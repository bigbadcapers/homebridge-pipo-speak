'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { resolvePiperBin, resolveVoiceFile, ensureVoiceFile } = require('./paths');

/**
 * Speaker — the memory-safe synthesis + playback engine.
 *
 * Everything here is built around one hard constraint learned on a 416 MB
 * Raspberry Pi with a 15 s hardware watchdog: only ever run ONE short-lived
 * Piper process at a time, refuse to start when free RAM is below a floor, and
 * pace successive runs with a cooldown. Piper is an external binary that exits
 * after each clip, so its memory is fully reclaimed between utterances — we
 * never load a speech model inside the Homebridge process.
 */
class Speaker {
  /**
   * @param {object} opts
   * @param {object} opts.log Homebridge logger
   * @param {string} opts.voice voice key (e.g. "en_US-lessac-low")
   * @param {number} opts.defaultVolume 0-100
   * @param {number} opts.maxChars
   * @param {number} opts.minAvailableMb pre-flight MemAvailable floor (0 = off)
   * @param {number} opts.cooldownSeconds
   * @param {number} [opts.piperThreads]
   * @param {string} opts.playback "auto" | "homepod-radio" | "pyatv"
   * @param {string} opts.homepodRadioPlayBase
   * @param {string} opts.mediaPath
   * @param {string} [opts.atvId]
   */
  constructor(opts) {
    this.log = opts.log;
    this.voice = opts.voice || 'en_US-lessac-low';
    this.defaultVolume = clampVolume(opts.defaultVolume, 75);
    this.maxChars = opts.maxChars > 0 ? opts.maxChars : 600;
    this.minAvailableMb = opts.minAvailableMb >= 0 ? opts.minAvailableMb : 90;
    this.cooldownMs = Math.max(0, (opts.cooldownSeconds || 0) * 1000);
    this.piperThreads = opts.piperThreads;
    this.playback = opts.playback || 'auto';
    this.homepodRadioPlayBase = (opts.homepodRadioPlayBase || 'http://127.0.0.1:7654/play').replace(/\/$/, '');
    this.mediaPath = opts.mediaPath || '/var/www/tones';
    this.atvId = opts.atvId;
    this.outputName = 'pipo-speak-latest.wav';

    // Serialize every utterance: at most one Piper process at any time.
    this._chain = Promise.resolve();
  }

  /**
   * Queue an utterance. Resolves to { code, message }. Never rejects.
   * @param {string} text
   * @param {number} [volume] 0-100, overrides default
   */
  say(text, volume) {
    const run = () => this._sayNow(text, volume);
    // Tack onto the serial chain regardless of prior outcome.
    const next = this._chain.then(run, run);
    // Keep the chain alive but swallow results so one failure can't poison it.
    this._chain = next.then(() => undefined, () => undefined);
    return next;
  }

  async _sayNow(rawText, volume) {
    let text = (rawText == null ? '' : String(rawText)).replace(/[\r\n\t]+/g, ' ').trim();
    if (!text) {
      return { code: 400, message: 'empty text' };
    }
    if (text.length > this.maxChars) {
      text = text.slice(0, this.maxChars);
    }
    const vol = clampVolume(volume, this.defaultVolume);

    // Pre-flight memory gate: refuse rather than risk an OOM/watchdog reboot.
    if (this.minAvailableMb > 0) {
      const avail = availableMb();
      if (avail != null && avail < this.minAvailableMb) {
        const msg = `low memory; refused (available=${avail} MiB, need=${this.minAvailableMb} MiB)`;
        this.log.warn(`pipo-speak: ${msg}`);
        return { code: 503, message: msg };
      }
    }

    let wav;
    try {
      await this._ensureVoice();
      wav = await this._synthesize(text);
      await this._play(wav, vol);
      this.log.info(`pipo-speak: spoke ${text.length} chars at volume ${vol}`);
      return { code: 200, message: `ok: spoke ${text.length} chars` };
    } catch (err) {
      this.log.error(`pipo-speak: ${err.message}`);
      return { code: 500, message: err.message };
    } finally {
      if (wav) {
        fs.promises.unlink(wav).catch(() => {});
      }
      if (this.cooldownMs > 0) {
        await delay(this.cooldownMs);
      }
    }
  }

  /**
   * Make sure the configured voice model is present, downloading it once if the
   * user picked a voice that wasn't bundled at install time. Best-effort: if the
   * download fails, _synthesize still reports the precise missing-file error.
   */
  async _ensureVoice() {
    if (process.env.PIPO_SPEAK_VOICE_FILE) {
      return;
    }
    if (fs.existsSync(resolveVoiceFile(this.voice))) {
      return;
    }
    this.log.info(`pipo-speak: voice "${this.voice}" not present yet; downloading once...`);
    try {
      await ensureVoiceFile(this.voice);
      this.log.info(`pipo-speak: voice "${this.voice}" ready.`);
    } catch (err) {
      this.log.warn(`pipo-speak: could not download voice "${this.voice}": ${err.message}`);
    }
  }

  /**
   * Synthesize text to a temp WAV with Piper, applying the same memory pacing
   * proven on the constrained Pi (nice/ionice + capped glibc arenas + optional
   * thread cap). Text is passed on stdin and never interpolated into a shell.
   * @returns {Promise<string>} path to the WAV
   */
  _synthesize(text) {
    return new Promise((resolve, reject) => {
      const piperBin = resolvePiperBin();
      const voiceFile = resolveVoiceFile(this.voice);
      if (!fs.existsSync(piperBin)) {
        return reject(new Error(`piper binary not found: ${piperBin} (run "npm run fetch-voice" in the plugin directory)`));
      }
      if (!fs.existsSync(voiceFile)) {
        return reject(new Error(`voice model not found: ${voiceFile}`));
      }

      const wav = path.join(os.tmpdir(), `pipo-speak-${process.pid}-${Date.now()}.wav`);
      const piperArgs = ['--model', voiceFile, '--output_file', wav];
      if (this.piperThreads) {
        piperArgs.push('--num-threads', String(this.piperThreads));
      }

      // Lower CPU priority (nice) and, where available, idle IO priority
      // (ionice) so a synthesis spike never starves the watchdog feeder.
      let command;
      let args;
      if (process.platform === 'linux' && hasBin('ionice')) {
        command = 'nice';
        args = ['-n', '10', 'ionice', '-c', '3', piperBin, ...piperArgs];
      } else if (process.platform === 'linux' && hasBin('nice')) {
        command = 'nice';
        args = ['-n', '10', piperBin, ...piperArgs];
      } else {
        command = piperBin;
        args = piperArgs;
      }

      const env = Object.assign({}, process.env, {
        // Cap glibc arenas so onnxruntime worker threads don't inflate Piper's
        // peak RSS with per-thread heap arenas (meaningful on small boards).
        MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX || '2',
      });

      const child = spawn(command, args, { env, stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 60000);

      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => {
        clearTimeout(killTimer);
        reject(new Error(`failed to start piper: ${err.message}`));
      });
      child.on('close', (codeNum) => {
        clearTimeout(killTimer);
        if (codeNum !== 0) {
          fs.promises.unlink(wav).catch(() => {});
          return reject(new Error(`piper exited ${codeNum}: ${stderr.trim().slice(0, 200)}`));
        }
        resolve(wav);
      });

      child.stdin.on('error', () => {});
      child.stdin.write(text);
      child.stdin.end();
    });
  }

  /**
   * Play a WAV on the target. Prefers the homepod-radio /play route (the warm,
   * low-latency path), falling back to pyatv direct streaming.
   */
  async _play(wav, volume) {
    const wantRadio = this.playback === 'homepod-radio'
      || (this.playback === 'auto' && this.mediaPath && fs.existsSync(this.mediaPath));
    if (wantRadio) {
      try {
        await this._playViaHomepodRadio(wav, volume);
        return;
      } catch (err) {
        if (this.playback === 'homepod-radio') {
          throw err;
        }
        this.log.warn(`pipo-speak: homepod-radio playback failed (${err.message}); falling back to pyatv`);
      }
    }
    await this._playViaPyatv(wav, volume);
  }

  async _playViaHomepodRadio(wav, volume) {
    if (!fs.existsSync(this.mediaPath)) {
      throw new Error(`media path not found: ${this.mediaPath}`);
    }
    // Atomically publish the clip under a fixed, URL-safe name so the
    // homepod-radio plugin never reads a half-written file.
    const dest = path.join(this.mediaPath, this.outputName);
    const tmp = path.join(this.mediaPath, `.${this.outputName}.${process.pid}.tmp`);
    await fs.promises.copyFile(wav, tmp);
    await fs.promises.chmod(tmp, 0o644).catch(() => {});
    await fs.promises.rename(tmp, dest);
    const url = `${this.homepodRadioPlayBase}/${this.outputName}/${volume}`;
    await httpGet(url, 20000);
  }

  _playViaPyatv(wav, volume) {
    return new Promise((resolve, reject) => {
      if (!this.atvId) {
        return reject(new Error('pyatv playback requires a device ID (atvId)'));
      }
      if (!hasBin('atvremote')) {
        return reject(new Error('atvremote (pyatv) not found on PATH'));
      }
      const args = ['--id', this.atvId, `set_volume=${volume}`, `stream_file=${wav}`];
      const child = spawn('atvremote', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 60000);
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => {
        clearTimeout(killTimer);
        reject(new Error(`failed to start atvremote: ${err.message}`));
      });
      child.on('close', (codeNum) => {
        clearTimeout(killTimer);
        if (codeNum !== 0) {
          return reject(new Error(`atvremote exited ${codeNum}: ${stderr.trim().slice(0, 200)}`));
        }
        resolve();
      });
    });
  }
}

function clampVolume(value, fallback) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0 && n <= 100) {
    return n;
  }
  return fallback;
}

function availableMb() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'ascii');
    const m = meminfo.match(/^MemAvailable:\s+(\d+)\s*kB/m);
    if (m) {
      return Math.floor(parseInt(m[1], 10) / 1024);
    }
  } catch (_e) {
    // Not Linux, or unreadable — treat as "unknown" and don't gate.
  }
  return null;
}

const _binCache = new Map();
function hasBin(name) {
  if (_binCache.has(name)) {
    return _binCache.get(name);
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  let found = false;
  for (const dir of dirs) {
    for (const ext of exts) {
      if (dir && fs.existsSync(path.join(dir, name + ext))) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  _binCache.set(name, found);
  return found;
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`play route returned HTTP ${res.statusCode}`));
      }
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('play route timeout')));
    req.on('error', reject);
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Speaker };

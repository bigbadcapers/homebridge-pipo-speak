"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const {
  resolvePiperBin,
  resolveVoiceFile,
  ensureVoiceFile,
} = require("./paths");
const { PhraseCache } = require("./cache");
const { clampVolume, speedToLengthScale, normalizeText } = require("./util");

/**
 * Speaker — the memory-safe synthesis + playback engine.
 *
 * Everything here is built around one hard constraint learned on a 416 MB
 * Raspberry Pi with a 15 s hardware watchdog: only ever run ONE short-lived
 * Piper process at a time, refuse to start when free RAM is below a floor, and
 * pace successive runs with a cooldown. Piper is an external binary that exits
 * after each clip, so its memory is fully reclaimed between utterances — we
 * never load a speech model inside the Homebridge process.
 *
 * A small on-disk WAV cache (see lib/cache.js) means a repeated phrase is
 * replayed from a file instead of re-synthesized — so the memory gate only ever
 * gates a genuine cache miss.
 */
class Speaker {
  /**
   * @param {object} opts
   * @param {object} opts.log Homebridge logger
   * @param {string} opts.voice default voice key (e.g. "en_US-lessac-low")
   * @param {number} opts.defaultVolume 0-100
   * @param {number} [opts.speed] default speech speed (0.5-2.0, 1 = normal)
   * @param {number} opts.maxChars
   * @param {number} opts.minAvailableMb pre-flight MemAvailable floor (0 = off)
   * @param {number} opts.cooldownSeconds
   * @param {number} [opts.piperThreads]
   * @param {string} opts.playback "auto" | "homepod-radio" | "pyatv"
   * @param {string} opts.homepodRadioPlayBase
   * @param {string} opts.mediaPath
   * @param {string} [opts.atvId]
   * @param {string} [opts.chimeFile] optional WAV played before each phrase
   * @param {boolean} [opts.restoreVolume] restore prior pyatv volume after play
   * @param {boolean} [opts.cacheEnabled] cache synthesized phrases (default true)
   * @param {number} [opts.cacheMaxEntries] cache eviction cap (default 64)
   */
  constructor(opts) {
    this.log = opts.log;
    this.voice = opts.voice || "en_US-lessac-low";
    this.defaultVolume = clampVolume(opts.defaultVolume, 75);
    this.speed = Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : 1;
    this.maxChars = opts.maxChars > 0 ? opts.maxChars : 600;
    this.minAvailableMb = opts.minAvailableMb >= 0 ? opts.minAvailableMb : 90;
    this.cooldownMs = Math.max(0, (opts.cooldownSeconds || 0) * 1000);
    this.piperThreads = opts.piperThreads;
    this.playback = opts.playback || "auto";
    this.homepodRadioPlayBase = (
      opts.homepodRadioPlayBase || "http://127.0.0.1:7654/play"
    ).replace(/\/$/, "");
    this.mediaPath = opts.mediaPath || "/var/www/tones";
    this.atvId = opts.atvId;
    this.chimeFile = opts.chimeFile || null;
    this.restoreVolume = opts.restoreVolume === true;
    this.outputName = "pipo-speak-latest.wav";

    this.cache = new PhraseCache({
      log: opts.log,
      enabled: opts.cacheEnabled !== false,
      maxEntries: opts.cacheMaxEntries != null ? opts.cacheMaxEntries : 64,
    });

    // Serialize every utterance: at most one Piper process at any time.
    this._chain = Promise.resolve();
  }

  /**
   * Queue an utterance. Resolves to { code, message }. Never rejects.
   * Back-compatible: the second argument may be a plain volume number, or an
   * options object { volume, voice, speed, atvId, playback, mediaPath }.
   * @param {string} text
   * @param {number|object} [volumeOrOpts]
   */
  say(text, volumeOrOpts) {
    const opts = normalizeOpts(volumeOrOpts);
    const run = () => this._sayNow(text, opts);
    const next = this._chain.then(run, run);
    this._chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Synthesize + cache a phrase WITHOUT playing it (startup pre-render). Same
   * serialized, memory-gated path as say(). Resolves to { code, message }.
   * @param {string} text
   * @param {number|object} [volumeOrOpts]
   */
  prime(text, volumeOrOpts) {
    const opts = normalizeOpts(volumeOrOpts);
    const run = () => this._primeNow(text, opts);
    const next = this._chain.then(run, run);
    this._chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Lightweight status snapshot for the /healthz route. */
  stats() {
    return {
      status: "ok",
      voice: this.voice,
      availableMb: availableMb(),
      minAvailableMb: this.minAvailableMb,
      cacheEnabled: this.cache.enabled,
      cacheSize: this.cache.size(),
    };
  }

  async _sayNow(rawText, opts) {
    const text = this._clean(rawText);
    if (!text) {
      return { code: 400, message: "empty text" };
    }
    const voice = opts.voice || this.voice;
    const lengthScale = speedToLengthScale(
      opts.speed != null ? opts.speed : this.speed,
    );
    const vol = clampVolume(opts.volume, this.defaultVolume);
    const route = this._route(opts);

    let prepared;
    try {
      prepared = await this._prepareWav(text, voice, lengthScale);
      if (this.chimeFile && fs.existsSync(this.chimeFile)) {
        try {
          await this._play(this.chimeFile, vol, route);
        } catch (err) {
          this.log.warn(`pipo-speak: chime failed (${err.message})`);
        }
      }
      await this._play(prepared.path, vol, route);
      this.log.info(
        `pipo-speak: spoke ${text.length} chars at volume ${vol}` +
          `${prepared.fromCache ? " (cached)" : ""}`,
      );
      return {
        code: 200,
        message: `ok: spoke ${text.length} chars${prepared.fromCache ? " (cached)" : ""}`,
      };
    } catch (err) {
      const code = err.httpCode || 500;
      if (code === 503) {
        this.log.warn(`pipo-speak: ${err.message}`);
      } else {
        this.log.error(`pipo-speak: ${err.message}`);
      }
      return { code, message: err.message };
    } finally {
      if (prepared && prepared.temp && prepared.path) {
        fs.promises.unlink(prepared.path).catch(() => {});
      }
      if (this.cooldownMs > 0) {
        await delay(this.cooldownMs);
      }
    }
  }

  async _primeNow(rawText, opts) {
    const text = this._clean(rawText);
    if (!text) {
      return { code: 400, message: "empty text" };
    }
    const voice = opts.voice || this.voice;
    const lengthScale = speedToLengthScale(
      opts.speed != null ? opts.speed : this.speed,
    );

    if (this.cache.get(text, voice, lengthScale)) {
      return { code: 200, message: "already cached" };
    }
    let wav;
    try {
      this._gate();
      await this._ensureVoice(voice);
      wav = await this._synthesize(text, voice, lengthScale);
      await this.cache.put(wav, text, voice, lengthScale);
      return { code: 200, message: "primed" };
    } catch (err) {
      const code = err.httpCode || 500;
      return { code, message: err.message };
    } finally {
      if (wav) {
        fs.promises.unlink(wav).catch(() => {});
      }
      if (this.cooldownMs > 0) {
        await delay(this.cooldownMs);
      }
    }
  }

  _clean(rawText) {
    let text = normalizeText(rawText);
    if (text.length > this.maxChars) {
      text = text.slice(0, this.maxChars);
    }
    return text;
  }

  _route(opts) {
    return {
      atvId: opts.atvId || this.atvId,
      playback: opts.playback || this.playback,
      mediaPath: opts.mediaPath || this.mediaPath,
      restoreVolume:
        opts.restoreVolume != null ? opts.restoreVolume : this.restoreVolume,
    };
  }

  /** Throw a 503-tagged error if free RAM is below the floor. */
  _gate() {
    if (this.minAvailableMb > 0) {
      const avail = availableMb();
      if (avail != null && avail < this.minAvailableMb) {
        const err = new Error(
          `low memory; refused (available=${avail} MiB, need=${this.minAvailableMb} MiB)`,
        );
        err.httpCode = 503;
        throw err;
      }
    }
  }

  /**
   * Resolve a ready-to-play WAV for this rendering. Cache hit → the cached file
   * (temp:false, never deleted). Miss → memory gate, then synth + cache copy,
   * returning the temp synth file (temp:true, deleted by the caller).
   * @returns {Promise<{path:string, temp:boolean, fromCache:boolean}>}
   */
  async _prepareWav(text, voice, lengthScale) {
    const cached = this.cache.get(text, voice, lengthScale);
    if (cached) {
      return { path: cached, temp: false, fromCache: true };
    }
    this._gate();
    await this._ensureVoice(voice);
    const wav = await this._synthesize(text, voice, lengthScale);
    await this.cache.put(wav, text, voice, lengthScale);
    return { path: wav, temp: true, fromCache: false };
  }

  /**
   * Make sure a voice model is present, downloading it once if the user picked a
   * voice that wasn't bundled at install time. Best-effort: if the download
   * fails, _synthesize still reports the precise missing-file error.
   */
  async _ensureVoice(voice) {
    const v = voice || this.voice;
    if (process.env.PIPO_SPEAK_VOICE_FILE) {
      return;
    }
    if (fs.existsSync(resolveVoiceFile(v))) {
      return;
    }
    this.log.info(`pipo-speak: voice "${v}" not present yet; downloading once...`);
    try {
      await ensureVoiceFile(v);
      this.log.info(`pipo-speak: voice "${v}" ready.`);
    } catch (err) {
      this.log.warn(
        `pipo-speak: could not download voice "${v}": ${err.message}`,
      );
    }
  }

  /**
   * Synthesize text to a temp WAV with Piper, applying the same memory pacing
   * proven on the constrained Pi (nice/ionice + capped glibc arenas + optional
   * thread cap). Text is passed on stdin and never interpolated into a shell.
   * @returns {Promise<string>} path to the WAV
   */
  _synthesize(text, voice, lengthScale) {
    return new Promise((resolve, reject) => {
      const piperBin = resolvePiperBin();
      const voiceFile = resolveVoiceFile(voice || this.voice);
      if (!fs.existsSync(piperBin)) {
        return reject(
          new Error(
            `piper binary not found: ${piperBin} (run "npm run fetch-voice" in the plugin directory)`,
          ),
        );
      }
      if (!fs.existsSync(voiceFile)) {
        return reject(new Error(`voice model not found: ${voiceFile}`));
      }

      const wav = path.join(
        os.tmpdir(),
        `pipo-speak-${process.pid}-${Date.now()}.wav`,
      );
      const piperArgs = ["--model", voiceFile, "--output_file", wav];
      if (lengthScale && lengthScale !== 1) {
        piperArgs.push("--length_scale", String(lengthScale));
      }
      if (this.piperThreads) {
        piperArgs.push("--num-threads", String(this.piperThreads));
      }

      // Lower CPU priority (nice) and, where available, idle IO priority
      // (ionice) so a synthesis spike never starves the watchdog feeder.
      let command;
      let args;
      if (process.platform === "linux" && hasBin("ionice")) {
        command = "nice";
        args = ["-n", "10", "ionice", "-c", "3", piperBin, ...piperArgs];
      } else if (process.platform === "linux" && hasBin("nice")) {
        command = "nice";
        args = ["-n", "10", piperBin, ...piperArgs];
      } else {
        command = piperBin;
        args = piperArgs;
      }

      const env = Object.assign({}, process.env, {
        // Cap glibc arenas so onnxruntime worker threads don't inflate Piper's
        // peak RSS with per-thread heap arenas (meaningful on small boards).
        MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX || "2",
      });

      const child = spawn(command, args, {
        env,
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 60000);

      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        clearTimeout(killTimer);
        reject(new Error(`failed to start piper: ${err.message}`));
      });
      child.on("close", (codeNum) => {
        clearTimeout(killTimer);
        if (codeNum !== 0) {
          fs.promises.unlink(wav).catch(() => {});
          return reject(
            new Error(`piper exited ${codeNum}: ${stderr.trim().slice(0, 200)}`),
          );
        }
        resolve(wav);
      });

      child.stdin.on("error", () => {});
      child.stdin.write(text);
      child.stdin.end();
    });
  }

  /**
   * Play a WAV on the target. Prefers the homepod-radio /play route (the warm,
   * low-latency path), falling back to pyatv direct streaming. Routing fields
   * (atvId/playback/mediaPath) default to the instance config but can be
   * overridden per call for per-button room routing.
   */
  async _play(wav, volume, route) {
    const r = route || {};
    const playback = r.playback || this.playback;
    const mediaPath = r.mediaPath || this.mediaPath;
    const atvId = r.atvId || this.atvId;
    const wantRadio =
      playback === "homepod-radio" ||
      (playback === "auto" && mediaPath && fs.existsSync(mediaPath));
    if (wantRadio) {
      try {
        await this._playViaHomepodRadio(wav, volume, mediaPath);
        return;
      } catch (err) {
        if (playback === "homepod-radio") {
          throw err;
        }
        this.log.warn(
          `pipo-speak: homepod-radio playback failed (${err.message}); falling back to pyatv`,
        );
      }
    }
    await this._playViaPyatv(wav, volume, atvId, r.restoreVolume);
  }

  async _playViaHomepodRadio(wav, volume, mediaPath) {
    const dir = mediaPath || this.mediaPath;
    if (!fs.existsSync(dir)) {
      throw new Error(`media path not found: ${dir}`);
    }
    // Atomically publish the clip under a fixed, URL-safe name so the
    // homepod-radio plugin never reads a half-written file.
    const dest = path.join(dir, this.outputName);
    const tmp = path.join(dir, `.${this.outputName}.${process.pid}.tmp`);
    await fs.promises.copyFile(wav, tmp);
    await fs.promises.chmod(tmp, 0o644).catch(() => {});
    await fs.promises.rename(tmp, dest);
    const url = `${this.homepodRadioPlayBase}/${this.outputName}/${volume}`;
    await httpGet(url, 20000);
  }

  async _playViaPyatv(wav, volume, atvId, restoreVolume) {
    const id = atvId || this.atvId;
    if (!id) {
      throw new Error("pyatv playback requires a device ID (atvId)");
    }
    if (!hasBin("atvremote")) {
      throw new Error("atvremote (pyatv) not found on PATH");
    }

    let prior = null;
    if (restoreVolume) {
      prior = await this._readPyatvVolume(id).catch(() => null);
    }

    await spawnOk(
      "atvremote",
      ["--id", id, `set_volume=${volume}`, `stream_file=${wav}`],
      "atvremote",
    );

    if (restoreVolume && prior != null) {
      await spawnOk(
        "atvremote",
        ["--id", id, `set_volume=${prior}`],
        "atvremote",
      ).catch(() => {});
    }
  }

  /** Best-effort read of the current pyatv device volume (0-100), or null. */
  async _readPyatvVolume(id) {
    const out = await spawnCapture("atvremote", ["--id", id, "volume"]);
    const m = out.match(/(\d+(?:\.\d+)?)/);
    if (!m) {
      return null;
    }
    const n = Math.round(parseFloat(m[1]));
    return n >= 0 && n <= 100 ? n : null;
  }
}

/**
 * Coerce say()/prime()'s second argument into an options object. A bare number
 * (or numeric string) is treated as a volume for backward compatibility.
 */
function normalizeOpts(volumeOrOpts) {
  if (volumeOrOpts == null) {
    return {};
  }
  if (typeof volumeOrOpts === "object") {
    return volumeOrOpts;
  }
  return { volume: volumeOrOpts };
}

function availableMb() {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "ascii");
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
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const exts =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
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

/** Spawn a command, resolve on exit code 0, reject otherwise. */
function spawnOk(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(new Error(`failed to start ${label}: ${err.message}`));
    });
    child.on("close", (codeNum) => {
      clearTimeout(killTimer);
      if (codeNum !== 0) {
        return reject(
          new Error(`${label} exited ${codeNum}: ${stderr.trim().slice(0, 200)}`),
        );
      }
      resolve();
    });
  });
}

/** Spawn a command and resolve with its captured stdout. */
function spawnCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(killTimer);
      resolve(stdout);
    });
  });
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
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error("play route timeout")),
    );
    req.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Speaker };

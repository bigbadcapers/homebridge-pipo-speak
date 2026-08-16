"use strict";

const fs = require("fs");
const crypto = require("crypto");
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
const { WarmPlayer } = require("./warm-player");
const { AzureTts } = require("./azure-tts");
const {
  clampVolume,
  speedToLengthScale,
  normalizeText,
  wavDurationSeconds,
  computeTimeout,
  synthTimeoutMs,
} = require("./util");

// --- Watchdog tuning ---------------------------------------------------------
// atvremote stream_file blocks for the full clip, so the playback watchdog is
// sized to the measured audio length plus AirPlay-handshake headroom; an
// unreadable clip falls back to a generous cap. This mirrors the duration-aware
// timeout adopted upstream in homebridge-homepod-radio (issue #360), where a
// fixed ceiling cut long audio off mid-stream.
const PLAY_TIMEOUT_PADDING_MS = 30000;
const UNKNOWN_PLAY_TIMEOUT_MS = 10 * 60 * 1000;
// The proven 60 s ceiling comfortably covers the default 600-char limit; longer
// text (a raised maxChars) earns 100 ms/char more so a slow-but-healthy render
// on a constrained Pi is never killed prematurely.
const SYNTH_TIMEOUT_FLOOR_MS = 60000;
const SYNTH_TIMEOUT_PER_CHAR_MS = 100;
// A few KB is enough to reach the WAV `data` chunk's declared size field.
const WAV_HEADER_READ_BYTES = 4096;
const NORMALIZED_AUDIO_EXTENSIONS = new Set([".aif", ".aiff"]);
const PIPER_QUALITY = 10;
const AZURE_QUALITY = 100;

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
   * @param {string} [opts.cacheDir] persistent cache directory
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

    // Optional warm pyatv connection for low-latency soundboard playback. A
    // resident worker holds one AirPlay connection open so a clip plays almost
    // instantly instead of paying the cold connect each press; if it isn't ready
    // playFile falls back to the normal route, so this is purely additive.
    this.warmConnection = opts.warmConnection === true && !!this.atvId;
    this.warm = null;
    if (this.warmConnection) {
      this.warm = new WarmPlayer({
        log: this.log,
        atvId: this.atvId,
        verbose: opts.warmVerbose === true,
      });
      this.warm.start();
    }

    this.cache = new PhraseCache({
      log: opts.log,
      dir: opts.cacheDir,
      enabled: opts.cacheEnabled !== false,
      maxEntries: opts.cacheMaxEntries != null ? opts.cacheMaxEntries : 64,
    });

    // Optional Azure cloud voice. When enabled and configured, a cache miss is
    // rendered by Azure over HTTPS instead of by the local Piper model — a plain
    // network+file operation, so the RAM/watchdog gate that protects the offline
    // path does not apply. Falls back to offline Piper when the key is missing.
    this.azure = null;
    this.azureVoice = null;
    if (opts.azure && opts.azure.enabled) {
      const azure = new AzureTts({
        log: this.log,
        region: opts.azure.region,
        key: opts.azure.key || process.env.PIPO_SPEAK_AZURE_KEY,
        voice: opts.azure.voice,
      });
      this.azureVoice = azure.voice;
      if (azure.configured()) {
        this.azure = azure;
        this.log.info(
          `pipo-speak: Azure cloud voice enabled (${azure.voice} @ ${azure.region})`,
        );
      } else {
        this.log.warn(
          "pipo-speak: Azure cloud voice enabled but no subscription key set " +
            "(config.azure.key or PIPO_SPEAK_AZURE_KEY); using offline Piper.",
        );
      }
    }

    // Serialize every utterance: at most one Piper process at any time.
    this._chain = Promise.resolve();
    this._upgrades = new Map();
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

  /**
   * Queue playback of an EXISTING audio file (no synthesis) on the same target
   * as say(). Used by the soundboard. Resolves to { code, message }; never
   * rejects. Goes through the same serialized chain so a clip can't overlap a
   * spoken phrase. The memory gate does not apply — nothing is synthesized.
   * @param {string} filePath absolute path to a playable audio file
   * @param {number|object} [volumeOrOpts]
   */
  playFile(filePath, volumeOrOpts) {
    const opts = normalizeOpts(volumeOrOpts);
    const run = () => this._playFileNow(filePath, opts);
    const next = this._chain.then(run, run);
    this._chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Stop background workers (warm pyatv connection) on shutdown. */
  stop() {
    if (this.warm) {
      this.warm.stop();
      this.warm = null;
    }
  }

  /** Lightweight status snapshot for the /healthz route. */
  stats() {
    return {
      status: "ok",
      voice: this.azure ? this.azureVoice : this.voice,
      backend: this.azure ? "azure" : "piper",
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
    const voice = this._effectiveVoice(opts);
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

  async _playFileNow(filePath, opts) {
    if (!filePath || typeof filePath !== "string") {
      return { code: 400, message: "no file path" };
    }
    if (!fs.existsSync(filePath)) {
      return { code: 404, message: `file not found: ${filePath}` };
    }
    const vol = clampVolume(opts.volume, this.defaultVolume);
    const route = this._route(opts);
    let prepared;
    try {
      prepared = await this._normalizeForPlayback(filePath);
      const playbackPath = prepared.path;
      // Fast path: replay on the held warm AirPlay connection if available.
      if (
        opts.warmConnection !== false &&
        route.atvId === this.atvId &&
        this.warm &&
        this.warm.isReady()
      ) {
        const ok = await this.warm.playFile(playbackPath, vol);
        if (ok) {
          this.log.info(
            `pipo-speak: played "${path.basename(filePath)}" at volume ${vol} (warm)`,
          );
          return {
            code: 200,
            message: `ok: played ${path.basename(filePath)}`,
          };
        }
        this.log.warn(
          "pipo-speak: warm playback unavailable; falling back to /play route",
        );
      }
      // Preserve the source extension so the homepod-radio ffmpeg path (and the
      // /play URL) sees the real container, not a mislabeled .wav.
        route.outName = soundboardOutName(playbackPath);
        await this._play(playbackPath, vol, route);
      this.log.info(
        `pipo-speak: played "${path.basename(filePath)}" at volume ${vol}`,
      );
      return { code: 200, message: `ok: played ${path.basename(filePath)}` };
    } catch (err) {
      const code = err.httpCode || 500;
      this.log.error(`pipo-speak: ${err.message}`);
      return { code, message: err.message };
    } finally {
      if (prepared && prepared.temp) {
        await fs.promises.unlink(prepared.path).catch(() => {});
      }
      if (opts.cooldown !== false && this.cooldownMs > 0) {
        await delay(this.cooldownMs);
      }
    }
  }

  async _normalizeForPlayback(filePath) {
    if (
      !NORMALIZED_AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    ) {
      return { path: filePath, temp: false };
    }
    if (!hasBin("ffmpeg")) {
      throw new Error("ffmpeg is required to normalize AIFF audio");
    }
    const output = path.join(
      os.tmpdir(),
      `pipo-speak-normalized-${process.pid}-${Date.now()}.wav`,
    );
    try {
      await spawnOk(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          filePath,
          "-vn",
          "-acodec",
          "pcm_s16le",
          "-ar",
          "44100",
          "-ac",
          "2",
          output,
        ],
        "ffmpeg AIFF normalization",
        UNKNOWN_PLAY_TIMEOUT_MS,
      );
      return { path: output, temp: true };
    } catch (err) {
      await fs.promises.unlink(output).catch(() => {});
      throw err;
    }
  }

  async _primeNow(rawText, opts) {
    const text = this._clean(rawText);
    if (!text) {
      return { code: 400, message: "empty text" };
    }
    const voice = this._effectiveVoice(opts);
    const lengthScale = speedToLengthScale(
      opts.speed != null ? opts.speed : this.speed,
    );

    let prepared;
    try {
      prepared = await this._resolveWav(text, voice, lengthScale);
      return {
        code: 200,
        message: prepared.fromCache ? "already cached" : "primed",
      };
    } catch (err) {
      const code = err.httpCode || 500;
      return { code, message: err.message };
    } finally {
      if (prepared && prepared.temp) {
        fs.promises.unlink(prepared.path).catch(() => {});
      }
      if (this.cooldownMs > 0) {
        await delay(this.cooldownMs);
      }
    }
  }

  /**
   * Resolve the voice for a rendering. In Azure mode the configured Azure voice
   * is used; a per-button override is honored only when it looks like an Azure
   * voice (hyphen locale, no underscore) so a leftover Piper voice key is never
   * sent to the cloud endpoint. Offline mode keeps the original behavior.
   */
  _effectiveVoice(opts) {
    if (this.azure) {
      const o = opts.voice;
      if (o && !o.includes("_")) {
        return o;
      }
      return this.azureVoice;
    }
    return opts.voice || this.voice;
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
    return this._resolveWav(text, voice, lengthScale);
  }

  async _resolveWav(text, voice, lengthScale) {
    const renderers = this._renderers(voice);
    const cached = this.cache.getBest(text, lengthScale);
    if (cached) {
      this._scheduleUpgrade(text, lengthScale, cached, renderers);
      return { path: cached.path, temp: false, fromCache: true };
    }
    const generated = await this._generateFirstAvailable(
      text,
      lengthScale,
      renderers,
    );
    return { path: generated.path, temp: true, fromCache: false };
  }

  _renderers(voice) {
    const renderers = [];
    if (this.azure) {
      const azureVoice = voice && !voice.includes("_") ? voice : this.azureVoice;
      renderers.push({
        provider: "azure",
        voice: azureVoice,
        quality: AZURE_QUALITY,
        synthesize: (text, lengthScale) =>
          this.azure.synthesize(text, azureVoice, lengthScale),
      });
    }
    const piperVoice = voice && voice.includes("_") ? voice : this.voice;
    renderers.push({
      provider: "piper",
      voice: piperVoice,
      quality: PIPER_QUALITY,
      synthesize: async (text, lengthScale) => {
        this._gate();
        await this._ensureVoice(piperVoice);
        return this._synthesize(text, piperVoice, lengthScale);
      },
    });
    return renderers;
  }

  async _generate(text, lengthScale, renderer) {
    const path = await renderer.synthesize(text, lengthScale);
    const stored = await this.cache.store(path, text, lengthScale, renderer);
    return { path, stored, ...renderer };
  }

  async _generateFirstAvailable(text, lengthScale, renderers) {
    let lastError;
    for (const renderer of renderers) {
      try {
        return await this._generate(text, lengthScale, renderer);
      } catch (err) {
        lastError = err;
        if (renderer.provider === "azure") {
          this.log.warn(
            `pipo-speak: Azure cloud voice failed (${err.message}); falling back to offline Piper.`,
          );
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error("no speech renderer available");
  }

  /** Start one best-effort quality upgrade without delaying cached playback. */
  _scheduleUpgrade(text, lengthScale, cached, renderers) {
    const renderer = renderers.find(
      (candidate) => candidate.quality > cached.quality,
    );
    if (!renderer) {
      return;
    }
    const requestKey = this.cache.requestKey(text, lengthScale);
    if (this._upgrades.has(requestKey)) {
      return;
    }
    const upgrade = this._generate(text, lengthScale, renderer)
      .then(async (generated) => {
        await fs.promises.unlink(generated.path).catch(() => {});
        if (generated.stored) {
          this.log.info(
            `pipo-speak: quietly upgraded cached phrase with ${renderer.provider} (${renderer.voice}).`,
          );
        }
      })
      .catch((err) => {
        this.log.warn(
          `pipo-speak: cached phrase upgrade deferred (${err.message}).`,
        );
      })
      .finally(() => {
        this._upgrades.delete(requestKey);
      });
    this._upgrades.set(requestKey, upgrade);
  }

  /**
   * Render a cache miss to a temp WAV: Azure cloud voice when enabled (a
   * network+file op, no memory gate), otherwise the memory-gated offline Piper
   * path. Returns the temp WAV path; the caller caches and cleans it up.
   */
  async _render(text, voice, lengthScale) {
    const generated = await this._generateFirstAvailable(
      text,
      lengthScale,
      this._renderers(voice),
    );
    return generated.path;
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
    this.log.info(
      `pipo-speak: voice "${v}" not present yet; downloading once...`,
    );
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
      let timedOut = false;
      // Scale the synthesis ceiling to the text length so a long phrase on a
      // slow Pi isn't killed while still rendering (a silent failure mode).
      const synthLimitMs = synthTimeoutMs(
        text.length,
        SYNTH_TIMEOUT_FLOOR_MS,
        SYNTH_TIMEOUT_PER_CHAR_MS,
      );
      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, synthLimitMs);

      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        clearTimeout(killTimer);
        reject(new Error(`failed to start piper: ${err.message}`));
      });
      child.on("close", (codeNum) => {
        clearTimeout(killTimer);
        if (timedOut) {
          fs.promises.unlink(wav).catch(() => {});
          return reject(
            new Error(
              `piper timed out after ${Math.round(synthLimitMs / 1000)}s ` +
                `synthesizing ${text.length} chars`,
            ),
          );
        }
        if (codeNum !== 0) {
          fs.promises.unlink(wav).catch(() => {});
          return reject(
            new Error(
              `piper exited ${codeNum}: ${stderr.trim().slice(0, 200)}`,
            ),
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
        await this._playViaHomepodRadio(wav, volume, mediaPath, r.outName);
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

  async _playViaHomepodRadio(wav, volume, mediaPath, outName) {
    const dir = mediaPath || this.mediaPath;
    if (!fs.existsSync(dir)) {
      throw new Error(`media path not found: ${dir}`);
    }
    // Atomically publish the clip under a fixed, URL-safe name so the
    // homepod-radio plugin never reads a half-written file. The soundboard
    // passes its own name so the clip keeps its real extension.
    const name = outName || this.outputName;
    const dest = path.join(dir, name);
    const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
    await fs.promises.copyFile(wav, tmp);
    await fs.promises.chmod(tmp, 0o644).catch(() => {});
    await fs.promises.rename(tmp, dest);
    const url = `${this.homepodRadioPlayBase}/${name}/${volume}`;
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
      this._playTimeoutMs(wav),
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

  /**
   * Size the pyatv stream_file watchdog to the clip about to play. atvremote
   * blocks for the full audio duration, so a fixed ceiling would cut a long
   * phrase off mid-sentence (the failure mode fixed upstream in homepod-radio
   * #360). The WAV header gives the exact length; an unreadable header falls
   * back to a generous cap.
   * @param {string} wav
   * @returns {number} watchdog in milliseconds
   */
  _playTimeoutMs(wav) {
    const seconds = readWavDurationSeconds(wav);
    const { timeoutMs } = computeTimeout(
      seconds,
      PLAY_TIMEOUT_PADDING_MS,
      UNKNOWN_PLAY_TIMEOUT_MS,
    );
    return timeoutMs;
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

function soundboardOutName(filePath) {
  const ext = path.extname(filePath).toLowerCase() || ".wav";
  const stem =
    path
      .basename(filePath, ext)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "sound";
  const hash = crypto
    .createHash("sha1")
    .update(path.resolve(filePath))
    .digest("hex")
    .slice(0, 8);
  return `pipo-speak-soundboard-${stem}-${hash}${ext}`;
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

/**
 * Read just the WAV header region of `wav` and return the clip duration in
 * seconds, or null when it can't be parsed (the caller then uses a generous
 * fallback timeout). Reads a few KB rather than the whole file.
 * @param {string} wav
 * @returns {number|null}
 */
function readWavDurationSeconds(wav) {
  let fd;
  try {
    fd = fs.openSync(wav, "r");
    const buf = Buffer.alloc(WAV_HEADER_READ_BYTES);
    const bytes = fs.readSync(fd, buf, 0, WAV_HEADER_READ_BYTES, 0);
    return wavDurationSeconds(buf.subarray(0, bytes));
  } catch (_e) {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        // ignore close failures
      }
    }
  }
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

/**
 * Spawn a command, resolve on exit code 0, reject otherwise. An optional
 * watchdog (`timeoutMs`, default 60 s) kills a run that overshoots and surfaces
 * a clear "timed out" error instead of a misleading "exited null".
 */
function spawnOk(command, args, label, timeoutMs) {
  const limitMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limitMs);
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(new Error(`failed to start ${label}: ${err.message}`));
    });
    child.on("close", (codeNum) => {
      clearTimeout(killTimer);
      if (timedOut) {
        return reject(
          new Error(
            `${label} timed out after ${Math.round(limitMs / 1000)}s and was stopped`,
          ),
        );
      }
      if (codeNum !== 0) {
        return reject(
          new Error(
            `${label} exited ${codeNum}: ${stderr.trim().slice(0, 200)}`,
          ),
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

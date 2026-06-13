"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { VOICES_DIR } = require("./paths");

// Default cache location: alongside the bundled engine under vendor/, which is
// gitignored and writable by the Homebridge user. Override with
// PIPO_SPEAK_CACHE_DIR (used by the test suite to point at a temp dir).
const DEFAULT_CACHE_DIR = path.join(VOICES_DIR, "..", "cache");

/**
 * PhraseCache — a tiny on-disk WAV cache for synthesized phrases.
 *
 * Fixed-button phrases are deterministic for a given (text, voice, length_scale),
 * so synthesizing them once and replaying the file turns the single most
 * memory-dangerous operation on a tiny board (an on-demand Piper run on a button
 * press) into a cheap file read. Entries are keyed by a content hash and evicted
 * oldest-first once the cap is exceeded.
 */
class PhraseCache {
  /**
   * @param {object} [opts]
   * @param {object} [opts.log] logger (defaults to console)
   * @param {string} [opts.dir] cache directory
   * @param {boolean} [opts.enabled] master on/off (default true)
   * @param {number} [opts.maxEntries] eviction cap (default 64; <=0 disables)
   */
  constructor(opts = {}) {
    this.log = opts.log || console;
    this.dir = opts.dir || process.env.PIPO_SPEAK_CACHE_DIR || DEFAULT_CACHE_DIR;
    this.maxEntries = Number.isFinite(opts.maxEntries) ? opts.maxEntries : 64;
    this.enabled = opts.enabled !== false && this.maxEntries > 0;
  }

  /**
   * Stable cache key for a phrase rendering.
   * @returns {string} hex sha1
   */
  key(text, voice, lengthScale) {
    const norm = `${voice || ""}|${lengthScale == null ? 1 : lengthScale}|${text}`;
    return crypto.createHash("sha1").update(norm, "utf8").digest("hex");
  }

  /** Absolute path the cached WAV would live at (whether or not it exists). */
  pathFor(text, voice, lengthScale) {
    return path.join(this.dir, `${this.key(text, voice, lengthScale)}.wav`);
  }

  /**
   * Return the path to a cached, non-empty WAV for this rendering, or null on a
   * miss. A hit is "touched" (mtime bumped) so eviction is least-recently-used.
   * @returns {string|null}
   */
  get(text, voice, lengthScale) {
    if (!this.enabled) {
      return null;
    }
    const p = this.pathFor(text, voice, lengthScale);
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) {
        const now = new Date();
        fs.utimes(p, now, now, () => {});
        return p;
      }
    } catch (_e) {
      // fall through to miss
    }
    return null;
  }

  /**
   * Copy a freshly synthesized WAV into the cache (the source is left intact for
   * the caller to play/clean up). Best-effort: a cache failure never breaks
   * playback. Returns the cached path, or null if disabled/failed.
   * @returns {Promise<string|null>}
   */
  async put(srcWav, text, voice, lengthScale) {
    if (!this.enabled) {
      return null;
    }
    const dest = this.pathFor(text, voice, lengthScale);
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.copyFile(srcWav, tmp);
      await fs.promises.rename(tmp, dest);
      this._evict();
      return dest;
    } catch (err) {
      fs.promises.unlink(tmp).catch(() => {});
      if (this.log && this.log.warn) {
        this.log.warn(`pipo-speak cache: could not store clip: ${err.message}`);
      }
      return null;
    }
  }

  /** Drop the oldest entries until at most maxEntries remain. */
  _evict() {
    try {
      const entries = fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".wav"))
        .map((f) => {
          const p = path.join(this.dir, f);
          return { p, m: fs.statSync(p).mtimeMs };
        })
        .sort((a, b) => a.m - b.m);
      while (entries.length > this.maxEntries) {
        const victim = entries.shift();
        try {
          fs.unlinkSync(victim.p);
        } catch (_e) {
          // already gone — ignore
        }
      }
    } catch (_e) {
      // best-effort
    }
  }

  /** Number of cached WAVs currently on disk. */
  size() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith(".wav")).length;
    } catch (_e) {
      return 0;
    }
  }

  /** Remove every cached WAV. */
  clear() {
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith(".wav")) {
          fs.unlinkSync(path.join(this.dir, f));
        }
      }
    } catch (_e) {
      // best-effort
    }
  }
}

module.exports = { PhraseCache, DEFAULT_CACHE_DIR };

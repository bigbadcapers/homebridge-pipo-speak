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
 * Every normalized text + speed request has one small manifest listing its
 * available provider/voice artifacts. Lookup reads exactly that manifest, then
 * returns its highest-quality valid WAV. Writes copy the WAV and replace the
 * manifest atomically, so every renderer uses the same persistence path.
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
    this.dir =
      opts.dir || process.env.PIPO_SPEAK_CACHE_DIR || DEFAULT_CACHE_DIR;
    this.maxEntries = Number.isFinite(opts.maxEntries) ? opts.maxEntries : 64;
    this.enabled = opts.enabled !== false && this.maxEntries > 0;
  }

  /** Provider-independent identity shared by every rendering of a request. */
  requestKey(text, lengthScale) {
    const norm = `${lengthScale == null ? 1 : lengthScale}|${text}`;
    return crypto.createHash("sha1").update(norm, "utf8").digest("hex");
  }

  manifestPath(text, lengthScale) {
    return path.join(this.dir, `${this.requestKey(text, lengthScale)}.json`);
  }

  artifactPath(text, lengthScale, artifact) {
    const identity = `${artifact.provider || "unknown"}|${artifact.voice || ""}`;
    const variantKey = crypto
      .createHash("sha1")
      .update(identity, "utf8")
      .digest("hex")
      .slice(0, 12);
    return path.join(
      this.dir,
      `${this.requestKey(text, lengthScale)}-${variantKey}.wav`,
    );
  }

  /**
   * Return the highest-quality valid artifact for a logical request.
   * @param {string} text
   * @param {number} lengthScale
   * @returns {{path:string,voice:string,provider:string,quality:number}|null}
   */
  getBest(text, lengthScale) {
    if (!this.enabled) {
      return null;
    }
    try {
      const manifest = JSON.parse(
        fs.readFileSync(this.manifestPath(text, lengthScale), "utf8"),
      );
      const variants = (Array.isArray(manifest.artifacts)
        ? manifest.artifacts
        : []
      )
        .map((artifact) => ({
          ...artifact,
          path: path.join(this.dir, artifact.file || ""),
        }))
        .filter((artifact) => {
          try {
            return artifact.file && fs.statSync(artifact.path).size > 0;
          } catch (_e) {
            return false;
          }
        })
        .sort((a, b) => b.quality - a.quality);
      const best = variants[0] || null;
      if (best) {
        const now = new Date();
        fs.utimes(best.path, now, now, () => {});
      }
      return best;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Copy a freshly synthesized WAV into the cache (the source is left intact for
   * the caller to play/clean up). Best-effort: a cache failure never breaks
   * playback. Returns the cached path, or null if disabled/failed.
   * @returns {Promise<string|null>}
   */
  async store(srcWav, text, lengthScale, artifact) {
    if (!this.enabled) {
      return null;
    }
    const dest = this.artifactPath(text, lengthScale, artifact);
    const tmp = `${dest}.${process.pid}.tmp`;
    const manifestPath = this.manifestPath(text, lengthScale);
    const manifestTmp = `${manifestPath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.copyFile(srcWav, tmp);
      await fs.promises.rename(tmp, dest);
      let artifacts = [];
      try {
        const current = JSON.parse(
          await fs.promises.readFile(manifestPath, "utf8"),
        );
        artifacts = Array.isArray(current.artifacts) ? current.artifacts : [];
      } catch (_e) {
        // First artifact for this request, or a stale manifest being replaced.
      }
      const entry = {
        file: path.basename(dest),
        provider: artifact.provider,
        voice: artifact.voice,
        quality: artifact.quality,
      };
      artifacts = artifacts.filter(
        (item) =>
          item.provider !== entry.provider || item.voice !== entry.voice,
      );
      artifacts.push(entry);
      const manifest = {
        version: 1,
        requestKey: this.requestKey(text, lengthScale),
        lengthScale: lengthScale == null ? 1 : lengthScale,
        artifacts,
      };
      await fs.promises.writeFile(
        manifestTmp,
        JSON.stringify(manifest),
        "utf8",
      );
      await fs.promises.rename(manifestTmp, manifestPath);
      this._evict();
      return dest;
    } catch (err) {
      fs.promises.unlink(tmp).catch(() => {});
      fs.promises.unlink(manifestTmp).catch(() => {});
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
          this._removeFromManifest(path.basename(victim.p));
        } catch (_e) {
          // already gone — ignore
        }
      }
    } catch (_e) {
      // best-effort
    }
  }

  _removeFromManifest(file) {
    const requestKey = file.split("-")[0];
    const manifestPath = path.join(this.dir, `${requestKey}.json`);
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.artifacts = (manifest.artifacts || []).filter(
        (artifact) => artifact.file !== file,
      );
      if (manifest.artifacts.length === 0) {
        fs.unlinkSync(manifestPath);
      } else {
        const tmp = `${manifestPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(manifest), "utf8");
        fs.renameSync(tmp, manifestPath);
      }
    } catch (_e) {
      // Missing/stale manifests do not block eviction.
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
        if (f.endsWith(".wav") || f.endsWith(".json")) {
          fs.unlinkSync(path.join(this.dir, f));
        }
      }
    } catch (_e) {
      // best-effort
    }
  }
}

module.exports = { PhraseCache, DEFAULT_CACHE_DIR };

"use strict";

const crypto = require("crypto");

/**
 * Pure, dependency-free helpers shared across the plugin. Kept here (rather than
 * inline) so they can be unit-tested in isolation.
 */

/**
 * Coerce a value to an integer volume in [0, 100], or return the fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function clampVolume(value, fallback) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0 && n <= 100) {
    return n;
  }
  return fallback;
}

/**
 * Parse an untrusted volume string (query/form input) into an integer in
 * [0, 100], or undefined when absent/invalid. Stricter than clampVolume: only
 * accepts a bare run of digits, never a fallback.
 * @param {*} raw
 * @returns {number|undefined}
 */
function cleanVolume(raw) {
  if (raw == null) {
    return undefined;
  }
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n >= 0 && n <= 100) {
      return n;
    }
  }
  return undefined;
}

/**
 * Convert a human "speed" multiplier into a Piper `--length_scale`. Speed 1.0 is
 * normal; 2.0 is twice as fast; 0.5 is half speed. Piper's length_scale is the
 * inverse (higher = slower), so length_scale = 1 / speed. Speed is clamped to
 * [0.5, 2.0] and the result is rounded to 3 decimals. Invalid input → 1.0.
 * @param {*} speed
 * @returns {number}
 */
function speedToLengthScale(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) {
    return 1;
  }
  const clamped = Math.min(2, Math.max(0.5, s));
  return Math.round((1 / clamped) * 1000) / 1000;
}

/**
 * Constant-time string comparison for auth tokens. Returns false for
 * non-strings or length mismatches without leaking timing on the compare.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function safeTokenEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length || ab.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Normalize free-form utterance text: collapse whitespace/newlines to single
 * spaces and trim. Returns "" for null/undefined.
 * @param {*} raw
 * @returns {string}
 */
function normalizeText(raw) {
  return (raw == null ? "" : String(raw)).replace(/\s+/g, " ").trim();
}

/**
 * Parse the duration, in seconds, of a PCM WAV from its header bytes. Pass the
 * first chunk of the file — a few KB is plenty, since Piper writes the `fmt `
 * and `data` chunk sizes up front. Returns the clip length in seconds, or null
 * when the buffer is not a parseable PCM WAV (the caller then uses a generous
 * fallback timeout instead of trusting a bad number).
 *
 * Dependency-free RIFF reader: the `fmt ` chunk gives the byte rate and the
 * `data` chunk header gives the sample-byte count, so duration = bytes / rate.
 * The declared `data` size is authoritative even when only the head was read,
 * so this works without loading the whole (potentially large) file.
 * @param {*} buf
 * @returns {number|null}
 */
function wavDurationSeconds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) {
    return null;
  }
  if (
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }
  let byteRate = 0;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 12 <= buf.length) {
      byteRate = buf.readUInt32LE(body + 8);
    } else if (id === "data") {
      // The declared size is authoritative even if the body runs past the
      // head we were handed, so capture it and stop.
      dataBytes = size;
      break;
    }
    // RIFF chunks are word-aligned: an odd size carries a trailing pad byte.
    offset = body + size + (size % 2);
  }
  if (byteRate > 0 && dataBytes > 0) {
    return dataBytes / byteRate;
  }
  return null;
}

/**
 * Size a playback watchdog from a known duration in seconds. With a usable
 * (finite, positive) duration the timeout is that length plus headroom;
 * otherwise it falls back to a deliberately generous cap so a legitimately long
 * clip is never killed mid-stream. Mirrors the duration-aware timeout adopted
 * upstream in homebridge-homepod-radio (issue #360), where a fixed ceiling cut
 * long audio off prematurely.
 * @param {*} seconds
 * @param {number} paddingMs headroom added on top of a known length
 * @param {number} unknownMs fallback used when the length is unknown
 * @returns {{ timeoutMs: number, known: boolean }}
 */
function computeTimeout(seconds, paddingMs, unknownMs) {
  const numeric = typeof seconds === "number" ? seconds : NaN;
  const known = Number.isFinite(numeric) && numeric > 0;
  const timeoutMs = known ? Math.ceil(numeric * 1000) + paddingMs : unknownMs;
  return { timeoutMs, known };
}

/**
 * Worst-case wall-clock budget for synthesizing `textLength` characters, in ms.
 * Piper runs faster than real time on a warm box but can crawl on a thrashing
 * Pi, so the budget only ever EXTENDS the proven floor: short phrases keep the
 * original timeout, longer text (a raised maxChars) earns proportionally more
 * room so a slow-but-healthy render is never killed prematurely.
 * @param {*} textLength
 * @param {number} floorMs   minimum budget (the original fixed timeout)
 * @param {number} perCharMs extra budget granted per character
 * @returns {number}
 */
function synthTimeoutMs(textLength, floorMs, perCharMs) {
  const len = Number.isFinite(textLength) && textLength > 0 ? textLength : 0;
  return Math.max(floorMs, Math.ceil(len * perCharMs));
}

module.exports = {
  clampVolume,
  cleanVolume,
  speedToLengthScale,
  safeTokenEqual,
  normalizeText,
  wavDurationSeconds,
  computeTimeout,
  synthTimeoutMs,
};

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

module.exports = {
  clampVolume,
  cleanVolume,
  speedToLengthScale,
  safeTokenEqual,
  normalizeText,
};

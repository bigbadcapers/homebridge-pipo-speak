"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  clampVolume,
  cleanVolume,
  speedToLengthScale,
  safeTokenEqual,
  normalizeText,
  wavDurationSeconds,
  computeTimeout,
  synthTimeoutMs,
} = require("../lib/util");

/** Build a minimal 44-byte PCM WAV header declaring `dataBytes` of audio. */
function makeWavHeader(dataBytes, sampleRate, channels, bits) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

test("clampVolume accepts integers in range, else fallback", () => {
  assert.equal(clampVolume(0, 75), 0);
  assert.equal(clampVolume(100, 75), 100);
  assert.equal(clampVolume(50, 75), 50);
  assert.equal(clampVolume(-1, 75), 75);
  assert.equal(clampVolume(101, 75), 75);
  assert.equal(clampVolume(50.5, 75), 75);
  assert.equal(clampVolume(undefined, 75), 75);
  assert.equal(clampVolume("not a number", 75), 75);
});

test("cleanVolume parses only bare digit strings in range", () => {
  assert.equal(cleanVolume("0"), 0);
  assert.equal(cleanVolume("75"), 75);
  assert.equal(cleanVolume("100"), 100);
  assert.equal(cleanVolume("101"), undefined);
  assert.equal(cleanVolume("-5"), undefined);
  assert.equal(cleanVolume("50.0"), undefined);
  assert.equal(cleanVolume("abc"), undefined);
  assert.equal(cleanVolume(null), undefined);
  assert.equal(cleanVolume(undefined), undefined);
});

test("speedToLengthScale inverts speed and clamps to [0.5, 2]", () => {
  assert.equal(speedToLengthScale(1), 1);
  assert.equal(speedToLengthScale(2), 0.5);
  assert.equal(speedToLengthScale(0.5), 2);
  // clamped
  assert.equal(speedToLengthScale(10), 0.5);
  assert.equal(speedToLengthScale(0.1), 2);
  // invalid → 1
  assert.equal(speedToLengthScale(0), 1);
  assert.equal(speedToLengthScale(-1), 1);
  assert.equal(speedToLengthScale("fast"), 1);
  assert.equal(speedToLengthScale(undefined), 1);
});

test("safeTokenEqual is true only for equal non-empty strings", () => {
  assert.equal(safeTokenEqual("secret", "secret"), true);
  assert.equal(safeTokenEqual("secret", "secres"), false);
  assert.equal(safeTokenEqual("secret", "secret2"), false);
  assert.equal(safeTokenEqual("", ""), false);
  assert.equal(safeTokenEqual("a", ""), false);
  assert.equal(safeTokenEqual(null, "a"), false);
  assert.equal(safeTokenEqual(undefined, undefined), false);
  assert.equal(safeTokenEqual(123, 123), false);
});

test("normalizeText collapses whitespace and trims", () => {
  assert.equal(normalizeText("  hello   world \n"), "hello world");
  assert.equal(normalizeText("a\r\nb\tc"), "a b c");
  assert.equal(normalizeText(""), "");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(undefined), "");
});

test("wavDurationSeconds reads the clip length from the header", () => {
  // 16 kHz mono 16-bit → byteRate 32000; 2.5 s → 80000 data bytes.
  assert.equal(wavDurationSeconds(makeWavHeader(80000, 16000, 1, 16)), 2.5);
});

test("wavDurationSeconds trusts the declared size when the body is absent", () => {
  // Header only (no PCM body), mirroring a head-only read of a large file.
  assert.equal(
    wavDurationSeconds(makeWavHeader(16000 * 2 * 10, 16000, 1, 16)),
    10,
  );
});

test("wavDurationSeconds returns null for non-WAV or truncated input", () => {
  assert.equal(wavDurationSeconds(Buffer.from("not a wav")), null); // too short
  assert.equal(wavDurationSeconds(Buffer.alloc(50)), null); // long enough, wrong magic
  assert.equal(wavDurationSeconds("RIFFWAVE"), null); // not a Buffer
  assert.equal(wavDurationSeconds(null), null);
  assert.equal(wavDurationSeconds(undefined), null);
});

test("computeTimeout sizes a known duration to length + padding", () => {
  assert.deepEqual(computeTimeout(2.5, 30000, 600000), {
    timeoutMs: 2500 + 30000,
    known: true,
  });
  // fractional ms rounds up before padding
  assert.deepEqual(computeTimeout(2.5005, 30000, 600000), {
    timeoutMs: Math.ceil(2.5005 * 1000) + 30000,
    known: true,
  });
});

test("computeTimeout falls back generously for unknown/invalid durations", () => {
  for (const bad of [null, undefined, NaN, 0, -5, Infinity, "5", {}]) {
    assert.deepEqual(computeTimeout(bad, 30000, 600000), {
      timeoutMs: 600000,
      known: false,
    });
  }
});

test("synthTimeoutMs keeps the floor for short text and extends for long text", () => {
  assert.equal(synthTimeoutMs(100, 60000, 100), 60000); // short → floor
  assert.equal(synthTimeoutMs(600, 60000, 100), 60000); // 600*100ms == floor
  assert.equal(synthTimeoutMs(1000, 60000, 100), 100000); // long → extended
  assert.equal(synthTimeoutMs(0, 60000, 100), 60000); // invalid → floor
  assert.equal(synthTimeoutMs(-5, 60000, 100), 60000);
  assert.equal(synthTimeoutMs("x", 60000, 100), 60000);
});

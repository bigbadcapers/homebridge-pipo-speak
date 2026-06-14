"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

// Point the cache at a throwaway dir so the suite never touches vendor/.
process.env.PIPO_SPEAK_CACHE_DIR = path.join(
  os.tmpdir(),
  `pipo-speak-test-cache-${process.pid}`,
);

const { Speaker } = require("../lib/speaker");

function makeSpeaker(opts = {}) {
  const logged = [];
  const log = {
    info: (m) => logged.push(["info", m]),
    warn: (m) => logged.push(["warn", m]),
    error: (m) => logged.push(["error", m]),
  };
  return { speaker: new Speaker({ log, ...opts }), logged };
}

test("say() with empty/whitespace text returns 400 without synthesizing", async () => {
  const { speaker } = makeSpeaker();
  assert.deepEqual(await speaker.say(""), { code: 400, message: "empty text" });
  assert.deepEqual(await speaker.say("   \n\t "), {
    code: 400,
    message: "empty text",
  });
});

test("_clean trims, collapses whitespace, and enforces maxChars", () => {
  const { speaker } = makeSpeaker({ maxChars: 5 });
  assert.equal(speaker._clean("  hello world  "), "hello"); // truncated to 5
  assert.equal(speaker._clean("a\nb"), "a b");
});

test("stats() reports shape used by /healthz", () => {
  const { speaker } = makeSpeaker({ minAvailableMb: 90 });
  const s = speaker.stats();
  assert.equal(s.status, "ok");
  assert.equal(typeof s.voice, "string");
  assert.equal(s.minAvailableMb, 90);
  assert.equal(typeof s.cacheEnabled, "boolean");
  assert.equal(typeof s.cacheSize, "number");
});

test("_route applies per-call overrides over instance defaults", () => {
  const { speaker } = makeSpeaker({
    atvId: "DEFAULT",
    playback: "auto",
    mediaPath: "/var/www/tones",
  });
  const def = speaker._route({});
  assert.equal(def.atvId, "DEFAULT");
  assert.equal(def.playback, "auto");

  const over = speaker._route({
    atvId: "ROOM2",
    playback: "pyatv",
    mediaPath: "/tmp/x",
  });
  assert.equal(over.atvId, "ROOM2");
  assert.equal(over.playback, "pyatv");
  assert.equal(over.mediaPath, "/tmp/x");
});

test("constructor honors speed and cache toggles", () => {
  const { speaker: on } = makeSpeaker();
  assert.equal(on.speed, 1);
  assert.equal(on.cache.enabled, true);

  const { speaker: off } = makeSpeaker({ speed: 1.5, cacheEnabled: false });
  assert.equal(off.speed, 1.5);
  assert.equal(off.cache.enabled, false);
});

test("_playTimeoutMs sizes the watchdog to the measured clip length", () => {
  const { speaker } = makeSpeaker();
  const wav = path.join(os.tmpdir(), `pipo-speak-pt-${process.pid}.wav`);
  fs.writeFileSync(wav, makeWavHeader(2 * 32000, 16000, 1, 16)); // 2 s clip
  try {
    // 2 s audio + 30 s AirPlay-handshake padding.
    assert.equal(speaker._playTimeoutMs(wav), 2000 + 30000);
  } finally {
    fs.rmSync(wav, { force: true });
  }
});

test("_playTimeoutMs falls back to a generous cap for an unreadable clip", () => {
  const { speaker } = makeSpeaker();
  const bad = path.join(os.tmpdir(), `pipo-speak-pt-bad-${process.pid}.bin`);
  fs.writeFileSync(bad, Buffer.from("not a wav"));
  try {
    assert.ok(speaker._playTimeoutMs(bad) >= 10 * 60 * 1000);
  } finally {
    fs.rmSync(bad, { force: true });
  }
  // A missing file must not throw — it also uses the generous fallback.
  const missing = path.join(os.tmpdir(), `pipo-speak-pt-missing-${process.pid}.wav`);
  assert.ok(speaker._playTimeoutMs(missing) >= 10 * 60 * 1000);
});

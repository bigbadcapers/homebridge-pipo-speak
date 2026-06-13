"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

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

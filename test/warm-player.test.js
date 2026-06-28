"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { WarmPlayer } = require("../lib/warm-player");

const log = { info() {}, warn() {}, debug() {}, error() {} };

test("playFile resolves false when not started (graceful fallback)", async () => {
  const wp = new WarmPlayer({ log, atvId: "AABBCCDDEEFF" });
  assert.strictEqual(wp.isReady(), false);
  const ok = await wp.playFile("/tmp/whatever.ogg", 40);
  assert.strictEqual(ok, false);
});

test("stop() is safe before start and prevents readiness", () => {
  const wp = new WarmPlayer({ log, atvId: "AABBCCDDEEFF" });
  wp.stop();
  assert.strictEqual(wp.stopped, true);
  assert.strictEqual(wp.isReady(), false);
});

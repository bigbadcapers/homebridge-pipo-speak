"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PhraseCache } = require("../lib/cache");

let dir;
let srcDir;
let srcWav;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipo-cache-test-"));
  // Keep the source WAV OUTSIDE the cache dir so it isn't counted or evicted.
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipo-cache-src-"));
  srcWav = path.join(srcDir, "_src.wav");
  fs.writeFileSync(srcWav, "RIFF....fake wav bytes");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

test("requestKey is deterministic and varies by text/lengthScale", () => {
  const c = new PhraseCache({ dir });
  const k1 = c.requestKey("hello", 1);
  const k2 = c.requestKey("hello", 1);
  assert.equal(k1, k2);
  assert.notEqual(k1, c.requestKey("hello!", 1));
  assert.notEqual(k1, c.requestKey("hello", 0.5));
  assert.match(k1, /^[0-9a-f]{40}$/);
});

test("store then getBest returns a non-empty cached artifact", async () => {
  const c = new PhraseCache({ dir });
  assert.equal(c.getBest("hello", 1), null);
  const artifact = { provider: "piper", voice: "v", quality: 10 };
  const stored = await c.store(srcWav, "hello", 1, artifact);
  assert.ok(stored);
  const hit = c.getBest("hello", 1);
  assert.ok(hit);
  assert.equal(hit.path, c.artifactPath("hello", 1, artifact));
  assert.equal(hit.provider, "piper");
  assert.ok(fs.statSync(hit.path).size > 0);
  // source is left intact
  assert.ok(fs.existsSync(srcWav));
});

test("getBest persists and ranks provider variants across instances", async () => {
  const first = new PhraseCache({ dir });
  await first.store(srcWav, "hello", 1, {
    provider: "piper",
    voice: "en_US-lessac-low",
    quality: 10,
  });
  await first.store(srcWav, "hello", 1, {
    provider: "azure",
    voice: "en-US-Ava:DragonHDLatestNeural",
    quality: 100,
  });

  const restarted = new PhraseCache({ dir });
  const best = restarted.getBest("hello", 1);
  assert.ok(best);
  assert.equal(best.provider, "azure");
  assert.equal(best.quality, 100);
  assert.equal(best.voice, "en-US-Ava:DragonHDLatestNeural");
});

test("getBest ignores missing artifacts referenced by a manifest", async () => {
  const c = new PhraseCache({ dir });
  const artifact = { provider: "azure", voice: "cloud-voice", quality: 100 };
  const stored = await c.store(srcWav, "missing", 1, artifact);
  fs.unlinkSync(stored);
  assert.equal(c.getBest("missing", 1), null);
});

test("disabled cache stores/returns nothing", async () => {
  const c = new PhraseCache({ dir, enabled: false });
  const stored = await c.store(srcWav, "hello", 1, {
    provider: "piper",
    voice: "v",
    quality: 10,
  });
  assert.equal(stored, null);
  assert.equal(c.getBest("hello", 1), null);
});

test("eviction keeps at most maxEntries, oldest-first", async () => {
  const c = new PhraseCache({ dir, maxEntries: 2 });
  const artifact = { provider: "piper", voice: "v", quality: 10 };
  await c.store(srcWav, "one", 1, artifact);
  await c.store(srcWav, "two", 1, artifact);
  // Pin explicit mtimes (resolution-independent) so "one" is unambiguously the
  // oldest before the third put triggers eviction.
  const old1 = new Date(Date.now() - 10000);
  const old2 = new Date(Date.now() - 5000);
  fs.utimesSync(c.artifactPath("one", 1, artifact), old1, old1);
  fs.utimesSync(c.artifactPath("two", 1, artifact), old2, old2);
  await c.store(srcWav, "three", 1, artifact);
  assert.equal(c.size(), 2);
  // "one" was oldest → evicted
  assert.equal(c.getBest("one", 1), null);
  assert.ok(c.getBest("two", 1));
  assert.ok(c.getBest("three", 1));
});

test("clear removes all cached wavs", async () => {
  const c = new PhraseCache({ dir });
  const artifact = { provider: "piper", voice: "v", quality: 10 };
  await c.store(srcWav, "a", 1, artifact);
  await c.store(srcWav, "b", 1, artifact);
  assert.equal(c.size(), 2);
  c.clear();
  assert.equal(c.size(), 0);
});

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

test("key is deterministic and varies by text/voice/lengthScale", () => {
  const c = new PhraseCache({ dir });
  const k1 = c.key("hello", "en_US-lessac-low", 1);
  const k2 = c.key("hello", "en_US-lessac-low", 1);
  assert.equal(k1, k2);
  assert.notEqual(k1, c.key("hello!", "en_US-lessac-low", 1));
  assert.notEqual(k1, c.key("hello", "en_US-amy-low", 1));
  assert.notEqual(k1, c.key("hello", "en_US-lessac-low", 0.5));
  assert.match(k1, /^[0-9a-f]{40}$/);
});

test("put then get returns a non-empty cached path", async () => {
  const c = new PhraseCache({ dir });
  assert.equal(c.get("hello", "v", 1), null);
  const stored = await c.put(srcWav, "hello", "v", 1);
  assert.ok(stored);
  const hit = c.get("hello", "v", 1);
  assert.ok(hit);
  assert.equal(hit, c.pathFor("hello", "v", 1));
  assert.ok(fs.statSync(hit).size > 0);
  // source is left intact
  assert.ok(fs.existsSync(srcWav));
});

test("disabled cache stores/returns nothing", async () => {
  const c = new PhraseCache({ dir, enabled: false });
  const stored = await c.put(srcWav, "hello", "v", 1);
  assert.equal(stored, null);
  assert.equal(c.get("hello", "v", 1), null);
});

test("eviction keeps at most maxEntries, oldest-first", async () => {
  const c = new PhraseCache({ dir, maxEntries: 2 });
  await c.put(srcWav, "one", "v", 1);
  await c.put(srcWav, "two", "v", 1);
  // Pin explicit mtimes (resolution-independent) so "one" is unambiguously the
  // oldest before the third put triggers eviction.
  const old1 = new Date(Date.now() - 10000);
  const old2 = new Date(Date.now() - 5000);
  fs.utimesSync(c.pathFor("one", "v", 1), old1, old1);
  fs.utimesSync(c.pathFor("two", "v", 1), old2, old2);
  await c.put(srcWav, "three", "v", 1);
  assert.equal(c.size(), 2);
  // "one" was oldest → evicted
  assert.equal(c.get("one", "v", 1), null);
  assert.ok(c.get("two", "v", 1));
  assert.ok(c.get("three", "v", 1));
});

test("clear removes all cached wavs", async () => {
  const c = new PhraseCache({ dir });
  await c.put(srcWav, "a", "v", 1);
  await c.put(srcWav, "b", "v", 1);
  assert.equal(c.size(), 2);
  c.clear();
  assert.equal(c.size(), 0);
});

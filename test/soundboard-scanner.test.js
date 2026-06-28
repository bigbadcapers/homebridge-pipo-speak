"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isAudioFile,
  scanSounds,
} = require("../lib/soundboard-scanner");

/** Create a throwaway directory tree from a { relPath: "" } spec. */
function makeTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipo-sb-"));
  for (const rel of spec) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
  }
  return root;
}

test("isAudioFile matches known audio extensions case-insensitively", () => {
  assert.equal(isAudioFile("a.wav"), true);
  assert.equal(isAudioFile("a.MP3"), true);
  assert.equal(isAudioFile("a.OgG"), true);
  assert.equal(isAudioFile("a.flac"), true);
  assert.equal(isAudioFile("a.txt"), false);
  assert.equal(isAudioFile("a.m3u"), false);
  assert.equal(isAudioFile("noext"), false);
});

test("scanSounds walks depth-first in case-insensitive name order", () => {
  const root = makeTree([
    "README.md",
    "b-dir/two.wav",
    "b-dir/one.wav",
    "a-dir/zeta.mp3",
    "a-dir/sub/deep.ogg",
    "top.wav",
  ]);
  const names = scanSounds(root, { maxSounds: 10 }).map((s) => s.relPath);
  // a-dir before b-dir before top.wav; within a-dir, "sub/" (s) sorts after
  // "zeta.mp3"? no: "sub" < "zeta" so deep.ogg comes first.
  assert.deepEqual(names, [
    path.join("a-dir", "sub", "deep.ogg"),
    path.join("a-dir", "zeta.mp3"),
    path.join("b-dir", "one.wav"),
    path.join("b-dir", "two.wav"),
    "top.wav",
  ]);
});

test("scanSounds stops at maxSounds", () => {
  const root = makeTree([
    "1.wav",
    "2.wav",
    "3.wav",
    "4.wav",
    "5.wav",
  ]);
  const got = scanSounds(root, { maxSounds: 3 });
  assert.equal(got.length, 3);
  assert.deepEqual(
    got.map((s) => s.name),
    ["1.wav", "2.wav", "3.wav"],
  );
});

test("scanSounds ignores dotfiles and non-audio files", () => {
  const root = makeTree([
    ".hidden.wav",
    ".DS_Store",
    "notes.txt",
    "real.wav",
  ]);
  const got = scanSounds(root, { maxSounds: 10 });
  assert.deepEqual(
    got.map((s) => s.name),
    ["real.wav"],
  );
});

test("scanSounds returns empty array for a missing folder", () => {
  const got = scanSounds(path.join(os.tmpdir(), "does-not-exist-xyz"), {});
  assert.deepEqual(got, []);
});

test("scanSounds defaults to 10 sounds when maxSounds is invalid", () => {
  const spec = [];
  for (let i = 0; i < 15; i++) {
    spec.push(`s${String(i).padStart(2, "0")}.wav`);
  }
  const root = makeTree(spec);
  assert.equal(scanSounds(root, { maxSounds: 0 }).length, 10);
  assert.equal(scanSounds(root).length, 10);
});

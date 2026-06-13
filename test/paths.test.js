"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { voiceRelPath } = require("../lib/paths");

test("voiceRelPath maps a voice key to its piper-voices path", () => {
  assert.equal(
    voiceRelPath("en_US-lessac-low"),
    "en/en_US/lessac/low/en_US-lessac-low",
  );
  assert.equal(
    voiceRelPath("en_GB-alan-low"),
    "en/en_GB/alan/low/en_GB-alan-low",
  );
});

test("voiceRelPath keeps multi-word voice names intact", () => {
  assert.equal(
    voiceRelPath("en_US-foo-bar-medium"),
    "en/en_US/foo-bar/medium/en_US-foo-bar-medium",
  );
});

test("voiceRelPath returns null for malformed keys", () => {
  assert.equal(voiceRelPath("bad"), null);
  assert.equal(voiceRelPath("en_US-low"), null);
});

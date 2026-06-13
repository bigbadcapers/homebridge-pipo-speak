"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  clampVolume,
  cleanVolume,
  speedToLengthScale,
  safeTokenEqual,
  normalizeText,
} = require("../lib/util");

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

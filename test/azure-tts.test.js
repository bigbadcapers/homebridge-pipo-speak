"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  AzureTts,
  buildAzureSsml,
  azureLocaleFromVoice,
  azureRatePercent,
  escapeXml,
  DEFAULT_VOICE,
} = require("../lib/azure-tts");

test("escapeXml escapes the five XML metacharacters", () => {
  assert.equal(escapeXml(`a & b < c > d " e ' f`), "a &amp; b &lt; c &gt; d &quot; e &apos; f");
  assert.equal(escapeXml(null), "");
  assert.equal(escapeXml(undefined), "");
});

test("azureLocaleFromVoice extracts the BCP-47 locale", () => {
  assert.equal(azureLocaleFromVoice("en-US-Ava:DragonHDLatestNeural"), "en-US");
  assert.equal(azureLocaleFromVoice("en-GB-RyanNeural"), "en-GB");
  assert.equal(azureLocaleFromVoice("es-MX-Ximena:DragonHDLatestNeural"), "es-MX");
  assert.equal(azureLocaleFromVoice(""), "en-US");
  assert.equal(azureLocaleFromVoice(undefined), "en-US");
});

test("azureRatePercent maps lengthScale (1/speed) to a percentage", () => {
  // normal speed → no adjustment
  assert.equal(azureRatePercent(1), 0);
  // speed 2.0 → lengthScale 0.5 → +100%
  assert.equal(azureRatePercent(0.5), 100);
  // speed 0.5 → lengthScale 2 → -50%
  assert.equal(azureRatePercent(2), -50);
  // rounded 3dp lengthScale for speed 1.5 (0.667) → ~+50%
  assert.equal(azureRatePercent(0.667), 50);
  // invalid → 0
  assert.equal(azureRatePercent(0), 0);
  assert.equal(azureRatePercent(-1), 0);
  assert.equal(azureRatePercent("x"), 0);
});

test("buildAzureSsml omits prosody at normal speed", () => {
  const ssml = buildAzureSsml("Dinner is ready", "en-US-Ava:DragonHDLatestNeural", 1);
  assert.match(ssml, /^<speak version="1.0"/);
  assert.match(ssml, /xml:lang="en-US"/);
  assert.match(ssml, /<voice name="en-US-Ava:DragonHDLatestNeural">Dinner is ready<\/voice>/);
  assert.doesNotMatch(ssml, /prosody/);
});

test("buildAzureSsml adds a single prosody rate wrapper off normal speed", () => {
  const fast = buildAzureSsml("go", "en-US-AriaNeural", 0.5);
  assert.match(fast, /<prosody rate="\+100%">go<\/prosody>/);
  const slow = buildAzureSsml("go", "en-US-AriaNeural", 2);
  assert.match(slow, /<prosody rate="-50%">go<\/prosody>/);
});

test("buildAzureSsml XML-escapes the phrase and voice", () => {
  const ssml = buildAzureSsml(`Tom & "Jerry" <here>`, "en-US-AriaNeural", 1);
  assert.match(ssml, /Tom &amp; &quot;Jerry&quot; &lt;here&gt;/);
  assert.doesNotMatch(ssml, /<here>/);
});

test("AzureTts.configured() requires a key (region defaults to eastus)", () => {
  assert.equal(new AzureTts({ region: "eastus", key: "abc" }).configured(), true);
  assert.equal(new AzureTts({ region: "eastus", key: "" }).configured(), false);
  assert.equal(new AzureTts({ key: "abc" }).configured(), true);
  assert.equal(new AzureTts({ region: "", key: "" }).configured(), false);
});

test("AzureTts derives host, endpoint URL, and default voice", () => {
  const az = new AzureTts({ region: "eastus", key: "abc" });
  assert.equal(az.host, "eastus.tts.speech.microsoft.com");
  assert.equal(az.endpointUrl(), "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
  assert.equal(az.voice, DEFAULT_VOICE);
});

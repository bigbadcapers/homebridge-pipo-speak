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

test("_render falls back to the configured Piper voice when Azure fails", async () => {
  const { speaker, logged } = makeSpeaker({ voice: "en_US-lessac-low" });
  const calls = [];
  speaker.azure = {
    synthesize: async () => {
      calls.push("azure");
      throw new Error("service unavailable");
    },
  };
  speaker._gate = () => calls.push("gate");
  speaker._ensureVoice = async (voice) => calls.push(["ensure", voice]);
  speaker._synthesize = async (_text, voice) => {
    calls.push(["piper", voice]);
    return "/tmp/fallback.wav";
  };

  assert.equal(
    await speaker._render("hello", "en-US-Ava:DragonHDLatestNeural", 1),
    "/tmp/fallback.wav",
  );
  assert.deepEqual(calls, [
    "azure",
    "gate",
    ["ensure", "en_US-lessac-low"],
    ["piper", "en_US-lessac-low"],
  ]);
  assert.ok(
    logged.some(
      ([level, message]) =>
        level === "warn" && message.includes("falling back to offline Piper"),
    ),
  );
});

test("stored Azure audio is used when the live endpoint is unavailable", async () => {
  const { speaker } = makeSpeaker({
    azure: {
      enabled: true,
      voice: "en-US-Ava:DragonHDLatestNeural",
    },
  });
  const phrase = `offline cloud hit ${process.pid}`;
  const source = path.join(os.tmpdir(), `pipo-cloud-hit-${process.pid}.wav`);
  fs.writeFileSync(source, makeWavHeader(16000, 24000, 1, 16));
  try {
    assert.equal(speaker.azure, null);
    await speaker.cache.put(source, phrase, speaker.azureVoice, 1, {
      provider: "azure",
      quality: 100,
    });
    speaker._synthesize = async () => {
      throw new Error("Piper should not run for a stored Azure phrase");
    };

    const prepared = await speaker._prepareWav(phrase, speaker.voice, 1);
    assert.equal(prepared.fromCache, true);
    assert.equal(prepared.temp, false);
    assert.equal(
      prepared.path,
      speaker.cache.pathFor(phrase, speaker.azureVoice, 1),
    );
  } finally {
    fs.rmSync(source, { force: true });
  }
});

test("low-quality cache hits return immediately and schedule one Azure upgrade", async () => {
  const { speaker } = makeSpeaker();
  const phrase = `quiet promotion ${process.pid}`;
  const low = path.join(os.tmpdir(), `pipo-low-${process.pid}.wav`);
  const high = path.join(os.tmpdir(), `pipo-high-${process.pid}.wav`);
  fs.writeFileSync(low, makeWavHeader(16000, 16000, 1, 16));
  fs.writeFileSync(high, makeWavHeader(24000, 24000, 1, 16));
  await speaker.cache.put(low, phrase, speaker.voice, 1, {
    provider: "piper",
    quality: 10,
  });

  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  speaker.azureVoice = "en-US-Ava:DragonHDLatestNeural";
  speaker.azure = {
    synthesize: async () => {
      calls += 1;
      await pending;
      return high;
    },
  };

  try {
    const first = await speaker._prepareWav(phrase, speaker.azureVoice, 1);
    const second = await speaker._prepareWav(phrase, speaker.azureVoice, 1);
    assert.equal(first.path, speaker.cache.pathFor(phrase, speaker.voice, 1));
    assert.equal(second.path, first.path);
    assert.equal(calls, 1);

    release();
    await Promise.all([...speaker._upgrades.values()]);
    const best = speaker.cache.getBest(phrase, 1);
    assert.equal(best.provider, "azure");
    assert.equal(best.quality, 100);
  } finally {
    release();
    fs.rmSync(low, { force: true });
    fs.rmSync(high, { force: true });
  }
});

test("a failed background upgrade leaves the cached fallback usable", async () => {
  const { speaker } = makeSpeaker();
  const phrase = `failed promotion ${process.pid}`;
  const low = path.join(os.tmpdir(), `pipo-failed-low-${process.pid}.wav`);
  fs.writeFileSync(low, makeWavHeader(16000, 16000, 1, 16));
  await speaker.cache.put(low, phrase, speaker.voice, 1, {
    provider: "piper",
    quality: 10,
  });
  speaker.azureVoice = "en-US-Ava:DragonHDLatestNeural";
  speaker.azure = {
    synthesize: async () => {
      throw new Error("offline");
    },
  };

  try {
    const prepared = await speaker._prepareWav(phrase, speaker.azureVoice, 1);
    await Promise.all([...speaker._upgrades.values()]);
    assert.equal(prepared.fromCache, true);
    assert.ok(speaker.cache.get(phrase, speaker.voice, 1));
    assert.equal(speaker.cache.getBest(phrase, 1).quality, 10);
  } finally {
    fs.rmSync(low, { force: true });
  }
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
  const missing = path.join(
    os.tmpdir(),
    `pipo-speak-pt-missing-${process.pid}.wav`,
  );
  assert.ok(speaker._playTimeoutMs(missing) >= 10 * 60 * 1000);
});

test("playFile() returns 400 for no path and 404 for a missing file", async () => {
  const { speaker } = makeSpeaker();
  assert.deepEqual(await speaker.playFile(), {
    code: 400,
    message: "no file path",
  });
  const missing = path.join(os.tmpdir(), `pipo-sb-missing-${process.pid}.wav`);
  const res = await speaker.playFile(missing);
  assert.equal(res.code, 404);
});

test("playFile() routes an existing clip through _play with a kept extension", async () => {
  const { speaker } = makeSpeaker({ defaultVolume: 60 });
  const clip = path.join(os.tmpdir(), `pipo-sb-${process.pid}.mp3`);
  fs.writeFileSync(clip, makeWavHeader(16000, 16000, 1, 16));
  const calls = [];
  speaker._play = async (wav, volume, route) => {
    calls.push({ wav, volume, outName: route.outName });
  };
  try {
    const res = await speaker.playFile(clip);
    assert.equal(res.code, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].wav, clip);
    assert.equal(calls[0].volume, 60);
    assert.equal(calls[0].outName, "pipo-speak-soundboard.mp3");
  } finally {
    fs.rmSync(clip, { force: true });
  }
});

test("playFile() routes AIFF as normalized WAV and removes the temporary file", async () => {
  const { speaker } = makeSpeaker({ defaultVolume: 60 });
  const clip = path.join(os.tmpdir(), `pipo-sb-${process.pid}.aiff`);
  const normalized = path.join(
    os.tmpdir(),
    `pipo-sb-${process.pid}-normalized.wav`,
  );
  fs.writeFileSync(clip, Buffer.from("FORM"));
  fs.writeFileSync(normalized, makeWavHeader(16000, 44100, 2, 16));
  const calls = [];
  speaker._normalizeForPlayback = async () => ({
    path: normalized,
    temp: true,
  });
  speaker._play = async (wav, volume, route) => {
    calls.push({ wav, volume, outName: route.outName });
  };
  try {
    const res = await speaker.playFile(clip);
    assert.equal(res.code, 200);
    assert.deepEqual(calls, [
      { wav: normalized, volume: 60, outName: "pipo-speak-soundboard.wav" },
    ]);
    assert.equal(fs.existsSync(normalized), false);
  } finally {
    fs.rmSync(clip, { force: true });
    fs.rmSync(normalized, { force: true });
  }
});

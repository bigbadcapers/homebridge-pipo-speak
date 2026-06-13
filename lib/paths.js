"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const VENDOR_DIR = path.join(__dirname, "..", "vendor");
const PIPER_DIR = path.join(VENDOR_DIR, "piper");
const VOICES_DIR = path.join(VENDOR_DIR, "voices");

const VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

/**
 * Resolve the Piper executable. Honors PIPO_SPEAK_PIPER_BIN so an existing
 * system install can be reused (e.g. during development on a board where the
 * binary is already present), otherwise falls back to the bundled copy that
 * the postinstall script downloads into vendor/piper/.
 */
function resolvePiperBin() {
  const override = process.env.PIPO_SPEAK_PIPER_BIN;
  if (override) {
    return override;
  }
  // The official Piper tarball extracts to a nested "piper/" folder.
  const candidates = [
    path.join(PIPER_DIR, "piper", "piper"),
    path.join(PIPER_DIR, "piper"),
    path.join(PIPER_DIR, "piper.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return candidates[0];
}

/**
 * Resolve a voice .onnx model by key (e.g. "en_US-lessac-low"). Honors
 * PIPO_SPEAK_VOICE_FILE for an absolute override.
 */
function resolveVoiceFile(voiceKey) {
  const override = process.env.PIPO_SPEAK_VOICE_FILE;
  if (override) {
    return override;
  }
  const key = voiceKey || "en_US-lessac-low";
  return path.join(VOICES_DIR, key + ".onnx");
}

/**
 * Map a voice key to its path under the piper-voices repo.
 * e.g. en_US-lessac-low -> en/en_US/lessac/low/en_US-lessac-low
 */
function voiceRelPath(key) {
  const parts = key.split("-");
  if (parts.length < 3) {
    return null;
  }
  const locale = parts[0];
  const name = parts.slice(1, parts.length - 1).join("-");
  const quality = parts[parts.length - 1];
  const lang = locale.split("_")[0];
  return `${lang}/${locale}/${name}/${quality}/${key}`;
}

function download(url, dest, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 8) {
      return reject(new Error("too many redirects"));
    }
    const tmp = `${dest}.download`;
    const file = fs.createWriteStream(tmp);
    const req = https.get(
      url,
      { headers: { "User-Agent": "homebridge-pipo-speak" } },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          file.close();
          fs.unlink(tmp, () => {});
          const next = new URL(res.headers.location, url).toString();
          return resolve(download(next, dest, (redirects || 0) + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          file.close();
          fs.unlink(tmp, () => {});
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        res.pipe(file);
        file.on("finish", () =>
          file.close(() => {
            fs.rename(tmp, dest, (err) => (err ? reject(err) : resolve(dest)));
          }),
        );
      },
    );
    req.on("error", (err) => {
      file.close();
      fs.unlink(tmp, () => {});
      reject(err);
    });
  });
}

/**
 * Ensure the .onnx model (and its .onnx.json config) for a voice key exist on
 * disk, downloading them once from the piper-voices repo if missing. This lets
 * the config UI offer a voice dropdown while only one voice ships at install
 * time — the selected voice is fetched lazily the first time it speaks.
 * Honors PIPO_SPEAK_VOICE_FILE as an absolute override (no download).
 * @returns {Promise<string>} absolute path to the .onnx model
 */
async function ensureVoiceFile(voiceKey) {
  if (process.env.PIPO_SPEAK_VOICE_FILE) {
    return process.env.PIPO_SPEAK_VOICE_FILE;
  }
  const key = voiceKey || "en_US-lessac-low";
  const onnx = path.join(VOICES_DIR, key + ".onnx");
  const json = path.join(VOICES_DIR, key + ".onnx.json");
  if (fs.existsSync(onnx) && fs.existsSync(json)) {
    return onnx;
  }
  const rel = voiceRelPath(key);
  if (!rel) {
    throw new Error(
      `cannot parse voice key "${key}" (expected form like en_US-lessac-low)`,
    );
  }
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  if (!fs.existsSync(json)) {
    await download(`${VOICE_BASE}/${rel}.onnx.json?download=true`, json, 0);
  }
  if (!fs.existsSync(onnx)) {
    await download(`${VOICE_BASE}/${rel}.onnx?download=true`, onnx, 0);
  }
  return onnx;
}

module.exports = {
  VENDOR_DIR,
  PIPER_DIR,
  VOICES_DIR,
  resolvePiperBin,
  resolveVoiceFile,
  ensureVoiceFile,
  voiceRelPath,
};

'use strict';

const fs = require('fs');
const path = require('path');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
const PIPER_DIR = path.join(VENDOR_DIR, 'piper');
const VOICES_DIR = path.join(VENDOR_DIR, 'voices');

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
    path.join(PIPER_DIR, 'piper', 'piper'),
    path.join(PIPER_DIR, 'piper'),
    path.join(PIPER_DIR, 'piper.exe'),
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
  const key = voiceKey || 'en_US-lessac-low';
  return path.join(VOICES_DIR, key + '.onnx');
}

module.exports = {
  VENDOR_DIR,
  PIPER_DIR,
  VOICES_DIR,
  resolvePiperBin,
  resolveVoiceFile,
};

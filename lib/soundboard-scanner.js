"use strict";

const fs = require("fs");
const path = require("path");

// Audio container/codec extensions atvremote (pyatv) and the homepod-radio
// ffmpeg path can both stream. Kept lowercase; matching is case-insensitive.
const AUDIO_EXTENSIONS = new Set([
  ".wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
  ".aiff",
  ".aif",
  ".wma",
]);

const DEFAULT_MAX_SOUNDS = 10;

/** True when `name` ends in a known audio extension (case-insensitive). */
function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Case-insensitive name sort so the depth-first walk is deterministic across
 * platforms (readdir order is not guaranteed). Ties fall back to the raw name.
 */
function byNameCi(a, b) {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Depth-first scan of `rootDir` for the first `maxSounds` playable audio files.
 *
 * Entries in each directory are visited in case-insensitive name order; a
 * subdirectory is descended into the moment it is reached (true depth-first),
 * so the result mirrors what a person reading the tree top-to-bottom would pick.
 * Symlinked directories are not followed (avoids cycles and escaping the root).
 *
 * @param {string} rootDir absolute path to the soundboard source folder
 * @param {object} [opts]
 * @param {number} [opts.maxSounds=10]
 * @returns {Array<{name:string, path:string, relPath:string}>}
 */
function scanSounds(rootDir, opts = {}) {
  const maxSounds =
    Number.isInteger(opts.maxSounds) && opts.maxSounds > 0
      ? opts.maxSounds
      : DEFAULT_MAX_SOUNDS;

  const found = [];
  const root = path.resolve(rootDir);

  const walk = (dir) => {
    if (found.length >= maxSounds) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      return; // unreadable directory — skip quietly
    }
    entries.sort((a, b) => byNameCi(a.name, b.name));
    for (const entry of entries) {
      if (found.length >= maxSounds) {
        return;
      }
      // Skip dotfiles/dirs (e.g. .DS_Store, .git) and the half-written temp
      // clips the speaker drops into a served media folder.
      if (entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full); // depth-first: descend before moving on
      } else if (entry.isFile() && isAudioFile(entry.name)) {
        found.push({
          name: entry.name,
          path: full,
          relPath: path.relative(root, full),
        });
      }
    }
  };

  walk(root);
  return found;
}

module.exports = {
  AUDIO_EXTENSIONS,
  DEFAULT_MAX_SOUNDS,
  isAudioFile,
  scanSounds,
};

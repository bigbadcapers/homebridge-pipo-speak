#!/usr/bin/env node
'use strict';

/**
 * postinstall — fetch a lean, fully-offline Piper speech engine + one voice so
 * the plugin is self-contained (no compiler, no Python, no cloud). Mirrors the
 * approach used by ffmpeg-for-homebridge: detect platform/arch, download a
 * prebuilt binary from a pinned release, and unpack it next to the plugin.
 *
 * Design goals:
 *   - Idempotent: skip work if the binary + voice are already present.
 *   - Non-fatal: never fail the npm install on an unsupported platform or a
 *     transient network error — print clear guidance instead, so Homebridge
 *     can still start (the plugin just reports the missing engine at runtime).
 *   - Opt-out: PIPO_SPEAK_SKIP_DOWNLOAD=1 skips entirely (for CI / air-gapped
 *     boxes that pre-stage vendor/ themselves).
 *
 * Licensing: Piper ships as a separate executable that this plugin merely
 * spawns at arm's length (no linking), so its license is independent of this
 * MIT-licensed plugin — the same arrangement ffmpeg-for-homebridge relies on.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const VENDOR = path.join(__dirname, '..', 'vendor');
const PIPER_DIR = path.join(VENDOR, 'piper');
const VOICES_DIR = path.join(VENDOR, 'voices');

const PIPER_RELEASE = '2023.11.14-2';
const PIPER_BASE = `https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}`;
const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const DEFAULT_VOICE = process.env.PIPO_SPEAK_VOICE || 'en_US-lessac-low';

function log(msg) {
  process.stdout.write(`pipo-speak postinstall: ${msg}\n`);
}

function piperAsset() {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'linux') {
    if (arch === 'x64') return 'piper_linux_x86_64.tar.gz';
    if (arch === 'arm64') return 'piper_linux_aarch64.tar.gz';
    if (arch === 'arm') return 'piper_linux_armv7l.tar.gz';
  } else if (platform === 'darwin') {
    if (arch === 'x64') return 'piper_macos_x64.tar.gz';
    if (arch === 'arm64') return 'piper_macos_aarch64.tar.gz';
  }
  return null;
}

function voicePath(key) {
  // e.g. en_US-lessac-low -> en/en_US/lessac/low/en_US-lessac-low.onnx
  const parts = key.split('-');
  if (parts.length < 3) {
    return null;
  }
  const locale = parts[0];
  const name = parts.slice(1, parts.length - 1).join('-');
  const quality = parts[parts.length - 1];
  const lang = locale.split('_')[0];
  return `${lang}/${locale}/${name}/${quality}/${key}`;
}

function download(url, dest, redirects) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      return reject(new Error('too many redirects'));
    }
    const tmp = `${dest}.download`;
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, { headers: { 'User-Agent': 'homebridge-pipo-speak' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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
      file.on('finish', () => file.close(() => {
        fs.rename(tmp, dest, (err) => (err ? reject(err) : resolve(dest)));
      }));
    });
    req.on('error', (err) => {
      file.close();
      fs.unlink(tmp, () => {});
      reject(err);
    });
  });
}

function piperInstalled() {
  return fs.existsSync(path.join(PIPER_DIR, 'piper', 'piper'))
    || fs.existsSync(path.join(PIPER_DIR, 'piper'));
}

function voiceInstalled(key) {
  return fs.existsSync(path.join(VOICES_DIR, `${key}.onnx`))
    && fs.existsSync(path.join(VOICES_DIR, `${key}.onnx.json`));
}

async function installPiper() {
  if (piperInstalled()) {
    log('piper already present, skipping.');
    return true;
  }
  const asset = piperAsset();
  if (!asset) {
    log(`no prebuilt Piper for ${os.platform()}/${os.arch()}. The plugin will`);
    log('look for a system Piper via PIPO_SPEAK_PIPER_BIN. See the README.');
    return false;
  }
  fs.mkdirSync(PIPER_DIR, { recursive: true });
  const url = `${PIPER_BASE}/${asset}`;
  const tarball = path.join(PIPER_DIR, asset);
  log(`downloading Piper (${asset})...`);
  await download(url, tarball, 0);
  log('extracting Piper...');
  const res = spawnSync('tar', ['-xzf', tarball, '-C', PIPER_DIR], { stdio: 'inherit' });
  fs.unlink(tarball, () => {});
  if (res.status !== 0) {
    throw new Error('tar extraction failed (is "tar" on PATH?)');
  }
  const bin = path.join(PIPER_DIR, 'piper', 'piper');
  if (fs.existsSync(bin)) {
    try { fs.chmodSync(bin, 0o755); } catch (_e) { /* best effort */ }
  }
  log('piper ready.');
  return true;
}

async function installVoice(key) {
  if (voiceInstalled(key)) {
    log(`voice ${key} already present, skipping.`);
    return;
  }
  const rel = voicePath(key);
  if (!rel) {
    log(`cannot parse voice key "${key}"; expected form like en_US-lessac-low.`);
    return;
  }
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  const onnx = path.join(VOICES_DIR, `${key}.onnx`);
  const json = path.join(VOICES_DIR, `${key}.onnx.json`);
  log(`downloading voice ${key} (model + config)...`);
  await download(`${VOICE_BASE}/${rel}.onnx?download=true`, onnx, 0);
  await download(`${VOICE_BASE}/${rel}.onnx.json?download=true`, json, 0);
  log('voice ready.');
}

async function main() {
  if (process.env.PIPO_SPEAK_SKIP_DOWNLOAD === '1') {
    log('PIPO_SPEAK_SKIP_DOWNLOAD=1 set, skipping engine/voice download.');
    return;
  }
  try {
    const ok = await installPiper();
    if (ok) {
      await installVoice(DEFAULT_VOICE);
    }
  } catch (err) {
    log(`WARNING: could not finish setup: ${err.message}`);
    log('The plugin is installed but speech will not work until the Piper');
    log('engine and a voice are available. Re-run "npm run fetch-voice" in the');
    log('plugin directory once connectivity is restored, or set');
    log('PIPO_SPEAK_PIPER_BIN / PIPO_SPEAK_VOICE_FILE to existing files.');
  }
}

main();

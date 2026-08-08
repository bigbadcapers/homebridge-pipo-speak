"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");

/**
 * Azure AI Speech (cloud) text-to-speech backend.
 *
 * This is the optional "high quality" path: instead of running an offline Piper
 * model on the Pi, a short phrase is rendered by Azure's Neural / Dragon HD
 * voices and the resulting WAV is dropped into the same on-disk phrase cache the
 * offline path uses. Because it is a plain HTTPS request that writes a file, it
 * carries none of the RAM/watchdog risk a local neural model would on a 416 MB
 * board — the memory gate that guards Piper does not apply here.
 *
 * Zero runtime dependencies: only Node built-ins, consistent with the rest of
 * the plugin. The default output format (24 kHz 16-bit mono PCM WAV) plays the
 * same way Piper's output does through homepod-radio / pyatv.
 */

// 24 kHz mono PCM RIFF WAV — the same shape the offline Piper path produces, so
// the existing playback + duration-parsing code handles it unchanged.
const DEFAULT_OUTPUT_FORMAT = "riff-24khz-16bit-mono-pcm";
const DEFAULT_VOICE = "en-US-Ava:DragonHDLatestNeural";
const DEFAULT_REGION = "eastus";
const DEFAULT_TIMEOUT_MS = 20000;

/** XML-escape a string for safe inclusion in SSML text/attributes. */
function escapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Derive the BCP-47 locale (e.g. "en-US") from an Azure voice short name like
 * "en-US-Ava:DragonHDLatestNeural" or "en-GB-RyanNeural". Falls back to en-US.
 * @param {string} voice
 * @returns {string}
 */
function azureLocaleFromVoice(voice) {
  const m = /^([a-z]{2,3}-[A-Za-z]{2,})/.exec(String(voice || ""));
  return m ? m[1] : "en-US";
}

/**
 * Convert the plugin's Piper-style `lengthScale` (= 1 / speed) into an Azure
 * SSML prosody rate percentage. Normal speed (lengthScale 1) → 0 (no wrapper).
 * A raised speed reads faster (+%), a lowered speed slower (-%). Clamped to the
 * same effective [0.5x, 2x] window the offline path uses.
 * @param {number} lengthScale
 * @returns {number} integer percent, 0 = default rate
 */
function azureRatePercent(lengthScale) {
  const ls = Number(lengthScale);
  if (!Number.isFinite(ls) || ls <= 0 || ls === 1) {
    return 0;
  }
  const speed = Math.min(2, Math.max(0.5, 1 / ls));
  return Math.round((speed - 1) * 100);
}

/**
 * Build the SSML document for one phrase. Kept minimal (no explicit emotion
 * tags) so it works with the Dragon HD voices, which infer prosody from the
 * text; a non-default speed adds a single <prosody rate> wrapper.
 * @param {string} text
 * @param {string} voice Azure voice short name
 * @param {number} lengthScale
 * @returns {string}
 */
function buildAzureSsml(text, voice, lengthScale) {
  const locale = azureLocaleFromVoice(voice);
  const safeText = escapeXml(text);
  const percent = azureRatePercent(lengthScale);
  const inner =
    percent === 0
      ? safeText
      : `<prosody rate="${percent > 0 ? "+" : ""}${percent}%">${safeText}</prosody>`;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xml:lang="${locale}"><voice name="${escapeXml(voice)}">${inner}</voice></speak>`
  );
}

class AzureTts {
  /**
   * @param {object} opts
   * @param {object} [opts.log] logger (defaults to console)
   * @param {string} [opts.region] Azure region, e.g. "eastus"
   * @param {string} [opts.key] Speech resource subscription key
   * @param {string} [opts.voice] default Azure voice short name
   * @param {string} [opts.outputFormat] X-Microsoft-OutputFormat value
   * @param {number} [opts.timeoutMs] per-request timeout
   */
  constructor(opts = {}) {
    this.log = opts.log || console;
    this.region = (opts.region || DEFAULT_REGION).trim();
    this.key = (opts.key || "").trim();
    this.voice = (opts.voice || DEFAULT_VOICE).trim();
    this.outputFormat = opts.outputFormat || DEFAULT_OUTPUT_FORMAT;
    this.timeoutMs =
      Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    this.host = `${this.region}.tts.speech.microsoft.com`;
    this.endpointPath = "/cognitiveservices/v1";
  }

  /** True when enough is set to attempt a request (region + key). */
  configured() {
    return this.region.length > 0 && this.key.length > 0;
  }

  /** The full TTS endpoint URL (for operational records / logs). */
  endpointUrl() {
    return `https://${this.host}${this.endpointPath}`;
  }

  /**
   * Render one phrase to a temp WAV via Azure and resolve its path. The caller
   * owns the file (caches then deletes it), mirroring the Piper _synthesize
   * contract. Rejects with a clear message on any non-2xx or transport error.
   * @param {string} text already-normalized utterance text
   * @param {string} [voice] Azure voice short name (defaults to configured)
   * @param {number} [lengthScale] speed as 1/speed (defaults to 1)
   * @returns {Promise<string>} path to the written WAV
   */
  synthesize(text, voice, lengthScale) {
    const useVoice = voice || this.voice;
    const ssml = buildAzureSsml(text, useVoice, lengthScale);
    const body = Buffer.from(ssml, "utf8");
    const wav = path.join(
      os.tmpdir(),
      `pipo-speak-azure-${process.pid}-${Date.now()}.wav`,
    );

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: this.host,
          path: this.endpointPath,
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": this.key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": this.outputFormat,
            "User-Agent": "homebridge-pipo-speak",
            "Content-Length": body.length,
          },
        },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let errBody = "";
            res.setEncoding("utf8");
            res.on("data", (d) => {
              if (errBody.length < 500) {
                errBody += d;
              }
            });
            res.on("end", () => {
              reject(
                new Error(
                  `azure TTS HTTP ${res.statusCode}: ${errBody.trim().slice(0, 200)}`,
                ),
              );
            });
            return;
          }
          const out = fs.createWriteStream(wav);
          let failed = false;
          const fail = (err) => {
            if (failed) {
              return;
            }
            failed = true;
            out.destroy();
            fs.promises.unlink(wav).catch(() => {});
            reject(err);
          };
          res.on("error", fail);
          out.on("error", fail);
          out.on("finish", () => {
            if (!failed) {
              resolve(wav);
            }
          });
          res.pipe(out);
        },
      );

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(
          new Error(`azure TTS request timed out after ${this.timeoutMs}ms`),
        );
      });
      req.on("error", (err) => {
        fs.promises.unlink(wav).catch(() => {});
        reject(new Error(`azure TTS request failed: ${err.message}`));
      });
      req.write(body);
      req.end();
    });
  }
}

module.exports = {
  AzureTts,
  buildAzureSsml,
  azureLocaleFromVoice,
  azureRatePercent,
  escapeXml,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_VOICE,
  DEFAULT_REGION,
};

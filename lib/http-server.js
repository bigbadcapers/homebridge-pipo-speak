"use strict";

const http = require("http");
const { URL } = require("url");

const { cleanVolume, safeTokenEqual } = require("./util");

/**
 * Optional LAN "speak anything" HTTP endpoint. Off by default. By design there
 * is no auth unless a token is configured — intended for a trusted LAN. Routes:
 *
 *   POST /say            body = text (text/plain, or form text=)
 *   GET  /say?text=...   convenience for quick tests
 *   GET  /healthz        liveness + status JSON (never requires a token)
 *   Optional ?volume=NN  overrides the default volume for one request.
 *
 * When a token is set, every /say request must present it via ?token=,
 * Authorization: Bearer <token>, or X-Auth-Token. /healthz stays open so
 * uptime probes work without embedding the secret.
 *
 * All requests funnel through the same serialized, memory-gated Speaker, so the
 * HTTP path can never run a second synthesis concurrently with a button press.
 */
class SpeakHttpServer {
  constructor({ log, speaker, port, bind, maxChars, token }) {
    this.log = log;
    this.speaker = speaker;
    this.port = port || 8095;
    this.bind = bind || "0.0.0.0";
    this.maxBody = 65536;
    this.maxChars = maxChars || 600;
    this.token = token || null;
    this.server = null;
  }

  start() {
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on("error", (err) => {
      this.log.error(`pipo-speak HTTP server error: ${err.message}`);
    });
    this.server.listen(this.port, this.bind, () => {
      const auth = this.token ? "token required" : "no auth";
      this.log.info(
        `pipo-speak: LAN HTTP endpoint listening on ${this.bind}:${this.port} (POST /say, ${auth})`,
      );
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  _reply(res, code, msg) {
    const body = Buffer.from(msg + "\n", "utf8");
    res.writeHead(code, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": body.length,
    });
    res.end(body);
  }

  _replyJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj) + "\n", "utf8");
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
    });
    res.end(body);
  }

  /** Extract a presented token from query, Authorization, or X-Auth-Token. */
  _presentedToken(req, parsed) {
    const q = parsed.searchParams.get("token");
    if (q) {
      return q;
    }
    const auth = req.headers["authorization"];
    if (auth && /^Bearer\s+/i.test(auth)) {
      return auth.replace(/^Bearer\s+/i, "").trim();
    }
    const x = req.headers["x-auth-token"];
    if (x) {
      return String(x).trim();
    }
    return "";
  }

  async _handle(req, res) {
    let parsed;
    try {
      parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch (_e) {
      return this._reply(res, 400, "bad request");
    }

    // Liveness probe — always open, never requires the token.
    if (parsed.pathname === "/healthz") {
      if (req.method !== "GET") {
        return this._reply(res, 405, "method not allowed");
      }
      return this._replyJson(res, 200, this.speaker.stats());
    }

    if (parsed.pathname !== "/say" && parsed.pathname !== "/speak") {
      return this._reply(
        res,
        404,
        "not found; use POST /say or GET /say?text=...",
      );
    }

    // Auth gate (only when a token is configured).
    if (this.token) {
      const presented = this._presentedToken(req, parsed);
      if (!safeTokenEqual(presented, this.token)) {
        return this._reply(res, 401, "unauthorized");
      }
    }

    const qVolume = cleanVolume(parsed.searchParams.get("volume"));

    try {
      if (req.method === "GET") {
        const text =
          parsed.searchParams.get("text") ||
          parsed.searchParams.get("message") ||
          "";
        const { code, message } = await this.speaker.say(text, qVolume);
        return this._reply(res, code, message);
      }
      if (req.method === "POST") {
        const body = await this._readBody(req);
        if (body === null) {
          return this._reply(res, 400, "missing or oversized body");
        }
        const ctype = (req.headers["content-type"] || "").split(";")[0].trim();
        let text = body;
        let volume = qVolume;
        if (
          ctype === "application/x-www-form-urlencoded" &&
          body.includes("=")
        ) {
          const form = new URLSearchParams(body);
          const field = form.get("text") || form.get("message");
          if (field !== null && field !== undefined) {
            text = field;
            if (volume == null) {
              volume = cleanVolume(form.get("volume"));
            }
          }
        }
        const { code, message } = await this.speaker.say(text, volume);
        return this._reply(res, code, message);
      }
      return this._reply(res, 405, "method not allowed");
    } catch (err) {
      this.log.error(`pipo-speak HTTP: ${err.message}`);
      return this._reply(res, 500, "internal error");
    }
  }

  _readBody(req) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      let aborted = false;
      req.on("data", (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > this.maxBody) {
          aborted = true;
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (aborted) return;
        if (size === 0) {
          return resolve(null);
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", () => resolve(null));
    });
  }
}

module.exports = { SpeakHttpServer };

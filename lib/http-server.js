'use strict';

const http = require('http');
const { URL } = require('url');

/**
 * Optional LAN "speak anything" HTTP endpoint. Off by default. No auth by
 * design — intended for a trusted LAN only. Mirrors the routes of the existing
 * pipo-tts Python server so existing callers keep working:
 *
 *   POST /say            body = text (text/plain, or form text=)
 *   GET  /say?text=...   convenience for quick tests
 *   Optional ?volume=NN  overrides the default volume for one request.
 *
 * All requests funnel through the same serialized, memory-gated Speaker, so the
 * HTTP path can never run a second synthesis concurrently with a button press.
 */
class SpeakHttpServer {
  constructor({ log, speaker, port, bind, maxChars }) {
    this.log = log;
    this.speaker = speaker;
    this.port = port || 8095;
    this.bind = bind || '0.0.0.0';
    this.maxBody = 65536;
    this.maxChars = maxChars || 600;
    this.server = null;
  }

  start() {
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('error', (err) => {
      this.log.error(`pipo-speak HTTP server error: ${err.message}`);
    });
    this.server.listen(this.port, this.bind, () => {
      this.log.info(`pipo-speak: LAN HTTP endpoint listening on ${this.bind}:${this.port} (POST /say)`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  _reply(res, code, msg) {
    const body = Buffer.from(msg + '\n', 'utf8');
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
    });
    res.end(body);
  }

  async _handle(req, res) {
    let parsed;
    try {
      parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (_e) {
      return this._reply(res, 400, 'bad request');
    }
    if (parsed.pathname !== '/say' && parsed.pathname !== '/speak') {
      return this._reply(res, 404, 'not found; use POST /say or GET /say?text=...');
    }
    const qVolume = cleanVolume(parsed.searchParams.get('volume'));

    try {
      if (req.method === 'GET') {
        const text = parsed.searchParams.get('text') || parsed.searchParams.get('message') || '';
        const { code, message } = await this.speaker.say(text, qVolume);
        return this._reply(res, code, message);
      }
      if (req.method === 'POST') {
        const body = await this._readBody(req);
        if (body === null) {
          return this._reply(res, 400, 'missing or oversized body');
        }
        const ctype = (req.headers['content-type'] || '').split(';')[0].trim();
        let text = body;
        let volume = qVolume;
        if (ctype === 'application/x-www-form-urlencoded' && body.includes('=')) {
          const form = new URLSearchParams(body);
          const field = form.get('text') || form.get('message');
          if (field !== null && field !== undefined) {
            text = field;
            if (volume == null) {
              volume = cleanVolume(form.get('volume'));
            }
          }
        }
        const { code, message } = await this.speaker.say(text, volume);
        return this._reply(res, code, message);
      }
      return this._reply(res, 405, 'method not allowed');
    } catch (err) {
      this.log.error(`pipo-speak HTTP: ${err.message}`);
      return this._reply(res, 500, 'internal error');
    }
  }

  _readBody(req) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      let aborted = false;
      req.on('data', (chunk) => {
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
      req.on('end', () => {
        if (aborted) return;
        if (size === 0) {
          return resolve(null);
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', () => resolve(null));
    });
  }
}

function cleanVolume(raw) {
  if (raw == null) {
    return undefined;
  }
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n >= 0 && n <= 100) {
      return n;
    }
  }
  return undefined;
}

module.exports = { SpeakHttpServer };

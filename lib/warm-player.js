"use strict";

const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

/**
 * Supervises a resident `warm-worker.py` that holds one warm pyatv connection
 * to the HomePod and replays files on it, eliminating the cold connect (~5-15s)
 * paid by a per-press spawn. Each play is one line of JSON in, one line out.
 *
 * playFile() resolves false when the worker isn't ready or a play fails, so the
 * caller can fall back to its original path — behavior degrades gracefully.
 */
class WarmPlayer {
  /**
   * @param {object} o
   * @param {object} o.log Homebridge logger
   * @param {string} o.atvId 12-hex MAC / id (or RAOP name) of the target
   * @param {boolean} [o.verbose]
   * @param {string} [o.python] python executable (default "python3")
   */
  constructor(o) {
    this.log = o.log;
    this.atvId = o.atvId;
    this.verbose = o.verbose === true;
    this.python = o.python || "python3";
    this.script = path.join(__dirname, "warm-worker.py");
    this.worker = null;
    this.rl = null;
    this.ready = false;
    this.stopped = false;
    this.nextId = 1;
    this.pending = new Map();
    this.restartDelay = 1000;
    this.MAX_RESTART_DELAY = 30000;
    // Idle keepalive: a held AirPlay connection can be silently dropped by the
    // HomePod after a few minutes of no traffic, which would push the cold
    // connect back into the first press. A periodic ping makes the worker
    // re-verify (and transparently reconnect) the link so it stays warm.
    this.keepaliveMs = Number.isFinite(o.keepaliveMs) ? o.keepaliveMs : 90000;
    this.keepalive = null;
  }

  isReady() {
    return this.ready && this.worker != null && !this.stopped;
  }

  start() {
    if (this.stopped || this.worker) {
      return;
    }
    const args = ["-u", this.script, "--id", this.atvId];
    if (this.verbose) {
      args.push("--verbose");
    }
    this.worker = spawn(this.python, args, { env: { ...process.env } });
    this.rl = readline.createInterface({ input: this.worker.stdout });
    this.rl.on("line", (line) => this._onLine(line));
    this.worker.stderr.on("data", (d) => {
      if (this.verbose) {
        this.log.debug(`pipo-speak: warm-worker: ${d.toString().trim()}`);
      }
    });
    this.worker.on("error", (err) => {
      this.log.warn(`pipo-speak: warm-worker spawn error: ${err.message}`);
    });
    this.worker.on("exit", () => {
      this.ready = false;
      this._stopKeepalive();
      this.rl?.close();
      this.rl = null;
      this.worker = null;
      this._failAll();
      if (!this.stopped) {
        setTimeout(() => this.start(), this.restartDelay);
        this.restartDelay = Math.min(
          this.restartDelay * 2,
          this.MAX_RESTART_DELAY,
        );
      }
    });
  }

  stop() {
    this.stopped = true;
    this._stopKeepalive();
    this._failAll();
    if (this.worker) {
      try {
        this.worker.stdin.end();
      } catch (_e) {
        // ignore
      }
      this.worker.kill();
      this.worker = null;
    }
  }

  _startKeepalive() {
    if (this.keepalive || this.keepaliveMs <= 0) {
      return;
    }
    this.keepalive = setInterval(() => {
      if (!this.isReady()) {
        return;
      }
      const id = this.nextId++;
      try {
        this.worker.stdin.write(
          JSON.stringify({ id, cmd: "ping" }) + "\n",
        );
      } catch (_e) {
        // exit handler restarts the worker
      }
    }, this.keepaliveMs);
    if (this.keepalive.unref) {
      this.keepalive.unref();
    }
  }

  _stopKeepalive() {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_e) {
      return;
    }
    if (msg.event === "ready") {
      this.ready = true;
      this.restartDelay = 1000;
      this.log.info(`pipo-speak: warm AirPlay connection ready (${this.atvId})`);
      this._startKeepalive();
      return;
    }
    const p = this.pending.get(msg.id);
    if (p) {
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg.ok === true);
    }
  }

  _failAll() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this.pending.clear();
  }

  /**
   * Replay a file on the warm connection. Resolves true on success, false if the
   * worker isn't ready, errors, or times out (caller falls back).
   * @param {string} filePath
   * @param {number} volume 0-100 (0 = leave volume unchanged)
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>}
   */
  playFile(filePath, volume, timeoutMs = 60000) {
    if (!this.isReady()) {
      return Promise.resolve(false);
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        this.worker.stdin.write(
          JSON.stringify({ id, cmd: "play", file: filePath, volume }) + "\n",
        );
      } catch (_e) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(false);
      }
    });
  }
}

module.exports = { WarmPlayer };

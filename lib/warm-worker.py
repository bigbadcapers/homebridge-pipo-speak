#!/usr/bin/python3
"""Resident pyatv worker for homebridge-pipo-speak (warm-connection mode).

Spawned once by the plugin when the soundboard has warm playback enabled. It
imports pyatv a single time, scans for and connects to the target HomePod once,
then holds that connection open and reuses it for every press. This removes the
~5-15 s per-press cost (cold ``import pyatv`` + device scan + AirPlay handshake)
paid when a fresh process is spawned for each clip.

Protocol (newline-delimited JSON, one object per line):

    stdin   {"id": <n>, "cmd": "play", "file": "<abs path>", "volume": <0-100>}
            {"id": <n>, "cmd": "ping"}

    stdout  {"event": "ready"}                  (once, after startup)
            {"id": <n>, "ok": true}
            {"id": <n>, "ok": false, "error": "..."}

Human-readable logging goes to stderr so stdout stays a clean protocol channel.
A volume of 0 (or missing) means "do not change volume".
"""
import argparse
import asyncio
import json
import logging
import os
import re
import sys

try:
    import pyatv
    from pyatv.const import Protocol
    from pyatv.interface import MediaMetadata
    _IMPORT_ERROR = None
except ImportError as ex:  # pragma: no cover - exercised only without pyatv
    pyatv = None
    Protocol = None
    MediaMetadata = None
    _IMPORT_ERROR = ex

_LOG = logging.getLogger("pipo-warm")


def _out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class WarmConnection:
    """Owns a single, reused pyatv connection to the target device."""

    def __init__(self, identifier, loop):
        self.identifier = identifier
        self.loop = loop
        self.atv = None
        self._lock = asyncio.Lock()

    async def _scan(self):
        ident = re.compile(r"^[0-9A-Fa-f]{12}$")
        mac = re.compile(r"^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$")
        found = []
        if ident.match(self.identifier) or mac.match(self.identifier):
            _LOG.info("scan by id: %s", self.identifier)
            found = await pyatv.scan(self.loop, identifier=self.identifier, timeout=5)
        if not found:
            _LOG.info("scan by name: %s", self.identifier)
            all_atv = await pyatv.scan(self.loop, protocol=Protocol.RAOP, timeout=5)
            found = [a for a in all_atv if a.name == self.identifier]
        if not found:
            raise RuntimeError("device not found: %s" % self.identifier)
        return found[0]

    async def ensure_connected(self):
        if self.atv is not None:
            return self.atv
        conf = await self._scan()
        _LOG.info("connecting to %s", conf.address)
        self.atv = await pyatv.connect(conf, self.loop)
        _LOG.info("connected; holding warm")
        return self.atv

    def close(self):
        if self.atv is not None:
            try:
                self.atv.close()
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass
            self.atv = None

    async def play(self, file_path, volume):
        async with self._lock:
            last = None
            for attempt in (1, 2):
                try:
                    atv = await self.ensure_connected()
                    if volume and int(volume) > 0:
                        try:
                            await atv.audio.set_volume(float(volume))
                        except Exception as ex:  # noqa: BLE001
                            _LOG.warning("set_volume(%s) failed: %s", volume, ex)
                    meta = MediaMetadata(title=os.path.basename(file_path))
                    _LOG.info("stream %s (attempt %d)", file_path, attempt)
                    await atv.stream.stream_file(file_path, metadata=meta)
                    return
                except Exception as ex:  # noqa: BLE001
                    last = ex
                    _LOG.error("attempt %d failed: %s", attempt, ex)
                    self.close()
            raise last if last is not None else RuntimeError("play failed")


async def _readline(loop):
    return await loop.run_in_executor(None, sys.stdin.readline)


async def main_async(identifier):
    loop = asyncio.get_running_loop()
    conn = WarmConnection(identifier, loop)
    try:
        await conn.ensure_connected()
    except Exception as ex:  # noqa: BLE001
        _LOG.warning("initial warmup failed (will retry on first play): %s", ex)
    _out({"event": "ready"})

    while True:
        line = await _readline(loop)
        if line == "":
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        rid = msg.get("id")
        cmd = msg.get("cmd")
        if cmd == "ping":
            _out({"id": rid, "ok": True, "pong": True})
            continue
        if cmd == "play":
            f = msg.get("file")
            vol = msg.get("volume", 0)
            if not f:
                _out({"id": rid, "ok": False, "error": "missing file"})
                continue
            try:
                await conn.play(f, vol)
                _out({"id": rid, "ok": True})
            except Exception as ex:  # noqa: BLE001
                _out({"id": rid, "ok": False, "error": str(ex)})
            continue
        _out({"id": rid, "ok": False, "error": "unknown cmd: %s" % cmd})
    conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--id", dest="id", required=True)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s]: %(message)s",
        stream=sys.stderr,
    )
    if pyatv is None:
        _LOG.error("pyatv not available: %s", _IMPORT_ERROR)
        sys.exit(2)
    try:
        asyncio.run(main_async(args.id))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

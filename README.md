<span align="center">

# HomePod Say Anything

</span>

<p align="center">
  <a href="https://github.com/homebridge/homebridge"><img src="https://img.shields.io/badge/homebridge-plugin-blueviolet" alt="homebridge plugin" /></a>
  <img src="https://img.shields.io/badge/homebridge_v2.0-ready-4CAF50" alt="homebridge v2 ready" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
  <img src="https://img.shields.io/badge/dependencies-0_npm-success" alt="zero npm dependencies" />
</p>

> **`homebridge-pipo-speak`** — speak short text phrases on your HomePod (or any
> AirPlay speaker) from HomeKit.

Each phrase you configure shows up in the Home app as a **momentary switch** —
flip it on and the phrase is spoken, then it resets itself. Optionally, expose a
small **LAN HTTP endpoint** so other devices on your network can speak arbitrary
text.

Speech is synthesized **fully offline** with a bundled [Piper](https://github.com/rhasspy/piper)
voice — nothing is sent to the cloud, and there is no compiler or Python
dependency to install. The Piper engine and one voice are downloaded
automatically on `npm install` (the same self-contained approach used by
`ffmpeg-for-homebridge`).

## Installation

Install through the **Homebridge UI** (search for "HomePod Say Anything"), or
from the command line:

```bash
npm install -g homebridge-pipo-speak
```

On install, a `postinstall` step downloads the prebuilt Piper engine and a
default voice into the plugin's `vendor/` folder. No build tools, Python, or
compiler are required. If your machine has no network access during install,
pre-stage `vendor/` yourself and set `PIPO_SPEAK_SKIP_DOWNLOAD=1` (see
[Environment overrides](#environment-overrides)).

## Why a separate engine instead of in-process TTS?

On memory-constrained boards (e.g. a 512 MB Raspberry Pi) loading a neural TTS
model inside the Homebridge process can exhaust RAM and trigger a watchdog
reboot. This plugin instead spawns Piper as a **short-lived external process**
that exits after each clip, so its memory is fully reclaimed. It also:

- runs **one synthesis at a time** (serialized),
- **refuses** to start when free RAM is below a configurable floor
  (`minAvailableMb`) instead of risking an out-of-memory reboot,
- paces successive utterances with a **cooldown**,
- lowers CPU/IO priority (`nice`/`ionice`) and caps glibc arenas
  (`MALLOC_ARENA_MAX=2`) while Piper runs.

## Requirements

- **Node 18+** and Homebridge 1.6+ (or 2.0 beta).
- A way to play audio on the target speaker — either:
  - **homebridge-homepod-radio** installed (the plugin auto-uses its `/play`
    route — the recommended, low-latency path), **or**
  - **pyatv** (`atvremote`) on the PATH for direct streaming.
- `tar` on the PATH (used once, during install, to unpack Piper). Standard on
  Linux and macOS.

Prebuilt Piper binaries are downloaded for Linux (x86_64 / aarch64 / armv7l) and
macOS (x64 / arm64). On other platforms, point `PIPO_SPEAK_PIPER_BIN` at an
existing Piper binary.

## Configuration

Use the Homebridge UI (Config UI X) — the form is self-describing. Minimal JSON
example:

```json
{
  "platforms": [
    {
      "platform": "PipoSpeak",
      "name": "Pipo Speak",
      "defaultVolume": 75,
      "playback": "auto",
      "buttons": [
        { "name": "Dinner", "phrase": "Dinner is ready, come to the kitchen." },
        { "name": "Leaving", "phrase": "Leaving in five minutes.", "volume": 60 }
      ]
    }
  ]
}
```

### Playback target

- `auto` (default): use the homepod-radio `/play` route if its media directory
  exists, otherwise fall back to pyatv.
- `homepod-radio`: always use the `/play` route
  (`homepodRadioPlayBase`, default `http://127.0.0.1:7654/play`); the WAV is
  written into `mediaPath` (default `/var/www/tones`) first.
- `pyatv`: stream directly with `atvremote --id <atvId> stream_file=...`.
  Requires `atvId` (from `atvremote scan`).

> **Media-directory permissions (homepod-radio path).** Homebridge usually runs
> as a dedicated `homebridge` user, which must be able to **write** into
> `mediaPath`. If that directory is owned by another user/group (a common
> homepod-radio setup writes to `/var/www/tones` owned by your login user), add
> the Homebridge user to the owning group once, e.g.
> `sudo usermod -aG <owner-group> homebridge && sudo systemctl restart homebridge`.
> Without write access the plugin logs `EACCES` and falls back to pyatv.

### Optional LAN HTTP endpoint

Off by default. When `enableHttp` is on, the plugin listens on `httpPort`
(default `8095`):

```
POST /say            body = text (text/plain, or form text=)
GET  /say?text=...   convenience for quick tests
Optional ?volume=NN  overrides the default volume for one request
```

There is **no authentication** — only enable it on a trusted LAN.

## Advanced / memory safety

| Option | Default | Meaning |
| --- | --- | --- |
| `maxChars` | 600 | Truncate longer utterances. |
| `minAvailableMb` | 90 | Refuse to synthesize below this much free RAM (0 = off). |
| `cooldownSeconds` | 4 | Settle time after each utterance. |
| `piperThreads` | (engine default) | Cap Piper threads; set `1` on low-RAM single-core boards. |

## Environment overrides

- `PIPO_SPEAK_PIPER_BIN` — use an existing Piper binary instead of the bundled one.
- `PIPO_SPEAK_VOICE_FILE` — absolute path to a `.onnx` voice to use.
- `PIPO_SPEAK_VOICE` — voice key to download (default `en_US-lessac-low`).
- `PIPO_SPEAK_SKIP_DOWNLOAD=1` — skip the postinstall download (pre-staged
  `vendor/`).

## License

MIT — see [LICENSE](LICENSE). The downloaded Piper engine and voices carry
their own licenses and are invoked as separate executables (no linking).

## Credits & acknowledgements

This plugin stands on the shoulders of excellent open-source work:

- **[homebridge-homepod-radio](https://github.com/homebridge-plugins/homebridge-homepod-radio)**
  — when present, its `/play` route is the recommended audio-playback path used
  by this plugin. It was **originally created by [Petro Kushchak](https://github.com/petro-kushchak)**
  and is now **maintained by the [homebridge-plugins](https://github.com/homebridge-plugins)
  community** (with thanks to maintainers including [Ben Potter (bwp91)](https://github.com/bwp91)).
  Huge thanks for the AirPlay streaming groundwork that makes "say anything on a
  HomePod" practical. This project is **independent of, and not endorsed by,**
  that project — it simply integrates with it when you have it installed.
- **[Piper](https://github.com/rhasspy/piper)** by the [Rhasspy](https://github.com/rhasspy)
  project — the fast, fully-offline neural text-to-speech engine that does the
  actual synthesis.
- **[piper-voices](https://huggingface.co/rhasspy/piper-voices)** — the voice
  models downloaded at install time.
- **[Homebridge](https://github.com/homebridge/homebridge)** — the platform that
  makes all of this possible.

Playback also supports **[pyatv](https://github.com/postlund/pyatv)** as a
direct streaming alternative.

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
dependency to install. The Piper engine and the default voice are downloaded
automatically on `npm install` (the same self-contained approach used by
`ffmpeg-for-homebridge`); any **other** voice you pick in the UI is fetched
automatically the first time it speaks.

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
      "speed": 1.0,
      "playback": "auto",
      "cacheEnabled": true,
      "buttons": [
        { "name": "Dinner", "phrase": "Dinner is ready, come to the kitchen." },
        {
          "name": "Leaving",
          "phrase": "Leaving in five minutes.",
          "volumeOverride": true,
          "volume": 60
        }
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

### Per-phrase volume

Each phrase plays at the **Default Volume** unless you tick **Override volume
for this phrase** on that button and set a specific value. (In raw JSON, a
button with a `volume` but no `volumeOverride` is still honored, for backward
compatibility.)

### Per-phrase voice, speed, and speaker

Each button can optionally override the global voice, speed, or target speaker
for that one phrase — handy for multi-room announcements or giving a particular
alert its own voice:

- **Voice** — any bundled/downloadable Piper voice (downloaded on first use).
  Blank = the default voice.
- **Speed** — `0.5`–`2.0` (1.0 = normal, 2.0 = twice as fast). Blank = default.
- **Speaker** — a pyatv device ID to play just this phrase on a specific
  speaker/room. Blank = the default playback target.

### Speech speed

The global **Default Speech Speed** (`speed`, default `1.0`) sets how fast every
phrase is spoken (`2.0` = twice as fast, `0.5` = half speed); a button's own
speed overrides it.

### Attention chime

Set **Attention Chime** (`chimeFile`) to the absolute path of a short WAV and it
is played immediately before every phrase — a quick "ding" to get attention.

### Phrase cache & pre-render

Synthesized phrases are **cached to disk** by default (`cacheEnabled`), keyed by
text + voice + speed, so a repeated phrase is replayed from a file instead of
re-synthesized. This removes the on-demand Piper run (and its memory spike) from
the common path — the memory gate then only ever gates a genuine first-time
synth. The cache holds up to `cacheMaxEntries` clips (default 64, oldest evicted
first).

Turn on **Pre-render phrases on startup** (`preRender`) to synthesize and cache
every button phrase once, in the background, right after Homebridge starts — so
even the first press is instant. Pre-rendering is paced through the same
serialized, memory-gated queue, so it won't overwhelm a small board.

### Optional LAN HTTP endpoint

Off by default. When `enableHttp` is on, the plugin listens on `httpPort`
(default `8095`):

```
POST /say            body = text (text/plain, or form text=)
GET  /say?text=...   convenience for quick tests
GET  /healthz        liveness + status JSON (never requires a token)
Optional ?volume=NN  overrides the default volume for one request
```

By default there is **no authentication** — only enable it on a trusted LAN.
For a little hardening, set **HTTP Access Token** (`httpToken`): every `/say`
request must then present it via `?token=`, an `Authorization: Bearer <token>`
header, or `X-Auth-Token`. `/healthz` stays open so uptime probes don't need the
secret.

## Soundboard (HomeKit Television)

An optional **Soundboard** exposes a HomeKit **Television** accessory whose
"inputs" are audio files you already have on the Pi. Picking an input plays that
sound on the **same speaker** the plugin speaks through — no synthesis, it just
streams the file.

How it works:

- Point it at a **source folder** on the Pi. On startup the plugin scans that
  folder **depth-first** and takes the first **N** playable audio files
  (`.wav .mp3 .m4a .aac .flac .ogg .opus .aiff .wma`, up to 10).
- It publishes a Television named after `soundboard.name` (default
  `Soundboard`). Its inputs are **`None`** (identifier 0, a no-op resting state)
  followed by one input per sound.
- Selecting any non-`None` input plays that file, then the input snaps back to
  `None` so you can fire the **same** sound again (momentary, like the phrase
  buttons).

Because HomeKit only surfaces **one Television per bridge**, the soundboard is
published as an **external accessory** — add it in the Home app with the **same
setup code as the bridge**.

| Option                  | Default      | Meaning                                                                  |
| ----------------------- | ------------ | ------------------------------------------------------------------------ |
| `soundboard.enabled`    | `false`      | Turn the soundboard on.                                                  |
| `soundboard.name`       | `Soundboard` | Name of the Television in the Home app.                                  |
| `soundboard.sourceFolder` | —          | Absolute path to the folder scanned for sounds.                          |
| `soundboard.maxSounds`  | 10           | How many sounds to expose as inputs (1–10), plus the synthetic `None`.   |
| `soundboard.volume`     | (default)    | Optional volume (0–100) for soundboard playback.                         |
| `soundboard.atvId`      | (default)    | Optional pyatv device ID to play the soundboard on a specific speaker.   |

```json
{
  "platform": "PipoSpeak",
  "soundboard": {
    "enabled": true,
    "name": "Soundboard",
    "sourceFolder": "/var/www/tones/sample-gallery",
    "maxSounds": 10,
    "volume": 60
  }
}
```

## Advanced / memory safety

| Option            | Default          | Meaning                                                                              |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `cacheEnabled`    | `true`           | Replay repeated phrases from a cached WAV instead of re-synthesizing.                 |
| `cacheMaxEntries` | 64               | Max cached phrase WAVs kept on disk (oldest evicted first).                           |
| `preRender`       | `false`          | Synthesize + cache every button phrase at startup, in the background.                |
| `restoreVolume`   | `false`          | pyatv only: restore the speaker's prior volume after an announcement.                |
| `maxChars`        | 600              | Truncate longer utterances.                                                          |
| `minAvailableMb`  | 90               | Refuse to synthesize below this much free RAM (0 = off; cache hits are never gated). |
| `cooldownSeconds` | 4                | Settle time after each utterance.                                                    |
| `piperThreads`    | (engine default) | Cap Piper threads; set `1` on low-RAM single-core boards.                            |

## Environment overrides

- `PIPO_SPEAK_PIPER_BIN` — use an existing Piper binary instead of the bundled one.
- `PIPO_SPEAK_VOICE_FILE` — absolute path to a `.onnx` voice to use.
- `PIPO_SPEAK_VOICE` — voice key to download (default `en_US-lessac-low`).
- `PIPO_SPEAK_SKIP_DOWNLOAD=1` — skip the postinstall download (pre-staged
  `vendor/`).
- `PIPO_SPEAK_CACHE_DIR` — override where cached phrase WAVs are stored
  (default: `vendor/cache/`).

## Development

This plugin has **zero runtime dependencies**. The test suite uses the built-in
Node test runner; ESLint is the only dev dependency:

```bash
PIPO_SPEAK_SKIP_DOWNLOAD=1 npm install   # devDependencies only; skip the engine fetch
npm test                                 # node --test
npm run lint                             # eslint .
```

CI runs lint + tests on Node 18, 20, and 22 (see `.github/workflows/ci.yml`).

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

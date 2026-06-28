"use strict";

const { Speaker } = require("./lib/speaker");
const { SpeakHttpServer } = require("./lib/http-server");
const { scanSounds } = require("./lib/soundboard-scanner");
const {
  buildSoundboardInputs,
  setupSoundboardAccessory,
} = require("./lib/soundboard");

const PLUGIN_NAME = "homebridge-pipo-speak";
const PLATFORM_NAME = "PipoSpeak";

let Service;
let Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PipoSpeakPlatform);
};

class PipoSpeakPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    this.buttons = Array.isArray(this.config.buttons)
      ? this.config.buttons
      : [];

    this.soundboard = this.config.soundboard || {};

    this.speaker = new Speaker({
      log,
      voice: this.config.voice,
      defaultVolume:
        this.config.defaultVolume != null ? this.config.defaultVolume : 75,
      speed: this.config.speed,
      maxChars: this.config.maxChars,
      minAvailableMb:
        this.config.minAvailableMb != null ? this.config.minAvailableMb : 90,
      cooldownSeconds:
        this.config.cooldownSeconds != null ? this.config.cooldownSeconds : 4,
      piperThreads: this.config.piperThreads,
      playback: this.config.playback || "auto",
      homepodRadioPlayBase: this.config.homepodRadioPlayBase,
      mediaPath: this.config.mediaPath,
      atvId: this.config.atvId || this.soundboard.atvId,
      chimeFile: this.config.chimeFile,
      restoreVolume: this.config.restoreVolume === true,
      cacheEnabled: this.config.cacheEnabled !== false,
      cacheMaxEntries: this.config.cacheMaxEntries,
      warmConnection:
        this.soundboard.enabled === true &&
        this.soundboard.warmConnection !== false,
    });

    this.httpServer = null;

    this.api.on("didFinishLaunching", () => {
      this.discoverButtons();
      this.maybeStartHttp();
      this.maybePreRender();
      this.maybeSetupSoundboard();
    });

    this.api.on("shutdown", () => {
      if (this.httpServer) {
        this.httpServer.stop();
      }
      if (this.speaker) {
        this.speaker.stop();
      }
    });
  }

  // Restore cached accessories on startup.
  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  /**
   * Build the per-utterance options for a button: per-button volume (only when
   * the override is on — legacy bare-volume configs still honored), and optional
   * per-button voice, speed, and speaker (atvId) for room routing.
   */
  _buttonOpts(button) {
    const overrideOn =
      button.volumeOverride === true ||
      (button.volumeOverride === undefined && Number.isInteger(button.volume));
    return {
      volume:
        overrideOn && Number.isInteger(button.volume)
          ? button.volume
          : undefined,
      voice: button.voice || undefined,
      speed: Number.isFinite(button.speed) ? button.speed : undefined,
      atvId: button.atvId || undefined,
    };
  }

  discoverButtons() {
    const valid = this.buttons.filter((b) => b && b.name && b.phrase);
    if (valid.length === 0) {
      this.log.warn("pipo-speak: no phrase buttons configured.");
    }

    const wantedUuids = new Set();
    for (const button of valid) {
      const uuid = this.api.hap.uuid.generate(
        `${PLATFORM_NAME}:${button.name}`,
      );
      wantedUuids.add(uuid);
      let accessory = this.accessories.find((a) => a.UUID === uuid);
      if (accessory) {
        accessory.context.button = button;
        this.setupSwitch(accessory, button);
        this.api.updatePlatformAccessories([accessory]);
      } else {
        accessory = new this.api.platformAccessory(button.name, uuid);
        accessory.context.button = button;
        this.setupSwitch(accessory, button);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
        this.accessories.push(accessory);
        this.log.info(`pipo-speak: added button "${button.name}"`);
      }
    }

    // Remove cached accessories that are no longer in config.
    const stale = this.accessories.filter((a) => !wantedUuids.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.accessories = this.accessories.filter((a) =>
        wantedUuids.has(a.UUID),
      );
      for (const a of stale) {
        this.log.info(`pipo-speak: removed stale button "${a.displayName}"`);
      }
    }
  }

  setupSwitch(accessory, button) {
    const info =
      accessory.getService(Service.AccessoryInformation) ||
      accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, "Pipo Speak")
      .setCharacteristic(Characteristic.Model, "Phrase Button")
      .setCharacteristic(
        Characteristic.SerialNumber,
        accessory.UUID.slice(0, 8),
      );

    const service =
      accessory.getService(Service.Switch) ||
      accessory.addService(Service.Switch, button.name);

    // Keep the displayed name in sync if the user renamed the button.
    service.setCharacteristic(Characteristic.Name, button.name);

    const onChar = service.getCharacteristic(Characteristic.On);
    onChar.removeAllListeners("get");
    onChar.removeAllListeners("set");

    onChar.on("get", (cb) => cb(null, false));
    onChar.on("set", (value, cb) => {
      // Acknowledge immediately so HomeKit doesn't block.
      cb(null);
      if (!value) {
        return;
      }
      const current = accessory.context.button || button;
      this.speaker.say(current.phrase, this._buttonOpts(current)).then(
        (result) => {
          if (result.code !== 200) {
            this.log.warn(
              `pipo-speak: "${current.name}" -> ${result.code} ${result.message}`,
            );
          }
        },
      );
      // Momentary: snap back to off so it behaves like a button.
      setTimeout(() => {
        service.updateCharacteristic(Characteristic.On, false);
      }, 800);
    });
  }

  maybeStartHttp() {
    if (!this.config.enableHttp) {
      return;
    }
    this.httpServer = new SpeakHttpServer({
      log: this.log,
      speaker: this.speaker,
      port: this.config.httpPort || 8095,
      bind: this.config.httpBind || "0.0.0.0",
      maxChars: this.config.maxChars,
      token: this.config.httpToken,
    });
    this.httpServer.start();
  }

  /**
   * Opt-in: synthesize + cache every fixed phrase once, in the background, so the
   * first real press replays a file instead of synthesizing on demand. Paced
   * through the speaker's serialized, memory-gated chain so it can't OOM a small
   * board even with many buttons.
   */
  maybePreRender() {
    if (!this.config.preRender) {
      return;
    }
    const valid = this.buttons.filter((b) => b && b.name && b.phrase);
    if (valid.length === 0) {
      return;
    }
    this.log.info(
      `pipo-speak: pre-rendering ${valid.length} phrase(s) in the background...`,
    );
    (async () => {
      for (const button of valid) {
        const result = await this.speaker.prime(
          button.phrase,
          this._buttonOpts(button),
        );
        if (result.code !== 200) {
          this.log.warn(
            `pipo-speak: pre-render "${button.name}" -> ${result.code} ${result.message}`,
          );
        }
      }
      this.log.info("pipo-speak: pre-render complete.");
    })();
  }

  /**
   * Opt-in: expose a HomeKit Television named after the soundboard whose
   * "inputs" are the first N playable audio files found (depth-first) under a
   * user-chosen folder. Selecting an input plays that file on the same speaker
   * the plugin speaks through. The TV is published as an EXTERNAL accessory
   * because HomeKit only surfaces one Television per bridge.
   */
  maybeSetupSoundboard() {
    const sb = this.soundboard || {};
    if (!sb.enabled) {
      return;
    }
    const folder = sb.sourceFolder;
    if (!folder) {
      this.log.warn(
        "pipo-speak: soundboard enabled but no source folder set; skipping.",
      );
      return;
    }
    const name = (sb.name && String(sb.name).trim()) || "Soundboard";
    const maxSounds =
      Number.isInteger(sb.maxSounds) && sb.maxSounds > 0 ? sb.maxSounds : 10;

    let sounds;
    try {
      sounds = scanSounds(folder, { maxSounds });
    } catch (err) {
      this.log.error(
        `pipo-speak: soundboard scan of "${folder}" failed (${err.message}).`,
      );
      return;
    }
    if (sounds.length === 0) {
      this.log.warn(
        `pipo-speak: soundboard found no playable audio under "${folder}"; skipping.`,
      );
      return;
    }
    this.log.info(
      `pipo-speak: soundboard "${name}" found ${sounds.length} sound(s) in "${folder}".`,
    );

    const inputs = buildSoundboardInputs(sounds);

    const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:soundboard`);
    const accessory = new this.api.platformAccessory(
      name,
      uuid,
      this.api.hap.Categories.TELEVISION,
    );

    const opts = {
      volume: Number.isInteger(sb.volume) ? sb.volume : undefined,
      atvId: sb.atvId || undefined,
    };

    setupSoundboardAccessory({
      api: this.api,
      Service,
      Characteristic,
      log: this.log,
      accessory,
      name,
      inputs,
      onSelect: (filePath, input) => {
        this.speaker.playFile(filePath, opts).then((result) => {
          if (result.code !== 200) {
            this.log.warn(
              `pipo-speak: soundboard "${input.name}" -> ${result.code} ${result.message}`,
            );
          }
        });
      },
    });

    // A Television must be published outside the bridge (one TV per bridge).
    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    this.log.info(
      `pipo-speak: soundboard "${name}" published with ${inputs.length - 1} input(s) + None.`,
    );
  }
}

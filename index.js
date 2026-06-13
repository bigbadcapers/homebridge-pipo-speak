'use strict';

const { Speaker } = require('./lib/speaker');
const { SpeakHttpServer } = require('./lib/http-server');

const PLUGIN_NAME = 'homebridge-pipo-speak';
const PLATFORM_NAME = 'PipoSpeak';

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

    this.buttons = Array.isArray(this.config.buttons) ? this.config.buttons : [];

    this.speaker = new Speaker({
      log,
      voice: this.config.voice,
      defaultVolume: this.config.defaultVolume != null ? this.config.defaultVolume : 75,
      maxChars: this.config.maxChars,
      minAvailableMb: this.config.minAvailableMb != null ? this.config.minAvailableMb : 90,
      cooldownSeconds: this.config.cooldownSeconds != null ? this.config.cooldownSeconds : 4,
      piperThreads: this.config.piperThreads,
      playback: this.config.playback || 'auto',
      homepodRadioPlayBase: this.config.homepodRadioPlayBase,
      mediaPath: this.config.mediaPath,
      atvId: this.config.atvId,
    });

    this.httpServer = null;

    this.api.on('didFinishLaunching', () => {
      this.discoverButtons();
      this.maybeStartHttp();
    });

    this.api.on('shutdown', () => {
      if (this.httpServer) {
        this.httpServer.stop();
      }
    });
  }

  // Restore cached accessories on startup.
  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  discoverButtons() {
    const valid = this.buttons.filter((b) => b && b.name && b.phrase);
    if (valid.length === 0) {
      this.log.warn('pipo-speak: no phrase buttons configured.');
    }

    const wantedUuids = new Set();
    for (const button of valid) {
      const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}:${button.name}`);
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
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
        this.log.info(`pipo-speak: added button "${button.name}"`);
      }
    }

    // Remove cached accessories that are no longer in config.
    const stale = this.accessories.filter((a) => !wantedUuids.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.accessories = this.accessories.filter((a) => wantedUuids.has(a.UUID));
      for (const a of stale) {
        this.log.info(`pipo-speak: removed stale button "${a.displayName}"`);
      }
    }
  }

  setupSwitch(accessory, button) {
    const info = accessory.getService(Service.AccessoryInformation)
      || accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Pipo Speak')
      .setCharacteristic(Characteristic.Model, 'Phrase Button')
      .setCharacteristic(Characteristic.SerialNumber, accessory.UUID.slice(0, 8));

    const service = accessory.getService(Service.Switch)
      || accessory.addService(Service.Switch, button.name);

    // Keep the displayed name in sync if the user renamed the button.
    service.setCharacteristic(Characteristic.Name, button.name);

    const onChar = service.getCharacteristic(Characteristic.On);
    onChar.removeAllListeners('get');
    onChar.removeAllListeners('set');

    onChar.on('get', (cb) => cb(null, false));
    onChar.on('set', (value, cb) => {
      // Acknowledge immediately so HomeKit doesn't block.
      cb(null);
      if (!value) {
        return;
      }
      const current = accessory.context.button || button;
      // Per-button volume only applies when the override checkbox is on.
      // Legacy configs (no volumeOverride field) keep honoring a set volume.
      const overrideOn = current.volumeOverride === true
        || (current.volumeOverride === undefined && Number.isInteger(current.volume));
      const volume = overrideOn && Number.isInteger(current.volume) ? current.volume : undefined;
      this.speaker.say(current.phrase, volume).then((result) => {
        if (result.code !== 200) {
          this.log.warn(`pipo-speak: "${current.name}" -> ${result.code} ${result.message}`);
        }
      });
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
      bind: this.config.httpBind || '0.0.0.0',
      maxChars: this.config.maxChars,
    });
    this.httpServer.start();
  }
}

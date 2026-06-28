"use strict";

const path = require("path");

// The synthetic first input. Selecting it is a no-op (the "resting" state the
// TV snaps back to after a sound fires, so the same sound can be re-triggered).
const NONE_INPUT_NAME = "None";
const NONE_IDENTIFIER = 0;

// HomeKit truncates very long input names; keep them tidy and readable.
const MAX_INPUT_NAME_LEN = 24;

/**
 * Turn an audio filename into a friendly HomeKit input label:
 * "oga-digital-two-tone-1.mp3" -> "Oga Digital Two Tone 1".
 * Pure + deterministic so it can be unit-tested without HomeKit.
 * @param {string} filename
 * @returns {string}
 */
function cleanInputName(filename) {
  const base = path.basename(filename, path.extname(filename));
  const words = base
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  let name = words.join(" ");
  if (!name) {
    name = "Sound";
  }
  if (name.length > MAX_INPUT_NAME_LEN) {
    name = name.slice(0, MAX_INPUT_NAME_LEN).trim();
  }
  return name;
}

/**
 * Build the ordered input list for the soundboard TV: identifier 0 is the
 * synthetic "None", then one entry per scanned sound (identifiers 1..N).
 * Duplicate friendly names are disambiguated with a numeric suffix so the
 * Home app never shows two identical inputs. Pure + deterministic.
 *
 * @param {Array<{name:string, path:string}>} sounds
 * @returns {Array<{identifier:number, name:string, path:(string|null)}>}
 */
function buildSoundboardInputs(sounds) {
  const inputs = [
    { identifier: NONE_IDENTIFIER, name: NONE_INPUT_NAME, path: null },
  ];
  const used = new Map();
  (sounds || []).forEach((sound, i) => {
    let label = cleanInputName(sound.name);
    const seen = used.get(label) || 0;
    used.set(label, seen + 1);
    if (seen > 0) {
      const suffix = ` ${seen + 1}`;
      label = label.slice(0, MAX_INPUT_NAME_LEN - suffix.length).trim() + suffix;
    }
    inputs.push({ identifier: i + 1, name: label, path: sound.path });
  });
  return inputs;
}

/**
 * Wire a HomeKit Television service onto `accessory` that exposes each sound as
 * a selectable input. Selecting any non-"None" input invokes `onSelect(path)`
 * and then snaps the active input back to "None" after `resetToNoneMs` so the
 * same sound can be picked again (momentary behavior, like the phrase buttons).
 *
 * @param {object} args
 * @param {object} args.api Homebridge API
 * @param {object} args.Service hap Service
 * @param {object} args.Characteristic hap Characteristic
 * @param {object} args.log Homebridge logger
 * @param {object} args.accessory platform accessory to attach the TV to
 * @param {string} args.name display/configured name of the soundboard
 * @param {Array<{identifier:number, name:string, path:(string|null)}>} args.inputs
 * @param {(path:string, input:object) => void} args.onSelect fired on selection
 * @param {number} [args.resetToNoneMs=1500] delay before snapping back to None
 * @returns {object} the Television service
 */
function setupSoundboardAccessory(args) {
  const {
    Service,
    Characteristic,
    log,
    accessory,
    name,
    inputs,
    onSelect,
    resetToNoneMs = 1500,
  } = args;

  const info =
    accessory.getService(Service.AccessoryInformation) ||
    accessory.addService(Service.AccessoryInformation);
  info
    .setCharacteristic(Characteristic.Manufacturer, "Pipo Speak")
    .setCharacteristic(Characteristic.Model, "Soundboard")
    .setCharacteristic(Characteristic.SerialNumber, accessory.UUID.slice(0, 8));

  const tv =
    accessory.getService(Service.Television) ||
    accessory.addService(Service.Television, name);

  tv.setCharacteristic(Characteristic.ConfiguredName, name);
  tv.setCharacteristic(
    Characteristic.SleepDiscoveryMode,
    Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
  );
  // The soundboard is always "on" — the act of selecting an input is the trigger.
  tv.setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);
  tv.setCharacteristic(Characteristic.ActiveIdentifier, NONE_IDENTIFIER);

  const activeChar = tv.getCharacteristic(Characteristic.Active);
  activeChar.removeAllListeners("set");
  activeChar.on("set", (value, cb) => {
    // Acknowledge but keep it on; there is no real power state to honor.
    cb(null);
    if (value !== Characteristic.Active.ACTIVE) {
      setTimeout(() => {
        tv.updateCharacteristic(
          Characteristic.Active,
          Characteristic.Active.ACTIVE,
        );
      }, 200);
    }
  });

  const byIdentifier = new Map(inputs.map((i) => [i.identifier, i]));

  // Build one InputSource service per input and link it to the TV.
  for (const input of inputs) {
    const subtype = `soundboard-input-${input.identifier}`;
    const svc =
      accessory.getServiceById(Service.InputSource, subtype) ||
      accessory.addService(Service.InputSource, input.name, subtype);
    svc
      .setCharacteristic(Characteristic.Identifier, input.identifier)
      .setCharacteristic(Characteristic.ConfiguredName, input.name)
      .setCharacteristic(
        Characteristic.IsConfigured,
        Characteristic.IsConfigured.CONFIGURED,
      )
      .setCharacteristic(
        Characteristic.InputSourceType,
        Characteristic.InputSourceType.HDMI,
      )
      .setCharacteristic(
        Characteristic.CurrentVisibilityState,
        Characteristic.CurrentVisibilityState.SHOWN,
      );
    tv.addLinkedService(svc);
  }

  const idChar = tv.getCharacteristic(Characteristic.ActiveIdentifier);
  idChar.removeAllListeners("set");
  idChar.on("set", (value, cb) => {
    // Acknowledge immediately so the Home app never blocks on playback.
    cb(null);
    const id = Number(value);
    if (id === NONE_IDENTIFIER) {
      return;
    }
    const input = byIdentifier.get(id);
    if (!input || !input.path) {
      if (log && log.warn) {
        log.warn(`pipo-speak: soundboard selected unknown input ${id}`);
      }
    } else {
      if (log && log.info) {
        log.info(`pipo-speak: soundboard -> "${input.name}"`);
      }
      try {
        onSelect(input.path, input);
      } catch (err) {
        if (log && log.error) {
          log.error(`pipo-speak: soundboard onSelect failed (${err.message})`);
        }
      }
    }
    // Snap back to "None" so re-selecting the same sound fires again.
    if (resetToNoneMs >= 0) {
      setTimeout(() => {
        tv.updateCharacteristic(
          Characteristic.ActiveIdentifier,
          NONE_IDENTIFIER,
        );
      }, resetToNoneMs);
    }
  });

  return tv;
}

module.exports = {
  NONE_INPUT_NAME,
  NONE_IDENTIFIER,
  MAX_INPUT_NAME_LEN,
  cleanInputName,
  buildSoundboardInputs,
  setupSoundboardAccessory,
};

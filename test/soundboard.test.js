"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanInputName,
  buildSoundboardInputs,
  setupSoundboardAccessory,
  NONE_IDENTIFIER,
} = require("../lib/soundboard");

// --- Minimal HAP mock --------------------------------------------------------
// Faithful enough to exercise setupSoundboardAccessory offline: services hold
// characteristics, characteristics record a single "set" handler we can fire.

function makeHap() {
  const C = {};
  for (const n of [
    "Name",
    "Manufacturer",
    "Model",
    "SerialNumber",
    "ConfiguredName",
    "SleepDiscoveryMode",
    "Active",
    "ActiveIdentifier",
    "Identifier",
    "IsConfigured",
    "InputSourceType",
    "CurrentVisibilityState",
  ]) {
    C[n] = { charName: n };
  }
  C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE = 1;
  C.Active.ACTIVE = 1;
  C.Active.INACTIVE = 0;
  C.IsConfigured.CONFIGURED = 1;
  C.InputSourceType.HDMI = 3;
  C.CurrentVisibilityState.SHOWN = 0;

  const S = {};
  for (const n of ["AccessoryInformation", "Television", "InputSource"]) {
    S[n] = { svcName: n };
  }
  return { Service: S, Characteristic: C };
}

class MockChar {
  constructor(type) {
    this.type = type;
    this.value = null;
    this.handlers = { set: [], get: [] };
  }
  on(evt, fn) {
    this.handlers[evt].push(fn);
    return this;
  }
  removeAllListeners(evt) {
    if (evt) this.handlers[evt] = [];
    else this.handlers = { set: [], get: [] };
    return this;
  }
  emitSet(value) {
    const fns = this.handlers.set;
    const fn = fns[fns.length - 1];
    return new Promise((resolve) => fn(value, () => resolve()));
  }
}

class MockService {
  constructor(type, name, subtype) {
    this.type = type;
    this.name = name;
    this.subtype = subtype;
    this.chars = new Map();
    this.linked = [];
  }
  _char(type) {
    let c = this.chars.get(type);
    if (!c) {
      c = new MockChar(type);
      this.chars.set(type, c);
    }
    return c;
  }
  setCharacteristic(type, value) {
    this._char(type).value = value;
    return this;
  }
  getCharacteristic(type) {
    return this._char(type);
  }
  updateCharacteristic(type, value) {
    this._char(type).value = value;
    return this;
  }
  addLinkedService(svc) {
    this.linked.push(svc);
    return this;
  }
}

class MockAccessory {
  constructor(uuid) {
    this.UUID = uuid;
    this.services = [];
  }
  addService(type, name, subtype) {
    const s = new MockService(type, name, subtype);
    this.services.push(s);
    return s;
  }
  getService(type) {
    return this.services.find(
      (s) => s.type === type && s.subtype === undefined,
    );
  }
  getServiceById(type, subtype) {
    return this.services.find((s) => s.type === type && s.subtype === subtype);
  }
}

const silentLog = { info() {}, warn() {}, error() {} };

// --- Pure helpers ------------------------------------------------------------

test("cleanInputName humanizes filenames", () => {
  assert.equal(
    cleanInputName("oga-digital-two-tone-1.mp3"),
    "Oga Digital Two Tone 1",
  );
  assert.equal(cleanInputName("kenney_select_003.ogg"), "Kenney Select 003");
  assert.equal(cleanInputName("a.wav"), "A");
  assert.equal(cleanInputName("___.mp3"), "Sound");
});

test("buildSoundboardInputs prepends None at identifier 0", () => {
  const inputs = buildSoundboardInputs([
    { name: "one.wav", path: "/s/one.wav" },
    { name: "two.mp3", path: "/s/two.mp3" },
  ]);
  assert.equal(inputs.length, 3);
  assert.equal(inputs[0].identifier, NONE_IDENTIFIER);
  assert.equal(inputs[0].name, "None");
  assert.equal(inputs[0].path, null);
  assert.equal(inputs[1].identifier, 1);
  assert.equal(inputs[1].path, "/s/one.wav");
  assert.equal(inputs[2].identifier, 2);
});

test("buildSoundboardInputs disambiguates duplicate names", () => {
  const inputs = buildSoundboardInputs([
    { name: "click.wav", path: "/a/click.wav" },
    { name: "click.mp3", path: "/b/click.mp3" },
  ]);
  assert.equal(inputs[1].name, "Click");
  assert.equal(inputs[2].name, "Click 2");
});

// --- Accessory wiring --------------------------------------------------------

test("setupSoundboardAccessory builds a TV with None + one input per sound", () => {
  const { Service, Characteristic } = makeHap();
  const accessory = new MockAccessory("ABCD1234EFGH");
  const inputs = buildSoundboardInputs([
    { name: "one.wav", path: "/snd/one.wav" },
    { name: "two.mp3", path: "/snd/two.mp3" },
  ]);
  const tv = setupSoundboardAccessory({
    api: {},
    Service,
    Characteristic,
    log: silentLog,
    accessory,
    name: "My Board",
    inputs,
    onSelect: () => {},
    resetToNoneMs: 0,
  });

  assert.equal(tv.getCharacteristic(Characteristic.ConfiguredName).value, "My Board");
  assert.equal(
    tv.getCharacteristic(Characteristic.Active).value,
    Characteristic.Active.ACTIVE,
  );
  assert.equal(
    tv.getCharacteristic(Characteristic.ActiveIdentifier).value,
    NONE_IDENTIFIER,
  );
  // None + 2 sounds = 3 linked InputSource services.
  assert.equal(tv.linked.length, 3);
  const inputSvcs = accessory.services.filter(
    (s) => s.type === Service.InputSource,
  );
  assert.equal(inputSvcs.length, 3);
});

test("selecting a non-None input fires onSelect with that file path", async () => {
  const { Service, Characteristic } = makeHap();
  const accessory = new MockAccessory("ABCD1234EFGH");
  const inputs = buildSoundboardInputs([
    { name: "one.wav", path: "/snd/one.wav" },
    { name: "two.mp3", path: "/snd/two.mp3" },
  ]);
  const calls = [];
  const tv = setupSoundboardAccessory({
    api: {},
    Service,
    Characteristic,
    log: silentLog,
    accessory,
    name: "Board",
    inputs,
    onSelect: (p, input) => calls.push({ p, name: input.name }),
    resetToNoneMs: 0,
  });

  await tv.getCharacteristic(Characteristic.ActiveIdentifier).emitSet(2);
  assert.deepEqual(calls, [{ p: "/snd/two.mp3", name: inputs[2].name }]);

  // Selecting None is a no-op.
  await tv.getCharacteristic(Characteristic.ActiveIdentifier).emitSet(
    NONE_IDENTIFIER,
  );
  assert.equal(calls.length, 1);

  // Unknown identifier does not throw and does not call onSelect.
  await tv.getCharacteristic(Characteristic.ActiveIdentifier).emitSet(99);
  assert.equal(calls.length, 1);
});

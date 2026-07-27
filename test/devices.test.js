import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS } from '../src/axenco/const.js';
import {
  buildStates,
  describeDevice,
  featureKeyOf,
  handleSetValue,
  isSupportedDevice,
} from '../src/devices/index.js';
import {
  fakeAxencoClient,
  fakeGladys,
  axencoSubDevice,
  axencoThermostat,
} from './helpers/fakes.js';

const describe_ = (device) => describeDevice(fakeGladys, device);
const featureNames = (entry) => entry.gladysDevice.features.map((feature) => feature.name);
const stateFor = (states, entry, key) =>
  states.find((state) => state.device_feature_external_id === entry.ids.feature(key));

test('only the models of the reference integration are picked up', () => {
  for (const model of ['EV30', 'ECTRL', 'ESTAT', 'RSS-ECTRL', 'NTD', 'ETRV', 'EWS', 'UFH']) {
    assert.ok(isSupportedDevice({ _id: 'x', model }), `${model} should be supported`);
  }
  assert.equal(isSupportedDevice({ _id: 'x', model: 'SOMETHING-ELSE' }), false);
  assert.equal(isSupportedDevice({ model: 'EV30' }), false, 'a device without _id is unusable');
  assert.equal(isSupportedDevice(null), false);
});

test('every feature carries min and max, which Gladys stores as NOT NULL', () => {
  const devices = [
    axencoThermostat(),
    axencoSubDevice(),
    axencoSubDevice({ model: 'NTD', state: { targetMode: 1, changeOverUser: 1 } }),
    axencoSubDevice({ model: 'UFH', state: { changeOverUser: 0 } }),
    axencoThermostat({ model: 'EWS', state: { deviceType: 0, targetMode: 1 } }),
    axencoThermostat({ model: 'EWS', state: { deviceType: 1, targetMode: 1 } }),
  ];
  for (const device of devices) {
    for (const feature of describe_(device).gladysDevice.features) {
      assert.equal(typeof feature.min, 'number', `${device.model}/${feature.name} min`);
      assert.equal(typeof feature.max, 'number', `${device.model}/${feature.name} max`);
      assert.ok(feature.selector, `${device.model}/${feature.name} needs an explicit selector`);
    }
  }
});

test('selectors stay unique across devices sharing the same feature names', () => {
  const entries = [
    describe_(axencoThermostat({ _id: 'aaa', name: 'Salon' })),
    describe_(axencoThermostat({ _id: 'bbb', name: 'Salon' })),
  ];
  const selectors = entries.flatMap((entry) => [
    entry.gladysDevice.selector,
    ...entry.gladysDevice.features.map((feature) => feature.selector),
  ]);
  assert.equal(new Set(selectors).size, selectors.length);
});

test('a thermostat exposes temperatures, the mode and the selectable presets', () => {
  // Auto is an ordinary targetMode value (0), so it is a switch like the
  // others and exclusive with them for free. Dérogation (8) is not: it is a
  // reported state produced by writing a temperature.
  const entry = describe_(axencoThermostat());
  assert.deepEqual(featureNames(entry), [
    'Température actuelle',
    'Température cible',
    'Mode actuel',
    'Boost',
    'Éco',
    'Confort',
    'Auto',
    'Hors gel',
    'Veille',
  ]);
  assert.ok(!featureNames(entry).includes('Dérogation'));
});

test('the setpoint bounds come from the device, with a 7-30 fallback', () => {
  const bounded = describe_(axencoThermostat()).gladysDevice.features[1];
  assert.deepEqual([bounded.min, bounded.max], [16, 21]);

  const unbounded = describe_(
    axencoThermostat({ state: { currentTemp: 19, overrideTemp: 20, targetMode: 1 } }),
  ).gladysDevice.features[1];
  assert.deepEqual([unbounded.min, unbounded.max], [7, 30]);
});

test('a UFH is a single heating/cooling switch, a NTD reports the same read-only', () => {
  const ufh = describe_(axencoSubDevice({ model: 'UFH', state: { changeOverUser: 0 } }));
  assert.deepEqual(featureNames(ufh), ['Mode actuel', 'Rafraîchissement']);
  assert.equal(ufh.gladysDevice.features[1].read_only, false);

  const ntd = describe_(axencoSubDevice({ model: 'NTD', state: { targetMode: 1 } }));
  const cooling = ntd.gladysDevice.features.find((f) => f.name === 'Rafraîchissement');
  assert.equal(cooling.read_only, true, 'climate.py never writes changeOverUser');
});

test('an EWS relay exposes On/Off/Auto', () => {
  const relay = describe_(axencoThermostat({ model: 'EWS', state: { deviceType: 0 } }));
  assert.deepEqual(featureNames(relay), ['Mode actuel', 'Marche', 'Arrêt', 'Auto']);
});

test('an EWS fil pilote exposes the seven orders the module really emits', () => {
  // Measured on a real EWSFPNEOA and cross-checked against its manual: the
  // module drives "un fil pilote 4 ou 6 ordres" and its LED table reads
  // "Mode Éco, Éco-1 ou Éco-2". The MyNeomitis app menu hides those two.
  const pilot = describe_(axencoThermostat({ model: 'EWS', state: { deviceType: 1 } }));
  assert.deepEqual(featureNames(pilot), [
    'Mode actuel',
    'Boost',
    'Éco',
    'Éco 1K',
    'Éco 2K',
    'Confort',
    'Auto',
    'Hors gel',
    'Veille',
  ]);
  // Ignored twice by the hardware, and absent from the manual.
  for (const phantom of ['Dérogation', 'Confort +']) {
    assert.ok(!featureNames(pilot).includes(phantom), `${phantom} does not exist on an EWS`);
  }
});

test('an EWS has no temperature feature: the module has no sensor', () => {
  const pilot = describe_(axencoThermostat({ model: 'EWS', state: { deviceType: 1 } }));
  assert.ok(!featureNames(pilot).some((name) => name.startsWith('Température')));
});

test('a sub-device keeps its gateway and rfid for command routing', () => {
  const entry = describe_(axencoSubDevice());
  assert.equal(entry.gateway, '65f0000000000000000000ff');
  assert.equal(entry.rfid, 'A1B2');
  const params = Object.fromEntries(entry.gladysDevice.params.map((p) => [p.name, p.value]));
  assert.equal(params.AXENCO_GATEWAY, '65f0000000000000000000ff');
  assert.equal(params.AXENCO_RFID, 'A1B2');
});

test('a state patch only produces states for the keys it actually carries', () => {
  const entry = describe_(axencoThermostat());
  const states = buildStates(entry, { currentTemp: 21.2 });
  assert.equal(states.length, 1);
  assert.equal(states[0].state, 21.2);
  assert.deepEqual(buildStates(entry, {}), []);
  assert.deepEqual(buildStates(entry, null), []);
});

test('a mode push lights exactly one switch and names the mode', () => {
  const entry = describe_(axencoThermostat());
  const states = buildStates(entry, { targetMode: PRESETS.boost.code });

  assert.equal(stateFor(states, entry, 'mode').text, 'Boost');
  assert.equal(stateFor(states, entry, 'preset:boost').state, 1);
  assert.equal(stateFor(states, entry, 'preset:comfort').state, 0);
  assert.equal(states.filter((state) => state.state === 1).length, 1);
});

test('a mode code we do not know stays visible instead of being dropped', () => {
  const entry = describe_(axencoThermostat());
  const states = buildStates(entry, { targetMode: 42 });
  assert.equal(stateFor(states, entry, 'mode').text, 'Inconnu (42)');
  assert.ok(states.every((state) => state.state !== 1));
});

test('a setpoint push is accepted under either temperature key', () => {
  const sub = describe_(axencoSubDevice());
  assert.equal(
    stateFor(buildStates(sub, { targetTemp: 19.5 }), sub, 'target-temperature').state,
    19.5,
  );
  assert.equal(
    stateFor(buildStates(sub, { overrideTemp: 18.5 }), sub, 'target-temperature').state,
    18.5,
    'climate.py accepts either key on a push, whatever the model normally uses',
  );
});

test('turning a preset switch on sends that mode and turns the siblings off', async () => {
  const client = fakeAxencoClient();
  const entry = describe_(axencoThermostat());
  const states = await handleSetValue(client, entry, 'preset:eco', 1);

  assert.deepEqual(client.calls, [
    { name: 'setDeviceMode', args: [entry.axencoId, PRESETS.eco.code] },
  ]);
  assert.equal(stateFor(states, entry, 'preset:eco').state, 1);
  assert.equal(stateFor(states, entry, 'preset:comfort').state, 0);
  assert.equal(stateFor(states, entry, 'mode').text, 'Éco');
});

test('turning a preset switch off writes nothing and snaps the switch back', async () => {
  const client = fakeAxencoClient();
  const entry = describe_(axencoThermostat()); // currently comfort
  const states = await handleSetValue(client, entry, 'preset:comfort', 0);

  assert.deepEqual(client.calls, [], 'there is no "no mode" to send to Axenco');
  assert.equal(stateFor(states, entry, 'preset:comfort').state, 1);
});

test('a preset the model does not support is rejected', async () => {
  const client = fakeAxencoClient();
  const entry = describe_(axencoSubDevice()); // ETRV: no boost
  await assert.rejects(() => handleSetValue(client, entry, 'preset:boost', 1), /Unknown preset/);
  assert.deepEqual(client.calls, []);
});

test('setting a temperature is a single call, no mode written first', async () => {
  // climate.py writes targetMode 8, THEN the temperature. Measured on a real
  // EV30, that first call answers 2xx and does nothing. The official app sends
  // one call carrying targetTemp + overrideTemp + targetMode 8 together, which
  // is what the client reproduces.
  const client = fakeAxencoClient();
  const entry = describe_(axencoThermostat());
  const states = await handleSetValue(client, entry, 'target-temperature', 20.5);

  assert.deepEqual(client.calls, [{ name: 'setDeviceTemperature', args: [entry.axencoId, 20.5] }]);
  assert.equal(stateFor(states, entry, 'target-temperature').state, 20.5);
});

test('Auto is written as targetMode 0, and is exclusive with the manual modes', async () => {
  // Captured from the official app: Auto from Confort sends {targetMode: 0},
  // and Confort from Auto sends {targetMode: 1} — one field, so leaving Auto
  // needs nothing else cleared.
  const client = fakeAxencoClient();
  const entry = describe_(axencoThermostat());
  const states = await handleSetValue(client, entry, 'preset:auto', 1);

  assert.deepEqual(client.calls, [{ name: 'setDeviceMode', args: [entry.axencoId, 0] }]);
  assert.equal(PRESETS.auto.code, 0);
  assert.equal(stateFor(states, entry, 'preset:auto').state, 1);
  assert.equal(stateFor(states, entry, 'preset:comfort').state, 0);
  assert.equal(stateFor(states, entry, 'mode').text, 'Auto');
});

test('hardware reporting 60 or 61 reads back as Auto, and says which side', () => {
  // We write 0; a radiator in Auto reports 60 or 61 instead, to say whether
  // the schedule currently asks for Confort or Éco. The switch stays a single
  // "Auto"; only the text feature is finer-grained.
  const entry = describe_(axencoThermostat());
  const expected = { 0: 'Auto', 60: 'Auto (Confort)', 61: 'Auto (Éco)' };
  for (const [reported, text] of Object.entries(expected)) {
    const states = buildStates(entry, { targetMode: Number(reported) });
    assert.equal(stateFor(states, entry, 'mode').text, text, `code ${reported}`);
    assert.equal(stateFor(states, entry, 'preset:auto').state, 1, `code ${reported}`);
  }
});

test('the per-mode setpoints are three writable features, written together', async () => {
  const client = fakeAxencoClient();
  const entry = describe_(
    axencoThermostat({ state: { targetMode: 1, comfTemp: 20, ecoTemp: 18, antifTemp: 7 } }),
  );
  assert.ok(featureNames(entry).includes('Consigne Confort'));
  assert.ok(featureNames(entry).includes('Consigne Éco'));
  assert.ok(featureNames(entry).includes('Consigne Hors gel'));

  const states = await handleSetValue(client, entry, 'eco-temperature', 17);
  // The app sends the three together even when one changed; the untouched two
  // come from the last known state.
  assert.deepEqual(client.calls, [
    {
      name: 'setDeviceSetpoints',
      args: [entry.axencoId, { comfTemp: 20, ecoTemp: 17, antifTemp: 7 }],
    },
  ]);
  assert.equal(stateFor(states, entry, 'eco-temperature').state, 17);
  assert.equal(stateFor(states, entry, 'comfort-temperature').state, 20);
});

test('a device not reporting a setpoint field gets no feature for it', () => {
  // The device says what it has; we never assume it per model.
  const entry = describe_(axencoThermostat({ state: { targetMode: 1, comfTemp: 20 } }));
  assert.ok(featureNames(entry).includes('Consigne Confort'));
  assert.ok(!featureNames(entry).includes('Consigne Éco'));
});

test('per-mode setpoints are refused where they cannot be written', async () => {
  const client = fakeAxencoClient();

  // A sub-device: the rfid-keyed payload has never been observed.
  const sub = describe_(
    axencoSubDevice({ state: { targetMode: 1, targetTemp: 19, comfTemp: 20 } }),
  );
  assert.ok(!featureNames(sub).includes('Consigne Confort'));
  await assert.rejects(
    () => handleSetValue(client, sub, 'comfort-temperature', 21),
    /cannot be written on a/,
  );

  // An EWS reports the three fields but refuses them: it drives a fil pilote
  // and regulates nothing itself. Confirmed against the hardware.
  const ews = describe_(
    axencoThermostat({
      model: 'EWS',
      state: { deviceType: 1, targetMode: 1, comfTemp: 19, ecoTemp: 15.5, antifTemp: 7 },
    }),
  );
  for (const name of ['Consigne Confort', 'Consigne Éco', 'Consigne Hors gel']) {
    assert.ok(!featureNames(ews).includes(name), `${name} must not appear on an EWS`);
  }
  await assert.rejects(
    () => handleSetValue(client, ews, 'comfort-temperature', 21),
    /cannot be written on a EWS/,
  );

  assert.deepEqual(client.calls, []);
});

test('Dérogation is decoded but never selectable', async () => {
  const client = fakeAxencoClient();
  const entry = describe_(axencoThermostat());
  // Reported by the device: it must read back as a label.
  assert.equal(stateFor(buildStates(entry, { targetMode: 8 }), entry, 'mode').text, 'Dérogation');
  // But there is no switch for it, and asking for one is refused.
  await assert.rejects(() => handleSetValue(client, entry, 'preset:setpoint', 1), /Unknown preset/);
  assert.deepEqual(client.calls, []);
});

test('a sub-device is written through its gateway and rfid', async () => {
  const client = fakeAxencoClient();
  const entry = describe_(axencoSubDevice({ state: { targetMode: PRESETS.setpoint.code } }));
  await handleSetValue(client, entry, 'target-temperature', 19.5);

  assert.deepEqual(client.calls, [
    { name: 'setSubDeviceTemperature', args: [entry.parents, 'A1B2', 19.5] },
  ]);
});

test('a UFH change-over goes through the dedicated sub-device route', async () => {
  const client = fakeAxencoClient();
  const entry = describe_(axencoSubDevice({ model: 'UFH', state: { changeOverUser: 0 } }));
  const states = await handleSetValue(client, entry, 'cooling', 1);

  assert.deepEqual(client.calls, [
    { name: 'setSubDeviceModeUfh', args: [entry.parents, 'A1B2', PRESETS.cooling.code] },
  ]);
  assert.equal(stateFor(states, entry, 'cooling').state, 1);
  assert.equal(stateFor(states, entry, 'mode').text, 'Rafraîchissement');
});

test('the change-over of a NTD is refused, and unknown features too', async () => {
  const client = fakeAxencoClient();
  const ntd = describe_(axencoSubDevice({ model: 'NTD', state: { targetMode: 1 } }));
  await assert.rejects(() => handleSetValue(client, ntd, 'cooling', 1), /read-only/);
  await assert.rejects(() => handleSetValue(client, ntd, 'nope', 1), /not writable/);
  assert.deepEqual(client.calls, []);
});

test('a sub-device missing its gateway fails loudly instead of building a bad URL', async () => {
  const client = fakeAxencoClient();
  const entry = describe_(axencoSubDevice({ parents: '', state: { targetMode: 1 } }));
  await assert.rejects(() => handleSetValue(client, entry, 'preset:eco', 1), /no gateway/);
});

test('a feature key is read back from its external id', () => {
  const entry = describe_(axencoThermostat());
  assert.equal(featureKeyOf(entry, entry.ids.feature('preset:comfort')), 'preset:comfort');
  assert.equal(featureKeyOf(entry, entry.ids.feature('mode')), 'mode');
});

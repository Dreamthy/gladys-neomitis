import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDevice, buildStates, modeLabel, FEATURE } from '../src/devices/index.js';
import { STANDARD } from '../src/devices/standard.js';
import { axencoThermostat, axencoSubDevice, fakeGladys } from './helpers/fakes.js';

const has = (entry, key) =>
  entry.gladysDevice.features.some((f) => f.external_id === entry.ids.feature(key));
const stateFor = (states, entry, key) =>
  states.find((s) => s.device_feature_external_id === entry.ids.feature(key));
const existingDevice = (raw, keys) => {
  const ids = fakeGladys.externalIds('axenco', raw._id);
  return {
    ...fakeGladys,
    devices: [
      { external_id: ids.device, features: keys.map((key) => ({ external_id: ids.feature(key) })) },
    ],
  };
};

test('new devices expose one standard window contact and no text alongside the mode selector', () => {
  const devices = [
    ...['EV30', 'ECTRL', 'ESTAT', 'RSS-ECTRL'].map((model) =>
      axencoThermostat({ model, state: { targetMode: 1, windowStatus: false } }),
    ),
    ...[0, 1].map((deviceType) =>
      axencoThermostat({ model: 'EWS', state: { targetMode: 1, deviceType, windowStatus: false } }),
    ),
    ...['NTD', 'ETRV'].map((model) =>
      axencoSubDevice({ model, state: { targetMode: 1, windowStatus: false } }),
    ),
  ];
  for (const raw of devices) {
    const entry = describeDevice(fakeGladys, raw);
    assert.ok(has(entry, FEATURE.MODE_SELECT), raw.model);
    assert.equal(has(entry, FEATURE.MODE), false, raw.model);
    assert.equal(has(entry, 'open-window'), false, raw.model);
    const contacts = entry.gladysDevice.features.filter((f) => f.category === 'opening-sensor');
    assert.equal(contacts.length, 1, raw.model);
    assert.equal(contacts[0].external_id, entry.ids.feature(STANDARD.WINDOW));
    assert.equal(contacts[0].name, 'Fenêtre ouverte');
    const closed = buildStates(entry, { targetMode: 1, windowStatus: false });
    assert.equal(stateFor(closed, entry, STANDARD.WINDOW).state, 1);
    assert.equal(stateFor(closed, entry, FEATURE.MODE), undefined);
    assert.equal(stateFor(closed, entry, 'open-window'), undefined);
    assert.equal(
      stateFor(buildStates(entry, { windowStatus: true }), entry, STANDARD.WINDOW).state,
      0,
    );
  }
});

test('discovery retains only the old read-only features that already exist', () => {
  const raw = axencoThermostat({ state: { targetMode: 60, windowStatus: false } });
  for (const keys of [[], [FEATURE.MODE], ['open-window'], [FEATURE.MODE, 'open-window']]) {
    const entry = describeDevice(existingDevice(raw, keys), raw);
    for (const key of [FEATURE.MODE, 'open-window']) {
      assert.equal(has(entry, key), keys.includes(key), key);
      if (keys.includes(key)) {
        const f = entry.gladysDevice.features.find(
          (item) => item.external_id === entry.ids.feature(key),
        );
        assert.match(f.name, /compatibilité/);
        assert.equal(f.read_only, true);
      }
    }
    const states = buildStates(entry, { targetMode: 60, windowStatus: true });
    assert.equal(stateFor(states, entry, STANDARD.WINDOW).state, 0);
    if (keys.includes('open-window')) assert.equal(stateFor(states, entry, 'open-window').state, 1);
    if (keys.includes(FEATURE.MODE))
      assert.equal(stateFor(states, entry, FEATURE.MODE).text, 'Auto (Confort)');
  }
});

test('missing or temporarily invalid window readings do not delete existing contacts', () => {
  for (const value of [undefined, null, 'false', 2]) {
    const raw = axencoThermostat({ state: { targetMode: 1, windowStatus: value } });
    const entry = describeDevice(existingDevice(raw, [STANDARD.WINDOW, 'open-window']), raw);
    assert.ok(has(entry, STANDARD.WINDOW));
    assert.ok(has(entry, 'open-window'));
    assert.equal(
      stateFor(buildStates(entry, { windowStatus: value }), entry, STANDARD.WINDOW),
      undefined,
    );
    assert.equal(stateFor(buildStates(entry, {}), entry, 'open-window'), undefined);
    assert.equal(has(describeDevice(fakeGladys, raw), STANDARD.WINDOW), false);
    assert.equal(has(describeDevice(fakeGladys, raw), 'open-window'), false);
  }
});

test('full mode labels are available without creating a text feature', () => {
  const entry = describeDevice(fakeGladys, axencoThermostat());
  for (const [code, label] of [
    [0, 'Auto'],
    [60, 'Auto (Confort)'],
    [61, 'Auto (Éco)'],
    [42, 'Inconnu (42)'],
  ]) {
    assert.equal(modeLabel(entry, { targetMode: code }), label);
    assert.equal(
      stateFor(buildStates(entry, { targetMode: code }), entry, FEATURE.MODE),
      undefined,
    );
  }
  assert.equal(modeLabel(entry, {}), undefined);
});

test('devices without a mode selector retain their read-only mode indication', () => {
  const entry = describeDevice(
    fakeGladys,
    axencoSubDevice({ model: 'UFH', state: { changeOverUser: 0, windowStatus: false } }),
  );
  assert.equal(has(entry, FEATURE.MODE_SELECT), false);
  assert.ok(has(entry, FEATURE.MODE));
  const modes = buildStates(entry, { changeOverUser: 1 });
  assert.equal(stateFor(modes, entry, FEATURE.MODE).text, 'Rafraîchissement');
  assert.equal(has(entry, 'open-window'), false);
  assert.ok(has(entry, STANDARD.WINDOW));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeDevice,
  buildStates,
  handleSetValue,
  modeLabel,
  FEATURE,
} from '../src/devices/index.js';
import {
  fakeGladys,
  fakeAxencoClient,
  axencoThermostat,
  axencoSubDevice,
} from './helpers/fakes.js';
import { STANDARD } from '../src/devices/standard.js';

const feature = (entry) =>
  entry.gladysDevice.features.find((f) => f.external_id === entry.ids.feature(FEATURE.MODE_SELECT));
const selected = (entry, patch) =>
  buildStates(entry, patch).find(
    (s) => s.device_feature_external_id === entry.ids.feature(FEATURE.MODE_SELECT),
  )?.text;

test('new devices use one Axenco selector without creating legacy mode switches', () => {
  for (const raw of [
    axencoThermostat(),
    axencoSubDevice(),
    axencoThermostat({ model: 'EWS', state: { deviceType: 1 } }),
  ]) {
    const entry = describeDevice(fakeGladys, raw);
    const select = feature(entry);
    assert.equal(select.category, 'text');
    assert.equal(select.type, 'select');
    assert.equal(select.keep_history, false);
    assert.equal(select.read_only, false);
    assert.equal(
      entry.gladysDevice.features.some((f) => f.external_id.includes(':preset:')),
      false,
    );
    assert.ok(
      select.supported_options.every(
        (option) => typeof option.value === 'string' && typeof option.label === 'string',
      ),
    );
  }
});

test('discovery retains exactly the legacy switches already created by the user', () => {
  const raw = axencoThermostat();
  const ids = fakeGladys.externalIds('axenco', raw._id);
  const legacy = { name: 'Éco', external_id: ids.feature('preset:eco') };
  const entry = describeDevice(
    { ...fakeGladys, devices: [{ external_id: ids.device, features: [legacy] }] },
    raw,
  );
  assert.ok(feature(entry));
  assert.deepEqual(
    entry.gladysDevice.features
      .filter((f) => f.external_id.includes(':preset:'))
      .map((f) => f.external_id),
    [legacy.external_id],
  );
});

test('selector options follow the model and wiring, with no fake temperature mode on EWS', () => {
  const ev30 = describeDevice(fakeGladys, axencoThermostat());
  assert.ok(feature(ev30).supported_options.some((o) => o.value === 'setpoint'));
  assert.ok(!feature(ev30).supported_options.some((o) => o.value === 'comfort_plus'));
  const relay = describeDevice(
    fakeGladys,
    axencoThermostat({ model: 'EWS', state: { deviceType: 0 } }),
  );
  assert.deepEqual(
    feature(relay).supported_options.map((o) => o.value),
    ['on', 'off', 'auto'],
  );
  const pilot = describeDevice(
    fakeGladys,
    axencoThermostat({ model: 'EWS', state: { deviceType: 1 } }),
  );
  assert.ok(
    !feature(pilot).supported_options.some((o) => ['setpoint', 'comfort_plus'].includes(o.value)),
  );
  assert.ok(feature(pilot).supported_options.some((o) => o.value === 'eco_2'));
  assert.equal(
    feature(describeDevice(fakeGladys, axencoSubDevice({ model: 'UFH' }))),
    undefined,
    'UFH retains its standard binary change-over',
  );
});

test('selector states recognize Auto, override, standby and clear unknown modes', () => {
  const entry = describeDevice(fakeGladys, axencoThermostat());
  for (const code of [0, 60, 61]) assert.equal(selected(entry, { targetMode: code }), 'auto');
  assert.equal(selected(entry, { targetMode: 4 }), 'standby');
  assert.equal(selected(entry, { targetMode: 8 }), 'setpoint');
  assert.equal(selected(entry, { targetMode: 42 }), 'unknown:42');
  assert.equal(modeLabel(entry, { targetMode: 42 }), 'Inconnu (42)');
  assert.ok(
    !buildStates(entry, { targetMode: 42 }).some(
      (s) => s.device_feature_external_id === entry.ids.feature(FEATURE.MODE),
    ),
  );
  assert.equal(selected(entry, { currentTemp: 19 }), undefined);
});

test('selector commands use the existing main, relay, pilot-wire and gateway routes', async () => {
  const scenarios = [
    [axencoThermostat(), 'auto', 'setDeviceMode', 0],
    [axencoThermostat({ model: 'EWS', state: { deviceType: 0 } }), 'off', 'setDeviceMode', 2],
    [axencoThermostat({ model: 'EWS', state: { deviceType: 1 } }), 'eco_2', 'setDeviceMode', 41],
    [axencoSubDevice(), 'eco', 'setSubDeviceMode', 2],
  ];
  for (const [raw, mode, method, code] of scenarios) {
    const entry = describeDevice(fakeGladys, raw);
    const client = fakeAxencoClient();
    const states = await handleSetValue(client, entry, FEATURE.MODE_SELECT, mode);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].name, method);
    assert.equal(client.calls[0].args.at(-1), code);
    assert.equal(
      states.find((s) => s.device_feature_external_id === entry.ids.feature(FEATURE.MODE_SELECT))
        .text,
      mode,
    );
  }
});

test('EWS removes the six-order duplicate and preserves the full selector and legacy modes', async () => {
  const raw = axencoThermostat({ model: 'EWS', state: { deviceType: 1 } });
  const ids = fakeGladys.externalIds('axenco', raw._id);
  const existing = [STANDARD.PILOT, FEATURE.MODE_SELECT, 'preset:eco_1', 'preset:standby'];
  const entry = describeDevice(
    {
      ...fakeGladys,
      devices: [
        {
          external_id: ids.device,
          features: existing.map((key) => ({ external_id: ids.feature(key) })),
        },
      ],
    },
    raw,
  );
  const pilot = entry.gladysDevice.features.find(
    (f) => f.external_id === ids.feature(STANDARD.PILOT),
  );
  assert.equal(pilot, undefined);
  assert.equal(feature(entry).name, 'Mode du module');
  const client = fakeAxencoClient();
  for (const [key, code, label] of [
    ['eco_1', 40, 'Confort −1 °C'],
    ['eco_2', 41, 'Confort −2 °C'],
    ['standby', 4, 'Arrêt'],
  ]) {
    assert.equal(feature(entry).supported_options.find((o) => o.value === key).label, label);
    assert.equal(modeLabel(entry, { targetMode: code }), label);
    await handleSetValue(client, entry, FEATURE.MODE_SELECT, key);
    assert.deepEqual(client.calls.slice(-1), [
      { name: 'setDeviceMode', args: [entry.axencoId, code] },
    ]);
  }
  for (const key of existing.filter((key) => key !== STANDARD.PILOT))
    assert.ok(entry.gladysDevice.features.some((f) => f.external_id === ids.feature(key)));
  assert.equal(
    entry.gladysDevice.features.find((f) => f.external_id === ids.feature('preset:eco_1')).name,
    'Confort −1 °C',
  );
  assert.equal(
    modeLabel(describeDevice(fakeGladys, axencoThermostat()), { targetMode: 4 }),
    'Veille',
  );
  const count = client.calls.length;
  await assert.rejects(handleSetValue(client, entry, STANDARD.PILOT, 0), /cannot be written/);
  assert.equal(client.calls.length, count, 'stale six-order commands never reach Axenco');
});

test('override selection writes the observed target rather than an ignored mode-8 order', async () => {
  const entry = describeDevice(fakeGladys, axencoThermostat());
  entry.state.overrideTemp = 21; // an unconfirmed legacy request must not be reused
  const client = fakeAxencoClient();
  await handleSetValue(client, entry, FEATURE.MODE_SELECT, 'setpoint');
  assert.deepEqual(client.calls, [{ name: 'setDeviceTemperature', args: [entry.axencoId, 20] }]);
  const missing = describeDevice(fakeGladys, axencoThermostat({ state: { targetMode: 1 } }));
  await assert.rejects(
    handleSetValue(client, missing, FEATURE.MODE_SELECT, 'setpoint'),
    /temperature/i,
  );
  assert.equal(client.calls.length, 1);
});

test('invalid selectors and unsupported modes never reach Axenco', async () => {
  const entry = describeDevice(fakeGladys, axencoThermostat());
  const client = fakeAxencoClient();
  for (const value of [1, true, null, {}, '', 'comfort_plus', '__proto__', 'unknown'])
    await assert.rejects(
      handleSetValue(client, entry, FEATURE.MODE_SELECT, value),
      /Unknown preset/,
    );
  assert.equal(client.calls.length, 0);
});

test('a rejected mode write does not publish a successful selection', async () => {
  const entry = describeDevice(fakeGladys, axencoThermostat());
  const before = { ...entry.state };
  await assert.rejects(
    handleSetValue(
      {
        setDeviceMode: async () => {
          throw new Error('offline');
        },
      },
      entry,
      FEATURE.MODE_SELECT,
      'eco',
    ),
    /offline/,
  );
  assert.deepEqual(entry.state, before);
});

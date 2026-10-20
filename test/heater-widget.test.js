import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { describeDevice, FEATURE } from '../src/devices/index.js';
import { registerSurfaces } from '../src/gladys/surfaces.js';
import { axencoThermostat, axencoSubDevice } from './helpers/fakes.js';

async function widget(raw = axencoThermostat(), { health = {}, filter = () => true } = {}) {
  const gladys = createFakeGladys();
  const entry = describeDevice(gladys, raw);
  const device = { ...entry.gladysDevice, features: entry.gladysDevice.features.filter(filter) };
  const target = device.features.find(
    (f) => f.external_id === entry.ids.feature(FEATURE.TARGET_TEMP),
  );
  if (target) target.last_value = 20;
  gladys.fake.devices = [device];
  await gladys.connect();
  const commands = [];
  const connection = {
    restReachable: true,
    pushConnected: true,
    lastSuccessAt: new Date().toISOString(),
    ...health,
  };
  registerSurfaces(gladys, {
    findEntry: () => entry,
    command: async (...args) => commands.push(args),
    status: () => connection,
  });
  const get = async (settings = {}, units = 'metric') => {
    const reply = await gladys.fake.widgetGet('heater', {
      settings: { device: entry.ids.device, ...settings },
      units,
    });
    assert.equal(reply.success, true);
    assert.deepEqual(validateWidgetContent(reply.data.content), []);
    return reply.data.content.components;
  };
  const act = (key, values = {}) =>
    gladys.fake.widgetAction('heater', key, {}, { settings: { device: entry.ids.device }, values });
  return { gladys, entry, commands, connection, get, act };
}
const buttons = (components) => components.filter((c) => c.type === 'button');
const rows = (components) => components.find((c) => c.type === 'status').items;

test('EV30 widget keeps live temperatures and only Mode and Setpoint buttons', async () => {
  const { get, entry } = await widget(
    axencoThermostat({ state: { targetMode: 60, windowStatus: false } }),
  );
  const content = await get();
  assert.equal(content.length, 6);
  assert.deepEqual(
    buttons(content).map((b) => b.action.key),
    ['mode', 'temperature'],
  );
  const tiles = content.filter((c) => c.type === 'value');
  assert.deepEqual(
    tiles.map((c) => c.device_feature),
    [entry.ids.feature(FEATURE.CURRENT_TEMP), entry.ids.feature(FEATURE.TARGET_TEMP)],
  );
  assert.ok(tiles.every((c) => c.value === undefined && c.unit === undefined));
  assert.deepEqual(
    (await get({}, 'us')).filter((c) => c.type === 'value'),
    tiles,
    'live feature tiles delegate unit conversion to Gladys',
  );
  assert.equal(rows(content).find((r) => r.label.en === 'Mode').value, 'Auto (Confort)');
  assert.deepEqual(
    rows(content).map((r) => r.label.en),
    ['Mode', 'Window'],
  );
  assert.equal(
    buttons(content).find((b) => b.action.key === 'mode').action.fields[0].default,
    'auto',
  );
});

test('window indication respects boolean and numeric readings without guessing absent values', async () => {
  for (const [windowStatus, expected] of [
    [true, 'Ouverture détectée'],
    [1, 'Ouverture détectée'],
    [false, 'Fermée'],
    [0, 'Fermée'],
  ]) {
    const { get } = await widget(axencoThermostat({ state: { targetMode: 1, windowStatus } }));
    assert.equal(rows(await get()).find((r) => r.label.en === 'Window').value.fr, expected);
  }
  const { get, entry } = await widget();
  assert.equal(
    rows(await get()).some((r) => r.label.en === 'Window'),
    false,
  );
  const reported = await widget(
    axencoThermostat({ state: { targetMode: 1, windowStatus: false } }),
  );
  reported.entry.observedState.windowStatus = null;
  assert.equal(
    rows(await reported.get()).find((r) => r.label.en === 'Window').value.fr,
    'État inconnu',
  );
  assert.equal(entry.observedState.windowStatus, undefined);
});

test('connection details are optional and anomalies stay visible in compact mode', async () => {
  const { get, connection, entry } = await widget();
  assert.deepEqual(
    rows(await get()).map((r) => r.label.en),
    ['Mode'],
  );
  assert.deepEqual(
    rows(await get({ show_diagnostics: true })).map((r) => r.label.en),
    ['Mode', 'Cloud', 'Real time', 'Last cloud read'],
  );
  connection.pushConnected = false;
  assert.equal(rows(await get()).find((r) => r.label.en === 'Real time').color, 'warning');
  connection.restReachable = false;
  entry.connected = false;
  assert.equal(rows(await get()).find((r) => r.label.en === 'Cloud').color, 'danger');
  assert.equal(rows(await get()).find((r) => r.label.en === 'Device').value.fr, 'Hors ligne');
  connection.lastSuccessAt = 'invalid';
  assert.equal(
    rows(await get({ show_diagnostics: true })).find((r) => r.label.en === 'Last cloud read').value
      .fr,
    'Indisponible',
  );
});

test('Auto and standby remain available through Mode while shortcut actions are removed', async () => {
  const { get, act, entry, commands } = await widget(
    axencoThermostat({ state: { targetMode: 4 } }),
  );
  const mode = buttons(await get()).find((button) => button.action.key === 'mode');
  assert.equal(mode.action.fields[0].default, 'standby');
  const options = mode.action.fields[0].options.map((option) => option.value);
  assert.ok(options.includes('auto'));
  assert.ok(options.includes('standby'));
  assert.equal((await act('mode', { mode: 'auto' })).success, true);
  assert.equal((await act('mode', { mode: 'standby' })).success, true);
  assert.deepEqual(commands, [
    [entry.ids.device, FEATURE.MODE_SELECT, 'auto'],
    [entry.ids.device, FEATURE.MODE_SELECT, 'standby'],
  ]);
  for (const removed of ['auto', 'stop', 'resume'])
    assert.equal((await act(removed)).success, false);
  assert.equal(commands.length, 2);
});

test('Mode and Setpoint buttons match relay, pilot-wire, thermostat and UFH capabilities', async () => {
  for (const [raw, keys, selection, feature, value] of [
    [
      axencoThermostat({ model: 'EWS', state: { deviceType: 0, targetMode: 2 } }),
      ['mode'],
      'on',
      FEATURE.MODE_SELECT,
      'on',
    ],
    [
      axencoThermostat({ model: 'EWS', state: { deviceType: 1, targetMode: 4 } }),
      ['mode'],
      'comfort',
      FEATURE.MODE_SELECT,
      'comfort',
    ],
    [
      axencoSubDevice({ state: { targetMode: 4 } }),
      ['mode', 'temperature'],
      'comfort',
      FEATURE.MODE_SELECT,
      'comfort',
    ],
    [
      axencoSubDevice({ model: 'UFH', state: { changeOverUser: 0 } }),
      ['mode'],
      'cooling',
      FEATURE.COOLING,
      1,
    ],
  ]) {
    const { get, act, commands, entry } = await widget(raw);
    const content = await get();
    assert.deepEqual(
      buttons(content).map((b) => b.action.key),
      keys,
      raw.model,
    );
    assert.equal((await act('mode', { mode: selection })).success, true);
    assert.deepEqual(commands, [[entry.ids.device, feature, value]]);
    if (raw.model === 'ETRV') {
      const options = buttons(content)[0].action.fields[0].options.map((option) => option.value);
      assert.ok(!options.includes('auto'));
      assert.equal((await act('mode', { mode: 'auto' })).success, false);
    }
  }
});

test('missing created controls do not produce unusable buttons', async () => {
  const { get, act, commands } = await widget(axencoThermostat(), {
    filter: (f) =>
      !['thermostat-mode', 'axenco-mode', 'target-temperature'].some((key) =>
        f.external_id.endsWith(`:${key}`),
      ),
  });
  assert.deepEqual(buttons(await get()), []);
  assert.equal((await act('stop')).success, false);
  assert.deepEqual(commands, []);
});

test('EWS widget uses the full observed module mode and explains six-order limitations', async () => {
  const { get, entry } = await widget(
    axencoThermostat({ model: 'EWS', state: { deviceType: 1, targetMode: 40 } }),
  );
  let content = await get();
  const field = buttons(content)[0].action.fields[0];
  assert.equal(field.label.fr, 'Mode du module');
  assert.equal(field.options.find((o) => o.value === 'eco_1').label.fr, 'Confort −1 °C');
  assert.equal(field.options.find((o) => o.value === 'eco_2').label.fr, 'Confort −2 °C');
  assert.equal(field.options.find((o) => o.value === 'standby').label.fr, 'Arrêt');
  const limitation = (items) => items.find((r) => r.label.en === 'Six-order control');
  assert.equal(limitation(rows(content)), undefined);
  // A requested mode must not replace the hardware observation in the widget.
  entry.state.targetMode = 4;
  assert.equal(rows(await get()).find((r) => r.label.en === 'Module mode').value, 'Confort −1 °C');
  for (const [code, expected] of [
    [0, 'Auto'],
    [60, 'Auto (Confort)'],
    [61, 'Auto (Éco)'],
    [6, 'Boost'],
    [42, 'Inconnu (42)'],
  ]) {
    entry.observedState.targetMode = code;
    content = await get({ show_diagnostics: true });
    assert.equal(rows(content).find((r) => r.label.en === 'Module mode').value, expected);
    assert.equal(limitation(rows(content)).color, 'warning');
  }
  entry.observedState.targetMode = 4;
  content = await get();
  assert.equal(rows(content).find((r) => r.label.en === 'Module mode').value, 'Arrêt');
  assert.equal(limitation(rows(content)), undefined);
  const relay = await widget(
    axencoThermostat({ model: 'EWS', state: { deviceType: 0, targetMode: 60 } }),
  );
  assert.equal(limitation(rows(await relay.get())), undefined);
});

test('setpoint form respects hardware bounds and omits invalid remembered defaults', async () => {
  const { get, gladys } = await widget();
  let field = buttons(await get()).find((b) => b.action.key === 'temperature').action.fields[0];
  assert.deepEqual([field.min, field.max, field.default], [16, 21, 20]);
  const target = gladys.fake.devices[0].features.find((f) =>
    f.external_id.endsWith(':target-temperature'),
  );
  for (const value of [7, 22, 20.1, NaN]) {
    target.last_value = value;
    field = buttons(await get()).find((b) => b.action.key === 'temperature').action.fields[0];
    assert.equal(field.default, undefined);
  }
});

test('forms refresh the current Gladys setpoint instead of using a stale SDK snapshot', async () => {
  const { get, gladys } = await widget();
  gladys.fake.devices = gladys.devices.map((device) => ({
    ...device,
    features: device.features.map((feature) => ({
      ...feature,
      ...(feature.external_id.endsWith(':target-temperature') ? { last_value: 21 } : {}),
    })),
  }));
  const field = buttons(await get()).find((b) => b.action.key === 'temperature').action.fields[0];
  assert.equal(field.default, 21);
});

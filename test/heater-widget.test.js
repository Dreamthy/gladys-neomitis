import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { describeDevice, FEATURE } from '../src/devices/index.js';
import { STANDARD } from '../src/devices/standard.js';
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

test('EV30 widget uses exactly eight components with live temperatures and four useful commands', async () => {
  const { get, entry } = await widget(
    axencoThermostat({ state: { targetMode: 60, windowStatus: false } }),
  );
  const content = await get();
  assert.equal(content.length, 8);
  assert.deepEqual(
    buttons(content).map((b) => b.action.key),
    ['stop', 'auto', 'mode', 'temperature'],
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

test('stop/resume buttons are explicit commands based on the observed mode', async () => {
  const { get, act, entry, commands } = await widget(
    axencoThermostat({ state: { targetMode: 4 } }),
  );
  assert.equal(buttons(await get())[0].label.fr, 'Reprendre');
  assert.equal((await act('resume')).success, true);
  assert.deepEqual(commands[0], [entry.ids.device, STANDARD.MODE, 1]);
  entry.observedState.targetMode = 8;
  assert.equal(buttons(await get())[0].label.fr, 'Arrêter');
  assert.equal((await act('stop')).success, true);
  assert.deepEqual(commands[1], [entry.ids.device, STANDARD.MODE, 0]);
  assert.equal((await act('auto')).success, true);
  assert.deepEqual(commands[2], [entry.ids.device, FEATURE.MODE_SELECT, 'auto']);
});

test('power commands and buttons match relay, pilot-wire, thermostat and UFH capabilities', async () => {
  for (const [raw, keys, method, value] of [
    [
      axencoThermostat({ model: 'EWS', state: { deviceType: 0, targetMode: 2 } }),
      ['resume', 'auto', 'mode'],
      STANDARD.RELAY,
      1,
    ],
    [
      axencoThermostat({ model: 'EWS', state: { deviceType: 1, targetMode: 4 } }),
      ['resume', 'auto', 'mode'],
      FEATURE.MODE_SELECT,
      'comfort',
    ],
    [
      axencoSubDevice({ state: { targetMode: 4 } }),
      ['resume', 'mode', 'temperature'],
      FEATURE.MODE_SELECT,
      'comfort',
    ],
    [axencoSubDevice({ model: 'UFH', state: { changeOverUser: 0 } }), ['mode'], null, null],
  ]) {
    const { get, act, commands, entry } = await widget(raw);
    assert.deepEqual(
      buttons(await get()).map((b) => b.action.key),
      keys,
      raw.model,
    );
    const ack = await act('resume');
    assert.equal(ack.success, Boolean(method));
    assert.deepEqual(commands, method ? [[entry.ids.device, method, value]] : []);
    if (raw.model === 'ETRV') {
      assert.equal(buttons(await get())[0].label.fr, 'Reprendre en Confort');
      assert.equal((await act('auto')).success, false);
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

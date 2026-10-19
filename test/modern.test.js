import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { describeDevice, buildStates, handleSetValue } from '../src/devices/index.js';
import { STANDARD } from '../src/devices/standard.js';
import { createThermostatControl, effectiveTarget } from '../src/gladys/thermostat.js';
import { createDeviceQueue } from '../src/gladys/queue.js';
import { createControlStore } from '../src/gladys/control-store.js';
import { registerSurfaces } from '../src/gladys/surfaces.js';
import { createPublisher } from '../src/gladys/publisher.js';
import { createReconciler } from '../src/gladys/reconciler.js';
import { normalizeConfig } from '../src/config.js';
import {
  fakeGladys,
  fakeAxencoClient,
  axencoThermostat,
  axencoSubDevice,
} from './helpers/fakes.js';

function harness(t, { saved = {}, state = {} } = {}) {
  const entry = describeDevice(
    fakeGladys,
    axencoThermostat({
      state: {
        targetMode: 8,
        overrideTemp: 20,
        currentTemp: 19,
        comfLimitMin: 7,
        comfLimitMax: 30,
        ...state,
      },
    }),
  );
  const client = fakeAxencoClient();
  const records = new Map(Object.entries(saved));
  const failures = [];
  const checks = [];
  const queue = createDeviceQueue();
  const control = createThermostatControl({
    client,
    store: {
      get: (id) => records.get(id),
      set: async (id, value) => records.set(id, { ...value }),
    },
    enqueue: queue,
    getEntry: () => entry,
    reconcile: (...args) => checks.push(args),
    failure: (...args) => failures.push(args),
    resumeDelayMs: 100,
  });
  t.after(() => control.cancelAll());
  return { control, entry, client, failures, records, checks };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('native OFF followed by the frost fallback never sends targetMode 8', async (t) => {
  const { control, entry, client, records } = harness(t);
  await control.command(entry, STANDARD.MODE, 0);
  const parked = await control.command(entry, STANDARD.TARGET, 7);
  assert.deepEqual(client.calls, [{ name: 'setDeviceMode', args: [entry.axencoId, 4] }]);
  assert.equal(parked[0].state, 7);
  assert.equal(records.get(entry.axencoId).stopped, true);
});

test('native stop survives a restart even before the cloud has reported standby', async (t) => {
  const original = harness(t);
  await original.control.command(original.entry, STANDARD.MODE, 0);
  const restarted = harness(t, { saved: Object.fromEntries(original.records) });
  await restarted.control.command(restarted.entry, STANDARD.TARGET, 7);
  assert.equal(restarted.client.calls.length, 0);
});

test('resume followed by a target is one Axenco temperature command', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { control, entry, client } = harness(t, { state: { targetMode: 4 } });
  await control.command(entry, STANDARD.MODE, 1);
  await control.command(entry, STANDARD.TARGET, 21);
  t.mock.timers.tick(200);
  await settle();
  assert.deepEqual(client.calls, [{ name: 'setDeviceTemperature', args: [entry.axencoId, 21] }]);
});

test('resume without a new target restores the known target', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { control, entry, client } = harness(t, { state: { targetMode: 4 } });
  await control.command(entry, STANDARD.MODE, 1);
  t.mock.timers.tick(200);
  await settle();
  assert.deepEqual(client.calls, [{ name: 'setDeviceTemperature', args: [entry.axencoId, 20] }]);
});

test('OFF cancels a queued resume', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { control, entry, client } = harness(t);
  await control.command(entry, STANDARD.MODE, 1);
  await control.command(entry, STANDARD.MODE, 0);
  t.mock.timers.tick(200);
  await settle();
  assert.deepEqual(
    client.calls.map((call) => call.name),
    ['setDeviceMode'],
  );
});

test('native targets are not optimistic and an ignored write cannot create a false manual change', async (t) => {
  const { control, entry } = harness(t);
  const initial = control.observe(entry, entry.state);
  assert.equal(
    initial.find((s) => s.device_feature_external_id.endsWith(STANDARD.TARGET)).state,
    20,
  );
  assert.deepEqual(await control.command(entry, STANDARD.TARGET, 21), []);
  assert.ok(
    !control
      .observe(entry, entry.state)
      .some((s) => s.device_feature_external_id.endsWith(STANDARD.TARGET)),
  );
  entry.state.overrideTemp = 21;
  const confirmed = control.observe(entry, { overrideTemp: 21 });
  assert.equal(
    confirmed.find((s) => s.device_feature_external_id.endsWith(STANDARD.TARGET)).state,
    21,
  );
  entry.state.overrideTemp = 19;
  assert.equal(
    control.observe(entry, { overrideTemp: 19 })[0].state,
    19,
    'later human changes still propagate',
  );
});

test('native controls preserve device bounds and reject unsupported steps', async (t) => {
  const { control, entry, client } = harness(t, { state: { comfLimitMin: 16, comfLimitMax: 21 } });
  await assert.rejects(() => control.command(entry, STANDARD.TARGET, 7), /supported range/);
  await assert.rejects(() => control.command(entry, STANDARD.TARGET, 20.1), /step/);
  assert.equal(client.calls.length, 0);
});

test('native observations cannot inherit optimistic legacy mode changes', async (t) => {
  const { control, entry, client } = harness(t, { state: { comfTemp: 21 } });
  await handleSetValue(client, entry, 'preset:comfort', 1);
  assert.equal(entry.state.targetMode, 1, 'legacy state is optimistic');
  const feedback = control.observe(entry, { currentTemp: 19.1 });
  assert.equal(
    feedback.find((s) => s.device_feature_external_id.endsWith(STANDARD.TARGET)).state,
    20,
  );
});

test('storage failure does not prevent sending OFF to the device', async (t) => {
  const entry = describeDevice(fakeGladys, axencoThermostat());
  const client = fakeAxencoClient();
  const control = createThermostatControl({
    client,
    store: {
      get: () => undefined,
      set: async () => {
        throw new Error('disk full');
      },
    },
    enqueue: createDeviceQueue(),
    getEntry: () => entry,
    reconcile() {},
    failure() {},
  });
  t.after(() => control.cancelAll());
  await assert.rejects(control.command(entry, STANDARD.MODE, 0), /disk full/);
  assert.equal(client.calls[0].args[1], 4);
});

test('invalid targets do not cancel a valid pending resume', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { control, entry, client } = harness(t, { state: { targetMode: 4 } });
  await control.command(entry, STANDARD.MODE, 1);
  await assert.rejects(control.command(entry, STANDARD.TARGET, 100));
  t.mock.timers.tick(200);
  await settle();
  assert.equal(client.calls.length, 1);
});

test('effective setpoint follows comfort and eco, not the saved override', () => {
  assert.equal(effectiveTarget({ targetMode: 60, comfTemp: 21, overrideTemp: 18 }), 21);
  assert.equal(effectiveTarget({ targetMode: 61, ecoTemp: 17, overrideTemp: 18 }), 17);
  assert.equal(effectiveTarget({ targetMode: 8, comfTemp: 21, overrideTemp: 18 }), 18);
});

test('relay switch really sends OFF and pilot-wire values are translated', async () => {
  const client = fakeAxencoClient();
  const relay = describeDevice(
    fakeGladys,
    axencoThermostat({ model: 'EWS', state: { deviceType: 0 } }),
  );
  await handleSetValue(client, relay, STANDARD.RELAY, 0);
  assert.equal(client.calls[0].args[1], 2);
  const pilot = describeDevice(
    fakeGladys,
    axencoThermostat({ model: 'EWS', state: { deviceType: 1 } }),
  );
  await handleSetValue(client, pilot, STANDARD.PILOT, 3);
  assert.equal(client.calls[1].args[1], 40);
  await assert.rejects(() => handleSetValue(client, pilot, STANDARD.PILOT, 6));
});

test('window polarity is explicit and legacy window states are preserved', () => {
  assert.equal(normalizeConfig().windowOpenValue, null);
  const raw = axencoThermostat({ state: { windowStatus: true } });
  const entry = describeDevice(fakeGladys, raw, { windowOpenValue: 1 });
  const states = buildStates(entry, raw.state);
  assert.equal(states.find((s) => s.device_feature_external_id.endsWith(':open-window')).state, 1);
  assert.equal(
    states.find((s) => s.device_feature_external_id.endsWith(':window-contact')).state,
    0,
  );
  const inverted = describeDevice(fakeGladys, raw, { windowOpenValue: 0 });
  assert.equal(
    buildStates(inverted, raw.state).find((s) =>
      s.device_feature_external_id.endsWith(':window-contact'),
    ).state,
    1,
  );
});

test('EWS setpoints that were not declared are not published', () => {
  const entry = describeDevice(
    fakeGladys,
    axencoThermostat({
      model: 'EWS',
      state: {
        deviceType: 1,
        comfTemp: 20,
        ecoTemp: 18,
        antifTemp: 7,
      },
    }),
  );
  assert.deepEqual(buildStates(entry, entry.state), []);
});

test('the control store is durable, atomic across concurrent writes and contains no credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'neomitis-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createControlStore(directory);
  await Promise.all([
    store.set('a', { stopped: true, target: 7 }),
    store.set('b', { stopped: false, target: 21 }),
  ]);
  const reopened = await createControlStore(directory);
  assert.equal(reopened.get('a').stopped, true);
  assert.equal(reopened.get('b').target, 21);
  const data = JSON.parse(await readFile(join(directory, 'thermostat-controls.json')));
  assert.deepEqual(Object.keys(data).sort(), ['a', 'b']);
});

test('the per-device queue survives failures and permits other devices to progress', async () => {
  const enqueue = createDeviceQueue();
  let release;
  const waiting = enqueue(
    'a',
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await settle();
  assert.equal(await enqueue('b', async () => 2), 2);
  release();
  await waiting;
  await assert.rejects(
    enqueue('a', async () => {
      throw new Error('failed');
    }),
  );
  assert.equal(await enqueue('a', async () => 3), 3);
});

test('expired queued commands never reach the hardware', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const enqueue = createDeviceQueue();
  let release;
  const first = enqueue(
    'a',
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await settle();
  let sent = false;
  const queued = enqueue('a', () => {
    sent = true;
  });
  const rejected = assert.rejects(queued, /expired/);
  t.mock.timers.tick(1500);
  release();
  await first;
  await rejected;
  assert.equal(sent, false);
});

test('SDK fake validates discovery, widget forms and scene action acknowledgements', async () => {
  const gladys = createFakeGladys();
  const entry = describeDevice(gladys, axencoThermostat());
  gladys.fake.devices = [entry.gladysDevice];
  await gladys.connect();
  await gladys.publishDiscoveredDevices([entry.gladysDevice]);
  const commands = [];
  registerSurfaces(gladys, {
    findEntry: () => entry,
    command: async (...args) => commands.push(args),
    status: () => ({ restReachable: true, pushConnected: true, lastSuccessAt: null }),
  });
  const ack = await gladys.fake.widgetGet('heater', {
    settings: { device: entry.ids.device },
    units: 'metric',
  });
  assert.equal(ack.success, true);
  assert.deepEqual(validateWidgetContent(ack.data.content), []);
  const scene = await gladys.fake.sceneAction('resume_program', { device: entry.ids.device });
  assert.equal(scene.success, true);
  assert.deepEqual(commands[0], [entry.ids.device, 'preset:auto', 1]);
  const widgetMode = await gladys.fake.widgetAction(
    'heater',
    'mode',
    {},
    {
      settings: { device: entry.ids.device },
      values: { mode: 'eco' },
    },
  );
  assert.equal(widgetMode.success, true);
  assert.deepEqual(commands[1], [entry.ids.device, 'preset:eco', 1]);
  const widgetTemperature = await gladys.fake.widgetAction(
    'heater',
    'temperature',
    {},
    {
      settings: { device: entry.ids.device },
      values: { temperature: 20.5 },
    },
  );
  assert.equal(widgetTemperature.success, true);
  assert.deepEqual(commands[2], [entry.ids.device, 'target-temperature', 20.5]);
});

test('publisher ignores uncreated features and sends heartbeats only for fresh snapshots', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const gladys = createFakeGladys();
  const entry = describeDevice(gladys, axencoThermostat());
  gladys.fake.devices = [entry.gladysDevice];
  await gladys.connect();
  const publisher = createPublisher(gladys);
  const states = [
    { device_feature_external_id: entry.ids.feature('current-temperature'), state: 19 },
  ];
  assert.equal((await publisher.publishStates(states)).count, 1);
  assert.equal((await publisher.publishStates(states)).count, 0);
  t.mock.timers.tick(30 * 60 * 1000);
  assert.equal((await publisher.publishStates(states, { heartbeat: true })).count, 1);
  assert.equal(
    (
      await publisher.publishStates([
        { device_feature_external_id: entry.ids.feature('phantom'), state: 1 },
      ])
    ).count,
    0,
  );
});

test('Auto 0 is confirmed by a device reporting 60 or 61', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings = [];
  const reconciler = createReconciler({
    client: { getDeviceState: async () => ({ state: { targetMode: 61 } }) },
    publisher: { publishStates: async () => {} },
    logger: { warn: (s) => warnings.push(s), info() {}, error() {} },
    buildStates: () => [],
    delayMs: 1,
  });
  reconciler.schedule({ axencoId: 'a', model: 'EV30', profile: {}, state: {} }, 'preset:auto', {
    targetMode: 0,
  });
  t.mock.timers.tick(2);
  await settle();
  assert.deepEqual(warnings, []);
});

test('native control does not invent a mode for an unknown Axenco code', (t) => {
  const { control, entry } = harness(t);
  const feedback = control.observe(entry, { targetMode: 999 });
  assert.equal(
    feedback.some((s) => s.device_feature_external_id === entry.ids.feature(STANDARD.MODE)),
    false,
  );
});

test('forgetting a device cancels all its pending reconciliation checks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const reconciler = createReconciler({
    client: {
      getDeviceState: async () => {
        reads += 1;
        return { state: {} };
      },
    },
    publisher: { publishStates: async () => {} },
    logger: { warn() {}, info() {}, error() {} },
    buildStates: () => [],
    delayMs: 1,
  });
  const entry = { axencoId: 'a', profile: {} };
  reconciler.schedule(entry, 'mode', { targetMode: 1 });
  reconciler.schedule(entry, 'temperature', { overrideTemp: 21 });
  reconciler.cancelDevice('a');
  t.mock.timers.tick(2);
  await settle();
  assert.equal(reads, 0);
});

test('a later mode command supersedes the previous mode confirmation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failures = [];
  const reconciler = createReconciler({
    client: { getDeviceState: async () => ({ state: { targetMode: 2 } }) },
    publisher: { publishStates: async () => {} },
    logger: { warn() {}, info() {}, error() {} },
    buildStates: () => [],
    delayMs: 1,
    onFailure: (...args) => failures.push(args),
  });
  const entry = {
    axencoId: 'a',
    model: 'EV30',
    profile: {},
    state: {},
    presetKeys: ['comfort', 'eco'],
  };
  reconciler.schedule(entry, 'preset:comfort', { targetMode: 1 });
  reconciler.schedule(entry, 'preset:eco', { targetMode: 2 });
  t.mock.timers.tick(2);
  await settle();
  assert.deepEqual(failures, []);
});

test('scene modes on UFH use its existing change-over route', async () => {
  const gladys = createFakeGladys();
  const entry = describeDevice(
    gladys,
    axencoSubDevice({ model: 'UFH', state: { changeOverUser: 0 } }),
  );
  gladys.fake.devices = [entry.gladysDevice];
  await gladys.connect();
  const client = fakeAxencoClient();
  registerSurfaces(gladys, {
    findEntry: () => entry,
    command: async (_device, key, value) => handleSetValue(client, entry, key, value),
    status: () => ({}),
  });
  const ack = await gladys.fake.sceneAction('choose_mode', {
    device: entry.ids.device,
    mode: 'cooling',
  });
  assert.equal(ack.success, true);
  assert.equal(client.calls[0].name, 'setSubDeviceModeUfh');
  assert.equal(client.calls[0].args[2], 1);
  assert.equal(
    (await gladys.fake.sceneAction('choose_mode', { device: entry.ids.device, mode: 'eco' }))
      .success,
    false,
  );
});

test('a failed persistent resume cannot let its following target wake the heater', async (t) => {
  const entry = describeDevice(
    fakeGladys,
    axencoThermostat({ state: { targetMode: 4, overrideTemp: 20 } }),
  );
  const client = fakeAxencoClient();
  const control = createThermostatControl({
    client,
    store: {
      get: () => ({ stopped: true, target: 20 }),
      set: async () => {
        throw new Error('disk full');
      },
    },
    enqueue: createDeviceQueue(),
    getEntry: () => entry,
    reconcile() {},
    failure() {},
  });
  t.after(() => control.cancelAll());
  await assert.rejects(control.command(entry, STANDARD.MODE, 1), /disk full/);
  await assert.rejects(control.command(entry, STANDARD.TARGET, 21), /disk full/);
  assert.equal(client.calls.length, 0);
});

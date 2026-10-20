import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createIntegration } from '../index.js';
import { describeDevice } from '../src/devices/index.js';
import { STANDARD } from '../src/devices/standard.js';
import { axencoThermostat, fakeAxencoClient } from './helpers/fakes.js';

async function runtime(t, { created = true, legacyTarget = false, state = {} } = {}) {
  const gladys = createFakeGladys({ config: { email: 'fake@example.invalid', password: 'fake' } });
  const raw = axencoThermostat({
    state: { currentTemp: 19, overrideTemp: 20, targetMode: 8, ...state },
  });
  const description = describeDevice(gladys, raw);
  if (legacyTarget) {
    const target = description.gladysDevice.features.find(
      (feature) => feature.external_id === description.ids.feature(STANDARD.TARGET),
    );
    description.gladysDevice.features.push({
      ...target,
      name: 'Consigne thermostat Gladys',
      external_id: description.ids.feature(STANDARD.LEGACY_TARGET),
      selector: `${target.selector}-compatibility`,
    });
  }
  if (created) gladys.fake.devices = [description.gladysDevice];
  const listeners = new Map();
  const client = Object.assign(fakeAxencoClient(), {
    down: false,
    push: true,
    login: async () => {},
    connectWebSocket() {},
    disconnectWebSocket() {},
    ensureWebSocket() {},
    isWebSocketConnected() {
      return this.push;
    },
    async getDevices() {
      if (this.down) throw new Error('cloud unavailable');
      return [raw];
    },
    async getDeviceState() {
      return { state: { ...raw.state } };
    },
    registerAuthFailureCallback() {},
    registerDiscoveryCallback() {},
    registerRemovalCallback() {},
    registerConnectionCallback() {},
    clearListeners() {
      listeners.clear();
    },
    registerListener(id, callback) {
      listeners.set(id, callback);
      return () => listeners.delete(id);
    },
  });
  const saved = new Map();
  const app = await createIntegration({
    gladys,
    axenco: client,
    handleShutdown: false,
    store: { get: (id) => saved.get(id), set: async (id, value) => saved.set(id, { ...value }) },
  });
  t.after(() => app.stop());
  await app.start();
  return { app, gladys, raw, client, listeners, description };
}

test('runtime discovers devices without publishing uncreated states, then seeds creation and updates', async (t) => {
  const { gladys, description } = await runtime(t, { created: false });
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.states.length, 0);
  await gladys.fake.deviceCreated(description.gladysDevice);
  assert.equal(gladys.fake.lastState(description.ids.feature('current-temperature')), 19);
  const before = gladys.fake.states.length;
  await gladys.fake.deviceUpdated(description.gladysDevice);
  assert.ok(gladys.fake.states.length > before, 'updated features are seeded even when unchanged');
});

test('runtime distinguishes push degradation from cloud failure and recovers', async (t) => {
  const { app, gladys, client } = await runtime(t);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  client.push = false;
  await app.refresh();
  assert.equal(gladys.fake.transports.at(-1).transport, 'cloud');
  assert.equal(gladys.fake.transports.at(-1).degraded, true);
  client.down = true;
  await assert.rejects(app.refresh(), /cloud unavailable/);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
  client.down = false;
  client.push = true;
  await app.refresh();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.notEqual(gladys.fake.transports.at(-1).degraded, true);
  assert.equal(gladys.fake.transports.at(-1).message, undefined);
});

test('native commands through the real SDK callbacks keep stop effective', async (t) => {
  const { gladys, client, description } = await runtime(t);
  const device = description.gladysDevice;
  const mode = device.features.find(
    (f) => f.external_id === description.ids.feature(STANDARD.MODE),
  );
  const target = device.features.find(
    (f) => f.external_id === description.ids.feature(STANDARD.TARGET),
  );
  assert.equal((await gladys.fake.setValue(device, mode, 0)).success, true);
  assert.equal((await gladys.fake.setValue(device, target, 7)).success, true);
  assert.deepEqual(
    client.calls.map((c) => c.name),
    ['setDeviceMode'],
  );
  assert.equal(gladys.fake.lastState(target.external_id), 7);
});

test('runtime publishes confirmed native targets and rejects unsupported scene modes', async (t) => {
  const { gladys, listeners, raw, client, description } = await runtime(t);
  const target = description.gladysDevice.features.find(
    (f) => f.external_id === description.ids.feature(STANDARD.TARGET),
  );
  assert.equal((await gladys.fake.setValue(description.gladysDevice, target, 21)).success, true);
  assert.equal(gladys.fake.lastState(target.external_id), 20);
  const listener = listeners.get(raw._id);
  listener({ currentTemp: 19.5, overrideTemp: 20 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gladys.fake.lastState(target.external_id), 20);
  listener({ overrideTemp: 21, targetMode: 8 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gladys.fake.lastState(target.external_id), 21);
  const before = client.calls.length;
  const ack = await gladys.fake.sceneAction('choose_mode', {
    device: description.ids.device,
    mode: 'off',
  });
  assert.equal(ack.success, false);
  assert.equal(client.calls.length, before);
});

test('deleting a device cancels a delayed native resume', async (t) => {
  const { app, gladys, client, description } = await runtime(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await app.command(description.ids.device, STANDARD.MODE, 1);
  await gladys.fake.deviceDeleted(description.gladysDevice);
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.calls.length, 0);
});

test('stale queued commands emit a failure event without reaching Axenco', async (t) => {
  const { app, gladys, client, description } = await runtime(t);
  t.mock.timers.enable({ apis: ['Date'] });
  let release;
  client.setDeviceMode = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const first = app.command(description.ids.device, 'axenco-mode', 'comfort');
  await new Promise((resolve) => setImmediate(resolve));
  const queued = app.command(description.ids.device, 'axenco-mode', 'eco');
  const rejected = assert.rejects(queued, /expired/);
  t.mock.timers.tick(1001);
  release();
  await first;
  await rejected;
  assert.equal(gladys.fake.sceneEvents.at(-1).key, 'command_failed');
  assert.match(gladys.fake.sceneEvents.at(-1).data.reason, /expired/);
});

test('stopping the integration prevents pending commands from being sent', async (t) => {
  const { app, client, description } = await runtime(t);
  let release;
  let sent = 0;
  client.setDeviceMode = () => {
    sent += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const first = app.command(description.ids.device, 'axenco-mode', 'comfort');
  await new Promise((resolve) => setImmediate(resolve));
  const queued = app.command(description.ids.device, 'axenco-mode', 'eco');
  const rejected = assert.rejects(queued, /stopping/);
  await app.stop();
  release();
  await first;
  await rejected;
  assert.equal(sent, 1);
});

test('SDK text selector controls the heater without creating a Gladys thermostat and follows push states', async (t) => {
  const { gladys, description, client, listeners, raw } = await runtime(t);
  const select = description.gladysDevice.features.find(
    (f) => f.external_id === description.ids.feature('axenco-mode'),
  );
  assert.ok(select);
  assert.equal(
    description.gladysDevice.features.some((f) => f.external_id.includes(':preset:')),
    false,
  );
  assert.equal(gladys.fake.lastState(select.external_id), 'setpoint');
  assert.equal((await gladys.fake.setValue(description.gladysDevice, select, 'eco')).success, true);
  assert.deepEqual(client.calls[0], { name: 'setDeviceMode', args: [raw._id, 2] });
  assert.equal(gladys.fake.lastState(select.external_id), 'eco');
  listeners.get(raw._id)({ targetMode: 61 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gladys.fake.lastState(select.external_id), 'auto');
  listeners.get(raw._id)({ targetMode: 42 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gladys.fake.lastState(select.external_id), 'unknown:42');
  const count = client.calls.length;
  assert.equal(
    (await gladys.fake.setValue(description.gladysDevice, select, 'comfort_plus')).success,
    false,
  );
  assert.equal(client.calls.length, count);
});

test('scenes on an existing device work before and after accepting the new selector', async (t) => {
  const { app, gladys, client, description } = await runtime(t);
  const device = description.gladysDevice;
  device.features = device.features.filter(
    (f) => f.external_id !== description.ids.feature('axenco-mode'),
  );
  device.features.push({
    name: 'Éco',
    external_id: description.ids.feature('preset:eco'),
    category: 'switch',
    type: 'binary',
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  });
  gladys.fake.devices = [device];
  await gladys.fake.deviceUpdated(device);
  await app.refresh();
  assert.equal(
    (await gladys.fake.sceneAction('choose_mode', { device: description.ids.device, mode: 'eco' }))
      .success,
    true,
  );
  const updated = gladys.fake.discoveredDevices.at(-1);
  assert.ok(updated.features.some((f) => f.external_id === description.ids.feature('preset:eco')));
  assert.ok(updated.features.some((f) => f.external_id === description.ids.feature('axenco-mode')));
  await gladys.fake.deviceUpdated(updated);
  assert.equal(
    (
      await gladys.fake.sceneAction('choose_mode', {
        device: description.ids.device,
        mode: 'comfort',
      })
    ).success,
    true,
  );
  const legacy = updated.features.find(
    (f) => f.external_id === description.ids.feature('preset:eco'),
  );
  assert.equal((await gladys.fake.setValue(updated, legacy, 1)).success, true);
  assert.deepEqual(
    client.calls.map((c) => c.args[1]),
    [2, 1, 2],
  );
});

test('discovery exposes one shared EV30 target and preserves its historical id', async (t) => {
  const { gladys, description } = await runtime(t);
  const features = gladys.fake.discoveredDevices[0].features;
  const targets = features.filter(
    (f) => f.category === 'thermostat' && f.type === 'target-temperature',
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0].external_id, description.ids.feature('target-temperature'));
  assert.equal(targets[0].name, 'Température de consigne');
  assert.equal(
    features.find((f) => f.external_id === description.ids.feature(STANDARD.MODE)).name,
    'Mode du radiateur',
  );
});

test('shared target publishes the actual Comfort and Auto setpoints without raw override duplicates', async (t) => {
  const { gladys, listeners, raw, description } = await runtime(t, {
    state: { targetMode: 1, comfTemp: 21, overrideTemp: 18, ecoTemp: 17 },
  });
  const targetId = description.ids.feature(STANDARD.TARGET);
  assert.equal(gladys.fake.lastState(targetId), 21);
  const before = gladys.fake.states.length;
  listeners.get(raw._id)({ targetMode: 61, overrideTemp: 18 });
  await new Promise((resolve) => setImmediate(resolve));
  const targets = gladys.fake.states
    .slice(before)
    .filter((s) => s.device_feature_external_id === targetId);
  assert.deepEqual(
    targets.map((s) => s.state),
    [17],
  );
});

test('direct Axenco mode releases a stop and cannot leave shared targets parked', async (t) => {
  const { app, client, description } = await runtime(t);
  const id = description.ids.device;
  await app.command(id, STANDARD.MODE, 0);
  await app.command(id, STANDARD.TARGET, 7);
  await app.command(id, 'axenco-mode', 'comfort');
  await app.command(id, STANDARD.TARGET, 21);
  assert.deepEqual(client.calls, [
    { name: 'setDeviceMode', args: [description.axencoId, 4] },
    { name: 'setDeviceMode', args: [description.axencoId, 1] },
    { name: 'setDeviceTemperature', args: [description.axencoId, 21] },
  ]);
});

test('direct standby protects shared writes and the explicit override action can resume', async (t) => {
  const { app, gladys, client, description } = await runtime(t);
  await app.command(description.ids.device, 'axenco-mode', 'standby');
  await app.command(description.ids.device, STANDARD.TARGET, 7);
  assert.deepEqual(
    client.calls.map((c) => c.name),
    ['setDeviceMode'],
  );
  const rejected = await gladys.fake.sceneAction('set_temperature', {
    device: description.ids.device,
    temperature: 100,
  });
  assert.equal(rejected.success, false);
  assert.equal(client.calls.length, 1, 'an invalid override never resumes');
  const accepted = await gladys.fake.sceneAction('set_temperature', {
    device: description.ids.device,
    temperature: 21,
  });
  assert.equal(accepted.success, true);
  assert.deepEqual(client.calls.at(-1), {
    name: 'setDeviceTemperature',
    args: [description.axencoId, 21],
  });
  assert.equal(client.calls.length, 2, 'resume and target use one captured Axenco payload');
});

test('selecting the current override resumes standby through the shared controller', async (t) => {
  const { app, client, description } = await runtime(t, { state: { targetMode: 4 } });
  await app.command(description.ids.device, 'axenco-mode', 'setpoint');
  assert.deepEqual(client.calls, [
    { name: 'setDeviceTemperature', args: [description.axencoId, 20] },
  ]);
  await app.command(description.ids.device, STANDARD.TARGET, 21);
  assert.equal(client.calls.length, 2);
});

test('existing duplicate targets survive device updates as synchronized compatibility aliases', async (t) => {
  const { app, gladys, description, client, listeners, raw } = await runtime(t, {
    legacyTarget: true,
  });
  const targetId = description.ids.feature(STANDARD.TARGET);
  const aliasId = description.ids.feature(STANDARD.LEGACY_TARGET);
  assert.equal(gladys.fake.lastState(aliasId), 20);
  const discovered = gladys.fake.discoveredDevices[0];
  assert.equal(
    discovered.features.find((f) => f.external_id === aliasId).name,
    'Consigne (compatibilité)',
  );
  await gladys.fake.deviceUpdated(discovered);
  assert.equal(gladys.fake.lastState(aliasId), 20);
  await app.command(description.ids.device, STANDARD.MODE, 0);
  await app.command(description.ids.device, STANDARD.LEGACY_TARGET, 7);
  assert.equal(gladys.fake.lastState(targetId), 7);
  assert.equal(gladys.fake.lastState(aliasId), 7);
  assert.equal(client.calls.length, 1);
  await app.command(description.ids.device, STANDARD.MODE, 1);
  await app.command(description.ids.device, STANDARD.LEGACY_TARGET, 21);
  listeners.get(raw._id)({ targetMode: 8, overrideTemp: 21 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gladys.fake.lastState(targetId), 21);
  assert.equal(gladys.fake.lastState(aliasId), 21);
  assert.equal(client.calls.length, 2);
  const updated = {
    ...discovered,
    features: discovered.features.filter((f) => f.external_id !== aliasId),
  };
  const before = gladys.fake.states.length;
  await gladys.fake.deviceUpdated(updated);
  assert.ok(
    !gladys.fake.states.slice(before).some((s) => s.device_feature_external_id === aliasId),
  );
  await assert.rejects(
    app.command(description.ids.device, STANDARD.LEGACY_TARGET, 20),
    /Feature unavailable/,
  );
  await app.refresh();
  assert.ok(
    !gladys.fake.discoveredDevices[0].features.some((f) => f.external_id === aliasId),
    'a removed alias is not recreated',
  );
});

test('an Axenco mode supersedes a resume that became queued while its HTTP call was in flight', async (t) => {
  const { app, client, description } = await runtime(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  client.setDeviceMode = async (...args) => {
    client.calls.push({ name: 'setDeviceMode', args });
    await new Promise((resolve) => {
      release = resolve;
    });
  };
  await app.command(description.ids.device, STANDARD.MODE, 1);
  const manufacturerMode = app.command(description.ids.device, 'axenco-mode', 'eco');
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(500);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await manufacturerMode;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.calls, [{ name: 'setDeviceMode', args: [description.axencoId, 2] }]);
});

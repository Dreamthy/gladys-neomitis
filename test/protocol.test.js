import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@gladysassistant/integration-sdk';
import { AxencoClient } from '../src/axenco/client.js';

const response = (status, data = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(data),
  json: async () => data,
});
const client = () => new AxencoClient({ logger: createLogger({ level: 'silent' }) });

test('gateway target uses the two documented payloads and one shared timeout budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const timeouts = [];
  const sent = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) });
    t.mock.timers.tick(2000);
    return response(200);
  });
  await client().setSubDeviceTarget({ gateway: 'gateway-1' }, 'rfid-1', 20.5);
  assert.deepEqual(timeouts, [3500, 1500]);
  assert.deepEqual(sent, [
    {
      url: 'https://user-ep.imhotepcreation.com/v1/devices/gateway-1/sub-devices/state',
      body: { parameters: { 'rfid-1': { targetMode: 8 } } },
    },
    {
      url: 'https://user-ep.imhotepcreation.com/v1/devices/gateway-1/sub-devices/state',
      body: { parameters: { 'rfid-1': { targetTemp: 20.5 } } },
    },
  ]);
});

test('an exhausted gateway mode budget cannot send a late target', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    t.mock.timers.tick(3501);
    return response(200);
  });
  await assert.rejects(client().setSubDeviceTarget(',gateway-1,', 'rfid-1', 21), /timed out/);
  assert.equal(requests, 1);
});

test('EV30 writes retain the captured temperature and standby payloads', async (t) => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push({ url, ...options, body: JSON.parse(options.body) });
    return response(200);
  });
  const api = client();
  await api.setDeviceTemperature('ev30', 20.5);
  await api.setDeviceMode('ev30', 4);
  assert.deepEqual(
    sent.map((request) => request.body),
    [
      { parameters: { targetTemp: 20.5, overrideTemp: 20.5, targetMode: 8 } },
      { parameters: { targetMode: 4 } },
    ],
  );
});

test('401 refresh and replay share one command budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests++;
    if (requests === 1) {
      t.mock.timers.tick(2000);
      return response(401);
    }
    if (url.endsWith('/auth/token')) {
      t.mock.timers.tick(1000);
      return response(200, { token: 'renewed' });
    }
    return response(200);
  });
  const api = client();
  api.refreshToken = 'fake';
  await api.setDeviceMode('ev30', 4);
  assert.deepEqual(timeouts, [3500, 1500, 500]);
  assert.equal(requests, 3);
});

test('an exhausted write budget never replays a stale command', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    t.mock.timers.tick(4000);
    return response(401);
  });
  const api = client();
  api.refreshToken = 'fake';
  await assert.rejects(api.setDeviceMode('ev30', 1), /timed out/);
  assert.equal(requests, 1);
});

test('changing Axenco accounts replaces the user id and invalidates its device cache', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    response(200, {
      token: 'fake-token',
      refresh_token: 'fake-refresh',
      id: 'new-account',
    }),
  );
  const api = client();
  api.userId = 'old-account';
  api.devicesCache = [{ _id: 'old' }];
  api.lastFetch = 100;
  await api.login('fake@example.invalid', 'fake');
  assert.equal(api.userId, 'new-account');
  assert.deepEqual(api.devicesCache, []);
  assert.equal(api.lastFetch, 0);
});

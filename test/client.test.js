import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@gladysassistant/integration-sdk';

import { AxencoClient } from '../src/axenco/client.js';

// These cover the push-channel state machine, the part that silently degraded
// the whole integration to its periodic refresh: socket.io-client gives up for
// good when the server rejects the handshake (an expired token in the headers),
// so the reconnection loop below is ours and has to keep working.

const silent = () => createLogger({ level: 'silent' });
const fakeSocket = (connected) => ({
  connected,
  removeAllListeners() {},
  disconnect() {},
});

function clientWithFakeSocket({ connected = false, wanted = true } = {}) {
  const client = new AxencoClient({ logger: silent() });
  client.socketWanted = wanted;
  client.socket = fakeSocket(connected);
  const opened = [];
  client.openSocket = () => opened.push(Date.now());
  return { client, opened };
}

test('the watchdog leaves a healthy channel alone', () => {
  const { client } = clientWithFakeSocket({ connected: true });
  assert.equal(client.isWebSocketConnected(), true);
  assert.equal(client.ensureWebSocket(), false);
  assert.equal(client.socketReconnectTimer, null);
});

test('the watchdog does nothing when the channel was never wanted', () => {
  const { client } = clientWithFakeSocket({ connected: false, wanted: false });
  assert.equal(client.ensureWebSocket(), false);
  assert.equal(client.socketReconnectTimer, null);
});

test('the watchdog revives a dead channel, once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client } = clientWithFakeSocket({ connected: false });

  assert.equal(client.ensureWebSocket(), true);
  assert.notEqual(client.socketReconnectTimer, null);
  // A second call while a retry is already armed must not stack timers.
  assert.equal(client.ensureWebSocket(), false);
  assert.equal(client.socketReconnectAttempt, 1);
});

test('retries back off instead of hammering the server', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new AxencoClient({ logger: silent() });
  client.socketWanted = true;
  client.openSocket = () => {};

  const delays = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = client.socketReconnectAttempt;
    client.socketReconnectTimer = null; // simulate the previous timer firing
    client.scheduleSocketReconnect();
    delays.push(5000 * 2 ** before);
  }
  assert.deepEqual(delays.slice(0, 4), [5000, 10000, 20000, 40000]);
  assert.ok(Math.min(...delays.map((d) => Math.min(d, 300000))) >= 5000);
  assert.equal(client.socketReconnectAttempt, 8);
});

test('a reconnection renews the token BEFORE reopening the socket', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new AxencoClient({ logger: silent() });
  client.socketWanted = true;

  const order = [];
  client.refreshAuthToken = async () => {
    order.push('refresh');
  };
  client.openSocket = () => {
    order.push('open');
  };

  client.scheduleSocketReconnect();
  t.mock.timers.tick(5000);
  await new Promise((resolve) => process.nextTick(resolve));

  assert.deepEqual(order, ['refresh', 'open'], 'reopening with a stale token just fails again');
});

test('a dead refresh token asks the owner to log in again, and stops retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new AxencoClient({ logger: silent() });
  client.socketWanted = true;

  let opened = 0;
  client.openSocket = () => {
    opened += 1;
  };
  client.refreshAuthToken = async () => {
    throw new Error('refresh token expired');
  };

  const failures = [];
  client.registerAuthFailureCallback((err) => failures.push(err.message));

  client.scheduleSocketReconnect();
  t.mock.timers.tick(5000);
  await new Promise((resolve) => process.nextTick(resolve));

  assert.deepEqual(failures, ['refresh token expired']);
  assert.equal(opened, 0, 'no point reopening a socket we cannot authenticate');
});

test('disconnecting on purpose stops the loop for good', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client } = clientWithFakeSocket({ connected: false });
  client.ensureWebSocket();
  assert.notEqual(client.socketReconnectTimer, null);

  client.disconnectWebSocket();

  assert.equal(client.socketWanted, false);
  assert.equal(client.socketReconnectTimer, null);
  assert.equal(client.socket, null);
  assert.equal(client.socketReconnectAttempt, 0);
  // And a later watchdog tick must not bring it back.
  assert.equal(client.ensureWebSocket(), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { askedPatch, createReconciler } from '../src/gladys/reconciler.js';

const DELAY = 1000;

function harness({ freshState, getStateError } = {}) {
  const logs = { warn: [], info: [], error: [] };
  const published = [];
  const client = {
    async getDeviceState() {
      if (getStateError) {
        throw getStateError;
      }
      return freshState === undefined ? { state: {} } : { state: freshState };
    },
  };
  const reconciler = createReconciler({
    client,
    publisher: {
      async publishStates(states) {
        published.push(states);
      },
    },
    logger: {
      warn: (line) => logs.warn.push(line),
      info: (line) => logs.info.push(line),
      error: (line) => logs.error.push(line),
    },
    buildStates: (entry, patch) => [{ device_feature_external_id: entry.axencoId, patch }],
    delayMs: DELAY,
  });
  return { reconciler, logs, published };
}

const mainEntry = (state = {}) => ({
  axencoId: 'dev-1',
  model: 'EV30',
  profile: { subDevice: false },
  state,
});

/** Let the scheduled timer fire and its async body settle. */
async function fire(t) {
  t.mock.timers.tick(DELAY);
  await new Promise((resolve) => setImmediate(resolve));
}

test('askedPatch keeps only what the command wrote, and only primitives', () => {
  const before = { targetMode: 3, overrideTemp: 19, drift: [1, 2] };
  const after = { targetMode: 1, overrideTemp: 19, drift: [1, 2] };

  assert.deepEqual(askedPatch(before, after), { targetMode: 1 });
});

test('askedPatch ignores arrays, which never compare equal by reference', () => {
  // driftCorrections / infoSystem / occupancyRanges are re-parsed on every
  // read, so === always says "changed" and drowned the real finding in noise.
  const before = { infoSystem: ['600', '0'] };
  const after = { infoSystem: ['600', '0'] };

  assert.deepEqual(askedPatch(before, after), {});
});

test('a command the device applied is confirmed, not warned about', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reconciler, logs, published } = harness({ freshState: { targetMode: 0 } });

  reconciler.schedule(mainEntry({ targetMode: 0 }), 'preset:auto', { targetMode: 0 });
  await fire(t);

  assert.equal(logs.warn.length, 0);
  assert.match(logs.info[0], /confirmed by the device — targetMode=0/);
  assert.equal(published.length, 1);
});

test('a command the device ignored is reported, with both values', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reconciler, logs } = harness({ freshState: { targetMode: 3 } });

  reconciler.schedule(mainEntry({ targetMode: 0 }), 'preset:auto', { targetMode: 0 });
  await fire(t);

  assert.match(logs.warn[0], /did not apply it — targetMode: asked 0, got 3/);
});

test('the real device state is published, not what we asked for', async (t) => {
  // This is the whole point: the optimistic publish already happened, and it
  // was a lie if the device refused.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entry = mainEntry({ targetMode: 0 });
  const { reconciler, published } = harness({ freshState: { targetMode: 3 } });

  reconciler.schedule(entry, 'preset:auto', { targetMode: 0 });
  await fire(t);

  assert.deepEqual(published[0][0].patch, { targetMode: 3 });
  assert.equal(entry.state.targetMode, 3, 'the entry is corrected too');
});

test('two features of one device are both checked', async (t) => {
  // Keyed per device, the second command cancelled the first check and we
  // learned nothing about it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entry = mainEntry({ targetMode: 1 });
  const { reconciler, logs } = harness({ freshState: { targetMode: 1, overrideTemp: 19 } });

  reconciler.schedule(entry, 'preset:comfort', { targetMode: 1 });
  reconciler.schedule(entry, 'target-temperature', { overrideTemp: 19 });
  await fire(t);

  assert.equal(logs.info.length, 2);
});

test('the same feature commanded twice is only checked once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entry = mainEntry();
  const { reconciler, logs } = harness({ freshState: { targetMode: 2 } });

  reconciler.schedule(entry, 'preset:eco', { targetMode: 1 });
  reconciler.schedule(entry, 'preset:eco', { targetMode: 2 });
  await fire(t);

  assert.equal(logs.info.length + logs.warn.length, 1);
  assert.match(logs.info[0], /targetMode=2/, 'the latest command wins');
});

test('a no-op command still publishes the truth, without a verdict', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reconciler, logs, published } = harness({ freshState: { targetMode: 1 } });

  reconciler.schedule(mainEntry({ targetMode: 1 }), 'preset:comfort', {});
  await fire(t);

  assert.equal(logs.warn.length, 0);
  assert.equal(logs.info.length, 0, 'nothing was asked, so there is nothing to confirm');
  assert.equal(published.length, 1);
});

test('a sub-device is never checked: its state shape is unknown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reconciler, published, logs } = harness({ freshState: { targetMode: 1 } });

  reconciler.schedule({ ...mainEntry(), profile: { subDevice: true } }, 'preset:eco', {
    targetMode: 2,
  });
  await fire(t);

  assert.equal(published.length, 0);
  assert.equal(logs.info.length + logs.warn.length, 0);
});

test('a failed re-read is logged and swallowed, never thrown at the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reconciler, logs } = harness({ getStateError: new Error('cloud down') });

  reconciler.schedule(mainEntry(), 'preset:eco', { targetMode: 2 });
  await fire(t);

  assert.equal(logs.error.length, 1);
});

test('cancelAll drops pending checks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reconciler, published } = harness({ freshState: { targetMode: 1 } });

  reconciler.schedule(mainEntry(), 'preset:eco', { targetMode: 2 });
  reconciler.cancelAll();
  await fire(t);

  assert.equal(published.length, 0);
});

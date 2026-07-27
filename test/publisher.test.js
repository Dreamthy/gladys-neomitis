import test from 'node:test';
import assert from 'node:assert/strict';

import { createPublisher } from '../src/gladys/publisher.js';

/** An SDK double recording every batch it was handed. */
function fakeGladys() {
  const stateBatches = [];
  const transportBatches = [];
  return {
    stateBatches,
    transportBatches,
    async publishStates(batch) {
      stateBatches.push(batch);
    },
    async publishTransports(batch) {
      transportBatches.push(batch);
    },
  };
}

const state = (id, value) => ({ device_feature_external_id: id, state: value });
const text = (id, value) => ({ device_feature_external_id: id, text: value });

test('an unchanged value is not published twice', async () => {
  const gladys = fakeGladys();
  const publisher = createPublisher(gladys);

  await publisher.publishStates([state('a', 21), state('b', 0)]);
  await publisher.publishStates([state('a', 21), state('b', 0)]);

  assert.equal(gladys.stateBatches.length, 1, 'the second call had nothing new to send');
});

test('only the values that moved are published', async () => {
  const gladys = fakeGladys();
  const publisher = createPublisher(gladys);

  await publisher.publishStates([state('a', 21), state('b', 0)]);
  await publisher.publishStates([state('a', 21), state('b', 1)]);

  assert.deepEqual(gladys.stateBatches[1], [state('b', 1)]);
});

test('text states are deduplicated on their own key', async () => {
  // A numeric state and a text state store their value under different keys;
  // reading the wrong one would make every text look unchanged.
  const gladys = fakeGladys();
  const publisher = createPublisher(gladys);

  await publisher.publishStates([text('mode', 'Auto')]);
  await publisher.publishStates([text('mode', 'Auto')]);
  await publisher.publishStates([text('mode', 'Confort')]);

  assert.equal(gladys.stateBatches.length, 2);
  assert.deepEqual(gladys.stateBatches[1], [text('mode', 'Confort')]);
});

test('force republishes a value the device never actually changed', async () => {
  // Turning a preset switch off is a no-op on the Axenco side, so the same
  // value has to be republished to snap the switch back.
  const gladys = fakeGladys();
  const publisher = createPublisher(gladys);

  await publisher.publishStates([state('preset', 1)]);
  await publisher.publishStates([state('preset', 1)], { force: true });

  assert.equal(gladys.stateBatches.length, 2);
});

test('batches are chunked to 100 states', async () => {
  const gladys = fakeGladys();
  const publisher = createPublisher(gladys);
  const many = Array.from({ length: 250 }, (_, index) => state(`f${index}`, index));

  await publisher.publishStates(many);

  assert.deepEqual(
    gladys.stateBatches.map((batch) => batch.length),
    [100, 100, 50],
  );
});

test('a failed batch is not remembered as published', async () => {
  // Otherwise the value would be skipped for ever and the feature would stay
  // stale until it happened to change again.
  const gladys = fakeGladys();
  let fail = true;
  gladys.publishStates = async (batch) => {
    if (fail) {
      throw new Error('host API down');
    }
    gladys.stateBatches.push(batch);
  };
  const publisher = createPublisher(gladys);

  await assert.rejects(() => publisher.publishStates([state('a', 21)]));
  fail = false;
  await publisher.publishStates([state('a', 21)]);

  assert.deepEqual(gladys.stateBatches, [[state('a', 21)]]);
});

test('the transport badge reflects reachability, and is chunked too', async () => {
  const gladys = fakeGladys();
  const publisher = createPublisher(gladys);
  const entry = (id, connected) => ({ ids: { device: id }, connected });

  await publisher.publishTransports([entry('a', true), entry('b', false)]);

  assert.deepEqual(gladys.transportBatches[0], [
    { external_id: 'a', transport: 'cloud' },
    { external_id: 'b', transport: 'unreachable' },
  ]);

  const many = Array.from({ length: 150 }, (_, index) => entry(`d${index}`, true));
  await publisher.publishTransports(many);
  assert.deepEqual(
    gladys.transportBatches.slice(1).map((batch) => batch.length),
    [100, 50],
  );
});

test('publishing nothing sends nothing', async () => {
  const gladys = fakeGladys();
  const publisher = createPublisher(gladys);

  await publisher.publishStates([]);
  await publisher.publishTransports([]);

  assert.equal(gladys.stateBatches.length, 0);
  assert.equal(gladys.transportBatches.length, 0);
});

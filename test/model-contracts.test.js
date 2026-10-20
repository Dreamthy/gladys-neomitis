import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@gladysassistant/integration-sdk';
import { AxencoClient } from '../src/axenco/client.js';
import { buildStates, describeDevice, handleSetValue, FEATURE } from '../src/devices/index.js';
import { STANDARD } from '../src/devices/standard.js';
import { axencoThermostat, axencoSubDevice, fakeGladys } from './helpers/fakes.js';

// Pin the integration's existing behavior for every supported profile.
// HTTP and device readbacks are simulated: passing these tests does not
// validate the protocol on hardware or establish pyaxencoapi as authoritative.
const profiles = [
  {
    model: 'EV30',
    temperature: 'captured',
    modes: { boost: 6, eco: 2, comfort: 1, auto: 0, antifrost: 3, standby: 4 },
  },
  ...['ECTRL', 'ESTAT', 'RSS-ECTRL'].map((model) => ({
    model,
    temperature: 'captured',
    modes: { boost: 6, eco: 2, comfort: 1, comfort_plus: 20, auto: 0, antifrost: 3, standby: 4 },
  })),
  {
    model: 'NTD',
    sub: true,
    temperature: 'gateway',
    modes: { eco: 2, comfort: 1, auto: 0, antifrost: 3, standby: 4 },
  },
  {
    model: 'ETRV',
    sub: true,
    temperature: 'gateway',
    modes: { eco: 2, comfort: 1, antifrost: 3, standby: 4 },
  },
  { model: 'EWS', deviceType: 0, modes: { on: 1, off: 2, auto: 0 } },
  {
    model: 'EWS',
    deviceType: 1,
    modes: {
      boost: 6,
      eco: 2,
      eco_1: 40,
      eco_2: 41,
      comfort: 1,
      auto: 0,
      antifrost: 3,
      standby: 4,
    },
  },
  {
    model: 'EWS',
    deviceType: 7,
    modes: {
      boost: 6,
      eco: 2,
      eco_1: 40,
      eco_2: 41,
      comfort: 1,
      comfort_plus: 20,
      auto: 0,
      antifrost: 3,
      standby: 4,
    },
  },
  { model: 'UFH', sub: true, ufh: true, modes: { heating: 0, cooling: 1 } },
];
const rawFor = (profile) =>
  (profile.sub ? axencoSubDevice : axencoThermostat)({
    model: profile.model,
    state: {
      currentTemp: 19,
      overrideTemp: 20,
      targetTemp: 20,
      targetMode: 1,
      changeOverUser: 0,
      comfLimitMin: 7,
      comfLimitMax: 30,
      comfTemp: 21,
      ecoTemp: 18,
      antifTemp: 7,
      ...(profile.deviceType === undefined ? {} : { deviceType: profile.deviceType }),
    },
  });
function capture(t) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => '{}' };
  });
  return { requests, client: new AxencoClient({ logger: createLogger({ level: 'silent' }) }) };
}
const stateFor = (states, entry, key) =>
  states.find((s) => s.device_feature_external_id === entry.ids.feature(key));

for (const profile of profiles) {
  const label = `${profile.model}${profile.deviceType === undefined ? '' : ` deviceType=${profile.deviceType}`}`;
  test(`${label}: discovery, serialized commands and simulated readback agree`, async (t) => {
    const raw = rawFor(profile);
    const entry = describeDevice(fakeGladys, raw);
    const { client, requests } = capture(t);
    const selector = entry.gladysDevice.features.find(
      (f) => f.external_id === entry.ids.feature(FEATURE.MODE_SELECT),
    );
    if (profile.ufh) assert.equal(selector, undefined);
    else {
      const expected = Object.keys(profile.modes)
        .concat(profile.temperature ? ['setpoint'] : [])
        .sort();
      assert.deepEqual(selector.supported_options.map((o) => o.value).sort(), expected);
    }
    for (const [mode, code] of Object.entries(profile.modes)) {
      await handleSetValue(
        client,
        entry,
        profile.ufh ? FEATURE.COOLING : FEATURE.MODE_SELECT,
        profile.ufh ? code : mode,
      );
      const field = profile.ufh ? 'changeOverUser' : 'targetMode';
      const expectedParameters = profile.sub ? { A1B2: { [field]: code } } : { [field]: code };
      assert.deepEqual(requests.at(-1), {
        url: profile.sub
          ? 'https://user-ep.imhotepcreation.com/v1/devices/65f0000000000000000000ff/sub-devices/state'
          : `https://user-ep.imhotepcreation.com/v1/devices/${raw._id}/state`,
        method: 'PATCH',
        body: { parameters: expectedParameters },
      });
      const states = buildStates(entry, { [field]: code });
      if (profile.ufh) assert.equal(stateFor(states, entry, FEATURE.COOLING).state, code);
      else assert.equal(stateFor(states, entry, FEATURE.MODE_SELECT).text, mode);
    }
    if (profile.modes.auto !== undefined) {
      for (const reported of [0, 60, 61])
        assert.equal(
          stateFor(buildStates(entry, { targetMode: reported }), entry, FEATURE.MODE_SELECT).text,
          'auto',
        );
    }
    assert.equal(requests.length, Object.keys(profile.modes).length);
  });

  test(`${label}: temperature capabilities and payload are model-specific`, async (t) => {
    const entry = describeDevice(fakeGladys, rawFor(profile));
    const { client, requests } = capture(t);
    const target = entry.gladysDevice.features.find(
      (f) => f.external_id === entry.ids.feature(FEATURE.TARGET_TEMP),
    );
    assert.equal(Boolean(target), Boolean(profile.temperature));
    if (!profile.temperature) {
      await assert.rejects(
        handleSetValue(client, entry, FEATURE.TARGET_TEMP, 20.5),
        /not writable|cannot be written/,
      );
      assert.equal(requests.length, 0);
      return;
    }
    await handleSetValue(client, entry, FEATURE.TARGET_TEMP, 20.5);
    const parameters =
      profile.temperature === 'captured'
        ? { targetTemp: 20.5, overrideTemp: 20.5, targetMode: 8 }
        : { A1B2: { targetTemp: 20.5 } };
    assert.deepEqual(requests[0].body, { parameters });
    assert.equal(requests.length, 1);
    if (profile.sub)
      assert.ok(requests[0].url.endsWith('/65f0000000000000000000ff/sub-devices/state'));
    assert.equal(
      entry.gladysDevice.features.some((f) => f.external_id === entry.ids.feature(STANDARD.MODE)),
      profile.model === 'EV30',
    );
  });
}

test('all six standard pilot-wire orders round-trip through their explicit Axenco equivalents', async (t) => {
  const entry = describeDevice(
    fakeGladys,
    rawFor(profiles.find((p) => p.model === 'EWS' && p.deviceType === 1)),
  );
  const { client, requests } = capture(t);
  for (const [standard, code] of [
    [0, 4],
    [1, 3],
    [2, 2],
    [3, 40],
    [4, 41],
    [5, 1],
  ]) {
    await handleSetValue(client, entry, STANDARD.PILOT, standard);
    assert.deepEqual(requests.at(-1).body, { parameters: { targetMode: code } });
    assert.equal(
      stateFor(buildStates(entry, { targetMode: code }), entry, STANDARD.PILOT).state,
      standard,
    );
  }
  for (const targetMode of [0, 60, 61, 6, 42]) {
    assert.equal(
      stateFor(buildStates(entry, { targetMode }), entry, STANDARD.PILOT),
      undefined,
      'no fabricated six-order state for Auto, Boost or unknown codes',
    );
  }
});

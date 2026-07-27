import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS,
  PRESET_MODE_MODELS,
  presetKeyFromCode,
  presetKeysFor,
  presetModelKey,
} from '../src/axenco/const.js';
import { extractGatewayId, findChildren, getRfidById, parentTokens } from '../src/axenco/utils.js';

test('every model preset list only references known presets', () => {
  for (const [model, keys] of Object.entries(PRESET_MODE_MODELS)) {
    for (const key of keys) {
      assert.ok(PRESETS[key], `${model} references unknown preset "${key}"`);
    }
  }
});

test('an EWS is a relay or a fil pilote depending on deviceType', () => {
  assert.equal(presetModelKey({ model: 'EWS', state: { deviceType: 0 } }), 'EWS_RELAIS');
  assert.equal(presetModelKey({ model: 'EWS', state: { deviceType: 1 } }), 'EWS_PILOTE_TYPE_1');
  // No state at all: fall back to the fil pilote list rather than crash.
  assert.equal(presetModelKey({ model: 'EWS' }), 'EWS_PILOTE');
  assert.equal(presetModelKey({ model: 'EV30' }), 'EV30');
});

test('an unverified EWS deviceType keeps the upstream list, not our one sample', () => {
  // We only ever measured deviceType 1. Generalizing its six modes to
  // hardware nobody has seen would silently remove real modes; the upstream
  // ten-preset list stays the default.
  for (const deviceType of [2, 3, 7, undefined, null, 'weird']) {
    assert.equal(
      presetModelKey({ model: 'EWS', state: { deviceType } }),
      'EWS_PILOTE',
      `deviceType ${deviceType} must fall back to the reference list`,
    );
  }
  assert.equal(presetKeysFor({ model: 'EWS', state: { deviceType: 2 } }).length, 10);
  // deviceType 1 is measured: 7 real orders + auto (targetMode 0).
  assert.equal(presetKeysFor({ model: 'EWS', state: { deviceType: 1 } }).length, 8);
});

test('preset lists match the models of the reference library', () => {
  assert.deepEqual(presetKeysFor({ model: 'ETRV' }), [
    'setpoint',
    'eco',
    'comfort',
    'antifrost',
    'standby',
  ]);
  assert.deepEqual(presetKeysFor({ model: 'UFH' }), ['heating', 'cooling']);
  assert.deepEqual(presetKeysFor({ model: 'EWS', state: { deviceType: 0 } }), [
    'on',
    'off',
    'auto',
  ]);
  assert.deepEqual(presetKeysFor({ model: 'NOPE' }), []);
});

test('a mode code is decoded within the presets of its own model', () => {
  // 1 and 2 mean comfort/eco on a thermostat, but on/off on an EWS relay.
  assert.equal(presetKeyFromCode(presetKeysFor({ model: 'EV30' }), 1), 'comfort');
  assert.equal(presetKeyFromCode(presetKeysFor({ model: 'EV30' }), 2), 'eco');
  const relay = presetKeysFor({ model: 'EWS', state: { deviceType: 0 } });
  assert.equal(presetKeyFromCode(relay, 1), 'on');
  assert.equal(presetKeyFromCode(relay, 2), 'off');
});

test('Auto is written as 0 and read back as 0, 60 or 61', () => {
  // Captured from the official app: entering Auto sends {targetMode: 0}.
  // pyaxencoapi documents 60, which does nothing; hardware in Auto reports
  // 60/61 back, so all three must decode to Auto.
  assert.equal(PRESETS.auto.code, 0);
  const keys = presetKeysFor({ model: 'EV30' });
  for (const reported of [0, 60, 61]) {
    assert.equal(presetKeyFromCode(keys, reported), 'auto', `code ${reported}`);
  }
});

test('the mode codes match what the official app sends', () => {
  // Captured from the MyNeomitis app network traffic, per model. This is the
  // authority: pyaxencoapi is wrong on auto (says 60) and treats setpoint as a
  // selectable mode, which it is not.
  const expected = { auto: 0, comfort: 1, eco: 2, antifrost: 3, standby: 4, boost: 6 };
  for (const [key, code] of Object.entries(expected)) {
    assert.equal(PRESETS[key].code, code, `${key} must be ${code}`);
  }
  // EWS fil pilote adds the two kelvin steps, same capture.
  assert.equal(PRESETS.eco_1.code, 40);
  assert.equal(PRESETS.eco_2.code, 41);
  // A derogation is targetMode 8, sent together with the temperature.
  assert.equal(PRESETS.setpoint.code, 8);
});

test('an unmapped or non numeric code decodes to null', () => {
  const keys = presetKeysFor({ model: 'ETRV' });
  assert.equal(presetKeyFromCode(keys, 999), null);
  assert.equal(presetKeyFromCode(keys, undefined), null);
  assert.equal(presetKeyFromCode(keys, '1'), null);
  // A preset the model does not support is not decoded either.
  assert.equal(presetKeyFromCode(keys, PRESETS.boost.code), null);
});

test('parents is read both as a comma separated string and as an object', () => {
  assert.deepEqual(parentTokens(',gw-1, rf-2 ,'), ['gw-1', 'rf-2']);
  assert.deepEqual(parentTokens({ gateway: 'gw-1' }), ['gw-1']);
  // The gateway comes first whatever the key order of the object.
  assert.deepEqual(parentTokens({ other: 'rf-2', gateway: 'gw-1' }), ['gw-1', 'rf-2']);
  assert.deepEqual(parentTokens(undefined), []);
  assert.deepEqual(parentTokens(null), []);
  assert.deepEqual(parentTokens(''), []);
});

test('the gateway is the first entry of the parent chain', () => {
  assert.equal(extractGatewayId(',gw-1,rf-2,'), 'gw-1');
  assert.equal(extractGatewayId({ gateway: 'gw-1' }), 'gw-1');
  assert.equal(extractGatewayId(''), null);
  assert.equal(extractGatewayId(undefined), null);
});

test('children are found through their parent rfid, in both parents shapes', () => {
  const devices = [
    { _id: 'gw', rfid: 'A0A0' },
    { _id: 'child-string', parents: ',gw,A0A0,' },
    { _id: 'child-object', parents: { gateway: 'gw', parent: 'A0A0' } },
    { _id: 'unrelated', parents: ',gw,ZZZZ,' },
    { _id: 'no-parents' },
  ];
  assert.equal(getRfidById(devices, 'gw'), 'A0A0');
  assert.equal(getRfidById(devices, 'missing'), '');
  assert.deepEqual(findChildren(devices, 'A0A0'), ['child-string', 'child-object']);
  assert.deepEqual(findChildren(devices, ''), []);
});

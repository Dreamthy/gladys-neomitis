// -----------------------------------------------------------------------------
// Translation layer between an Axenco device and its Gladys counterpart.
//
//   describeDevice() : raw Axenco device  -> discovery payload + routing data
//   buildStates()    : Axenco state patch -> Gladys states to publish
//   handleSetValue() : Gladys command     -> Axenco write + states to publish
//
// Everything that knows about presets, gateways and state keys lives here;
// index.js stays generic wiring.
// -----------------------------------------------------------------------------

import {
  PRESETS,
  presetLabelFor,
  presetKeyFromCode,
  presetKeysFor,
  selectablePresetKeys,
} from '../axenco/const.js';
import { extractGatewayId } from '../axenco/utils.js';
import { selectorFromExternalId } from '../selector.js';
import { profileFor } from './profiles.js';
import {
  STANDARD,
  PILOT_PRESETS,
  pilotOrderFromCode,
  binary,
  validateTemperature,
} from './standard.js';
import {
  DEVICE_TYPE,
  FEATURE,
  SENSOR_FEATURES,
  SETPOINT_FEATURES,
  buildFeatures,
  presetFeatureKey,
  presetKeyFromFeature,
  setpointFeature,
} from './features.js';

export { isSupportedDevice, profileFor } from './profiles.js';
export { DEVICE_TYPE, FEATURE } from './features.js';

/**
 * @description Turn a raw Axenco device into everything the integration needs:
 * the payload published to the Discovery screen, and the data used later to
 * route commands and decode state pushes.
 * @param {object} gladys - The SDK instance (for the external ids).
 * @param {object} axencoDevice - Raw device as returned by the Axenco API.
 * @returns {object} The registry entry for this device.
 * @example
 * const entry = describeDevice(gladys, axencoDevice);
 */
export function describeDevice(gladys, axencoDevice) {
  const profile = profileFor(axencoDevice.model);
  // Two lists on purpose: every preset the model can REPORT (to decode a mode
  // into a label) and the subset a user can actually SELECT (the switches).
  const presetKeys = presetKeysFor(axencoDevice);
  const selectableKeys = selectablePresetKeys(axencoDevice);
  const ids = gladys.externalIds(DEVICE_TYPE, axencoDevice._id);
  const created = (gladys.devices || []).find((device) => device.external_id === ids.device);
  const existingFeatureKeys = (created?.features || []).map((feature) =>
    feature.external_id.slice(ids.device.length + 1),
  );
  const legacyPresetKeys = selectableKeys.filter((key) =>
    existingFeatureKeys.includes(presetFeatureKey(key)),
  );
  const legacyThermostatTarget = existingFeatureKeys.includes(STANDARD.LEGACY_TARGET);
  const modeKeys = presetKeys.filter((key) => key !== 'setpoint' || profile.targetTempKey);
  const state = { ...(axencoDevice.state || {}) };
  const gateway = profile.subDevice ? extractGatewayId(axencoDevice.parents) : null;

  const params = [
    { name: 'AXENCO_MODEL', value: String(axencoDevice.model) },
    { name: 'AXENCO_DEVICE_ID', value: String(axencoDevice._id) },
  ];
  if (profile.subDevice) {
    params.push({ name: 'AXENCO_GATEWAY', value: String(gateway || '') });
    params.push({ name: 'AXENCO_RFID', value: String(axencoDevice.rfid || '') });
  }

  return {
    axencoId: axencoDevice._id,
    model: axencoDevice.model,
    profile,
    presetKeys,
    selectableKeys,
    ids,
    parents: axencoDevice.parents,
    gateway,
    rfid: axencoDevice.rfid,
    state,
    observedState: { ...state },
    legacyThermostatTarget,
    connected: Boolean(axencoDevice.connected),
    gladysDevice: {
      name: axencoDevice.name || axencoDevice._id,
      external_id: ids.device,
      selector: selectorFromExternalId(ids.device),
      params,
      features: buildFeatures({
        ids,
        profile,
        presetKeys: selectableKeys,
        modeKeys,
        legacyPresetKeys,
        legacyThermostatTarget,
        existingFeatureKeys,
        state,
        model: axencoDevice.model,
      }),
    },
  };
}

/**
 * @description Extract the feature key out of a feature external id.
 * @param {object} entry - A registry entry.
 * @param {string} featureExternalId - The feature external id.
 * @returns {string} The feature key (`mode`, `preset:comfort`...).
 * @example
 * featureKeyOf(entry, 'ext:neo:axenco:65f:preset:eco'); // 'preset:eco'
 */
export function featureKeyOf(entry, featureExternalId) {
  return featureExternalId.slice(entry.ids.device.length + 1);
}

/** Read the full hardware mode label without requiring a text feature. */
export function modeLabel(entry, state = entry.observedState || entry.state) {
  const code = state[entry.profile.presetStateKey];
  if (!isNumber(code)) return undefined;
  const key = presetKeyFromCode(entry.presetKeys, code);
  return key ? presetLabelFor(entry.model, key, code) : `Inconnu (${code})`;
}

/**
 * @description Translate an Axenco state patch into Gladys states. Only the
 * keys actually present in the patch produce a state, so a WebSocket push
 * carrying a single field does not republish the whole device.
 * @param {object} entry - A registry entry.
 * @param {object} patch - A full or partial Axenco state.
 * @returns {Array<object>} States ready for `publishStates`.
 * @example
 * buildStates(entry, { currentTemp: 19.5 });
 */
export function buildStates(entry, patch) {
  if (!patch || typeof patch !== 'object') {
    return [];
  }
  const { ids, profile, presetKeys, selectableKeys } = entry;
  const states = [];
  const push = (key, state) => states.push({ device_feature_external_id: ids.feature(key), state });

  if (profile.targetTempKey) {
    if (isNumber(patch.currentTemp)) {
      push(FEATURE.CURRENT_TEMP, patch.currentTemp);
    }
    const target = pickTargetTemp(profile, patch);
    if (target !== undefined) {
      push(FEATURE.TARGET_TEMP, target);
    }
  }

  const modeCode = patch[profile.presetStateKey];
  if (isNumber(modeCode)) {
    const activeKey = presetKeyFromCode(presetKeys, modeCode);
    states.push({
      device_feature_external_id: ids.feature(FEATURE.MODE),
      // Kept only for existing text features, or devices without a selector.
      // The widget reads the same label directly from observed hardware state.
      text: modeLabel(entry, patch),
    });
    if (profile.presetRendering === 'switches') {
      states.push({
        device_feature_external_id: ids.feature(FEATURE.MODE_SELECT),
        // Nonempty text is required on the real core's newStateEvent path.
        // An unknown code must not leave the last recognized mode selected.
        text:
          activeKey && (activeKey !== 'setpoint' || profile.targetTempKey)
            ? activeKey
            : `unknown:${modeCode}`,
      });
    }
    if (profile.presetRendering === 'switches') {
      for (const presetKey of selectableKeys) {
        push(presetFeatureKey(presetKey), presetKey === activeKey ? 1 : 0);
      }
    } else {
      push(FEATURE.COOLING, activeKey === 'cooling' ? 1 : 0);
    }
  }

  if (!profile.subDevice) {
    for (const setpoint of SETPOINT_FEATURES) {
      if (isNumber(patch[setpoint.stateKey])) {
        push(setpoint.key, patch[setpoint.stateKey]);
      }
    }
  }

  for (const sensor of SENSOR_FEATURES) {
    if (patch[sensor.stateKey] !== undefined) {
      const value = sensor.read(patch[sensor.stateKey]);
      if (Number.isFinite(value)) push(sensor.key, value);
    }
  }

  if (profile.reportsChangeOver && isNumber(patch.changeOverUser)) {
    push(FEATURE.COOLING, patch.changeOverUser === PRESETS.cooling.code ? 1 : 0);
  }

  if (entry.model === 'EWS' && entry.state.deviceType === 0 && isNumber(modeCode)) {
    if (modeCode === PRESETS.on.code || modeCode === PRESETS.off.code) {
      push(STANDARD.RELAY, modeCode === PRESETS.on.code ? 1 : 0);
    }
  }
  if (isNumber(modeCode)) {
    const pilot = pilotOrderFromCode(modeCode);
    if (pilot !== undefined) push(STANDARD.PILOT, pilot);
    if (entry.model === 'EV30' && presetKeyFromCode(presetKeys, modeCode))
      push(STANDARD.MODE, modeCode === PRESETS.standby.code ? 0 : 1);
  }
  if (patch.windowStatus !== undefined) {
    const raw = patch.windowStatus;
    if ([true, false, 0, 1].includes(raw)) {
      push(STANDARD.WINDOW, raw ? 0 : 1);
    }
  }
  // Do not publish phantom setpoints on EWS, or features that appeared after
  // the current discovery snapshot. Gladys has not created those features yet.
  const declared = new Set(entry.gladysDevice.features.map((f) => f.external_id));
  return states.filter((s) => declared.has(s.device_feature_external_id));
}

/**
 * @description Apply a command coming from Gladys, then report the states to
 * publish so the UI reflects the new situation immediately.
 * @param {object} client - The Axenco client.
 * @param {object} entry - A registry entry.
 * @param {string} featureKey - The feature key being written.
 * @param {number|string} value - The numeric or select value Gladys sent.
 * @returns {Promise<Array<object>>} States ready for `publishStates`.
 * @example
 * await handleSetValue(client, entry, 'preset:comfort', 1);
 */
export async function handleSetValue(client, entry, featureKey, value) {
  const declared = entry.gladysDevice.features.find(
    (f) => f.external_id === entry.ids.feature(featureKey),
  );
  if (!declared || declared.read_only) {
    if (presetKeyFromFeature(featureKey) !== null)
      throw new Error(`Unknown preset for model ${entry.model}`);
    throw new Error(
      `Feature "${featureKey}" is not writable (read-only) or cannot be written on a ${entry.model}`,
    );
  }
  if (featureKey === STANDARD.RELAY) {
    return setPreset(client, entry, binary(value) ? 'on' : 'off', 1);
  }
  if (featureKey === FEATURE.MODE_SELECT) {
    if (
      typeof value !== 'string' ||
      !declared.supported_options.some((option) => option.value === value)
    )
      throw new Error(`Unknown preset for model ${entry.model}`);
    if (value === 'setpoint') {
      // Mode 8 alone is ignored. Enter an override using the existing,
      // observed target and the same captured temperature payload as before.
      return setTargetTemperature(
        client,
        entry,
        pickTargetTemp(entry.profile, entry.observedState),
      );
    }
    return setPreset(client, entry, value, 1);
  }
  if (featureKey === STANDARD.PILOT) {
    if (!Number.isInteger(value) || !PILOT_PRESETS[value])
      throw new Error('Invalid pilot-wire mode');
    return setPreset(client, entry, PILOT_PRESETS[value], 1);
  }
  if (featureKey === FEATURE.TARGET_TEMP) {
    return setTargetTemperature(client, entry, value);
  }
  const presetKey = presetKeyFromFeature(featureKey);
  if (presetKey !== null) {
    return setPreset(client, entry, presetKey, value);
  }
  if (featureKey === FEATURE.COOLING) {
    return setChangeOver(client, entry, value);
  }
  const setpoint = setpointFeature(featureKey);
  if (setpoint !== null) {
    return setModeSetpoint(client, entry, setpoint, value);
  }
  throw new Error(`Feature "${featureKey}" is not writable`);
}

async function setTargetTemperature(client, entry, value) {
  const temperature = validateTemperature(entry, FEATURE.TARGET_TEMP, value);
  if (!Number.isFinite(temperature)) {
    throw new Error(`Invalid temperature: ${value}`);
  }
  const { profile } = entry;
  const states = [];

  // `climate.py` writes `targetMode: 8` first, then the temperature. Measured
  // on a real EV30: that first call answers 2xx and does nothing, while the
  // temperature write moves the device into derogation (8) on its own. So we
  // send the temperature alone and let the device set its own mode.
  if (profile.subDevice) {
    await client.setSubDeviceTemperature(requireParents(entry), requireRfid(entry), temperature);
  } else {
    await client.setDeviceTemperature(entry.axencoId, temperature);
  }
  entry.state[profile.targetTempKey] = temperature;
  states.push(...buildStates(entry, { [profile.targetTempKey]: temperature }));
  // The resulting mode (derogation) is whatever the device decides; the
  // WebSocket push that follows reports it.
  return states;
}

async function setPreset(client, entry, presetKey, value) {
  const { profile } = entry;
  binary(value);

  // Switching a preset OFF has no Axenco counterpart — there is no "no mode"
  // to send. Re-publish the mode as it really is so the switch snaps back
  // instead of lying about a state the device never entered.
  if (Number(value) <= 0) {
    return buildStates(entry, { [profile.presetStateKey]: entry.state[profile.presetStateKey] });
  }

  const preset = PRESETS[presetKey];
  if (!preset || !entry.selectableKeys.includes(presetKey)) {
    throw new Error(`Unknown preset "${presetKey}" for model ${entry.model}`);
  }
  await writeMode(client, entry, preset.code);
  entry.state[profile.presetStateKey] = preset.code;
  // Republishing every sibling switch is what makes the set exclusive in the
  // UI: the one just turned on stays on, the others go off in the same batch.
  return buildStates(entry, { [profile.presetStateKey]: preset.code });
}

async function setModeSetpoint(client, entry, setpoint, value) {
  const temperature = validateTemperature(entry, setpoint.key, value);
  if (!Number.isFinite(temperature)) {
    throw new Error(`Invalid temperature: ${value}`);
  }
  if (entry.profile.subDevice || !entry.profile.targetTempKey) {
    throw new Error(`Per-mode setpoints cannot be written on a ${entry.model}`);
  }
  // The app sends the three together even when one changed, so the two others
  // come from the state we last read.
  const setpoints = {};
  for (const field of SETPOINT_FEATURES) {
    const current = field.key === setpoint.key ? temperature : entry.state[field.stateKey];
    if (typeof current === 'number') {
      setpoints[field.stateKey] = current;
    }
  }
  await client.setDeviceSetpoints(entry.axencoId, setpoints);
  Object.assign(entry.state, setpoints);
  return buildStates(entry, setpoints);
}

async function setChangeOver(client, entry, value) {
  binary(value);
  if (entry.profile.presetRendering !== 'binary') {
    // NTD reports the change-over but never sets it, exactly like `climate.py`.
    throw new Error(`The change-over of a ${entry.model} is read-only`);
  }
  const code = Number(value) > 0 ? PRESETS.cooling.code : PRESETS.heating.code;
  // `select.py` routes UFH through `set_device_mode`, but a UFH IS a
  // sub-device and its mode lives on `changeOverUser`: we use the dedicated
  // sub-device route `pyaxencoapi` provides for it. Documented divergence.
  await client.setSubDeviceModeUfh(requireParents(entry), requireRfid(entry), code);
  entry.state.changeOverUser = code;
  return buildStates(entry, { changeOverUser: code });
}

async function writeMode(client, entry, code) {
  if (entry.profile.subDevice) {
    await client.setSubDeviceMode(requireParents(entry), requireRfid(entry), code);
    return;
  }
  await client.setDeviceMode(entry.axencoId, code);
}

function requireParents(entry) {
  if (!entry.gateway) {
    throw new Error(`Sub-device ${entry.axencoId} has no gateway in its parents`);
  }
  return entry.parents;
}

function requireRfid(entry) {
  if (!entry.rfid) {
    throw new Error(`Sub-device ${entry.axencoId} has no rfid`);
  }
  return String(entry.rfid);
}

function pickTargetTemp(profile, patch) {
  if (isNumber(patch[profile.targetTempKey])) {
    return patch[profile.targetTempKey];
  }
  // A push does not always use the key the model normally carries;
  // `climate.py` accepts either and so do we.
  const alternate = profile.targetTempKey === 'overrideTemp' ? 'targetTemp' : 'overrideTemp';
  return isNumber(patch[alternate]) ? patch[alternate] : undefined;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

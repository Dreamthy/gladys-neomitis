// One Axenco device uses a mode selector; existing preset switches keep
// their historical feature ids so existing Gladys scenes remain valid. Gladys 5.2 uses
// the shared EV30 setpoint, a physical mode, an EWS relay and pilot-wire controls.
// The full Axenco preset list is also available in the integration widget.
// The widget shows Auto details and unknown codes without an extra text feature.

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { DEFAULT_MAX_TEMP, DEFAULT_MIN_TEMP, PRESETS, presetLabelFor } from '../axenco/const.js';
import { selectorFromExternalId } from '../selector.js';
import { STANDARD, PILOT_PRESETS } from './standard.js';

export const DEVICE_TYPE = 'axenco';

export const FEATURE = {
  CURRENT_TEMP: 'current-temperature',
  TARGET_TEMP: 'target-temperature',
  MODE: 'mode',
  MODE_SELECT: 'axenco-mode',
  COOLING: 'cooling',
};

/**
 * The per-mode setpoints a device stores, one Gladys feature each. They are the
 * temperatures the modes USE, unlike `TARGET_TEMP` which is the derogation
 * overriding whichever one is in force.
 *
 * Only `comfTemp` has device-reported bounds (`comfLimitMin`/`comfLimitMax` —
 * they are the comfort limits, hence the name). The other two have none, so
 * they get the wide 7-30 fallback: a device is free to clamp or refuse, and
 * the post-command reconciliation reports it when it does.
 */
export const SETPOINT_FEATURES = [
  { key: 'comfort-temperature', stateKey: 'comfTemp', name: 'Consigne Confort', bounded: true },
  { key: 'eco-temperature', stateKey: 'ecoTemp', name: 'Consigne Éco', bounded: false },
  {
    key: 'antifrost-temperature',
    stateKey: 'antifTemp',
    name: 'Consigne Hors gel',
    bounded: false,
  },
];

/**
 * Read-only sensors every Axenco device already reports in its state. They cost
 * nothing: the values ride along with the device list and with every WebSocket
 * push, so there is no extra API call and no rate-limit pressure beyond the
 * deduplication that already applies.
 *
 * Neither `pyaxencoapi` nor the Home Assistant integration exposes any of them.
 *
 * `read` converts the Axenco representation to what Gladys stores: booleans
 * become 0/1, numbers pass through. A sensor appears only when the device
 * actually reports the field — no assumption per model, and being read-only
 * there is no risk in exposing one that turns out to be meaningless.
 */
export const SENSOR_FEATURES = [
  {
    key: 'signal',
    stateKey: 'rssi',
    name: 'Signal',
    category: DEVICE_FEATURE_CATEGORIES.SIGNAL,
    type: DEVICE_FEATURE_TYPES.SIGNAL.QUALITY,
    unit: DEVICE_FEATURE_UNITS.DECIBEL,
    // Gladys draws antenna bars by mapping min..max onto 0..5 levels
    // (`getSignalQualityLevel`), so the bounds have to be the useful dBm range
    // rather than a raw integer range, or every device would show full bars.
    min: -100,
    max: -30,
    keepHistory: true,
    read: (value) => value,
  },
  {
    key: 'presence',
    stateKey: 'occupancyStatus',
    name: 'Présence',
    category: DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
    keepHistory: true,
    read: (value) => (value ? 1 : 0),
  },
  {
    key: 'open-window',
    stateKey: 'windowStatus',
    name: 'Fenêtre ouverte',
    category: DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
    keepHistory: true,
    read: (value) => (value ? 1 : 0),
  },
  {
    key: 'child-lock',
    stateKey: 'keylock',
    name: 'Verrouillage clavier',
    category: DEVICE_FEATURE_CATEGORIES.CHILD_LOCK,
    type: DEVICE_FEATURE_TYPES.CHILD_LOCK.BINARY,
    min: 0,
    max: 1,
    keepHistory: false,
    // Read-only on purpose: the field is reported, but nothing proves it can
    // be written, and this session showed that reporting is not accepting.
    read: (value) => (value ? 1 : 0),
  },
  {
    key: 'fault',
    stateKey: 'faultSystem',
    name: 'Défaut système',
    category: DEVICE_FEATURE_CATEGORIES.RISK,
    type: DEVICE_FEATURE_TYPES.RISK.INTEGER,
    // Published as the raw integer rather than collapsed to a boolean: 0 is
    // "no fault" on every device seen, and a non-zero value may well be a code
    // or a bit mask, which flattening would destroy.
    min: 0,
    max: 65535,
    keepHistory: false,
    read: (value) => value,
  },
];

/**
 * @description Find the setpoint a feature key drives, if any.
 * @param {string} featureKey - A feature key.
 * @returns {object|null} The `SETPOINT_FEATURES` entry, or null.
 * @example
 * setpointFeature('eco-temperature'); // { stateKey: 'ecoTemp', ... }
 */
export function setpointFeature(featureKey) {
  return SETPOINT_FEATURES.find((entry) => entry.key === featureKey) || null;
}

export const PRESET_FEATURE_PREFIX = 'preset:';

/**
 * @description Feature key of the switch driving one preset.
 * @param {string} presetKey - A key of `PRESETS`.
 * @returns {string} The feature key.
 * @example
 * presetFeatureKey('comfort'); // 'preset:comfort'
 */
export function presetFeatureKey(presetKey) {
  return `${PRESET_FEATURE_PREFIX}${presetKey}`;
}

/**
 * @description Read the preset back from a preset feature key.
 * @param {string} featureKey - A feature key.
 * @returns {string|null} The preset key, or null for another feature.
 * @example
 * presetKeyFromFeature('preset:comfort'); // 'comfort'
 */
export function presetKeyFromFeature(featureKey) {
  return featureKey.startsWith(PRESET_FEATURE_PREFIX)
    ? featureKey.slice(PRESET_FEATURE_PREFIX.length)
    : null;
}

// Gladys stores `min` and `max` as NOT NULL for EVERY feature
// (`server/models/device_feature.js`), including the ones where a range means
// nothing — omitting them is rejected with a 422.
const BINARY_RANGE = { min: 0, max: 1 };
const NO_RANGE = { min: 0, max: 0 };

function withSelector(feature) {
  return { ...feature, selector: selectorFromExternalId(feature.external_id) };
}

/**
 * @description Build the complete Gladys feature list of an Axenco device.
 * @param {object} params - Build parameters.
 * @param {object} params.ids - Result of `gladys.externalIds()` for the device.
 * @param {object} params.profile - The model capability profile.
 * @param {string[]} params.presetKeys - Presets supported by this model.
 * @param {object} params.state - The device state as last read.
 * @returns {Array<object>} The features to publish.
 * @example
 * buildFeatures({ ids, profile, presetKeys, state });
 */
export function buildFeatures({
  ids,
  profile,
  presetKeys,
  modeKeys = presetKeys,
  legacyPresetKeys = [],
  legacyThermostatTarget = false,
  existingFeatureKeys = [],
  state,
  model,
}) {
  const features = [];
  const add = (key, name, category, type, min, max, extra = {}) =>
    features.push(
      withSelector({
        name,
        external_id: ids.feature(key),
        category,
        type,
        min,
        max,
        read_only: false,
        has_feedback: true,
        keep_history: false,
        ...extra,
      }),
    );

  if (model === 'EV30') {
    add(
      STANDARD.MODE,
      'Mode du radiateur',
      DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
      DEVICE_FEATURE_TYPES.THERMOSTAT.MODE,
      0,
      1,
      {
        supported_options: [
          { value: 0, label: 'Arrêt' },
          { value: 1, label: 'Chauffage' },
        ],
      },
    );
    // Gladys deletes missing features on device update. Retain an existing
    // alias so saved thermostat/scenes and history are not silently destroyed.
    if (legacyThermostatTarget)
      add(
        STANDARD.LEGACY_TARGET,
        'Consigne (compatibilité)',
        DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
        DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE,
        numberOr(state.comfLimitMin, DEFAULT_MIN_TEMP),
        numberOr(state.comfLimitMax, DEFAULT_MAX_TEMP),
        { unit: DEVICE_FEATURE_UNITS.CELSIUS, step: 0.5, keep_history: true },
      );
  }
  if (model === 'EWS' && state.deviceType === 0) {
    add(
      STANDARD.RELAY,
      'Marche / Arrêt',
      DEVICE_FEATURE_CATEGORIES.SWITCH,
      DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      0,
      1,
    );
  }
  if (model === 'EWS' && state.deviceType !== 0) {
    const supported = Object.entries(PILOT_PRESETS).filter(([, key]) => presetKeys.includes(key));
    add(
      STANDARD.PILOT,
      'Commande fil pilote (6 ordres)',
      DEVICE_FEATURE_CATEGORIES.HEATER,
      DEVICE_FEATURE_TYPES.HEATER.PILOT_WIRE_MODE,
      0,
      5,
      {
        supported_options: supported.map(([value, key]) => ({
          value: Number(value),
          label: presetLabelFor(model, key),
        })),
      },
    );
  }
  if (
    [true, false, 0, 1].includes(state.windowStatus) ||
    existingFeatureKeys.includes(STANDARD.WINDOW)
  ) {
    add(
      STANDARD.WINDOW,
      'Fenêtre ouverte',
      DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR,
      DEVICE_FEATURE_TYPES.SENSOR.BINARY,
      0,
      1,
      { read_only: true, has_feedback: false, keep_history: true },
    );
  }

  if (profile.targetTempKey) {
    features.push(
      withSelector({
        name: 'Température actuelle',
        external_id: ids.feature(FEATURE.CURRENT_TEMP),
        category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: -50,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      }),
    );
    features.push(
      withSelector({
        name: 'Température de consigne',
        external_id: ids.feature(FEATURE.TARGET_TEMP),
        category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
        type: DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        // Bounds come from the device itself: a real installation reports
        // narrower limits than the 7/30 fallback (`comfLimitMin/Max`).
        min: numberOr(state.comfLimitMin, DEFAULT_MIN_TEMP),
        max: numberOr(state.comfLimitMax, DEFAULT_MAX_TEMP),
        ...(model === 'EV30' ? { step: 0.5 } : {}),
        read_only: false,
        has_feedback: true,
        keep_history: true,
      }),
    );
  }

  // A selector already reports the mode. Preserve an existing text feature
  // for references/history, and retain it on devices without a selector.
  if (profile.presetRendering !== 'switches' || existingFeatureKeys.includes(FEATURE.MODE))
    features.push(
      withSelector({
        name:
          profile.presetRendering === 'switches' ? 'Mode actuel (compatibilité)' : 'Mode actuel',
        external_id: ids.feature(FEATURE.MODE),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        ...NO_RANGE,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      }),
    );

  if (profile.presetRendering === 'switches') {
    for (const presetKey of presetKeys) {
      if (!legacyPresetKeys.includes(presetKey)) continue;
      const preset = PRESETS[presetKey];
      if (!preset) {
        continue;
      }
      features.push(
        withSelector({
          name: presetLabelFor(model, presetKey),
          external_id: ids.feature(presetFeatureKey(presetKey)),
          category: DEVICE_FEATURE_CATEGORIES.SWITCH,
          type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
          ...BINARY_RANGE,
          read_only: false,
          has_feedback: true,
          keep_history: false,
        }),
      );
    }
  }

  // The per-mode setpoints. Two conditions, both necessary:
  //
  //   - the model must actually REGULATE a temperature (`targetTempKey`).
  //     Reporting the fields is not the same as accepting them: an EWS carries
  //     comfTemp/ecoTemp/antifTemp in its state, and the user confirmed they
  //     cannot be written — it drives a fil pilote and has no sensor, so it
  //     has no setpoint of its own to configure. Same reasoning excludes UFH.
  //   - main devices only: writing these on a sub-device would need the
  //     rfid-keyed payload, whose shape has never been observed.
  //
  // Unlike the mode lists, the default here is to EXPOSE NOTHING when unsure.
  // A phantom mode is visible and harmless; a temperature that silently does
  // not apply reads as a setting that took effect when it did not.
  if (!profile.subDevice && profile.targetTempKey) {
    for (const setpoint of SETPOINT_FEATURES) {
      if (typeof state[setpoint.stateKey] !== 'number') {
        continue;
      }
      features.push(
        withSelector({
          name: setpoint.name,
          external_id: ids.feature(setpoint.key),
          category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
          type: DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE,
          unit: DEVICE_FEATURE_UNITS.CELSIUS,
          min: setpoint.bounded ? numberOr(state.comfLimitMin, DEFAULT_MIN_TEMP) : DEFAULT_MIN_TEMP,
          max: setpoint.bounded ? numberOr(state.comfLimitMax, DEFAULT_MAX_TEMP) : DEFAULT_MAX_TEMP,
          read_only: false,
          has_feedback: true,
          keep_history: false,
        }),
      );
    }
  }

  // The read-only sensors the device already reports. Any device, including
  // sub-devices: nothing is written, so there is no routing to get wrong.
  for (const sensor of SENSOR_FEATURES) {
    const legacyWindow = sensor.key === 'open-window';
    if (
      legacyWindow
        ? !existingFeatureKeys.includes(sensor.key)
        : state[sensor.stateKey] === undefined
    ) {
      continue;
    }
    features.push(
      withSelector({
        name: legacyWindow ? `${sensor.name} (compatibilité)` : sensor.name,
        external_id: ids.feature(sensor.key),
        category: sensor.category,
        type: sensor.type,
        ...(sensor.unit ? { unit: sensor.unit } : {}),
        min: sensor.min,
        max: sensor.max,
        read_only: true,
        has_feedback: false,
        keep_history: sensor.keepHistory,
      }),
    );
  }

  // A two-preset model (UFH heating/cooling) is a genuine binary, and a NTD
  // reports the same information read-only alongside its presets.
  if (profile.presetRendering === 'binary' || profile.reportsChangeOver) {
    features.push(
      withSelector({
        name: PRESETS.cooling.label,
        external_id: ids.feature(FEATURE.COOLING),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        ...BINARY_RANGE,
        read_only: profile.presetRendering !== 'binary',
        has_feedback: profile.presetRendering === 'binary',
        keep_history: false,
      }),
    );
  }

  if (profile.presetRendering === 'switches') {
    add(
      FEATURE.MODE_SELECT,
      model === 'EWS' ? 'Mode du module' : 'Mode Axenco',
      DEVICE_FEATURE_CATEGORIES.TEXT,
      DEVICE_FEATURE_TYPES.TEXT.SELECT,
      0,
      0,
      {
        supported_options: modeKeys.map((key, index) => ({
          value: key,
          label: key === 'setpoint' ? 'Dérogation (consigne actuelle)' : presetLabelFor(model, key),
          sort_order: index,
        })),
      },
    );
  }

  return features;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// -----------------------------------------------------------------------------
// What each Axenco model actually exposes.
//
// The Home Assistant integration splits its models across two platforms
// (`climate.py` for the thermostats, `select.py` for EWS and UFH). Gladys has
// no `climate` entity grouping temperature + setpoint + mode, so here a device
// is described by capabilities instead, and the feature list is composed from
// them. One table, every model, no branching spread over the code base.
// -----------------------------------------------------------------------------

/**
 * - `subDevice`         : reached through its gateway (`parents`) + its `rfid`
 *                         rather than by its own `_id`.
 * - `targetTempKey`     : Axenco state key holding the setpoint, null when the
 *                         model has no temperature at all.
 * - `presetStateKey`    : Axenco state key holding the mode.
 * - `presetRendering`   : `switches` -> one binary feature per preset;
 *                         `binary`   -> a single binary feature (two presets).
 * - `reportsChangeOver` : the model reports a heating/cooling change-over on
 *                         top of its presets, read-only (`climate.py` reads
 *                         `changeOverUser` for NTD but never writes it).
 */
const THERMOSTAT_MAIN = {
  subDevice: false,
  targetTempKey: 'overrideTemp',
  presetStateKey: 'targetMode',
  presetRendering: 'switches',
  reportsChangeOver: false,
};

const THERMOSTAT_SUB = {
  subDevice: true,
  targetTempKey: 'targetTemp',
  presetStateKey: 'targetMode',
  presetRendering: 'switches',
  reportsChangeOver: false,
};

export const MODEL_PROFILES = {
  EV30: THERMOSTAT_MAIN,
  ECTRL: THERMOSTAT_MAIN,
  ESTAT: THERMOSTAT_MAIN,
  'RSS-ECTRL': THERMOSTAT_MAIN,

  ETRV: THERMOSTAT_SUB,
  // Same as ETRV, but a NTD also reports whether the installation currently
  // runs in heating or cooling.
  NTD: { ...THERMOSTAT_SUB, reportsChangeOver: true },

  // Wireless module: no temperature, only a mode. Its preset list depends on
  // how it is wired (dry-contact relay vs fil pilote), see `presetModelKey`.
  EWS: {
    subDevice: false,
    targetTempKey: null,
    presetStateKey: 'targetMode',
    presetRendering: 'switches',
    reportsChangeOver: false,
  },

  // Underfloor heating/cooling: no temperature and no `targetMode` either —
  // its only mode is the heating/cooling change-over, which lives on its own
  // state key and is written through a dedicated route.
  UFH: {
    subDevice: true,
    targetTempKey: null,
    presetStateKey: 'changeOverUser',
    presetRendering: 'binary',
    reportsChangeOver: false,
  },
};

/**
 * @description Return the capability profile of an Axenco model.
 * @param {string} model - The `model` field of the Axenco device.
 * @returns {object|null} The profile, or null when the model is not supported.
 * @example
 * profileFor('NTD').subDevice; // true
 */
export function profileFor(model) {
  return MODEL_PROFILES[model] || null;
}

/**
 * @description Tell whether a raw Axenco device is one this integration maps.
 * @param {object} axencoDevice - Raw device as returned by the Axenco API.
 * @returns {boolean} True when the model is supported.
 * @example
 * isSupportedDevice({ model: 'EV30', _id: '65f...' }); // true
 */
export function isSupportedDevice(axencoDevice) {
  return Boolean(axencoDevice && axencoDevice._id && profileFor(axencoDevice.model));
}

// -----------------------------------------------------------------------------
// Axenco protocol constants.
//
// JavaScript port of `pyaxencoapi/const.py` (the library the Home Assistant
// `myneomitis` integration relies on), kept deliberately close to the original
// so the two stay comparable when the upstream library evolves.
// -----------------------------------------------------------------------------

export const API_BASE = 'https://user-ep.imhotepcreation.com';

// The Axenco backend gates its API on these request headers. `pyaxencoapi`
// sends `application: home-assistant` and `source-id: myneomitis`; we send the
// exact same values on purpose — they are part of the contract the server
// validates, not a user agent we are free to rebrand.
export const SOURCE_ID = 'myneomitis';
export const APPLICATION = 'home-assistant';
export const APPLICATION_VERSION = '1.0.0';
export const SOURCE_TYPE = 'plugin';

// Socket.IO endpoint: a non-default path, and websocket-only transport.
export const SOCKET_IO_PATH = '/socket.io-v2';

// Fallback temperature bounds when the device does not report its own
// `comfLimitMin` / `comfLimitMax` (same defaults as `climate.py`).
export const DEFAULT_MIN_TEMP = 7;
export const DEFAULT_MAX_TEMP = 30;

/**
 * Every preset Axenco exposes, with the numeric code carried by `targetMode`
 * (or `changeOverUser` for the UFH heating/cooling pair) and the label shown
 * in Gladys.
 *
 * Codes are NOT globally unique: `on`/`off` (EWS relay) reuse 1/2, which
 * `comfort`/`eco` also use, and `cooling` reuses 0/1 on another state key.
 * Decoding a code is therefore always done through the preset list of the
 * model at hand — never against this table as a whole. That is exactly what
 * `ModelPresetMap.reverse` does in `pyaxencoapi`.
 *
 * `readCodes` covers codes a device may REPORT for a preset on top of the one
 * we send. `auto` is the known case: we write 0, and hardware reports 60 or 61
 * back. Accepting all three avoids showing an unknown mode.
 */
export const PRESETS = {
  comfort: { code: 1, label: 'Confort' },
  eco: { code: 2, label: 'Éco' },
  antifrost: { code: 3, label: 'Hors gel' },
  standby: { code: 4, label: 'Veille' },
  boost: { code: 6, label: 'Boost' },
  // "Dérogation" is the name the MyNeomitis app gives it, and the name fits
  // what it is: a temporary override of the weekly program. It is a REPORTED
  // state, never a command — see `selectablePresetKeys`.
  setpoint: { code: 8, label: 'Dérogation' },
  comfort_plus: { code: 20, label: 'Confort +' },
  // Named "eco 1K" / "eco 2K" in the MyNeomitis app: one or two kelvin below
  // the comfort setpoint. Same thing the EWS manual calls Éco-1 / Éco-2.
  eco_1: { code: 40, label: 'Éco 1K' },
  eco_2: { code: 41, label: 'Éco 2K' },
  // Auto is `targetMode: 0`, captured from the official app switching a real
  // EV30 out of Confort. `pyaxencoapi` documents 60, which simply does not
  // work: 60 and 61 both answer 2xx and change nothing.
  //
  // Being an ordinary `targetMode` value is what makes Auto exclusive with the
  // manual modes for free — the app leaves Auto with `{targetMode: 1}` alone,
  // nothing else to clear. The `autoProgram` flag is a separate setting (is a
  // weekly program active), NOT the mode selector.
  //
  // 60 and 61 stay as read codes: hardware switched to Auto reports them back,
  // probably to say whether the schedule currently asks for Éco or Confort.
  auto: {
    code: 0,
    label: 'Auto',
    readCodes: [0, 60, 61],
    // In Auto the schedule alternates, and the device says which side it is on
    // right now. Confirmed by the user against the app: 60 is Auto Confort,
    // 61 Auto Éco. Only the TEXT feature varies — the switch stays "Auto",
    // since both are the same selectable mode.
    labelByCode: { 60: 'Auto (Confort)', 61: 'Auto (Éco)' },
  },
  on: { code: 1, label: 'Marche' },
  off: { code: 2, label: 'Arrêt' },
  heating: { code: 0, label: 'Chauffage' },
  cooling: { code: 1, label: 'Rafraîchissement' },
};

/**
 * Presets supported per model, in the order `pyaxencoapi` declares them.
 * `EWS_RELAIS` / `EWS_PILOTE` are not Axenco models but the two operating
 * modes of the EWS module, told apart by `state.deviceType` (see `select.py`).
 */
export const PRESET_MODE_MODELS = {
  // MEASURED on a real EV30 (ERFLB1001) through the WebSocket: 1 comfort,
  // 2 eco, 3 antifrost, 4 standby and 6 boost all apply — 4 needed two tries,
  // these heaters drop commands. Ignored: 8 setpoint, 20, 40, 41, 60, 61.
  // 0 auto was never in that sweep — `pyaxencoapi` documents 60, so 0 was not
  // a candidate. The app capture settled it afterwards.
  EV30: ['setpoint', 'boost', 'eco', 'comfort', 'auto', 'antifrost', 'standby'],
  ECTRL: ['setpoint', 'boost', 'eco', 'comfort', 'comfort_plus', 'auto', 'antifrost', 'standby'],
  ESTAT: ['setpoint', 'boost', 'eco', 'comfort', 'comfort_plus', 'auto', 'antifrost', 'standby'],
  'RSS-ECTRL': [
    'setpoint',
    'boost',
    'eco',
    'comfort',
    'comfort_plus',
    'auto',
    'antifrost',
    'standby',
  ],
  NTD: ['setpoint', 'eco', 'comfort', 'auto', 'antifrost', 'standby'],
  ETRV: ['setpoint', 'eco', 'comfort', 'antifrost', 'standby'],
  UFH: ['heating', 'cooling'],
  EWS_RELAIS: ['on', 'off', 'auto'],

  // Fil pilote EWS, DEFAULT list: the ten presets `pyaxencoapi` and
  // `select.py` advertise. That is the union of what Axenco hardware can do
  // rather than what a given module offers, so it over-lists on the modules
  // we know — but it is the upstream behaviour, and erring towards a mode
  // that does nothing beats silently hiding one a module really has. Any
  // `deviceType` we have not verified lands here.
  EWS_PILOTE: [
    'setpoint',
    'boost',
    'eco',
    'eco_1',
    'eco_2',
    'comfort',
    'comfort_plus',
    'auto',
    'antifrost',
    'standby',
  ],

  // Fil pilote EWS reporting `deviceType: 1`. MEASURED on a real EWSFPNEOA
  // (`relayMode: 0`) through the WebSocket, and cross-checked against the
  // module's manual — the two agree, and both contradict the MyNeomitis app,
  // whose menu only offers six of these.
  //
  // Applied: 1 comfort, 2 eco, 3 antifrost, 4 standby, 6 boost, 40 eco_1,
  // 41 eco_2 (40 and 41 confirmed twice each). Ignored twice: 20 comfort_plus.
  // The manual settles why: the module drives heaters with "un fil pilote 4 ou
  // 6 ordres", and its LED table reads "Mode Éco, Éco-1 ou Éco-2". So the app
  // hides two orders the hardware really emits.
  //
  // `setpoint` is absent: no sensor (`currentTemp` stays 0) — writing
  // `overrideTemp` here does NOT flip the mode to 8, unlike on an EV30.
  // Caveat worth passing on: per the manual, Boost only does something when
  // the connected heater understands the Boost order over the fil pilote.
  EWS_PILOTE_TYPE_1: ['boost', 'eco', 'eco_1', 'eco_2', 'comfort', 'auto', 'antifrost', 'standby'],
};

/**
 * The three configured setpoints a device holds, one per mode. Distinct from
 * the derogation (`overrideTemp`), which temporarily overrides whichever of
 * them is in force.
 *
 * Captured from the official app, which writes the three together in a single
 * call: `{"comfTemp":20,"ecoTemp":18,"antifTemp":7}`. Neither `pyaxencoapi`
 * nor the Home Assistant integration exposes them at all.
 */
export const SETPOINT_FIELDS = ['comfTemp', 'ecoTemp', 'antifTemp'];

/**
 * @description Resolve the key of the preset table that applies to a device.
 *
 * Every model maps to itself, except EWS whose preset set depends on how the
 * module is wired. `select.py` only tells a dry-contact relay
 * (`deviceType === 0`) from a fil pilote (anything else); we refine the fil
 * pilote side per `deviceType`, because the ten-preset list upstream uses is
 * the union of what Axenco hardware can do, not what one module offers.
 *
 * A `deviceType` we have verified gets its own list; every other one keeps
 * the upstream default. Showing a mode that turns out to do nothing is a
 * visible, harmless annoyance — hiding a mode a module really has is a silent
 * loss of capability on hardware we have never seen.
 * @param {object} axencoDevice - Raw device as returned by the Axenco API.
 * @returns {string} The key to look up in `PRESET_MODE_MODELS`.
 * @example
 * presetModelKey({ model: 'EWS', state: { deviceType: 0 } }); // 'EWS_RELAIS'
 * presetModelKey({ model: 'EWS', state: { deviceType: 1 } }); // 'EWS_PILOTE_TYPE_1'
 * presetModelKey({ model: 'EWS', state: { deviceType: 7 } }); // 'EWS_PILOTE'
 */
export function presetModelKey(axencoDevice) {
  if (axencoDevice.model !== 'EWS') {
    return axencoDevice.model;
  }
  const deviceType = (axencoDevice.state || {}).deviceType;
  if (deviceType === 0) {
    return 'EWS_RELAIS';
  }
  const verified = `EWS_PILOTE_TYPE_${deviceType}`;
  return PRESET_MODE_MODELS[verified] ? verified : 'EWS_PILOTE';
}

/**
 * @description List the preset keys a device supports.
 * @param {object} axencoDevice - Raw device as returned by the Axenco API.
 * @returns {string[]} Ordered preset keys, empty when the model is unknown.
 * @example
 * presetKeysFor({ model: 'ETRV' }); // ['setpoint', 'eco', 'comfort', ...]
 */
export function presetKeysFor(axencoDevice) {
  return PRESET_MODE_MODELS[presetModelKey(axencoDevice)] || [];
}

/**
 * @description The presets a user can actually SELECT, out of the ones the
 * model reports. Only `setpoint` is filtered out: measured on a real EV30,
 * writing `targetMode: 8` does nothing, while writing `overrideTemp` puts the
 * device in derogation by itself — so the control that produces it is the
 * target-temperature feature, not a switch.
 *
 * Auto is NOT filtered: it is `targetMode: 0`, an ordinary mode value, so it
 * belongs to the exclusive switch set like every other one.
 * @param {object} axencoDevice - Raw device as returned by the Axenco API.
 * @returns {string[]} The selectable preset keys, in model order.
 * @example
 * selectablePresetKeys({ model: 'EV30', state: {} });
 */
export function selectablePresetKeys(axencoDevice) {
  return presetKeysFor(axencoDevice).filter((key) => key !== 'setpoint');
}

/**
 * @description Decode a numeric mode reported by Axenco into a preset key,
 * within the presets of one model only (codes are ambiguous across models).
 * @param {string[]} keys - The preset keys of the model.
 * @param {number} code - The numeric code reported by the device.
 * @returns {string|null} The matching preset key, or null when unknown.
 * @example
 * presetKeyFromCode(['auto', 'comfort'], 61); // 'auto'
 */
export function presetKeyFromCode(keys, code) {
  if (typeof code !== 'number') {
    return null;
  }
  return (
    keys.find((key) => {
      const preset = PRESETS[key];
      if (!preset) {
        return false;
      }
      return preset.code === code || (preset.readCodes || []).includes(code);
    }) || null
  );
}

// Models driven through `targetMode` + a temperature setpoint. "Sub" models
// are reached through their gateway (`parents`) and their own `rfid`, and
// carry their setpoint in `targetTemp` instead of `overrideTemp`.
export const THERMOSTAT_MODELS = ['EV30', 'ECTRL', 'ESTAT', 'RSS-ECTRL'];
export const THERMOSTAT_SUB_MODELS = ['NTD', 'ETRV'];
// Mode-only models: no temperature at all, just `targetMode` (EWS) or the
// heating/cooling change-over (UFH, a sub-device).
export const MODE_ONLY_MODELS = ['EWS'];
export const CHANGE_OVER_SUB_MODELS = ['UFH'];

export const SUPPORTED_MODELS = [
  ...THERMOSTAT_MODELS,
  ...THERMOSTAT_SUB_MODELS,
  ...MODE_ONLY_MODELS,
  ...CHANGE_OVER_SUB_MODELS,
];

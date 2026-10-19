// Gladys values are not Axenco values. Keep the translation explicit.
export const STANDARD = {
  MODE: 'thermostat-mode',
  TARGET: 'thermostat-temperature',
  RELAY: 'power',
  PILOT: 'pilot-wire-mode',
  WINDOW: 'window-contact',
};

export const PILOT_PRESETS = {
  0: 'standby',
  1: 'antifrost',
  2: 'eco',
  3: 'eco_1',
  4: 'eco_2',
  5: 'comfort',
};

export function nativeThermostat(entry) {
  // Only the EV30 protocol has been checked on real hardware.
  return entry.model === 'EV30';
}

export function binary(value) {
  if (value !== 0 && value !== 1) throw new Error('Expected 0 or 1');
  return value;
}

export function validateTemperature(entry, key, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid temperature');
  const feature = entry.gladysDevice.features.find((f) => f.external_id === entry.ids.feature(key));
  if (!feature || value < feature.min || value > feature.max) {
    throw new Error(`Temperature outside the supported range for ${key}`);
  }
  if (feature.step && Math.abs(value / feature.step - Math.round(value / feature.step)) > 1e-8) {
    throw new Error(`Temperature must use a ${feature.step} degree step`);
  }
  return value;
}

// Gladys values are not Axenco values. Keep the translation explicit.
import { profileFor } from './profiles.js';

export const STANDARD = {
  MODE: 'thermostat-mode',
  TARGET: 'target-temperature',
  // Compatibility only: retained in discovery solely when already created.
  LEGACY_TARGET: 'thermostat-temperature',
  RELAY: 'power',
  // Retired: omitted from EWS discovery; stale commands must be rejected.
  PILOT: 'pilot-wire-mode',
  WINDOW: 'window-contact',
};

export function nativeThermostat(entry) {
  return (entry.profile || profileFor(entry.model))?.nativeThermostat === true;
}

/** NTD reports the installation changeover; this integration cannot change it. */
export function runningThermostatMode(entry, state = entry.observedState || entry.state) {
  return entry.profile.reportsChangeOver && state.changeOverUser === 1 ? 2 : 1;
}

export function validateThermostatMode(entry, value) {
  const max = entry.profile.reportsChangeOver ? 2 : 1;
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new Error(`Expected a thermostat mode between 0 and ${max}`);
  if (value !== 0 && value !== runningThermostatMode(entry))
    throw new Error('NTD mode must match the installation heating/cooling changeover');
  return value;
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

// -----------------------------------------------------------------------------
// Integration configuration: defaults and normalization.
//
// Values come from the manifest `config_schema` filled in by the user, and
// arrive both through `getConfig()` and `onConfigUpdated()`. Normalizing them
// in one place keeps the rest of the code free of defensive checks.
// -----------------------------------------------------------------------------

export const DEFAULT_REFRESH_INTERVAL = 300;
const MIN_REFRESH_INTERVAL = 60;
const MAX_REFRESH_INTERVAL = 3600;

/**
 * @description Normalize the raw configuration object.
 * @param {object} [rawConfig] - The values as stored by Gladys.
 * @returns {{email: string, password: string, refreshInterval: number}} Config.
 * @example
 * normalizeConfig({ email: 'a@b.c', password: 'x', refresh_interval: 120 });
 */
export function normalizeConfig(rawConfig = {}) {
  const refreshInterval = Number(rawConfig.refresh_interval);
  return {
    email: typeof rawConfig.email === 'string' ? rawConfig.email.trim() : '',
    password: typeof rawConfig.password === 'string' ? rawConfig.password : '',
    refreshInterval: Number.isFinite(refreshInterval)
      ? Math.min(Math.max(refreshInterval, MIN_REFRESH_INTERVAL), MAX_REFRESH_INTERVAL)
      : DEFAULT_REFRESH_INTERVAL,
  };
}

/**
 * @description Tell whether the configuration carries usable credentials.
 * @param {object} config - A normalized configuration.
 * @returns {boolean} True when both email and password are set.
 * @example
 * hasCredentials({ email: 'a@b.c', password: 'x' }); // true
 */
export function hasCredentials(config) {
  return config.email.length > 0 && config.password.length > 0;
}

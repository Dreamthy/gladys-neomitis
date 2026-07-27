import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_REFRESH_INTERVAL, hasCredentials, normalizeConfig } from '../src/config.js';

test('an empty configuration is usable and reports missing credentials', () => {
  const config = normalizeConfig();
  assert.deepEqual(config, {
    email: '',
    password: '',
    refreshInterval: DEFAULT_REFRESH_INTERVAL,
  });
  assert.equal(hasCredentials(config), false);
});

test('the email is trimmed and both credentials are required', () => {
  assert.equal(normalizeConfig({ email: '  a@b.c  ' }).email, 'a@b.c');
  assert.equal(hasCredentials(normalizeConfig({ email: 'a@b.c' })), false);
  assert.equal(hasCredentials(normalizeConfig({ password: 'x' })), false);
  assert.equal(hasCredentials(normalizeConfig({ email: 'a@b.c', password: 'x' })), true);
});

test('the refresh interval is clamped to a sane range', () => {
  assert.equal(normalizeConfig({ refresh_interval: 120 }).refreshInterval, 120);
  assert.equal(normalizeConfig({ refresh_interval: 5 }).refreshInterval, 60);
  assert.equal(normalizeConfig({ refresh_interval: 99999 }).refreshInterval, 3600);
  assert.equal(
    normalizeConfig({ refresh_interval: 'nope' }).refreshInterval,
    DEFAULT_REFRESH_INTERVAL,
  );
});

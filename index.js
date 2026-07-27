// -----------------------------------------------------------------------------
// Entry point of the Neomitis / Axenco external integration.
//
// This file is wiring only: it connects the Gladys SDK to the Axenco client and
// to the translation layer in src/devices/. It knows nothing about presets,
// gateways or state keys.
//
// Data flow:
//   Axenco WebSocket push  -> buildStates()   -> gladys.publishStates()
//   Gladys command         -> handleSetValue() -> Axenco REST -> publishStates()
//   Periodic REST refresh  -> safety net when a push is missed
//
// The three GLADYS_* environment variables are injected by the supervisor and
// read by the SDK on its own.
// -----------------------------------------------------------------------------

import { GladysIntegration, createLogger, logger } from '@gladysassistant/integration-sdk';
import { AxencoClient, AxencoApiError } from './src/axenco/client.js';
import { hasCredentials, normalizeConfig } from './src/config.js';
import { createPublisher } from './src/gladys/publisher.js';
import { askedPatch, createReconciler } from './src/gladys/reconciler.js';
import {
  buildStates,
  describeDevice,
  featureKeyOf,
  handleSetValue,
  isSupportedDevice,
} from './src/devices/index.js';

// Backoff for the Axenco session itself: a cloud outage or a wrong password
// must never leave the integration idle, nor hammer the API.
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 600_000;
// The Axenco WebSocket announces a new or removed device; both mean the device
// list changed. Coalesce a burst of them into a single refresh.
const RESCAN_DEBOUNCE_MS = 5_000;
// Gladys replays `device-created` for every existing device on startup, and a
// device coming back online can flip several badges at once. Coalesce those
// bursts into one publish instead of one per device.
const TRANSPORT_DEBOUNCE_MS = 1_000;

const gladys = new GladysIntegration();
const axenco = new AxencoClient({ logger: createLogger({ name: 'axenco' }) });
const publisher = createPublisher(gladys);
const reconciler = createReconciler({ client: axenco, publisher, logger, buildStates });

let config = normalizeConfig();
/** axencoId -> registry entry (see describeDevice). */
let registry = new Map();
/** Gladys device external_id -> registry entry, for command routing. */
let entryByDeviceExternalId = new Map();
/** Unsubscribe functions of the per-device WebSocket listeners. */
let listenerCleanups = [];

let refreshTimer = null;
let retryTimer = null;
let rescanTimer = null;
let transportTimer = null;
let retryAttempt = 0;
let accountCallbacksRegistered = false;

// --- Handlers, registered before connect() -----------------------------------

gladys.onScanRequest(async () => {
  logger.info('Scan requested -> refreshing the Axenco device list');
  await refreshDevices({ force: true });
});

gladys.onSetValue(async (device, feature, value) => {
  const entry = entryByDeviceExternalId.get(device.external_id);
  if (!entry) {
    throw new Error(`Unknown device ${device.external_id}`);
  }
  const featureKey = featureKeyOf(entry, feature.external_id);
  logger.info(`Command ${entry.model}/${featureKey} = ${value}`);

  // The device layer records what it asked for in entry.state, so diffing
  // around the call gives exactly the Axenco keys this command wrote — which
  // is what the reconciliation must check, and nothing else.
  const before = { ...entry.state };
  const states = await handleSetValue(axenco, entry, featureKey, value);
  await publisher.publishStates(states, { force: true });

  const asked = askedPatch(before, entry.state);
  if (Object.keys(asked).length === 0) {
    // Gladys asked for a value the device was already on. Worth saying: it
    // means the switch in Gladys had drifted away from the hardware.
    logger.info(`${entry.model}/${featureKey}: already at that value, nothing sent to the device`);
  }
  reconciler.schedule(entry, featureKey, asked);
});

// A device only exists in Gladys once the user creates it from the Discovery
// screen, and Axenco only pushes on change: without this, a fresh device shows
// "no recent value" until something physically moves.
gladys.onDeviceCreated(async (device) => {
  const entry = entryByDeviceExternalId.get(device.external_id);
  if (!entry) {
    return;
  }
  logger.info(`Device created in Gladys -> seeding ${entry.model} with its known state`);
  await publisher.publishStates(buildStates(entry, entry.state), { force: true });
  // The transport badge is a device param, so it only exists once the device
  // does. Without this, a freshly created device carries no badge until the
  // next periodic refresh — up to `refresh_interval` later.
  scheduleTransportPublish();
});

gladys.onConfigUpdated(async (newConfig) => {
  logger.info('Configuration updated -> reconnecting to Axenco');
  config = normalizeConfig(newConfig);
  await initialize();
});

gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
  } catch (err) {
    logger.error('Could not read the integration configuration', err);
  }
  await initialize();
});

gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopTimers();
  axenco.disconnectWebSocket();
});

// --- Lifecycle ---------------------------------------------------------------

/**
 * @description (Re)establish the Axenco session: log in, open the push
 * channel, publish the devices. Retries with a backoff when it fails, so a
 * cloud outage or a wrong password never leaves the integration idle.
 * @returns {Promise<void>} Resolves once initialized, or once a retry is armed.
 * @example
 * await initialize();
 */
async function initialize() {
  stopTimers();

  if (!hasCredentials(config)) {
    logger.warn('No credentials configured yet');
    await reportDisconnected({
      en: 'Enter your MyNeomitis email address and password in the configuration.',
      fr: 'Renseignez votre adresse e-mail et votre mot de passe MyNeomitis dans la configuration.',
    });
    return;
  }

  try {
    await axenco.login(config.email, config.password);
    axenco.connectWebSocket();
    registerAccountCallbacks();
    await refreshDevices({ force: true });
    retryAttempt = 0;
    await gladys.setConnectionStatus(true);
    refreshTimer = setInterval(() => {
      refreshDevices({ force: true }).catch((err) => logger.error('Periodic refresh failed', err));
    }, config.refreshInterval * 1000);
    logger.info(`Connected to Axenco, refreshing every ${config.refreshInterval}s`);
  } catch (err) {
    const invalidCredentials = err instanceof AxencoApiError && err.status === 401;
    logger.error('Connection to Axenco failed', err);
    await reportDisconnected(
      invalidCredentials
        ? {
            en: 'MyNeomitis rejected these credentials, please check them.',
            fr: 'MyNeomitis a refusé ces identifiants, veuillez les vérifier.',
          }
        : {
            en: 'Cannot reach MyNeomitis, retrying automatically.',
            fr: 'MyNeomitis est injoignable, nouvelle tentative automatique.',
          },
    );
    scheduleRetry();
  }
}

/**
 * @description Read the Axenco device list, rebuild the registry and publish
 * everything Gladys needs: discovered devices, transports and states.
 * @param {object} [options] - Options.
 * @param {boolean} [options.force] - Bypass the client-side device cache.
 * @returns {Promise<void>} Resolves once published.
 * @example
 * await refreshDevices({ force: true });
 */
async function refreshDevices({ force = false } = {}) {
  // Watchdog: the push channel is what makes this integration real time, and
  // a silent loss of it degrades everything to this very refresh. Check it
  // here rather than trusting it to stay up.
  axenco.ensureWebSocket();

  const axencoDevices = await axenco.getDevices(force);
  const supported = axencoDevices.filter(isSupportedDevice);
  const skipped = axencoDevices.length - supported.length;
  logger.info(
    `${supported.length} supported device(s)${skipped > 0 ? `, ${skipped} ignored` : ''}` +
      ` | push channel: ${axenco.isWebSocketConnected() ? 'connected' : 'DOWN'}` +
      `${axenco.lastPushAt ? `, last push ${Math.round((Date.now() - axenco.lastPushAt) / 1000)}s ago` : ', no push received yet'}`,
  );

  registry = new Map();
  entryByDeviceExternalId = new Map();
  for (const axencoDevice of supported) {
    const entry = describeDevice(gladys, axencoDevice);
    registry.set(entry.axencoId, entry);
    entryByDeviceExternalId.set(entry.ids.device, entry);
  }

  await gladys.publishDiscoveredDevices([...registry.values()].map((entry) => entry.gladysDevice));
  await publishAllTransports();
  subscribeToPushUpdates();

  const states = [...registry.values()].flatMap((entry) => buildStates(entry, entry.state));
  await publisher.publishStates(states);
}

/**
 * Subscribe to the Axenco push channel, one listener per device. Rebuilt from
 * scratch on every refresh so a device that disappeared stops being watched.
 */
function subscribeToPushUpdates() {
  listenerCleanups.forEach((cleanup) => cleanup());
  axenco.clearListeners();
  listenerCleanups = [...registry.values()].map((entry) =>
    axenco.registerListener(entry.axencoId, (patch) => {
      if (!patch || typeof patch !== 'object') {
        return;
      }
      if (typeof patch.connected === 'boolean' && patch.connected !== entry.connected) {
        entry.connected = patch.connected;
        scheduleTransportPublish();
      }
      Object.assign(entry.state, patch);
      publisher
        .publishStates(buildStates(entry, patch))
        .catch((err) => logger.error(`Failed to publish a push update for ${entry.axencoId}`, err));
    }),
  );
}

/** Watch the account-wide events: a device was linked to, or unlinked from, it. */
function registerAccountCallbacks() {
  if (accountCallbacksRegistered) {
    return;
  }
  accountCallbacksRegistered = true;

  // The client renews the access token on its own, but when the refresh token
  // itself is dead only a full login recovers — and only we hold the
  // credentials.
  axenco.registerAuthFailureCallback(() => {
    logger.warn('Axenco session lost beyond refresh -> logging in again');
    initialize().catch((err) => logger.error('Re-login failed', err));
  });

  const rescan = () => {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      refreshDevices({ force: true }).catch((err) =>
        logger.error('Refresh after a device list change failed', err),
      );
    }, RESCAN_DEBOUNCE_MS);
  };
  axenco.registerDiscoveryCallback(rescan);
  axenco.registerRemovalCallback(rescan);
}

// --- Publishing ---------------------------------------------------------------

/** Publish the transport badge of every device currently in the registry. */
async function publishAllTransports() {
  await publisher.publishTransports(registry.values());
}

/** Same, coalescing a burst of triggers into a single publish. */
function scheduleTransportPublish() {
  clearTimeout(transportTimer);
  transportTimer = setTimeout(() => {
    transportTimer = null;
    publishAllTransports().catch((err) => logger.error('Failed to publish transports', err));
  }, TRANSPORT_DEBOUNCE_MS);
}

async function reportDisconnected(message) {
  try {
    await gladys.setConnectionStatus(false, message);
  } catch (err) {
    logger.error('Could not report the connection status', err);
  }
}

function scheduleRetry() {
  const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** retryAttempt, RETRY_MAX_DELAY_MS);
  retryAttempt += 1;
  logger.info(`Retrying the Axenco connection in ${Math.round(delay / 1000)}s`);
  retryTimer = setTimeout(() => {
    initialize().catch((err) => logger.error('Retry failed', err));
  }, delay);
}

function stopTimers() {
  clearInterval(refreshTimer);
  clearTimeout(retryTimer);
  clearTimeout(rescanTimer);
  clearTimeout(transportTimer);
  transportTimer = null;
  reconciler.cancelAll();
  refreshTimer = null;
  retryTimer = null;
  rescanTimer = null;
}

// --- Startup -----------------------------------------------------------------

logger.info('Starting the Neomitis integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection to Gladys failed', err);
  process.exit(1);
});

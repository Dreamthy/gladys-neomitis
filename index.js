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
import { createControlStore } from './src/gladys/control-store.js';
import { createDeviceQueue } from './src/gladys/queue.js';
import { createThermostatControl } from './src/gladys/thermostat.js';
import { registerSurfaces } from './src/gladys/surfaces.js';
import { fileURLToPath } from 'node:url';
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

export async function createIntegration(options = {}) {
  const gladys = options.gladys || new GladysIntegration();
  const axenco = options.axenco || new AxencoClient({ logger: createLogger({ name: 'axenco' }) });
  const publisher = createPublisher(gladys);
  const enqueue = createDeviceQueue();
  let closing = false;
  const store =
    options.store ||
    (await createControlStore(
      process.env.NEOMITIS_DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data' : '.data'),
    ));
  const reconciler = createReconciler({
    client: axenco,
    publisher,
    logger,
    buildStates: confirmedStates,
    getEntry: createdEntryById,
    onFailure: commandFailure,
  });
  const thermostat = createThermostatControl({
    client: axenco,
    store,
    enqueue,
    getEntry: createdEntryById,
    reconcile: (...args) => {
      if (!closing) reconciler.schedule(...args);
    },
    failure: commandFailure,
  });

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
  let restReachable = false;
  let lastSuccessAt = null;
  let refreshInFlight = null;
  let initialization = Promise.resolve();

  function createdEntryById(id) {
    if (closing) return null;
    const entry = registry.get(id);
    return entry && gladys.devices.some((device) => device.external_id === entry.ids.device)
      ? entry
      : null;
  }

  function confirmedStates(entry, patch) {
    Object.assign(entry.observedState, patch);
    return [...buildStates(entry, patch), ...thermostat.observe(entry, patch)];
  }

  async function commandFailure(entry, key, error) {
    logger.warn(`${entry.model}/${key}: ${error.message}`);
    try {
      await gladys.publishSceneEvent('command_failed', {
        device: entry.ids.device,
        feature: key,
        reason: error.message.slice(0, 500),
      });
      await gladys.requestWidgetRefresh('heater');
    } catch (err) {
      logger.error('Could not publish command failure', err);
    }
  }

  function findCreatedEntry(externalId) {
    const entry = entryByDeviceExternalId.get(externalId);
    if (!entry || !gladys.devices.some((d) => d.external_id === externalId)) {
      throw new Error('Select a device already created in Gladys');
    }
    return entry;
  }

  async function command(externalId, featureKey, value) {
    if (closing) throw new Error('Integration is stopping');
    const selectedEntry = findCreatedEntry(externalId);
    return enqueue(selectedEntry.axencoId, async () => {
      if (closing) throw new Error('Integration is stopping');
      const entry = findCreatedEntry(externalId);
      const device = gladys.devices.find((d) => d.external_id === externalId);
      if (
        !device.features.some(
          (f) => f.external_id === entry.ids.feature(featureKey) && !f.read_only,
        )
      ) {
        throw new Error('Feature unavailable: update the device from Discovery first');
      }
      try {
        let states;
        if (thermostat.handles(featureKey)) {
          states = await thermostat.command(entry, featureKey, value);
        } else {
          const before = { ...entry.state };
          states = await handleSetValue(axenco, entry, featureKey, value);
          if (!closing) reconciler.schedule(entry, featureKey, askedPatch(before, entry.state));
        }
        await publisher.publishStates(states, { force: true });
        await gladys.requestWidgetRefresh('heater');
      } catch (err) {
        await commandFailure(entry, featureKey, err);
        throw err;
      }
    }).catch(async (error) => {
      if (['QUEUE_FULL', 'QUEUE_EXPIRED'].includes(error.code))
        await commandFailure(selectedEntry, featureKey, error);
      throw error;
    });
  }

  registerSurfaces(gladys, {
    findEntry: findCreatedEntry,
    command,
    status: () => ({ restReachable, pushConnected: axenco.isWebSocketConnected(), lastSuccessAt }),
  });

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

    await command(device.external_id, featureKey, value);
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
    publisher.forget(device.external_id);
    await publisher.publishStates(confirmedStates(entry, entry.observedState), { force: true });
    // The transport badge is a device param, so it only exists once the device
    // does. Without this, a freshly created device carries no badge until the
    // next periodic refresh — up to `refresh_interval` later.
    scheduleTransportPublish();
  });

  gladys.onDeviceUpdated(async (device) => {
    publisher.forget(device.external_id);
    const entry = entryByDeviceExternalId.get(device.external_id);
    if (entry)
      await publisher.publishStates(confirmedStates(entry, entry.observedState), { force: true });
  });
  gladys.onDeviceDeleted((device) => {
    publisher.forget(device.external_id);
    const entry = entryByDeviceExternalId.get(device.external_id);
    if (entry) {
      thermostat.forget(entry.axencoId);
      reconciler.cancelDevice(entry.axencoId);
    }
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

  if (options.handleShutdown !== false)
    gladys.handleShutdown((signal) => {
      logger.info(`Received ${signal} -> graceful shutdown`);
      closing = true;
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
  function initialize() {
    initialization = initialization.catch(() => {}).then(initializeSession);
    return initialization;
  }

  async function initializeSession() {
    if (closing) return;
    stopTimers();
    axenco.disconnectWebSocket();
    restReachable = false;

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
      if (closing) return;
      axenco.connectWebSocket();
      registerAccountCallbacks();
      await refreshDevices({ force: true });
      if (closing) return;
      retryAttempt = 0;
      await gladys.setConnectionStatus(true);
      refreshTimer = setInterval(() => {
        refreshDevices({ force: true }).catch((err) =>
          logger.error('Periodic refresh failed', err),
        );
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
      await publishAllTransports();
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
  function refreshDevices(options = {}) {
    if (!refreshInFlight) {
      refreshInFlight = refreshDevicesOnce(options).finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  async function refreshDevicesOnce({ force = false } = {}) {
    if (closing) return;
    // Watchdog: the push channel is what makes this integration real time, and
    // a silent loss of it degrades everything to this very refresh. Check it
    // here rather than trusting it to stay up.
    axenco.ensureWebSocket();

    let axencoDevices;
    try {
      axencoDevices = await axenco.getDevices(force);
      if (closing) return;
      restReachable = true;
      lastSuccessAt = new Date().toISOString();
      await gladys.setConnectionStatus(true);
    } catch (err) {
      restReachable = false;
      await reportDisconnected({
        en: 'MyNeomitis unavailable; retrying automatically.',
        fr: 'MyNeomitis indisponible ; nouvelle tentative automatique.',
      });
      await publishAllTransports();
      throw err;
    }
    const supported = axencoDevices.filter(isSupportedDevice);
    const skipped = axencoDevices.length - supported.length;
    logger.info(
      `${supported.length} supported device(s)${skipped > 0 ? `, ${skipped} ignored` : ''}` +
        ` | push channel: ${axenco.isWebSocketConnected() ? 'connected' : 'DOWN'}` +
        `${axenco.lastPushAt ? `, last push ${Math.round((Date.now() - axenco.lastPushAt) / 1000)}s ago` : ', no push received yet'}`,
    );

    const previous = registry;
    registry = new Map();
    entryByDeviceExternalId = new Map();
    for (const axencoDevice of supported) {
      const description = describeDevice(gladys, axencoDevice, config);
      const entry = Object.assign(previous.get(axencoDevice._id) || {}, description);
      registry.set(entry.axencoId, entry);
      entryByDeviceExternalId.set(entry.ids.device, entry);
    }
    for (const id of previous.keys()) {
      if (!registry.has(id)) {
        thermostat.forget(id);
        reconciler.cancelDevice(id);
      }
    }

    await gladys.publishDiscoveredDevices(
      [...registry.values()].map((entry) => entry.gladysDevice),
    );
    await publishAllTransports();
    subscribeToPushUpdates();

    const states = [...registry.values()].flatMap((entry) => confirmedStates(entry, entry.state));
    await publisher.publishStates(states, { heartbeat: true });
    await gladys.requestWidgetRefresh('heater');
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
          .publishStates(confirmedStates(entry, patch))
          .catch((err) =>
            logger.error(`Failed to publish a push update for ${entry.axencoId}`, err),
          );
        Promise.resolve()
          .then(() => gladys.requestWidgetRefresh('heater'))
          .catch((err) => logger.error('Widget refresh failed', err));
      }),
    );
  }

  /** Watch the account-wide events: a device was linked to, or unlinked from, it. */
  function registerAccountCallbacks() {
    if (accountCallbacksRegistered) {
      return;
    }
    accountCallbacksRegistered = true;
    axenco.registerConnectionCallback(scheduleTransportPublish);

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
    await publisher.publishTransports(registry.values(), {
      reachable: restReachable,
      pushConnected: axenco.isWebSocketConnected(),
    });
  }

  /** Same, coalescing a burst of triggers into a single publish. */
  function scheduleTransportPublish() {
    if (closing) return;
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
    if (closing) return;
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
    thermostat.cancelAll();
    refreshTimer = null;
    retryTimer = null;
    rescanTimer = null;
  }

  return {
    start: () => gladys.connect(),
    refresh: () => refreshDevices({ force: true }),
    command,
    async stop() {
      closing = true;
      stopTimers();
      listenerCleanups.forEach((cleanup) => cleanup());
      axenco.disconnectWebSocket();
      await gladys.disconnect();
    },
  };
}

// Importing the factory in tests never starts a real session.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  logger.info('Starting the Neomitis integration...');
  const integration = await createIntegration();
  integration.start().catch((err) => {
    logger.error('Initial connection to Gladys failed', err);
    process.exit(1);
  });
}

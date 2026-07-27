// -----------------------------------------------------------------------------
// Axenco cloud client.
//
// JavaScript port of `pyaxencoapi/api.py`: email/password login, automatic
// token refresh on 401, the REST endpoints used by the Home Assistant
// `myneomitis` integration, and the Socket.IO channel that pushes device
// updates in real time.
//
// The endpoint paths, payload shapes and request headers are reproduced
// verbatim from the Python library — they are the contract the Axenco backend
// validates, not implementation details we are free to tidy up.
// -----------------------------------------------------------------------------

import { io } from 'socket.io-client';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  API_BASE,
  APPLICATION,
  APPLICATION_VERSION,
  PRESETS,
  SOCKET_IO_PATH,
  SOURCE_ID,
  SOURCE_TYPE,
} from './const.js';
import { extractGatewayId, findChildren, getRfidById } from './utils.js';

const AUTH_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DEVICES_CACHE_TTL_MS = 300_000;
const SOCKET_RECONNECT_BASE_DELAY_MS = 5_000;
const SOCKET_RECONNECT_MAX_DELAY_MS = 300_000;

/** An HTTP error returned by the Axenco API, carrying its status code. */
export class AxencoApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AxencoApiError';
    this.status = status;
  }
}

export class AxencoClient {
  constructor({ logger } = {}) {
    this.logger = logger || createLogger({ name: 'axenco' });
    this.token = null;
    this.refreshToken = null;
    this.userId = null;
    this.socket = null;

    // Socket.IO reconnection is ours to drive, see `openSocket`.
    this.socketWanted = false;
    // A Socket.IO handshake takes a few hundred ms; without this the watchdog
    // sees "not connected" and tears down a socket that was merely connecting,
    // burning a token refresh for nothing.
    this.socketConnecting = false;
    this.socketReconnectAttempt = 0;
    this.socketReconnectTimer = null;
    this.lastPushAt = null;

    // Device list cache, mirroring `_devices_cache` / `_last_fetch`.
    this.devicesCache = [];
    this.lastFetch = 0;

    // deviceId -> Set<callback>, plus the account-wide callbacks.
    this.listeners = new Map();
    this.discoveryCallbacks = [];
    this.removalCallbacks = [];
    this.authFailureCallbacks = [];
  }

  // --- Authentication --------------------------------------------------------

  /**
   * @description Authenticate against the Axenco API and keep the tokens.
   * @param {string} email - Account email address.
   * @param {string} password - Account password.
   * @returns {Promise<void>} Resolves once the tokens are stored.
   * @example
   * await client.login('user@example.com', 'secret');
   */
  async login(email, password) {
    const response = await fetch(`${API_BASE}/v1/auth/login`, {
      method: 'POST',
      headers: { ...this.baseHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AxencoApiError(response.status, `Login failed with status ${response.status}`);
    }
    const result = await response.json();
    if (!result.token || !result.refresh_token || !result.id) {
      throw new Error('Unexpected login response format');
    }
    this.token = result.token;
    this.refreshToken = result.refresh_token;
    if (!this.userId) {
      this.userId = result.id;
    }
    this.applyTokenToSocket();
  }

  /**
   * @description Renew the access token with the refresh token.
   * @returns {Promise<void>} Resolves once the new token is stored.
   * @example
   * await client.refreshAuthToken();
   */
  async refreshAuthToken() {
    if (!this.refreshToken) {
      throw new Error('Missing refresh token');
    }
    const response = await fetch(`${API_BASE}/v1/auth/token`, {
      method: 'POST',
      headers: { ...this.baseHeaders(), Authorization: `Bearer ${this.refreshToken}` },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AxencoApiError(
        response.status,
        `Token refresh failed with status ${response.status}`,
      );
    }
    const result = await response.json();
    if (!result.token) {
      throw new Error('Invalid refresh response');
    }
    this.token = result.token;
    this.applyTokenToSocket();
    this.logger.debug('Token successfully refreshed');
  }

  /**
   * @description Invalidate the session server side and drop the local state.
   * @returns {Promise<void>} Resolves once the session is cleared.
   * @example
   * await client.logout();
   */
  async logout() {
    this.disconnectWebSocket();
    if (this.token) {
      try {
        await fetch(`${API_BASE}/v1/auth/logout`, {
          method: 'DELETE',
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
        });
      } catch (err) {
        this.logger.error('Error during logout', err);
      }
    }
    this.token = null;
    this.refreshToken = null;
    this.userId = null;
    this.devicesCache = [];
    this.lastFetch = 0;
    this.listeners.clear();
  }

  baseHeaders() {
    return {
      application: APPLICATION,
      'application-version': APPLICATION_VERSION,
      'source-type': SOURCE_TYPE,
      'source-id': SOURCE_ID,
    };
  }

  authHeaders() {
    return { ...this.baseHeaders(), Authorization: `Bearer ${this.token}` };
  }

  // --- REST ------------------------------------------------------------------

  /**
   * @description Perform an authenticated request, refreshing the token once
   * and replaying the call when the API answers 401 (the `auto_refresh_token`
   * decorator of the Python library).
   * @param {string} method - HTTP method.
   * @param {string} path - Path appended to the API base URL.
   * @param {object} [body] - JSON body to send, when any.
   * @returns {Promise<object|null>} The parsed JSON body, or null when empty.
   * @example
   * await client.request('GET', '/v1/devices/abc');
   */
  async request(method, path, body) {
    const send = async () => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (method === 'GET') {
        this.logger.debug(`-> ${method} ${path}`);
      } else {
        this.logger.info(`-> ${method} ${path} ${payload ?? ''}`);
      }
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          ...this.authHeaders(),
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) {
        // The body is where Axenco explains itself; a bare status code is not
        // enough to tell "wrong value" from "unsupported parameter".
        throw new AxencoApiError(
          response.status,
          `${method} ${path} failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ''}`,
        );
      }
      // Writes answer with the accepted state, which is how we can see the
      // device silently refusing a value it reported as valid. Logged at INFO,
      // not debug: writes only happen on a user action, so this is never noisy,
      // and `LOG_LEVEL` is not settable on an installed integration.
      if (method !== 'GET') {
        this.logger.info(`<- ${response.status} ${text.slice(0, 300)}`);
      }
      return text.length === 0 ? null : JSON.parse(text);
    };

    try {
      return await send();
    } catch (err) {
      if (err instanceof AxencoApiError && err.status === 401) {
        this.logger.debug('Token expired, attempting to refresh');
        await this.refreshAuthToken();
        return send();
      }
      throw err;
    }
  }

  /**
   * @description List the devices of the account. Cached for 5 minutes, like
   * the Python client, so the WebSocket child lookup stays cheap.
   * @param {boolean} [force] - Bypass the cache.
   * @returns {Promise<Array<object>>} The device list.
   * @example
   * const devices = await client.getDevices(true);
   */
  async getDevices(force = false) {
    if (!force && Date.now() - this.lastFetch < DEVICES_CACHE_TTL_MS) {
      return this.devicesCache;
    }
    const data = await this.request('GET', `/v1/users/${this.userId}/devices`);
    this.devicesCache = (data && data.devices) || [];
    this.lastFetch = Date.now();
    return this.devicesCache;
  }

  /**
   * @description Read the full state of one main device.
   * @param {string} deviceId - The device `_id`.
   * @returns {Promise<object|null>} The device state.
   * @example
   * await client.getDeviceState('65f...');
   */
  async getDeviceState(deviceId) {
    return this.request('GET', `/v1/devices/${deviceId}`);
  }

  /**
   * @description Read the state of the sub-devices behind a gateway.
   * @param {string|object} parents - The `parents` value of the sub-device.
   * @returns {Promise<object|null>} The sub-devices state.
   * @example
   * await client.getSubDeviceState(device.parents);
   */
  async getSubDeviceState(parents) {
    return this.request('GET', `/v1/devices/${this.gatewayId(parents)}/sub-devices`);
  }

  /**
   * @description Set the setpoint of a main device, creating a derogation.
   *
   * The payload is the one the official app sends, captured from its network
   * traffic: the three fields go together in a SINGLE call
   * `{targetTemp, overrideTemp, targetMode: 8}`. Writing `overrideTemp` alone
   * also works — measured, the device moves to mode 8 by itself — but there is
   * no reason to diverge from the client that is known to be right, and
   * `pyaxencoapi` sends neither `targetTemp` nor the mode here.
   * @param {string} deviceId - The device `_id`.
   * @param {number} temperature - The setpoint, in Celsius.
   * @returns {Promise<void>} Resolves once accepted by the API.
   * @example
   * await client.setDeviceTemperature('65f...', 20.5);
   */
  async setDeviceTemperature(deviceId, temperature) {
    await this.request('PATCH', `/v1/devices/${deviceId}/state`, {
      parameters: {
        targetTemp: temperature,
        overrideTemp: temperature,
        targetMode: PRESETS.setpoint.code,
      },
    });
  }

  /**
   * @description Set the three per-mode setpoints of a main device.
   *
   * Captured from the official app, which sends all three together even when
   * only one changed: `{"comfTemp":20,"ecoTemp":18,"antifTemp":7}`. We do the
   * same rather than send the single field that moved — the app is the client
   * known to be right, and a partial write has never been tested.
   *
   * These are the temperatures the MODES use. The derogation
   * (`setDeviceTemperature`) is a separate, temporary override.
   * @param {string} deviceId - The device `_id`.
   * @param {object} setpoints - `{ comfTemp, ecoTemp, antifTemp }`, all three.
   * @returns {Promise<void>} Resolves once accepted by the API.
   * @example
   * await client.setDeviceSetpoints('65f...', { comfTemp: 20, ecoTemp: 18, antifTemp: 7 });
   */
  async setDeviceSetpoints(deviceId, setpoints) {
    await this.request('PATCH', `/v1/devices/${deviceId}/state`, { parameters: setpoints });
  }

  /**
   * @description Set the setpoint of a sub-device (`targetTemp`).
   * @param {string|object} parents - The `parents` value of the sub-device.
   * @param {string} rfid - The sub-device `rfid`.
   * @param {number} temperature - The setpoint, in Celsius.
   * @returns {Promise<void>} Resolves once accepted by the API.
   * @example
   * await client.setSubDeviceTemperature(device.parents, 'A1B2', 20.5);
   */
  async setSubDeviceTemperature(parents, rfid, temperature) {
    await this.request('PATCH', `/v1/devices/${this.gatewayId(parents)}/sub-devices/state`, {
      parameters: { [rfid]: { targetTemp: temperature } },
    });
  }

  /**
   * @description Set the mode of a main device (`targetMode`).
   * @param {string} deviceId - The device `_id`.
   * @param {number} modeCode - The Axenco mode code.
   * @returns {Promise<void>} Resolves once accepted by the API.
   * @example
   * await client.setDeviceMode('65f...', 1);
   */
  async setDeviceMode(deviceId, modeCode) {
    await this.request('PATCH', `/v1/devices/${deviceId}/state`, {
      parameters: { targetMode: modeCode },
    });
  }

  /**
   * @description Set the mode of a sub-device (`targetMode`).
   * @param {string|object} parents - The `parents` value of the sub-device.
   * @param {string} rfid - The sub-device `rfid`.
   * @param {number} modeCode - The Axenco mode code.
   * @returns {Promise<void>} Resolves once accepted by the API.
   * @example
   * await client.setSubDeviceMode(device.parents, 'A1B2', 1);
   */
  async setSubDeviceMode(parents, rfid, modeCode) {
    await this.request('PATCH', `/v1/devices/${this.gatewayId(parents)}/sub-devices/state`, {
      parameters: { [rfid]: { targetMode: modeCode } },
    });
  }

  /**
   * @description Set the heating/cooling change-over of a UFH sub-device
   * (`changeOverUser`, a different state key than the other modes).
   * @param {string|object} parents - The `parents` value of the sub-device.
   * @param {string} rfid - The sub-device `rfid`.
   * @param {number} modeCode - 0 for heating, 1 for cooling.
   * @returns {Promise<void>} Resolves once accepted by the API.
   * @example
   * await client.setSubDeviceModeUfh(device.parents, 'A1B2', 1);
   */
  async setSubDeviceModeUfh(parents, rfid, modeCode) {
    await this.request('PATCH', `/v1/devices/${this.gatewayId(parents)}/sub-devices/state`, {
      parameters: { [rfid]: { changeOverUser: modeCode } },
    });
  }

  /**
   * @description Replace the weekly program of a device.
   * @param {string} deviceId - The device `_id`.
   * @param {object} programData - The program payload.
   * @returns {Promise<void>} Resolves once accepted by the API.
   * @example
   * await client.setDeviceProgram('65f...', program);
   */
  async setDeviceProgram(deviceId, programData) {
    await this.request('PATCH', `/v1/devices/${deviceId}/program`, {
      data: programData,
      redundancy: 'weekly',
    });
  }

  gatewayId(parents) {
    const gateway = extractGatewayId(parents);
    if (!gateway) {
      throw new Error('Invalid device parents: no gateway id');
    }
    return gateway;
  }

  // --- WebSocket -------------------------------------------------------------

  /**
   * @description Open the Socket.IO channel and keep it open for good.
   *
   * Reconnection CANNOT be left to socket.io-client here. The Axenco access
   * token travels in the handshake headers, and it is short lived; when the
   * socket re-handshakes with an expired one the server rejects it in a
   * namespace middleware ("Forbidden access!"). socket.io-client treats that
   * as terminal — `socket.js` handles `CONNECT_ERROR` with `destroy()` and
   * never calls `maybeReconnectOnOpen()`, and `destroy()` closes the manager
   * with `skipReconnect = true`. The channel would then stay dead forever and
   * the integration would silently degrade to the periodic REST refresh.
   *
   * So we own the loop: on any failure we refresh the token FIRST, then build
   * a brand new socket with fresh headers.
   * @returns {void}
   * @example
   * client.connectWebSocket();
   */
  connectWebSocket() {
    this.socketWanted = true;
    if (this.isWebSocketConnected()) {
      // Already live (a Gladys reconnection re-ran the whole init): keep the
      // channel, just make sure a future re-handshake uses the fresh token.
      this.applyTokenToSocket();
      return;
    }
    this.openSocket();
  }

  /**
   * @description Reopen the channel if it is not currently connected. Called
   * by the periodic refresh as a watchdog, so a channel lost in a way we did
   * not anticipate still comes back.
   * @returns {boolean} True when a reconnection was triggered.
   * @example
   * client.ensureWebSocket();
   */
  ensureWebSocket() {
    if (
      !this.socketWanted ||
      this.isWebSocketConnected() ||
      this.socketConnecting ||
      this.socketReconnectTimer
    ) {
      return false;
    }
    this.logger.warn('WebSocket is down, reconnecting');
    this.scheduleSocketReconnect();
    return true;
  }

  /** Whether the push channel is currently established. */
  isWebSocketConnected() {
    return Boolean(this.socket && this.socket.connected);
  }

  openSocket() {
    clearTimeout(this.socketReconnectTimer);
    this.socketReconnectTimer = null;
    this.teardownSocket();
    this.socketConnecting = true;
    this.socket = io(API_BASE, {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      query: { userId: this.userId },
      extraHeaders: this.authHeaders(),
      // Our own loop below drives the retries, with a token refresh in
      // between: socket.io's would replay the stale credential.
      reconnection: false,
    });

    this.socket.on('connect', () => {
      this.socketConnecting = false;
      this.socketReconnectAttempt = 0;
      this.logger.info('WebSocket connected to Axenco');
    });

    this.socket.on('disconnect', (reason) => {
      this.socketConnecting = false;
      this.logger.warn(`WebSocket disconnected from Axenco (${reason})`);
      // 'io client disconnect' is us calling disconnect(): stay down.
      if (reason !== 'io client disconnect') {
        this.scheduleSocketReconnect();
      }
    });

    this.socket.on('connect_error', (err) => {
      this.socketConnecting = false;
      this.logger.error('WebSocket connection error', err && err.message ? err.message : err);
      this.scheduleSocketReconnect();
    });

    // State pushes. `updateExtDevState` / `setExtDevState` are the sub-device
    // flavours of `update` / `setState`; the payload shape is identical.
    for (const event of ['setState', 'update', 'updateExtDevState', 'setExtDevState']) {
      this.socket.on(event, (data) => {
        this.lastPushAt = Date.now();
        this.logger.debug(`WS ${event} received`, data);
        this.notifyUpdate(data && data.objectId, data && data.data).catch((err) =>
          this.logger.error(`Failed to handle WS ${event}`, err),
        );
      });
    }

    this.socket.on('setProgram', (data) => {
      this.lastPushAt = Date.now();
      this.logger.debug('WS setProgram received', data);
      this.notifyUpdate(data && data.objectId, { program: data && data.data }).catch((err) =>
        this.logger.error('Failed to handle WS setProgram', err),
      );
    });

    this.socket.on('discover', (data) => this.logger.debug('WS discover received', data));

    this.socket.on('link', (data) => {
      const devices = ((data && data.data) || {}).devices || [];
      this.logger.debug('WS link received', data);
      this.discoveryCallbacks.forEach((callback) => callback(devices));
    });

    this.socket.on('unlink', (data) => {
      this.logger.debug('WS unlink received', data);
      this.removalCallbacks.forEach((callback) => callback(data && data.objectId));
    });
  }

  /**
   * Retry with a backoff, refreshing the token before each attempt: an
   * expired credential in the handshake headers is the expected reason for a
   * rejection, and reconnecting without renewing it would just fail again.
   */
  scheduleSocketReconnect() {
    if (!this.socketWanted || this.socketReconnectTimer) {
      return;
    }
    const delay = Math.min(
      SOCKET_RECONNECT_BASE_DELAY_MS * 2 ** this.socketReconnectAttempt,
      SOCKET_RECONNECT_MAX_DELAY_MS,
    );
    this.socketReconnectAttempt += 1;
    this.logger.info(`Reconnecting the WebSocket in ${Math.round(delay / 1000)}s`);

    this.socketReconnectTimer = setTimeout(async () => {
      this.socketReconnectTimer = null;
      if (!this.socketWanted) {
        return;
      }
      try {
        await this.refreshAuthToken();
      } catch (err) {
        // The refresh token itself is gone: only a full login can recover,
        // and that belongs to the caller which owns the credentials.
        this.logger.error('Could not refresh the token before reconnecting', err);
        this.authFailureCallbacks.forEach((callback) => callback(err));
        return;
      }
      this.openSocket();
    }, delay);
  }

  teardownSocket() {
    if (!this.socket) {
      return;
    }
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
  }

  /** Close the Socket.IO channel, without reconnection. */
  disconnectWebSocket() {
    this.socketWanted = false;
    this.socketConnecting = false;
    clearTimeout(this.socketReconnectTimer);
    this.socketReconnectTimer = null;
    this.socketReconnectAttempt = 0;
    this.teardownSocket();
  }

  /**
   * Keep the handshake headers of the live manager in sync with the current
   * token, so a re-handshake does not replay an expired credential.
   */
  applyTokenToSocket() {
    if (this.socket && this.socket.io && this.socket.io.opts) {
      this.socket.io.opts.extraHeaders = this.authHeaders();
    }
  }

  /**
   * @description Register a callback fired when the session cannot be renewed
   * from the client alone (the refresh token expired): the owner must log in
   * again with the user credentials.
   * @param {Function} callback - Called with the underlying error.
   * @returns {void}
   * @example
   * client.registerAuthFailureCallback(() => initialize());
   */
  registerAuthFailureCallback(callback) {
    this.authFailureCallbacks.push(callback);
  }

  /**
   * @description Subscribe to the updates of one device.
   * @param {string} deviceId - The device `_id`.
   * @param {Function} callback - Called with the new partial state.
   * @returns {Function} Unsubscribe function.
   * @example
   * const off = client.registerListener('65f...', (state) => {});
   */
  registerListener(deviceId, callback) {
    if (!this.listeners.has(deviceId)) {
      this.listeners.set(deviceId, new Set());
    }
    this.listeners.get(deviceId).add(callback);
    return () => {
      const callbacks = this.listeners.get(deviceId);
      if (!callbacks) {
        return;
      }
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.listeners.delete(deviceId);
      }
    };
  }

  /** Drop every device listener (used when the device list is rebuilt). */
  clearListeners() {
    this.listeners.clear();
  }

  registerDiscoveryCallback(callback) {
    this.discoveryCallbacks.push(callback);
  }

  registerRemovalCallback(callback) {
    this.removalCallbacks.push(callback);
  }

  /**
   * @description Dispatch a state update to the device it belongs to, then to
   * its children: a gateway event carries the state of the sub-devices behind
   * it, and those have no event of their own.
   * @param {string} deviceId - The `_id` carried by the event (`objectId`).
   * @param {object} newState - The partial state pushed by Axenco.
   * @returns {Promise<void>} Resolves once every listener has been called.
   * @example
   * await client.notifyUpdate('65f...', { currentTemp: 19.5 });
   */
  async notifyUpdate(deviceId, newState) {
    if (!deviceId) {
      return;
    }
    this.emitTo(deviceId, newState);

    const devices = await this.getDevices();
    const deviceRfid = getRfidById(devices, deviceId);
    if (!deviceRfid) {
      return;
    }
    for (const childId of findChildren(devices, deviceRfid)) {
      this.emitTo(childId, newState);
    }
  }

  emitTo(deviceId, newState) {
    const callbacks = this.listeners.get(deviceId);
    if (!callbacks) {
      return;
    }
    for (const callback of callbacks) {
      try {
        callback(newState);
      } catch (err) {
        this.logger.error(`Listener failed for device ${deviceId}`, err);
      }
    }
  }
}

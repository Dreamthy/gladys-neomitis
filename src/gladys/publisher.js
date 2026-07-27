// -----------------------------------------------------------------------------
// Publishing to Gladys: deduplication, batching and the transport badge.
//
// Extracted from index.js so it can be unit tested. It has no Axenco knowledge
// and no timers — it only knows how to send states and transports to the host
// API within its limits.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';

// Host API batch limits, enforced by the SDK and by Gladys itself.
const MAX_STATES_PER_REQUEST = 100;
const MAX_TRANSPORTS_PER_REQUEST = 100;

/**
 * @description Read the comparable value out of a state entry: numeric states
 * and text states live under different keys.
 * @param {object} state - A state entry.
 * @returns {number|string|undefined} The value to compare.
 * @example
 * valueOf({ device_feature_external_id: 'x', text: 'Auto' }); // 'Auto'
 */
function valueOf(state) {
  return state.state === undefined ? state.text : state.state;
}

/**
 * @description Build the publisher bound to one SDK instance.
 * @param {object} gladys - The `GladysIntegration` instance.
 * @returns {object} `{ publishStates, publishTransports, forget }`.
 * @example
 * const publisher = createPublisher(gladys);
 */
export function createPublisher(gladys) {
  /** Last value published per feature, so unchanged values cost nothing. */
  const lastPublished = new Map();

  return {
    /**
     * @description Publish states, dropping the ones that did not change and
     * chunking the rest.
     *
     * Deduplication is what keeps a fleet under the 300 states/minute limit:
     * the periodic refresh republishes a full snapshot every cycle, and almost
     * none of it has moved.
     *
     * `force` bypasses it, and is needed after a user action: the job there is
     * to make the UI match reality, not to report a change. Turning a preset
     * switch off is the case that matters — it is a no-op on the Axenco side,
     * so the very same value is republished to snap the switch back, which
     * deduplication would otherwise swallow.
     * @param {Array<object>} states - States to publish.
     * @param {object} [options] - Options.
     * @param {boolean} [options.force] - Publish even unchanged values.
     * @returns {Promise<void>} Resolves once every chunk is sent.
     * @example
     * await publisher.publishStates(states, { force: true });
     */
    async publishStates(states, { force = false } = {}) {
      const changed = force
        ? states
        : states.filter(
            (state) => lastPublished.get(state.device_feature_external_id) !== valueOf(state),
          );
      if (changed.length === 0) {
        return;
      }
      for (let index = 0; index < changed.length; index += MAX_STATES_PER_REQUEST) {
        const chunk = changed.slice(index, index + MAX_STATES_PER_REQUEST);
        await gladys.publishStates(chunk);
        // Remember only what Gladys actually accepted: a batch that threw must
        // be retried on the next refresh, not cached as if it had been sent.
        for (const state of chunk) {
          lastPublished.set(state.device_feature_external_id, valueOf(state));
        }
      }
    },

    /**
     * @description Publish the per-device transport badge.
     *
     * Axenco is cloud-only, so the badge carries the one thing that varies:
     * whether the device is reachable. The nominal `cloud` value is what
     * CLEARS a previous `unreachable`, which is why it is published too.
     * @param {Iterable<object>} entries - Registry entries.
     * @returns {Promise<void>} Resolves once every chunk is sent.
     * @example
     * await publisher.publishTransports(registry.values());
     */
    async publishTransports(entries) {
      const payload = [...entries].map((entry) => ({
        external_id: entry.ids.device,
        transport: entry.connected ? DEVICE_TRANSPORTS.CLOUD : DEVICE_TRANSPORTS.UNREACHABLE,
      }));
      for (let index = 0; index < payload.length; index += MAX_TRANSPORTS_PER_REQUEST) {
        await gladys.publishTransports(payload.slice(index, index + MAX_TRANSPORTS_PER_REQUEST));
      }
    },
  };
}

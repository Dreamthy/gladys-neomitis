// -----------------------------------------------------------------------------
// Post-command reconciliation.
//
// The states published straight after a command are optimistic: they say what
// we ASKED for. That is a lie in two measured situations — Axenco answers 200
// to values the device then ignores, and these heaters drop commands sent a
// few seconds apart. Without a check, a switch stays where the user put it
// while the hardware never moved, and nothing says so.
//
// So every command schedules a re-read. Deliberately OUT of the command path:
// the Gladys ack is due in 5 s while a device takes 2-30 s to settle, so
// blocking would fail the command that is about to succeed.
//
// Extracted from index.js because this is where three bugs lived — a
// tautological confirmation check, a timer keyed per device instead of per
// feature, and array comparison by reference — none of which any test covered.
// -----------------------------------------------------------------------------

// Long enough for a heater to settle (measured 2-30 s). 12 s was tried first
// and reported refusals on commands that had simply not landed yet.
const RECONCILE_DELAY_MS = 30_000;

// Arrays and objects in the device state (driftCorrections, infoSystem,
// occupancyRanges…) compare by reference, so they always look different.
// Commands only ever write primitives.
const PRIMITIVE_TYPES = new Set(['number', 'boolean', 'string']);

/**
 * @description Extract the Axenco keys a command actually wrote, by diffing the
 * device state around the call. The device layer records what it asked for in
 * `entry.state`, so the difference is exactly the command's footprint — and
 * nothing else, which is what the check must compare.
 * @param {object} before - Snapshot of `entry.state` taken before the command.
 * @param {object} after - `entry.state` after the command.
 * @returns {object} The written keys and their asked values.
 * @example
 * askedPatch({ targetMode: 3 }, { targetMode: 1 }); // { targetMode: 1 }
 */
export function askedPatch(before, after) {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => before[key] !== value && PRIMITIVE_TYPES.has(typeof value),
    ),
  );
}

/**
 * @description Build the reconciler.
 * @param {object} deps - Dependencies.
 * @param {object} deps.client - The Axenco client.
 * @param {object} deps.publisher - The Gladys publisher.
 * @param {object} deps.logger - Logger.
 * @param {Function} deps.buildStates - `(entry, patch) => states`.
 * @param {number} [deps.delayMs] - Override the settle delay, for tests.
 * @returns {object} `{ schedule, cancelAll }`.
 * @example
 * const reconciler = createReconciler({ client, publisher, logger, buildStates });
 */
export function createReconciler({
  client,
  publisher,
  logger,
  buildStates,
  delayMs = RECONCILE_DELAY_MS,
}) {
  /** `${axencoId}:${featureKey}` -> pending timer. */
  const timers = new Map();

  return {
    /**
     * @description Re-read a device after a command and publish what it
     * ACTUALLY reports, logging the outcome either way — Axenco answers 200
     * whether or not the device obeyed, so this is the only place the
     * difference shows.
     * @param {object} entry - The registry entry that was commanded.
     * @param {string} featureKey - The feature that was written.
     * @param {object} asked - The keys the command wrote, from `askedPatch`.
     * @returns {void}
     * @example
     * reconciler.schedule(entry, 'preset:auto', { targetMode: 0 });
     */
    schedule(entry, featureKey, asked) {
      if (entry.profile.subDevice) {
        // Sub-device state comes from the gateway under a shape we have never
        // observed; guessing at it would be worse than not checking.
        return;
      }
      // Keyed per FEATURE, not per device: with a 30 s delay, a user clicking
      // two switches in a row would otherwise cancel the first check and we
      // would learn nothing about it.
      const timerKey = `${entry.axencoId}:${featureKey}`;
      clearTimeout(timers.get(timerKey));
      timers.set(
        timerKey,
        setTimeout(async () => {
          timers.delete(timerKey);
          try {
            const fresh = ((await client.getDeviceState(entry.axencoId)) || {}).state;
            if (!fresh) {
              return;
            }
            const watched = Object.keys(asked);
            const refused = watched.filter((key) => fresh[key] !== asked[key]);
            if (refused.length > 0) {
              logger.warn(
                `${entry.model}/${featureKey}: Axenco answered 200 but the device did not apply it — ` +
                  refused.map((key) => `${key}: asked ${asked[key]}, got ${fresh[key]}`).join(', '),
              );
            } else if (watched.length > 0) {
              logger.info(
                `${entry.model}/${featureKey}: confirmed by the device — ` +
                  watched.map((key) => `${key}=${fresh[key]}`).join(' '),
              );
            }
            Object.assign(entry.state, fresh);
            await publisher.publishStates(buildStates(entry, fresh), { force: true });
          } catch (err) {
            logger.error(`Reconciliation failed for ${entry.axencoId}`, err);
          }
        }, delayMs),
      );
    },

    /** Drop every pending check, on shutdown or on a session restart. */
    cancelAll() {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    },
  };
}

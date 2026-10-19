import { PRESETS, presetKeyFromCode } from '../axenco/const.js';
import { STANDARD, binary, nativeThermostat, validateTemperature } from '../devices/standard.js';

/** Actual EV30 setpoint for the reported mode, rather than a stale saved override. */
export function effectiveTarget(state) {
  const key = { 1: 'comfTemp', 60: 'comfTemp', 2: 'ecoTemp', 61: 'ecoTemp', 3: 'antifTemp' }[
    state.targetMode
  ];
  const value = key && state[key];
  return Number.isFinite(value) ? value : (state.overrideTemp ?? state.targetTemp);
}

/** Native controls use separate ids to preserve the existing Axenco scenes. */
export function createThermostatControl({
  client,
  store,
  enqueue,
  getEntry,
  reconcile,
  failure,
  resumeDelayMs = 400,
}) {
  const controls = new Map();
  const control = (entry) => {
    if (!controls.has(entry.axencoId)) {
      const saved = store.get(entry.axencoId) || {};
      controls.set(entry.axencoId, {
        stopped:
          saved.stopped ?? (entry.observedState || entry.state).targetMode === PRESETS.standby.code,
        target: saved.target ?? effectiveTarget(entry.observedState || entry.state),
        expected: null,
        timer: null,
      });
    }
    return controls.get(entry.axencoId);
  };
  const persist = (entry, c) => store.set(entry.axencoId, { stopped: c.stopped, target: c.target });
  async function writeTarget(entry, value) {
    const c = control(entry);
    c.expected = value;
    try {
      await client.setDeviceTemperature(entry.axencoId, value);
      reconcile(entry, STANDARD.TARGET, { overrideTemp: value, targetMode: PRESETS.setpoint.code });
    } catch (error) {
      c.expected = null;
      throw error;
    }
  }
  return {
    handles: (key) => [STANDARD.MODE, STANDARD.TARGET].includes(key),
    async command(entry, key, value) {
      if (!nativeThermostat(entry))
        throw new Error('Native thermostat control is verified on EV30 only');
      if (![STANDARD.MODE, STANDARD.TARGET].includes(key))
        throw new Error('Unknown thermostat control');
      if (key === STANDARD.MODE) binary(value);
      else validateTemperature(entry, STANDARD.TARGET, value);
      const c = control(entry);
      clearTimeout(c.timer);
      c.timer = null;
      if (key === STANDARD.MODE) {
        c.stopped = value === 0;
        if (c.stopped) {
          let storageError;
          try {
            await persist(entry, c);
          } catch (error) {
            storageError = error;
          }
          c.expected = null;
          await client.setDeviceMode(entry.axencoId, PRESETS.standby.code);
          reconcile(entry, STANDARD.MODE, { targetMode: PRESETS.standby.code });
          if (storageError) throw storageError;
        } else {
          try {
            await persist(entry, c);
          } catch (error) {
            c.stopped = true;
            throw error;
          }
          // Gladys writes mode, THEN target: combine wake-up and setpoint into
          // one captured Axenco payload instead of two easily dropped orders.
          c.timer = setTimeout(() => {
            c.timer = null;
            enqueue(entry.axencoId, async () => {
              const current = getEntry(entry.axencoId);
              if (!current || c.stopped || controls.get(entry.axencoId) !== c) return;
              await writeTarget(current, validateTemperature(current, STANDARD.TARGET, c.target));
            }).catch((error) => failure(entry, STANDARD.MODE, error));
          }, resumeDelayMs);
        }
        return [];
      }
      const target = validateTemperature(entry, STANDARD.TARGET, value);
      if (c.stopped) {
        // OFF is followed by a frost fallback. Park it without targetMode=8.
        c.target = target;
        await persist(entry, c);
        return [{ device_feature_external_id: entry.ids.feature(STANDARD.TARGET), state: target }];
      }
      await writeTarget(entry, target);
      return []; // HTTP 200 is not temperature feedback.
    },
    observe(entry, patch) {
      if (!nativeThermostat(entry)) return [];
      const observed = entry.observedState || entry.state;
      Object.assign(observed, patch);
      const c = control(entry);
      const states = [];
      if (presetKeyFromCode(entry.presetKeys, patch.targetMode))
        states.push({
          device_feature_external_id: entry.ids.feature(STANDARD.MODE),
          state: patch.targetMode === PRESETS.standby.code ? 0 : 1,
        });
      const target = effectiveTarget(observed);
      if (c.stopped) {
        if (Number.isFinite(c.target))
          states.push({
            device_feature_external_id: entry.ids.feature(STANDARD.TARGET),
            state: c.target,
          });
      } else if (Number.isFinite(target) && (c.expected === null || target === c.expected)) {
        c.target = target;
        c.expected = null;
        states.push({
          device_feature_external_id: entry.ids.feature(STANDARD.TARGET),
          state: target,
        });
      }
      // A refused command must not look like a human turning the dial. Retain
      // the last confirmed value until the pending target is observed; the
      // reconciler reports failure and the next regulation pass can retry.
      return states;
    },
    cancelAll() {
      for (const c of controls.values()) clearTimeout(c.timer);
    },
    forget(id) {
      clearTimeout(controls.get(id)?.timer);
      controls.delete(id);
    },
  };
}

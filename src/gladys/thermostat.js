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

/** One physical mode and one shared setpoint, also serving the Gladys scheduler. */
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
      const observed = entry.observedState || entry.state;
      const physicalStop = observed.targetMode === PRESETS.standby.code;
      // A stale saved running intent must not override physical standby after
      // a restart. A saved stop still protects against delayed cloud feedback.
      const stopped = saved.stopped === true || physicalStop;
      controls.set(entry.axencoId, {
        stopped,
        // A persisted intent can precede the cloud feedback, including at restart.
        pendingMode: stopped && !physicalStop ? PRESETS.standby.code : null,
        target: saved.stopped
          ? (saved.target ?? effectiveTarget(observed))
          : effectiveTarget(observed),
        expected: null,
        timer: null,
        resumeRevision: 0,
      });
    }
    return controls.get(entry.axencoId);
  };
  const persist = (entry, c) => store.set(entry.axencoId, { stopped: c.stopped, target: c.target });
  const targetStates = (entry, target) =>
    [STANDARD.TARGET, ...(entry.legacyThermostatTarget ? [STANDARD.LEGACY_TARGET] : [])].map(
      (key) => ({ device_feature_external_id: entry.ids.feature(key), state: target }),
    );
  const cancelResume = (c) => {
    clearTimeout(c.timer);
    c.timer = null;
    c.resumeRevision += 1;
  };
  async function resume(entry, c) {
    c.stopped = false;
    c.pendingMode = PRESETS.setpoint.code;
    try {
      await persist(entry, c);
    } catch (error) {
      c.stopped = true;
      c.pendingMode = PRESETS.standby.code;
      throw error;
    }
  }
  async function writeTarget(entry, value) {
    const c = control(entry);
    c.expected = value;
    c.pendingMode = PRESETS.setpoint.code;
    try {
      await client.setDeviceTemperature(entry.axencoId, value);
      reconcile(entry, STANDARD.TARGET, { overrideTemp: value, targetMode: PRESETS.setpoint.code });
    } catch (error) {
      c.expected = null;
      c.pendingMode = null;
      throw error;
    }
  }
  return {
    handles: (entry, key) =>
      nativeThermostat(entry) &&
      [STANDARD.MODE, STANDARD.TARGET, STANDARD.LEGACY_TARGET].includes(key),
    async command(entry, key, value, { resume: explicitResume = false } = {}) {
      if (!nativeThermostat(entry))
        throw new Error('Native thermostat control is verified on EV30 only');
      if (![STANDARD.MODE, STANDARD.TARGET, STANDARD.LEGACY_TARGET].includes(key))
        throw new Error('Unknown thermostat control');
      if (key === STANDARD.MODE) binary(value);
      else validateTemperature(entry, STANDARD.TARGET, value);
      const c = control(entry);
      cancelResume(c);
      if (key === STANDARD.MODE) {
        if (value === 0) {
          c.stopped = true;
          c.pendingMode = PRESETS.standby.code;
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
          await resume(entry, c);
          // Gladys writes mode, THEN target: combine wake-up and setpoint into
          // one captured Axenco payload instead of two easily dropped orders.
          const revision = c.resumeRevision;
          c.timer = setTimeout(() => {
            c.timer = null;
            enqueue(entry.axencoId, async () => {
              const current = getEntry(entry.axencoId);
              if (
                !current ||
                c.stopped ||
                c.resumeRevision !== revision ||
                controls.get(entry.axencoId) !== c
              )
                return;
              await writeTarget(current, validateTemperature(current, STANDARD.TARGET, c.target));
            }).catch((error) => failure(entry, STANDARD.MODE, error));
          }, resumeDelayMs);
        }
        return [];
      }
      const target = validateTemperature(entry, STANDARD.TARGET, value);
      if (explicitResume) await resume(entry, c);
      if (c.stopped) {
        // OFF is followed by a frost fallback. Park it without targetMode=8.
        c.target = target;
        await persist(entry, c);
        return targetStates(entry, target);
      }
      await writeTarget(entry, target);
      return []; // HTTP 200 is not temperature feedback.
    },
    async directModeChanged(entry) {
      if (!nativeThermostat(entry)) return;
      const c = control(entry);
      cancelResume(c);
      c.expected = null;
      c.pendingMode = entry.state.targetMode;
      c.stopped = entry.state.targetMode === PRESETS.standby.code;
      // A manufacturer mode is an explicit user command too. It must release
      // a previous stop, or subsequent shared setpoints would remain parked.
      const target = effectiveTarget(entry.state);
      if (Number.isFinite(target)) c.target = target;
      await persist(entry, c);
    },
    observe(entry, patch) {
      if (!nativeThermostat(entry)) return [];
      const observed = entry.observedState || entry.state;
      Object.assign(observed, patch);
      const c = control(entry);
      const states = [];
      let stopChanged = false;
      const mode = presetKeyFromCode(entry.presetKeys, patch.targetMode);
      if (mode) {
        const expectedMode = presetKeyFromCode(entry.presetKeys, c.pendingMode);
        if (c.pendingMode === null || mode === expectedMode) {
          const stopped = patch.targetMode === PRESETS.standby.code;
          stopChanged = stopped !== c.stopped;
          c.stopped = stopped;
          c.pendingMode = null;
        }
        states.push({
          device_feature_external_id: entry.ids.feature(STANDARD.MODE),
          state: patch.targetMode === PRESETS.standby.code ? 0 : 1,
        });
      }
      const target = effectiveTarget(observed);
      if (c.stopped) {
        if (Number.isFinite(c.target)) states.push(...targetStates(entry, c.target));
      } else if (Number.isFinite(target) && (c.expected === null || target === c.expected)) {
        c.target = target;
        c.expected = null;
        states.push(...targetStates(entry, target));
      }
      if (stopChanged) {
        persist(entry, c).catch((error) =>
          Promise.resolve(failure(entry, STANDARD.MODE, error)).catch(() => {}),
        );
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

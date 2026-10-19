import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';

/** SDK deduplication plus ordered forced sends and created-feature filtering. */
export function createPublisher(gladys) {
  let tail = Promise.resolve();
  const run = (task) => {
    const next = tail.catch(() => {}).then(task);
    tail = next;
    return next;
  };
  return {
    publishStates(states, { force = false, heartbeat = false } = {}) {
      return run(async () => {
        const created = new Set(
          (gladys.devices || []).flatMap((d) => d.features.map((f) => f.external_id)),
        );
        const owned = states.filter((s) => created.has(s.device_feature_external_id));
        if (force)
          for (const state of owned) gladys.forgetPublishedStates(state.device_feature_external_id);
        return gladys.publishChangedStates(owned, heartbeat ? { heartbeat: 30 * 60 * 1000 } : {});
      });
    },
    forget(id) {
      gladys.forgetPublishedStates(id);
    },
    async publishTransports(entries, { reachable = true, pushConnected = true } = {}) {
      const created = new Set((gladys.devices || []).map((d) => d.external_id));
      const payload = [...entries]
        .filter((e) => created.has(e.ids.device))
        .map((entry) => ({
          external_id: entry.ids.device,
          transport:
            reachable && entry.connected ? DEVICE_TRANSPORTS.CLOUD : DEVICE_TRANSPORTS.UNREACHABLE,
          degraded: reachable && entry.connected && !pushConnected,
          ...(reachable && entry.connected && !pushConnected
            ? {
                message: {
                  en: 'Real-time channel unavailable; periodic refresh remains active.',
                  fr: 'Temps réel indisponible ; le rafraîchissement périodique reste actif.',
                },
              }
            : {}),
        }));
      for (let i = 0; i < payload.length; i += 100)
        await gladys.publishTransports(payload.slice(i, i + 100));
    },
  };
}

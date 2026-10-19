/** Serialize commands to one device without blocking unrelated devices. */
export function createDeviceQueue({ maxWaitMs = 1000 } = {}) {
  const tails = new Map();
  const pending = new Map();
  return (id, task) => {
    const count = pending.get(id) || 0;
    if (count >= 16)
      return Promise.reject(
        Object.assign(new Error('Too many pending commands for this device'), {
          code: 'QUEUE_FULL',
        }),
      );
    pending.set(id, count + 1);
    const enqueuedAt = Date.now();
    const run = (tails.get(id) || Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (Date.now() - enqueuedAt >= maxWaitMs)
          throw Object.assign(new Error('Queued command expired before it could be sent'), {
            code: 'QUEUE_EXPIRED',
          });
        return task();
      });
    const tail = run.finally(() => {
      pending.set(id, pending.get(id) - 1);
      if (tails.get(id) === tail) {
        tails.delete(id);
        pending.delete(id);
      }
    });
    tails.set(id, tail);
    tail.catch(() => {});
    return run;
  };
}

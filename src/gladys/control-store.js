import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Persist only thermostat stop intent and parked setpoints, never credentials. */
export async function createControlStore(directory) {
  const file = join(directory, 'thermostat-controls.json');
  let data = {};
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Invalid control store');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let tail = Promise.resolve();
  return {
    get: (id) => data[id],
    async set(id, value) {
      const next = tail
        .catch(() => {})
        .then(async () => {
          const updated = { ...data, [id]: value };
          await mkdir(directory, { recursive: true });
          await writeFile(`${file}.tmp`, JSON.stringify(updated), { mode: 0o600 });
          await rename(`${file}.tmp`, file);
          data = updated;
        });
      tail = next;
      return next;
    },
  };
}

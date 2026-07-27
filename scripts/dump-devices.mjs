// -----------------------------------------------------------------------------
// Debug tool: dump the raw Axenco device list.
//
//   node scripts/dump-devices.mjs
//
// It uses the integration's own client, so what it prints is exactly what the
// integration sees. Credentials are asked interactively (nothing lands in the
// shell history) and no token is ever printed.
//
// Useful when a device exposes modes it does not really have, or when a model
// is not recognized: the raw `state` is the only authoritative source.
// -----------------------------------------------------------------------------

import { connect } from './lib/connect.mjs';

const { devices } = await connect();

console.log(`\n${devices.length} appareil(s) sur le compte\n${'='.repeat(60)}`);

const KNOWN_FIELDS = new Set(['_id', 'name', 'model', 'rfid', 'parents', 'connected', 'state']);

for (const device of devices) {
  console.log(`\n--- ${device.name} | model=${device.model} ---`);
  console.log('_id       :', device._id);
  console.log('rfid      :', device.rfid ?? '(aucun)');
  console.log('parents   :', JSON.stringify(device.parents ?? null));
  console.log('connected :', device.connected);
  console.log('state     :', JSON.stringify(device.state, null, 2));

  // Anything we do not already read may be the capability hint we are after.
  const others = Object.keys(device).filter((key) => !KNOWN_FIELDS.has(key));
  if (others.length > 0) {
    const extra = Object.fromEntries(others.map((key) => [key, device[key]]));
    console.log('autres    :', JSON.stringify(extra, null, 2));
  }
}

process.exit(0);

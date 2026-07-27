// -----------------------------------------------------------------------------
// Capability sweep: what can a given Axenco device REALLY be told to do?
//
// The reference library `pyaxencoapi` lumps three different mechanisms into one
// "mode" enum, and the API answers 2xx to values it then ignores — so the only
// way to know a device's real capabilities is to try every candidate and watch
// the device.
//
//   node scripts/sweep-modes.mjs                            # list devices
//   node scripts/sweep-modes.mjs <deviceId>                 # read-only report
//   node scripts/sweep-modes.mjs <deviceId> --apply         # run the sweep
//   node scripts/sweep-modes.mjs <deviceId> --apply --codes 1,2,6
//
// METHOD, learned the hard way. A first version wrote a mode, slept 2 s and
// read back over REST. That produced garbage: these heaters apply a change in
// 2-30 s, so a "change" it saw was often the PREVIOUS write landing late, and
// real changes were recorded as ignored. Worse, hammering a device with a dozen
// writes in two minutes makes it drop commands.
//
// So this version:
//   - observes through the WEBSOCKET, the same push channel the integration
//     uses and the only authoritative signal, with REST only as a fallback;
//   - CONFIRMS the baseline before every test, and reports "non conclusive"
//     rather than a verdict when it cannot — no data beats wrong data;
//   - waits for the device to settle, then cools down between tests.
//
// It is slow on purpose: budget ~1 minute per code. Use --codes to split a run.
//
// Main devices only: sub-devices (NTD / ETRV / UFH) are written through their
// gateway, and are refused here rather than handled wrongly.
// -----------------------------------------------------------------------------

import { argv } from 'node:process';
import { PRESETS } from '../src/axenco/const.js';
import { connect, printDeviceList } from './lib/connect.mjs';

// 0 FIRST, and never drop it: it is Auto, and it was missing from the initial
// list precisely because `pyaxencoapi` documents auto as 60. Sweeping every
// code the reference knows is not the same as sweeping every code that exists.
const DEFAULT_CODES = [0, 1, 2, 3, 4, 6, 8, 20, 40, 41, 60, 61];
const SETTLE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
const COOLDOWN_MS = 6_000;

const deviceId = argv[2] && !argv[2].startsWith('--') ? argv[2] : null;
const apply = argv.includes('--apply');
const codesArg = argv[argv.indexOf('--codes') + 1];
const codes =
  argv.includes('--codes') && codesArg
    ? codesArg.split(',').map((value) => Number(value.trim()))
    : DEFAULT_CODES;

const { client, devices } = await connect();

if (!deviceId) {
  printDeviceList(devices);
  console.log('\nRelancez avec un _id, puis --apply pour balayer.');
  process.exit(0);
}

const device = devices.find((candidate) => candidate._id === deviceId);
if (!device) {
  console.error(`Appareil ${deviceId} introuvable sur ce compte.`);
  process.exit(1);
}
if (device.parents) {
  console.error(`${device.name} est un sous-appareil : ce script ne gère que le routage direct.`);
  process.exit(1);
}

// --- Observation: the WebSocket mirror, REST as a fallback -------------------

/** Local mirror of the device state, fed by every push Axenco sends. */
const mirror = { ...(device.state || {}) };
let pushCount = 0;

client.connectWebSocket();
client.registerListener(deviceId, (patch) => {
  if (patch && typeof patch === 'object') {
    pushCount += 1;
    Object.assign(mirror, patch);
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (parameters) =>
  client.request('PATCH', `/v1/devices/${deviceId}/state`, { parameters });
const labelOf = (code) =>
  Object.entries(PRESETS).find(([, preset]) => preset.code === code)?.[0] ?? '?';

/** Refresh the mirror from REST too, so a missed push does not blind us. */
async function syncMirror() {
  const state = ((await client.getDeviceState(deviceId)) || {}).state;
  if (state) {
    Object.assign(mirror, state);
  }
  return mirror;
}

/**
 * Wait until `predicate(state)` holds. Returns whether it ever did, so the
 * caller can tell a confirmed observation from a timeout.
 */
async function waitUntil(predicate, timeoutMs = SETTLE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  if (predicate(mirror)) {
    return true;
  }
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (predicate(mirror)) {
      return true;
    }
    await syncMirror();
    if (predicate(mirror)) {
      return true;
    }
  }
  return false;
}

/** Drive the device to a known mode and PROVE it got there. */
async function establishBaseline(code) {
  await write({ targetMode: code });
  return waitUntil((state) => state.targetMode === code);
}

await syncMirror();
const initial = { ...mirror };
console.log(`\n=== ${device.name} — ${device.model} (${device.reference ?? 'réf. inconnue'}) ===`);
console.log(
  `deviceType=${initial.deviceType} relayMode=${initial.relayMode}` +
    ` | targetMode=${initial.targetMode} autoProgram=${initial.autoProgram}` +
    ` overrideTemp=${initial.overrideTemp} currentTemp=${initial.currentTemp}\n`,
);

if (!apply) {
  console.log('Lecture seule. Ajoutez --apply pour lancer le balayage.');
  client.disconnectWebSocket();
  process.exit(0);
}

console.log(
  `Balayage de ${codes.length} code(s), ~1 min chacun. Observation par WebSocket.\n` +
    `Ne touchez pas à cet appareil depuis l'app pendant le test.\n`,
);

const rows = [];

try {
  for (const code of codes) {
    // Baseline must differ from the code under test, else "unchanged" and
    // "already there" are the same observation.
    const baseline = code === 3 ? 1 : 3;
    process.stdout.write(`  ${String(code).padStart(3)} (${labelOf(code).padEnd(12)}) ... `);

    if (!(await establishBaseline(baseline))) {
      console.log(`NON CONCLUANT — impossible d'établir la base ${baseline}`);
      rows.push({ code, verdict: 'NON CONCLUANT (base non établie)' });
      await sleep(COOLDOWN_MS);
      continue;
    }

    let sendError = null;
    try {
      await write({ targetMode: code });
    } catch (err) {
      sendError = err.message.slice(0, 120);
    }
    if (sendError) {
      console.log(`REFUSÉ — ${sendError}`);
      rows.push({ code, verdict: `REFUSÉ (${sendError})` });
      await sleep(COOLDOWN_MS);
      continue;
    }

    const exact = await waitUntil((state) => state.targetMode === code);
    if (exact) {
      console.log(`APPLIQUÉ (targetMode=${code})`);
      rows.push({ code, verdict: 'APPLIQUÉ' });
    } else {
      // Not the asked value: did it move at all, or stay on the baseline?
      const landed = mirror.targetMode;
      const moved = landed !== baseline;
      console.log(
        moved
          ? `AUTRE VALEUR — l'appareil est passé à ${landed}`
          : `IGNORÉ — resté sur la base ${baseline}`,
      );
      rows.push({ code, verdict: moved ? `AUTRE VALEUR -> ${landed}` : 'IGNORÉ' });
    }
    await sleep(COOLDOWN_MS);
  }

  // --- autoProgram, measured on a confirmed baseline ------------------------
  console.log('\n--- Drapeau autoProgram ---');
  if (await establishBaseline(3)) {
    await write({ autoProgram: false });
    await waitUntil((state) => state.autoProgram === false, 15_000);

    await write({ autoProgram: true });
    const flagOn = await waitUntil((state) => state.autoProgram === true);
    console.log(`  autoProgram=true    ${flagOn ? 'APPLIQUÉ' : 'IGNORÉ'}`);
    rows.push({ code: 'autoProgram true', verdict: flagOn ? 'APPLIQUÉ' : 'IGNORÉ' });

    if (flagOn) {
      // The open question: does a manual mode clear the flag by itself?
      await write({ targetMode: 1 });
      const modeApplied = await waitUntil((state) => state.targetMode === 1);
      await sleep(COOLDOWN_MS);
      await syncMirror();
      console.log(
        `  puis Confort (1)    ${modeApplied ? 'APPLIQUÉ' : 'IGNORÉ'}` +
          ` -> autoProgram=${mirror.autoProgram}`,
      );
      rows.push({
        code: 'mode manuel pendant autoProgram',
        verdict: modeApplied
          ? `autoProgram reste ${mirror.autoProgram}`
          : 'NON CONCLUANT (mode non appliqué)',
      });
    } else {
      rows.push({ code: 'mode manuel pendant autoProgram', verdict: 'NON CONCLUANT' });
    }
  } else {
    console.log('  NON CONCLUANT — base non établie');
    rows.push({ code: 'autoProgram', verdict: 'NON CONCLUANT (base non établie)' });
  }

  // --- Does writing a temperature create the derogation by itself? ----------
  console.log('\n--- Température ---');
  if (await establishBaseline(3)) {
    const probeTemp = (initial.overrideTemp ?? 19) + 0.5;
    await write({ overrideTemp: probeTemp });
    const applied = await waitUntil((state) => state.overrideTemp === probeTemp);
    await sleep(COOLDOWN_MS);
    await syncMirror();
    console.log(
      `  overrideTemp=${probeTemp}  ${applied ? 'APPLIQUÉ' : 'IGNORÉ'}` +
        ` -> targetMode=${mirror.targetMode} overrideTemp=${mirror.overrideTemp}` +
        `${applied && mirror.targetMode === 8 ? '  => bascule seule en dérogation (8)' : ''}`,
    );
    rows.push({
      code: `overrideTemp ${probeTemp}`,
      verdict: applied ? `APPLIQUÉ, targetMode=${mirror.targetMode}` : 'IGNORÉ',
    });
  } else {
    console.log('  NON CONCLUANT — base non établie');
    rows.push({ code: 'overrideTemp', verdict: 'NON CONCLUANT (base non établie)' });
  }
} finally {
  console.log('\nRestauration...');
  try {
    if (initial.overrideTemp !== undefined) {
      await write({ overrideTemp: initial.overrideTemp });
      await waitUntil((state) => state.overrideTemp === initial.overrideTemp, 15_000);
    }
    if (initial.autoProgram !== undefined) {
      await write({ autoProgram: initial.autoProgram });
      await waitUntil((state) => state.autoProgram === initial.autoProgram, 15_000);
    }
    // Mode last: writing a temperature moves the device into derogation.
    await write({ targetMode: initial.targetMode });
    const ok = await waitUntil((state) => state.targetMode === initial.targetMode, 20_000);
    await syncMirror();
    console.log(
      `Restauré : targetMode=${mirror.targetMode} autoProgram=${mirror.autoProgram}` +
        ` overrideTemp=${mirror.overrideTemp}` +
        `${ok ? '' : " /!\\ différent de l'initial, à remettre depuis l'app"}`,
    );
  } catch (err) {
    console.error(`ÉCHEC de la restauration (${err.message}) — remettez le mode depuis l'app.`);
  }
  client.disconnectWebSocket();
}

console.log(
  `\n=== Résumé : ${device.name} / ${device.model} / deviceType=${initial.deviceType} ===`,
);
console.log(`(${pushCount} push WebSocket reçus pendant le test)\n`);
for (const row of rows) {
  const name = typeof row.code === 'number' ? `${row.code} (${labelOf(row.code)})` : row.code;
  console.log(`  ${String(name).padEnd(36)} ${row.verdict}`);
}
process.exit(0);

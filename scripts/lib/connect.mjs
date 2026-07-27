// -----------------------------------------------------------------------------
// Shared entry point of the debug scripts: ask for the credentials and log in.
//
// Credentials are read interactively rather than from arguments or env vars, so
// they never land in the shell history, and no token is ever printed.
// -----------------------------------------------------------------------------

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createLogger } from '@gladysassistant/integration-sdk';
import { AxencoClient } from '../../src/axenco/client.js';

/**
 * @description Prompt for the MyNeomitis credentials and return a logged-in
 * client together with the account's devices.
 * @param {object} [options] - Options.
 * @param {boolean} [options.verbose] - Let the client log its own requests.
 * @returns {Promise<{client: object, devices: Array<object>}>} The session.
 * @example
 * const { client, devices } = await connect();
 */
export async function connect({ verbose = false } = {}) {
  const rl = createInterface({ input: stdin, output: stdout });
  const email = await rl.question('Email MyNeomitis : ');
  const password = await rl.question('Mot de passe : ');
  rl.close();

  const client = new AxencoClient({
    logger: createLogger({ level: verbose ? 'info' : 'silent', name: 'axenco' }),
  });
  await client.login(email, password);
  return { client, devices: await client.getDevices(true) };
}

/**
 * @description Print the account's devices, one line each, with the fields the
 * other scripts need to be pointed at one.
 * @param {Array<object>} devices - The device list.
 * @returns {void}
 * @example
 * printDeviceList(devices);
 */
export function printDeviceList(devices) {
  console.log('\nAppareils du compte :\n');
  for (const device of devices) {
    const state = device.state || {};
    console.log(
      `  ${device._id}  ${String(device.model).padEnd(6)} ${String(device.name).padEnd(14)}` +
        ` targetMode=${state.targetMode} autoProgram=${state.autoProgram}` +
        ` overrideTemp=${state.overrideTemp}`,
    );
  }
}

import { FEATURE, presetFeatureKey } from '../devices/features.js';
import { STANDARD } from '../devices/standard.js';
import { registerHeaterWidget } from './heater-widget.js';

/** All commands enter the same validated, per-device queue as device controls. */
export function registerSurfaces(gladys, { findEntry, command, status }) {
  const chooseMode = async (device, mode) => {
    const entry = findEntry(device);
    if (!entry.selectableKeys.includes(mode)) throw new Error('Mode unsupported by this device');
    if (entry.profile.presetRendering === 'binary')
      await command(device, FEATURE.COOLING, mode === 'cooling' ? 1 : 0);
    else {
      const created = gladys.devices.find((item) => item.external_id === entry.ids.device);
      if (
        created?.features.some(
          (feature) => feature.external_id === entry.ids.feature(FEATURE.MODE_SELECT),
        )
      )
        await command(device, FEATURE.MODE_SELECT, mode);
      else await command(device, presetFeatureKey(mode), 1);
    }
  };
  const setTemperature = async (device, temperature) => {
    const entry = findEntry(device);
    // This action explicitly starts a derogation. Ordinary shared-setpoint
    // writes leave an EV30 in standby until its physical mode is resumed.
    if (entry.model === 'EV30')
      await command(device, FEATURE.TARGET_TEMP, temperature, { resume: true });
    else await command(device, FEATURE.TARGET_TEMP, temperature);
  };
  gladys.onSceneAction('choose_mode', async ({ device, mode }) => {
    await chooseMode(device, mode);
    return { accepted: true };
  });
  gladys.onSceneAction('set_temperature', async ({ device, temperature }) => {
    await setTemperature(device, temperature);
    return { accepted: true };
  });
  gladys.onSceneAction('resume_program', async ({ device }) => {
    await chooseMode(device, 'auto');
    return { accepted: true };
  });
  gladys.onSceneAction('set_heating', async ({ device, enabled }) => {
    const entry = findEntry(device);
    const key = entry.model === 'EV30' ? STANDARD.MODE : STANDARD.RELAY;
    if (typeof enabled !== 'boolean') throw new Error('Expected a boolean');
    await command(device, key, enabled ? 1 : 0);
    return { accepted: true };
  });

  registerHeaterWidget(gladys, { findEntry, command, status, chooseMode, setTemperature });
}

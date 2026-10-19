import { FEATURE, presetFeatureKey } from '../devices/features.js';
import { PRESETS } from '../axenco/const.js';
import { STANDARD } from '../devices/standard.js';

/** All commands enter the same validated, per-device queue as device controls. */
export function registerSurfaces(gladys, { findEntry, command, status }) {
  const chooseMode = async (device, mode) => {
    const entry = findEntry(device);
    if (!entry.selectableKeys.includes(mode)) throw new Error('Mode unsupported by this device');
    if (entry.profile.presetRendering === 'binary')
      await command(device, FEATURE.COOLING, mode === 'cooling' ? 1 : 0);
    else await command(device, presetFeatureKey(mode), 1);
  };
  const setTemperature = async (device, temperature) => {
    findEntry(device);
    // Explicit Axenco derogation: unlike the native scheduler, this user action
    // retains the historical behaviour of waking the heater with a temperature.
    await command(device, FEATURE.TARGET_TEMP, temperature);
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

  gladys.onWidgetGet('heater', ({ settings, units }) => {
    const entry = findEntry(settings.device);
    const health = status();
    const features = gladys.devices.find((d) => d.external_id === entry.ids.device).features;
    const value = (key) =>
      features.find((f) => f.external_id === entry.ids.feature(key))?.last_value;
    const mode = features.find(
      (f) => f.external_id === entry.ids.feature(FEATURE.MODE),
    )?.last_value_string;
    const components = [
      { type: 'text', variant: 'heading', text: entry.gladysDevice.name.slice(0, 40) },
    ];
    const temperature = (key, label) => {
      const reading = value(key);
      if (typeof reading !== 'number' || !Number.isFinite(reading)) return;
      components.push({
        type: 'value',
        label,
        value: units === 'us' ? (reading * 9) / 5 + 32 : reading,
        unit: units === 'us' ? '°F' : '°C',
      });
    };
    temperature(FEATURE.CURRENT_TEMP, { en: 'Room', fr: 'Pièce' });
    temperature(FEATURE.TARGET_TEMP, { en: 'Axenco target', fr: 'Consigne Axenco' });
    components.push({
      type: 'status',
      items: [
        { label: { en: 'Mode', fr: 'Mode' }, value: mode || '—' },
        {
          label: { en: 'Cloud', fr: 'Cloud' },
          value: health.restReachable
            ? { en: 'Connected', fr: 'Connecté' }
            : { en: 'Unavailable', fr: 'Indisponible' },
          color: health.restReachable ? 'success' : 'danger',
        },
        {
          label: { en: 'Real time', fr: 'Temps réel' },
          value: health.pushConnected
            ? { en: 'Connected', fr: 'Connecté' }
            : { en: 'Periodic refresh', fr: 'Relecture périodique' },
          color: health.pushConnected ? 'success' : 'warning',
        },
        ...(health.lastSuccessAt
          ? [
              {
                label: { en: 'Last cloud read', fr: 'Dernière lecture cloud' },
                value: `${Math.max(0, Math.floor((Date.now() - Date.parse(health.lastSuccessAt)) / 60000))} min`,
              },
            ]
          : []),
      ],
    });
    if (entry.selectableKeys.length)
      components.push({
        type: 'button',
        label: { en: 'Axenco mode', fr: 'Mode Axenco' },
        action: {
          key: 'mode',
          fields: [
            {
              key: 'mode',
              type: 'select',
              required: true,
              label: { en: 'Mode', fr: 'Mode' },
              options: entry.selectableKeys.map((key) => ({
                value: key,
                label: { en: PRESETS[key].label, fr: PRESETS[key].label },
              })),
            },
          ],
        },
      });
    const target = features.find((f) => f.external_id === entry.ids.feature(FEATURE.TARGET_TEMP));
    if (target)
      components.push({
        type: 'button',
        label: { en: 'Override (°C)', fr: 'Dérogation (°C)' },
        action: {
          key: 'temperature',
          fields: [
            {
              key: 'temperature',
              type: 'number',
              required: true,
              label: { en: 'Temperature (°C)', fr: 'Température (°C)' },
              min: target.min,
              max: target.max,
              ...(Number.isFinite(target.last_value) ? { default: target.last_value } : {}),
            },
          ],
        },
      });
    return { ttl_seconds: 60, components };
  });
  gladys.onWidgetAction('heater', async (key, params, { settings, values = {} }) => {
    if (key === 'mode') await chooseMode(settings.device, values.mode);
    else if (key === 'temperature') await setTemperature(settings.device, values.temperature);
    else throw new Error('Unknown widget action');
    return {
      en: 'Command sent; hardware confirmation follows.',
      fr: 'Commande envoyée ; confirmation matérielle à suivre.',
    };
  });
}

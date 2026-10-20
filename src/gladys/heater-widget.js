import { FEATURE, presetFeatureKey } from '../devices/features.js';
import { modeLabel } from '../devices/index.js';
import { PRESETS, presetKeyFromCode } from '../axenco/const.js';
import { STANDARD } from '../devices/standard.js';

/** Compact direct controls; the Gladys thermostat remains the scheduling UI. */
export function registerHeaterWidget(gladys, { findEntry, status, chooseMode, setTemperature }) {
  const featuresFor = (entry) =>
    gladys.devices.find((device) => device.external_id === entry.ids.device)?.features || [];
  const featureFor = (entry, features, key) =>
    features.find((f) => f.external_id === entry.ids.feature(key));
  const writableFeatureFor = (entry, features, key) =>
    features.find((f) => f.external_id === entry.ids.feature(key) && !f.read_only);
  const modesFor = (entry, features) =>
    entry.selectableKeys.filter((key) => {
      if (entry.profile.presetRendering === 'binary')
        return Boolean(writableFeatureFor(entry, features, FEATURE.COOLING));
      const selector = writableFeatureFor(entry, features, FEATURE.MODE_SELECT);
      return selector
        ? selector.supported_options?.some((option) => option.value === key)
        : Boolean(writableFeatureFor(entry, features, presetFeatureKey(key)));
    });
  gladys.onWidgetGet('heater', async ({ settings }) => {
    // Published states do not refresh the SDK's device snapshot. Read the
    // current Gladys values for form defaults, without querying Axenco again.
    await gladys.getDevices();
    const entry = findEntry(settings.device);
    const features = featuresFor(entry);
    const observed = entry.observedState || entry.state;
    const activeMode = presetKeyFromCode(entry.presetKeys, observed[entry.profile.presetStateKey]);
    const modes = modesFor(entry, features);
    const stopped = ['standby', 'off'].includes(activeMode);
    const health = status();
    const diagnostics = settings.show_diagnostics === true;
    const components = [
      { type: 'text', variant: 'heading', text: entry.gladysDevice.name.slice(0, 40) },
    ];
    for (const [key, label, icon] of [
      [FEATURE.CURRENT_TEMP, { en: 'Room', fr: 'Pièce' }, 'thermometer'],
      [FEATURE.TARGET_TEMP, { en: 'Setpoint', fr: 'Consigne' }, 'target'],
    ]) {
      if (featureFor(entry, features, key))
        components.push({ type: 'value', device_feature: entry.ids.feature(key), label, icon });
    }
    const items = [
      {
        label: { en: 'Mode', fr: 'Mode' },
        value: modeLabel(entry) || '—',
        icon: 'settings',
        color: !activeMode ? 'warning' : stopped ? 'neutral' : 'info',
      },
    ];
    const window = observed.windowStatus;
    if ([true, false, 0, 1].includes(window)) {
      items.push({
        label: { en: 'Window', fr: 'Fenêtre' },
        value: window
          ? { en: 'Opening detected', fr: 'Ouverture détectée' }
          : { en: 'Closed', fr: 'Fermée' },
        icon: window ? 'alert-triangle' : 'check-circle',
        color: window ? 'warning' : 'neutral',
      });
    } else if (featureFor(entry, features, STANDARD.WINDOW)) {
      items.push({
        label: { en: 'Window', fr: 'Fenêtre' },
        value: { en: 'Unknown', fr: 'État inconnu' },
        color: 'warning',
      });
    }
    if (entry.connected === false)
      items.push({
        label: { en: 'Device', fr: 'Appareil' },
        value: { en: 'Offline', fr: 'Hors ligne' },
        icon: 'wifi-off',
        color: 'danger',
      });
    if (diagnostics || health.restReachable === false)
      items.push({
        label: { en: 'Cloud', fr: 'Cloud' },
        value: health.restReachable
          ? { en: 'Connected', fr: 'Connecté' }
          : { en: 'Unavailable', fr: 'Indisponible' },
        color: health.restReachable ? 'success' : 'danger',
      });
    if (diagnostics || health.pushConnected === false)
      items.push({
        label: { en: 'Real time', fr: 'Temps réel' },
        value: health.pushConnected
          ? { en: 'Connected', fr: 'Connecté' }
          : { en: 'Periodic refresh', fr: 'Relecture périodique' },
        color: health.pushConnected ? 'success' : 'warning',
      });
    if (diagnostics) {
      const timestamp = Date.parse(health.lastSuccessAt);
      items.push({
        label: { en: 'Last cloud read', fr: 'Dernière lecture cloud' },
        value: Number.isFinite(timestamp)
          ? `${Math.max(0, Math.floor((Date.now() - timestamp) / 60000))} min`
          : { en: 'Not available', fr: 'Indisponible' },
      });
    }
    components.push({ type: 'status', items });
    if (modes.length)
      components.push({
        type: 'button',
        label: { en: 'Mode', fr: 'Mode' },
        icon: 'settings',
        action: {
          key: 'mode',
          fields: [
            {
              key: 'mode',
              type: 'select',
              required: true,
              label: { en: 'Axenco mode', fr: 'Mode Axenco' },
              ...(modes.includes(activeMode) ? { default: activeMode } : {}),
              options: modes.map((key) => ({
                value: key,
                label: { en: PRESETS[key].label, fr: PRESETS[key].label },
              })),
            },
          ],
        },
      });
    const target = featureFor(entry, features, FEATURE.TARGET_TEMP);
    if (target && !target.read_only) {
      const reading = target.last_value;
      const validDefault =
        Number.isFinite(reading) &&
        reading >= target.min &&
        reading <= target.max &&
        (!target.step ||
          Math.abs(reading / target.step - Math.round(reading / target.step)) <= 1e-8);
      components.push({
        type: 'button',
        label: { en: 'Setpoint', fr: 'Consigne' },
        icon: 'edit-3',
        action: {
          key: 'temperature',
          fields: [
            {
              key: 'temperature',
              type: 'number',
              required: true,
              label: { en: 'Setpoint (°C)', fr: 'Consigne (°C)' },
              description: {
                en: 'Applies an override and can resume heating. An active Gladys schedule may take over again.',
                fr: 'Applique une dérogation et peut reprendre le chauffage. Un planning Gladys actif peut ensuite reprendre la main.',
              },
              min: target.min,
              max: target.max,
              ...(validDefault ? { default: reading } : {}),
            },
          ],
        },
      });
    }
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

// Minimal doubles: the SDK bits the device layer uses, and an Axenco client
// that records what it was asked to write.

export const fakeGladys = {
  externalIds(type, platformId) {
    const device = `ext:neomitis:${type}:${platformId}`;
    return { device, feature: (key) => `${device}:${key}` };
  },
};

export function fakeAxencoClient() {
  const calls = [];
  const record =
    (name) =>
    async (...args) => {
      calls.push({ name, args });
    };
  return {
    calls,
    setDeviceTemperature: record('setDeviceTemperature'),
    setSubDeviceTemperature: record('setSubDeviceTemperature'),
    setDeviceMode: record('setDeviceMode'),
    setSubDeviceMode: record('setSubDeviceMode'),
    setSubDeviceModeUfh: record('setSubDeviceModeUfh'),
    setDeviceSetpoints: record('setDeviceSetpoints'),
  };
}

/** A main thermostat, as the Axenco API returns it. */
export function axencoThermostat(overrides = {}) {
  return {
    _id: '65f0000000000000000000a1',
    name: 'Salon',
    model: 'EV30',
    connected: true,
    state: {
      currentTemp: 19.4,
      overrideTemp: 20,
      targetMode: 1,
      comfLimitMin: 16,
      comfLimitMax: 21,
    },
    ...overrides,
  };
}

/** A sub-device reached through a gateway. */
export function axencoSubDevice(overrides = {}) {
  return {
    _id: '65f0000000000000000000b2',
    name: 'Chambre',
    model: 'ETRV',
    connected: true,
    rfid: 'A1B2',
    parents: ',65f0000000000000000000ff,A0A0,',
    state: { currentTemp: 18.1, targetTemp: 19, targetMode: 2 },
    ...overrides,
  };
}

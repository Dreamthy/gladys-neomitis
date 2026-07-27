// -----------------------------------------------------------------------------
// Helpers around the Axenco parent/child model.
//
// JavaScript port of `pyaxencoapi/utils.py`, plus the `_extract_gateway_id`
// static method of `api.py`.
//
// One wrinkle the Python sources disagree on: the shape of `device.parents`.
// `api.py` and `utils.py` treat it as a comma separated STRING
// (`",<gateway>,<parent rfid>,"`), while `climate.py` reads it as a DICT and
// does `self._parents.get("gateway")`. Both shapes exist in the wild depending
// on the endpoint, so every reader here goes through `parentTokens()` and
// handles the two — a single point of truth instead of a `TypeError` waiting
// in whichever branch guessed wrong.
// -----------------------------------------------------------------------------

/**
 * @description Normalize `device.parents` into the list of parent identifiers.
 * @param {string|object|null|undefined} parents - The raw `parents` value.
 * @returns {string[]} Parent identifiers, in order, without empty entries.
 * @example
 * parentTokens(',gw-1,rf-2,'); // ['gw-1', 'rf-2']
 * parentTokens({ gateway: 'gw-1' }); // ['gw-1']
 */
export function parentTokens(parents) {
  if (typeof parents === 'string') {
    return parents
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  if (parents && typeof parents === 'object') {
    // `gateway` first when present: the gateway is what the REST routes need,
    // and `climate.py` reads exactly that key.
    const ordered = [
      ...(parents.gateway === undefined ? [] : [parents.gateway]),
      ...Object.entries(parents)
        .filter(([key]) => key !== 'gateway')
        .map(([, value]) => value),
    ];
    return ordered
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .map((v) => v.trim());
  }
  return [];
}

/**
 * @description Extract the gateway id a sub-device is reached through. The
 * gateway is the first entry of the parent chain (`_extract_gateway_id`).
 * @param {string|object|null|undefined} parents - The raw `parents` value.
 * @returns {string|null} The gateway id, or null when there is none.
 * @example
 * extractGatewayId(',gw-1,rf-2,'); // 'gw-1'
 */
export function extractGatewayId(parents) {
  const [gateway] = parentTokens(parents);
  return gateway || null;
}

/**
 * @description Return the `rfid` of the device carrying a given `_id`.
 * @param {Array<object>} devices - The device list.
 * @param {string} id - The `_id` to look for.
 * @returns {string} The device `rfid`, or an empty string when not found.
 * @example
 * getRfidById(devices, '65f...'); // 'A1B2'
 */
export function getRfidById(devices, id) {
  const device = devices.find((candidate) => candidate._id === id);
  return (device && device.rfid) || '';
}

/**
 * @description Find the `_id` of every device whose parent chain contains a
 * given rfid (`find_childs`).
 * @param {Array<object>} devices - The device list.
 * @param {string} parentRfid - The rfid of the parent device.
 * @returns {string[]} The `_id` of each child device.
 * @example
 * findChildren(devices, 'A1B2'); // ['65f...', '65e...']
 */
export function findChildren(devices, parentRfid) {
  if (!parentRfid) {
    return [];
  }
  return devices
    .filter((device) => parentTokens(device.parents).includes(parentRfid))
    .map((device) => device._id);
}

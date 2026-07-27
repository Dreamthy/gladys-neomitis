// -----------------------------------------------------------------------------
// Explicit Gladys selectors.
//
// Gladys enforces global uniqueness on the `selector` of a device and of a
// device feature, and derives it from `name` when the payload does not carry
// one (`server/utils/addSelector.js`: `addSelectorBeforeValidateHook` ->
// `slugify(item.name)`).
//
// Our feature names are generic on purpose ("Température actuelle", "Confort"…)
// and repeat across every room, so letting Gladys derive them means the second
// radiator is rejected with a 409 CONFLICT on `temperature-actuelle`. Deriving
// the selector from the external_id instead makes it unique by construction —
// the external_id already is, and Gladys enforces that too.
// -----------------------------------------------------------------------------

/**
 * @description Build a unique, stable selector out of an external id.
 * @param {string} externalId - An `ext:<integration>:<...>` external id.
 * @returns {string} The selector Gladys should store.
 * @example
 * selectorFromExternalId('ext:neomitis:thermostat:65f:mode');
 * // 'neomitis-thermostat-65f-mode'
 */
export function selectorFromExternalId(externalId) {
  return externalId.replace(/^ext:/, '').replace(/:/g, '-');
}

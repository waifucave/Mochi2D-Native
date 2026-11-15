/**
 * Mochi2D's own JSON formats are named `mochi2d-<kind>/<major>` (scenarios,
 * results, catalogs, item layouts…). Before the project was renamed, they
 * were named `lively2d-<kind>/<major>`. Writers use the current names;
 * readers accept both.
 */

/** The prefix of the current format names. */
export const FORMAT_PREFIX = "mochi2d-";

/** The prefix of the format names before the rename; still accepted when reading. */
export const LEGACY_FORMAT_PREFIX = "lively2d-";

/**
 * A format name with the former prefix replaced by the current one
 * (`lively2d-result/0` → `mochi2d-result/0`). Other values are returned as
 * they are.
 */
export function currentFormatName<T>(name: T): T | string {
  return typeof name === "string" && name.startsWith(LEGACY_FORMAT_PREFIX)
    ? FORMAT_PREFIX + name.slice(LEGACY_FORMAT_PREFIX.length)
    : name;
}

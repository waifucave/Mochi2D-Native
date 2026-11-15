/**
 * `validateMoc`: structured validation of `.moc3` files and {@link MocData}
 * (docs/moc-data.md), at two levels:
 *
 * - `official`: what the official consistency check rejects (1b.7,
 *   P8, C26 slot order, S6, band and mask entries, position runs). Errors only.
 * - `strict`: everything `official` reports, plus what Mochi2D's loader
 *   rejects beyond that (the second list of 1b.7, group totals C6, every
 *   keyform's own position run, color index N, and the rest of the loader's
 *   checks), plus warnings: out-of-range draw orders (C12/C25), per-keyform
 *   color indices that the runtime ignores (C5), a deformer band that differs
 *   from its warp or rotation record's, non-finite keyform positions,
 *   duplicate IDs, defaults outside [min, max], a non-positive ppu.
 *
 * `official` is looser than the format's meaning in places, as the official
 * check is: it tests keyform position runs with a
 * mismatched index (see the keyform-positions section below), so most runs
 * go unchecked and some valid files are rejected; it gives a part's child
 * group only a range check, so a part entry without a child group, or with a
 * cycle back to its own group, passes.
 *
 * A file that passes `strict` loads in Mochi2D (`loadMoc`); the validator
 * runs the loader at the end to make sure. Every check reports where the
 * problem is: the {@link MocData} group, the element and the field.
 */
import { loadMoc, buildModel } from "./model.js";
import { MocFormatError, type MocSections } from "./read.js";
import { checkMocDataShape, readMoc, type MocDiagnostic } from "./io.js";
import { Report, checkStructure } from "./structure.js";
import { sectionsFromData } from "./from-data.js";
import type { MocData, MocDataGroup, MocVersion } from "./data.js";

export type MocValidationLevel = "official" | "strict";

export interface ValidateMocOptions {
  /** Default "strict". */
  level?: MocValidationLevel;
  /** The version of the data, when validating {@link MocData} (not needed for bytes). */
  version?: MocVersion;
}

export interface MocValidation {
  /** No errors at this level (warnings are allowed). */
  valid: boolean;
  /** The file's version (bytes) or the one given (data); null if the bytes have none. */
  version: MocVersion | null;
  diagnostics: MocDiagnostic[];
}

const isBytes = (x: unknown): x is ArrayBuffer | ArrayBufferView =>
  x instanceof ArrayBuffer || ArrayBuffer.isView(x);

/**
 * Validates a `.moc3` file (bytes) or {@link MocData} (with `version`).
 * Never throws for bad input: every problem is a diagnostic.
 */
export function validateMoc(
  input: MocData | ArrayBuffer | ArrayBufferView,
  options: ValidateMocOptions = {},
): MocValidation {
  const level = options.level ?? "strict";
  const strict = level === "strict";
  const report = new Report(strict);
  let data: MocData;
  let version: MocVersion;
  if (isBytes(input)) {
    try {
      const r = readMoc(input);
      data = r.data;
      version = r.version;
      for (const d of r.diagnostics) {
        if (d.code === "big-endian")
          report.error(
            "official",
            "big-endian",
            "file",
            "big-endian file: the official consistency check rejects it (Mochi2D and the official loader read it)",
          );
        else report.error("official", d.code, d.kind, d.message, d.index, d.field);
      }
    } catch (e) {
      if (!(e instanceof MocFormatError)) throw e;
      report.error("official", e.code, "file", e.message);
      const view = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      const v = view[4];
      return {
        valid: false,
        version: v !== undefined && v >= 1 && v <= 6 ? (v as MocVersion) : null,
        diagnostics: report.list,
      };
    }
  } else {
    if (options.version === undefined) {
      report.error("official", "version", "file", "validating MocData needs options.version");
      return { valid: false, version: null, diagnostics: report.list };
    }
    version = options.version;
    const shape = checkMocDataShape(input, version);
    if (shape.diagnostics.length) return { valid: false, version, diagnostics: shape.diagnostics };
    data = input;
  }

  checkStructure(data, version, report);

  // A strict pass must also load: the loader is the final judge.
  if (strict && report.errors === 0) {
    try {
      if (isBytes(input)) loadMoc(input);
      else buildModel(sectionsFromData(data, version));
    } catch (e) {
      if (!(e instanceof MocFormatError)) throw e;
      report.error("strict", "load-error", "file", `Mochi2D's loader rejects it: ${e.message}`);
    }
  }
  return { valid: report.errors === 0, version, diagnostics: report.list };
}

export type { MocDataGroup };

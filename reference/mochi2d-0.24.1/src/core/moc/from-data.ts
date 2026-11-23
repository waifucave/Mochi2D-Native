/**
 * A loaded model straight from {@link MocData}, without writing a file:
 * `mocModelFromData(data, version)` is `loadMoc(writeMoc(data, { version }))`
 * (the same model, the same errors), for versions 1–6.
 */
import { buildModel, type LoadMocOptions, type MocModel } from "./model.js";
import type { MocSections } from "./read.js";
import { FIELDS, countTableLength, type FieldKey } from "./schema.js";
import { MocWriteError, checkMocDataShape } from "./io.js";
import { Report, checkStructure } from "./structure.js";
import type { MocData, MocVersion } from "./data.js";

const f32 = Math.fround;

/**
 * The loader's view of some data, as a written file would give it: typed
 * arrays from the shape check, and the canvas in float32. Throws
 * {@link MocWriteError} when the data does not fit the version.
 */
export function sectionsFromData(data: MocData, version: number): MocSections {
  const { diagnostics, encodable } = checkMocDataShape(data, version);
  if (!encodable) throw new MocWriteError(diagnostics);
  const fields = new Map<
    FieldKey,
    Int32Array | Float32Array | Uint16Array | Uint8Array | string[] | null
  >();
  // Copies, so that the model never shares an array with the data: later edits
  // of the data do not reach the model, and patches of the model do not reach the data.
  const copy = (v: ArrayLike<number> | readonly string[] | undefined) =>
    v === undefined ? null : (v as { slice(): unknown }).slice();
  for (const f of FIELDS) {
    if (f.since > version) continue;
    if (f.type === "placeholder") fields.set(f.key, null);
    else fields.set(f.key, copy(encodable.values.get(f.key)) as never);
  }
  const c = data.canvas;
  return {
    version,
    bigEndian: false,
    byteLength: 0,
    counts: encodable.counts ?? new Int32Array(countTableLength(version)),
    canvas: {
      pixelsPerUnit: f32(c.pixelsPerUnit),
      originX: f32(c.originX),
      originY: f32(c.originY),
      width: f32(c.width),
      height: f32(c.height),
      flags: c.flags,
    },
    fields,
    issues: [],
  };
}

/**
 * Loads a model from {@link MocData} of a version (1–6), as
 * `loadMoc(writeMoc(data, { version }))` would: throws
 * {@link MocWriteError} for data `writeMoc` refuses (it does not fit the
 * version, or it fails validateMoc's official level) and `MocFormatError` for data
 * the loader rejects.
 */
export function mocModelFromData(
  data: MocData,
  version: MocVersion,
  options: LoadMocOptions = {},
): MocModel {
  const sections = sectionsFromData(data, version);
  const report = new Report(false);
  checkStructure(data, version, report);
  if (report.errors) throw new MocWriteError(report.list);
  return buildModel(sections, options);
}

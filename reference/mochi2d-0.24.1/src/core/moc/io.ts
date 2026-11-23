/**
 * Reading and writing `.moc3` files as {@link MocData} (docs/moc-data.md):
 *
 * - `readMoc(bytes)` → `{ data, version, diagnostics }`, without building an
 *   evaluator;
 * - `writeMoc(data, { version })` → the file's bytes.
 *
 * The two round-trip: `readMoc(writeMoc(d, { version: v }))` gives back `d`
 * and `v` for every `d` that `writeMoc` accepts. `writeMoc` lays the file out
 * the way genuine files are laid out (below), so writing the data of a
 * genuine file reproduces it byte for byte.
 *
 * Layout written:
 * - the 64-byte header ("MOC3", the version, little-endian, zeros), then
 *   the offset table (480 slots, 1440 from version 6) and the count table
 *   (32 entries, 64 from version 5);
 * - the count table, the 64-byte canvas block, then every array of the
 *   version in slot order (C26), each on a 64-byte boundary, except that a
 *   non-empty ID (name) array follows the placeholder array before it
 *   directly, as in genuine files;
 * - an empty array's offset is the next 64-byte boundary;
 * - placeholder arrays, padding and unused slots are zeros; the file length
 *   is a multiple of 64.
 */
import {
  CANVAS_BLOCK_SIZE,
  CANVAS_SLOT,
  COUNT_TABLE_SLOT,
  ELEMENT_SIZE,
  FIELDS,
  HEADER_SIZE,
  MAX_VERSION,
  MIN_VERSION,
  countSince,
  countTableLength,
  fieldsForVersion,
  slotTableLength,
  type ElementType,
  type FieldKey,
  type FieldSpec,
} from "./schema.js";
import { MocFormatError, readMocSections, type FieldValue, type MocSections } from "./read.js";
import { Report, checkStructure } from "./structure.js";
import {
  MOC_DATA_GROUPS,
  MOC_DATA_LAYOUT,
  type MocCanvasData,
  type MocData,
  type MocDataGroup,
  type MocVersion,
} from "./data.js";

/** One finding of {@link readMoc}, {@link writeMoc} or `validateMoc`. */
export interface MocDiagnostic {
  /** A stable identifier of the problem, for example "index-out-of-range" (docs/moc-data.md). */
  code: string;
  severity: "error" | "warning";
  /**
   * Where: a {@link MocData} group (for example "artMeshes"), "canvas", or
   * "file" for the file as a whole.
   */
  kind: MocDataGroup | "canvas" | "file";
  /** The element of that group, when the problem is in one element. */
  index?: number;
  /** The field of that group (for example "parent"), when there is one. */
  field?: string;
  message: string;
}

/** `writeMoc` refused the data: the diagnostics say why. */
export class MocWriteError extends Error {
  constructor(readonly diagnostics: MocDiagnostic[]) {
    super(
      `cannot write the .moc3 file: ${diagnostics[0]?.message ?? "invalid data"}` +
        (diagnostics.length > 1 ? ` (and ${diagnostics.length - 1} more)` : ""),
    );
    this.name = "MocWriteError";
  }
}

/** The result of {@link readMoc}. */
export interface MocReadResult {
  data: MocData;
  version: MocVersion;
  /** Problems that did not stop reading: a big-endian file, sections out of slot order, a length that is not a multiple of 64. */
  diagnostics: MocDiagnostic[];
}

/** The versions `writeMoc` writes: every version (6 since 0.22.0). */
export const WRITABLE_VERSIONS: readonly MocVersion[] = [1, 2, 3, 4, 5, 6];

const fieldSpec = new Map<FieldKey, FieldSpec>(FIELDS.map((f) => [f.key, f]));
const TYPED: Record<Exclude<ElementType, "name" | "placeholder">, string> = {
  i32: "Int32Array",
  f32: "Float32Array",
  u16: "Uint16Array",
  u8: "Uint8Array",
};
const tag = (v: unknown) => Object.prototype.toString.call(v).slice(8, -1);
const hostLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Whether a group (or one of its fields) exists in a version. */
function groupSince(group: MocDataGroup): number {
  const layout = MOC_DATA_LAYOUT[group];
  if ("pool" in layout) return fieldSpec.get(layout.pool)!.since;
  return Math.min(...Object.values(layout.fields).map((k) => fieldSpec.get(k)!.since));
}

function copyValue(value: FieldValue, type: ElementType): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return [...value];
  switch (type) {
    case "i32":
      return Int32Array.from(value as Int32Array);
    case "f32":
      return new Float32Array(value as Float32Array);
    case "u16":
      return Uint16Array.from(value as Uint16Array);
    case "u8":
      return Uint8Array.from(value as Uint8Array);
    default:
      return value;
  }
}

/** {@link MocData} from the sections of a file. */
export function mocDataFromSections(sections: MocSections): MocData {
  const v = sections.version;
  const value = (key: FieldKey) => {
    const spec = fieldSpec.get(key)!;
    return copyValue(sections.fields.get(key) ?? null, spec.type);
  };
  const c = sections.canvas;
  const data: Record<string, unknown> = {
    canvas: {
      pixelsPerUnit: c.pixelsPerUnit,
      originX: c.originX,
      originY: c.originY,
      width: c.width,
      height: c.height,
      flags: c.flags,
    } satisfies MocCanvasData,
  };
  for (const group of MOC_DATA_GROUPS) {
    if (groupSince(group) > v) continue;
    const layout = MOC_DATA_LAYOUT[group];
    if ("pool" in layout) {
      data[group] = value(layout.pool);
      continue;
    }
    const out: Record<string, unknown> = {};
    for (const [name, key] of Object.entries(layout.fields))
      if (fieldSpec.get(key)!.since <= v) out[name] = value(key);
    data[group] = out;
  }
  return data as unknown as MocData;
}

/**
 * Reads a `.moc3` file into {@link MocData}. Throws {@link MocFormatError}
 * (with a `code`) when the bytes cannot be read at all: not a `.moc3` file,
 * an unknown version, an array past the end of the file, a negative count,
 * or an ID without a NUL. Problems that leave the data intact are returned
 * as diagnostics.
 */
export function readMoc(bytes: ArrayBuffer | ArrayBufferView): MocReadResult {
  let sections: MocSections;
  try {
    sections = readMocSections(bytes, { lenient: true });
  } catch (e) {
    throw endiannessError(bytes, e) ?? e;
  }
  const diagnostics: MocDiagnostic[] = sections.issues.map((i) => ({
    code: i.code,
    severity: "error",
    kind: "file",
    message: i.message,
  }));
  if (sections.bigEndian)
    diagnostics.push({
      code: "big-endian",
      severity: "warning",
      kind: "file",
      message:
        "big-endian file: Mochi2D and the official loader read it, but the official consistency check rejects it",
    });
  return {
    data: mocDataFromSections(sections),
    version: sections.version as MocVersion,
    diagnostics,
  };
}

/**
 * A file whose endianness byte is set while its data is little-endian
 * (1b.7): it fails as a big-endian file but reads with the byte cleared.
 */
function endiannessError(bytes: ArrayBuffer | ArrayBufferView, e: unknown): MocFormatError | null {
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  if (!(e instanceof MocFormatError) || view.length < 64 || view[5] === 0) return null;
  const copy = view.slice();
  copy[5] = 0;
  try {
    readMocSections(copy, { lenient: true });
  } catch {
    return null;
  }
  return new MocFormatError(
    "the endianness byte (byte 5) is set, but the data is little-endian",
    "endianness",
  );
}

// ------------------------------------------------------------------- write

export interface WriteMocOptions {
  /** The file version to write (1–6). */
  version: MocVersion;
}

/** The checked arrays of some data, by schema field, and its count table. */
interface Encodable {
  counts: Int32Array;
  values: Map<FieldKey, ArrayLike<number> | readonly string[]>;
}

const encoder = (s: string): number => {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
};

/**
 * Checks that `data` has exactly the arrays of `version`, of the right
 * types and lengths, and values the file can hold. Returns the diagnostics
 * (errors), and the arrays to encode when there are none.
 */
export function checkMocDataShape(
  data: unknown,
  version: number,
): { diagnostics: MocDiagnostic[]; encodable?: Encodable } {
  const diagnostics: MocDiagnostic[] = [];
  const error = (
    code: string,
    kind: MocDiagnostic["kind"],
    message: string,
    where: { index?: number; field?: string } = {},
  ) => diagnostics.push({ code, severity: "error", kind, ...where, message });
  if (!(Number.isInteger(version) && version >= MIN_VERSION && version <= MAX_VERSION)) {
    error("version", "file", `version ${version} is not a .moc3 version (1–6)`);
    return { diagnostics };
  }
  if (typeof data !== "object" || data === null) {
    error("value-type", "file", "the data must be an object");
    return { diagnostics };
  }
  const d = data as Record<string, unknown>;
  // Canvas.
  const canvas = d.canvas as Record<string, unknown> | undefined;
  if (typeof canvas !== "object" || canvas === null)
    error("missing-field", "canvas", "canvas is missing");
  else {
    for (const f of ["pixelsPerUnit", "originX", "originY", "width", "height"] as const) {
      const x = canvas[f];
      if (typeof x !== "number")
        error("value-type", "canvas", `canvas.${f} must be a number`, { field: f });
      else if (!Object.is(Math.fround(x), x))
        error(
          "not-float32",
          "canvas",
          `canvas.${f} = ${x} is not a float32 value (the file stores float32: use Math.fround)`,
          { field: f },
        );
    }
    const flags = canvas.flags;
    if (!(Number.isInteger(flags) && (flags as number) >= 0 && (flags as number) <= 255))
      error("value-range", "canvas", `canvas.flags = ${String(flags)} must be an integer 0–255`, {
        field: "flags",
      });
    for (const k of Object.keys(canvas))
      if (!["pixelsPerUnit", "originX", "originY", "width", "height", "flags"].includes(k))
        error("unknown-field", "canvas", `canvas.${k} is not a field of the canvas`, { field: k });
  }
  for (const k of Object.keys(d))
    if (k !== "canvas" && !(k in MOC_DATA_LAYOUT))
      error("unknown-field", "file", `${k} is not a group of the model data`);

  const counts = new Int32Array(countTableLength(version));
  const values = new Map<FieldKey, ArrayLike<number> | readonly string[]>();
  const checkArray = (
    group: MocDataGroup,
    name: string | undefined,
    key: FieldKey,
    value: unknown,
  ): number | null => {
    const spec = fieldSpec.get(key)!;
    const where = name ? { field: name } : {};
    const label = name ? `${group}.${name}` : group;
    if (spec.type === "name") {
      if (!Array.isArray(value)) {
        error("value-type", group, `${label} must be an array of strings`, where);
        return null;
      }
      value.forEach((s, i) => {
        if (typeof s !== "string")
          error("value-type", group, `${label}[${i}] must be a string`, { ...where, index: i });
        else if (s.includes("\0"))
          error("name-nul", group, `${label}[${i}] contains a NUL character`, {
            ...where,
            index: i,
          });
        else if (encoder(s) > 63)
          error(
            "name-too-long",
            group,
            `${label}[${i}] "${s}" is ${encoder(s)} bytes in UTF-8; IDs are at most 63`,
            { ...where, index: i },
          );
      });
    } else if (spec.type !== "placeholder") {
      const want = TYPED[spec.type];
      if (tag(value) !== want) {
        error("value-type", group, `${label} must be an ${want} (it is ${tag(value)})`, where);
        return null;
      }
    }
    values.set(key, value as ArrayLike<number> | readonly string[]);
    return (value as ArrayLike<unknown>).length;
  };

  for (const group of MOC_DATA_GROUPS) {
    const layout = MOC_DATA_LAYOUT[group];
    const present = d[group];
    const since = groupSince(group);
    if (since > version) {
      if (present !== undefined)
        error(
          "field-not-in-version",
          group,
          `${group} needs version ${since} or later; version ${version} cannot hold it`,
        );
      continue;
    }
    if (present === undefined) {
      error("missing-field", group, `${group} is missing (version ${version} has it)`);
      continue;
    }
    if ("pool" in layout) {
      const n = checkArray(group, undefined, layout.pool, present);
      if (n !== null) counts[layout.count] = n;
      continue;
    }
    if (typeof present !== "object" || present === null || ArrayBuffer.isView(present)) {
      error("value-type", group, `${group} must be an object of arrays`);
      continue;
    }
    const obj = present as Record<string, unknown>;
    for (const k of Object.keys(obj))
      if (!(k in layout.fields) && obj[k] !== undefined)
        error("unknown-field", group, `${group}.${k} is not a field of ${group}`, { field: k });
    let length: number | null = null;
    let lengthFrom = "";
    for (const [name, key] of Object.entries(layout.fields)) {
      const spec = fieldSpec.get(key)!;
      const value = obj[name];
      if (spec.since > version) {
        if (value !== undefined)
          error(
            "field-not-in-version",
            group,
            `${group}.${name} needs version ${spec.since} or later; version ${version} cannot hold it`,
            { field: name },
          );
        continue;
      }
      if (value === undefined) {
        error("missing-field", group, `${group}.${name} is missing (version ${version} has it)`, {
          field: name,
        });
        continue;
      }
      const n = checkArray(group, name, key, value);
      if (n === null) continue;
      if (length === null) {
        length = n;
        lengthFrom = name;
      } else if (n !== length)
        error(
          "length-mismatch",
          group,
          `${group}.${name} has ${n} elements, but ${group}.${lengthFrom} has ${length}: the arrays of a group are parallel`,
          { field: name },
        );
    }
    if (length !== null) counts[layout.count] = length;
  }
  for (let i = 0; i < counts.length; i++) if (countSince(i) > version) counts[i] = 0;
  return diagnostics.length ? { diagnostics } : { diagnostics, encodable: { counts, values } };
}

/**
 * Writes {@link MocData} as a `.moc3` file of `version` (1–6). Throws
 * {@link MocWriteError} with every problem when the data does not fit the
 * version (arrays missing or of a later version, wrong types or lengths, IDs
 * longer than 63 bytes, canvas values that are not float32), or when the
 * data fails the `official` level of `validateMoc` (which includes the check
 * of keyform position runs). Equal input gives byte-identical output.
 */
export function writeMoc(data: MocData, options: WriteMocOptions): Uint8Array {
  const version = checkWritableVersion(options?.version);
  const { diagnostics, encodable } = checkMocDataShape(data, version);
  if (!encodable) throw new MocWriteError(diagnostics);
  const report = new Report(false);
  checkStructure(data, version, report);
  if (report.errors) throw new MocWriteError(report.list);
  return encode(version, data.canvas, encodable);
}

/**
 * Internal: {@link writeMoc} without the structure checks, for tests and
 * crafted files that must break the format on purpose. The data must still
 * fit the version.
 */
export function writeMocUnchecked(data: MocData, options: WriteMocOptions): Uint8Array {
  const version = checkWritableVersion(options?.version);
  const { diagnostics, encodable } = checkMocDataShape(data, version);
  if (!encodable) throw new MocWriteError(diagnostics);
  return encode(version, data.canvas, encodable);
}

function checkWritableVersion(version: number | undefined): MocVersion {
  if (!WRITABLE_VERSIONS.includes(version as MocVersion))
    throw new MocWriteError([
      {
        code: "version-unsupported",
        severity: "error",
        kind: "file",
        message: `cannot write version ${String(version)}: writeMoc writes versions 1–6`,
      },
    ]);
  return version as MocVersion;
}

/** The genuine layout (module comment). */
function encode(version: number, canvas: MocCanvasData, input: Encodable): Uint8Array {
  const { counts, values } = input;
  const slots = slotTableLength(version);
  const countEntries = countTableLength(version);
  const fields = [...fieldsForVersion(version)].sort((a, b) => a.slot - b.slot);
  const align = (x: number) => Math.ceil(x / 64) * 64;
  const offsets = new Uint32Array(slots);
  let end = HEADER_SIZE + slots * 4;
  const place = (size: number, packed: boolean): number => {
    const start = packed && size > 0 ? end : align(end);
    if (size > 0) end = start + size;
    return start;
  };
  offsets[COUNT_TABLE_SLOT] = place(countEntries * 4, false);
  offsets[CANVAS_SLOT] = place(CANVAS_BLOCK_SIZE, false);
  const placed: { spec: FieldSpec; start: number; count: number }[] = [];
  for (const spec of fields) {
    const count = counts[spec.count]!;
    const start = place(count * ELEMENT_SIZE[spec.type], spec.type === "name");
    offsets[spec.slot] = start;
    placed.push({ spec, start, count });
  }
  const bytes = new Uint8Array(align(end));
  const dv = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x4f, 0x43, 0x33, version, 0], 0); // "MOC3", version, little-endian
  for (let i = 0; i < slots; i++) dv.setUint32(HEADER_SIZE + i * 4, offsets[i]!, true);
  for (let i = 0; i < countEntries; i++)
    dv.setInt32(offsets[COUNT_TABLE_SLOT]! + i * 4, counts[i]!, true);
  const c = offsets[CANVAS_SLOT]!;
  dv.setFloat32(c, canvas.pixelsPerUnit, true);
  dv.setFloat32(c + 4, canvas.originX, true);
  dv.setFloat32(c + 8, canvas.originY, true);
  dv.setFloat32(c + 12, canvas.width, true);
  dv.setFloat32(c + 16, canvas.height, true);
  bytes[c + 20] = canvas.flags;
  for (const { spec, start, count } of placed) {
    if (count === 0 || spec.type === "placeholder") continue;
    const value = values.get(spec.key)!;
    if (spec.type === "name") {
      const names = value as readonly string[];
      for (let i = 0; i < count; i++) writeName(bytes, start + i * 64, names[i]!);
      continue;
    }
    const arr = value as Int32Array | Float32Array | Uint16Array | Uint8Array;
    const size = ELEMENT_SIZE[spec.type];
    if (hostLittleEndian || size === 1) {
      // The raw bytes, so float32 bit patterns (NaN payloads too) are kept.
      bytes.set(new Uint8Array(arr.buffer, arr.byteOffset, count * size), start);
      continue;
    }
    const src = new Uint8Array(arr.buffer, arr.byteOffset, count * size);
    for (let i = 0; i < count * size; i += size)
      for (let b = 0; b < size; b++) bytes[start + i + b] = src[i + size - 1 - b]!;
  }
  return bytes;
}

function writeName(bytes: Uint8Array, at: number, s: string): void {
  let o = at;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) bytes[o++] = cp;
    else if (cp < 0x800) {
      bytes[o++] = 0xc0 | (cp >> 6);
      bytes[o++] = 0x80 | (cp & 63);
    } else if (cp < 0x10000) {
      bytes[o++] = 0xe0 | (cp >> 12);
      bytes[o++] = 0x80 | ((cp >> 6) & 63);
      bytes[o++] = 0x80 | (cp & 63);
    } else {
      bytes[o++] = 0xf0 | (cp >> 18);
      bytes[o++] = 0x80 | ((cp >> 12) & 63);
      bytes[o++] = 0x80 | ((cp >> 6) & 63);
      bytes[o++] = 0x80 | (cp & 63);
    }
  }
}

/**
 * Reads the raw sections of a `.moc3` file (§1b.1–1b.5).
 *
 * This stage only checks what is needed to read safely: header, file length,
 * table and section bounds, counts and names. Structural validation of the
 * contents happens in validate.ts.
 */
import { ByteReader, BinaryReadError } from "../binary/byte-reader.js";
import { decodeUtf8 } from "../binary/utf8.js";
import {
  CANVAS_BLOCK_SIZE,
  CANVAS_SLOT,
  COUNT_NAMES,
  COUNT_TABLE_SLOT,
  ELEMENT_SIZE,
  HEADER_SIZE,
  MAGIC,
  MAX_VERSION,
  MIN_VERSION,
  countSince,
  countTableLength,
  fieldsForVersion,
  slotTableLength,
  type FieldKey,
  type FieldSpec,
} from "./schema.js";

/** A `.moc3` file that cannot be loaded. */
export class MocFormatError extends Error {
  constructor(
    message: string,
    /** What is wrong, as a stable code (for example "magic" or "section-bounds"); see docs/moc-data.md. */
    readonly code: string = "invalid",
  ) {
    super(message);
    this.name = "MocFormatError";
  }
}

/** A problem that {@link readMocSections} reports instead of failing, in lenient mode. */
export interface ReadIssue {
  code: "file-length" | "slot-order";
  message: string;
}

export interface ReadMocOptions {
  /**
   * Report a file length that is not a multiple of 64 and sections out of
   * slot order (C26) in `issues` instead of failing: the data can still be
   * read. Default false (the loader fails, as 1b.7 requires).
   */
  lenient?: boolean;
}

export interface MocCanvas {
  pixelsPerUnit: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** Bit 0 set: no output conversion (§1b.4). */
  flags: number;
}

export type FieldValue = Int32Array | Float32Array | Uint16Array | Uint8Array | string[] | null;

/** The file's arrays, keyed by schema field. Placeholder arrays are `null`. */
export interface MocSections {
  version: number;
  bigEndian: boolean;
  byteLength: number;
  /** Count table (all entries the version defines; others are 0). */
  counts: Int32Array;
  canvas: MocCanvas;
  fields: Map<FieldKey, FieldValue>;
  /** Problems found in lenient mode (empty otherwise). */
  issues: ReadIssue[];
}

function fail(message: string, code = "invalid"): never {
  throw new MocFormatError(message, code);
}

function readNames(r: ByteReader, offset: number, count: number, field: FieldSpec): string[] {
  const out = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const raw = r.viewAt(offset + i * 64, 64, field.key);
    const end = raw.indexOf(0);
    if (end < 0)
      fail(`${field.key}[${i}]: name has no NUL terminator within 64 bytes`, "name-terminator");
    out[i] = decodeUtf8(raw.subarray(0, end));
  }
  return out;
}

/** Reads header, tables and every section. Throws {@link MocFormatError}. */
export function readMocSections(
  data: ArrayBuffer | ArrayBufferView,
  options: ReadMocOptions = {},
): MocSections {
  try {
    return readUnchecked(data, options.lenient === true);
  } catch (e) {
    if (e instanceof MocFormatError) throw e;
    if (e instanceof BinaryReadError) throw new MocFormatError(e.message, "section-bounds");
    throw e;
  }
}

function readUnchecked(data: ArrayBuffer | ArrayBufferView, lenient: boolean): MocSections {
  const issues: ReadIssue[] = [];
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const byteLength = bytes.byteLength;
  if (byteLength < HEADER_SIZE)
    fail(`file is ${byteLength} bytes, shorter than the 64-byte header`, "file-length");
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== MAGIC) fail(`bad magic ${JSON.stringify(magic)} (expected "MOC3")`, "magic");
  const version = bytes[4]!;
  if (version < MIN_VERSION || version > MAX_VERSION) {
    fail(
      `unsupported file version ${version} (supported ${MIN_VERSION}–${MAX_VERSION})`,
      "version",
    );
  }
  if (byteLength % 64 !== 0) {
    const message = `file length ${byteLength} is not a multiple of 64`;
    if (!lenient) fail(message, "file-length");
    issues.push({ code: "file-length", message });
  }
  // Big-endian files load when their data is swapped (P3). The
  // official consistency check rejects them; keeping them is the one
  // deliberate exception to "reject everything it rejects".
  const bigEndian = bytes[5] !== 0;
  const r = new ByteReader(bytes, 0, byteLength, !bigEndian);

  // Offset table.
  const slotCount = slotTableLength(version);
  if (HEADER_SIZE + slotCount * 4 > byteLength) {
    fail(`offset table (${slotCount} slots) extends past end of file`, "section-bounds");
  }
  const slots = r.u32ArrayAt(HEADER_SIZE, slotCount, "offset table");

  // Count table.
  const countOffset = slots[COUNT_TABLE_SLOT]!;
  const countEntries = countTableLength(version);
  if (countOffset + countEntries * 4 > byteLength)
    fail(`count table at ${countOffset} extends past end of file`, "section-bounds");
  const rawCounts = r.i32ArrayAt(countOffset, countEntries, "count table");
  const counts = new Int32Array(countEntries);
  for (let i = 0; i < countEntries; i++) {
    if (countSince(i) > version) continue; // undefined for this version
    const n = rawCounts[i]!;
    if (n < 0) fail(`negative count ${n} for ${COUNT_NAMES[i] ?? `count ${i}`}`, "negative-count");
    counts[i] = n;
  }

  // Canvas block.
  const canvasOffset = slots[CANVAS_SLOT]!;
  if (canvasOffset + CANVAS_BLOCK_SIZE > byteLength)
    fail(`canvas block at ${canvasOffset} extends past end of file`, "section-bounds");
  const canvas: MocCanvas = {
    pixelsPerUnit: r.f32At(canvasOffset),
    originX: r.f32At(canvasOffset + 4),
    originY: r.f32At(canvasOffset + 8),
    width: r.f32At(canvasOffset + 12),
    height: r.f32At(canvasOffset + 16),
    flags: r.u8At(canvasOffset + 20),
  };

  // Sections.
  const fields = new Map<FieldKey, FieldValue>();
  const sections: { slot: number; what: string; start: number; end: number }[] = [
    {
      slot: COUNT_TABLE_SLOT,
      what: "count table",
      start: countOffset,
      end: countOffset + countEntries * 4,
    },
    {
      slot: CANVAS_SLOT,
      what: "canvas block",
      start: canvasOffset,
      end: canvasOffset + CANVAS_BLOCK_SIZE,
    },
  ];
  for (const field of fieldsForVersion(version)) {
    const count = counts[field.count]!;
    const offset = slots[field.slot]!;
    const size = count * ELEMENT_SIZE[field.type];
    if (count > 0 && offset + size > byteLength) {
      fail(
        `section ${field.key} (slot ${field.slot}, ${count} × ${ELEMENT_SIZE[field.type]} bytes at ${offset}) extends past end of file (${byteLength} bytes)`,
        "section-bounds",
      );
    }
    if (size > 0)
      sections.push({
        slot: field.slot,
        what: `section ${field.key}`,
        start: offset,
        end: offset + size,
      });
    let value: FieldValue;
    switch (field.type) {
      case "placeholder":
        value = null;
        break;
      case "name":
        value = readNames(r, offset, count, field);
        break;
      case "i32":
        value = count ? r.i32ArrayAt(offset, count, field.key) : new Int32Array(0);
        break;
      case "f32":
        value = count ? r.f32ArrayAt(offset, count, field.key) : new Float32Array(0);
        break;
      case "u16":
        value = count ? r.u16ArrayAt(offset, count, field.key) : new Uint16Array(0);
        break;
      case "u8":
        value = count ? r.bytesAt(offset, count, field.key) : new Uint8Array(0);
        break;
    }
    fields.set(field.key, value);
  }
  const order = slotOrderProblem(sections, HEADER_SIZE + slotCount * 4);
  if (order) {
    if (!lenient) fail(order, "slot-order");
    issues.push({ code: "slot-order", message: order });
  }
  return { version, bigEndian, byteLength, counts, canvas, fields, issues };
}

/**
 * Sections in slot order (C26): taken in slot order, each
 * non-empty section must start at or after the end of the previous one, and
 * the first after the offset table. Gaps and any alignment are allowed;
 * overlaps and any other order are rejected. Empty arrays play no part.
 */
function slotOrderProblem(
  sections: { slot: number; what: string; start: number; end: number }[],
  tableEnd: number,
): string | null {
  const inOrder = [...sections].sort((a, b) => a.slot - b.slot);
  let prev = { what: "the offset table", slot: -1, end: tableEnd };
  for (const s of inOrder) {
    if (s.start < prev.end)
      return `${s.what} (slot ${s.slot}) starts at byte ${s.start}, before the end (${prev.end}) of ${prev.slot >= 0 ? `${prev.what} (slot ${prev.slot})` : prev.what}: sections must be in slot order without overlaps`;
    prev = s;
  }
  return null;
}

/** Typed accessors that fail loudly on schema mistakes. */
export class SectionAccess {
  constructor(readonly sections: MocSections) {}

  has(key: FieldKey): boolean {
    return this.sections.fields.has(key);
  }

  i32(key: FieldKey): Int32Array {
    const v = this.sections.fields.get(key);
    if (v === undefined) return new Int32Array(0);
    if (!(v instanceof Int32Array)) throw new Error(`${key} is not an i32 field`);
    return v;
  }

  f32(key: FieldKey): Float32Array {
    const v = this.sections.fields.get(key);
    if (v === undefined) return new Float32Array(0);
    if (!(v instanceof Float32Array)) throw new Error(`${key} is not an f32 field`);
    return v;
  }

  u16(key: FieldKey): Uint16Array {
    const v = this.sections.fields.get(key);
    if (v === undefined) return new Uint16Array(0);
    if (!(v instanceof Uint16Array)) throw new Error(`${key} is not a u16 field`);
    return v;
  }

  u8(key: FieldKey): Uint8Array {
    const v = this.sections.fields.get(key);
    if (v === undefined) return new Uint8Array(0);
    if (!(v instanceof Uint8Array)) throw new Error(`${key} is not a u8 field`);
    return v;
  }

  names(key: FieldKey): string[] {
    const v = this.sections.fields.get(key);
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${key} is not a name field`);
    return v;
  }

  count(index: number): number {
    return this.sections.counts[index] ?? 0;
  }
}

/**
 * Writes `.moc3` files from raw arrays, using the same schema as the reader
 * (§1b). Used to build synthetic files for tests and tools.
 * Sections are written in slot order (C26), each on a 64-byte
 * boundary by default; the file length is padded to a multiple of 64.
 */
import {
  CANVAS_BLOCK_SIZE,
  CANVAS_SLOT,
  COUNT_TABLE_SLOT,
  ELEMENT_SIZE,
  HEADER_SIZE,
  countSince,
  countTableLength,
  fieldsForVersion,
  slotTableLength,
  type FieldKey,
} from "./schema.js";
import type { MocCanvas } from "./read.js";

export interface MocWriteInput {
  version: number;
  bigEndian?: boolean;
  canvas: MocCanvas;
  /** Arrays by field; missing fields are written as zeros (names as empty strings). */
  fields: Partial<Record<FieldKey, ArrayLike<number> | readonly string[]>>;
  /** Explicit counts; by default each count is the length of its group's arrays. */
  counts?: Partial<Record<number, number>>;
  /** Extra bytes added to every section offset (to test misaligned files). */
  sectionShift?: number;
  /** Section alignment in bytes (default 64). */
  alignment?: number;
  /**
   * "slot" (default): sections in slot order, as C26 requires. "schema": the
   * order of the schema table, which puts later versions' arrays next to the
   * first version's arrays of the same kind; such files are invalid (tests of
   * C26 only).
   */
  sectionOrder?: "slot" | "schema";
}

const utf8 = (s: string): Uint8Array => {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return Uint8Array.from(out);
};

export function writeMoc(input: MocWriteInput): Uint8Array {
  const v = input.version;
  const le = !input.bigEndian;
  const schemaOrder = fieldsForVersion(v);
  const fields =
    input.sectionOrder === "schema"
      ? schemaOrder
      : [...schemaOrder].sort((a, b) => a.slot - b.slot);
  const countEntries = countTableLength(v);
  const counts = new Int32Array(countEntries);
  // Derive counts from the provided arrays.
  for (const f of fields) {
    const arr = input.fields[f.key];
    if (arr !== undefined && countSince(f.count) <= v)
      counts[f.count] = Math.max(counts[f.count]!, arr.length);
  }
  for (const [k, n] of Object.entries(input.counts ?? {})) counts[Number(k)] = n!;

  const slots = slotTableLength(v);
  const step = input.alignment ?? 64;
  const align = (x: number) => Math.ceil(x / step) * step;
  let cursor = align(HEADER_SIZE + slots * 4);
  const shift = input.sectionShift ?? 0;
  const offsets = new Uint32Array(slots);
  offsets[COUNT_TABLE_SLOT] = cursor;
  cursor = align(cursor + countEntries * 4);
  offsets[CANVAS_SLOT] = cursor;
  cursor = align(cursor + CANVAS_BLOCK_SIZE);
  const placed: { key: FieldKey; offset: number; size: number }[] = [];
  for (const f of fields) {
    const n = counts[f.count] ?? 0;
    const size = n * ELEMENT_SIZE[f.type];
    offsets[f.slot] = cursor + shift;
    placed.push({ key: f.key, offset: cursor + shift, size });
    cursor = align(cursor + shift + size);
  }
  const total = Math.ceil(cursor / 64) * 64;
  const bytes = new Uint8Array(total);
  const dv = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x4f, 0x43, 0x33], 0); // "MOC3"
  bytes[4] = v;
  bytes[5] = le ? 0 : 1;
  for (let i = 0; i < slots; i++) dv.setUint32(HEADER_SIZE + i * 4, offsets[i]!, le);
  for (let i = 0; i < countEntries; i++)
    dv.setInt32(offsets[COUNT_TABLE_SLOT]! + i * 4, counts[i]!, le);
  const c = offsets[CANVAS_SLOT]!;
  dv.setFloat32(c, input.canvas.pixelsPerUnit, le);
  dv.setFloat32(c + 4, input.canvas.originX, le);
  dv.setFloat32(c + 8, input.canvas.originY, le);
  dv.setFloat32(c + 12, input.canvas.width, le);
  dv.setFloat32(c + 16, input.canvas.height, le);
  bytes[c + 20] = input.canvas.flags;

  const specByKey = new Map(fields.map((f) => [f.key, f]));
  for (const p of placed) {
    const f = specByKey.get(p.key)!;
    const n = counts[f.count] ?? 0;
    const arr = input.fields[p.key];
    for (let i = 0; i < n; i++) {
      const at = p.offset + i * ELEMENT_SIZE[f.type];
      switch (f.type) {
        case "placeholder":
          break;
        case "name": {
          const s = (arr as readonly string[] | undefined)?.[i] ?? "";
          const b = utf8(s);
          if (b.length > 63) throw new Error(`name "${s}" is longer than 63 bytes`);
          bytes.set(b, at);
          break;
        }
        case "i32":
          dv.setInt32(at, Number((arr as ArrayLike<number> | undefined)?.[i] ?? 0), le);
          break;
        case "f32":
          dv.setFloat32(at, Number((arr as ArrayLike<number> | undefined)?.[i] ?? 0), le);
          break;
        case "u16":
          dv.setUint16(at, Number((arr as ArrayLike<number> | undefined)?.[i] ?? 0), le);
          break;
        case "u8":
          bytes[at] = Number((arr as ArrayLike<number> | undefined)?.[i] ?? 0);
          break;
      }
    }
  }
  return bytes;
}

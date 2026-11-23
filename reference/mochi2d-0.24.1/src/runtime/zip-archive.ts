/**
 * Reading zip archives at the level of their records: the central directory
 * with each entry's raw name bytes, flags and extra fields, and the data of
 * stored or deflated entries. Name decoding is separate (zip-names.ts).
 * Pure TypeScript: runs in browsers, workers and Node.
 */
import { Inflate } from "fflate";

/** One entry of the central directory. */
export interface ZipRecord {
  /** The file name exactly as stored. */
  rawName: Uint8Array;
  /** General purpose bit flags (bit 0: encrypted, bit 11: UTF-8 name). */
  flags: number;
  /** Compression method: 0 stored, 8 deflated. */
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local header. */
  localOffset: number;
  /** The central directory record's extra field. */
  extra: Uint8Array;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

/**
 * Caps on what an archive source may inflate to. Each is a number of bytes
 * (entries for `maxEntries`); `Infinity` turns a cap off.
 */
export interface ArchiveLimits {
  /** The most one entry may inflate to. */
  maxEntryBytes?: number;
  /** The most the entries read, each counted once, may inflate to together. */
  maxTotalBytes?: number;
  /** The most entries the archive's directory may list. */
  maxEntries?: number;
}

/** The caps archive sources use when not given others. */
export const DEFAULT_ARCHIVE_LIMITS: Readonly<Required<ArchiveLimits>> = Object.freeze({
  maxEntryBytes: 256 * 2 ** 20,
  maxTotalBytes: 2 ** 30,
  maxEntries: 10_000,
});

/** Which cap an archive passed: one entry's size, the total read, or the entry count. */
export type ArchiveLimitKind = "entry" | "total" | "entries";

/** An archive that passes one of its source's {@link ArchiveLimits}. */
export class ArchiveLimitError extends Error {
  constructor(
    /** The entry being read, or the archive's label for `"entries"`. */
    readonly path: string,
    readonly kind: ArchiveLimitKind,
    /** The cap passed. */
    readonly limit: number,
    /** What was counted when it was passed: bytes, or entries. */
    readonly size: number,
  ) {
    super(
      kind === "entries"
        ? `${path}: the archive lists ${size} entries, more than the ${limit} allowed`
        : kind === "entry"
          ? `"${path}" inflates to ${size} bytes or more, more than the ${limit} allowed for one entry`
          : `"${path}": reading it takes the archive past the ${limit} bytes allowed in total (${size})`,
    );
    this.name = "ArchiveLimitError";
  }
}

/** General purpose flag: the name and comment are UTF-8. */
export const ZIP_FLAG_UTF8 = 0x800;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_END64_LOCATOR = 0x07064b50;

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

/** True if the bytes start like a zip archive (a local header or an empty archive). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const sig = u32(bytes, 0);
  return sig === SIG_LOCAL || sig === SIG_END || sig === 0x08074b50;
}

/**
 * The data of the extra field with the given header ID, or undefined. Extra
 * fields are a sequence of (ID, size, data) blocks.
 */
export function findExtraField(extra: Uint8Array, id: number): Uint8Array | undefined {
  for (let o = 0; o + 4 <= extra.length;) {
    const tag = u16(extra, o);
    const size = u16(extra, o + 2);
    if (o + 4 + size > extra.length) return undefined;
    if (tag === id) return extra.subarray(o + 4, o + 4 + size);
    o += 4 + size;
  }
  return undefined;
}

function findEnd(bytes: Uint8Array): number {
  // The end record is 22 bytes plus a comment of at most 65535 bytes.
  const last = bytes.length - 22;
  const first = Math.max(0, last - 0xffff);
  for (let o = last; o >= first; o--) {
    if (bytes[o] === 0x50 && bytes[o + 1] === 0x4b && u32(bytes, o) === SIG_END) {
      if (o + 22 + u16(bytes, o + 20) <= bytes.length) return o;
    }
  }
  return -1;
}

/**
 * Reads the central directory: one record per entry, in directory order.
 * Throws {@link ArchiveLimitError} (kind "entries") when it lists more than
 * `maxEntries`, before reading the records.
 */
export function readZipDirectory(
  bytes: Uint8Array,
  maxEntries = Infinity,
  label = "archive",
): ZipRecord[] {
  const end = findEnd(bytes);
  if (end < 0) throw new ZipFormatError("not a zip archive (no end of central directory record)");
  let count = u16(bytes, end + 10);
  let size = u32(bytes, end + 12);
  let offset = u32(bytes, end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    // ZIP64: the locator just before the end record points to the ZIP64 end record.
    const loc = end - 20;
    if (loc >= 0 && u32(bytes, loc) === SIG_END64_LOCATOR) {
      const e64 = u64(bytes, loc + 8);
      if (e64 + 56 <= bytes.length && u32(bytes, e64) === SIG_END64) {
        count = u64(bytes, e64 + 32);
        size = u64(bytes, e64 + 40);
        offset = u64(bytes, e64 + 48);
      }
    }
  }
  if (count > maxEntries) throw new ArchiveLimitError(label, "entries", maxEntries, count);
  // Data before the archive (a self-extractor stub) shifts every offset.
  let shift = 0;
  if (offset + 4 > bytes.length || u32(bytes, offset) !== SIG_CENTRAL) {
    const start = end - size;
    if (count > 0 && start >= 0 && u32(bytes, start) === SIG_CENTRAL) shift = start - offset;
    else if (count > 0)
      throw new ZipFormatError("the central directory is not where the archive says");
  }
  const records: ZipRecord[] = [];
  let o = offset + shift;
  for (let i = 0; i < count; i++) {
    if (o + 46 > bytes.length || u32(bytes, o) !== SIG_CENTRAL)
      throw new ZipFormatError(`central directory entry ${i} is damaged`);
    const nameLen = u16(bytes, o + 28);
    const extraLen = u16(bytes, o + 30);
    const commentLen = u16(bytes, o + 32);
    const rawName = bytes.subarray(o + 46, o + 46 + nameLen);
    const extra = bytes.subarray(o + 46 + nameLen, o + 46 + nameLen + extraLen);
    let compressedSize = u32(bytes, o + 20);
    let fileSize = u32(bytes, o + 24);
    let localOffset = u32(bytes, o + 42);
    if (compressedSize === 0xffffffff || fileSize === 0xffffffff || localOffset === 0xffffffff) {
      // ZIP64 extra field: only the fields that overflowed, in this order.
      const z = findExtraField(extra, 0x0001);
      let p = 0;
      const next = () => {
        if (!z || p + 8 > z.length) throw new ZipFormatError(`entry ${i}: damaged ZIP64 field`);
        const v = u64(z, p);
        p += 8;
        return v;
      };
      if (fileSize === 0xffffffff) fileSize = next();
      if (compressedSize === 0xffffffff) compressedSize = next();
      if (localOffset === 0xffffffff) localOffset = next();
    }
    records.push({
      rawName,
      flags: u16(bytes, o + 8),
      method: u16(bytes, o + 10),
      crc32: u32(bytes, o + 16),
      compressedSize,
      size: fileSize,
      localOffset: localOffset + shift,
      extra,
    });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return records;
}

/** The extra field of an entry's local header (some writers put fields only there). */
export function localExtraField(bytes: Uint8Array, rec: ZipRecord): Uint8Array {
  const o = rec.localOffset;
  if (o + 30 > bytes.length || u32(bytes, o) !== SIG_LOCAL) return new Uint8Array(0);
  const nameLen = u16(bytes, o + 26);
  const extraLen = u16(bytes, o + 28);
  return bytes.subarray(o + 30 + nameLen, o + 30 + nameLen + extraLen);
}

/** The size an entry inflates to by its directory record (a stored entry's is its data). */
export function declaredSize(rec: ZipRecord): number {
  return rec.method === 0 ? rec.compressedSize : rec.size;
}

/**
 * Compressed bytes pushed to the inflater at a time. One push gives at most
 * about 1,032 times its size, so each step is sized from the bytes still
 * allowed: one step's output stays under the larger of a quarter of those
 * bytes and {@link STEP_SLACK}. Smaller steps would cost more time than
 * they save memory (the inflater copies its window on every push). The
 * step is at most {@link MAX_STEP}.
 */
const STEP_SLACK = 16 * 2 ** 20;
const MAX_STEP = 64 * 1024;

/**
 * The uncompressed data of an entry (a new array), at most `maxBytes` long.
 * `name` is only used in error messages.
 *
 * - An entry whose directory record declares more than `maxBytes` is refused
 *   with {@link ArchiveLimitError} before anything inflates.
 * - A deflated entry inflates as a stream, in small steps, counting the real
 *   bytes: the moment they pass the declared size, it stops and throws
 *   {@link ZipFormatError}. It keeps at most the declared size (itself at
 *   most `maxBytes`). While inflating it briefly holds at most about as
 *   much again, or about 40 MiB for a small entry.
 * - The CRC-32 of the data must match the record's, or it throws
 *   {@link ZipFormatError}.
 */
export function zipEntryData(
  bytes: Uint8Array,
  rec: ZipRecord,
  name: string,
  maxBytes = Infinity,
): Uint8Array {
  const o = rec.localOffset;
  if (o + 30 > bytes.length || u32(bytes, o) !== SIG_LOCAL)
    throw new ZipFormatError(`"${name}": the local header is missing`);
  if (rec.flags & 1) throw new ZipFormatError(`"${name}" is encrypted, which is not supported`);
  if (rec.method !== 0 && rec.method !== 8)
    throw new ZipFormatError(
      `"${name}" uses compression method ${rec.method}; only stored and deflated entries are supported`,
    );
  const size = declaredSize(rec);
  if (size > maxBytes) throw new ArchiveLimitError(name, "entry", maxBytes, size);
  const start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
  const end = start + rec.compressedSize;
  if (end > bytes.length) throw new ZipFormatError(`"${name}" is cut off`);
  const data = bytes.subarray(start, end);
  let out: Uint8Array;
  if (rec.method === 0) out = data.slice();
  else {
    // Deflate expands at most about 1032:1: a larger size is a corrupt header,
    // refused before the buffer is allocated.
    if (rec.size > 1032 * rec.compressedSize + 64)
      throw new ZipFormatError(
        `"${name}" claims ${rec.size} bytes from ${rec.compressedSize} compressed bytes, more than deflate produces`,
      );
    out = inflateCounted(data, rec.size, name);
  }
  if (crc32(out) !== rec.crc32)
    throw new ZipFormatError(`"${name}" is damaged: its CRC-32 does not match the archive's`);
  return out;
}

/** Inflates `data` into exactly `size` bytes, stopping as soon as it would give more. */
function inflateCounted(data: Uint8Array, size: number, name: string): Uint8Array {
  const out = new Uint8Array(size);
  let n = 0;
  let over = false;
  const inflater = new Inflate((chunk) => {
    if (over) return;
    if (n + chunk.length > size) {
      over = true;
      return;
    }
    out.set(chunk, n);
    n += chunk.length;
  });
  try {
    if (data.length === 0) inflater.push(data, true);
    for (let at = 0; at < data.length && !over;) {
      const step = Math.min(MAX_STEP, Math.floor(Math.max((size - n) / 4, STEP_SLACK) / 1032));
      const stop = Math.min(at + step, data.length);
      inflater.push(data.subarray(at, stop), stop === data.length);
      at = stop;
    }
  } catch (e) {
    throw new ZipFormatError(
      `"${name}": the compressed data is damaged (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (over)
    throw new ZipFormatError(
      `"${name}" inflates past the ${size} bytes its directory record declares (damaged or crafted)`,
    );
  if (n !== size) throw new ZipFormatError(`"${name}": expected ${size} bytes, got ${n}`);
  return out;
}

let crcTables: Uint32Array[] | undefined;

/** Eight tables: table k gives the CRC of a byte followed by k zero bytes (slicing by 8). */
function crcTablesFor(): Uint32Array[] {
  if (crcTables) return crcTables;
  const t0 = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t0[n] = c >>> 0;
  }
  const tables = [t0];
  for (let k = 1; k < 8; k++) {
    const prev = tables[k - 1]!;
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) t[n] = (prev[n]! >>> 8) ^ t0[prev[n]! & 0xff]!;
    tables.push(t);
  }
  return (crcTables = tables);
}

/** CRC-32 (the zip and PNG polynomial 0xEDB88320). */
export function crc32(bytes: Uint8Array): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = crcTablesFor() as [
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
  ];
  let c = 0xffffffff;
  let i = 0;
  const n8 = bytes.length - (bytes.length % 8);
  for (; i < n8; i += 8) {
    c ^= bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24);
    c =
      t7[c & 0xff]! ^
      t6[(c >>> 8) & 0xff]! ^
      t5[(c >>> 16) & 0xff]! ^
      t4[c >>> 24]! ^
      t3[bytes[i + 4]!]! ^
      t2[bytes[i + 5]!]! ^
      t1[bytes[i + 6]!]! ^
      t0[bytes[i + 7]!]!;
  }
  for (; i < bytes.length; i++) c = t0[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

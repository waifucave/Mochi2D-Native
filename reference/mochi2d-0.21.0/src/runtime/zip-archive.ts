/**
 * Reading zip archives at the level of their records: the central directory
 * with each entry's raw name bytes, flags and extra fields, and the data of
 * stored or deflated entries. Name decoding is separate (zip-names.ts).
 * Pure TypeScript: runs in browsers, workers and Node.
 */
import { inflateSync } from "fflate";

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

/** Reads the central directory: one record per entry, in directory order. */
export function readZipDirectory(bytes: Uint8Array): ZipRecord[] {
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

/**
 * The uncompressed data of an entry (a new array). `name` is only used in
 * error messages.
 */
export function zipEntryData(bytes: Uint8Array, rec: ZipRecord, name: string): Uint8Array {
  const o = rec.localOffset;
  if (o + 30 > bytes.length || u32(bytes, o) !== SIG_LOCAL)
    throw new ZipFormatError(`"${name}": the local header is missing`);
  if (rec.flags & 1) throw new ZipFormatError(`"${name}" is encrypted, which is not supported`);
  const start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
  const end = start + rec.compressedSize;
  if (end > bytes.length) throw new ZipFormatError(`"${name}" is cut off`);
  const data = bytes.subarray(start, end);
  let out: Uint8Array;
  if (rec.method === 0) out = data.slice();
  else if (rec.method === 8) {
    // Deflate expands at most about 1032:1: a larger size is a corrupt header,
    // refused before the buffer is allocated.
    if (rec.size > 1032 * rec.compressedSize + 64)
      throw new ZipFormatError(
        `"${name}" claims ${rec.size} bytes from ${rec.compressedSize} compressed bytes, more than deflate produces`,
      );
    try {
      out = inflateSync(data, { out: new Uint8Array(rec.size) });
    } catch (e) {
      throw new ZipFormatError(
        `"${name}": the compressed data is damaged (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  } else
    throw new ZipFormatError(
      `"${name}" uses compression method ${rec.method}; only stored and deflated entries are supported`,
    );
  if (out.length !== rec.size)
    throw new ZipFormatError(`"${name}": expected ${rec.size} bytes, got ${out.length}`);
  return out;
}

let crcTable: Uint32Array | undefined;

/** CRC-32 (the zip and PNG polynomial 0xEDB88320). */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

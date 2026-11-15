/**
 * A small zip writer for tests: entries with raw name bytes, flags and extra
 * fields exactly as given, so archives made by tools that do not write UTF-8
 * names can be reproduced. Stored or deflated; optionally ZIP64 records.
 */
import { deflateSync } from "fflate";
import { crc32 } from "../../src/runtime/zip-archive.js";

export interface TestZipEntry {
  /** The name as stored: a string is written as UTF-8. */
  name: Uint8Array | string;
  data: Uint8Array | string;
  /** General purpose flags (bit 11: UTF-8 name). Default 0. */
  flags?: number;
  /** Extra field of the central directory record. */
  extra?: Uint8Array;
  /** Extra field of the local header. */
  localExtra?: Uint8Array;
  deflate?: boolean;
}

const bytes = (x: Uint8Array | string) => (typeof x === "string" ? new TextEncoder().encode(x) : x);

class Out {
  private parts: number[] = [];
  get length() {
    return this.parts.length;
  }
  u8(...v: number[]) {
    this.parts.push(...v);
  }
  u16(v: number) {
    this.u8(v & 0xff, (v >>> 8) & 0xff);
  }
  u32(v: number) {
    this.u8(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  u64(v: number) {
    this.u32(v % 2 ** 32);
    this.u32(Math.floor(v / 2 ** 32));
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
  }
  result() {
    return Uint8Array.from(this.parts);
  }
}

/** An extra field block: header ID, size, data. */
export function extraField(id: number, data: Uint8Array): Uint8Array {
  const o = new Out();
  o.u16(id);
  o.u16(data.length);
  o.bytes(data);
  return o.result();
}

/** An Info-ZIP Unicode Path field (0x7075) for a stored name. */
export function unicodePathField(rawName: Uint8Array, utf8Name: string, crc = crc32(rawName)) {
  const o = new Out();
  o.u8(1);
  o.u32(crc);
  o.bytes(new TextEncoder().encode(utf8Name));
  return extraField(0x7075, o.result());
}

/**
 * Builds a zip archive. With `zip64`, sizes and offsets in the central
 * directory are written as 0xFFFFFFFF with a ZIP64 extra field, and the end
 * record points to a ZIP64 end record.
 */
export function buildZip(entries: TestZipEntry[], opts: { zip64?: boolean } = {}): Uint8Array {
  const out = new Out();
  const central: {
    e: TestZipEntry;
    name: Uint8Array;
    data: Uint8Array;
    offset: number;
    crc: number;
    size: number;
  }[] = [];
  for (const e of entries) {
    const name = bytes(e.name);
    const raw = bytes(e.data);
    const data = e.deflate ? deflateSync(raw) : raw;
    const crc = crc32(raw);
    const offset = out.length;
    const localExtra = e.localExtra ?? new Uint8Array(0);
    out.u32(0x04034b50);
    out.u16(20);
    out.u16(e.flags ?? 0);
    out.u16(e.deflate ? 8 : 0);
    out.u16(0);
    out.u16(0);
    out.u32(crc);
    out.u32(data.length);
    out.u32(raw.length);
    out.u16(name.length);
    out.u16(localExtra.length);
    out.bytes(name);
    out.bytes(localExtra);
    out.bytes(data);
    central.push({ e, name, data, offset, crc, size: raw.length });
  }
  const cdStart = out.length;
  for (const c of central) {
    let extra = c.e.extra ?? new Uint8Array(0);
    if (opts.zip64) {
      const z = new Out();
      z.u64(c.size);
      z.u64(c.data.length);
      z.u64(c.offset);
      extra = Uint8Array.from([...extraField(0x0001, z.result()), ...extra]);
    }
    out.u32(0x02014b50);
    out.u16(45);
    out.u16(opts.zip64 ? 45 : 20);
    out.u16(c.e.flags ?? 0);
    out.u16(c.e.deflate ? 8 : 0);
    out.u16(0);
    out.u16(0);
    out.u32(c.crc);
    out.u32(opts.zip64 ? 0xffffffff : c.data.length);
    out.u32(opts.zip64 ? 0xffffffff : c.size);
    out.u16(c.name.length);
    out.u16(extra.length);
    out.u16(0);
    out.u16(0);
    out.u16(0);
    out.u32(0);
    out.u32(opts.zip64 ? 0xffffffff : c.offset);
    out.bytes(c.name);
    out.bytes(extra);
  }
  const cdSize = out.length - cdStart;
  if (opts.zip64) {
    const e64 = out.length;
    out.u32(0x06064b50);
    out.u64(44);
    out.u16(45);
    out.u16(45);
    out.u32(0);
    out.u32(0);
    out.u64(central.length);
    out.u64(central.length);
    out.u64(cdSize);
    out.u64(cdStart);
    out.u32(0x07064b50);
    out.u32(0);
    out.u64(e64);
    out.u32(1);
  }
  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(opts.zip64 ? 0xffff : central.length);
  out.u16(opts.zip64 ? 0xffff : central.length);
  out.u32(opts.zip64 ? 0xffffffff : cdSize);
  out.u32(opts.zip64 ? 0xffffffff : cdStart);
  out.u16(0);
  return out.result();
}

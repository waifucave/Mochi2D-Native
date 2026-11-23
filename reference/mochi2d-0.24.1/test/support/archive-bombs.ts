/**
 * Crafted zip archives for the inflate caps (test/archive-limits.test.ts),
 * built in small pieces so that building one takes little memory. Shared by
 * the test and the child process that measures each case's peak memory
 * (archive-limits-child.ts).
 */
import { Deflate } from "fflate";

const MiB = 2 ** 20;

/** CRC-32, fed in pieces. */
export class Crc32 {
  private static table?: Uint32Array;
  private c = 0xffffffff;
  update(bytes: Uint8Array): this {
    let t = Crc32.table;
    if (!t) {
      t = Crc32.table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
    }
    let c = this.c;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    this.c = c;
    return this;
  }
  get value(): number {
    return (this.c ^ 0xffffffff) >>> 0;
  }
}

/** Deflate data of `mib` MiB of zeros, and their CRC-32, built 1 MiB at a time. */
export function zerosDeflated(mib: number): { stored: Uint8Array; size: number; crc: number } {
  const parts: Uint8Array[] = [];
  const d = new Deflate({ level: 9 }, (chunk) => parts.push(chunk));
  const zeros = new Uint8Array(MiB);
  const crc = new Crc32();
  for (let i = 0; i < mib; i++) {
    d.push(zeros, false);
    crc.update(zeros);
  }
  d.push(new Uint8Array(0), true);
  const stored = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    stored.set(p, at);
    at += p.length;
  }
  return { stored, size: mib * MiB, crc: crc.value };
}

/**
 * One local entry and `count` central directory records, every one naming a
 * different file and pointing at that same entry: the "overlapping entries"
 * pattern, where a small archive lists the same compressed data many times.
 */
export function overlappingZip(
  entry: { stored: Uint8Array; size: number; crc: number; deflate: boolean },
  count: number,
): Uint8Array {
  const name = (i: number) => new TextEncoder().encode(`f${String(i).padStart(6, "0")}.bin`);
  const nameLen = name(0).length;
  const local = 30 + nameLen + entry.stored.length;
  const central = count * (46 + nameLen);
  const out = new Uint8Array(local + central + 22);
  const dv = new DataView(out.buffer);
  const method = entry.deflate ? 8 : 0;
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(8, method, true);
  dv.setUint32(14, entry.crc, true);
  dv.setUint32(18, entry.stored.length, true);
  dv.setUint32(22, entry.size, true);
  dv.setUint16(26, nameLen, true);
  out.set(name(0), 30);
  out.set(entry.stored, 30 + nameLen);
  let o = local;
  for (let i = 0; i < count; i++) {
    dv.setUint32(o, 0x02014b50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 6, 20, true);
    dv.setUint16(o + 10, method, true);
    dv.setUint32(o + 16, entry.crc, true);
    dv.setUint32(o + 20, entry.stored.length, true);
    dv.setUint32(o + 24, entry.size, true);
    dv.setUint16(o + 28, nameLen, true);
    dv.setUint32(o + 42, 0, true);
    out.set(name(i), o + 46);
    o += 46 + nameLen;
  }
  // End record; a count over 65,534 needs ZIP64, which these cases don't.
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 8, Math.min(count, 0xfffe), true);
  dv.setUint16(o + 10, Math.min(count, 0xfffe), true);
  dv.setUint32(o + 12, central, true);
  dv.setUint32(o + 16, local, true);
  return out;
}

/** A zip of `count` distinct deflated files of `kib` KiB each, built without a large buffer. */
export function manySmallZip(count: number, kib: number): Uint8Array {
  const files: { name: Uint8Array; stored: Uint8Array; size: number; crc: number }[] = [];
  for (let i = 0; i < count; i++) {
    const raw = new Uint8Array(kib * 1024).fill(i & 0xff);
    const parts: Uint8Array[] = [];
    const d = new Deflate({ level: 6 }, (c) => parts.push(c));
    d.push(raw, true);
    const stored = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      stored.set(p, at);
      at += p.length;
    }
    files.push({
      name: new TextEncoder().encode(`textures/t${String(i).padStart(4, "0")}.bin`),
      stored,
      size: raw.length,
      crc: new Crc32().update(raw).value,
    });
  }
  const localLen = files.reduce((n, f) => n + 30 + f.name.length + f.stored.length, 0);
  const centralLen = files.reduce((n, f) => n + 46 + f.name.length, 0);
  const out = new Uint8Array(localLen + centralLen + 22);
  const dv = new DataView(out.buffer);
  const offsets: number[] = [];
  let o = 0;
  for (const f of files) {
    offsets.push(o);
    dv.setUint32(o, 0x04034b50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 8, 8, true);
    dv.setUint32(o + 14, f.crc, true);
    dv.setUint32(o + 18, f.stored.length, true);
    dv.setUint32(o + 22, f.size, true);
    dv.setUint16(o + 26, f.name.length, true);
    out.set(f.name, o + 30);
    out.set(f.stored, o + 30 + f.name.length);
    o += 30 + f.name.length + f.stored.length;
  }
  files.forEach((f, i) => {
    dv.setUint32(o, 0x02014b50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 6, 20, true);
    dv.setUint16(o + 10, 8, true);
    dv.setUint32(o + 16, f.crc, true);
    dv.setUint32(o + 20, f.stored.length, true);
    dv.setUint32(o + 24, f.size, true);
    dv.setUint16(o + 28, f.name.length, true);
    dv.setUint32(o + 42, offsets[i]!, true);
    out.set(f.name, o + 46);
    o += 46 + f.name.length;
  });
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 8, count, true);
  dv.setUint16(o + 10, count, true);
  dv.setUint32(o + 12, centralLen, true);
  dv.setUint32(o + 16, localLen, true);
  return out;
}

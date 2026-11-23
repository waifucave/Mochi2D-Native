/**
 * Crafted PNG files for the texture caps (test/texture-limits.test.ts),
 * built in pieces so that a file declaring a huge image takes little memory
 * to build. Generic PNG format knowledge only.
 */
import { Zlib } from "fflate";
import { crc32 } from "../../src/runtime/zip-archive.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function ihdr(width: number, height: number, colorType = 0, bitDepth = 8): Uint8Array {
  const b = new Uint8Array(13);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  b[8] = bitDepth;
  b[9] = colorType;
  return b;
}

/**
 * A PNG whose header declares `width` × `height` (8-bit gray) and whose
 * image data holds `rows` rows of `dataWidth` pixels (by default the
 * declared size: an honest file). `fill` gives each row's bytes: zeros
 * compress to almost nothing, "noise" hardly at all.
 */
export function craftPng(o: {
  width: number;
  height: number;
  dataWidth?: number;
  rows?: number;
  fill?: "zeros" | "noise";
  colorType?: number;
  bitDepth?: number;
}): Uint8Array {
  const w = o.dataWidth ?? o.width;
  const rows = o.rows ?? o.height;
  const parts: Uint8Array[] = [];
  const z = new Zlib({ level: 1 }, (c) => parts.push(c));
  const step = Math.max(1, Math.floor((4 << 20) / (1 + w)));
  const block = new Uint8Array((1 + w) * step);
  let seed = 1;
  for (let y = 0; y < rows; y += step) {
    const n = Math.min(step, rows - y);
    if (o.fill === "noise")
      for (let i = 0; i < block.length; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        block[i] = i % (1 + w) === 0 ? 0 : seed >>> 24;
      }
    z.push(block.subarray(0, (1 + w) * n), y + n >= rows);
  }
  if (rows === 0) z.push(new Uint8Array(0), true);
  return concat([
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr(o.width, o.height, o.colorType, o.bitDepth)),
    chunk("IDAT", concat(parts)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** A PNG declaring `width` × `height` whose image data is `bytes` raw bytes (no real image). */
export function pngWithData(width: number, height: number, bytes: number): Uint8Array {
  return concat([
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr(width, height)),
    chunk("IDAT", new Uint8Array(bytes)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const le16b = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
const le24b = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff];
const le32b = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/**
 * A file of another image format whose header declares `width` × `height`,
 * followed by `pad` bytes of filler (no real image): what a header reader
 * sees. `jpeg` is a sequential (baseline) frame header, `jpeg-progressive` a
 * progressive one; `webp` uses the extended (VP8X) header, `webp-lossless`
 * the lossless one; `ico` holds one PNG entry.
 */
export function craftHeader(
  format: "jpeg" | "jpeg-progressive" | "webp" | "webp-lossless" | "gif" | "bmp" | "ico",
  width: number,
  height: number,
  pad = 0,
): Uint8Array {
  const filler = new Array<number>(pad).fill(0);
  switch (format) {
    case "jpeg":
    case "jpeg-progressive": {
      const sof = format === "jpeg" ? 0xc0 : 0xc2;
      const app0 = [0xff, 0xe0, 0, 16, ...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
      // A frame header: precision, then the height, then the width.
      const frame = [
        0xff,
        sof,
        0,
        11,
        8,
        height >> 8,
        height & 0xff,
        width >> 8,
        width & 0xff,
        1,
        1,
        0x11,
        0,
      ];
      return Uint8Array.from([0xff, 0xd8, ...app0, ...frame, 0xff, 0xda, ...filler, 0xff, 0xd9]);
    }
    case "webp": {
      const vp8x = [
        ...ascii("VP8X"),
        ...le32b(10),
        0,
        0,
        0,
        0,
        ...le24b(width - 1),
        ...le24b(height - 1),
      ];
      const body = [...ascii("WEBP"), ...vp8x, ...filler];
      return Uint8Array.from([...ascii("RIFF"), ...le32b(body.length), ...body]);
    }
    case "webp-lossless": {
      const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
      const vp8l = [...ascii("VP8L"), ...le32b(5 + pad), 0x2f, ...le32b(bits), ...filler];
      const body = [...ascii("WEBP"), ...vp8l];
      return Uint8Array.from([...ascii("RIFF"), ...le32b(body.length), ...body]);
    }
    case "gif":
      return Uint8Array.from([
        ...ascii("GIF89a"),
        ...le16b(width),
        ...le16b(height),
        0,
        0,
        0,
        0x2c,
        0,
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        ...filler,
        0x3b,
      ]);
    case "bmp": {
      const dib = [
        ...le32b(40),
        ...le32b(width),
        ...le32b(height),
        1,
        0,
        24,
        0,
        ...new Array(24).fill(0),
      ];
      const size = 14 + dib.length + pad;
      return Uint8Array.from([
        0x42,
        0x4d,
        ...le32b(size),
        0,
        0,
        0,
        0,
        ...le32b(54),
        ...dib,
        ...filler,
      ]);
    }
    case "ico": {
      const png = craftPng({ width, height });
      const dir = [0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0, ...le32b(png.length), ...le32b(22)];
      return Uint8Array.from([...dir, ...png]);
    }
  }
}

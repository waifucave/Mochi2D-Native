/**
 * PNG encoding in Node without dependencies: RGBA8, 8 bits per channel, no
 * interlacing, filter 0 on every row, the image data deflated by node:zlib.
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG file of an RGBA8 image, top row first. */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0))
    throw new RangeError(`bad image size ${width}×${height}`);
  if (rgba.length !== width * height * 4)
    throw new RangeError(`expected ${width * height * 4} bytes of RGBA, got ${rgba.length}`);
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const idat = deflateSync(raw);
  const chunks: [string, Uint8Array][] = [
    ["IHDR", ihdr(width, height)],
    ["IDAT", new Uint8Array(idat.buffer, idat.byteOffset, idat.byteLength)],
    ["IEND", new Uint8Array(0)],
  ];
  const size = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(out.buffer);
  let o = 8;
  for (const [type, data] of chunks) {
    dv.setUint32(o, data.length);
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
    out.set(data, o + 8);
    dv.setUint32(o + 8 + data.length, crc32(out, o + 4, o + 8 + data.length));
    o += 12 + data.length;
  }
  return out;
}

function ihdr(width: number, height: number): Uint8Array {
  const b = new Uint8Array(13);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  b[8] = 8; // bit depth
  b[9] = 6; // RGBA
  return b; // compression, filter and interlace methods 0
}

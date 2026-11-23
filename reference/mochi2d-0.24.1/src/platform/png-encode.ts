/**
 * Minimal PNG encoder for RGBA8 images (color type 6, 8 bits, no interlace),
 * usable in browsers and Node. Compression uses the generic `fflate` library.
 */
import { zlibSync } from "fflate";

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngEncodeOptions {
  /** zlib level 0-9. Default 6. */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

/** Encodes RGBA8 pixels (rows top to bottom, stored as given) as PNG bytes. */
export function encodePngRgba8(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  options: PngEncodeOptions = {},
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`encodePngRgba8: invalid size ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePngRgba8: got ${rgba.length} bytes, expected ${width}x${height}x4`);
  }
  // Filter type 0 (None) on every row; the zlib stage does the work.
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = zlibSync(raw, { level: options.level ?? 6 });

  const chunks: [string, Uint8Array][] = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  chunks.push(["IHDR", ihdr], ["IDAT", idat], ["IEND", new Uint8Array(0)]);

  const size = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  let p = 8;
  for (const [type, data] of chunks) {
    view.setUint32(p, data.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(data, p + 8);
    view.setUint32(p + 8 + data.length, crc32(out, p + 4, p + 8 + data.length));
    p += 12 + data.length;
  }
  return out;
}

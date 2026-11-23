/**
 * The size an image file declares, read from its header without decoding,
 * for the formats browsers decode as textures: PNG, JPEG, WebP, GIF, BMP and
 * ICO. Each reader also says the least data a file of that size must hold,
 * where its format makes that a real bound. Generic image format knowledge
 * only.
 */
import { readPngInfo } from "./png-info.js";

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "bmp" | "ico";

export interface ImageHeader {
  format: ImageFormat;
  width: number;
  height: number;
  /**
   * The fewest bytes a file of this size can hold, when its format makes
   * that a real bound (every pixel or block needs some data); else 0.
   */
  minBytes: number;
  /**
   * Whether the decoded image is exactly the declared size, or at most it
   * (a GIF's frames, or the entry an ICO decoder picks, can be smaller).
   */
  decoded: "exact" | "at-most";
}

/** Why a header can't be read: a message for the error. */
export class ImageHeaderError extends Error {}

const be16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const be32 = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const le16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const le24 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const le32 = (b: Uint8Array, o: number) =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const at = (b: Uint8Array, o: number, s: string) =>
  o + s.length <= b.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0));

/** The format of a file's first bytes; `other` names a format no reader handles. */
export function imageFormat(b: Uint8Array): ImageFormat | { other: string } | null {
  if (at(b, 0, "\x89PNG\r\n\x1a\n")) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (at(b, 0, "RIFF") && at(b, 8, "WEBP")) return "webp";
  if (at(b, 0, "GIF87a") || at(b, 0, "GIF89a")) return "gif";
  if (at(b, 0, "BM")) return "bmp";
  if (b.length >= 6 && le16(b, 0) === 0 && (le16(b, 2) === 1 || le16(b, 2) === 2) && le16(b, 4) > 0)
    return "ico";
  if (at(b, 4, "ftyp")) return { other: "AVIF or HEIF" };
  if (at(b, 0, "II*\0") || at(b, 0, "MM\0*")) return { other: "TIFF" };
  if (at(b, 0, "\xff\x0a") || at(b, 4, "JXL ")) return { other: "JPEG XL" };
  if (at(b, 0, "<svg") || at(b, 0, "<?xml")) return { other: "SVG" };
  return null;
}

// ------------------------------------------------------------------ PNG

function pngBitsPerPixel(colorType: number, bitDepth: number): number {
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  const depths = (
    { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] } as Record<
      number,
      number[]
    >
  )[colorType];
  if (!channels || !depths?.includes(bitDepth)) return 0;
  return channels * bitDepth;
}

/** Bytes of IDAT data in a PNG, walking its chunks (stops at IEND or the end of the bytes). */
function pngDataBytes(b: Uint8Array): number {
  let n = 0;
  for (let o = 8; o + 8 <= b.length;) {
    const len = be32(b, o);
    const type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
    const avail = Math.max(0, Math.min(len, b.length - (o + 8)));
    if (type === "IDAT") n += avail;
    if (type === "IEND" || avail < len) break;
    o += 12 + len;
  }
  return n;
}

function readPng(b: Uint8Array): ImageHeader {
  const info = readPngInfo(b);
  if (!info) throw new ImageHeaderError("damaged PNG header");
  const bpp = pngBitsPerPixel(info.colorType, info.bitDepth);
  if (bpp === 0)
    throw new ImageHeaderError(
      `damaged PNG header (color type ${info.colorType}, bit depth ${info.bitDepth})`,
    );
  // The filtered image inflates from its IDAT data, at most about 1,032:1.
  const raw = info.height * (1 + Math.ceil((info.width * bpp) / 8));
  const data = pngDataBytes(b);
  return {
    format: "png",
    width: info.width,
    height: info.height,
    // The whole file: the rest of it, and at least raw / 1,032 bytes of image data.
    minBytes: b.length - data + Math.max(0, Math.ceil((raw - 64) / 1032)),
    decoded: "exact",
  };
}

// ----------------------------------------------------------------- JPEG

function readJpeg(b: Uint8Array): ImageHeader {
  // Segments after SOI: FF, marker, a 2-byte length (counting itself), until the first frame header.
  for (let o = 2; o + 4 <= b.length;) {
    if (b[o] !== 0xff) throw new ImageHeaderError("damaged JPEG: no frame header before the data");
    const m = b[o + 1]!;
    if (m === 0xff) {
      o++; // fill byte
      continue;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      o += 2;
      continue;
    }
    if (m === 0xda || m === 0xd9) break; // the data, or the end, before any frame header
    const len = be16(b, o + 2);
    if (len < 2) throw new ImageHeaderError("damaged JPEG segment");
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      if (o + 9 > b.length) throw new ImageHeaderError("JPEG frame header cut off");
      const height = be16(b, o + 5);
      const width = be16(b, o + 7);
      if (width === 0 || height === 0)
        throw new ImageHeaderError("JPEG frame header without a size (a DNL height is not read)");
      // Sequential Huffman coding needs at least two bits (a DC code and an end of block)
      // for every 8 × 8 block of the full-resolution component. Progressive and
      // arithmetic coding can code a block in less, so they give no bound.
      const sequential = m === 0xc0 || m === 0xc1;
      const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
      return {
        format: "jpeg",
        width,
        height,
        minBytes: sequential ? Math.floor(blocks / 4) : 0,
        decoded: "exact",
      };
    }
    o += 2 + len;
  }
  throw new ImageHeaderError("damaged JPEG: no frame header before the data");
}

// ----------------------------------------------------------------- WebP

function readWebp(b: Uint8Array): ImageHeader {
  let width = 0;
  let height = 0;
  // Chunks after "WEBP": a 4-character id, a 4-byte little-endian size, data padded to even.
  for (let o = 12; o + 8 <= b.length;) {
    const id = String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
    const size = le32(b, o + 4);
    const d = o + 8;
    if (id === "VP8X" && d + 10 <= b.length) {
      width = Math.max(width, le24(b, d + 4) + 1);
      height = Math.max(height, le24(b, d + 7) + 1);
    } else if (id === "VP8 " && d + 10 <= b.length) {
      if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a)
        throw new ImageHeaderError("damaged WebP (VP8) frame header");
      width = Math.max(width, le16(b, d + 6) & 0x3fff);
      height = Math.max(height, le16(b, d + 8) & 0x3fff);
    } else if (id === "VP8L" && d + 5 <= b.length) {
      if (b[d] !== 0x2f) throw new ImageHeaderError("damaged WebP (VP8L) header");
      const bits = le32(b, d + 1);
      width = Math.max(width, (bits & 0x3fff) + 1);
      height = Math.max(height, ((bits >>> 14) & 0x3fff) + 1);
    }
    o = d + size + (size & 1);
  }
  if (width === 0 || height === 0) throw new ImageHeaderError("WebP without a readable size");
  // Lossless codes can spend no bits on a pixel, and lossy ones skip blocks: no bound.
  return { format: "webp", width, height, minBytes: 0, decoded: "exact" };
}

// ------------------------------------------------------------------ GIF

function readGif(b: Uint8Array): ImageHeader {
  if (b.length < 13) throw new ImageHeaderError("GIF header cut off");
  let width = le16(b, 6);
  let height = le16(b, 8);
  // The first image descriptor's extent, after the global color table and any extensions.
  let o = 13 + (b[10]! & 0x80 ? 3 * (2 << (b[10]! & 7)) : 0);
  while (o < b.length) {
    if (b[o] === 0x21) {
      // An extension: its label, then sub-blocks until a zero-length one.
      o += 2;
      while (o < b.length && b[o] !== 0) o += 1 + b[o]!;
      o++;
    } else if (b[o] === 0x2c && o + 10 <= b.length) {
      width = Math.max(width, le16(b, o + 1) + le16(b, o + 5));
      height = Math.max(height, le16(b, o + 3) + le16(b, o + 7));
      break;
    } else break;
  }
  if (width === 0 || height === 0) throw new ImageHeaderError("GIF without a size");
  // A frame may cover a small part of the screen: no bound from the data.
  return { format: "gif", width, height, minBytes: 0, decoded: "at-most" };
}

// ------------------------------------------------------------------ BMP

/** A bitmap's DIB header at `o`: size, bits per pixel, compression. */
function readDib(
  b: Uint8Array,
  o: number,
  iconHeight: boolean,
): { width: number; height: number; bpp: number; compression: number } {
  if (o + 16 > b.length) throw new ImageHeaderError("bitmap header cut off");
  const size = le32(b, o);
  let width: number;
  let height: number;
  let bpp: number;
  let compression = 0;
  if (size === 12) {
    width = le16(b, o + 4);
    height = le16(b, o + 6);
    bpp = le16(b, o + 10);
  } else if (size >= 40 && o + 20 <= b.length) {
    width = Math.abs(le32(b, o + 4) | 0);
    height = Math.abs(le32(b, o + 8) | 0);
    bpp = le16(b, o + 14);
    compression = le32(b, o + 16);
  } else throw new ImageHeaderError(`bitmap header of ${size} bytes`);
  // An icon's bitmap counts its mask rows too: twice the image's height.
  if (iconHeight) height = Math.floor(height / 2);
  if (width === 0 || height === 0) throw new ImageHeaderError("bitmap without a size");
  return { width, height, bpp, compression };
}

function readBmp(b: Uint8Array): ImageHeader {
  if (b.length < 26) throw new ImageHeaderError("BMP header cut off");
  const { width, height, bpp, compression } = readDib(b, 14, false);
  // Uncompressed rows hold every pixel (each row padded to 4 bytes); run-length
  // coding can skip pixels, so it gives no bound.
  const uncompressed = compression === 0 || compression === 3 || compression === 6;
  const stride = Math.ceil((width * bpp) / 32) * 4;
  // The last row's padding may be missing.
  const minBytes =
    uncompressed && bpp > 0
      ? le32(b, 10) + stride * (height - 1) + Math.ceil((width * bpp) / 8)
      : 0;
  return { format: "bmp", width, height, minBytes, decoded: "exact" };
}

// ------------------------------------------------------------------ ICO

function readIco(b: Uint8Array): ImageHeader {
  const count = le16(b, 4);
  if (6 + 16 * count > b.length) throw new ImageHeaderError("ICO directory cut off");
  let width = 0;
  let height = 0;
  // The decoder picks one entry; each entry's own image header declares its size.
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const size = le32(b, e + 8);
    const offset = le32(b, e + 12);
    if (offset + 8 > b.length) throw new ImageHeaderError(`ICO entry ${i} lies past the file`);
    const image = b.subarray(offset, Math.min(b.length, offset + size));
    let w: number;
    let h: number;
    if (imageFormat(image) === "png") {
      const p = readPng(image);
      if (p.minBytes > image.length)
        throw new ImageHeaderError(`ICO entry ${i}: too little image data`);
      [w, h] = [p.width, p.height];
    } else ({ width: w, height: h } = readDib(b, offset, true));
    width = Math.max(width, w);
    height = Math.max(height, h);
  }
  if (width === 0 || height === 0) throw new ImageHeaderError("ICO without images");
  return { format: "ico", width, height, minBytes: 0, decoded: "at-most" };
}

const READERS: Record<ImageFormat, (b: Uint8Array) => ImageHeader> = {
  png: readPng,
  jpeg: readJpeg,
  webp: readWebp,
  gif: readGif,
  bmp: readBmp,
  ico: readIco,
};

/** The header of an image of a known format (throws {@link ImageHeaderError} if it can't be read). */
export function readImageHeader(format: ImageFormat, bytes: Uint8Array): ImageHeader {
  return READERS[format](bytes);
}

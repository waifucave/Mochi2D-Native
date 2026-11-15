/**
 * Reads a PNG's header (IHDR) without decoding the image, so texture sizes can
 * be planned before any pixels are decoded. Generic PNG format knowledge.
 */
export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  /** 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA. */
  colorType: number;
  interlaced: boolean;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Returns the header fields, or `null` if the bytes do not start like a PNG. */
export function readPngInfo(bytes: Uint8Array): PngInfo | null {
  if (bytes.length < 33) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return null;
  // First chunk must be IHDR with length 13.
  const be32 = (o: number) =>
    ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
  if (be32(8) !== 13) return null;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  const width = be32(16);
  const height = be32(20);
  if (width === 0 || height === 0) return null;
  return {
    width,
    height,
    bitDepth: bytes[24]!,
    colorType: bytes[25]!,
    interlaced: bytes[28] === 1,
  };
}

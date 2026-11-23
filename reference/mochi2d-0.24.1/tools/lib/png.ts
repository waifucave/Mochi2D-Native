/** PNG encode/decode for Node (RGBA8), via the generic `pngjs` library. */
import { PNG } from "pngjs";
import { readFile, writeFile } from "node:fs/promises";

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA8, rows top to bottom, non-premultiplied unless stated otherwise. */
  data: Uint8Array;
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  };
}

export function encodePng(img: RgbaImage): Uint8Array {
  if (img.data.length !== img.width * img.height * 4) {
    throw new Error(
      `encodePng: data has ${img.data.length} bytes, expected ${img.width}x${img.height}x4`,
    );
  }
  const png = new PNG({
    width: img.width,
    height: img.height,
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
  });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return new Uint8Array(PNG.sync.write(png, { colorType: 6 }));
}

export const readPng = async (path: string): Promise<RgbaImage> => decodePng(await readFile(path));
export const writePng = (path: string, img: RgbaImage): Promise<void> =>
  writeFile(path, encodePng(img));

export { unpremultiplyRgba8 as unpremultiply } from "../../src/core/image/alpha.js";

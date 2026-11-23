/**
 * Caps on what a model's textures may declare, checked from each file's
 * header before anything is decoded.
 *
 * A PNG of a few kilobytes can declare 30,000 × 30,000 pixels, 3.6 GB once
 * decoded, and browsers allocate the declared size before the data proves
 * it. So every texture's header is read first:
 *
 * - textures must be PNG, JPEG, WebP, GIF, BMP or ICO files, whose declared
 *   size is read from their headers (image-headers.ts); other images are
 *   refused with {@link TextureFormatError};
 * - a file too short to hold the size it declares, where its format makes
 *   that a bound, is refused as damaged or crafted;
 * - a texture that declares more than a cap is refused with
 *   {@link TextureLimitError}.
 *
 * Generic image format knowledge only.
 */
import {
  ImageHeaderError,
  imageFormat,
  readImageHeader,
  type ImageFormat,
  type ImageHeader,
} from "./image-headers.js";

/** Caps on the sizes a model's textures declare. A cap not given keeps its default. */
export interface TextureLimits {
  /** The most pixels one texture may declare on a side (width or height). */
  maxSide?: number;
  /** The most pixels (width × height) one texture may declare. */
  maxPixels?: number;
  /** The most pixels a model's textures may declare together. */
  maxTotalPixels?: number;
}

/**
 * The caps used when none are given: 16,384 on a side, 268 million pixels
 * (16,384²; 1 GiB as RGBA) per texture, 1,074 million pixels (4 GiB as
 * RGBA) per model.
 */
export const DEFAULT_TEXTURE_LIMITS: Readonly<Required<TextureLimits>> = Object.freeze({
  maxSide: 16384,
  maxPixels: 2 ** 28,
  maxTotalPixels: 2 ** 30,
});

/** Which cap a texture passed. */
export type TextureLimitKind = "side" | "pixels" | "total";

/** A texture declares more than a {@link TextureLimits} cap allows. Nothing was decoded. */
export class TextureLimitError extends Error {
  constructor(
    /** The texture, as the settings name it. */
    readonly path: string,
    readonly kind: TextureLimitKind,
    /** The cap. */
    readonly limit: number,
    /** What was asked for: the larger side, the pixels, or the model's running total. */
    readonly size: number,
    /** The declared width and height. */
    readonly width: number,
    readonly height: number,
  ) {
    super(
      kind === "side"
        ? `"${path}" declares ${width}×${height} pixels, more than the ${limit} allowed on a side`
        : kind === "pixels"
          ? `"${path}" declares ${width}×${height} = ${size} pixels, more than the ${limit} allowed for one texture`
          : `"${path}" (${width}×${height}) takes the model's textures to ${size} pixels, more than the ${limit} allowed in total`,
    );
    this.name = "TextureLimitError";
  }
}

/**
 * A texture is not a PNG, its header can't be read, or its data doesn't
 * match what the header declares (damaged or crafted).
 */
export class TextureFormatError extends Error {
  constructor(
    /** The texture, as the settings name it. */
    readonly path: string,
    message: string,
  ) {
    super(`"${path}": ${message}`);
    this.name = "TextureFormatError";
  }
}

/** The caps of a load: the given ones over {@link DEFAULT_TEXTURE_LIMITS}, checked. */
export function resolveTextureLimits(limits: TextureLimits = {}): Required<TextureLimits> {
  const out = { ...DEFAULT_TEXTURE_LIMITS };
  for (const key of ["maxSide", "maxPixels", "maxTotalPixels"] as const) {
    const v = limits[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || Number.isNaN(v) || v < 0)
      throw new RangeError(`${key} must be a number ≥ 0 (Infinity for no cap)`);
    out[key] = v;
  }
  return out;
}

/** What a texture's header declares. */
export interface TextureHeader {
  width: number;
  height: number;
  /** The image format, from the file's first bytes. */
  format: ImageFormat;
}

const NAMES: Record<ImageFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP",
  gif: "GIF",
  bmp: "BMP",
  ico: "ICO",
};

/**
 * What a texture's header declares, without decoding it: for PNG, JPEG,
 * WebP, GIF, BMP and ICO files. Throws {@link TextureFormatError} for any
 * other format (naming it when it is one we know), for a header that can't
 * be read, and for a file too short to hold the size it declares, where its
 * format makes that a bound (PNG: deflate expands at most about 1,032:1;
 * sequential JPEG: two bits per 8 × 8 block; uncompressed BMP: every pixel).
 */
export function readTextureHeader(path: string, bytes: Uint8Array): TextureHeader {
  const format = imageFormat(bytes);
  if (format === null || typeof format === "object")
    throw new TextureFormatError(
      path,
      format
        ? `a ${format.other} image, whose declared size Mochi2D does not read; ` +
            "textures must be PNG, JPEG, WebP, GIF, BMP or ICO files"
        : "not an image file Mochi2D reads (PNG, JPEG, WebP, GIF, BMP or ICO), or its header is damaged",
    );
  let h: ImageHeader;
  try {
    h = readImageHeader(format, bytes);
  } catch (e) {
    if (e instanceof ImageHeaderError) throw new TextureFormatError(path, e.message);
    throw e;
  }
  if (bytes.length < h.minBytes)
    throw new TextureFormatError(
      path,
      `declares ${h.width}×${h.height} pixels but is ${bytes.length} bytes, too few for a ` +
        `${NAMES[format]} file of that size (damaged or crafted)`,
    );
  return { width: h.width, height: h.height, format };
}

/** Whether a decoded image's size is what its header declared (GIF and ICO: at most). */
export function decodedSizeFits(header: TextureHeader, width: number, height: number): boolean {
  return header.format === "gif" || header.format === "ico"
    ? width <= header.width && height <= header.height
    : width === header.width && height === header.height;
}

/**
 * Reads every texture's header and checks the set against the caps, in
 * order, before any is decoded. Returns the headers. Throws
 * {@link TextureFormatError} or {@link TextureLimitError}.
 */
export function checkTextures(
  files: readonly { path: string; bytes: Uint8Array }[],
  limits: TextureLimits = {},
): TextureHeader[] {
  const { maxSide, maxPixels, maxTotalPixels } = resolveTextureLimits(limits);
  let total = 0;
  return files.map(({ path, bytes }) => {
    const h = readTextureHeader(path, bytes);
    const side = Math.max(h.width, h.height);
    const pixels = h.width * h.height;
    if (side > maxSide) throw new TextureLimitError(path, "side", maxSide, side, h.width, h.height);
    if (pixels > maxPixels)
      throw new TextureLimitError(path, "pixels", maxPixels, pixels, h.width, h.height);
    total += pixels;
    if (total > maxTotalPixels)
      throw new TextureLimitError(path, "total", maxTotalPixels, total, h.width, h.height);
    return h;
  });
}

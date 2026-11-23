import { GlError } from "./context.js";
import { convertAlpha, premultiplyRgba8, type AlphaMode } from "../../core/image/alpha.js";
import { rgba8Bytes, type GpuMemoryTracker } from "./gpu-memory.js";

export { premultiplyRgba8 };

export interface RawPixels {
  width: number;
  height: number;
  /** RGBA8, rows top to bottom. */
  data: Uint8Array | Uint8ClampedArray;
}

export type TextureSource =
  ImageBitmap | HTMLImageElement | HTMLCanvasElement | ImageData | OffscreenCanvas | RawPixels;

export interface TextureOptions {
  /** Alpha convention the texture should hold. Default "straight". */
  alpha?: AlphaMode;
  /** Shorthand for `alpha: "premultiplied"`. */
  premultiplyAlpha?: boolean;
  /**
   * Alpha convention of raw pixel sources. Default "straight". DOM sources
   * (images, canvases, ImageData) are always treated as straight alpha.
   * ImageBitmaps carry their own convention, chosen when they were decoded
   * (WebGL ignores the unpack flags for them), so pass the convention they
   * were decoded with here.
   */
  sourceAlpha?: AlphaMode;
  /** Flip rows during upload. Not possible for ImageBitmaps (flip when decoding). Default false. */
  flipY?: boolean;
  /** Generate mipmaps and use trilinear minification. Default false. */
  mipmaps?: boolean;
  filter?: "linear" | "nearest";
  wrap?: "clamp" | "repeat" | "mirror";
  memory?: GpuMemoryTracker;
  label?: string;
}

export interface Texture2D {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly alpha: AlphaMode;
  /** Same as `alpha === "premultiplied"`. */
  readonly premultiplied: boolean;
  /** Nominal GPU bytes (including mipmaps). */
  readonly bytes: number;
}

function isRawPixels(src: TextureSource): src is RawPixels {
  return (
    typeof (src as { data?: unknown }).data === "object" &&
    !(typeof ImageData !== "undefined" && src instanceof ImageData)
  );
}

function isImageBitmap(src: TextureSource): src is ImageBitmap {
  return typeof ImageBitmap !== "undefined" && src instanceof ImageBitmap;
}

export function createTexture2D(
  gl: WebGL2RenderingContext,
  src: TextureSource,
  opts: TextureOptions = {},
): Texture2D {
  const alpha: AlphaMode = opts.alpha ?? (opts.premultiplyAlpha ? "premultiplied" : "straight");
  const sourceAlpha: AlphaMode = opts.sourceAlpha ?? "straight";
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (src.width < 1 || src.height < 1 || src.width > max || src.height > max) {
    throw new GlError(
      `Texture size ${src.width}x${src.height} outside [1, ${max}]; downscale it first`,
    );
  }
  if (isImageBitmap(src)) {
    if (sourceAlpha !== alpha) {
      throw new GlError(
        `ImageBitmap is ${sourceAlpha} but a ${alpha} texture was requested; choose the alpha convention when decoding`,
      );
    }
    if (opts.flipY)
      throw new GlError("Cannot flip an ImageBitmap at upload; flip it when decoding");
  } else if (!isRawPixels(src) && sourceAlpha !== "straight") {
    throw new GlError("DOM image sources are always straight alpha");
  }

  const tex = gl.createTexture();
  if (!tex) throw new GlError("createTexture returned null (context lost?)");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, opts.flipY ?? false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  try {
    if (isRawPixels(src)) {
      if (src.data.length !== src.width * src.height * 4) {
        throw new GlError(
          `Raw texture data has ${src.data.length} bytes, expected ${src.width}x${src.height}x4`,
        );
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      const pixels =
        sourceAlpha === alpha
          ? new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.length)
          : convertAlpha(src.data, sourceAlpha, alpha);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        src.width,
        src.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    } else {
      gl.pixelStorei(
        gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
        !isImageBitmap(src) && alpha === "premultiplied",
      );
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    }
  } catch (e) {
    gl.deleteTexture(tex);
    throw e;
  } finally {
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  const lin = (opts.filter ?? "linear") === "linear";
  if (opts.mipmaps) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      lin ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST,
    );
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin ? gl.LINEAR : gl.NEAREST);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
  const wrap = { clamp: gl.CLAMP_TO_EDGE, repeat: gl.REPEAT, mirror: gl.MIRRORED_REPEAT }[
    opts.wrap ?? "clamp"
  ];
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const result: Texture2D = {
    texture: tex,
    width: src.width,
    height: src.height,
    alpha,
    premultiplied: alpha === "premultiplied",
    bytes: rgba8Bytes(src.width, src.height, opts.mipmaps ?? false),
  };
  opts.memory?.set(
    result,
    "texture",
    opts.label ?? `texture ${src.width}x${src.height}`,
    result.bytes,
  );
  return result;
}

/** Deletes a texture and forgets it in the memory tracker. */
export function deleteTexture2D(
  gl: WebGL2RenderingContext,
  t: Texture2D,
  memory?: GpuMemoryTracker,
): void {
  gl.deleteTexture(t.texture);
  memory?.delete(t);
}

/** The context's maximum 2D texture size. */
export const maxTextureSize = (gl: WebGL2RenderingContext): number =>
  gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

export interface IncrementalUploadOptions extends TextureOptions {
  /** Rows uploaded per step. */
  stripRows: number;
  /** Awaited between steps so the main thread can run. Default: a zero-delay timeout. */
  yieldBetween?: () => Promise<void>;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Uploads a decoded image in horizontal strips (`texSubImage2D` with
 * `UNPACK_SKIP_ROWS`), yielding between strips, so a very large texture does
 * not block the main thread in one long call. Same result as
 * {@link createTexture2D}; the texture storage is immutable.
 */
export async function createTexture2DIncremental(
  gl: WebGL2RenderingContext,
  src: ImageBitmap | HTMLImageElement | HTMLCanvasElement | ImageData | OffscreenCanvas,
  opts: IncrementalUploadOptions,
): Promise<Texture2D> {
  const alpha: AlphaMode = opts.alpha ?? (opts.premultiplyAlpha ? "premultiplied" : "straight");
  const sourceAlpha: AlphaMode = opts.sourceAlpha ?? "straight";
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const { width, height } = src;
  if (width < 1 || height < 1 || width > max || height > max) {
    throw new GlError(`Texture size ${width}x${height} outside [1, ${max}]; downscale it first`);
  }
  const bitmap = isImageBitmap(src);
  if (bitmap && sourceAlpha !== alpha) {
    throw new GlError(
      `ImageBitmap is ${sourceAlpha} but a ${alpha} texture was requested; choose the alpha convention when decoding`,
    );
  }
  if (opts.flipY) throw new GlError("Incremental upload does not support flipY");
  const rows = Math.max(1, Math.floor(opts.stripRows));
  const yieldBetween = opts.yieldBetween ?? yieldToEventLoop;
  const levels = opts.mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
  const tex = gl.createTexture();
  if (!tex) throw new GlError("createTexture returned null (context lost?)");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, width, height);
  try {
    for (let y = 0; y < height; y += rows) {
      const h = Math.min(rows, height - y);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !bitmap && alpha === "premultiplied");
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        y,
        width,
        h,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        src as TexImageSource,
      );
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (y + rows < height) await yieldBetween();
    }
  } catch (e) {
    gl.deleteTexture(tex);
    throw e;
  } finally {
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const lin = (opts.filter ?? "linear") === "linear";
  if (opts.mipmaps) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      lin ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST,
    );
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin ? gl.LINEAR : gl.NEAREST);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
  const wrap = { clamp: gl.CLAMP_TO_EDGE, repeat: gl.REPEAT, mirror: gl.MIRRORED_REPEAT }[
    opts.wrap ?? "clamp"
  ];
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const result: Texture2D = {
    texture: tex,
    width,
    height,
    alpha,
    premultiplied: alpha === "premultiplied",
    bytes: rgba8Bytes(width, height, opts.mipmaps ?? false),
  };
  opts.memory?.set(result, "texture", opts.label ?? `texture ${width}x${height}`, result.bytes);
  return result;
}

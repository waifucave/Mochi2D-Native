/**
 * Loads a set of textures: reads PNG headers to plan sizes against the GPU
 * limit and a memory budget, decodes off the main thread directly at the
 * planned size, uploads, and records GPU memory.
 */
import type { AlphaMode } from "../../core/image/alpha.js";
import { readPngInfo } from "../../core/image/png-info.js";
import {
  createTexture2D,
  createTexture2DIncremental,
  deleteTexture2D,
  maxTextureSize,
  type Texture2D,
  type TextureSource,
} from "../gl/texture.js";
import type { GpuMemoryTracker } from "../gl/gpu-memory.js";
import { fitTextureSize, planTextureSizes, type PlannedSize } from "./budget.js";
import { ImageDecoder } from "./decoder.js";
import { TexturePreparer, mipLevels } from "./prepare.js";
import { rgba8Bytes } from "../gl/gpu-memory.js";

/**
 * A texture exceeds the device's maximum texture size and downscaling is not
 * allowed (reference renders, answer B4). The name is the error kind.
 */
export class TextureTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextureTooLarge";
  }
}

export interface TextureFile {
  label: string;
  bytes: Uint8Array;
  /** Default "image/png". */
  mime?: string;
}

export interface LoadedTexture {
  label: string;
  texture: Texture2D;
  originalWidth: number;
  originalHeight: number;
  /** Uploaded size / original size (1 = full size). */
  scale: number;
  decodeMs: number;
  uploadMs: number;
  decodedOn: "worker" | "main";
}

export interface TextureLoaderOptions {
  /** Total nominal GPU bytes for one {@link TextureLoader.loadSet} call. Unlimited if omitted. */
  budgetBytes?: number;
  /** Override the size limit (never above the GPU's MAX_TEXTURE_SIZE). */
  maxSize?: number;
  mipmaps?: boolean;
  /**
   * Alpha convention of the uploaded textures. Default "premultiplied", so
   * that downscaling and filtering do not bleed color from transparent texels.
   */
  alpha?: AlphaMode;
  filter?: "linear" | "nearest";
  /**
   * Textures with more than `stripThresholdPixels` texels are uploaded in
   * strips of this many rows, yielding to the event loop between strips.
   * Default 512; 0 disables strip uploads. (Measured in headless Chromium with
   * the DeepSeek textures: much shorter main-thread stalls and lower peak
   * memory than one large upload, at similar total time.)
   */
  uploadStripRows?: number;
  /** Default 4096 × 4096. */
  stripThresholdPixels?: number;
  /**
   * Exact preparation (§2b): decode straight, then premultiply and
   * build the mip chain on the GPU with the specified integer rules, repeat
   * wrapping. Implies premultiplied textures. Default false.
   */
  exact?: boolean;
  /**
   * What to do with a texture larger than the size limit: "downscale" (default;
   * the viewer, which must say so visibly) or "fail" with
   * {@link TextureTooLargeError} (reference renders).
   */
  oversize?: "downscale" | "fail";
  /** Number of decode workers. Default min(2, hardwareConcurrency). */
  workers?: number;
  /** Set false to decode on the main thread. */
  useWorkers?: boolean;
  memory?: GpuMemoryTracker;
}

export interface PlannedTexture extends PlannedSize {
  originalWidth: number;
  originalHeight: number;
}

export class TextureLoader {
  readonly decoder: ImageDecoder;
  readonly maxSize: number;

  private preparer: TexturePreparer | null = null;

  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly options: TextureLoaderOptions = {},
  ) {
    const gpuMax = maxTextureSize(gl);
    this.maxSize = Math.min(gpuMax, options.maxSize ?? gpuMax);
    this.decoder = new ImageDecoder({
      ...(options.workers !== undefined ? { workers: options.workers } : {}),
      ...(options.useWorkers !== undefined ? { useWorkers: options.useWorkers } : {}),
    });
  }

  /** Plans sizes for the files whose headers can be read (others get `null`). */
  plan(files: readonly TextureFile[]): (PlannedTexture | null)[] {
    const infos = files.map((f) => readPngInfo(f.bytes));
    const known = infos.filter((i): i is NonNullable<typeof i> => i !== null);
    const planned = planTextureSizes(known, {
      maxSize: this.maxSize,
      ...(this.options.budgetBytes !== undefined ? { budgetBytes: this.options.budgetBytes } : {}),
      // Exact preparation builds the mip chain unless told otherwise.
      mipmaps: this.options.mipmaps ?? this.options.exact ?? false,
    });
    let k = 0;
    return infos.map((info) =>
      info ? { ...planned[k++]!, originalWidth: info.width, originalHeight: info.height } : null,
    );
  }

  /**
   * Loads all files. Decoding runs in parallel (bounded by the worker count);
   * uploads happen in input order. On failure, textures already uploaded by
   * this call are deleted and the error is rethrown.
   */
  async loadSet(files: readonly TextureFile[]): Promise<LoadedTexture[]> {
    const exact = this.options.exact ?? false;
    // Exact preparation decodes straight and premultiplies on the GPU.
    const alpha = exact ? "straight" : (this.options.alpha ?? "premultiplied");
    const plans = this.plan(files);
    if (this.options.oversize === "fail") {
      plans.forEach((p, i) => {
        if (p && p.scale < 1)
          throw new TextureTooLargeError(
            `${files[i]!.label} is ${p.originalWidth}×${p.originalHeight}, larger than the maximum texture size ${this.maxSize}`,
          );
      });
    }
    const decodes = files.map((f, i) => {
      const p = plans[i];
      return this.decoder.decode(f.bytes, {
        alpha,
        ...(f.mime ? { mime: f.mime } : {}),
        ...(p && p.scale < 1 ? { resize: { width: p.width, height: p.height } } : {}),
      });
    });
    // Avoid unhandled rejections for decodes we never await after an earlier failure.
    for (const d of decodes) d.catch(() => {});
    const out: LoadedTexture[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        let decoded = await decodes[i]!;
        const plan = plans[i];
        let originalWidth = plan?.originalWidth ?? decoded.bitmap.width;
        let originalHeight = plan?.originalHeight ?? decoded.bitmap.height;
        let scale = plan?.scale ?? 1;
        if (!plan) {
          // Unknown header: fit to the size limit after decoding.
          const fit = fitTextureSize(decoded.bitmap.width, decoded.bitmap.height, {
            maxSize: this.maxSize,
          });
          if (fit.scale < 1 && this.options.oversize === "fail") {
            decoded.bitmap.close();
            throw new TextureTooLargeError(
              `${f.label} is ${originalWidth}×${originalHeight}, larger than the maximum texture size ${this.maxSize}`,
            );
          }
          if (fit.scale < 1) {
            const resized = await createImageBitmap(decoded.bitmap, {
              resizeWidth: fit.width,
              resizeHeight: fit.height,
              resizeQuality: "high",
            });
            decoded.bitmap.close();
            decoded = { ...decoded, bitmap: resized };
            scale = fit.scale;
          }
        }
        const t0 = performance.now();
        const texOpts = {
          alpha,
          sourceAlpha: alpha,
          // With exact preparation, level 0 is uploaded as is and prepared below.
          mipmaps: exact ? false : (this.options.mipmaps ?? false),
          filter: exact ? "nearest" : (this.options.filter ?? "linear"),
          ...(this.options.memory && !exact ? { memory: this.options.memory } : {}),
          label: f.label,
        } as const;
        const strip = this.options.uploadStripRows ?? 512;
        const threshold = this.options.stripThresholdPixels ?? 4096 * 4096;
        const texture =
          strip > 0 &&
          decoded.bitmap.width * decoded.bitmap.height > threshold &&
          decoded.bitmap.height > strip
            ? await createTexture2DIncremental(this.gl, decoded.bitmap, {
                ...texOpts,
                stripRows: strip,
              })
            : createTexture2D(this.gl, decoded.bitmap, texOpts);
        const final = exact ? this.prepareExact(texture, f.label) : texture;
        const uploadMs = performance.now() - t0;
        decoded.bitmap.close();
        out.push({
          label: f.label,
          texture: final,
          originalWidth,
          originalHeight,
          scale,
          decodeMs: decoded.ms,
          uploadMs,
          decodedOn: decoded.on,
        });
      }
    } catch (e) {
      for (const t of out) deleteTexture2D(this.gl, t.texture, this.options.memory);
      // Free bitmaps that were decoded but not uploaded.
      for (let i = out.length + 1; i < decodes.length; i++) {
        decodes[i]!.then(
          (d) => d.bitmap.close(),
          () => {},
        );
      }
      throw e;
    }
    return out;
  }

  /** Premultiplied, mip-mapped texture from an uploaded straight one (which is deleted). */
  private prepareExact(straight: Texture2D, label: string): Texture2D {
    this.preparer ??= new TexturePreparer(this.gl);
    const mipmaps = this.options.mipmaps ?? true;
    try {
      const tex = this.preparer.prepare(straight.texture, straight.width, straight.height, {
        mipmaps,
        wrap: "repeat",
      });
      const result: Texture2D = {
        texture: tex,
        width: straight.width,
        height: straight.height,
        alpha: "premultiplied",
        premultiplied: true,
        bytes: rgba8Bytes(straight.width, straight.height, mipmaps),
      };
      this.options.memory?.set(result, "texture", label, result.bytes);
      return result;
    } finally {
      deleteTexture2D(this.gl, straight);
    }
  }

  /**
   * Replaces a texture this loader prepared exactly, or the region of it at
   * (x, y) (pixels from the top-left corner) the size of `source`, with
   * straight-alpha pixels, prepared as at load: premultiplied, and the mip
   * texels over the region recomputed by the same exact rule. The texture
   * object stays the same, so whatever draws with it shows the new pixels
   * from its next draw. `source` must fit inside the texture as stored (its
   * downscaled size, if it was downscaled).
   */
  updateTexture(texture: LoadedTexture, source: TextureSource, x = 0, y = 0): void {
    if (!(this.options.exact ?? false))
      throw new Error("only textures prepared exactly can be updated in place");
    const t = texture.texture;
    const w = "naturalWidth" in source ? source.naturalWidth : source.width;
    const h = "naturalHeight" in source ? source.naturalHeight : source.height;
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      w < 1 ||
      h < 1 ||
      x + w > t.width ||
      y + h > t.height
    )
      throw new RangeError(
        `a ${w}×${h} image at (${x}, ${y}) does not fit in the ${t.width}×${t.height} texture ${texture.label}`,
      );
    this.preparer ??= new TexturePreparer(this.gl);
    const straight = createTexture2D(this.gl, source, {
      alpha: "straight",
      sourceAlpha: "straight",
      mipmaps: false,
      filter: "nearest",
      label: `${texture.label} (update)`,
    });
    try {
      const mipmaps = this.options.mipmaps ?? true;
      this.preparer.updateRegion(
        t.texture,
        t.width,
        t.height,
        mipmaps ? mipLevels(t.width, t.height) : 1,
        straight.texture,
        { x, y, w, h },
      );
    } finally {
      deleteTexture2D(this.gl, straight);
    }
  }

  /** Deletes textures returned by {@link loadSet}. */
  release(textures: readonly LoadedTexture[]): void {
    for (const t of textures) deleteTexture2D(this.gl, t.texture, this.options.memory);
  }

  dispose(): void {
    this.decoder.dispose();
    this.preparer?.dispose();
    this.preparer = null;
  }
}

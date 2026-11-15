/**
 * Texture size planning. Textures larger than the GPU limit, or a set of
 * textures larger than a memory budget, are scaled down uniformly (keeping
 * aspect ratio). UVs are normalized, so scaling does not change the mapping.
 */
import { rgba8Bytes } from "../gl/gpu-memory.js";

export interface TextureLimits {
  /** Largest allowed width/height (use `gl.MAX_TEXTURE_SIZE`). */
  maxSize: number;
  /** Optional cap on width × height (pixels) for one texture. */
  maxPixels?: number;
}

export interface PlannedSize {
  width: number;
  height: number;
  /** 1 = unchanged. */
  scale: number;
}

/** Size one texture must be scaled to so it fits `limits`. */
export function fitTextureSize(width: number, height: number, limits: TextureLimits): PlannedSize {
  let scale = Math.min(1, limits.maxSize / width, limits.maxSize / height);
  if (limits.maxPixels !== undefined && width * height * scale * scale > limits.maxPixels) {
    scale = Math.min(scale, Math.sqrt(limits.maxPixels / (width * height)));
  }
  if (scale >= 1) return { width, height, scale: 1 };
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

export interface BudgetOptions extends TextureLimits {
  /** Total nominal GPU bytes allowed for the whole set. Unlimited if omitted. */
  budgetBytes?: number;
  /** Count mip chains (≈ 4/3 of the base level). Default false. */
  mipmaps?: boolean;
}

/**
 * Plans sizes for a set of textures: first each is fitted to the size limits,
 * then, if the set exceeds `budgetBytes`, all are scaled by the same factor.
 */
export function planTextureSizes(
  sizes: readonly { width: number; height: number }[],
  opts: BudgetOptions,
): PlannedSize[] {
  const fitted = sizes.map((s) => fitTextureSize(s.width, s.height, opts));
  const bytes = (p: PlannedSize) => rgba8Bytes(p.width, p.height, opts.mipmaps ?? false);
  const total = fitted.reduce((n, p) => n + bytes(p), 0);
  if (opts.budgetBytes === undefined || total <= opts.budgetBytes) return fitted;
  let g = Math.sqrt(opts.budgetBytes / total);
  // Flooring can only shrink, but the mip chain's rounding can add a little; tighten until it fits.
  for (let iter = 0; iter < 20; iter++) {
    const planned = sizes.map((s, i) => {
      const scale = fitted[i]!.scale * g;
      return scale >= 1
        ? { width: s.width, height: s.height, scale: 1 }
        : {
            width: Math.max(1, Math.floor(s.width * scale)),
            height: Math.max(1, Math.floor(s.height * scale)),
            scale,
          };
    });
    if (planned.reduce((n, p) => n + bytes(p), 0) <= opts.budgetBytes) return planned;
    g *= 0.98;
  }
  return sizes.map(() => ({ width: 1, height: 1, scale: 0 }));
}

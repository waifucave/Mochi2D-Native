/**
 * The image measures of 4h, on premultiplied 8-bit RGBA images:
 * d(p), the largest channel difference at a pixel; RMS over every channel of
 * every pixel; F_k, the fraction of pixels with d > k (k = 4, 8); and N₁₆,
 * the number of pixels with d > 16. The limits are those of 4l.2.
 */
export interface ImageMeasures {
  width: number;
  height: number;
  rms: number;
  f4: number;
  f8: number;
  n16: number;
  /** Number of pixels with d > 8 (for the advisory of 4l.2). */
  n8: number;
  /** The largest d and its first pixel. */
  maxD: number;
  maxAt: [number, number];
}

export interface Rgba8 {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export function measureImages(a: Rgba8, b: Rgba8): ImageMeasures {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`image sizes differ: ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  const n = a.width * a.height;
  let sumSq = 0;
  let c4 = 0;
  let c8 = 0;
  let c16 = 0;
  let maxD = 0;
  let maxAt = 0;
  for (let p = 0; p < n; p++) {
    let d = 0;
    for (let c = 0; c < 4; c++) {
      const diff = a.data[4 * p + c]! - b.data[4 * p + c]!;
      sumSq += diff * diff;
      const ad = diff < 0 ? -diff : diff;
      if (ad > d) d = ad;
    }
    if (d > 4) c4++;
    if (d > 8) c8++;
    if (d > 16) c16++;
    if (d > maxD) {
      maxD = d;
      maxAt = p;
    }
  }
  return {
    width: a.width,
    height: a.height,
    rms: n ? Math.sqrt(sumSq / (4 * n)) : 0,
    f4: n ? c4 / n : 0,
    f8: n ? c8 / n : 0,
    n16: c16,
    n8: c8,
    maxD,
    maxAt: [maxAt % Math.max(1, a.width), Math.floor(maxAt / Math.max(1, a.width))],
  };
}

/** The render limits of 4l.2. */
export const RENDER_LIMITS = {
  rms: 1.0,
  f4: 0.02,
  f8: 0.005,
  /** N₁₆ ≤ max(8, 0.03 % of W·H). */
  n16: (width: number, height: number) => Math.max(8, 0.0003 * width * height),
} as const;

/**
 * "Expected values for a correct implementation" (4l.2): above them, an
 * advisory. "At most a few pixels with d > 8" means at most 4.
 */
export const RENDER_EXPECTED = { rms: 0.1, n8: 4 } as const;

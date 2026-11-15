/** Image comparison: per-pixel error statistics, PSNR and a diff visualization. */
import type { RgbaImage } from "./png.js";

export interface DiffOptions {
  /** A pixel counts as "different" if any channel differs by more than this (0-255). Default 0. */
  threshold?: number;
  /** Compare alpha too. Default true. */
  includeAlpha?: boolean;
}

export interface DiffStats {
  width: number;
  height: number;
  /** Largest absolute channel difference (0-255). */
  maxError: number;
  /** Mean absolute channel difference (0-255). */
  meanAbsError: number;
  /** Root-mean-square channel difference (0-255). */
  rmse: number;
  /** PSNR in dB for 8-bit channels; `Infinity` for identical images. */
  psnr: number;
  /** Pixels with any channel difference above the threshold. */
  differingPixels: number;
  differingFraction: number;
}

export interface DiffResult {
  stats: DiffStats;
  /**
   * Diff visualization: grayscale of the expected image at reduced contrast,
   * with differing pixels drawn in red, brightness scaled by error.
   */
  diffImage: RgbaImage;
}

export function diffImages(
  expected: RgbaImage,
  actual: RgbaImage,
  opts: DiffOptions = {},
): DiffResult {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new Error(
      `Image sizes differ: ${expected.width}x${expected.height} vs ${actual.width}x${actual.height}`,
    );
  }
  const threshold = opts.threshold ?? 0;
  const channels = opts.includeAlpha === false ? 3 : 4;
  const { width, height } = expected;
  const a = expected.data;
  const b = actual.data;
  const out = new Uint8Array(width * height * 4);
  let maxError = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    let pixMax = 0;
    for (let c = 0; c < channels; c++) {
      const d = Math.abs(a[i + c]! - b[i + c]!);
      sumAbs += d;
      sumSq += d * d;
      if (d > pixMax) pixMax = d;
    }
    if (pixMax > maxError) maxError = pixMax;
    if (pixMax > threshold) {
      differing++;
      out[i] = 128 + Math.round((127 * pixMax) / 255);
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 255;
    } else {
      const lum = (a[i]! * 0.299 + a[i + 1]! * 0.587 + a[i + 2]! * 0.114) * (a[i + 3]! / 255);
      const g = Math.round(255 - (255 - lum) * 0.25);
      out[i] = out[i + 1] = out[i + 2] = g;
      out[i + 3] = 255;
    }
  }
  const n = width * height * channels;
  const mse = n ? sumSq / n : 0;
  return {
    stats: {
      width,
      height,
      maxError,
      meanAbsError: n ? sumAbs / n : 0,
      rmse: Math.sqrt(mse),
      psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
      differingPixels: differing,
      differingFraction: width * height ? differing / (width * height) : 0,
    },
    diffImage: { width, height, data: out },
  };
}

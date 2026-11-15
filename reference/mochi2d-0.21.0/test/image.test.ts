import { describe, expect, it } from "vitest";
import { decodePng, encodePng, unpremultiply } from "../tools/lib/png.js";
import { diffImages } from "../tools/lib/image-diff.js";

function img(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

describe("png", () => {
  it("round-trips RGBA8 exactly", () => {
    const a = img(7, 5, (x, y) => [x * 30, y * 50, (x * y) % 256, 255 - x * 10]);
    const b = decodePng(encodePng(a));
    expect(b.width).toBe(7);
    expect(b.height).toBe(5);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });
  it("unpremultiplies", () => {
    expect(Array.from(unpremultiply(new Uint8Array([64, 32, 0, 128, 9, 9, 9, 0])))).toEqual([
      128, 64, 0, 128, 0, 0, 0, 0,
    ]);
  });
});

describe("diffImages", () => {
  it("reports zero error for identical images", () => {
    const a = img(4, 4, (x) => [x * 60, 0, 0, 255]);
    const { stats } = diffImages(a, a);
    expect(stats.maxError).toBe(0);
    expect(stats.psnr).toBe(Infinity);
    expect(stats.differingPixels).toBe(0);
  });
  it("computes max / mean / rmse / psnr and counts differing pixels", () => {
    const a = img(2, 1, () => [100, 100, 100, 255]);
    const b = img(2, 1, (x) => (x === 0 ? [110, 100, 100, 255] : [100, 100, 100, 255]));
    const { stats, diffImage } = diffImages(a, b, { threshold: 5 });
    expect(stats.maxError).toBe(10);
    expect(stats.meanAbsError).toBeCloseTo(10 / 8);
    expect(stats.rmse).toBeCloseTo(Math.sqrt(100 / 8));
    expect(stats.psnr).toBeCloseTo(10 * Math.log10((255 * 255) / (100 / 8)));
    expect(stats.differingPixels).toBe(1);
    expect(diffImage.data[0]).toBeGreaterThan(128); // red marks the differing pixel
    expect(diffImages(a, b, { threshold: 10 }).stats.differingPixels).toBe(0);
  });
  it("rejects size mismatches", () => {
    expect(() =>
      diffImages(
        img(1, 1, () => [0, 0, 0, 0]),
        img(2, 1, () => [0, 0, 0, 0]),
      ),
    ).toThrow(/sizes differ/);
  });
});

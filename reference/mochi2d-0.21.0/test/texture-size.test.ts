import { describe, expect, it } from "vitest";
import { fitTextureSize, planTextureSizes } from "../src/render/texture/budget.js";
import { readPngInfo } from "../src/core/image/png-info.js";
import { encodePngRgba8 } from "../src/platform/png-encode.js";
import { decodePng } from "../tools/lib/png.js";
import { convertAlpha } from "../src/core/image/alpha.js";

describe("fitTextureSize", () => {
  it("keeps textures that fit", () => {
    expect(fitTextureSize(4096, 8192, { maxSize: 16384 })).toEqual({
      width: 4096,
      height: 8192,
      scale: 1,
    });
  });
  it("downscales non-square textures to the max size, keeping aspect", () => {
    expect(fitTextureSize(4096, 8192, { maxSize: 4096 })).toEqual({
      width: 2048,
      height: 4096,
      scale: 0.5,
    });
  });
  it("applies a pixel budget", () => {
    const r = fitTextureSize(8192, 8192, { maxSize: 16384, maxPixels: 4096 * 4096 });
    expect(r).toEqual({ width: 4096, height: 4096, scale: 0.5 });
  });
});

describe("planTextureSizes", () => {
  const deepseekLike = [
    { width: 4096, height: 8192 },
    { width: 4096, height: 8192 },
    { width: 2048, height: 2048 },
    { width: 8192, height: 8192 },
    { width: 4096, height: 4096 },
  ];
  it("only applies size limits when there is no budget", () => {
    const p = planTextureSizes(deepseekLike, { maxSize: 4096 });
    expect(p.map((s) => [s.width, s.height])).toEqual([
      [2048, 4096],
      [2048, 4096],
      [2048, 2048],
      [4096, 4096],
      [4096, 4096],
    ]);
  });
  it("scales the whole set uniformly to fit a byte budget", () => {
    const budget = 256 * 1024 * 1024;
    const p = planTextureSizes(deepseekLike, { maxSize: 16384, budgetBytes: budget });
    const total = p.reduce((n, s) => n + s.width * s.height * 4, 0);
    expect(total).toBeLessThanOrEqual(budget);
    expect(total).toBeGreaterThan(budget * 0.95);
    const scales = p.map((s) => s.scale);
    expect(Math.max(...scales) - Math.min(...scales)).toBeLessThan(1e-9);
    // Aspect ratio is kept.
    expect(p[0]!.height / p[0]!.width).toBeCloseTo(2, 2);
  });
  it("accounts for mip chains", () => {
    const p = planTextureSizes([{ width: 1024, height: 1024 }], {
      maxSize: 4096,
      budgetBytes: 4 * 1024 * 1024,
      mipmaps: true,
    });
    expect(p[0]!.width).toBeLessThan(1024);
  });
});

describe("PNG helpers", () => {
  it("encodes RGBA8 PNGs that decode to the same pixels and reads their header", () => {
    const w = 5;
    const h = 3;
    const data = new Uint8Array(w * h * 4).map((_, i) => (i * 37) % 256);
    const png = encodePngRgba8(w, h, data);
    expect(readPngInfo(png)).toEqual({
      width: 5,
      height: 3,
      bitDepth: 8,
      colorType: 6,
      interlaced: false,
    });
    const back = decodePng(png);
    expect(Array.from(back.data)).toEqual(Array.from(data));
    expect(readPngInfo(new Uint8Array(40))).toBeNull();
  });
  it("converts alpha both ways", () => {
    const straight = new Uint8Array([255, 128, 0, 128, 10, 20, 30, 0]);
    const pm = convertAlpha(straight, "straight", "premultiplied");
    expect(Array.from(pm)).toEqual([128, 64, 0, 128, 0, 0, 0, 0]);
    expect(Array.from(convertAlpha(pm, "premultiplied", "straight"))).toEqual([
      255, 128, 0, 128, 0, 0, 0, 0,
    ]);
  });
});

/**
 * Reference rendering formulas (src/core/render) against the examples of
 * premultiplication (§2b.1), mip averaging (§2b.3), framing (§2i),
 * mask groups and mapping (§2g), and the worked examples of §2j.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  advancedBlend,
  advancedSource,
  alphaWeights,
  colorFunction,
  fragmentColor,
  isCompatibleBlend,
  legacyBlend,
  mipAverage,
  premultiplyByte,
  toByte,
  type Rgb,
  type Rgba,
} from "../src/core/render/compositing.js";
import {
  clipTransform,
  frameImage,
  imagePosition,
  outputPosition,
} from "../src/core/render/framing.js";
import { drawablesBox, maskGroups, maskMapping } from "../src/core/render/masks.js";
import { loadMoc } from "../src/core/moc/model.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const close = (a: readonly number[], b: readonly number[], digits = 5) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
};

describe("textures (§2b)", () => {
  it("premultiplies bytes as ⌊c·a/255 + ½⌋ (examples)", () => {
    const cases: [number, number, number][] = [
      [200, 128, 100],
      [1, 128, 1],
      [255, 1, 1],
      [37, 200, 29],
      [128, 255, 128],
    ];
    for (const [c, a, p] of cases) expect(premultiplyByte(c, a)).toBe(p);
  });

  it("never meets a tie, so the formula is unambiguous for all 65,536 pairs", () => {
    for (let c = 0; c < 256; c++)
      for (let a = 0; a < 256; a++)
        expect((2 * c * a) % 255 === 0 && ((2 * c * a) / 255) % 2 === 1).toBe(false);
  });

  it("averages 2×2 blocks with ties to even", () => {
    expect(mipAverage(10, 10, 11, 11)).toBe(10);
    expect(mipAverage(11, 11, 12, 12)).toBe(12);
    expect(mipAverage(0, 0, 0, 3)).toBe(1); // 0.75
    expect(mipAverage(0, 0, 0, 1)).toBe(0); // 0.25
    expect(mipAverage(255, 255, 255, 255)).toBe(255);
  });
});

describe("worked examples (§2j)", () => {
  const T: Rgba = [0.4, 0.2, 0.1, 0.5];
  const M: Rgb = [0.5, 1, 1];
  const S: Rgb = [0.2, 0.2, 0.2];
  const o = 0.8;
  const m = 0.75;

  it("a) fragment color", () => {
    close(fragmentColor(T, M, S, 1).slice(0, 3), [0.26, 0.26, 0.18]);
    close(fragmentColor(T, M, S, o), [0.208, 0.208, 0.144, 0.4]);
    close(fragmentColor(T, M, S, o, { coverage: m, inverted: false }), [0.156, 0.156, 0.108, 0.3]);
    close(fragmentColor(T, M, S, o, { coverage: m, inverted: true }), [0.052, 0.052, 0.036, 0.1]);
  });

  it("b) legacy blends over (0.5, 0.5, 0.5, 1)", () => {
    const src = fragmentColor(T, M, S, o, { coverage: m, inverted: false });
    const dst: Rgba = [0.5, 0.5, 0.5, 1];
    const normal = legacyBlend("normal", src, dst);
    close(normal, [0.506, 0.506, 0.458, 1]);
    expect(normal.map(toByte)).toEqual([129, 129, 117, 255]);
    close(legacyBlend("additive", src, dst), [0.656, 0.656, 0.608, 1]);
    close(legacyBlend("multiplicative", src, dst), [0.428, 0.428, 0.404, 1]);
  });

  it("c) advanced source, color functions and alpha modes", () => {
    const src = advancedSource(T, M, S, o, { coverage: m, inverted: false });
    close(src.C, [0.72, 0.72, 0.56]);
    expect(src.A).toBeCloseTo(0.3, 6);
    const Cd: Rgb = [0.6, 0.4, 0.2];
    const table: Record<number, Rgb> = {
      0: [0.72, 0.72, 0.56],
      3: [1, 1, 0.76],
      4: [1.32, 1.12, 0.76],
      5: [0.6, 0.4, 0.2],
      6: [0.432, 0.288, 0.112],
      7: [0.444444, 0.166667, 0],
      8: [0.32, 0.12, 0],
      9: [0.72, 0.72, 0.56],
      10: [0.888, 0.832, 0.648],
      11: [1, 1, 0.454545],
      12: [0.776, 0.576, 0.224],
      13: [0.676823, 0.50228, 0.22976],
      14: [0.776, 0.664, 0.296],
      15: [1, 0.84, 0.32],
      16: [0.482, 0.482, 0.082],
      17: [0.4556, 0.4556, 0.2956],
    };
    for (const [code, B] of Object.entries(table)) close(colorFunction(Number(code), src.C, Cd), B);
    const dst: Rgba = [0.3, 0.2, 0.1, 0.5];
    const modes: [number, Rgb, Rgba][] = [
      [0, [0.15, 0.15, 0.35], [0.3828, 0.2912, 0.1708, 0.65]],
      [1, [0.15, 0, 0.35], [0.2748, 0.1832, 0.0868, 0.5]],
      [2, [0, 0, 0.35], [0.21, 0.14, 0.07, 0.35]],
      [3, [0.3, 0, 0.2], [0.2496, 0.1664, 0.0736, 0.5]],
      [4, [0, 0.3, 0.5], [0.516, 0.416, 0.268, 0.8]],
    ];
    for (const [mode, p, result] of modes) {
      close(alphaWeights(mode, src.A, 0.5), p);
      close(advancedBlend(6 | (mode << 8), src, dst), result);
    }
  });

  it("d) helper edge cases (color and hue)", () => {
    close(colorFunction(17, [1, 0, 0], [0.9, 0.9, 0.9]), [1, 0.857143, 0.857143]);
    close(colorFunction(16, [0.9, 0.1, 0.1], [0.2, 0.5, 0.8]), [0.863, 0.263, 0.263]);
  });

  it("a fully transparent source leaves the destination unchanged in every alpha mode", () => {
    const dst: Rgba = [0.3, 0.2, 0.1, 0.5];
    for (let mode = 0; mode < 5; mode++)
      close(advancedBlend(10 | (mode << 8), { C: [0.5, 0.5, 0.5], A: 0 }, dst), dst);
  });

  it("classifies compatible blend codes", () => {
    expect(isCompatibleBlend(0)).toBe(true);
    expect(isCompatibleBlend(1)).toBe(true);
    expect(isCompatibleBlend(2 | (3 << 8))).toBe(true);
    expect(isCompatibleBlend(0 | (1 << 8))).toBe(false);
    expect(isCompatibleBlend(6)).toBe(false);
  });
});

describe("masks (§2g)", () => {
  it("maps output space into the buffer (§2g.3 example)", () => {
    const map = maskMapping({ x0: -0.1, y0: 0.3, w: 0.3, h: 0.2 }, 3749, 4096);
    const t = [(0.05 - map.ox) * map.sx, (0.4 - map.oy) * map.sy];
    close(t, [0.137292, 0.091528], 6);
    close([t[0]! * 4096, t[1]! * 4096], [562.35, 374.9], 2);
    const wide = maskMapping({ x0: -0.6, y0: 0, w: 1.5, h: 0.1 }, 3749, 4096);
    expect(wide.ox).toBeCloseTo(-0.675, 12);
    expect((0 - wide.ox) * wide.sx).toBeCloseTo(0.409091, 6);
  });

  it("starts the running maximum of a drawable group box at the smallest positive double", () => {
    const verts = [Float32Array.of(-3, -2, -1, -5)];
    const box = drawablesBox([0], verts, true);
    expect(box).toEqual({ x0: -3, y0: -5, w: 3 + Number.MIN_VALUE, h: 5 + Number.MIN_VALUE });
    expect(drawablesBox([0], verts, false)).toEqual({ x0: -3, y0: -5, w: 2, h: 3 });
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "forms DeepSeek-chan's 49 mask groups from 181 masked drawables",
    () => {
      const root = resolve(__dirname, "..");
      const model = loadMoc(readFileSync(join(DEEPSEEK, "大肥鱼.moc3")));
      const { groups, groupOf } = maskGroups(model.meshes.masks);
      expect(groupOf.filter((g) => g >= 0).length).toBe(181);
      expect(groups.length).toBe(49);
      const hist = new Map<number, number>();
      for (const g of groups) hist.set(g.masks.length, (hist.get(g.masks.length) ?? 0) + 1);
      expect([...hist].sort((a, b) => a[0] - b[0])).toEqual([
        [1, 33],
        [2, 8],
        [3, 2],
        [4, 4],
        [5, 1],
        [16, 1],
      ]);
    },
  );
});

describe.skipIf(!HAVE_DEEPSEEK)("framing (§2i)", () => {
  const root = resolve(__dirname, "..");
  const model = HAVE_DEEPSEEK ? loadMoc(readFileSync(join(DEEPSEEK, "大肥鱼.moc3"))) : null!;

  it("fits DeepSeek-chan's canvas as in the examples", () => {
    const f = frameImage(model.canvas, 384, 768);
    expect(f.k).toBeCloseTo(374.072, 3);
    expect([f.centerX, f.centerY]).toEqual([0, 0]);
    close(imagePosition(f, 0.25, 0.5), [285.518, 196.964], 3);
    const g = frameImage(model.canvas, 512, 512);
    expect(g.k).toBeCloseTo(249.381, 3);
    const half = (model.canvas.width / model.canvas.pixelsPerUnit / 2) * g.k;
    close([256 - half, 256 + half], [131.3, 380.7], 1);
  });

  it("uses an explicit view and inverts the mapping", () => {
    const f = frameImage(model.canvas, 512, 512, { x: -0.01, y: 0.6, pixelsPerUnit: 2500 });
    expect(f).toEqual({ width: 512, height: 512, k: 2500, centerX: -0.01, centerY: 0.6 });
    const [P, Q] = imagePosition(f, 0.03, 0.55);
    close(outputPosition(f, P, Q), [0.03, 0.55], 12);
    const [sx, sy, tx, ty] = clipTransform(f);
    // Clip x = 2P/W − 1 and clip y = 1 − 2Q/H.
    expect(0.03 * sx + tx).toBeCloseTo((2 * P) / 512 - 1, 12);
    expect(0.55 * sy + ty).toBeCloseTo(1 - (2 * Q) / 512, 12);
  });
});

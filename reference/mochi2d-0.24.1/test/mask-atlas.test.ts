import { describe, expect, it } from "vitest";
import { ATLAS_GUTTER, clipBox, packMaskAtlas } from "../src/render/model/mask-atlas.js";
import type { Box } from "../src/core/render/masks.js";

const boxes: (Box | null)[] = [
  { x0: -0.3, y0: 0.2, w: 0.25, h: 0.1 },
  null,
  { x0: 0.1, y0: -0.5, w: 0.05, h: 0.4 },
  { x0: -1, y0: -1, w: 2, h: 1.5 }, // too big for a region: margin mapping
  { x0: 0.2, y0: 0.2, w: 0, h: 0 }, // empty
];
// A coordinate's texel along one axis: ((v − o)·s + ℓ)·T.
const texel = (v: number, o: number, s: number, T: number, l = 0) => ((v - o) * s + l) * T;

describe("mask atlas layout (viewer-only approximation)", () => {
  it("gives each box its own region inside the atlas", () => {
    const regions = packMaskAtlas(boxes, 1000, 2048, 1024)!;
    expect(regions).not.toBeNull();
    expect(regions[1]).toBeNull();
    const rects = regions.filter((r) => r !== null);
    expect(rects).toHaveLength(4);
    for (const r of rects) {
      expect(r.x + r.w).toBeLessThanOrEqual(2048);
      expect(r.y + r.h).toBeLessThanOrEqual(2048);
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `regions ${i} and ${j} overlap`).toBe(true);
      }
  });

  it("maps each box inside its region, clear of the gutter", () => {
    const T = 2048;
    const regions = packMaskAtlas(boxes, 1000, T, 1024)!;
    boxes.forEach((b, i) => {
      const r = regions[i];
      if (!b || !r) return;
      const m = r.map;
      for (const [x, y] of [
        [b.x0, b.y0],
        [b.x0 + b.w, b.y0 + b.h],
      ] as const) {
        const tx = texel(x, m.ox, m.sx, T, m.lx);
        const ty = texel(y, m.oy, m.sy, T, m.ly);
        expect(tx).toBeGreaterThanOrEqual(r.x + ATLAS_GUTTER - 1e-6);
        expect(tx).toBeLessThanOrEqual(r.x + r.w - ATLAS_GUTTER + 1e-6);
        expect(ty).toBeGreaterThanOrEqual(r.y + ATLAS_GUTTER - 1e-6);
        expect(ty).toBeLessThanOrEqual(r.y + r.h - ATLAS_GUTTER + 1e-6);
      }
    });
  });

  it("spends `density` texels per unit from the box edge when the box fits", () => {
    const T = 2048;
    const r = packMaskAtlas(boxes, 1000, T, 1024)![0]!;
    expect(r.map.sx * T).toBeCloseTo(1000, 9);
    expect(texel(-0.3, r.map.ox, r.map.sx, T, r.map.lx)).toBeCloseTo(r.x + ATLAS_GUTTER, 9);
  });

  it("stretches a box that is too big, with a 5 % margin, over the largest region", () => {
    const T = 2048;
    const r = packMaskAtlas(boxes, 1000, T, 1024)![3]!;
    const inner = 1024 - 2 * ATLAS_GUTTER;
    expect(r.map.sx * T).toBeCloseTo(inner / 2.2, 9);
    expect(texel(-1.1, r.map.ox, r.map.sx, T, r.map.lx)).toBeCloseTo(r.x + ATLAS_GUTTER, 9);
    expect(texel(1.1, r.map.ox, r.map.sx, T, r.map.lx)).toBeCloseTo(r.x + ATLAS_GUTTER + inner, 9);
  });

  it("normalizes coordinates to the texture, which may be larger than the packed area", () => {
    const a = packMaskAtlas(boxes, 1000, 2048, 1024)!;
    const b = packMaskAtlas(boxes, 1000, 2048, 1024, 4096)!;
    a.forEach((r, i) => {
      const q = b[i];
      if (!r || !q) return expect(q).toBe(r);
      expect([q.x, q.y, q.w, q.h]).toEqual([r.x, r.y, r.w, r.h]);
      // Same texel for the same point, in a texture twice as large.
      expect(texel(0.05, q.map.ox, q.map.sx, 4096, q.map.lx)).toBeCloseTo(
        texel(0.05, r.map.ox, r.map.sx, 2048, r.map.lx),
        9,
      );
    });
  });

  it("reports when the regions do not fit", () => {
    const big = { x0: 0, y0: 0, w: 1, h: 1 };
    expect(packMaskAtlas([big, big, big, big, big], 1000, 2048, 1024)).toBeNull();
    expect(packMaskAtlas([big, big, big, big], 1000, 2048, 1024)).not.toBeNull();
  });

  it("clips boxes to the visible rectangle", () => {
    const view = { x0: -1, y0: -1, x1: 1, y1: 1 };
    expect(clipBox({ x0: -2, y0: 0, w: 2.5, h: 3 }, view)).toEqual({ x0: -1, y0: 0, w: 1.5, h: 1 });
    expect(clipBox({ x0: -0.5, y0: -0.5, w: 1, h: 1 }, view)).toEqual({
      x0: -0.5,
      y0: -0.5,
      w: 1,
      h: 1,
    });
    // Entirely off-screen: an empty box on the edge.
    expect(clipBox({ x0: 3, y0: 0, w: 1, h: 0.5 }, view)).toEqual({ x0: 1, y0: 0, w: 0, h: 0.5 });
  });
});

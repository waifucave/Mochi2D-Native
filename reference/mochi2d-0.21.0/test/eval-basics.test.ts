import { describe, expect, it } from "vitest";
import { evaluationValue, locateKey, type KeyLocation } from "../src/core/eval/binding.js";
import { warpPoint, type WarpGrid } from "../src/core/eval/warp-map.js";

const fr = Math.fround;

describe("§1d.1 binding location", () => {
  const keys = Float32Array.from([-30, 0, 30]);
  const loc = (v: number): KeyLocation =>
    locateKey(keys, fr(v), { index: -1, t: -1, outOfRange: false });
  const cases: [number, boolean, number, number][] = [
    [-30.0011, true, 0, 0],
    [-30.0009, false, 0, 0],
    [-15, false, 0, 0.5],
    [0.00099, false, 1, 0],
    [0.001, false, 1, fr(fr(0.001) / 30)],
    [29.99901, false, 2, 0],
    [fr(29.999), false, 1, fr(fr(29.999) / 30)],
    [30.0009, false, 2, 0],
    [30.0011, true, 2, 0],
  ];
  for (const [v, oor, i, t] of cases) {
    it(`v = ${v}`, () => {
      const r = loc(v);
      expect(r.outOfRange).toBe(oor);
      expect(r.index).toBe(i);
      expect(r.t).toBe(t);
    });
  }
  it("t for 0.001 is 3.3333334e-5", () => {
    expect(loc(0.001).t).toBeCloseTo(3.3333334e-5, 12);
  });
  it("uses an absolute epsilon at the range edge (bisection example)", () => {
    const k = Float32Array.from([-10, 10]);
    const edge = fr(-10.001);
    const l = { index: 0, t: 0, outOfRange: false };
    expect(locateKey(k, edge, l).outOfRange).toBe(false);
    const below = fr(edge - 1e-6); // next float32 below is within this step
    expect(locateKey(k, below, l).outOfRange).toBe(true);
  });
  it("single key gives (0, 0) and still tests the range", () => {
    const k = Float32Array.from([5]);
    const l = { index: -1, t: -1, outOfRange: false };
    expect(locateKey(k, 5.5, l)).toMatchObject({ index: 0, t: 0, outOfRange: true });
    expect(locateKey(k, 5.0005, l)).toMatchObject({ index: 0, t: 0, outOfRange: false });
  });
});

describe("§1c.1 repeat wrap", () => {
  const table: [number, number][] = [
    [45, -15],
    [75, 15],
    [90, -30],
    [90.01, -29.99],
    [-45, 15],
    [29.9995, 29.9995],
    [30, -30],
  ];
  for (const [set, expected] of table) {
    it(`${set} evaluates as ${expected}`, () => {
      expect(evaluationValue(set, -30, 30, true)).toBeCloseTo(expected, 4);
    });
  }
  it("clamps normal parameters", () => {
    expect(evaluationValue(45, -30, 30, false)).toBe(30);
    expect(evaluationValue(-1000, -30, 30, false)).toBe(-30);
  });
});

describe("§1d.2 warp mapping", () => {
  const R = 5;
  const C = 5;
  const pts = new Float32Array(2 * (R + 1) * (C + 1));
  for (let r = 0; r <= R; r++) {
    for (let c = 0; c <= C; c++) {
      const i = 2 * (r * (C + 1) + c);
      pts[i] = fr(-1 + (2 * c) / 5 + 0.05 * Math.sin(1.3 * c + 0.7 * r));
      pts[i + 1] = fr(-1 + (2 * r) / 5 + 0.05 * Math.cos(0.9 * c - 1.1 * r));
    }
  }
  const tri: WarpGrid = { points: pts, rows: R, columns: C, bilinear: false };
  const bil: WarpGrid = { points: pts, rows: R, columns: C, bilinear: true };
  it("grid point (0, 0) is (-1, -0.95)", () => {
    expect(pts[0]).toBe(-1);
    expect(pts[1]).toBeCloseTo(-0.95, 6);
  });
  const table: [number, number, [number, number], [number, number] | null][] = [
    [0.5, 0.5, [-0.045805, 0.023708], [-0.035855, 0.033684]],
    [0.13, 0.77, [-0.756511, 0.50568], [-0.756602, 0.503372]],
    [0.61, 0.07, [0.179769, -0.889875], [0.180482, -0.890557]],
    [0.35, 0.95, [-0.326666, 0.866684], [-0.324264, 0.864136]],
    [1, 1, [0.972799, 1.027015], null],
    [-0.5, 0.5, [-1.967733, 0.00115], null],
    [-1.5, 0.3, [-3.995876, -0.312011], null],
    [0.5, -1, [0.043352, -3.009033], null],
    [1.5, 1.5, [1.961751, 2.009007], null],
    [2.5, -0.25, [4.014685, -1.555359], null],
    [-1.7, 2.6, [-4.467205, 4.323514], null],
    [3.5, 0.5, [5.993145, -0.07796], null],
    [10, 10, [18.733093, 18.807119], null],
  ];
  const out = new Float32Array(2);
  for (const [u, v, t, b] of table) {
    it(`W(${u}, ${v})`, () => {
      warpPoint(tri, fr(u), fr(v), out, 0);
      expect(Math.abs(out[0]! - t[0])).toBeLessThan(2e-6);
      expect(Math.abs(out[1]! - t[1])).toBeLessThan(2e-6);
      warpPoint(bil, fr(u), fr(v), out, 0);
      const e = b ?? t;
      expect(Math.abs(out[0]! - e[0])).toBeLessThan(2e-6);
      expect(Math.abs(out[1]! - e[1])).toBeLessThan(2e-6);
    });
  }
  it("is continuous across the grid boundary and the near/far boundary", () => {
    const a = new Float32Array(2);
    const b2 = new Float32Array(2);
    for (const g of [tri, bil]) {
      for (const [u, v] of [
        [0, 0.3],
        [1, 0.6],
        [0.4, 0],
        [0.7, 1],
        [-2, 0.5],
        [3, 0.5],
        [0.5, -2],
        [0.5, 3],
      ] as const) {
        warpPoint(g, fr(u - 1e-5), fr(v - 1e-5), a, 0);
        warpPoint(g, fr(u + 1e-5), fr(v + 1e-5), b2, 0);
        expect(Math.hypot(a[0]! - b2[0]!, a[1]! - b2[1]!)).toBeLessThan(1e-3);
      }
    }
  });
});

/**
 * The forward mapping (`mapPoints`, `mapJacobians`; ModelRuntime.mapPoints):
 * points from a deformer's input space to model units through its world form
 * at the latest evaluation.
 *
 * - The mapped points equal the evaluator's own vertices bit for bit, inside
 *   a warp's grid, in the near band and far outside, through rotations with
 *   mirror flags and through chains, with both kernels.
 * - The analytic Jacobian matches central differences of the mapping, away
 *   from region boundaries, in both warp modes and in both spaces.
 *
 * On synthetic `.moc3` files; DeepSeek-chan's deformers where it is present.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { ModelInstance, type MapSpace } from "../src/core/eval/instance.js";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { ModelRuntime } from "../src/runtime/model-runtime.js";
import { loadModelFromDisk } from "../src/lib/node.js";
import { MODES } from "./support/evaluate.js";
import { Synth, spec1d2Grid } from "./support/synth.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const fr = Math.fround;

/** A seeded sequence in [0, 1). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/**
 * Points of a warp's input space in every region: inside, the near band
 * ([−2, 3]² outside the unit square) and far outside.
 */
function regionPoints(n: number, seed: number): number[] {
  const rnd = lcg(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const region = i % 3;
    const span = region === 0 ? [0, 1] : region === 1 ? [-2, 3] : [-6, 7];
    let u = span[0]! + rnd() * (span[1]! - span[0]!);
    let v = span[0]! + rnd() * (span[1]! - span[0]!);
    if (region === 1 && u >= 0 && u < 1 && v >= 0 && v < 1) u -= 1.5; // into the band
    if (region === 2 && u >= -2 && u <= 3 && v >= -2 && v <= 3) v += 4; // out of the band
    out.push(fr(u), fr(v));
  }
  return out;
}

/**
 * A distorted 5×5 warp W (triangle or bilinear) under a mirrored, scaled
 * rotation P, a rotation R inside W, and child meshes holding `points`: one
 * under W, one under R, one under P. A parameter Q moves W's grid and P.
 */
function chainModel(bilinear: boolean, points: number[]): { model: MocModel; q: number } {
  const s = new Synth(5);
  s.part({ id: "Root" });
  const q = s.param("Q", 0, 1, 0);
  const band = s.band([s.binding(q, [0, 1])]);
  const grid = spec1d2Grid();
  const moved = grid.map((x, i) => fr(x * 1.2 + (i % 2 ? 0.1 : -0.05) * Math.sin(i)));
  const p = s.rotation({
    id: "P",
    band,
    baseAngle: 10,
    keyforms: [
      { angle: 20, x: 0.3, y: -0.2, scale: 1.5, mirrorY: true },
      { angle: -35, x: 0.1, y: 0.4, scale: 0.75, mirrorX: true },
    ],
  });
  const w = s.warp({
    id: "W",
    parent: p,
    band,
    rows: 5,
    cols: 5,
    bilinear,
    keyforms: [{ points: grid }, { points: moved }],
  });
  const r = s.rotation({
    id: "R",
    parent: w,
    keyforms: [{ angle: 33, x: 0.4, y: 0.6, scale: 0.02, mirrorX: true }],
  });
  const triangles = [0, 1, 2];
  s.mesh({ id: "MW", deformer: w, triangles, keyforms: [{ positions: points }] });
  s.mesh({ id: "MR", deformer: r, triangles, keyforms: [{ positions: points.map((x) => x * 7) }] });
  s.mesh({ id: "MP", deformer: p, triangles, keyforms: [{ positions: points }] });
  return { model: loadMoc(s.build()), q };
}

describe("mapPoints: the evaluator's own mapping", () => {
  const POINTS = regionPoints(300, 7);
  for (const bilinear of [false, true])
    it(`equals the drawables' vertices bit for bit (${bilinear ? "bilinear" : "triangle"} warp, every kernel)`, () => {
      const { model: m, q } = chainModel(bilinear, POINTS);
      const R_POINTS = POINTS.map((x) => fr(x * 7));
      for (const mode of MODES)
        for (const value of [0, 0.37, 1]) {
          const inst = new ModelInstance(m, mode);
          inst.setParameter(q, value);
          inst.evaluate();
          const what = `${mode.kernels}, Q = ${value}`;
          // Deformers 0 P, 1 W, 2 R; meshes MW, MR, MP.
          expect(Array.from(inst.mapPoints(1, POINTS)), what).toEqual(
            Array.from(inst.drawableVertices[0]!),
          );
          expect(Array.from(inst.mapPoints(2, R_POINTS)), what).toEqual(
            Array.from(inst.drawableVertices[1]!),
          );
          expect(Array.from(inst.mapPoints(0, POINTS)), what).toEqual(
            Array.from(inst.drawableVertices[2]!),
          );
          // "keyform" space: y not negated; −1: the identity.
          const k = inst.mapPoints(1, POINTS, "keyform");
          const o = inst.mapPoints(1, POINTS, "model");
          for (let i = 0; i < k.length; i += 2) {
            expect(k[i]).toBe(o[i]);
            expect(k[i + 1]).toBe(-o[i + 1]!);
          }
          expect(Array.from(inst.mapPoints(-1, [0.5, 0.25], "keyform"))).toEqual([0.5, 0.25]);
          expect(Array.from(inst.mapPoints(-1, [0.5, 0.25]))).toEqual([0.5, -0.25]);
        }
    });

  it("maps more points than one chunk, into a given array, and checks its arguments", () => {
    const many = regionPoints(1500, 3);
    const { model: m } = chainModel(false, many);
    const inst = new ModelInstance(m);
    const out = new Float32Array(many.length);
    expect(inst.mapPoints(1, many, "model", out)).toBe(out);
    expect(Array.from(out)).toEqual(Array.from(inst.drawableVertices[0]!));
    expect(() => inst.mapPoints(3, [0, 0])).toThrow(RangeError);
    expect(() => inst.mapPoints(-2, [0, 0])).toThrow(RangeError);
    expect(() => inst.mapPoints(0, [0, 0, 1])).toThrow(RangeError);
    expect(() => inst.mapPoints(0, [0, 0], "model", new Float32Array(1))).toThrow(RangeError);
  });
});

/** One float32 step at the magnitude of x. */
const ulp32 = (x: number) => 2 ** (Math.floor(Math.log2(Math.max(Math.abs(x), 2 ** -126))) - 23);

/**
 * Central differences of the mapping (in double, from float32 mappings at
 * ±h), with the size of their float32 noise: a few steps of the outputs over
 * the step taken.
 */
function centralJacobian(
  inst: ModelInstance,
  d: number,
  x: number,
  y: number,
  h: number,
  space: MapSpace,
): { J: number[]; noise: number } {
  const at = (px: number, py: number) => inst.mapPoints(d, [px, py], space);
  const xp = at(x + h, y);
  const xm = at(x - h, y);
  const yp = at(x, y + h);
  const ym = at(x, y - h);
  // The float32 steps actually taken.
  const hx = fr(x + h) - fr(x - h);
  const hy = fr(y + h) - fr(y - h);
  const largest = Math.max(...[...xp, ...xm, ...yp, ...ym].map(Math.abs));
  return {
    J: [
      (xp[0]! - xm[0]!) / hx,
      (yp[0]! - ym[0]!) / hy,
      (xp[1]! - xm[1]!) / hx,
      (yp[1]! - ym[1]!) / hy,
    ],
    noise: (8 * ulp32(largest)) / Math.min(hx, hy),
  };
}

/** Checks an analytic Jacobian against central differences: within their noise plus 10⁻⁴ of its size. */
function expectClose(a: number[], c: { J: number[]; noise: number }, what: string): void {
  const size = Math.max(...a.map(Math.abs));
  for (let k = 0; k < 4; k++)
    expect(Math.abs(a[k]! - c.J[k]!), `${what}: ${a} vs ${c.J}`).toBeLessThanOrEqual(
      c.noise + 1e-4 * size,
    );
}

/** Whether (u, v) lies within `m` of a region boundary of a C×R warp's mapping. */
function nearBoundary(u: number, v: number, C: number, R: number, m: number): boolean {
  const lines = (t: number, n: number) => {
    const cuts = [-2, 3];
    for (let i = 0; i <= n; i++) cuts.push(i / n);
    return cuts.some((c) => Math.abs(t - c) < m);
  };
  if (lines(u, C) || lines(v, R)) return true;
  // The triangle diagonal of the cell (or band cell) the point lies in.
  const frac = (t: number, n: number) => {
    if (t < 0) return (t + 2) / 2;
    if (t > 1) return (t - 1) / 2;
    const k = Math.min(Math.floor(t * n), n - 1);
    return t * n - k;
  };
  const inBand = u >= -2 && u <= 3 && v >= -2 && v <= 3;
  if (!inBand) return false;
  return Math.abs(frac(u, C) + frac(v, R) - 1) < 4 * m * Math.max(C, R);
}

describe("mapJacobians: the analytic Jacobian", () => {
  for (const bilinear of [false, true])
    for (const space of ["model", "keyform"] as const)
      it(`matches central differences (${bilinear ? "bilinear" : "triangle"} warp, ${space} space)`, () => {
        const POINTS = regionPoints(600, 11);
        const { model: m, q } = chainModel(bilinear, POINTS);
        const inst = new ModelInstance(m);
        inst.setParameter(q, 0.37);
        inst.evaluate();
        const h = 1e-3;
        let checked = 0;
        let worst = 0;
        for (const [d, scale] of [
          [1, 1],
          [2, 7],
          [0, 1],
        ] as const) {
          const pts = POINTS.map((x) => fr(x * scale));
          const J = inst.mapJacobians(d, pts, space);
          for (let i = 0; i < pts.length / 2; i++) {
            const [x, y] = [pts[2 * i]!, pts[2 * i + 1]!];
            // Rotations (P, and R: flattened, so affine) have no region boundaries.
            if (d === 1 && nearBoundary(x, y, 5, 5, 3 * h)) continue;
            // Rotations are affine: a large step keeps float32 rounding out of the differences.
            const c = centralJacobian(inst, d, x, y, d === 1 ? h : 1, space);
            const a = Array.from(J.subarray(4 * i, 4 * i + 4));
            expectClose(a, c, `deformer ${d}, point (${x}, ${y})`);
            const size = Math.max(...a.map(Math.abs));
            worst = Math.max(worst, ...a.map((v, k) => Math.abs(v - c.J[k]!) / size));
            checked++;
          }
        }
        expect(checked).toBeGreaterThan(1000);
        expect(worst).toBeLessThan(2e-3);
      });

  it("a rotation's Jacobian is s·R(θ)·diag(±1, ±1), mirror flags included", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    for (const [mx, my] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const)
      s.rotation({
        id: `R${mx}${my}`,
        keyforms: [{ angle: 30, x: 1, y: 2, scale: 2, mirrorX: mx, mirrorY: my }],
      });
    s.mesh({ id: "M", keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
    const inst = new ModelInstance(loadMoc(s.build()));
    const c = Math.cos(Math.PI / 6);
    const sn = Math.sin(Math.PI / 6);
    for (const [d, mx, my] of [
      [0, 1, 1],
      [1, -1, 1],
      [2, 1, -1],
      [3, -1, -1],
    ] as const) {
      const J = Array.from(inst.mapJacobians(d, [5, -3], "keyform"));
      const expected = [2 * c * mx, -2 * sn * my, 2 * sn * mx, 2 * c * my];
      J.forEach((v, k) => expect(v, `rotation ${d}`).toBeCloseTo(expected[k]!, 6));
      // In model space (y up), the y row is negated.
      const Jm = Array.from(inst.mapJacobians(d, [5, -3]));
      expect(Jm).toEqual([J[0], J[1], -J[2]!, -J[3]!]);
    }
    expect(Array.from(inst.mapJacobians(-1, [5, -3]))).toEqual([1, 0, -0, -1]);
  });
});

describe("ModelRuntime.mapPoints", () => {
  async function runtime() {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const w = s.warp({
      id: "W",
      rows: 1,
      cols: 1,
      keyforms: [{ points: [0, 0, 2, 0, 0, 2, 2, 2] }],
    });
    s.rotation({ id: "R", parent: w, keyforms: [{ angle: 90, x: 0.5, y: 0.5, scale: 0.5 }] });
    s.mesh({ id: "M", deformer: 1, keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
    const source = MemoryFileSource.fromFiles({
      "m.model3.json": JSON.stringify({
        Version: 3,
        FileReferences: { Moc: "m.moc3", Textures: [] },
      }),
      "m.moc3": s.build(),
    });
    return ModelRuntime.load(source, "m.model3.json");
  }

  it("lists the deformers and maps by ID, with Jacobians", async () => {
    const rt = await runtime();
    expect(rt.deformers).toEqual([
      { id: "W", kind: "warp", parent: null },
      { id: "R", kind: "rotation", parent: "W" },
    ]);
    // The warp doubles: (0.25, 0.75) → (0.5, 1.5) in keyform space, y negated in model units.
    const w = rt.mapPoints("W", [0.25, 0.75], { jacobian: true });
    expect(Array.from(w.points)).toEqual([0.5, -1.5]);
    expect(Array.from(w.jacobians!)).toEqual([2, 0, -0, -2]);
    // The rotation sits at W(0.5, 0.5) = (1, 1), turned by 90°, scale 0.5 · σ.
    const r = rt.mapPoints("R", [1, 0], { space: "keyform" });
    expect(r.points[0]).toBeCloseTo(1, 6);
    expect(r.jacobians).toBeUndefined();
    // The mesh's vertices are R's mapping of its keyform positions.
    expect(Array.from(rt.mapPoints("R", [0, 0, 1, 0, 0, 1]).points)).toEqual(
      Array.from(rt.instance.drawableVertices[0]!),
    );
    expect(Array.from(rt.mapPoints(null, [3, 4]).points)).toEqual([3, -4]);
    expect(() => rt.mapPoints("Nope", [0, 0])).toThrow(/no deformer "Nope"/);
  });
});

describe.skipIf(!HAVE_DEEPSEEK)("on DeepSeek-chan", () => {
  it("the Jacobian matches central differences for every deformer at a pose", async () => {
    const rt = await loadModelFromDisk(join(DEEPSEEK, "大肥鱼.model3.json"));
    for (const e of ["physics", "eyeBlink", "breath", "look", "idle"] as const)
      rt.setEffect(e, false);
    rt.setParameter("ParamAngleX", 17);
    rt.setParameter("ParamAngleY", -9);
    rt.setParameter("ParamBodyAngleZ", 4);
    rt.update(0);
    const inst = rt.instance;
    const m = rt.model;
    let checked = 0;
    for (let d = 0; d < m.deformers.ids.length; d++) {
      const warp = m.deformers.kind[d] === 0;
      const [C, R] = warp
        ? [m.warps.columns[m.deformers.kindIndex[d]!]!, m.warps.rows[m.deformers.kindIndex[d]!]!]
        : [1, 1];
      // Points inside and in the band (warps), or around the origin (rotations).
      const pts = warp ? regionPoints(8, 100 + d) : [12, -7, -30, 4];
      const J = inst.mapJacobians(d, pts);
      for (let i = 0; i < pts.length / 2; i++) {
        const [x, y] = [pts[2 * i]!, pts[2 * i + 1]!];
        const h = warp ? 1e-3 : 1;
        if (warp && nearBoundary(x, y, C, R, 3 * h)) continue;
        const c = centralJacobian(inst, d, x, y, h, "model");
        expectClose(
          Array.from(J.subarray(4 * i, 4 * i + 4)),
          c,
          `${m.deformers.ids[d]} (${x}, ${y})`,
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2500);
  });
});

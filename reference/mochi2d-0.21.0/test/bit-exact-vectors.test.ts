/**
 * The float32 evaluation rules with their vectors: each expected value is the
 * float32 result printed in full, compared bit for bit (`Math.fround` of the
 * printed decimal is the exact float32).
 */
import { describe, expect, it } from "vitest";
import { warpPoint, type WarpGrid } from "../src/core/eval/warp-map.js";
import { createKernels, wasmKernelsAvailable } from "../src/core/eval/kernels.js";
import { loadMoc } from "../src/core/moc/model.js";
import { evaluateAll, type Output } from "./support/evaluate.js";
import { Synth, type RGB } from "./support/synth.js";

const f = Math.fround;

// ------------------------------------------------------------ the warp mapping

/** 2 × 2 cells, p(c, r) row by row. */
const GRID = [
  [-1, -1],
  [0.1, -1.2],
  [1, -0.9],
  [-1.1, 0.05],
  [0.2, 0.1],
  [0.9, -0.1],
  [-0.8, 1.1],
  [0.15, 0.95],
  [1.2, 1.05],
]
  .flat()
  .map(f);

/** (u, v), the triangle-cell result, the quad-cell result (null: the same). */
const WARP: [[number, number], [number, number], [number, number] | null][] = [
  [
    [0.3, 0.2],
    [-0.3799999952316284, -0.7000000476837158],
    [-0.3319999873638153, -0.64000004529953],
  ],
  [
    [0.8, 0.9],
    [0.7200000286102295, 0.7799999713897705],
    [0.7480000257492065, 0.8039999008178711],
  ],
  [
    [0.75, 0.25],
    [0.6000000238418579, -0.3999999761581421],
    [0.550000011920929, -0.5249999761581421],
  ],
  [[0.5, 0.5], [0.20000000298023224, 0.10000000149011612], null],
  [[-0.5, 0.25], [-2.000000238418579, -0.4874999523162842], null],
  [[0.4, -1.3], [-0.4450000822544098, -3.629999876022339], null],
  [[1.7, 2.2], [2.8399999141693115, 3.533125400543213], null],
  [[1, 0.5], [0.8999999761581421, -0.10000000149011612], null],
  [[-2, 0.5], [-4.900000095367432, 1.1920928955078125e-7], null],
  [[4.5, -3.25], [7.349999904632568, -7.431250095367432], null],
];

/** Maps points through a warp grid with every kernel kind available, and with warpPoint. */
function mapAll(
  points: Float32Array,
  rows: number,
  columns: number,
  bilinear: boolean,
  uv: number[],
) {
  const results: { kind: string; out: number[] }[] = [];
  const out = new Float32Array(uv.length);
  const grid: WarpGrid = { points, rows, columns, bilinear };
  for (let i = 0; i < uv.length; i += 2) warpPoint(grid, f(uv[i]!), f(uv[i + 1]!), out, i);
  results.push({ kind: "warpPoint", out: [...out] });
  for (const kind of wasmKernelsAvailable() ? (["js", "wasm"] as const) : (["js"] as const)) {
    const n = uv.length / 2;
    const k = createKernels(points.length + 4 * uv.length + 64, kind);
    k.heap.set(points, 0);
    const src = points.length;
    k.heap.set(uv.map(f), src);
    const dst = src + uv.length;
    k.warp(0, rows, columns, bilinear ? 1 : 0, src, dst, n, dst + uv.length);
    results.push({ kind, out: [...k.heap.subarray(dst, dst + uv.length)] });
    // In place too.
    k.heap.set(uv.map(f), src);
    k.warp(0, rows, columns, bilinear ? 1 : 0, src, src, n, dst + uv.length);
    results.push({ kind: `${kind} in place`, out: [...k.heap.subarray(src, src + uv.length)] });
  }
  return results;
}

describe("the warp mapping: inside, band and far, both cell flags", () => {
  for (const bilinear of [false, true]) {
    it(bilinear ? "quad cells" : "triangle cells", () => {
      const uv = WARP.flatMap(([p]) => p);
      const want = WARP.flatMap(([, tri, quad]) => (bilinear ? (quad ?? tri) : tri)).map(f);
      // Every point alone and all together (the wide WebAssembly path takes groups of 4).
      for (const r of mapAll(Float32Array.from(GRID), 2, 2, bilinear, uv))
        expect(r.out, r.kind).toEqual(want);
      for (let i = 0; i < WARP.length; i++)
        for (const r of mapAll(Float32Array.from(GRID), 2, 2, bilinear, uv.slice(2 * i, 2 * i + 2)))
          expect(r.out, `${r.kind} ${uv.slice(2 * i, 2 * i + 2)}`).toEqual(
            want.slice(2 * i, 2 * i + 2),
          );
    });
  }
});

// ------------------------------------------------- models, in every kernel mode

/** Vertices of mesh `i` in file coordinates (the instance reports y negated). */
const fileXY = (out: Output, i: number) => out.vertices[i]!.map((v, k) => (k % 2 ? -v : v));
/** Points as file-coordinate float32 pairs. */
const pts = (xy: number[][]) => xy.flat().map(f);

describe("a warp inside a rotation", () => {
  it("carries the grid points like vertices, then maps through the carried grid", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const r = s.rotation({
      id: "R",
      keyforms: [{ angle: f(33.7), x: 12.5, y: -7.25, scale: f(1.3), mirrorX: true }],
    });
    const grid = [
      [-40, -30],
      [5, -35],
      [45, -25],
      [-38, 30],
      [0, 28],
      [42, 35],
    ];
    const w = s.warp({
      id: "W",
      parent: r,
      rows: 1,
      cols: 2,
      bilinear: true,
      keyforms: [{ points: pts(grid) }],
    });
    s.mesh({ id: "Carried", deformer: r, keyforms: [{ positions: pts(grid) }] });
    s.mesh({
      id: "Mapped",
      deformer: w,
      keyforms: [
        {
          positions: pts([
            [0.25, 0.6],
            [0.9, 0.1],
            [-0.4, 0.5],
            [3.5, 0.5],
          ]),
        },
      ],
    });
    const out = evaluateAll(loadMoc(s.build()));
    expect(fileXY(out, 0)).toEqual(
      pts([
        [77.40054321289062, -10.844297409057617],
        [32.33772277832031, -48.71039962768555],
        [-18.136869430541992, -66.74691009521484],
        [31.9596004486084, 52.605525970458984],
        [-7.696338653564453, 23.033130645751953],
        [-58.17012023925781, 0.3094043731689453],
      ]),
    );
    expect(fileXY(out, 1)).toEqual(
      pts([
        [29.226627349853516, 10.780658721923828],
        [-12.045289993286133, -56.34022903442383],
        [92.08387756347656, 42.700679779052734],
        [-270.2374267578125, -168.4671630859375],
      ]),
    );
  });
});

const TRIANGLE = [0, 0, 1, 0, 0, 1];

describe("ancestor opacities, combined top-down", () => {
  it("a part tree: the parts' product from the root down, then own·acc", () => {
    const s = new Synth(6);
    const root = s.part({ id: "Root" });
    const a = s.part({ id: "A", parent: root });
    const b = s.part({ id: "B", parent: a });
    const c = s.part({ id: "C", parent: b });
    s.mesh({ id: "M", part: c, keyforms: [{ positions: TRIANGLE, opacity: f(0.8137) }] });
    const out = evaluateAll(loadMoc(s.build()), {
      parts: { [root]: f(0.9131), [a]: f(0.7279), [b]: f(0.5531), [c]: f(0.6617) },
    });
    expect(out.opacity[0]).toBe(f(0.19793343544006348));
  });

  it("deformers: f32(f32(own·dacc)·acc), dacc from the outermost deformer down", () => {
    const s = new Synth(5);
    const root = s.part({ id: "Root" });
    const r1 = s.rotation({
      id: "R1",
      keyforms: [{ angle: 0, x: 0, y: 0, scale: 1, opacity: f(0.83) }],
    });
    const w = s.warp({
      id: "W",
      parent: r1,
      rows: 1,
      cols: 1,
      keyforms: [{ points: [0, 0, 1, 0, 0, 1, 1, 1], opacity: f(0.61) }],
    });
    const r2 = s.rotation({
      id: "R2",
      parent: w,
      keyforms: [{ angle: 0, x: 0.5, y: 0.5, scale: 1, opacity: f(0.47) }],
    });
    s.mesh({ id: "M", deformer: r2, keyforms: [{ positions: TRIANGLE, opacity: f(0.7713) }] });
    const out = evaluateAll(loadMoc(s.build()), { parts: { [root]: f(0.6429) } });
    expect(out.opacity[0]).toBe(f(0.1179974153637886));
  });
});

describe("a repeating parameter is always wrapped", () => {
  // S repeats, T doesn't; both on keys −180, 0, 180. S001 (opacities 0, 0, 1) reports t on
  // 0…180, S010 (0, 1, 0) reports t on −180…0; T001 is S001 on T.
  const s = new Synth(5);
  s.part({ id: "Root" });
  const S = s.param("S", -180, 180, 0, { repeat: true });
  const T = s.param("T", -180, 180, 0);
  const bS = s.band([s.binding(S, [-180, 0, 180])]);
  const bT = s.band([s.binding(T, [-180, 0, 180])]);
  const kf = (o: number[]) => o.map((opacity) => ({ positions: TRIANGLE, opacity }));
  s.mesh({ id: "S001", band: bS, keyforms: kf([0, 0, 1]) });
  s.mesh({ id: "S010", band: bS, keyforms: kf([0, 1, 0]) });
  s.mesh({ id: "T001", band: bT, keyforms: kf([0, 0, 1]) });
  const model = loadMoc(s.build());
  // v, the segment's mesh (0: S001, 1: S010), t, T001's value.
  const rows: [number, 0 | 1, number, number][] = [
    [37.29999923706055, 0, 0.20722223818302155, 0.20722222328186035],
    [123.45600128173828, 0, 0.68586665391922, 0.68586665391922],
    [179.99000549316406, 0, 0.9999443888664246, 0.9999444484710693],
    [180, 1, 0, 1],
    [200, 1, 0.11111119389533997, 1],
    [-200, 0, 0.8888888955116272, 0],
    [541.7000122070312, 1, 0.00944468192756176, 1],
    [-540.25, 0, 0.9986112713813782, 0],
  ];
  for (const [v, mesh, t, control] of rows)
    it(`v = ${v}`, () => {
      const out = evaluateAll(model, { parameters: { [S]: v, [T]: v } });
      expect(out.opacity[mesh]).toBe(f(t));
      expect(out.opacity[2]).toBe(f(control));
    });
  it("v = 180: S001 reports 0 (the maximum wraps to the minimum)", () => {
    expect(evaluateAll(model, { parameters: { [S]: 180 } }).opacity[0]).toBe(0);
  });
});

describe("glue: the pair's float32 order, glues one after another", () => {
  it("a chain A–B–C, where B's vertex 0 is in both glues", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const P = s.param("P", 0, 1, 0);
    const band = s.band([s.binding(P, [0, 1])]);
    const A = s.mesh({
      id: "A",
      keyforms: [
        {
          positions: pts([
            [0.1, 0.2],
            [0.9, 0.15],
            [0.85, 0.8],
            [0.12, 0.75],
          ]),
        },
      ],
    });
    const B = s.mesh({
      id: "B",
      keyforms: [
        {
          positions: pts([
            [1.3, 0.1],
            [2.1, 0.3],
            [2.0, 0.9],
            [1.2, 0.85],
          ]),
        },
      ],
    });
    const C = s.mesh({
      id: "C",
      keyforms: [
        {
          positions: pts([
            [3.1, 0.05],
            [3.9, 0.2],
            [3.8, 1.0],
            [3.0, 0.9],
          ]),
        },
      ],
    });
    s.glue({
      id: "G1",
      band,
      a: A,
      b: B,
      pairs: [
        [1, f(0.37), 0, f(0.81)],
        [2, f(0.55), 3, f(0.23)],
      ],
      intensities: [f(0.33), f(0.91)],
    });
    s.glue({
      id: "G2",
      band,
      a: B,
      b: C,
      pairs: [
        [1, f(0.64), 0, f(0.29)],
        [0, f(0.18), 3, f(0.72)],
      ],
      intensities: [f(0.77), f(0.42)],
    });
    const out = evaluateAll(loadMoc(s.build()), { parameters: { [P]: f(0.6180339) } });
    expect(fileXY(out, A)).toEqual(
      pts([
        [0.1, 0.2],
        [1.0018919706344604, 0.13726350665092468],
        [0.9825285077095032, 0.8189326524734497],
        [0.12, 0.75],
      ]),
    );
    expect(fileXY(out, B)).toEqual(
      pts([
        [1.2685987949371338, 0.20483481884002686],
        [2.454360246658325, 0.21140989661216736],
        [2.0, 0.9],
        [1.1445790529251099, 0.8420827388763428],
      ]),
    );
    expect(fileXY(out, C)).toEqual(
      pts([
        [2.9394302368164062, 0.0901423916220665],
        [3.9, 0.2],
        [3.8, 1.0],
        [2.23336124420166, 0.5921911001205444],
      ]),
    );
  });

  it("a blend-shape target glue's intensity is clamped to [0, 1]", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const Q = s.param("Q", 0, 1, 0, { type: 1 });
    const GA = s.mesh({ id: "GA", keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
    const GB = s.mesh({ id: "GB", keyforms: [{ positions: [2, 0, 3, 0, 2, 1] }] });
    const g = s.glue({ id: "G", a: GA, b: GB, pairs: [[1, 0.5, 0, 0.5]], intensities: [0.5] });
    s.blendShape("glue", g, { param: Q, keys: [0, 1], base: 0, keyforms: [0, f(0.8)] });
    const model = loadMoc(s.build());
    for (const [q, ga, gb] of [
      [0.25, 1.350000023841858, 1.649999976158142],
      [f(0.6), 1.4900000095367432, 1.5099999904632568],
      [1, 1.5, 1.5],
    ]) {
      const out = evaluateAll(model, { parameters: { [Q]: q! } });
      expect([out.vertices[GA]![2], out.vertices[GB]![0]], `Q = ${q}`).toEqual([f(ga!), f(gb!)]);
    }
  });
});

describe("a blend shape's constraint weight between keys, in the weighted form", () => {
  it("opacity and screen green, with the base-segment rule", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const B = s.param("B", 0, 1, 0, { type: 1 });
    const C = s.param("C", 0, 1, 0);
    const zero = {
      positions: [0, 0, 0, 0, 0, 0],
      opacity: 0,
      drawOrder: 0,
      multiply: [0, 0, 0] as RGB,
      screen: [0, 0, 0] as RGB,
    };
    const m = s.mesh({
      id: "M",
      keyforms: [{ positions: TRIANGLE, opacity: f(0.1), multiply: [1, 1, 1], screen: [0, 0, 0] }],
    });
    s.blendShape("mesh", m, {
      param: B,
      keys: [0, 1],
      base: 0,
      keyforms: [zero, { ...zero, opacity: f(0.6), screen: [0, f(0.45), 0] }],
      constraints: [{ param: C, keys: [0, 1], weights: [f(0.9), f(0.35)] }],
    });
    const model = loadMoc(s.build());
    for (const [b, c, opacity, green] of [
      [f(0.3), f(0.42), 0.2204200029373169, 0.09031500667333603],
      [f(0.123457), f(0.0731), 0.16368862986564636, 0.04776647314429283],
      [f(0.8), f(0.6), 0.37359997630119324, 0.2051999717950821],
    ]) {
      const out = evaluateAll(model, { parameters: { [B]: b!, [C]: c! } });
      expect([out.opacity[0], out.screen[1]], `B = ${b}, C = ${c}`).toEqual([
        f(opacity!),
        f(green!),
      ]);
    }
  });
});

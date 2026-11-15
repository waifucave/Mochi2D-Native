/**
 * The rules of blend-shape evaluation, as unit tests with their vectors, on
 * synthetic `.moc3` files:
 *
 * - blend shapes: the interpolation rule, the range and snapping bounds,
 *   negative zero, constraints on blend-shape parameters and their weights,
 *   glue blend-shape targets, the opacity clamp of targets and the
 *   visibility rule;
 * - deformer targets: their clamps and the local values they act on,
 *   version 4 without clamps, non-finite opacities, the rule at the bit
 *   level for colors, rotation values and glue, and the accumulation order
 *   of two blend shapes.
 *
 * Every case runs with the WebAssembly and the JavaScript kernels, with and
 * without incremental evaluation; the results must be bit-identical. The
 * validation verdicts (rotation color indices, type-1 constraint
 * parameters, glue targets, non-finite opacities) are in moc-validate's
 * tests.
 */
import { describe, expect, it } from "vitest";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { locateBlendKeyAt } from "../src/core/eval/binding.js";
import { Synth, type Constraint, type MeshKeyform, type RGB } from "./support/synth.js";
import { evaluateAll, f32Step, same, type Output } from "./support/evaluate.js";

const fr = Math.fround;
const E4 = fr(1e-4); // 0.00009999999747378752
const zeros = (n: number) => new Array<number>(n).fill(0);
/** A blend-shape keyform with no contribution (deltas 0, colors included). */
const ZERO_COLORS = { multiply: [0, 0, 0] as RGB, screen: [0, 0, 0] as RGB };
const gray = (x: number): RGB => [x, x, x];

/** S2's weighted sum of two keyform values, and the lerp, for comparison. */
const s2 = (t: number, a: number, b: number) => fr(fr(fr(1 - t) * a) + fr(t * b));
const lerp = (t: number, a: number, b: number) => fr(a + fr(t * fr(b - a)));

// ================================================================= blend shapes

describe("blend-shape interpolation", () => {
  const UNEVEN = [-1.3, -0.4, 0, 0.6, 1.9].map(fr);

  /** A mesh whose normal keyform is all zeros, the target of one blend shape whose vertex 0 is (x, x). */
  function model(keys: number[], base: number, xs: number[]): { model: MocModel; bs: number } {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const bs = s.param("BS", -3, 3, 0, { type: 1 });
    const m = s.mesh({ id: "M", keyforms: [{ opacity: 1, positions: zeros(6) }] });
    s.blendShape("mesh", m, {
      param: bs,
      keys,
      base,
      keyforms: xs.map((x) => ({ opacity: 0, positions: [x, x, 0, 0, 0, 0], ...ZERO_COLORS })),
    });
    return { model: loadMoc(s.build()), bs };
  }

  // The vectors: keys, base index, the keyform values (base: 0), v, t, the
  // expected s, and S2 or the lerp where the table gives them.
  const ROWS: {
    what: string;
    keys: number[];
    base: number;
    xs: number[];
    v: number;
    t: number;
    s: number;
    s2?: number;
    lerp?: number;
  }[] = [
    {
      what: "−1, 0, 1 (base 0), segment −1…0",
      keys: [-1, 0, 1],
      base: 1,
      xs: [-5.700717449188232, 0, 3],
      v: -0.9543954730033875,
      t: 0.04560452699661255,
      s: -5.440739154815674,
      s2: -5.440739154815674,
      lerp: -5.440738677978516,
    },
    {
      what: "0, 1, 2 (base 0), segment 1…2",
      keys: [0, 1, 2],
      base: 0,
      xs: [0, 0.10112937539815903, 26.323307037353516],
      v: 1.0901148319244385,
      t: 0.09011483192443848,
      s: 2.4641366004943848,
      s2: 2.4641366004943848,
      lerp: 2.4641363620758057,
    },
    {
      what: "uneven, −1.3…−0.4",
      keys: UNEVEN,
      base: 2,
      xs: [-40.30952453613281, 22.288658142089844, 0, 45.95344543457031, 7],
      v: -0.626639187335968,
      t: 0.7481786608695984,
      s: 6.52509880065918,
      s2: 6.52509880065918,
      lerp: 6.5251007080078125,
    },
    {
      what: "uneven, −0.4…0",
      keys: UNEVEN,
      base: 2,
      xs: [-40.30952453613281, 22.288658142089844, 0, 45.95344543457031, 7],
      v: -0.24260346591472626,
      t: 0.39349135756492615,
      s: 13.51826286315918,
      s2: 13.51826286315918,
      lerp: 13.518263816833496,
    },
    {
      what: "uneven, 0…0.6 (t = 0.212)",
      keys: UNEVEN,
      base: 2,
      xs: [-40.30952453613281, 22.288658142089844, 0, 45.95344543457031, 7],
      v: 0.12742580473423004,
      t: 0.21237632632255554,
      s: 9.759425163269043,
      s2: 9.759424209594727,
      lerp: 9.759424209594727,
    },
    {
      what: "uneven, 0…0.6 (t = 0.463)",
      keys: UNEVEN,
      base: 2,
      xs: [-40.30952453613281, 22.288658142089844, 0, 45.95344543457031, 7],
      v: 0.2780880928039551,
      t: 0.463480144739151,
      s: 21.298507690429688,
      s2: 21.29850959777832,
      lerp: 21.29850959777832,
    },
  ];

  it("the six published vectors (positions; y negated by the output conversion)", () => {
    for (const r of ROWS) {
      const { model: m, bs } = model(r.keys.map(fr), r.base, r.xs.map(fr));
      const out = evaluateAll(m, { parameters: { [bs]: r.v } });
      expect(out.vertices[0]![0], r.what).toBe(r.s);
      expect(out.vertices[0]![1], r.what).toBe(-r.s);
    }
  });

  it("the table's t, and S2 and the lerp as the table gives them", () => {
    const li = new Int32Array(1);
    const lt = new Float32Array(1);
    for (const r of ROWS) {
      const keys = Float32Array.from(r.keys);
      locateBlendKeyAt(keys, fr(r.v), li, lt, 0);
      expect(lt[0], r.what).toBe(r.t);
      const i = li[0]!;
      const qi = i === r.base ? 0 : fr(r.xs[i]!);
      const qj = i + 1 === r.base ? 0 : fr(r.xs[i + 1]!);
      if (r.s2 !== undefined) expect(s2(r.t, qi, qj), r.what).toBe(r.s2);
      if (r.lerp !== undefined) expect(lerp(r.t, qi, qj), r.what).toBe(r.lerp);
    }
    // In the segment that starts at the base, the other keyform weighs f32(1 − f32(1 − t)).
    expect(fr(1 - fr(1 - 0.21237632632255554))).toBe(0.21237635612487793);
    expect(fr(1 - fr(1 - 0.463480144739151))).toBe(0.4634801149368286);
  });

  it("the same rule for opacity, and t = 0 reads the keyform itself", () => {
    // The opacity of a target is s itself here (normal opacity 0, clamped to [0, 1]).
    const s = new Synth(5);
    s.part({ id: "Root" });
    const bs = s.param("BS", -3, 3, 0, { type: 1 });
    const m = s.mesh({ id: "M", keyforms: [{ opacity: 0, positions: zeros(6) }] });
    s.blendShape("mesh", m, {
      param: bs,
      keys: UNEVEN,
      base: 2,
      keyforms: [0.3, 0.7, 0, 0.45953444, 0.9].map((o) => ({
        opacity: o,
        positions: zeros(6),
        ...ZERO_COLORS,
      })),
    });
    const model1 = loadMoc(s.build());
    const at = (v: number) => evaluateAll(model1, { parameters: { [bs]: v } }).opacity[0];
    const t = fr(fr(0.12742580473423004) / UNEVEN[3]!);
    expect(at(0.12742580473423004)).toBe(fr(fr(1 - fr(1 - t)) * fr(0.45953444)));
    expect(at(UNEVEN[3]!)).toBe(fr(0.45953444));
    expect(at(UNEVEN[1]!)).toBe(fr(0.7));
  });
});

describe("the range test is half-open, snapping is strict", () => {
  /** One parameter (k − 2 … k + 2) with d decimals; a mesh on `keys` whose vertex 0 has x = xs. */
  function model(k: number, d: number, keys: number[], xs: number[]) {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const p = s.param("P", k - 2, k + 2, k);
    const band = s.band([s.binding(p, keys)]);
    s.mesh({ id: "M", band, keyforms: xs.map((x) => ({ positions: [x, 0, 0, 10, 10, 0] })) });
    return { model: loadMoc(s.build({ tamper: (f) => void (f["parameter.decimals"] = [d]) })), p };
  }
  const run = (m: { model: MocModel; p: number }, v: number) =>
    evaluateAll(m.model, { parameters: { [m.p]: v } });

  it("the selected values: upper bound out, lower bound in", () => {
    // k, d, upper b, the last in-range value, lower b (in range), the first out-of-range value.
    const SELECTED: [number, number, number, number, number, number][] = [
      [1, 6, 1.0000009536743164, 1.0000008344650269, 0.9999989867210388, 0.999998927116394],
      [10, 6, 10.000000953674316, 10, 9.999999046325684, 9.999998092651367],
      [10, 7, 10, 9.999999046325684, 10, 9.999999046325684],
      [10, 3, 10.00100040435791, 10.000999450683594, 9.99899959564209, 9.998998641967773],
    ];
    for (const [k, d, upper, lastIn, lower, firstOut] of SELECTED) {
      const eps = fr(10 ** -d);
      expect(fr(k + eps)).toBe(upper);
      expect(fr(k - eps)).toBe(lower);
      const up = model(k, d, [k - 1, k], [0, 1]);
      const low = model(k, d, [k, k + 1], [0, 1]);
      const row = `k = ${k}, d = ${d}`;
      expect(run(up, upper).active[0], row).toBe(0);
      expect(run(up, lastIn).active[0], row).toBe(1);
      expect(run(low, lower).active[0], row).toBe(1);
      expect(run(low, firstOut).active[0], row).toBe(0);
    }
    // At d = 7 the last key 10 is itself out of range; the first key stays in.
    expect(run(model(10, 7, [9, 10], [0, 1]), 10).active[0]).toBe(0);
    expect(run(model(10, 7, [10, 11], [0, 1]), 10).active[0]).toBe(1);
  });

  it("the d = 6 question: f32(1 + 0.9·10⁻⁶) is the bound itself, so out of range", () => {
    expect(fr(1 + 0.9e-6)).toBe(fr(1 + fr(1e-6)));
    expect(run(model(1, 6, [0, 1], [0, 1]), fr(1 + 0.9e-6)).active[0]).toBe(0);
  });

  it("the rule's example at d = 3: keys −10 and 10", () => {
    const lo = fr(-10 - fr(0.001));
    const hi = fr(10 + fr(0.001));
    expect([lo, hi]).toEqual([-10.00100040435791, 10.00100040435791]);
    const s = new Synth(5);
    s.part({ id: "Root" });
    const p = s.param("P", -12, 12, 0);
    s.mesh({
      id: "M",
      band: s.band([s.binding(p, [-10, 10])]),
      keyforms: [0, 1].map((x) => ({ positions: [x, 0, 0, 10, 10, 0] })),
    });
    const wide = { model: loadMoc(s.build()), p };
    expect(run(wide, lo).active[0]).toBe(1);
    expect(run(wide, f32Step(lo, -1)).active[0]).toBe(0);
    expect(run(wide, hi).active[0]).toBe(0);
    expect(run(wide, f32Step(hi, -1)).active[0]).toBe(1);
  });

  it("56 rows of 9 values: k = 1 and 10, d = 1…7, four cases each", () => {
    for (const k of [1, 10])
      for (let d = 1; d <= 7; d++) {
        const eps = fr(10 ** -d);
        const up = model(k, d, [k - 1, k], [0, 1]);
        const low = model(k, d, [k, k + 1], [0, 1]);
        const snap = model(k, d, [k - 1, k, k + 1], [-100, 0, 100]);
        const snapped = (v: number) => fr(k - eps) < v && v < fr(k + eps);
        // x of vertex 0 on keys k − 1, k, k + 1 (x −100, 0, 100), by the rules.
        const expectedX = (v: number) => {
          if (snapped(v)) return 0;
          if (v < k) return s2(fr(fr(v - (k - 1)) / 1), -100, 0);
          return s2(fr(fr(v - k) / 1), 0, 100);
        };
        for (let j = -4; j <= 4; j++) {
          const row = `k = ${k}, d = ${d}, step ${j}`;
          const vu = f32Step(fr(k + eps), j);
          expect(run(up, vu).active[0], `upper, ${row}`).toBe(vu < fr(k + eps) ? 1 : 0);
          const vl = f32Step(fr(k - eps), j);
          expect(run(low, vl).active[0], `lower, ${row}`).toBe(vl >= fr(k - eps) ? 1 : 0);
          for (const [what, v] of [
            ["snap above", vu],
            ["snap below", vl],
          ] as const) {
            const out = run(snap, v);
            expect(out.active[0], `${what}, ${row}`).toBe(1);
            expect(out.vertices[0]![0], `${what}, ${row}`).toBe(expectedX(v));
          }
        }
      }
  });
});

describe("every evaluated zero is +0, then y is negated", () => {
  /** Eight meshes whose selected keyform stores vertex 0 = (−0, −0), vertex 1 = (+0, +0) and opacity −0. */
  function model(flags: number) {
    const s = new Synth(5);
    s.canvas = { ...s.canvas, flags };
    s.part({ id: "Root" });
    const Z: MeshKeyform = { opacity: -0, positions: [-0, -0, 0, 0, 5, 5] };
    const other: MeshKeyform = { opacity: 0.5, positions: [3, 3, 4, 4, 5, 5] };
    const pose: Record<number, number> = {};
    const param = (id: string, max: number, value: number, type = 0) => {
      const p = s.param(id, 0, max, 0, { type });
      pose[p] = value;
      return p;
    };
    // 1. no binding
    s.mesh({ id: "M1", keyforms: [Z] });
    // 2. one binding, at its first key
    s.mesh({
      id: "M2",
      band: s.band([s.binding(param("P2", 1, 0), [0, 1])]),
      keyforms: [Z, other],
    });
    // 3. one binding, at its last key
    s.mesh({
      id: "M3",
      band: s.band([s.binding(param("P3", 1, 1), [0, 1])]),
      keyforms: [other, Z],
    });
    // 4. two bindings, both on keys (keyform 0 + 2·1)
    const band4 = s.band([
      s.binding(param("P4a", 1, 0), [0, 1]),
      s.binding(param("P4b", 1, 1), [0, 1]),
    ]);
    s.mesh({ id: "M4", band: band4, keyforms: [other, other, Z, other] });
    // 5. the middle key of three
    s.mesh({
      id: "M5",
      band: s.band([s.binding(param("P5", 2, 1), [0, 1, 2])]),
      keyforms: [other, Z, other],
    });
    // 6–8. no binding, plus a blend shape: at its base key; at key 1 with +0 deltas; with −0 deltas.
    const deltas = (z: number): MeshKeyform => ({
      opacity: z,
      positions: [z, z, z, z, z, z],
      multiply: [z, z, z],
      screen: [z, z, z],
    });
    for (const [id, value, delta] of [
      ["M6", 0, deltas(1)],
      ["M7", 1, deltas(0)],
      ["M8", 1, deltas(-0)],
    ] as const) {
      const m = s.mesh({ id, keyforms: [Z] });
      s.blendShape("mesh", m, {
        param: param(`BS${id}`, 1, value, 1),
        keys: [0, 1],
        base: 0,
        keyforms: [deltas(7), delta], // the base keyform is never read
      });
    }
    return { model: loadMoc(s.build()), pose };
  }

  it("default conversion: x = +0, y = −0, opacity +0, in all eight cases", () => {
    const { model: m, pose } = model(0);
    const out = evaluateAll(m, { parameters: pose });
    for (let i = 0; i < 8; i++) {
      expect(out.active[i]).toBe(1);
      expect(same(out.vertices[i]!.slice(0, 4), [0, -0, 0, -0]), `M${i + 1}`).toBe(true);
      expect(Object.is(out.opacity[i], 0), `M${i + 1}`).toBe(true);
      expect(out.visible[i]).toBe(0);
    }
  });

  it("canvas flag bit 0 set: every zero is +0", () => {
    const { model: m, pose } = model(1);
    const out = evaluateAll(m, { parameters: pose });
    for (let i = 0; i < 8; i++)
      expect(same(out.vertices[i]!.slice(0, 4), [0, 0, 0, 0]), `M${i + 1}`).toBe(true);
  });
});

describe("constraints and their weights", () => {
  /**
   * BS1 and BS2 are blend-shape parameters (type 1), N a normal one, all 0…1.
   * Each mesh has one blend shape on BS1 (keys 0 = base, 1) whose key-1
   * keyform moves vertex 0 by x = +10 and adds opacity 0.5, with the given
   * constraints. Normal keyform: vertex 0 at x = 0, opacity 0.
   */
  function model(cases: ((p: { bs1: number; bs2: number; n: number }) => Constraint[])[]) {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const p = {
      bs1: s.param("BS1", 0, 1, 0, { type: 1 }),
      bs2: s.param("BS2", 0, 1, 0, { type: 1 }),
      n: s.param("N", 0, 1, 0),
    };
    cases.forEach((constraints, i) => {
      const m = s.mesh({ id: `M${i}`, keyforms: [{ opacity: 0, positions: zeros(6) }] });
      s.blendShape("mesh", m, {
        param: p.bs1,
        keys: [0, 1],
        base: 0,
        keyforms: [
          { opacity: 0, positions: zeros(6), ...ZERO_COLORS },
          { opacity: 0.5, positions: [10, 0, 0, 0, 0, 0], ...ZERO_COLORS },
        ],
        constraints: constraints(p),
      });
    });
    return { model: loadMoc(s.build()), p };
  }
  const fall = (param: number): Constraint => ({ param, keys: [0, 1], weights: [1, 0] });
  const constant = (param: number, c: number): Constraint => ({
    param,
    keys: [0, 1],
    weights: [c, c],
  });

  it("constraint parameters of type 1, the blend shape's own one included", () => {
    const { model: m, p } = model([
      () => [],
      (q) => [fall(q.n)],
      (q) => [fall(q.bs2)],
      (q) => [fall(q.bs1)],
    ]);
    // (BS1, BS2, N) → x of vertex 0 for: none, N, BS2, BS1.
    const TABLE: [[number, number, number], number[]][] = [
      [
        [1, 0, 0],
        [10, 10, 10, 0],
      ],
      [
        [1, 0.5, 0.25],
        [10, 7.5, 5, 0],
      ],
      [
        [1, 1, 0.75],
        [10, 2.5, 0, 0],
      ],
      [
        [0.5, 0.25, 0.5],
        [5, 2.5, 3.75, 2.5],
      ],
    ];
    for (const [[b1, b2, n], xs] of TABLE) {
      const out = evaluateAll(m, { parameters: { [p.bs1]: b1, [p.bs2]: b2, [p.n]: n } });
      expect(
        out.vertices.map((v) => v[0]),
        `(${b1}, ${b2}, ${n})`,
      ).toEqual(xs);
    }
  });

  it("w = min(1, c₁, …, c_m); negative weights are used as stored", () => {
    const { model: m, p } = model([
      (q) => [constant(q.n, 1.5)],
      (q) => [constant(q.bs2, 1.5)],
      (q) => [{ param: q.n, keys: [0, 1], weights: [0, 2] }],
      (q) => [constant(q.n, -0.5)],
      (q) => [constant(q.n, 1.5), constant(q.bs2, 0.8)],
      (q) => [constant(q.n, -0.5), constant(q.bs2, 0.8)],
    ]);
    // The rows that hold at every value of the other parameters.
    for (const b2 of [0, 0.5, 1])
      for (const n of [0, 0.5, 1]) {
        const out = evaluateAll(m, { parameters: { [p.bs1]: 1, [p.bs2]: b2, [p.n]: n } });
        const row = `BS2 = ${b2}, N = ${n}`;
        expect(out.vertices[0]![0], row).toBe(10);
        expect(out.vertices[1]![0], row).toBe(10);
        expect(out.vertices[3]![0], row).toBe(-5);
        expect(out.vertices[4]![0], row).toBe(8);
        expect(out.vertices[5]![0], row).toBe(-5);
        // Opacity: a target's opacity is clamped, so −0.25 is reported as 0.
        expect(out.opacity[3], row).toBe(0);
        expect(out.opacity[4], row).toBe(0.4000000059604645); // f32(f32(0.8)·0.5)
        expect(out.opacity[5], row).toBe(0);
      }
    // N: 0 → 0, 1 → 2.
    const at = (n: number) =>
      evaluateAll(m, { parameters: { [p.bs1]: 1, [p.n]: n } }).vertices[2]![0];
    expect(at(0.25)).toBe(5);
    expect(at(0.75)).toBe(10);
  });
});

describe("glue blend-shape targets", () => {
  type Row = {
    what: string;
    intensities: number[]; // one, or two bound to N on keys 0 and 1
    delta: number | null; // the blend shape's key-1 intensity, or none
    I: [number, number, number]; // at GB = 0, 0.5, 1 (N = 0)
    extra?: [gb: number, n: number, I: number][];
  };
  const ROWS: Row[] = [
    { what: "0.5, no blend shape", intensities: [0.5], delta: null, I: [0.5, 0.5, 0.5] },
    { what: "0.5, +0.3", intensities: [0.5], delta: 0.3, I: [0.5, 0.65, 0.8] },
    { what: "0.5, −0.5", intensities: [0.5], delta: -0.5, I: [0.5, 0.25, 0] },
    { what: "0.5, +0.8", intensities: [0.5], delta: 0.8, I: [0.5, 0.9, 1] },
    { what: "0.5, −0.8", intensities: [0.5], delta: -0.8, I: [0.5, 0.1, 0] },
    {
      what: "bound to N (0.2 / 0.6), +0.3",
      intensities: [0.2, 0.6],
      delta: 0.3,
      I: [0.2, 0.35, 0.5],
      extra: [
        [1, 0.5, 0.7],
        [0, 1, 0.6],
      ],
    },
    { what: "1.5, no blend shape", intensities: [1.5], delta: null, I: [1.5, 1.5, 1.5] },
    { what: "−0.5, no blend shape", intensities: [-0.5], delta: null, I: [-0.5, -0.5, -0.5] },
    {
      what: "bound to N (0.5 / 1.5), no blend shape",
      intensities: [0.5, 1.5],
      delta: null,
      I: [0.5, 0.5, 0.5],
      extra: [
        [0, 0.5, 1],
        [0, 1, 1.5],
      ],
    },
    { what: "1.5, delta 0", intensities: [1.5], delta: 0, I: [1, 1, 1] },
    { what: "−0.5, delta 0", intensities: [-0.5], delta: 0, I: [0, 0, 0] },
    { what: "1.5, −0.3", intensities: [1.5], delta: -0.3, I: [1, 1, 1] },
  ];

  /** Per row, meshes A (vertex 0 at x = 0) and B (at x = 10), glued 0–0 with weights 0.5 / 0.5. */
  function model() {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const gb = s.param("GB", 0, 1, 0, { type: 1 });
    const n = s.param("N", 0, 1, 0);
    const byN = s.band([s.binding(n, [0, 1])]);
    ROWS.forEach((r, i) => {
      const a = s.mesh({ id: `A${i}`, keyforms: [{ positions: [0, 0, 0, 1, 1, 0] }] });
      const b = s.mesh({ id: `B${i}`, keyforms: [{ positions: [10, 0, 10, 1, 11, 0] }] });
      const g = s.glue({
        id: `G${i}`,
        a,
        b,
        pairs: [[0, 0.5, 0, 0.5]],
        intensities: r.intensities,
        ...(r.intensities.length > 1 ? { band: byN } : {}),
      });
      if (r.delta !== null)
        s.blendShape("glue", g, { param: gb, keys: [0, 1], base: 0, keyforms: [0, r.delta] });
    });
    return { model: loadMoc(s.build()), gb, n };
  }

  it("I = clamp(I_normal + Σ w·s, 0, 1) for targets; other glues are not clamped", () => {
    const { model: m, gb, n } = model();
    const check = (out: Output, i: number, I: number, what: string) => {
      const A0 = out.vertices[2 * i]![0]!;
      const B0 = out.vertices[2 * i + 1]![0]!;
      expect(A0 / 5, what).toBeCloseTo(I, 6);
      expect((10 - B0) / 5, what).toBeCloseTo(I, 6);
    };
    for (const [j, value] of [0, 0.5, 1].entries()) {
      const out = evaluateAll(m, { parameters: { [gb]: value } });
      ROWS.forEach((r, i) => check(out, i, r.I[j]!, `${r.what}, GB = ${value}`));
    }
    ROWS.forEach((r, i) => {
      for (const [g, v, I] of r.extra ?? [])
        check(
          evaluateAll(m, { parameters: { [gb]: g, [n]: v } }),
          i,
          I,
          `${r.what}, GB = ${g}, N = ${v}`,
        );
    });
  });

  it("at 1.5 the vertices overshoot and swap sides; at −0.5 they move apart", () => {
    const { model: m } = model();
    const out = evaluateAll(m);
    expect([out.vertices[12]![0], out.vertices[13]![0]]).toEqual([7.5, 2.5]); // row 6: 1.5
    expect([out.vertices[14]![0], out.vertices[15]![0]]).toEqual([-2.5, 12.5]); // row 7: −0.5
  });
});

describe("the opacity clamp of mesh targets, and visibility", () => {
  it("a target's own opacity is clamped to [0, 1], before the part factor", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const part = s.part({ id: "P", parent: 0 });
    const bs = s.param("BS", 0, 1, 0, { type: 1 });
    const stored = [1.5, 0.8, -0.5];
    for (const target of [false, true])
      for (const o of stored) {
        const m = s.mesh({
          id: `M${o}${target}`,
          part,
          keyforms: [{ opacity: o, positions: zeros(6) }],
        });
        if (target)
          s.blendShape("mesh", m, {
            param: bs,
            keys: [0, 1],
            base: 0,
            keyforms: [0, 1].map(() => ({ opacity: 0, positions: zeros(6), ...ZERO_COLORS })),
          });
      }
    const model1 = loadMoc(s.build());
    // [not a target: part opacity 1, 0.5], [target: 1, 0.5]
    const TABLE: [number, number][][] = [
      [
        [1.5, 0.75],
        [0.800000011920929, 0.4000000059604645],
        [-0.5, -0.25],
      ],
      [
        [1, 0.5],
        [0.800000011920929, 0.4000000059604645],
        [0, 0],
      ],
    ];
    for (const [j, partOpacity] of [1, 0.5].entries()) {
      const out = evaluateAll(model1, { parts: { [part]: partOpacity } });
      for (const target of [0, 1])
        for (let k = 0; k < 3; k++) {
          const d = 3 * target + k;
          const what = `stored ${stored[k]}, target ${target}, part ${partOpacity}`;
          expect(out.opacity[d], what).toBe(TABLE[target]![k]![j]);
          expect(out.visible[d], what).toBe(TABLE[target]![k]![j] !== 0 ? 1 : 0);
        }
    }
  });

  it("visible ⇔ active and opacity ≠ 0, so negative opacities are visible", () => {
    const OPACITIES = [0, -0, 1e-7, -1e-7, -0.5, -2, 0.5, 1.5, 3e38, -3e38];
    const s = new Synth(5);
    s.part({ id: "Root" });
    OPACITIES.forEach((o, i) =>
      s.mesh({ id: `M${i}`, keyforms: [{ opacity: o, positions: zeros(6) }] }),
    );
    const out = evaluateAll(loadMoc(s.build()));
    OPACITIES.forEach((o, i) => {
      expect(Object.is(out.opacity[i], o === 0 ? 0 : fr(o)), `${o}`).toBe(true);
      expect(out.visible[i], `${o}`).toBe(o === 0 ? 0 : 1);
    });
    expect(out.opacity[2]).toBe(1.0000000116860974e-7);
    expect(out.opacity[3]).toBe(-1.0000000116860974e-7);
  });
});

// ============================================================= deformer targets

/** A child mesh's vertices inside a 1×1 warp's unit square. */
const INSIDE = [0.25, 0.25, 0.75, 0.25, 0.25, 0.75];
const UNIT_GRID = [0, 0, 1, 0, 0, 1, 1, 1];

interface Values {
  opacity?: number;
  multiply?: RGB;
  screen?: RGB;
}

/** A deformer's normal keyform, or a blend-shape keyform of deltas (zeros by default). */
function deformerKeyform(kind: "warp" | "rotation", v: Values, delta: boolean) {
  const colors = {
    multiply: v.multiply ?? gray(delta ? 0 : 1),
    screen: v.screen ?? gray(0),
  };
  const opacity = v.opacity ?? (delta ? 0 : 1);
  return kind === "warp"
    ? { opacity, points: delta ? zeros(8) : UNIT_GRID, ...colors }
    : { opacity, angle: 0, x: 0, y: 0, scale: delta ? 0 : 1, ...colors };
}

describe("deformer targets are clamped (opacity and colors)", () => {
  type Row = {
    what: string;
    values: Values;
    target: boolean;
    delta?: Values;
    // The child's opacity, multiply and screen at BS = 0, 0.5, 1 (null: not checked).
    opacity: (number | null)[];
    colors?: [number, number][];
  };
  const ROWS: Row[] = [
    { what: "opacity 1.5", values: { opacity: 1.5 }, target: false, opacity: [1.5, 1.5, 1.5] },
    { what: "opacity −0.5", values: { opacity: -0.5 }, target: false, opacity: [-0.5, -0.5, -0.5] },
    { what: "opacity 1.5, target", values: { opacity: 1.5 }, target: true, opacity: [1, 1, 1] },
    { what: "opacity −0.5, target", values: { opacity: -0.5 }, target: true, opacity: [0, 0, 0] },
    {
      what: "opacity 0.7, target",
      values: { opacity: 0.7 },
      target: true,
      opacity: [0.699999988079071, 0.699999988079071, 0.699999988079071],
    },
    {
      what: "opacity 0.5, delta +0.8",
      values: { opacity: 0.5 },
      target: true,
      delta: { opacity: 0.8 },
      opacity: [0.5, 0.8999999761581421, 1],
    },
    {
      what: "opacity 0.5, delta −0.8",
      values: { opacity: 0.5 },
      target: true,
      delta: { opacity: -0.8 },
      opacity: [0.5, 0.09999999403953552, 0],
    },
    {
      what: "multiply 1.5, screen −0.5",
      values: { multiply: gray(1.5), screen: gray(-0.5) },
      target: false,
      opacity: [1, 1, 1],
      colors: [
        [0.75, 0.25],
        [0.75, 0.25],
        [0.75, 0.25],
      ],
    },
    {
      what: "multiply 1.5, screen −0.5, target",
      values: { multiply: gray(1.5), screen: gray(-0.5) },
      target: true,
      opacity: [1, 1, 1],
      colors: [
        [0.5, 0.5],
        [0.5, 0.5],
        [0.5, 0.5],
      ],
    },
    {
      what: "multiply 0.5, screen 0.5, deltas +0.8 and −0.8",
      values: { multiply: gray(0.5), screen: gray(0.5) },
      target: true,
      delta: { multiply: gray(0.8), screen: gray(-0.8) },
      opacity: [1, 1, 1],
      colors: [
        [0.25, 0.75],
        [0.44999998807907104, 0.550000011920929],
        [0.5, 0.5],
      ],
    },
  ];

  for (const kind of ["warp", "rotation"] as const)
    it(`root-level ${kind}s, read through a child mesh (opacity 1, multiply 0.5, screen 0.5)`, () => {
      const s = new Synth(5);
      s.part({ id: "Root" });
      const bs = s.param("BS", 0, 1, 0, { type: 1 });
      ROWS.forEach((r, i) => {
        const kf = deformerKeyform(kind, r.values, false);
        const d =
          kind === "warp"
            ? s.warp({ id: `D${i}`, rows: 1, cols: 1, keyforms: [kf as never] })
            : s.rotation({ id: `D${i}`, keyforms: [kf as never] });
        s.mesh({
          id: `C${i}`,
          deformer: d,
          keyforms: [{ opacity: 1, positions: INSIDE, multiply: gray(0.5), screen: gray(0.5) }],
        });
        if (r.target)
          s.blendShape(kind, d, {
            param: bs,
            keys: [0, 1],
            base: 0,
            keyforms: [deformerKeyform(kind, {}, true), deformerKeyform(kind, r.delta ?? {}, true)],
          });
      });
      const model1 = loadMoc(s.build());
      for (const [j, value] of [0, 0.5, 1].entries()) {
        const out = evaluateAll(model1, { parameters: { [bs]: value } });
        ROWS.forEach((r, i) => {
          const what = `${kind}: ${r.what}, BS = ${value}`;
          expect(out.opacity[i], what).toBe(r.opacity[j]);
          expect(out.visible[i], what).toBe(r.opacity[j] !== 0 ? 1 : 0);
          if (r.colors) {
            for (let ch = 0; ch < 3; ch++) {
              expect(out.multiply[3 * i + ch], what).toBe(r.colors[j]![0]);
              expect(out.screen[3 * i + ch], what).toBe(r.colors[j]![1]);
            }
          }
        });
      }
    });

  it("an art-mesh target under a rotation that is not one (multiply 0.5, screen 0.5, opacity 0.5)", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const bs = s.param("BS", 0, 1, 0, { type: 1 });
    const rot = s.rotation({
      id: "R",
      keyforms: [
        { opacity: 0.5, angle: 0, x: 0, y: 0, scale: 1, multiply: gray(0.5), screen: gray(0.5) },
      ],
    });
    for (const target of [false, true]) {
      const m = s.mesh({
        id: `M${target}`,
        deformer: rot,
        keyforms: [{ opacity: 1.5, positions: INSIDE, multiply: gray(1.5), screen: gray(-0.5) }],
      });
      if (target)
        s.blendShape("mesh", m, {
          param: bs,
          keys: [0, 1],
          base: 0,
          keyforms: [0, 1].map(() => ({ opacity: 0, positions: zeros(6), ...ZERO_COLORS })),
        });
    }
    const out = evaluateAll(loadMoc(s.build()));
    expect([out.multiply[0], out.screen[0], out.opacity[0]]).toEqual([0.75, 0.25, 0.75]);
    expect([out.multiply[3], out.screen[3], out.opacity[1]]).toEqual([0.5, 0.5, 0.5]);
  });
});

/**
 * Root-level rotations, each with a child mesh whose vertex 0 is `vertex`
 * (in the rotation's input space). A spec with `delta` (or `target`) is the
 * target of one blend shape on BS (keys 0 = base, 1).
 */
interface RotationSpec {
  angle?: number;
  scale?: number;
  x?: number;
  y?: number;
  baseAngle?: number;
  target?: boolean;
  delta?: { angle?: number; scale?: number; x?: number; y?: number };
}
function rotations(specs: RotationSpec[], vertex: [number, number] = [1, 0]) {
  const s = new Synth(5);
  s.part({ id: "Root" });
  const bs = s.param("BS", 0, 1, 0, { type: 1 });
  specs.forEach((r, i) => {
    const d = s.rotation({
      id: `R${i}`,
      baseAngle: r.baseAngle ?? 0,
      keyforms: [{ angle: r.angle ?? 0, x: r.x ?? 0, y: r.y ?? 0, scale: r.scale ?? 1 }],
    });
    s.mesh({ id: `C${i}`, deformer: d, keyforms: [{ positions: [...vertex, 0, 1, 1, 0] }] });
    if (r.target || r.delta)
      s.blendShape("rotation", d, {
        param: bs,
        keys: [0, 1],
        base: 0,
        keyforms: [
          { opacity: 0, angle: 0, x: 0, y: 0, scale: 0, ...ZERO_COLORS },
          {
            opacity: 0,
            angle: r.delta?.angle ?? 0,
            x: r.delta?.x ?? 0,
            y: r.delta?.y ?? 0,
            scale: r.delta?.scale ?? 0,
            ...ZERO_COLORS,
          },
        ],
      });
  });
  return { model: loadMoc(s.build()), bs };
}
/** The direction of a reported vertex, in degrees within [0, 360) (y is negated back). */
const direction = (v: number[]) => {
  const a = (Math.atan2(-v[1]!, v[0]!) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
};

describe("rotation targets (scale and angle)", () => {
  it("the scale table: child vertex (1, 0) reports x = the scale", () => {
    // stored, delta or null for a non-target, then [BS, x] pairs.
    const ROWS: [number, number | null, [number, number][]][] = [
      [-2, null, [[1, -2]]],
      [-2, 0, [[1, E4]]],
      [0, 0, [[1, E4]]],
      [
        1,
        -3,
        [
          [0.5, E4],
          [1, E4],
        ],
      ],
      [
        1,
        1e6,
        [
          [0.5, 100],
          [1, 100],
        ],
      ],
      [1e6, 0, [[1, 100]]],
      [1e30, 0, [[1, 100]]],
      [1e30, null, [[1, 1.0000000150474662e30]]],
    ];
    const { model: m, bs } = rotations(
      ROWS.map(([scale, delta]) =>
        delta === null ? { scale } : { scale, delta: { scale: delta } },
      ),
    );
    for (const value of [0.5, 1]) {
      const out = evaluateAll(m, { parameters: { [bs]: value } });
      ROWS.forEach(([scale, delta, pairs], i) => {
        for (const [v, x] of pairs)
          if (v === value) expect(out.vertices[i]![0], `${scale}, delta ${delta}`).toBe(x);
      });
    }
  });

  it("the exact scale bounds, f32(10⁻⁴) and 100, against non-target twins", () => {
    const low = [fr(1e-5), f32Step(E4, -1), f32Step(E4, -2)];
    const kept = [
      E4,
      f32Step(E4, 1),
      f32Step(E4, 2),
      1e-3,
      0.5,
      2,
      50,
      f32Step(100, -1),
      f32Step(100, -2),
      100,
    ].map(fr);
    const high = [100.00000762939453, 100.00001525878906, 1000];
    expect(f32Step(100, 1)).toBe(high[0]);
    const all = [...low, ...kept, ...high];
    const { model: m, bs } = rotations(
      all.flatMap((scale) => [{ scale, target: true }, { scale }]),
    );
    const out = evaluateAll(m, { parameters: { [bs]: 1 } });
    all.forEach((scale, i) => {
      const expected = i < low.length ? E4 : i < low.length + kept.length ? scale : 100;
      expect(out.vertices[2 * i]![0], `target ${scale}`).toBe(expected);
      expect(out.vertices[2 * i + 1]![0], `twin ${scale}`).toBe(scale);
    });
  });

  it("the angle: clamped to ±3600, else as stored (child vertex (1000, 0), twins)", () => {
    // [target spec, the non-target angle it must equal bit for bit, BS]
    const PAIRS: [RotationSpec, number, number][] = [
      [{ angle: 400, target: true }, 400, 1],
      [{ angle: -400, target: true }, -400, 1],
      [{ delta: { angle: 400 } }, 200, 0.5],
      [{ delta: { angle: 400 } }, 400, 1],
    ];
    for (const sign of [1, -1]) {
      for (const a of [3599, f32Step(3600, -1), 3600])
        PAIRS.push([{ angle: sign * a, target: true }, sign * a, 1]);
      for (const a of [f32Step(3600, 1), 3601, 3700, 7200, 1e6, 3e7])
        PAIRS.push([{ angle: sign * a, target: true }, sign * 3600, 1]);
    }
    expect(f32Step(3600, 1)).toBe(3600.000244140625);
    for (const [spec, twin, value] of PAIRS) {
      const { model: m, bs } = rotations([spec, { angle: twin }], [1000, 0]);
      const out = evaluateAll(m, { parameters: { [bs]: value } });
      const what = `${JSON.stringify(spec)} at BS = ${value} vs ${twin}`;
      expect(same(out.vertices[0], out.vertices[1]), what).toBe(true);
    }
    // A non-target at 10⁶ points like 280°, a target like 3600° (0°).
    const { model: m } = rotations([{ angle: 1e6 }, { angle: 1e6, target: true }], [1000, 0]);
    const out = evaluateAll(m);
    expect(direction(out.vertices[0]!)).toBeCloseTo(280, 1);
    const d = direction(out.vertices[1]!);
    expect(Math.min(d, 360 - d)).toBeLessThan(0.01);
  });

  it("not clamped: rotation origins, warp grids and art-mesh vertices", () => {
    const origins: [number, number][] = [
      [1e7, 0],
      [-1e9, 0],
      [1e30, 0],
      [-1e5, 1e5],
    ];
    const { model: m } = rotations(
      origins.flatMap(([x, y]) => [
        { x, y, target: true },
        { x, y },
      ]),
    );
    const out = evaluateAll(m, { parameters: { 0: 1 } });
    origins.forEach((o, i) =>
      expect(same(out.vertices[2 * i], out.vertices[2 * i + 1]), `origin ${o}`).toBe(true),
    );
    // Warps with large sides, and meshes with large vertices.
    const s = new Synth(5);
    s.part({ id: "Root" });
    const bs = s.param("BS", 0, 1, 1, { type: 1 });
    for (const L of [4e6, 1e9, 1e30])
      for (const target of [true, false]) {
        const w = s.warp({
          id: `W${L}${target}`,
          rows: 1,
          cols: 1,
          keyforms: [{ points: [0, 0, L, 0, 0, L, L, L] }],
        });
        s.mesh({ id: `C${L}${target}`, deformer: w, keyforms: [{ positions: INSIDE }] });
        if (target)
          s.blendShape("warp", w, {
            param: bs,
            keys: [0, 1],
            base: 0,
            keyforms: [0, 1].map(() => deformerKeyform("warp", {}, true)),
          });
      }
    for (const X of [1e9, 1e30])
      for (const target of [true, false]) {
        const m2 = s.mesh({
          id: `M${X}${target}`,
          keyforms: [{ positions: [X, X, -X, X, X, -X] }],
        });
        if (target)
          s.blendShape("mesh", m2, {
            param: bs,
            keys: [0, 1],
            base: 0,
            keyforms: [0, 1].map(() => ({ opacity: 0, positions: zeros(6), ...ZERO_COLORS })),
          });
      }
    const out2 = evaluateAll(loadMoc(s.build()));
    for (let i = 0; i < 5; i++)
      expect(same(out2.vertices[2 * i], out2.vertices[2 * i + 1]), `pair ${i}`).toBe(true);
    expect(out2.vertices[6]![0]).toBe(1e9);
    expect(out2.vertices[8]![0]).toBe(fr(1e30));
  });
});

describe("draw orders of targets are capped at 1000", () => {
  const TRI = [1, 0, -0.5, 0.866, -0.5, -0.866];

  it("art meshes: stored 999.5, 1000.5, 1500 and 10⁶", () => {
    const STORED = [999.5, 1000.5, 1500, 1e6];
    const s = new Synth(5);
    s.part({ id: "Root" });
    const bs = s.param("BS", 0, 1, 0, { type: 1 });
    for (const target of [false, true])
      for (const D of STORED) {
        const m = s.mesh({ id: `M${D}${target}`, keyforms: [{ positions: TRI, drawOrder: D }] });
        if (target)
          s.blendShape("mesh", m, {
            param: bs,
            keys: [0, 1],
            base: 0,
            keyforms: [0, 1].map(() => ({
              opacity: 0,
              positions: zeros(6),
              drawOrder: 0,
              ...ZERO_COLORS,
            })),
          });
      }
    const out = evaluateAll(loadMoc(s.build()));
    expect(out.drawOrder).toEqual([999, 1000, 1500, 1e6, 999, 1000, 1000, 1000]);
  });

  it("parts at 1500 and 10⁶ sort at 1000 when they are targets (probe meshes)", () => {
    const s = new Synth(5);
    const root = s.part({ id: "Root" });
    const bs = s.param("BS", 0, 1, 1, { type: 1 });
    const PROBES = [999, 1001, 1499, 1501, 999999, 1000001];
    const probes = PROBES.map((D) =>
      s.mesh({ id: `Probe${D}`, keyforms: [{ positions: TRI, drawOrder: D }] }),
    );
    const objects: { kind: 0 | 1; index: number; nested?: number }[] = probes.map((index) => ({
      kind: 0,
      index,
    }));
    const nested: { objects: { kind: 0; index: number }[]; min: number; max: number }[] = [];
    const PARTS: [number, boolean][] = [
      [1500, true],
      [1e6, true],
      [1500, false],
      [1e6, false],
    ];
    const parts: number[] = [];
    const children: number[] = [];
    PARTS.forEach(([D, target], i) => {
      const p = s.part({ id: `P${i}`, parent: root, keyforms: [{ drawOrder: D }] });
      if (target)
        s.blendShape("part", p, {
          param: bs,
          keys: [0, 1],
          base: 0,
          keyforms: [{ drawOrder: 0 }, { drawOrder: 0 }],
        });
      const m = s.mesh({ id: `C${i}`, part: p, keyforms: [{ positions: TRI }] });
      parts.push(p);
      children.push(m);
      nested.push({ objects: [{ kind: 0, index: m }], min: 0, max: 1000 });
      objects.push({ kind: 1, index: p, nested: nested.length });
    });
    s.groups = [{ objects, min: 0, max: 1000 }, ...nested];
    const out = evaluateAll(loadMoc(s.build()));
    expect(parts.map((p) => out.partDrawOrder[p])).toEqual([1000, 1000, 1500, 1e6]);
    const ro = (d: number) => out.renderOrder[d]!;
    const between = (d: number, lo: number, hi: number) =>
      ro(probes[PROBES.indexOf(lo)]!) < ro(d) && ro(d) < ro(probes[PROBES.indexOf(hi)]!);
    expect(between(children[0]!, 999, 1001)).toBe(true);
    expect(between(children[1]!, 999, 1001)).toBe(true);
    expect(between(children[2]!, 1499, 1501)).toBe(true);
    expect(between(children[3]!, 999999, 1000001)).toBe(true);
  });
});

describe("the clamp acts on the local value", () => {
  /** A parent rotation P with a child rotation R (or warp W) whose child mesh has vertex 0 at `vertex`. */
  function nested(
    parent: { angle?: number; scale?: number; opacity?: number; multiply?: RGB; screen?: RGB },
    child:
      | { kind: "rotation"; angle?: number; scale?: number; baseAngle?: number }
      | { kind: "warp"; opacity?: number; multiply?: RGB; screen?: RGB },
    target: boolean,
    vertex: [number, number],
    mesh: { multiply?: RGB; screen?: RGB } = {},
  ): Output {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const bs = s.param("BS", 0, 1, 1, { type: 1 });
    const p = s.rotation({
      id: "P",
      keyforms: [
        {
          opacity: parent.opacity ?? 1,
          angle: parent.angle ?? 0,
          x: 0,
          y: 0,
          scale: parent.scale ?? 1,
          multiply: parent.multiply ?? gray(1),
          screen: parent.screen ?? gray(0),
        },
      ],
    });
    const c =
      child.kind === "rotation"
        ? s.rotation({
            id: "R",
            parent: p,
            baseAngle: child.baseAngle ?? 0,
            keyforms: [{ angle: child.angle ?? 0, x: 0, y: 0, scale: child.scale ?? 1 }],
          })
        : s.warp({
            id: "W",
            parent: p,
            rows: 1,
            cols: 1,
            keyforms: [
              deformerKeyform(
                "warp",
                { opacity: child.opacity, multiply: child.multiply, screen: child.screen },
                false,
              ) as never,
            ],
          });
    s.mesh({
      id: "C",
      deformer: c,
      keyforms: [
        {
          positions: child.kind === "warp" ? INSIDE : [...vertex, 0, 1, 1, 0],
          multiply: mesh.multiply ?? gray(1),
          screen: mesh.screen ?? gray(0),
        },
      ],
    });
    // A blend shape names its target by the index among its kind: warp 0, or rotation 1.
    if (target)
      s.blendShape(child.kind, child.kind === "warp" ? 0 : 1, {
        param: bs,
        keys: [0, 1],
        base: 0,
        keyforms: [0, 1].map(() => deformerKeyform(child.kind, {}, true)),
      });
    return evaluateAll(loadMoc(s.build()));
  }

  it("rotation scale 1000 under a parent rotation with scale 0.5: x = 50 (target), 500 (not)", () => {
    const r = { kind: "rotation", scale: 1000 } as const;
    expect(nested({ scale: 0.5 }, r, true, [1, 0]).vertices[0]![0]).toBe(50);
    expect(nested({ scale: 0.5 }, r, false, [1, 0]).vertices[0]![0]).toBe(500);
  });

  it("the combined angle and the base angle are not clamped", () => {
    const CASES: [
      string,
      { angle?: number },
      { kind: "rotation"; angle: number; baseAngle?: number },
      number,
    ][] = [
      ["angle 3000 under a parent at 1000", { angle: 1000 }, { kind: "rotation", angle: 3000 }, 40],
      [
        "angle 3000 with base angle 1000",
        {},
        { kind: "rotation", angle: 3000, baseAngle: 1000 },
        40,
      ],
      ["angle 0 with base angle 5000", {}, { kind: "rotation", angle: 0, baseAngle: 5000 }, 320],
    ];
    for (const [what, parent, child, deg] of CASES) {
      const t = nested(parent, child, true, [1000, 0]);
      const n = nested(parent, child, false, [1000, 0]);
      expect(same(t.vertices[0], n.vertices[0]), what).toBe(true);
      expect(direction(t.vertices[0]!), what).toBeCloseTo(deg, 2);
    }
  });

  it("a warp's opacity and colors are clamped before the parent rotation's combine in", () => {
    const w = { kind: "warp", opacity: 1.5 } as const;
    expect(nested({ opacity: 0.5 }, w, true, [0, 0]).opacity[0]).toBe(0.5);
    const colors = { kind: "warp", multiply: gray(1.5), screen: gray(-0.5) } as const;
    const parent = { multiply: gray(0.5), screen: gray(0.5) };
    const mesh = { multiply: gray(1), screen: gray(0) };
    const t = nested(parent, colors, true, [0, 0], mesh);
    const n = nested(parent, colors, false, [0, 0], mesh);
    expect([t.multiply[0], t.screen[0]]).toEqual([0.5, 0.5]);
    expect([n.multiply[0], n.screen[0]]).toEqual([0.75, 0.25]);
  });
});

describe("two blend shapes on one target add one at a time, then clamp once", () => {
  it("opacity 0.5 (art mesh and rotation) and scale 1 (rotation)", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const bs1 = s.param("BS1", 0, 1, 1, { type: 1 });
    const bs2 = s.param("BS2", 0, 1, 1, { type: 1 });
    const meshKf = (o: number) => ({ opacity: o, positions: zeros(6), ...ZERO_COLORS });
    const ORDERS: [number, number][] = [
      [0.8, -0.8],
      [-0.8, 0.8],
    ];
    // Art meshes 0 and 1: opacity 0.5 with the deltas in the two orders.
    for (const [a, b] of ORDERS) {
      const m = s.mesh({ id: `M${a}`, keyforms: [{ opacity: 0.5, positions: INSIDE }] });
      s.blendShape("mesh", m, {
        param: bs1,
        keys: [0, 1],
        base: 0,
        keyforms: [meshKf(0), meshKf(a)],
      });
      s.blendShape("mesh", m, {
        param: bs2,
        keys: [0, 1],
        base: 0,
        keyforms: [meshKf(0), meshKf(b)],
      });
    }
    // Rotations: opacity 0.5 (children 2, 3), then scale 1 with +200/−150 (children 4, 5).
    const rotKf = (o: number, sc: number) => ({
      opacity: o,
      angle: 0,
      x: 0,
      y: 0,
      scale: sc,
      ...ZERO_COLORS,
    });
    const rotation = (id: string, opacity: number, deltas: [number, number][]) => {
      const r = s.rotation({ id, keyforms: [{ opacity, angle: 0, x: 0, y: 0, scale: 1 }] });
      s.mesh({ id: `C${id}`, deformer: r, keyforms: [{ positions: [1, 0, 0, 1, 1, 1] }] });
      for (const [j, [o, sc]] of deltas.entries())
        s.blendShape("rotation", r, {
          param: j === 0 ? bs1 : bs2,
          keys: [0, 1],
          base: 0,
          keyforms: [rotKf(0, 0), rotKf(o, sc)],
        });
    };
    rotation("RO1", 0.5, [
      [0.8, 0],
      [-0.8, 0],
    ]);
    rotation("RO2", 0.5, [
      [-0.8, 0],
      [0.8, 0],
    ]);
    rotation("RS1", 1, [
      [0, 200],
      [0, -150],
    ]);
    rotation("RS2", 1, [
      [0, -150],
      [0, 200],
    ]);
    const model1 = loadMoc(s.build());
    const both = evaluateAll(model1, { parameters: { [bs1]: 1, [bs2]: 1 } });
    expect(both.opacity.slice(0, 4)).toEqual([0.4999999403953552, 0.5, 0.4999999403953552, 0.5]);
    expect([both.vertices[4]![0], both.vertices[5]![0]]).toEqual([51, 51]);
    // f32(0.5 + f32(0.8)) is a tie, rounded to even.
    expect(fr(0.5 + fr(0.8))).toBe(1.2999999523162842);
    const first = evaluateAll(model1, { parameters: { [bs1]: 1, [bs2]: 0 } });
    expect(first.opacity.slice(0, 4)).toEqual([1, 0, 1, 0]);
    expect([first.vertices[4]![0], first.vertices[5]![0]]).toEqual([100, E4]);
  });
});

describe("version-4 targets are not clamped", () => {
  /** The same scene in version 4 or 5; targets have one blend shape on BS (at 1). */
  function scene(version: 4 | 5, targets: boolean): Output {
    const s = new Synth(version);
    s.part({ id: "Root" });
    const bs = s.param("BS", 0, 1, 1, { type: 1 });
    const meshDelta = (o: number, x: number): MeshKeyform => ({
      opacity: o,
      positions: [x, 0, 0, 0, 0, 0],
      drawOrder: 0,
      ...ZERO_COLORS,
    });
    const target = (m: number, delta: MeshKeyform = meshDelta(0, 0)) => {
      if (targets)
        s.blendShape("mesh", m, {
          param: bs,
          keys: [0, 1],
          base: 0,
          keyforms: [meshDelta(0, 0), delta],
        });
    };
    target(s.mesh({ id: "O15", keyforms: [{ opacity: 1.5, positions: zeros(6) }] }));
    target(s.mesh({ id: "On05", keyforms: [{ opacity: -0.5, positions: zeros(6) }] }));
    target(
      s.mesh({ id: "O05", keyforms: [{ opacity: 0.5, positions: zeros(6) }] }),
      meshDelta(0.3, 10),
    );
    target(s.mesh({ id: "D37", keyforms: [{ positions: zeros(6), drawOrder: -3.7 }] }));
    target(
      s.mesh({ id: "D1500", keyforms: [{ positions: zeros(6), drawOrder: 1500 }] }),
      meshDelta(0, 10),
    );
    // An art mesh under a warp (multiply 0.5, screen 0.5), its own colors (1.5, −0.5).
    const w1 = s.warp({
      id: "W1",
      rows: 1,
      cols: 1,
      keyforms: [{ points: UNIT_GRID, multiply: gray(0.5), screen: gray(0.5) }],
    });
    target(
      s.mesh({
        id: "Colors",
        deformer: w1,
        keyforms: [{ positions: INSIDE, multiply: gray(1.5), screen: gray(-0.5) }],
      }),
    );
    // A warp target with opacity 1.5 and colors (1.5, −0.5); child colors (0.5, 0.5).
    const w2 = s.warp({
      id: "W2",
      rows: 1,
      cols: 1,
      keyforms: [{ opacity: 1.5, points: UNIT_GRID, multiply: gray(1.5), screen: gray(-0.5) }],
    });
    s.mesh({
      id: "Child",
      deformer: w2,
      keyforms: [{ positions: INSIDE, multiply: gray(0.5), screen: gray(0.5) }],
    });
    if (targets)
      s.blendShape("warp", w2, {
        param: bs,
        keys: [0, 1],
        base: 0,
        keyforms: [0, 1].map(() => deformerKeyform("warp", {}, true)),
      });
    return evaluateAll(loadMoc(s.build()));
  }
  const summary = (o: Output) => ({
    opacity: o.opacity.slice(0, 3),
    visible: o.visible[1],
    x: o.vertices[2]![0],
    drawOrder: o.drawOrder.slice(3, 5),
    colors: [o.multiply[15], o.screen[15]],
    warp: [o.opacity[6], o.multiply[18], o.screen[18]],
  });

  it("the published table", () => {
    expect(summary(scene(4, true))).toEqual({
      opacity: [1.5, -0.5, 0.5],
      visible: 1,
      x: 10,
      drawOrder: [-3, 1500],
      colors: [0.75, 0.25],
      warp: [1.5, 0.75, 0.25],
    });
    expect(summary(scene(5, true))).toEqual({
      opacity: [1, 0, 0.800000011920929],
      visible: 0,
      x: 10,
      drawOrder: [0, 1000],
      colors: [0.5, 0.5],
      warp: [1, 0.5, 0.5],
    });
    // Non-targets: as stored, in both versions.
    for (const version of [4, 5] as const)
      expect(summary(scene(version, false))).toEqual({
        opacity: [1.5, -0.5, 0.5],
        visible: 1,
        x: 0,
        drawOrder: [-3, 1500],
        colors: [0.75, 0.25],
        warp: [1.5, 0.75, 0.25],
      });
  });
});

describe("non-finite opacities", () => {
  /** The cases of the table, in one file loaded with nonFiniteOpacity: "load". */
  function model() {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const part = s.part({ id: "P", parent: 0 });
    const bs = s.param("BS", 0, 1, 1, { type: 1 });
    const a = s.param("A", 0, 1, 0);
    const byA = s.band([s.binding(a, [0, 1])]);
    const target = (m: number) =>
      s.blendShape("mesh", m, {
        param: bs,
        keys: [0, 1],
        base: 0,
        keyforms: [0, 1].map(() => ({ opacity: 0, positions: zeros(6), ...ZERO_COLORS })),
      });
    // 0–5: stored NaN, +∞, −∞, each not a target and a target.
    for (const o of [NaN, Infinity, -Infinity])
      for (const isTarget of [false, true]) {
        const m = s.mesh({
          id: `S${o}${isTarget}`,
          keyforms: [{ opacity: o, positions: zeros(6) }],
        });
        if (isTarget) target(m);
      }
    // 6, 7: keyforms +∞ (A = 0) and −∞ (A = 1), not a target and a target.
    for (const isTarget of [false, true]) {
      const m = s.mesh({
        id: `I${isTarget}`,
        band: byA,
        keyforms: [
          { opacity: Infinity, positions: zeros(6) },
          { opacity: -Infinity, positions: zeros(6) },
        ],
      });
      if (isTarget) target(m);
    }
    // 8: a warp with opacity NaN, its child mesh not a target.
    const w = s.warp({
      id: "W",
      rows: 1,
      cols: 1,
      keyforms: [{ opacity: NaN, points: UNIT_GRID }],
    });
    s.mesh({ id: "WC", deformer: w, keyforms: [{ positions: INSIDE }] });
    // 9, 10: opacity 1 in part P (whose opacity is set), not a target and a target.
    target(s.mesh({ id: "PT", part, keyforms: [{ positions: zeros(6) }] }));
    s.mesh({ id: "PN", part, keyforms: [{ positions: zeros(6) }] });
    return { bytes: s.build(), a, part };
  }

  it("load only when asked; the default load rejects them", () => {
    const { bytes } = model();
    expect(() => loadMoc(bytes)).toThrow(/not finite/);
    expect(() => loadMoc(bytes, { nonFiniteOpacity: "load" })).not.toThrow();
  });

  it("the published table: reported opacity and visibility", () => {
    const { bytes, a, part } = model();
    const m = loadMoc(bytes, { nonFiniteOpacity: "load" });
    const out = evaluateAll(m);
    const STORED: [number, number][] = [
      [NaN, 1],
      [NaN, 1],
      [Infinity, 1],
      [1, 1],
      [-Infinity, 1],
      [0, 0],
    ];
    STORED.forEach(([o, vis], i) => {
      expect(Object.is(out.opacity[i], o), `case ${i}`).toBe(true);
      expect(out.visible[i], `case ${i}`).toBe(vis);
    });
    // Interpolating +∞ and −∞: at A = 0 / 0.5 / 1.
    const EXPECT: [number, number][][] = [
      [
        [Infinity, 1],
        [NaN, 1],
        [-Infinity, 1],
      ],
      [
        [1, 1],
        [NaN, 1],
        [0, 0],
      ],
    ];
    for (const [j, value] of [0, 0.5, 1].entries()) {
      const o = evaluateAll(m, { parameters: { [a]: value } });
      for (const k of [0, 1]) {
        const [op, vis] = EXPECT[k]![j]!;
        expect(Object.is(o.opacity[6 + k], op), `interp ${k}, A = ${value}`).toBe(true);
        expect(o.visible[6 + k], `interp ${k}, A = ${value}`).toBe(vis);
      }
    }
    expect(Number.isNaN(out.opacity[8])).toBe(true);
    expect(out.visible[8]).toBe(1);
    // Part opacities are clamped to [0, 1] with NaN propagating.
    const PARTS: [number, number, number][] = [
      [NaN, NaN, 1],
      [Infinity, 1, 1],
      [-Infinity, 0, 0],
      [1.5, 1, 1],
      [-0.5, 0, 0],
    ];
    for (const [p, op, vis] of PARTS) {
      const o = evaluateAll(m, { parts: { [part]: p } });
      for (const d of [9, 10]) {
        expect(Object.is(o.opacity[d], op), `part ${p}, drawable ${d}`).toBe(true);
        expect(o.visible[d], `part ${p}, drawable ${d}`).toBe(vis);
      }
    }
  });
});

describe("the rule at the bit level (colors, rotation, glue)", () => {
  const UNEVEN = [-1.3, -0.4, 0, 0.6, 1.9].map(fr);
  const V1 = 0.19010111689567566; // t = 0.3168351948261261, in the segment 0…0.6
  /** Blend-shape keyforms on BV's keys: q at key f32(0.6) (index 3), zeros elsewhere (base: index 2). */
  const at3 = <T>(make: (q: number) => T, q: number) => [0, 0, 0, q, 0].map((x) => make(x));

  it("the location and the columns of the table", () => {
    const li = new Int32Array(1);
    const lt = new Float32Array(1);
    const keys = Float32Array.from(UNEVEN);
    const rows: [number, number, number, number, number][] = [
      // v, t, Q(i+1), the rule, S2
      [V1, 0.3168351948261261, 75.11164093017578, 23.798009872436523, 23.798011779785156],
      [V1, 0.3168351948261261, 0.3235340118408203, 0.10250695049762726, 0.10250696539878845],
      [V1, 0.3168351948261261, 0.6039312481880188, 0.1913466602563858, 0.191346675157547],
      [
        0.19004859030246735, 0.31674763560295105, -1041.05908203125, -329.7530212402344,
        -329.75299072265625,
      ],
      [
        0.03908523917198181, 0.06514206528663635, -1041.05908203125, -67.81671142578125,
        -67.81674194335938,
      ],
    ];
    for (const [v, t, q, rule, s2v] of rows) {
      locateBlendKeyAt(keys, fr(v), li, lt, 0);
      expect([li[0], lt[0]]).toEqual([2, t]);
      expect(fr(fr(1 - fr(1 - t)) * q)).toBe(rule);
      expect(s2(t, 0, q)).toBe(s2v);
    }
  });

  it("multiply color, rotation scale and glue intensity, read directly", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const bv = s.param("BV", -2, 2, 0, { type: 1 });
    // 0: an art mesh at the root whose multiply and screen are s (normal colors 0).
    const m = s.mesh({
      id: "Colors",
      keyforms: [{ positions: zeros(6), multiply: gray(0), screen: gray(0) }],
    });
    s.blendShape("mesh", m, {
      param: bv,
      keys: UNEVEN,
      base: 2,
      keyforms: at3(
        (q) => ({ opacity: 0, positions: zeros(6), multiply: [q, 0, 0] as RGB, screen: gray(0) }),
        0.6039312481880188,
      ),
    });
    // 1: a rotation at angle 0 whose scale is s; child vertex (1, 0).
    const r = s.rotation({ id: "R", keyforms: [{ angle: 0, x: 0, y: 0, scale: 0 }] });
    s.mesh({ id: "RC", deformer: r, keyforms: [{ positions: [1, 0, 0, 1, 1, 1] }] });
    s.blendShape("rotation", 0, {
      param: bv,
      keys: UNEVEN,
      base: 2,
      keyforms: at3(
        (q) => ({ opacity: 0, angle: 0, x: 0, y: 0, scale: q, ...ZERO_COLORS }),
        75.11164093017578,
      ),
    });
    // 2, 3: meshes with vertex 0 at x = 0 and 1024, glued 0.5 / 0.5 with intensity s (normal 0).
    const ga = s.mesh({ id: "GA", keyforms: [{ positions: [0, 0, 0, 1, 1, 0] }] });
    const gb = s.mesh({ id: "GB", keyforms: [{ positions: [1024, 0, 1024, 1, 1025, 0] }] });
    s.glue({ id: "G", a: ga, b: gb, pairs: [[0, 0.5, 0, 0.5]], intensities: [0] });
    s.blendShape("glue", 0, {
      param: bv,
      keys: UNEVEN,
      base: 2,
      keyforms: at3((q) => q, 0.3235340118408203),
    });
    const out = evaluateAll(loadMoc(s.build()), { parameters: { [bv]: V1 } });
    expect(out.multiply[0]).toBe(0.1913466602563858);
    expect(out.vertices[1]![0]).toBe(23.798009872436523);
    expect(out.vertices[2]![0]).toBe(52.483558654785156); // 512·I
    expect(out.vertices[2]![0]! / 512).toBe(0.10250695049762726);
  });

  it("the rotation angle: the expected outputs of the rule twins", () => {
    // Child vertex (−30059.67578125, −11166.716796875), origin 0, scale 1.
    const P: [number, number] = [-30059.67578125, -11166.716796875];
    const ROWS: [number, number[], [number, [number, number]][]][] = [
      [
        0.19004859030246735,
        [-329.7530212402344, -329.75299072265625, -329.7529602050781],
        [
          [0, [-20342.427734375, 24788.41015625]],
          [1, [-20342.427734375, 24788.41015625]],
          [2, [-20342.404296875, 24788.4296875]],
          [3, [-20342.392578125, 24788.44140625]],
        ],
      ],
      [
        0.03908523917198181,
        [-67.81671142578125, -67.81674194335938, -67.8167724609375],
        [
          [0, [-21689.81640625, -23618.458984375]],
          [1, [-21689.81640625, -23618.458984375]],
          [2, [-21689.8046875, -23618.46875]],
          [3, [-21689.79296875, -23618.478515625]],
        ],
      ],
    ];
    for (const [v, twins, expected] of ROWS) {
      // Rotation 0 is the target (normal angle 0, the delta at key f32(0.6));
      // rotations 1–3 are the rule, S2 and t-from-the-right twins.
      const s = new Synth(5);
      s.part({ id: "Root" });
      const bv = s.param("BV", -2, 2, 0, { type: 1 });
      [0, ...twins].forEach((angle, i) => {
        const r = s.rotation({ id: `R${i}`, keyforms: [{ angle, x: 0, y: 0, scale: 1 }] });
        s.mesh({ id: `C${i}`, deformer: r, keyforms: [{ positions: [...P, 0, 1, 1, 0] }] });
      });
      s.blendShape("rotation", 0, {
        param: bv,
        keys: UNEVEN,
        base: 2,
        keyforms: at3(
          (q) => ({ opacity: 0, angle: q, x: 0, y: 0, scale: 0, ...ZERO_COLORS }),
          -1041.05908203125,
        ),
      });
      const out = evaluateAll(loadMoc(s.build()), { parameters: { [bv]: v } });
      for (const [i, xy] of expected)
        expect(out.vertices[i]!.slice(0, 2), `v = ${v}, rotation ${i}`).toEqual(xy);
    }
  });
});

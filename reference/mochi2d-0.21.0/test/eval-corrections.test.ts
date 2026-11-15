/**
 * Evaluation corrections S1, S2, S4 and S5, with their vectors, on
 * synthetic `.moc3` files.
 *
 * - S1: the key-snap and range tolerance is ε = f32(10^−d), d being the
 *   binding's parameter's decimal places (slot 55).
 * - S2: keyform interpolation is a float32 weighted sum over the corners of
 *   the bindings that are off their keys, accumulated from 0 in ascending
 *   corner order, each weight a running product in band order.
 * - S4: a blend shape's base keyform is never read: its values are taken as
 *   zero, and the contribution is w·s.
 * - S5: in v5+, normal keyforms use color entry C + (k − F), as in v4; only
 *   blend-shape keyforms use their own per-keyform indices.
 * - The draw-order formula: n = trunc(f32(D + 0.001)); a blend-shape
 *   target gets max(0, trunc(f32(f32(n + B) + 0.001))); that value is also the
 *   render-order key and what group ranges are compared with.
 *
 * Every case runs with the WebAssembly and the JavaScript kernels, with and
 * without incremental evaluation; the results must be bit-identical.
 */
import { describe, expect, it } from "vitest";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { ModelInstance, type InstanceOptions } from "../src/core/eval/instance.js";
import { wasmKernelsAvailable } from "../src/core/eval/kernels.js";
import { Synth, type MeshKeyform } from "./support/synth.js";

const fr = Math.fround;

const MODES: InstanceOptions[] = [
  { kernels: "js" },
  { kernels: "js", incremental: false },
  ...(wasmKernelsAvailable()
    ? ([{ kernels: "wasm" }, { kernels: "wasm", incremental: false }] as InstanceOptions[])
    : []),
];

interface Output {
  active: number[];
  vertices: number[][];
  opacity: number[];
  drawOrder: number[];
  multiply: number[];
  screen: number[];
}

function output(inst: ModelInstance): Output {
  return {
    active: Array.from(inst.drawableActive),
    vertices: inst.drawableVertices.map((v) => Array.from(v)),
    opacity: Array.from(inst.drawableOpacity),
    drawOrder: Array.from(inst.drawableDrawOrder),
    multiply: Array.from(inst.drawableMultiply),
    screen: Array.from(inst.drawableScreen),
  };
}

/** Bit-level equality, −0 and NaN included. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object")
    return Object.keys(a).every((k) => same((a as never)[k], (b as never)[k]));
  return false;
}

/**
 * Evaluates `model` after `pose` in every mode, checks that all modes agree
 * bit for bit, and returns the output. A first evaluation at the defaults
 * runs before the pose, so the incremental path is exercised too.
 */
function evaluate(model: MocModel, pose: Record<number, number>): Output {
  const outs = MODES.map((mode) => {
    const inst = new ModelInstance(model, mode);
    for (const [p, v] of Object.entries(pose)) inst.setParameter(Number(p), v);
    inst.evaluate();
    return output(inst);
  });
  for (const o of outs.slice(1)) expect(same(o, outs[0])).toBe(true);
  return outs[0]!;
}

/** A triangle at radius r (model space, y up): (r, 0), (−r/2, r·√3/2), (−r/2, −r·√3/2). */
const triangle = (r: number): number[] => [
  r,
  0,
  -r / 2,
  (r * Math.sqrt(3)) / 2,
  -r / 2,
  (-r * Math.sqrt(3)) / 2,
];

// ------------------------------------------------------------------ S1

describe("S1: the key tolerance is 10^−d of the binding's parameter", () => {
  /** One parameter (−2…3), keys 0, 0.4, 1; vertex 0 has x = 100, 150, 200 at those keys. */
  function model(version: number, d: number): { model: MocModel; p: number } {
    const s = new Synth(version);
    s.part({ id: "Root" });
    const p = s.param("P", -2, 3, 0);
    const band = s.band([s.binding(p, [0, 0.4, 1])]);
    s.mesh({
      id: "M",
      band,
      keyforms: [100, 150, 200].map((x) => ({ positions: [x, 0, 0, 10, 10, 0] })),
    });
    const bytes = s.build({ tamper: (f) => void (f["parameter.decimals"] = [d]) });
    return { model: loadMoc(bytes), p };
  }

  // d, value, x of vertex 0 (null: out of range, the mesh is inactive).
  const ROWS: [number, number, number | null][] = [
    [1, 0.31, 150],
    [1, 0.29, 136.25],
    [1, 0.35, 150],
    [1, 1.09, 200],
    [1, 1.11, null],
    [2, 0.389, 148.625],
    [3, 0.3989, 149.8625],
    [3, 0.3991, 150],
    [3, 1.0011, null],
    [0, 0.75, 100],
    [0, 1.9, 200],
    [0, 2.1, null],
  ];

  for (const version of [1, 5])
    it(`the table of decimal places, values and positions, v${version}`, () => {
      for (const [d, value, x] of ROWS) {
        const { model: m, p } = model(version, d);
        const out = evaluate(m, { [p]: value });
        const row = `d = ${d}, value ${value}`;
        expect(out.active[0], row).toBe(x === null ? 0 : 1);
        if (x !== null) expect(out.vertices[0]![0], row).toBe(fr(x));
      }
    });

  it("large d: the tolerance is f32(10^−d), down to 0 (a value on a key still gives t = 0)", () => {
    for (const d of [6, 7, 8, 30, 45, 46, 400, 1000]) {
      const { model: m, p } = model(5, d);
      // Exactly on key 0.4: t = 0 whatever ε is.
      expect(evaluate(m, { [p]: 0.4 }).vertices[0]![0], `d = ${d}`).toBe(150);
      // The last key 1 is out of range once f32(1 + ε) = 1, from d = 8: the
      // upper range test is strict.
      expect(evaluate(m, { [p]: 1 }).active[0], `d = ${d}`).toBe(d <= 7 ? 1 : 0);
      // Two float32 steps above the last key. The bound f32(1 + ε) is 8 steps above it
      // for d = 6, one step for d = 7 and none from d = 8.
      const above = evaluate(m, { [p]: fr(1 + 2 ** -22) });
      expect(above.active[0], `d = ${d}`).toBe(d <= 6 ? 1 : 0);
    }
  });
});

// ------------------------------------------------------------------ S2

describe("S2: interpolation is a weighted sum over the corners", () => {
  it("two two-key bindings at t = f32(0.3), Q = (0, 1.59, 3.18, 4.77): 1.4310002326965332", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const a = s.param("A", 0, 1, 0);
    const b = s.param("B", 0, 1, 0);
    const band = s.band([s.binding(a, [0, 1]), s.binding(b, [0, 1])]);
    const Q = [0, 1.59, 3.18, 4.77];
    s.mesh({
      id: "M",
      band,
      keyforms: Q.map((q) => ({ positions: [q, 0, 0, 1, 1, 0], opacity: q })),
    });
    const out = evaluate(loadMoc(s.build()), { [a]: 0.3, [b]: 0.3 });
    expect(out.vertices[0]![0]).toBe(1.4310002326965332);
    expect(out.opacity[0]).toBe(1.4310002326965332);
  });

  /** n two-key bindings, vertex 0 of keyform c at x = c (version 3: no color tables). */
  function cornerModel(n: number): { model: MocModel; params: number[] } {
    const s = new Synth(3);
    s.part({ id: "Root" });
    const params = Array.from({ length: n }, (_, i) => s.param(`P${i}`, 0, 1, 0));
    const band = s.band(params.map((p) => s.binding(p, [0, 1])));
    const keyforms: MeshKeyform[] = Array.from({ length: 2 ** n }, (_, c) => ({
      positions: [c, 0],
    }));
    s.mesh({ id: "M", band, keyforms, triangles: [] });
    return { model: loadMoc(s.build()), params };
  }

  it("float32 accumulation over 2^n corners: n = 16 → 32767.047 (ideal 32767.5)", () => {
    const { model: m, params } = cornerModel(16);
    const out = evaluate(m, Object.fromEntries(params.map((p) => [p, 0.5])));
    expect(out.vertices[0]![0]).toBe(fr(32767.047));
  });

  it("n = 20 → 524350.25 (ideal 524287.5)", { timeout: 60_000 }, () => {
    const { model: m, params } = cornerModel(20);
    const out = evaluate(m, Object.fromEntries(params.map((p) => [p, 0.5])));
    expect(out.vertices[0]![0]).toBe(524350.25);
  });

  /** ParamA (0…1); vertex 0 of keyform c at (100c, 10c²); the canvas flips y. */
  function repeated(kind: "same" | "twin" | "mixed"): { model: MocModel; p: number } {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const p = s.param("ParamA", 0, 1, 0);
    const b1 = s.binding(p, [0, 1]);
    const bindings =
      kind === "same"
        ? [b1, b1]
        : kind === "twin"
          ? [b1, s.binding(p, [0, 1])]
          : [b1, s.binding(p, [0, 0.5, 1])];
    const band = s.band(bindings);
    const count = kind === "mixed" ? 6 : 4;
    s.mesh({
      id: "M",
      band,
      keyforms: Array.from({ length: count }, (_, c) => ({
        positions: [100 * c, 10 * c * c, 0, 1, 1, 0],
      })),
    });
    return { model: loadMoc(s.build()), p };
  }

  it("repeated entries inside one band (reported positions, y negated)", () => {
    const cases: [kind: "same" | "twin" | "mixed", value: number, x: number, y: number][] = [
      ["same", 0.25, 75, -15],
      ["same", 0.6, 180, -44.4],
      ["twin", 0.25, 75, -15],
      ["twin", 0.6, 180, -44.4],
      ["mixed", 0.25, 125, -27.5],
      ["mixed", 0.6, 300.00003, -98.80001],
    ];
    for (const [kind, value, x, y] of cases) {
      const { model: m, p } = repeated(kind);
      const v = evaluate(m, { [p]: value }).vertices[0]!;
      expect([v[0], v[1]], `${kind} at ${value}`).toEqual([fr(x), fr(y)]);
    }
  });

  it("a one-key binding sits at its key: in range only within ε of it", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const p = s.param("P", 0, 1, 0);
    const band = s.band([s.binding(p, [0])]);
    s.mesh({ id: "M", band, keyforms: [{ positions: triangle(100) }] });
    const m = loadMoc(s.build());
    expect(evaluate(m, { [p]: 0 }).active[0]).toBe(1);
    expect(evaluate(m, { [p]: 0.0005 }).active[0]).toBe(1);
    expect(evaluate(m, { [p]: 0.5 }).active[0]).toBe(0);
  });
});

// ------------------------------------------------------------------ S4

describe("S4: a blend shape's base keyform is never read", () => {
  /** A triangle at radius 100 with a blend shape on BS (keys 0 = base, 1). */
  function model(version: number, base: MeshKeyform): { model: MocModel; bs: number } {
    const s = new Synth(version);
    s.part({ id: "Root" });
    const bs = s.param("BS", 0, 1, 0, { type: 1 });
    const m = s.mesh({ id: "M", keyforms: [{ positions: triangle(100), drawOrder: 500 }] });
    s.blendShape("mesh", m, {
      param: bs,
      keys: [0, 1],
      base: 0,
      keyforms: [
        base,
        {
          positions: [10, -20, 10, -20, 10, -20],
          opacity: -0.5,
          drawOrder: 100,
          multiply: [-0.5, -0.25, -0.75],
          screen: [0.1, 0.2, 0.3],
        },
      ],
    });
    return { model: loadMoc(s.build()), bs };
  }
  const zeros: MeshKeyform = {
    positions: [0, 0, 0, 0, 0, 0],
    opacity: 0,
    drawOrder: 0,
    multiply: [0, 0, 0],
    screen: [0, 0, 0],
  };
  const nonzero: MeshKeyform = {
    positions: [4, 8, 4, 8, 4, 8],
    opacity: 0.25,
    drawOrder: 40,
    multiply: [0.3, 0.6, 0.9],
    screen: [0.2, 0.4, 0.8],
  };

  it("v5: zero and non-zero base keyforms give the same outputs; BS = 0.5 gives the vector", () => {
    for (const value of [0, 0.25, 0.5, 1]) {
      const a = evaluate(model(5, zeros).model, { 0: value });
      const b = evaluate(model(5, nonzero).model, { 0: value });
      expect(same(a, b), `BS = ${value}`).toBe(true);
    }
    const out = evaluate(model(5, nonzero).model, { 0: 0.5 });
    // Vertex (100, 0) → (105, −10) in model space, reported with y negated.
    expect(out.vertices[0]!.slice(0, 2)).toEqual([105, 10]);
    expect(out.opacity[0]).toBe(0.75);
    expect(out.drawOrder[0]).toBe(550);
  });

  it("v4: the same for positions (a v4 blend shape moves vertices only)", () => {
    for (const value of [0, 0.5, 1]) {
      const a = evaluate(model(4, zeros).model, { 0: value });
      const b = evaluate(model(4, nonzero).model, { 0: value });
      expect(same(a, b), `BS = ${value}`).toBe(true);
    }
    const out = evaluate(model(4, nonzero).model, { 0: 0.5 });
    expect(out.vertices[0]!.slice(0, 2)).toEqual([105, 10]);
    expect(out.opacity[0]).toBe(1);
    expect(out.drawOrder[0]).toBe(500);
  });

  it("v5 blend-shape colors: w·s added to the normal color, then clamped to [0, 1]", () => {
    const rows: {
      normal: [number[], number[]];
      delta: [number[], number[]];
      half: [number[], number[]];
      full: [number[], number[]];
    }[] = [
      {
        normal: [
          [1, 1, 1],
          [0, 0, 0],
        ],
        delta: [
          [-0.5, -0.25, -0.75],
          [0.1, 0.2, 0.3],
        ],
        half: [
          [0.75, 0.875, 0.625],
          [0.05, 0.1, 0.15],
        ],
        full: [
          [0.5, 0.75, 0.25],
          [0.1, 0.2, 0.3],
        ],
      },
      {
        normal: [
          [0.5, 0.5, 0.5],
          [0.5, 0.5, 0.5],
        ],
        delta: [
          [0, 0, 0],
          [1, 1, 1],
        ],
        half: [
          [0.5, 0.5, 0.5],
          [1, 1, 1],
        ],
        full: [
          [0.5, 0.5, 0.5],
          [1, 1, 1],
        ],
      },
    ];
    for (const row of rows) {
      const s = new Synth(5);
      s.part({ id: "Root" });
      const bs = s.param("BS", 0, 1, 0, { type: 1 });
      const m = s.mesh({
        id: "M",
        keyforms: [
          {
            positions: triangle(100),
            multiply: row.normal[0] as never,
            screen: row.normal[1] as never,
          },
        ],
      });
      s.blendShape("mesh", m, {
        param: bs,
        keys: [0, 1],
        base: 0,
        keyforms: [
          { ...nonzero },
          {
            positions: [0, 0, 0, 0, 0, 0],
            opacity: 0,
            drawOrder: 0,
            multiply: row.delta[0],
            screen: row.delta[1],
          },
        ],
      });
      const model2 = loadMoc(s.build());
      for (const [value, want] of [
        [0.5, row.half],
        [1, row.full],
      ] as const) {
        const out = evaluate(model2, { [bs]: value });
        expect(out.multiply, `BS = ${value}`).toEqual(want[0].map(fr));
        expect(out.screen, `BS = ${value}`).toEqual(want[1].map(fr));
      }
    }
  });
});

// ------------------------------------------------------------------ S5

describe("S5: v5 normal keyforms use color entry C + (k − F)", () => {
  /** Two keyforms; a 7-entry table whose entry i has multiply green 1 − i/10; first entry 5. */
  function model(version: 4 | 5): { model: MocModel; p: number } {
    const s = new Synth(version);
    s.part({ id: "Root" });
    const p = s.param("P", 0, 1, 0);
    const band = s.band([s.binding(p, [0, 1])]);
    s.mesh({
      id: "M",
      band,
      keyforms: [{ positions: triangle(100) }, { positions: triangle(100) }],
    });
    const bytes = s.build({
      tamper: (f) => {
        const ones = [1, 1, 1, 1, 1, 1, 1];
        const zeros = [0, 0, 0, 0, 0, 0, 0];
        f["multiplyColor.r"] = ones;
        f["multiplyColor.g"] = ones.map((_, i) => 1 - i / 10);
        f["multiplyColor.b"] = ones;
        f["screenColor.r"] = zeros;
        f["screenColor.g"] = zeros;
        f["screenColor.b"] = zeros;
        f["mesh.firstColor"] = [5];
        if (version === 5) {
          f["meshKeyform.multiplyColor"] = [6, 3];
          f["meshKeyform.screenColor"] = [6, 3];
        }
      },
    });
    return { model: loadMoc(bytes), p };
  }

  for (const version of [4, 5] as const)
    it(`v${version}: green 0.5 at P = 0 and 0.4 at P = 1 (entries 5 and 6)`, () => {
      const { model: m, p } = model(version);
      expect(evaluate(m, { [p]: 0 }).multiply[1]).toBe(fr(0.5));
      expect(evaluate(m, { [p]: 1 }).multiply[1]).toBe(fr(0.4));
    });
});

// ------------------------------------------------------- draw orders

describe("the draw-order formula, for art meshes and parts", () => {
  const D1 = fr(500 - 0.0005); // 499.999512
  const D2 = fr(500 - 0.00105); // 499.998962

  /**
   * One object with the single normal draw-order keyform D and one blend shape
   * per delta, each on its own parameter BSj (keys 0 = base, 1; the delta on key
   * 1). With `asPart`, the object is a part read through partDrawOrder; else an
   * art mesh. Returns the draw order with every BSj at `value`.
   */
  function drawOrder(D: number, deltas: number[], value: number, asPart: boolean): number {
    const results = MODES.map((mode) => {
      const s = new Synth(5);
      const params = deltas.map((_, j) => s.param(`BS${j}`, 0, 1, 0, { type: 1 }));
      const root = s.part({ id: "Root", keyforms: [{ drawOrder: asPart ? D : 500 }] });
      const m = s.mesh({
        id: "M",
        keyforms: [{ positions: triangle(1), drawOrder: asPart ? 500 : D }],
      });
      deltas.forEach((delta, j) =>
        asPart
          ? s.blendShape("part", root, {
              param: params[j]!,
              keys: [0, 1],
              base: 0,
              keyforms: [{ drawOrder: 0 }, { drawOrder: delta }],
            })
          : s.blendShape("mesh", m, {
              param: params[j]!,
              keys: [0, 1],
              base: 0,
              keyforms: [
                { positions: [0, 0, 0, 0, 0, 0], opacity: 0, drawOrder: 0 },
                { positions: [0, 0, 0, 0, 0, 0], opacity: 0, drawOrder: delta },
              ],
            }),
      );
      const inst = new ModelInstance(loadMoc(s.build()), mode);
      for (const p of params) inst.setParameter(p, value);
      inst.evaluate();
      return asPart ? inst.partDrawOrder[root]! : inst.drawableDrawOrder[m]!;
    });
    for (const r of results) expect(r).toBe(results[0]);
    return results[0]!;
  }

  // Draw orders at BSj = 1, and the expected value.
  const AT_ONE: [D: number, deltas: number[], expected: number][] = [
    [D1, [], 500],
    [D2, [], 499],
    [D1, [-0.3], 499],
    [D1, [1], 501],
    [D2, [0.5], 499],
    [500.5, [0.6], 500],
    [500.7, [-0.6], 499],
    [500.3, [-0.2], 499],
    [500, [0.9995], 501],
    [500, [-0.0005], 500],
    [500, [-0.002], 499],
    [500, [1.9995], 502],
    [500, [-1.0005], 499],
    [500.5, [-0.5005], 499],
    [500.4, [-2.2], 497],
    [505.621, [8.8], 513],
    [500, [0.4995, 0.5], 501],
    [500, [0.3335, 0.333, 0.333], 501],
    [500, [0.7, -0.9], 499],
    [500.5, [0.3, 0.3], 500],
    [D1, [0.25, 0.25], 500],
  ];
  // Negative values (sections 1 and 2): [D, delta or null for none, at BS = 1, at BS = 0].
  const NEGATIVE: [D: number, delta: number | null, one: number, zero: number][] = [
    [-3.7, null, -3, -3],
    [-10.2, null, -10, -10],
    [-3.7, 0.5, 0, 0],
    [-3.7, 0, 0, 0],
    [-3.7, 5, 2, 0],
    [-5.5, 7.3, 2, 0],
    [2.5, -3.2, 0, 2],
    [1.9995, -1, 1, 2],
    [3, -2.9995, 0, 3],
    [-2.2, 5.5, 3, 0],
  ];

  for (const asPart of [false, true]) {
    const what = asPart ? "parts" : "art meshes";
    it(`${what}: the 21 cases at BS = 1, and the controls at 0`, () => {
      for (const [D, deltas, expected] of AT_ONE) {
        expect(drawOrder(D, deltas, 1, asPart), `D ${D}, δ ${deltas.join(", ")}`).toBe(expected);
        // At 0 the blend shapes contribute nothing: trunc(f32(D + 0.001)).
        expect(drawOrder(D, deltas, 0, asPart)).toBe(Math.trunc(fr(fr(D) + fr(0.001))));
      }
    });

    it(`${what}: negative values, and the clamp of blend-shape targets at 0`, () => {
      for (const [D, delta, one, zero] of NEGATIVE) {
        const deltas = delta === null ? [] : [delta];
        const row = `D ${D}, δ ${delta}`;
        expect(drawOrder(D, deltas, 1, asPart), row).toBe(one);
        expect(drawOrder(D, deltas, 0, asPart), row).toBe(zero);
      }
    });
  }

  it("art meshes that are not targets: stored −8…−1 report −7…0", () => {
    for (let D = -8; D <= -1; D++) expect(drawOrder(D, [], 0, false)).toBe(D + 1);
  });

  it("further vectors: tolerances, several blend shapes, negative draw orders", () => {
    const rows: [number, number[] | null, number][] = [
      [D1, null, 500],
      [D2, null, 499],
      [D1, [-0.3], 499],
      [500, [0.9995], 501],
      [500, [-0.0005], 500],
      [500, [-0.002], 499],
      [500.5, [0.6], 500],
      [500.7, [-0.6], 499],
      [500, [0.4995, 0.5], 501],
      [505.621, [8.8], 513],
      [-3.7, null, -3],
      [-3.7, [0], 0],
      [-5.5, [7.3], 2],
      [2.5, [-3.2], 0],
    ];
    for (const asPart of [false, true])
      for (const [D, deltas, expected] of rows)
        expect(drawOrder(D, deltas ?? [], 1, asPart), `${asPart ? "part" : "mesh"} ${D}`).toBe(
          expected,
        );
  });

  /**
   * Section 3: two objects A and B, in that file order, in one group; A must be
   * drawn first (a tie keeps file order). Each is an art mesh, or a part with its
   * own child group holding one mesh. [kind, D, delta] per object.
   */
  type Obj = ["mesh" | "part", number, number | null];
  function firstDrawn(a: Obj, b: Obj, range: [number, number] = [0, 1000]): "A" | "B" {
    const orders = MODES.map((mode) => {
      const s = new Synth(5);
      const root = s.part({ id: "Root" });
      const bs = s.param("BS", 0, 1, 1, { type: 1 });
      const drawn: number[] = []; // the mesh drawn for A and for B
      const objects: { kind: 0 | 1; index: number; nested?: number }[] = [];
      const nestedGroups: { objects: { kind: 0; index: number }[]; min: number; max: number }[] =
        [];
      for (const [i, [kind, D, delta]] of [a, b].entries()) {
        if (kind === "mesh") {
          const m = s.mesh({
            id: `M${i}`,
            keyforms: [{ positions: triangle(1), drawOrder: D }],
          });
          if (delta !== null)
            s.blendShape("mesh", m, {
              param: bs,
              keys: [0, 1],
              base: 0,
              keyforms: [
                { positions: [0, 0, 0, 0, 0, 0], opacity: 0, drawOrder: 0 },
                { positions: [0, 0, 0, 0, 0, 0], opacity: 0, drawOrder: delta },
              ],
            });
          drawn.push(m);
          objects.push({ kind: 0, index: m });
        } else {
          const p = s.part({ id: `P${i}`, parent: root, keyforms: [{ drawOrder: D }] });
          if (delta !== null)
            s.blendShape("part", p, {
              param: bs,
              keys: [0, 1],
              base: 0,
              keyforms: [{ drawOrder: 0 }, { drawOrder: delta }],
            });
          const m = s.mesh({ id: `C${i}`, part: p, keyforms: [{ positions: triangle(1) }] });
          drawn.push(m);
          nestedGroups.push({ objects: [{ kind: 0, index: m }], min: 0, max: 1000 });
          objects.push({ kind: 1, index: p, nested: nestedGroups.length });
        }
      }
      s.groups = [{ objects, min: range[0], max: range[1] }, ...nestedGroups];
      const inst = new ModelInstance(loadMoc(s.build()), mode);
      return inst.drawableRenderOrder[drawn[0]!]! < inst.drawableRenderOrder[drawn[1]!]!
        ? "A"
        : "B";
    });
    for (const o of orders) expect(o).toBe(orders[0]);
    return orders[0]!;
  }

  it("the render-order key is the reported draw order", () => {
    const cases: [Obj, Obj, [number, number]?][] = [
      [
        ["mesh", 500.7, null],
        ["mesh", 500.2, null],
      ],
      [
        ["mesh", 501, null],
        ["mesh", 500.9995, null],
      ],
      [
        ["mesh", 501, null],
        ["mesh", 500, 0.9995],
      ],
      [
        ["mesh", 500.5, 0.6],
        ["mesh", 501, null],
      ],
      [
        ["part", 500.7, null],
        ["part", 500.2, null],
      ],
      [
        ["part", 501, null],
        ["part", 500.9995, null],
      ],
      [
        ["part", 501, null],
        ["part", 500, 0.9995],
      ],
      [
        ["part", 500.7, null],
        ["mesh", 500.2, null],
      ],
      [
        ["mesh", 500.7, null],
        ["part", 500.2, null],
      ],
      [
        ["mesh", 500, null],
        ["mesh", 499.9995, null],
        [500, 1000],
      ],
      [
        ["mesh", 499.9995, null],
        ["mesh", 500, null],
        [500, 1000],
      ],
      [
        ["mesh", 500.0005, null],
        ["mesh", 500, null],
        [0, 500],
      ],
      [
        ["mesh", 500, null],
        ["mesh", 499.9995, null],
        [500, 500],
      ],
    ];
    for (const [a, b, range] of cases)
      expect(firstDrawn(a, b, range), `${JSON.stringify([a, b, range])}`).toBe("A");
  });

  it("group ranges are compared with the reported draw order (no warning for 499.9995 in 500…)", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    s.mesh({ id: "A", keyforms: [{ positions: triangle(1), drawOrder: 499.9995 }] });
    s.mesh({ id: "B", keyforms: [{ positions: triangle(1), drawOrder: 500.0005 }] });
    s.groups = [
      {
        objects: [
          { kind: 0, index: 0 },
          { kind: 0, index: 1 },
        ],
        min: 500,
        max: 500,
      },
    ];
    expect(loadMoc(s.build()).loadWarnings).toEqual([]);
    // 500.9995 reports 501, above a maximum of 500: loaded with a warning (C28).
    const t = new Synth(5);
    t.part({ id: "Root" });
    t.mesh({ id: "A", keyforms: [{ positions: triangle(1), drawOrder: 500.9995 }] });
    t.groups = [{ objects: [{ kind: 0, index: 0 }], min: 500, max: 500 }];
    expect(loadMoc(t.build()).loadWarnings).toHaveLength(1);
  });
});

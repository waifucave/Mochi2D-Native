/**
 * Synthetic `.moc3` files for format variants and worked examples that
 * DeepSeek-chan does not exercise (§1b, §1c, §1d.3–1d.4).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { MocFormatError, readMocSections } from "../src/core/moc/read.js";
import { writeMoc } from "../src/core/moc/write.js";
import { FIELDS, lastSlotUsed, type FieldKey } from "../src/core/moc/schema.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import { outputTriangles, outputUvs } from "../src/core/eval/static-output.js";
import { Synth, spec1d2Grid } from "./support/synth.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const fr = Math.fround;

/** Loads a synthetic model with canvas flag bit 0 set, so outputs stay in model space. */
function instance(
  s: Synth,
  opts: Parameters<Synth["build"]>[0] = {},
): { model: MocModel; inst: ModelInstance } {
  s.canvas = { ...s.canvas, flags: 1 };
  const model = loadMoc(s.build(opts));
  const inst = new ModelInstance(model);
  inst.evaluate();
  return { model, inst };
}

const vertex = (inst: ModelInstance, mesh: number, k: number): [number, number] => [
  inst.drawableVertices[mesh]![2 * k]!,
  inst.drawableVertices[mesh]![2 * k + 1]!,
];

function expectNear(actual: [number, number], expected: [number, number], tol: number): void {
  expect(Math.abs(actual[0] - expected[0]), `x ${actual[0]} vs ${expected[0]}`).toBeLessThanOrEqual(
    tol,
  );
  expect(Math.abs(actual[1] - expected[1]), `y ${actual[1]} vs ${expected[1]}`).toBeLessThanOrEqual(
    tol,
  );
}

describe("schema", () => {
  it("maps every slot 2–166 exactly once, matching the per-version slot ranges", () => {
    const slots = FIELDS.map((f) => f.slot).sort((a, b) => a - b);
    expect(slots).toEqual(Array.from({ length: 165 }, (_, i) => i + 2));
    for (const v of [1, 2, 3, 4, 5, 6]) {
      expect(Math.max(...FIELDS.filter((f) => f.since <= v).map((f) => f.slot))).toBe(
        lastSlotUsed(v),
      );
    }
  });
});

describe("§1d.3 rotation deformer inside a warp (v1 file: triangle mode)", () => {
  const build = (mirrorX: boolean) => {
    const s = new Synth(1);
    s.part({ id: "Root" });
    const w = s.warp({ id: "W", rows: 5, cols: 5, keyforms: [{ points: spec1d2Grid() }] });
    const r = s.rotation({
      id: "R",
      parent: w,
      keyforms: [{ angle: 20, x: 0.3, y: 0.6, scale: 0.01, mirrorX }],
    });
    s.mesh({ id: "M", deformer: r, keyforms: [{ positions: [0, 0, 10, 0, 0, 10, 7, -3] }] });
    return instance(s);
  };
  it("matches the table without mirroring", () => {
    const { inst } = build(false);
    expectNear(vertex(inst, 0, 0), [-0.431387, 0.183334], 3e-6);
    expectNear(vertex(inst, 0, 1), [-0.338634, 0.220709], 3e-6);
    expectNear(vertex(inst, 0, 2), [-0.468762, 0.276086], 3e-6);
    expectNear(vertex(inst, 0, 3), [-0.355247, 0.181671], 3e-6);
  });
  it("matches the table with mirror-x", () => {
    const { inst } = build(true);
    expectNear(vertex(inst, 0, 0), [-0.431387, 0.183334], 3e-6);
    expectNear(vertex(inst, 0, 1), [-0.524139, 0.145958], 3e-6);
    expectNear(vertex(inst, 0, 2), [-0.468762, 0.276086], 3e-6);
    expectNear(vertex(inst, 0, 3), [-0.485101, 0.129345], 3e-6);
  });
});

describe("§1d.2 bilinear mode through a v2 file", () => {
  it("maps a mesh vertex through a bilinear root warp", () => {
    const s = new Synth(2);
    s.part({ id: "Root" });
    const w = s.warp({
      id: "W",
      rows: 5,
      cols: 5,
      bilinear: true,
      keyforms: [{ points: spec1d2Grid() }],
    });
    s.mesh({ id: "M", deformer: w, keyforms: [{ positions: [0.5, 0.5, 0.13, 0.77, 3.5, 0.5] }] });
    const { inst } = instance(s);
    expectNear(vertex(inst, 0, 0), [-0.035855, 0.033684], 2e-6);
    expectNear(vertex(inst, 0, 1), [-0.756602, 0.503372], 2e-6);
    expectNear(vertex(inst, 0, 2), [5.993145, -0.07796], 2e-6);
  });
});

describe("§1d.4 worked examples", () => {
  it("a) rotation inside a rotation with parent mirror-y", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const p = s.rotation({
      id: "P",
      keyforms: [{ angle: 30, x: 0.1, y: 0.2, scale: 0.002, mirrorY: true }],
    });
    const c = s.rotation({
      id: "C",
      parent: p,
      baseAngle: 5,
      keyforms: [{ angle: 10, x: 50, y: 0, scale: 1.5 }],
    });
    s.mesh({ id: "M", deformer: c, keyforms: [{ positions: [0, 0, 20, 10, 0, 0] }] });
    const { inst } = instance(s);
    expectNear(vertex(inst, 0, 0), [0.186603, 0.25], 2e-6);
    expectNear(vertex(inst, 0, 1), [0.165389, 0.18636], 2e-6);
  });

  it("b) glue", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const a = s.mesh({ id: "A", keyforms: [{ positions: [0, 0] }] });
    const b = s.mesh({ id: "B", keyforms: [{ positions: [1, 0.5] }] });
    s.glue({ id: "G", a, b, pairs: [[0, 0.25, 0, 0.75]], intensities: [0.5] });
    const { inst } = instance(s);
    expectNear(vertex(inst, a, 0), [0.125, 0.0625], 1e-7);
    expectNear(vertex(inst, b, 0), [0.625, 0.3125], 1e-7);
  });

  it("b') later glues see the results of earlier ones (sequential application)", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const a = s.mesh({ id: "A", keyforms: [{ positions: [0, 0] }] });
    const b = s.mesh({ id: "B", keyforms: [{ positions: [1, 0] }] });
    const c = s.mesh({ id: "C", keyforms: [{ positions: [0, 1] }] });
    s.glue({ id: "G1", a, b, pairs: [[0, 0.5, 0, 0.5]] });
    s.glue({ id: "G2", a, b: c, pairs: [[0, 0.5, 0, 0.5]] });
    const { inst } = instance(s);
    expectNear(vertex(inst, b, 0), [0.5, 0], 1e-7);
    expectNear(vertex(inst, a, 0), [0.25, 0.5], 1e-7);
    expectNear(vertex(inst, c, 0), [0.25, 0.5], 1e-7);
  });

  /**
   * §1d.4's example, its blend-shape keyforms stored as deltas from the base
   * (zeros at the base key) as genuine files do. With `absolute`, they hold
   * the example's absolute values instead: the base keyform is then not read
   * (S4), so it acts as zeros.
   */
  const constrained = (version: number, absolute = false) => {
    const s = new Synth(version);
    s.part({ id: "Root" });
    const bs = s.param("BS", -1, 1, 0, { type: 1 });
    const c1 = s.param("C1", 0, 1, 0);
    const c2 = s.param("C2", 0, 1, 0);
    const m = s.mesh({ id: "M", keyforms: [{ positions: [10, 0], opacity: 1 }] });
    const base = absolute ? { x: 10, opacity: 1 } : { x: 0, opacity: 0 };
    s.blendShape("mesh", m, {
      param: bs,
      keys: [-1, 0, 1],
      base: 1,
      keyforms: [
        { positions: [4 - 10 + base.x, 0], opacity: base.opacity },
        { positions: [base.x, 0], opacity: base.opacity },
        { positions: [22 - 10 + base.x, 0], opacity: -0.5 + base.opacity },
      ],
      constraints: [
        { param: c1, keys: [0, 1], weights: [1, 0] },
        { param: c2, keys: [0, 1], weights: [1, 0.2] },
      ],
    });
    const { model, inst } = instance(s);
    inst.setParameter(model.parameters.ids.indexOf("BS"), 0.5);
    inst.setParameter(model.parameters.ids.indexOf("C1"), 0.25);
    inst.setParameter(model.parameters.ids.indexOf("C2"), 0.6);
    inst.evaluate();
    return inst;
  };

  it("c) blend shape with constraints uses the minimum weight (v5: positions and opacity)", () => {
    const inst = constrained(5);
    expect(vertex(inst, 0, 0)[0]).toBeCloseTo(13.12, 5);
    // Opacity: s = lerp(0, −0.5, 0.5) = −0.25, weight 0.52.
    expect(inst.drawableOpacity[0]).toBeCloseTo(1 - 0.25 * 0.52, 6);
  });

  it("c') v4 files apply blend shapes to positions only", () => {
    const inst = constrained(4);
    expect(vertex(inst, 0, 0)[0]).toBeCloseTo(13.12, 5);
    expect(inst.drawableOpacity[0]).toBe(1);
  });

  it("c'') a non-zero base keyform is not read (S4): absolute keyforms act as deltas from zero", () => {
    const inst = constrained(5, true);
    // s = lerp(0, 22, 0.5) = 11 (the base key's 10 reads as 0): 10 + 0.52·11.
    expect(vertex(inst, 0, 0)[0]).toBeCloseTo(10 + 0.52 * 11, 5);
    // Opacity: s = 0.25, so 1 + 0.52·0.25 = 1.13, clamped to 1: a version-5
    // target's own opacity is clamped to [0, 1].
    expect(inst.drawableOpacity[0]).toBe(1);
  });

  const colorChain = (version: number) => {
    const s = new Synth(version);
    s.part({ id: "Root" });
    const w = s.warp({
      id: "W",
      rows: 1,
      cols: 1,
      keyforms: [{ points: [0, 0, 1, 0, 0, 1, 1, 1], multiply: [0.5, 1, 1], screen: [0.2, 0, 0] }],
    });
    const r = s.rotation({
      id: "R",
      parent: w,
      keyforms: [
        { angle: 0, x: 0.5, y: 0.5, scale: 1, multiply: [0.8, 0.5, 1], screen: [0.5, 0, 0] },
      ],
    });
    s.mesh({
      id: "M",
      deformer: r,
      keyforms: [{ positions: [0, 0], multiply: [1.5, 1, 0.2], screen: [0, 0.4, 0] }],
    });
    return instance(s).inst;
  };

  for (const version of [4, 5]) {
    it(`d) colors accumulate down the chain and clamp once at the end (v${version})`, () => {
      const inst = colorChain(version);
      const mult = Array.from(inst.drawableMultiply.subarray(0, 3));
      const scr = Array.from(inst.drawableScreen.subarray(0, 3));
      [0.6, 0.5, 0.2].forEach((e, i) => expect(mult[i]).toBeCloseTo(e, 6));
      [0.6, 0.4, 0].forEach((e, i) => expect(scr[i]).toBeCloseTo(e, 6));
    });
  }

  it("d') files before v4 have no colors", () => {
    const inst = colorChain(3);
    expect(Array.from(inst.drawableMultiply.subarray(0, 3))).toEqual([1, 1, 1]);
    expect(Array.from(inst.drawableScreen.subarray(0, 3))).toEqual([0, 0, 0]);
  });

  it("e) render order with an inactive drawable, a part object and an offscreen (v6)", () => {
    const s = new Synth(6);
    s.part({ id: "Root" });
    const P = s.part({ id: "P", parent: 0, keyforms: [{ drawOrder: 300 }] });
    s.offscreen({ part: P, keyforms: [{ opacity: 1 }] });
    const mk = (id: string, drawOrder: number, part = 0, enabled = true) =>
      s.mesh({ id, part, enabled, keyforms: [{ positions: [0, 0], drawOrder }] });
    const A = mk("A", 500);
    const B = mk("B", 300);
    const C = mk("C", 700, 0, false);
    const D = mk("D", 300);
    const E = mk("E", 600, P);
    const F = mk("F", 200, P);
    s.groups = [
      {
        min: 100,
        max: 900,
        objects: [
          { kind: 0, index: A },
          { kind: 0, index: B },
          { kind: 0, index: C },
          { kind: 1, index: P, nested: 1 },
          { kind: 0, index: D },
        ],
      },
      {
        min: 200,
        max: 600,
        objects: [
          { kind: 0, index: E },
          { kind: 0, index: F },
        ],
      },
    ];
    const { inst } = instance(s);
    expect(Array.from(inst.drawableRenderOrder)).toEqual([6, 1, 0, 5, 4, 3]);
    expect(Array.from(inst.offscreenRenderOrder)).toEqual([2]);
  });

  it("f) offscreen opacity chains stop at the next part that owns an offscreen (v6)", () => {
    const s = new Synth(6);
    const T = s.part({ id: "T" });
    const S = s.part({ id: "S", parent: T });
    const R = s.part({ id: "R", parent: S });
    const Q = s.part({ id: "Q", parent: R });
    s.offscreen({ part: Q, keyforms: [{ opacity: 0.6 }] }); // offscreen 0
    s.offscreen({ part: S, keyforms: [{ opacity: 1 }] }); // offscreen 1
    const dQ = s.mesh({ id: "inQ", part: Q, keyforms: [{ positions: [0, 0], opacity: 0.9 }] });
    const dR = s.mesh({ id: "inR", part: R, keyforms: [{ positions: [0, 0], opacity: 0.9 }] });
    const dT = s.mesh({ id: "inT", part: T, keyforms: [{ positions: [0, 0], opacity: 0.9 }] });
    s.groups = [
      {
        min: 0,
        max: 1000,
        objects: [
          { kind: 0, index: dT },
          { kind: 1, index: S, nested: 1 },
        ],
      },
      {
        min: 0,
        max: 1000,
        objects: [
          { kind: 0, index: dR },
          { kind: 1, index: Q, nested: 2 },
        ],
      },
      { min: 0, max: 1000, objects: [{ kind: 0, index: dQ }] },
    ];
    const { inst } = instance(s);
    for (const [p, o] of [
      [T, 0.7],
      [S, 0.9],
      [R, 0.5],
      [Q, 0.8],
    ] as const)
      inst.setPartOpacity(p, o);
    inst.evaluate();
    expect(inst.offscreenOpacity[0]).toBeCloseTo(0.24, 6);
    expect(inst.offscreenOpacity[1]).toBeCloseTo(0.63, 6);
    expect(inst.drawableOpacity[dQ]).toBeCloseTo(0.9, 6);
    expect(inst.drawableOpacity[dR]).toBeCloseTo(0.45, 6);
    expect(inst.drawableOpacity[dT]).toBeCloseTo(0.63, 6);
  });

  it("g) output conversion and its canvas-flag opt-out", () => {
    const make = (flags: number) => {
      const s = new Synth(5);
      s.part({ id: "Root" });
      s.mesh({
        id: "M",
        uvs: [0.3, 0.2, 0, 0, 1, 1],
        triangles: [0, 1, 2],
        keyforms: [{ positions: [0.25, -0.5, 0, 0, 1, 1] }],
      });
      s.canvas = { ...s.canvas, flags };
      const model = loadMoc(s.build());
      const inst = new ModelInstance(model);
      inst.evaluate();
      return { model, inst };
    };
    const normal = make(0);
    expect(vertex(normal.inst, 0, 0)).toEqual([0.25, 0.5]);
    expect(outputUvs(normal.model, 0)[1]).toBeCloseTo(0.8, 6);
    expect(Array.from(outputTriangles(normal.model, 0))).toEqual([2, 1, 0]);
    const flagged = make(1);
    expect(vertex(flagged.inst, 0, 0)).toEqual([0.25, -0.5]);
    expect(outputUvs(flagged.model, 0)[1]).toBeCloseTo(0.2, 6);
    expect(Array.from(outputTriangles(flagged.model, 0))).toEqual([0, 1, 2]);
  });
});

describe("§1c behaviours on crafted models", () => {
  it("takes mirror flags from the lower corner of the active cell", () => {
    const mirrored = (flagged: number, v: number) => {
      const s = new Synth(5);
      s.part({ id: "Root" });
      const p = s.param("P", -10, 10, 0);
      const band = s.band([s.binding(p, [-5, 0, 10])]);
      const r = s.rotation({
        id: "R",
        band,
        keyforms: [0, 1, 2].map((k) => ({
          angle: 0,
          x: 0,
          y: 0,
          scale: 1,
          mirrorX: k === flagged,
        })),
      });
      s.mesh({ id: "M", deformer: r, keyforms: [{ positions: [1, 0] }] });
      const { inst } = instance(s);
      inst.setParameter(0, v);
      inst.evaluate();
      return vertex(inst, 0, 0)[0] < 0;
    };
    expect([-5, -2, -0.5].map((v) => mirrored(0, v))).toEqual([true, true, true]);
    expect([0, 5, 9.9].map((v) => mirrored(0, v))).toEqual([false, false, false]);
    expect([-5, 0, 5, 9.9].map((v) => mirrored(1, v))).toEqual([false, true, true, true]);
    expect([5, 9.9, 10].map((v) => mirrored(2, v))).toEqual([false, false, true]);
  });

  it("wraps a bound repeat parameter for evaluation but reports it as given", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const p = s.param("R", -30, 30, 0, { repeat: true });
    const band = s.band([s.binding(p, [-30, 0, 30])]);
    s.mesh({ id: "M", band, keyforms: [-30, 0, 30].map((x) => ({ positions: [x, 0] })) });
    const { inst } = instance(s);
    inst.setParameter(0, 45);
    inst.evaluate();
    expect(vertex(inst, 0, 0)[0]).toBeCloseTo(-15, 5);
    expect(inst.parameterValues[0]).toBe(45);
  });

  it("clamps normal parameters and part opacities and writes them back", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    s.param("A", -30, 30, 0);
    s.mesh({ id: "M", keyforms: [{ positions: [0, 0] }] });
    const { inst } = instance(s);
    inst.setParameter(0, 45);
    inst.setPartOpacity(0, 1.5);
    expect(inst.parameterValues[0]).toBe(30);
    expect(inst.partOpacities[0]).toBe(1);
    inst.setPartOpacity(0, -0.5);
    expect(inst.partOpacities[0]).toBe(0);
  });

  it("applies part draw-order blend shapes (v5)", () => {
    // Deltas from the base (as genuine files store them), and the same with a non-zero
    // base keyform, which is not read (S4).
    for (const [base, expected] of [
      [0, 450],
      [900, 900],
    ] as const) {
      const s = new Synth(5);
      const bs = s.param("BS", -1, 1, 0, { type: 1 });
      const part = s.part({ id: "Root", keyforms: [{ drawOrder: 900 }] });
      s.blendShape("part", part, {
        param: bs,
        keys: [-1, 0],
        base: 1,
        keyforms: [{ drawOrder: base - 900 }, { drawOrder: base }],
      });
      s.mesh({ id: "M", keyforms: [{ positions: [0, 0] }] });
      const { inst } = instance(s);
      inst.setParameter(bs, -0.5);
      inst.evaluate();
      // s = lerp(base − 900, 0, 0.5): 900 − 450, or 900 + 0 with the base keyform at 900.
      expect(inst.partDrawOrder[part]).toBe(expected);
    }
  });

  it("propagates inactivity from parts, deformers and out-of-range bindings", () => {
    const s = new Synth(5);
    const root = s.part({ id: "Root" });
    const off = s.part({ id: "Off", parent: root, enabled: false });
    const p = s.param("P", 0, 1, 0);
    const narrow = s.band([s.binding(p, [0.5, 1])]);
    const w = s.warp({
      id: "W",
      band: narrow,
      rows: 1,
      cols: 1,
      keyforms: [0, 1].map(() => ({ points: [0, 0, 1, 0, 0, 1, 1, 1] })),
    });
    const inDisabledPart = s.mesh({ id: "a", part: off, keyforms: [{ positions: [0, 0] }] });
    const underWarp = s.mesh({ id: "b", deformer: w, keyforms: [{ positions: [0.5, 0.5] }] });
    const plain = s.mesh({ id: "c", keyforms: [{ positions: [0, 0] }] });
    const { inst } = instance(s);
    expect([
      inst.drawableVisible[inDisabledPart],
      inst.drawableVisible[underWarp],
      inst.drawableVisible[plain],
    ]).toEqual([0, 0, 1]);
    inst.setParameter(p, 0.7);
    inst.evaluate();
    expect(inst.drawableVisible[underWarp]).toBe(1);
  });

  it("uses the parent warp's accumulated scale and probe direction for a rotation inside a warp inside a rotation", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const r0 = s.rotation({ id: "R0", keyforms: [{ angle: 0, x: 0, y: 0, scale: 0.5 }] });
    const w = s.warp({
      id: "W",
      parent: r0,
      rows: 1,
      cols: 1,
      bilinear: true,
      keyforms: [{ points: [0, 0, 10, 0, 0, 10, 10, 10] }],
    });
    const p = s.param("A", 0, 90, 0);
    const band = s.band([s.binding(p, [0, 90])]);
    const r1 = s.rotation({
      id: "R1",
      parent: w,
      band,
      keyforms: [0, 90].map((angle) => ({ angle, x: 0.5, y: 0.5, scale: 1 })),
    });
    s.mesh({ id: "M", deformer: r1, keyforms: [{ positions: [2, 0] }] });
    const { inst } = instance(s);
    expectNear(vertex(inst, 0, 0), [3.5, 2.5], 1e-5);
    inst.setParameter(p, 90);
    inst.evaluate();
    expectNear(vertex(inst, 0, 0), [2.5, 3.5], 1e-5);
  });
});

describe("version-specific layout", () => {
  it("v1–v3: a parameter's key list is the union of its bindings' keys", () => {
    const s = new Synth(3);
    s.part({ id: "Root" });
    const p = s.param("P", -1, 1, 0);
    const b1 = s.band([s.binding(p, [0, 1])]);
    const b2 = s.band([s.binding(p, [0, 0.5, 1])]);
    const b3 = s.band([s.binding(p, [-1, 0])]);
    for (const [i, band] of [b1, b2, b3].entries()) {
      const n = [2, 3, 2][i]!;
      s.mesh({
        id: `M${i}`,
        band,
        keyforms: Array.from({ length: n }, () => ({ positions: [0, 0] })),
      });
    }
    const { model } = instance(s);
    expect(Array.from(model.parameters.keyLists[0]!)).toEqual([-1, 0, 0.5, 1]);
  });

  it("v4: keyform k of an object uses color entry firstColor + (k − firstKeyform)", () => {
    const s = new Synth(4);
    s.part({ id: "Root" });
    // Pad the color table so the object's first color entry is not 0.
    s.mesh({ id: "pad", keyforms: [{ positions: [0, 0] }] });
    const p = s.param("P", 0, 2, 0);
    const band = s.band([s.binding(p, [0, 1, 2])]);
    const m = s.mesh({
      id: "M",
      band,
      keyforms: [0.1, 0.2, 0.3].map((g) => ({
        positions: [0, 0],
        multiply: [1, g, 1] as [number, number, number],
      })),
    });
    const { inst } = instance(s);
    for (const [v, g] of [
      [0, 0.1],
      [1, 0.2],
      [2, 0.3],
    ] as const) {
      inst.setParameter(p, v);
      inst.evaluate();
      expect(inst.drawableMultiply[m * 3 + 1]).toBeCloseTo(g, 6);
    }
  });

  it("before v6, the blend mode comes from the legacy flags", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    for (const [i, flags] of [4, 5, 6, 14].entries())
      s.mesh({ id: `M${i}`, flags, keyforms: [{ positions: [0, 0] }] });
    expect(Array.from(loadMoc(s.build()).meshes.blendMode)).toEqual([0, 1, 2, 2]);
  });

  it("v6 reads the blend mode slot", () => {
    const s = new Synth(6);
    s.part({ id: "Root" });
    s.mesh({ id: "M", blendMode: 0x106, keyforms: [{ positions: [0, 0] }] });
    expect(loadMoc(s.build()).meshes.blendMode[0]).toBe(0x106);
  });
});

describe("encodings that must load identically", () => {
  const base = () => {
    const s = new Synth(6);
    s.part({ id: "Root" });
    const w = s.warp({ id: "W", rows: 5, cols: 5, keyforms: [{ points: spec1d2Grid() }] });
    const r = s.rotation({
      id: "R",
      parent: w,
      keyforms: [{ angle: 20, x: 0.3, y: 0.6, scale: 0.01 }],
    });
    s.mesh({ id: "M", deformer: r, keyforms: [{ positions: [0, 0, 10, 0, 0, 10, 7, -3] }] });
    return s;
  };
  const verts = (bytes: Uint8Array) => {
    const inst = new ModelInstance(loadMoc(bytes));
    inst.evaluate();
    return Array.from(inst.drawableVertices[0]!);
  };
  it("big-endian files", () => {
    const le = base().build();
    const be = base().build({ bigEndian: true });
    expect(be[5]).toBe(1);
    expect(loadMoc(be).bigEndian).toBe(true);
    expect(verts(be)).toEqual(verts(le));
  });
  it("misaligned sections and 64 appended zero bytes", () => {
    const le = base().build();
    expect(verts(base().build({ sectionShift: 4 }))).toEqual(verts(le));
    const padded = new Uint8Array(le.length + 64);
    padded.set(le);
    expect(verts(padded)).toEqual(verts(le));
  });
  it.skipIf(!HAVE_DEEPSEEK)("DeepSeek-chan rewritten little- and big-endian", () => {
    const original = readFileSync(join(DEEPSEEK, "大肥鱼.moc3"));
    const sections = readMocSections(original);
    const fields: Partial<Record<FieldKey, ArrayLike<number> | string[]>> = {};
    for (const [k, v] of sections.fields) if (v !== null) fields[k] = v;
    const counts: Record<number, number> = {};
    sections.counts.forEach((c, i) => (counts[i] = c));
    const rewritten = (bigEndian: boolean) =>
      writeMoc({ version: sections.version, canvas: sections.canvas, fields, counts, bigEndian });
    const a = new ModelInstance(loadMoc(original));
    const b = new ModelInstance(loadMoc(rewritten(true)));
    a.evaluate();
    b.evaluate();
    expect(
      Buffer.from(b.drawableRenderOrder.buffer).equals(Buffer.from(a.drawableRenderOrder.buffer)),
    ).toBe(true);
    for (let d = 0; d < a.drawableVertices.length; d++) {
      expect(
        Buffer.from(b.drawableVertices[d]!.buffer).equals(
          Buffer.from(a.drawableVertices[d]!.buffer),
        ),
      ).toBe(true);
    }
  });
});

describe("validation (§1b.7)", () => {
  /** A small valid v5 model with two parts, a warp, a rotation, two meshes and a binding. */
  const base = () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    s.part({ id: "Child", parent: 0 });
    const p = s.param("P", 0, 1, 0);
    const band = s.band([s.binding(p, [0, 1])]);
    const w = s.warp({
      id: "W",
      rows: 1,
      cols: 1,
      keyforms: [{ points: [0, 0, 1, 0, 0, 1, 1, 1] }],
    });
    s.rotation({ id: "R", parent: w, keyforms: [{ angle: 0, x: 0.5, y: 0.5, scale: 1 }] });
    s.mesh({
      id: "M0",
      deformer: w,
      band,
      keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }, { positions: [0, 0, 1, 0, 0, 1] }],
    });
    s.mesh({ id: "M1", part: 1, masks: [0, -1], keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
    return s;
  };
  type Fields = Partial<Record<FieldKey, number[] | string[]>>;
  const reject = (tamper: (f: Fields) => void, message: RegExp) => {
    expect(() => loadMoc(base().build({ tamper }))).toThrow(message);
    expect(() => loadMoc(base().build({ tamper }))).toThrow(MocFormatError);
  };
  const set = (f: Fields, key: FieldKey, index: number, value: number) => {
    (f[key] as number[])[index] = value;
  };

  it("accepts the untouched base model", () => {
    expect(() => loadMoc(base().build())).not.toThrow();
  });

  it("rejects header problems", () => {
    const ok = base().build();
    const patched = (at: number, value: number) => {
      const b = ok.slice();
      b[at] = value;
      return b;
    };
    expect(() => loadMoc(patched(0, 0x58))).toThrow(/magic/);
    expect(() => loadMoc(patched(4, 0))).toThrow(/version 0/);
    expect(() => loadMoc(patched(4, 7))).toThrow(/version 7/);
    expect(() => loadMoc(patched(5, 1))).toThrow(MocFormatError);
    const longer = new Uint8Array(ok.length + 1);
    longer.set(ok);
    expect(() => loadMoc(longer)).toThrow(/multiple of 64/);
    expect(() => loadMoc(ok.slice(0, ok.length - 64))).toThrow(/past end of file/);
    expect(() => loadMoc(ok.slice(0, 32))).toThrow(MocFormatError);
  });

  it("rejects a negative count", () => {
    const b = base().build();
    const dv = new DataView(b.buffer);
    const countTable = dv.getUint32(0x40, true);
    dv.setInt32(countTable + 4 * 4, -1, true); // art meshes
    expect(() => loadMoc(b)).toThrow(/negative count/);
  });

  it("rejects a name without NUL", () => {
    const b = base().build();
    const dv = new DataView(b.buffer);
    const meshIds = dv.getUint32(0x40 + 33 * 4, true);
    b.fill(0x41, meshIds, meshIds + 64);
    expect(() => loadMoc(b)).toThrow(/NUL/);
  });

  it("rejects each corrupted reference", () => {
    reject((f) => set(f, "part.parent", 1, 2), /parent/);
    reject((f) => set(f, "part.parent", 1, -2), /parent/);
    reject((f) => set(f, "deformer.kind", 0, 2), /unknown kind/);
    reject((f) => set(f, "deformer.kindIndex", 0, 5), /warp record/);
    reject((f) => set(f, "mesh.deformer", 0, 9), /parent deformer/);
    reject((f) => set(f, "mesh.texture", 0, -1), /negative texture/);
    reject((f) => set(f, "mesh.firstUv", 1, 1000), /UVs/);
    reject((f) => set(f, "maskEntries", 0, 7), /mask entry/);
    reject((f) => set(f, "meshKeyform.firstPosition", 0, 100000), /positions/);
    reject((f) => set(f, "bindingIndex", 0, 9), /binding-index entry/);
    reject((f) => set(f, "warp.pointCount", 0, 5), /grid points/);
    reject((f) => set(f, "groupObject.index", 0, 9), /draw-order object/);
    reject((f) => set(f, "groupObject.kind", 0, 2), /unknown kind/);
  });

  it("rejects what Mochi2D treats as undefined", () => {
    reject((f) => set(f, "part.parent", 0, 1), /earlier part/); // parent after itself
    reject((f) => set(f, "deformer.parent", 1, 1), /earlier deformer/); // own parent
    reject((f) => set(f, "triangleIndices", 0, 3), /≥ vertex count/);
    reject((f) => set(f, "mesh.triangleIndexCount", 0, 2), /multiple of 3/);
    reject((f) => set(f, "mesh.keyformCount", 0, 1), /bindings need/);
    reject((f) => set(f, "binding.keyCount", 0, 0), /no keys/);
    reject((f) => set(f, "keys", 0, 2), /ascending/);
    reject((f) => set(f, "parameter.min", 0, 2), /min/);
    reject((f) => set(f, "mesh.band", 0, 99), /keyform binding: index 99/); // past the bands: refused
  });

  it("accepts what the official level accepts and is well defined", () => {
    const ok = (tamper: (f: Fields) => void) =>
      expect(() => loadMoc(base().build({ tamper }))).not.toThrow();
    ok((f) => set(f, "parameter.default", 0, 5)); // default outside [min, max]
    ok((f) => {
      (f["mesh.id"] as string[])[1] = "M0"; // duplicate IDs
    });
    const s = base();
    s.canvas = { ...s.canvas, pixelsPerUnit: 0 };
    expect(() => loadMoc(s.build())).not.toThrow();
  });

  it("finds the first object for a duplicate ID", () => {
    const m = loadMoc(base().build({ tamper: (f) => ((f["mesh.id"] as string[])[1] = "M0") }));
    const inst = new ModelInstance(m);
    expect(m.meshes.ids.indexOf("M0")).toBe(0);
    expect(inst.parameterIndex("P")).toBe(0);
  });
});

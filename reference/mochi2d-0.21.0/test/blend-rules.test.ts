/**
 * Two evaluation rules, on synthetic `.moc3` files.
 *
 * - C29: every evaluation adds an inactive art mesh's blend-shape position
 *   contribution to its reported vertices, in the mesh's keyform space (no
 *   deformer, no y negation), and the additions accumulate on the last
 *   active output, or on zeros.
 * - C30: draw order = trunc(trunc(D) + B) for art meshes, and for parts
 *   (with 14 part vectors that are tested here). The final formula, which
 *   adds a tolerance of 0.001 twice and clamps blend-shape targets at 0
 *   (test/eval-corrections.test.ts), replaced it; all of C30's vectors still
 *   hold under it.
 *
 * Every case runs with the WebAssembly and the JavaScript kernels, and with
 * and without incremental evaluation; the results must be bit-identical.
 */
import { describe, expect, it } from "vitest";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { ModelInstance, type InstanceOptions } from "../src/core/eval/instance.js";
import { wasmKernelsAvailable } from "../src/core/eval/kernels.js";
import { Synth } from "./support/synth.js";

const fr = Math.fround;

const MODES: InstanceOptions[] = [
  { kernels: "js" },
  { kernels: "js", incremental: false },
  ...(wasmKernelsAvailable()
    ? ([{ kernels: "wasm" }, { kernels: "wasm", incremental: false }] as InstanceOptions[])
    : []),
];

/**
 * A blend parameter BS (−10…10), a gate G (0…1) and a mesh M under a
 * rotation that is active only for G in [0.5, 1]. M's blend shape on BS
 * stores the deltas d at keys −10 and 10 and zeros at the base key 0, as
 * genuine files do (its base keyform is not read anyway, S4). The
 * canvas flips y (flag bit 0 clear), so active output has y negated.
 */
function gatedModel(gateDefault: number): { model: MocModel; bs: number; g: number } {
  const s = new Synth(5);
  s.canvas = { ...s.canvas, flags: 0 };
  s.part({ id: "Root" });
  const bs = s.param("BS", -10, 10, 0, { type: 1 });
  const g = s.param("G", 0, 1, gateDefault);
  const gate = s.band([s.binding(g, [0.5, 1])]);
  const rot = s.rotation({
    id: "R",
    band: gate,
    keyforms: [
      { angle: 90, x: 0.25, y: 0.5, scale: 0.01 },
      { angle: 90, x: 0.25, y: 0.5, scale: 0.01 },
    ],
  });
  const base = [10, 20, 30, 40, 50, 60];
  const m = s.mesh({ id: "M", deformer: rot, keyforms: [{ positions: base, drawOrder: 500 }] });
  s.blendShape("mesh", m, {
    param: bs,
    keys: [-10, 0, 10],
    base: 1,
    keyforms: [
      { positions: base.map((_, i) => [3.0779617, 6.6926445][i % 2]!), drawOrder: -20 },
      { positions: base.map(() => 0), drawOrder: 0 },
      { positions: base.map((_, i) => -[1, 2][i % 2]!), drawOrder: -20 },
    ],
  });
  return { model: loadMoc(s.build()), bs, g };
}

/** The contribution w·s of the blend shape at BS, per coordinate (one binding, w = 1). */
function contribution(bsValue: number): number[] {
  const delta = (bsValue <= 0 ? [3.0779617, 6.6926445] : [-1, -2]).map(fr);
  const out: number[] = [];
  for (let k = 0; k < 3; k++)
    for (let c = 0; c < 2; c++) {
      const d = delta[c]!;
      // s = Q(i) + t·(Q(i+1) − Q(i)) between the outer key and the base key (zeros).
      const s =
        bsValue <= 0
          ? fr(d + fr(fr(fr(bsValue + 10) / 10) * fr(0 - d)))
          : fr(0 + fr(fr(bsValue / 10) * fr(d - 0)));
      out.push(fr(1 * s));
    }
  return out;
}

const vertices = (inst: ModelInstance) => Array.from(inst.drawableVertices[0]!);

describe("C29: blend shapes on inactive art meshes accumulate", () => {
  it("a never-active mesh starts from zeros and gains the contribution at every evaluation", () => {
    const runs = MODES.map((mode) => {
      const { model, bs } = gatedModel(0); // G = 0: the rotation, so the mesh, is inactive
      const inst = new ModelInstance(model, mode); // the creation evaluation, at BS = 0
      const out: number[][] = [vertices(inst)];
      inst.setParameter(bs, -10);
      for (let n = 0; n < 3; n++) {
        inst.evaluate();
        out.push(vertices(inst));
      }
      inst.setParameter(bs, -5);
      inst.evaluate();
      out.push(vertices(inst));
      inst.setParameter(bs, 0);
      inst.evaluate();
      out.push(vertices(inst));
      expect(inst.drawableActive[0]).toBe(0);
      expect(inst.drawableDrawOrder[0]).toBe(0); // draw order is not touched
      return out;
    });
    const [first] = runs;
    expect(first![0]).toEqual([0, 0, 0, 0, 0, 0]);
    // Each evaluation at −10 adds the contribution again, in keyform space (y not negated).
    let acc = [0, 0, 0, 0, 0, 0];
    const c10 = contribution(-10);
    for (let n = 1; n <= 3; n++) {
      acc = acc.map((v, i) => fr(v + c10[i]!));
      expect(first![n]).toEqual(acc);
    }
    // Vertex 0 after three evaluations: three times the keyform offset (float32 sums).
    expect(first![3]![0]).toBe(fr(fr(c10[0]! + c10[0]!) + c10[0]!));
    // −5 adds half of it, 0 adds nothing.
    const c5 = contribution(-5);
    expect(first![4]).toEqual(acc.map((v, i) => fr(v + c5[i]!)));
    expect(first![5]).toEqual(first![4]);
    // Every kernel and mode agrees bit for bit.
    for (const r of runs.slice(1)) expect(r).toEqual(first);
  });

  it("a mesh active at creation keeps its creation output and gains the same additions", () => {
    const runs = MODES.map((mode) => {
      const { model, bs, g } = gatedModel(1); // active at creation
      const inst = new ModelInstance(model, mode);
      const creation = vertices(inst);
      expect(inst.drawableActive[0]).toBe(1);
      inst.setParameter(g, 0); // inactive from now on
      inst.setParameter(bs, 10);
      inst.evaluate();
      const once = vertices(inst);
      inst.evaluate();
      const twice = vertices(inst);
      // Active again: evaluated afresh from the keyforms, without the additions.
      inst.setParameter(g, 1);
      inst.setParameter(bs, 0);
      inst.evaluate();
      const again = vertices(inst);
      return { creation, once, twice, again };
    });
    const r = runs[0]!;
    const c = contribution(10);
    expect(r.once).toEqual(r.creation.map((v, i) => fr(v + c[i]!)));
    expect(r.twice).toEqual(r.once.map((v, i) => fr(v + c[i]!)));
    expect(r.again).toEqual(r.creation);
    // The creation output went through the rotation and the y flip; the additions did not.
    expect(r.creation[1]).toBeLessThan(0);
    expect(r.once[1]! - r.creation[1]!).toBeCloseTo(-2, 5);
    for (const other of runs.slice(1)) expect(other).toEqual(r);
  });

  it("repeated evaluations with unchanged inputs keep adding (also in incremental mode)", () => {
    for (const mode of MODES) {
      const { model, bs } = gatedModel(0);
      const inst = new ModelInstance(model, mode);
      inst.setParameter(bs, 10);
      const xs: number[] = [];
      for (let n = 0; n < 5; n++) {
        inst.evaluate();
        xs.push(inst.drawableVertices[0]![0]!);
      }
      expect(xs).toEqual([-1, -2, -3, -4, -5]);
      // The vertex version counts every change, for renderers that upload on change.
      expect(inst.drawableVertexVersion[0]).toBeGreaterThanOrEqual(5);
    }
  });
});

/**
 * A mesh whose draw order is a single keyform value D, with a blend shape on
 * BS whose draw-order keyforms are (−20, 0, ±20) at keys (−10, 0, 10): the
 * contribution B is 2·BS (or −2·|BS|).
 */
function drawOrderModel(D: number, positiveSide: boolean) {
  const s = new Synth(5);
  s.part({ id: "Root" });
  const bs = s.param("BS", -10, 10, 0, { type: 1 });
  const m = s.mesh({ id: "M", keyforms: [{ positions: [0, 0, 1, 0, 0, 1], drawOrder: D }] });
  s.blendShape("mesh", m, {
    param: bs,
    keys: [-10, 0, 10],
    base: 1,
    keyforms: [
      { positions: [0, 0, 1, 0, 0, 1], drawOrder: -20 },
      { positions: [0, 0, 1, 0, 0, 1], drawOrder: 0 },
      { positions: [0, 0, 1, 0, 0, 1], drawOrder: positiveSide ? 20 : -20 },
    ],
  });
  return { model: loadMoc(s.build()), bs };
}

describe("C30's vectors, under the final draw-order formula", () => {
  // The vectors of C30: [D, B, expected, old rule].
  const vectors: [number, number, number, number][] = [
    [519.4, -2.2, 516, 517],
    [517.390011, -2.138935, 514, 515],
    [502.291201, -4.014264, 497, 498],
    [505.621, 8.8, 513, 514],
  ];

  it.each(vectors)("art mesh: D %f, B %f → %i (the old rule gave %i)", (D, B, expected, old) => {
    for (const mode of MODES) {
      const { model, bs } = drawOrderModel(D, B > 0);
      const inst = new ModelInstance(model, mode);
      inst.setParameter(bs, B / 2); // the blend draw order moves 2 per unit of BS
      inst.evaluate();
      expect(inst.drawableDrawOrder[0]).toBe(expected);
      expect(Math.trunc(fr(D) + B)).toBe(old);
    }
  });

  it("integer draw orders and draw orders without blend shapes are unchanged", () => {
    const { model, bs } = drawOrderModel(519, false);
    const inst = new ModelInstance(model);
    inst.setParameter(bs, -1.1);
    inst.evaluate();
    expect(inst.drawableDrawOrder[0]).toBe(516); // trunc(519 − 2.2) under both rules
    inst.setParameter(bs, 0);
    inst.evaluate();
    expect(inst.drawableDrawOrder[0]).toBe(519);
  });

  // The part vectors, both signs of B: [HipAngleX h, Param33 b, new rule, old
  // rule]. The part's draw-order keyforms are 499, 500, 501 at h = −30, 0, 30 (D = 500 + h/30), and its
  // blend shape on b holds +1, 0, −1 at keys −1, 0, 1 (base key 0), so B = −b.
  const partVectors: [number, number, number, number][] = [
    [12, 0.2, 499, 500],
    [3, 0.05, 499, 500],
    [-18, -0.8, 499, 500],
    [-27, -0.95, 499, 500],
    [27, -0.3, 500, 501],
    [12, -0.7, 500, 501],
    [12, 0, 500, 500],
    [12, 0.5, 499, 499],
    [-18, -0.5, 499, 499],
    [27, 0.95, 499, 499],
    [0, 0.3, 499, 499],
    [-30, 0, 499, 499],
    [30, 0, 501, 501],
    [0, 0, 500, 500],
  ];

  it.each(partVectors)(
    "part: HipAngleX %f, Param33 %f → %i (the old rule gave %i)",
    (h, b, expected, old) => {
      for (const mode of MODES) {
        const s = new Synth(5);
        const hip = s.param("HipAngleX", -30, 30, 0);
        const q = s.param("Param33", -1, 1, 0, { type: 1 });
        const band = s.band([s.binding(hip, [-30, 0, 30])]);
        const part = s.part({
          id: "Part18",
          band,
          keyforms: [{ drawOrder: 499 }, { drawOrder: 500 }, { drawOrder: 501 }],
        });
        s.blendShape("part", part, {
          param: q,
          keys: [-1, 0, 1],
          base: 1,
          keyforms: [{ drawOrder: 1 }, { drawOrder: 0 }, { drawOrder: -1 }],
        });
        s.mesh({ id: "M", keyforms: [{ positions: [0, 0] }] });
        const inst = new ModelInstance(loadMoc(s.build()), mode);
        inst.setParameter(hip, h);
        inst.setParameter(q, b);
        inst.evaluate();
        expect(inst.partDrawOrder[part]).toBe(expected);
        const D = fr(500 + fr(fr(h / 30) * 1));
        expect(Math.trunc(D - b)).toBe(old);
      }
    },
  );

  it("parts follow the same rule: an interpolated part draw order with a blend shape", () => {
    for (const mode of MODES) {
      const s = new Synth(5);
      const p = s.param("P", 0, 1, 0);
      const bs = s.param("BS", -10, 10, 0, { type: 1 });
      const band = s.band([s.binding(p, [0, 1])]);
      const part = s.part({ id: "Root", band, keyforms: [{ drawOrder: 500 }, { drawOrder: 520 }] });
      s.blendShape("part", part, {
        param: bs,
        keys: [-10, 0, 10],
        base: 1,
        keyforms: [{ drawOrder: -20 }, { drawOrder: 0 }, { drawOrder: -20 }],
      });
      s.mesh({ id: "M", keyforms: [{ positions: [0, 0] }] });
      const inst = new ModelInstance(loadMoc(s.build()), mode);
      inst.setParameter(p, 0.97); // D = 519.4
      inst.setParameter(bs, -1.1); // B = −2.2
      inst.evaluate();
      expect(inst.partDrawOrder[part]).toBe(516); // the old rule: 517
    }
  });

  it("a draw order that shares its keyform values with the opacity is still truncated first", () => {
    // Opacity and draw order hold the same numbers, so the plan may share their property.
    const s = new Synth(5);
    s.part({ id: "Root" });
    const bs = s.param("BS", -10, 10, 0, { type: 1 });
    const m = s.mesh({ id: "M", keyforms: [{ positions: [0, 0], opacity: 0.5, drawOrder: 0.5 }] });
    s.blendShape("mesh", m, {
      param: bs,
      keys: [-10, 0, 10],
      base: 1,
      keyforms: [
        { positions: [0, 0], opacity: 1.5, drawOrder: 1.5 },
        { positions: [0, 0], opacity: 0, drawOrder: 0 },
        { positions: [0, 0], opacity: 1.5, drawOrder: 1.5 },
      ],
    });
    const inst = new ModelInstance(loadMoc(s.build()));
    inst.setParameter(bs, 5); // contribution 0.75
    inst.evaluate();
    // 0.5 + 0.75 = 1.25, clamped to 1: a version-5 target's opacity is clamped.
    expect(inst.drawableOpacity[0]).toBe(1);
    expect(inst.drawableDrawOrder[0]).toBe(0); // trunc(trunc(0.5) + 0.75); the old rule gave 1
  });
});

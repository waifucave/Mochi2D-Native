/**
 * The experimental evaluation switches (`evaluation: { glue, blendShapes }`
 * on ModelInstance and RuntimeOptions):
 *
 * - left on, explicitly or by default, results are bit-identical with
 *   today's, in every kernel mode, on a synthetic model and on DeepSeek-chan;
 * - `glue: false` gives the results of the same model without its glues;
 * - `blendShapes: false` gives the results of the same model without its
 *   blend-shape keyform bindings;
 * - the runtime passes the option to its instance.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { ModelInstance, type EvaluationOptions } from "../src/core/eval/instance.js";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { ModelRuntime } from "../src/runtime/model-runtime.js";
import { Synth, type RGB } from "./support/synth.js";
import { MODES, output, same, type Output } from "./support/evaluate.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";
import { join } from "node:path";

const ZERO_COLORS = { multiply: [0, 0, 0] as RGB, screen: [0, 0, 0] as RGB };

/**
 * Two meshes glued 0–0, a parameter that moves mesh A, and blend shapes on
 * mesh A (positions, opacity, colors), on the glue's intensity and on the
 * part's draw order. Without glue or without blend shapes, the same model
 * minus that feature.
 */
function model(o: { glue?: boolean; blendShapes?: boolean } = {}): {
  bytes: Uint8Array;
  move: number;
  shape: number;
} {
  const s = new Synth(5);
  s.part({ id: "Root" });
  const move = s.param("Move", 0, 1, 0);
  const shape = s.param("Shape", 0, 1, 0, { type: 1 });
  const byMove = s.band([s.binding(move, [0, 1])]);
  const a = s.mesh({
    id: "A",
    band: byMove,
    keyforms: [
      { opacity: 1, positions: [0, 0, 0, 1, 1, 0] },
      { opacity: 0.5, positions: [3, 0, 3, 1, 4, 0] },
    ],
  });
  const b = s.mesh({ id: "B", keyforms: [{ opacity: 1, positions: [10, 0, 10, 1, 11, 0] }] });
  if (o.glue !== false) s.glue({ id: "G", a, b, pairs: [[0, 0.5, 0, 0.5]], intensities: [0.75] });
  if (o.blendShapes !== false) {
    s.blendShape("mesh", a, {
      param: shape,
      keys: [0, 1],
      base: 0,
      keyforms: [
        { opacity: 0, positions: [0, 0, 0, 0, 0, 0], ...ZERO_COLORS },
        {
          opacity: 0.25,
          positions: [1.5, -2, 0, 0, 0.5, 0.5],
          multiply: [-0.5, 0, 0],
          screen: [0.25, 0, 0],
        },
      ],
    });
    if (o.glue !== false)
      s.blendShape("glue", 0, { param: shape, keys: [0, 1], base: 0, keyforms: [0, -0.5] });
    s.blendShape("part", 0, { param: shape, keys: [0, 1], base: 0, keyforms: [0, 300] });
  }
  return { bytes: s.build(), move, shape };
}

const POSES: [move: number, shape: number][] = [
  [0, 0],
  [0.3, 0],
  [0, 0.6],
  [0.7, 1],
  [1, 0.25],
];

/** The outputs at each pose, in order, from one instance per mode (incremental within it). */
function run(m: MocModel, evaluation?: EvaluationOptions, ids = { move: 0, shape: 1 }): Output[] {
  const all = MODES.map((mode) => {
    const inst = new ModelInstance(m, { ...mode, ...(evaluation ? { evaluation } : {}) });
    return POSES.map(([mv, sh]) => {
      inst.setParameter(ids.move, mv);
      inst.setParameter(ids.shape, sh);
      inst.evaluate();
      return output(inst);
    });
  });
  for (const o of all.slice(1)) expect(same(o, all[0])).toBe(true);
  return all[0]!;
}

describe("evaluation switches", () => {
  const full = model();
  const m = loadMoc(full.bytes);

  it("left on, give today's results bit for bit, in every kernel mode", () => {
    const base = run(m);
    expect(same(run(m, {}), base)).toBe(true);
    expect(same(run(m, { glue: true, blendShapes: true }), base)).toBe(true);
    // The model does use both: the glue and the blend shapes move vertices.
    expect(same(run(m, { glue: false }), base)).toBe(false);
    expect(same(run(m, { blendShapes: false }), base)).toBe(false);
  });

  it("glue: false evaluates as the model without its glues", () => {
    const without = loadMoc(model({ glue: false }).bytes);
    expect(same(run(m, { glue: false }), run(without))).toBe(true);
  });

  it("blendShapes: false evaluates as the model without its blend shapes", () => {
    const without = loadMoc(model({ blendShapes: false }).bytes);
    expect(same(run(m, { blendShapes: false }), run(without))).toBe(true);
  });

  it("both off evaluate as the model without either", () => {
    const without = loadMoc(model({ glue: false, blendShapes: false }).bytes);
    expect(same(run(m, { glue: false, blendShapes: false }), run(without))).toBe(true);
  });

  it("instances with and without blend shapes can share one model", () => {
    const on = new ModelInstance(m);
    const off = new ModelInstance(m, { evaluation: { blendShapes: false } });
    for (const inst of [on, off]) {
      inst.setParameter(full.shape, 1);
      inst.evaluate();
    }
    const plain = new ModelInstance(loadMoc(model({ blendShapes: false }).bytes));
    plain.setParameter(full.shape, 1);
    plain.evaluate();
    expect(same(output(off), output(plain))).toBe(true);
    expect(same(output(on).vertices, output(off).vertices)).toBe(false);
  });

  it("ModelRuntime passes the option to its instance", async () => {
    const files = (bytes: Uint8Array) =>
      MemoryFileSource.fromFiles({
        "m.model3.json": JSON.stringify({
          Version: 3,
          FileReferences: { Moc: "m.moc3", Textures: [] },
        }),
        "m.moc3": bytes,
      });
    const vertices = async (evaluation?: EvaluationOptions) => {
      const rt = await ModelRuntime.load(files(full.bytes), "m.model3.json", { evaluation });
      rt.setParameter("Shape", 1);
      rt.update(0);
      return rt.instance.drawableVertices.map((v) => Array.from(v));
    };
    const ref = new ModelInstance(m, { evaluation: { glue: false, blendShapes: false } });
    ref.setParameter(full.shape, 1);
    ref.evaluate();
    expect(same(await vertices({ glue: false, blendShapes: false }), output(ref).vertices)).toBe(
      true,
    );
    expect(same(await vertices(), output(ref).vertices)).toBe(false);
  });
});

describe.skipIf(!HAVE_DEEPSEEK)("evaluation switches on DeepSeek-chan", () => {
  const ds = () => {
    const name = "大肥鱼.moc3";
    return loadMoc(new Uint8Array(readFileSync(join(DEEPSEEK, name))));
  };

  it("left on, give today's results bit for bit", () => {
    const m = ds();
    const pose = (inst: ModelInstance) => {
      for (let i = 0; i < m.parameters.ids.length; i += 3) {
        const lo = m.parameters.min[i]!;
        const hi = m.parameters.max[i]!;
        inst.setParameter(i, lo + (hi - lo) * ((i % 7) / 6));
      }
      inst.evaluate();
      return output(inst);
    };
    for (const kernels of ["js", "auto"] as const) {
      const base = pose(new ModelInstance(m, { kernels }));
      const on = pose(
        new ModelInstance(m, { kernels, evaluation: { glue: true, blendShapes: true } }),
      );
      expect(same(on, base)).toBe(true);
    }
  });
});

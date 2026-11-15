/**
 * The evaluation switches of Mochi2D 0.21.0 (`evaluation: { glue, blendShapes }`,
 * test/evaluation-switches.test.ts) as fixtures: the test's model, built with
 * the same calls of Mochi2D's own test builder (Synth), and the same model
 * without its glue, without its blend shapes and without either; and
 * Mochi2D's outputs of the full model at the test's poses with each setting
 * of the switches. Before writing them, the script checks what the test
 * checks: switches left on give the default results, and a switch off gives
 * the results of the model without that feature.
 *
 * The `evaluation_switches_0_21_0` unit test then requires Mochi2D Native's
 * outputs to be the same, bit for bit, through the C API.
 *
 * usage: node switches.mjs <outDir>   (writes the four .moc3 files and expected.json)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Synth, type RGB } from "../../reference/mochi2d-0.21.0/test/support/synth.js";
import { loadMoc, type MocModel } from "../../reference/mochi2d-0.21.0/src/core/moc/model.js";
import {
  ModelInstance,
  type EvaluationOptions,
} from "../../reference/mochi2d-0.21.0/src/core/eval/instance.js";

const out = process.argv[2];
if (!out) {
  console.error("usage: node switches.mjs <outDir>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const ZERO_COLORS = { multiply: [0, 0, 0] as RGB, screen: [0, 0, 0] as RGB };

/** The test's model: two meshes glued 0–0, blend shapes on mesh A, the glue and the part. */
function model(o: { glue?: boolean; blendShapes?: boolean } = {}): Uint8Array {
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
  void move;
  return s.build();
}

const POSES: [move: number, shape: number][] = [
  [0, 0],
  [0.3, 0],
  [0, 0.6],
  [0.7, 1],
  [1, 0.25],
];

interface Output {
  vertices: number[][];
  opacity: number[];
  drawOrder: number[];
  renderOrder: number[];
  multiply: number[];
  screen: number[];
  partDrawOrder: number[];
}

function output(inst: ModelInstance): Output {
  return {
    vertices: inst.drawableVertices.map((v) => Array.from(v)),
    opacity: Array.from(inst.drawableOpacity),
    drawOrder: Array.from(inst.drawableDrawOrder),
    renderOrder: Array.from(inst.drawableRenderOrder),
    multiply: Array.from(inst.drawableMultiply),
    screen: Array.from(inst.drawableScreen),
    partDrawOrder: Array.from(inst.partDrawOrder),
  };
}

/** The outputs at each pose, from one instance evaluated incrementally. */
function run(m: MocModel, evaluation?: EvaluationOptions): Output[] {
  const inst = new ModelInstance(m, evaluation ? { evaluation } : {});
  return POSES.map(([mv, sh]) => {
    inst.setParameter(0, mv);
    inst.setParameter(1, sh);
    inst.evaluate();
    return output(inst);
  });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const files: Record<string, Uint8Array> = {
  "full.moc3": model(),
  "no-glue.moc3": model({ glue: false }),
  "no-blend-shapes.moc3": model({ blendShapes: false }),
  "neither.moc3": model({ glue: false, blendShapes: false }),
};
const m = loadMoc(files["full.moc3"]!);
const cases: [string, EvaluationOptions, string][] = [
  ["on", { glue: true, blendShapes: true }, "full.moc3"],
  ["glue-off", { glue: false }, "no-glue.moc3"],
  ["blend-shapes-off", { blendShapes: false }, "no-blend-shapes.moc3"],
  ["both-off", { glue: false, blendShapes: false }, "neither.moc3"],
];
const expected: Record<string, { glue: boolean; blendShapes: boolean; same_as: string; outputs: Output[] }> = {};
const base = run(m);
for (const [name, evaluation, without] of cases) {
  const outputs = run(m, evaluation);
  // What Mochi2D's test checks: the switch's results are those of the model without the feature.
  if (!same(outputs, run(loadMoc(files[without]!)))) throw new Error(`${name}: not the model without it`);
  if (name === "on" ? !same(outputs, base) : same(outputs, base))
    throw new Error(`${name}: ${name === "on" ? "differs from" : "the same as"} the default`);
  expected[name] = {
    glue: evaluation.glue ?? true,
    blendShapes: evaluation.blendShapes ?? true,
    same_as: without,
    outputs,
  };
}
for (const [name, bytes] of Object.entries(files)) writeFileSync(join(out, name), bytes);
writeFileSync(
  join(out, "expected.json"),
  JSON.stringify({ producer: "Mochi2D 0.21.0 (tests/crosscheck/switches.ts)", poses: POSES, cases: expected }, null, 1) +
    "\n",
);
console.log(`switches: ${Object.keys(files).length} models, ${cases.length} cases × ${POSES.length} poses`);

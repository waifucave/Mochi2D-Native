/**
 * Evaluation vectors: one reference instance (Mochi2D's default, incremental,
 * as the conformance tool makes it) per model, evaluated step after step
 * while a few parameters or part opacities change at a time, sometimes none,
 * sometimes all, with values on keys, between them, out of range, huge, ±∞
 * and NaN (which scenario files cannot express). Every step's outputs are
 * recorded bit for bit, and again with Mochi2D's full evaluation
 * (incremental: false); mochi2d_check_eval replays the steps with Mochi2D
 * Native's instance in the same mode, and compares.
 */
import type { MocModel } from "../../reference/mochi2d-0.24.1/src/core/moc/model.js";
import { ModelInstance } from "../../reference/mochi2d-0.24.1/src/core/eval/instance.js";

function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A number for JSON: NaN and ±∞ as strings. */
type Num = number | "NaN" | "Infinity" | "-Infinity";
const num = (x: number): Num =>
  Number.isNaN(x) ? "NaN" : x === Infinity ? "Infinity" : x === -Infinity ? "-Infinity" : x;

export interface EvalCase {
  model: string;
  /** Mochi2D's evaluation mode: incremental (its default) or full. */
  incremental: boolean;
  steps: { params: [number, Num][]; parts: [number, Num][] }[];
  /** Per step: integer outputs, and float outputs as float32 bits (NaN as null). */
  ints: number[][];
  floats: (number | null)[][];
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bits = (x: number): number | null => {
  if (Number.isNaN(x)) return null;
  f32[0] = x;
  return u32[0]!;
};

/** The outputs in a fixed order (mochi2d_check_eval flattens Mochi2D Native's the same way). */
function record(inst: ModelInstance, c: EvalCase): void {
  const ints: number[] = [];
  const floats: (number | null)[] = [];
  const I = (a: ArrayLike<number>) => {
    for (let i = 0; i < a.length; i++) ints.push(a[i]!);
  };
  const F = (a: ArrayLike<number>) => {
    for (let i = 0; i < a.length; i++) floats.push(bits(a[i]!));
  };
  I(inst.drawableActive);
  I(inst.drawableVisible);
  I(inst.drawableDrawOrder);
  I(inst.drawableRenderOrder);
  I(inst.offscreenRenderOrder);
  I(inst.partActive);
  I(inst.partDrawOrder);
  I(inst.deformerActive);
  F(inst.parameterValues);
  F(inst.partOpacities);
  F(inst.drawableOpacity);
  F(inst.drawableMultiply);
  F(inst.drawableScreen);
  for (const v of inst.drawableVertices) F(v);
  F(inst.offscreenOpacity);
  F(inst.offscreenMultiply);
  F(inst.offscreenScreen);
  c.ints.push(ints);
  c.floats.push(floats);
}

export function evalVectors(path: string, model: MocModel, seed: number, steps = 40): EvalCase[] {
  const rnd = lcg(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const P = model.parameters.ids.length;
  const parts = model.parts.ids.length;
  const keysOf: number[][] = Array.from({ length: P }, () => []);
  for (let b = 0; b < model.bindings.keys.length; b++)
    keysOf[model.bindings.parameter[b]!]!.push(...Array.from(model.bindings.keys[b]!));
  const value = (p: number): number => {
    const lo = model.parameters.min[p]!;
    const hi = model.parameters.max[p]!;
    const r = rnd();
    if (r < 0.03) return NaN;
    if (r < 0.05) return rnd() < 0.5 ? Infinity : -Infinity;
    if (r < 0.07) return (rnd() < 0.5 ? -1 : 1) * 1e30;
    if (r < 0.35 && keysOf[p]!.length) return pick(keysOf[p]!);
    if (r < 0.45) return lo + (hi - lo) * 1.5 * (rnd() - 0.17);
    return lo + (hi - lo) * rnd();
  };
  const c: EvalCase = { model: path, incremental: true, steps: [], ints: [], floats: [] };
  const inst = new ModelInstance(model);
  for (let s = 0; s < steps; s++) {
    const step: EvalCase["steps"][number] = { params: [], parts: [] };
    const r = rnd();
    // Most steps change a few parameters; some none, some all.
    const n = r < 0.15 ? 0 : r < 0.25 ? P : 1 + Math.floor(rnd() * Math.min(3, P));
    for (let k = 0; k < n && P > 0; k++) {
      const p = n === P ? k : Math.floor(rnd() * P);
      const v = value(p);
      inst.setParameter(p, v);
      step.params.push([p, num(v)]);
    }
    if (parts > 0 && rnd() < 0.2) {
      const p = Math.floor(rnd() * parts);
      const v = pick([0, 1, 0.5, rnd(), NaN, -1, 2]);
      inst.setPartOpacity(p, v);
      step.parts.push([p, num(v)]);
    }
    inst.evaluate();
    c.steps.push(step);
    record(inst, c);
  }
  // The same steps with Mochi2D's full evaluation (incremental: false).
  const full: EvalCase = { model: path, incremental: false, steps: c.steps, ints: [], floats: [] };
  const again = new ModelInstance(model, { incremental: false });
  for (const step of c.steps) {
    const value = (x: Num) => (typeof x === "number" ? x : Number(x));
    for (const [p, v] of step.params) again.setParameter(p, value(v));
    for (const [p, v] of step.parts) again.setPartOpacity(p, value(v));
    again.evaluate();
    record(again, full);
  }
  return [c, full];
}

/** Steps where Mochi2D's incremental and full evaluations differ. */
export function modeDifferences(a: EvalCase, b: EvalCase): number {
  let n = 0;
  for (let s = 0; s < a.steps.length; s++)
    if (JSON.stringify(a.ints[s]) !== JSON.stringify(b.ints[s]) || JSON.stringify(a.floats[s]) !== JSON.stringify(b.floats[s])) n++;
  return n;
}

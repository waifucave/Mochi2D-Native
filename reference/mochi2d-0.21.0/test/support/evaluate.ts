/**
 * Evaluating a synthetic model in every kernel mode (WebAssembly and
 * JavaScript, with and without incremental evaluation), checking that the
 * modes agree bit for bit, and reading the outputs as plain arrays.
 */
import { expect } from "vitest";
import type { MocModel } from "../../src/core/moc/model.js";
import { ModelInstance, type InstanceOptions } from "../../src/core/eval/instance.js";
import { wasmKernelsAvailable } from "../../src/core/eval/kernels.js";

export const MODES: InstanceOptions[] = [
  { kernels: "js" },
  { kernels: "js", incremental: false },
  ...(wasmKernelsAvailable()
    ? ([
        { kernels: "wasm" },
        { kernels: "wasm", incremental: false },
        { kernels: "wasm-scalar" },
      ] as InstanceOptions[])
    : []),
];

export interface Output {
  active: number[];
  visible: number[];
  vertices: number[][];
  opacity: number[];
  drawOrder: number[];
  renderOrder: number[];
  multiply: number[];
  screen: number[];
  partDrawOrder: number[];
  offscreenOpacity: number[];
  offscreenMultiply: number[];
  offscreenScreen: number[];
  offscreenRenderOrder: number[];
}

export function output(inst: ModelInstance): Output {
  return {
    active: Array.from(inst.drawableActive),
    visible: Array.from(inst.drawableVisible),
    vertices: inst.drawableVertices.map((v) => Array.from(v)),
    opacity: Array.from(inst.drawableOpacity),
    drawOrder: Array.from(inst.drawableDrawOrder),
    renderOrder: Array.from(inst.drawableRenderOrder),
    multiply: Array.from(inst.drawableMultiply),
    screen: Array.from(inst.drawableScreen),
    partDrawOrder: Array.from(inst.partDrawOrder),
    offscreenOpacity: Array.from(inst.offscreenOpacity),
    offscreenMultiply: Array.from(inst.offscreenMultiply),
    offscreenScreen: Array.from(inst.offscreenScreen),
    offscreenRenderOrder: Array.from(inst.offscreenRenderOrder),
  };
}

/** Bit-level equality, −0 and NaN included. */
export function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object")
    return Object.keys(a).every((k) => same((a as never)[k], (b as never)[k]));
  return false;
}

/** Parameter values and part opacities, by index. */
export interface Pose {
  parameters?: Record<number, number>;
  parts?: Record<number, number>;
}

/**
 * Evaluates `model` at `pose` in every mode, on a fresh instance each (which
 * evaluates once at its defaults when created, so the incremental path runs
 * too), checks that the modes agree bit for bit, and returns the output.
 */
export function evaluateAll(model: MocModel, pose: Pose = {}): Output {
  const outs = MODES.map((mode) => {
    const inst = new ModelInstance(model, mode);
    for (const [p, v] of Object.entries(pose.parameters ?? {})) inst.setParameter(Number(p), v);
    for (const [p, v] of Object.entries(pose.parts ?? {})) inst.setPartOpacity(Number(p), v);
    inst.evaluate();
    return output(inst);
  });
  for (const o of outs.slice(1)) expect(same(o, outs[0])).toBe(true);
  return outs[0]!;
}

/** The float32 `n` steps from `x` (n < 0: toward −∞), crossing zero as the float line does. */
export function f32Step(x: number, n: number): number {
  const f = new Float32Array([x]);
  const u = new Int32Array(f.buffer);
  for (let i = 0; i < Math.abs(n); i++) {
    const up = n > 0;
    if (f[0] === 0) {
      u[0] = up ? 1 : -2147483647; // the smallest subnormal, of either sign
      continue;
    }
    // For positive floats the bit pattern grows with the value; for negative ones it shrinks.
    u[0] = u[0]! + (f[0]! > 0 === up ? 1 : -1);
  }
  return f[0]!;
}

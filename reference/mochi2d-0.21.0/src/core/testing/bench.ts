/**
 * Evaluation benchmark shared by the Node CLI and the browser harness. The
 * clock is injected because `performance` is not part of the core's
 * environment-free library.
 */
import type { MocModel } from "../moc/model.js";
import { ModelInstance } from "../eval/instance.js";
import type { KernelChoice } from "../eval/kernels.js";
import { applyRequest, type EvaluationRequest } from "../model/snapshot.js";
import { randomPoses } from "./poses.js";

export type BenchMode = "random-all" | "random-mixed" | "typical";

/** Commonly animated parameters (face, eyes, mouth, body, breathing). */
export const TYPICAL_PARAMETERS = [
  "ParamAngleX",
  "ParamAngleY",
  "ParamAngleZ",
  "ParamBodyAngleX",
  "ParamBodyAngleY",
  "ParamBodyAngleZ",
  "ParamEyeLOpen",
  "ParamEyeROpen",
  "ParamEyeBallX",
  "ParamEyeBallY",
  "ParamBrowLY",
  "ParamBrowRY",
  "ParamMouthOpenY",
  "ParamMouthForm",
  "ParamBreath",
];

/** Poses for a benchmark mode (deterministic for a seed). */
export function benchPoses(
  model: MocModel,
  mode: BenchMode,
  count: number,
  seed: number,
): EvaluationRequest[] {
  if (mode === "random-all") return randomPoses(model, count, seed, { coverage: 1, parts: 0 });
  if (mode === "random-mixed") return randomPoses(model, count, seed);
  const all = randomPoses(model, count, seed, { coverage: 1, parts: 0, overshoot: 0 });
  return all.map((p) => ({
    parameters: Object.fromEntries(
      TYPICAL_PARAMETERS.filter((id) => id in p.parameters).map((id) => [id, p.parameters[id]!]),
    ),
    partOpacities: {},
  }));
}

export interface BenchResult {
  mode: BenchMode;
  /** Kernel implementation measured. */
  backend: "wasm" | "wasm-scalar" | "js";
  poses: number;
  warmup: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  /** Mean milliseconds per evaluation stage (when requested). */
  stages?: Record<string, number>;
}

/** Private stage methods of ModelInstance, timed when `stages` is requested. */
const STAGES = [
  "locateBindings",
  "evaluateParts",
  "evaluateDeformers",
  "evaluateMeshes",
  "applyGlue",
  "convertOutput",
  "evaluateOffscreens",
  "computeRenderOrder",
];

export function benchmarkEvaluation(
  model: MocModel,
  mode: BenchMode,
  now: () => number,
  opts: {
    poses?: number;
    warmup?: number;
    seed?: number;
    stages?: boolean;
    kernels?: KernelChoice;
  } = {},
): BenchResult {
  const count = opts.poses ?? 300;
  const warmup = opts.warmup ?? 50;
  const poses = benchPoses(model, mode, count + warmup, opts.seed ?? 1);
  const inst = new ModelInstance(model, { kernels: opts.kernels ?? "auto" });
  const stageTotals: Record<string, number> = {};
  if (opts.stages) {
    const target = inst as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of STAGES) {
      const original = target[name];
      if (typeof original !== "function") continue;
      const bound = original.bind(inst);
      target[name] = (...a: unknown[]) => {
        const t = now();
        const r = bound(...a);
        stageTotals[name] = (stageTotals[name] ?? 0) + now() - t;
        return r;
      };
    }
  }
  const times: number[] = [];
  for (let i = 0; i < poses.length; i++) {
    applyRequest(inst, poses[i]!);
    const t = now();
    inst.evaluate();
    const dt = now() - t;
    if (i >= warmup) times.push(dt);
    if (i === warmup - 1) for (const k of Object.keys(stageTotals)) stageTotals[k] = 0;
  }
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const result: BenchResult = {
    mode,
    backend: inst.backend,
    poses: count,
    warmup,
    meanMs: mean,
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)]!,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
  };
  if (opts.stages)
    result.stages = Object.fromEntries(Object.entries(stageTotals).map(([k, v]) => [k, v / count]));
  return result;
}

/**
 * A smooth, deterministic animation for render benchmarks: the typical
 * parameters swing around their defaults at different slow frequencies, and
 * the eyes blink every 3 seconds. `time` is in seconds.
 */
export function animatedPose(model: MocModel, time: number): EvaluationRequest {
  const parameters: Record<string, number> = {};
  TYPICAL_PARAMETERS.forEach((id, k) => {
    const i = model.parameters.ids.indexOf(id);
    if (i < 0) return;
    const lo = model.parameters.min[i]!;
    const hi = model.parameters.max[i]!;
    const d = model.parameters.defaults[i]!;
    if (id === "ParamEyeLOpen" || id === "ParamEyeROpen") {
      const phase = time % 3;
      const closed = phase < 0.15 ? Math.sin((phase / 0.15) * Math.PI) : 0;
      parameters[id] = d + (lo - d) * closed;
      return;
    }
    const amp = 0.8 * Math.min(hi - d, d - lo) || 0.4 * (hi - lo);
    parameters[id] = d + amp * Math.sin(2 * Math.PI * (0.11 + 0.037 * k) * time + k);
  });
  return { parameters, partOpacities: {} };
}

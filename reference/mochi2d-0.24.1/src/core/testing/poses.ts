/**
 * Deterministic random poses for regression tests and benchmarks. Pure
 * TypeScript (no host APIs), so Node tests and the browser benchmark generate
 * identical poses from the same seed.
 */
import type { MocModel } from "../moc/model.js";
import type { EvaluationRequest } from "../model/snapshot.js";

/** Small, fast 32-bit PRNG (mulberry32). Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Parameters that drive keyforms or blend shapes (directly or as constraints). */
export function drivingParameters(model: MocModel): number[] {
  const used = new Set<number>();
  for (const b of model.bands) for (const x of b.bindings) used.add(model.bindings.parameter[x]!);
  for (const list of Object.values(model.blendShapes)) {
    for (const perObject of list) {
      for (const bs of perObject) {
        used.add(bs.parameter);
        for (const c of bs.constraints) used.add(c.parameter);
      }
    }
  }
  return [...used].sort((a, b) => a - b);
}

export interface PoseOptions {
  /** Fraction of driving parameters set per pose (1 = all). Default: varies per pose. */
  coverage?: number;
  /** Allow values up to this fraction of the range outside [min, max]. Default 0.1. */
  overshoot?: number;
  /** Number of part opacities to set per pose. Default: 0–10 at random. */
  parts?: number;
}

/**
 * Random poses over the model's driving parameters. Some values land exactly on
 * keys or within the 0.001 snapping band, and some fall outside the range, so
 * snapping, clamping and out-of-range activity are exercised.
 */
export function randomPoses(
  model: MocModel,
  count: number,
  seed: number,
  opts: PoseOptions = {},
): EvaluationRequest[] {
  const rnd = seededRandom(seed);
  const params = drivingParameters(model);
  const p = model.parameters;
  const poses: EvaluationRequest[] = [];
  for (let n = 0; n < count; n++) {
    const coverage = opts.coverage ?? [1, 0.5, 0.1, 0.02][n % 4]!;
    const overshoot = opts.overshoot ?? 0.1;
    const parameters: Record<string, number> = {};
    for (const i of params) {
      if (rnd() >= coverage) continue;
      const min = p.min[i]!;
      const max = p.max[i]!;
      const range = max - min;
      const r = rnd();
      let v: number;
      if (r < 0.1 && p.keyLists[i]!.length) {
        // Exactly on a key, or just inside the snapping band.
        const keys = p.keyLists[i]!;
        v = keys[Math.floor(rnd() * keys.length)]! + (rnd() < 0.5 ? 0 : (rnd() - 0.5) * 0.0019);
      } else {
        v = min - overshoot * range + rnd() * (1 + 2 * overshoot) * range;
      }
      parameters[p.ids[i]!] = v;
    }
    const partOpacities: Record<string, number> = {};
    const partCount = opts.parts ?? Math.floor(rnd() * 11);
    for (let k = 0; k < partCount; k++) {
      const part = Math.floor(rnd() * model.parts.ids.length);
      partOpacities[model.parts.ids[part]!] = -0.2 + rnd() * 1.4;
    }
    poses.push({ parameters, partOpacities });
  }
  return poses;
}

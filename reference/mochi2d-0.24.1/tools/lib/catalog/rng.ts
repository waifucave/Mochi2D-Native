/**
 * The deterministic number stream of the test catalog (4q and 4u): a
 * linear congruential generator, s ← (1664525·s + 1013904223) mod 2³², each
 * draw returning s / 2³². With it: the random lists R(seed), the jittered
 * steps J(n, seed; lo, span) and the dsrand scenario generator.
 */
import type { MocModel } from "../../../src/core/moc/model.js";

export class NumberStream {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    // 1664525·s needs more than 53 bits: split the multiplication.
    const s = this.s;
    const lo = (s & 0xffff) * 1664525;
    const hi = ((s >>> 16) * 1664525) & 0xffff;
    this.s = (lo + (hi << 16) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
}

/** R(seed): the first 64 draws (4u). */
export function randomList(seed: number, count = 64): number[] {
  const g = new NumberStream(seed);
  return Array.from({ length: count }, () => g.next());
}

/** J(n, seed; lo, span): Δᵢ = lo + span·uᵢ (4u). */
export function jitteredSteps(n: number, seed: number, lo = 1 / 30, span = 1 / 20): number[] {
  const g = new NumberStream(seed);
  return Array.from({ length: n }, () => lo + span * g.next());
}

/** Rounds to `digits` significant digits (as a double). */
export function roundSignificant(x: number, digits: number): number {
  return x === 0 ? 0 : Number(x.toPrecision(digits));
}

/** Parameter key lists (1b.6.6). */
function parameterKeys(model: MocModel): number[][] {
  return model.parameters.keyLists.map((k) => Array.from(k));
}

export interface StaticInputs {
  parameters: Record<string, number>;
  partOpacities: Record<string, number>;
  /** Parameter IDs in set (insertion) order. */
  order: string[];
}

/**
 * The starting state of the dsrand stream: 20261102 (4q, as corrected). Its first draws are 0.4753243600,
 * 0.5163225122 and 0.9656537434.
 */
export const DSRAND_SEED = 20261102;

/**
 * The dsrand generator of 4q: 300 scenarios from one stream. Returns the
 * inputs of scenarios 0 … count−1.
 */
export function dsrandInputs(model: MocModel, count = 300, seed = DSRAND_SEED): StaticInputs[] {
  const g = new NumberStream(seed);
  const P = model.parameters.ids.length;
  const partCount = model.parts.ids.length;
  const keys = parameterKeys(model);
  const out: StaticInputs[] = [];
  for (let s = 0; s < count; s++) {
    const mode = s % 4;
    const c =
      mode === 2 ? P : mode === 1 ? 60 + Math.floor(120 * g.next()) : 5 + Math.floor(25 * g.next());
    const set: number[] = [];
    const seen = new Set<number>();
    while (set.length < Math.min(c, P)) {
      const i = Math.floor(P * g.next());
      if (!seen.has(i)) {
        seen.add(i);
        set.push(i);
      }
    }
    const parameters: Record<string, number> = {};
    const order: string[] = [];
    for (const i of set) {
      const lo = model.parameters.min[i]!;
      const hi = model.parameters.max[i]!;
      const span = hi - lo;
      const r = g.next();
      let value: number;
      const k = keys[i]!;
      if (mode === 3 && k.length > 0 && r < 0.6) {
        const key = k[Math.floor(k.length * g.next())]!;
        const offset = [0, 0.0009, -0.0009, 0.0011, -0.0011, 0.002][Math.floor(6 * g.next())]!;
        value = key + offset;
      } else if (r < 0.08) value = lo - 0.2 * span * g.next();
      else if (r < 0.16) value = hi + 0.2 * span * g.next();
      else value = lo + span * g.next();
      const id = model.parameters.ids[i]!;
      parameters[id] = roundSignificant(Math.fround(value), 9);
      order.push(id);
    }
    const partOpacities: Record<string, number> = {};
    const q = g.next();
    if (q < 0.3) {
      const n = 1 + Math.floor(6 * g.next());
      for (let t = 0; t < n; t++) {
        const part = model.parts.ids[Math.floor(partCount * g.next())]!;
        const w = g.next();
        const opacity = w < 0.15 ? -0.2 + 1.4 * g.next() : g.next();
        partOpacities[part] = Math.round(opacity * 1e4) / 1e4; // a later draw overwrites
      }
    }
    out.push({ parameters, partOpacities, order });
  }
  return out;
}

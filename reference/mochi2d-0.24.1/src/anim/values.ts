/**
 * Values that animation reads and writes (3g):
 *
 * - model parameter values: float32, limited to their range (or wrapped, in
 *   the optional wrap mode), with a saved copy for the frame procedure (3j);
 * - free values for IDs the model does not have: doubles, start at 0, never
 *   limited, never restored;
 * - part opacities: float32, persistent; IDs not in the model get free
 *   opacity entries, used only by poses;
 * - the model opacity.
 *
 * Every parameter write goes through one rule (3g.1): limit (or wrap) first,
 * then blend with the stored value by the weight, then store as float32.
 */
import type { MocModel } from "../core/moc/model.js";

/** Wrap-around of 3g.2 for a value outside [lo, hi]. */
export function wrapValue(x: number, lo: number, hi: number): number {
  const L = hi - lo;
  const m = (d: number) => d - Math.floor(d / L) * L;
  if (x > hi) {
    const d = x - hi;
    return !Number.isFinite(d) || L === 0 ? hi : lo + m(d);
  }
  if (x < lo) {
    const d = lo - x;
    return !Number.isFinite(d) || L === 0 ? lo : hi - m(d);
  }
  return x;
}

export class AnimationValues {
  readonly ids: readonly string[];
  /** Current parameter values (float32). */
  readonly values: Float32Array;
  /** Saved parameter values (3j steps 1 and 3). */
  readonly saved: Float32Array;
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly repeat: Uint8Array;
  /** Free values (3g.3). */
  readonly free = new Map<string, number>();
  /** Wrap mode (3g.2), off by default. */
  wrap = false;
  readonly partIds: readonly string[];
  readonly partOpacities: Float32Array;
  /** Opacities of part IDs that are not in the model (used only by poses). */
  readonly freePartOpacities = new Map<string, number>();
  /** Model opacity (3g.5). */
  modelOpacity = 1;
  private readonly indexById = new Map<string, number>();
  private readonly partIndexById = new Map<string, number>();

  constructor(model: MocModel) {
    const p = model.parameters;
    this.ids = p.ids;
    this.values = Float32Array.from(p.defaults);
    this.saved = Float32Array.from(p.defaults);
    this.min = Float32Array.from(p.min);
    this.max = Float32Array.from(p.max);
    this.repeat = Uint8Array.from(p.repeat);
    p.ids.forEach((id, i) => this.indexById.has(id) || this.indexById.set(id, i));
    this.partIds = model.parts.ids;
    this.partOpacities = Float32Array.from(model.parts.initialOpacity);
    model.parts.ids.forEach((id, i) => this.partIndexById.has(id) || this.partIndexById.set(id, i));
  }

  /** Index of the parameter with this ID, or −1. */
  index(id: string): number {
    return this.indexById.get(id) ?? -1;
  }

  partIndex(id: string): number {
    return this.partIndexById.get(id) ?? -1;
  }

  /** The value of an ID: its parameter value, or its free value (0 if never written). */
  get(id: string): number {
    const i = this.indexById.get(id);
    return i === undefined ? (this.free.get(id) ?? 0) : this.values[i]!;
  }

  /** Limits (or, in wrap mode for repeating parameters, wraps) x to parameter i's range. */
  limit(i: number, x: number): number {
    const lo = this.min[i]!;
    const hi = this.max[i]!;
    if (this.wrap && this.repeat[i]) return wrapValue(x, lo, hi);
    return Math.min(Math.max(x, lo), hi);
  }

  /** 3g.1: set parameter i to x with weight w. */
  setAt(i: number, x: number, w = 1): void {
    const lim = this.limit(i, x);
    this.values[i] = w === 1 ? lim : this.values[i]! * (1 - w) + lim * w;
  }

  /** Sets an ID: a parameter by 3g.1, otherwise its free value (no limit, double). */
  set(id: string, x: number, w = 1): void {
    const i = this.indexById.get(id);
    if (i !== undefined) {
      this.setAt(i, x, w);
      return;
    }
    const c = this.free.get(id) ?? 0;
    this.free.set(id, w === 1 ? x : c * (1 - w) + x * w);
  }

  /** Adds x with weight w: sets v + x·w. */
  add(id: string, x: number, w = 1): void {
    this.set(id, this.get(id) + x * w);
  }

  addAt(i: number, x: number, w = 1): void {
    this.setAt(i, this.values[i]! + x * w);
  }

  /** Multiplies by x with weight w: sets v·(1 + (x − 1)·w). */
  multiply(id: string, x: number, w = 1): void {
    this.set(id, this.get(id) * (1 + (x - 1) * w));
  }

  /** 3j step 1: every model parameter takes its saved value. */
  restore(): void {
    this.values.set(this.saved);
  }

  /** 3j step 3: the saved values become the current ones. */
  save(): void {
    this.saved.set(this.values);
  }

  /** The opacity of a part, or of a free part entry (1 if never written). */
  partOpacity(id: string): number {
    const i = this.partIndexById.get(id);
    return i === undefined ? (this.freePartOpacities.get(id) ?? 1) : this.partOpacities[i]!;
  }

  setPartOpacity(id: string, v: number): void {
    const i = this.partIndexById.get(id);
    if (i === undefined) this.freePartOpacities.set(id, Math.fround(v));
    else this.partOpacities[i] = v;
  }
}

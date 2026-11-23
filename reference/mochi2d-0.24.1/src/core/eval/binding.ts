/**
 * Locating a parameter value on a binding's keys (§1c.2) and
 * applying parameter values (§1c.1). All in float32.
 */
import { KEY_EPSILON, fr } from "./f32.js";

export interface KeyLocation {
  /** Segment index i (0 … K−1). */
  index: number;
  /** Position within the segment; 0 means exactly on key i. */
  t: number;
  /** The value lies outside [f32(k₀ − ε), f32(k_{K−1} + ε)): below the lower bound, or at or above the upper one. */
  outOfRange: boolean;
}

/**
 * Locates float32 value `v` on ascending float32 `keys`: out-of-range test,
 * snapping to keys within ±ε, clamping, then interpolation. ε is the
 * tolerance of the binding's parameter, f32(10^−d) (S1; 0.001 for the usual
 * d = 3). The range test is half-open: in range exactly when
 * f32(k₀ − ε) ≤ v < f32(k_last + ε), so when f32(k_last + ε) = k_last the
 * last key itself is out of range. Snapping is strict at both bounds:
 * f32(kᵢ − ε) < v < f32(kᵢ + ε). Writes the segment index to index[at] and the position t
 * to t[at]; returns whether the value lies out of range. (Typed-array outputs
 * keep the per-frame path free of boxed numbers.)
 */
export function locateKeyAt(
  keys: ArrayLike<number>,
  v: number,
  index: Int32Array,
  t: Float32Array,
  at: number,
  eps: number = KEY_EPSILON,
): boolean {
  const K = keys.length;
  const first = keys[0]!;
  const last = keys[K - 1]!;
  const outOfRange = v < fr(first - eps) || v >= fr(last + eps);
  for (let i = 0; i < K; i++) {
    const k = keys[i]!;
    if (fr(k - eps) < v && v < fr(k + eps)) {
      index[at] = i;
      t[at] = 0;
      return outOfRange;
    }
  }
  if (v <= first) {
    index[at] = 0;
    t[at] = 0;
    return outOfRange;
  }
  if (v >= last) {
    index[at] = K - 1;
    t[at] = 0;
    return outOfRange;
  }
  // keys[i] <= v < keys[i+1]
  let i = 0;
  while (i + 1 < K && !(v < keys[i + 1]!)) i++;
  const ki = keys[i]!;
  index[at] = i;
  t[at] = fr(fr(v - ki) / fr(keys[i + 1]! - ki));
  return outOfRange;
}

/**
 * Locates `v` on the keys of a blend-shape binding (C1, which
 * corrects §1c.4 step 1): clamped to the first or last key, otherwise the
 * segment kᵢ ≤ v < kᵢ₊₁ with t = f32(f32(v − kᵢ) / f32(kᵢ₊₁ − kᵢ)). Unlike
 * parameter bindings (§1c.2) there is no snapping, and being out of range has
 * no effect.
 */
export function locateBlendKeyAt(
  keys: ArrayLike<number>,
  v: number,
  index: Int32Array,
  t: Float32Array,
  at: number,
): void {
  const K = keys.length;
  if (v <= keys[0]!) {
    index[at] = 0;
    t[at] = 0;
    return;
  }
  if (v >= keys[K - 1]!) {
    index[at] = K - 1;
    t[at] = 0;
    return;
  }
  let i = 0;
  while (i + 1 < K && !(v < keys[i + 1]!)) i++;
  const ki = keys[i]!;
  index[at] = i;
  t[at] = fr(fr(v - ki) / fr(keys[i + 1]! - ki));
}

const oneIndex = new Int32Array(1);
const oneT = new Float32Array(1);

/** {@link locateKeyAt} with the result in a {@link KeyLocation} (writes `out` and returns it). */
export function locateKey(
  keys: ArrayLike<number>,
  v: number,
  out: KeyLocation,
  eps: number = KEY_EPSILON,
): KeyLocation {
  out.outOfRange = locateKeyAt(keys, v, oneIndex, oneT, 0, eps);
  out.index = oneIndex[0]!;
  out.t = oneT[0]!;
  return out;
}

/**
 * The value evaluation uses for a parameter (§1c.1): clamped, or wrapped if
 * repeating. A repeating value is always wrapped, inside its range too: with L the minimum and Δ = f32(max − min),
 * u = f32(f32(v − L) / Δ), u′ = f32(u − ⌊u⌋), v′ = f32(f32(u′·Δ) + L). So the
 * maximum wraps to the minimum, and a value in range can move by an ulp.
 */
export function evaluationValue(given: number, min: number, max: number, repeat: boolean): number {
  const v = fr(given);
  if (!repeat) return v < min ? min : v > max ? max : v;
  const range = fr(max - min);
  if (!(range > 0)) return min;
  const u = fr(fr(v - min) / range);
  const w = fr(u - Math.floor(u));
  return fr(fr(w * range) + min);
}

/**
 * The value reported after applying (§1c.1): clamped for normal parameters, as
 * given for repeat ones (Mochi2D keeps a repeating parameter's value as
 * given, not wrapped).
 */
export function appliedValue(given: number, min: number, max: number, repeat: boolean): number {
  const v = fr(given);
  if (repeat) return v;
  return v < min ? min : v > max ? max : v;
}

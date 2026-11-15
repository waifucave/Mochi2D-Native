/**
 * Float32 arithmetic (§1a "numeric model"). Every operation is
 * rounded to float32. For +, −, × and ÷ on float32 inputs, computing in
 * float64 and rounding once gives exactly the float32 result.
 */
export const fr = Math.fround;

/** f32(a + t·(b − a)), rounding after each operation. */
export function lerp32(a: number, b: number, t: number): number {
  return fr(a + fr(t * fr(b - a)));
}

/** f32(0.001): the key snapping / range tolerance of §1c.2 for 3 decimal places. */
export const KEY_EPSILON = fr(0.001);

/**
 * The key snapping / range tolerance of a parameter with `decimals` decimal
 * places (slot 55): ε = f32(10^−d) (S1). It is KEY_EPSILON for
 * d = 3, and 0 once 10^−d is below float32's smallest value. Negative d is
 * rejected when a file is loaded; it would give 10^|d| here.
 */
export function keyTolerance(decimals: number): number {
  // The decimal literal is parsed with correct rounding, unlike 10 ** -d.
  return decimals >= 0 ? fr(Number(`1e-${decimals}`)) : fr(10 ** -decimals);
}

/**
 * The fixed tolerance of the draw-order formula: f32(0.001),
 * whatever the parameters' decimal places.
 */
export const DRAW_ORDER_TOLERANCE = fr(0.001);

/** The draw-order range of a blend-shape target from version 5: 0 to 1000. */
export const TARGET_DRAW_ORDER_MAX = 1000;

/**
 * The draw order that a single keyform value `v` gives without blend-shape
 * contributions: n = trunc(f32(v + 0.001)), and for a blend-shape target from
 * version 5, min(1000, max(0, trunc(f32(n + 0.001)))) (version-4 targets
 * are not clamped). Group ranges are compared
 * with this value, not with `v`.
 */
export function keyformDrawOrder(v: number, target: boolean, version: number): number {
  const n = Math.trunc(fr(v + DRAW_ORDER_TOLERANCE));
  if (!target || version < 5) return n;
  return Math.min(TARGET_DRAW_ORDER_MAX, Math.max(0, Math.trunc(fr(n + DRAW_ORDER_TOLERANCE))));
}

/**
 * The clamp of a blend-shape target's own value (version 5):
 * NaN passes through, ±∞ go to the bounds.
 */
export function clampTarget(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** A target rotation's scale range: [f32(10⁻⁴), 100]. */
export const TARGET_SCALE_MIN = fr(1e-4);
export const TARGET_SCALE_MAX = 100;
/** A target rotation's keyform angle range, before the base and parent angles: [−3600, 3600]. */
export const TARGET_ANGLE_LIMIT = 3600;

/** π in float32. */
export const PI_32 = fr(Math.PI);
/** 2π and π/2 in float32 (2π_f is exactly 2·π_f). */
export const TWO_PI_32 = fr(2 * Math.PI);
export const HALF_PI_32 = fr(Math.PI / 2);
/**
 * A rotation's angle in degrees → radians, f32(f32(a·f32(π)) / 180), with
 * no reduction modulo 360.
 */
export function radians32(degrees: number): number {
  return fr(fr(degrees * PI_32) / 180);
}

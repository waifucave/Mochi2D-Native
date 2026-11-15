/**
 * A rotation deformer's world form: its
 * angle under a parent, read back from two mapped probe points, and its
 * cosine and sine with the world scale folded in. The probe mapping itself
 * runs through the parent's kernels (ModelInstance).
 */
import { atan2f, cosf, sinf } from "../math/libm32.js";
import { HALF_PI_32, PI_32, TWO_PI_32, fr, radians32 } from "./f32.js";

/** The probe length under a rotation parent, and under a warp parent, f32(0.1). */
export const PROBE_ROTATION = 10;
export const PROBE_WARP = fr(0.1);

/**
 * The angle θ, in degrees, of a rotation with keyform angle `a` and base
 * angle `base` under a parent that maps its origin to O and the probe point
 * a length L above it (file coordinates, y down) to Q: the parent's
 * orientation P is the probe's direction minus that of the unmapped probe
 * (0, −L), whose float32 arctangent is −f32(π/2), wrapped into [−π_f, π_f]
 * and taken to degrees; then θ = f32(f32(a + P) + base), the base added last.
 */
export function probedAngle(
  a: number,
  base: number,
  ox: number,
  oy: number,
  qx: number,
  qy: number,
): number {
  const dx = fr(qx - ox);
  const dy = fr(qy - oy);
  let q = fr(atan2f(dy, dx) + HALF_PI_32);
  while (q < -PI_32) q = fr(q + TWO_PI_32);
  while (q > PI_32) q = fr(q - TWO_PI_32);
  const parent = fr(fr(q * 180) / PI_32);
  return fr(fr(a + parent) + base);
}

/**
 * C = f32(s·cos r) and S = f32(s·sin r) for the angle θ in degrees, with
 * r = f32(f32(θ·π_f) / 180) unreduced and the library's float32 sine and
 * cosine. A point p (mirrored first) maps to
 * X = f32(O_x + f32(f32(C·p_x) − f32(S·p_y))), Y = f32(O_y + f32(f32(S·p_x) + f32(C·p_y))).
 */
export function rotationCS(theta: number, scale: number): [number, number] {
  const r = radians32(theta);
  return [fr(scale * cosf(r)), fr(scale * sinf(r))];
}

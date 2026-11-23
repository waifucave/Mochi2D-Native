/**
 * The 2×2 Jacobian of a deformer's world mapping (§1c.7, §1c.8), analytic
 * per region, for the forward mapping of {@link ModelInstance.mapPoints}.
 *
 * Within each region the mapping is bilinear, triangle-wise linear or affine,
 * so the derivative there is exact (computed in double from the float32
 * world form). The regions are chosen with exactly the float32 tests of the
 * mapping. The mapping is continuous but not smooth across region
 * boundaries; on a boundary, the derivative is that of the region the point
 * belongs to, as the mapping assigns it.
 *
 * Output per point: [∂x/∂px, ∂x/∂py, ∂y/∂px, ∂y/∂py], in model space.
 */
import { fr } from "./f32.js";

/** Grid points are row-major: point (c, r) is at p[g + 2·(r·(C+1) + c)]. */
const at = (g: number, C: number, c: number, r: number) => g + 2 * (r * (C + 1) + c);

/** The affine extension's D_u and D_v (§1c.8, outside, step 1) from the four outer corners. */
function affineAxes(p: Float32Array, g: number, R: number, C: number, out: Float64Array): void {
  const i00 = g;
  const i10 = at(g, C, C, 0);
  const i01 = at(g, C, 0, R);
  const i11 = at(g, C, C, R);
  for (let k = 0; k < 2; k++) {
    out[k] = (p[i10 + k]! + p[i11 + k]! - (p[i00 + k]! + p[i01 + k]!)) / 2; // D_u
    out[2 + k] = (p[i01 + k]! + p[i11 + k]! - (p[i00 + k]! + p[i10 + k]!)) / 2; // D_v
  }
}

/** A(u, v) of the affine extension, in double (corners of the near band's virtual cell). */
function affinePoint(
  p: Float32Array,
  g: number,
  R: number,
  C: number,
  u: number,
  v: number,
  out: Float64Array,
  o: number,
): void {
  const i00 = g;
  const i10 = at(g, C, C, 0);
  const i01 = at(g, C, 0, R);
  const i11 = at(g, C, C, R);
  for (let k = 0; k < 2; k++) {
    const z = (p[i00 + k]! + p[i10 + k]! + p[i01 + k]! + p[i11 + k]!) / 4;
    const du = (p[i10 + k]! + p[i11 + k]! - (p[i00 + k]! + p[i01 + k]!)) / 2;
    const dv = (p[i01 + k]! + p[i11 + k]! - (p[i00 + k]! + p[i10 + k]!)) / 2;
    out[o + k] = z + (u - 0.5) * du + (v - 0.5) * dv;
  }
}

const axes = new Float64Array(4);
const q = new Float64Array(8); // the virtual cell's corners Q00, Q10, Q01, Q11

/**
 * The Jacobian of the warp whose world grid is at p[g…] (R rows, C columns)
 * at (u, v), written to out[o…o+3].
 */
export function warpJacobian(
  p: Float32Array,
  g: number,
  R: number,
  C: number,
  bilinear: boolean,
  u: number,
  v: number,
  out: Float64Array | Float32Array,
  o: number,
): void {
  u = fr(u);
  v = fr(v);
  if (u >= 0 && u < 1 && v >= 0 && v < 1) {
    // Inside: the cell of the mapping, with its fx, fy.
    const X = fr(u * C);
    const Y = fr(v * R);
    const c = Math.min(Math.floor(X), C - 1);
    const r = Math.min(Math.floor(Y), R - 1);
    const fx = fr(X - c);
    const fy = fr(Y - r);
    const i00 = at(g, C, c, r);
    const i10 = at(g, C, c + 1, r);
    const i01 = at(g, C, c, r + 1);
    const i11 = at(g, C, c + 1, r + 1);
    for (let k = 0; k < 2; k++) {
      const p00 = p[i00 + k]!;
      const p10 = p[i10 + k]!;
      const p01 = p[i01 + k]!;
      const p11 = p[i11 + k]!;
      let du: number, dv: number;
      if (bilinear) {
        du = (1 - fy) * (p10 - p00) + fy * (p11 - p01);
        dv = (1 - fx) * (p01 - p00) + fx * (p11 - p10);
      } else if (fr(fx + fy) <= 1) {
        du = p10 - p00;
        dv = p01 - p00;
      } else {
        du = p11 - p01;
        dv = p11 - p10;
      }
      out[o + 2 * k] = du * C;
      out[o + 2 * k + 1] = dv * R;
    }
    return;
  }
  if (u < -2 || u > 3 || v < -2 || v > 3) {
    // Far outside: the affine extension.
    affineAxes(p, g, R, C, axes);
    out[o] = axes[0]!;
    out[o + 1] = axes[2]!;
    out[o + 2] = axes[1]!;
    out[o + 3] = axes[3]!;
    return;
  }
  // The near band: the triangle rule on a virtual cell, as the mapping picks it.
  let u0: number, u1: number, gc0: number, gc1: number;
  if (u < 0) [u0, u1, gc0, gc1] = [-2, 0, -1, 0];
  else if (u > 1) [u0, u1, gc0, gc1] = [1, 3, C, -1];
  else {
    const c = Math.min(Math.floor(fr(u * C)), C - 1);
    [u0, u1, gc0, gc1] = [fr(c / C), fr((c + 1) / C), c, c + 1];
  }
  let v0: number, v1: number, gr0: number, gr1: number;
  if (v < 0) [v0, v1, gr0, gr1] = [-2, 0, -1, 0];
  else if (v > 1) [v0, v1, gr0, gr1] = [1, 3, R, -1];
  else {
    const r = Math.min(Math.floor(fr(v * R)), R - 1);
    [v0, v1, gr0, gr1] = [fr(r / R), fr((r + 1) / R), r, r + 1];
  }
  const corner = (slot: number, gc: number, gr: number, cu: number, cv: number) => {
    if (gc >= 0 && gr >= 0) {
      const i = at(g, C, gc, gr);
      q[slot] = p[i]!;
      q[slot + 1] = p[i + 1]!;
    } else affinePoint(p, g, R, C, cu, cv, q, slot);
  };
  corner(0, gc0, gr0, u0, v0);
  corner(2, gc1, gr0, u1, v0);
  corner(4, gc0, gr1, u0, v1);
  corner(6, gc1, gr1, u1, v1);
  const fx = fr(fr(u - u0) / fr(u1 - u0));
  const fy = fr(fr(v - v0) / fr(v1 - v0));
  const lower = fr(fx + fy) <= 1;
  for (let k = 0; k < 2; k++) {
    const q00 = q[k]!;
    const q10 = q[2 + k]!;
    const q01 = q[4 + k]!;
    const q11 = q[6 + k]!;
    const du = lower ? q10 - q00 : q11 - q01;
    const dv = lower ? q01 - q00 : q11 - q10;
    out[o + 2 * k] = du / (u1 - u0);
    out[o + 2 * k + 1] = dv / (v1 - v0);
  }
}

/**
 * The Jacobian of a rotation's world form, s·R(θ)·diag(mx, my) with mx, my = −1
 * for a mirrored axis (§1c.7), from the float32 cos θ, sin θ and scale.
 */
export function rotationJacobian(
  cos: number,
  sin: number,
  scale: number,
  mirrorX: boolean,
  mirrorY: boolean,
  out: Float64Array | Float32Array,
  o: number,
): void {
  const mx = mirrorX ? -1 : 1;
  const my = mirrorY ? -1 : 1;
  out[o] = scale * cos * mx;
  out[o + 1] = -scale * sin * my;
  out[o + 2] = scale * sin * mx;
  out[o + 3] = scale * cos * my;
}

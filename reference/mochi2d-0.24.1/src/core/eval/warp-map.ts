/**
 * Warp deformer mapping W(u, v) (§1c.8, at the float32 level): cell interpolation inside the grid, an affine map far outside,
 * and triangle interpolation between grid and affine map in the band around
 * it. Every operation is one float32 operation in the order written.
 *
 * Regions: inside is 0 ≤ u < 1 and 0 ≤ v < 1 (half-open); far is u ≤ −2,
 * u ≥ 3, v ≤ −2 or v ≥ 3; the band is everything else.
 *
 * These are the JavaScript forms; the WebAssembly kernels (kernels.ts)
 * perform the same float32 operations, so results are bit-identical.
 */
import { fr } from "./f32.js";

/** Grid points are row-major: point (c, r) is at index 2·(r·(C+1) + c). */
export interface WarpGrid {
  points: Float32Array;
  rows: number;
  columns: number;
  bilinear: boolean;
}

/**
 * The affine map's coefficients from the four outer corners a = p(0, 0),
 * b = p(C, 0), c = p(0, R), d = p(C, R) of the grid at p[g…], into coef:
 * with D₁ = d − a and D₂ = b − c, A₀ = m − D₁·0.5 (m = (((a + b) + c) + d)·0.25)
 * at coef[0, 1], Bᵤ = (D₁ + D₂)·0.5 at coef[2, 3] and Bᵥ = (D₁ − D₂)·0.5 at
 * coef[4, 5], for x and y. (The corner diagonals, not the edge vectors b − a
 * and c − a, which differ at the last bit.)
 */
export function warpAffineSetup(
  p: Float32Array,
  g: number,
  R: number,
  C: number,
  coef: Float32Array,
): void {
  const ib = g + 2 * C;
  const ic = g + 2 * (R * (C + 1));
  const id = g + 2 * (R * (C + 1) + C);
  for (let k = 0; k < 2; k++) {
    const a = p[g + k]!;
    const b = p[ib + k]!;
    const c = p[ic + k]!;
    const d = p[id + k]!;
    const D1 = fr(d - a);
    const D2 = fr(b - c);
    coef[2 + k] = fr(fr(D1 + D2) * 0.5);
    coef[4 + k] = fr(fr(D1 - D2) * 0.5);
    const m = fr(fr(fr(fr(a + b) + c) + d) * 0.25);
    coef[k] = fr(m - fr(D1 * 0.5));
  }
}

/** Aff(U, V) = (A₀ + U·Bᵤ) + V·Bᵥ from {@link warpAffineSetup}'s coefficients, to out[o, o + 1]. */
function affineAt(coef: Float32Array, U: number, V: number, out: Float32Array, o: number): void {
  out[o] = fr(fr(coef[0]! + fr(U * coef[2]!)) + fr(V * coef[4]!));
  out[o + 1] = fr(fr(coef[1]! + fr(U * coef[3]!)) + fr(V * coef[5]!));
}

/** The affine map of the grid at p[g…] at (U, V), written to out[o], out[o + 1]. */
export function warpAffine(
  p: Float32Array,
  g: number,
  R: number,
  C: number,
  U: number,
  V: number,
  out: Float32Array,
  o: number,
): void {
  warpAffineSetup(p, g, R, C, ownCoef);
  affineAt(ownCoef, U, V, out, o);
}

/** Coefficients for callers that pass none. */
const ownCoef = new Float32Array(6);

/**
 * A point inside the grid at p[g…] (0 ≤ u < 1, 0 ≤ v < 1), written to
 * out[o], out[o + 1]. Cell (c, r) and local (x, y): X = u·C,
 * c = min(⌊X⌋, C − 1), x = X − c (and the same for v). Quad cells:
 * (((gy·(gx·p00) + gy·(x·p10)) + y·(gx·p01)) + y·(x·p11)), the corner value
 * multiplied in before the row weight. Triangle cells split along p10–p01:
 * below, ((((1 − x) − y)·p00 + x·p10) + y·p01); above, with a = 1 − x,
 * b = 1 − y and e = y − a, ((e·p11 + a·p01) + b·p10).
 */
export function warpInside(
  p: Float32Array,
  g: number,
  R: number,
  C: number,
  bilinear: boolean,
  u: number,
  v: number,
  out: Float32Array,
  o: number,
): void {
  const X = fr(u * C);
  const Y = fr(v * R);
  let c = Math.floor(X);
  if (c > C - 1) c = C - 1;
  let r = Math.floor(Y);
  if (r > R - 1) r = R - 1;
  const x = fr(X - c);
  const y = fr(Y - r);
  const stride = 2 * (C + 1);
  const i00 = g + r * stride + 2 * c;
  const i10 = i00 + 2;
  const i01 = i00 + stride;
  const i11 = i01 + 2;
  const gx = fr(1 - x);
  const gy = fr(1 - y);
  if (bilinear) {
    for (let k = 0; k < 2; k++)
      out[o + k] = fr(
        fr(
          fr(fr(gy * fr(gx * p[i00 + k]!)) + fr(gy * fr(x * p[i10 + k]!))) +
            fr(y * fr(gx * p[i01 + k]!)),
        ) + fr(y * fr(x * p[i11 + k]!)),
      );
  } else if (fr(x + y) <= 1) {
    const w = fr(gx - y);
    for (let k = 0; k < 2; k++)
      out[o + k] = fr(fr(fr(w * p[i00 + k]!) + fr(x * p[i10 + k]!)) + fr(y * p[i01 + k]!));
  } else {
    const e = fr(y - gx);
    for (let k = 0; k < 2; k++)
      out[o + k] = fr(fr(fr(e * p[i11 + k]!) + fr(gx * p[i01 + k]!)) + fr(gy * p[i10 + k]!));
  }
}

/** Scratch for the four corners of a band macro-cell (q00, q10, q01, q11). */
const corner = new Float32Array(8);

/** Sets corner `slot` to grid point (gc, gr), or to Aff(U, V) if either index is outer (−1). */
function setCorner(
  p: Float32Array,
  g: number,
  C: number,
  coef: Float32Array,
  slot: number,
  gc: number,
  gr: number,
  U: number,
  V: number,
): void {
  if (gc >= 0 && gr >= 0) {
    const i = g + 2 * (gr * (C + 1) + gc);
    corner[slot] = p[i]!;
    corner[slot + 1] = p[i + 1]!;
  } else {
    affineAt(coef, U, V, corner, slot);
  }
}

/** One axis of a band macro-cell: its ends' positions and grid indices (−1: affine), and x. */
const axisOut = { t0: 0, t1: 0, g0: 0, g1: 0, x: 0 };

function bandAxis(t: number, n: number): void {
  const a = axisOut;
  if (t <= 0) {
    a.t0 = -2;
    a.t1 = 0;
    a.g0 = -1;
    a.g1 = 0;
    a.x = fr(fr(t - a.t0) / fr(a.t1 - a.t0));
  } else if (t >= 1) {
    a.t0 = 1;
    a.t1 = 3;
    a.g0 = n;
    a.g1 = -1;
    a.x = fr(fr(t - a.t0) / fr(a.t1 - a.t0));
  } else {
    const T = fr(t * n);
    const k = Math.min(Math.floor(T), n - 1);
    a.t0 = fr(k / n);
    a.t1 = fr((k + 1) / n);
    a.g0 = k;
    a.g1 = k + 1;
    a.x = fr(T - k);
  }
}

/**
 * A point outside [0, 1)² of the grid at p[g…]: the far region's affine map,
 * or in the band, the triangle form with differences on its macro-cell
 * (for both cell flags): below the diagonal (x + y ≤ 1),
 * (q00 + x·(q10 − q00)) + y·(q01 − q00); above,
 * (q11 + gx·(q01 − q11)) + gy·(q10 − q11). `coef` holds the grid's affine
 * coefficients ({@link warpAffineSetup}) when the caller has them already
 * (several points of one grid); without it they are computed here.
 */
export function warpOutside(
  p: Float32Array,
  g: number,
  R: number,
  C: number,
  u: number,
  v: number,
  out: Float32Array,
  o: number,
  coef?: Float32Array,
): void {
  if (!coef) {
    warpAffineSetup(p, g, R, C, ownCoef);
    coef = ownCoef;
  }
  if (u <= -2 || u >= 3 || v <= -2 || v >= 3) {
    affineAt(coef, u, v, out, o);
    return;
  }
  bandAxis(u, C);
  const u0 = axisOut.t0;
  const u1 = axisOut.t1;
  const gc0 = axisOut.g0;
  const gc1 = axisOut.g1;
  const x = axisOut.x;
  bandAxis(v, R);
  const v0 = axisOut.t0;
  const v1 = axisOut.t1;
  const gr0 = axisOut.g0;
  const gr1 = axisOut.g1;
  const y = axisOut.x;
  setCorner(p, g, C, coef, 0, gc0, gr0, u0, v0);
  setCorner(p, g, C, coef, 2, gc1, gr0, u1, v0);
  setCorner(p, g, C, coef, 4, gc0, gr1, u0, v1);
  setCorner(p, g, C, coef, 6, gc1, gr1, u1, v1);
  if (fr(x + y) <= 1) {
    for (let k = 0; k < 2; k++) {
      const q00 = corner[k]!;
      out[o + k] = fr(
        fr(q00 + fr(x * fr(corner[2 + k]! - q00))) + fr(y * fr(corner[4 + k]! - q00)),
      );
    }
  } else {
    const gx = fr(1 - x);
    const gy = fr(1 - y);
    for (let k = 0; k < 2; k++) {
      const q11 = corner[6 + k]!;
      out[o + k] = fr(
        fr(q11 + fr(gx * fr(corner[4 + k]! - q11))) + fr(gy * fr(corner[2 + k]! - q11)),
      );
    }
  }
}

/** Input scratch for {@link warpPoint}. */
const single = new Float32Array(2);

/** Maps (u, v) through the warp and writes x, y to out[o], out[o + 1]. */
export function warpPoint(g: WarpGrid, u: number, v: number, out: Float32Array, o: number): void {
  single[0] = u;
  single[1] = v;
  warpPoints(g.points, g.rows, g.columns, g.bilinear, single, 0, out, o, 1);
}

/**
 * Maps `count` points from src[srcOffset…] (x, y pairs in the warp's input space)
 * to dst[dstOffset…]. `src` and `dst` may be the same array and offset.
 */
export function warpPoints(
  p: Float32Array,
  R: number,
  C: number,
  bilinear: boolean,
  src: Float32Array,
  srcOffset: number,
  dst: Float32Array,
  dstOffset: number,
  count: number,
): void {
  for (let n = 0; n < count; n++) {
    const u = src[srcOffset + 2 * n]!;
    const v = src[srcOffset + 2 * n + 1]!;
    const o = dstOffset + 2 * n;
    if (u >= 0 && u < 1 && v >= 0 && v < 1) warpInside(p, 0, R, C, bilinear, u, v, dst, o);
    else warpOutside(p, 0, R, C, u, v, dst, o);
  }
}

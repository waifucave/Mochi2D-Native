/**
 * 3x3 matrices for 2D affine transforms, stored column-major in a Float32Array
 * of length 9 (the layout WebGL's `uniformMatrix3fv` expects):
 *
 *   | m0 m3 m6 |
 *   | m1 m4 m7 |
 *   | m2 m5 m8 |
 */
import type { Vec2 } from "./vec2.js";

export type Mat3 = Float32Array;

export const identity3 = (): Mat3 => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export function multiply3(a: Mat3, b: Mat3, out: Mat3 = new Float32Array(9)): Mat3 {
  const r = new Float32Array(9);
  for (let c = 0; c < 3; c++) {
    for (let row = 0; row < 3; row++) {
      r[c * 3 + row] =
        a[row]! * b[c * 3]! + a[3 + row]! * b[c * 3 + 1]! + a[6 + row]! * b[c * 3 + 2]!;
    }
  }
  out.set(r);
  return out;
}

export const translation3 = (tx: number, ty: number): Mat3 =>
  new Float32Array([1, 0, 0, 0, 1, 0, tx, ty, 1]);

export const scaling3 = (sx: number, sy: number): Mat3 =>
  new Float32Array([sx, 0, 0, 0, sy, 0, 0, 0, 1]);

export const rotation3 = (rad: number): Mat3 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1]);
};

export function determinant3(m: Mat3): number {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[];
  return a! * (e! * i! - f! * h!) - d! * (b! * i! - c! * h!) + g! * (b! * f! - c! * e!);
}

/** Inverse, or `null` if the matrix is singular. */
export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[];
  const A = e! * i! - f! * h!;
  const B = -(b! * i! - c! * h!);
  const C = b! * f! - c! * e!;
  const det = a! * A - d! * (b! * i! - c! * h!) + g! * (b! * f! - c! * e!);
  if (det === 0 || !Number.isFinite(det)) return null;
  const inv = 1 / det;
  return new Float32Array([
    A * inv,
    B * inv,
    C * inv,
    -(d! * i! - f! * g!) * inv,
    (a! * i! - c! * g!) * inv,
    -(a! * f! - c! * d!) * inv,
    (d! * h! - e! * g!) * inv,
    -(a! * h! - b! * g!) * inv,
    (a! * e! - b! * d!) * inv,
  ]);
}

export function transformPoint3(m: Mat3, p: Vec2): Vec2 {
  return {
    x: m[0]! * p.x + m[3]! * p.y + m[6]!,
    y: m[1]! * p.x + m[4]! * p.y + m[7]!,
  };
}

/** Transforms a flat `[x0, y0, x1, y1, ...]` array in place (or into `out`). */
export function transformPoints3(
  m: Mat3,
  points: ArrayLike<number>,
  out: Float32Array = new Float32Array(points.length),
): Float32Array {
  const a = m[0]!,
    b = m[1]!,
    c = m[3]!,
    d = m[4]!,
    tx = m[6]!,
    ty = m[7]!;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    out[i] = a * x + c * y + tx;
    out[i + 1] = b * x + d * y + ty;
  }
  return out;
}

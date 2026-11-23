/**
 * Mask coordinates as float32 affine matrices (rule M of the renderer).
 *
 * A mask maps an output-space point p to mask-texture coordinates
 * t = s·(p − b) + ℓ per axis: b is the corner the mapping starts from (the
 * group box's lower-left corner, or that minus the 5 % margin), s the scale to
 * texture units and ℓ the corner of the mask's region in the texture (0 for a
 * whole-texture mask, the region's corner in the atlas). The renderer does
 * not subtract first: it applies two 4 × 4 matrices in the vertex shader as
 * A·p + c, built on the CPU from b, s and ℓ in a fixed order:
 *
 *   texture: T(ℓ) · S(s) · T(−b)
 *   clip:    T(−1, −1) · S(2, 2) · T(ℓ) · S(s) · T(−b)
 *
 * T is a translation and S a scale. The product starts from the identity
 * and multiplies the factors on from left to right, each intermediate matrix
 * stored in float32. Each entry of a product is the sum over the inner index
 * in increasing order: each term (two float32 values multiplied, exact in
 * double) is added to the running sum, and every addition is rounded once to
 * float32. The texture matrix's x translation is so
 * f32(ℓx + f32(sx·(−bx))), and the clip matrix's f32(f32(2ℓx − 1) + f32(2sx·(−bx))).
 */
import type { MaskMapping } from "./masks.js";

/** A 4 × 4 matrix, row-major: m[4·r + c]. */
export type Mat4 = Float32Array;

const f32 = Math.fround;

function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function translation(x: number, y: number): Mat4 {
  const m = identity();
  m[3] = f32(x);
  m[7] = f32(y);
  return m;
}

function scale(x: number, y: number): Mat4 {
  const m = identity();
  m[0] = f32(x);
  m[5] = f32(y);
  return m;
}

/** a · b in the order of the rule: terms in increasing inner index, each addition rounded to float32. */
export function multiplyF32(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let sum = a[4 * r]! * b[c]!;
      for (let k = 1; k < 4; k++) sum = f32(sum + a[4 * r + k]! * b[4 * k + c]!);
      out[4 * r + c] = sum;
    }
  return out;
}

/** The identity times each factor in turn. */
export function composeF32(factors: readonly Mat4[]): Mat4 {
  let m = identity();
  for (const f of factors) m = multiplyF32(m, f);
  return m;
}

export interface MaskMatrices {
  /** Output space → mask-texture coordinates in [0, 1], row-major. */
  texture: Mat4;
  /** Output space → clip space of the mask buffer (2t − 1), row-major. */
  clip: Mat4;
}

/** The two matrices of a mask mapping, with b, s and ℓ taken as float32. */
export function maskMatrices(map: MaskMapping): MaskMatrices {
  const tail = [
    translation(map.lx ?? 0, map.ly ?? 0),
    scale(map.sx, map.sy),
    translation(-f32(map.ox), -f32(map.oy)),
  ];
  return {
    texture: composeF32(tail),
    clip: composeF32([translation(-1, -1), scale(2, 2), ...tail]),
  };
}

/** A row-major matrix in the column-major order WebGL takes. */
export function columnMajor(m: Mat4): Float32Array {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[4 * c + r] = m[4 * r + c]!;
  return out;
}

/**
 * The view matrix V, output space → clip space, as float32 entries (row-major
 * 4 × 4): the scale and translation of `clipTransform`, then the framing's
 * rotation (`clipTurn`; none in reference renders), combined in double and
 * rounded once per entry.
 */
export function viewMatrix(
  view: readonly [number, number, number, number],
  turn: readonly [number, number, number] = [1, 0, 0],
): Mat4 {
  const [sx, sy, tx, ty] = view;
  const [c, hs, ws] = turn; // clip′ = (c·x − hs·y, ws·x + c·y)
  const m = identity();
  m[0] = f32(c * sx);
  m[1] = f32(-hs * sy);
  m[3] = f32(c * tx - hs * ty);
  m[4] = f32(ws * sx);
  m[5] = f32(c * sy);
  m[7] = f32(ws * tx + c * ty);
  return m;
}

/**
 * The inverse of an affine view matrix (rule I): computed in double from its
 * float32 entries as a 3 × 3 inverse by cofactors over the determinant, the
 * translation as minus the unrounded inverse times V's translation, and each
 * entry then stored as float32.
 */
export function inverseView(v: Mat4): Mat4 {
  const [a, b, tx] = [v[0]!, v[1]!, v[3]!];
  const [c, d, ty] = [v[4]!, v[5]!, v[7]!];
  const det = a * d - b * c;
  const i00 = d / det;
  const i01 = -b / det;
  const i10 = -c / det;
  const i11 = a / det;
  const m = identity();
  m[0] = f32(i00);
  m[1] = f32(i01);
  m[3] = f32(-(i00 * tx + i01 * ty));
  m[4] = f32(i10);
  m[5] = f32(i11);
  m[7] = f32(-(i10 * tx + i11 * ty));
  return m;
}

/**
 * Rule I: the matrix a masked layer's mask is looked up through,
 * D = A · V⁻¹ (A the mask's texture matrix by rule M, V⁻¹ by
 * {@link inverseView}), with rule M's four-term sums. Applied to the layer
 * quad's clip-space corners (±1, ±1) and interpolated across the screen.
 */
export function layerMaskMatrix(map: MaskMapping, view: Mat4): Mat4 {
  return multiplyF32(maskMatrices(map).texture, inverseView(view));
}

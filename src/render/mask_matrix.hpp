// The renderer's float32 rules on the CPU side (Mochi2D 0.18.0,
// docs/rendering.md; src/core/render/sampling.ts and mask-matrix.ts):
//
// - Rule V: a texture is sampled at v flipped twice in float32,
//   f32(1 − f32(1 − v)); u as stored.
// - Rule M: a mask maps an output-space point p to t = s·(p − b) + ℓ, per
//   axis, and is applied as two float32 affine matrices built in a fixed
//   order (texture T(ℓ)·S(s)·T(−b); clip T(−1, −1)·S(2, 2)·T(ℓ)·S(s)·T(−b)),
//   each entry of a product the four-term sum in increasing inner index,
//   every addition rounded to float32.
// - Rule I: a masked layer's mask is looked up through D = A · V⁻¹ (A the
//   mask's texture matrix, V the view matrix, V⁻¹ computed in double from
//   V's float32 entries), applied to the layer quad's clip-space corners.
//
// The arithmetic is the reference's: double products of float32 values
// (exact), sums rounded to float32, no fused operations (the build turns
// contraction off).
#pragma once

#include <array>
#include <cstddef>

#include "util/alloc.hpp"

namespace mochi2d::render {

/** A 4 × 4 matrix, row-major: m[4·r + c]. */
using Mat4 = std::array<float, 16>;

/** Rule V: the v the renderer samples for a stored v. */
float sampled_v(float v);
/** A drawable's stored UVs (u, v pairs) as the renderer samples them. */
void sampled_uvs(const float* uvs, std::size_t floats, Vector<float>& out);

Mat4 identity4();
/** a · b by rule M: terms in increasing inner index, each addition rounded to float32. */
Mat4 multiply_f32(const Mat4& a, const Mat4& b);

/** A mask mapping: t = (x − ox)·sx + lx, (y − oy)·sy + ly (masks.ts MaskMapping). */
struct MaskMapping {
  double ox = 0, oy = 0, sx = 0, sy = 0, lx = 0, ly = 0;
};

struct MaskMatrices {
  /** Output space → mask-texture coordinates. */
  Mat4 texture;
  /** Output space → the mask buffer's clip space (2t − 1). */
  Mat4 clip;
};
/** Rule M: both matrices of a mapping, b, s and ℓ taken as float32. */
MaskMatrices mask_matrices(const MaskMapping& map);

/**
 * The view matrix V, output space → clip space: clip = (x·view[0] + view[2],
 * y·view[1] + view[3]), then a rotation `turn` = (c, s·H/W, s·W/H)
 * (framing.ts clipTurn; (1, 0, 0) for none), combined in double and
 * rounded once per entry.
 */
Mat4 view_matrix(const std::array<double, 4>& view, const std::array<double, 3>& turn = {1, 0, 0});
/** Rule I: V⁻¹ of an affine view matrix, in double from its float32 entries, stored as float32. */
Mat4 inverse_view(const Mat4& v);
/** Rule I: D = A · V⁻¹, A the mapping's texture matrix. */
Mat4 layer_mask_matrix(const MaskMapping& map, const Mat4& view);

/** The column-major order OpenGL's glUniformMatrix4fv takes (transpose false). */
Mat4 column_major(const Mat4& m);

}  // namespace mochi2d::render

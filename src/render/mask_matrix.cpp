#include "render/mask_matrix.hpp"

namespace mochi2d::render {

namespace {

float f32(double x) { return static_cast<float>(x); }

Mat4 translation(double x, double y) {
  Mat4 m = identity4();
  m[3] = f32(x);
  m[7] = f32(y);
  return m;
}

Mat4 scale(double x, double y) {
  Mat4 m = identity4();
  m[0] = f32(x);
  m[5] = f32(y);
  return m;
}

}  // namespace

float sampled_v(float v) { return f32(1.0 - static_cast<double>(f32(1.0 - static_cast<double>(v)))); }

void sampled_uvs(const float* uvs, std::size_t floats, Vector<float>& out) {
  out.assign(uvs, uvs + floats);
  for (std::size_t i = 1; i < floats; i += 2) out[i] = sampled_v(out[i]);
}

Mat4 identity4() {
  Mat4 m{};
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

Mat4 multiply_f32(const Mat4& a, const Mat4& b) {
  Mat4 out{};
  for (int r = 0; r < 4; r++)
    for (int c = 0; c < 4; c++) {
      // The first term starts the sum unrounded (a product of two float32 values is exact in double).
      double sum = static_cast<double>(a[static_cast<std::size_t>(4 * r)]) * static_cast<double>(b[static_cast<std::size_t>(c)]);
      for (int k = 1; k < 4; k++)
        sum = f32(sum + static_cast<double>(a[static_cast<std::size_t>(4 * r + k)]) *
                            static_cast<double>(b[static_cast<std::size_t>(4 * k + c)]));
      out[static_cast<std::size_t>(4 * r + c)] = f32(sum);
    }
  return out;
}

MaskMatrices mask_matrices(const MaskMapping& map) {
  const Mat4 tail[3] = {translation(map.lx, map.ly), scale(map.sx, map.sy),
                        translation(-static_cast<double>(f32(map.ox)), -static_cast<double>(f32(map.oy)))};
  MaskMatrices out;
  Mat4 t = identity4();
  for (const Mat4& f : tail) t = multiply_f32(t, f);
  out.texture = t;
  Mat4 c = multiply_f32(multiply_f32(identity4(), translation(-1, -1)), scale(2, 2));
  for (const Mat4& f : tail) c = multiply_f32(c, f);
  out.clip = c;
  return out;
}

Mat4 view_matrix(const std::array<double, 4>& view, const std::array<double, 3>& turn) {
  const double sx = view[0], sy = view[1], tx = view[2], ty = view[3];
  const double c = turn[0], hs = turn[1], ws = turn[2];  // clip′ = (c·x − hs·y, ws·x + c·y)
  Mat4 m = identity4();
  m[0] = f32(c * sx);
  m[1] = f32(-hs * sy);
  m[3] = f32(c * tx - hs * ty);
  m[4] = f32(ws * sx);
  m[5] = f32(c * sy);
  m[7] = f32(ws * tx + c * ty);
  return m;
}

Mat4 inverse_view(const Mat4& v) {
  const double a = v[0], b = v[1], tx = v[3];
  const double c = v[4], d = v[5], ty = v[7];
  const double det = a * d - b * c;
  const double i00 = d / det, i01 = -b / det, i10 = -c / det, i11 = a / det;
  Mat4 m = identity4();
  m[0] = f32(i00);
  m[1] = f32(i01);
  m[3] = f32(-(i00 * tx + i01 * ty));
  m[4] = f32(i10);
  m[5] = f32(i11);
  m[7] = f32(-(i10 * tx + i11 * ty));
  return m;
}

Mat4 layer_mask_matrix(const MaskMapping& map, const Mat4& view) {
  return multiply_f32(mask_matrices(map).texture, inverse_view(view));
}

Mat4 column_major(const Mat4& m) {
  Mat4 out{};
  for (std::size_t r = 0; r < 4; r++)
    for (std::size_t c = 0; c < 4; c++) out[4 * c + r] = m[4 * r + c];
  return out;
}

}  // namespace mochi2d::render

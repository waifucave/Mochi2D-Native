// Port of Mochi2D's src/core/eval/instance.ts, plan.ts, binding.ts,
// kernels.ts (the JavaScript kernels) and warp-map.ts.
#include "core/eval/instance.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <limits>
#include <unordered_map>

#include "core/eval/f32.hpp"
#include "core/eval/rotation.hpp"
#include "fdlibm.hpp"
#include "util/text.hpp"

// SSE2 for the warp mapping (x86-64, and 32-bit x86 built with SSE2), unless
// MOCHI2D_NO_SIMD; other targets take the scalar path, which gives the same
// results.
#if !defined(MOCHI2D_NO_SIMD) && \
    (defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2))
#define MOCHI2D_WARP_SSE2 1
#include <emmintrin.h>
#endif

namespace mochi2d::eval {

using moc::BlendShapeBinding;
using moc::Model;

namespace {

inline std::size_t Z(long long x) { return static_cast<std::size_t>(x); }

inline float clamp01(float v) { return v < 0 ? 0.0f : v > 1 ? 1.0f : v; }

constexpr float kNaN32 = std::numeric_limits<float>::quiet_NaN();

/**
 * keys[i] of a typed array as the reference reads it: past the end it is
 * undefined, which arithmetic turns into NaN. Only a NaN parameter value
 * reaches past the end (the key search then runs to the last key with
 * t = NaN, so every weight that multiplies such a read is NaN too).
 */
template <class V>
inline float at_or_nan(const V& v, std::size_t i) {
  return i < v.size() ? static_cast<float>(v[i]) : kNaN32;
}

/** §1c.2: locates v on ascending keys; returns whether it is out of range. */
bool locate_key(const Vector<float>& keys, float v, int32_t& index, float& t, float eps) {
  const int K = static_cast<int>(keys.size());
  const float first = keys[0];
  const float last = keys[Z(K - 1)];
  const bool out_of_range = v < first - eps || v >= last + eps;
  for (int i = 0; i < K; i++) {
    const float k = keys[Z(i)];
    if (k - eps < v && v < k + eps) {
      index = i;
      t = 0;
      return out_of_range;
    }
  }
  if (v <= first) {
    index = 0;
    t = 0;
    return out_of_range;
  }
  if (v >= last) {
    index = K - 1;
    t = 0;
    return out_of_range;
  }
  int i = 0;
  while (i + 1 < K && !(v < keys[Z(i + 1)])) i++;
  const float ki = keys[Z(i)];
  index = i;
  t = (v - ki) / (at_or_nan(keys, Z(i + 1)) - ki);
  return out_of_range;
}

/** Blend-shape key location (C1): clamped, no snapping. */
void locate_blend_key(const Vector<float>& keys, float v, int32_t& index, float& t) {
  const int K = static_cast<int>(keys.size());
  if (v <= keys[0]) {
    index = 0;
    t = 0;
    return;
  }
  if (v >= keys[Z(K - 1)]) {
    index = K - 1;
    t = 0;
    return;
  }
  int i = 0;
  while (i + 1 < K && !(v < keys[Z(i + 1)])) i++;
  const float ki = keys[Z(i)];
  index = i;
  t = (v - ki) / (at_or_nan(keys, Z(i + 1)) - ki);
}

/** Colors at c (multiply r g b, screen r g b) combined with the parent's accumulated ones, in place. */
void combine_colors(float* colors, const float* acc) {
  for (int ch = 0; ch < 3; ch++) {
    colors[ch] = colors[ch] * acc[ch];
    const float s = colors[3 + ch];
    const float ps = acc[3 + ch];
    colors[3 + ch] = (s + ps) - s * ps;
  }
}

// ---- warp mapping (warp-map.ts) ----

/**
 * The affine map from the grid's outer corners a = p(0, 0), b = p(C, 0),
 * c = p(0, R), d = p(C, R) (warp-map.ts warpAffine, 0.14.0): with D1 = d − a
 * and D2 = b − c, Bu = (D1 + D2)·0.5, Bv = (D1 − D2)·0.5,
 * m = (((a + b) + c) + d)·0.25, A0 = m − D1·0.5; Aff(U, V) = (A0 + U·Bu) + V·Bv.
 */
void affine(const float* p, int R, int C, float U, float V, float* out) {
  const int ib = 2 * C;
  const int ic = 2 * (R * (C + 1));
  const int id = 2 * (R * (C + 1) + C);
  for (int k = 0; k < 2; k++) {
    const float a = p[k];
    const float b = p[ib + k];
    const float c = p[ic + k];
    const float d = p[id + k];
    const float D1 = d - a;
    const float D2 = b - c;
    const float Bu = (D1 + D2) * 0.5f;
    const float Bv = (D1 - D2) * 0.5f;
    const float m = (((a + b) + c) + d) * 0.25f;
    const float A0 = m - D1 * 0.5f;
    out[k] = (A0 + U * Bu) + V * Bv;
  }
}

void set_corner(const float* p, int R, int C, float* corner, int slot, int gc, int gr, float U, float V) {
  if (gc >= 0 && gr >= 0) {
    const int i = 2 * (gr * (C + 1) + gc);
    corner[slot] = p[i];
    corner[slot + 1] = p[i + 1];
  } else {
    affine(p, R, C, U, V, corner + slot);
  }
}

/** JavaScript's Math.floor of a float, as an int (the value is in range here). */
inline int floor_int(float x) { return static_cast<int>(std::floor(static_cast<double>(x))); }

/** One axis of a band macro-cell (warp-map.ts bandAxis): its ends, their grid indices (−1: affine), and x. */
struct BandAxis {
  float t0, t1, x;
  int g0, g1;
};
BandAxis band_axis(float t, int n) {
  BandAxis a{};
  if (t <= 0) {
    a.t0 = -2;
    a.t1 = 0;
    a.g0 = -1;
    a.g1 = 0;
    a.x = (t - a.t0) / (a.t1 - a.t0);
  } else if (t >= 1) {
    a.t0 = 1;
    a.t1 = 3;
    a.g0 = n;
    a.g1 = -1;
    a.x = (t - a.t0) / (a.t1 - a.t0);
  } else {
    const float T = t * static_cast<float>(n);
    const int k = std::min(floor_int(T), n - 1);
    a.t0 = static_cast<float>(k) / static_cast<float>(n);
    a.t1 = static_cast<float>(k + 1) / static_cast<float>(n);
    a.g0 = k;
    a.g1 = k + 1;
    a.x = T - static_cast<float>(k);
  }
  return a;
}

/**
 * A point outside [0, 1)² (warp-map.ts warpOutside, 0.14.0): the far
 * region's affine map (u ≤ −2, u ≥ 3, v ≤ −2 or v ≥ 3), or in the band the
 * triangle form with differences on its macro-cell, for both cell flags.
 */
void warp_outside(const float* p, int R, int C, float u, float v, float* out) {
  // A NaN coordinate gives NaN for both outputs on every path of the
  // reference (its grid index is NaN too); stop before taking floor_int of it.
  if (std::isnan(u) || std::isnan(v)) {
    out[0] = out[1] = std::numeric_limits<float>::quiet_NaN();
    return;
  }
  if (u <= -2 || u >= 3 || v <= -2 || v >= 3) {
    affine(p, R, C, u, v, out);
    return;
  }
  const BandAxis au = band_axis(u, C);
  const BandAxis av = band_axis(v, R);
  float corner[8];
  set_corner(p, R, C, corner, 0, au.g0, av.g0, au.t0, av.t0);
  set_corner(p, R, C, corner, 2, au.g1, av.g0, au.t1, av.t0);
  set_corner(p, R, C, corner, 4, au.g0, av.g1, au.t0, av.t1);
  set_corner(p, R, C, corner, 6, au.g1, av.g1, au.t1, av.t1);
  const float x = au.x;
  const float y = av.x;
  if (x + y <= 1) {
    for (int k = 0; k < 2; k++) {
      const float q00 = corner[k];
      out[k] = (q00 + x * (corner[2 + k] - q00)) + y * (corner[4 + k] - q00);
    }
  } else {
    const float gx = 1 - x;
    const float gy = 1 - y;
    for (int k = 0; k < 2; k++) {
      const float q11 = corner[6 + k];
      out[k] = (q11 + gx * (corner[4 + k] - q11)) + gy * (corner[2 + k] - q11);
    }
  }
}

}  // namespace

namespace {

/**
 * The inside-grid part of warp_points for one kind of cell interpolation;
 * points outside the grid go through warp_outside. In the grid u, v ≥ 0, so
 * X, Y ≥ 0 and truncation is Math.floor (−0 included).
 */
template <bool kBilinear>
void warp_points_scalar(const float* p, int R, int C, const float* src, float* dst, int count) {
  const int stride = C + 1;
  const float Cf = static_cast<float>(C);
  const float Rf = static_cast<float>(R);
  for (int n = 0; n < count; n++) {
    const float u = src[2 * n];
    const float v = src[2 * n + 1];
    float* o = dst + 2 * n;
    if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) {
      float out[2];
      warp_outside(p, R, C, u, v, out);
      o[0] = out[0];
      o[1] = out[1];
      continue;
    }
    const float X = u * Cf;
    const float Y = v * Rf;
    int c = static_cast<int>(X);
    if (c > C - 1) c = C - 1;
    int r = static_cast<int>(Y);
    if (r > R - 1) r = R - 1;
    const float fx = X - static_cast<float>(c);
    const float fy = Y - static_cast<float>(r);
    const float* q00 = p + 2 * (r * stride + c);
    const float* q10 = q00 + 2;
    const float* q01 = q00 + 2 * stride;
    const float* q11 = q01 + 2;
    // 0.14.0 (warp-map.ts warpInside): quad cells multiply each corner value
    // before the row weight; triangle cells weigh the corners.
    const float gx = 1 - fx;
    const float gy = 1 - fy;
    if (kBilinear) {
      o[0] = ((gy * (gx * q00[0]) + gy * (fx * q10[0])) + fy * (gx * q01[0])) + fy * (fx * q11[0]);
      o[1] = ((gy * (gx * q00[1]) + gy * (fx * q10[1])) + fy * (gx * q01[1])) + fy * (fx * q11[1]);
    } else if (fx + fy <= 1) {
      const float w = gx - fy;
      o[0] = (w * q00[0] + fx * q10[0]) + fy * q01[0];
      o[1] = (w * q00[1] + fx * q10[1]) + fy * q01[1];
    } else {
      const float e = fy - gx;
      o[0] = (e * q11[0] + gx * q01[0]) + gy * q10[0];
      o[1] = (e * q11[1] + gx * q01[1]) + gy * q10[1];
    }
  }
}

#ifdef MOCHI2D_WARP_SSE2
/**
 * The same four points at a time: every lane computes what the scalar loop
 * computes for its point, operation for operation (IEEE single operations,
 * no contraction), and the triangle mode takes both triangles' formulas and
 * keeps the one the scalar test picks. The cell corners come as two rows of
 * 4 floats per point (points (r, c), (r, c + 1) and the row below),
 * transposed. Points outside the grid (and NaN) go through warp_outside,
 * from the coordinates as loaded, so src may equal dst.
 */
template <bool kBilinear>
void warp_points_sse2(const float* p, int R, int C, const float* src, float* dst, int count) {
  const int stride = C + 1;
  const __m128 Cf = _mm_set1_ps(static_cast<float>(C));
  const __m128 Rf = _mm_set1_ps(static_cast<float>(R));
  const __m128i Cm1 = _mm_set1_epi32(C - 1);
  const __m128i Rm1 = _mm_set1_epi32(R - 1);
  const __m128 zero = _mm_setzero_ps();
  const __m128 one = _mm_set1_ps(1.0f);
  int n = 0;
  for (; n + 4 <= count; n += 4) {
    const __m128 a = _mm_loadu_ps(src + 2 * n);
    const __m128 b = _mm_loadu_ps(src + 2 * n + 4);
    const __m128 u = _mm_shuffle_ps(a, b, _MM_SHUFFLE(2, 0, 2, 0));
    const __m128 v = _mm_shuffle_ps(a, b, _MM_SHUFFLE(3, 1, 3, 1));
    const __m128 in = _mm_and_ps(_mm_and_ps(_mm_cmpge_ps(u, zero), _mm_cmplt_ps(u, one)),
                                 _mm_and_ps(_mm_cmpge_ps(v, zero), _mm_cmplt_ps(v, one)));
    const int inside = _mm_movemask_ps(in);
    alignas(16) float out[8];
    if (inside != 0) {
      const __m128 X = _mm_mul_ps(u, Cf);
      const __m128 Y = _mm_mul_ps(v, Rf);
      // Truncation, then min(·, C − 1) and min(·, R − 1); lanes outside the grid take
      // cell (0, 0), so their reads stay in the grid (their results are replaced).
      __m128i c = _mm_and_si128(_mm_cvttps_epi32(X), _mm_castps_si128(in));
      __m128i r = _mm_and_si128(_mm_cvttps_epi32(Y), _mm_castps_si128(in));
      __m128i over = _mm_cmpgt_epi32(c, Cm1);
      c = _mm_or_si128(_mm_andnot_si128(over, c), _mm_and_si128(over, Cm1));
      over = _mm_cmpgt_epi32(r, Rm1);
      r = _mm_or_si128(_mm_andnot_si128(over, r), _mm_and_si128(over, Rm1));
      const __m128 fx = _mm_sub_ps(X, _mm_cvtepi32_ps(c));
      const __m128 fy = _mm_sub_ps(Y, _mm_cvtepi32_ps(r));
      alignas(16) int32_t ci[4], ri[4];
      _mm_store_si128(reinterpret_cast<__m128i*>(ci), c);
      _mm_store_si128(reinterpret_cast<__m128i*>(ri), r);
      const float* q[4];
      for (int l = 0; l < 4; l++) q[l] = p + 2 * (ri[l] * stride + ci[l]);
      // (x00, y00, x10, y10) and (x01, y01, x11, y11) of each lane, transposed.
      __m128 x00 = _mm_loadu_ps(q[0]), y00 = _mm_loadu_ps(q[1]), x10 = _mm_loadu_ps(q[2]), y10 = _mm_loadu_ps(q[3]);
      _MM_TRANSPOSE4_PS(x00, y00, x10, y10);
      __m128 x01 = _mm_loadu_ps(q[0] + 2 * stride), y01 = _mm_loadu_ps(q[1] + 2 * stride);
      __m128 x11 = _mm_loadu_ps(q[2] + 2 * stride), y11 = _mm_loadu_ps(q[3] + 2 * stride);
      _MM_TRANSPOSE4_PS(x01, y01, x11, y11);
      // 0.14.0's forms (warp-map.ts warpInside), as the scalar loop computes them.
      const __m128 gx = _mm_sub_ps(one, fx);
      const __m128 gy = _mm_sub_ps(one, fy);
      __m128 x, y;
      if (kBilinear) {
        // (((gy·(gx·p00) + gy·(fx·p10)) + fy·(gx·p01)) + fy·(fx·p11))
        x = _mm_add_ps(_mm_add_ps(_mm_add_ps(_mm_mul_ps(gy, _mm_mul_ps(gx, x00)), _mm_mul_ps(gy, _mm_mul_ps(fx, x10))),
                                  _mm_mul_ps(fy, _mm_mul_ps(gx, x01))),
                       _mm_mul_ps(fy, _mm_mul_ps(fx, x11)));
        y = _mm_add_ps(_mm_add_ps(_mm_add_ps(_mm_mul_ps(gy, _mm_mul_ps(gx, y00)), _mm_mul_ps(gy, _mm_mul_ps(fx, y10))),
                                  _mm_mul_ps(fy, _mm_mul_ps(gx, y01))),
                       _mm_mul_ps(fy, _mm_mul_ps(fx, y11)));
      } else {
        // Lower: ((gx − fy)·p00 + fx·p10) + fy·p01; upper: ((fy − gx)·p11 + gx·p01) + gy·p10.
        const __m128 lower = _mm_cmple_ps(_mm_add_ps(fx, fy), one);
        const __m128 w = _mm_sub_ps(gx, fy);
        const __m128 e = _mm_sub_ps(fy, gx);
        const __m128 lx = _mm_add_ps(_mm_add_ps(_mm_mul_ps(w, x00), _mm_mul_ps(fx, x10)), _mm_mul_ps(fy, x01));
        const __m128 ly = _mm_add_ps(_mm_add_ps(_mm_mul_ps(w, y00), _mm_mul_ps(fx, y10)), _mm_mul_ps(fy, y01));
        const __m128 ux = _mm_add_ps(_mm_add_ps(_mm_mul_ps(e, x11), _mm_mul_ps(gx, x01)), _mm_mul_ps(gy, x10));
        const __m128 uy = _mm_add_ps(_mm_add_ps(_mm_mul_ps(e, y11), _mm_mul_ps(gx, y01)), _mm_mul_ps(gy, y10));
        x = _mm_or_ps(_mm_and_ps(lower, lx), _mm_andnot_ps(lower, ux));
        y = _mm_or_ps(_mm_and_ps(lower, ly), _mm_andnot_ps(lower, uy));
      }
      const __m128 lo = _mm_unpacklo_ps(x, y);
      const __m128 hi = _mm_unpackhi_ps(x, y);
      if (inside == 0xF) {
        _mm_storeu_ps(dst + 2 * n, lo);
        _mm_storeu_ps(dst + 2 * n + 4, hi);
        continue;
      }
      _mm_store_ps(out, lo);
      _mm_store_ps(out + 4, hi);
    }
    alignas(16) float uv[8];
    _mm_store_ps(uv, a);
    _mm_store_ps(uv + 4, b);
    for (int l = 0; l < 4; l++)
      if (!((inside >> l) & 1)) warp_outside(p, R, C, uv[2 * l], uv[2 * l + 1], out + 2 * l);
    std::memcpy(dst + 2 * n, out, sizeof out);
  }
  warp_points_scalar<kBilinear>(p, R, C, src + 2 * n, dst + 2 * n, count - n);
}
#endif

}  // namespace

void warp_points(const float* p, int R, int C, bool bilinear, const float* src, float* dst, int count) {
#ifdef MOCHI2D_WARP_SSE2
  if (bilinear)
    warp_points_sse2<true>(p, R, C, src, dst, count);
  else
    warp_points_sse2<false>(p, R, C, src, dst, count);
#else
  warp_points_reference(p, R, C, bilinear, src, dst, count);
#endif
}

void warp_points_reference(const float* p, int R, int C, bool bilinear, const float* src, float* dst, int count) {
  if (bilinear)
    warp_points_scalar<true>(p, R, C, src, dst, count);
  else
    warp_points_scalar<false>(p, R, C, src, dst, count);
}

bool warp_points_simd() {
#ifdef MOCHI2D_WARP_SSE2
  return true;
#else
  return false;
#endif
}

float evaluation_value(float v, float min, float max, bool repeat) {
  if (!repeat) return v < min ? min : v > max ? max : v;
  const float range = max - min;
  if (!(range > 0)) return min;
  // 0.14.0 (binding.ts evaluationValue): always wrapped, inside the range too:
  // u = (v − L)/Δ, u′ = u − ⌊u⌋, v′ = u′·Δ + L (the maximum wraps to the minimum).
  const float u = (v - min) / range;
  const float w = u - std::floor(u);
  return w * range + min;
}

float applied_value(double given, float min, float max, bool repeat) {
  const float v = static_cast<float>(given);
  if (repeat) return v;
  return v < min ? min : v > max ? max : v;
}

// ------------------------------------------------------------------ plan

namespace {

/** Object.is on float32 values: NaN is itself, +0 and −0 differ. */
inline bool same_float(float a, float b) {
  if (std::isnan(a) || std::isnan(b)) return std::isnan(a) && std::isnan(b);
  uint32_t x, y;
  std::memcpy(&x, &a, sizeof x);
  std::memcpy(&y, &b, sizeof y);
  return x == y;
}

bool same_arrays(const Vector<float>& a, const Vector<float>& b) {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); i++)
    if (!same_float(a[i], b[i])) return false;
  return true;
}

/** Every value is ±0. */
bool all_zero(const Vector<float>& values) {
  for (float x : values)
    if (!(x == 0)) return false;
  return true;
}

/** Same content, so the same evaluation result (plan.ts sameProp). */
bool same_prop(const ScalarProp& a, const ScalarProp& b) {
  if (!same_float(a.constant, b.constant) || a.fold_active != b.fold_active || !same_arrays(a.values, b.values) ||
      a.blend_slots != b.blend_slots)
    return false;
  for (std::size_t j = 0; j < a.blend_values.size(); j++)
    if (!same_arrays(a.blend_values[j], b.blend_values[j])) return false;
  return true;
}

/** Properties equal to the previous one share its evaluation (plan.ts shareEqualNeighbours). */
void share_equal_neighbours(Vector<ScalarProp>& props) {
  for (std::size_t ch = 1; ch < props.size(); ch++) props[ch].shared = same_prop(props[ch], props[ch - 1]);
}

constexpr int32_t kFoldAlways = std::numeric_limits<int32_t>::max();

/**
 * The folded value and its exactness bound (plan.ts fold): every value the
 * same finite float32 c; any number of active bindings for c = ±0 (folded to
 * +0), one for c = ±2^k with k ≥ 0, none otherwise.
 */
void fold(ScalarProp& p) {
  const float c = p.values.empty() ? std::numeric_limits<float>::quiet_NaN() : p.values[0];
  for (std::size_t i = 1; i < p.values.size(); i++)
    if (!same_float(p.values[i], c)) return;
  if (!std::isfinite(c)) return;
  if (c == 0) {
    p.constant = 0.0f;
    p.fold_active = kFoldAlways;
    return;
  }
  const double e = fdlibm::log2(std::fabs(static_cast<double>(c)));
  p.constant = c;
  p.fold_active = e == std::floor(e) && e >= 0 ? 1 : 0;
}

ScalarProp fixed_prop(float value) {
  ScalarProp p;
  p.values = {value};
  p.constant = value;
  p.fold_active = kFoldAlways;
  return p;
}

}  // namespace

void Instance::build_plan() {
  const Model& m = *model_;
  const int v = m.version;
  const auto& kf = m.keyforms;
  // An object's blend-shape bindings, or none when blend shapes are off (plan.ts blendShapeLists).
  static const Vector<BlendShapeBinding> kNoBlendShapes;
  const bool with_blend_shapes = blend_shapes_on_;
  auto bs = [with_blend_shapes](const Vector<BlendShapeBinding>& list) -> const Vector<BlendShapeBinding>& {
    return with_blend_shapes ? list : kNoBlendShapes;
  };
  HashMap<const BlendShapeBinding*, int32_t> blend_index;
  auto reg = [&](const Vector<BlendShapeBinding>& list, const Vector<int32_t>* first_position) {
    Vector<int32_t> out;
    for (const auto& b : list) {
      auto it = blend_index.find(&b);
      if (it == blend_index.end()) {
        BlendPlan bp;
        bp.binding = &b;
        if (first_position)
          for (std::size_t k = 0; k < b.keys.size(); k++)
            bp.position_offsets.push_back(static_cast<int>(k) == b.base_key
                                              ? -1
                                              : (*first_position)[Z(b.first_keyform + static_cast<long long>(k))]);
        it = blend_index.emplace(&b, static_cast<int32_t>(blends_.size())).first;
        blends_.push_back(std::move(bp));
      }
      out.push_back(it->second);
    }
    return out;
  };
  auto finite_weights = [&](const BlendShapeBinding& b) {
    for (int32_t ci : b.constraints)
      for (float w : m.constraints[Z(ci)].weights)
        if (!std::isfinite(w)) return false;
    return true;
  };
  auto keyform_count = [&](int band) { return m.bands[Z(band)].keyform_count; };
  // A scalar property from a per-keyform accessor (plan.ts ValueBuilder.scalar):
  // `with_blends` = blend shapes apply to it; `draw_order` = its interpolated
  // value is folded whatever its blend shapes (the instance adds those apart);
  // `blend_at` reads the blend-shape keyforms when they are not in the same
  // array as the normal ones (offscreens: normal keyforms through the owner
  // part's, blend-shape keyforms straight from the offscreen keyforms).
  auto scalar_with = [&](int band, int first, const Vector<BlendShapeBinding>& list, bool with_blends, const auto& at,
                         bool draw_order, const auto& blend_at) {
    ScalarProp p;
    const int n = keyform_count(band);
    p.values.resize(Z(n));
    for (int o = 0; o < n; o++) p.values[Z(o)] = at(first + o);
    if (with_blends)
      for (std::size_t j = 0; j < list.size(); j++) {
        const auto& b = list[j];
        Vector<float> vals(b.keys.size());
        for (std::size_t k = 0; k < b.keys.size(); k++)
          vals[k] = static_cast<int>(k) == b.base_key ? 0.0f : blend_at(b.first_keyform + static_cast<int>(k));
        // A step adds ±0 when all its values are ±0 and its weights are finite (w·0 with w = ±∞ is NaN).
        if (all_zero(vals) && finite_weights(b)) continue;
        p.blend_slots.push_back(static_cast<int32_t>(j));
        p.blend_values.push_back(std::move(vals));
      }
    if (p.blend_slots.empty() || draw_order) fold(p);
    return p;
  };
  auto scalar = [&](int band, int first, const Vector<BlendShapeBinding>& list, bool with_blends, const auto& at,
                    bool draw_order = false) { return scalar_with(band, first, list, with_blends, at, draw_order, at); };
  // Six colors (multiply r g b, screen r g b): constant white and black before version 4.
  auto color_props = [&](Vector<ScalarProp>& props, int band, int first, const Vector<BlendShapeBinding>& list,
                         bool with_blends, const moc::ColorIndices& idx) {
    if (v < 4) {
      for (float c : {1.0f, 1.0f, 1.0f, 0.0f, 0.0f, 0.0f}) props.push_back(fixed_prop(c));
      return;
    }
    for (int ch = 0; ch < 3; ch++)
      props.push_back(scalar(band, first, list, with_blends,
                             [&](int k) { return m.multiply_colors[Z(idx.multiply[Z(k)] * 3LL + ch)]; }));
    for (int ch = 0; ch < 3; ch++)
      props.push_back(scalar(band, first, list, with_blends,
                             [&](int k) { return m.screen_colors[Z(idx.screen[Z(k)] * 3LL + ch)]; }));
  };
  // Per normal keyform: its run of `length` floats holds no −0, so 0 + Q = Q.
  auto plain_runs = [&](const Vector<int32_t>& offsets, int length) {
    Vector<uint8_t> out(offsets.size(), 1);
    for (std::size_t k = 0; k < offsets.size(); k++)
      for (int i = 0; i < length; i++) {
        const float q = m.positions[Z(offsets[k] + static_cast<long long>(i))];
        if (q == 0 && std::signbit(q)) {
          out[k] = 0;
          break;
        }
      }
    return out;
  };

  // Deformers.
  const auto& d = m.deformers;
  for (std::size_t i = 0; i < d.ids.size(); i++) {
    DeformerPlan p;
    p.band = d.band[i];
    const int k = d.kind_index[i];
    const bool blend = v >= 5;
    if (d.kind[i] == moc::kWarpKind) {
      p.kind = 0;
      const int first = m.warps.first_keyform[Z(k)];
      const auto& list = bs(m.blend_shapes.warp[Z(k)]);
      p.rows = m.warps.rows[Z(k)];
      p.columns = m.warps.columns[Z(k)];
      p.grid_length = 2 * (p.rows + 1) * (p.columns + 1);
      for (int o = 0; o < keyform_count(p.band); o++) p.position_offsets.push_back(kf.warp_first_position[Z(first + o)]);
      p.plain_run = plain_runs(p.position_offsets, p.grid_length);
      p.blends = reg(list, &kf.warp_first_position);
      p.bilinear = m.warps.bilinear[Z(k)] == 1;
      p.first_keyform = first;
      p.props.push_back(scalar(p.band, first, list, blend, [&](int x) { return kf.warp_opacity[Z(x)]; }));
      color_props(p.props, p.band, first, list, blend, kf.warp_colors);
    } else {
      p.kind = 1;
      const int first = m.rotations.first_keyform[Z(k)];
      const auto& list = bs(m.blend_shapes.rotation[Z(k)]);
      p.blends = reg(list, nullptr);
      p.base_angle = m.rotations.base_angle[Z(k)];
      p.first_keyform = first;
      p.props.push_back(scalar(p.band, first, list, blend, [&](int x) { return kf.rotation_opacity[Z(x)]; }));
      color_props(p.props, p.band, first, list, blend, kf.rotation_colors);
      p.props.push_back(scalar(p.band, first, list, blend, [&](int x) { return kf.rotation_angle[Z(x)]; }));
      p.props.push_back(scalar(p.band, first, list, blend, [&](int x) { return kf.rotation_origin_x[Z(x)]; }));
      p.props.push_back(scalar(p.band, first, list, blend, [&](int x) { return kf.rotation_origin_y[Z(x)]; }));
      p.props.push_back(scalar(p.band, first, list, blend, [&](int x) { return kf.rotation_scale[Z(x)]; }));
    }
    share_equal_neighbours(p.props);
    deformers_.push_back(std::move(p));
  }

  // Meshes.
  const auto& me = m.meshes;
  for (std::size_t i = 0; i < me.ids.size(); i++) {
    MeshPlan p;
    p.band = me.band[i];
    const int first = me.first_keyform[i];
    const auto& list = bs(m.blend_shapes.mesh[i]);
    const bool full = v >= 5;
    for (int o = 0; o < keyform_count(p.band); o++) p.position_offsets.push_back(kf.mesh_first_position[Z(first + o)]);
    p.plain_run = plain_runs(p.position_offsets, 2 * me.vertex_count[i]);
    p.blends = reg(list, &kf.mesh_first_position);
    p.props.push_back(scalar(p.band, first, list, full, [&](int x) { return kf.mesh_opacity[Z(x)]; }));
    p.props.push_back(scalar(p.band, first, list, full, [&](int x) { return kf.mesh_draw_order[Z(x)]; }, true));
    color_props(p.props, p.band, first, list, full, kf.mesh_colors);
    share_equal_neighbours(p.props);
    meshes_.push_back(std::move(p));
  }

  // Parts (draw order) and glues (intensity).
  for (std::size_t p = 0; p < m.parts.ids.size(); p++) {
    SimplePlan sp;
    sp.band = m.parts.band[p];
    const auto& list = bs(m.blend_shapes.part[p]);
    sp.blends = reg(list, nullptr);
    sp.props.push_back(scalar(sp.band, m.parts.first_keyform[p], list, v >= 5,
                              [&](int x) { return kf.part_draw_order[Z(x)]; }, true));
    parts_.push_back(std::move(sp));
  }
  for (std::size_t g = 0; g < m.glues.ids.size(); g++) {
    SimplePlan sp;
    sp.band = m.glues.band[g];
    const auto& list = bs(m.blend_shapes.glue[g]);
    sp.blends = reg(list, nullptr);
    sp.props.push_back(scalar(sp.band, m.glues.first_keyform[g], list, v >= 5, [&](int x) { return kf.glue_intensity[Z(x)]; }));
    glues_.push_back(std::move(sp));
  }

  // Offscreens (plan.ts offscreen): normal keyforms through the owning part's
  // (the part→offscreen keyform map; −1 gives opacity and colors 0); blend shapes their own, from the offscreen
  // targets (count 37), never the owner part's, with their keyforms read
  // straight from the offscreen keyforms (colors through each keyform's own
  // multiply and screen indices).
  const auto& map = kf.part_offscreen_keyform;
  for (std::size_t o = 0; o < m.offscreens.part.size(); o++) {
    OffscreenPlan op;
    op.owner = m.offscreens.part[o];
    op.band = m.parts.band[Z(op.owner)];
    const int first = m.parts.first_keyform[Z(op.owner)];
    const auto& list = bs(m.blend_shapes.offscreen[o]);
    const auto& idx = kf.offscreen_colors;
    auto prop = [&](const auto& read) {
      return scalar_with(
          op.band, first, list, true, [&](int k) { return map[Z(k)] >= 0 ? read(map[Z(k)]) : 0.0f; }, false, read);
    };
    op.props.push_back(prop([&](int ok) { return kf.offscreen_opacity[Z(ok)]; }));
    for (int ch = 0; ch < 3; ch++)
      op.props.push_back(prop([&](int ok) { return m.multiply_colors[Z(idx.multiply[Z(ok)] * 3LL + ch)]; }));
    for (int ch = 0; ch < 3; ch++)
      op.props.push_back(prop([&](int ok) { return m.screen_colors[Z(idx.screen[Z(ok)] * 3LL + ch)]; }));
    share_equal_neighbours(op.props);
    for (int p = m.parts.parent[Z(op.owner)]; p >= 0; p = m.parts.parent[Z(p)]) {
      if (m.parts.offscreen[Z(p)] >= 0) break;
      op.part_chain.push_back(p);
    }
    op.blends = reg(list, nullptr);
    offscreens_.push_back(std::move(op));
  }

  is_glued_.assign(me.ids.size(), 0);
  for (std::size_t g = 0; glue_on_ && g < m.glues.ids.size(); g++) {
    is_glued_[Z(m.glues.mesh_a[g])] = 1;
    is_glued_[Z(m.glues.mesh_b[g])] = 1;
  }
  for (std::size_t i = 0; i < is_glued_.size(); i++)
    if (is_glued_[i]) glue_meshes_.push_back(static_cast<int32_t>(i));
}

// ------------------------------------------------------------- instance

uint64_t Instance::Serial::next() {
  static std::atomic<uint64_t> counter{0};
  return ++counter;
}

Instance::Instance(std::shared_ptr<const Model> model, const InstanceOptions& options)
    : model_(std::move(model)),
      incremental_(options.incremental),
      glue_on_(options.glue),
      blend_shapes_on_(options.blend_shapes) {
  const Model& m = *model_;
  build_plan();
  const std::size_t P = m.parameters.ids.size();
  parameter_values = m.parameters.defaults;
  eval_values_.assign(P, 0.0f);
  part_opacities = m.parts.initial_opacity;
  for (std::size_t i = 0; i < P; i++) param_index_.emplace(m.parameters.ids[i], static_cast<int>(i));
  for (std::size_t i = 0; i < m.parts.ids.size(); i++) part_index_.emplace(m.parts.ids[i], static_cast<int>(i));
  const std::size_t nb = m.bindings.keys.size();
  seg_index_.assign(nb, 0);
  seg_t_.assign(nb, 0.0f);
  seg_out_of_range_.assign(nb, 0);
  seg_changed_.assign(nb, 0);
  const std::size_t NB = m.bands.size();
  K_ = 1;
  for (const auto& band : m.bands) K_ = std::max(K_, band.bindings.size());
  band_base_.assign(NB, 0);
  band_active_.assign(NB, 0);
  band_out_of_range_.assign(NB, 0);
  band_changed_.assign(NB, 0);
  band_stride_.assign(NB * K_, 0);
  band_t_.assign(NB * K_, 0.0f);
  band_w_.assign(NB * 16, 0.0f);
  band_o_.assign(NB * 16, 0);
  blend_index_.assign(blends_.size(), 0);
  blend_t_.assign(blends_.size(), 0.0f);
  blend_weight_.assign(blends_.size(), 0.0f);
  blend_wa_.assign(blends_.size(), 0.0f);
  blend_wb_.assign(blends_.size(), 0.0f);
  blend_changed_.assign(blends_.size(), 0);
  const std::size_t D = m.deformers.ids.size();
  deformer_active.assign(D, 0);
  deformer_dirty_.assign(D, 0);
  deformer_opacity_.assign(D, 0.0f);
  deformer_colors_.assign(D * 6, 0.0f);
  sigma_.assign(D, 0.0f);
  rot_ox_.assign(D, 0.0f);
  rot_oy_.assign(D, 0.0f);
  rot_angle_.assign(D, 0.0f);
  rot_scale_.assign(D, 0.0f);
  rot_c_.assign(D, 0.0f);
  rot_s_.assign(D, 0.0f);
  rot_mirror_x_.assign(D, 0);
  rot_mirror_y_.assign(D, 0);
  const std::size_t N = m.meshes.ids.size();
  drawable_active.assign(N, 0);
  drawable_visible.assign(N, 0);
  drawable_opacity.assign(N, 0.0f);
  drawable_draw_order.assign(N, 0);
  drawable_render_order.assign(N, 0);
  drawable_multiply.assign(N * 3, 0.0f);
  drawable_screen.assign(N * 3, 0.0f);
  drawable_vertex_version.assign(N, 0);
  mesh_evaluated_.assign(N, 0);
  mesh_stale_.assign(N, 1);
  was_active_.assign(N, 0);
  for (std::size_t i = 0; i < N; i++) {
    Vector<int32_t> chain;
    for (int p = m.meshes.part[i]; p >= 0; p = m.parts.parent[Z(p)]) {
      if (m.parts.offscreen[Z(p)] >= 0) break;
      chain.push_back(p);
    }
    mesh_part_chain_.push_back(std::move(chain));
  }
  const std::size_t O = m.offscreens.part.size();
  offscreen_opacity.assign(O, 0.0f);
  offscreen_render_order.assign(O, 0);
  offscreen_multiply.assign(O * 3, 0.0f);
  offscreen_screen.assign(O * 3, 0.0f);
  part_active.assign(m.parts.ids.size(), 0);
  part_draw_order.assign(m.parts.ids.size(), 0);
  has_colors_ = m.version >= 4;
  // From version 5; version 6 is taken to behave the same.
  clamp_targets_ = m.version >= 5;
  // Before version 4 every drawable, never-active ones included, reports multiply (1, 1, 1) (C23).
  if (!has_colors_) std::fill(drawable_multiply.begin(), drawable_multiply.end(), 1.0f);
  flip_output_ = (m.canvas.flags & 1) == 0;
  std::size_t max_run = 4;
  for (const auto& dp : deformers_) {
    grids_.emplace_back(Z(dp.kind == 0 ? dp.grid_length : 0), 0.0f);
    max_run = std::max(max_run, Z(dp.grid_length));
  }
  for (std::size_t i = 0; i < N; i++) {
    const std::size_t V = Z(m.meshes.vertex_count[i]);
    local_.emplace_back(2 * V, 0.0f);
    drawable_vertices.emplace_back(2 * V, 0.0f);
    max_run = std::max(max_run, 2 * V);
  }
  zeros_.assign(max_run, 0.0f);
  nans_.assign(max_run, kNaN32);
  // The runtime evaluates once at creation (C4).
  evaluate();
}

int Instance::parameter_index(const String& id) const {
  auto it = param_index_.find(id);
  return it == param_index_.end() ? -1 : it->second;
}

int Instance::part_index(const String& id) const {
  auto it = part_index_.find(id);
  return it == part_index_.end() ? -1 : it->second;
}

void Instance::set_parameter(int index, double value) {
  const auto& p = model_->parameters;
  parameter_values[Z(index)] = applied_value(value, p.min[Z(index)], p.max[Z(index)], p.repeat[Z(index)] == 1);
}

void Instance::set_part_opacity(int index, double value) {
  const float v = static_cast<float>(value);
  part_opacities[Z(index)] = v < 0 ? 0.0f : v > 1 ? 1.0f : v;
}

void Instance::evaluate() {
  last_work = Work();
  locate_bindings();
  evaluate_parts();
  evaluate_deformers();
  evaluate_meshes();
  apply_glue();
  convert_output();
  evaluate_offscreens();
  compute_render_order();
  first_evaluation_ = false;
  evaluations++;
}

/** §1c.1 and §1c.2 for every parameter binding, then per-band corners and blend-shape locations. */
void Instance::locate_bindings() {
  const Model& m = *model_;
  const auto& p = m.parameters;
  for (std::size_t i = 0; i < eval_values_.size(); i++)
    eval_values_[i] = evaluation_value(parameter_values[i], p.min[i], p.max[i], p.repeat[i] == 1);
  for (std::size_t b = 0; b < m.bindings.keys.size(); b++) {
    int32_t index;
    float t;
    const bool oor = locate_key(m.bindings.keys[b], eval_values_[Z(m.bindings.parameter[b])], index, t, m.bindings.epsilon[b]);
    seg_changed_[b] = index != seg_index_[b] || t != seg_t_[b] ? 1 : 0;
    seg_index_[b] = index;
    seg_t_[b] = t;
    seg_out_of_range_[b] = oor ? 1 : 0;
  }
  // Bands: lower corner, active (t ≠ 0) bindings, range and change flags.
  const bool all = first_evaluation_ || !incremental_;
  for (std::size_t bi = 0; bi < m.bands.size(); bi++) {
    const auto& band = m.bands[bi];
    int32_t base = 0;
    int32_t active = 0;
    uint8_t oor = 0, changed = 0;
    for (std::size_t j = 0; j < band.bindings.size(); j++) {
      const auto b = Z(band.bindings[j]);
      const int32_t s = band.strides[j];
      base += seg_index_[b] * s;
      const float t = seg_t_[b];
      if (t != 0) {
        band_stride_[bi * K_ + Z(active)] = s;
        band_t_[bi * K_ + Z(active)] = t;
        active++;
      }
      oor |= seg_out_of_range_[b];
      changed |= seg_changed_[b];
    }
    band_base_[bi] = base;
    band_active_[bi] = active;
    band_out_of_range_[bi] = oor;
    band_changed_[bi] = changed;
    if (active <= 4 && (changed || all))
      corner_tables(static_cast<int>(bi), active, band_w_.data() + bi * 16, band_o_.data() + bi * 16);
  }
  frame_++;
  // Blend shapes: location (without snapping) and weight once per binding.
  for (std::size_t g = 0; g < blends_.size(); g++) {
    const BlendShapeBinding& bs = *blends_[g].binding;
    int32_t index;
    float t;
    locate_blend_key(bs.keys, eval_values_[Z(bs.parameter)], index, t);
    const float w = blend_shape_weight(bs);
    const float old = blend_weight_[g];
    // The sign of a zero weight can matter (r + w·0 with r = −0), so compare exactly.
    const bool same_weight = w == old && (w != 0 || std::signbit(w) == std::signbit(old));
    blend_changed_[g] = index != blend_index_[g] || t != blend_t_[g] || !same_weight ? 1 : 0;
    blend_index_[g] = index;
    blend_t_[g] = t;
    blend_weight_[g] = w;
    // The S2 weights (1 − t, t), except in the segment that starts
    // at the base key, whose keyform reads as zeros: there the other keyform
    // weighs f32(1 − f32(1 − t)).
    const float u = 1 - t;
    blend_wa_[g] = u;
    blend_wb_[g] = index == bs.base_key ? 1 - u : t;
  }
}

/**
 * S2's corner weights and keyform offsets of a band: for corner c (bit L =
 * the L-th active binding at its upper key), the float32 running product
 * over the active bindings in band order of t or f32(1 − t), from 1, and the
 * sum of the strides of the bits set.
 */
void Instance::corner_tables(int band, int active, float* W, int32_t* O) const {
  const std::size_t row = Z(band) * K_;
  const std::size_t n = std::size_t{1} << active;
  for (std::size_t c = 0; c < n; c++) {
    float w = 1;
    int32_t o = 0;
    for (int L = 0; L < active; L++) {
      const float t = band_t_[row + Z(L)];
      if (c & (std::size_t{1} << L)) {
        w = w * t;
        o += band_stride_[row + Z(L)];
      } else {
        w = w * (1 - t);
      }
    }
    W[c] = w;
    O[c] = o;
  }
}

void Instance::big_tables(int band) {
  if (big_band_ == band && big_frame_ == frame_) return;
  const int active = band_active_[Z(band)];
  const std::size_t n = std::size_t{1} << active;
  if (big_w_.size() < n) {
    big_w_.resize(n);
    big_o_.resize(n);
  }
  corner_tables(band, active, big_w_.data(), big_o_.data());
  big_band_ = band;
  big_frame_ = frame_;
}

void Instance::tables(int band, const float*& W, const int32_t*& O) {
  if (band_active_[Z(band)] > 4) {
    big_tables(band);
    W = big_w_.data();
    O = big_o_.data();
  } else {
    W = band_w_.data() + Z(band) * 16;
    O = band_o_.data() + Z(band) * 16;
  }
}

float Instance::blend_shape_weight(const BlendShapeBinding& b) const {
  if (b.constraints.empty()) return 1;
  // min(1, c₁, …, c_m): a weight above 1 does not amplify; negative ones are used as stored.
  float w = 1;
  for (int32_t ci : b.constraints) {
    const auto& con = model_->constraints[Z(ci)];
    const float u = eval_values_[Z(con.parameter)];
    const auto& ks = con.keys;
    const auto& ws = con.weights;
    float cv;
    if (u <= ks[0]) {
      cv = ws[0];
    } else if (u >= ks.back()) {
      cv = ws.back();
    } else {
      std::size_t i = 0;
      while (i + 1 < ks.size() && !(u < ks[i + 1])) i++;
      const float t = (u - ks[i]) / (at_or_nan(ks, i + 1) - ks[i]);
      // 0.14.0: the weighted form of keyforms, not a lerp.
      cv = (1 - t) * ws[i] + t * at_or_nan(ws, i + 1);
    }
    if (cv < w) w = cv;
  }
  return w;
}

bool Instance::blends_changed(const Vector<int32_t>& list) const {
  for (int32_t g : list)
    if (blend_changed_[Z(g)]) return true;
  return false;
}

/** S2's weighted sum of a scalar property: from +0, r ← f32(r + f32(w·Q)) per corner. */
float Instance::sum_interp(const Vector<float>& values, int band) {
  const int active = band_active_[Z(band)];
  const int base = band_base_[Z(band)];
  if (active == 0) return 0.0f + at_or_nan(values, Z(base));
  const float* W;
  const int32_t* O;
  tables(band, W, O);
  const std::size_t n = std::size_t{1} << active;
  float r = 0;
  for (std::size_t c = 0; c < n; c++) r = r + W[c] * at_or_nan(values, Z(base + O[c]));
  return r;
}

/** One blend-shape contribution f32(w·s) of binding g (§1c.4, S4). */
float Instance::blend_step(int g, const Vector<float>& vals) const {
  const int i = blend_index_[Z(g)];
  const float s =
      blend_t_[Z(g)] == 0 ? vals[Z(i)] : blend_wa_[Z(g)] * vals[Z(i)] + blend_wb_[Z(g)] * at_or_nan(vals, Z(i + 1));
  return blend_weight_[Z(g)] * s;
}

void Instance::eval_props(const Vector<ScalarProp>& props, int count, int band, const Vector<int32_t>& blends,
                          int draw_order_at, bool target) {
  const int active = band_active_[Z(band)];
  for (int p = 0; p < count; p++) {
    const ScalarProp& prop = props[Z(p)];
    if (p == draw_order_at) {
      pv_[p] = static_cast<float>(draw_order(prop, band, blends, target));
      continue;
    }
    if (p > 0 && prop.shared && p - 1 != draw_order_at) {
      pv_[p] = pv_[p - 1];
      continue;
    }
    if (prop.constant == prop.constant && active <= prop.fold_active) {
      pv_[p] = prop.constant;  // folded (not NaN), exact at this many active bindings
      continue;
    }
    float r = sum_interp(prop.values, band);
    for (std::size_t j = 0; j < prop.blend_slots.size(); j++)
      r = r + blend_step(blends[Z(prop.blend_slots[j])], prop.blend_values[j]);
    pv_[p] = r;
  }
}

/**
 * The draw order of an art mesh (§1c.9) or a part (§1c.6):
 * n = trunc(f32(D + 0.001)), D folded by the same rules as other values; a
 * version-5 blend-shape target adds its contributions to n one at a time and
 * gets min(1000, max(0, trunc(f32(r + 0.001)))).
 */
double Instance::draw_order(const ScalarProp& prop, int band, const Vector<int32_t>& blends, bool target) {
  float D;
  if (prop.constant == prop.constant && band_active_[Z(band)] <= prop.fold_active)
    D = prop.constant;
  else
    D = sum_interp(prop.values, band);
  const double n = std::trunc(static_cast<double>(D + kDrawOrderTolerance));
  if (!target || !clamp_targets_) return n;
  float r = static_cast<float>(n);
  for (std::size_t j = 0; j < prop.blend_slots.size(); j++)
    r = r + blend_step(blends[Z(prop.blend_slots[j])], prop.blend_values[j]);
  return js_clamp(std::trunc(static_cast<double>(r + kDrawOrderTolerance)), 0, kTargetDrawOrderMax);
}

/**
 * §1c.3 with S2 for a run of `length` floats of keyform positions into dst:
 * the weighted sum over the band's corners, from +0. With every binding on a
 * key it is 0 + Q, a plain copy unless the run holds −0.
 */
void Instance::interp_positions(const Vector<int32_t>& offsets, const Vector<uint8_t>& plain, int band, float* dst,
                                int length) {
  const int active = band_active_[Z(band)];
  const int base = band_base_[Z(band)];
  const float* pos = model_->positions.data();
  auto run = [&](int32_t corner) -> const float* {
    const std::size_t at = Z(base + corner);
    return at < offsets.size() ? pos + offsets[at] : nans_.data();
  };
  if (active == 0) {
    const float* q = run(0);
    if (Z(base) < plain.size() && plain[Z(base)])
      std::copy(q, q + length, dst);
    else
      for (int k = 0; k < length; k++) dst[k] = 0.0f + q[k];
    return;
  }
  const float* W;
  const int32_t* O;
  tables(band, W, O);
  if (active == 1) {
    const float* a = run(O[0]);
    const float* b = run(O[1]);
    const float wa = W[0], wb = W[1];
    for (int k = 0; k < length; k++) dst[k] = (0.0f + wa * a[k]) + wb * b[k];
    return;
  }
  // Four corners per pass, in corner order (Mochi2D's sum4 kernel).
  const std::size_t n = std::size_t{1} << active;
  for (std::size_t c = 0; c < n; c += 4) {
    const float* a = run(O[c]);
    const float* b = run(O[c + 1]);
    const float* q2 = run(O[c + 2]);
    const float* q3 = run(O[c + 3]);
    const float w0 = W[c], w1 = W[c + 1], w2 = W[c + 2], w3 = W[c + 3];
    if (c == 0)
      for (int k = 0; k < length; k++) dst[k] = (((0.0f + w0 * a[k]) + w1 * b[k]) + w2 * q2[k]) + w3 * q3[k];
    else
      for (int k = 0; k < length; k++) dst[k] = (((dst[k] + w0 * a[k]) + w1 * b[k]) + w2 * q2[k]) + w3 * q3[k];
  }
}

void Instance::blend_positions(float* dst, int length, const Vector<int32_t>& blends) const {
  const float* pos = model_->positions.data();
  for (int32_t g : blends) {
    const auto& offsets = blends_[Z(g)].position_offsets;
    const int i = blend_index_[Z(g)];
    const float t = blend_t_[Z(g)];
    const float w = blend_weight_[Z(g)];
    const float* a = offsets[Z(i)] < 0 ? zeros_.data() : pos + offsets[Z(i)];
    if (t == 0) {
      for (int k = 0; k < length; k++) dst[k] = dst[k] + w * a[k];
    } else {
      const float* b = Z(i + 1) >= offsets.size() ? nans_.data()
                       : offsets[Z(i + 1)] < 0     ? zeros_.data()
                                                   : pos + offsets[Z(i + 1)];
      const float wa = blend_wa_[Z(g)], wb = blend_wb_[Z(g)];
      for (int k = 0; k < length; k++) {
        const float s = wa * a[k] + wb * b[k];
        dst[k] = dst[k] + w * s;
      }
    }
  }
}

void Instance::map_through(int def, const float* src, float* dst, int count) const {
  const DeformerPlan& p = deformers_[Z(def)];
  if (p.kind == 1) {
    // C and S carry the world scale (f32(1·v) = v in Mochi2D's kernel).
    const float c = rot_c_[Z(def)], sn = rot_s_[Z(def)];
    const float ox = rot_ox_[Z(def)], oy = rot_oy_[Z(def)];
    const bool mx = rot_mirror_x_[Z(def)] != 0, my = rot_mirror_y_[Z(def)] != 0;
    for (int n = 0; n < count; n++) {
      const float x = mx ? -src[2 * n] : src[2 * n];
      const float y = my ? -src[2 * n + 1] : src[2 * n + 1];
      const float rx = c * x - sn * y;
      const float ry = sn * x + c * y;
      dst[2 * n] = ox + rx;
      dst[2 * n + 1] = oy + ry;
    }
    return;
  }
  warp_points(grids_[Z(def)].data(), p.rows, p.columns, p.bilinear, src, dst, count);
}

/** §1c.5 (parts) and §1c.6. */
void Instance::evaluate_parts() {
  const auto& parts = model_->parts;
  for (std::size_t p = 0; p < parts_.size(); p++) {
    const SimplePlan& plan = parts_[p];
    const int parent = parts.parent[p];
    part_active[p] = parts.enabled[p] && !band_out_of_range_[Z(plan.band)] && (parent < 0 || part_active[Z(parent)]) ? 1 : 0;
    // The draw-order formula, as for art meshes.
    eval_props(plan.props, 1, plan.band, plan.blends, 0, !plan.blends.empty());
    part_draw_order[p] = text::js_to_int32(static_cast<double>(pv_[0]));
  }
}

/** §1c.5 (deformers) and §1c.7, skipping deformers whose inputs did not change. */
void Instance::evaluate_deformers() {
  const auto& d = model_->deformers;
  const bool first = first_evaluation_ || !incremental_;
  for (std::size_t i = 0; i < deformers_.size(); i++) {
    const DeformerPlan& plan = deformers_[i];
    const int parent = d.parent[i];
    const int part = d.part[i];
    const int band = plan.band;
    deformer_active[i] = d.enabled[i] && !band_out_of_range_[Z(band)] && (part < 0 || part_active[Z(part)]) &&
                                 (parent < 0 || deformer_active[Z(parent)])
                             ? 1
                             : 0;
    const bool dirty = first || band_changed_[Z(band)] || blends_changed(plan.blends) ||
                       (parent >= 0 && deformer_dirty_[Z(parent)]);
    deformer_dirty_[i] = dirty ? 1 : 0;
    if (!dirty) continue;
    last_work.deformers++;
    // Opacity, colors and (rotations) angle, origin, scale into pv_.
    eval_props(plan.props, plan.kind == 1 ? 11 : 7, band, plan.blends);
    float* pv = pv_;
    if (clamp_targets_ && !plan.blends.empty()) {
      // A target's own values, before the parent's combine in; a rotation's keyform
      // angle before its base angle is added. Origins are not clamped.
      pv[0] = clamp_target(pv[0], 0, 1);
      if (has_colors_)
        for (int ch = 1; ch <= 6; ch++) pv[ch] = clamp_target(pv[ch], 0, 1);
      if (plan.kind == 1) {
        pv[7] = clamp_target(pv[7], -kTargetAngleLimit, kTargetAngleLimit);
        pv[10] = clamp_target(pv[10], kTargetScaleMin, kTargetScaleMax);
      }
    }
    if (plan.kind == 0)
      evaluate_warp(static_cast<int>(i), parent);
    else
      evaluate_rotation(static_cast<int>(i), parent, pv);
    const float opacity = pv[0];
    deformer_opacity_[i] = parent >= 0 ? opacity * deformer_opacity_[Z(parent)] : opacity;
    float* acc = deformer_colors_.data() + i * 6;
    if (has_colors_) {
      for (int ch = 0; ch < 6; ch++) acc[ch] = pv[1 + ch];
      if (parent >= 0) combine_colors(acc, deformer_colors_.data() + Z(parent) * 6);
    } else {
      acc[0] = acc[1] = acc[2] = 1;
      acc[3] = acc[4] = acc[5] = 0;
    }
  }
}

void Instance::evaluate_warp(int i, int parent) {
  const DeformerPlan& plan = deformers_[Z(i)];
  float* grid = grids_[Z(i)].data();
  const int band = plan.band;
  const int base = band_base_[Z(band)];
  if (parent >= 0 && band_active_[Z(band)] == 0 && plan.blends.empty() && Z(base) < plan.plain_run.size() &&
      plan.plain_run[Z(base)]) {
    // A single keyform without blend shapes, and 0 + Q = Q: map it straight from the keyform data.
    map_through(parent, model_->positions.data() + plan.position_offsets[Z(base)], grid, plan.grid_length / 2);
  } else {
    interp_positions(plan.position_offsets, plan.plain_run, band, grid, plan.grid_length);
    if (!plan.blends.empty()) blend_positions(grid, plan.grid_length, plan.blends);
    if (parent >= 0) map_through(parent, grid, grid, plan.grid_length / 2);
  }
  sigma_[Z(i)] = parent < 0 ? 1.0f : deformers_[Z(parent)].kind == 1 ? rot_scale_[Z(parent)] : sigma_[Z(parent)];
}

void Instance::evaluate_rotation(int i, int parent, const float* pv) {
  const DeformerPlan& plan = deformers_[Z(i)];
  const auto& kf = model_->keyforms;
  const float a = pv[7];
  const float x = pv[8];
  const float y = pv[9];
  const float s = pv[10];
  const int corner = plan.first_keyform + band_base_[Z(plan.band)];
  rot_mirror_x_[Z(i)] = kf.rotation_mirror_x[Z(corner)] == 1 ? 1 : 0;
  rot_mirror_y_[Z(i)] = kf.rotation_mirror_y[Z(corner)] == 1 ? 1 : 0;
  const float base = plan.base_angle;
  float ox, oy, angle, scale;
  if (parent < 0) {
    ox = x;
    oy = y;
    angle = a + base;
    scale = s;
  } else {
    // The parent's orientation, read back from two mapped probe points: the
    // origin, and a point L above it in file coordinates (y down), L = 10 under
    // a rotation and f32(0.1) under a warp. A parent's mirror flags act
    // through the probe (rotation.ts).
    const bool rotation_parent = deformers_[Z(parent)].kind == 1;
    const float in[4] = {x, y, x, y - (rotation_parent ? kProbeRotation : kProbeWarp)};
    float out[4];
    map_through(parent, in, out, 2);
    ox = out[0];
    oy = out[1];
    angle = probed_angle(a, base, ox, oy, out[2], out[3]);
    scale = s * (rotation_parent ? rot_scale_[Z(parent)] : sigma_[Z(parent)]);
  }
  // Radians without reduction, the library's float32 sine and cosine, and the
  // world scale folded into them.
  const float r = radians32(angle);
  rot_ox_[Z(i)] = ox;
  rot_oy_[Z(i)] = oy;
  rot_angle_[Z(i)] = angle;
  rot_scale_[Z(i)] = scale;
  rot_c_[Z(i)] = scale * libm32::cosf(r);
  rot_s_[Z(i)] = scale * libm32::sinf(r);
}

/**
 * §1c.5 (art meshes) and §1c.9. Vertices only for active meshes whose inputs
 * changed (or changed while they were inactive); inactive meshes keep their
 * arrays (C4).
 */
void Instance::evaluate_meshes() {
  const auto& me = model_->meshes;
  const bool first = first_evaluation_ || !incremental_;
  for (std::size_t i = 0; i < meshes_.size(); i++) {
    const MeshPlan& plan = meshes_[i];
    const int band = plan.band;
    const int part = me.part[i];
    const int def = me.deformer[i];
    drawable_active[i] = me.enabled[i] && !band_out_of_range_[Z(band)] && (part < 0 || part_active[Z(part)]) &&
                                 (def < 0 || deformer_active[Z(def)])
                             ? 1
                             : 0;
    const int V = me.vertex_count[i];
    // Vertices.
    const bool dirty = first || band_changed_[Z(band)] || blends_changed(plan.blends) ||
                       (def >= 0 && deformer_dirty_[Z(def)]);
    const bool evaluate = drawable_active[i] && (dirty || mesh_stale_[i]);
    if (!drawable_active[i] && dirty) mesh_stale_[i] = 1;
    mesh_evaluated_[i] = evaluate ? 1 : 0;
    if (evaluate) {
      mesh_stale_[i] = 0;
      last_work.meshes++;
      float* local = local_[i].data();
      const int base = band_base_[Z(band)];
      if (def >= 0 && band_active_[Z(band)] == 0 && plan.blends.empty() && Z(base) < plan.plain_run.size() &&
          plan.plain_run[Z(base)]) {
        // A single keyform without blend shapes, and 0 + Q = Q: map it straight from the keyform data.
        map_through(def, model_->positions.data() + plan.position_offsets[Z(base)], local, V);
      } else {
        interp_positions(plan.position_offsets, plan.plain_run, band, local, 2 * V);
        if (!plan.blends.empty()) blend_positions(local, 2 * V, plan.blends);
        if (def >= 0) map_through(def, local, local, V);
      }
    }
    // Opacity, draw order and colors: an inactive drawable keeps those of its
    // last active evaluation, or zeros if it was never active (C10).
    if (!drawable_active[i]) {
      // C29: an inactive mesh's blend-shape position contributions still add to
      // its reported vertices, in keyform space, accumulating. They make its
      // vertices stale: once active again it is evaluated in full, even when its
      // own inputs are unchanged, as a full evaluation would (0.10.0).
      if (!plan.blends.empty()) {
        blend_positions(drawable_vertices[i].data(), 2 * V, plan.blends);
        drawable_vertex_version[i]++;
        mesh_stale_[i] = 1;
      }
      drawable_visible[i] = 0;
      continue;
    }
    // Property 1 is the draw order.
    eval_props(plan.props, 8, band, plan.blends, 1, !plan.blends.empty());
    float* pv = pv_;
    if (clamp_targets_ && !plan.blends.empty()) {
      // A target's own opacity and colors, before the deformer and parts.
      pv[0] = clamp_target(pv[0], 0, 1);
      if (has_colors_)
        for (int ch = 2; ch < 8; ch++) pv[ch] = clamp_target(pv[ch], 0, 1);
    }
    // 0.14.0: ancestor opacities combine top-down: the parts' product from the
    // topmost part of the chain down to the mesh's own, then f32(f32(own·dacc)·acc).
    float op = pv[0];
    if (def >= 0) op = op * deformer_opacity_[Z(def)];
    const auto& chain = mesh_part_chain_[i];
    if (!chain.empty()) {
      float acc = part_opacities[Z(chain.back())];
      for (std::size_t c = chain.size() - 1; c-- > 0;) acc = acc * part_opacities[Z(chain[c])];
      op = op * acc;
    }
    drawable_opacity[i] = op;
    drawable_draw_order[i] = text::js_to_int32(static_cast<double>(pv[1]));
    if (has_colors_) {
      // The final clamp belongs to the combination with the parent deformer's
      // colors: a mesh without one reports its colors as interpolated (a
      // target's were clamped above).
      if (def >= 0) {
        float colors[6];
        for (int ch = 0; ch < 6; ch++) colors[ch] = pv[2 + ch];
        combine_colors(colors, deformer_colors_.data() + Z(def) * 6);
        for (int ch = 0; ch < 3; ch++) {
          drawable_multiply[i * 3 + Z(ch)] = clamp01(colors[ch]);
          drawable_screen[i * 3 + Z(ch)] = clamp01(colors[3 + ch]);
        }
      } else {
        for (int ch = 0; ch < 3; ch++) {
          drawable_multiply[i * 3 + Z(ch)] = pv[2 + ch];
          drawable_screen[i * 3 + Z(ch)] = pv[5 + ch];
        }
      }
    } else {
      for (int ch = 0; ch < 3; ch++) {
        drawable_multiply[i * 3 + Z(ch)] = 1;
        drawable_screen[i * 3 + Z(ch)] = 0;
      }
    }
    // Visible when active and its opacity is not 0: negative and NaN opacities are visible.
    drawable_visible[i] = op != 0 ? 1 : 0;
  }
}

/**
 * §1c.10 with C4: glues in file order, pairs applied sequentially, in place on
 * the persistent arrays of all glued meshes, active or not. Active glued
 * meshes start from their fresh positions and are converted to output space
 * afterwards; inactive ones keep their array as it stands (so their glue
 * changes accumulate from call to call). Skipped when nothing it reads
 * changed: every glued mesh active now and before, none re-evaluated, and no
 * glue's band or blend shapes moved.
 */
void Instance::apply_glue() {
  if (glues_.empty() || !glue_on_) return;
  const auto& g = model_->glues;
  const auto& vc = model_->meshes.vertex_count;
  bool run = first_evaluation_ || !incremental_;
  for (std::size_t k = 0; !run && k < glue_meshes_.size(); k++) {
    const auto d = Z(glue_meshes_[k]);
    // An inactive glued mesh changes on every call; activity changes and new positions too.
    if (!drawable_active[d] || !was_active_[d] || mesh_evaluated_[d]) run = true;
  }
  for (std::size_t k = 0; !run && k < glues_.size(); k++)
    if (band_changed_[Z(glues_[k].band)] || blends_changed(glues_[k].blends)) run = true;
  if (!run) return;
  last_work.glue = true;
  for (int32_t d : glue_meshes_) {
    // Glue writes every glued mesh's array, active or not.
    drawable_vertex_version[Z(d)]++;
    if (drawable_active[Z(d)]) std::copy(local_[Z(d)].begin(), local_[Z(d)].end(), drawable_vertices[Z(d)].begin());
  }
  for (std::size_t i = 0; i < glues_.size(); i++) {
    const SimplePlan& plan = glues_[i];
    eval_props(plan.props, 1, plan.band, plan.blends);
    // A target glue's intensity is clamped to [0, 1]; others act as stored.
    float intensity = pv_[0];
    if (clamp_targets_ && !plan.blends.empty()) intensity = clamp_target(intensity, 0, 1);
    float* A = drawable_vertices[Z(g.mesh_a[i])].data();
    float* B = drawable_vertices[Z(g.mesh_b[i])].data();
    const auto& va = g.vertex_a[i];
    const auto& vb = g.vertex_b[i];
    const auto& wa = g.weight_a[i];
    const auto& wb = g.weight_b[i];
    for (std::size_t p = 0; p < va.size(); p++) {
      float* ia = A + 2 * va[p];
      float* ib = B + 2 * vb[p];
      // 0.14.0: a′ = a + ((b − a)·w_A)·I and b′ = b + ((a − b)·w_B)·I, both read first.
      const float fa = wa[p];
      const float fb = wb[p];
      const float ax = ia[0], ay = ia[1], bx = ib[0], by = ib[1];
      ia[0] = ax + ((bx - ax) * fa) * intensity;
      ia[1] = ay + ((by - ay) * fa) * intensity;
      ib[0] = bx + ((ax - bx) * fb) * intensity;
      ib[1] = by + ((ay - by) * fb) * intensity;
    }
  }
  if (!flip_output_) return;
  for (int32_t d : glue_meshes_) {
    if (!drawable_active[Z(d)]) continue;
    auto& out = drawable_vertices[Z(d)];
    const int n = 2 * vc[Z(d)];
    for (int k = 1; k < n; k += 2) out[Z(k)] = -out[Z(k)];
  }
}

/**
 * §1c.11 for the meshes without glue that were evaluated in this call: negate
 * y unless canvas flag bit 0 is set. Arrays of meshes that were not evaluated
 * keep their contents (C4).
 */
void Instance::convert_output() {
  const auto& vc = model_->meshes.vertex_count;
  for (std::size_t i = 0; i < vc.size(); i++) {
    if (is_glued_[i] || !mesh_evaluated_[i]) continue;
    drawable_vertex_version[i]++;
    const auto& local = local_[i];
    auto& out = drawable_vertices[i];
    const std::size_t n = Z(2LL * vc[i]);
    for (std::size_t k = 0; k < n; k += 2) {
      out[k] = local[k];
      out[k + 1] = flip_output_ ? -local[k + 1] : local[k + 1];
    }
  }
  was_active_ = drawable_active;
}

/** §1c.14 (opacity and colors; render order is assigned with drawables). */
void Instance::evaluate_offscreens() {
  for (std::size_t o = 0; o < offscreens_.size(); o++) {
    const OffscreenPlan& plan = offscreens_[o];
    eval_props(plan.props, 7, plan.band, plan.blends);
    float* pv = pv_;
    // An offscreen target (count 37) is clamped like an art-mesh target: opacity
    // and colors to [0, 1], once, after all its deltas (zero ones too), before
    // the part opacities; NaN stays NaN. Other offscreens are not clamped, colors
    // included.
    if (clamp_targets_ && !plan.blends.empty())
      for (int k = 0; k < 7; k++) pv[k] = clamp_target(pv[k], 0, 1);
    float op = pv[0] * part_opacities[Z(plan.owner)];
    for (int32_t c : plan.part_chain) op = op * part_opacities[Z(c)];
    offscreen_opacity[o] = op;
    for (int ch = 0; ch < 3; ch++) {
      offscreen_multiply[o * 3 + Z(ch)] = pv[1 + ch];
      offscreen_screen[o * 3 + Z(ch)] = pv[4 + ch];
    }
  }
}

// --------------------------------------------------------------- mapping

bool Instance::map_points(int deformer, const float* points, std::size_t count, float* out, MapSpace space) const {
  if (deformer < -1 || deformer >= static_cast<int>(deformers_.size())) return false;
  const bool flip = space == MapSpace::Model && flip_output_;
  if (out != points) std::copy(points, points + 2 * count, out);  // out may equal points
  if (deformer >= 0 && count) map_through(deformer, out, out, static_cast<int>(count));
  if (flip)
    for (std::size_t i = 0; i < count; i++) out[2 * i + 1] = -out[2 * i + 1];
  return true;
}

namespace {

// Port of Mochi2D 0.5.0's src/core/eval/jacobian.ts: the Jacobian of a world
// mapping, analytic per region, in double from the float32 world form.

inline int grid_at(int C, int c, int r) { return 2 * (r * (C + 1) + c); }

void affine_axes(const float* p, int R, int C, double* out) {
  const int i00 = 0, i10 = grid_at(C, C, 0), i01 = grid_at(C, 0, R), i11 = grid_at(C, C, R);
  for (int k = 0; k < 2; k++) {
    out[k] = (static_cast<double>(p[i10 + k]) + p[i11 + k] - (static_cast<double>(p[i00 + k]) + p[i01 + k])) / 2;
    out[2 + k] = (static_cast<double>(p[i01 + k]) + p[i11 + k] - (static_cast<double>(p[i00 + k]) + p[i10 + k])) / 2;
  }
}

void affine_point(const float* p, int R, int C, double u, double v, double* out) {
  const int i00 = 0, i10 = grid_at(C, C, 0), i01 = grid_at(C, 0, R), i11 = grid_at(C, C, R);
  for (int k = 0; k < 2; k++) {
    const double z = (static_cast<double>(p[i00 + k]) + p[i10 + k] + p[i01 + k] + p[i11 + k]) / 4;
    const double du = (static_cast<double>(p[i10 + k]) + p[i11 + k] - (static_cast<double>(p[i00 + k]) + p[i01 + k])) / 2;
    const double dv = (static_cast<double>(p[i01 + k]) + p[i11 + k] - (static_cast<double>(p[i00 + k]) + p[i10 + k])) / 2;
    out[k] = z + (u - 0.5) * du + (v - 0.5) * dv;
  }
}

void warp_jacobian(const float* p, int R, int C, bool bilinear, float u, float v, double* out) {
  if (u >= 0 && u < 1 && v >= 0 && v < 1) {
    const float X = u * static_cast<float>(C);
    const float Y = v * static_cast<float>(R);
    const int c = std::min(floor_int(X), C - 1);
    const int r = std::min(floor_int(Y), R - 1);
    const float fx = X - static_cast<float>(c);
    const float fy = Y - static_cast<float>(r);
    const int i00 = grid_at(C, c, r), i10 = grid_at(C, c + 1, r), i01 = grid_at(C, c, r + 1), i11 = grid_at(C, c + 1, r + 1);
    for (int k = 0; k < 2; k++) {
      const double p00 = p[i00 + k], p10 = p[i10 + k], p01 = p[i01 + k], p11 = p[i11 + k];
      double du, dv;
      if (bilinear) {
        du = (1 - static_cast<double>(fy)) * (p10 - p00) + fy * (p11 - p01);
        dv = (1 - static_cast<double>(fx)) * (p01 - p00) + fx * (p11 - p10);
      } else if (fx + fy <= 1) {
        du = p10 - p00;
        dv = p01 - p00;
      } else {
        du = p11 - p01;
        dv = p11 - p10;
      }
      out[2 * k] = du * C;
      out[2 * k + 1] = dv * R;
    }
    return;
  }
  if (u < -2 || u > 3 || v < -2 || v > 3) {
    double axes[4];
    affine_axes(p, R, C, axes);
    out[0] = axes[0];
    out[1] = axes[2];
    out[2] = axes[1];
    out[3] = axes[3];
    return;
  }
  float u0, u1, v0, v1;
  int gc0, gc1, gr0, gr1;
  if (u < 0) {
    u0 = -2; u1 = 0; gc0 = -1; gc1 = 0;
  } else if (u > 1) {
    u0 = 1; u1 = 3; gc0 = C; gc1 = -1;
  } else {
    const int c = std::min(floor_int(u * static_cast<float>(C)), C - 1);
    u0 = static_cast<float>(c) / static_cast<float>(C);
    u1 = static_cast<float>(c + 1) / static_cast<float>(C);
    gc0 = c;
    gc1 = c + 1;
  }
  if (v < 0) {
    v0 = -2; v1 = 0; gr0 = -1; gr1 = 0;
  } else if (v > 1) {
    v0 = 1; v1 = 3; gr0 = R; gr1 = -1;
  } else {
    const int r = std::min(floor_int(v * static_cast<float>(R)), R - 1);
    v0 = static_cast<float>(r) / static_cast<float>(R);
    v1 = static_cast<float>(r + 1) / static_cast<float>(R);
    gr0 = r;
    gr1 = r + 1;
  }
  double q[8];
  auto corner = [&](int slot, int gc, int gr, float cu, float cv) {
    if (gc >= 0 && gr >= 0) {
      const int i = grid_at(C, gc, gr);
      q[slot] = p[i];
      q[slot + 1] = p[i + 1];
    } else {
      affine_point(p, R, C, cu, cv, q + slot);
    }
  };
  corner(0, gc0, gr0, u0, v0);
  corner(2, gc1, gr0, u1, v0);
  corner(4, gc0, gr1, u0, v1);
  corner(6, gc1, gr1, u1, v1);
  const float fx = (u - u0) / (u1 - u0);
  const float fy = (v - v0) / (v1 - v0);
  const bool lower = fx + fy <= 1;
  for (int k = 0; k < 2; k++) {
    const double q00 = q[k], q10 = q[2 + k], q01 = q[4 + k], q11 = q[6 + k];
    const double du = lower ? q10 - q00 : q11 - q01;
    const double dv = lower ? q01 - q00 : q11 - q10;
    out[2 * k] = du / (static_cast<double>(u1) - u0);
    out[2 * k + 1] = dv / (static_cast<double>(v1) - v0);
  }
}

}  // namespace

bool Instance::map_jacobians(int deformer, const float* points, std::size_t count, double* out, MapSpace space) const {
  if (deformer < -1 || deformer >= static_cast<int>(deformers_.size())) return false;
  const bool flip = space == MapSpace::Model && flip_output_;
  for (std::size_t i = 0; i < count; i++) {
    double* o = out + 4 * i;
    if (deformer < 0) {
      o[0] = 1;
      o[1] = 0;
      o[2] = 0;
      o[3] = 1;
    } else if (deformers_[Z(deformer)].kind == 1) {
      const auto d = Z(deformer);
      const double mx = rot_mirror_x_[d] ? -1 : 1;
      const double my = rot_mirror_y_[d] ? -1 : 1;
      const double c = rot_c_[d], sn = rot_s_[d], sc = 1;
      o[0] = sc * c * mx;
      o[1] = -sc * sn * my;
      o[2] = sc * sn * mx;
      o[3] = sc * c * my;
    } else {
      const DeformerPlan& p = deformers_[Z(deformer)];
      warp_jacobian(grids_[Z(deformer)].data(), p.rows, p.columns, p.bilinear, points[2 * i], points[2 * i + 1], o);
    }
    if (flip) {
      o[2] = -o[2];
      o[3] = -o[3];
    }
  }
  return true;
}

// --------------------------------------------------------- static output

Vector<float> output_uvs(const Model& m, int i) {
  Vector<float> uv = m.meshes.uvs[Z(i)];
  if ((m.canvas.flags & 1) == 0)
    for (std::size_t k = 1; k < uv.size(); k += 2) uv[k] = 1.0f - uv[k];
  return uv;
}

Vector<uint16_t> output_triangles(const Model& m, int i) {
  Vector<uint16_t> t = m.meshes.triangles[Z(i)];
  if ((m.canvas.flags & 1) == 0)
    for (std::size_t k = 0; k + 2 < t.size(); k += 3) std::swap(t[k], t[k + 2]);
  return t;
}

}  // namespace mochi2d::eval

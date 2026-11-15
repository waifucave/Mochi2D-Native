#include "render/renderer.hpp"

#include "render/mask_matrix.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <limits>

#include "core/eval/instance.hpp"

namespace mochi2d::render {

namespace {

/** A mask mapping (ox, sx, oy, sy) as render/mask_matrix.hpp takes it (ℓ = 0: a buffer of its own). */
template <class Map>
MaskMapping mapping(const Map& m) {
  MaskMapping out;
  out.ox = m.ox;
  out.oy = m.oy;
  out.sx = m.sx;
  out.sy = m.sy;
  return out;
}

constexpr uint8_t kDoubleSided = 4;
constexpr uint8_t kInvertedMask = 8;

inline std::size_t Z(long long x) { return static_cast<std::size_t>(x); }

/**
 * A float in [0, 1] as a stored byte: clamped, then round to nearest (the
 * fixed-point conversion). x·255 lies in (0, 255) here, where adding and
 * subtracting 2²³ rounds it as nearbyint does (ties to even), inline.
 */
inline uint8_t to_byte(float x) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 255;
  const float y = x * 255.0f;
  return static_cast<uint8_t>(static_cast<int>((y + 8388608.0f) - 8388608.0f));
}

inline float clamp01(float x) { return x > 0 ? (x < 1 ? x : 1.0f) : 0.0f; }

/** b / 255 for every byte value, divided once (the same correctly rounded quotients). */
struct ByteFloats {
  float v[256];
};
constexpr ByteFloats byte_floats() {
  ByteFloats t{};
  for (int i = 0; i < 256; i++) t.v[i] = static_cast<float>(i) / 255.0f;
  return t;
}
constexpr ByteFloats kByteFloats = byte_floats();

inline float from_byte(uint8_t b) { return kByteFloats.v[b]; }

// ----------------------------------------------------------- textures

// ------------------------------------------------------------ sampling

/** One bilinear lookup of a level (GL LINEAR), REPEAT or CLAMP_TO_EDGE wrapping. */
void bilinear(const Texture::Level& l, float u, float v, bool repeat, float out[4]) {
  const float s = u * static_cast<float>(l.width) - 0.5f;
  const float t = v * static_cast<float>(l.height) - 0.5f;
  const float fs = std::floor(s), ft = std::floor(t);
  const float a = s - fs, b = t - ft;
  long long i0 = static_cast<long long>(fs), j0 = static_cast<long long>(ft);
  auto wrap = [&](long long i, int n) -> long long {
    if (i >= 0 && i < n) return i;
    if (repeat) {
      i %= n;
      return i < 0 ? i + n : i;
    }
    return i < 0 ? 0 : n - 1;
  };
  const long long x0 = wrap(i0, l.width), x1 = wrap(i0 + 1, l.width);
  const long long y0 = wrap(j0, l.height), y1 = wrap(j0 + 1, l.height);
  const uint8_t* p00 = &l.rgba[Z((y0 * l.width + x0) * 4)];
  const uint8_t* p10 = &l.rgba[Z((y0 * l.width + x1) * 4)];
  const uint8_t* p01 = &l.rgba[Z((y1 * l.width + x0) * 4)];
  const uint8_t* p11 = &l.rgba[Z((y1 * l.width + x1) * 4)];
  for (int ch = 0; ch < 4; ch++) {
    const float c00 = from_byte(p00[ch]), c10 = from_byte(p10[ch]);
    const float c01 = from_byte(p01[ch]), c11 = from_byte(p11[ch]);
    const float top = c00 + (c10 - c00) * a;
    const float bottom = c01 + (c11 - c01) * a;
    out[ch] = top + (bottom - top) * b;
  }
}

/**
 * texture() with LINEAR_MIPMAP_LINEAR minification and LINEAR magnification
 * (GL ES 3.0 §3.8.10): λ ≤ 0 magnifies (level 0); otherwise the two levels
 * around λ, blended by its fraction (the last level from λ ≥ q on).
 */
void sample(const Texture& t, float u, float v, double lambda, float out[4]) {
  const int q = static_cast<int>(t.levels.size()) - 1;
  if (!(lambda > 0) || q == 0) {
    bilinear(t.levels[0], u, v, true, out);
    return;
  }
  const double fl = std::floor(lambda);
  const int d1 = lambda >= q ? q : static_cast<int>(fl);
  const int d2 = lambda >= q ? q : d1 + 1;
  const float f = static_cast<float>(lambda - fl);
  float a[4], b[4];
  bilinear(t.levels[Z(d1)], u, v, true, a);
  if (d2 == d1) {
    for (int ch = 0; ch < 4; ch++) out[ch] = a[ch];
    return;
  }
  bilinear(t.levels[Z(d2)], u, v, true, b);
  for (int ch = 0; ch < 4; ch++) out[ch] = a[ch] + (b[ch] - a[ch]) * f;
}

/** The mask buffer's red channel at a mask coordinate (LINEAR, no mipmaps, CLAMP_TO_EDGE as render targets are). */
float sample_mask(const uint8_t* red, int size, float u, float v) {
  // The coordinate clamped to [0, 1) first (NaN to 0), as the driver's CLAMP_TO_EDGE addressing does.
  const float below_one = std::nextafter(1.0f, 0.0f);
  u = u > 0 ? (u < below_one ? u : below_one) : 0.0f;
  v = v > 0 ? (v < below_one ? v : below_one) : 0.0f;
  const float s = u * static_cast<float>(size) - 0.5f;
  const float t = v * static_cast<float>(size) - 0.5f;
  const float fs = std::floor(s), ft = std::floor(t);
  const float a = s - fs, b = t - ft;
  auto wrap = [&](long long i) { return i < 0 ? 0 : i >= size ? size - 1 : i; };
  const long long x0 = wrap(static_cast<long long>(fs)), x1 = wrap(static_cast<long long>(fs) + 1);
  const long long y0 = wrap(static_cast<long long>(ft)), y1 = wrap(static_cast<long long>(ft) + 1);
  const float c00 = from_byte(red[Z(y0 * size + x0)]), c10 = from_byte(red[Z(y0 * size + x1)]);
  const float c01 = from_byte(red[Z(y1 * size + x0)]), c11 = from_byte(red[Z(y1 * size + x1)]);
  const float top = c00 + (c10 - c00) * a;
  const float bottom = c01 + (c11 - c01) * a;
  return top + (bottom - top) * b;
}

/**
 * The level of detail of an affine triangle (constant over it), as Vulkan's
 * software rasterizer computes it: the texel-space derivative vectors' larger
 * squared length L, then log₂ √L ≈ ¼·log₂(L²) read off L²'s float bits (a
 * linear interpolation of log₂ between powers of two).
 */
double lod_of(const double* x, const double* y, const float* u, const float* v, int tw, int th) {
  const double det = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]);
  if (det == 0) return 0;
  const double du1 = static_cast<double>(u[1]) - u[0], du2 = static_cast<double>(u[2]) - u[0];
  const double dv1 = static_cast<double>(v[1]) - v[0], dv2 = static_cast<double>(v[2]) - v[0];
  const double dudx = (du1 * (y[2] - y[0]) - du2 * (y[1] - y[0])) / det;
  const double dudy = ((x[1] - x[0]) * du2 - (x[2] - x[0]) * du1) / det;
  const double dvdx = (dv1 * (y[2] - y[0]) - dv2 * (y[1] - y[0])) / det;
  const double dvdy = ((x[1] - x[0]) * dv2 - (x[2] - x[0]) * dv1) / det;
  const float ux = static_cast<float>(dudx) * static_cast<float>(tw), vx = static_cast<float>(dvdx) * static_cast<float>(th);
  const float uy = static_cast<float>(dudy) * static_cast<float>(tw), vy = static_cast<float>(dvdy) * static_cast<float>(th);
  float l = std::max(ux * ux + vx * vx, uy * uy + vy * vy);
  if (!(l <= std::numeric_limits<float>::max())) return std::numeric_limits<double>::infinity();
  l = l * l;
  int32_t bits;
  std::memcpy(&bits, &l, sizeof bits);
  // 2⁻²⁵ = ¼ · 2⁻²³ (the mantissa's length); 0x3F800000 is 1.0f's bits.
  return static_cast<double>((static_cast<float>(bits) - 1065353216.0f) * 2.98023223876953125e-08f);
}

// --------------------------------------------------------- rasterizing

struct Scissor {
  int x0 = 0, y0 = 0, x1 = 0, y1 = 0;
};

/** A clip-space position (z = 0 and w = 1 on input; the clipper's new vertices carry their own w). */
struct Clip4 {
  float x, y, z, w;
};

/** The intersection of edge i → j with a clip plane, from the plane distances di ≥ 0 > dj or the reverse. */
inline Clip4 clip_edge(const Clip4& vi, const Clip4& vj, float di, float dj) {
  const float D = 1.0f / (dj - di);
  return {(dj * vi.x - di * vj.x) * D, (dj * vi.y - di * vj.y) * D, (dj * vi.z - di * vj.z) * D,
          (dj * vi.w - di * vj.w) * D};
}

/** One clip stage: keeps the part of the polygon where dist(v) ≥ 0. */
template <class Dist>
void clip_stage(Clip4* v, int& n, Dist&& dist) {
  Clip4 out[16];
  int t = 0;
  for (int i = 0; i < n; i++) {
    const int j = i == n - 1 ? 0 : i + 1;
    const float di = dist(v[i]), dj = dist(v[j]);
    if (di >= 0 && t < 16) out[t++] = v[i];
    if ((di >= 0) != (dj >= 0) && t < 16) out[t++] = clip_edge(v[i], v[j], di, dj);
  }
  for (int i = 0; i < t; i++) v[i] = out[i];
  n = t;
}

inline int64_t ceil_div(int64_t a, int64_t b) { return a >= 0 ? (a + b - 1) / b : -((-a) / b); }

/** Round to nearest even in float, as the conversion instruction does. */
inline int64_t round_int(float x) { return static_cast<int64_t>(std::nearbyint(x)); }

/** The rasterizer's snapping of a clip coordinate to 1/16 pixel (pixel centers at multiples of 16) for a viewport side of n pixels. */
struct Snap {
  float origin, scale;
  explicit Snap(int n) {
    const float h = 0.5f * static_cast<float>(n);
    origin = h * 16.0f - 8.0f;
    scale = h * 16.0f;
  }
  int64_t operator()(float c) const { return round_int(origin + c * scale); }
};

/** Inside the frustum's sides (no clipping), NaN outside. */
inline bool inside_frustum(float cx, float cy) { return -1.0f <= cx && cx <= 1.0f && -1.0f <= cy && cy <= 1.0f; }

/**
 * Rasterizes one triangle given in clip space (z = 0, w = 1) into a viewport
 * of vw × vh pixels at the origin, as Vulkan's software rasterizer does it
 * (see docs/design.md §8.4): a triangle crossing the frustum's sides is
 * clipped against them (left, right, top, bottom) in float, every polygon
 * vertex is snapped to 1/16 pixel with pixel centers at the integers, the
 * polygon's outline gives each row a span [left, right) (left edges and top
 * rows inclusive), and the first three vertices' area decides the facing.
 * Front faces are counterclockwise in window coordinates (y up); `cull`
 * drops back faces. `shade(x, y, l0, l1, l2)` gets each covered pixel with
 * the original triangle's barycentric weights at its center.
 */
template <class Shade>
void rasterize(const float* cx, const float* cy, int vw, int vh, const Scissor& sc, bool cull, Vector<int32_t>& left,
               Vector<int32_t>& right, Shade&& shade) {
  constexpr int kRight = 1, kTop = 2, kLeft = 4, kBottom = 8, kFinite = 16;
  constexpr float kMax = std::numeric_limits<float>::max();
  int flags_and = ~0, flags_or = 0;
  for (int i = 0; i < 3; i++) {
    int f = 0;
    if (1.0f < cx[i]) f |= kRight;
    if (1.0f < cy[i]) f |= kTop;
    if (!(-1.0f <= cx[i])) f |= kLeft;
    if (!(-1.0f <= cy[i])) f |= kBottom;
    if (std::fabs(cx[i]) <= kMax && std::fabs(cy[i]) <= kMax) f |= kFinite;
    flags_and &= f;
    flags_or |= f;
  }
  if (flags_and != kFinite) return;
  const Snap snap_x(vw), snap_y(vh);
  // The original vertices, projected (their positions without clipping).
  bool reversed = false;
  int64_t OX[3], OY[3];
  for (int i = 0; i < 3; i++) {
    OX[i] = snap_x(cx[i]);
    OY[i] = snap_y(cy[i]);
  }
  // Facing, from the original triangle's projected vertices (window y up: counterclockwise
  // is a negative A); the outline then goes down its left side, reversed when A < 0.
  {
    const float x0 = static_cast<float>(OX[0]), x1 = static_cast<float>(OX[1]), x2 = static_cast<float>(OX[2]);
    const float y0 = static_cast<float>(OY[0]), y1 = static_cast<float>(OY[1]), y2 = static_cast<float>(OY[2]);
    const float A = ((y0 - y2) * x1 + (y2 - y1) * x0) + (y1 - y0) * x2;
    if (A == 0.0f) return;
    if (cull && A > 0.0f) return;
    reversed = A < 0.0f;
  }
  Clip4 poly[16];
  int n = 3;
  for (int i = 0; i < 3; i++) poly[i] = {cx[i], cy[i], 0.0f, 1.0f};
  bool clipped = false;
  if (flags_or & (kRight | kTop | kLeft | kBottom)) {
    clipped = true;
    if (flags_or & kLeft) clip_stage(poly, n, [](const Clip4& v) { return v.w + v.x; });
    if (n >= 3 && (flags_or & kRight)) clip_stage(poly, n, [](const Clip4& v) { return v.w - v.x; });
    if (n >= 3 && (flags_or & kTop)) clip_stage(poly, n, [](const Clip4& v) { return v.w - v.y; });
    if (n >= 3 && (flags_or & kBottom)) clip_stage(poly, n, [](const Clip4& v) { return v.w + v.y; });
    if (n < 3) return;
  }
  int64_t X[17], Y[17];
  for (int i = 0; i < n; i++) {
    if (clipped) {
      const float w = poly[i].w;
      const float rhw = w != 0.0f ? 1.0f / w : 1.0f;
      X[i] = round_int(snap_x.origin + poly[i].x * rhw * snap_x.scale);
      Y[i] = round_int(snap_y.origin + poly[i].y * rhw * snap_y.scale);
    } else {
      X[i] = OX[i];
      Y[i] = OY[i];
    }
  }
  X[n] = X[0];
  Y[n] = Y[0];
  int64_t ymin = Y[0], ymax = Y[0];
  for (int i = 1; i < n; i++) {
    ymin = std::min(ymin, Y[i]);
    ymax = std::max(ymax, Y[i]);
  }
  const int64_t row0 = std::max<int64_t>(sc.y0, ceil_div(ymin, 16));
  const int64_t row1 = std::min<int64_t>(sc.y1, ceil_div(ymax, 16));
  if (row0 >= row1) return;
  // The spans of the rows [row0, row1).
  const std::size_t rows = static_cast<std::size_t>(row1 - row0);
  left.assign(rows, 0);
  right.assign(rows, 0);
  for (int i = 0; i < n; i++) {
    // Edge i → i + 1, or i + 1 → i for a reversed outline (in this order: a row two edges
    // reach, which snapping can make, keeps the later one).
    const int a = reversed ? i + 1 : i, b = reversed ? i : i + 1;
    const int64_t Xa = X[a], Ya = Y[a], Xb = X[b], Yb = Y[b];
    if (Ya == Yb) continue;
    const bool up = Yb < Ya;
    const int64_t X1 = up ? Xb : Xa, Y1 = up ? Yb : Ya, X2 = up ? Xa : Xb, Y2 = up ? Ya : Yb;
    const int64_t y1 = std::max<int64_t>(ceil_div(Y1, 16), row0);
    const int64_t y2 = std::min<int64_t>(ceil_div(Y2, 16), row1);
    const int64_t DX = X2 - X1, DY = Y2 - Y1;
    Vector<int32_t>& side = up ? right : left;
    for (int64_t y = y1; y < y2; y++) {
      // x = ⌈(X1 + DX·(16y − Y1)/DY) / 16⌉, the first pixel center at or right of the edge.
      const int64_t x = ceil_div(X1 * DY + DX * (16 * y - Y1), 16 * DY);
      side[static_cast<std::size_t>(y - row0)] = static_cast<int32_t>(std::clamp<int64_t>(x, sc.x0, sc.x1));
    }
  }
  // Barycentric weights from the original triangle's projected vertices (extrapolated outside it).
  const int64_t area = (OX[1] - OX[0]) * (OY[2] - OY[0]) - (OX[2] - OX[0]) * (OY[1] - OY[0]);
  if (area == 0) return;
  const double inv = 1.0 / static_cast<double>(area);
  for (int64_t y = row0; y < row1; y++) {
    const std::size_t r = static_cast<std::size_t>(y - row0);
    const int64_t Py = 16 * y;
    for (int64_t x = left[r]; x < right[r]; x++) {
      const int64_t Px = 16 * x;
      const int64_t w0 = (OX[2] - OX[1]) * (Py - OY[1]) - (OY[2] - OY[1]) * (Px - OX[1]);
      const int64_t w1 = (OX[0] - OX[2]) * (Py - OY[2]) - (OY[0] - OY[2]) * (Px - OX[2]);
      const int64_t w2 = (OX[1] - OX[0]) * (Py - OY[0]) - (OY[1] - OY[0]) * (Px - OX[0]);
      shade(static_cast<int>(x), static_cast<int>(y), static_cast<float>(static_cast<double>(w0) * inv),
            static_cast<float>(static_cast<double>(w1) * inv), static_cast<float>(static_cast<double>(w2) * inv));
    }
  }
}

inline float interp(const float* a, const float* l) { return (a[0] * l[0] + a[1] * l[1]) + a[2] * l[2]; }

/**
 * False when a triangle covers no row of [y0, y1), as rasterize() would find
 * (for vertices inside the frustum, from their snapped rows; a triangle that
 * is clipped may cover any row).
 */
template <class V>
bool may_cover(const V& a, const V& b, const V& c, int y0, int y1) {
  if (!(a.inside && b.inside && c.inside)) return true;
  const int64_t lo = std::min(a.sy, std::min(b.sy, c.sy)), hi = std::max(a.sy, std::max(b.sy, c.sy));
  return ceil_div(hi, 16) > y0 && ceil_div(lo, 16) < y1;
}

/**
 * The rows [lo, hi) and window columns that triangles of these vertices can
 * cover in a vw × vh viewport: the vertices' own rows when all are inside
 * the frustum (NaN and infinite ones draw nothing), else the whole viewport.
 */
template <class R, class V>
R rows_of(const V* v, std::size_t n, int vw, int vh) {
  constexpr float kMax = std::numeric_limits<float>::max();
  R r;
  int64_t lo = std::numeric_limits<int64_t>::max(), hi = std::numeric_limits<int64_t>::min();
  float x_lo = kMax, x_hi = -kMax;
  for (std::size_t i = 0; i < n; i++) {
    const V& q = v[i];
    if (q.inside) {
      lo = std::min(lo, ceil_div(q.sy, 16));
      hi = std::max(hi, ceil_div(q.sy, 16));
      x_lo = std::min(x_lo, q.wx);
      x_hi = std::max(x_hi, q.wx);
    } else if (std::fabs(q.cx) <= kMax && std::fabs(q.cy) <= kMax) {
      r.lo = 0, r.hi = vh, r.x_lo = 0, r.x_hi = static_cast<float>(vw);
      return r;
    }
  }
  if (lo > hi) return r;
  r.lo = std::max<int64_t>(0, lo);
  r.hi = std::min<int64_t>(vh, hi);
  r.x_lo = std::max(0.0f, x_lo);
  r.x_hi = std::min(static_cast<float>(vw), x_hi);
  return r;
}

// ---------------------------------------------------- advanced blending

float lum(const float* c) { return (0.3f * c[0] + 0.59f * c[1]) + 0.11f * c[2]; }
float sat_of(const float* c) { return std::max(c[0], std::max(c[1], c[2])) - std::min(c[0], std::min(c[1], c[2])); }

void clip_color(float* c) {
  const float l = lum(c);
  const float n = std::min(c[0], std::min(c[1], c[2]));
  const float x = std::max(c[0], std::max(c[1], c[2]));
  if (n < 0)
    for (int i = 0; i < 3; i++) c[i] = l + (c[i] - l) * l / (l - n);
  if (x > 1)
    for (int i = 0; i < 3; i++) c[i] = l + (c[i] - l) * (1.0f - l) / (x - l);
}

void set_lum(const float* c, float l, float* out) {
  const float d = l - lum(c);
  for (int i = 0; i < 3; i++) out[i] = c[i] + d;
  clip_color(out);
}

void set_sat(const float* c, float s, float* out) {
  const float mx = std::max(c[0], std::max(c[1], c[2]));
  const float mn = std::min(c[0], std::min(c[1], c[2]));
  const float md = ((c[0] + c[1]) + c[2] - mx) - mn;
  float nmx = 0, nmd = 0, nmn = 0;
  if (mn < mx) {
    nmx = s;
    nmd = (md - mn) * s / (mx - mn);
  }
  auto put = [&](float r, float g, float b) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
  };
  if (c[0] == mx) {
    if (c[2] < c[1]) put(nmx, nmd, nmn);
    else put(nmx, nmn, nmd);
  } else if (c[1] == mx) {
    if (c[0] < c[2]) put(nmn, nmx, nmd);
    else put(nmd, nmx, nmn);
  } else {
    if (c[1] < c[0]) put(nmd, nmn, nmx);
    else put(nmn, nmd, nmx);
  }
}

float channel(int code, float s, float d) {
  switch (code) {
    case 3: return std::min(s + d, 1.0f);
    case 4: return s + d;
    case 5: return std::min(s, d);
    case 6: return s * d;
    case 7:
      return std::fabs(d - 1.0f) < 1e-6f ? 1.0f : (std::fabs(s) < 1e-6f ? 0.0f : 1.0f - std::min(1.0f, (1.0f - d) / s));
    case 8: return std::max(0.0f, (s + d) - 1.0f);
    case 9: return std::max(s, d);
    case 10: return (s + d) - s * d;
    case 11: return d <= 0 ? 0.0f : (s == 1.0f ? 1.0f : std::min(1.0f, d / (1.0f - s)));
    case 12: return d < 0.5f ? 2.0f * s * d : 1.0f - 2.0f * (1.0f - s) * (1.0f - d);
    case 13:
      if (s <= 0.5f) return d - (1.0f - 2.0f * s) * d * (1.0f - d);
      if (d <= 0.25f) return d + (2.0f * s - 1.0f) * d * ((16.0f * d - 12.0f) * d + 3.0f);
      return d + (2.0f * s - 1.0f) * (std::sqrt(d) - d);
    case 14: return s < 0.5f ? 2.0f * s * d : 1.0f - 2.0f * (1.0f - s) * (1.0f - d);
    case 15: return s < 0.5f ? std::max(0.0f, (2.0f * s + d) - 1.0f) : std::min(1.0f, 2.0f * (s - 0.5f) + d);
    default: return s;
  }
}

void blend_color(int code, const float* s, const float* d, float* out) {
  if (code == 16) {
    float t[3];
    set_sat(s, sat_of(d), t);
    set_lum(t, lum(d), out);
    return;
  }
  if (code == 17) {
    set_lum(s, lum(d), out);
    return;
  }
  for (int i = 0; i < 3; i++) out[i] = channel(code, s[i], d[i]);
}

void weights(int mode, float As, float Ad, float* p) {
  switch (mode) {
    case 1:
      p[0] = As * Ad, p[1] = 0, p[2] = Ad * (1.0f - As);
      return;
    case 2:
      p[0] = 0, p[1] = 0, p[2] = Ad * (1.0f - As);
      return;
    case 3:
      p[0] = std::min(As, Ad), p[1] = std::max(As - Ad, 0.0f), p[2] = std::max(Ad - As, 0.0f);
      return;
    case 4:
      p[0] = std::max((As + Ad) - 1.0f, 0.0f), p[1] = std::min(As, 1.0f - Ad), p[2] = std::min(Ad, 1.0f - As);
      return;
    default:
      p[0] = As * Ad, p[1] = As * (1.0f - Ad), p[2] = Ad * (1.0f - As);
  }
}

inline int color_part(int code) { return code & 0xff; }
inline int alpha_part(int code) { return (code >> 8) & 0xff; }
inline bool compatible(int code) {
  const int c = color_part(code);
  return code == 0 || c == 1 || c == 2;
}
/** 0 normal, 1 additive, 2 multiplicative. */
inline uint8_t compatible_mode(int code) {
  const int c = color_part(code);
  return c == 1 ? 1 : c == 2 ? 2 : 0;
}
inline uint8_t legacy_mode(uint8_t flags) { return flags & 1 ? 1 : flags & 2 ? 2 : 0; }

/** Fixed-function blending of a fragment into an RGBA8 pixel (the source clamped to [0, 1] first). */
void blend_into(uint8_t* px, const float* src, uint8_t mode) {
  float s[4];
  for (int i = 0; i < 4; i++) s[i] = clamp01(src[i]);
  float d[4];
  for (int i = 0; i < 4; i++) d[i] = from_byte(px[i]);
  const float k = 1.0f - s[3];
  if (mode == 1) {
    for (int i = 0; i < 3; i++) px[i] = to_byte(s[i] + d[i]);
  } else if (mode == 2) {
    for (int i = 0; i < 3; i++) px[i] = to_byte(s[i] * d[i] + d[i] * k);
  } else {
    for (int i = 0; i < 3; i++) px[i] = to_byte(s[i] + d[i] * k);
    px[3] = to_byte(s[3] + d[3] * k);
  }
}

}  // namespace

// ------------------------------------------------------------ texture API

uint8_t premultiply_byte(int c, int a) { return static_cast<uint8_t>((2 * c * a + 255) / 510); }

uint8_t mip_average(int a, int b, int c, int d) {
  const int sum = a + b + c + d;
  const int q = sum >> 2;
  const int r = sum & 3;
  return static_cast<uint8_t>(r > 2 ? q + 1 : r == 2 ? q + (q & 1) : q);
}

void prepare_texture(const uint8_t* straight, int width, int height, Texture& out) {
  out = Texture();
  out.width = width;
  out.height = height;
  if (width <= 0 || height <= 0) return;
  Texture::Level base;
  base.width = width;
  base.height = height;
  base.rgba.resize(Z(4LL * width * height));
  for (std::size_t i = 0; i < base.rgba.size(); i += 4) {
    const int a = straight[i + 3];
    for (int ch = 0; ch < 3; ch++) base.rgba[i + Z(ch)] = premultiply_byte(straight[i + Z(ch)], a);
    base.rgba[i + 3] = static_cast<uint8_t>(a);
  }
  out.levels.push_back(std::move(base));
  const int levels = static_cast<int>(std::floor(std::log2(static_cast<double>(std::max(width, height))))) + 1;
  for (int l = 1; l < levels; l++) {
    const Texture::Level& src = out.levels.back();
    Texture::Level dst;
    dst.width = std::max(1, src.width / 2);
    dst.height = std::max(1, src.height / 2);
    dst.rgba.resize(Z(4LL * dst.width * dst.height));
    // §2b.3, for every size (0.10.0): the mean of the 2×2 block below, ties to
    // even, a block reaching past the level above reading its last texel again
    // (prepare.ts MIP_FS).
    for (int y = 0; y < dst.height; y++)
      for (int x = 0; x < dst.width; x++) {
        auto at = [&](int i, int j, int ch) {
          i = std::min(i, src.width - 1);
          j = std::min(j, src.height - 1);
          return static_cast<int>(src.rgba[Z((static_cast<long long>(j) * src.width + i) * 4 + ch)]);
        };
        for (int ch = 0; ch < 4; ch++)
          dst.rgba[Z((static_cast<long long>(y) * dst.width + x) * 4 + ch)] =
              mip_average(at(2 * x, 2 * y, ch), at(2 * x + 1, 2 * y, ch), at(2 * x, 2 * y + 1, ch),
                          at(2 * x + 1, 2 * y + 1, ch));
      }
    out.levels.push_back(std::move(dst));
  }
}

bool update_texture(Texture& t, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x, int y,
                    Vector<TextureRegion>* changed) {
  return update_texture_in(t, straight, w, h, stride, x, y, changed);
}

bool update_texture_in(Texture& t, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x, int y,
                       Vector<TextureRegion>* changed) {
  if (changed) changed->clear();
  if (t.levels.empty() || w < 1 || h < 1 || x < 0 || y < 0 || x > t.width - w || y > t.height - h) return false;
  if (stride == 0) stride = 4 * static_cast<std::ptrdiff_t>(w);
  // Level 0: the region premultiplied as at preparation.
  Texture::Level& base = t.levels[0];
  for (int j = 0; j < h; j++) {
    const uint8_t* row = straight + stride * j;
    uint8_t* out = base.rgba.data() + (static_cast<std::ptrdiff_t>(y + j) * base.width + x) * 4;
    for (int i = 0; i < w; i++) {
      const int a = row[4 * i + 3];
      for (int ch = 0; ch < 3; ch++) out[4 * i + ch] = premultiply_byte(row[4 * i + ch], a);
      out[4 * i + 3] = static_cast<uint8_t>(a);
    }
  }
  int x0 = x, y0 = y, x1 = x + w, y1 = y + h;
  if (changed) changed->push_back({0, x0, y0, x1 - x0, y1 - y0});
  // Further levels: only the texels whose 2×2 block covers the region (prepare.ts
  // updateRegion: texel p reads texels 2p and 2p + 1 above, clamped), by the same rule.
  for (std::size_t l = 1; l < t.levels.size(); l++) {
    const Texture::Level& src = t.levels[l - 1];
    Texture::Level& dst = t.levels[l];
    x0 = std::min(x0 >> 1, dst.width - 1);
    y0 = std::min(y0 >> 1, dst.height - 1);
    x1 = std::min((x1 + 1) >> 1, dst.width);
    y1 = std::min((y1 + 1) >> 1, dst.height);
    for (int yy = y0; yy < y1; yy++)
      for (int xx = x0; xx < x1; xx++) {
        auto at = [&](int i, int j, int ch) {
          i = std::min(i, src.width - 1);
          j = std::min(j, src.height - 1);
          return static_cast<int>(src.rgba[Z((static_cast<long long>(j) * src.width + i) * 4 + ch)]);
        };
        for (int ch = 0; ch < 4; ch++)
          dst.rgba[Z((static_cast<long long>(yy) * dst.width + xx) * 4 + ch)] =
              mip_average(at(2 * xx, 2 * yy, ch), at(2 * xx + 1, 2 * yy, ch), at(2 * xx, 2 * yy + 1, ch),
                          at(2 * xx + 1, 2 * yy + 1, ch));
      }
    if (changed) changed->push_back({static_cast<int>(l), x0, y0, x1 - x0, y1 - y0});
  }
  return true;
}

std::shared_ptr<Texture> own_copy(Vector<std::shared_ptr<const Texture>>& textures, Vector<uint8_t>& own,
                                  std::size_t index) {
  if (own.size() < textures.size()) own.resize(textures.size(), 0);
  if (!own[index]) {
    textures[index] = std::allocate_shared<Texture>(Allocator<Texture>(), *textures[index]);
    own[index] = 1;
  }
  return std::const_pointer_cast<Texture>(textures[index]);
}

Framing frame_image(const moc::Canvas& canvas, int width, int height, const View* view) {
  Framing f;
  f.width = width;
  f.height = height;
  if (view) {
    f.k = view->pixels_per_unit;
    f.center_x = view->x;
    f.center_y = view->y;
    return f;
  }
  const double ppu = canvas.pixels_per_unit;
  f.k = std::min(width / static_cast<double>(canvas.width), height / static_cast<double>(canvas.height)) * ppu;
  f.center_x = (static_cast<double>(canvas.width) / 2 - canvas.origin_x) / ppu;
  f.center_y = (static_cast<double>(canvas.origin_y) - static_cast<double>(canvas.height) / 2) / ppu;
  return f;
}

// --------------------------------------------------------------- renderer

/** The uniforms of one draw (shaders.ts). */
struct Renderer::Draw {
  float multiply[3] = {1, 1, 1}, screen[3] = {0, 0, 0}, tint[3] = {1, 1, 1};
  float opacity = 1;
  int code = 0;
  bool advanced = false;
  uint8_t mode = 0;
  /** 0 none, 1 normal, 2 inverted. */
  int mask_mode = 0;
  MaskSource mask;
};

Renderer::Renderer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const Texture>> textures,
                   int mask_size, int offscreen_mask_size)
    : model_(std::move(model)),
      textures_(std::move(textures)),
      mask_size_(mask_size),
      offscreen_mask_size_(offscreen_mask_size) {
  const moc::Model& m = *model_;
  const std::size_t N = m.meshes.ids.size();
  for (std::size_t i = 0; i < N; i++) triangles_.push_back(eval::output_triangles(m, static_cast<int>(i)));
  // Rule V: textures sampled at v flipped twice in float32, mask meshes included.
  uvs_.resize(N);
  for (std::size_t i = 0; i < N; i++) sampled_uvs(m.meshes.uvs[i].data(), m.meshes.uvs[i].size(), uvs_[i]);
  // §2h.1: offscreens, or a drawable blend code the direct pipeline cannot draw.
  layered_ = !m.offscreens.part.empty();
  for (int32_t c : m.meshes.blend_mode) layered_ = layered_ || !compatible(c);
  for (std::size_t i = 0; i < N; i++)
    blend_of_.push_back(layered_ ? compatible_mode(m.meshes.blend_mode[i]) : legacy_mode(m.meshes.flags[i]));
  group_masks(m.meshes.masks, drawable_groups_, drawable_group_of_);
  group_masks(m.offscreens.masks, offscreen_groups_, offscreen_group_of_);
  // The box of an offscreen group: every drawable under its owners (C9).
  for (const auto& g : offscreen_groups_) {
    Vector<uint8_t> in(N, 0);
    for (int32_t o : g.members) {
      const int owner = m.offscreens.part[Z(o)];
      for (std::size_t d = 0; d < N; d++)
        for (int q = m.meshes.part[d]; q >= 0; q = m.parts.parent[Z(q)])
          if (q == owner) {
            in[d] = 1;
            break;
          }
    }
    Vector<int32_t> members;
    for (std::size_t d = 0; d < N; d++)
      if (in[d]) members.push_back(static_cast<int32_t>(d));
    offscreen_box_members_.push_back(std::move(members));
  }
  mask_.size = mask_size_;
  offscreen_mask_.size = offscreen_mask_size_;
  lanes_.resize(1);
}

Renderer::~Renderer() = default;

void Renderer::set_threads(int threads) {
  threads_ = threads < 0 ? 1 : threads;
  workers_.start(threads_ == 0 ? Workers::hardware() : threads_);
  if (lanes_.size() < Z(workers_.size())) lanes_.resize(Z(workers_.size()));
}

bool Renderer::update_texture(int index, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x, int y) {
  if (index < 0 || Z(index) >= textures_.size() || !textures_[Z(index)] || textures_[Z(index)]->levels.empty())
    return false;
  const Texture& t = *textures_[Z(index)];
  if (w < 1 || h < 1 || x < 0 || y < 0 || x > t.width - w || y > t.height - h) return false;
  return update_texture_in(*own_copy(textures_, own_texture_, Z(index)), straight, w, h, stride, x, y);
}

namespace {

/**
 * Rows per band at least, bands per thread (taken in turn as each thread
 * finishes one, so uneven rows even out), and the work (pixels) a pass
 * needs before its rows are split over threads.
 */
constexpr int kMinBandRows = 4;
constexpr int kBandsPerThread = 8;
constexpr double kMinSplitWork = 2048;

}  // namespace

template <class F>
void Renderer::parallel_rows(int row0, int row1, double work, const F& f) {
  const int rows = row1 - row0;
  if (rows <= 0) return;
  const int threads = workers_.size();
  int bands = threads * kBandsPerThread;
  if (bands > rows / kMinBandRows) bands = rows / kMinBandRows;
  if (threads <= 1 || bands <= 1 || !(work >= kMinSplitWork)) {
    f(lanes_[0], row0, row1);
    return;
  }
  struct Job {
    const F* f;
    Lane* lanes;
    int row0, rows, bands;
    std::atomic<int> next{0};
  } job{&f, lanes_.data(), row0, rows, bands};
  workers_.run(
      std::min(threads, bands),
      [](void* p, int i) {
        Job& j = *static_cast<Job*>(p);
        for (int k; (k = j.next.fetch_add(1, std::memory_order_relaxed)) < j.bands;) {
          const int a = j.row0 + static_cast<int>(static_cast<long long>(j.rows) * k / j.bands);
          const int b = j.row0 + static_cast<int>(static_cast<long long>(j.rows) * (k + 1) / j.bands);
          (*j.f)(j.lanes[i], a, b);
        }
      },
      &job);
}

void Renderer::fill(Target& t, int width, int height, const uint8_t value[4]) {
  const std::size_t size = Z(4LL * width * height);
  t.width = width;
  t.height = height;
  if (t.rgba.size() != size) t.rgba.resize(size);
  const bool bytes = value[0] == value[1] && value[1] == value[2] && value[2] == value[3];
  parallel_rows(0, height, static_cast<double>(width) * height, [&](Lane&, int y0, int y1) {
    uint8_t* p = t.rgba.data() + Z(4LL * width * y0);
    const std::size_t n = Z(static_cast<long long>(width) * (y1 - y0));
    if (bytes) {
      std::memset(p, value[0], 4 * n);
    } else {
      for (std::size_t i = 0; i < n; i++) std::memcpy(p + 4 * i, value, 4);
    }
  });
}

namespace {

/** Rows [y0, y1) of `from` copied into `to` (both of one size). */
template <class T>
void copy_rows(const T& from, T& to, int y0, int y1) {
  const std::size_t row = Z(4LL * from.width);
  std::memcpy(to.rgba.data() + row * Z(y0), from.rgba.data() + row * Z(y0), row * Z(y1 - y0));
}

/** `to` sized as `like` (its pixels to be copied row by row). */
template <class T>
void shape_like(T& to, const T& like) {
  to.width = like.width;
  to.height = like.height;
  if (to.rgba.size() != like.rgba.size()) to.rgba.resize(like.rgba.size());
}

}  // namespace

void Renderer::group_masks(const Vector<Vector<int32_t>>& lists, Vector<Group>& groups,
                           Vector<int32_t>& group_of) const {
  // maskGroups: objects with the same set of mask meshes, numbered in the file order of their first member.
  group_of.assign(lists.size(), -1);
  Vector<Vector<int32_t>> keys;
  for (std::size_t i = 0; i < lists.size(); i++) {
    if (lists[i].empty()) continue;
    Vector<int32_t> key = lists[i];
    std::sort(key.begin(), key.end());
    key.erase(std::unique(key.begin(), key.end()), key.end());
    std::size_t g = 0;
    while (g < keys.size() && keys[g] != key) g++;
    if (g == keys.size()) {
      keys.push_back(key);
      Group group;
      group.masks = lists[i];
      groups.push_back(std::move(group));
    }
    groups[g].members.push_back(static_cast<int32_t>(i));
    group_of[i] = static_cast<int32_t>(g);
  }
}

int Renderer::acquire_layer() {
  int t;
  if (!free_layers_.empty()) {
    t = free_layers_.back();
    free_layers_.pop_back();
  } else {
    t = static_cast<int>(layers_.size());
    layers_.emplace_back();
  }
  const uint8_t zero[4] = {0, 0, 0, 0};
  fill(layers_[Z(t)], framing_.width, framing_.height, zero);
  return t;
}

void Renderer::release_layer(int layer) { free_layers_.push_back(layer); }

void Renderer::draw(const eval::Instance& inst, const FrameOptions& frame, Image& out) {
  out.width = frame.framing.width;
  out.height = frame.framing.height;
  out.rgba.resize(Z(4LL * out.width * out.height));
  draw(inst, frame, out.rgba.data(), 4LL * out.width);
}

void Renderer::draw(const eval::Instance& inst, const FrameOptions& frame, uint8_t* pixels, std::ptrdiff_t stride) {
  const moc::Model& m = *model_;
  inst_ = &inst;
  framing_ = frame.framing;
  tints_ = frame.tints;
  stats_ = FrameStats();
  stats_.layered = layered_;
  const Framing& f = framing_;
  // clipTransform, as the vertex shader's uniform (float32).
  const double sx = 2 * f.k / f.width, sy = 2 * f.k / f.height;
  view_[0] = static_cast<float>(sx);
  view_[1] = static_cast<float>(sy);
  view_[2] = static_cast<float>(-f.center_x * sx);
  view_[3] = static_cast<float>(-f.center_y * sy);
  view_matrix_ = view_matrix({sx, sy, -f.center_x * sx, -f.center_y * sy});
  // Render order: drawables and offscreens.
  const std::size_t N = m.meshes.ids.size(), O = m.offscreens.part.size();
  order_.assign(N + O, 0x7fffffff);
  for (std::size_t d = 0; d < N; d++) {
    const int32_t pos = inst.drawable_render_order[d];
    if (pos >= 0 && Z(pos) < order_.size()) order_[Z(pos)] = static_cast<int32_t>(d);
  }
  for (std::size_t o = 0; o < O; o++) {
    const int32_t pos = inst.offscreen_render_order[o];
    if (pos >= 0 && Z(pos) < order_.size()) order_[Z(pos)] = -1 - static_cast<int32_t>(o);
  }
  group_mapped_.assign(drawable_groups_.size(), 0);
  group_box_.assign(drawable_groups_.size(), Box());
  group_map_.assign(drawable_groups_.size(), MaskMap());
  offscreen_mapped_.assign(offscreen_groups_.size(), 0);
  offscreen_box_.assign(offscreen_groups_.size(), Box());
  offscreen_map_.assign(offscreen_groups_.size(), MaskMap());
  mask_holds_ = offscreen_mask_holds_ = -1;
  // One lane per thread, its row scratch reserved here: the workers never allocate.
  const std::size_t most_rows = Z(std::max(f.height, std::max(mask_size_, offscreen_mask_size_)));
  for (int i = 0; i < workers_.size(); i++) {
    Lane& lane = lanes_[Z(i)];
    lane.fragments = 0;
    lane.spans.left.reserve(most_rows);
    lane.spans.right.reserve(most_rows);
  }
  // The target, cleared to the premultiplied background.
  Target& target = target_;
  const auto& bg = frame.background;
  const uint8_t clear[4] = {to_byte(static_cast<float>(bg[0] * bg[3])), to_byte(static_cast<float>(bg[1] * bg[3])),
                            to_byte(static_cast<float>(bg[2] * bg[3])), to_byte(static_cast<float>(bg[3]))};
  fill(target, f.width, f.height, clear);
  if (layered_)
    draw_layered(frame, target);
  else
    draw_direct(target);
  // Read back as the harness does: rows top to bottom.
  const std::size_t row = Z(4LL * f.width);
  parallel_rows(0, f.height, static_cast<double>(f.width) * f.height, [&](Lane&, int y0, int y1) {
    for (int y = y0; y < y1; y++)
      std::memcpy(pixels + static_cast<std::ptrdiff_t>(f.height - 1 - y) * stride,
                  &target.rgba[Z(static_cast<long long>(y) * static_cast<long long>(row))], row);
  });
  for (int i = 0; i < workers_.size(); i++) stats_.fragments += lanes_[Z(i)].fragments;
  inst_ = nullptr;
}

void Renderer::draw_direct(Target& target) {
  const eval::Instance& inst = *inst_;
  for (int32_t d : order_) {
    if (d < 0 || d == 0x7fffffff || !inst.drawable_visible[Z(d)]) continue;
    draw_mesh(d, target, false);
  }
}

void Renderer::draw_layered(const FrameOptions& frame, Target& target) {
  (void)frame;
  const moc::Model& m = *model_;
  const eval::Instance& inst = *inst_;
  const auto& parents = m.parts.parent;
  auto self_or_ancestor = [&](int a, int p) {
    for (int q = p; q >= 0; q = parents[Z(q)])
      if (q == a) return true;
    return false;
  };
  Vector<LayerEntry> stack;
  stack.push_back({acquire_layer(), -1});
  auto close_top = [&] {
    const LayerEntry layer = stack.back();
    stack.pop_back();
    // §2h.4: the offscreen's layer composited into the layer below it.
    const int o = layer.offscreen;
    Draw dr;
    for (int ch = 0; ch < 3; ch++) {
      dr.multiply[ch] = inst.offscreen_multiply[Z(3LL * o + ch)];
      dr.screen[ch] = inst.offscreen_screen[Z(3LL * o + ch)];
    }
    dr.opacity = inst.offscreen_opacity[Z(o)];
    dr.code = m.offscreens.blend_mode[Z(o)];
    dr.advanced = !compatible(dr.code);
    dr.mode = compatible_mode(dr.code);
    const int g = offscreen_group_of_[Z(o)];
    if (g >= 0) {
      dr.mask = offscreen_mask(g);
      dr.mask_mode = (m.offscreens.flags[Z(o)] & kInvertedMask) ? 2 : 1;
    }
    Target& below = layers_[Z(stack.back().target)];
    composite(layers_[Z(layer.target)], below, dr);
    release_layer(layer.target);
  };
  for (int32_t e : order_) {
    if (e == 0x7fffffff) continue;
    if (e < 0) {
      const int o = -1 - e;
      const int owner = m.offscreens.part[Z(o)];
      while (stack.back().offscreen >= 0) {
        const int top_owner = m.offscreens.part[Z(stack.back().offscreen)];
        if (top_owner != owner && self_or_ancestor(top_owner, owner)) break;
        close_top();
      }
      stack.push_back({acquire_layer(), o});
      stats_.layers++;
    } else {
      if (!inst.drawable_visible[Z(e)]) continue;
      const int q = m.meshes.part[Z(e)];
      while (stack.back().offscreen >= 0) {
        const int top_owner = m.offscreens.part[Z(stack.back().offscreen)];
        if (self_or_ancestor(top_owner, q)) break;
        close_top();
      }
      draw_mesh(e, layers_[Z(stack.back().target)], true);
    }
  }
  while (stack.size() > 1) close_top();
  // L₀ over the destination: dst ← L₀ + (1 − L₀.a)·dst.
  const int l0 = stack.back().target;
  stack.pop_back();
  Draw dr;
  composite(layers_[Z(l0)], target, dr);
  release_layer(l0);
}

void Renderer::draw_mesh(int d, Target& target, bool layer) {
  const moc::Model& m = *model_;
  const eval::Instance& inst = *inst_;
  const int tex_index = m.meshes.texture[Z(d)];
  if (tex_index < 0 || Z(tex_index) >= textures_.size() || !textures_[Z(tex_index)]) return;
  const Texture& tex = *textures_[Z(tex_index)];
  if (tex.levels.empty()) return;
  // Every visible drawable (opacity ≠ 0) is drawn, negative, NaN and infinite
  // opacities too: the output is clamped at fixed points (compatible blends
  // clamp the source, NaN to 0; advanced codes their stored result), so a compatible blend changes nothing for a negative or NaN opacity,
  // while an advanced one brightens or erases the destination. A tint's alpha
  // multiplies the opacity (exactly so at 1); a tint alpha of 0 hides the mesh
  // whatever its opacity.
  const float opacity = tints_ ? inst.drawable_opacity[Z(d)] * tints_[Z(4LL * d + 3)] : inst.drawable_opacity[Z(d)];
  if (opacity == 0 || (tints_ && tints_[Z(4LL * d + 3)] == 0)) return;
  Draw dr;
  for (int ch = 0; ch < 3; ch++) {
    dr.multiply[ch] = inst.drawable_multiply[Z(3LL * d + ch)];
    dr.screen[ch] = inst.drawable_screen[Z(3LL * d + ch)];
    if (tints_) dr.tint[ch] = tints_[Z(4LL * d + ch)];
  }
  dr.opacity = opacity;
  dr.code = m.meshes.blend_mode[Z(d)];
  dr.advanced = layered_ && !compatible(dr.code);
  dr.mode = blend_of_[Z(d)];
  const int g = drawable_group_of_[Z(d)];
  if (g >= 0) {
    dr.mask = drawable_mask(g);
    dr.mask_mode = (m.meshes.flags[Z(d)] & kInvertedMask) ? 2 : 1;
    stats_.masked++;
  }
  if (dr.advanced) stats_.advanced_draws++;
  const Framing& f = framing_;
  const auto& verts = inst.drawable_vertices[Z(d)];
  const auto& uvs = uvs_[Z(d)];
  const auto& tris = triangles_[Z(d)];
  const bool cull = (m.meshes.flags[Z(d)] & kDoubleSided) == 0;
  const float hw = static_cast<float>(f.width) / 2, hh = static_cast<float>(f.height) / 2;
  const bool tinted = !(dr.tint[0] == 1 && dr.tint[1] == 1 && dr.tint[2] == 1);
  const bool bright = dr.tint[0] > 1 || dr.tint[1] > 1 || dr.tint[2] > 1;
  // Rule M: the mask coordinate through the mask's float32 texture matrix, A·p + c.
  const Mat4 mt = mask_matrices(mapping(dr.mask.map)).texture;
  stats_.drawn++;
  // MESH_VS once per vertex: clip = aPos·uView.xy + uView.zw, the viewport's window
  // pixels, the mask coordinates.
  const std::size_t nv = std::min(verts.size(), uvs.size()) / 2;
  verts_.resize(nv);
  const Snap snap(f.height);
  for (std::size_t i = 0; i < nv; i++) {
    const float x = verts[2 * i], y = verts[2 * i + 1];
    Vert& q = verts_[i];
    q.cx = x * view_[0] + view_[2];
    q.cy = y * view_[1] + view_[3];
    q.wx = (q.cx + 1.0f) * hw;
    q.wy = (q.cy + 1.0f) * hh;
    q.mx = mt[0] * x + mt[1] * y + mt[3];
    q.my = mt[4] * x + mt[5] * y + mt[7];
    q.inside = inside_frustum(q.cx, q.cy);
    q.sy = q.inside ? static_cast<int32_t>(snap(q.cy)) : 0;
  }
  const Rows rows = rows_of<Rows>(verts_.data(), nv, f.width, f.height);
  // An advanced draw reads the destination as it was: each band copies its rows first.
  const bool copy = dr.advanced && layer;
  if (copy) shape_like(dst_copy_, target);
  const double work = static_cast<double>(rows.hi - rows.lo) * std::max(1.0f, rows.x_hi - rows.x_lo);
  parallel_rows(static_cast<int>(rows.lo), static_cast<int>(rows.hi), work, [&](Lane& lane, int y0, int y1) {
    if (copy) copy_rows(target, dst_copy_, y0, y1);
    const Scissor sc{0, y0, f.width, y1};
    uint64_t fragments = 0;
    for (std::size_t k = 0; k + 2 < tris.size(); k += 3) {
      const std::size_t i0 = tris[k], i1 = tris[k + 1], i2 = tris[k + 2];
      if (i0 >= nv || i1 >= nv || i2 >= nv) continue;
      const Vert* q[3] = {&verts_[i0], &verts_[i1], &verts_[i2]};
      if (!may_cover(*q[0], *q[1], *q[2], y0, y1)) continue;
      const std::size_t vi[3] = {i0, i1, i2};
      double wx[3], wy[3];
      float ccx[3], ccy[3];
      float u[3], v[3], mx[3], my[3];
      for (int c = 0; c < 3; c++) {
        ccx[c] = q[c]->cx;
        ccy[c] = q[c]->cy;
        wx[c] = static_cast<double>(q[c]->wx);
        wy[c] = static_cast<double>(q[c]->wy);
        u[c] = uvs[2 * vi[c]];
        v[c] = uvs[2 * vi[c] + 1];
        mx[c] = q[c]->mx;
        my[c] = q[c]->my;
      }
      const double lambda = lod_of(wx, wy, u, v, tex.width, tex.height);
      rasterize(ccx, ccy, f.width, f.height, sc, cull, lane.spans.left, lane.spans.right,
                [&](int px, int py, float l0, float l1, float l2) {
                  const float l[3] = {l0, l1, l2};
                  float t[4];
                  sample(tex, interp(u, l), interp(v, l), lambda, t);
                  float mask = 1;
                  if (dr.mask_mode) {
                    const float r =
                        sample_mask(dr.mask.buffer->red.data(), dr.mask.buffer->size, interp(mx, l), interp(my, l));
                    const float mf = 1.0f - r;
                    mask = dr.mask_mode == 1 ? mf : 1.0f - mf;
                  }
                  uint8_t* px_ = &target.rgba[Z((static_cast<long long>(py) * target.width + px) * 4)];
                  fragments++;
                  float rgb[3];
                  for (int ch = 0; ch < 3; ch++) rgb[ch] = t[ch] * dr.multiply[ch];
                  if (!dr.advanced) {
                    float o[4];
                    for (int ch = 0; ch < 3; ch++) {
                      rgb[ch] = (rgb[ch] + dr.screen[ch] * t[3]) - rgb[ch] * dr.screen[ch];
                      if (tinted) rgb[ch] = rgb[ch] * dr.tint[ch];
                      // 0.14.0: a tint above 1 brightens up to white (premultiplied: at most the alpha).
                      if (bright) rgb[ch] = std::min(rgb[ch], t[3]);
                      o[ch] = rgb[ch] * dr.opacity * mask;
                    }
                    o[3] = t[3] * dr.opacity * mask;
                    blend_into(px_, o, dr.mode);
                    return;
                  }
                  // §2h.3, from a copy of the destination; no fixed-function blending.
                  for (int ch = 0; ch < 3; ch++) {
                    rgb[ch] = (rgb[ch] + dr.screen[ch]) - rgb[ch] * dr.screen[ch];
                    if (tinted) rgb[ch] = rgb[ch] * dr.tint[ch];
                    if (bright) rgb[ch] = std::min(rgb[ch], t[3]);
                  }
                  float c[4] = {rgb[0] * dr.opacity, rgb[1] * dr.opacity, rgb[2] * dr.opacity, t[3] * dr.opacity};
                  float As = c[3];
                  float Cs[3];
                  for (int ch = 0; ch < 3; ch++) Cs[ch] = As >= 1e-5f ? c[ch] / As : 0.0f;
                  As = As * mask;
                  const uint8_t* dp = &dst_copy_.rgba[Z((static_cast<long long>(py) * dst_copy_.width + px) * 4)];
                  const float Ad = from_byte(dp[3]);
                  float Cd[3];
                  for (int ch = 0; ch < 3; ch++) Cd[ch] = Ad >= 1e-5f ? from_byte(dp[ch]) / Ad : 0.0f;
                  float B[3], p[3];
                  blend_color(color_part(dr.code), Cs, Cd, B);
                  weights(alpha_part(dr.code), As, Ad, p);
                  for (int ch = 0; ch < 3; ch++) px_[ch] = to_byte((p[0] * B[ch] + p[1] * Cs[ch]) + p[2] * Cd[ch]);
                  px_[3] = to_byte((p[0] + p[1]) + p[2]);
                });
    }
    lane.fragments += fragments;
  });
}

void Renderer::composite(const Target& layer, Target& below, const Draw& dr) {
  // A whole layer as a drawable covering the image: texels one to one (rule L's
  // linear filtering at texel centers, exactly), the mask through D = A · V⁻¹ at each
  // pixel center's clip-space position (rule I: the quad's interpolated coordinate).
  const Framing& f = framing_;
  const float hw = static_cast<float>(f.width) / 2, hh = static_cast<float>(f.height) / 2;
  const Mat4 md = layer_mask_matrix(mapping(dr.mask.map), view_matrix_);
  const bool tinted = !(dr.tint[0] == 1 && dr.tint[1] == 1 && dr.tint[2] == 1);
  const bool bright = dr.tint[0] > 1 || dr.tint[1] > 1 || dr.tint[2] > 1;
  if (dr.advanced) shape_like(dst_copy_, below);
  parallel_rows(0, f.height, static_cast<double>(f.width) * f.height, [&](Lane&, int y0, int y1) {
    if (dr.advanced) copy_rows(below, dst_copy_, y0, y1);
    for (int y = y0; y < y1; y++)
      for (int x = 0; x < f.width; x++) {
        const std::size_t at = Z((static_cast<long long>(y) * f.width + x) * 4);
        float t[4];
        for (int ch = 0; ch < 4; ch++) t[ch] = from_byte(layer.rgba[at + Z(ch)]);
        float mask = 1;
        if (dr.mask_mode) {
          const float px = (static_cast<float>(x) + 0.5f) / hw - 1.0f;
          const float py = (static_cast<float>(y) + 0.5f) / hh - 1.0f;
          const float r = sample_mask(dr.mask.buffer->red.data(), dr.mask.buffer->size,
                                      md[0] * px + md[1] * py + md[3], md[4] * px + md[5] * py + md[7]);
          const float mf = 1.0f - r;
          mask = dr.mask_mode == 1 ? mf : 1.0f - mf;
        }
        uint8_t* px = &below.rgba[at];
        float rgb[3];
        for (int ch = 0; ch < 3; ch++) rgb[ch] = t[ch] * dr.multiply[ch];
        if (!dr.advanced) {
          float o[4];
          for (int ch = 0; ch < 3; ch++) {
            rgb[ch] = (rgb[ch] + dr.screen[ch] * t[3]) - rgb[ch] * dr.screen[ch];
            if (tinted) rgb[ch] = rgb[ch] * dr.tint[ch];
            if (bright) rgb[ch] = std::min(rgb[ch], t[3]);
            o[ch] = rgb[ch] * dr.opacity * mask;
          }
          o[3] = t[3] * dr.opacity * mask;
          blend_into(px, o, dr.mode);
          continue;
        }
        for (int ch = 0; ch < 3; ch++) rgb[ch] = (rgb[ch] + dr.screen[ch]) - rgb[ch] * dr.screen[ch];
        float c[4] = {rgb[0] * dr.opacity, rgb[1] * dr.opacity, rgb[2] * dr.opacity, t[3] * dr.opacity};
        float As = c[3];
        float Cs[3];
        for (int ch = 0; ch < 3; ch++) Cs[ch] = As >= 1e-5f ? c[ch] / As : 0.0f;
        As = As * mask;
        const uint8_t* dp = &dst_copy_.rgba[at];
        const float Ad = from_byte(dp[3]);
        float Cd[3];
        for (int ch = 0; ch < 3; ch++) Cd[ch] = Ad >= 1e-5f ? from_byte(dp[ch]) / Ad : 0.0f;
        float B[3], p[3];
        blend_color(color_part(dr.code), Cs, Cd, B);
        weights(alpha_part(dr.code), As, Ad, p);
        for (int ch = 0; ch < 3; ch++) px[ch] = to_byte((p[0] * B[ch] + p[1] * Cs[ch]) + p[2] * Cd[ch]);
        px[3] = to_byte((p[0] + p[1]) + p[2]);
      }
  });
  stats_.advanced_draws += dr.advanced ? 1 : 0;
}

// ------------------------------------------------------------------ masks

namespace {

/** drawablesBox: the members' vertex bounds; with `quirk` the maxima start at the smallest positive double. */
template <class B>
B drawables_box(const Vector<int32_t>& members, const Vector<Vector<float>>& vertices, bool quirk) {
  double min_x = std::numeric_limits<double>::infinity(), min_y = min_x;
  double max_x = quirk ? std::numeric_limits<double>::denorm_min() : -std::numeric_limits<double>::infinity();
  double max_y = max_x;
  for (int32_t d : members) {
    const auto& v = vertices[Z(d)];
    for (std::size_t i = 0; i + 1 < v.size(); i += 2) {
      const double x = v[i], y = v[i + 1];
      if (x < min_x) min_x = x;
      if (x > max_x) max_x = x;
      if (y < min_y) min_y = y;
      if (y > max_y) max_y = y;
    }
  }
  B b;
  b.x0 = min_x;
  b.y0 = min_y;
  b.w = max_x - min_x;
  b.h = max_y - min_y;
  return b;
}

/** maskMapping (§2g.3): one buffer pixel per canvas pixel if the box fits, else the box plus 5 % per side. */
template <class M, class B>
M mask_mapping(const B& box, double ppu, int size) {
  auto axis = [&](double origin, double extent, double& o, double& s) {
    if (extent * ppu <= size) {
      o = origin;
      s = ppu / size;
    } else {
      o = origin - 0.05 * extent;
      s = 1 / (1.1 * extent);
    }
  };
  M m;
  axis(box.x0, box.w, m.ox, m.sx);
  axis(box.y0, box.h, m.oy, m.sy);
  return m;
}

}  // namespace

Renderer::MaskSource Renderer::drawable_mask(int g) {
  const eval::Instance& inst = *inst_;
  if (!group_mapped_[Z(g)]) {
    group_box_[Z(g)] = drawables_box<Box>(drawable_groups_[Z(g)].members, inst.drawable_vertices, true);
    group_map_[Z(g)] = mask_mapping<MaskMap>(group_box_[Z(g)], model_->canvas.pixels_per_unit, mask_size_);
    group_mapped_[Z(g)] = 1;
  }
  if (mask_holds_ != g) {
    rasterize_masks(drawable_groups_[Z(g)].masks, group_map_[Z(g)], group_box_[Z(g)], mask_);
    mask_holds_ = g;
  }
  return {&mask_, group_map_[Z(g)]};
}

Renderer::MaskSource Renderer::offscreen_mask(int g) {
  const eval::Instance& inst = *inst_;
  if (!offscreen_mapped_[Z(g)]) {
    offscreen_box_[Z(g)] = drawables_box<Box>(offscreen_box_members_[Z(g)], inst.drawable_vertices, false);
    offscreen_map_[Z(g)] =
        mask_mapping<MaskMap>(offscreen_box_[Z(g)], model_->canvas.pixels_per_unit, offscreen_mask_size_);
    offscreen_mapped_[Z(g)] = 1;
  }
  if (offscreen_mask_holds_ != g) {
    rasterize_masks(offscreen_groups_[Z(g)].masks, offscreen_map_[Z(g)], offscreen_box_[Z(g)], offscreen_mask_);
    offscreen_mask_holds_ = g;
  }
  return {&offscreen_mask_, offscreen_map_[Z(g)]};
}

void Renderer::rasterize_masks(const Vector<int32_t>& masks, const MaskMap& map, const Box& box, MaskBuffer& buf) {
  const moc::Model& m = *model_;
  const eval::Instance& inst = *inst_;
  const int S = buf.size;
  if (buf.red.empty()) buf.red.assign(Z(static_cast<long long>(S) * S), 0);
  stats_.mask_builds++;
  // The scissor rectangle the masked object can sample: the box plus 2 pixels.
  auto px = [&](double v, double o, double s) { return (v - o) * s * S; };
  const double x0 = std::max(0.0, std::floor(px(box.x0, map.ox, map.sx)) - 2);
  const double y0 = std::max(0.0, std::floor(px(box.y0, map.oy, map.sy)) - 2);
  const double x1 = std::min(static_cast<double>(S), std::ceil(px(box.x0 + box.w, map.ox, map.sx)) + 2);
  const double y1 = std::min(static_cast<double>(S), std::ceil(px(box.y0 + box.h, map.oy, map.sy)) + 2);
  const bool full = !(x1 > x0 && y1 > y0 && std::isfinite(x0 + x1 + y0 + y1));
  Scissor sc;
  if (full) {
    sc = {0, 0, S, S};
  } else {
    sc = {static_cast<int>(x0), static_cast<int>(y0), static_cast<int>(x1), static_cast<int>(y1)};
  }
  // Rule M: mask meshes placed through the mask's float32 clip matrix, A·p + c.
  const Mat4 mc = mask_matrices(mapping(map)).clip;
  const float half = static_cast<float>(S) / 2;
  // The mask meshes, and MASK_VS once per vertex: clip = uMaskClip · (aPos, 0, 1).
  mask_meshes_.clear();
  std::size_t total = 0;
  for (int32_t mi : masks) {
    const int tex_index = m.meshes.texture[Z(mi)];
    if (tex_index < 0 || Z(tex_index) >= textures_.size() || !textures_[Z(tex_index)]) continue;
    const Texture& tex = *textures_[Z(tex_index)];
    if (tex.levels.empty()) continue;
    stats_.mask_mesh_draws++;
    MaskMesh mesh;
    mesh.mesh = mi;
    mesh.first = total;
    mesh.count = std::min(inst.drawable_vertices[Z(mi)].size(), m.meshes.uvs[Z(mi)].size()) / 2;
    mesh.texture = &tex;
    mesh.cull = (m.meshes.flags[Z(mi)] & kDoubleSided) == 0;
    total += mesh.count;
    mask_meshes_.push_back(mesh);
  }
  mask_verts_.resize(total);
  const Snap snap(S);
  for (const MaskMesh& mesh : mask_meshes_) {
    const auto& verts = inst.drawable_vertices[Z(mesh.mesh)];
    for (std::size_t i = 0; i < mesh.count; i++) {
      Vert& q = mask_verts_[mesh.first + i];
      const float x = verts[2 * i], y = verts[2 * i + 1];
      q.cx = mc[0] * x + mc[1] * y + mc[3];
      q.cy = mc[4] * x + mc[5] * y + mc[7];
      q.wx = (q.cx + 1.0f) * half;
      q.wy = (q.cy + 1.0f) * half;
      q.inside = inside_frustum(q.cx, q.cy);
      q.sy = q.inside ? static_cast<int32_t>(snap(q.cy)) : 0;
    }
  }
  const double work = static_cast<double>(sc.x1 - sc.x0) * (sc.y1 - sc.y0);
  parallel_rows(sc.y0, sc.y1, work, [&](Lane& lane, int band0, int band1) {
    for (int y = band0; y < band1; y++)
      std::memset(&buf.red[Z(static_cast<long long>(y) * S + sc.x0)], 255, Z(sc.x1 - sc.x0));
    const Scissor band{sc.x0, band0, sc.x1, band1};
    for (const MaskMesh& mesh : mask_meshes_) {
      const Texture& tex = *mesh.texture;
      const auto& uvs = uvs_[Z(mesh.mesh)];
      const auto& tris = triangles_[Z(mesh.mesh)];
      const Vert* vq = mask_verts_.data() + mesh.first;
      for (std::size_t k = 0; k + 2 < tris.size(); k += 3) {
        const std::size_t vi[3] = {tris[k], tris[k + 1], tris[k + 2]};
        if (vi[0] >= mesh.count || vi[1] >= mesh.count || vi[2] >= mesh.count) continue;
        if (!may_cover(vq[vi[0]], vq[vi[1]], vq[vi[2]], band0, band1)) continue;
        double wx[3], wy[3];
        float ccx[3], ccy[3];
        float u[3], v[3];
        for (int c = 0; c < 3; c++) {
          const Vert& q = vq[vi[c]];
          ccx[c] = q.cx;
          ccy[c] = q.cy;
          wx[c] = static_cast<double>(q.wx);
          wy[c] = static_cast<double>(q.wy);
          u[c] = uvs[2 * vi[c]];
          v[c] = uvs[2 * vi[c] + 1];
        }
        const double lambda = lod_of(wx, wy, u, v, tex.width, tex.height);
        rasterize(ccx, ccy, S, S, band, mesh.cull, lane.spans.left, lane.spans.right,
                  [&](int px_, int py_, float l0, float l1, float l2) {
                    const float l[3] = {l0, l1, l2};
                    float t[4];
                    sample(tex, interp(u, l), interp(v, l), lambda, t);
                    // red ← red·(1 − α) (blend ZERO, ONE_MINUS_SRC_ALPHA; red only).
                    uint8_t& r = buf.red[Z(static_cast<long long>(py_) * S + px_)];
                    r = to_byte(from_byte(r) * (1.0f - clamp01(t[3])));
                  });
      }
    }
  });
}

}  // namespace mochi2d::render

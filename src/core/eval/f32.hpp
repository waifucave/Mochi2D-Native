// Float32 arithmetic (port of Mochi2D's src/core/eval/f32.ts, §1a).
//
// Every operation of the evaluator is a single float32 operation. Mochi2D
// computes each +, −, × and ÷ in float64 and rounds once with Math.fround,
// which gives exactly the float32 result; here the operations are float32
// operations. The build must not contract a·b + c into fused multiply-adds
// (CMake sets -ffp-contract=off, and MSVC's /fp:precise does not contract).
#pragma once

#include <cfloat>
#include <cmath>
#include <string>

// Float32 operations must round to float32 each time: no x87 extended
// precision (FLT_EVAL_METHOD 0; on 32-bit x86, SSE2 math).
#if defined(FLT_EVAL_METHOD) && FLT_EVAL_METHOD != 0 && FLT_EVAL_METHOD != -1
#error "Mochi2D Native needs FLT_EVAL_METHOD == 0 (on 32-bit x86: -msse2 -mfpmath=sse, or /arch:SSE2)"
#endif
#if defined(_M_IX86) && (!defined(_M_IX86_FP) || _M_IX86_FP < 2)
#error "Mochi2D Native needs SSE2 math on 32-bit x86 (/arch:SSE2)"
#endif

#include "fdlibm.hpp"
#include "util/text.hpp"

namespace mochi2d::eval {

/** f32(a + t·(b − a)), rounding after each operation. */
inline float lerp32(float a, float b, float t) { return a + t * (b - a); }

/** f32(0.001): the key tolerance for 3 decimal places. */
inline const float kKeyEpsilon = static_cast<float>(0.001);

/**
 * The key snapping / range tolerance of a parameter with `decimals` decimal
 * places: ε = f32(10^−d) (S1), the decimal 1e-d rounded to a
 * double, then to float32.
 */
inline float key_tolerance(int decimals) {
  if (decimals < 0) return static_cast<float>(fdlibm::pow(10.0, -static_cast<double>(decimals)));  // never: the loader rejects d < 0
  if (decimals > 400) return 0.0f;
  const String s = "1e-" + to_str(decimals);
  double d = 0;
  if (!text::parse_double(s.data(), s.data() + s.size(), d)) d = 0;
  return static_cast<float>(d);
}

/** The fixed tolerance of the draw-order formula. */
inline const float kDrawOrderTolerance = static_cast<float>(0.001);

/** The draw-order range of a blend-shape target from version 5. */
constexpr double kTargetDrawOrderMax = 1000;

/** JavaScript's Math.min(hi, Math.max(lo, x)) (NaN passes through). */
inline double js_clamp(double x, double lo, double hi) {
  if (std::isnan(x)) return x;
  const double m = x > lo ? x : lo;  // Math.max(lo, x); -0 vs 0 does not matter here
  return m < hi ? m : hi;
}

/**
 * The draw order a single keyform value gives without blend-shape
 * contributions: n = trunc(f32(v + 0.001)), and for a blend-shape target from
 * version 5 min(1000, max(0, trunc(f32(n + 0.001)))) (version-4 targets
 * are not clamped).
 */
inline double keyform_draw_order(float v, bool target, int version) {
  const double n = std::trunc(static_cast<double>(v + kDrawOrderTolerance));
  if (!target || version < 5) return n;
  // f32(n + 0.001): n is a float32 value, so this is a float32 addition.
  const double m = std::trunc(static_cast<double>(static_cast<float>(n) + kDrawOrderTolerance));
  return js_clamp(m, 0, kTargetDrawOrderMax);
}

/** The clamp of a blend-shape target's own value (version 5): NaN passes through. */
inline float clamp_target(float x, float lo, float hi) { return x < lo ? lo : x > hi ? hi : x; }

/** A target rotation's scale range [f32(10⁻⁴), 100] and keyform angle range [−3600, 3600]. */
inline const float kTargetScaleMin = static_cast<float>(1e-4);
constexpr float kTargetScaleMax = 100;
constexpr float kTargetAngleLimit = 3600;

/** π in float32. */
inline const float kPi32 = static_cast<float>(3.141592653589793);
/** A rotation's angle in degrees → radians: f32(f32(a·f32(π)) / 180), with no reduction modulo 360. */
inline float radians32(float degrees) { return (degrees * kPi32) / 180.0f; }

}  // namespace mochi2d::eval

// A probe that tells whether this library was compiled with floating-point
// contraction (a·b + c fused into one rounding). Mochi2D's results need
// every operation rounded on its own, so the unit tests call it with inputs
// whose fused and unfused results differ. It lives in its own
// translation unit of the core so that the core's compile flags decide.
#include "core/eval/fp_check.hpp"

namespace mochi2d::eval {

float fp_probe_f32(float a, float b, float c) { return a * b + c; }
double fp_probe_f64(double a, double b, double c) { return a * b + c; }

bool fp_contraction_off() {
  // a = b = 1 + 2^-12: a·b = 1 + 2^-11 + 2^-24 exactly, which rounds to
  // 1 + 2^-11 in float32 (a tie, to even). With c = −(1 + 2^-11) the unfused
  // result is 0; a fused multiply-add gives 2^-24.
  volatile float a = 1.0f + 1.0f / 4096.0f;
  volatile float c = -(1.0f + 1.0f / 2048.0f);
  // The same in double: (1 + 2^-27)² = 1 + 2^-26 + 2^-54.
  volatile double ad = 1.0 + 1.0 / 134217728.0;
  volatile double cd = -(1.0 + 1.0 / 67108864.0);
  return fp_probe_f32(a, a, c) == 0.0f && fp_probe_f64(ad, ad, cd) == 0.0;
}

}  // namespace mochi2d::eval

// A rotation deformer's world form under a parent (Mochi2D 0.8.0's
// rotation.ts): the parent's orientation read back from two mapped probe
// points, with the float32 arctangent, sine and cosine of the C math library
// (musl's, third_party/musl).
#pragma once

#include "core/eval/f32.hpp"
#include "libm32.hpp"

namespace mochi2d::eval {

/** The probe length under a rotation parent, and under a warp parent, f32(0.1). */
constexpr float kProbeRotation = 10;
inline const float kProbeWarp = static_cast<float>(0.1);
/** 2π and π/2 in float32 (2π_f is exactly 2·π_f). */
inline const float kTwoPi32 = static_cast<float>(2 * 3.141592653589793);
inline const float kHalfPi32 = static_cast<float>(3.141592653589793 / 2);

/**
 * The angle θ, in degrees, of a rotation with keyform angle `a` and base angle
 * `base` under a parent that maps its origin to O and the probe point a length
 * L above it (file coordinates, y down) to Q: the parent's orientation is the
 * probe's direction minus that of the unmapped probe (0, −L), whose float32
 * arctangent is −f32(π/2), wrapped into [−π_f, π_f] and taken to degrees; then
 * θ = f32(f32(a + P) + base), the base added last.
 */
inline float probed_angle(float a, float base, float ox, float oy, float qx, float qy) {
  const float dx = qx - ox;
  const float dy = qy - oy;
  float q = libm32::atan2f(dy, dx) + kHalfPi32;
  while (q < -kPi32) q = q + kTwoPi32;
  while (q > kPi32) q = q - kTwoPi32;
  const float parent = (q * 180.0f) / kPi32;
  return (a + parent) + base;
}

}  // namespace mochi2d::eval

// musl's float32 arctangent, sine and cosine (third_party/musl, compiled as
// C from the unchanged sources): the float32 functions of the classic C math
// library that Mochi2D 0.8.0 and later use for rotations. Each gives the same
// float32 result as musl's own build, bit for bit, on every input.
#pragma once

extern "C" {
float mochi2d_musl_atan2f(float y, float x);
float mochi2d_musl_atanf(float x);
float mochi2d_musl_sinf(float x);
float mochi2d_musl_cosf(float x);
}

namespace mochi2d::libm32 {

inline float atan2f(float y, float x) { return mochi2d_musl_atan2f(y, x); }
inline float atanf(float x) { return mochi2d_musl_atanf(x); }
inline float sinf(float x) { return mochi2d_musl_sinf(x); }
inline float cosf(float x) { return mochi2d_musl_cosf(x); }

}  // namespace mochi2d::libm32

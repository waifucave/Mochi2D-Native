/*
 * Mochi2D Native's stand-in for musl's internal src/internal/libm.h, with
 * only what the eight vendored files of src/math/ use, for any C99
 * compiler. musl's own header needs the rest of musl (its endian.h,
 * fp_arch.h and visibility macros); the files themselves are unchanged.
 *
 * The functions get prefixed names here, so that they never clash with the
 * platform's sinf, cosf, atanf and atan2f, and no compiler treats them as
 * its built-ins (which it may evaluate its own way). See ../README.md.
 */
#ifndef MOCHI2D_MUSL_LIBM_H
#define MOCHI2D_MUSL_LIBM_H

#include <float.h>
#include <math.h>
#include <stdint.h>

/* POSIX's π/2 (0x3FF921FB54442D18), which strict C99 headers leave out. */
#ifndef M_PI_2
#define M_PI_2 1.57079632679489661923
#endif

#define atan2f mochi2d_musl_atan2f
#define atanf mochi2d_musl_atanf
#define sinf mochi2d_musl_sinf
#define cosf mochi2d_musl_cosf
#define __sindf mochi2d_musl_sindf
#define __cosdf mochi2d_musl_cosdf
#define __rem_pio2f mochi2d_musl_rem_pio2f
#define __rem_pio2_large mochi2d_musl_rem_pio2_large

float atan2f(float y, float x);
float atanf(float x);
float sinf(float x);
float cosf(float x);
float __sindf(double x);
float __cosdf(double x);
int __rem_pio2f(float x, double *y);
int __rem_pio2_large(double *x, double *y, int e0, int nx, int prec);

#if defined(__GNUC__)
#define predict_true(x) __builtin_expect(!!(x), 1)
#define predict_false(x) __builtin_expect(x, 0)
#else
#define predict_true(x) (x)
#define predict_false(x) (x)
#endif

/* musl evaluates x only to raise floating-point exceptions; the library never reads them. */
#define FORCE_EVAL(x) ((void)(x))

#define GET_FLOAT_WORD(w, d)            \
  do {                                  \
    union {                             \
      float f;                          \
      uint32_t i;                       \
    } u_;                               \
    u_.f = (d);                         \
    (w) = u_.i;                         \
  } while (0)

#endif

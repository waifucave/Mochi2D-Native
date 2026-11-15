/*
 * Digests of float32 atanf, sinf and cosf over every float32 input (or
 * every stride-th one), and of atan2f over fixed input pairs: special
 * values against each other, the thresholds of its argument ranges, and
 * random bit patterns. For comparing builds of musl's functions bit for bit
 * (tests/crosscheck/libm32.sh): one line per chunk of 2^20 inputs,
 * "<function> <chunk> <FNV-1a 64 of the result bits>". One exception: for
 * two NaN arguments atan2f returns x + y, and which of the two NaNs that is
 * depends on the compiler's order of the operands (the addition commutes;
 * Clang swaps them, GCC does not), so a NaN result there counts as the
 * default NaN.
 *
 * Built against the vendored files (-DVENDORED, third_party/musl) or
 * against a C library's own functions (musl's, through musl-gcc).
 *
 * usage: libm32_dump [stride]
 *        libm32_dump list <function> <chunk> [stride]   (every input and result of a chunk)
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef VENDORED
float mochi2d_musl_atan2f(float y, float x);
float mochi2d_musl_atanf(float x);
float mochi2d_musl_sinf(float x);
float mochi2d_musl_cosf(float x);
#define F_ATAN2F mochi2d_musl_atan2f
#define F_ATANF mochi2d_musl_atanf
#define F_SINF mochi2d_musl_sinf
#define F_COSF mochi2d_musl_cosf
#else
#include <math.h>
#define F_ATAN2F atan2f
#define F_ATANF atanf
#define F_SINF sinf
#define F_COSF cosf
#endif

#define CHUNK_BITS 20

static float from_bits(uint32_t u) {
  float f;
  memcpy(&f, &u, 4);
  return f;
}
static uint32_t to_bits(float f) {
  uint32_t u;
  memcpy(&u, &f, 4);
  return u;
}

static int is_nan(uint32_t u) { return (u & 0x7fffffffu) > 0x7f800000u; }

/* atan2f's result bits, NaN results of two NaN arguments as the default NaN (see above). */
static uint32_t atan2f_bits(uint32_t y, uint32_t x) {
  const uint32_t r = to_bits(F_ATAN2F(from_bits(y), from_bits(x)));
  return is_nan(y) && is_nan(x) && is_nan(r) ? 0x7fc00000u : r;
}

static uint64_t fnv(uint64_t h, uint32_t v) {
  for (int i = 0; i < 4; i++) {
    h ^= (v >> (8 * i)) & 0xff;
    h *= 1099511628211ull;
  }
  return h;
}

/* The atan2f pairs: specials × specials, threshold neighbours, then random bit patterns. */
static const uint32_t specials[] = {
    0x00000000, 0x80000000, 0x00000001, 0x80000001, 0x007fffff, 0x807fffff, 0x00800000, 0x80800000,
    0x33800000, 0xb3800000, 0x3f000000, 0xbf000000, 0x3f800000, 0xbf800000, 0x3f800001, 0x3f7fffff,
    0x40000000, 0xc0000000, 0x40490fdb, 0xc0490fdb, 0x3fc90fdb, 0xbfc90fdb, 0x4c800000, 0xcc800000,
    0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000, 0x7fc00000, 0xffc00000, 0x7f800001, 0x3ee00000,
    0x3edfffff, 0x3f980000, 0x3f97ffff, 0x401c0000, 0x401bffff, 0x39800000, 0x397fffff, 0x4b000000};
#define NSPECIAL ((uint32_t)(sizeof specials / sizeof specials[0]))
#define NRANDOM (1u << 24)

static uint64_t rng = 0x9e3779b97f4a7c15ull;
static uint32_t next_random(void) {
  rng ^= rng << 13;
  rng ^= rng >> 7;
  rng ^= rng << 17;
  return (uint32_t)(rng >> 32);
}

/* Pair n of the atan2f set (n < pair_count()), as (y, x) bits. */
static uint32_t pair_count(void) { return NSPECIAL * NSPECIAL + 4 * 64 * 64 + NRANDOM; }
static void pair_at(uint32_t n, uint32_t* y, uint32_t* x) {
  if (n < NSPECIAL * NSPECIAL) {
    *y = specials[n / NSPECIAL];
    *x = specials[n % NSPECIAL];
    return;
  }
  n -= NSPECIAL * NSPECIAL;
  if (n < 4 * 64 * 64) {
    /* |y/x| around 2^26 and 2^-26 (the exponent offsets of 26 << 23), with neighbours. */
    const uint32_t which = n / (64 * 64), i = (n / 64) % 64, j = n % 64;
    const uint32_t base = 0x3f800000 + (i << 19);
    const uint32_t other = (which & 1 ? base - (26u << 23) : base + (26u << 23)) + j - 32;
    *y = (which & 1 ? other : base) | (which & 2 ? 0x80000000u : 0);
    *x = (which & 1 ? base : other) | (which & 2 ? 0 : 0x80000000u);
    return;
  }
  /* Random pairs, generated in order. */
  *y = next_random();
  *x = next_random();
}

static float unary(const char* fn, float x) {
  if (!strcmp(fn, "atanf")) return F_ATANF(x);
  if (!strcmp(fn, "sinf")) return F_SINF(x);
  return F_COSF(x);
}

int main(int argc, char** argv) {
  const char* fns[] = {"atanf", "sinf", "cosf"};
  if (argc >= 4 && !strcmp(argv[1], "list")) {
    const char* fn = argv[2];
    const uint32_t chunk = (uint32_t)strtoul(argv[3], NULL, 10);
    const uint32_t stride = argc > 4 ? (uint32_t)strtoul(argv[4], NULL, 10) : 1;
    if (!strcmp(fn, "atan2f")) {
      for (uint32_t n = 0; n < pair_count(); n++) {
        uint32_t y, x;
        pair_at(n, &y, &x);
        if (n >> CHUNK_BITS == chunk)
          printf("%08x %08x %08x\n", (unsigned)y, (unsigned)x, (unsigned)atan2f_bits(y, x));
      }
      return 0;
    }
    for (uint64_t k = (uint64_t)chunk << CHUNK_BITS; k < ((uint64_t)chunk + 1) << CHUNK_BITS; k++) {
      const uint64_t i = k * stride;
      if (i > 0xffffffffull) break;
      printf("%08x %08x\n", (unsigned)i, (unsigned)to_bits(unary(fn, from_bits((uint32_t)i))));
    }
    return 0;
  }
  const uint32_t stride = argc > 1 ? (uint32_t)strtoul(argv[1], NULL, 10) : 1;
  for (int f = 0; f < 3; f++) {
    uint64_t h = 1469598103934665603ull;
    uint64_t k = 0;
    for (uint64_t i = 0; i <= 0xffffffffull; i += stride, k++) {
      const float x = from_bits((uint32_t)i);
      h = fnv(h, to_bits(f == 0 ? F_ATANF(x) : f == 1 ? F_SINF(x) : F_COSF(x)));
      if (((k + 1) & ((1u << CHUNK_BITS) - 1)) == 0 || i + stride > 0xffffffffull) {
        printf("%s %llu %016llx\n", fns[f], (unsigned long long)(k >> CHUNK_BITS), (unsigned long long)h);
        h = 1469598103934665603ull;
      }
    }
  }
  uint64_t h = 1469598103934665603ull;
  const uint32_t pairs = pair_count();
  for (uint32_t n = 0; n < pairs; n++) {
    uint32_t y, x;
    pair_at(n, &y, &x);
    h = fnv(h, atan2f_bits(y, x));
    if (((n + 1) & ((1u << CHUNK_BITS) - 1)) == 0 || n + 1 == pairs) {
      printf("atan2f %u %016llx\n", (unsigned)(n >> CHUNK_BITS), (unsigned long long)h);
      h = 1469598103934665603ull;
    }
  }
  return 0;
}

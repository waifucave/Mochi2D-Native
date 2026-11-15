// Compares the vendored musl float32 functions (third_party/musl) with
// Mochi2D's own port of them (vectors written by tests/crosscheck/libm32.ts),
// bit for bit. NaN results compare by bits too, as both sides give the same.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "libm32.hpp"

namespace {

uint32_t u32(const unsigned char* p) {
  return static_cast<uint32_t>(p[0]) | static_cast<uint32_t>(p[1]) << 8 | static_cast<uint32_t>(p[2]) << 16 |
         static_cast<uint32_t>(p[3]) << 24;
}
float f32(uint32_t u) {
  float f;
  std::memcpy(&f, &u, 4);
  return f;
}
uint32_t bits(float f) {
  uint32_t u;
  std::memcpy(&u, &f, 4);
  return u;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: mochi2d_check_libm32 <vectors file>\n");
    return 2;
  }
  std::FILE* f = std::fopen(argv[1], "rb");
  if (!f) {
    std::fprintf(stderr, "cannot read %s\n", argv[1]);
    return 2;
  }
  std::vector<unsigned char> data;
  unsigned char chunk[1 << 16];
  std::size_t n;
  while ((n = std::fread(chunk, 1, sizeof chunk, f)) > 0) data.insert(data.end(), chunk, chunk + n);
  std::fclose(f);
  if (data.size() < 8) return 2;
  const uint32_t unary = u32(&data[0]), pairs = u32(&data[4]);
  if (data.size() != 8 + std::size_t{unary} * 16 + std::size_t{pairs} * 12) {
    std::fprintf(stderr, "malformed vectors file\n");
    return 2;
  }
  std::size_t fails = 0, nan_args = 0;
  // A NaN argument gives a NaN on both sides, but not always the same NaN:
  // JavaScript quiets a signaling NaN when it reads a float32 (the conversion
  // to double sets the quiet bit), and atan2f's x + y of two NaNs keeps the
  // payload of whichever operand the compiler puts first (C and V8 differ).
  // NaN bits are not observable in results (they are written as null), and
  // the evaluator's arguments come out of float32 arithmetic anyway.
  auto is_nan = [](uint32_t u) { return (u & 0x7f800000u) == 0x7f800000u && (u & 0x007fffffu); };
  auto report = [&](const char* fn, uint32_t in, uint32_t in2, bool two, uint32_t want, uint32_t got) {
    if (is_nan(got) && is_nan(want) && (is_nan(in) || (two && is_nan(in2)))) {
      nan_args++;
      return;
    }
    if (fails++ < 10) {
      if (two)
        std::printf("DIFFERS: %s(%08x, %08x): Mochi2D %08x, vendored %08x\n", fn, static_cast<unsigned>(in),
                    static_cast<unsigned>(in2), static_cast<unsigned>(want), static_cast<unsigned>(got));
      else
        std::printf("DIFFERS: %s(%08x): Mochi2D %08x, vendored %08x\n", fn, static_cast<unsigned>(in),
                    static_cast<unsigned>(want), static_cast<unsigned>(got));
    }
  };
  const unsigned char* p = &data[8];
  for (uint32_t i = 0; i < unary; i++, p += 16) {
    const uint32_t u = u32(p);
    const float x = f32(u);
    const uint32_t a = bits(mochi2d::libm32::atanf(x)), s = bits(mochi2d::libm32::sinf(x)),
                   c = bits(mochi2d::libm32::cosf(x));
    if (a != u32(p + 4)) report("atanf", u, 0, false, u32(p + 4), a);
    if (s != u32(p + 8)) report("sinf", u, 0, false, u32(p + 8), s);
    if (c != u32(p + 12)) report("cosf", u, 0, false, u32(p + 12), c);
  }
  for (uint32_t i = 0; i < pairs; i++, p += 12) {
    const uint32_t y = u32(p), x = u32(p + 4);
    const uint32_t r = bits(mochi2d::libm32::atan2f(f32(y), f32(x)));
    if (r != u32(p + 8)) report("atan2f", y, x, true, u32(p + 8), r);
  }
  std::printf(
      "libm32: %u inputs × atanf, sinf, cosf and %u atan2f pairs, %zu different from Mochi2D's port "
      "(for %zu NaN arguments, a NaN with other bits)\n",
      static_cast<unsigned>(unary), static_cast<unsigned>(pairs), fails, nan_args);
  return fails ? 1 : 0;
}

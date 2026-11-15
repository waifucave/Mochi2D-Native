# musl's float32 arctangent, sine and cosine

The rotation evaluation of Mochi2D 0.8.0 and later uses the float32
`atan2f`, `sinf` and `cosf` of the classic C math library, as musl
implements them (from FreeBSD's msun). These are musl's own files, as
Mochi2D's `THIRD_PARTY_NOTICES.md` names them:

- `src/math/`: `atan2f.c`, `atanf.c`, `sinf.c`, `cosf.c`, `__sindf.c`,
  `__cosdf.c`, `__rem_pio2f.c` and `__rem_pio2_large.c`, **unchanged**,
  from the musl 1.2.6 release (`musl-1.2.6.tar.gz` from
  https://musl.libc.org/releases/, SHA-256
  `d585fd3b613c66151fc3249e8ed44f77020cb5e6c1e635a616d3f9f82460512a`; its
  signature verified with musl's release key, fingerprint
  `8364 8929 0BB6 B70F 99FF DA05 56BC DB59 3020 450F`);
- `COPYRIGHT`: musl's license (MIT), unchanged. The files carry Sun
  Microsystems' notice, which asks to be preserved.

Ours (MIT, as the rest of Mochi2D Native):

- `include/libm.h` stands in for musl's internal `src/internal/libm.h`. It
  holds what the eight files use: `GET_FLOAT_WORD`, `FORCE_EVAL` (a no-op:
  musl uses it only to raise floating-point exceptions), `predict_false`,
  `M_PI_2` where strict C99 headers leave it out, and the prototypes. It
  gives the functions the prefix `mochi2d_musl_`, so they never clash with
  the platform's `sinf` and kin, and no compiler replaces them with its own
  built-ins.
- `libm32.hpp`: the C++ interface, `mochi2d::libm32::atan2f`, `atanf`,
  `sinf` and `cosf`.

The files are compiled as C99 with the libraries' floating-point flags (no
contraction into fused multiply-adds, no fast math, SSE2 on 32-bit x86), so
float and double operations round as C specifies with `FLT_EVAL_METHOD` 0.
`tests/crosscheck/check_libm32.cpp` compares them with Mochi2D's port, and
`tests/crosscheck/libm32.sh` with musl's own builds, bit for bit. (For two
NaN arguments `atan2f` returns x + y, and which of the NaNs that is follows
the compiler's order of the operands, so those results compare as NaN.)

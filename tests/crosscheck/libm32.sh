#!/usr/bin/env bash
# Compares the vendored musl float32 functions (third_party/musl, as built
# into the core library) with musl's own builds, bit for bit: atanf, sinf
# and cosf on every float32 input (or every stride-th one), atan2f on a
# fixed set of pairs (specials, range thresholds, 16.8 million random ones;
# NaN results of two NaN arguments count as NaN, since which NaN x + y
# returns depends on the compiler's operand order).
#
#   - musl's own: a C library's atanf, sinf, cosf and atan2f through
#     musl-gcc (the system's, or MUSL_GCC=<path>, for example a musl 1.2.6
#     built from its release); skipped when there is none.
#
# usage: tests/crosscheck/libm32.sh <build dir> [stride]
# Nothing it writes is committed: everything goes to <build dir>/libm32.
set -euo pipefail

BUILD="$(cd "${1:?usage: libm32.sh <build dir> [stride]}" && pwd)"
STRIDE="${2:-1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$BUILD/libm32"
MUSL_GCC="${MUSL_GCC:-$(command -v musl-gcc || true)}"
CORE="$BUILD/libmochi2d_core.a"

[ -n "$MUSL_GCC" ] || { echo "libm32: no musl-gcc (install musl-tools, or set MUSL_GCC)" >&2; exit 77; }
[ -f "$CORE" ] || { echo "libm32: $CORE not built" >&2; exit 2; }
mkdir -p "$OUT"
# The vendored functions, from the core library's own objects.
${CC:-cc} -std=c99 -O2 -DVENDORED "$ROOT/tests/crosscheck/libm32_dump.c" "$CORE" -lm -o "$OUT/dump-vendored"
# musl's own, through its compiler wrapper (statically linked, no built-ins).
"$MUSL_GCC" -std=c99 -O2 -fno-builtin -static "$ROOT/tests/crosscheck/libm32_dump.c" -lm -o "$OUT/dump-musl"
"$OUT/dump-vendored" "$STRIDE" > "$OUT/vendored.txt" &
"$OUT/dump-musl" "$STRIDE" > "$OUT/musl.txt" &
wait
lines=$(wc -l < "$OUT/vendored.txt")
which="every float32"
[ "$STRIDE" = 1 ] || which="1 in $STRIDE float32 inputs"
if cmp -s "$OUT/vendored.txt" "$OUT/musl.txt"; then
  echo "libm32: atanf, sinf and cosf on $which, atan2f on $(( $(grep -c '^atan2f' "$OUT/vendored.txt") )) chunks of pairs (NaN results of two NaN arguments as NaN): identical to the musl of $MUSL_GCC ($lines chunks)"
  exit 0
fi
echo "libm32: DIFFERENT from musl:"
diff "$OUT/vendored.txt" "$OUT/musl.txt" | head -10
first=$(diff "$OUT/vendored.txt" "$OUT/musl.txt" | grep '^<' | head -1 | awk '{print $2, $3}')
fn=${first% *}
chunk=${first#* }
diff <("$OUT/dump-vendored" list "$fn" "$chunk" "$STRIDE") <("$OUT/dump-musl" list "$fn" "$chunk" "$STRIDE") | head -6
exit 1

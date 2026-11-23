#!/usr/bin/env bash
# Cross-checks Mochi2D Native against the reference (Mochi2D 0.14.0 in
# reference/) on synthetic models made at test time:
#
#   1. builds the reference's tools (needs Node ≥ 20 and `npm ci` in the
#      reference folder) and the vector generator;
#   2. generates models, static scenarios and validation cases;
#   3. runs the reference's conformance tool and mochi2d-native on the same
#      scenarios, mochi2d-native both incrementally (the default) and with
#      --full-evaluation, and requires byte-identical results (the producer
#      aside);
#   4. judges them with the reference's judge as well;
#   5. compares validation, loading and writing on every validation case;
#   6. compares the forward mapping (points and Jacobians) bit for bit,
#      idle weights (driven on the reference's motion queue) frame by frame,
#      evaluation sequences with NaN, ±∞ and partial changes (incremental
#      and full evaluation), and live lip sync on generated samples, bit for
#      bit;
#   7. compares the JSON parser's error messages with JSON.parse's;
#   8. compares the vendored fdlibm with Node's Math bit for bit, and the
#      vendored musl float32 functions with Mochi2D's port of them (musl's
#      own builds: tests/crosscheck/libm32.sh).
#
# usage: tests/crosscheck/run.sh <build dir> [models] [mutations]
# Nothing it writes is committed: everything goes to <build dir>/crosscheck.
set -euo pipefail

BUILD="$(cd "${1:?usage: run.sh <build dir> [models] [mutations]}" && pwd)"
MODELS="${2:-120}"
MUTATIONS="${3:-300}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="$ROOT/reference/mochi2d-0.24.1"
OUT="$BUILD/crosscheck"
CLI="$BUILD/mochi2d-native"
CHECK="$BUILD/tests/mochi2d_check_validate"
CHECK_MAP="$BUILD/tests/mochi2d_check_map"
CHECK_MATH="$BUILD/tests/mochi2d_check_math"
CHECK_LIBM32="$BUILD/tests/mochi2d_check_libm32"
CHECK_IDLE="$BUILD/tests/mochi2d_check_idle"
CHECK_EVAL="$BUILD/tests/mochi2d_check_eval"
CHECK_LIVE="$BUILD/tests/mochi2d_check_live"

if [ ! -d "$REF/node_modules" ]; then
  echo "crosscheck: reference dependencies missing (run: npm ci --prefix $REF)" >&2
  exit 77
fi
[ -x "$CLI" ] || { echo "crosscheck: $CLI not built" >&2; exit 2; }
[ -x "$CHECK" ] || { echo "crosscheck: $CHECK not built" >&2; exit 2; }

rm -rf "$OUT"
mkdir -p "$OUT"
if [ ! -f "$REF/dist/tools/conformance.js" ] || [ ! -f "$REF/dist/tools/resultdiff.js" ]; then
  (cd "$REF" && npm run --silent build:tools >/dev/null)
fi
"$REF/node_modules/.bin/esbuild" "$ROOT/tests/crosscheck/generate.ts" --bundle --platform=node --format=esm \
  --outfile="$OUT/generate.mjs" --log-level=warning
node "$OUT/generate.mjs" "$OUT/data" --models "$MODELS" --mutations "$MUTATIONS"

DATA="$OUT/data"
(cd "$REF" && node dist/tools/conformance.js "$DATA/scenarios" --out "$OUT/reference" --models "$DATA/models" >/dev/null || true)
"$CLI" run "$DATA/scenarios" --out "$OUT/native" --models "$DATA/models" --quiet >/dev/null || true
# The same scenarios with every evaluation from scratch: identical results.
"$CLI" run "$DATA/scenarios" --out "$OUT/native-full" --models "$DATA/models" --quiet --full-evaluation >/dev/null || true

# Byte-identical results (only the producer differs).
differ=0
total=0
for f in "$OUT/reference"/*.result.json; do
  total=$((total + 1))
  b="$(basename "$f")"
  if ! cmp -s <(grep -v '"producer"' "$f") <(grep -v '"producer"' "$OUT/native/$b"); then
    differ=$((differ + 1))
    if [ "$differ" -le 5 ]; then
      echo "DIFFERS: $b"
      diff <(grep -v '"producer"' "$f") <(grep -v '"producer"' "$OUT/native/$b") | head -8 || true
    fi
  fi
done
echo "results (static, sequence, animation): $((total - differ))/$total byte-identical to the reference"
full_differ=0
for f in "$OUT/reference"/*.result.json; do
  b="$(basename "$f")"
  if ! cmp -s <(grep -v '"producer"' "$f") <(grep -v '"producer"' "$OUT/native-full/$b"); then
    full_differ=$((full_differ + 1))
    [ "$full_differ" -le 5 ] && echo "DIFFERS (full evaluation): $b"
  fi
done
echo "results with full evaluation: $((total - full_differ))/$total byte-identical to the reference"

# The judge is informational: it scores a null (NaN) against the same null
# as a difference, and byte identity is the measure here.
(cd "$REF" && node dist/tools/resultdiff.js --judge "$OUT/reference" "$OUT/native" --out "$OUT/judge-report.json" | tail -4) || true

"$CHECK" "$DATA/validate"
"$CHECK_MAP" "$DATA"
"$CHECK_IDLE" "$DATA"
"$CHECK_EVAL" "$DATA"
"$CHECK_LIVE" "$DATA"

# JSON.parse's error messages (they appear in warnings about broken files).
node "$ROOT/tests/crosscheck/json.mjs" "$OUT/json-cases.json" 50000 >/dev/null
"$BUILD/tests/mochi2d_check_json" "$OUT/json-cases.json"

# The vendored fdlibm against Node's Math, bit for bit.
node "$ROOT/tests/crosscheck/math.mjs" "$OUT/math.txt" 100000
"$CHECK_MATH" "$OUT/math.txt" | tail -1
"$REF/node_modules/.bin/esbuild" "$ROOT/tests/crosscheck/libm32.ts" --bundle --platform=node --format=esm \
  --outfile="$OUT/libm32.mjs" --log-level=warning
node "$OUT/libm32.mjs" "$OUT/libm32.bin" >/dev/null
"$CHECK_LIBM32" "$OUT/libm32.bin"

[ "$differ" -eq 0 ] && [ "$full_differ" -eq 0 ]

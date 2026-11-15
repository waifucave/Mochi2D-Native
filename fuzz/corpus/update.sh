#!/usr/bin/env bash
# Regenerates the committed fuzz corpora (see README.md): the seeds written by
# the unit test binary, fuzzed for a while from there, then merged to a
# smallest set with the same coverage.
#
# usage: fuzz/corpus/update.sh <seconds per target>   (needs Clang with libFuzzer)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SECONDS_PER_TARGET="${1:-600}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cmake -S "$ROOT" -B "$WORK/seeds" -DMOCHI2D_CROSSCHECK=OFF >/dev/null
cmake --build "$WORK/seeds" --parallel --target mochi2d_tests >/dev/null
"$WORK/seeds/tests/mochi2d_tests" --write-seeds "$WORK/seed-files" >/dev/null
CC="${CC:-clang}" CXX="${CXX:-clang++}" cmake -S "$ROOT" -B "$WORK/fuzz" -DCMAKE_BUILD_TYPE=Debug -DMOCHI2D_FUZZ=ON \
  -DMOCHI2D_BUILD_TESTS=OFF -DMOCHI2D_BUILD_CLI=OFF -DMOCHI2D_SHARED=OFF >/dev/null
cmake --build "$WORK/fuzz" --parallel >/dev/null
for t in moc json anim model; do
  # .moc3 inputs are kept to 6 KB (the seed models' size), the others to 16 KB.
  len=16384
  [ "$t" = moc ] && len=6144
  mkdir -p "$WORK/grow-$t"
  cp "$WORK/seed-files/$t/"* "$WORK/grow-$t/"
  [ -d "$ROOT/fuzz/corpus/$t" ] && cp "$ROOT/fuzz/corpus/$t/"* "$WORK/grow-$t/" 2>/dev/null || true
  "$WORK/fuzz/fuzz/fuzz_$t" "$WORK/grow-$t" -max_total_time="$SECONDS_PER_TARGET" -max_len="$len" -timeout=10 \
    -rss_limit_mb=2048 >/dev/null 2>&1
  rm -rf "$ROOT/fuzz/corpus/$t"
  mkdir -p "$ROOT/fuzz/corpus/$t"
  "$WORK/fuzz/fuzz/fuzz_$t" -merge=1 -max_len="$len" "$ROOT/fuzz/corpus/$t" "$WORK/seed-files/$t" "$WORK/grow-$t" \
    >/dev/null 2>&1
  echo "$t: $(ls "$ROOT/fuzz/corpus/$t" | wc -l) inputs"
done

#!/usr/bin/env bash
# The benchmarks on a synthetic model of DeepSeek-chan's size, made with the
# reference's builder (tests/bench/model.ts):
#
#   - evaluation (bench.cpp): full against incremental evaluation in Mochi2D
#     Native, and the same workloads in Mochi2D itself for comparison;
#   - rendering (render_bench.cpp): the reference renderer on 1, 2, 4, ...
#     threads, on the same model with its meshes shaped as artwork
#     (model.ts --render).
#
# Needs Node ≥ 20 and the reference's dependencies (npm ci --prefix
# reference/mochi2d-0.21.0). Nothing it writes is committed: everything goes
# to <build dir>/bench.
#
# usage: tests/bench/run.sh <build dir> [frames] [render frames]
set -euo pipefail

BUILD="$(cd "${1:?usage: run.sh <build dir> [frames]}" && pwd)"
FRAMES="${2:-300}"
RENDER_FRAMES="${3:-10}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="$ROOT/reference/mochi2d-0.21.0"
OUT="$BUILD/bench"
[ -d "$REF/node_modules" ] || { echo "bench: run npm ci --prefix $REF first" >&2; exit 77; }
for b in mochi2d_bench mochi2d_render_bench; do
  [ -x "$BUILD/tests/$b" ] || { echo "bench: $BUILD/tests/$b not built" >&2; exit 2; }
done
mkdir -p "$OUT"
for f in model reference; do
  "$REF/node_modules/.bin/esbuild" "$ROOT/tests/bench/$f.ts" --bundle --platform=node --format=esm \
    --outfile="$OUT/$f.mjs" --log-level=warning
done
node "$OUT/model.mjs" "$OUT/bench.moc3"
"$BUILD/tests/mochi2d_bench" "$OUT/bench.moc3" "$FRAMES"
echo
node "$OUT/reference.mjs" "$OUT/bench.moc3" "$FRAMES"
echo
node "$OUT/model.mjs" "$OUT/render.moc3" --render
"$BUILD/tests/mochi2d_render_bench" "$OUT/render.moc3" "$RENDER_FRAMES" 512x1024 1024x2048

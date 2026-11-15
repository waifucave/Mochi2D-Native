#!/usr/bin/env bash
# The committed MSL and HLSL (src/render/gpu/cross_sources.inc, hlsl/) are
# what tests/gpu/make_shaders.sh makes from today's shaders. Compared where
# the same glslang and SPIRV-Cross made them (other versions may write other
# text for the same program); with others, the programs are only
# translated. 77 without glslang or spirv-cross.
#
# usage: tests/gpu/check_shaders.sh <build dir>
set -euo pipefail
BUILD="$(cd "${1:?usage: check_shaders.sh <build dir>}" && pwd)"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMMITTED="$ROOT/src/render/gpu"
command -v glslangValidator >/dev/null || { echo "gpu-shaders: glslangValidator missing (skipped)"; exit 77; }
command -v spirv-cross >/dev/null || { echo "gpu-shaders: spirv-cross missing (skipped)"; exit 77; }
OUT="$BUILD/gpu-shaders"
rm -rf "$OUT"
"$ROOT/tests/gpu/make_shaders.sh" "$BUILD" "$OUT" >/dev/null
if [ "$(head -1 "$COMMITTED/cross_sources.inc")" != "$(head -1 "$OUT/cross_sources.inc")" ]; then
  echo "gpu-shaders: other tools ($(head -1 "$OUT/cross_sources.inc" | sed 's/.*(\(.*\)).*/\1/')) than the committed files'; the programs translate"
  exit 0
fi
if ! cmp -s "$COMMITTED/cross_sources.inc" "$OUT/cross_sources.inc" ||
  ! diff -r -q "$COMMITTED/hlsl" "$OUT/hlsl" >/dev/null; then
  echo "gpu-shaders: src/render/gpu is stale: run tests/gpu/make_shaders.sh <build dir>" >&2
  exit 1
fi
echo "gpu-shaders: the committed MSL and HLSL are today's"

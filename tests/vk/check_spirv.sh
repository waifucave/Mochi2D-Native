#!/usr/bin/env bash
# The committed SPIR-V (src/render/vk/spirv.inc) is what tests/vk/make_spirv.sh
# makes from today's shaders. Compared where the same glslang version made
# it (other versions may emit other words for the same text); with another
# version, the shaders are only compiled and validated. 77 without glslang.
#
# usage: tests/vk/check_spirv.sh <build dir>
set -euo pipefail
BUILD="$(cd "${1:?usage: check_spirv.sh <build dir>}" && pwd)"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMMITTED="$ROOT/src/render/vk/spirv.inc"
command -v glslangValidator >/dev/null || { echo "vk-spirv: glslangValidator missing (skipped)"; exit 77; }
OUT="$BUILD/vk-spirv.inc"
"$ROOT/tests/vk/make_spirv.sh" "$BUILD" "$OUT" >/dev/null
if [ "$(sed -n 2p "$COMMITTED")" != "$(sed -n 2p "$OUT")" ]; then
  echo "vk-spirv: another glslang ($(sed -n 2p "$OUT")) than the committed file's; the shaders compile and validate"
  exit 0
fi
if ! cmp -s "$COMMITTED" "$OUT"; then
  echo "vk-spirv: src/render/vk/spirv.inc is stale: run tests/vk/make_spirv.sh <build dir>" >&2
  exit 1
fi
echo "vk-spirv: the committed SPIR-V is today's"

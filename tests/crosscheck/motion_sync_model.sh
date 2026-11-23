#!/usr/bin/env bash
# Motion sync on a model against Mochi2D 0.14.0's model runtime, bit for bit:
# the crafted settings of Mochi2D's model tests (tests/crosscheck/motion_sync_model.ts)
# with each "Talk" entry started as Mochi2D's runtime starts it, against
# `mochi2d-native motion-sync-play` (the C API's package helper and animator)
# on the same files: every frame's mouth parameters, motion-sync tick, bound
# setting and motions playing, and the warnings.
#
# usage: tests/crosscheck/motion_sync_model.sh <build dir> [<DeepSeek-chan's folder>]
# Without a model folder, a synthetic package stands in. The model is copied
# into <build dir>/crosscheck-motion-sync-model, which is never committed.
# Needs Node ≥ 20 and `npm ci` in the reference folder (exit 77 otherwise).
set -euo pipefail

BUILD="$(cd "${1:?usage: motion_sync_model.sh <build dir> [model folder]}" && pwd)"
MODEL="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="$ROOT/reference/mochi2d-0.24.1"
OUT="$BUILD/crosscheck-motion-sync-model"
CLI="$BUILD/mochi2d-native"

if [ ! -d "$REF/node_modules" ]; then
  echo "motion sync model check: reference dependencies missing (run: npm ci --prefix $REF)" >&2
  exit 77
fi
[ -x "$CLI" ] || { echo "motion sync model check: $CLI not built" >&2; exit 2; }

rm -rf "$OUT"
mkdir -p "$OUT/native"
"$REF/node_modules/.bin/esbuild" "$ROOT/tests/crosscheck/motion_sync_model.ts" --bundle --platform=node --format=esm \
  --outfile="$OUT/motion_sync_model.mjs" --log-level=warning
if [ -n "$MODEL" ]; then
  node "$OUT/motion_sync_model.mjs" "$OUT" --model "$MODEL"
else
  node "$OUT/motion_sync_model.mjs" "$OUT"
fi

total=0
differ=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  IFS=$'\t' read -r -a argv <<< "$line"
  name="${argv[0]}"
  "$CLI" "${argv[@]:1}" > "$OUT/native/$name.json"
  total=$((total + 1))
  if ! cmp -s "$OUT/reference/$name.json" "$OUT/native/$name.json"; then
    echo "motion sync model check: $name differs" >&2
    differ=$((differ + 1))
  fi
done < "$OUT/cases.txt"
echo "motion sync model check: $((total - differ)) of $total cases byte-identical"
[ "$differ" -eq 0 ]

#!/usr/bin/env bash
# Motion sync against Mochi2D 0.14.0 (reference/), bit for bit: Mochi2D's
# motion-sync driver and its own analysis over synthetic sounds made by the
# reference's test support (tests/crosscheck/motion_sync.ts), against
# `mochi2d-native motion-sync-trace` on the same files: every analysis
# (raw weights, voicing, openness, level, features), every reported tick and
# the values written after each frame; the voice profiles of calibrations
# (`mochi2d-native voice-profile`); and the library's neutral voice profile.
#
# usage: tests/crosscheck/motion_sync.sh <build dir>
# Needs Node ≥ 20 and `npm ci` in the reference folder (exit 77 otherwise).
# Nothing it writes is committed: everything goes to <build dir>/crosscheck-motion-sync.
set -euo pipefail

BUILD="$(cd "${1:?usage: motion_sync.sh <build dir>}" && pwd)"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="$ROOT/reference/mochi2d-0.24.1"
OUT="$BUILD/crosscheck-motion-sync"
CLI="$BUILD/mochi2d-native"
NEUTRAL="$BUILD/tests/mochi2d_make_neutral"

if [ ! -d "$REF/node_modules" ]; then
  echo "motion sync check: reference dependencies missing (run: npm ci --prefix $REF)" >&2
  exit 77
fi
[ -x "$CLI" ] || { echo "motion sync check: $CLI not built" >&2; exit 2; }

rm -rf "$OUT"
mkdir -p "$OUT/native"
"$REF/node_modules/.bin/esbuild" "$ROOT/tests/crosscheck/motion_sync.ts" --bundle --platform=node --format=esm \
  --outfile="$OUT/motion_sync.mjs" --log-level=warning
node "$OUT/motion_sync.mjs" "$OUT"

total=0
differ=0
ticks=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  IFS=$'\t' read -r -a argv <<< "$line"
  name="${argv[0]}"
  "$CLI" "${argv[@]:1}" > "$OUT/native/$name.json"
  total=$((total + 1))
  if ! cmp -s "$OUT/reference/$name.json" "$OUT/native/$name.json"; then
    echo "motion sync check: $name differs" >&2
    differ=$((differ + 1))
  fi
  ticks=$((ticks + $( (grep -o '"frame":' "$OUT/native/$name.json" || true) | wc -l)))
done < "$OUT/cases.txt"

neutral=identical
if [ -x "$NEUTRAL" ]; then
  "$NEUTRAL" --json > "$OUT/native/neutral.json"
  cmp -s "$OUT/reference/neutral.json" "$OUT/native/neutral.json" || neutral=different
else
  neutral="not checked ($NEUTRAL not built)"
fi

echo "motion sync check: $((total - differ)) of $total traces and profiles byte-identical ($ticks analyses); neutral profile $neutral"
[ "$differ" -eq 0 ] && [ "$neutral" = identical ]

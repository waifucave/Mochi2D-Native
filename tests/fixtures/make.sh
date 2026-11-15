#!/usr/bin/env bash
# Regenerates the committed fixtures (see README.md): synthetic models with
# their motions, expressions, physics, poses and sounds, scenarios on them,
# and the reference's results for those scenarios; and the render fixtures,
# synthetic textured models and render scenarios with the SHA-256 of
# mochi2d-native's renders of them (from the build given). Needs Node ≥ 20
# and the reference's dependencies (npm ci --prefix reference/mochi2d-0.21.0).
#
# usage: tests/fixtures/make.sh [build dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="$ROOT/reference/mochi2d-0.21.0"
FIX="$ROOT/tests/fixtures"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -d "$REF/node_modules" ] || { echo "make.sh: run npm ci --prefix $REF first" >&2; exit 1; }
if [ ! -f "$REF/dist/tools/conformance.js" ]; then
  (cd "$REF" && npm run --silent build:tools >/dev/null)
fi
"$REF/node_modules/.bin/esbuild" "$ROOT/tests/crosscheck/generate.ts" --bundle --platform=node --format=esm \
  --outfile="$TMP/generate.mjs" --log-level=warning
node "$TMP/generate.mjs" "$TMP/data" --models 6 --mutations 0 --anims 2 --sound-scale 0.12 --scenarios-only
# The float32 rules' vectors of the reference's test/bit-exact-vectors.test.ts, as models and scenarios.
"$REF/node_modules/.bin/esbuild" "$ROOT/tests/crosscheck/bit_exact.ts" --bundle --platform=node --format=esm \
  --outfile="$TMP/bit_exact.mjs" --log-level=warning
node "$TMP/bit_exact.mjs" "$TMP/data"
rm -rf "$FIX/models" "$FIX/scenarios" "$FIX/expected"
cp -R "$TMP/data/models" "$FIX/models"
cp -R "$TMP/data/scenarios" "$FIX/scenarios"
(cd "$REF" && node dist/tools/conformance.js "$FIX/scenarios" --out "$FIX/expected" --models "$FIX/models" >/dev/null || true)
echo "fixtures: $(ls "$FIX/scenarios" | wc -l) scenarios, $(ls "$FIX/expected" | wc -l) expected results"

# The evaluation switches' model, its reduced variants and Mochi2D's outputs (tests/crosscheck/switches.ts).
"$REF/node_modules/.bin/esbuild" "$ROOT/tests/crosscheck/switches.ts" --bundle --platform=node --format=esm \
  --outfile="$TMP/switches.mjs" --log-level=warning
rm -rf "$FIX/switches"
node "$TMP/switches.mjs" "$FIX/switches"

# Render fixtures (tests/crosscheck/render.ts without the reference's renders).
"$REF/node_modules/.bin/esbuild" "$ROOT/tests/crosscheck/render.ts" --bundle --platform=node --format=esm \
  --outfile="$TMP/render.mjs" --log-level=warning --external:playwright \
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
node "$TMP/render.mjs" "$TMP/render" --models 6 --seed 7 --no-reference
rm -rf "$FIX/render/models" "$FIX/render/scenarios"
mkdir -p "$FIX/render"
cp -R "$TMP/render/models" "$FIX/render/models"
cp -R "$TMP/render/scenarios" "$FIX/render/scenarios"
if [ -n "${1:-}" ]; then
  "$1/mochi2d-native" render "$FIX/render/scenarios" --out "$TMP/render-out" --models "$FIX/render/models" --quiet \
    >/dev/null || true
  (cd "$TMP/render-out" && sha256sum -- *.png) > "$FIX/render/expected.sha256"
  echo "render fixtures: $(wc -l < "$FIX/render/expected.sha256") renders hashed"
else
  echo "render fixtures: models and scenarios only (give a build dir to hash the renders)"
fi

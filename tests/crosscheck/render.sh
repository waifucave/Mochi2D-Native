#!/usr/bin/env bash
# Render cross-check: Mochi2D Native's reference renderer against Mochi2D
# 0.18.0's WebGL2 renderer (reference/) on synthetic textured models made at
# test time (tests/crosscheck/render.ts):
#
#   1. builds the reference (its web harness and tools; needs Node ≥ 20,
#      `npm ci` in the reference folder and the Chromium that Playwright
#      finds);
#   2. generates the models (the reference's own builder, with generated PNG
#      textures), the render scenarios, and the reference's renders of them
#      (its render harness in headless Chromium);
#   3. renders the same scenarios with `mochi2d-native render` (the
#      reference renderer), or with a GPU backend, by the fourth argument:
#        gl-es, gl-desktop     the GL backend on the system's EGL (Mesa);
#        gl-es-angle           the GL backend on ANGLE over SwiftShader's
#                              Vulkan driver (MOCHI2D_ANGLE: the folder of
#                              ANGLE's libEGL.so and libGLESv2.so);
#        vk                    the Vulkan backend on SwiftShader's Vulkan
#                              driver (MOCHI2D_SWIFTSHADER_ICD, or the one
#                              beside Playwright's Chromium);
#        vk-lavapipe           the Vulkan backend on Mesa's lavapipe;
#   4. judges the two sets with the reference's judge (resultdiff --judge)
#      and requires every scenario to pass. On SwiftShader (software,
#      gl-es-angle, vk) against Mochi2D's own renders. On Mesa (gl-es,
#      gl-desktop, vk-lavapipe), Mochi2D's renders are made a second time
#      with ANGLE over the system's OpenGL ES (bundle.mjs swaps the flag in
#      the bundle), the closest driver: the backend must pass against those;
#      its numbers against the SwiftShader renders, and the two drivers'
#      against each other, are reported.
#
# usage: tests/crosscheck/render.sh <build dir> [models] [seed] [backend]
# Nothing it writes is committed: everything goes to <build dir>/rendercheck
# (rendercheck-<backend> for a GPU backend).
set -euo pipefail

BUILD="$(cd "${1:?usage: render.sh <build dir> [models] [seed]}" && pwd)"
MODELS="${2:-12}"
SEED="${3:-7}"
BACKEND="${4:-software}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="$ROOT/reference/mochi2d-0.24.1"
OUT="$BUILD/rendercheck"
CLI="$BUILD/mochi2d-native"
GL="$BUILD/tests/mochi2d-gl-render"
VK="$BUILD/tests/mochi2d-vk-render"
swiftshader_icd() {
  if [ -n "${MOCHI2D_SWIFTSHADER_ICD:-}" ]; then echo "$MOCHI2D_SWIFTSHADER_ICD"; return; fi
  ls -d /opt/pw-browsers/chromium*/chrome-linux*/vk_swiftshader_icd.json \
    "$HOME"/.cache/ms-playwright/chromium*/chrome-linux*/vk_swiftshader_icd.json 2>/dev/null | sort -r | head -1 || true
}
# TOOL: the backend's command; SAME: the reference renders on its driver (reference, or reference-gl on Mesa).
TOOL=()
SAME=reference
case "$BACKEND" in
  software) ;;
  gl-es | gl-desktop)
    [ -x "$GL" ] || { echo "rendercheck: $GL not built (no EGL)" >&2; exit 77; }
    TOOL=("$GL" --api "${BACKEND#gl-}")
    SAME=reference-gl
    ;;
  gl-es-angle)
    [ -x "$GL" ] || { echo "rendercheck: $GL not built (no EGL)" >&2; exit 77; }
    [ -f "${MOCHI2D_ANGLE:-}/libEGL.so" ] || { echo "rendercheck: MOCHI2D_ANGLE (ANGLE's libEGL.so) not set" >&2; exit 77; }
    ICD="$(swiftshader_icd)"
    [ -f "$ICD" ] || { echo "rendercheck: SwiftShader's Vulkan driver not found" >&2; exit 77; }
    TOOL=(env "VK_ICD_FILENAMES=$ICD" "$GL" --api es --egl "$MOCHI2D_ANGLE/libEGL.so")
    ;;
  vk | vk-lavapipe)
    [ -x "$VK" ] || { echo "rendercheck: $VK not built (no Vulkan headers or loader)" >&2; exit 77; }
    if [ "$BACKEND" = vk ]; then ICD="$(swiftshader_icd)"; else ICD=/usr/share/vulkan/icd.d/lvp_icd.json; SAME=reference-gl; fi
    [ -f "$ICD" ] || { echo "rendercheck: no Vulkan driver for $BACKEND" >&2; exit 77; }
    TOOL=("$VK" --icd "$ICD")
    ;;
  *) echo "rendercheck: the backend is software, gl-es, gl-desktop, gl-es-angle, vk or vk-lavapipe" >&2; exit 2 ;;
esac
if [ "$BACKEND" != software ]; then
  OUT="$BUILD/rendercheck-$BACKEND"
  # The tools take their subcommand first.
  run_tool() {
    local sub="$1"; shift
    if [ "${TOOL[0]}" = env ]; then "${TOOL[0]}" "${TOOL[1]}" "${TOOL[2]}" "$sub" "${TOOL[@]:3}" "$@"
    else "${TOOL[0]}" "$sub" "${TOOL[@]:1}" "$@"; fi
  }
  st=0; DEVICE="$(run_tool info 2>/dev/null)" || st=$?
  [ "$st" = 0 ] || exit 77
fi

if [ ! -d "$REF/node_modules" ]; then
  echo "rendercheck: reference dependencies missing (run: npm ci --prefix $REF)" >&2
  exit 77
fi
[ -x "$CLI" ] || { echo "rendercheck: $CLI not built" >&2; exit 2; }
# Playwright and its Chromium, found as the reference finds them (MOCHI2D_PLAYWRIGHT,
# the playwright or playwright-core package, or a global install).
if ! (cd "$REF" && node -e '
const { join } = require("path");
let root = "";
try { root = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim(); } catch {}
const names = [process.env.MOCHI2D_PLAYWRIGHT, "playwright", "playwright-core",
  root && join(root, "playwright"), root && join(root, "playwright-core")].filter(Boolean);
for (const n of names) {
  let pw;
  try { pw = require(n); } catch { continue; }
  process.exit(require("fs").existsSync(pw.chromium.executablePath()) ? 0 : 1);
}
process.exit(1);') 2>/dev/null; then
  echo "rendercheck: Playwright or its Chromium is missing (npm install -g playwright && playwright install chromium)" >&2
  exit 77
fi
if [ ! -f "$REF/dist/web/harness.html" ] || [ ! -f "$REF/dist/tools/resultdiff.js" ]; then
  (cd "$REF" && npm run --silent build >/dev/null)
fi

rm -rf "$OUT"
mkdir -p "$OUT"
node "$ROOT/tests/crosscheck/bundle.mjs" "$REF" "$ROOT/tests/crosscheck/render.ts" "$OUT/render.mjs"
node "$OUT/render.mjs" "$OUT/data" --models "$MODELS" --seed "$SEED" --ref "$REF"
if [ "$SAME" = reference-gl ]; then
  # Mochi2D's renders again, with ANGLE over the system's OpenGL ES (Mesa,
  # the driver the backend runs on): the backend is judged against these;
  # the SwiftShader renders' numbers are reported.
  node "$ROOT/tests/crosscheck/bundle.mjs" "$REF" "$ROOT/tests/crosscheck/render.ts" "$OUT/render-gl.mjs" gl-egl
  node "$OUT/render-gl.mjs" "$OUT/data" --models "$MODELS" --seed "$SEED" --ref "$REF" --reference-out reference-gl
fi

DATA="$OUT/data"
if [ "$BACKEND" = software ]; then
  "$CLI" render "$DATA/scenarios" --out "$OUT/native" --models "$DATA/models" --quiet >/dev/null || true
else
  run_tool render "$DATA/scenarios" --out "$OUT/native" --models "$DATA/models" 2>&1 \
    | grep -E "^(context|device|FAIL)" || true
fi
summary() {
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const adv = j.scenarios.filter((s) => s.advisories.length).length;
let worst = { v: 0, id: "" };
for (const s of j.scenarios)
  for (const q of s.largest ?? []) if (q.quantity === "RMS" && q.value > worst.v) worst = { v: q.value, id: s.id };
console.log(`renders: ${j.passed}/${j.passed + j.failed} pass the judge; ${adv} with advisories; largest RMS ${worst.v.toFixed(3)} (${worst.id})`);
for (const s of j.scenarios.filter((s) => !s.pass).slice(0, 10)) console.log(`FAILS: ${s.id}: ${s.firstFailure}`);
' "$1"
}
judge() { (cd "$REF" && node dist/tools/resultdiff.js --judge "$1" "$2" --out "$3" >/dev/null) || return $?; }
status=0
driver_of() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).renderer ?? "?")' \
    "$(ls "$1"/*.render.json | head -1)"
}
if [ "$BACKEND" = software ]; then
  (cd "$REF" && node dist/tools/resultdiff.js --judge "$DATA/reference" "$OUT/native" --out "$OUT/judge.json") || status=$?
  summary "$OUT/judge.json"
elif [ "$SAME" = reference ]; then
  echo "Mochi2D on $(driver_of "$DATA/reference"); $BACKEND on $DEVICE"
  judge "$DATA/reference" "$OUT/native" "$OUT/judge.json" || status=$?
  printf "%s against Mochi2D's renders: " "$BACKEND"; summary "$OUT/judge.json"
else
  echo "Mochi2D on $(driver_of "$DATA/reference-gl"); $BACKEND on $DEVICE"
  judge "$DATA/reference-gl" "$OUT/native" "$OUT/judge.json" || status=$?
  printf "%s against Mochi2D on the same driver: " "$BACKEND"; summary "$OUT/judge.json"
  judge "$DATA/reference" "$OUT/native" "$OUT/judge-swiftshader.json" || true
  printf "%s against Mochi2D on SwiftShader (reported): " "$BACKEND"; summary "$OUT/judge-swiftshader.json" | head -1
  judge "$DATA/reference" "$DATA/reference-gl" "$OUT/judge-drivers.json" || true
  printf "Mochi2D on that driver against Mochi2D on SwiftShader (reported): "; summary "$OUT/judge-drivers.json" | head -1
fi
exit "$status"

#!/usr/bin/env bash
# The licenses of the third-party code in an ANGLE build's libEGL and
# libGLESv2 (tests/gl/build_angle.sh), as one text: the targets' third_party
# folders by `gn desc … deps --all`, and each folder's license file (its
# README.chromium's "License File", else a LICENSE, COPYING or NOTICE file
# in the folder or its src/). ANGLE's own LICENSE and the Vulkan loader's
# ship beside it in the test asset (.github/workflows/angle.yml).
#
# usage: tests/gl/angle_licenses.sh <angle checkout> <build dir, e.g. out/vk> > LICENSE-third-party
set -euo pipefail
A="$(cd "${1:?usage: angle_licenses.sh <angle checkout> <build dir>}" && pwd)"
OUT="${2:?usage: angle_licenses.sh <angle checkout> <build dir>}"
cd "$A"
dirs="$(for t in //:libEGL //:libGLESv2; do buildtools/linux64/gn desc "$OUT" "$t" deps --all; done |
  sed -n 's#^//\(\(src/\|buildtools/\)\{0,1\}third_party/[^/:]*\).*#\1#p' | sort -u)"
[ -n "$dirs" ] || { echo "angle_licenses: no third_party dependencies found" >&2; exit 1; }
echo "Third-party code in ANGLE's libEGL.so and libGLESv2.so, as built ($(git rev-parse HEAD))."
echo "Each section is that component's license file, as its source tree has it."
missing=0
for d in $dirs; do
  file=""
  # buildtools/third_party/libc++ builds the sources in third_party/libc++: look there too.
  for src in "$d" "third_party/${d##*/}"; do
    [ -d "$src" ] || continue
    if [ -f "$src/README.chromium" ]; then
      f="$(sed -n 's/^License File: *//p' "$src/README.chromium" | head -1 | cut -d, -f1 | tr -d ' ')"
      f="${f#/}"
      for c in "$src/$f" "$f"; do [ -n "$f" ] && [ -f "$c" ] && { file="$c"; break; }; done
    fi
    if [ -z "$file" ]; then
      for c in "$src"/LICENSE* "$src"/COPYING* "$src"/NOTICE* "$src"/src/LICENSE* "$src"/src/COPYING* \
        "$src"/src/NOTICE*; do
        [ -f "$c" ] && { file="$c"; break; }
      done
    fi
    [ -n "$file" ] && break
  done
  printf '\n================================================================================\n%s\n' "$d"
  if [ -n "$file" ]; then
    printf '(%s)\n\n' "$file"
    cat "$file"
  else
    echo "(no license file found in the checkout)"
    missing=1
  fi
done
[ "$missing" = 0 ] || echo "angle_licenses: some components have no license file in the checkout" >&2

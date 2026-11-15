#!/usr/bin/env bash
# Builds the release package of one platform: the C API's shared
# and static libraries, mochi2d.h, the CMake package config, LICENSE,
# THIRD_PARTY_NOTICES.md and the stability list, installed into a prefix
# and archived; then builds tests/package (a consumer that finds the package)
# against it, shared and static, and runs one model with each. Prints what
# the package weighs.
#
# usage: tests/package/package.sh <name> [extra CMake arguments...]
#        (writes mochi2d-native-<version>-<name>.tar.gz, or .zip on Windows, in the working directory)
set -euo pipefail
NAME="${1:?usage: package.sh <name> [cmake args...]}"
shift
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${PACKAGE_WORK:-$PWD/package-work}"
VERSION="$(sed -n 's/^project(mochi2d_native VERSION \([0-9.]*\).*/\1/p' "$ROOT/CMakeLists.txt")"
PKG="mochi2d-native-$VERSION-$NAME"
rm -rf "$WORK"
mkdir -p "$WORK"
cmake -S "$ROOT" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DMOCHI2D_BUILD_TESTS=OFF -DMOCHI2D_BUILD_CLI=OFF "$@"
cmake --build "$WORK/build" --config Release --parallel
cmake --install "$WORK/build" --config Release --prefix "$WORK/$PKG" --strip
# The consumer: finds the package, links it both ways, runs a model.
cmake -S "$ROOT/tests/package" -B "$WORK/consumer" -DCMAKE_PREFIX_PATH="$WORK/$PKG" -DCMAKE_BUILD_TYPE=Release "$@"
cmake --build "$WORK/consumer" --config Release
MODEL="$ROOT/tests/fixtures/render/models/render05-v6/render05-v6.moc3"
for kind in shared static; do
  exe="$WORK/consumer/consumer_$kind"
  [ -f "$exe" ] || exe="$WORK/consumer/Release/consumer_$kind.exe"
  # The shared library from the package (bin/ on Windows, lib/ elsewhere).
  PATH="$WORK/$PKG/bin:$PATH" LD_LIBRARY_PATH="$WORK/$PKG/lib" DYLD_LIBRARY_PATH="$WORK/$PKG/lib" "$exe" "$MODEL"
done
# What it weighs: each file, the whole, the archive.
echo "== $PKG"
(cd "$WORK/$PKG" && find . -type f | sort | while read -r f; do
  printf "%10d  %s\n" "$(wc -c <"$f" | tr -d ' ')" "${f#./}"
done)
if command -v lipo >/dev/null && [ -f "$WORK/$PKG/lib/libmochi2d.dylib" ]; then lipo -info "$WORK/$PKG/lib/libmochi2d.dylib"; fi
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    ARCHIVE="$PKG.zip"
    (cd "$WORK" && 7z a -tzip -bso0 "$OLDPWD/$ARCHIVE" "$PKG")
    ;;
  *)
    ARCHIVE="$PKG.tar.gz"
    tar -czf "$ARCHIVE" -C "$WORK" "$PKG"
    ;;
esac
echo "package: $ARCHIVE, $(wc -c <"$ARCHIVE" | tr -d ' ') bytes packed, $(cd "$WORK/$PKG" && find . -type f -exec cat {} + | wc -c | tr -d ' ') bytes installed"

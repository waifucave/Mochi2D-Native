#!/usr/bin/env bash
# Builds ANGLE (BSD-3-Clause, https://chromium.googlesource.com/angle/angle)
# from source for the GL backend's tests: its Vulkan backend only, so it runs
# over SwiftShader's Vulkan driver, as the reference renders are made
# (Chromium's ANGLE on SwiftShader). Test tooling, never part of the
# library. vcpkg's ANGLE port builds only the OpenGL backend on Linux, so
# it cannot run over SwiftShader.
#
# The branch is the one of the Chromium that Playwright installs (153.0.8010:
# chromium/8010). It needs git, Python 3, about 16 GB for the checkout (11 GB
# after the pruning below) and 1–2 hours on four cores. The libraries end up
# in <dir>/angle/out/vk (libEGL.so, libGLESv2.so, and the Vulkan loader
# libvulkan.so.1 that ANGLE builds and loads from beside it: the system's
# refuses ANGLE's instance, so a copy of the libraries keeps all three); point the tests at them
# with -DMOCHI2D_ANGLE_DIR=<dir>/angle/out/vk (CMake) or MOCHI2D_ANGLE
# (tests/crosscheck/render.sh gl-es-angle).
#
# usage: tests/gl/build_angle.sh <dir> [branch]
set -euo pipefail
W="$(mkdir -p "${1:?usage: build_angle.sh <dir> [branch]}" && cd "$1" && pwd)"
BRANCH="${2:-chromium/8010}"
cd "$W"
[ -d depot_tools ] || git clone -q --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git
export PATH="$W/depot_tools:$PATH" DEPOT_TOOLS_UPDATE=0 DEPOT_TOOLS_METRICS=0 GCLIENT_SUPPRESS_GIT_VERSION_WARNING=1
[ -d angle ] || git clone -q --depth 1 --branch "$BRANCH" https://chromium.googlesource.com/angle/angle
cd angle
python3 scripts/bootstrap.py
gclient sync --no-history --shallow -j4
# Not needed for these two libraries on Linux.
rm -rf third_party/android_sdk third_party/android_toolchain
buildtools/linux64/gn gen out/vk --args='is_debug=false is_component_build=false angle_enable_vulkan=true
  angle_enable_gl=false angle_enable_null=false angle_enable_swiftshader=false angle_build_tests=false
  angle_enable_wgpu=false angle_has_frame_capture=false build_angle_deqp_tests=false symbol_level=0
  use_siso=false use_remoteexec=false'
third_party/ninja/ninja -C out/vk libEGL libGLESv2
ls -la out/vk/libEGL.so out/vk/libGLESv2.so out/vk/libvulkan.so.1

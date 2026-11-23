# Mochi2D Native

An open-source C++ runtime for models made with Live2D Cubism (`.moc3` with
`.model3.json` and its companion files). It is the native counterpart of
Mochi2D, the project's web runtime, and the base for engine integrations
(Unity, Godot, Unreal).

**How it was made.** Most of this code was written by AI coding agents (Anthropic's Claude) under the direction of the project's maintainer, through the clean-room process in [CLEANROOM.md](CLEANROOM.md). Copyright may not subsist in every part of it. To the extent it does, it is licensed under the MIT License. Either way, it is provided as is, without warranty. Third-party code keeps its own licenses ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

Work in progress. In place: reading, validating and writing `.moc3` data
(versions 1–6), the evaluation of a model instance (incremental: only what
changed is recomputed, with results identical to a full evaluation; the
warp mapping four points at a time with SSE2, with results identical to the
scalar path), and the framework: model settings and packages (a settings
file and its companions, read through the host), motions and the motion
queue with idle weights, expressions (with fade times per call), physics
(with strength, wind, wind per setting and the step rate at runtime, and its state saved and restored bit for bit), pose,
eye blink, breath, look, lip sync from WAV sounds or live samples, motion
sync, tints, user data, display info, hit tests, and the frame procedure
that ties them together. All of it is bit-exact with Mochi2D 0.24.1 on
everything it has been compared on.

**Motion sync** moves the mouth with a sound through a setting of the
model's `.motionsync3.json` file: a motion's linked sound, any sound the host
plays (its samples with the playback clock), or live audio the host pushes
(the library opens no device). The file, its links from the settings and
the processing around the analysis follow Mochi2D. The analysis, which tells
which element (Silence, A, I, U, E, O) the sound is at each tick, is
Mochi2D's own, bit for bit: **the mouth shapes follow Mochi2D's analysis**,
and no other analysis engine is used. Voice calibration
makes a voice profile in the same JSON as Mochi2D's.

The reference renderer, a software rasterizer, draws an evaluated instance
as Mochi2D's WebGL2 renderer does in its render harness (masks, legacy
blends, version-6 blend codes and offscreens), within the judge's
tolerances of Mochi2D's own renders, into memory the caller owns, on the
calling thread or with rows split over worker threads (the same bytes with
any number). GPU backends execute the frame plan, the same decisions as a
list of operations (masks, layers, blends, colors, tints): the OpenGL
backend draws with OpenGL ES 3.0 or desktop OpenGL 3.3 core in the host's
context and into the host's framebuffer, through the host's loader, and
the Vulkan backend with Vulkan 1.1 into the host's command buffer and
image, its programs committed as SPIR-V; the Metal backend into the host's
command buffer and texture, and the Direct3D 11 backend through the host's
device and context into its render target view, their programs the same
ones translated to MSL and HLSL (committed; the HLSL compiled by fxc when
the library is built). The library links no GL, Vulkan or Direct3D library
and opens no window. On SwiftShader, the reference renders' driver, the GL
backend (through ANGLE) gives Mochi2D's renders byte for byte, and the
Vulkan backend within one level (with Mochi2D 0.18.0's render rules,
pixel-identical in 60 and 49 of the 60 render scenarios); the Metal backend on the macOS runner's
GPU and the Direct3D 11 backend on WARP pass Mochi2D's judge against
Mochi2D's own renders on the same driver. See
[docs/design.md](docs/design.md); the engine bindings' design note is
[docs/bindings.md](docs/bindings.md).

## Install

Releases are on the repository's [Releases page](../../releases): each
version tag (`v0.10.0` and later) gets a package per platform, made by
`.github/workflows/release.yml`, with its changelog section as notes.

| Package | Platform |
| --- | --- |
| `mochi2d-native-<version>-linux-x64.tar.gz` | Linux x86-64, built on Ubuntu 24.04; needs glibc 2.38 and GCC 12's libstdc++ or later |
| `mochi2d-native-<version>-linux-arm64.tar.gz` | Linux arm64, built on Ubuntu 24.04 |
| `mochi2d-native-<version>-macos-universal.tar.gz` | macOS 13.3 or later, arm64 and x86-64 |
| `mochi2d-native-<version>-windows-x64.zip` | Windows x64 (MSVC, the `/MD` runtime) |

Each holds:

- `include/mochi2d.h`;
- the shared library (`lib/`, or `bin/` for the DLL with its import
  library in `lib/`) and the static libraries in `lib/`;
- a CMake package config in `lib/cmake/mochi2d`;
- `LICENSE`, `THIRD_PARTY_NOTICES.md` and the bundled code's license texts
  in `share/mochi2d`.

Unpack it anywhere and point CMake at it. A whole project:

```cmake
cmake_minimum_required(VERSION 3.16)
project(app LANGUAGES C CXX)  # C++ too: the static libraries are C++ inside
find_package(mochi2d 0.10 CONFIG REQUIRED)
add_executable(app main.c)
target_link_libraries(app PRIVATE mochi2d::mochi2d)  # or mochi2d::mochi2d_static
```

```c
#include <mochi2d.h>
#include <stdio.h>

int main(void) {
  const uint32_t v = m2d_version();
  printf("Mochi2D Native %u.%u.%u\n", (unsigned)(v >> 16 & 255), (unsigned)(v >> 8 & 255), (unsigned)(v & 255));
  return 0;
}
```

```
cmake -S . -B build -DCMAKE_PREFIX_PATH=/path/to/mochi2d-native-0.10.0-linux-x64
cmake --build build
```

The version in `find_package` is the package's minor version: a 0.x
package is found only by its own minor version, since a 0.x minor release
may change the API. On Linux, CMake records the package's `lib/` in the
executable's run path, so it runs from the build folder; on macOS and
Windows, and whenever you ship an application, put the shared library where
the system's loader finds it (on Windows, `bin/mochi2d.dll` next to the
executable). `tests/package/` is such a project. What changed in each release is in [CHANGELOG.md](CHANGELOG.md).
To build from source instead, see below.

## Build

CMake ≥ 3.16 and a C++17 compiler (GCC, Clang, MSVC). No other dependencies.

```
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

The cross-check test runs Mochi2D itself on synthetic models (static,
sequence and animation scenarios, validation, mapping, idle weights,
evaluation sequences, live lip sync, JSON messages, math) and compares
results byte for byte. It needs Node ≥ 20 and the reference's dependencies
(`npm ci --prefix reference/mochi2d-0.24.1`); without them it is skipped.
The motion-sync checks do the same for motion sync: synthetic sounds through
Mochi2D's driver and analysis and through `mochi2d-native motion-sync-trace`
(every analysis and every value written), and the crafted settings' motions
on Mochi2D's model runtime and through the C API (`motion-sync-play`).
The render cross-check renders synthetic textured models with Mochi2D's
render harness in headless Chromium and with `mochi2d-native render`, and
judges them with Mochi2D's judge; it also needs Playwright and its Chromium
where the reference finds them (`npm install -g playwright && playwright
install chromium`). The GL backend's tests run where EGL offers a context
without a window (Mesa's surfaceless platform: `libegl-mesa0`,
`libegl-dev`), and are skipped otherwise; with Chromium, its renders are
judged against Mochi2D's own on the same driver (ANGLE over Mesa); with
ANGLE built by `tests/gl/build_angle.sh` (`-DMOCHI2D_ANGLE_DIR=…`; in CI
the release asset `angle.yml` publishes), on ANGLE over SwiftShader against
Mochi2D's reference renders. The Vulkan
backend builds where the Vulkan headers are (`libvulkan-dev` or the Vulkan
SDK); its tests run on SwiftShader's Vulkan driver (beside Playwright's
Chromium) and Mesa's lavapipe (`mesa-vulkan-drivers`). The `libm32` test compares the vendored musl float32
functions with musl's own build (`musl-gcc`, from musl-tools) on every
input. The `fixtures` test compares a committed set of the reference's
results without Node ([tests/fixtures](tests/fixtures/README.md)).

Build options: `MOCHI2D_THREADS=OFF` builds the renderer without threads
(the libraries then use no threads at all), `MOCHI2D_SIMD=OFF` keeps the
warp mapping scalar, `MOCHI2D_NO_EXCEPTIONS=ON` builds the libraries without
C++ exceptions. The benchmarks (`tests/bench/run.sh <build dir>`) time
evaluation and rendering on a synthetic model of DeepSeek-chan's size.

Fuzzing needs Clang with libFuzzer:

```
CC=clang CXX=clang++ cmake -S . -B build-fuzz -DMOCHI2D_FUZZ=ON -DMOCHI2D_BUILD_TESTS=OFF
cmake --build build-fuzz --parallel
build-fuzz/fuzz/fuzz_moc fuzz/corpus/moc -max_total_time=600
```

The targets are `fuzz_moc`, `fuzz_json`, `fuzz_anim` (the framework's
files and the animator) and `fuzz_model` (a whole model folder, opened and
stepped); [fuzz/corpus](fuzz/corpus/README.md) has their
starting corpora.

## Command line

`mochi2d-native` prints JSON:

```
mochi2d-native validate model.moc3 [--level official|strict]
mochi2d-native inspect model.model3.json
mochi2d-native evaluate model.model3.json --param ParamAngleX=15 --part PartArmL=0.5
mochi2d-native run scenarios/ --out results/ [--models assets/models] [--full-evaluation]
mochi2d-native render scenarios/ --out renders/ [--models assets/models] [--mask-size N] [--threads N]
```

Motion sync and voice profiles:

```
mochi2d-native motion-sync-trace voice.wav mouth.motionsync3.json [--setting "Mouth basic"] [--live] [--profile me.json]
mochi2d-native voice-profile A=a.wav I=i.wav U=u.wav E=e.wav O=o.wav Silence=room.wav --name me > me.json
mochi2d-native motion-sync-play model.model3.json --group Talk --index 0 [--seconds 8]
```

`run` takes Mochi2D's conformance scenarios (static `mochi2d-scenario/0`,
`mochi2d-sequence/0` and `mochi2d-anim-scenario/0`) and writes their results
in the same text layout, to be judged with Mochi2D's judge;
`--full-evaluation` evaluates every step from scratch. `render` draws static
scenarios (with their `render` block's size, background and view; 1024 ×
1024 without one) and writes `<id>.png` (premultiplied RGBA8) and
`<id>.render.json` (`mochi2d-render/0`), as Mochi2D's render runner does;
`--threads` draws with that many threads (0: the hardware's).
`motion-sync-trace` plays a WAV file through a setting frame by frame and
prints every analysis (element weights, level, voicing) and the values
written; `voice-profile` calibrates a voice from recordings;
`motion-sync-play` starts a settings motion entry as Mochi2D's runtime
does, with its linked sound, and prints the mouth parameters frame by frame.

## C API

`include/mochi2d.h`: load and validate models, create instances, set
parameters and part opacities, evaluate, read draw data (vertices, UVs,
indices, opacity, colors, masks, blend modes, draw and render orders), map
points through deformers, test hits; parse settings, motions, expressions,
physics, poses, sounds, user data and display info, or open a whole package
through a host file callback; and animate with the animator (motions, idle
playback with idle weights, expressions with fade times per call, look, lip sync from sounds or live
samples with the gate, gain and smoothing in the library, effects; physics
strength, wind (and per setting), the step rate and the hold of zero-length steps at runtime,
and the physics state saved and restored bit for bit); motion sync (files,
sounds with their playback clock, live input pushed from any thread, the
element weights and the level at every analysis, voice calibration and
profiles, a motion's linked sound started with it from a package), with tints
(up to 2, brightening toward white) and base values; draw with the reference renderer (textures, renderers, draws
into caller-owned images, with the instance's tints and an optional number
of threads; textures updated in place, as in every backend), plan frames for a GPU backend (the operations in drawing
order, as plain structs, the changed vertices in one buffer, the programs'
source, SPIR-V, MSL and HLSL), or draw with the OpenGL backend into the host's
framebuffer, the Vulkan or Metal backend into the host's command buffer, or
the Direct3D 11 backend through the host's context. Every object is created with an allocator of the host's
choosing (or malloc and free), which everything made from it inherits.
Engines draw with their own renderers, executing the frame plan; the
reference renderer is the yardstick for them.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and the
statement each contribution confirms, and [SECURITY.md](SECURITY.md) for
reporting vulnerabilities.

## License

MIT, see [LICENSE](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Patents

This project is licensed under the MIT License, which grants no patent rights. Reading some model files uses techniques, such as joining meshes ("glue") and blend shapes, that may be covered by third-party patents in some countries, including Japan and the United States. The project has taken no legal opinion on this, and makes no statement that any patent is or is not infringed. If you use or distribute it in such a country, above all commercially, check for yourself whether you need a license.

---

Live2D and Live2D Cubism are trademarks or registered trademarks of Live2D Inc. Mochi2D Native is an independent project. It is not affiliated with, endorsed by, sponsored by or supported by Live2D Inc., and it contains none of Live2D's code or files.

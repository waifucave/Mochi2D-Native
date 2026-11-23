# Changelog

Mochi2D Native's releases. Each one follows a Mochi2D release, the
project's web runtime and the behavioral reference: evaluation and the
framework are bit-exact with it, and the GPU backends follow its renderer.

## 0.10.0

The first published release of Mochi2D Native.

**What it is.** A C++17 runtime for models made with Live2D Cubism (a
`.moc3` file with its `.model3.json` and companion files), with a C API,
`mochi2d.h`, for applications and engine bindings. It:

- reads, validates and loads `.moc3` files of versions 1–6, and evaluates
  model instances (incrementally: only what changed is recomputed);
- runs the framework around them: model settings and whole model folders
  read through the host, motions with idle weights, expressions, physics,
  pose, eye blink, breath, look, lip sync from WAV sounds or live samples,
  motion sync, tints, user data, display info, hit tests and the frame
  procedure;
- draws them: a software renderer into memory you own, and GPU backends
  that draw with your OpenGL ES 3.0 or desktop OpenGL 3.3 context, Vulkan
  1.1 device, Metal device or Direct3D 11 device.

The library opens no file, window or device of its own: you hand it bytes,
decoded pixels and your graphics objects. It follows **Mochi2D 0.24.1**,
the project's web runtime: evaluation and the framework give Mochi2D's
results bit for bit on everything they have been compared on, and the
renderers draw as Mochi2D's does.

**The packages.** One per platform:

| Package | Platform |
| --- | --- |
| `mochi2d-native-0.10.0-linux-x64.tar.gz` | Linux x86-64, built on Ubuntu 24.04 |
| `mochi2d-native-0.10.0-linux-arm64.tar.gz` | Linux arm64, built on Ubuntu 24.04 |
| `mochi2d-native-0.10.0-macos-universal.tar.gz` | macOS 13.3 or later, arm64 and x86-64 |
| `mochi2d-native-0.10.0-windows-x64.zip` | Windows x64 (MSVC, the `/MD` runtime) |

Each holds the header, the shared and static libraries, a CMake package
config and the license texts. Unpack one, point `CMAKE_PREFIX_PATH` at it,
and in your project:

```cmake
find_package(mochi2d 0.10 CONFIG REQUIRED)
target_link_libraries(app PRIVATE mochi2d::mochi2d)  # or mochi2d::mochi2d_static
```

The README's "Install" section has a whole example.

**What is experimental.** `docs/api-stability.md` marks every function,
type and constant. Experimental, and so free to change in a minor release:

- the GPU layer: the frame plan, the shader programs and the four GPU
  backends (Metal has run only on the Apple Paravirtual device, Direct3D 11
  only on WARP);
- live motion sync: the analysis, live input, voice calibration and
  profiles, and the animator's motion sync (reading `.motionsync3.json`
  files is stable);
- the evaluation switches (`m2d_instance_options`).

Before 1.0, a minor release may also change the stable API; each change is
in this file.

**Known limits.**

- The libraries are not signed or notarized: the application that ships
  them signs them.
- macOS 13.3 or later, for `std::to_chars` of a double.
- Windows: the static libraries use the release DLL runtime (`/MD`).
- A crafted model can be slow to evaluate within its size: an application
  that opens models people hand it should cap their size
  (`m2d_package_limits`) and time the first frames (`SECURITY.md`).

**Reporting a problem.** Bugs: an issue in this repository. Vulnerabilities:
privately, through the repository's Security tab (`SECURITY.md`).

### Changes since 0.9.0

- **It follows Mochi2D 0.24.1.** Evaluation results and renders are
  unchanged, bit for bit.
- **Input someone else made** (Mochi2D 0.23.0–0.24.1's question: what is
  refused before memory or time is spent on it). `SECURITY.md` lists the
  bound for each input. New:
  - `M2D_LIMIT_ERROR`, "too large", apart from the format and file errors
    ("damaged or crafted");
  - a package reads within Mochi2D's file caps, 1 GiB a file and 2 GiB in
    all by default: `m2d_package_limits`, `m2d_package_open_with_limits`,
    and an optional `size` callback in `m2d_file_source`, which lets the
    library refuse a file before it is read;
  - a texture past a renderer's limit, or past `M2D_MAX_TEXTURE_SIDE`, is
    `M2D_LIMIT_ERROR` (it was `M2D_INVALID_ARGUMENT`, or
    `M2D_INTERNAL_ERROR` from a GPU backend);
  - a `.moc3` is checked in full before any of its arrays is allocated, and
    validation is bounded for files whose sections overlap; a validation
    report lists at most 10,000 diagnostics;
  - JSON files take about a fifth of the memory they did, and an object
    with many keys parses in O(n log n): one of 200,000 keys took 110 s and
    now takes 0.06 s;
  - the command line refuses files past 1 GiB, and reads a PNG's header
    before decoding it.
- **`m2d_motion_loop`:** a motion file's `Meta.Loop` (Mochi2D 0.22.0's
  `Motion.loop`).
- **The packages** no longer hold `api-stability.md` or stb_image's
  license (stb_image is in the command-line tool only).

`m2d_file_source` gains a last member: code that fills it member by member,
or zero-initializes it, needs no change.

## 0.9.0

It follows **Mochi2D 0.21.0**. Evaluation results and renders are
unchanged, bit for bit.

### Added

- **Evaluation switches** (experimental, as Mochi2D 0.21.0's
  `evaluation: { glue, blendShapes }`):
  - `m2d_instance_options` and `m2d_instance_create_with_options`, with
    `glue` and `blend_shapes` (and `incremental`), all on by default;
  - `glue = 0` skips the glue pass, so glued meshes keep their own
    positions;
  - `blend_shapes = 0` ignores every blend-shape keyform binding, as if the
    file had none.

  With both on, results are those of `m2d_instance_create`, bit for bit.
  A test checks each setting against Mochi2D's outputs and against the same
  model built without glue or blend shapes (`tests/fixtures/switches/`).

### Changed

- **Wording:**
  - the docs and comments describe what Mochi2D Native does;
  - the validation message for a keyform position run now reads "the
    official level tests keyform …", as Mochi2D 0.21.0's does;
  - the README has the "How it was made" paragraph, a "Patents" section and
    the trademark footer in their reviewed wording.
- **The `public-text` test** refuses two more kinds of wording (its
  header lists them), and checks the README's footer word for word.

## 0.8.0

It follows **Mochi2D 0.20.0**. One default changes; evaluation results and
renders are unchanged, bit for bit.

### Changed

- **The motion-sync file's per-parameter smoothing is off by default**, as
  in Mochi2D 0.20.0:
  - `m2d_motion_sync_options.file_smoothing` now defaults to 0, and 1
    applies the file's `Smooth` as before;
  - the analysis's own smoothing (the setting's `Smoothing`) and the
    file's dead band (`Damper`) are unchanged;
  - the command line's `motion-sync-trace` takes `--file-smoothing` (it
    had `--no-file-smoothing`).
- **Packages and `cmake --install`** also carry the license texts of the
  bundled third-party code, in `share/mochi2d/third_party/`: fdlibm's
  `LICENSE`, musl's `COPYRIGHT` and stb's `LICENSE`.
- **The macOS jobs** run on `macos-15`.

### Added

- **`SECURITY.md` and `CONTRIBUTING.md`.**
- **A public-text test** (`public-text`), which scans the tracked files for
  references to the project's private records.
- **The README:** how the project was made, and a trademark footer.
- **Workflows** run with read-only repository permissions where they need
  no more.

## 0.7.0

The first version with packages per platform (Linux x86-64 and arm64,
macOS universal, Windows x64); it was not published. It follows
**Mochi2D 0.18.0**.

### What the library does

- **Models:** `.moc3` files of versions 1–6, read, validated and written;
  instances evaluated incrementally (only what changed is recomputed, with
  the same results as a full evaluation).
- **Framework:** model settings and whole model folders read through the
  host; motions with idle weights, expressions, physics, pose, eye blink,
  breath, look, lip sync from WAV sounds or live samples, motion sync,
  tints, user data, display info, hit tests and the frame procedure.
- **Reference renderer:** a software rasterizer, on the calling thread or
  over worker threads, with the same bytes for any number of them.
- **GPU backends:** a frame plan (the renderer's decisions as a list of
  operations) and its execution in OpenGL ES 3.0 or desktop OpenGL 3.3,
  Vulkan 1.1, Metal and Direct3D 11. Each draws in the host's context,
  device or command buffer: the library makes none, links no graphics
  library and opens no window.
- **C API:** `mochi2d.h`, with per-object allocators. Each function, type
  and constant is marked stable or experimental in `api-stability.md`. The
  render plan, the shader texts, the GPU backends and live motion sync are
  experimental.

### Changes since 0.6.0

- **Mochi2D 0.18.0's render rules** (its `docs/rendering.md`), which fix
  the float32 order and rounding of four rendering operations:
  - V: textures sampled at v flipped twice in float32;
  - M: masks through float32 matrices composed in a fixed order;
  - L: layers composited by a linearly filtered quad;
  - I: a masked layer's mask through D = A · V⁻¹.

  All four are in every GPU backend, and V, M and I in the software
  renderer. On SwiftShader, against Mochi2D's own renders of the synthetic
  render scenarios:
  - the GL backend (through ANGLE) is pixel-identical in 60 of 60;
  - the Vulkan backend in 49 of 60, the rest within one level in at most
    23 pixels.
- **New in the C API:**
  - `m2d_render_plan_drawable_uvs`, the UVs as sampled;
  - `m2d_render_op.mask_matrix`;
  - the uniforms `uMaskTex` and `uMaskClip`, replacing `uMaskMap`,
    `uCenter`, `uHalfSize`, `uK` and `uUnturn`;
  - the Vulkan push-constant block is now 120 bytes.
- **Layers** in the Vulkan, Metal and Direct3D 11 backends now have the
  frame's size; they had kept the largest frame's.
- **Mochi2D 0.16.0's fuzz fixes:**
  - physics takes at most 10,000 steps a frame, and an infinite `Fps`
    steps once a frame;
  - a WAV of 0 bits per sample is refused;
  - motion-sync WAV files accept rates of 1–768 kHz only;
  - plus a regression test for a corrupt `.moc3` keyform count.

  A new fuzz target, `fuzz_model`, loads a whole model folder and steps it.
- **The shared library exports only `m2d_` symbols**, checked on every
  platform. The stability list is generated from the header and checked
  against it.
- **Packages:** shared and static libraries, the header, a CMake package
  config (`mochi2d::mochi2d`, `mochi2d::mochi2d_static`), `LICENSE` and
  `THIRD_PARTY_NOTICES.md`. A consumer project finds each package and runs
  a model before it is attached to the release.
- **Metal:** the shader libraries are compiled once per device, and vertex
  positions are uploaded by range.

### Known limits

- **Not signed or notarized:** the host signs what it ships.
- **macOS 13.3 or later**, for `std::to_chars` of a double.
- **Windows:** the static libraries use the release DLL runtime (`/MD`).
- **Tested devices:** Metal ran on the Apple Paravirtual device only, and
  Direct3D 11 on WARP only.

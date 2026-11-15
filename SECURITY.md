# Security

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private
vulnerability reporting: the **Security** tab of this repository, then
**Report a vulnerability**. Don't open a public issue for them.

**Include:**

- the version (`m2d_version()`, or the project version in `CMakeLists.txt`);
- the platform, the compiler, and the function, backend or tool involved;
- a file or steps that reproduce it.

Model files that are the maintainer's or a third party's may only be
shared under their terms; a minimal crafted file is best. You'll get an
answer within a week. A fix is released as a patch version, with credit in
`CHANGELOG.md` unless you would rather not.

## Supported versions

| Version | Security fixes |
| --- | --- |
| the latest minor release (0.9.x) | yes |
| earlier releases | no: upgrade (`CHANGELOG.md` lists what changed) |

From 1.0, the latest minor release of the current major version gets
fixes. `docs/api-stability.md` says which parts of the C API are stable.

## What Mochi2D Native touches

The library sends no telemetry and makes no network request. It opens no
file, window, device or socket of its own: it reads the bytes and files
the host hands it, and draws into the host's memory, context or device.

### Data it parses, which can be untrusted

- **The formats:**
  - `.moc3` model data;
  - the JSON files of a model: settings, physics, pose, expressions,
    motions, display information, user data and motion sync;
  - WAV audio;
  - PNG textures, in the command-line tool only (through stb_image; the
    library takes decoded pixels).
- **What to expect for a damaged file:** every reader returns a status and
  an error (`m2d_error`), never throws across the C API, and is built and
  tested without C++ exceptions. It may not crash, hang, read or write
  outside the buffers it was given, or use memory out of proportion to the
  input. Limits that keep it so are documented in `mochi2d.h` (for
  example at most 10,000 physics steps a frame, WAV rates of 1–768 kHz for
  motion sync, texture sides up to 32768).
- **How it is checked:** the readers are fuzzed with libFuzzer under
  AddressSanitizer and UndefinedBehaviorSanitizer (`fuzz/`: `fuzz_moc`,
  `fuzz_json`, `fuzz_anim`, and `fuzz_model` for a whole model folder);
  CI replays the committed corpora on every push and fuzzes each target
  briefly. The unit tests run under AddressSanitizer, UndefinedBehavior-
  Sanitizer and ThreadSanitizer in CI.
- **What counts as a vulnerability:** an input that breaks these
  guarantees, or that makes the library read or write outside what it was
  given.

### What the host hands it

- **A model folder** (`m2d_package_open`): the library asks the host's file
  callback for the names the settings file lists, resolved inside the
  folder: a `..` that would leave it is refused before the callback is
  asked, and a leading `/` or `\` is dropped, so the callback only ever
  sees paths within the folder. What a path names is up to the host's
  callback.
- **Live audio** (live lip sync, live motion sync): samples the host
  pushes, processed in memory and never stored or sent. The library opens
  no microphone.
- **GPU backends:** they draw with the host's OpenGL context, Vulkan
  device, Metal device or Direct3D 11 device, into the host's target. The
  shader programs are fixed text compiled with the library (or committed
  SPIR-V, MSL and HLSL); nothing from a model is compiled.
- **Threads:** only a software renderer created with `threads` other than 1
  starts threads (worker threads for its rows), and it stops them when it is
  destroyed.

### The tools

- **The command line (`mochi2d-native`):** it reads the files and folders
  it is given, and writes only the files and folders named by `--out`.
- **The test tools** (`mochi2d-gl-render`, `mochi2d-vk-render`,
  `mochi2d-mtl-render`, `mochi2d-d3d11-render`) are not part of the
  packages; they read the scenarios and models they are given and write
  under `--out`.

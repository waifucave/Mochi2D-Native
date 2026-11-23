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
| the latest minor release (0.10.x) | yes |
| earlier releases | no: upgrade (`CHANGELOG.md` lists what changed) |

From 1.0, the latest minor release of the current major version gets
fixes. `docs/api-stability.md` says which parts of the C API are stable.

## What Mochi2D Native touches

The library sends no telemetry and makes no network request. It opens no
file, window, device or socket of its own: it reads the bytes and files
the host hands it, and draws into the host's memory, context or device.

### Data it parses, which can be untrusted

The library reads only the bytes and pixels the host hands it. Every reader
returns a status and an error (`m2d_error`), never throws across the C API,
and is built and tested without C++ exceptions. Two statuses tell a host why
a file was refused:

- **`M2D_LIMIT_ERROR`, "too large":** a file, or what it declares, passes a
  cap. Nothing past the cap was read or decoded.
- **`M2D_FORMAT_ERROR` (`.moc3`) and `M2D_FILE_ERROR` (the other files),
  "damaged or crafted":** the data does not hold what it declares.

What bounds each input's memory and time, before the cost is paid:

| Input | Read by | Memory | Time |
| --- | --- | --- | --- |
| `.moc3` (`m2d_model_load`, `m2d_validate_moc`) | the library | Loading and evaluating: about 5 times the file at most. Validation: the file's arrays, at most 4 file lengths, plus a report of at most 10,000 diagnostics (about 20 MB) | Loading is linear in the file. A frame's evaluation grows with the model's vertices and the depth of their deformers, as in Mochi2D |
| JSON: settings, motions, expressions, physics, pose, display info, user data, motion sync | the library | About 32 times the text at most; nesting at most 1,000 deep | O(n log n): repeated keys are merged by sorting |
| WAV (`m2d_sound_decode`, motion sync's decoder) | the library | 8 times the samples there are at most (8-bit samples as doubles), plus a few bytes for each channel the header declares (at most 1.6 MB for 65,535) and motion sync's fixed tables (under 256 KB) | Linear |
| Textures | the host decodes them; the library takes RGBA8 pixels (`m2d_texture_create`) | 4/3 of the pixels (the mip chain) | Linear |
| A package's files (`m2d_package_open`) | the host's `m2d_file_source` reads them | Each file once; by default at most 1 GiB a file and 2 GiB in all (`m2d_package_limits`) | — |
| Physics state (`m2d_animator_restore_physics_state`) | the library | The size it declares must equal the bytes given | Linear |

How a crafted file is refused before its cost (the `unit` test
`crafted_inputs_refused_before_their_cost` checks each with a counting
allocator):

- **`.moc3`:** every count, offset and name is checked against the file
  before any array is allocated. A file whose counts declare 2³¹ − 1 of
  everything is refused (`section-bounds`) having allocated under 16 KB.
  Sections that overlap are refused by the loader (`slot-order`); validation
  reads them as Mochi2D does, up to 4 file lengths, so that one region
  cannot count many times. Past 10,000 diagnostics a report counts the rest
  and ends with a `diagnostics-truncated` warning.
- **JSON:** no reader allocates from a count a file declares (a motion's
  `Meta.CurveCount` of 2·10⁹ costs nothing). An object of 200,000 keys
  parses in well under a second.
- **WAV:** the data chunk's declared size is clamped to the bytes there
  are: a 44-byte file declaring 4 GiB of samples decodes to none.
- **Textures:** a side above 32,768 (`M2D_MAX_TEXTURE_SIDE`) is
  `M2D_LIMIT_ERROR` from the sizes alone, before a pixel is read; the
  renderers refuse textures above their own limit the same way (8,192 for
  the software renderer, the device's for a GPU backend). The library trusts
  the pixels to be the size it is told: the host decodes, so the host caps
  the decoding (below).
- **A package:** a file past a cap is `M2D_LIMIT_ERROR` (code `file-limit`)
  for the settings file or the `.moc3`, and a warning for a companion.
  With the source's `size` callback the cap is checked before the host
  reads the file; without it, after the read and before the library copies
  the bytes.

**What a host that opens models people hand it should do:**

- pass `m2d_package_limits` that fit the models it expects (Mochi2D suggests
  128 MiB a file and 512 MiB in all), and give its `m2d_file_source` a
  `size` callback;
- read each image's declared size from its header and refuse one past its
  caps before decoding it (Mochi2D's defaults: 16,384 on a side, 2²⁸ pixels
  a texture, 2³⁰ for a model's textures together);
- treat `M2D_LIMIT_ERROR` as "too large" and the format and file errors as
  "damaged or not a model";
- time the first frames of a model it has not seen, if frame time matters:
  a crafted model can be slow to evaluate within its size.

**How it is checked:** the readers are fuzzed with libFuzzer under
AddressSanitizer and UndefinedBehaviorSanitizer (`fuzz/`: `fuzz_moc`,
`fuzz_json`, `fuzz_anim`, and `fuzz_model` for a whole model folder); CI
replays the committed corpora on every push and fuzzes each target
briefly. The unit tests run under AddressSanitizer, UndefinedBehavior-
Sanitizer and ThreadSanitizer in CI.

**What counts as a vulnerability:** an input that breaks these bounds, that
makes the library crash or hang, or that makes it read or write outside
what it was given.

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
  it is given, and writes only the files and folders named by `--out`. It
  refuses a file past 1 GiB from its size, before reading it
  (`FileLimitError`). It decodes PNG textures with stb_image, which only
  the tool links: the libraries contain no image decoder. Before stb_image
  sees a PNG, the tool reads its header and refuses a file too short for
  the size it declares (`TextureFormatError`) and one past Mochi2D's
  texture caps (`TextureLimitError`: 16,384 on a side, 2²⁸ pixels, 2³⁰ for
  a model's textures).
- **The test tools** (`mochi2d-gl-render`, `mochi2d-vk-render`,
  `mochi2d-mtl-render`, `mochi2d-d3d11-render`) are not part of the
  packages; they read the scenarios and models they are given and write
  under `--out`.

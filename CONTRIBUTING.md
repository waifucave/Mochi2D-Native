# Contributing

Thank you for helping with Mochi2D Native. This page covers how to build and
test it, and what a contribution has to come with.

## Build and test

Mochi2D Native needs CMake 3.16 or later and a C++17 compiler (GCC, Clang or
MSVC).

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

**What runs without more tools:** the unit tests (`unit`), the committed
fixtures against the reference's results (`fixtures`, `render-fixtures`),
the fuzz corpora's replays, and the C API's stability list and exports
(`api-list`, `api-exports`, with Python 3), and the public-text check
(`public-text`).

**What needs more, and is skipped without it** (the README's "Build"
section says how to set each up):

- **The cross-checks** run Mochi2D itself beside Mochi2D Native and compare
  results byte for byte: Node 20 or later, and
  `npm ci --prefix reference/mochi2d-0.24.1`. The render checks also need
  Playwright and its Chromium.
- **The GPU backends' tests:** EGL (Mesa) for OpenGL, the Vulkan headers and
  SwiftShader or lavapipe for Vulkan, ANGLE (`tests/gl/build_angle.sh`) for
  OpenGL over SwiftShader; Metal on macOS and Direct3D 11 (WARP) on Windows.
- **`libm32`:** `musl-gcc`.
- **The GPU programs' generated files** (`gpu-shaders`, `vk-spirv`):
  glslangValidator and spirv-cross.

**Fuzzing** needs Clang with libFuzzer: see the README.

**Tests that use DeepSeek-chan** run by hand, where the model is in the
reference's `assets/models/`. Commit no model files: tests build their models
with the project's own builders (`tests/support/tiny_model.hpp`, the
reference's synthetic models), and `assets/models/` is ignored by git.

**What a change should come with:**

- **Code:** a test that fails without the change.
- **The C API:** its documentation in `include/mochi2d.h`, and the
  stability list regenerated (`python3 tests/api/api_list.py`), with the new
  name's mark in `tests/api/marks.txt` if it is not stable.
- **Evaluation or rendering:** results stay bit-exact with the reference;
  regenerate the fixtures with `tests/fixtures/make.sh <build dir>` and say
  in the pull request which results or renders changed and why.
- **The GPU programs:** `tests/vk/make_spirv.sh` and
  `tests/gpu/make_shaders.sh` regenerate the committed SPIR-V, MSL and HLSL.
- **`CHANGELOG.md`:** an entry under the next version.

`tests/api/public_text.py` keeps the public files free of references to
private records. If it flags a line, state the rule or the fact itself.

## Making a release

Only people with write access to the repository can start a workflow by
hand, so only they can make a release. With the version in `CMakeLists.txt`
and its section in `CHANGELOG.md` on `main`:

1. Open the repository's **Actions** tab.
2. Choose the **Release** workflow.
3. Click **Run workflow** on `main`, check **release**, and run it.

The run builds the four packages, runs the Platforms checks, and at the
end creates the release `v<version>` and its tag at that commit: as a draft
with the four files, checked, then published, which is when the tag comes
into being. Its first job, the gate, stops it before anything is built if
the tag or the release exists already, if the run is not on `main`, or if
the changelog has no section for the version; the same checks run again
right before the release is made. A run that fails leaves at most a draft
(no tag), which the next run replaces.

Run without **release**, the workflow builds and checks everything and
prints the release it would make, without making it (also when started
from a tag). Pushing a tag `v<version>` by hand, lightweight or annotated,
starts the same path; the release then uses that tag. The release is titled
"Mochi2D Native <version>", without the tag's "v".

To try a change to the release path without making a release, run the
workflow with **rehearsal** checked instead (in a private repository only;
the gate refuses it in a public one, and with **release** at the same
time). It makes every call a release by hand makes, to the end, with a
throwaway tag `rehearsal-<run number>` and a pre-release titled REHEARSAL,
then deletes both and checks that nothing of that name is left. It never
creates, replaces or deletes `v<version>` or its release. A rehearsal that
cannot remove what it made fails, and says what is left.

## The clean-room rule

Mochi2D Native is written from scratch, through the process in
[CLEANROOM.md](CLEANROOM.md). A contribution may not draw on Live2D's own
code or documentation, or on other implementations of the format.

Each pull request confirms, in its description:

> I have not viewed, decompiled or copied Live2D's SDK, Cubism Core,
> Framework, sample code or manuals, or third-party `.moc3`
> implementations, for this contribution.

**What you may use:**

- the model files themselves (`.moc3`, JSON, textures, audio), within
  their terms;
- Mochi2D, the reference in `reference/`, and this repository's docs;
- general programming, graphics and math knowledge, and libraries unrelated
  to Live2D under permissive licenses (listed in `THIRD_PARTY_NOTICES.md`).

**If you're unsure** whether a source is allowed, ask in an issue before
you use it.

## Sign-off (DCO)

Every commit is signed off under the
[Developer Certificate of Origin](https://developercertificate.org/): by
adding the line

```
Signed-off-by: Your Name <you@example.com>
```

you certify that you wrote the change, or have the right to submit it,
under the project's license. `git commit -s` adds the line. A pull request
whose commits aren't signed off can't be merged.

## License

Contributions are licensed under the [MIT License](LICENSE), as the rest of
Mochi2D Native is.

# Fixtures

Synthetic test data with the reference's results, so that every build checks
bit-exactness with Mochi2D, including builds without Node (CI's
no-exceptions, sanitizer and ThreadSanitizer jobs, and other platforms).

- `models/`: six synthetic models, one per `.moc3` file version (1–6), built
  from seeded random choices with Mochi2D's own test builder
  (`reference/mochi2d-0.24.1/test/support/synth.ts`). Each folder has the
  model's settings file and, for the animation scenarios, settings variants,
  motions, expressions, physics and pose files, and short WAV sounds, written
  by `tests/crosscheck/anim.ts` (with the reference catalog's motion and WAV
  writers). Some of these files are broken on purpose: motions with wrong
  counts or segments, physics files with wrong totals, without vertices or
  with a fractional vertex index, malformed and unsupported WAVs.
- `models/bitexact-*` and their scenarios: the models of Mochi2D 0.14.0's
  `test/bit-exact-vectors.test.ts` (the float32 rules: a warp inside a
  rotation, ancestor opacities from a part tree and from deformers,
  repeating parameters, glue in a chain and as a target, a constraint's
  weight), built with the same calls by `tests/crosscheck/bit_exact.ts`,
  which first checks that Mochi2D gives every value that test prints. The
  warp mapping's own table is the unit test
  `warp_mapping_bit_exact_vectors`.
- `scenarios/`: static (`mochi2d-scenario/0`), sequence
  (`mochi2d-sequence/0`) and animation (`mochi2d-anim-scenario/0`) scenarios
  on these models, and malformed sequence and animation scenarios, one per
  `InvalidScenario` rule of the reference's parser.
- `expected/`: the results of the reference's conformance tool
  (Mochi2D 0.24.1, the current reference) for every scenario. Their
  `producer` line is the reference's released version (`mochi2d@0.24.1`, from
  its `package.json`): its tool would name the commit of the checkout it
  runs in, and `make.sh` replaces that.
- `render/`: six synthetic textured models (versions 1–6, PNG textures of
  power-of-two and other sizes, masks, blend codes, offscreens) and four
  render scenarios on each, made by `tests/crosscheck/render.ts`, with
  `expected.sha256`, the SHA-256 of `mochi2d-native render`'s PNG of each
  (Mochi2D Native's own renders on Linux: the renderer is not bit-exact with
  Mochi2D's, so these check thread counts and platforms, while the render
  cross-check measures it against Mochi2D's renders).
- `switches/`: the model of Mochi2D 0.21.0's evaluation-switch test (two
  meshes glued, blend shapes on a mesh, the glue and the part), built with
  Mochi2D's own test builder, the same model without its glue, without its
  blend shapes and without either, and Mochi2D's outputs of the full model
  at the test's poses with each setting of the switches (`expected.json`),
  written by `tests/crosscheck/switches.ts`.
- `libm32.txt`: digests of musl's own build of atanf, sinf and cosf on every
  61st float32 input and of atan2f on 16.8 million pairs, as
  `tests/crosscheck/libm32.sh` writes them with `musl-gcc` (Ubuntu's musl
  1.2.4); the vendored files must give the same.

No model data of any third party is involved, and nothing comes from a test
model or is derived from one.

## How they are made

```sh
npm ci --prefix reference/mochi2d-0.24.1
tests/fixtures/make.sh
```

`make.sh` runs the cross-check's generator
(`tests/crosscheck/generate.ts`) with
`--models 6 --mutations 0 --anims 2 --sound-scale 0.12 --scenarios-only`, then
the reference's conformance tool on the scenarios; then the render check's
generator (`tests/crosscheck/render.ts --models 6 --seed 7 --no-reference`)
and, given a build folder (`tests/fixtures/make.sh build`), hashes that
build's renders. The generators are seeded: running them again gives the
same files unless a generator or the reference changes. The fixtures are
regenerated when the reference changes. `libm32.txt` is
`<build>/libm32/musl.txt` after `tests/crosscheck/libm32.sh <build> 61`.

## How they are used

Four ctest tests, the unit tests and portable CMake scripts, so they run
everywhere:

- `unit` (`evaluation_switches_0_21_0`) evaluates `switches/` with each
  setting of the switches, through the C++ instance and the C API, and
  requires Mochi2D's values and the reduced models' outputs bit for bit.
- `fixtures` (`compare.cmake`) runs `mochi2d-native run` on `scenarios/` and
  requires every result to be byte-identical to the one in `expected/`, the
  `producer` line aside.
- `render-fixtures` (`render_compare.cmake`) renders `render/` with one
  thread and with four, and requires every PNG to have the same SHA-256 with
  both and as committed.
- `libm32-fixture` (`libm32_compare.cmake`) runs the vendored functions as
  this compiler builds them (`mochi2d_libm32_dump`) and requires
  `libm32.txt`'s digests.

Where they run: every CI job on Linux (GCC and Clang, ASan + UBSan,
ThreadSanitizer, without exceptions and threads) runs all three; the
Platforms workflow (`platforms.yml`: macOS 15 on ARM64 with Apple Clang, and
Windows 2022 with MSVC; started by hand and on version tags) runs them as
its own steps. Node, the reference and `musl-gcc` are needed only on Linux,
for the cross-checks themselves.

About 3.6 MB in all.

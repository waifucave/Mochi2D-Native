# Architecture

Mochi2D reads Live2D Cubism model files (`*.model3.json`, `.moc3`, motions,
expressions, physics, pose), animates and evaluates them in TypeScript, and
draws them with WebGL2. It was written through a clean-room process (see
`CLEANROOM.md`).

## Layers

```
            ┌──────────────── src/viewer ────────────────┐   ┌─ examples/ ─┐
            │ the viewer app: menus, resources, settings │   │ embed, node │
            └─────────────────────┬──────────────────────┘   └──────┬──────┘
                                  │                                  │
   ┌────────────────────────── src/lib (browser) ───────────────────┴────────┐
   │ MochiView, MochiModel (public API) · LiveModel (runtime + renderer +  │
   │ view) · Stage (canvas, loop, clock, context loss) · gestures · texture  │
   │ budgets · model inputs · speech · entry points index/headless/node      │
   └───────┬─────────────────────────────┬───────────────────────────────────┘
           │                             │
   ┌───────▼────────┐   ┌────────────────▼──────────────── pure TypeScript ───┐
   │ src/render     │   │ src/runtime: ModelRuntime (load a bundle, motions   │
   │ WebGL2: exact  │   │ by name, change tracking, hit tests)                │
   │ textures, the  │   │ src/anim: settings and animation files, the frame   │
   │ model renderer │   │ procedure (motions, expressions, physics, pose,     │
   │ (direct and    │   │ eye blink, breath, look, lip sync)                  │
   │ layered),      │   │ src/core: .moc3 reading and validation, float32     │
   │ masks          │   │ evaluation (WebAssembly kernels with a JS fallback), │
   └───────┬────────┘   │ file sources, framing and compositing formulas      │
           │            └──────────────────────────────────────────────────────┘
   ┌───────▼────────┐
   │ src/platform   │ browser file sources (folders, drops, zips, URLs),
   │                │ audio input and the live microphone tap, PNG
   │                │ encoding; Node file sources, Node PNG encoding,
   │                │ headless Chromium through Playwright
   └────────────────┘
```

- **`src/core`** reads and validates `.moc3` files (versions 1–6, either byte
  order) and evaluates a model for given parameter values and part
  opacities. Evaluation is in float32, with bulk loops as WebAssembly
  kernels that produce bit-identical results to the JavaScript fallback.
  Keyforms are interpolated as a float32 weighted sum over the corners of
  the bindings that are off their keys, each parameter with its own key
  tolerance (10^−d, d its decimal places). Draw orders are then truncated
  with a fixed tolerance of 0.001. In version 5 and later, the own values
  of blend-shape targets are clamped once, after their blend shapes:
  opacity and colors to [0, 1], draw orders to [0, 1000], a rotation's scale
  and keyform angle to [10⁻⁴, 100] and [−3600, 3600], glue intensity to
  [0, 1]. Rotations under another deformer take their angle from two
  mapped probe points, through float32 arctangent, sine and cosine ported
  from musl (`src/core/math/libm32.ts`), so long rotation chains come out
  as the official runtime's. The instance also maps points through any
  deformer's world form, with the Jacobian (`mapPoints`, `mapJacobians`).
- **`src/anim`** parses the settings and animation files and runs the frame
  procedure: restore, motions, save, then eye blink, expressions, look,
  breath, physics, lip sync, motion sync and pose. It works on parameter
  values and part opacities only. `src/anim/motion-sync/` holds motion
  sync: the `.motionsync3.json` reader (`file.ts`), the per-parameter
  filter and the analysis tick (`parameter-filter.ts`), Mochi2D's own audio
  analysis and voice calibration (`analysis.ts`), the engine steps and the
  driver that binds sounds and live inputs to settings (`driver.ts`), a WAV
  decoder (`wav.ts`) and a vowel synthesizer for the neutral templates
  (`voice-synth.ts`).
- **`src/runtime`** ties core and anim together for applications.
  `ModelRuntime` loads a model's files from any `FileSource`, starts
  motions by group or file and expressions by name, and evaluates a frame
  only when a value changed. It also hit-tests in model units. It is the
  headless API.
- **`src/render`** turns textures into exactly premultiplied textures with
  mip chains built on the GPU by Mochi2D's own integer rule, for every
  texture size. It draws evaluated drawables with the direct pipeline, or
  with the layered pipeline for models with offscreen layers, and builds
  clipping masks per drawable (as in reference renders) or in a shared
  atlas. Items are composited into the main model's pass at places in its
  render order.
- **`src/lib`** is the browser runtime. `LiveModel` combines a runtime, the
  renderer and the textures under a movable view. `Stage` is the canvas and
  its render loop. `MochiView` and `MochiModel` are the public API on top.
  The viewer uses the same pieces.
- **`src/core`, `src/anim` and `src/runtime` are pure TypeScript**: no DOM
  and no Node APIs (`npm run typecheck` checks this). They run in browsers,
  workers and Node alike.

## A frame

1. `Stage` measures the time since the last frame and advances the clock
   (paused, stepped or scaled).
2. `LiveModel.update(dt)` runs `ModelRuntime.animate(dt)`, the frame
   procedure. If a parameter value or part opacity changed, the runtime
   evaluates the model, and the renderer uploads the vertices of drawables
   whose vertices changed.
3. If nothing changed and the view is the same, the frame is skipped and the
   canvas keeps the last image. Otherwise the stage clears the canvas and the
   renderer draws, building clipping masks first.

## Reference behavior and conveniences

Reference renders (`npm run render`, the conformance tools) follow the
reference configuration exactly. They use the per-drawable masks at 4096 (256 for
offscreens), rasterize every mask mesh, never downscale textures, give each
scenario a fresh model instance, write premultiplied PNGs, and are checked
by golden hashes (`npm run golden -- --check` and `--renders --check`).

Interactive use adds conveniences, each visible or documented and each
switchable on its own (docs/api.md, "Conveniences and their defaults"):

- the mask atlas, and only active mask meshes in masks;
- texture budgets with a visible notice;
- look through physics inputs;
- the lip-sync fallback parameter;
- lip sync from non-WAV formats in the library;
- lip sync from live audio (the microphone or a `MediaStream`): the 3s.2
  measure on the samples since the previous frame, with a noise gate, a gain
  and smoothing (`src/anim/live-lip-sync.ts`; the browser tap and its
  lifecycle in `src/platform/live-audio.ts`). It runs only when started;
- motion sync, whose analysis is Mochi2D's own method;
- clearing the motion priority on stop.

Files whose keyform draw orders lie outside their draw-order group's range
load everywhere, as in the official runtime, with a warning; drawables are
sorted by their evaluated draw order. The strict mode that rejects them
(`strictDrawOrders`, `--strict-draw-orders`) is opt-in.

## Evaluation speed

`npm run bench -- --kernels all` times `ModelInstance.evaluate()` on
DeepSeek-chan (509 parameters, 723 warps) over 300 seeded poses in each
kernel mode:

- `wasm`: the WebAssembly kernels with their 4-lane (SIMD) loops, used
  wherever WebAssembly with SIMD is available;
- `wasm-scalar`: the same kernels without the 4-lane loops, for comparison;
- `js`: the JavaScript fallback.

All three give the same bits. Milliseconds per evaluation in Node on the
development container, the median of three alternating runs of each build
(mean / median of 300 poses). The container is shared, so differences
under about 10 % are noise:

| Kernels | Poses | 0.13.0 | 0.14.0 | 0.15.0 |
| --- | --- | --- | --- | --- |
| wasm | random, all parameters | 5.78 / 5.49 | 6.30 / 5.76 | 6.42 / 5.76 |
| wasm | random, some parameters | 5.39 / 5.13 | 5.64 / 5.36 | 4.99 / 4.83 |
| wasm | typical | 5.19 / 4.75 | 5.28 / 4.94 | 5.45 / 4.88 |
| wasm-scalar | random, all parameters | 9.96 / 9.04 | 10.60 / 9.68 | 11.97 / 11.60 |
| wasm-scalar | random, some parameters | 9.17 / 8.77 | 9.91 / 9.41 | 9.26 / 8.93 |
| wasm-scalar | typical | 9.46 / 8.54 | 9.36 / 8.57 | 9.29 / 8.63 |
| js | random, all parameters | 20.19 / 18.00 | 24.61 / 22.15 | 20.89 / 18.50 |
| js | random, some parameters | 18.35 / 16.95 | 23.91 / 21.56 | 17.59 / 16.88 |
| js | typical | 19.23 / 16.91 | 23.94 / 20.90 | 17.89 / 16.32 |

0.14.0 fixed evaluation's float32 order of operations. Its warp mapping multiplies each corner value before the row weight, which
costs a few more multiplications per point.

- **WebAssembly:** the 4-lane kernels absorb this.
- **Scalar WebAssembly:** about 6 % slower at its fastest poses (8.5
  against 8.0 ms; the 11.97 ms in the table did not repeat in three more
  runs, 9.9–11.4 ms against 9.4–10.8 ms for 0.13.0).
- **JavaScript:** 0.14.0 was about 25 % slower, from calling a shared
  function for every point inside a grid and computing the far region's
  affine map anew for each band corner. 0.15.0 inlines the inside path
  again and computes the affine map once per grid, which brings it back to
  0.13.0's speed.

Most of the time goes to deformers: about 70 % in JavaScript, where
DeepSeek-chan's warps map their child grids through their parents, about
6,000 of those points per evaluation falling outside the parent grid.

## Package size

`npm run size` bundles each entry point as the build does, minified, and
gzips it (level 9). For 0.21.0, without license comments or source maps:

| Entry point | Minified | Gzipped | Modules |
| --- | --: | --: | --: |
| `mochi2d` | 376.2 KiB | 122.4 KiB | 101 |
| `mochi2d/headless` | 257.3 KiB | 84.7 KiB | 60 |
| `mochi2d/node` | 267.0 KiB | 88.8 KiB | 65 |
| `mochi2d/pixi` (PixiJS not included) | 385.4 KiB | 125.1 KiB | 102 |

An app's bundler keeps only what it imports (the package has no side
effects):

| Import | Minified | Gzipped | Modules |
| --- | --: | --: | --: |
| `{ MochiView }` from `mochi2d` | 367.5 KiB | 119.4 KiB | 100 |
| `{ ModelRuntime }` from `mochi2d/headless` | 210.1 KiB | 67.5 KiB | 46 |
| `{ MochiSprite }` from `mochi2d/pixi` | 328.9 KiB | 106.4 KiB | 85 |

About a third of every bundle is the evaluator and the model data; the two
WebAssembly kernel modules are in it as bytes. `test/package-size.test.ts`
checks what each entry point pulls in:

- `mochi2d/headless` only the core, animation, runtime and conformance
  modules and fflate: no WebGL, DOM or Node code, and none of their
  globals in the bundle;
- `mochi2d/node` only Node modules on top of that;
- `mochi2d` and `mochi2d/pixi` neither the viewer (`src/viewer/`) nor
  PixiJS, and `MochiSprite` alone not `MochiView`, its stage or items;
- each entry point within a gzipped ceiling about 15 % above these sizes.

## Fuzzing the loaders

`tools/lib/fuzz.ts` feeds mutated inputs to every loader: `.moc3` bytes
(read, validated, written again, loaded and evaluated), each JSON file the
library reads, zips, WAV files, and whole synthetic models through
`ModelRuntime.load`. The seeds are synthetic models and hand-written
files. A loader may throw only its documented errors; anything else, an
input slower than the time limit, or memory out of proportion to the input
is a failure.

- `test/fuzz.test.ts`: a short pass per target, and the inputs the long
  runs found, as regression tests.
- `npm run fuzz -- [--iterations N] [--target moc3,zip,…]`: the long run,
  each target in a child process under a watchdog; failing inputs go to
  `out/fuzz/`.

## Conformance tools

`tools/` holds the Node command-line tools (bundled to `dist/tools/`):

- `tools/lib/catalog/` generates the test catalog (crafted
  model and animation files, the 827 scenarios) from DeepSeek-chan's files;
  tests serve the same crafts from memory (`virtual.ts`);
- `tools/lib/conformance-runner.ts` and `tools/lib/formats.ts` run static,
  sequence and animation scenarios and write their result formats;
- `tools/lib/render-runner.ts` drives the render harness (`src/harness`) in
  headless Chromium; the library's `NodeRenderer` (`src/lib/node-render.ts`)
  drives the same harness for apps, with its own small local server, and the
  harness's `fast` request (downscaled textures, mask atlas) for previews;
- `tools/lib/judge.ts` and `tools/lib/judge-run.ts` apply the final rules
  (4h, 4l, 4m) to two result folders.

How to run a round: docs/conformance.md.

## Model data and results

- `src/core/moc/data.ts` defines `MocData`, the public model-data type, and
  `MOC_DATA_LAYOUT`, which maps each of its arrays to its slot in the schema
  (`schema.ts`). `io.ts` reads it (`readMoc`, on the section reader
  `read.ts` in lenient mode) and writes it (`writeMoc`, in the layout of
  genuine files, refusing data that fails the `official` level).
  `validate.ts` checks it at two levels (`validateMoc`) with the structural
  checks of `structure.ts`, which `writeMoc` shares, and the loader
  (`model.ts`) as the final check of the strict level. The test writer
  `write.ts` stays for crafted files.
- `src/conformance/` holds the scenario formats and runners that
  `npm run conformance` and the library's `scenarioResult` share: static,
  sequence and animation scenarios and their results. The model comes from
  a `ScenarioModels` loader: the CLI's disk cache, or one given model.

## Agent interface

`tools/lib/agent/` holds the operations that AI agents use
([agent-api.md](agent-api.md)), shared by the MCP server
(`tools/mochi2d-mcp.ts`, on the official MCP TypeScript SDK) and the
`mochi2d` command line (`tools/mochi2d.ts`):

- `session.ts`: one `ModelRuntime` with seeded randomness, and the
  operations on it (describe, parameters, part opacities, expressions,
  motions, time, hit tests, `.moc3` validation);
- `paths.ts`: the allowed folders, checked on real paths after following
  links, and a folder source that reads nothing outside them;
- `render.ts`: renders through the render harness in an offline headless
  Chromium that the session opens once, with a local server that serves only
  the loaded model's files.

## Tests

`npm test` runs unit tests and headless-Chromium tests:

- format and evaluation checks against DeepSeek-chan and crafted models
  built at test time;
- the animation test vectors;
- render hash checks;
- the viewer on desktop and emulated phones;
- the library through the embed example;
- the built package and the static build.

Browser tests need `npm run build` and the environment's Playwright with
Chromium; they are skipped without them.

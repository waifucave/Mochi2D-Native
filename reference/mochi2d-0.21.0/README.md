# Mochi2D

Mochi2D — an open-source runtime for models made with Live2D Cubism.

Mochi2D reads the model files that Live2D Cubism exports: `.moc3` with
`model3.json`, motions, expressions, physics, pose and the rest. It is a
from-scratch TypeScript runtime and WebGL renderer.

**How it was made.** Most of this code was written by AI coding agents
(Anthropic's Claude) under the direction of the project's maintainer,
through the clean-room process in [CLEANROOM.md](CLEANROOM.md). Copyright
may not subsist in every part of it. To the extent it does, it is licensed
under the MIT License. Either way, it is provided as is, without warranty.
Third-party code keeps its own licenses
([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

Models come with their own terms of use: follow the terms of every model you
use with Mochi2D.

Mochi2D is released under the [MIT License](LICENSE). The third-party code in
its builds is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Status

**0.19.0 is a 1.0 candidate:** the API is marked stable or experimental
export by export ([docs/api-stability.md](docs/api-stability.md)), and
[docs/versioning.md](docs/versioning.md) says what each release may change.
Coming from an earlier 0.x, see [docs/migration.md](docs/migration.md).
In the project's own tests on its conformance catalog, Mochi2D's evaluation
results are bit-identical with those of Live2D's Cubism SDK runtime ("the
official runtime" in these docs), and its reference renders are
pixel-identical ([docs/conformance.md](docs/conformance.md)). These are
test results, not a certification by anyone.

Mochi2D covers `.moc3` files of versions 1–6,
evaluation, the direct and layered render pipelines (offscreens, advanced
blends, masks), animation (motions, expressions, physics, pose, eye blink,
breath, look, lip sync), a library API and a viewer. The library and the
viewer also place items over a model (further models, which can be pinned to
it, drawn in front, behind or between its art meshes), move a model's mouth
with the microphone (live lip sync, processed in
memory only), run motion sync (`.motionsync3.json`: the mouth follows a
sound or live audio through Mochi2D's own analysis, so its mouth shapes are its own; see
[docs/api.md](docs/api.md#motion-sync)), and open zip archives whose file names use Chinese, Japanese
or Korean code pages. AI agents can drive models through an MCP server and a
headless command line ([docs/agent-api.md](docs/agent-api.md)). The viewer
shows a resource tree and the selected file's settings beside the model, with
tools for checking a model: a model-file inspector, a comparison of two model
files, motion-curve graphs, a motion-sync preview, and event, frame-rate and
physics displays. It also edits a model's motion settings, expressions and
pose, makes new expressions, and exports them
([docs/viewer.md](docs/viewer.md)). In PixiJS v8 scenes, a model is a
display object (`mochi2d/pixi`).

**Conformance.** In the project's first full judgment, Mochi2D's results
were compared with the official runtime's on the project's test
catalog: 807 scenarios, generated from DeepSeek-chan by `npm run catalog`
and run with Mochi2D's own tools, then checked again. The catalog now has 827 scenarios
(20 more validation cases), and 0.3.0 corrected the evaluation arithmetic,
which moved its results by at most 2·10⁻⁶ (vertices), 7·10⁻⁷ (opacity and
colors) and RMS 0.04 (renders). The table gives that first judgment:

| Kind | Result | Largest difference (tolerance) |
| --- | --- | --- |
| static evaluation | 604/604 pass | vertices 6.5·10⁻⁶ (2·10⁻⁵); opacity and colors 6·10⁻⁷ (10⁻⁵) |
| file validation | 41/41 as required | — |
| sequences | 4/4 (32 states) | vertices 2.7·10⁻⁶ |
| renders | 54/54 pass, no advisory | RMS 0.057 (1.0) |
| animation | 104/104 pass, 93 bit-exact | parameters 4.8·10⁻¹⁷ |

Two deliberate differences from the official runtime, both documented in
[docs/api.md](docs/api.md): correctly byte-swapped big-endian files load
(the official consistency check rejects them), and files whose draw orders
lie outside their group's range load with a warning and draw in the order of
their evaluated draw orders. Interactive conveniences, such as the mask atlas
and texture budgets, can each be switched off.

## Quick start

Requires Node ≥ 20 and a browser with WebGL2.

**Run the viewer.**

```sh
npm ci
npm run dev
```

Then open http://localhost:5173/. Models in `assets/models/` (for example
DeepSeek-chan, see [Test models](#test-models)) appear in **File › Models…**.
Open any other model with **File › Open folder…**, **Open zip…** or a URL,
or drop it on the page. On a phone, serve the viewer to your network
(`npm run build && npm run viewer -- --host 0.0.0.0`), or build a static copy
for any web server (`npm run build:static`). Then open a model as a `.zip`
from the Files app. See [docs/viewer.md](docs/viewer.md).

**Embed a model in a page.** Build the library, which writes
`dist/lib/mochi2d.js` (and `.min.js`) with type declarations:

```sh
npm run build:lib
```

```html
<canvas id="model" style="width: 100%; height: 600px"></canvas>
<script type="module">
  import { MochiView } from "./mochi2d.js";
  const view = new MochiView(document.getElementById("model"));
  const model = await view.load("models/my-model/my-model.model3.json"); // or a .zip, a File, …
  view.on("hit", (e) => model.startMotion("TapBody"));
</script>
```

`npm run example:embed` serves [examples/embed](examples/embed/index.html).
See [docs/api.md](docs/api.md).

**In a PixiJS scene.** `mochi2d/pixi` gives a PixiJS v8 display object
(PixiJS is a peer dependency):

```js
import { MochiSprite } from "mochi2d/pixi";
const chan = await MochiSprite.from(url, { renderer: app.renderer, ticker: app.ticker });
app.stage.addChild(chan);
```

`npm run example:pixi` serves [examples/pixi](examples/pixi/index.html).

**Evaluate a model headlessly (Node).**

```js
import { loadModelFromDisk } from "mochi2d/node"; // dist/lib/node.js
const model = await loadModelFromDisk("assets/models/DeepSeek/大肥鱼.model3.json");
await model.startMotionFile("Animation/脱捕.motion3.json");
for (let i = 0; i < 60; i++) model.update(1 / 60);
console.log(model.instance.drawableVertices[0]);
```

`npm run example:node` runs [examples/node/evaluate.mjs](examples/node/evaluate.mjs).

**Render a model to PNG from Node.** `NodeRenderer` (in `mochi2d/node`)
renders with the reference renderer in headless Chromium and keeps the
browser open between renders; `fast: true` gives quicker previews with
downscaled textures. It needs Playwright (an optional peer dependency).

```js
import { NodeRenderer, loadModelFromDisk } from "mochi2d/node";
const renderer = await NodeRenderer.open();
const model = await loadModelFromDisk("assets/models/DeepSeek/大肥鱼.model3.json");
const { png } = await renderer.render(model, { width: 512, height: 1024 });
await renderer.close();
```

**Read, write and validate `.moc3` files.** `readMoc`, `writeMoc` and
`validateMoc` (in `mochi2d/headless`) work on a file's contents as plain
arrays, for editors and exporters. Writing a genuine file's data reproduces
it byte for byte, and `writeMoc` refuses data that fails `validateMoc`'s
`official` level. See [docs/moc-data.md](docs/moc-data.md).
`parsePhysics` and `writePhysics` read and write `.physics3.json` files.
An editor can also change a shown model's values in place (`model.patch`)
and show other data without loading its textures again (`model.replace`);
see [Editing a shown model](docs/api.md#editing-a-shown-model). For a
timeline with physics, `savePhysicsState` and `restorePhysicsState`
continue the physics from a saved frame bit for bit.

**Let an AI agent drive a model.** `npm run build` also writes an MCP server
(stdio) and a headless command line with the same operations: load, describe,
set parameters, play motions, advance time, render a PNG, hit-test, validate.

```sh
npm run build
# the MCP server, here added to Claude Code (other clients: docs/agent-api.md)
claude mcp add mochi2d -- node "$PWD/dist/tools/mochi2d-mcp.js" --root "$PWD/assets/models"
# the command line
npx mochi2d render assets/models/DeepSeek --params ParamMouthOpenY=1 --out out/open.png
```

The server reads files only under its `--root` folders, writes nothing and
makes no network requests. Renders need Playwright's Chromium. See
[docs/agent-api.md](docs/agent-api.md) for the tools, the command line and
client configurations, and [llms.txt](llms.txt) for a summary for language
models.

**Run the conformance tools.**

```sh
npm run build
# the 827-scenario test catalog and its crafted inputs (gitignored)
npm run catalog
npm run conformance -- out/catalog/static out/catalog/sequence out/catalog/animation --out out/results
# premultiplied PNGs (headless Chromium)
npm run render -- out/catalog/render --out out/renders
# the judge's rules; path/to/reference holds the reference results
npm run judge -- path/to/reference out --catalog out/catalog
npm run golden -- --check && npm run golden -- --renders --check
```

A full round is described in [docs/conformance.md](docs/conformance.md).

How the pieces fit together: [docs/architecture.md](docs/architecture.md).

## Test models

The tests and the conformance catalog use **DeepSeek-chan**, a free Live2D
model. It is not in this repository, because its terms of use forbid
re-uploading the model files. To run the tests that need it:

1. Download DeepSeek-chan from its creator: https://vgen.co/KAMIYA
2. Put the folder that holds `大肥鱼.model3.json` at `assets/models/DeepSeek/`,
   so that `assets/models/DeepSeek/大肥鱼.model3.json` exists.

`assets/models/` is gitignored: models you put there are never committed.
Without DeepSeek-chan, the build and the other tests still work, and
`npm test` says which tests it skips and how to get the model. Follow the
terms of use that come with it.

DeepSeek-chan: illustration and PSD by Kamiya Ryoko (神宫凉子); Live2D rigging
by 霓虹猫_NeonNeko; distributed free by Kamiya Ryoko.

The committed tests use no other model. Live2D Inc.'s own sample models are
not used with Mochi2D.

## Development

Headless rendering and the browser tests use the environment's pre-installed
Playwright + Chromium (`require('playwright')`); it is an optional peer
dependency of the package, needed only to render.

`package.json` denies the install scripts of esbuild and fsevents in its
`allowScripts` field, which npm reads from version 11.16. Older npm versions
ignore the field and run the scripts. Mochi2D needs neither script:

- esbuild finds its binary in the platform package that npm installs. Its
  script only installs that package if it is missing, swaps in a faster
  launcher and checks the version.
- fsevents (macOS only) ships a prebuilt binary that its script rebuilds from
  source. Without fsevents, Vite watches files with Node's own `fs.watch`.

The build, the dev server and the tests work the same after
`npm ci --ignore-scripts`.

```sh
npm ci
# viewer + render harness (dist/web), CLIs and the MCP server (dist/tools), library (dist/lib)
npm run build
# the library only: dist/lib/{mochi2d,mochi2d.min,headless,node}.js + types
npm run build:lib
# self-contained viewer in dist/viewer; options: -- --models <folder>… (docs/viewer.md)
npm run build:static
# unit tests (+ headless WebGL tests if Playwright is available)
npm test
# also checks that src/core, src/anim and src/runtime use no DOM/Node APIs
npm run typecheck
# prettier
npm run format
# the long fuzzing run of the loaders (failing inputs in out/fuzz)
npm run fuzz
# docs/api-stability.md's export lists from the build; the size of each entry point
npm run api-list
npm run size
# viewer with hot reload (models served under /models/)
npm run dev
# serve the built viewer at http://127.0.0.1:5174/; options: -- --host 0.0.0.0, --dir D
npm run viewer
# serve examples/embed (after build:lib)
npm run example:embed
# run examples/node/evaluate.mjs (after build:lib)
npm run example:node
# render the built-in textured-triangles test scene to out/demo/
npm run demo:render
# evaluator results still match the captured golden hashes
npm run golden -- --check
# dsr-* render PNGs still match their hashes
npm run golden -- --renders --check
```

The command-line tools take these arguments (`<…>` is a placeholder, `[…]`
is optional):

```text
# the test catalog (docs/conformance.md)
npm run catalog     [-- --crafts <dir>] [--out <dir>]
# static, sequence and animation scenarios (Node)
npm run conformance -- <scenario.json | dir>... --out <dir>
# renders (headless Chromium)
npm run render      -- <scenario.json | dir>... --out <dir> [--alpha premultiplied|straight]
# judges a candidate against reference results (docs/conformance.md)
npm run judge       -- <referenceDir> <candidateDir> [--catalog <dir>]
# compares result files (docs/resultdiff.md)
npm run resultdiff  -- <a.result.json | dirA> <b.result.json | dirB>
# compares two PNGs
npm run imgdiff     -- expected.png actual.png --diff diff.png [--threshold N] [--json]
# texture pipeline measurements
npm run texture-probe -- assets/models/DeepSeek/大肥鱼.4096 [--budget-mib N]
# evaluation timing
npm run bench -- [--chromium] [--kernels auto|wasm|js|both] [--stages]
# frame timing + GL call profile
npm run bench -- --render [--render-modes static,animated,random] [--configs …]
```

The viewer ([docs/viewer.md](docs/viewer.md)) draws with the same renderer as
`npm run render`, with these differences: canvas antialiasing; clipping masks
from a mask atlas by default (an approximation sized to the screen and kept
between frames; the "Masks" setting switches to the per-drawable reference
masks); textures downscaled to a memory budget with a visible notice (256 MiB
on phones and tablets); and frames are not redrawn while nothing changes.

A scenario's `model` path is resolved against `assets/models/` first, then
against the repository root, so `DeepSeek/大肥鱼.model3.json` finds
`assets/models/DeepSeek/大肥鱼.model3.json`.

Source layout: `src/core` (pure TypeScript: binary reader, math, file sources,
image helpers; `moc/` reads, validates and writes `.moc3` files; `eval/` is the
float32 evaluation pipeline, with bulk loops as WebAssembly kernels assembled by
`wasm/` and a bit-identical JavaScript fallback; `model/` builds conformance
results; `render/` holds the renderer's reference formulas: framing, mask
boxes, compositing), `src/anim` (the animation layer, pure TS: model settings,
motions, expressions, physics, pose, eye blink, breath, look, lip sync, motion
sync and its audio analysis, hit testing, the frame procedure and a programmatic scenario API), `src/runtime`
(pure TS: `ModelRuntime`, the headless model runtime), `src/render` (WebGL2:
the exact texture pipeline and the model renderer with the direct and layered
pipelines and clipping masks), `src/lib` (the browser runtime and the public
API, with the library entry points), `src/platform` (browser and Node file
sources, audio, PNG encoding), `src/viewer` and `src/harness` (pages in
`web/`), `tools/` (Node CLIs), `test/` (unit and browser tests, synthetic
`.moc3` builder, DeepSeek-chan self-checks), `examples/`, `docs/`. See
[docs/architecture.md](docs/architecture.md).

## Repository layout

- `LICENSE` (MIT) and `THIRD_PARTY_NOTICES.md`: the licenses
- `CLEANROOM.md`: the clean-room process and rules
- `CONTRIBUTING.md`: building, testing, the clean-room statement and sign-off for contributions
- `SECURITY.md`: reporting vulnerabilities, supported versions, what Mochi2D reads and serves
- `src/`, `web/`, `tools/`, `test/`: Mochi2D itself (see Development)
- `docs/`: [API](docs/api.md), [API stability](docs/api-stability.md), [versioning](docs/versioning.md), [migration from 0.x](docs/migration.md), [model data](docs/moc-data.md), [agent API](docs/agent-api.md), [viewer guide](docs/viewer.md), [architecture](docs/architecture.md), [rendering rules](docs/rendering.md), [resultdiff](docs/resultdiff.md)
- `CHANGELOG.md`: releases and the versioning policy
- `llms.txt`: a summary of Mochi2D for language models
- `examples/`: embedding a model in a page, headless evaluation in Node
- `scripts/`: build tooling

## Patents

This project is licensed under the MIT License, which grants no patent
rights. Reading some model files uses techniques, such as joining meshes
("glue") and blend shapes, that may be covered by third-party patents in
some countries, including Japan and the United States. The project has
taken no legal opinion on this, and makes no statement that any patent is
or is not infringed. If you use or distribute it in such a country, above
all commercially, check for yourself whether you need a license.

---

Live2D and Live2D Cubism are trademarks or registered trademarks of Live2D
Inc. Mochi2D is an independent project. It is not affiliated with, endorsed
by, sponsored by or supported by Live2D Inc., and it contains none of
Live2D's code or files.

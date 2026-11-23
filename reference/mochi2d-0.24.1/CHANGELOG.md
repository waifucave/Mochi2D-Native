# Changelog

Mochi2D follows [semantic versioning](https://semver.org) from 0.2.0. Before
1.0, a minor release (0.x.0) may change the documented API, and a patch
release (0.x.y) does not. The documented API is what
[docs/api.md](docs/api.md), [docs/moc-data.md](docs/moc-data.md) and
[docs/agent-api.md](docs/agent-api.md) describe. Everything else is
internal and can change in any release.

- [docs/api-stability.md](docs/api-stability.md) lists every export with its
  mark: stable or experimental.
- [docs/versioning.md](docs/versioning.md) says what a major, minor and patch
  release may change, from 1.0.
- [docs/migration.md](docs/migration.md) lists the renames, removals and
  changed behavior since 0.10.0.

## 0.24.1

A fix: a file past its cap is reported as what it is everywhere. No API
change; evaluation and renders are unchanged.

### Fixed

- **`mochi2d render`, the MCP server's `render`, `NodeRenderer.render`
  and `npm run render`:** a model file past the file cap (a texture of
  1.5 GiB, say) failed with `page.evaluate: FileNotFoundError: File not
  found: "1/…" in models`, as a plain `Error`, where `describe` promised a
  `FileLimitError`. It now fails with that `FileLimitError` and its
  `path`, `kind`, `limit` and `size`, on standard error and under
  `--json`, and in `structuredContent.error`. The same holds for the
  total cap and for a zip entry past the archive caps.
- **Every error of ours from the render page keeps its type:** the page
  sends each one's name and fields with its message, and Node rebuilds the
  same class by name (one with a name we have no class for keeps its name
  and fields). No error of ours reaches a caller as `page.evaluate: …`
  with the name `Error`.
- **The local server of `npm run render` and `npm run viewer`** streams a
  model file with its length instead of reading it whole first: a page
  refuses one past its cap on the length alone. A 1.5 GiB texture took
  9 s and 1.7 GB of memory in `npm run render`, and 22 s and 4.7 GB in
  the viewer's server; now under a second and about 100 MB.
- **A motion sound that can't be read** (missing, or past a cap) is named
  in the model's `warnings`; it was dropped silently. `describe` says
  "motion sound not played: FileLimitError: …" for one past a cap, where
  it said "not found".
- **The viewer** shows a failed open with the error's name
  (`Opening folder failed: FileLimitError: …`).

## 0.24.0

Caps on what a model's textures declare and on its files' own sizes, a
choice for compressed motion sounds, and refusals that fail the command
line and the MCP server properly. Evaluation and the renders of existing
files are unchanged.

### What an app should set

- **If your app opens models people hand it,** pass these beside the
  archive caps of 0.23.0:
  - `textures: { maxSide: 8192, maxPixels: 2 ** 26, maxTotalPixels: 2 ** 28 }`
    and `files: { maxFileBytes: 128 * 2 ** 20, maxTotalBytes: 512 * 2 ** 20 }`,
    to `view.load`, `view.addItem` or `MochiSprite.from`;
  - `textures` and `files` to `NodeRenderer.render`, and `files` to
    `loadModelFromDisk`.
- **If it only opens your own models,** the defaults are enough. To play
  their compressed motion sounds (MP3, Ogg, FLAC), pass
  `sounds: { compressed: true }`.
- **Catch** `TextureLimitError` and `FileLimitError` ("too large") and
  `TextureFormatError` ("damaged or not an image we read") where you catch
  `ArchiveLimitError`. Show `model.warnings`: it names every motion sound
  that won't play.

### Added

- **`TextureLimits`** (`maxSide`, `maxPixels`, `maxTotalPixels`; defaults
  in `DEFAULT_TEXTURE_LIMITS`: 16,384, 2²⁸ and 2³⁰), as `textures`. Every
  texture's header is read before anything is decoded.
- **`TextureLimitError`** (`path`, `kind`, `limit`, `size`, `width`,
  `height`) and **`TextureFormatError`** (`path`).
- **`readTextureHeader(path, bytes)`** and `TextureHeader`: what a PNG,
  JPEG, WebP, GIF, BMP or ICO file declares, without decoding it.
- **`FileLimits`** (`maxFileBytes`, `maxTotalBytes`; defaults in
  `DEFAULT_FILE_LIMITS`: 1 GiB and 2 GiB), as `files`, and
  **`FileLimitError`** (`path`, `kind`, `limit`, `size`): the files of a
  folder, a URL or a drop. A known size is checked before reading; a
  download is streamed and stopped at the cap.
- **`SoundOptions`** (`compressed`), as `sounds`; **`soundFormat(bytes)`**
  and `SoundFormat`.

All new exports are stable.

### Changed

- **Every texture's header is checked before decoding,** in the view, the
  Pixi sprite, items, the Node renderer, the command line, the MCP server
  and the texture probe. Browsers decode a texture at its declared size
  even when it is then scaled down, so the texture budget never bounded
  decoding; the caps now do.
- **Texture formats:** PNG, JPEG, WebP, GIF, BMP and ICO load, their sizes
  read from their headers. Formats whose size isn't read (AVIF or HEIF,
  TIFF, JPEG XL) are refused with `TextureFormatError`
  (`docs/migration.md`). A file too short for the size it declares is
  refused where the format makes that a bound (PNG, sequential JPEG,
  uncompressed BMP).
- **A model's own motion sounds play only as WAV files** unless
  `sounds: { compressed: true }`: the browser decodes compressed formats
  to many times their size. Every skipped sound is named in the model's
  `warnings`, at load and when it was to play; the viewer shows them, and
  the command line's `describe` prints them. `speak()` still plays any
  format the browser decodes.
- **The command line and the MCP server fail on a refusal.** A texture,
  archive or file cap, or a damaged file, exits non-zero with
  `mochi2d: <name>: <message>` and, under `--json`, the error's fields; a
  render writes no file. The MCP server returns `isError` with the name in
  its text and the fields in `structuredContent.error`. `describe` and
  `load_model` list each texture's declared size and the refusal a render
  would meet.
- **The fuzz tests** also run the texture header readers.

## 0.23.0

Caps on what a zip archive may inflate to. Evaluation and renders are
unchanged.

### What an app should set

- **If your app opens models people hand it** (uploads, drops, links),
  pass caps that fit the models you expect, for example
  `{ maxEntryBytes: 64 * 2 ** 20, maxTotalBytes: 256 * 2 ** 20, maxEntries: 2000 }`:
  - as `archive` to `view.load`, `view.addItem` or `MochiSprite.from`;
  - as the last argument of `sourceFromZip`, `new ZipFileSource`,
    `sourceFromZipFile` or `sourceFromDataTransfer`;
  - as `archive` to `loadModelFromDisk`.
- **If it only opens your own models,** the defaults are enough.
- **Catch `ArchiveLimitError`** where you catch `ZipFormatError`, to tell
  the person the archive is too large.

### Added

- **`ArchiveLimits`:** `maxEntryBytes`, `maxTotalBytes` and `maxEntries`.
  `DEFAULT_ARCHIVE_LIMITS` holds the defaults: 256 MiB, 1 GiB and 10,000.
  Pass `Infinity` to turn a cap off.
- **`ArchiveLimitError`,** with `path`, `kind` (`"entry"`, `"total"`,
  `"entries"`), `limit` and `size`.
- **`ZipFileSource.limits`,** the caps a source reads with, and
  **`inflatedBytes`,** what it has inflated so far, each entry once.

All four exports are stable.

### Changed

- **Zip entries inflate as a stream,** counting the real bytes. An entry
  that inflates past the size its records declare stops there with
  `ZipFormatError`. A read takes at most about twice the declared size,
  itself capped, or about 40 MiB for a small entry.
- **Every entry's CRC-32 is checked.** A wrong one is a `ZipFormatError`.
- **The defaults apply everywhere,** the viewer, the command line, the
  MCP server and the Node helpers included, and to the name decoding's own
  reads of settings files.
- **Reading deflated entries is slower,** the cost of stopping a crafted
  one early: reading all of a 77 MiB model archive took 1.0 s where it
  took 0.6 s before, on the test machine. The CRC-32 is computed about
  twice as fast as before, which pays for part of the check.
- **The fuzz tests** also run the zip reader with small caps.

## 0.22.1

Tests and a comment only; no API or behavior change.

### Changed

- **`test/viewer-editing.test.ts`:** the pose test waits for every part
  opacity it checks, the linked sleeve too, before checking it. It could
  check the sleeve a frame early.
- **Public text:** a source comment no longer names a development round,
  and `test/public-text.test.ts` also catches a round with a letter suffix.

## 0.22.0

What an editor needs to export and render version 6 models. Evaluation
results and renders of existing files are unchanged, bit for bit: the
conformance catalog and the goldens are untouched.

### Added

- **`writeMoc` writes version 6** (`WRITABLE_VERSIONS` is 1–6):
  offscreens, offscreen keyforms and blend shapes, and the blend codes. The
  layout extends that of versions 1–5, and the refusals are the same kinds
  (`missing-field` for a version 6 array that is missing, and so on).
- **Model data in place of a `.moc3`** (experimental): `ModelRuntime.load`
  and `view.load` take `moc` (`.moc3` bytes, or `{ data, version }`), with
  the other files from the source, so a preview needs no stand-in `.moc3`.
  New types `MocInput`, `RuntimeLoadOptions` and `ModelDataOrigin`, and
  `runtime.modelSource`.
- **Motions as written:** `Motion.loop` (`Meta.Loop`) and `Motion.written`
  (experimental, type `MotionAsWritten`): the file's `Meta` and curve fades
  as written, beside the resolved values.
- **`docs/moc-data.md`:** the blend codes (color functions, alpha modes and
  how they combine) and the meaning of each art-mesh and offscreen flag
  bit, as one table; and what `readMoc` checks (the file's framing, not its
  data).

### Changed

- **`NodeRenderer.render(runtime)`** draws the runtime's own model after
  `withData` or the `moc` load option; it drew the source's `.moc3` before.
  A runtime from `withModel` (a built model, which no file holds) is
  refused with a message naming `withData`.
- **`runtime.withData(data, version)`** writes the data with `writeMoc` and
  loads it, so its runtime's `source` serves the new `.moc3`; the errors are
  those of `mocModelFromData` before (`MocWriteError`, `MocFormatError`).
- `Motion` has the two new fields: code that builds `Motion` objects by
  hand needs them.

## 0.21.1

Documentation and a sample model. No API or behavior change; evaluation
results and renders are unchanged.

### Added

- **The sample model «Mochi»** in `samples/mochi/` (MIT; see
  `samples/README.md`): five parameters with the usual IDs, eye blink and
  lip sync groups, hair physics and an idle motion. It is not part of the
  npm package.
- **The viewer offers it** in one click when no model is open, and lists it
  in **File › Models…** (`?model=samples/mochi/mochi.model3.json`).
- **A screenshot in the README**, generated by
  `test/readme-screenshot.test.ts` (`MOCHI2D_UPDATE_IMAGES=1` writes it
  again); the sample's reference render in `test/golden/mochi-render.json`.
- The Node example falls back to the sample model when DeepSeek-chan is not
  there.

### Changed

- **README:** the status no longer names a release; the "Run the viewer"
  steps start with the sample.

## 0.21.0

Wording and tests, and one experimental option. Evaluation results and
renders are unchanged, bit for bit.

### Added

- **Evaluation switches** (experimental): `evaluation: { glue, blendShapes }`
  on `ModelInstance` and `RuntimeOptions` (so also a view's `runtime`
  option). `glue: false` skips the glue pass; `blendShapes: false` ignores
  blend-shape keyform bindings. Both default to true; with both on, results
  are bit-identical with 0.20.0's, with either kernel. New type
  `EvaluationOptions`. See docs/api.md, "Evaluating without glue or blend
  shapes".

### Changed

- **Docs:** they describe what Mochi2D does, and state its test results
  against the official runtime as the project's own. `README.md` has a new
  Status sentence, a "Patents" section, and new "How it was made" and
  trademark texts. `docs/conformance.md` says that reference results can
  come from any set in the same formats.
- **No references to the project's private specification document:**
  they now say what they mean (the test catalog, the format's rules). Rule
  labels such as C12, P8 and §1b.7 stay.
- **`test/public-text.test.ts`** has no exceptions any more, and also
  refuses two more kinds of wording (see the test's header).

## 0.20.0

Preparing the repository to be public. One default changes; evaluation
results and renders are unchanged, bit for bit.

### Changed

- **The motion-sync file's per-parameter smoothing is off by default**
  (`fileSmoothing`, default false). Where it applies:
  - the driver and `ModelRuntime`;
  - the view and its items;
  - the agent API's `load_model` (a new `fileSmoothing` input) and the
    command line (a new `--file-smoothing` flag).

  The analysis's own smoothing (the setting's `Smoothing`, attack and
  release) is unchanged and still shapes the motion, and the file's dead
  band (`Damper`) still applies. Pass `fileSmoothing: true` for the old
  behavior. One test changes with the default: white or pink noise now
  opens the mouth to at most 0.15 (0.1 with the file's smoothing).
- **Wording:** comments and docs state rules and facts without citing the
  project's private records, and `test/public-text.test.ts` scans every
  tracked file outside `cleanroom/` for such citations.
- **The tagline:** "an open-source runtime for models made with Live2D
  Cubism".

### Added

- **`SECURITY.md`:** reporting vulnerabilities privately, the supported
  versions, and what Mochi2D parses, reads, serves and opens.
- **`CONTRIBUTING.md`:** building and testing, the clean-room statement
  each pull request confirms, and the DCO sign-off.
- **The README:** how Mochi2D was made, and a trademark footer.
- **CI:** the workflow runs with read-only repository permissions.

## 0.19.1

Docs only. The code, results and renders are 0.19.0's.

- **`docs/conformance.md`:** 0.18.0's renders, compared with the official
  renderer on SwiftShader in every pixel and channel, are identical:
  - all 53 catalog render scenarios that render;
  - all 156 renders of a second model pack;
  - the 54th catalog scenario, a texture too large, is refused by both.

  The rules changed exactly the pixels 0.14.0 had wrong, and no others.
- **The README and `llms.txt`** say so in a line each.

## 0.19.0

A 1.0 candidate: 1.0 would be this release with its number changed.
Evaluation results and renders are unchanged, bit for bit.

### Removed

- **The deprecated names from 0.16.0,** as their notes said. Nothing in
  the repository used them any more.
  - `folderSource`: use `sourceFromFolder`.
  - `zipFileSource`: use `sourceFromZipFile`.
  - `NodeDirSource`: use `NodeFileSource`.
  - `BrowserFilesSource`: use `BrowserFileSource`.
  - `SettingsError`: use `SettingsFormatError`.
  - `MochiHitEvent.hitAreas`: use `areas`.

### Changed

- **Stable since this release:**
  - the items: `MochiItem`, `AddItemOptions`, `ItemLayout`,
    `ItemLayoutEntry`, `ItemPlacement`, `ItemSettings`, `ItemPinInfo`,
    `ItemDepth`, `ItemSplit` and `ItemMeshPlace`;
  - the framing helpers: `frameImage`, `imagePosition`, `outputPosition`
    and `Framing`.

  `docs/api-stability.md` gives the reasons for what stays experimental.

### Added

- **`docs/versioning.md`:** what a major, minor and patch release may
  change, in stable and experimental exports, in results (bit-exact with
  the official runtime: a change is a fix or a break), in renders (only
  toward the official renderer), in Mochi2D's own file formats, and how
  long a deprecated name lives.
- **`docs/migration.md`:** every rename and removal since 0.10.0, and the
  behavior changes that may need a change in your code.

## 0.18.0

The last render rule, and advancing without drawing. Evaluation results
are unchanged, bit for bit.

### Changed

- **Rule I, a masked layer's mask** (`docs/rendering.md`): when an
  offscreen layer that carries a mask is composited, its mask is looked up
  through one matrix, D = A · V⁻¹, applied to the layer quad's clip-space
  corners and interpolated:
  - A is the mask's texture matrix by rule M;
  - V⁻¹ is the view matrix's inverse, computed in double from V's float32
    entries.

  0.17.0 mapped the corners to model space first, which is mathematically
  the same but not bit for bit.
- **Renders:** only layers with masks change. Of the crafted renders, 4
  change by one level, in 4, 17, 5 and 9 pixels (`q2c-leg-pose`,
  `q2c-leg`, `q2d-leg-pose`, `q2d-leg`). DeepSeek-chan's reference renders
  are unchanged. With the four rules, the catalog's 53 render scenarios
  are expected to be pixel-identical with the official renderer.

### Added

- **Advancing without drawing** (`docs/api.md`, "Advancing without
  drawing"):
  - `view.drawing = false` keeps the loop and `advance()` moving the model
    without drawing;
  - `view.advance(seconds, { draw: false })` does one such step;
  - `view.draw()` draws the current state.

  Motions, events, expressions, physics, live lip sync and items all move
  on, and drawing later gives the same picture as drawing every frame.

## 0.17.0

Pixel-exact rendering. Renders change by one level in some pixels, toward
the official renderer; evaluation results are unchanged, bit for bit.

### Changed

Three rendering operations follow the official renderer's order and
rounding (`docs/rendering.md`). The view, the sprite, items, the render
tool, `NodeRenderer` and the viewer's mask atlas all use them.

- **Rule V, texture coordinates:** textures are sampled at
  `f32(1 − f32(1 − v))`, the stored v flipped twice in float32, in mask
  meshes too. On DeepSeek-chan this moves the v of 14,506 of 58,967
  vertices by a few units in the last place.
- **Rule M, mask coordinates:** masks are mapped through float32 affine
  matrices, composed in a fixed order with each addition rounded to float32,
  and applied as `A·p + c` in the vertex shader. Before, Mochi2D subtracted
  the origin and then scaled. An offscreen's mask coordinate is now
  interpolated from the layer quad's corners instead of rebuilt per pixel.
- **Rule L, layers:** offscreen and root layers are composited by a quad
  with texture coordinates 0 to 1 and linear filtering, instead of an exact
  per-pixel texel fetch.

The render goldens are regenerated:

- DeepSeek-chan's 9 reference renders differ from 0.16.0 in 8 to 210
  pixels each;
- the 11 crafted renders differ in 21 to 110 pixels each.

Every changed pixel moves by one level, except one pixel by two.

### Docs

- **`docs/rendering.md`, new:** the three rules, for other renderers.
- **`docs/conformance.md`:** the render comparison with the official
  renderer, and Mochi2D's own limits where the format gives no rule (the physics step
  cap).

## 0.16.0

Readiness for 1.0: the bit-exact result checked, every loader fuzzed, an API
stability list, and package sizes. Results are unchanged, bit for bit.

### Changed

- **Bit for bit, checked:** 0.14.0's results were compared with the
  official runtime's evaluation, and `docs/conformance.md` gives the
  result. Every compared field of the static catalog's 573 scenarios is
  bit-identical, and so are the catalog's sequences and all but 17 of its
  28,856 animation frames. Those 17 differ in near-zero physics or curve
  tails computed in double precision (around 10⁻³¹), and no float32
  output changes from them.
- **Renamed, with the old names kept as deprecated aliases until 1.0**
  (`docs/api-stability.md`):
  - `folderSource` → `sourceFromFolder`;
  - `zipFileSource` → `sourceFromZipFile`;
  - `NodeDirSource` → `NodeFileSource`;
  - `BrowserFilesSource` → `BrowserFileSource`;
  - `SettingsError` → `SettingsFormatError` (its `name` is now
    `"SettingsFormatError"`);
  - `MochiHitEvent.hitAreas` → `areas`, as in the view's `TapEvent`.
- **`MochiSpriteEvents.motionend`** is typed as the `MotionEnd` the sprite
  emits (`motion`, `group`, `index`, `reason`, `queueEmpty`); the type said
  `path`, which the event never had.

### Fixed

Found by fuzzing the loaders:

- **Zip:** a damaged deflate stream threw a plain `Error` from the
  decompressor. It now throws `ZipFormatError`, and an entry that claims to
  unpack to more than deflate can produce is refused before its memory is
  allocated.
- **`.moc3`:** a huge corrupt keyform count made `writeMoc` and
  `validateMoc` loop for seconds over indices outside the file. Only the
  indices inside it are visited now.
- **WAV:** `decodeWav` threw a `RangeError` for 0 bits per sample. It now
  throws `WavFormatError`.
- **Physics:** a physics file with an absurd `Fps` (`1e308`, or `1e309`,
  which reads as infinite) made the model hang forever in its first
  update. A frame now takes at most 10,000 physics steps and drops the
  time beyond them, and an infinite `Fps` steps once per frame. Rates up to
  600,000 steps a second at 60 frames per second are unaffected.
- **Motion-sync WAV:** `decodeMotionSyncWav` accepted any sample rate, and
  a 2.1 GHz rate took minutes to analyze. Rates outside 1–768 kHz now throw
  `MotionSyncAudioError`.

### Added

- **Fuzzing** (`docs/architecture.md`, "Fuzzing the loaders"): every
  loader is fed mutated `.moc3`, JSON, zip and WAV files and whole
  synthetic models. A short pass runs in the test suite, and
  `npm run fuzz` runs the long one (20,000 inputs per target by default).
- **`docs/api-stability.md`:** every export of `mochi2d`,
  `mochi2d/headless`, `mochi2d/node` and `mochi2d/pixi`, generated from the
  build (`npm run api-list`), each marked stable, experimental or
  deprecated. A test fails when an export appears or disappears without the
  list changing.
- **Package size** (`npm run size`, `docs/architecture.md`): each entry
  point minified and gzipped. A test checks that `mochi2d/headless` pulls
  in no WebGL, DOM or Node code, that `mochi2d/pixi` pulls in neither the
  viewer nor PixiJS, and that each entry point stays under a size ceiling.
- **`docs/api.md`:** which error each loader throws.

## 0.15.0

Speed after the bit-exact rules. Results are unchanged, bit for bit.

### Changed

- **The JavaScript fallback** is back to 0.13.0's speed (0.14.0 was about
  25 % slower): the warp's inside path is inlined again, and the far
  region's affine map is computed once per grid instead of once per band
  corner. The WebAssembly kernels were already as fast as before.

### Added

- **`npm run bench -- --kernels all`** times the three kernel modes:
  WebAssembly with its 4-lane loops, WebAssembly without them
  (`"wasm-scalar"`, a new `KernelChoice` for comparison) and JavaScript. Any
  list works too (`--kernels wasm,js`). The numbers before and after the
  rules are in `docs/architecture.md`.

## 0.14.0

Evaluation bit for bit, textures updated in place, bright tints, and a
PixiJS sprite that survives a lost WebGL context. Results change in their
last bits (vertices by up to 1.3·10⁻⁵, a few opacities by up to 3·10⁻⁸);
every catalog verdict is unchanged.

### Changed

- **Evaluation follows the official runtime's float32 order** where it
  differed in the last bits, in both evaluation kernels (JavaScript and
  WebAssembly):
  - the warp mapping: inside the grid (quad cells multiply each corner
    value before the row weight; triangle cells weigh the corners rather
    than their differences), the far region's affine map from the grid's
    corner diagonals (now from u ≤ −2, u ≥ 3, v ≤ −2 or v ≥ 3), and the
    band's local coordinates in a grid cell;
  - ancestor opacities combined from the top down (the parts' product from
    the topmost part, then the mesh's own opacity times the deformers'
    product, times the parts');
  - repeating parameters always wrapped, inside their range too (the
    maximum wraps to the minimum);
  - glue pairs as a + ((b − a)·w)·I, glues one after another in file order;
  - blend-shape constraint weights between keys in the weighted form of
    keyforms.

  The result goldens, render goldens and crafted render hashes are
  regenerated. The judge passes every catalog scenario against 0.13.0's
  results.
- **Tints** take r, g and b up to 2: above 1 a tint brightens, the drawn
  color limited to white (a light overlay). Tints of 1 or below draw as
  before, bit for bit.
- Tests that follow the audio clock run on their own, after the others, and
  wait for the states they check.

### Added

- **`updateTexture(index, image, at?)`** on models, items and Pixi sprites
  (`sprite.model`): replaces a texture, or a region of it, from an
  ImageBitmap, a canvas, ImageData, an image or RGBA pixels, without
  reloading; drawn from the next frame, with the mip levels recomputed by
  the exact rule. `model.textures` gives each texture's size.
- **`mochi2d/pixi`**: after Pixi's WebGL context is lost and restored, the
  sprite loads its textures and renderer again and carries on
  (`"contextrestored"`).

## 0.13.0

Expression fade times per call, wind per physics setting, a PixiJS
integration, and three additions to the viewer's editing. Evaluation
results and renders are unchanged.

### Added

- **`mochi2d/pixi`**: `MochiSprite`, a PixiJS v8 container that shows a
  model in a Pixi scene. It takes its transform, alpha, tint, blend mode,
  masks and filters from Pixi, draws through the Pixi renderer's WebGL
  context (or, with a WebGPU renderer, a context of its own, handed over as
  a canvas texture), takes pointer events (`"hit"` on hit areas, look
  following the pointer) and is driven by a Pixi ticker. `sprite.model` is
  the `MochiModel` API. PixiJS is an optional peer dependency (8.12 or
  later); the module also exports all of `mochi2d`. Example:
  `examples/pixi/` (`npm run example:pixi`).
- **Expression fade times per call**: `setExpression`, `addExpression`,
  `removeExpression` and `clearExpression` take `{ fadeIn, fadeOut }` in
  seconds (`ExpressionFades`) that replace the file's for that call; an
  added expression keeps the fade-out it was given for its removal.
  Without them, nothing changes.
- **Wind per physics setting**: `setPhysicsSettingWind(id, multiplier)`,
  `getPhysicsSettingWind`, `physicsSettingWinds` and
  `resetPhysicsSettingWinds` (models, items and `ModelRuntime`). A
  setting's pendulums feel the wind times the multiplier; 1 is the
  reference bit for bit, 0 shields the setting.
- **Viewer**: File › New expression… (or the Expressions branch) makes a
  named, empty expression file, listed in the model settings, and opens its
  editor with every parameter listed; Ctrl+C copies the selected pose
  row's part ID.

### Changed

- **Viewer**: opening another model (or settings file) while changes are
  not exported asks first, as closing the page does.

## 0.12.0

Editing in the viewer, items listed in drawing order, physics settings that
say whether their name is their own, and test files that describe their
rules themselves. Evaluation results and renders are unchanged.

### Added

- **Editing in the viewer**, with every change shown on the model at once
  and an asterisk on the item until exported:
  - a motion's settings entry: its group (new groups too; blank takes it
    out of the model settings, and a group adds a motion they don't list),
    fades, sound and motion-sync setting, saved in the model settings; the
    model plays groups and idle motions from them at once;
  - expressions: every parameter's check box, value and blend; an `Add`
    value is the parameter's value (the file stores it less the default),
    `Multiply` is a factor from 1 (right-click switches a parameter to it
    and back), `Overwrite` the value itself; the fades;
  - the pose: a new `.pose3.json` listing every part (File › New pose),
    each part's group number and the part it follows, with warnings for
    links the groups override or that have no effect; the fade.
- **Export** (Ctrl+S) downloads the one changed file, or with several, a
  `.zip` of the model settings and every changed file at its path in the
  model's folder. An expression and the pose have their own Export button.
  Edited files keep their other keys and key order; new ones follow the
  formats' usual key order. JSON indented with tabs.
- **`PhysicsSettingInfo.named`**: `physicsSettings` entries say whether the
  physics file's dictionary names the setting (`name` is then its name
  there) or not (`name` is the ID). The type is exported.
- **`Animator.setPose(file)`** replaces the pose (for editors); the pose
  sets the parts up on its next frame.

### Changed

- **`view.items` follows the drawing order**: `item.raise()` moves the item
  to its end, and `exportItemLayout()` lists the items in that order.
  `applyItemLayout()` restores it: the placed items are drawn in the
  entries' order, above the items the layout doesn't place.
- **`Animator.idleCount`** follows the settings' `Idle` group as it is,
  so changes to `runtime.settings.motions` reach idle playback.
- The tests describe each rule and vector themselves, and a test keeps
  `src/`, `test/`, `tools/`, `docs/` and the top-level docs free of
  references to the research behind them.

## 0.11.0

A new viewer layout, with tools for checking a model, and motion-sync files
written back. The library's API gains only the additions below; the agent
tools and the viewer's URL parameters are unchanged. Evaluation results and
renders are unchanged.

### Added

- **The viewer's layout**: a menu bar (File, Edit, Display, Animation) and
  four areas: a menu area whose panel (Parameters, Parts, Items, Lip sync)
  is chosen from a drop-down, the model view, a resource tree, and a
  settings area for the item selected in the tree. On phones the three
  areas share a sheet, one at a time, chosen with tabs.
- **The resource tree**: the model settings, the `.moc3` file, the
  textures, the physics, the motions by group, the expressions, the pose,
  the user data, the motion-sync settings and the display information,
  with the folder's motions and expressions the settings don't name.
  Double-click or Enter plays a motion or an expression; right-click shows
  a motion's curves. Changed items get an asterisk until exported, and the
  page asks before closing while any has one.
- **The settings area**: the model settings and notes on what loaded; the
  model-file inspector (statistics, then the parameters, parts, art meshes,
  offscreens and the current draw order; a clicked art mesh flashes on the
  model); a texture's sizes and preview; a physics summary with the rate in
  use and a rate choice; a motion's settings, with where its fades come
  from (the settings, the file, or the 1000 ms default), loop playback, its
  sound, its motion-sync setting and its events; a motion's curves as a
  graph; an expression's fades (the file's, or 500 ms) and values; the
  pose's fade (the file's, or 500 ms) and groups; the user data and display
  information; and the motion-sync settings with a preview from a WAV file.
- **Tools**: a comparison of two `.moc3` files, object by object (Edit ›
  Compare two .moc3 files…, or drop two files); the motions' events and the
  frame rate shown over the model (Display › Events, Display › Frame
  rate); a line saying which lip sync moves the mouth, motion sync or
  volume lip sync, in the Lip sync panel and the motion-sync preview.
- **The Animation menu**: expressions, automatic blinking, physics, pose
  switching, motion sync, idle motion, cursor tracking, breathing,
  parameter repetition and lip sync, each on or off.
- **Opening**: File › Open recent (models opened by URL or from the Models
  list). File › Add files… takes WAV files too. Dropping two `.moc3` files
  compares them, and dropping motion, expression or WAV files adds them to
  the open model.
- **File › Export model settings** (Ctrl+S, ⌘S): the loaded `.model3.json`
  with every key kept, plus the expressions in the model's folder that it
  doesn't list, indented with tabs.
- **Mouse**: Ctrl+drag moves the model, and Alt+wheel zooms as the wheel
  does.
- **Display › Mipmapping**, on by default: turned off, textures are
  minified from their full-size level only, for comparison.
- **`writeMotionSync(file)`**: motion-sync settings back to
  `.motionsync3.json` text, the inverse of `parseMotionSync`. In the
  browser bundle and `mochi2d/headless`, with the `MotionSyncSettingData`
  and `WriteMotionSyncOptions` types.
- `PressInfo.ctrl` and `PressInfo.alt` for gesture handlers.

### Changed

- **The viewer's controls moved**: the open controls into the File menu;
  the masks, texture budget, background and screenshot from the stage bar
  into the Display menu; the effect toggles into the Animation menu; Stop
  motions into the Edit menu; hit-area outlines into the Display menu.
  Motions and expressions are played from the resource tree, looping is
  chosen per motion in its settings, and the Audio panel is now the Lip
  sync panel.

### Fixed

- The browser test of items between layers starts from a blank page of its
  own, and the embed example's log works without its log element.

## 0.10.0

Items between the main model's art meshes and split items, physics files
written back, physics state saved and restored, a physics rate option, and
mip levels that no longer depend on the GPU driver. Evaluation results are
unchanged except for one case of the incremental evaluation (below), and
renders of models whose textures are powers of two (DeepSeek-chan's
included) are unchanged.

### Added

- **Items between the model's layers**: `item.layer = { above: meshId }`
  or `{ below: meshId }` draws an item at that place in the main model's
  render order, into whatever the art mesh is drawn into (inside an
  offscreen, with its opacity, colors, blending and mask). `"front"` and
  `"behind"` are the whole model as before. Clipping masks stay per
  drawable. `ItemPlacement.layer`, the `ItemDepth` and `ItemMeshPlace`
  types; layouts save it.
- **Split items**: `item.split = { mesh, back }` draws an item in two
  passes, split at one of its art meshes: the front part at `item.layer`,
  the back part at `back`, never in front of the front part.
  `ItemPlacement.split`, the `ItemSplit` type; layouts save it.
- **`writePhysics(data)`**: physics data back to `.physics3.json` text, the
  inverse of `parsePhysics`; DeepSeek-chan's file comes back byte for byte.
  `parsePhysics` keeps the file's `EffectiveForces` (the simulation still
  does not use them), and both are in the browser bundle and
  `mochi2d/headless`, with the physics data types.
- **Physics state**: `savePhysicsState()` and `restorePhysicsState(state)`
  on models, items and runtimes. A run continued from a restored state
  repeats the run after the save bit for bit, for timeline scrubbing.
- **Physics rate**: `setPhysicsRate(stepsPerSecond | null)` and
  `physicsRate` on models, items and runtimes, and the `physicsRate`
  runtime option (not reference behavior). `describe_model` reports the
  rate.
- **Loading part keyforms' offscreen keyform indices** that the official
  check rejects: `offscreenKeyformRange: "load"` (`loadMoc` and runtime
  option) reads such an index as −1, with a load warning.
- Renderer: `FrameOptions.range` (render-order positions to draw) and
  `FrameOptions.inserts` (drawing at places in the render order).

### Changed

- **Validation**: every part keyform's offscreen keyform index, normal or
  blend-shape, of any part, must be −1 or an offscreen keyform, at both
  levels, as the official check requires; nothing else about it is
  checked. An offscreen-owning part's normal keyform may hold −1, which
  gives the offscreen opacity 0 and colors 0 (it was refused before), and
  blend-shape keyforms' indices are never read.
- **Mip levels** of textures whose sizes are not powers of two are built by
  Mochi2D's own rule (the mean of each 2 × 2 block, rounded to nearest with
  ties to even, on clamped blocks), as for powers of two, instead of the
  GPU driver's generator: renders no longer depend on the driver. Renders
  with such textures, minified, change slightly.
- **Live motion sync and `recordAudio`** open the microphone without the
  browser's voice processing by default (`voiceProcessing: false`), since
  noise suppression changes the vowels' spectra. Live lip sync keeps it on.

### Fixed

- A mesh with blend shapes that became inactive through its part or
  deformer, while its own inputs stayed the same, kept the vertices it had
  accumulated while inactive when it became active again in the
  incremental evaluation. It is now recomputed, as in a full evaluation.
- The motion-sync rating page's browser test waits for the volume panel's
  mouth to move, so it passes under load.

## 0.9.0

Motion sync: `.motionsync3.json` files move the mouth with a sound, a motion's
linked sound or live audio, through Mochi2D's own audio analysis. The file,
its links and the processing around the analysis follow the official
runtime; the analysis itself is Mochi2D's, so the mouth shapes are similar,
not the same (the official analysis engine is closed). Evaluation results
and renders are unchanged.

### Added

- **Motion-sync files**: `FileReferences.MotionSync` in model settings and
  each motion entry's `MotionSync` setting (by dictionary name, else by
  setting ID). The reader is lenient as the official one, with a warning
  for each missing, ill-typed or out-of-range value, and limits values the
  official runtime would refuse to run (`Scale`, `BlendRatio`, `Smoothing`,
  `SampleRate`, `Smooth`). `parseMotionSync`, `findMotionSyncSetting`.
- **Motion sync at runtime**: the analysis tick (`SampleRate` a second, at
  most one a frame), each parameter's smoothing (`Smooth`) and dead band
  (`Damper`), the writes after lip sync and before pose (or before physics
  with `motionSync: { beforePhysics: true }`), the `motionSync` effect
  switch, links per motion entry, a sound that plays once and then settles
  to the Silence shape, and only the bound setting writing.
- **Mochi2D's analysis**: a gate, the level against the sound's own voiced
  level, voicing (periodicity), band energies and mel spectra compared with
  vowel templates after noise masking, then `Enabled`, `Scale`, the blend
  and a non-linear smoothing (slew limits) set by `Smoothing`. Sound files
  are analysed ahead of playback.
- **API**: `MochiModel.speak(audio, { motionSync })`,
  `startLiveMotionSync()` (microphone or `MediaStream`),
  `stopLiveMotionSync()`, `liveMotionSync`, `motionSync` (the element
  weights, the level and the values at every analysis), `onMotionSyncTick`,
  `motionSyncSettings`, `voiceProfile` and `setVoiceProfile` (items too);
  `ModelRuntime.startMotionSync`, `setMotionSyncInput`, `stopMotionSync`,
  `motionSyncSource`; `RuntimeOptions.onSound` may return the sound's
  playback clock.
- **Voice calibration**: `VoiceCalibration` (record each vowel, and a
  moment of the room's silence), profiles as JSON (`voiceProfileFromJson`),
  and `MochiView.recordAudio(seconds)` for the recordings.
- **Agents**: the MCP tool `play_sound` (a WAV file through a setting);
  `describe_model` lists the settings, and `play_motion` and `advance_time`
  report motion sync, with how often each element was the strongest.
- **Rating page** (`examples/motion-sync-rating/`, `npm run
  example:rating`): a clip with four mouths side by side, in a blind random
  order (Mochi2D's analysis calibrated and not, a volume-only baseline and
  a still mouth), with ratings exported as JSON or CSV.
- `mochi2d/headless` exports the parts: `MotionSyncDriver`,
  `SettingEngine`, `ParameterFilter`, `TickClock`, `VowelAnalyzer`,
  `decodeMotionSyncWav` (8- to 32-bit PCM and float WAV files, any rate),
  and a vowel synthesizer.

### Changed

- The live audio tap's AudioWorklet also hands over the samples, mixed to
  mono (for live motion sync).

## 0.8.0

Rotation chains bit for bit, offscreen blend shapes, every opacity drawn as
the official renderer draws it, and physics strength and wind at runtime.
Evaluation results change (vertices only, by up to 8.1·10⁻⁶ in the
catalog), and so do the render goldens; see "Changed".

### Added

- **Physics strength**: `setPhysicsStrength(k)`, `physicsStrength`,
  `setPhysicsSettingStrength(id, k)`, `getPhysicsSettingStrength`,
  `physicsSettingStrengths`, `resetPhysicsStrengths()` and
  `physicsSettings` (IDs and names) on `MochiModel`, `MochiItem` and
  `ModelRuntime`. Each output moves its parameter by k times the way: 0
  leaves the parameters as with physics off, 1 is the reference bit for
  bit, above 1 exaggerates within the parameter's range. The model's
  strength times a setting's. Not reference behavior.
- **Wind at runtime**: `setPhysicsWind(x, y)` and `physicsWind`, read at
  every physics step. `replace()` keeps strengths and wind.
- **Physics while paused**: `ViewOptions.holdPhysicsWhenPaused` (default
  true) keeps physics-driven parameters at their last physics values in
  frames that take no time, instead of their base values. Runtimes take it
  as `RuntimeOptions.holdPhysicsInZeroSteps` (default false: the reference
  rule). Not reference behavior.
- **`RuntimeOptions.nonFiniteOpacity`** (`"load"` loads files with NaN or
  ±∞ keyform opacities), `NodeRenderer`'s `nonFiniteOpacity` option for
  paths and sources, and `ModelRuntime.loadOptions`.
- **Offscreen blend shapes** (version 6): `MocData.offscreenBlendShapeTargets`
  (count 37) and the model's `blendShapes.offscreen`; `validateMoc` checks
  the table like the other target tables.
- `THIRD_PARTY_NOTICES.md` lists musl, whose float32 arctangent, sine and
  cosine Mochi2D ports (MIT, with the Sun Microsystems notice of the math
  code); the bundles that include them carry its license comment.

### Changed

- **Rotation deformers** under a rotation or a warp take their angle from
  two mapped probe points, with float32 arctangent, sine and cosine as the
  C math library computes them; the base angle is added last, radians are
  not reduced, and the scale is folded into the rotation's coefficients.
  Every vertex under a rotation can move by a few float32 steps: all 68
  result goldens and all 18 render goldens change, and 618 of 773 catalog
  results (vertices only; every scenario still passes the judge).
- **Offscreens** receive blend shapes only from offscreen targets, not from
  their owner part; a part's blend shapes change its draw order only. An
  offscreen's opacity and colors are clamped only when it is a target.
- **Art-mesh colors** are clamped to [0, 1] only where they combine with a
  parent deformer's (a mesh without one reports them as interpolated,
  unless it is a blend-shape target).
- **The renderer draws every drawable whose opacity is not 0**, negative,
  NaN and infinite ones too, and clamps where the official renderer does:
  the compatible blends clamp the source (NaN to 0), the advanced codes
  their stored result, and an advanced offscreen composite covers its
  whole parent layer.
- **Mirrored items** get the main model's `ParamAngleX` and `ParamAngleZ`
  negated, so they turn with it on screen; item settings apply on top.
- The loader no longer requires offscreen keyforms behind a part's
  blend-shape keyforms (they are not read).
- `MocData.unidentifiedV6` (and the type `MocUnidentifiedGroup`) is now
  `offscreenBlendShapeTargets` (`MocBlendShapeTargets`).

## 0.7.0

For desktop apps and agents: tints, idle weights, mirrored items and base
values. Evaluation results, renders without tints and the bytes `writeMoc`
writes are unchanged.

### Added

- **Art-mesh tints**: `setTint(meshId, [r, g, b, a?])`, `clearTint`,
  `clearTints`, `getTint` and `tints` on `MochiModel`, `MochiItem` and
  `ModelRuntime`. RGB multiplies a mesh's color after its multiply and
  screen colors, A its opacity; masks are unaffected. Drawn by the view,
  items and `NodeRenderer` (which also takes a `tints` option), kept by
  `replace()`. Not reference behavior.
- **Idle weights**: `setIdleWeight(id, w)`, `getIdleWeight`,
  `resetIdleWeights` (and `idleWeights` on the runtime). Motions at the idle
  priority (the `Idle` group, and `priority: 1` starts) move a parameter by
  w of their usual amount: 0 leaves the base value, 1 is unchanged bit for
  bit. Other motions are not affected. Not reference behavior.
- **Mirrored items**: `item.mirror` and `ItemPlacement.mirror` flip an item
  about its anchor; drawing, hit tests, dragging and pins follow it, and
  layouts save it.
- **`getParameterBase(id)`** beside `getParameter(id)`, on `MochiModel`,
  `MochiItem` and `ModelRuntime`. The MCP tool `get_parameters` and the
  command line report `base` beside `value`.

### Changed

- Default item placements, and so exported layouts, include `mirror: false`.
- Introspection (B5) and `explain_pose` move to 0.8.0.

## 0.6.0

For editors: values change in place, and structural edits keep the
textures. Evaluation results, renders and the bytes `writeMoc` writes are
unchanged.

### Added

- **Value patches**: `MochiModel.patch(patches)` (and `ModelRuntime.patch`,
  `ModelInstance.patch`) writes new keyform positions of art meshes and warp
  grids, opacities, draw orders, multiply and screen colors, rotation values
  and glue intensities and weights, blend-shape keyforms included, by their
  `MocData` array and index (`ValuePatch`, `PATCHABLE_FIELDS`). The next
  evaluation equals a rebuild with those values, with either kernel and with
  or without incremental evaluation.
- **Other data, same textures**: `MochiModel.replace(moc, version?)` shows
  `.moc3` bytes or `MocData` for the shown model, keeping its textures (not
  decoded or uploaded again), the view, parameter base values, part
  opacities, effect switches, a live lip-sync input, and items pinned to a
  triangle that remains. `ModelRuntime.withData(moc, version?)` and
  `withModel(model)` do it without a view.
- `MochiView.toPage(x, y)`, the inverse of `toModel`.
- `keepView` in `view.load` options.
- The browser bundle exports `mocModelFromData`, `readMoc`, `writeMoc`,
  `MocWriteError`, `MocFormatError`, `WRITABLE_VERSIONS` and the `MocData`
  types.
- `ModelInstance.evaluations`, the number of evaluations so far.

### Changed

- `mocModelFromData` copies the data: later changes to the arrays no longer
  reach the model (0.5.0 shared some arrays). Patches change a loaded model.
- A view draws an evaluation made outside its frames (`runtime.update(0)`
  between frames) at its next frame; 0.5.0 waited for the next change.
- Docs: `getParameter` reads a parameter's value in the latest frame,
  effects included (the docs said base value, which `setParameter` sets);
  `setParameter` shows at the next frame and `runtime.update(0)` applies it
  at once; `physicsInputs`' `reflect` is the input's own flag, without the
  output's.

## 0.5.0

Evaluation follows corrected rules for blend shapes, so results
change in their last bits, and draw orders, render orders and visibility
change only for files with blend-shape targets outside [0, 1000] or
negative opacities. Within the conformance tolerances everywhere. The bytes
`writeMoc` writes are unchanged.

### Changed

- **Blend-shape interpolation**: the float32 weighted sum, as for normal
  keyforms, except in the segment that starts at the base key, where the
  other keyform weighs f32(1 − f32(1 − t)). For positions, opacity, colors,
  rotation values, glue intensity and draw orders.
- **Constraint weights**: w = min(1, c₁, …, c_m); negative weights are used
  as stored.
- **Clamps of blend-shape targets (version 5 and later)**, once, on the
  object's own value after all of its blend shapes (added one at a time in
  binding order), before anything from a parent combines in: opacity and
  multiply and screen colors to [0, 1] (art meshes, warps, rotations), draw
  orders to [0, 1000] (art meshes, parts), a rotation's scale to
  [f32(10⁻⁴), 100] and its keyform angle to [−3600, 3600], glue intensity to
  [0, 1]. Positions, grid points and origins are never clamped. Version-4
  targets are not clamped at all (0.4.0 clamped their draw orders at 0).
- **The range test is half-open**: a value at or above f32(k_last + ε) is out
  of range; snapping to a key is strict at both bounds.
- **Visibility**: a drawable is visible when it is active and its opacity is
  not 0, so negative and NaN opacities are visible (0.4.0: above 0). The
  renderer never draws a drawable whose opacity is negative or NaN, and
  `drawableAt` skips them.
- **Rotation angles in radians**: f32(f32(a·f32(π)) / 180), which reproduces
  the bit-level rotation vectors.
- **Validation**: rotation keyform color indices are checked like those of
  warps and art meshes at the `official` level; non-finite keyform
  opacities are a strict error (`opacity-value`), and `loadMoc` rejects them
  unless `nonFiniteOpacity: "load"`.
- **Holding a motion**: eye blink runs again once a held motion is at its
  end (it stayed off in 0.4.0); `blinkWhileHeld: false` keeps it off.

### Added

- **Forward mapping**: `ModelRuntime.mapPoints(deformer, points, { space,
  jacobian })` maps points from a deformer's input space to model units
  through its world form, bit for bit as the evaluator maps vertices, with
  the analytic 2×2 Jacobian per point; `ModelRuntime.deformers` lists the
  deformers. `ModelInstance.mapPoints` and `mapJacobians` by index. The MCP
  tool `map_points`, and deformer counts in `describe_model`.
- `MotionOptions.blinkWhileHeld`; `play_motion` takes it too.
- `LoadMocOptions.nonFiniteOpacity`.

## 0.4.0

No evaluation changes: results and reference renders are bit for bit those
of 0.3.0. The bytes `writeMoc` writes are unchanged.

### Changed

- **`startMotion` and `startMotionFile`** (of `MochiModel`, `MochiItem` and
  `ModelRuntime`) resolve to a `MotionPlayback` instead of `true` when the
  start is accepted, and still to `false` when it is refused. A playback is
  truthy, so `if (await model.startMotion(…))` keeps working; code that
  compares with `=== true` must change. `ModelRuntime.playMotion` returns a
  playback or false likewise.
- **The view's `motionend` event** fires for each motion that ends (idle
  motions included), with `motion`, `group`, `index`, `reason` and
  `queueEmpty`. Before, it fired only when the motion queue became empty:
  check `queueEmpty` for that.
- **`viewTransform`** also gives `rotation` and `pixelsPerUnit`.
- **Item layouts** hold an `id` per item, and `applyItemLayout` matches by id
  before settings path, so copies of the same item keep their own places.
  Layouts without ids are read as before.
- `ModelRuntime.physicsDriven` follows the last physics setting that
  overwrites a parameter, whose value is the one that shows, when several do
  (DeepSeek-chan has no such parameter).
- Public docs no longer name internal documents.

### Added

- **Holding a motion's last frame**: `MotionOptions.hold` (not reference
  behavior).
- **A finished event per motion**: `MotionPlayback.ended`, a promise of the
  motion's `MotionEnd` with the reason (`finished`, `replaced`, `stopped`),
  and `ModelRuntime.onMotionEnd(listener)`.
- **Several expressions at once**: `addExpression(nameOrPath)`,
  `removeExpression(nameOrPath?)` and `addedExpressions`, each with the
  file's fades; `setExpression` keeps replacing (not reference behavior).
- **View rotation**: `setView({ rotation })`, in degrees, counterclockwise
  about the canvas center; drawing, items, taps, hit tests, look, zoom, pan
  and dragging follow it. `panBy(dx, dy)` moves the model by CSS pixels, and
  docs/api.md explains the view's units ("View coordinates").
  `MochiModel.canvas` gives the model's canvas rectangle in model units.
- **Mixing live lip sync**: `LiveLipSyncOptions.mix` (`"add"`, the default;
  `"replace"`; `"max"`; or a function that receives the live value and the
  value so far), changeable on the control.
- **Choosing the microphone**: `LiveLipSyncOptions.deviceId`.
- **Item ids**: `item.id` (given to `addItem` or `<settings path>#<n>`),
  `view.item(id)`, and per-item `exportLayout()` and `applyLayout(entry)`.
- **Physics-driven parameters**: `physicsInputs` (on `MochiModel` and
  `ModelRuntime`) maps each parameter physics overwrites to the parameters
  that drive it, and `MochiModel.lookRouting()`.
- **`mocModelFromData(data, version)`**: the model from `MocData` without
  writing a file, equal to `loadMoc(writeMoc(data, { version }))`, also for
  version 6 data.
- **`MemoryFileSource.fromFiles(files)`** for in-memory file maps (bytes,
  `ArrayBuffer` or text), and lookups that match precomposed and decomposed
  Unicode names.
- **Rendering to PNG from Node**: `NodeRenderer` and `renderToPng` in
  `mochi2d/node`, with the reference renderer in headless Chromium, the
  browser kept open between renders, and a `fast` mode with downscaled
  textures and the mask atlas. Playwright is an optional peer dependency.
- **The agent API**: `play_motion` takes `hold`; `play_expression` takes
  `mode` (`replace`, `add`, `remove`); `advance_time` reports each motion's
  end (`ends`); `set_parameters` lists the parameters physics overwrites with
  the inputs to set instead (`physicsOverwrites`); `describe_model` gives
  every parameter's `physicsInputs` and what physics overwrites and look
  writes; `render` takes `maxTextureSize` for fast previews, and the CLI
  `render --fast`.

### Fixed

- The audio tests feed a generated tone instead of the fake capture
  device's beeps, so they no longer fail under load.

## 0.3.0

Evaluation results change in their low-order bits, and some files that loaded
before are now rejected (both described below). The bytes `writeMoc` writes
are unchanged.

### Changed

- **Evaluation**, corrected after tests against the official runtime:
  - keyforms are interpolated as a float32 weighted sum over the corners of
    the bindings that are off their keys, accumulated from zero, instead of
    nested linear interpolation, for every keyform kind;
  - draw orders of art meshes and parts: n = trunc(D + 0.001), D being the
    interpolated draw order, and for objects with blend shapes
    max(0, trunc(n + B + 0.001)), B being their blend-shape contribution,
    in float32. This replaces trunc(trunc(D) + B). The value is also the
    object's render-order key, and what its draw-order group's range is
    compared with;
  - a parameter's decimal places `d` set its key snapping and range
    tolerance, 10^−d, instead of a fixed 0.001. Genuine files store `d` = 3,
    which is 0.001;
  - a blend shape's base keyform is not read: its values count as zero.
    Genuine files store zeros there, so their results do not change;
  - on DeepSeek-chan's test catalog, results moved by at most 2.0·10⁻⁶
    (vertices), 6.6·10⁻⁷ (opacity), 5.4·10⁻⁷ (colors) and RMS 0.039
    (renders). Its draw orders and render orders did not change.
- **`writeMoc` refuses data that the official consistency check rejects**,
  with the diagnostics of `validateMoc`'s `official` level, instead of
  writing it. This includes the check's position-run rule, which a valid
  layout can fail (docs/moc-data.md). Data laid out like genuine files
  passes.
- **Validation** (`validateMoc` and the loader), from the official check's
  verdicts:
  - newly checked at the `official` level: flag fields other than 0 or 1
    (code `flag-value`), negative decimal places, every mask entry and every
    draw-order object whether or not something lists it, every object's
    band, deformer parents and parts, color ranges, the version-5 color
    indices of warp and art-mesh keyforms, and the position-run rule (code
    `position-run`), which replaces the old first-position check;
  - newly rejected by the `strict` level and the loader: a color index
    equal to the table size, which the official check accepts;
  - new `strict` warnings: `band-mismatch` (a deformer's band differs from
    its warp or rotation record's) and `position-value` (non-finite keyform
    positions);
  - files that break these rules no longer load. All local genuine test
    models pass every rule.
- The test catalog has 827 scenarios: 20 more validation cases.

### Added

- The byte layout `writeMoc` writes is part of the documented API: a release
  that changes the bytes for equal data and version is at least a minor
  release, with a changelog entry.

## 0.2.0

### Added

- **Model data** (`mochi2d/headless`, `mochi2d/node`; [docs/moc-data.md](docs/moc-data.md)):
  - `MocData`, the public model-data type: everything a `.moc3` file of
    versions 1–6 stores, as index-based typed arrays.
  - `readMoc(bytes)` → `{ data, version, diagnostics }`, without building an
    evaluator.
  - `writeMoc(data, { version })` for versions 1–5, laid out like genuine
    files. `readMoc(writeMoc(d))` gives back `d`, and writing the data of a
    genuine file reproduces it byte for byte. It refuses data the version
    cannot hold, with every problem (`MocWriteError.diagnostics`).
  - `validateMoc(data or bytes, { level })` with the levels `official` and
    `strict`, and structured diagnostics `{ code, severity, kind, index,
    field, message }`.
  - `MocFormatError.code`: what is wrong, as a stable code.
- **Conformance results** as a library call: `scenarioResult(model,
  scenario)` and `resultModelFromSource` in `mochi2d/headless`, and
  `resultModelFromDisk` in `mochi2d/node` ([docs/api.md](docs/api.md)).
- **The agent interface** ([docs/agent-api.md](docs/agent-api.md)): the
  `mochi2d-mcp` MCP server and the `mochi2d` command line, with `bin` entries
  in `package.json`.
- This changelog.

### Changed

- The package's files include `dist/web` (the render page that the commands
  need) and `CHANGELOG.md`.
- The viewer server's model list skips symbolic links that point nowhere.

## 0.1.0

The first version: the runtime, the WebGL renderer, the viewer, and the
library entry points `mochi2d`, `mochi2d/headless` and `mochi2d/node`.

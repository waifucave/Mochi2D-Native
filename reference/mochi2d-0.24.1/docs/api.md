# Mochi2D API

Mochi2D has four entry points. All are ES modules with TypeScript
declarations, built by `npm run build:lib` into `dist/lib/`.

| Import              | File                                         | Runs in                                 | For                                               |
| ------------------- | -------------------------------------------- | --------------------------------------- | ------------------------------------------------- |
| `mochi2d`          | `mochi2d.js` (`mochi2d.min.js` minified)   | browsers with WebGL2                    | showing a model on a canvas: `MochiView`         |
| `mochi2d/headless` | `headless.js`                                | anywhere (no DOM, no Node APIs)         | animating and evaluating a model: `ModelRuntime`  |
| `mochi2d/node`     | `node.js`                                    | Node ≥ 20                               | everything in headless, plus files on disk and rendering to PNG |
| `mochi2d/pixi`     | `pixi.js`                                    | browsers with WebGL2, with PixiJS v8    | a model in a PixiJS scene: `MochiSprite` ([below](#in-a-pixijs-scene-mochi2dpixi)) |

Without a bundler, import the file directly:
`import { MochiView } from "./mochi2d.js"`. The bundles have no runtime
dependencies (`mochi2d/pixi` imports `pixi.js`, a peer dependency), and image decoding runs in an inline worker, so the files can
be hosted anywhere.

`mochi2d/headless` and `mochi2d/node` also read, write and validate `.moc3`
files ([moc-data.md](moc-data.md)) and produce conformance results
([below](#conformance-results)).

**Versions.** Mochi2D follows semantic versioning from 0.2.0. Before 1.0, a
minor release may change the documented API (this document,
[moc-data.md](moc-data.md) and [agent-api.md](agent-api.md)), and a patch
release does not. Releases are listed in [CHANGELOG.md](../CHANGELOG.md).
`MOCHI2D_VERSION` gives the version of a build.

## Showing a model: `MochiView`

```ts
import { MochiView } from "mochi2d";

const view = new MochiView(document.querySelector("canvas")!, { look: "follow" });
const model = await view.load("models/my-model/my-model.model3.json");

view.on("hit", (e) => void model.startMotion("TapBody"));
```

The canvas is sized by CSS. The view sizes its drawing buffer to match and
draws the model fitted inside. It animates every frame and only redraws when
something changed.

### `new MochiView(canvas, options?)`

| Option          | Default         | Meaning                                                                                                                       |
| --------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `background`    | `"transparent"` | A CSS color, or `"transparent"` so the page shows through.                                                                   |
| `look`          | `"follow"`      | `"follow"`: the model looks at the mouse over the canvas, or at a finger dragging on it. `"drag"`: only while pressing. `"off"`. |
| `zoom`          | `false`         | Wheel and two-finger pinch zoom; a double tap resets the view.                                                              |
| `pan`           | `false`         | Shift-, middle- or right-drag pans (any drag when `look` is `"off"`).                                                        |
| `fit`           | `0.95`          | Fraction of the canvas that the model's own canvas rectangle fills.                                                          |
| `textureBudget` | `"auto"`        | Texture memory: `"auto"` (256 MiB on phones and tablets, 1 GiB otherwise), `"full"`, or a number of MiB.                    |
| `masks`         | `"atlas"`       | Clipping masks: `"atlas"`, `"atlas-fine"`, or `"reference"` (the per-drawable masks of reference renders; slow).             |
| `maskMeshes`    | `"active"`      | Which mask meshes are drawn into masks: `"active"` (the meshes the latest evaluation recomputed) or `"all"` (reference renders).   |
| `maxPixelRatio` | 2 on mobile     | Upper limit of the device pixel ratio used for the drawing buffer.                                                          |
| `autoResize`    | `true`          | Size the drawing buffer to the canvas's CSS size every frame.                                                               |
| `autoStart`     | `true`          | Start the render loop at once. Otherwise call `start()`, or `advance(seconds)` from your own loop.                          |
| `antialias`     | `true`          | Canvas antialiasing.                                                                                                          |
| `runtime`       |                 | Options for the models' runtimes (see `RuntimeOptions` below).                                                              |
| `dragItems`     | `false`         | Pressing on an item drags it; a pinned item is pinned again where it is dropped (see Items below).                            |
| `holdPhysicsWhenPaused` | `true`  | While the clock is paused, physics-driven parameters keep their last physics values (below). Not reference behavior.          |

When textures do not fit the budget, they are all scaled down by one factor
and `model.textureNotice` says which. Show that text to your users: fine
detail is lost.

### Loading

`view.load(input, { settings?, keepView?, moc?, archive?, textures?, files?, sounds? })` loads a model and shows it in
place of the current one (which is disposed). It resolves with a
`MochiModel`. With `keepView: true`, the new model is shown with the zoom,
offset and rotation of the one before (by default the view starts fitted).
With `moc` (experimental), the model is the `.moc3` bytes or
`{ data, version }` given (written with `writeMoc`), in place of the
settings' `.moc3`, which then need not exist; the settings, textures and
other files still come from the input ([Model data in place of a
`.moc3`](#model-data-in-place-of-a-moc3)).
The input can be:

- a URL (string or `URL`) of a `*.model3.json` file, or of a `.zip` archive;
- a `.zip` archive as a `Blob` or `File`;
- a folder's files: a `FileList` from `<input type="file" webkitdirectory>`,
  or `File[]` with `webkitRelativePath`;
- a drop: a `DataTransfer`;
- in-memory files: `{ files: { "model.model3.json": bytes, … } }` (values:
  `Uint8Array`, `ArrayBuffer`, `Blob` or string);
- any `FileSource` (`{ label, list(), read(path) }`).

When the input holds several settings files, `settings` names the one to
load. Otherwise the shallowest `*.model3.json` is used. A URL source cannot
list its files, so only the files the settings reference are available.

**Zip archives.** Entries are decompressed when they are read. Names are
decoded in this order:

1. from an Info-ZIP Unicode Path field (0x7075) whose CRC matches the stored name;
2. as UTF-8 when the archive flags them so;
3. otherwise with one encoding for the whole archive: UTF-8 if every such name
   is valid UTF-8, else the first of GB18030, Shift_JIS, EUC-KR and Big5 that
   decodes them all (preferring one under which the settings file's references
   resolve), else code page 437.

`source.nameEncoding` tells which encoding step 3 chose. Node's EUC-KR decoder
lacks the CP949 extension syllables, which only browsers decode. RAR and 7z
archives are rejected with an `UnsupportedArchiveError`, which asks for the
archive to be extracted first.

**Caps on what an archive may inflate to.** A small zip can inflate to
gigabytes. Every zip source reads within three caps, `ArchiveLimits`
(`archive` in `view.load`, `view.addItem` and `MochiSprite.from`; the last
argument of `sourceFromZip`, `new ZipFileSource`, `sourceFromZipFile` and
`sourceFromDataTransfer`; `archive` in `loadModelFromDisk`):

| Cap | Default (`DEFAULT_ARCHIVE_LIMITS`) | Refuses |
| --- | --- | --- |
| `maxEntryBytes` | 256 MiB | an entry larger than this |
| `maxTotalBytes` | 1 GiB | reading past this many bytes from one archive, all entries together |
| `maxEntries` | 10,000 | an archive whose directory lists more entries, when it is opened |

- **The error:** `ArchiveLimitError`, with `path` (the entry, or the
  archive's label for `"entries"`), `kind` (`"entry"`, `"total"` or
  `"entries"`), `limit` (the cap) and `size` (what was asked for).
- **What counts:** the bytes really inflated. An entry whose records
  declare more than a cap is refused before anything is inflated. One that
  inflates past its declared size stops there with `ZipFormatError`, so
  the data kept is never larger than the declared size. While inflating,
  a read briefly takes up to about as much again, or about 40 MiB for a
  small entry.
- **The total:** each entry counts once, the first time it is read, so a
  view that reads a texture again does not use the cap up. An entry the
  directory lists under several names counts once per name.
- **Every read is capped,** the name decoding's own reads of settings
  files too. Opening an archive reads only its directory and its settings
  files.
- **The CRC-32** of every entry is checked; a wrong one is a
  `ZipFormatError`.
- **Turning a cap off:** pass `Infinity`. A cap must be a number ≥ 0
  (`RangeError` otherwise); one not given keeps its default.
- **Nested archives:** a zip inside a zip is an entry like any other and
  is never opened.

The defaults let through any model we have seen many times over: the
largest test model is 77 MiB in all, its largest file 17 MiB, and none
has more than 44 files. The viewer, the command line, the MCP server and
the Node helpers use them. An app that loads models from strangers should
set its own, smaller caps:

```ts
await view.load(file, {
  archive: { maxEntryBytes: 64 * 2 ** 20, maxTotalBytes: 256 * 2 ** 20, maxEntries: 2000 },
});
```

**Caps on what textures may declare.** A PNG of a few kilobytes can declare
30,000 × 30,000 pixels, 3.6 GB once decoded. Browsers decode a texture at
the size its header declares, and allocate that before the data proves it,
even when it is then scaled down to the texture budget or `maxTextureSize`.
So every texture's header is read before anything is decoded, and checked
against three caps, `TextureLimits`: `textures` in `view.load`,
`view.addItem`, `MochiSprite.from` and `NodeRenderer.render`.

| Cap | Default (`DEFAULT_TEXTURE_LIMITS`) | Refuses |
| --- | --- | --- |
| `maxSide` | 16,384 | a texture wider or taller than this |
| `maxPixels` | 268 million (16,384²; 1 GiB as RGBA) | a texture of more pixels than this |
| `maxTotalPixels` | 1,074 million (2³⁰; 4 GiB as RGBA) | a model whose textures declare more pixels than this together |

- **The error:** `TextureLimitError`, with `path` (the texture as the
  settings name it), `kind` (`"side"`, `"pixels"` or `"total"`), `limit`,
  `size` (the larger side, the pixels, or the model's running total) and
  the declared `width` and `height`. Nothing was decoded.
- **The formats:** PNG, JPEG, WebP, GIF, BMP and ICO, the formats browsers
  decode as textures. Each declares its size in a header read without
  decoding:

  | Format | The size read from | Too little data refused |
  | --- | --- | --- |
  | PNG | the IHDR chunk | yes: the image data inflates at most about 1,032:1 |
  | JPEG | the first frame header | sequential (baseline) only: two bits per 8 × 8 block; progressive and arithmetic coding can code a block in less |
  | WebP | the VP8X canvas, and each VP8 or VP8L frame header | no: lossless codes can spend no bits on a pixel |
  | GIF | the logical screen and the first frame's extent | no: a frame can cover a small part of the screen |
  | BMP | the bitmap header | uncompressed only: every pixel; run-length coding can skip pixels |
  | ICO | each entry's own image header (the largest) | the PNG entries' |

  A GIF or ICO decodes to at most its declared size (a smaller frame or
  entry); the others to exactly that size.
- **Damaged or crafted:** `TextureFormatError`, with `path`, for
  - another format, whose declared size Mochi2D does not read (AVIF and
    HEIF, TIFF, JPEG XL, SVG), naming it;
  - a header that can't be read, or that its format doesn't allow;
  - a file too short to hold the size it declares (the table), before
    decoding;
  - data that fails to decode, or decodes to another size than declared.
- **What the caps bound:** decoding a texture takes at most its declared
  size, which the caps limit. A header that declares more than its data
  holds fails to decode, after the browser has allocated the declared size;
  one that declares less is decoded at the declared size, and the rest of
  its data is ignored.
- **The texture budget and `maxTextureSize`** scale textures down after they
  are decoded, so they bound GPU memory, not decoding. The caps bound
  decoding.
- **Turning a cap off:** pass `Infinity` (`RangeError` for anything but a
  number ≥ 0).
- **`readTextureHeader(path, bytes)`** reads what a texture declares
  (`{ width, height, format }`) with the same checks, to show a model's
  sizes before loading it.

The defaults let through every model we have measured: the largest texture
is 8,192², 67 million pixels, and the largest model's textures declare 268
million together. The viewer, the command line and the MCP server use them.
An app that loads models from strangers should set smaller caps:

```ts
await view.load(file, {
  archive: { maxEntryBytes: 64 * 2 ** 20, maxTotalBytes: 256 * 2 ** 20, maxEntries: 2000 },
  textures: { maxSide: 8192, maxPixels: 2 ** 26, maxTotalPixels: 2 ** 28 },
});
```

**Caps on a file's own size.** A zip's entries have their caps; the files
themselves, from a folder, a URL, a drop or a picked file (a zip
included), have two more, `FileLimits`: `files` in `view.load`,
`view.addItem`, `MochiSprite.from`, `loadModelFromDisk` and
`NodeRenderer.render`; the last argument of `sourceFromFolder`,
`sourceFromZipFile` (after `archive`), `sourceFromFileList` and
`sourceFromDataTransfer` (after `archive`); the third of `new
HttpFileSource(baseUrl, label, limits)` and `new BrowserFileSource`.

| Cap | Default (`DEFAULT_FILE_LIMITS`) | Refuses |
| --- | --- | --- |
| `maxFileBytes` | 1 GiB | a file larger than this |
| `maxTotalBytes` | 2 GiB | reading past this many bytes from one source, each file counted once |

- **The error:** `FileLimitError`, with `path`, `kind` (`"file"` or
  `"total"`), `limit` and `size`.
- **Before reading:** a size known beforehand (a `File`, a file on disk, a
  download's `Content-Length`) is checked before anything is read.
- **Downloads** are streamed and cancelled the moment they pass the cap,
  never read whole first.
- **Optional files** (physics, motions, expressions…) past a cap are not
  read, and the model loads without them, with a warning; the settings and
  the `.moc3` past a cap fail the load. A motion past a cap rejects
  `startMotion` with its `FileLimitError`; a motion sound past a cap (or
  missing) is not played, and `warnings` names it.
- **Renders in Node:** `NodeRenderer.render` reads a model's files through
  the same caps (`files`), and a file past one, a texture included,
  rejects with the same `FileLimitError` and fields as in a page.
- **In-memory input** (`{ files }`, a `FileSource` of your own) is already
  held, so these caps don't apply to it.

**Other files.** Sounds, motions, physics and the `.moc3` are read in
proportion to their own size, whatever they declare: a WAV's data length
is read to the end of the file, a motion's or physics file's `Meta` counts
are only compared with what the file holds, and a `.moc3`'s section counts
are checked against the file's length before anything is read.

**A model's motion sounds** play only when they are WAV files, by default:
the browser decodes compressed formats (FLAC, Ogg, MP3) to many times their
size, and nothing in their headers bounds what it decodes. `sounds:
{ compressed: true }` in `view.load`, `view.addItem` and `MochiSprite.from`
lets them play, for models you trust. Every sound that won't play is
named in the model's `warnings`, with the reason:

- at load, by its name (not `.wav`);
- when it was to play, by its bytes (a `.wav` that isn't one) or because
  the browser could not decode it;
- for a view's items, which play no motion sounds of their own.

`soundFormat(bytes)` tells the formats apart. `speak()` plays any format
the browser decodes, since the app chooses that audio.

The defaults let through every model we have measured. For an app that
loads models from strangers:

```ts
await view.load(file, {
  archive: { maxEntryBytes: 64 * 2 ** 20, maxTotalBytes: 256 * 2 ** 20, maxEntries: 2000 },
  textures: { maxSide: 8192, maxPixels: 2 ** 26, maxTotalPixels: 2 ** 28 },
  files: { maxFileBytes: 128 * 2 ** 20, maxTotalBytes: 512 * 2 ** 20 },
});
```

### Events

`view.on(type, listener)` returns a function that removes the listener;
`once` and `off` work as usual.

| Event             | Payload                                                    | When                                                         |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| `tap`             | `TapEvent`                                                 | every tap or click (not a drag) on the canvas               |
| `hit`             | `TapEvent`                                                 | a tap on at least one of the settings' hit areas            |
| `motionevent`     | `{ model, value }`                                         | a user event of a playing motion                            |
| `motionend`       | `{ model, motion, group, index, reason, queueEmpty }`      | a motion ended (each motion once, idle motions included)    |
| `load`            | `{ model }`                                                | a model was loaded and is shown                             |
| `frame`           | `{ dt, time }`                                             | after every frame (model seconds)                           |
| `error`           | `{ error }`                                                | a background error (for example reloading after a GPU reset) |
| `contextlost`     | `{}`                                                       | the browser took the GPU context away                       |
| `contextrestored` | `{}`                                                       | the context is back and the textures have been reloaded     |

A `TapEvent` has `model`, `areas` (hit-area names under the point), `drawable`
(the topmost visible drawable under it, or null), `x`, `y` (model units, y
up) and `clientX`, `clientY`.

`motionend` names the motion (its file's path), the settings `group` and
`index` it was started from (null for a file), and the `reason`:
`"finished"` (it played to its end; a held motion when it reaches its last
frame), `"replaced"` (another motion started while it played, so it faded
out) or `"stopped"` (`stopMotions()`, or its model was unloaded).
`queueEmpty` says whether nothing plays any more. Before 0.4.0 the event
fired only when the queue became empty: check `queueEmpty` for that.

### Other members

| Member                                            | Meaning                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `model`                                           | The `MochiModel` shown, or null.                                     |
| `unload()`                                        | Removes and disposes the model.                                       |
| `start()`, `stop()`, `running`                    | The render loop.                                                      |
| `paused`, `speed`, `time`                         | Animation clock: pause, speed factor, model time.                     |
| `advance(seconds, { draw }?)`                     | Animate by `seconds` and draw (for your own loop); with `draw: false`, animate without drawing (below). |
| `drawing`, `draw()`                               | Whether frames draw (default true), and drawing the current state now ([Advancing without drawing](#advancing-without-drawing)). |
| `resize()`                                        | Size the drawing buffer to the canvas's CSS size now.                 |
| `background`                                      | Get or set the background (CSS color or `"transparent"`).             |
| `viewTransform`, `setView({ zoom, x, y, rotation })`, `resetView()` | Zoom, offset and rotation of the view ([View coordinates](#view-coordinates)). |
| `panBy(dx, dy)`                                   | Move the model on screen by CSS pixels (x right, y down), as a drag does. |
| `lookAt(clientX, clientY)`                        | Look at a point in page coordinates.                                  |
| `hitTest(clientX, clientY)`                       | What lies under a point, like a `TapEvent`.                           |
| `toModel(clientX, clientY)`                       | Page coordinates to model units.                                      |
| `toPage(x, y)`                                    | Model units to page coordinates (as `clientX`, `clientY`): the inverse of `toModel`, for placing page elements over the model. Null without a model. |
| `screenshot()`                                    | A PNG `Blob` of the next frame (straight alpha).                      |
| `items`, `addItem(input, options?)`, `item(id)`, `itemAt(clientX, clientY)` | Items over the model (see Items below).     |
| `exportItemLayout()`, `applyItemLayout(layout)`   | Save and restore where the items are.                                 |
| `dispose()`                                       | Stops the loop and frees the model, its items and GPU resources.      |

### Advancing without drawing

A window nobody sees (a minimized control window, a hidden tab's view)
still has to keep its model moving: motions and their events,
expressions, physics, live lip sync, items, and the parameter values other
code reads. Drawing it each frame is wasted work. Two ways to skip it:

- **`view.drawing = false`:** the render loop, and `advance(seconds)`,
  advance without drawing until it is true again.
- **`view.advance(seconds, { draw: false })`:** one step without drawing,
  whatever `drawing` says.

Everything else in the frame happens: the clock, the model's and items'
update, `"frame"`, `"motionevent"` and `"motionend"` events, and promises
that wait for frames. The canvas keeps its last picture. `view.draw()`
draws the current state at once, without advancing; `screenshot()` draws
too. The picture is the same as drawing every frame would have given:

```ts
view.drawing = !document.hidden;
document.addEventListener("visibilitychange", () => {
  view.drawing = !document.hidden;
  if (view.drawing) view.draw();
});
```

Browsers stop `requestAnimationFrame` in hidden and minimized windows, so
a hidden view's loop doesn't run at all. To keep a model moving there,
drive it yourself (`autoStart: false`, or `stop()`) with a timer and
`advance(seconds, { draw: false })`.

### View coordinates

The view starts fitted: the model's canvas rectangle (`model.canvas`, in
model units) centered in the canvas, filling `fit` of it (0.95 by default)
along its limiting side. `viewTransform` is relative to that:

- `zoom`: scale factor of the fitted view (2 shows the model twice as large);
- `x`, `y`: the model point shown at the center of the canvas, as an offset
  from the center of the model's canvas rectangle, in model units, x to the
  right and y up in the model's own directions (they turn with the model).
  Positive `x` moves the model left on screen, positive `y` moves it down;
  `{ x: 0, y: 0 }` centers it;
- `rotation`: degrees the model is turned on screen, counterclockwise, about
  the center of the canvas;
- `pixelsPerUnit` (read only): CSS pixels one model unit spans on screen now.

`setView()` changes the fields it is given. For offsets in screen pixels,
use `panBy(dx, dy)` (CSS pixels, y down), or divide by `pixelsPerUnit`:
moving the model 100 CSS pixels right at rotation 0 is
`setView({ x: view.viewTransform.x - 100 / view.viewTransform.pixelsPerUnit })`.
Taps, hit tests, `toModel`, `toPage`, `lookAt`, pinch and wheel zoom,
panning and item dragging all follow the rotation. Under a rotated view, look targets follow
the pointer's position in the model's own space.

## A model on screen: `MochiModel`

| Member                                                     | Meaning                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                     | Path of the settings file inside its source.                                                                                    |
| `parameters`, `parts`                                      | `{ id, name, group?, min, max, default, blendShape }` and `{ id, name, defaultOpacity }`. Names come from the display-info file. |
| `motionGroups`, `expressions`, `hitAreas`                  | From the settings file.                                                                                                         |
| `files`                                                    | Files of the model folder (relative to the settings file), or undefined for URL sources.                                       |
| `getParameter(id)`                                         | A parameter's value in the latest frame: its base value with motions, expressions and effects (breath, physics, look…) applied. What is drawn. |
| `getParameterBase(id)`                                     | Its base value: what `setParameter` set, or what motions left in it (below). |
| `setParameter(id, value)`                                  | Sets a parameter's base value. It stays until changed, and motions, expressions and effects apply on top. It shows at the next frame; `model.runtime.update(0)` applies it at once (to read vertices or hit-test right after). Unknown IDs return false. |
| `setIdleWeight(id, weight)`, `getIdleWeight(id)`, `resetIdleWeights()` | How far the idle animation moves a parameter, 0–1 (below).                                                        |
| `physicsSettings`, `setPhysicsStrength(k)`, `physicsStrength`, `setPhysicsSettingStrength(id, k)`, `getPhysicsSettingStrength(id)`, `resetPhysicsStrengths()` | How strongly physics moves the parameters, for the model and per physics setting (below). |
| `setPhysicsWind(x, y)`, `physicsWind`, `setPhysicsSettingWind(id, k)`, `getPhysicsSettingWind(id)`, `resetPhysicsSettingWinds()` | The physics wind, changeable at any time, and how much of it each physics setting feels (below). |
| `setPhysicsRate(rate)`, `physicsRate`                      | The physics simulation rate, steps per second, instead of the file's (below).                                                   |
| `savePhysicsState()`, `restorePhysicsState(state)`         | A copy of the physics simulation's state, and continuing from one bit for bit (below).                                          |
| `setTint(meshId, rgba)`, `clearTint(meshId)`, `clearTints()`, `getTint(meshId)`, `tints` | Tints of art meshes (below).                                                                     |
| `resetParameters()`                                        | All base values back to their defaults.                                                                                         |
| `getPartOpacity(id)`, `setPartOpacity(id, value)`          | Part opacity.                                                                                                                   |
| `startMotion(group, index?, options?)`                     | A motion of a settings group (random when `index` is omitted), with the entry's fades and sound. Resolves to a `MotionPlayback`, or false when a motion of higher priority plays. |
| `startMotionFile(path, options?)`                          | A motion file by path, relative to the settings file; likewise.                                                                 |
| `stopMotions()`, `motions`                                 | Stop all (held ones included; their playbacks end with `"stopped"`); the playing motions.                                      |
| `setExpression(nameOrPath, fades?)`, `clearExpression(fades?)` | An expression by settings name or file path, replacing the current one; fade it out. `fades` overrides the fade times (below). |
| `addExpression(nameOrPath, fades?)`, `removeExpression(nameOrPath?, fades?)`, `addedExpressions` | Several expressions at once (below).                                                      |
| `physicsInputs`, `lookRouting()`                           | What physics overwrites and what drives it (below); which parameter look writes for each look target.                          |
| `canvas`                                                   | The model's canvas rectangle in model units: `{ left, right, bottom, top }` (the fitted view shows it).                        |
| `lookAt(x, y)`, `stopLooking()`                            | Look target in [−1, 1], x right and y up.                                                                                       |
| `speak(audio, { volume?, play? })`, `stopSpeaking()`       | Play a sound and move the mouth with it. Resolves when the sound ends.                                                          |
| `startLiveLipSync(options?)`, `stopLiveLipSync()`, `liveLipSync` | Move the mouth with the microphone or a `MediaStream` (below).                                                            |
| `effect(name)`, `effectAvailable(name)`, `setEffect(name, on)` | Switch `physics`, `eyeBlink`, `breath`, `look`, `idle`, `lipSync`, `pose` or `expressions`.                                 |
| `opacity`                                                  | The model opacity from its motions.                                                                                             |
| `textureNotice`, `warnings`                                | Downscaled textures; problems with optional files.                                                                              |
| `patch(patches)`, `replace(moc, version?)`                 | An editor's changes: new values in place, or other data keeping the textures and view ([Editing a shown model](#editing-a-shown-model)). |
| `runtime`                                                  | The underlying `ModelRuntime`, for advanced use (a new one after `replace`).                                                   |
| `dispose()`                                                | Removes the model from its view.                                                                                                |

`SpeakOptions`: `volume` (0–1, default 1), `play` (default true; false only
drives lip sync), `lipSyncFromDecodedAudio` (default true, see Audio below).

`MotionOptions`: `priority` (1 idle, 2 normal (default), 3 force), `loop`
(default false), `fadeIn` and `fadeOut` (override, used when ≥ 0), `weight`
(0–1), `sound` (start the entry's sound, default true), `hold` and
`blinkWhileHeld` (below).

Motions of the `Idle` group play by themselves when nothing else plays, at
priority 1.

**A motion's end.** `startMotion` resolves to a `MotionPlayback`:
`{ motion, group, index, ended }`, where `ended` is a promise of the
`MotionEnd` (`{ motion, group, index, reason, queueEmpty }`, as the
`motionend` event). Before 0.4.0, `startMotion` resolved to `true`; a
playback is truthy, so `if (await model.startMotion(…))` still works.

```ts
const playback = await model.startMotion("TapBody", 0);
if (playback) {
  const end = await playback.ended; // { reason: "finished" | "replaced" | "stopped", … }
}
```

**Holding the last frame.** With `hold: true`, a motion has no fade-out at
its end, and its last frame's values stay until `stopMotions()` or the next
motion, which fades it out with its own fade-out time. Its playback ends
(`"finished"`) when it reaches its last frame, and from then on it keeps no
priority, so the next start of any priority is accepted. While it holds,
idle motions do not start. Eye blink stays off while the motion plays, as
for any motion, and runs again once it is at its end; `blinkWhileHeld: false`
keeps it off while the motion holds. `hold` is ignored with `loop`. Not
reference behavior. (Without `hold`, the
values a motion leaves also stay after it ends, as in the frame procedure,
but its fade-out at the end stops them short of the last frame, and idle
motions take over.)

**Several expressions at once.** `addExpression(nameOrPath)` shows an
expression on top of the others, fading in with its file's fade-in time;
`removeExpression(nameOrPath)` fades it out with its file's fade-out time,
and `removeExpression()` removes every added one. Added expressions apply in
the order they were added, after the one of `setExpression` (which keeps
replacing), each with the file's blend: `Add` adds w·value, `Multiply`
multiplies by 1 + w·(value − 1), `Overwrite` moves the value toward the
file's by w, where w is the expression's fade weight. Adding one that is
already added resolves false. The `expressions` effect switch covers both.
Not reference behavior.

**Fade times per call.** Each of the four takes fade times in seconds
(`ExpressionFades`) that replace the expression file's for that call: 
`setExpression(name, { fadeIn, fadeOut })` and `addExpression(name, {
fadeIn, fadeOut })` for the expression they start (its fade-out is used when
it is later replaced, cleared or removed), `clearExpression({ fadeOut })`
and `removeExpression(name, { fadeOut })` for the fade-out they start
(`removeExpression(null, …)` for every added one). An absent time keeps the
file's (or the one given when the expression started); without the
argument nothing changes. 0 is at once. Negative, NaN and infinite times
throw a `RangeError`. Not reference behavior.

```ts
await model.setExpression("smile", { fadeIn: 0.2 }); // as a plugin asks
model.removeExpression(null, { fadeOut: 0 }); // every added one, at once
```

**Parameters that physics drives.** While physics runs, it overwrites some
parameters every frame: DeepSeek-chan's physics writes `ParamAngleX`,
`ParamAngleY`, `ParamAngleZ` and the body angles from `AngleX`, `AngleY`,
`PositionX` and others. Writing such a parameter (with `setParameter`, a
slider or head tracking) then has no visible effect. `physicsInputs` maps
each overwritten parameter to the model parameters that drive it, largest
weight first (`{ id, weight, type, reflect }`, weight in percent): write one
of those instead. `reflect` is the input's own `Reflect` flag in the physics
file. The overwritten parameter's output has a `Reflect` flag of its own,
which `physicsInputs` does not include.

```ts
const drivers = model.physicsInputs.get("ParamAngleX"); // [{ id: "AngleX", weight: 100, … }]
model.setParameter(drivers?.[0]?.id ?? "ParamAngleX", headYaw);
```

Look does this by itself: with `lookThroughPhysics` (on by default, see
below), look writes the largest-weight input instead of a target that physics
overwrites, and `lookRouting()` says which.

**Base values and what is drawn.** Each frame starts from the parameters'
base values, applies the motions (whose results the frame procedure keeps
in the base values, so they stay after a motion ends), then expressions and
effects (eye blink, breath, look, physics, lip sync) on top.
`getParameterBase(id)` reads the base value, and `getParameter(id)` the
frame's result. An editor shows and restores base values; restoring one from
`getParameter` would add an effect such as breath twice.

**Idle weights.** Tracking that writes base values with `setParameter`
loses to the idle animation, which applies on top. `setIdleWeight(id, w)`
keeps the idle animation off a parameter:

- The idle animation is every motion started at the idle priority (1): the
  settings' `Idle` group, and motions started with `priority: 1`.
- At weight 0 it leaves the parameter at its base value. At 1, the default,
  it applies as usual, bit for bit as without weights.
- In between, where a motion would move the parameter by f of the way from
  its current value v to its curve value c (f: the motion's fade weight),
  it moves it by f·w: v + (c − v)·f·w, stored as float32. With the base
  value written every frame (tracking), the frame shows base + (c −
  base)·f·w. A parameter that nothing writes keeps that result as its base
  value, so it moves on from there in the next frame, toward c.
- Other motions (one-shot motions, priority 2 and 3), expressions and
  effects are not affected, nor are part-opacity curves.
- Change the weight over a few frames to fade a handover. Weights are
  limited to [0, 1]; NaN throws a `RangeError`, and unknown IDs return false.

```ts
model.setIdleWeight("ParamAngleX", 0); // tracking drives the head
model.setParameter("ParamAngleX", trackedYaw); // every frame
```

**Tints.** `setTint(meshId, [r, g, b])` or `[r, g, b, a]` tints an art
mesh until `clearTint(meshId)` or `clearTints()`, through every frame and
pose (not reference behavior):

- r, g and b (each 0–2) multiply the mesh's drawn color, after its multiply
  and screen colors. Below 1 a tint darkens, and 1 changes no pixel. Above
  1 it brightens, as a light overlay does: the color is limited to 1
  (white) per channel, so 1.8 brings a mid-gray most of the way to white
  and leaves white white. The opacity is not changed by r, g and b. Tints
  of 1 or below draw exactly as before tints above 1 existed;
- a (0–1) multiplies its opacity (default 1);
- masks are drawn as before: a tinted mesh still clips the meshes it masks;
- values are limited to those ranges; a value that is not finite throws a
  `RangeError`, and an unknown ID returns false.

`getTint(meshId)` and `tints` (ID → `[r, g, b, a]`) read them back. Items
have the same methods, and `NodeRenderer` renders a runtime's tints (and
takes more in its `tints` option). `replace()` keeps them by ID.

**Textures updated in place.** `model.updateTexture(index, image, at?)`
replaces texture `index` (in the settings' order), or a region of it,
without reloading anything; the new pixels are drawn from the next frame
(not reference behavior). Items and Pixi sprites (`sprite.model`) have it
too.

```ts
// The whole texture, from a canvas the app draws into.
item.updateTexture(0, canvas);
// A region: 64 × 32 RGBA pixels whose top-left texel is (128, 256).
item.updateTexture(0, { width: 64, height: 32, data: rgba }, { x: 128, y: 256 });
```

- `image` is an `ImageBitmap`, a canvas, `ImageData`, an image element, or
  `{ width, height, data }` with RGBA8 rows from the top, all in straight
  (not premultiplied) alpha. Make ImageBitmaps with
  `premultiplyAlpha: "none"`: a premultiplied one would be premultiplied
  twice. A 2D canvas keeps its pixels premultiplied, so their colors come
  back rounded where alpha is low; pixel arrays and straight ImageBitmaps are
  exact.
- `at` (default `{ x: 0, y: 0 }`) is in texels from the top-left corner. The
  image must fit inside the texture as stored: `model.textures[index]`
  gives its `width` and `height` (and the file's, `originalWidth` and
  `originalHeight`: smaller when the texture budget downscaled it). Otherwise
  a `RangeError` is thrown and nothing changes.
- The pixels are prepared as at load: premultiplied exactly, and the mip
  levels recomputed by the same exact 2 × 2 rule, only over the region (each
  level's texels whose block covers it). The result is the texture that
  loading a file with the new pixels would give, texel for texel at every
  level.
- **Cost.** One upload of the image's pixels (4 bytes a texel), one
  premultiply pass over the region, and one pass per further mip level over
  the region's shrinking footprint: about 1⅓ times the region's texels in
  all, on the GPU. For a whole 2048 × 2048 texture that is a 16 MiB upload
  and about 5.6 million texels drawn; nothing is decoded or allocated except
  a temporary texture of the image's size, freed at once. A small region
  costs in proportion. No CPU work depends on the texture's size.

**Physics strength.** `setPhysicsStrength(k)` sets how strongly physics
moves the model's parameters (not reference behavior), and
`setPhysicsSettingStrength(id, k)` the same for one physics setting, by the
ID that `physicsSettings` lists with each setting's display name. A
setting's outputs use the model's strength times their setting's. Each
entry of `physicsSettings` (`PhysicsSettingInfo`) has the `id`, the `name`
and `named`: true when the physics file's dictionary names the setting
(`name` is then its name there, which may be empty), false when it doesn't
(`name` is then the ID).

- Each physics output moves its parameter from c, the value it has before
  the output is written (its base value with motions, expressions and the
  other effects), to r, the value the physics file's own rule gives. With
  strength k the parameter becomes c + (r − c)·k instead.
- At 0 physics leaves its parameters as they are: the frame is the one
  physics off would give. At 1, the default, it is the reference, bit for
  bit, however 1 is reached (0.5 for the model times 2 for a setting
  included). Above 1 it exaggerates, limited to each parameter's range.
- The simulation itself runs unchanged: inputs, gravity and wind act on the
  pendulums as before, so changing the strength never makes them jump. A
  setting whose input is another setting's output reads that output as
  written, scaled.
- Negative values are limited to 0; NaN and ±∞ throw a `RangeError`, and an
  unknown setting ID returns false. `getPhysicsSettingStrength(id)` is 1
  unless set, and `resetPhysicsStrengths()` sets everything back to 1.

**Wind.** `setPhysicsWind(x, y)` sets the physics wind: a force added to
every pendulum particle's, in the physics' own units (gravity is (0, −1)),
x to the right and y up. It is read at every physics step, so a change
takes effect from the next one; the frame after shows it, because a frame
draws the outputs between the last two steps. `physicsWind` reads it back:
(0, 0) unless set, or the `animation.wind` runtime option. Non-finite values
throw a `RangeError`.

**Wind per setting.** `setPhysicsSettingWind(id, multiplier)` sets how much
of the wind one physics setting feels (not reference behavior): its
pendulum particles get the wind times `multiplier` instead of the wind, at
every step and in the settle procedure. 1, the default, is the reference,
bit for bit; 0 shields the setting (long hair blowing, a stiff collar
still); 2 doubles the wind for it; a negative multiplier turns it around.
The wind is a force, so the setting's pendulums respond over the next steps
without jumping. Gravity, the inputs and the strengths are unaffected.
`getPhysicsSettingWind(id)` reads it back (1 unless set),
`physicsSettingWinds` holds those that are not 1, and
`resetPhysicsSettingWinds()` sets them back to 1 (the wind itself stays).
An unknown ID returns false; a non-finite multiplier throws a `RangeError`.

Items have the same methods, and `replace()` keeps the strengths and wind
multipliers (by setting ID) and the wind.

```ts
model.setPhysicsStrength(0.5); // calmer hair and clothes
model.setPhysicsSettingStrength("PhysicsSetting3", 0); // one setting off
model.setPhysicsWind(0.3, 0); // a breeze from the left
model.setPhysicsSettingWind("PhysicsSetting5", 0); // that setting feels none
```

**Physics rate.** `setPhysicsRate(rate)` sets how many simulation steps a
second the pendulums take, instead of the physics file's `Fps` (not
reference behavior): each frame's outputs are drawn between the last two
steps, as at the file's rate. 0 takes one step per frame, as long as the
frame. `setPhysicsRate(null)` goes back to the file's rate. `physicsRate`
reads the rate in use (0 without physics); the `physicsRate` runtime option
sets it at load. Values below 0, above 1000 or not finite throw a
`RangeError`. A change takes effect from the next frame without a jump, and
`replace()` keeps it. Higher rates cost more time per frame. A physics
file's own `Fps` is not limited, but no frame takes more than 10,000
steps (not reference behavior): beyond that, the frame's remaining time is
dropped, so a corrupt rate such as `1e308` can't stall the model. An
infinite `Fps` steps once per frame, as 0 does.

**Physics state.** `savePhysicsState()` returns a copy of the physics
simulation's state (null without physics): every pendulum particle's
position, velocity and last gravity direction, every output's last two
values, the step timing and the input values of the last step.
`restorePhysicsState(state)` puts the simulation back there: the next frame
continues exactly as the frame after the save did, bit for bit, on the
same model or another one with the same physics file, given the same
parameter values, frame lengths and physics options. The options (strength,
wind, rate) are not part of the state. For an editor that scrubs a
timeline with physics:

```ts
const states = new Map<number, PhysicsState>();
for (let frame = 0; frame < frames; frame++) {
  setTimelineParameters(model, frame);
  model.runtime.update(1 / 60);
  states.set(frame, model.savePhysicsState()!);
}
// Later: continue from frame 120.
model.restorePhysicsState(states.get(120)!);
```

A state from other physics settings throws a `RangeError`, as does
restoring one into a model without physics. The physics-driven parameters
show the restored state from the next frame; with `holdPhysicsInZeroSteps`
(a `MochiView`'s models), `update(0)` shows it at once. The state holds a
`Float64Array`; to store it, keep its bytes, since JSON turns −0 into 0.

**Physics while paused.** A frame that takes no time (a paused clock, or a
change applied with `update(0)`) runs no physics steps. The reference then
writes no physics outputs, so physics-driven parameters fall back to their
base values: hair snaps to its rest pose whenever something changes while
paused. A `MochiView` keeps them where they were instead, with its
`holdPhysicsWhenPaused` option (default true; not reference behavior); the
runtimes it shows are made with `holdPhysicsInZeroSteps` (below). Runtimes
made elsewhere, scenarios and conformance results keep the reference rule.

**Audio.** Browsers only play sound after a user gesture, so call `speak()`
from a click or tap handler. `audio` is a URL, `Blob`, `ArrayBuffer` or
`Uint8Array`. WAV files are analysed for lip sync exactly as the reference
does. Other formats the browser can decode (MP3, AAC, Ogg) are analysed from
the browser's decoded samples, which is a Mochi2D convenience: pass
`lipSyncFromDecodedAudio: false` to play them without lip sync.

## Lip sync from the microphone

```ts
micButton.onclick = async () => {
  try {
    const mic = await model.startLiveLipSync(); // the browser asks for the microphone
    mic.onstatechange = (state) => (micButton.dataset.state = state);
  } catch (e) {
    showMessage((e as Error).message); // a LiveAudioError: an insecure page, a denied permission…
  }
};
stopButton.onclick = () => model.stopLiveLipSync();
```

The mouth follows the microphone, or a `MediaStream` passed as `stream`: a
call, a `<video>`'s `captureStream()`, a Web Audio
`MediaStreamAudioDestinationNode`. Items have the same three members:
`item.startLiveLipSync()` moves only that item's mouth, and the main model
and other items keep their own. Live lip sync runs alongside `speak()`: both
values are added. It is not reference behavior (the reference analyses
sound files only), so it runs only when started. It belongs to the model:
loading another model into the view stops it, so start it again on the new
one. It survives a restored GPU context.

| Member                       | Meaning                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `startLiveLipSync(options?)` | Starts. Resolves with a `LiveLipSyncControl` once the input is set up; rejects with a `LiveAudioError`. Starting again replaces the previous one. |
| `stopLiveLipSync()`          | Stops (the same as `control.stop()`).                                                                                            |
| `liveLipSync`                | The running control, or null.                                                                                                    |

`LiveLipSyncOptions`:

| Option              | Default  | Meaning                                                                                                   |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `gain`              | 12       | The sensitivity: multiplies the loudness above the gate.                                                  |
| `gate`              | −45      | The noise gate in dBFS (an RMS level; a full-scale sine is −3 dBFS). Quieter frames give 0. `-Infinity`: none. |
| `attack`, `release` | 0.03, 0.12 | Time constants in seconds of the value rising and falling. 0: at once.                                  |
| `stream`            | none     | A stream to follow instead of the microphone. Mochi2D never stops its tracks.                            |
| `voiceProcessing`   | true     | For the microphone: the browser's echo cancellation, noise suppression and automatic gain control (live motion sync and `recordAudio` default to false). |
| `releaseWhenHidden` | true     | For the microphone: release it while the page is hidden (below).                                          |
| `tap`               | `"auto"` | How samples are taken: `"worklet"`, `"analyser"`, or `"auto"` (the worklet where it loads).              |
| `deviceId`          | none     | For the microphone: the input to open, from `navigator.mediaDevices.enumerateDevices()`, asked for exactly (a missing one rejects with `no-device`). |
| `mix`               | `"add"`  | How the value combines with the lip-sync parameters (below). Also `control.mix`.                         |

**The mapping.** Each frame takes the samples since the previous frame and:

1. measures their RMS, all channels pooled: the measure the reference uses
   for WAV files;
2. subtracts the gate level: max(0, RMS − gate). The value grows
   continuously above the gate, so it does not flicker there;
3. multiplies by the gain;
4. smooths: one step of a one-pole filter towards that target, with the
   attack time constant when rising and the release time constant when
   falling, stepped by the duration of the samples (so it does not depend
   on the frame rate);
5. adds the value, with weight 1, to the lip-sync parameters (the settings'
   `LipSync` group, or `ParamMouthOpenY`, see `lipSyncFallback`), limited to
   their range, as the WAV analysis does. Other `mix` modes combine it
   differently.

**Mixing.** In each frame the live value meets the lip-sync parameters'
value so far: their base value, motions, expressions, effects and a playing
sound. `mix` decides what is written: `"add"` (default) adds the live value;
`"replace"` writes it instead (silence closes the mouth even while a motion
opens it); `"max"` writes the larger of the two. A function
`(live, current, id) => value` receives the live value, the value so far and
the parameter ID, and returns the value to write (limited to the range; a
non-finite result leaves the parameter as it is), so an app can combine
both in the same frame. It runs every frame for every lip-sync parameter
and must not throw. `control.mix` changes the mode while it runs.

```ts
const mic = await model.startLiveLipSync({ deviceId, mix: "max" });
mic.mix = (live, current) => Math.max(live, 0.6 * current);
```

With `LIVE_LIP_SYNC_NEUTRAL` (gain 1, no gate, no smoothing) the value is
the WAV analysis of the live samples. Audio arrives in blocks that do not
line up with frames: a frame without new samples keeps the previous value,
and after 0.1 s without samples (suspended audio), frames count as silence.

**The defaults** (`LIVE_LIP_SYNC_DEFAULTS`, with voice processing on) are
for speech at arm's length. With voice processing, such speech gives frame
levels of about −35 to −15 dBFS. That is a value of about 0.15 at −35 dBFS,
0.5 at −26 dBFS and 1 (a 0–1 mouth fully open) from about −20 dBFS. A quiet
room stays below the −45 dBFS gate, so the mouth stays closed. To tune: if
the mouth barely opens, raise the gain; if it moves in silence, raise the
gate above the silent level (`control.level` is linear; in dBFS,
20·log10(level)).

`LiveLipSyncControl`:

| Member              | Meaning                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `settings`          | `{ gain, gate, attack, release }`. Change them at any time; they apply from the next frame.  |
| `state`             | `starting`, `running`, `suspended` (audio waits for a tap), `paused` (page hidden) or `stopped`. |
| `onstatechange`     | Called with each new state, last with `stopped`.                                              |
| `error`             | Why it stopped, if the microphone or stream failed (a `LiveAudioError`).                      |
| `level`, `value`    | The latest frame's RMS (linear) and the live value, before it is mixed.                       |
| `mix`               | How the value combines with the parameters; set it to change the mode.                       |
| `stream`, `label`   | The stream in use (null while released) and the microphone's name.                            |
| `tap`               | `"worklet"` or `"analyser"`: how samples are taken.                                           |
| `stop()`            | Stops. A shared microphone closes when nothing uses it.                                       |

**Errors.** `LiveAudioError.code` is `insecure-context`, `unsupported`,
`denied`, `blocked` (a permissions policy, e.g. an iframe without
`allow="microphone"`), `no-device`, `busy` (in use elsewhere), `ended`
(unplugged, or the permission withdrawn), `no-lip-sync` (the model has no
lip-sync parameter) or `failed`. The messages can be shown to people.
`liveAudioProblem()` returns the error the microphone would give on this
page, or null, without asking for it (to explain a disabled button).

**Platforms.**

- **Secure pages.** Browsers offer the microphone only on HTTPS pages and on
  `localhost`. A phone that opens a development server by its network
  address over plain HTTP (`http://192.168.1.20:5173/`) gets
  `insecure-context`. Serve the page over HTTPS instead: any HTTPS static
  host, or an HTTPS proxy in front of the server.
- **Gestures.** Call `startLiveLipSync()` from a click or tap handler: the
  browser asks for the permission, and the audio context is resumed while
  the gesture lasts. iOS Safari starts audio only in a gesture. If audio is
  suspended (state `suspended`: the autoplay rules, or an interruption such
  as a call or Siri), the next tap, click or key press anywhere on the page
  resumes it, and so does showing the page again.
- **Hidden pages.** The microphone is released while the page is hidden
  (state `paused`), so the browser's recording indicator goes off, and
  opened again when the page is visible. Browsers that keep the permission
  do not ask again; if reopening fails, the state becomes `stopped` with an
  `error`. This is the norm on phones, which stop or interrupt capture in
  the background anyway, and a hidden page draws nothing. With
  `releaseWhenHidden: false` the microphone stays open. A stream passed in
  is never stopped or released by Mochi2D.
- **Streaming setups.** When streaming software captures the page (a
  browser source, or a browser window that may be minimized or covered),
  pass `releaseWhenHidden: false`. Hiding the page then never closes the
  microphone, so there is no gap and no new permission prompt when it is
  shown again:

  ```ts
  await model.startLiveLipSync({ releaseWhenHidden: false });
  ```
- **Sharing.** A view's models and items share one microphone when their
  `voiceProcessing`, `releaseWhenHidden` and `tap` options match. Live
  motion sync defaults to `voiceProcessing: false` (below), so lip sync and
  motion sync running at once with the defaults open the microphone twice.
- **Taps.** By default an AudioWorklet counts every sample once. It loads
  its module from a `blob:` URL; under a Content Security Policy that
  refuses it, `"auto"` falls back to an AnalyserNode read each frame (the
  channels mixed to mono, the samples counted by the audio clock), and
  `tap: "analyser"` asks for it directly.

**Privacy.** Audio is processed in memory as it arrives: each block becomes
a sum of squares, each frame one loudness value, and the samples are then
dropped. Mochi2D never records, stores or sends audio anywhere.

**Without a view.** `LiveLipSync` (in `mochi2d` and `mochi2d/headless`) is
the mapping on its own: push samples with `push(channels)` (or
`pushSums(sumOfSquares, values, frames)`) and hand it to
`runtime.setLiveLipSync()`, for audio from any other source.

## Motion sync

Motion sync moves the mouth with a sound through a setting of the model's
`.motionsync3.json` file (named by `FileReferences.MotionSync` in its
`.model3.json`): each setting names the mouth parameters it drives, the
shape each audio element gives them (`Silence` and the vowels `A`, `I`,
`U`, `E`, `O`), and how the result is blended and smoothed.

**What Mochi2D does.** It reads the file and its links from the model
settings, and runs the processing around the analysis: the analysis
schedule (`SampleRate` ticks a second, at most one a frame), each
parameter's smoothing (`Smooth`, off by default) and dead band (`Damper`),
and where the values are written in the frame. The analysis itself (which
element the sound is, at each tick) is Mochi2D's own method, so its mouth
shapes are its own. The `AnalysisType` that editor-made files name is read
as it is; Mochi2D runs its own analysis for it.

```ts
// A motion whose settings entry has a Sound and a MotionSync setting: the view
// plays the sound and its analysis drives the mouth.
await model.startMotion("Talk", 0);

// Any sound (any format the browser decodes), through a setting:
await model.speak("hello.mp3", { motionSync: "Mouth basic" }); // or true: the first usable setting

// The microphone or a MediaStream:
const live = await model.startLiveMotionSync({ setting: "Mouth basic" }); // from a click or tap
model.onMotionSyncTick((t) => meter.update(t.level, t.weights)); // Silence, A, I, U, E, O
live.stop(); // the mouth settles to the Silence shape
```

| Member | Meaning |
| --- | --- |
| `motionSyncSettings` | The file's settings: `id`, `name` (the dictionary name motions use) and `usable` (false for an unknown analysis type). Empty without a file. |
| `speak(audio, { motionSync })` | Plays a sound with the mouth by motion sync instead of lip sync. Resolves when it has played. |
| `startLiveMotionSync(options?)`, `stopLiveMotionSync()`, `liveMotionSync` | Live motion sync from the microphone or `options.stream`, through `options.setting` (default the first usable one). The control has `state`, `error`, `tick`, `stream`, `label`, `tap` and `stop()`, like live lip sync's. Rejects with a `LiveAudioError` of code `"no-motion-sync"` for a model without a usable setting, and a RangeError for an unknown setting. |
| `motionSync` | The latest analysis, a `MotionSyncTick`: `setting` (`name`, `id`), `source` (`"sound"` or `"live"`), `level` (dBFS), `silent`, `weights` (the elements' weights after `Enabled` and `Scale`, summing to 1), `values` (the driven parameters' values written from it, by ID) and `time` (seconds of the sound). Null while nothing plays. |
| `onMotionSyncTick(listener)` | Calls `listener(tick)` at every analysis; returns a function that removes it. |
| `voiceProfile`, `setVoiceProfile(profile)` | The voice profile the analysis uses (below), or null for the neutral voice. |

Items have `startLiveMotionSync`, `stopLiveMotionSync`, `liveMotionSync`,
`motionSync`, `voiceProfile` and `setVoiceProfile` too.

**Voice processing.** Live motion sync opens the microphone with
`voiceProcessing: false` by default: the browser's noise suppression changes
the vowels' spectra, which the analysis compares, while lip sync only
follows the loudness (and defaults to true). `view.recordAudio` defaults to
false too, so calibration hears the voice as motion sync does. Pass
`voiceProcessing: true` when echo (speakers near the microphone, a call)
or steady noise (a fan) moves the mouth more than the processing changes
the vowels; calibrate with the same setting.

**How a sound plays.** A motion's linked sound starts with the motion and
plays once, even when the motion loops. The mouth follows the audio clock
of its playback, and the analysis looks ahead to the sample being heard, so
the mouth is not late. When the sound ends, the mouth is fed silence until
every driven parameter is within its `Damper` of the Silence shape, or for
0.5 s, and then motion sync stops writing: the parameters show what the
motions give them again. A motion stopped early (replaced, or faded out)
fades its sound's analysis out over its fade-out time first. Only the
setting bound to the playing sound writes. A sound bound to another setting
starts that setting from the parameters' current values; consecutive sounds
on one setting carry its state over, so the mouth stays continuous.

**Where it writes.** After lip sync and before pose: physics (which runs before) sees the motions' mouth values, and a
mouth parameter that physics also writes is overwritten. The animation
option `motionSync: { beforePhysics: true }` runs it before physics
instead, so that mouth-driven physics (lip wobble) reacts to speech. Lip
sync of the model's `LipSync` group leaves the parameters that motion sync
drives. `setEffect("motionSync", false)` turns it off.

**Mochi2D's analysis.** Each tick analyses 32 ms of the sound, mixed to
mono and resampled to 16 kHz. A window quieter than the gate (−50 dBFS) is
silence; louder, the vowels take a weight that grows with the level (up to
6 dB below the sound's typical voiced level) and with how voiced the window
is (noise is not), shared by how close its spectrum (20 mel bands from 100
to 4000 Hz) lies to each vowel's templates, after noise masking. Silence
takes the rest. Then, per setting: `Enabled` and `Scale` (limited to
[0.1, 10]), normalization, the blend (`BlendRatio` 0 takes the most likely
element's shape, 1 blends the shapes by weight), the shape, and a smoothing
that limits how fast each value moves, towards a shape at its attack rate
and back at its release rate (`Smoothing` 1 gives a full swing in 20 ms,
100 in 0.5 s). The file's per-parameter `Smooth` is a further, fixed linear
filter, off by default since 0.20.0: the analysis's own smoothing above
shapes the motion, and the file's dead band (`Damper`) still applies. Pass
`fileSmoothing: true` in the runtime's `animation.motionSync` options (a
view's `runtime` option, which its items share, or `ModelRuntime.load`) for the file's
`Smooth` too, as before 0.20.0.

**Voice calibration.** The neutral templates come from a synthetic voice
in four sizes. A profile of one voice reads it better:

```ts
import { VoiceCalibration, voiceProfileFromJson } from "mochi2d";

const cal = new VoiceCalibration("Aiko");
for (const vowel of ["A", "I", "U", "E", "O"] as const) {
  await prompt(`Say "${vowel}" for a second`);
  const clip = await view.recordAudio(1.2); // from a click or tap; mono samples
  cal.add(vowel, clip.channels, clip.sampleRate);
}
const room = await view.recordAudio(1); // optional: a moment of the room's silence
cal.add("Silence", room.channels, room.sampleRate);
model.setVoiceProfile(cal.profile());
localStorage.voice = JSON.stringify(cal.profile()); // save; load with voiceProfileFromJson(JSON.parse(…))
```

A profile holds each vowel's spectrum, the voice's typical level and, with
a Silence recording, the room's noise level (the gate then sits 6 dB above
it). `view.recordAudio(seconds, options?)` records up to 60 s of the
microphone (or `options.stream`), mixed to mono, without voice processing
unless `voiceProcessing: true`; the clip is only handed back.

**Limits.**

- The analysis is approximate. On clean synthetic vowels (male and female
  voices, with or without calibration) its strongest element is right every
  time, and with noise 20 dB below the voice at least 85 % of the time (a
  female U reads partly as E). Real voices vary more; calibration helps.
- Consonants are not recognized: the mouth shows the nearest vowel, partly
  closed by their lower voicing.
- Hard-clipped audio reads poorly (clipping flattens the spectrum), and
  audio quieter than the gate is silence.
- Live input waits for its first 32 ms window, so the mouth moves within
  about 50 ms of the sound; sound files are analysed ahead and line up
  within a frame.

**Without a view.** `ModelRuntime` has `motionSyncSettings`,
`startMotionSync(sound, { setting?, clock? })` (WAV bytes or decoded
channels; `clock` returns the playback position in seconds, else the
frames' steps count), `setMotionSyncInput(input, setting?)` (an object with
`sampleRate` and `read()`, returning the mono samples captured since the
previous call; null ends it), `stopMotionSync(fade?)`, `motionSync`,
`motionSyncSource`, `onMotionSyncTick`, `voiceProfile` and
`setVoiceProfile`. A `RuntimeOptions.onSound` callback that returns a
function gives the motion sounds' playback clock. `mochi2d/headless` also
exports the parts: `parseMotionSync`, `writeMotionSync` (see
[Model data](#model-data)), `MotionSyncDriver`, `SettingEngine`,
`ParameterFilter`, `TickClock`, `VowelAnalyzer`, `VoiceCalibration`,
`decodeMotionSyncWav` and a vowel synthesizer (`synthesizeVowel`).

## Items over a model: `MochiItem`

An item is a further model placed over the main model, such as a hat or a
prop in the hand. It animates on its own (physics, breath, motions, expressions)
and is drawn in front of the main model, behind it, or between its art
meshes, whole or in two parts. It can be pinned to the main model, so it
moves with the body.

```ts
const model = await view.load("models/my-model/my-model.model3.json");
const hat = await view.addItem("models/hat/hat.model3.json", {
  placement: { scale: 0.8, front: true },
});
hat.place({ x: 0.1, y: 0.35, rotation: -10 }); // main-model units, degrees
hat.pinToModel(); // follows the body from now on
```

`view.addItem(input, { settings?, placement?, id? })` takes the same inputs as
`view.load()` and needs a loaded model. `item.id` names the item in the view:
the `id` given (unique in the view; a duplicate is an error), or
`<settings path>#<n>`, n counting items with the same settings path from 1
(the smallest free number), so items added in the same order get the same
ids again. `view.item(id)` finds one. The single-model API is unchanged:
`view.model` is still the main model, and loading another main model keeps
the items, releasing their pins.

**Placement** (`item.placement`, `item.place({...})`):

| Field                | Meaning                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `x`, `y`             | Where the item's anchor sits, in the main model's units (y up). Default: the main canvas center.     |
| `scale`              | Main-model canvas pixels per item canvas pixel. Default 1: the item keeps its own pixel size.        |
| `rotation`           | Degrees, counterclockwise, about the anchor. Default 0.                                              |
| `anchorX`, `anchorY` | The anchor in the item's canvas: (0, 0) top-left, (1, 1) bottom-right. Default (0.5, 0.5).           |
| `front`              | Drawn in front of the main model (default) or behind it.                                             |
| `mirror`             | Flipped horizontally: the item's left and right swapped about its anchor, before the rotation. Default false. |
| `layer`              | `{ above: meshId }` or `{ below: meshId }`: drawn at that place in the main model's render order instead (below). Null or absent: `front` decides. |
| `split`              | `{ mesh, back }`: drawn in two parts (below). Null or absent: drawn whole.                           |

Each item is drawn into its own offscreen image at about its size on screen,
which is then drawn as one quad. The reference renderer and the conformance
tools stay single-model.

**Between the main model's art meshes** (not reference behavior). An item
can be drawn at a place in the main model's render order: just above or
just below one of its art meshes, wherever the main model's draw order puts
that art mesh in the frame, and whether or not it is visible.

```ts
hat.layer = { below: "ArtMesh_Bangs" }; // under the bangs, over the rest of the head
hat.layer = { above: "ArtMesh_Body" };
hat.layer = "front";                     // or "behind": the whole model again
```

`item.layer` is `"front"`, `"behind"`, `{ above: meshId }` or
`{ below: meshId }`; setting an art mesh the main model does not have
throws a RangeError. The item is drawn into whatever that art mesh is drawn
into: inside an offscreen of the main model (version 6 files), it is
composited with the offscreen's opacity, colors, blending and mask. Clipping
masks stay per drawable: the main model's masks do not clip the item, and
the item's do not clip the main model. Several items at one place are drawn
in item order (`raise()` puts one on top). `view.items` lists the items in
that order, and `raise()` moves an item to its end. A saved place whose art
mesh the main model lacks (another main model was loaded) draws the item
per `front`. Setting `front` (or `place({ front })` without `layer`) draws
the item in front of or behind the whole model again.

**Split items.** `item.split = { mesh, back }` draws an item in two passes:
its art mesh `mesh` and every drawable after it in the item's render order
form the front part, drawn at `item.layer`; the drawables before it form the
back part, drawn at `back` (`"front"`, `"behind"` or a mesh place). The back
part is never in front of the front part: a `back` place in front of the
front part's stands for the front part's place, the back part then just
below the front part. For a scarf around the neck:

```ts
scarf.layer = { above: "ArtMesh_Neck" };
scarf.split = { mesh: "ScarfFront", back: { below: "ArtMesh_Neck" } };
```

An offscreen of the item that the split crosses is composited in each part.
Setting a `mesh` the item does not have, or a `back` art mesh the main model
does not have, throws a RangeError; a saved split whose mesh the item lacks
draws the item whole. `split = null` draws it whole again. Hit tests
(`view.itemAt`) take items in drawing order: front items, then items at
places from the top of the main model's render order, then behind items,
each at its front part's place.

**Mirroring.** `item.mirror = true` (or `place({ mirror: true })`) flips an
item about its anchor. Drawing, hit tests (`view.itemAt`), dragging and pins
all use the same flipped map, so a pinned item stays pinned and follows the
main model mirrored. A mirrored item gets the main model's `ParamAngleX`
and `ParamAngleZ` negated (`ParamAngleY` as it is), so it turns with the
main model on screen. The multipliers and shifts of its item settings then
apply as for any item: target = multiplier · (−angle) + shift. Layouts save
`mirror`; layouts saved before 0.7.0 have none (false).

**Pinning.** `item.pinToModel()` records the point under the item's anchor:
the topmost visible drawable of the main model there, a triangle of it and
the point's barycentric coordinates. Drawables whose texture is transparent
at that point, or whose clipping masks hide it there, are skipped. Every
frame the item's anchor follows that point, and its rotation follows the
triangle's rotation since pinning (the best-fit rotation of the triangle's
three vertices). `item.pin` tells where it is pinned; `item.unpin()` keeps
the current placement. Changing a pinned item's position or rotation with
`place()` unpins it first.

**Head angles.** When the item's folder has a `.vtube.json` with an
`ItemSettings` object (`item.settings`), the main model's `ParamAngleX`,
`ParamAngleY` and `ParamAngleZ` are fed to the item's parameters of the
same names every frame. Each value is multiplied by `Multiplier_HeadAngle*`,
shifted by `Shift_HeadAngle*` (missing values: 1 and 0), and smoothed. The
smoothing is Mochi2D's choice: a first-order low-pass filter with a time
constant of `Smoothing_HeadAngle*` hundredths of a second (15 → 0.15 s),
independent of the frame rate; 0 means none. Items without `ItemSettings`
get no forwarded inputs. `OnlyMoveWhenPinned` and `AllowNormalHotkeyTriggers`
are read (`item.settings`) but have no effect. `item.headAngles` holds the
values last fed.

| Member                                                     | Meaning                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `id`, `name`, `settings`, `runtime`                        | Its id in the view; settings path; `ItemSettings` or null; the item's runtime. |
| `placement`, `place(p)`, `front`, `opacity`, `visible`, `raise()` | Where and how it is drawn; hidden items do not animate.           |
| `pin`, `pinToModel()`, `unpin()`, `headAngles`             | Pinning and forwarded head angles.                                       |
| `parameters`, `parts`, `getParameter`, `getParameterBase`, `setParameter`, `resetParameters`, `getPartOpacity`, `setPartOpacity` | As for `MochiModel`. |
| `mirror`                                                   | Flipped horizontally about its anchor (above).                           |
| `layer`, `split`                                           | A place in the main model's render order, and split items (above).       |
| `setIdleWeight`, `getIdleWeight`, `resetIdleWeights`, `setTint`, `clearTint`, `clearTints`, `getTint`, `tints` | As for `MochiModel`. |
| `motionGroups`, `startMotion`, `startMotionFile`, `stopMotions`, `expressions`, `setExpression`, `clearExpression`, `addExpression`, `removeExpression` | As for `MochiModel`. |
| `exportLayout()`, `applyLayout(entry)`                     | This item's layout entry, and applying one (from any item) to it.       |
| `effect`, `effectAvailable`, `setEffect`                   | As for `MochiModel`.                                                    |
| `startLiveLipSync(options?)`, `stopLiveLipSync()`, `liveLipSync` | As for `MochiModel`: only this item's mouth follows the microphone or stream. |
| `dispose()`                                                | Removes the item and frees its GPU resources.                            |

**Layouts.** `view.exportItemLayout()` returns Mochi2D's own JSON layout
(`format: "mochi2d-item-layout/1"`): for each item, its `id`, settings path
(`name`), placement (with `layer` and `split` when set; layouts saved
before 0.10.0 have neither, so their items are drawn whole per `front`),
opacity, visibility and pin (drawable ID, triangle, weights). A malformed
`layer` or `split` makes `applyItemLayout` throw a TypeError before it
changes anything. `view.applyItemLayout(layout)` applies one to the loaded items: it
matches entries to items by id first, then the rest by settings path in
order (layouts saved before 0.4.0 have no ids, and those saved before the
rename, `lively2d-item-layout/1`, are read too), and returns how many it
placed. So copies of the same item keep their own places. A pin is restored
when the main model has that drawable and triangle; the rotation then counts
from the main model's current pose. The entries come in drawing order, and
applying a layout restores it: the placed items are drawn in the entries'
order, above the items the layout doesn't place, which keep theirs. For one
item, `item.exportLayout()` gives its entry and `item.applyLayout(entry)`
applies an entry to it; it returns false when the entry's pin could not be
restored.

## Editing a shown model

An editor changes a model and shows the result without loading it again.

**Value patches.** `model.patch(patches)` writes new values into the loaded
model: one `ValuePatch` or a list of them, each `{ group, field?, start,
values }`. It names an array of the model's [`MocData`](moc-data.md), the
first element to replace and the new values. The next frame evaluates with
them (`model.runtime.update(0)` applies them at once), and the result is the
same as loading data with those values: with either evaluation kernel, and
with or without incremental evaluation. The patchable arrays
(`PATCHABLE_FIELDS`):

| `group`                           | `field`                                           | Holds                                                    |
| --------------------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `keyformPositions`                | (none)                                            | keyform positions of art meshes and warp grids (x, y pairs) |
| `artMeshKeyforms`                 | `opacity`, `drawOrder`                            | art-mesh keyforms                                        |
| `warpKeyforms`                    | `opacity`                                         | warp keyforms                                            |
| `rotationKeyforms`                | `opacity`, `angle`, `originX`, `originY`, `scale` | rotation keyforms                                        |
| `partKeyforms`                    | `drawOrder`                                       | part keyforms                                            |
| `offscreenKeyforms`               | `opacity`                                         | offscreen keyforms (version 6)                           |
| `glueKeyforms`                    | `intensity`                                       | glue keyforms                                            |
| `glueInfo`                        | `weight`                                          | glue weights (a vertex of A, then of B, for each pair)   |
| `multiplyColors`, `screenColors`  | `r`, `g`, `b`                                     | color entries                                            |

Blend-shape keyforms are entries of the same arrays and are patched the
same way.

```ts
// Move vertex 2 of the first keyform of an art mesh (data from readMoc).
const at = data.artMeshKeyforms.firstPosition[data.artMeshes.firstKeyform[mesh]] + 2 * 2;
model.patch({ group: "keyformPositions", start: at, values: [x, y] });
```

- A patch of another array, outside its array, with a value that is not a
  number, or with an opacity that is NaN or ±∞ (which `loadMoc` rejects)
  throws a `TypeError` or `RangeError`, and nothing of the list is applied.
- Values are stored as float32, as the file stores them.
- A patch changes the loaded model, which all its `ModelInstance`s share:
  they all see it at their next evaluation.
- It does not change a file or a `MocData` you hold. Keep your data in step
  for saving (`writeMoc`).
- `ModelRuntime.patch` and `ModelInstance.patch` are the same without a
  view.

On DeepSeek-chan (720 art meshes, 509 parameters, 301 warps), a drag frame
(a patch of one vertex, warp grid point, opacity or rotation angle, then an
evaluation) took 0.5–1.6 ms in Node with either kernel. A model's first
patch also builds an index of what reads each value (6–23 ms).

**Other data.** Structural edits (a vertex, a binding or a key added)
cannot be patches. `await model.replace(moc, version?)` shows other data
for the same model: `.moc3` bytes (`Uint8Array` or `ArrayBuffer`), or
`MocData` with its `version`, as `mocModelFromData` takes them. It keeps:

- the textures, which are not decoded or uploaded again;
- the view (zoom, offset and rotation);
- the parameter base values, part opacities, idle weights, tints and effect
  switches, matched by ID (values of IDs the new data lacks are dropped; new
  IDs start at their defaults);
- a live lip-sync input, and the motion, expression and sound files already
  read;
- items pinned to an art mesh, while the mesh (by ID) has the pinned
  triangle with the same vertices. Other pinned items are released where
  they are.

Motions, expressions and speech stop (motions end with `"stopped"`). It
resolves once the new data is shown. If the data does not load, it rejects
with the errors of `loadMoc` or `mocModelFromData`, and the current data
stays. A call that a later one overtakes (or that ends after `dispose()`)
rejects with an `AbortError` and shows nothing, so the latest data wins.
Afterwards `model.runtime` is a new `ModelRuntime`: listeners added with
`runtime.onMotionEnd` do not carry over (the view's `motionend` events do).
Art meshes whose texture index the settings do not list are not drawn.

Without a view, `runtime.withData(moc, version?)` (or `withModel(model)`,
with a model from `loadMoc` or `mocModelFromData`) returns a new
`ModelRuntime` for the other data, with the same settings, files and options
and the state listed above. The runtime it came from is unchanged. A
runtime from `withData` serves its data as the settings' `.moc3`, so
`NodeRenderer` draws it; one from `withModel` holds a built model that no
file holds, and `NodeRenderer` refuses it (use `withData`).

#### Model data in place of a `.moc3`

Editors that hold the model as `MocData` load and render it without writing
a stand-in `.moc3` (experimental):

```ts
// The settings, textures, physics and motions from the source; the model from the data.
const runtime = await ModelRuntime.load(source, "model.model3.json", {
  moc: { data, version: 6 }, // or the .moc3 bytes
});
const { png } = await renderer.render(runtime, { width: 512 });
const edited = await runtime.withData(nextData, 6); // renders too
await view.load(url, { moc: { data, version: 6 } });
```

- `moc` is `MocInput`: `.moc3` bytes, or `{ data, version }`, written with
  `writeMoc`. Data it refuses rejects with its `MocWriteError`; bytes the
  loader rejects, with `MocFormatError`.
- The runtime's `source` serves the bytes at the settings' `Moc` path; every
  other file comes from the source.
- `runtime.modelSource` says where the model comes from: `"file"` (the
  source's `.moc3`), `"data"` (`moc`, or `withData`) or `"model"`
  (`withModel`). `NodeRenderer` draws `"file"` and `"data"` runtimes.
- Repeated `withData` calls each build on the original source, so old data
  is not kept alive by the new runtime.

The browser bundle (`mochi2d`) exports `mocModelFromData`, `readMoc`,
`writeMoc` and the `MocData` types too.

**The pose and the motion groups.** `runtime.animator.setPose(file)`
replaces the pose with another `PoseFile` (as `parsePose` reads one; null
for none). The new pose sets the parts up on its next frame, as at load;
whether the pose effect is on stays as it is. Group starts and idle
playback read the settings' motion list (`runtime.settings.motions`) when a
motion starts, so an editor that changes the list in place changes what
plays next: `animator.idleCount` follows the `Idle` group's length.

## In a PixiJS scene: `mochi2d/pixi`

```ts
import { Application } from "pixi.js";
import { MochiSprite } from "mochi2d/pixi";

const app = new Application();
await app.init({ width: 800, height: 600 });
document.body.append(app.canvas);

const chan = await MochiSprite.from("models/chan/chan.model3.json", {
  renderer: app.renderer,
  ticker: app.ticker,
});
chan.scale.set(0.1);
chan.position.set(400, 50);
app.stage.addChild(chan);
chan.on("hit", (e) => chan.model.startMotion("TapBody"));
await chan.model.setExpression("smile", { fadeIn: 0.2 });
```

`MochiSprite` is a Pixi v8 container that shows a model. It sits in the
scene graph like any display object: its position, scale, rotation, skew,
pivot, alpha, tint, blend mode, mask, filters, visibility and drawing order
are Pixi's, and so are its bounds and its pointer events. PixiJS (MIT) is a
peer dependency: `npm install pixi.js` (8.12 or later; the tests run on
8.22). The core entry points don't use it, and `mochi2d/pixi` imports it
without bundling it. `mochi2d/pixi` also exports everything `mochi2d` does,
so a Pixi app imports all of Mochi2D from it and has one copy.

**How it draws.** Before each Pixi frame, the sprite draws the model with
Mochi2D's renderer into a texture of Pixi's, on the Pixi renderer's own
WebGL 2 context, and hands the context back to Pixi
(`renderer.resetState()`). Pixi then draws that texture as it draws a
sprite's. So the model is one picture in the scene: the sprite's alpha
fades the whole model, and overlapping art meshes don't show through each
other, as with a Pixi filter's alpha. This differs from Pixi's own
containers, whose alpha multiplies each child's separately, so that their
overlapping children show through each other as they fade. The picture is redrawn only when
the model changed or the sprite's size on screen changed. Its resolution
follows the sprite's scale on screen (times the renderer's resolution) in
steps of an eighth of an octave, up to `maxTextureSize`. At a scale that
puts the texture's pixels on the canvas's pixels, the picture is
identical, value for value, to `MochiView`'s at the same framing.

With a WebGPU renderer, Mochi2D's WebGL renderer can't share the device:
the sprite draws in a WebGL 2 context of its own and gives the picture to
Pixi as a canvas texture, which Pixi uploads when the model changed
(`context: "own"`, which a WebGL renderer can use too). The upload
un- and re-premultiplies the colors, so values may differ by a level.

**Local coordinates** are the model's canvas in pixels, as for a sprite of
the model's art at full size: (0, 0) is the canvas's top-left corner, x
right, y down, and the canvas is `canvasWidth` × `canvasHeight`. Scale the
sprite down to fit (`chan.scale.set(480 / chan.canvasHeight)`), and set
`pivot` to place it by another point (`chan.pivot.set(chan.canvasWidth / 2,
chan.canvasHeight)` for the bottom center).

### `MochiSprite.from(input, options)`

Loads a model, as `MochiView.load` does (a URL of the settings file or a
zip, a `File`/`FileList`, `{ files }`, or a `FileSource`), and resolves to
the sprite, not yet in the scene. Options:

| Option            | Default                     | Meaning |
| ----------------- | --------------------------- | ------- |
| `renderer`        | (required)                  | The Pixi renderer it is drawn with (`app.renderer`). |
| `ticker`          | `Ticker.shared`             | The ticker that advances the animation (`app.ticker`), or null to call `update(seconds)` yourself. |
| `settings`        |                             | Which settings file, when the input holds several. |
| `archive`         | `DEFAULT_ARCHIVE_LIMITS`    | Caps on what a zip input may inflate to ([Loading](#loading)). |
| `textures`        | `DEFAULT_TEXTURE_LIMITS`    | Caps on what the model's textures may declare ([Loading](#loading)). |
| `files`           | `DEFAULT_FILE_LIMITS`       | Caps on the files read from a folder, a URL or picked files ([Loading](#loading)). |
| `sounds`          | WAV only                    | `{ compressed: true }` lets a trusted model's compressed motion sounds play ([Loading](#loading)). |
| `context`         | `"shared"` (WebGL 2), else `"own"` | Where the model is drawn (above). |
| `look`            | `"follow"`                  | The eyes and head follow the pointer over the canvas (`globalpointermove`), or `"off"`. |
| `hitArea`         | `"meshes"`                  | What Pixi counts as the sprite for pointer events: the boxes of the visible art meshes, or `"canvas"` (the canvas rectangle, through the picture's bounds). |
| `resolution`      | the renderer's              | Texture pixels per screen pixel. |
| `maxTextureSize`  | 4096 (or the GPU's limit)   | The texture's largest side. |
| `padding`         | 0                           | Room around the canvas, in local units, for models that reach outside it. |
| `masks`           | `"atlas"`                   | `"atlas"`, `"atlas-fine"` or `"reference"`, as for `MochiView`. |
| `textureBudget`   | `"auto"`                    | As for `MochiView`. |
| `runtime`         |                             | The runtime's options (`RuntimeOptions`). |
| `container`       |                             | Pixi `ContainerOptions` (position, scale, label, …). |

### Members

| Member | |
| ------ | --- |
| `model` | The model's API, a `MochiModel`: parameters, parts, motions, expressions (with fade times), look, lip sync and motion sync, physics, tints, effects, `replace()`. As [above](#a-model-on-screen-mochimodel). |
| `canvasWidth`, `canvasHeight` | The model's canvas in pixels: the sprite's local size. |
| `update(seconds)` | Advances the animation and evaluates the model (the ticker calls it). |
| `setTicker(ticker \| null)` | Changes the ticker. |
| `toModel(global)`, `localToModel(x, y)` | A point in Pixi's global (stage) or the sprite's local coordinates, in model units (x right, y up). |
| `hitTest(global)` | The hit areas at a global point (names, or IDs without a name). |
| `meshAtPoint(global)` | The topmost visible art mesh whose box holds the point, or null. |
| `lookAtPoint(global)` | Look at a global point: the canvas center is the origin and the canvas's shorter side spans [−1, 1]. `model.lookAt(x, y)` and `model.stopLooking()` take the target directly. |
| `destroy()` | Removes the sprite, disposes the model and frees its GPU resources. |

**Events.** Besides Pixi's (`pointertap`, `pointerover`, …, with
`eventMode` `"static"` by default), the sprite emits `"hit"` on a tap over
hit areas (`{ areas, x, y, event }`, the hit areas' names as in the
view's `TapEvent`, the point in model units and Pixi's
`FederatedPointerEvent`), `"motionevent"` (`{ value }`) and
`"motionend"` (as `ModelRuntime.onMotionEnd`), `"contextrestored"` and
`"error"` (below).

**A lost WebGL context.** When Pixi's context is lost and restored, Pixi
rebuilds its own objects and tells its systems (the `contextChange`
runner); the sprite then loads its textures and renderer again on the
restored context, with the same runtime, as `MochiView` does: the
animation, parameters, expressions and motions carry on. It draws nothing
until that is done, then emits `"contextrestored"` (`"error"` with
`{ error }` if loading failed). A sprite with its own context does the same
when that context comes back.

**Not here (yet).** Items (`MochiItem`) belong to `MochiView`; in a Pixi
scene, another model is another sprite, ordered and placed by Pixi.

## Without a browser: `ModelRuntime`

```ts
import { loadModelFromDisk } from "mochi2d/node";

const model = await loadModelFromDisk("models/my-model/my-model.model3.json"); // or a folder or a .zip
await model.startMotion("Idle", 0);
for (let i = 0; i < 60; i++) model.update(1 / 60); // animate and evaluate one frame each
const vertices = model.instance.drawableVertices; // per drawable: x, y pairs in model units
```

`ModelRuntime.load(source, settingsPath?, options?)` (the options below, and
`moc`: [model data in place of a `.moc3`](#model-data-in-place-of-a-moc3))
loads from any `FileSource`: `MemoryFileSource`, `sourceFromZip(label, bytes, limits?)`, or in Node
`sourceFromFolder(dir)` and `sourceFromZipFile(path, limits?)` (named
`folderSource` and `zipFileSource` before 0.16.0). It has the same parameter,
part, motion, expression, look and effect methods as `MochiModel`
(`physicsInputs`, `addExpression`, `onMotionEnd` included), plus:

| Member                                        | Meaning                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `update(dt)`                                  | One frame: animate, then evaluate if a value changed. Returns the frame's result, or null for a zero step with nothing changed. `update(0)` applies changed values and patches at once. |
| `animate(dt)`, `evaluate()`                   | The two halves of `update`.                                                                    |
| `instance`                                    | The evaluated model: `drawableVertices`, `drawableOpacity`, `drawableVisible`, `drawableRenderOrder`, …  |
| `hitAreasAt(x, y)`, `drawableAt(x, y)`, `hitAreaBounds()`, `drawableBounds(id)` | Hit tests in model units (y up).            |
| `deformers`, `mapPoints(deformer, points, options?)` | The deformers (`id`, `kind`, `parent`), and the forward mapping through one (below). |
| `patch(patches)`, `withData(moc, version?)`, `withModel(model)` | Value patches, and a new runtime for other data ([Editing a shown model](#editing-a-shown-model)). |
| `getParameterBase`, `setIdleWeight`, `getIdleWeight`, `idleWeights`, `resetIdleWeights` | Base values and idle weights, as for `MochiModel`.                                        |
| `physicsSettings`, `setPhysicsStrength`, `physicsStrength`, `setPhysicsSettingStrength`, `getPhysicsSettingStrength`, `physicsSettingStrengths`, `resetPhysicsStrengths`, `setPhysicsWind`, `physicsWind`, `setPhysicsSettingWind`, `getPhysicsSettingWind`, `physicsSettingWinds`, `resetPhysicsSettingWinds` | Physics strength and wind, as for `MochiModel`; `physicsSettingStrengths` and `physicsSettingWinds` hold those that are not 1, by setting ID. |
| `setPhysicsRate`, `physicsRate`, `savePhysicsState`, `restorePhysicsState` | The physics rate and state, as for `MochiModel`.                                     |
| `loadOptions`                                 | The `loadMoc` options this runtime loads files with (from `strictDrawOrders`, `nonFiniteOpacity` and `offscreenKeyformRange`). |
| `setTint`, `clearTint`, `clearTints`, `getTint`, `tints`, `drawableTints`, `activeTints`, `tintVersion` | Tints, as for `MochiModel`; for renderers, the RGBA array per drawable (null from `activeTints` without tints) and a counter that changes with them. |
| `startLipSync(sound)`, `startLipSyncWav(bytes)` | Lip sync from a decoded or WAV sound.                                                      |
| `setLiveLipSync(source, mix?)`, `liveLipSync`, `liveLipSyncMix` | A live lip-sync input (a `LiveLipSync`, or any object with `next(dt)`): its value is combined with the lip-sync parameters every frame by `mix` (default `"add"`, alongside a sound). Null removes it. |
| `startMotionSync`, `setMotionSyncInput`, `stopMotionSync`, `motionSync`, `motionSyncSource`, `onMotionSyncTick`, `motionSyncSettings`, `voiceProfile`, `setVoiceProfile` | Motion sync ([Motion sync](#motion-sync)). |
| `onMotionEnd(listener)`                       | Calls `listener(end)` for every motion that ends (a `MotionEnd`, as the view's `motionend`); returns a function that removes it. |
| `physicsDriven`                               | For each parameter physics overwrites, its largest-weight input (`physicsInputs` has them all). |
| `loadMotion(path)`, `loadExpression(path)`, `playMotion(motion)`, `playExpression(expression)` | Parsed files, cached.              |
| `animator`, `settings`, `model`, `bundle`     | The frame procedure, the parsed settings and `.moc3`, and the optional files.                  |

`RuntimeOptions`:

- `animation`: options of the frame procedure: `random` (a function
  returning numbers in [0, 1), for repeatable blinks and idle choices),
  `gravity`, `wind`, `settle`, `wrap`, `eyeBlink` timing.
- `lookThroughPhysics` (default true): when physics overwrites a look
  target (DeepSeek-chan drives `ParamAngleX` from `AngleX`), look writes the
  physics input instead, so looking stays visible with physics on. This is
  a convenience, not reference behavior. `physicsInputs` gives the same
  knowledge to apps: every parameter physics overwrites, with the inputs that
  drive it (see "Parameters that physics drives" above), and `lookRouting()`
  says which parameter look writes for each target.
- `lipSyncFallback` (default `"ParamMouthOpenY"`, or false): the parameter
  lip sync drives when the settings list no `LipSync` parameters. Also a
  convenience.
- `stopClearsPriority` (default true): `stopMotions()` also clears the
  current priority, so the next start is always accepted. The frame
  procedure itself keeps the priority after a stop (C19). A convenience.
- `strictDrawOrders` (default false): reject files whose keyform draw
  orders lie outside their draw-order group's range (as reported: truncated
  with the tolerance of 0.001, so 499.9995 lies inside a range from 500), for
  validation tooling. By default such files load, as in the official runtime, with a
  warning per object in `warnings` that names the object and its group's
  range; the keys stay as they are, and drawables are drawn in the order of
  their evaluated draw orders. The viewer shows these warnings as a notice.
- `nonFiniteOpacity` (default `"reject"`): `"load"` loads files whose
  keyform opacities are NaN or ±∞, as the official runtime does (see
  Loading and validation below). `NodeRenderer` draws such a runtime with
  the same option.
- `offscreenKeyformRange` (default `"reject"`): `"load"` loads version-6
  files whose part keyforms hold an offscreen keyform index that is neither
  −1 nor valid, as the official runtime does, reading it as −1 (see Loading
  and validation below).
- `holdPhysicsInZeroSteps` (default false): in frames that take no time,
  write the last physics outputs again (not reference behavior; see
  "Physics while paused"). `MochiView` turns it on for its models and items
  unless its `holdPhysicsWhenPaused` option is false.
- `physicsRate`: the physics simulation rate, steps per second, instead of
  the physics file's `Fps` (not reference behavior; see "Physics rate").
- `onSound(path, bytes)`: called when an accepted motion has a sound, so the
  host can play it.
- `evaluation` (experimental): evaluation stages to leave out (below).

### Evaluating without glue or blend shapes

The `evaluation` option (experimental) of `ModelInstance`
(`new ModelInstance(model, { evaluation })`) and of `RuntimeOptions` (so
also a view's `runtime` option, which its items share) switches two
evaluation stages off: `glue: false` skips the glue pass, so glued meshes
keep the positions their own keyforms and deformers give them, and
`blendShapes: false` ignores every blend-shape keyform binding, as if the
file had none. Both default to true, and with both on the results are the
same as without the option, bit for bit, with either kernel. A model that
uses glue or blend shapes then evaluates and draws without them.

```ts
const runtime = await ModelRuntime.load(source, settings, {
  evaluation: { glue: false, blendShapes: false },
});
```

### Mapping points through a deformer

`mapPoints(deformer, points, options?)` is the forward mapping at the
latest evaluation: it maps `points` (x, y pairs) from a deformer's input
space to model units, through the deformer's world form and so through its
ancestors, exactly as the evaluator maps the vertices of the deformer's
child meshes, outside a warp's grid too. A warp's input space is its
normalized grid (0 to 1 inside it); a rotation's is its local space.
`deformer` is a deformer ID, or null for no deformer (the points are then
already in model space). `deformers` lists them, in file order, with their
kind and parent.

```ts
const { points, jacobians } = model.mapPoints("Warp12", [0.5, 0.5, 1.2, -0.3], {
  jacobian: true,
});
// points: Float32Array of x, y pairs in model units (y up);
// jacobians: Float64Array, per point ∂x/∂px, ∂x/∂py, ∂y/∂px, ∂y/∂py
```

Options: `space` (`"model"`, the default: model units with y up, as
`instance.drawableVertices` and the hit tests have them; `"keyform"`: the
y-down space keyform positions are stored in) and `jacobian` (default
false). The Jacobian is analytic per region of the mapping (a warp cell, or
one of its two triangles; the band around the grid; the affine extension
far outside; a rotation's s·R(θ) with its mirror flags), so it is exact
within a region; on a boundary between regions it is that of the region the
point belongs to. A mesh's interpolated keyform positions map bit for bit
onto its `drawableVertices` (before glue) through its parent deformer. In a browser, a `MochiModel` maps through
`model.runtime.mapPoints(…)`. `ModelInstance` has the same mapping by
deformer index: `instance.mapPoints(d, points, space?)` and
`instance.mapJacobians(d, points, space?)`, with −1 for no deformer.

### Conveniences and their defaults

Mochi2D follows the reference behavior except for these conveniences. Each
can be switched on or off on its own:

| Convenience | Where | Default | Reference behavior when switched off |
| --- | --- | --- | --- |
| Look writes the physics input when physics overwrites the look target | `RuntimeOptions.lookThroughPhysics` | on | look writes the target, physics overwrites it |
| Lip sync drives `ParamMouthOpenY` when the settings list no `LipSync` parameters | `RuntimeOptions.lipSyncFallback` | `"ParamMouthOpenY"` | `false`: no lip sync without `LipSync` parameters |
| `stopMotions()` clears the current priority | `RuntimeOptions.stopClearsPriority` | on | the priority is kept (C19) |
| Lip sync from the browser's decoded samples for non-WAV sounds | `SpeakOptions.lipSyncFromDecodedAudio` | on | only WAV files (3s.1) drive lip sync |
| Textures scaled down to a memory budget, with a notice | `ViewOptions.textureBudget` | `"auto"` | `"full"`: full resolution (reference renders fail with TextureTooLarge instead) |
| Clipping masks in a shared atlas | `ViewOptions.masks` | `"atlas"` | `"reference"`: one mask per masked drawable at 4096 |
| Only active mask meshes drawn into masks | `ViewOptions.maskMeshes` | `"active"` | `"all"`: every mask mesh of a group (reference renders, C13) |
| Physics-driven parameters keep their physics values in frames that take no time | `ViewOptions.holdPhysicsWhenPaused` (`RuntimeOptions.holdPhysicsInZeroSteps`) | on in views, off in runtimes | no physics outputs in such frames (3n.3): the parameters show their base values |

The viewer (`npm run viewer`) starts with these defaults (its panels change the mask
setting).

`ModelRuntime.update()` and the views evaluate the model only on frames
where a parameter or part opacity changed. Two kinds of inactive art mesh
change at every evaluation of the reference, even with unchanged inputs:
glued meshes (C4) and meshes with blend shapes, whose blend-shape offsets
accumulate (C29). While a model holds still, Mochi2D does not evaluate, so
these accumulate less. Call `runtime.instance.evaluate()` yourself to
evaluate on every frame. Such meshes are not drawn, except as clipping masks.
Conformance tools (`npm run conformance`, `npm run render`) never use a
convenience: they use the reference configuration of the test catalog.

Lower-level building blocks (`loadMoc`, `ModelInstance`, `Animator`,
`parseMotion`, `parseExpression`, `parsePhysics`, `decodeWav`,
`runAnimationScenario`, …) are exported from `mochi2d/headless` as well.

**Motions as written.** `parseMotion(text)` resolves the file's values
(missing or negative fades become 1). Beside them, `motion.loop` is
`Meta.Loop` (missing: false; playback doesn't read it, since looping is
chosen when a motion starts), and `motion.written` (experimental) has the
file's values as written: `meta`, a copy of the `Meta` object with only the
keys the file has, and `curves`, each curve's `FadeInTime` and
`FadeOutTime` (as `fadeIn`, `fadeOut`) where the curve has them. An
importer can tell a missing fade from a written 1.

**What the loaders throw.** For a damaged or unsupported file, each loader
throws only its own error class (fuzzed, see `docs/architecture.md`):

| Loader | Error |
| --- | --- |
| `loadMoc`, `readMoc`, `validateMoc` (a file it can't read) | `MocFormatError` |
| `writeMoc` | `MocWriteError` |
| `parseModelSettings` | `SettingsFormatError` |
| `parseMotion`, `parseExpression`, `parsePhysics`, `parsePose`, `parseDisplayInfo`, `parseUserData`, `parseMotionSync` | `AnimationFormatError` |
| zip sources (`sourceFromZip`, `ZipFileSource`, a damaged entry when it is read) | `ZipFormatError`; RAR and 7z archives `UnsupportedArchiveError`; past a cap, `ArchiveLimitError` |
| a model's textures (`view.load`, `view.addItem`, `MochiSprite.from`, `NodeRenderer.render`; `readTextureHeader`) | `TextureFormatError`; past a cap, `TextureLimitError` |
| folder, URL and picked-file sources, a file past a cap (also through `NodeRenderer.render`) | `FileLimitError` |
| `decodeWav` | `WavFormatError` |
| `decodeMotionSyncWav` (also refuses sample rates outside 1–768 kHz) | `MotionSyncAudioError` |
| file sources, a path that is not there | `FileNotFoundError` |

`ModelRuntime.load` rejects with `MocFormatError`, `SettingsFormatError`
or `FileNotFoundError` for the `.moc3` file or the settings; a damaged
motion, expression, physics or other file only gives a warning.

**In-memory files.** A model package built in memory (an export to
preview) loads without touching the disk:

```ts
import { ModelRuntime, MemoryFileSource } from "mochi2d/headless";

const source = MemoryFileSource.fromFiles({
  "キャラ/キャラ.model3.json": settingsJson, // text is stored as UTF-8
  "キャラ/キャラ.moc3": mocBytes, // Uint8Array or ArrayBuffer
  "キャラ/表情/笑顔.exp3.json": expressionJson,
});
const model = await ModelRuntime.load(source); // the shallowest *.model3.json
```

`MemoryFileSource.fromFiles(files, label?)` takes a record or a `Map` from
path to bytes, `ArrayBuffer` or text; `new MemoryFileSource(label, entries)`
and `source.set(path, bytes)` take bytes. Paths are relative, with `/` (a
`\` counts as `/`), and may hold any Unicode characters, spaces and `%`
(they are never URL-decoded). A path that is not found as given is looked up
in Unicode normalization form C, so a precomposed reference (NFC, as JSON
files usually have) finds a decomposed name (NFD, as macOS gives file
names), and the other way round. In the browser, `view.load({ files })` does
the same.

### Rendering to PNG from Node

`NodeRenderer` (in `mochi2d/node`) renders models to PNG with the reference
renderer, the one `npm run render` uses: the built render harness
(`dist/web/harness.html`, part of the package) in headless Chromium with
software WebGL. The browser stays open between renders, offline: it loads
only the harness and the model's files from a local server.

```ts
import { NodeRenderer, loadModelFromDisk } from "mochi2d/node";

const renderer = await NodeRenderer.open();
const model = await loadModelFromDisk("models/my-model/my-model.model3.json");
model.setParameter("ParamAngleX", 20);
model.update(1 / 60);
const { png, pixelsPerUnit, center } = await renderer.render(model, { width: 512, height: 512 });
const preview = await renderer.render(model, { width: 512, height: 512, fast: true });
await renderer.close();
```

Playwright is an optional peer dependency: install it to render
(`npm install playwright`, then `npx playwright install chromium`). Without
it, `NodeRenderer.open()` rejects with a message that says what to install;
everything else in `mochi2d/node` works. `NodeRenderer.open(options)` takes
`executablePath` (a Chromium to use), `playwright` (the module, or where to
load it from) and `webDir` (a built web folder other than the package's).

`renderer.render(input, options)` renders a `ModelRuntime` at its current
pose (its parameter values, part opacities and tints, and its own model
data after `withData` or the `moc` load option; a runtime from `withModel`
is refused), a `*.model3.json`
file, folder or `.zip` on disk, or `{ source, settings? }` (any
`FileSource`, an in-memory one included) at its default pose. Options:
`width`, `height` (default 1024), `parameters` and `partOpacities` (over the
runtime's values or the defaults), `tints` (art-mesh ID → `[r, g, b]` or
`[r, g, b, a]`, over the runtime's; IDs the model lacks are skipped with a
note), `background` (straight RGBA, 0–1; default transparent),
`view` (`{ x, y, pixelsPerUnit }`: the model point at the image center and
the scale; default the canvas fitted in), `alpha` (`"straight"`, the default,
or `"premultiplied"`), `nonFiniteOpacity` (for a path or source: `"load"`
draws a file whose keyform opacities are NaN or ±∞; a runtime is drawn with
its own option), `files` (caps on the files read for a path, default
`DEFAULT_FILE_LIMITS`), `textures` (caps on what the textures may declare, default
`DEFAULT_TEXTURE_LIMITS`; past one it rejects with `TextureLimitError`) and
`fast`. It resolves to `{ png, width, height,
pixelsPerUnit, center, reference, renderer, notes }`. Renders run one at a
time; concurrent calls wait their turn. A source's files are read once and
kept while the renderer is open (`renderer.forget(source)` drops them).
`renderToPng(input, options)` opens, renders and closes in one call.

**Fast previews.** `fast: true` (or `{ maxTextureSize }`, default 1024) is
not the reference render: textures are downscaled so that no side exceeds
`maxTextureSize`, and masks use the viewer's mask atlas instead of
per-drawable 4096 × 4096 buffers. It is much quicker for large models;
`reference` is false and `notes` says so.

### Loading and validation

`loadMoc` (and every loader built on it) checks a `.moc3` file before it
evaluates anything, and throws a `MocFormatError` naming the problem. It
rejects everything the official consistency check rejects, including
sections that are not in slot order. It also rejects, by the format's
rules, the nonsensical cases the official check lets
through (indices out of range, a part or deformer that is its own or a later
parent, triangle indices ≥ the vertex count, unsorted keys, min > max, …).
Duplicate IDs, a default outside its range and a zero `pixelsPerUnit` load.

Beyond those required rejections, **big-endian files are the one deliberate
difference from the official check.** A file whose endianness byte is set
and whose data is correctly byte-swapped evaluates exactly like the
little-endian file. The official check rejects such files; Mochi2D keeps
loading them. A set endianness byte on data that is not swapped is still
rejected.

Files whose keyform draw orders lie outside their draw-order group's range
pass both checks. Mochi2D adds a warning for each such object and draws
them in the order of their evaluated draw orders (`strictDrawOrders` above
rejects them instead, for validation tooling).

Every part keyform of a version-6 file holds an offscreen keyform index,
normal and blend-shape keyforms alike, of any part: it must be −1 or a
valid index, at both validator levels (the official check rejects anything
else). Only a normal keyform's index is read: −1 there gives the offscreen
opacity 0 and multiply and screen colors 0, and blend-shape keyforms'
indices are never read. The official runtime loads files with an index out
of range all the same; `loadMoc(bytes, { offscreenKeyformRange: "load" })`
(or the runtime option of that name) does too, reading such an index as −1
with a line in `loadWarnings` (the values there are unspecified, so this
is a choice, not a match).

Keyform opacities that are NaN or ±∞ pass the official check, but no
genuine file has one, so `loadMoc` rejects them. `loadMoc(bytes,
{ nonFiniteOpacity: "load" })` (or the runtime option of that name) loads
them, as the official runtime does: Mochi2D then reports a NaN opacity as
NaN and counts the drawable as visible.

The renderer draws every drawable whose opacity is not 0, negative, NaN and
infinite ones too, and clamps at fixed points. With the
compatible blends (normal, the legacy additive and multiplicative flags,
and the compatible codes in layers), the source color and alpha are
clamped to [0, 1] before blending, NaN becoming 0, and the opacity is not
clamped before the product: a negative or NaN opacity changes nothing, and
+∞ saturates every channel above 0. The advanced codes compute with the
unclamped source alpha and clamp the result as it is stored: a negative
opacity brightens the destination under multiply, overlay, darken and
atop (by 1 − opacity, where the formula's B(0, d) is 0), and NaN or ±∞
erases the pixel. An offscreen composite with an advanced code covers its
whole parent layer, so a non-finite offscreen opacity erases all of it.

### Model data

`readMoc`, `writeMoc` and `validateMoc` work on a `.moc3` file's contents
as plain arrays (`MocData`) without building an evaluator: for editors and
exporters, and for checking files. `mocModelFromData(data, version)` builds
the model from such data directly, for fast previews; it copies the data,
so later changes to the arrays do not reach the model (use patches for
that). See [moc-data.md](moc-data.md). They are in the browser bundle too.

```ts
import { readMoc, writeMoc, validateMoc } from "mochi2d/headless";

const { data, version } = readMoc(bytes);
const { valid, diagnostics } = validateMoc(data, { version, level: "strict" });
const out = writeMoc(data, { version }); // byte for byte the same as a genuine original;
// it throws MocWriteError for data that fails validateMoc's official level
const model = mocModelFromData(data, version); // = loadMoc(writeMoc(data, { version }))
const instance = new ModelInstance(model);
```

**Physics files.** `parsePhysics(text)` reads a `.physics3.json` file into
plain data (`PhysicsFile`: the rate, the settings with their inputs,
outputs, particles and normalization, the display names, and the file's
`EffectiveForces`, which the simulation does not use), and
`writePhysics(file, { indent? })` writes such data back as text. Parsing
the text gives the data back; keys come in the usual order, indented with
tabs, and the Meta totals are counted from the arrays, so a file written in
that layout comes back byte for byte (DeepSeek-chan's does). Data without
forces gets gravity (0, −1) and wind (0, 0). A number JSON cannot hold
(NaN, ±∞) or a type other than `"X"`, `"Y"` and `"Angle"` throws a
`RangeError` that says where. Both are in the browser bundle too.

```ts
import { parsePhysics, writePhysics } from "mochi2d/headless";

const physics = parsePhysics(text);
physics.settings[0]!.particles[1]!.delay = 0.8;
const out = writePhysics(physics);
```

**Motion-sync files.** `parseMotionSync(text)` reads a `.motionsync3.json`
file (`MotionSyncFile`: the version and the settings, each with its
elements, driven parameters, audio parameters and post-processing), and
`writeMotionSync({ version?, settings }, { indent? })` writes settings back
as text. Parsing the text gives the same settings back. `Meta` (the count,
and the dictionary of IDs and names) is made from the settings, each
element's shape is written as its mapping, keys come in the format's order,
and the text is indented with tabs; `version` defaults to 1. Values outside
the format's ranges are written as given (the reader limits them, with a
warning). A number JSON cannot hold (NaN, ±∞), a shape whose size doesn't
match the elements and driven parameters, or an ID used twice among a
setting's elements or driven parameters throws a `RangeError` that says
where. The settings `parseMotionSync` returns can be passed as they are:
what the reader works out (`index`, `usable`, each element's `known`) is
ignored.

```ts
import { parseMotionSync, writeMotionSync } from "mochi2d/headless";

const sync = parseMotionSync(text);
sync.settings[0]!.blendRatio = 0.5;
const out = writeMotionSync(sync);
```

## Conformance results

`scenarioResult(model, scenario, options?)` runs a scenario on a model and
returns its result object, the same object `npm run conformance` writes (the
result contract of the conformance tools: `mochi2d-result/0`, `mochi2d-sequence-result/0`
or `mochi2d-anim-result/0`).

```ts
import { scenarioResult, formatResultJson } from "mochi2d/headless";
import { resultModelFromDisk } from "mochi2d/node";

const model = await resultModelFromDisk("models/my-model/my-model.model3.json");
const result = scenarioResult(model, {
  format: "mochi2d-scenario/0",
  id: "pose",
  parameters: { ParamAngleX: 10 },
});
formatResultJson(result); // as written to pose.result.json
```

- **`model`.** `{ moc, settings?, read? }`. `moc` is the `.moc3`'s bytes (for
  example straight from `writeMoc`) or a model from `loadMoc`. `settings`
  (bytes, text or parsed) and `read(path)` (the model's other files, relative
  to the settings file) are needed by animation scenarios that use motions,
  expressions, physics or sounds. `resultModelFromSource(source,
  settingsPath?)` and, in Node, `resultModelFromDisk(path)` build it from a
  model's files.
- **`scenario`.** A parsed scenario object. Its `model` member is not needed.
- **`options`.** `producer` (default `mochi2d@<version>`) and
  `strictDrawOrders`.
- **Errors.** It never throws for bad input. As in the contract, a malformed
  scenario gives an `InvalidScenario` error in the result, and a `.moc3`
  that does not load a `ModelLoadError`.
- **Output.** `formatResultJson(result)` prints it as the CLI does. Pass
  `"double"` as the third argument for animation results:
  `formatResultJson(result, "  ", "double")`.

## Examples

- `examples/embed/index.html`: a page that embeds a model, with taps,
  motions, expressions, lip sync and a Microphone button. Run `npm run build:lib` and
  `npm run example:embed`, then open the printed URL. It shows DeepSeek-chan
  from `assets/models/DeepSeek/` (see the README), or `?model=<URL>`.
- `examples/pixi/index.html`: a model in a PixiJS scene, swaying and fading
  in a container behind a Pixi frame, with taps, motions and expressions.
  Run `npm run build:lib` and `npm run example:pixi`, then open the printed
  URL (it takes PixiJS from `node_modules/`).
- `examples/node/evaluate.mjs`: headless evaluation in Node. Run
  `npm run build:lib` and `npm run example:node` (or `node
  examples/node/evaluate.mjs <model> [motion] --seconds 3 --out result.json`).

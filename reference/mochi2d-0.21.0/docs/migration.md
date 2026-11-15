# Migrating from 0.x

This page covers every rename and removal since 0.10.0, and the behavior
changes that may need a change in your code. Everything else since then
was added without breaking callers: see `CHANGELOG.md`.

## Names

| Old name | Replaced by | Renamed in | Old name removed in |
| --- | --- | --- | --- |
| `folderSource(dir)` | `sourceFromFolder(dir)` | 0.16.0 | 0.19.0 |
| `zipFileSource(path)` | `sourceFromZipFile(path)` | 0.16.0 | 0.19.0 |
| `NodeDirSource` | `NodeFileSource` | 0.16.0 | 0.19.0 |
| `BrowserFilesSource` | `BrowserFileSource` | 0.16.0 | 0.19.0 |
| `SettingsError` | `SettingsFormatError` | 0.16.0 | 0.19.0 |
| `MochiHitEvent.hitAreas` | `MochiHitEvent.areas` | 0.16.0 | 0.19.0 |

- **Errors by name:** `SettingsFormatError`'s `name` is
  `"SettingsFormatError"` since 0.16.0. Code that compares
  `error.name === "SettingsError"` needs the new string. `instanceof`
  works with the new class.
- **The sprite's hit event:** `sprite.on("hit", (e) => e.areas)` holds the
  same list `hitAreas` held, under the field name the view's `TapEvent`
  uses.

## Behavior

### 0.20.0

- **Motion sync** no longer applies the motion-sync file's per-parameter
  `Smooth` by default. Pass `fileSmoothing: true` for the old behavior:
  - in `ModelRuntime.load(source, settings, { animation: { motionSync:
    { fileSmoothing: true } } })`;
  - in a view's `runtime` option, which its items share;
  - with `fileSmoothing: true` in the agent API's `load_model`;
  - with `--file-smoothing` on the command line.

  The analysis's own smoothing and the file's dead band (`Damper`) are
  unchanged.

### 0.18.0

- **A masked offscreen layer** looks its mask up through the inverse view
  matrix (rule I, `docs/rendering.md`). Renders with such layers change by
  one level in a few pixels.
- **`MochiView.advance(seconds)`** is unchanged. `advance(seconds,
  { draw: false })`, `view.drawing` and `view.draw()` are new.

### 0.17.0

- **Renders** change by one level in some pixels, toward the official
  renderer: texture v flipped twice in float32, mask coordinates through
  float32 matrices, layers read through a filtered quad. Pixel hashes of
  0.16.0's images don't match any more; regenerate them.

### 0.16.0

- **The loaders' errors.** Each loader throws only its documented errors
  (the table in `docs/api.md`, "What the loaders throw"):
  - **Zip:** a damaged zip throws `ZipFormatError` where fflate's own
    `Error` escaped before. An entry claiming more than deflate can produce
    is refused before it is read.
  - **`decodeWav`:** 0 bits per sample throws `WavFormatError` (it was a
    `RangeError`).
  - **`decodeMotionSyncWav`:** refuses sample rates outside 1–768 kHz with
    `MotionSyncAudioError`.
- **Physics:** a frame takes at most 10,000 internal physics steps, and an
  infinite `Fps` steps once per frame. Only corrupt rates reach this.
- **`MochiSpriteEvents.motionend`** is typed as `MotionEnd`: `motion`, not
  `path`. The event always carried `motion`; only the type was wrong.

### 0.14.0

- **Evaluation** uses one fixed float32 order of operations. Results
  change in their last bits: vertices by up to 1.3·10⁻⁵, a few opacities
  by up to 3·10⁻⁸. Stored results and hashes from 0.13.0 or earlier don't
  match bit for bit; the judge still passes them.
- **Tints** take r, g and b up to 2. Values above 1, clamped before,
  brighten now.

### 0.13.0

- **The viewer** asks before opening another model while changes are not
  exported. The library's API only gained additions.

### 0.12.0

- **`view.items`** follows the drawing order: `item.raise()` moves an item
  to the end. `exportItemLayout()` lists items in that order, and
  `applyItemLayout()` restores it.
- **`Animator.idleCount`** (experimental) follows the settings' `Idle`
  group as it is now.

### 0.11.0

- **The viewer's controls moved** into its menus and resource tree. The
  library's API and the viewer's URL parameters are unchanged.

### 0.10.0

- **Validation:**
  - a part keyform's offscreen keyform index may be −1 on an
    offscreen-owning part's normal keyform. That gives the offscreen
    opacity 0 and colors 0; it was refused before;
  - blend-shape keyforms' indices aren't read.
- **Mip levels** of textures whose sizes are not powers of two are built
  by Mochi2D's own rule, not the GPU driver's. Minified renders of such
  textures change slightly.
- **Live motion sync and `recordAudio`** open the microphone without the
  browser's voice processing. Pass `voiceProcessing: true` for the old
  behavior. Live lip sync keeps it on.

## Stability

`docs/api-stability.md` marks every export stable or experimental.
`docs/versioning.md` says what a release may change in each. Exports that
became stable in 0.19.0:

- the items (`MochiItem` and its option and layout types);
- the framing helpers (`frameImage`, `imagePosition`, `outputPosition`,
  `Framing`).

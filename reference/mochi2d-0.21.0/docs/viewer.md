# The Mochi2D viewer

The viewer opens a model, animates it and lets you look inside it:
parameters, parts, motions, expressions, physics, pose, lip sync, hit tests
and the model file itself. It works on desktop browsers and on phones
(Safari and Chrome).

## Running it

| Command                                   | What you get                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                             | The viewer with hot reload at http://localhost:5173/. Models from `assets/models/` (for example DeepSeek-chan in `assets/models/DeepSeek/`, see the README) appear in **File › Models…**. |
| `npm run build` then `npm run viewer`     | The built viewer at http://127.0.0.1:5174/, with the same Models menu.                                           |
| `npm run viewer -- --host 0.0.0.0`        | The same, reachable from other devices on your network (open `http://<this computer's address>:5174/` on a phone). |
| `npm run build:static`                    | A self-contained copy in `dist/viewer/` for any static file server (below).                                      |

WebGL2 is required (any current desktop browser, Safari 15 or later on
iPhone and iPad).

## The window

The window has a menu bar and four areas:

| Area                    | Where (desktop)     | What it holds                                                                                        |
| ----------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| **Menu area**           | left                | one panel at a time, chosen from its drop-down: **Parameters**, **Parts**, **Items** or **Lip sync** |
| **Model view**          | middle              | the model, with the frame rate and the motions' events over it, and the stage bar below              |
| **Resources**           | right, top          | the resource tree: everything loaded for the model                                                   |
| **Settings**            | right, bottom       | the settings of the item selected in Resources                                                       |

On a phone the model view has the screen. **☰ Panels** opens the three other
areas as a sheet over the model, one at a time: its tabs **Panel**,
**Resources** and **Settings** choose which. Picking a file in Resources
shows its settings.

## Menus

- **File**: **Open folder…**, **Open zip…**, **Add files…**, **Load URL**,
  **Models…**, **Open recent**, **New expression…** and **New pose**
  (below), and **Export** (Ctrl+S).
- **Edit**: **Reset parameters**, **Stop motions**, and **Compare two .moc3
  files…**.
- **Display**: **Hit areas** (outlines of the settings' hit areas),
  **Mipmapping**, **Transparent background**, **Background color**,
  **Frame rate** and **Events** (the displays over the model), **Masks**,
  **Textures** (below), and **Screenshot** (a PNG of the view).
- **Animation**: the model's features, each on or off: **Expressions**,
  **Automatic blinking**, **Physics**, **Pose switching**, **Motion sync**,
  **Idle motion**, **Cursor tracking**, **Breathing**, **Parameter
  repetition** (repeating parameters wrap around their range) and **Lip
  sync** (by volume). A feature the model has no data for is greyed out.

Escape or a click elsewhere closes a menu.

## Opening a model

- **File › Open folder…** picks a model folder (desktop browsers).
- **File › Open zip…** opens a `.zip` of a model folder. Use this on iPhone
  and iPad: Safari cannot open folders, but it can open a zip from the Files
  app. File names written in Chinese, Japanese or Korean code pages open
  too. RAR and 7z archives are not supported: extract them, then open the
  folder.
- **File › Load URL** opens the URL of a `*.model3.json` file or of a
  `.zip`. The server must allow the request (same origin, or CORS).
- **File › Models…** lists the models in `models/index.json` next to the
  page: the development servers list `assets/models/`, and a static build
  lists the folders copied into it.
- **File › Open recent** lists the last models opened by URL or from the
  Models list. A folder or zip opened from your disk can't be reopened by
  the page, so it isn't listed.
- Dropping a folder or a zip on the page opens it (desktop). Dropping two
  `.moc3` files compares them. Dropping motion, expression or WAV files adds
  them to the open model, as **File › Add files…** does.
- `?model=<path or URL>` opens a model when the page loads: a path from the
  Models list (`?model=DeepSeek/大肥鱼.model3.json`) or a URL.

## Resources

The resource tree lists the model settings file and, under it, the `.moc3`
file, the textures, the physics, the motions by group, the expressions, the
pose, the user data, the motion-sync settings and the display information.
Motions and expressions in the folder that the settings don't name are
listed too: expressions after the named ones, motions in a **Not in the
settings** group (or directly under **Motions** when the settings have no
groups).

| Input                          | Effect                                      |
| ------------------------------ | ------------------------------------------- |
| click                          | select: its settings show in Settings       |
| double click, or Enter         | play a motion or an expression              |
| right-click a motion           | show its curves                             |
| click a selected group again   | fold or unfold it                           |

An asterisk after an item's name marks a change made in the viewer (see
Editing) that is not exported yet. Exporting clears the marks. While any
item is marked, the page asks before it closes, and before another model
(or another settings file) is opened in its place: declining keeps the open
model and its changes.

## Settings

What the Settings area shows depends on the item:

- **Model settings**: the files it refers to, notes on what loaded and what
  didn't, and **Export**. When the folder has several settings files, a
  list switches between them.
- **`.moc3` file** (the model-file inspector): the file version, the canvas
  and the counts of parameters, parts, art meshes, deformers, glues and
  offscreens, then sections listing each kind. Click an art mesh in its
  section to make it flash on the model. **Draw order now** lists the art
  meshes in the order they are drawn when you open it.
- **Texture**: its size, the size in use (after the texture budget), and a
  preview.
- **Physics**: **Rate in use**, the simulation steps per second and where
  that rate comes from (the file's `Fps`, or one step per frame without
  it). **Rate** changes it for this session; it isn't exported. Then the
  totals, and every group with its stages, inputs and outputs.
- **Motion**: its group, file, duration, frame rate, the file's loop flag
  (playback doesn't use it), its curves, its fades (from the settings, from
  the file, or the 1000 ms default), its sound and its motion-sync setting,
  and its events. **▶ Play** plays it; **loop playback** repeats it (in the
  viewer only); **Curves** draws its curves, each over its target's range,
  with a check box per curve. Below, its settings entry, to edit.
- **Expression**: its fades (the file's, or the 500 ms default), **▶ Play**,
  and its values, to edit.
- **Pose**: its fade (the file's, or the 500 ms default) and every part's
  group and the part it follows, to edit.
- **User data** and **display information**: their entries.
- **Motion sync**: its settings, and a preview: **Load WAV…**, pick a
  **Setting**, then **▶ Play** (with **repeat** if you like) or **■ Stop**.
  The sound plays through that setting's analysis and moves the mouth.

**Defaults.** A motion fades in and out over 1000 ms, an expression and the
pose over 500 ms, unless their files or the settings say otherwise. (For
expressions this is the viewer's choice: the library's default is 1 s.)
With **Idle motion** on, the settings' `Idle` group plays whenever no other
motion does.

## Editing

Changes take effect on the model at once, and are kept until exported.

- **Motion settings** (select a motion): its **Group** (type a new name for
  a new group; blank takes the motion out of the model settings, and a
  motion they don't list joins them when it gets a group), **Fade-in** and
  **Fade-out** in milliseconds (blank: the file's, or the 1000 ms
  default), **Sound** (a WAV file of the folder) and **Motion-sync
  setting**. They are saved in the model settings, and the model plays its
  groups, idle included, from them at once. Loop playback stays a choice of
  the viewer's.
- **Expressions** (select an expression): every parameter has a check box,
  a value and a blend; **every parameter** lists those the expression
  doesn't use too. With `Add`, the value is the parameter's value (the file
  stores it less the parameter's default). `Multiply` is a factor, from 1
  when a parameter is switched to it: right-click a parameter to switch it
  to `Multiply` and back. `Overwrite` is the value itself. Unchecked
  parameters are left out of the file. The fades are in milliseconds
  (blank: the 500 ms default). The model shows the expression as it is
  edited.
- **New expressions** (**File › New expression…**, or the Expressions
  branch): give it a name, and the viewer makes `<name>.exp3.json` in the
  folder of the model's other expression files (next to the settings when
  there are none), empty, and lists it in the model settings under that
  name. A name the settings already have is refused. The editor opens with
  every parameter listed: check the ones it sets.
- **Pose** (select the pose; for a model without one, **File › New pose**
  or **New pose** in the model settings makes a `.pose3.json` next to the
  settings, listing every part): give alternative parts the same
  **Group** number, and one part of each group shows at a time, groups from
  the lowest number up. A part **Follows** a part of a group to show and
  hide with it, as a costume variant follows its arm. A part that follows
  another and is in a group too gets a warning: links apply after the
  groups, so the link wins. **Fade** is in milliseconds (blank: 500 ms).
  Click a part's name to select its row, and Ctrl+C (⌘C) copies its ID.

**Export** (File, or Ctrl+S): with one changed file, that file; with
several, one `.zip` of the model settings and every changed file at its
path in the model's folder (the menu item says which). Without changes, it
downloads the model settings. An expression's or the pose's own **Export**
button downloads that file alone.

- The model settings keep every key; they also list the expressions of the
  model's folder that they don't (named after their files).
- Edited files keep their other keys and the order of their keys. New ones
  are written as an expression's `Type`, `FadeInTime` and `FadeOutTime`
  (when set) and `Parameters` (`Id`, `Value`, `Blend`), or a pose's `Type`,
  `FadeInTime` (when set) and `Groups`, each entry with its `Id` and `Link`
  (empty when nothing follows it).
- Everything is JSON indented with tabs.

## Mouse and keyboard

| Input                                              | Effect                                                         |
| -------------------------------------------------- | -------------------------------------------------------------- |
| drag (Cursor tracking on)                          | the model looks at the pointer; releasing returns it           |
| Ctrl+drag, Shift+drag, right- or middle-drag       | move the model (a plain drag does too with Cursor tracking off) |
| wheel or Alt+wheel                                 | zoom about the pointer                                         |
| two fingers apart and together                     | zoom and move                                                  |
| drag an item or its anchor cross                   | move the item (a pinned item is pinned again where dropped)    |
| click or tap                                       | hit test: the settings' hit areas, else the topmost drawable   |
| double click or double tap                         | reset the view                                                 |
| Space, `.`                                         | pause and play; one frame                                      |
| Ctrl+S (⌘S on a Mac)                               | export (the model settings, or the changed files)               |
| Escape                                             | close the open menu, or the sheet on a phone                   |

## Debugging tools

- **The model-file inspector**: select the `.moc3` file in Resources (see
  Settings above). Click an art mesh to find it on the model.
- **The two-file comparison**: **Edit › Compare two .moc3 files…**, or drop
  two `.moc3` files. Settings lists every difference, object by object
  (matched by ID): the file version, the canvas, the parts, parameters and
  art meshes that only one file has, each parameter's range and default,
  and each art mesh's blend mode, culling, texture, draw order (at the
  default pose), masks, and vertex and triangle counts.
- **The motion-curve graph**: right-click a motion, or **Curves** in its
  settings.
- **The event and frame-rate displays**: a motion's events appear over the
  model for a few seconds as they fire; the frame rate shows in the corner.
  **Display › Events** and **Display › Frame rate** hide them.
- **The physics summary**: select the physics file.

## Lip sync

Two kinds of lip sync move the mouth. The line **Active: …**, in the **Lip
sync** panel and in the motion-sync preview, says which one does it now.

- **Motion sync** analyzes a voice and sets the mouth's shape parameters,
  with the model's `.motionsync3.json` settings. It runs for a motion whose
  entry in the model settings names a sound and a motion-sync setting, and
  for the preview in the motion-sync settings. **Animation › Motion sync**
  turns it on and off.
- **Volume lip sync** moves the parameters of the settings' `LipSync` group
  (or `ParamMouthOpenY` when they list none) by loudness. In the **Lip
  sync** panel, play a WAV file from the model's folder or use the
  microphone. **Animation › Lip sync** turns it on and off.

**Microphone lip sync.** Press **Microphone** in the Lip sync panel and allow
the microphone: while it runs and **Animation › Lip sync** is on, your voice
moves the model's lip-sync parameters. Each frame, the loudness (RMS) of the
audio since the previous frame, measured as for WAV files, goes through a
noise gate, a gain and smoothing, and is added to those parameters. The
sliders under the meter set them:

| Control        | Default | Effect                                                                                     |
| -------------- | ------- | ------------------------------------------------------------------------------------------ |
| Sensitivity    | ×12     | Multiplies the loudness above the gate. Raise it if the mouth barely opens.                 |
| Noise gate     | −45 dB  | Levels (dBFS) at or below it keep the mouth closed. Raise it above the level shown in silence. |
| Attack         | 30 ms   | How fast the mouth opens.                                                                   |
| Release        | 120 ms  | How fast it closes.                                                                         |
| voice processing | on    | The browser's echo cancellation, noise suppression and automatic gain control.              |

With these defaults, normal speech at arm's length opens the mouth clearly
(about half open at −26 dBFS, fully from about −20 dBFS) and a quiet room
keeps it closed. ↺ resets a slider. The line under the second bar shows the
level, the gate and the value added, and what it drives. The settings are
remembered in this browser.

- The microphone needs a secure page: HTTPS, or `localhost` on the computer
  that runs the viewer. A phone that opens `npm run viewer -- --host 0.0.0.0`
  or the dev server by the computer's address over plain HTTP cannot use it,
  and the panel says so. Use HTTPS instead, for example a static build
  (below) on an HTTPS host.
- On iPhone and iPad, audio starts only from a tap. If iOS pauses it (a
  call, Siri), the panel says "Microphone waiting": tap anywhere to resume.
- While the page is hidden (another tab, the app in the background), the
  microphone is released and the panel says so. It opens again when the
  page is visible.
- Playing a sound file stops the microphone; press **Microphone** again.
- **Privacy:** the audio is processed in memory as it arrives, to compute
  one loudness value per frame. It is never recorded, stored or sent
  anywhere. Only the slider settings are stored, in this browser.

## The menu area's panels

- **Parameters** and **Parts**: sliders with display names (IDs in tooltips;
  search matches both). With physics on, parameters that physics overwrites
  are locked and say which input drives them ("physics ← AngleX"). Move the
  input to move them. A list above them chooses whether the sliders show
  the model or an item.
- **Items**: further models placed over the model, such as a hat or a prop
  in the hand. Add one from a folder, a zip, the Models list or a URL. Each
  item has numeric position, scale, rotation and anchor fields, in front or
  behind, opacity, and its own physics and breath. **Pin to model** attaches
  the item at its anchor (the cross) to the topmost visible drawable there,
  so it moves with the body. An item whose folder has a `.vtube.json` with
  `ItemSettings` is fed the model's head angles. **Export layout** and
  **Import layout…** save and restore where the items are. See
  [api.md](api.md#items-over-a-model-mochiitem) for the details.
- **Lip sync**: the sound files of the model's folder, the microphone and
  the meter (above).

**Stage bar** (under the model): play and pause, one frame, speed and the
time; then what plays (motions, expressions, the lip-sync value) and the
frame statistics. On a phone, **⋯** shows the second half.

- **Display › Masks**: `atlas (fast)` shares one mask texture sized to the
  screen; the per-drawable options are the reference masks (slower).
- **Display › Textures**: textures with their mip chains are scaled down
  together to fit the budget, and a notice over the model lists them.
  `auto` is 256 MiB on phones and tablets and 1 GiB elsewhere. DeepSeek-chan
  needs about 789 MiB at full size. Raise the budget if your device can take
  it; the choice is remembered.

## On iPhone and iPad

1. Host the viewer where the phone can reach it. Use `npm run viewer -- --host
   0.0.0.0` on a computer on the same network, or upload a static build to
   any web host.
2. Open it in Safari, then open your model with **File › Open zip…** (a zip
   of the model folder, from the Files app). In a build made with `--models`,
   pick it from **File › Models…** instead.
3. Drag with one finger to make the model look, pinch to zoom, tap to
   hit-test, and double tap to reset. **☰ Panels** has the panels, the
   resources and the settings.

The viewer limits the drawing buffer to twice the CSS size (phones are often
3×), decodes one texture at a time, and reloads the textures if iOS takes
the GPU context away from a background tab. The microphone needs HTTPS:
over plain HTTP from another computer, the Lip sync panel explains what to
do (see Microphone lip sync above).

## Static build

```sh
# dist/viewer/: index.html + assets/
npm run build:static
# also copies assets/models/DeepSeek/ into dist/viewer/models/DeepSeek/
npm run build:static -- --models assets/models/DeepSeek
npm run build:static -- --out site --models path/to/MyModel --models path/to/Other
```

The output uses relative URLs, so any static server can host it, in any
directory. Try it locally:

```sh
npm run build:static -- --models assets/models/DeepSeek
python3 -m http.server -d dist/viewer 8080
```

Then open http://localhost:8080/ and pick DeepSeek-chan from **File ›
Models…**, or open http://localhost:8080/?model=DeepSeek/大肥鱼.model3.json
directly.
Another static server works as well, for example `npx serve dist/viewer`,
which prints its own address.

**With your own model folder:** build without `--models` and open the folder
or a zip from the page. Or copy it in with `--models path/to/folder` and pick
it from the menu.

**Pointing at your copy of DeepSeek-chan without copying it into the
build:** serve the repository root, for example `python3 -m http.server 8080`
in the repository. Then open
http://localhost:8080/dist/viewer/?model=../../assets/models/DeepSeek/大肥鱼.model3.json.
This loads by URL, so the resource tree only lists the motions and
expressions the settings name (DeepSeek-chan's settings name none). A model
from the Models list (with `--models`) lists every file.

A build made with `--models` contains the model's files. Publishing it
publishes them, so respect each model's terms. DeepSeek-chan's terms forbid
re-uploading its files for others to download, so keep such a build private
(local or on your own network).

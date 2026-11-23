# Mochi2D agent API

AI agents can drive Mochi2D in two ways:

- **`mochi2d-mcp`**, an [MCP](https://modelcontextprotocol.io) server over
  stdio, for agents in MCP clients (Claude Code, Claude Desktop, VS Code,
  Cursor and others).
- **`mochi2d`**, a headless command line with the same operations, for
  scripts.

Both load a Live2D Cubism model (a folder, a `*.model3.json` file or a
`.zip` of the folder) and can describe it, read and set parameters and part
opacities, play expressions and motions, advance time, render a PNG,
hit-test, and validate `.moc3` files. They share one implementation
(`tools/lib/agent/`).

- [Setup](#setup)
- [Rendering needs Chromium](#rendering-needs-chromium)
- [Safety](#safety)
- [MCP server](#mcp-server): [tools](#tools), [resources](#resources), [an example session](#an-example-session)
- [Command line](#command-line)
- [Client configurations](#client-configurations)

## Setup

Requires Node ≥ 20. In a clone of the repository:

```sh
npm ci
npm run build
```

This writes `dist/tools/mochi2d-mcp.js` and `dist/tools/mochi2d.js`, and the
page that renders (`dist/web/`). The commands then run in these ways:

| Where | MCP server | Command line |
| --- | --- | --- |
| in the Mochi2D folder | `npx mochi2d-mcp --root <folder>` or `npm run mcp -- --root <folder>` | `npx mochi2d describe <model>` or `npm run mochi2d -- describe <model>` |
| anywhere | `node /path/to/Mochi2D/dist/tools/mochi2d-mcp.js --root <folder>` | `node /path/to/Mochi2D/dist/tools/mochi2d.js describe <model>` |
| anywhere, through npm | `npx --no-install --prefix /path/to/Mochi2D mochi2d-mcp --root <folder>` | `npx --no-install --prefix /path/to/Mochi2D mochi2d describe <model>` |

Or install both commands once with `npm install -g /path/to/Mochi2D`. This
links to the folder, so later builds apply. Mochi2D is not published to the
npm registry. Outside its folder, pass `--no-install` to `npx` so that npx
never downloads some other package with the same name.

`mochi2d-mcp --help` and `mochi2d --help` print the usage, and `--version`
prints the version. The server writes its messages to stderr, because stdout
carries the protocol.

## Rendering needs Chromium

`render` draws with Mochi2D's WebGL renderer in headless Chromium, which
it drives through [Playwright](https://playwright.dev). Neither is a package
dependency. Mochi2D looks for Playwright in this order:

1. `MOCHI2D_PLAYWRIGHT`, the path of a `playwright` package folder;
2. `playwright` or `playwright-core` from Mochi2D's folder (its
   `node_modules`, or `NODE_PATH`);
3. npm's global packages (`npm install -g playwright`).

Playwright uses its own Chromium (`npx playwright install chromium`; set
`PLAYWRIGHT_BROWSERS_PATH` if it is not in Playwright's default place).
`MOCHI2D_CHROMIUM` names another Chromium executable for when that fails.
To install both in the Mochi2D folder:

```sh
npm install --no-save playwright
npx playwright install chromium
```

MCP clients start servers with only a few environment variables, so a
`NODE_PATH` or `PLAYWRIGHT_BROWSERS_PATH` from your shell may not reach the
server. Set them in the client's `env` settings (see
[Client configurations](#client-configurations)).

Without Chromium, `render` fails with a message that says so and how to fix
it:

> Rendering needs headless Chromium through Playwright, which is not
> available here (…). Install both in the Mochi2D folder (…) with "npm
> install --no-save playwright && npx playwright install chromium", or …

The CLI exits with code 3 in that case. If `dist/web` is not built, the
message says to run `npm run build`. Every other operation works without
Chromium.

## Safety

- **Files are read only under the allowed folders.** For the MCP server,
  these are the `--root` folders, else the folders in `MOCHI2D_ROOTS`
  (separated like `PATH`: `:` on macOS and Linux, `;` on Windows), else the
  roots that the MCP client shares, updated when the client changes them.
  With none of these, the server reads nothing, and its tools say how to
  allow a folder. The command line reads only the model or file given on
  its command line.
- Paths are checked after following symbolic links, so a link inside an
  allowed folder that points outside it is refused (or, inside a model
  folder, left out). A model's motions, expressions and other files are read
  only from that model's own folder or zip. A relative path starts at the
  first allowed folder.
- Dotfiles are left out of model folders. A model folder may hold at most
  20,000 files, 12 levels deep, and no file may be larger than 1 GiB.
- **Nothing is written.** The MCP server writes no files; a render's PNG is
  part of the tool's result. The command line writes only the `--out` file
  of `render`. (Chromium keeps a temporary profile while it runs, which
  Playwright removes when it closes.)
- **No network.** The server and the CLI make no network requests, and the
  MCP server talks only over stdio. Renders run in headless Chromium, on a
  page from a local server at `127.0.0.1` (a random port). That server
  serves Mochi2D's own pages (`dist/web`) and the loaded model's files, and
  nothing else. Chromium starts with its background networking switched
  off, and the page's requests to any other address are blocked.
- The tools' annotations say this: `openWorldHint: false` and
  `destructiveHint: false` for all, and `readOnlyHint: true` for the tools
  that change no state.

## MCP server

```
mochi2d-mcp [--root <folder>]...
```

`--root` may be given several times (also as `--root=<folder>`). The server
holds one model at a time: `load_model` replaces it.

### Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_models` | `folder?` | `allowedFolders`, `models` (`path`, `kind`), `truncated` |
| `load_model` | `path`, `seed?`, `effects?`, `fileSmoothing?` | `loaded`: a summary of the model |
| `describe_model` | | everything about the loaded model (below) |
| `get_parameters` | `ids?` | `parameters` (`id`, `name`, `value`, `base`, `min`, `max`, `default`), `unknown` |
| `set_parameters` | `values` | the parameters that were set, as above, `unknown`, and `physicsOverwrites` when physics overwrites some |
| `get_part_opacities` | `ids?` | `parts` (`id`, `name`, `opacity`, `default`), `unknown` |
| `set_part_opacities` | `values` | the parts that were set, as above, and `unknown` |
| `play_expression` | `expression`, `mode?` | `playing`: the expressions in the queue; `added`: those added on top |
| `play_motion` | `group?`, `index?`, `file?`, `priority?`, `loop?`, `hold?`, `blinkWhileHeld?` | `started`, `playing`, `motionSync` when its sound drives the mouth |
| `play_sound` | `file`, `setting?` | `started`, `file`, `seconds`, `motionSync` |
| `advance_time` | `seconds`, `fps?` | `frames`, `time`, `events`, `motionsEnded`, `ends`, `playing`, `motionSync` while it runs |
| `reset` | | `reset`: the summary, as after `load_model` |
| `render` | `width?`, `height?`, `view?`, `background?`, `alpha?`, `maxTextureSize?` | a PNG image, and `width`, `height`, `pixelsPerUnit`, `center`, `renderer`, `notes` |
| `hit_test` | `x`, `y`, `space?`, `width?`, `height?`, `view?` | `model`, `hitAreas`, `drawable` |
| `map_points` | `deformer?` or `drawable?`, `points`, `space?`, `jacobian?` | `deformer`, `chain`, `space`, `points`, `jacobians` |
| `validate_moc3` | `path`, `strict?` | `valid`, `version`, `counts`, `warnings`; or `valid: false` and `reasons` |

Every result is JSON, in both `structuredContent` and a text item. `render`
also returns an `image` item (`image/png`, base64), so the agent can see
the result. A tool that fails returns `isError: true`, a text item with the
error's name and message (`TextureLimitError: "t.png" declares 30000×30000
pixels, …`; a plain message for a plain error, for example `No model is
loaded: call load_model first.`), and `structuredContent.error`: its
`name`, `message` and, for the typed errors, their fields (`path`, `kind`,
`limit`, `size`, a texture's `width` and `height`, a format error's
`code`), so an agent can tell "too large" (`ArchiveLimitError`,
`TextureLimitError`, `FileLimitError`) from "damaged" (`ZipFormatError`,
`TextureFormatError`, `MocFormatError`) from "missing" (`FileNotFoundError`).
Nothing is rendered past a cap: `render` returns no image. `render`
reports the same error as `load_model` and `describe` do, with the same
fields: a texture file past the file cap is a `FileLimitError` from
`render` too, never "not found".

**`list_models`.** The allowed folders, and the `*.model3.json` files
(`kind: "settings"`) and `.zip` archives (`kind: "zip"`) in them: at most
200, without dotfiles and `node_modules`. `folder` looks only in one folder
inside the allowed folders.

**`load_model`.** `path` is a model folder, a `*.model3.json` file or a
`.zip` of the folder. A folder or zip with several settings files loads the
shallowest one (then the first by name). In a folder, give the
`*.model3.json` file to choose another. RAR and 7z archives are refused
with a message.

`seed` (an integer, default 1) seeds the random choices of eye blinks and
idle motions, so runs repeat. `fileSmoothing` (default false) applies the
motion-sync file's per-parameter `Smooth` too, on top of the analysis's own
smoothing (see docs/api.md, "Motion sync"). `effects` switches components on or off:
`physics`, `eyeBlink`, `breath`, `look`, `idle`, `lipSync`, `pose`,
`expressions`, `motionSync` (other names are an error). For example, with
`{ "physics": false, "eyeBlink": false, "breath": false }` only the
parameters you set, motions and expressions pose the model.

The summary has `path`, `settings`, `mocVersion`, the counts of
`parameters`, `parts` and `drawables`, `expressions` (how many the settings
name), `motionGroups`, `physics`, `time`, `textures` and `warnings`:

- `textures`: what each texture declares, read from its header (nothing is
  decoded): `path`, `width`, `height`, `format`;
- `texturesRefused` (only when there is one): the error a render would
  meet under the default caps, as in a failed result;
- `warnings`: the runtime's, the motion sounds a view would not play (their
  files are read, and each one named with the reason), and a line for a
  refusal of the textures.

**`describe_model`.** The loaded model:

- `canvas`: `widthPixels`, `heightPixels`, `pixelsPerUnit`, and the size in
  model units (`widthUnits`, `heightUnits`);
- `parameterGroups`, and `parameters`: `id`, display `name` and `group` from
  the display-info file (`*.cdi3.json`, else the ID), `min`, `max`,
  `default`, current `value`, `blendShape: true` for blend-shape parameters,
  and for parameters that physics overwrites, `physicsInputs` (the
  parameters that drive them, `id` and `weight` in percent, largest first)
  and `drivenByPhysicsFrom` (the first of them; see below);
- `parts`: `id`, `name`, `opacity`, `default`;
- `drawables`: `count`, and how many are `masked`; `deformers`: the number
  of `warps` and `rotations` (see `map_points`);
- `expressions`: `named` (in the settings) and `files` (`*.exp3.json` files
  in the model, by path);
- `motions`: `groups` of the settings (`name`, `motions`) and `files`
  (`*.motion3.json` files in the model, by path);
- `physics`: `present`, the number of `settings`, how many parameters it
  `overwrites`, its `rate` (simulation steps per second, from the file's
  `Fps`; 0 steps once per frame), and `look`: for each look target, the
  parameter look writes (its physics input when physics overwrites the
  target); `pose`,
  `eyeBlink`, `lipSync`;
- `motionSync`: the `settings` of the model's motion-sync file (`id`,
  `name`, and whether Mochi2D can run it, `usable`; empty without a file),
  and what `playing` (as for `play_sound`, or null);
- `hitAreas` (`id`, `name`) of the settings;
- `effects`: the components the model has, and whether each is on;
- `playing` (`motions`, `expressions`), `time` and `warnings`.

**`set_parameters`.** `values` maps parameter IDs to base values, which are
kept within each parameter's range. Motions, expressions, physics, eye blink
and breath still apply on top. A parameter that physics sets follows its
input instead: set the input (`physicsInputs`, for example `AngleX` for
`ParamAngleX`) and advance time, or switch physics off. While physics runs,
the result's `physicsOverwrites` lists the parameters you set that physics
overwrites, each with the inputs to set instead (`setInstead`). The result
gives the values after the change, with the components applied, so they
can differ from what was set: eye blink, for example, sets the eye-open
parameters while it runs. To pose such parameters yourself, switch the
component off (`effects` of `load_model`). Unknown IDs are listed in
`unknown`, and the others are still set.

**`set_part_opacities`.** `values` maps part IDs to opacities from 0 to 1. A
pose file may override the parts it controls.

**`play_expression`.** `expression` is a name from the settings or a
`*.exp3.json` path relative to the settings file. With `mode` `"replace"`
(the default) it replaces the current expression, and `null` fades the
current expressions out. With `"add"` it shows on top of the others, so
several show at once, and `"remove"` fades an added one out (`null`: all
added ones); `changed` says whether anything changed. Expressions fade in
and out over time, so call `advance_time`.

**`play_motion`.** A motion group of the settings (`group`, with `index`,
else a random motion of the group) or a `*.motion3.json` `file` relative to
the settings file. `priority` is 1 (idle), 2 (normal, the default) or
3 (force). A motion can be refused while one of higher priority plays
(`started: false`). `loop` repeats it. `hold` keeps its last frame (no
fade-out at the end) until the next motion or `reset`; it then keeps no
priority, so the next motion is accepted. Once a held motion is at its end,
eye blink runs again; `blinkWhileHeld: false` keeps it off while the motion
holds. Motions play as time advances. When the motion's settings entry has a
`Sound` and a `MotionSync` setting, the sound drives the mouth through that
setting, as with `play_sound`, and the result says so (`motionSync`).

**`play_sound`.** Moves the mouth with a WAV `file` (relative to the
settings file) through a `setting` (a name or ID) of the model's
motion-sync file, by default the first that can run: motion sync. Nothing
is played aloud. Mochi2D analyses the sound with its own method, so the
mouth shapes are its own. The mouth moves as time advances; the sound plays once, then the
mouth settles to the setting's Silence shape. The result gives the sound's
length (`seconds`) and `motionSync`: the `setting` (`id`, `name`), the
`source` (`"sound"`), and from the latest analysis the `time` (seconds of
the sound), `level` (dBFS), `silent`, the element `weights` (`Silence`,
`A`, `I`, `U`, `E`, `O`, summing to 1) and the `values` written. A model
without a motion-sync file, an unknown setting or a file that is not a
readable WAV file is an error.

**`advance_time`.** Runs the animation for `seconds` (0–600) at `fps` frames
per second (1–240, default 60). Time passes only here: `time` counts the
seconds since loading or `reset`. `events` holds the motion events that
fired (`time`, `value`), and `motionsEnded` counts how often the motion
queue ran empty. `ends` lists the motions that ended (`time`, `motion`,
`reason`): `"finished"` (played to its end; a held motion when it reaches
its last frame), `"replaced"` (another motion started, so it faded out) or
`"stopped"`. While motion sync runs, `motionSync` has the number of
analyses in these frames (`ticks`, at most one a frame and `SampleRate` a
second), how often each element was the `strongest`, and what plays `now`
(as for `play_sound`; null once the mouth has settled).

Physics runs as the reference does: at full strength, with no wind, and
with no physics steps in `advance_time` with `seconds: 0`, so physics-driven
parameters then show their base values. (Physics strength and wind, and
holding physics while paused, are library features: see [api.md](api.md).)

**`reset`.** A fresh model from the same files and options: default
parameters and opacities, nothing playing, `time` 0.

**`get_parameters`.** `value` is the parameter's value in the latest frame,
with motions, expressions and effects (physics, breath, eye blink, look, lip
sync) applied: what is drawn. `base` is its base value: what
`set_parameters` sets, or what motions left in it (a motion's result stays
after it ends). While physics overwrites a parameter, `value` follows
physics and `base` keeps what was set.

**`render`.** Draws the current state (the values that `get_parameters`
reports) into a PNG of `width` × `height` pixels (16–4096, default
512 × 512). The `view` is `{ x, y, pixelsPerUnit }`: the model point at the
image center and the image pixels per model unit. By default, the model's
canvas is fitted into the image. `background` is `"transparent"`, a hex
color (`"#rrggbb"`, `"#rrggbbaa"`) or `[r, g, b, a]` in 0–1. The default is
opaque white, so the image is easy to look at. `alpha` is `"straight"` (the
default) or `"premultiplied"`. The result gives the `pixelsPerUnit` and
`center` that were used, the WebGL `renderer`, and `notes`. Rendering does
not advance time. A drawable whose opacity is negative is drawn too: it
changes nothing with the normal blend, and
brightens what is behind it with some advanced blends (see api.md, Loading
and validation). Textures are minified through mip levels that Mochi2D
builds itself for every texture size, so a render does not depend on the
GPU driver. `maxTextureSize` (64–8192) asks for a faster preview that
is not the reference render: textures downscaled so that no side exceeds it,
and the viewer's mask atlas; `notes` says so.

**`hit_test`.** What lies at a point: the settings' hit areas whose
drawable's bounding box contains it, and the topmost visible drawable whose
bounding box contains it (`null` when there is none). The point is in model
units (x right, y up), or with `space: "pixels"` in pixels from the top-left
corner of a render of that `width`, `height` and `view`. The result gives
the point in model units (`model`).

**`map_points`.** The forward mapping at the current pose: `points`
(`[x, y]` pairs, at most 10,000) from a deformer's input space to model
units, exactly as Mochi2D maps the vertices of the deformer's child meshes,
through its ancestors and outside a warp's grid too. A warp's input space
is its normalized grid (0 to 1 inside it), a rotation's is its local space.
Give the `deformer` ID, or a `drawable` ID to map from that drawable's
keyform space through its parent deformer (with no parent, the points are
already in model space). `space: "keyform"` returns y down, as keyform
positions are stored, instead of model units (y up). The result names the
`deformer` and its `chain` up to the root (`id`, `kind`). With `jacobian`,
`jacobians` holds the 2×2 Jacobian at each point, `[dx/dpx, dx/dpy, dy/dpx,
dy/dpy]`: exact within each region of the mapping (a warp cell or triangle,
the band around the grid, the affine extension far outside, a rotation),
and for a point on a boundary, that of the region the point belongs to.

**`validate_moc3`.** Whether Mochi2D loads a `.moc3` file, and if not, why:
`{ "valid": false, "reasons": ["MocFormatError: …"] }`. Valid files give the
moc3 `version`, the `counts` of parameters, parts and drawables, and load
`warnings`. With `strict`, draw orders outside their group's range are
errors, not warnings.

**Coordinates.** Model units: x to the right, y up, with the model's own
origin. `describe_model` gives the canvas size in model units. The default
render view is centered on the canvas.

### Resources

| URI | Content |
| --- | --- |
| `mochi2d://model` | `describe_model` of the loaded model as JSON, or `{ "loaded": false, "allowedFolders": […] }` |
| `mochi2d://docs/agent-api` | this document |
| `mochi2d://docs/api` | the library API ([api.md](api.md)) |
| `mochi2d://docs/llms.txt` | the project summary for language models ([llms.txt](../llms.txt)) |

### An example session

With DeepSeek-chan (see the README's "Test models") and
`--root /path/to/Mochi2D/assets/models`:

```text
list_models {}
  → { "allowedFolders": [".../assets/models"],
      "models": [{ "path": ".../assets/models/DeepSeek/大肥鱼.model3.json", "kind": "settings" }], … }
load_model { "path": "DeepSeek" }
describe_model {}
  → 509 parameters, such as { "id": "ParamMouthOpenY", "name": "嘴　张开和闭合", "group": "嘴", "min": 0, "max": 1, … }
set_parameters { "values": { "ParamMouthOpenY": 1, "ParamMouthForm": 1 } }
render { "width": 512, "height": 768 }
  → an image, and { "width": 512, "height": 768, "pixelsPerUnit": 374.07…, "center": [0, 0], … }
play_motion { "file": "Animation/IDLE.motion3.json", "loop": true }
advance_time { "seconds": 1.5 }
render { "view": { "x": 0, "y": 0.6, "pixelsPerUnit": 1200 } }
hit_test { "x": 256, "y": 200, "space": "pixels", "view": { "x": 0, "y": 0.6, "pixelsPerUnit": 1200 } }
reset {}
```

## Command line

```
mochi2d list     <folder> [--json]
mochi2d describe <model> [state options] [--json]
mochi2d params   <model> [state options] [--ids ID,ID] [--json]
mochi2d render   <model> [state options] --out <file.png> [--size WxH] [--view x,y,ppu]
                          [--background transparent|#rrggbb|r,g,b,a] [--alpha straight|premultiplied]
                          [--fast | --fast=MAX]
mochi2d hit-test <model> --at x,y [--pixels] [--size WxH] [--view x,y,ppu] [state options] [--json]
mochi2d validate <file.moc3> [--strict] [--json]
```

`<model>` is a model folder, a `*.model3.json` file or a `.zip`. The state
options set up the model before the command, in this order:

| Option | Meaning |
| --- | --- |
| `--seed N` | the random seed of eye blinks and idle motions (default 1) |
| `--effects a=on,b=off` | switch components on or off, as `effects` of `load_model` |
| `--file-smoothing` | apply the motion-sync file's per-parameter `Smooth` too, as `fileSmoothing` of `load_model` |
| `--params ID=V,…` | parameter base values |
| `--parts ID=V,…` | part opacities (0–1) |
| `--expression NAME` | an expression by settings name or file path |
| `--motion GROUP[:I]` or `--motion FILE` | a motion of a settings group, or a `*.motion3.json` file |
| `--time SECONDS` | advance the animation (with `--fps N`, default 60) |

`--json` prints the same JSON as the MCP tools; without it, the output is
short text. `params` prints one line per parameter (ID, value, range, name),
with `base` and the base value at the end where it differs from the value.
`render` prints the file it wrote and its size, and with `--json`
also `pixelsPerUnit`, `center` and `notes`. Its default size is 512 × 512 on
white, like the MCP tool. `--fast` renders a quicker preview that is not the
reference render: textures downscaled to at most 1024 pixels (`--fast=MAX`
for another size) and the viewer's mask atlas, as `maxTextureSize` of the
MCP tool.

Exit codes: 0 success; 1 failure (an invalid `.moc3` for `validate`, unknown
IDs for `params`, or any error); 2 a usage error; 3 rendering is not
possible here.

A failure prints `mochi2d: <name>: <message>` on stderr (the message alone
for a plain error), and with `--json` also `{ "error": { … } }` on stdout,
with the fields of the MCP results above. A render that fails writes no
file. `describe` prints the textures' declared sizes and, under
`warnings`, a refusal a render would meet and the motion sounds a view
would skip; `params` and `hit-test` decode no texture and are not affected
by the texture caps.

```sh
mochi2d describe assets/models/DeepSeek
mochi2d params assets/models/DeepSeek --params ParamMouthOpenY=1 --ids ParamMouthOpenY
mochi2d render assets/models/DeepSeek --params ParamMouthOpenY=1 --size 512x1024 --out out/open.png
mochi2d render model.zip --motion Idle:0 --time 2 --background transparent --out frame.png
mochi2d render assets/models/DeepSeek --fast --size 256x512 --out out/preview.png
mochi2d hit-test assets/models/DeepSeek --at 256,256 --pixels
mochi2d validate assets/models/DeepSeek/大肥鱼.moc3 --strict
```

## Client configurations

Replace `/path/to/Mochi2D` with the folder of your clone, and `/path/to/models`
with the folder that holds your models. Give several `--root` options for
several folders. On Windows, write paths like
`C:\\Users\\me\\Mochi2D\\dist\\tools\\mochi2d-mcp.js` in JSON. Add an `env` entry
when renders need it (see [Rendering needs Chromium](#rendering-needs-chromium)),
for example `"env": { "MOCHI2D_PLAYWRIGHT": "/usr/local/lib/node_modules/playwright" }`.

**Claude Code**, from a terminal:

```sh
claude mcp add mochi2d -- node /path/to/Mochi2D/dist/tools/mochi2d-mcp.js --root /path/to/models
```

Or for everyone working in a project, a `.mcp.json` file in the project's
folder:

```json
{
  "mcpServers": {
    "mochi2d": {
      "command": "node",
      "args": ["/path/to/Mochi2D/dist/tools/mochi2d-mcp.js", "--root", "/path/to/models"]
    }
  }
}
```

**Claude Desktop**: `claude_desktop_config.json` (Settings → Developer →
Edit Config):

```json
{
  "mcpServers": {
    "mochi2d": {
      "command": "node",
      "args": ["/path/to/Mochi2D/dist/tools/mochi2d-mcp.js", "--root", "/path/to/models"]
    }
  }
}
```

**VS Code**: `.vscode/mcp.json` in a workspace. Without `--root`, the
workspace folders are the allowed folders, because VS Code shares them as
roots:

```json
{
  "servers": {
    "mochi2d": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/Mochi2D/dist/tools/mochi2d-mcp.js"]
    }
  }
}
```

**Cursor**: `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for all
projects:

```json
{
  "mcpServers": {
    "mochi2d": {
      "command": "node",
      "args": ["/path/to/Mochi2D/dist/tools/mochi2d-mcp.js", "--root", "/path/to/models"]
    }
  }
}
```

**Other clients** take the same command: `node`, with the arguments
`/path/to/Mochi2D/dist/tools/mochi2d-mcp.js --root /path/to/models`, over
stdio. For example Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.mochi2d]
command = "node"
args = ["/path/to/Mochi2D/dist/tools/mochi2d-mcp.js", "--root", "/path/to/models"]
```

To try the server without a client, use the MCP Inspector:
`npx @modelcontextprotocol/inspector node dist/tools/mochi2d-mcp.js --root assets/models`.

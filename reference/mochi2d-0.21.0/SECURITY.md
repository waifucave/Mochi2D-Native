# Security

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private
vulnerability reporting: the **Security** tab of this repository, then
**Report a vulnerability**. Don't open a public issue for them.

**Include:**

- the version (`MOCHI2D_VERSION`, or `package.json`);
- the entry point or tool involved;
- a file or steps that reproduce it.

Model files that are the maintainer's or a third party's may only be
shared under their terms; a minimal crafted file is best. You'll get an
answer within a week. A fix is released as a patch version, with credit
in `CHANGELOG.md` unless you would rather not.

## Supported versions

| Version | Security fixes |
| --- | --- |
| the latest minor release (0.20.x) | yes |
| earlier releases | no: upgrade (`docs/migration.md` lists what changed) |

From 1.0, the latest minor release of the current major version gets
fixes. `docs/versioning.md` says what each kind of release may change.

## What Mochi2D touches

Mochi2D sends no telemetry and makes no network request of its own. It
reads what the application, or the person using a tool, gives it.

### Files it parses, which can be untrusted

- **The formats:**
  - `.moc3` model data;
  - the JSON files of a model: settings, physics, pose, expressions,
    motions, display information, user data and motion sync;
  - zip archives;
  - WAV audio;
  - textures, decoded by the browser (in Node, by the headless Chromium
    that renders them).
- **What to expect for a damaged file:** each loader throws only its
  documented errors (`docs/api.md`, "What the loaders throw"). It may
  not crash, hang, or use memory out of proportion to the input.
- **How it is checked:** the loaders are fuzzed: a short pass in the test
  suite, and `npm run fuzz` for long runs. A zip entry that claims more
  than deflate can produce is refused before it is unpacked.
- **What counts as a vulnerability:** an input that breaks these
  guarantees, or that makes Mochi2D read or write outside what it was
  given.

### In the browser (`mochi2d`, `mochi2d/pixi`)

- **Files:** it fetches URLs the application passes (`view.load(url)`),
  and reads files the person picks or drops.
- **The microphone:** it opens it only when the application asks for live
  lip sync or live motion sync, after the browser's permission prompt.
  The audio is processed in memory and never stored or sent.

### In Node (`mochi2d/node`)

- **Files:** it reads the files and folders whose paths the application
  passes.
- **`NodeRenderer` and `renderToPng`:** they start headless Chromium
  through Playwright, and serve the model to it from an HTTP server on
  `127.0.0.1` with a random port, for the time of the render.

### The tools

- **The MCP server (`mochi2d-mcp`):** it talks over stdio only. It reads
  files only under its allowed folders (`--root`, `MOCHI2D_ROOTS`, or the
  roots its client shares). A path outside them, or a link that leads out
  of them, is refused. It writes nothing: renders come back as images.
- **The command line (`mochi2d`):** it reads the model it is given, and
  writes only the `--out` file of `render`.
- **The development servers (`npm run viewer`, `npm run dev`):** they
  listen on `127.0.0.1` (`localhost` for `npm run dev`) by default, and
  serve the repository's files and `assets/models/`. `npm run viewer --
  --host 0.0.0.0` exposes the viewer to the network, and says so when it
  starts.

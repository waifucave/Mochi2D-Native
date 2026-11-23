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
- **Zip archives are capped:** by default an entry may inflate to
  256 MiB, an archive to 1 GiB in all, and a directory may list 10,000
  entries (`docs/api.md`, "Caps on what an archive may inflate to"). The
  real inflated bytes are counted, so an entry that inflates past what
  its records declare is stopped there. An app that opens models from
  strangers should set smaller caps. A way around the caps, or memory
  out of proportion to them, counts as a vulnerability.
- **Textures are capped by what they declare:** every texture's PNG header
  is read before it is decoded, and by default a texture may declare
  16,384 on a side and 268 million pixels, a model 1,074 million pixels
  in all (`docs/api.md`, "Caps on what textures may declare"). Browsers
  allocate the declared size before decoding, so these caps, not the
  texture budget, bound what decoding takes. PNG, JPEG, WebP, GIF, BMP and
  ICO sizes are read from their headers; other image formats are refused.
- **Files from folders, URLs and drops are capped:** 1 GiB a file and
  2 GiB in all by default; downloads are streamed and stopped at the cap.
- **A model's motion sounds** play only as WAV files unless an app allows
  compressed ones, and every skipped sound is named in the warnings.
- **The tools fail on a refusal:** the command line exits non-zero with the
  error's name and fields, and writes no picture; the MCP server returns an
  error result.
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

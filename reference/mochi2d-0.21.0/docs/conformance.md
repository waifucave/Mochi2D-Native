# Conformance runs

The conformance tools compare two sets of results on a fixed catalog of 827
scenarios: Mochi2D's and a reference. This page describes a full round, and
reports the project's own comparisons with the official runtime.

**Bit for bit.** Since 0.14.0, Mochi2D evaluates in one fixed float32 order
of operations: the warp mapping (inside the grid, the band around it and the far region, for
both cell kinds), ancestor opacities combined from the top down, repeating
parameters always wrapped, the glue pair's order with glues applied one
after another, and blend-shape constraint weights in the weighted form. With that order,
its results equal the official runtime's bit for bit wherever the catalog
reaches. The rules' test vectors pass bit for bit in both evaluation kernels
(`test/bit-exact-vectors.test.ts`).

0.14.0, as released, was then run against the official runtime:

| What | Compared | Identical |
| --- | --- | --- |
| The static catalog | 573 scenarios: about 280,700 visible drawables, 291,657 parameter values, 84,231 part opacities | every compared field, bit for bit |
| A second model pack, static | 1,106 scenarios | all, bit for bit |
| The second pack, animated | 1,440 frames | all |
| The catalog's sequences | 32 steps | all |
| The catalog's animations | 28,856 frames | 28,839 (see below) |

- The canvas-flag variant matches directly, the y sign included, and the
  big-endian variant matches the official evaluation of the same file.
- Every load verdict is the catalog's required one.
- The other 17 animation frames differ in one or two values that are
  effectively zero: the decay tails of physics outputs or motion curves,
  around 10⁻³¹, and once 4.8·10⁻¹⁷. Those are computed in double precision,
  outside the float32 rules, and no float32 output of the model changes
  from them.

The judge's limits are unchanged, so results from before 0.14.0 still
pass: they differed from the official runtime by at most a few units in
the last place (vertices within 1.3·10⁻⁵).

**Renders.** 0.14.0's renders, compared with the official renderer on the
same driver (SwiftShader), all pass the render tolerance: 54 of 54 catalog
renders, most differing by one level in a few dozen pixels. Four rendering
rules fix Mochi2D's order and rounding
([docs/rendering.md](rendering.md)):

- the texture v flipped twice in float32 (since 0.17.0);
- mask coordinates through float32 matrices (since 0.17.0);
- layers read through a filtered quad (since 0.17.0);
- a masked layer's mask looked up through the inverse view matrix (since
  0.18.0).

**Pixel for pixel, checked.** 0.18.0, as released, was then rendered
against the official renderer, on the same driver (SwiftShader). Every
pixel of every image was compared, in all four channels (premultiplied
RGBA):

| What | Compared | Identical |
| --- | --- | --- |
| The catalog's render scenarios | 53 that render | all 53, 0 differing pixels |
| A second model pack, default renders | 39 | all 39 |
| The second pack, random poses | 117 | all 117 |

- The 54th catalog scenario, a 16384 × 4 texture, is refused by both
  renderers, as the catalog requires.
- Against 0.14.0, 0.18.0 changed exactly the pixels where 0.14.0 was off
  from the official image: 2,245 in the catalog and 15 in the second pack.
  It changed no pixel that 0.14.0 already had right. So the four rules
  account for every difference, and they introduced none.

Mochi2D thus matches the official runtime bit for bit in evaluation, and
the official renderer pixel for pixel in reference renders.

**Mochi2D's own limits.** Where the format gives no rule and no conforming
file reaches them:

- a frame takes at most 10,000 internal physics steps, and an infinite
  `Fps` steps once per frame (a corrupt rate such as `1e308` would
  otherwise never end a frame; see docs/api.md, "Physics rate");
- each loader throws only its documented errors for damaged files
  (docs/api.md, "What the loaders throw").

## A full round, step by step

Needs Node ≥ 20, the environment's Chromium with Playwright (for renders),
about 1 GB of free disk space, and DeepSeek-chan's files in `DeepSeek/`.

1. **Build** the tools, the render harness and the library:

   ```
   npm ci && npm run build
   ```

2. **Generate the catalog** (about 10 s): every crafted model file under
   `assets/models/crafts/` and the 827 scenario files under `out/catalog/`.

   ```
   npm run catalog
   ```

3. **Run Mochi2D** on it (about 1 min each). Static, sequence and animation
   scenarios run in Node; renders run in headless Chromium:

   ```
   npm run conformance -- out/catalog/static out/catalog/sequence out/catalog/animation --out out/round/results
   npm run render -- out/catalog/render --out out/round/renders
   ```

   `npm run conformance` exits 1 because 54 validation scenarios fail to
   load, as P8 requires, and `npm run render` exits 1 because of the one
   expected `TextureTooLarge` failure. Each writes one result file per
   scenario either way.

4. **Supply reference results.** The judge compares Mochi2D's results with
   any other set in the same formats (`<id>.result.json`, `<id>.render.json`,
   `<id>.png`): an earlier Mochi2D release, or another runtime. Put them in
   one folder, for example `out/reference/`. Subfolders are fine: results
   are paired by scenario ID, not by path. This repository contains no
   reference results and no third-party software. If you produce results
   with other software, its license terms are yours to follow.

5. **Judge**:

   ```
   npm run judge -- out/reference out/round --catalog out/catalog
   ```

   It prints the passes and failures per group, the first failing check of
   every failed scenario and the advisories, and writes the full report to
   `judge-report.json` (`--out` to change). It exits 0 when every scenario
   passes. Validation cases are scored against P8's Required column, which the
   catalog index carries (C27), so the reference's verdicts on them do not
   matter.

6. **Clean up** when done: `rm -rf assets/models/crafts out/catalog out/round`.
   The crafted files must never be committed (they are gitignored).

The sections below describe each tool.

## The catalog: `npm run catalog`

Generates every input from DeepSeek-chan's files in `DeepSeek/` (about 10 s):

- **Crafted model files** under `assets/models/crafts/` (gitignored, about
  840 MB): the moc crafts P1–P8 (version relabels, canvas flag, big-endian,
  the v6 conversion, q2c/q2d, the narrowed-key crafts, q4c and the 61
  validation cases), the oversized-texture craft `texbig`, and the animation
  folders `anim/` and `anim-q/` with their settings, motions, expressions,
  poses, physics files and WAV sounds. DeepSeek-chan's unchanged files are
  linked, not copied. Never commit any of these files.
- **Scenario files** under `out/catalog/<kind>/<group>/<id>.json`, with an
  index `out/catalog/index.json` (`mochi2d-catalog/0`) that lists every
  scenario's ID, kind, group and file, and for the 61 validation cases their
  official and required verdicts.

Crafted `.moc3` files keep every section in slot order (C26), as the official
consistency check requires; only the validation crafts break the rules, on
purpose.

The dsrand scenarios are checked against the published check values before
anything is written. Options: `--crafts <dir>`, `--out <dir>`.

Tests do not need the files on disk: they build the same crafts in memory
(`tools/lib/catalog/virtual.ts`).

## Evaluation: `npm run conformance`

Reads scenario files and folders (recursively), dispatches on `format` and
writes `<out>/<id>.result.json`:

| Scenario format | Run protocol | Result format |
| --- | --- | --- |
| `mochi2d-scenario/0` | fresh instance, inputs, one evaluation (a `render` block is ignored) | `mochi2d-result/0` |
| `mochi2d-sequence/0` | one instance, `create` then one evaluation per step; values persist | `mochi2d-sequence-result/0` |
| `mochi2d-anim-scenario/0` | the frame procedure per frame, commands, recording | `mochi2d-anim-result/0` |

The tools write these names. Files from before the project was renamed
(`lively2d-scenario/0`, `lively2d-result/0` and so on) are still read: the
conformance runner, the judge and resultdiff treat a `lively2d-` prefix as
`mochi2d-`.

Files whose keyform draw orders lie outside their group's range load with
a warning per object in the result's `warnings`; `--strict-draw-orders`
rejects them instead (`ModelLoadError`), for validation runs.

Error kinds: `ModelLoadError` (settings, `.moc3`, physics or pose file),
`InvalidScenario` (malformed file, unknown format or major version, broken
rule), `RandomExhausted` (animation; the completed frames stay). A leading
byte-order mark is skipped and unknown keys are ignored. Animation results
print float32 quantities as the shortest decimal of the float32 value and
doubles (time, free values, lip sync) as doubles; a free value that was
never written is `null`.

## Renders: `npm run render`

Renders scenarios with a `render` block in headless Chromium, in the
reference configuration of 4f: no antialiasing, one 4096 mask per masked
drawable, 256 × 256 offscreen masks, every mask mesh rasterized, full
resolution textures. It writes `<out>/<id>.png` (8-bit RGBA, **premultiplied**)
and always `<out>/<id>.render.json` with `format`, `scenario`, `producer`,
`error`, `png` (the file name or null), `alpha`, `width`, `height`,
`pixelsPerUnit`, `center`, `masks` and statistics. A texture larger than
8192 fails with `TextureTooLarge` and no PNG. `--alpha straight` writes
PNGs for viewing; they are never used for conformance.

## The judge: `npm run judge`

`npm run judge -- <referenceDir> <candidateDir> [--catalog out/catalog] [--out judge-report.json] [--json] [--all]`

(also `npm run resultdiff -- --judge …`). It reads every `*.result.json` and
`*.render.json` below both folders, pairs them by scenario ID and applies
the final rules of 4l in the order of 4m: error state, exact structural
checks, exact values, toleranced values.

| Kind | Rules |
| --- | --- |
| static, sequence | canvas, IDs and lists exact; parameter values and part opacities exact (float32); `visible` and `renderOrder` exact for every drawable; `drawOrder` exact for visible ones; vertices ≤ 2·10⁻⁵ per coordinate for **every** drawable; opacity and colors ≤ 10⁻⁵ for visible ones; offscreens likewise |
| render | both succeed or both fail (`TextureTooLarge` by kind); same size; RMS ≤ 1.0, F₄ ≤ 2 %, F₈ ≤ 0.5 %, N₁₆ ≤ max(8, 0.03 % of W·H) on premultiplied pixels |
| animation | `ids` and recorded frames exact; time ≤ 10⁻⁹; parameters ≤ 10⁻⁶·max(1, R); parts and model opacity ≤ 10⁻⁶; free values and lip sync `null` only against `null`; discrete fields, `starts` and `randomUsed` exact; hit tests exact where decidable (margin 10⁻³) |
| validation (with `--catalog`) | the candidate rejects exactly the cases P8 requires it to reject; the reference's verdict is only noted (C27) |

The report lists, per scenario, pass or fail, the first failing check and
the largest difference of every toleranced quantity with its location, and
per group the passes, failures and largest differences. Advisories never
fail a round: static vertex differences above 10⁻⁵, renders above the
expected values (RMS 0.1, or more than 4 pixels with d > 8), animation parameter
differences above 10⁻⁷·max(1, R), undecidable hit tests, and the optional
strict check of C10 on non-visible drawables. With `--catalog`, the scenario
list and groups come from the catalog index (a scenario with no result on a
side fails), and parameter ranges R come from each scenario's model file.
The exit code is 0 when every scenario passes.

The pairwise `npm run resultdiff -- a.result.json b.result.json` remains for
exploring a single difference (docs/resultdiff.md); its
tolerances are the provisional ones of static evaluation.

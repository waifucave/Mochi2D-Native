# resultdiff — compare conformance result files

`resultdiff` compares two `mochi2d-result/*` files (or two directories of them)
and reports where they differ. It is meant for comparing Mochi2D's output with
reference output, and is usable by anyone who can run Node ≥ 20: the built CLI
(`dist/tools/resultdiff.js`) is a single file with **no runtime dependencies**
(Node built-ins only). The comparison logic lives in `tools/lib/result-diff.ts`,
which has no imports at all.

```sh
# once; produces dist/tools/resultdiff.js
npm run build
npm run resultdiff -- ref/deepseek-default.result.json out/deepseek-default.result.json
npm run resultdiff -- ref/ out/ --tol-vertex 1e-3 --out diff-report.json
# the same thing, without npm
node dist/tools/resultdiff.js a.result.json b.result.json --json
```

By convention **a** is the reference and **b** the candidate. All checks are
symmetric except the "only in a / only in b" lists.

## Inputs

- **Two files:** compared directly.
- **Two directories:** every `*.result.json` below each directory is paired by
  its relative path. Files present on only one side are listed and make the run
  fail. Unreadable or malformed files are recorded as failed entries; the run
  continues.

A file must be a JSON object whose `format` starts with `mochi2d-result/`.
Otherwise (and for unreadable files in two-file mode) the tool exits with code 2.

## What is compared

| Check | Compared | Rule |
|---|---|---|
| `error` | the `error` field of both files | must be `null` in both |
| `canvas` | every value inside `canvas`, recursively | numbers within `--tol-canvas`; everything else equal; keys must match |
| `parameterIds`, `partIds`, `drawableIds` | the ID sets | no ID only on one side, no duplicate IDs |
| `parameterValues` | `value` per parameter ID | within `--tol-parameter` |
| `partOpacities` | `opacity` per part ID | within `--tol-part` |
| `drawableOrder` | relative order of the drawable IDs present in both | identical |
| `vertexCount` | length of `vertices` | identical (and even) |
| `vertices` | each vertex `(x, y)` | Euclidean distance within `--tol-vertex` |
| `visible` | `visible` | identical booleans |
| `opacity` | drawable `opacity` | within `--tol-opacity` |
| `drawOrder`, `renderOrder` | the numbers | within `--tol-draw-order` / `--tol-render-order` (default 0 = exact) |
| `multiplyColor`, `screenColor` | each channel | within `--tol-color` |

Missing values, non-numbers and `null` where a number is expected (for example
a `NaN` that was serialized as `null`) count as **invalid** and always fail.

For each drawable the report gives the vertex count, the **maximum** vertex
distance (and at which vertex index) and the **RMS** vertex distance. Across the
file it gives the global maximum (with drawable ID and vertex index), the global
RMS over all compared vertices and the diagonal of the reference's vertex
bounding box, so absolute errors can be put in scale.

## Options

| Option | Default | Meaning |
|---|---|---|
| `--out <file>` | `resultdiff-report.json` | where the JSON report is written |
| `--json` | | print the JSON report instead of the table |
| `--quiet` | | print only the verdict |
| `--top <n>` | 10 | how many of the worst drawables the table lists |
| `--tol <x>` | | sets all numeric tolerances except draw/render order |
| `--tol-vertex <x>` | 1e-4 | vertex distance |
| `--tol-opacity <x>` | 1e-4 | drawable opacity |
| `--tol-color <x>` | 1e-4 | color channels |
| `--tol-parameter <x>` | 1e-4 | parameter values |
| `--tol-part <x>` | 1e-4 | part opacities |
| `--tol-draw-order <x>` | 0 | draw order |
| `--tol-render-order <x>` | 0 | render order |
| `--tol-canvas <x>` | 1e-4 | numbers inside `canvas` |
| `--skip-invisible` | | skip vertex, opacity and color checks for drawables that are invisible in **both** files |
| `--ignore <c1,c2>` | | still report these checks but don't let them fail the run (names from the table above) |

Tolerances are absolute and inclusive: a value passes when `|a − b| <= tol`.
The defaults are placeholders, not a statement of the expected precision.

## Exit codes

- `0`: every check passed (ignored checks excepted)
- `1`: at least one check failed, a result carries an error, or (directory mode)
  files are unpaired or unreadable
- `2`: usage error, or an input in two-file mode that is missing, unreadable or
  not a result file

## JSON report

Two-file mode writes `format: "mochi2d-resultdiff/0"`:

```jsonc
{
  "format": "mochi2d-resultdiff/0",
  "a": { "label": "...", "format": "...", "scenario": "...", "producer": "...", "error": null },
  "b": { ... },
  "tolerances": { "vertex": 0.0001, ... },
  "skipInvisible": false,
  "pass": false,
  "failedChecks": ["vertices"],
  "warnings": [],                      // e.g. scenario IDs differ
  "checks": {
    "vertices": {
      "compared": 15, "mismatched": 1, "invalid": 0,
      "max": { "value": 0.002, "id": "Mesh2", "index": 1 },
      "rms": 0.000516, "tolerance": 0.0001,
      "examples": ["Mesh2"],           // up to 50 IDs involved
      "ignored": false, "pass": false
    },
    ...                                // one entry per check in the table above
  },
  "referenceExtent": 14.14,            // bbox diagonal of a's vertices, or null
  "parameterIds": { "onlyInA": [], "onlyInB": [], "duplicatesInA": [], "duplicatesInB": [] },
  "partIds": { ... },
  "drawableIds": { ... },
  "canvasMismatches": [ { "path": "canvas.height", "a": 50, "b": 51 } ],
  "parameterMismatches": [ { "id": "ParamX", "a": 1, "b": 2, "error": 1 } ],
  "partMismatches": [],
  "drawables": [                       // every drawable; failures first, then by max vertex error
    {
      "id": "Mesh2", "status": "mismatch", "failed": ["vertices"],
      "vertexCount": [3, 3], "maxVertexError": 0.002, "maxVertexIndex": 1, "rmsVertexError": 0.00115,
      // present only when that check failed: [a value, b value]
      "opacity": [1, 0.9], "drawOrder": [500, 501], "multiplyColor": [[1,1,1,1], [1,0.5,1,1]]
    },
    { "id": "MeshX", "status": "only-in-a", "failed": ["drawableIds"] }
  ]
}
```

Directory mode writes `format: "mochi2d-resultdiff-set/0"` with `pass`,
`compared`, `failed`, `onlyInA`, `onlyInB` and `scenarios`: one entry per paired
file with `file`, `pass`, `failedChecks` and the full `report` above (or `error`
if the pair could not be compared).

Infinite or NaN numbers never appear in the report; they are written as `null`.

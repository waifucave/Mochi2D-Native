# Model data: reading, writing and validating `.moc3` files

`mochi2d/headless` (and `mochi2d/node`, which includes it, and the browser
bundle `mochi2d`) reads, writes and validates `.moc3` files without building
an evaluator:

```ts
import { readMoc, writeMoc, validateMoc, type MocData } from "mochi2d/headless";

const { data, version, diagnostics } = readMoc(bytes); // MocData, 1–6, problems that did not stop reading
data.artMeshes.ids[0];                                  // "ArtMesh0"
data.parameters.max[3] = 30;                            // edit in place
const check = validateMoc(data, { version, level: "strict" });
if (check.valid) bytes = writeMoc(data, { version });   // versions 1–5
```

These are part of Mochi2D's documented API and follow semantic versioning
(see [CHANGELOG.md](../CHANGELOG.md)).

- [`MocData`](#mocdata): the type
- [`readMoc`](#readmoc), [`writeMoc`](#writemoc), [`validateMoc`](#validatemoc),
  [`mocModelFromData`](#mocmodelfromdata)
- [The file layout writeMoc writes](#the-file-layout), part of the versioned contract
- [Diagnostics and their codes](#diagnostics)
- [Changing a file's version](#changing-a-files-version)

Labels such as §1b.4 (canvas), §1b.5 (arrays), §1b.6 (object graph), §1b.7
(validation) and §1c (evaluation) name groups of Mochi2D's format rules;
the code's comments use the same labels.

## `MocData`

`MocData` holds everything a `.moc3` file of versions 1–6 stores, as plain
arrays. It is index-based: every "first…" field is an element index into the
named array, and every "…Count" field a number of elements. Byte offsets and
slot numbers are the writer's business and do not appear.

- Each group (for example `artMeshes`) is an object of parallel arrays, one
  element per object. A few groups are single arrays (pools such as
  `keyformPositions`).
- Numbers are typed arrays of the file's element types: `Int32Array`,
  `Float32Array`, `Uint16Array` (triangle and glue vertex indices) and
  `Uint8Array` (flag bytes). IDs are strings (UTF-8, at most 63 bytes, no NUL).
- Fields that only some versions have are optional: a file of version *n*
  has the fields marked *n* or earlier and no others. `readMoc` returns
  exactly the fields of the file's version, and `writeMoc` requires exactly
  those of the version it writes.
- Placeholder arrays (8 bytes per element, ignored by the runtime) are not
  part of the data; `writeMoc` writes them as zeros.

Each type has doc comments in its declaration file. In summary:

| Group | Count | From | Fields |
| --- | --- | --- | --- |
| `canvas` | | 1 | `pixelsPerUnit`, `originX`, `originY`, `width`, `height` (float32 numbers), `flags` (0–255); §1b.4 |
| `parts` | 0 | 1 | `ids`, `band`, `firstKeyform`, `keyformCount`, `initiallyVisible`, `enabled`, `parent`; `offscreen` (6) |
| `deformers` | 1 | 1 | `ids`, `band`, `visible`, `enabled`, `part`, `parent`, `kind` (0 warp, 1 rotation), `kindIndex` |
| `warpDeformers` | 2 | 1 | `band`, `firstKeyform`, `keyformCount`, `pointCount`, `rows`, `columns`; `bilinear` (2); `firstColor` (4) |
| `rotationDeformers` | 3 | 1 | `band`, `firstKeyform`, `keyformCount`, `baseAngle`; `firstColor` (4) |
| `artMeshes` | 4 | 1 | `ids`, `band`, `firstKeyform`, `keyformCount`, `visible`, `enabled`, `part`, `deformer`, `texture`, `flags`, `vertexCount`, `firstUv`, `firstTriangleIndex`, `triangleIndexCount`, `firstMask`, `maskCount`; `firstColor` (4); `blendMode` (6) |
| `parameters` | 5 | 1 | `ids`, `max`, `min`, `defaultValue`, `repeat`, `decimals`, `firstBinding`, `bindingCount`; `firstKey`, `keyCount`, `type`, `firstBlendShapeBinding`, `blendShapeBindingCount` (4) |
| `partKeyforms` | 6 | 1 | `drawOrder`; `offscreenKeyform` (6) |
| `warpKeyforms` | 7 | 1 | `opacity`, `firstPosition`; `multiplyColor`, `screenColor` (5) |
| `rotationKeyforms` | 8 | 1 | `opacity`, `angle`, `originX`, `originY`, `scale`, `mirrorX`, `mirrorY`; `multiplyColor`, `screenColor` (5) |
| `artMeshKeyforms` | 9 | 1 | `opacity`, `drawOrder`, `firstPosition`; `multiplyColor`, `screenColor` (5) |
| `keyformPositions` | 10 | 1 | a `Float32Array` of x, y pairs |
| `bindingIndices` | 11 | 1 | an `Int32Array` of parameter-binding indices, listed by `bands` |
| `bands` | 12 | 1 | `firstEntry`, `entryCount` (keyform bindings, §1b.6.2–3) |
| `parameterBindings` | 13 | 1 | `firstKey`, `keyCount` |
| `keys` | 14 | 1 | a `Float32Array` of key values, ascending per binding |
| `uvs` | 15 | 1 | a `Float32Array` of u, v pairs (v stored top-down) |
| `triangleIndices` | 16 | 1 | a `Uint16Array`, local to each mesh |
| `maskEntries` | 17 | 1 | an `Int32Array` of art-mesh indices; −1 entries are ignored |
| `drawOrderGroups` | 18 | 1 | `firstObject`, `objectCount`, `entryCount` (C6), `maxDrawOrder`, `minDrawOrder` |
| `drawOrderGroupObjects` | 19 | 1 | `kind` (0 art mesh, 1 part), `index`, `nestedGroup` |
| `glues` | 20 | 1 | `ids`, `band`, `firstKeyform`, `keyformCount`, `artMeshA`, `artMeshB`, `firstInfo`, `infoCount` |
| `glueInfo` | 21 | 1 | `weight`, `vertex` (pairs: a vertex of A, then of B) |
| `glueKeyforms` | 22 | 1 | `intensity` |
| `multiplyColors`, `screenColors` | 23, 24 | 4 | `r`, `g`, `b` |
| `blendShapeParameterBindings` | 25 | 4 | `firstKey`, `keyCount`, `baseKey` |
| `blendShapeKeyformBindings` | 26 | 4 | `parameterBinding`, `firstKeyform`, `keyformCount`, `firstConstraintEntry`, `constraintEntryCount` |
| `warpBlendShapeTargets`, `artMeshBlendShapeTargets` | 27, 28 | 4 | `object`, `firstBinding`, `bindingCount` |
| `blendShapeConstraintEntries` | 29 | 4 | an `Int32Array` of constraint indices |
| `blendShapeConstraints` | 30 | 4 | `parameter`, `firstValue`, `valueCount` |
| `blendShapeConstraintValues` | 31 | 4 | `key`, `weight` |
| `partBlendShapeTargets`, `rotationBlendShapeTargets`, `glueBlendShapeTargets` | 32–34 | 5 | `object`, `firstBinding`, `bindingCount` |
| `offscreens` | 35 | 6 | `part`, `flags`, `blendMode`, `firstMask`, `maskCount` |
| `offscreenKeyforms` | 36 | 6 | `opacity`, `multiplyColor`, `screenColor` |
| `offscreenBlendShapeTargets` | 37 | 6 | `object`, `firstBinding`, `bindingCount`: offscreen targets, whose keyforms are offscreen keyforms |

**Colors (§1b.6.8, correction C5).** From version 4, each warp, rotation and art
mesh has a first color entry, and its normal keyform *k* uses entry
`firstColor + (k − firstKeyform)` for both its multiply and its screen color.
The object's range of entries must lie inside both color tables. From
version 5, keyforms also have their own `multiplyColor` and `screenColor`
indices. The runtime reads them only for blend-shape keyforms; normal
keyforms keep the version-4 rule. Genuine files store `firstColor + position`
in them for normal keyforms, equal for multiply and screen; `validateMoc`
warns when they differ (code `color-index`). An exporter should write them
that way. Every such index must lie in [0, N), N being the table size; the
official check also accepts N, Mochi2D does not.

**Offscreens and blend shapes (version 6).** An offscreen's normal keyforms
are its owner part's: `partKeyforms.offscreenKeyform` maps each of the
part's normal keyforms to an offscreen keyform, and both colors of the
owner's offscreen keyform j come from the multiply entry of its first
offscreen keyform + j. A normal keyform with −1 there gives the offscreen
opacity 0 and multiply and screen colors 0. Its blend shapes come only from
`offscreenBlendShapeTargets` (count 37), whose keyforms follow the normal
ones in `offscreenKeyforms`, with their own multiply and screen indices. A
part's own blend shapes (`partBlendShapeTargets`) change the part's draw
order only, so the `offscreenKeyform` entries of its blend-shape keyforms
are never read. An offscreen target's opacity and colors are clamped to
[0, 1] after its deltas; other offscreens are not clamped. The offscreen
target table is checked like the other target tables
(`index-out-of-range`, `range-out-of-bounds`, `keyform-count`: strict).

Every `partKeyforms.offscreenKeyform` entry, of any part and of normal and
blend-shape keyforms alike, must be −1 or a valid index into
`offscreenKeyforms` (`index-out-of-range`, at both levels). Nothing else
about it is checked: an entry may name another offscreen's keyform, an
offscreen keyform may go unreferenced, and an owner's normal keyform may
hold −1. A file with an entry out of range loads only with the load option
`offscreenKeyformRange: "load"` (`RuntimeOptions` too), which reads it as
−1; the official runtime loads such files too, but the format leaves such
an entry's meaning open, so reading it as −1 is Mochi2D's choice. When writing, put −1 in the blend-shape keyforms'
entries, give an offscreen-owning part's normal keyforms their own
offscreen keyforms, and express an offscreen's blend shapes through
`offscreenBlendShapeTargets`, not through the owner part.

**Decimal places.** `parameters.decimals` (d ≥ 0) is not only for display: it
sets the parameter's key tolerance ε = 10^−d (as float32). A value strictly
within ε of a key counts as on that key. A value below f32(k₀ − ε), or at
or above f32(k_last + ε), makes the object inactive, so with a large d and
large keys the last key itself can be out of range. Genuine files store 3
(ε = 0.001).

**Flags.** `initiallyVisible`, `enabled` and `visible` (parts, deformers, art
meshes) and the parameters' `repeat` must be 0 or 1.

## `readMoc`

```ts
readMoc(bytes: ArrayBuffer | ArrayBufferView): { data: MocData; version: MocVersion; diagnostics: MocDiagnostic[] }
```

Reads a file of versions 1–6, little- or big-endian. The arrays are copies,
so editing the data leaves the bytes alone.

- It throws `MocFormatError` when the bytes cannot be read: its `code` is
  `magic`, `version`, `endianness`, `section-bounds`, `negative-count`,
  `name-terminator` or `file-length` (shorter than the header).
- It reports, without failing, what leaves the data intact: a file length
  that is not a multiple of 64 (`file-length`), sections out of slot order
  (`slot-order`, C26), both errors, and a big-endian file (`big-endian`, a
  warning).

## `writeMoc`

```ts
writeMoc(data: MocData, options: { version: MocVersion }): Uint8Array
```

Writes versions 1–5 (`WRITABLE_VERSIONS`). Version 6 is refused until what
writing it needs is confirmed.

- **It refuses, never silently.** It throws `MocWriteError`, whose
  `diagnostics` list every problem: arrays of a later version
  (`field-not-in-version`) or missing ones (`missing-field`), wrong types
  (`value-type`), groups whose arrays differ in length (`length-mismatch`),
  unknown fields (`unknown-field`), IDs over 63 bytes (`name-too-long`) or
  with a NUL (`name-nul`), canvas values that are not float32
  (`not-float32`; use `Math.fround`) or flags outside 0–255 (`value-range`).
- **It refuses data that fails `validateMoc`'s `official` level,** with
  that level's diagnostics. One of its rules can reject sound data: the
  level tests the keyform
  stored at index *i* with the position run length of object *i*, whoever
  owns that keyform (code `position-run`, below). Data laid out like genuine
  files, each object's position runs in keyform order and blend-shape
  keyforms last, passes. Otherwise reorder the runs, or append zero floats
  to `keyformPositions` until every such run ends inside the array.
- **It checks no more than that.** Problems that only Mochi2D's loader
  rejects (keyform counts, key order, cycles and more: the `strict` level)
  do not stop it. Call `validateMoc` before writing.
- **Round trip.** For any data it accepts, `readMoc(writeMoc(d, { version: v }))`
  gives back `d` and `v`.
- **Byte identity.** Equal input gives byte-identical output. Writing the
  data of a file laid out like a genuine file (below) reproduces that file
  byte for byte. This holds for DeepSeek-chan, and the tests check it. Files
  with other padding or alignment get this layout, with the same data.

### The file layout

The layout below is part of the documented, versioned API. A release that
changes the bytes `writeMoc` writes for equal data and version is at least a
minor release (0.x.0 before 1.0) and says so in the changelog; a patch
release never changes them.

- The 64-byte header: `MOC3`, the version, 0 (little-endian), then zeros.
- The offset table (480 slots; 1440 from version 6) and the count table
  (32 entries; 64 from version 5).
- The count table, then the 64-byte canvas block, then every array of the
  version in slot order (C26). Each starts on a 64-byte boundary, except
  that a non-empty ID array follows the placeholder array before it
  directly, as in genuine files.
- An empty array's offset is the next 64-byte boundary. Placeholders,
  padding and unused slots are zeros, and the file length is a multiple of 64.

## `mocModelFromData`

```ts
mocModelFromData(data: MocData, version: MocVersion, options?: LoadMocOptions): MocModel
```

The loaded model, straight from data, without writing a file: for fast
previews in an editor. It is `loadMoc(writeMoc(data, { version }))`: the
same model, and the same errors. It throws `MocWriteError` for data
`writeMoc` refuses (data the version cannot hold, values that are not
float32, or what fails the `official` level) and `MocFormatError` for data
the loader rejects (Mochi2D's own required rejections). It also takes
version 6 data, which `writeMoc` cannot write yet, as read from a version 6
file. Evaluate it with `new ModelInstance(model)`. The model holds copies
of the arrays: changing `data` afterwards does not change the model. To
change a loaded model's values, use value patches (`ModelInstance.patch`,
`MochiModel.patch`; [api.md](api.md#editing-a-shown-model)), which name
these same arrays.

## `validateMoc`

```ts
validateMoc(input: MocData | ArrayBuffer | ArrayBufferView, options?: {
  level?: "official" | "strict"; // default "strict"
  version?: MocVersion;          // required for MocData
}): { valid: boolean; version: MocVersion | null; diagnostics: MocDiagnostic[] }
```

- **`official`**: what the official consistency check rejects (§1b.7, the
  validation crafts of the conformance plan, C26, and the official check's
  verdicts studied since). It reports errors only.
- **`strict`**: everything `official` reports, plus what Mochi2D's loader
  rejects beyond that (the second list of §1b.7, group totals C6, every
  keyform's own position run, and the loader's other checks), plus warnings.
  A file that passes `strict` loads in Mochi2D: the validator runs the loader
  last to make sure.

`valid` means no errors at that level; warnings are allowed. For bytes, the
diagnostics of `readMoc` are included. Big-endian files are an error at both
levels, because the official check rejects them, although Mochi2D and the
official loader read them. `validateMoc` never throws for bad input.

On the 61 validation crafts of the conformance plan (P8's 41 and 20 more
from later verdicts), the official level gives the official verdict and the
strict level the required one, in every case. The tests also check that the
strict level and the loader agree on thousands of single-value changes to
real and synthetic files.

### Where the `official` level is looser than the format

The `official` level mirrors the official check, also where it checks less
than the format needs. `strict` and Mochi2D's loader reject these files:

- **Position runs.** The level tests keyform *i* with the run length of
  object *i* (art mesh or warp *i*), whoever owns the keyform, and only
  requires `0 ≤ firstPosition + length ≤ N`. Keyforms at an index at or past
  the object count, blend-shape keyforms included, are never tested, and a
  start may be negative. So a run can lie outside the array and pass, and a
  valid file can fail (code `position-run`); `official` reports that failure
  too, at both levels.
- **Child groups.** A part's draw-order entry gets only a range check of its
  child group, [−1, group count). A part entry without a child group (−1), or
  with a cycle back to its own group, passes, although its render orders
  are then not a permutation.
- **Color index N.** A version-5 per-keyform color index equal to the table
  size passes.
- **Values.** Non-finite or huge keyform positions pass (`strict` warns:
  `position-value`). Non-finite keyform opacities pass too (`strict`
  rejects them: `opacity-value`; the loader rejects them unless asked to
  load them).

## Diagnostics

```ts
interface MocDiagnostic {
  code: string;                // stable, below
  severity: "error" | "warning";
  kind: MocDataGroup | "canvas" | "file"; // where: a group of MocData
  index?: number;              // the element of that group
  field?: string;              // the field of that group
  message: string;
}
```

So `data[kind][field][index]` is the value a diagnostic is about, for example
`{ code: "index-out-of-range", kind: "artMeshes", index: 3, field: "deformer" }`.

| Code | Level | Meaning |
| --- | --- | --- |
| `magic`, `version`, `endianness`, `file-length`, `section-bounds`, `negative-count`, `name-terminator`, `slot-order` | official | the file itself (§1b.1–1b.5, C26) |
| `big-endian` | official | a big-endian file (a warning from `readMoc`) |
| `index-out-of-range` | official or strict | an index outside its array. Official for parents (parts, deformers), a deformer's part and kind index, every object's band, an art mesh's deformer, every mask entry (listed or not), binding-index entries, every draw-order object's kind, index and child group, first color entries and the version-5 color indices of warp, rotation and art-mesh keyforms, normal and blend-shape ones (an index equal to the table size: strict); strict for the rest |
| `range-out-of-bounds` | official or strict | a run [first, first + count) outside its array; official for art-mesh UVs and color ranges, strict for every keyform's own position run and the rest |
| `position-run` | official | the `official` level's position-run rule fails (above) |
| `flag-value` | official | a flag field other than 0 or 1 |
| `value-range` | official or strict | negative decimal places (official), a negative vertex count (strict) |
| `kind` | official | a deformer kind or draw-order object kind other than 0 or 1 |
| `grid-points` | official | a warp's point count ≠ (rows + 1)(columns + 1) |
| `texture-negative` | official | a negative texture index |
| `negative-count` | strict | a negative count field |
| `parent-order` | strict | a part's or deformer's parent that is not earlier in the file |
| `keyform-count` | strict | a keyform count ≠ the product of its band's key counts, or ≠ a blend shape's key count |
| `no-keys`, `keys-unsorted` | strict | a binding or constraint without keys, or not strictly ascending |
| `min-above-max` | strict | a parameter's minimum above its maximum |
| `binding-ownership` | strict | a (blend-shape) parameter binding owned twice or not at all |
| `parameter-type` | strict | a parameter type other than 0 or 1 |
| `band-overflow` | strict | a band whose keyform count overflows |
| `grid-size` | strict | a warp with fewer than one cell per direction |
| `triangle-count`, `triangle-index` | strict | triangle indices not in threes, or ≥ the vertex count |
| `glue-pairs` | strict | an odd glue-info count |
| `offscreen-link` | strict | offscreens and parts that do not point at each other |
| `group-structure` | strict | an art mesh or offscreen not drawn exactly once from group 0, a cycle |
| `group-total` | strict | a group's `entryCount` ≠ its render-order entries (C6) |
| `load-error` | strict | the loader rejects the file although no other check did (should not happen) |
| `draw-order-range` | warning | keyform draw orders outside the group's range (C12, C25), compared as the runtime reports them (truncated after adding 0.001; in version 5, blend-shape targets clamped to [0, 1000]); drawn by the evaluated value |
| `color-index` | warning | version-5 per-keyform color indices the runtime ignores (C5) |
| `band-mismatch` | warning | a deformer's band differs from its warp or rotation record's, which is the one evaluated |
| `position-value` | warning | non-finite keyform positions |
| `opacity-value` | strict | a non-finite keyform opacity (the official check accepts it) |
| `duplicate-id` | warning | a repeated ID (an ID lookup finds the first) |
| `default-outside-range` | warning | a parameter default outside [min, max] |
| `canvas` | warning | a pixels-per-unit value that is not positive |

`writeMoc`'s codes are listed above. They are also what `validateMoc` reports
for `MocData` whose shape does not fit the version.

## Changing a file's version

The data of version *n* fits another version when it has exactly that
version's fields:

- **Down** (for example 5 → 4): remove the later fields. That is only
  possible when the model does not use what they hold. Blend shapes of
  parts, rotations and glues, for example, need version 5.
- **Up**: add the new fields. 4 → 5 needs `multiplyColor` and `screenColor`
  for every keyform (normal keyforms: `firstColor` + position), and empty
  `partBlendShapeTargets`, `rotationBlendShapeTargets` and
  `glueBlendShapeTargets`. 3 → 4 needs the color entries, every object's
  `firstColor`, the parameters' key lists and types, and empty blend-shape
  groups.

`writeMoc` names every field that does not fit.

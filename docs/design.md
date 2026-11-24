# Mochi2D Native: design

Mochi2D Native is a portable C++17 runtime for models made with Live2D
Cubism. It is a port of Mochi2D, the project's web runtime (the reference in
`reference/mochi2d-0.24.1/`), with the same behavior and, where Mochi2D is
bit-exact, the same bits. This document describes its architecture:
floating point, safety and portability; status returns instead of
exceptions, fdlibm and musl's float32 functions, an allocator per object;
incremental evaluation, the package helper and live input; the reference
renderer, with threads over rows and SIMD for the warp mapping; motion sync
with Mochi2D's own analysis; and a backend-neutral render interface with
its OpenGL, Vulkan, Metal and Direct3D 11 backends (the bindings' design
note is [bindings.md](bindings.md)). The § labels name groups of Mochi2D's
format rules, as its source uses them (§1b the `.moc3` layout, §1c
evaluation, 3a–3x the framework, 4a–4x the conformance tools' formats), and
labels such as "C4" or "S2" name single rules the same way.

Status markers: **done** (built and tested), **started** (partly built),
**planned** (not yet built).

## 1. Layers and modules

```
                 ┌───────────── engine integrations (own repositories) ────────────┐
                 │ Unity (C#)      Godot (GDExtension)      Unreal (plugin)        │
                 └───────────────────────────────┬─────────────────────────────────┘
                                                 │ include/mochi2d.h
 ┌──────────────────────────────── C API (src/capi) ─────────────────────────────────┐
 │ opaque handles, status codes, no exceptions, no global state                      │
 └──────────────┬──────────────────────────────────────────────┬─────────────────────┘
                │                                              │
 ┌──────────────▼───────── framework (src/framework) ──────────┐│  mochi2d-native (tools/cli)
 │ settings · motions + queue (idle weights) · expressions     ││  inspect · validate · evaluate · run
 │ (queue, layers) · physics · pose · eye blink · breath · look││  · render (JSON out), over
 │ · lip sync + WAV + live input · user data · display info ·  ││  conformance (src/conformance):
 │ hit tests · tints · packages · the animator (frame          ││  scenario files, model folders,
 │ procedure) · animation scenarios                            ││  results (std::filesystem)
 └──────────────┬──────────────────────────────────────────────┘│
 ┌──────────────▼──────── render (src/render, §8) ─────────────┐│
 │ the reference renderer: a software rasterizer of Mochi2D's  ││
 │ WebGL2 pipeline (textures, masks, blends, offscreens) ·     ││
 │ the frame plan (the backend-neutral interface, §8.10) ·     ││
 │ gl/: the OpenGL ES 3.0 / GL 3.3 backend (host's context)    ││
 └──────────────┬──────────────────────────────────────────────┘│
 ┌──────────────▼───────────── core (src/core) ─────────────────▼────────────────────┐
 │ moc/   schema · read · io (MocData, write) · structure+validate · model (loader)  │
 │ eval/  instance (plan, bindings, kernels, warp map) · render order · f32          │
 │ snapshot (result shape)                                                           │
 └──────────────┬────────────────────────────────────────────────────────────────────┘
 ┌──────────────▼──────────── util (src/util) ─────────────┐
 │ allocator per object (Heap, HeapScope) · JSON value/    │
 │ parser/writer · JS-compatible number text · UTF-8 ·     │
 │ ToInt32         third_party/fdlibm: V8's fdlibm          │
 └─────────────────────────────────────────────────────────┘
```

Two static libraries and one C library:

| Target | Contents | Depends on |
| --- | --- | --- |
| `mochi2d_core` | `src/util`, `src/core`, `third_party/fdlibm` | the C++17 standard library only |
| `mochi2d_framework` | `src/framework` | `mochi2d_core` |
| `mochi2d_render` | `src/render`: the reference renderer and the frame plan (§8) | `mochi2d_core`; the platform's threads unless `MOCHI2D_THREADS=OFF` (§3) |
| `mochi2d_render_gl` | `src/render/gl`: the OpenGL backend (§8.10) | `mochi2d_render`; no GL library or header (the host's loader) |
| `mochi2d` (shared) / `mochi2d_static` | `src/capi`: the C API of `include/mochi2d.h` | all of the above |
| `mochi2d_conformance` | `src/conformance`: scenario files, model folders, result files | `mochi2d_framework`, `std::filesystem` |
| `mochi2d-native` | `tools/cli`: the command line | `mochi2d_conformance` |
| `fuzz_moc`, `fuzz_json`, `fuzz_anim`, `fuzz_model` | `fuzz/`: fuzz targets | `mochi2d_conformance`, `mochi2d_static` |
| `mochi2d-gl-render` | `tests/gl`: the GL backend's test tool (headless EGL) | `mochi2d_conformance`, `mochi2d_static`, EGL (built where found) |

`core` and `framework` use standard C++17 only: no platform headers, no
`<filesystem>`, no threads. Reading files from disk belongs to the tools
(`mochi2d_conformance`); the libraries take bytes.

The C++ headers under `src/` are internal: bindings use the C API. The C++
namespace is `mochi2d` (`mochi2d::moc`, `mochi2d::eval`,
`mochi2d::framework`); the C API's prefix is `m2d_`.

### 1.1 core: model data (done)

- **`moc/schema`** (Mochi2D `schema.ts`, `data.ts` layout): every array of
  §1b.5 as one row `(field id, key, slot, element type, count entry, first
  version, MocData group, MocData field)`, generated with an X-macro, so the
  reader, the writer, the validator and the MocData groups share one table.
- **`moc/data`**: `MocData` is a table of arrays indexed by field id
  (`data.i32(F::mesh_vertexCount)`); each array is a `mochi2d::Vector` of the
  file's element type (`int32_t`, `float`, `uint16_t`, `uint8_t`,
  `mochi2d::String`).
  `present` marks the fields of the data's version. `Diagnostic` (code,
  severity, kind, index, field, message) is shared by reading, writing and
  validation, with Mochi2D's stable codes (docs/moc-data.md).
- **`moc/read`** (`read.ts`, `byte-reader.ts`): header, offset and count
  tables, bounds, names, either byte order, lenient mode for file length and
  slot order (C26).
- **`moc/io`** (`io.ts`): `read_moc`, the shape check, `write_moc` (versions
  1–5, the layout of genuine files, refusing what the official check
  rejects, and version 6 with `version-unsupported`, as Mochi2D does),
  `write_moc_unchecked`.
- **`moc/structure` + `moc/validate`** (`structure.ts`, `validate.ts`):
  `validate_moc` at the `official` and `strict` levels, for bytes or for
  MocData. The strict level runs the loader last.
- **`moc/model`** (`model.ts`, `from-data.ts`): the loader builds the
  object graph and rejects everything that could make evaluation index out
  of range, loop or hang; `model_from_data` loads MocData without writing a
  file, and copies it (Mochi2D 0.6.0's `mocModelFromData` copies the data:
  later changes to it never reach the model).

### 1.2 core: evaluation (done)

`eval::Instance` (Mochi2D 0.14.0 `instance.ts`, `plan.ts`, `binding.ts`,
`kernels.ts`, `warp-map.ts`, `rotation.ts`, `jacobian.ts`, `render-order.ts`, `f32.ts`): parameter values
and part opacities in; drawables (visibility, opacity, draw order, render
order, multiply and screen colors, vertices), offscreens and part and
deformer activity out. One model (`std::shared_ptr<const moc::Model>`) backs
any number of instances.

Per evaluation, in Mochi2D's order: bindings located (§1c.1–2, with each
parameter's key tolerance), corner weights per band (S2), blend-shape
locations and weights (C1, §1c.4), parts (§1c.5–6), deformers (§1c.7–8),
art meshes (§1c.9, C29), glue (§1c.10, C4), output conversion (§1c.11),
offscreens (§1c.14), render order (§1c.13, C25).

The rules since 0.5.0 (its CHANGELOG; 0.6.0 and 0.7.0 leave evaluation unchanged): blend-shape interpolation with weights
(f32(1 − t), t), or f32(1 − f32(1 − t)) for the other keyform in the segment
that starts at the base key; constraint weights min(1, c₁, …); the
half-open range test f32(k₀ − ε) ≤ v < f32(k_last + ε); version-5 clamps of a
blend-shape target's own values after its blend shapes, added one at a time
(opacity and colors to [0, 1], draw orders to [0, 1000], rotation scale to
[f32(10⁻⁴), 100] and keyform angle to [−3600, 3600], glue intensity to
[0, 1]); visibility for any opacity other than 0; radians as
f32(f32(a·f32(π)) / 180).

**0.8.0's corrections** (its CHANGELOG; 0.9.0 leaves evaluation unchanged,
0.10.0's changes follow the list):

- *Rotation chains.* A rotation under a parent takes the parent's
  orientation from two points mapped through it: its origin O, and the
  probe a length L above it in file coordinates (y down; L = 10 under a
  rotation, f32(0.1) under a warp), which maps to Q. The parent's angle is
  q = atan2f(Q_y − O_y, Q_x − O_x) + f32(π/2) (the unmapped probe's
  direction is −f32(π/2)), wrapped into [−π_f, π_f] by steps of 2π_f, in
  degrees f32(f32(q·180)/π_f); θ = f32(f32(a + P) + base), the base angle
  added last. Radians are not reduced, and the world scale (the keyform's
  times the parent rotation's scale, or the warp's σ) is folded into
  C = f32(s·cosf(r)) and S = f32(s·sinf(r)): a point maps to
  (O_x + f32(C·x − S·y), O_y + f32(S·x + C·y)), and the Jacobians use C and
  S with scale 1. `atan2f`, `sinf` and `cosf` are musl's float32 functions,
  vendored (§3), as the C library computes them, so they agree with
  Mochi2D's own port of the same files bit for bit.
- *Offscreen blend shapes* (version 6): offscreens take blend shapes only
  from their own target table (`offscreenBlendShapeTargets`, count 37;
  their keyform values read straight from the offscreen keyforms) and are
  clamped only when they are targets; a part's blend shapes change its draw
  order only.
- *Mesh colors* are clamped to [0, 1] only where they combine with a parent
  deformer's colors; a mesh without one reports them as interpolated, unless
  it is a blend-shape target.

**0.10.0's changes** (its CHANGELOG):

- *The C29 stale mark.* A mesh whose blend-shape contributions accumulate
  while it is inactive (C29) is marked stale whenever they write its
  vertices, so the incremental and full evaluations agree (below).
- *Offscreen keyform indices* (version 6). A part keyform's
  `offscreenKeyform` is checked at the official level (−1, or an offscreen
  keyform of the part's own offscreen); a normal keyform's −1 gives the
  offscreen opacity 0 and colors 0 in that keyform (no offscreen draws from
  it), and the owner check of the strict level is gone. The load flag
  `M2D_LOAD_OFFSCREEN_KEYFORM_RANGE` (Mochi2D's `offscreenKeyformRange`)
  reads an index out of range as −1, with a warning, instead of refusing the
  file.
- *Mip levels for every texture size* (the renderer, §8.3).

**0.14.0's rules** (its CHANGELOG and `test/bit-exact-vectors.test.ts`,
whose every vector the unit tests check bit for bit; 0.11.0 to 0.13.0 leave
evaluation as it was):

- *The warp mapping.* Outside the grid, the affine form comes from the
  corner diagonals: with a, b, c, d the corners (0, 0), (C, 0), (0, R),
  (C, R), D1 = d − a, D2 = b − c, B_u = (D1 + D2)·0.5, B_v = (D1 − D2)·0.5,
  m = (((a + b) + c) + d)·0.25, A0 = m − D1·0.5, and a point maps to
  (A0 + u·B_u) + v·B_v. Far (u ≤ −2, u ≥ 3, v ≤ −2 or v ≥ 3) it is that form;
  in the band each axis is placed by t ≤ 0: x = (t + 2)/2 on [−2, 0]; t ≥ 1:
  x = (t − 1)/2 on [1, 3]; inside: T = t·n, k = min(⌊T⌋, n − 1), x = T − k.
  Inside, quad cells weigh corners as (((g_y·(g_x·p00) + g_y·(f_x·p10)) +
  f_y·(g_x·p01)) + f_y·(f_x·p11)) and triangle cells as
  ((g_x − f_y)·p00 + f_x·p10) + f_y·p01 below the diagonal and
  ((f_y − g_x)·p11 + g_x·p01) + g_y·p10 above it, in both cell modes and in
  the SSE2 path alike.
- *Child warps under rotations* are carried like vertices, and a
  rotation's mirror flags come from the keyform at the lower corner (both
  as the port already did: the vectors pass unchanged).
- *Ancestor opacities* multiply top-down: the parts' product from the
  topmost down, then the mesh's own.
- *Repeating parameters* are always wrapped, inside the range too:
  u = (v − L)/Δ, v′ = (u − ⌊u⌋)·Δ + L, in float32 (the maximum wraps to the
  minimum).
- *Glue* pairs in float32 in that order, a′ = a + ((b − a)·w_A)·I and
  b′ = b + ((a − b)·w_B)·I, both read before either is written, and glues
  in file order.
- *Constraint weights* in the weighted form, c = (1 − t)·w_i + t·w_{i+1},
  not a lerp.

**Forward mapping** (0.5.0 `mapPoints`, `mapJacobians`): `map_points` maps
points from a deformer's input space through its world form at the last
evaluation, with the evaluator's own float32 operations (so a vertex maps
exactly as evaluation maps it), in model or keyform space; `map_jacobians`
gives the analytic 2×2 Jacobian per point and region, in double.

**Bit-exactness.** Every arithmetic step is one IEEE float32 operation in
Mochi2D's order of operations: Mochi2D rounds each float64 `+ − × ÷` of
float32 inputs with `Math.fround`, which equals the float32 operation.
CMake builds the libraries with `-ffp-contract=off -fno-fast-math` (SSE2 on
32-bit x86; `/fp:precise` on MSVC), so no multiply-add is fused. Integer
conversions follow JavaScript (`ToInt32` of a float32-rounded value for
draw orders). The few double-precision steps of Mochi2D are double here too
(`atan2`, `cos`, `sin`), and the transcendental
functions are V8's own fdlibm, vendored (§3), so they agree with Node's
`Math` bit for bit on every platform.

**The plan (Mochi2D's `plan.ts`).** Built once per instance: compact
keyform values per property; blend-shape values with the base key as zero;
**exact constant folding**: a property whose keyform values are all the same
float32 c, and that no blend-shape step can change, is folded to c while at
most `fold_active` bindings are off their keys (any number for c = ±0, one
for c = ±2^k with k ≥ 0, none otherwise), where the step-by-step sum gives c
exactly; blend-shape steps that can only add ±0 (all their values ±0, finite
constraint weights) are dropped; equal neighbouring channels share one
evaluation; and keyform position runs without −0 are flagged, so a single
keyform is copied (0 + Q = Q) or mapped straight from the keyform data.

**NaN inputs.** Static scenarios only set finite values, but animation can
make a parameter NaN (a lip-sync window without samples, a physics output of
0/0). Mochi2D then reads past the end of its typed arrays, which gives
`undefined` and so NaN: its key search runs to the last key with t = NaN,
every corner weight of the band is NaN, and the warp of a NaN point is NaN.
The native code takes the same paths and reads such positions as NaN
instead of out of bounds (`at_or_nan`, the NaN row of keyform positions,
NaN warp points), so the results stay memory-safe. Folding matters here:
a folded property keeps its constant where the step-by-step sum is NaN, and
a dropped step adds nothing where it would add NaN. Summing step by step
instead differs from Mochi2D at NaN parameters (for example a constant
opacity of 1 comes out NaN); with the plan ported, the
evaluation vectors of the cross-check (NaN, ±∞ and huge parameter values)
match Mochi2D bit for bit.

**Incremental evaluation (Mochi2D's default mode).** Work whose inputs did
not change since the previous evaluation is skipped: a band's corner tables
are recomputed only when one of its bindings moved (the tables of bands with
more than four bindings off their keys are made on demand, once per
evaluation); a deformer's world form only when its band, its blend shapes or
its parent deformer changed; a mesh's vertices only when its band, blend
shapes or deformer changed, or changed while it was inactive (it is then
stale until it is active again); glue only when a glued mesh is inactive,
was inactive, or was recomputed, or a glue's band or blend shapes moved.
Opacities, colors, draw orders, parts and offscreens are evaluated every
time. `InstanceOptions::incremental = false` evaluates everything on every
call (Mochi2D's `incremental: false`, its testing reference). The per-frame
path allocates nothing beyond the first growth of the big corner tables.
`drawable_vertex_version` counts the writes of each vertex array (renderers
skip uploads), `evaluations` the calls, and `last_work` what the latest call
recomputed.

**Persistent state.** Results depend on earlier evaluations: an inactive
drawable keeps its last outputs (C10), an inactive mesh accumulates its
blend-shape position contributions (C29), and glue on an inactive mesh
accumulates (C4). The instance keeps all of this, in both modes.

**The two modes agree.** Up to 0.9.0, a mesh with blend shapes that became
inactive through its part or its deformer kept accumulated C29
contributions in the incremental mode when it became active again, while a
full evaluation recomputed them (the cross-check found 2 such steps in
4,720). 0.10.0 marks the mesh stale whenever C29 writes its vertices, and so
does the port: the modes now differ in none of the cross-check's steps.

**SIMD.** `warp_points` maps four points per pass with SSE2 where the target
has it (x86-64, 32-bit x86 with SSE2; `MOCHI2D_SIMD=OFF` keeps the scalar
path). Each lane does what the scalar loop does for its point, operation for
operation (IEEE single operations, no contraction): the cell from truncated
u·C and v·R limited to C − 1 and R − 1, the corners as two rows of four
floats per point transposed into lanes, bilinear weights, or both
triangles' formulas with the one the scalar test (fx + fy ≤ 1) picks.
Points outside the grid, and NaN, take the scalar `warp_outside`, from the
coordinates as loaded (so mapping in place works). A unit test compares the
two paths on random grids and points, edges and special values included,
and the cross-check runs on the SIMD path.

**Evaluation switches** (experimental, Mochi2D 0.21.0's `evaluation`):
`InstanceOptions::glue` and `blend_shapes`, both true by default, and
`m2d_instance_create_with_options` in the C API. With `glue` false the glue
pass does not run and no mesh is marked glued, so glued meshes keep their
own positions. With `blend_shapes` false the plan is built from empty
blend-shape lists for every object, as if the file had none (each instance
has its own plan, so instances with and without blend shapes share one
model). With both true, nothing changes. `evaluation_switches_0_21_0`
compares each setting with Mochi2D's outputs and with the same model built
without the feature (`tests/fixtures/switches/`).

### 1.3 framework (done)

Mochi2D 0.14.0's `src/anim/` and model settings, file by file
(`mochi2d::framework`):

- **`settings`** (`model-settings.ts`): the settings file in full: file
  references (the motion-sync file included), named expressions, motion
  groups in `Object.entries` order (integer-like names first) with fade
  overrides, sounds and motion-sync settings, parameter groups (EyeBlink,
  LipSync), hit areas and layout; `normalize_path`.
- **`values`** (`values.ts`): parameter values (float32, limited or wrapped,
  blended in double, stored as float32), free values for IDs the model lacks
  (doubles), part opacities and free part entries, the model opacity.
- **`motion`, `motion_queue`** (`motion.ts`, `motion-queue.ts`): motion files
  with the validation of 3c.4 and the order rule of 3c.2, curve evaluation
  (linear, Bézier restricted or solved with Mochi2D's cubic solver, stepped,
  inverse stepped, the loop's end interval), the queue with priorities, sine
  fades, curve fades, loops (with and without fade-in, legacy), events,
  `hold` and `blinkWhileHeld`, the ends of motions, and **idle weights**
  (0.7.0): motions started at the idle priority move a parameter by w·k of
  the way, skip it at k = 0, and keep the unweighted arithmetic without a
  weight (`set_idle_weight` limits to [0, 1], and 1 removes).
- **`expression`** (`expression.ts`): files, the queue of 3m (tracked IDs,
  Add/Multiply/Overwrite blending, the fade-in sum) and expression layers;
  since 0.13.0 fade times per call (a start's fade-in and fade-out, a
  clear's and a layer removal's fade-out, instead of the file's).
- **`physics`** (`physics.ts`): files with the Meta totals of 3e.1 and the
  pendulum simulation of 3n (input interpolation in float32, internal rate,
  output interpolation, settle), and 0.8.0's runtime controls (not
  reference behavior): a strength k for the model and per setting (their
  product), where each output moves its parameter by k of the way from the
  value it would have without physics (0 is physics off, 1 the reference
  bit for bit, above 1 limited to the parameter's range); wind read at every
  step, and since 0.13.0 a wind multiplier per setting (`setSettingWind`:
  its pendulums see the wind times it, 1 by default); and the hold of physics outputs in frames that take no time
  (`hold_on_zero_steps`, off by default: the reference rule). 0.10.0's
  **state and rate**: `save_state`/`restore_state` bit for bit (Mochi2D's
  `mochi2d-physics-state/1`: the shape, then the doubles of every
  particle, output and input), and the step rate as an option (0 to 1000
  steps a second; none: the file's `Fps`). 0.16.0's **step limit** (not
  reference behavior): a frame takes at most 10,000 internal steps, then
  drops the time beyond them but for the remainder (ρ mod h), and an
  infinite `Fps` (a file's `1e309`) steps once a frame, as 0 does: an absurd
  rate no longer hangs the first update (`PhysicsRig::kMaxStepsPerFrame`).
- **`pose`** (`pose.ts`), **`effects`** (`effects.ts`: eye blink, breath,
  look), **`lip_sync`** (`lip-sync.ts`: WAV decoding of 3s.1, the RMS of
  3s.2, a live input with its mix modes), **`model_data`** (`model-data.ts`:
  vertex bounds and hit tests, user data, display info and its labels).
- **`live_input`** (`live-lip-sync.ts`): the microphone processing in the
  library, the host giving the samples (planar, interleaved, or as sums of
  squares): the 3s.2 RMS of the samples since the previous frame, a noise
  gate in dBFS, a gain, attack/release smoothing over the samples' duration
  (frame-rate independent), the held value on frames without samples,
  silence after 0.1 s, a dropped backlog beyond the window; pushes may come
  from an audio thread (a spin lock guards the sums). It is a
  `LiveLipSyncSource`, so it plugs into the animator's live lip sync.
- **`tints`** (0.7.0 `setTint` and kin): an RGBA per art mesh, stored as
  float32, kept by the C API's instance as draw data; since 0.14.0 the color
  is limited to [0, 2] (`M2D_MAX_TINT`) and the alpha to [0, 1], and a color
  above 1 brightens up to white: when a channel of the tint is above 1, the
  color after the tint's multiply is limited to the texel's alpha
  (premultiplied white), in all three renderers.
- **`package`** (`runtime/bundle.ts`, `core/io/file-source.ts`, the model
  runtime's caches): a settings file and its companions through a
  `FileSource` (the host's files): the settings path given or the shallowest
  `*.model3.json`, the `.moc3`, physics, pose, display info and user data
  (problems with optional files as warnings, in Mochi2D's words), Mochi2D's
  path rules (`normalizePath`, `joinPath`, `dirnameOf`), and motions,
  expressions and sounds by settings-relative path, cached by resolved path.
- **`animator`** (`animator.ts`): the frame procedure of 3j: restore, the
  motion queue (or an idle start), save, then eye blink, expressions, look,
  breath, physics, lip sync, motion sync and pose, each switchable (motion
  sync before physics as an option); `apply_to` hands the values to an
  instance.
- **The lip-sync fallback** (Mochi2D's `ModelRuntime` option
  `lipSyncFallback`, not reference behavior): when the settings' `LipSync`
  group has no IDs, or there is no such group, lip sync and the motions'
  `LipSync` curves drive the fallback parameter if the model has it. The
  C API's default is Mochi2D's, `"ParamMouthOpenY"`
  (`m2d_animator_options.lip_sync_fallback`; NULL turns it off, the
  reference animator's rule, which the C++ `AnimatorOptions` keeps as its
  default); `m2d_animator_lip_sync_fallback` tells which parameter was
  applied. The motion-sync model check runs on settings with an empty
  `LipSync` group and with none.
- **Motion sync** (0.9.0's `src/anim/motion-sync/`; §1.5).
- **`animation_scenario`** (`anim/scenario.ts`): the run protocol of 4j over
  a file source, with the reference's warnings and its random sequence.
- **`conformance/formats`** (`conformance/formats.ts`): the sequence and
  animation scenario formats with every `InvalidScenario` rule and message,
  and their result objects.

**JavaScript semantics.** Where Mochi2D's results depend on JavaScript
itself, the port reproduces it: `Math.min`/`Math.max` with NaN and signed
zeros (`js_min`, `js_max`); `String()` of JSON values in messages; plain
objects used as maps, where a key such as `toString` or `__proto__` finds a
property of `Object.prototype` (an effect named `toString` is accepted and
does nothing, a curve target named `toString` disables the order rule of
3c.2, a `__proto__` key in a `parameters` object is dropped); `??` treating
`null` as missing (`"random": null`); `new Array(n)` refusing n ≥ 2³²
(a `RangeError`); the TypeErrors V8 raises for a physics setting without
vertices or a fractional output vertex index, with V8's messages; the
`RangeError` of a WAV whose samples have no size (`Invalid typed array
length: Infinity`); and typed-array reads past the end (NaN, §1.2).

**Errors without exceptions.** Parsers return `bool` with a `FormatError`
(Mochi2D's `AnimationFormatError` message); what Mochi2D raises while a frame
runs (the random sequence running out, a `RangeError` for a random number
outside [0, 1), the physics TypeErrors) comes back as a `Fault` (error name
and message) from `Animator::frame`, and the scenario runner turns it into
the reference's result. Where Mochi2D never finishes (a physics step or a
loop length that leaves its loop counter unchanged), the port stops the
loop instead of hanging; no result exists to compare there.

### 1.4 Data layout: structure of arrays

As in Mochi2D, every object kind is a set of parallel arrays, by index:

```cpp
struct Model {
  struct { Vector<String> ids; Vector<float> min, max, defaults; … } parameters;
  struct { Vector<int32_t> band, first_keyform, part, deformer, texture, vertex_count; …
           Vector<Vector<float>> uvs; … } meshes;
  struct { Vector<float> mesh_opacity, mesh_draw_order; Vector<int32_t> mesh_first_position; …
           ColorIndices mesh_colors; … } keyforms;
  Vector<float> positions;               // the shared keyform position pool
  Vector<Band> bands;                    // binding lists, strides, keyform counts
  …
};
```

The instance's outputs are parallel arrays too (`drawable_opacity[i]`,
`drawable_vertices[i]`, …), so the C API hands out pointers into them
without copying. Per-object evaluation plans (keyform values per property,
blend-shape values with the base key as zero, position offsets) are built
once per instance from the model.

### 1.5 Motion sync (done)

Mochi2D 0.9.0's motion sync, ported file by file; the mouth shapes follow
Mochi2D's analysis (no other analysis engine is downloaded, run or licensed
for this project). These rules hold
throughout: no "CRI" in a name or an interface (the `AnalysisType` value in
files is data, read as it is: `kMotionSyncAnalysisType`); the engine's
smoothing stays non-linear (slew limits); the file's per-parameter `Smooth`
stays behind its one switch (`file_smoothing`), off by default since
Mochi2D 0.20.0 (the dead band, `Damper`, applies either way); the analysis is ported as it
is, with nothing added (no vocal-tract estimation of any kind).

- **`motion_sync`** (`file.ts`): the lenient reader, with Mochi2D's warnings
  word for word (missing or ill-typed values take defaults; `Scale`
  [0.1, 10], `BlendRatio` [0, 1], `Smooth` [0, 100], `Smoothing` read as an
  integer from its decimal text, [1, 100], `SampleRate` [1, 120] or 60 when
  not positive; settings by position for the smaller of `SettingCount` and
  `Settings`; mappings and targets matched by ID; the lint option over
  `Object.keys` order), and the lookup by dictionary name, then by ID.
- **`motion_sync_driver`** (`parameter-filter.ts`, `driver.ts`, `wav.ts`):
  the per-parameter filter (smoothing, then the dead band), the analysis
  tick (at most one a frame, every 1/SampleRate), the engine (the gate,
  `Enabled`, `Scale`, normalization, the blend, the shape, slew limits
  towards a shape at the attack rate, 0.02·25^((Smoothing−1)/99) seconds a
  full swing, and back 1.5 times slower), and the driver: a sound analyzed
  ahead of its playback (the window centered on the sample heard) with its
  own reference level and noise, a playback clock or the frames' steps,
  sample accounting, a fade when stopped early, silence fed until every
  parameter is within its `Damper` of the Silence shape or 0.5 s pass, a
  live input's newest window (resampled as it arrives), only the bound
  setting writing, and a new binding starting from the parameters' current
  values. `decode_motion_sync_wav` reads 8- to 32-bit PCM and 32- and 64-bit
  float, also extensible. `MotionSyncLiveInput` is the input the C API's
  host feeds, from an audio thread if it likes (a spin lock over a ring of
  fixed size).
- **`motion_sync_analysis`** (`analysis.ts`): the windowed-sinc resampler to
  16 kHz, the 512-sample window with its level, the radix-2 FFT, band
  shares, periodicity by autocorrelation, 20 mel bands, the cepstral
  distance after noise masking, a sound's statistics, the noise tracker of a
  live input, the vowel analyzer (gate, hangover, openness), voice profiles
  as Mochi2D's JSON, and the calibration. Every step is in double precision
  with V8's fdlibm, so the analysis is Mochi2D's bit for bit.
- **The neutral templates.** Without a profile, the analysis compares with
  a neutral synthetic voice in four sizes, which Mochi2D builds at run time
  with its vowel synthesizer (cascade formant resonators). The synthesizer's
  formant filters make test sounds only, so the library holds
  the neutral profile as data (`motion_sync_neutral.cpp`, exact hexadecimal
  values), generated by the test port of the synthesizer and the library's
  calibration (`tests/motion_sync/make_neutral.cpp`), and checked by the
  unit tests and against Mochi2D's own `neutralVoiceProfile()`, byte for
  byte. The synthesizer is test code only (`tests/support/`).
- **`motion_sync_runtime`** (the motion-sync part of `model-runtime.ts`): a
  motion's linked sound bound to its entry's setting when the start is
  accepted (with Mochi2D's warnings when the model has no file, the setting
  is missing or cannot run, or the WAV cannot be decoded, once), sounds
  played through a setting, live inputs, and the end of a motion's sound: it
  plays once, fades out with its motion over the motion's fade-out time,
  and stops when the motion is stopped or replaced early.
- **In the animator**: the `motion_sync` effect switch; motion sync after
  lip sync and before pose, or before physics (`before_physics`), where
  Mochi2D's animator runs it; lip sync leaves the parameters that the bound
  setting drives.
- **In the package**: `FileReferences.MotionSync`, read leniently with the
  other companions (its warnings after theirs), and sounds decoded for
  motion sync once per resolved path.

Sample rates are limited to 1 to 1000 kHz (decoding refuses others):
Mochi2D takes any rate, but at extreme rates its resampler's table or its
output grows without bound.

## 2. The C API

`include/mochi2d.h` documents every function; the overview:

```c
/* basics: version, m2d_status + m2d_error (stable code, message), m2d_free_string,
   m2d_allocator { allocate, deallocate, user } given when an object is created */

/* validation and models */
m2d_status m2d_validate_moc(bytes, size, level, allocator, &valid, &report_json, &error);
m2d_status m2d_model_load(bytes, size, flags, allocator, &model, &error);
/* … parameters, parts, drawables (UVs, indices, masks), deformers, offscreens */

/* instances: inputs, evaluation, draw data, forward mapping, hit tests */
m2d_status m2d_instance_create(model, &instance, &error);   /* the model's allocator */
m2d_status m2d_instance_set_parameter(instance, index, value);
m2d_status m2d_instance_evaluate(instance, &error);
m2d_status m2d_instance_drawable_state(instance, index, &state);
m2d_status m2d_instance_copy_drawable_vertices(instance, index, out, capacity, &written);
m2d_status m2d_instance_map_points(instance, deformer, points, count, space, out);
m2d_status m2d_instance_drawable_bounds(instance, index, box);
int32_t    m2d_instance_hit_test(instance, index, x, y);

/* framework files, parsed from bytes, immutable, shareable */
m2d_status m2d_settings_parse(bytes, size, label, allocator, &settings, &error);
m2d_status m2d_motion_parse(…);      m2d_status m2d_expression_parse(…);
m2d_status m2d_physics_parse(…);     m2d_status m2d_pose_parse(…);
m2d_status m2d_sound_decode(…);      m2d_status m2d_user_data_parse(…);
m2d_status m2d_display_info_parse(…);
m2d_status m2d_display_label(info, model, kind, row, &index, &label, &group);

/* the animator: the frame procedure */
m2d_status m2d_animator_create(model, settings, physics, pose, &options, &animator, &error);
m2d_status m2d_animator_update(animator, instance, dt, &frame, &error);  /* frame + apply + evaluate */
int32_t    m2d_animator_start_motion(animator, motion, &start, sound);
m2d_status m2d_animator_set_idle_motions(animator, motions, count);
m2d_status m2d_animator_start_expression(animator, expression);
m2d_status m2d_animator_start_expression_fades(animator, expression, fade_in, fade_out); /* 0.13.0; NaN: the file's */
m2d_status m2d_animator_clear_expression(animator, fade_out);
m2d_status m2d_animator_add_expression_layer_fades(…);  m2d_animator_remove_expression_layers_fade(…);
void       m2d_animator_set_look_target(animator, x, y);
m2d_status m2d_animator_start_sound(animator, sound);
m2d_status m2d_animator_set_live_lip_sync(animator, next, mode, mix, user);
m2d_status m2d_animator_set_parameter(animator, id, value);   /* the base value */
double     m2d_animator_parameter(animator, id);              /* the latest frame, effects included */
double     m2d_animator_parameter_base(animator, id);         /* the base value (0.7.0 getParameterBase) */
m2d_status m2d_animator_set_idle_weight(animator, id, weight); /* 0.7.0 idle weights */
m2d_status m2d_animator_set_effect(animator, effect, on);
m2d_status m2d_animator_set_physics_strength(animator, k);     /* 0.8.0: and per setting, wind, hold */
m2d_status m2d_animator_set_physics_setting_strength(animator, id, k);
m2d_status m2d_animator_set_physics_wind(animator, x, y);
m2d_status m2d_animator_set_physics_setting_wind(animator, id, multiplier); /* 0.13.0; and get, reset */
void       m2d_animator_set_physics_hold(animator, on);
m2d_status m2d_animator_set_physics_rate(animator, steps_per_second); /* 0.10.0; reset: the file's Fps */
m2d_status m2d_animator_save_physics_state(animator, out, capacity, &written);  /* bit for bit */
m2d_status m2d_animator_restore_physics_state(animator, state, size, &error);

/* motion sync (0.9.0; Mochi2D's own analysis): files, sounds, live input, profiles */
m2d_status m2d_motion_sync_parse(bytes, size, label, flags /* lint */, allocator, &file, &error);
m2d_status m2d_motion_sync_sound_create(channels, count, frames, rate, allocator, &sound);
m2d_status m2d_motion_sync_sound_decode(wav, size, allocator, &sound, &error);   /* a helper */
m2d_status m2d_motion_sync_input_create(rate, capacity, allocator, &input);
void       m2d_motion_sync_input_push(input, samples, count);                    /* any thread */
m2d_status m2d_animator_set_motion_sync(animator, file, &options /* before physics, … */);
m2d_status m2d_animator_start_motion_sync(animator, sound, setting, clock, user, &error);
m2d_status m2d_animator_bind_motion_sync(animator, ticket, sound, setting, path, clock, user);
m2d_status m2d_animator_set_motion_sync_input(animator, input, setting, &error);
void       m2d_animator_stop_motion_sync(animator, fade);
int32_t    m2d_animator_motion_sync_tick(animator, &tick);   /* weights, level, values */
m2d_status m2d_voice_calibration_add(…);   m2d_status m2d_voice_profile_parse(json, …);

/* tints: draw data of the instance (0.7.0 setTint) */
m2d_status m2d_instance_set_tint(instance, drawable, rgba, 3 or 4);
const float* m2d_instance_drawable_tints(instance);           /* NULL while none is set */

/* the live input: microphone processing in the library, samples from the host */
m2d_status m2d_live_input_create(sample_rate, &settings, window, allocator, &input);
void       m2d_live_input_push(input, channels, channel_count, frames);   /* any thread */
m2d_status m2d_animator_set_live_input(animator, input, mode, mix, user);

/* packages: a settings file and its companions through the host's files */
m2d_status m2d_package_open(&source /* read, release, list */, settings_path, flags, allocator,
                            &package, &error);
m2d_model* m2d_package_model(package);   const m2d_settings* m2d_package_settings(package);
m2d_status m2d_package_motion(package, path, &motion, &error);    /* cached by resolved path */
m2d_status m2d_package_group_motion(package, group, index, &entry, &error);
m2d_status m2d_package_start_motion(package, animator, group, index, &start, clock, user,
                                    &accepted, &error);   /* with the entry's motion-sync link */

/* rendering: the reference renderer (§8), into memory the caller owns */
m2d_status m2d_texture_create(pixels, width, height, stride, allocator, &texture, &error);
m2d_status m2d_renderer_create(model, textures, count, &options /* masks, threads */, &renderer, &error);
m2d_status m2d_renderer_draw(renderer, instance, &frame /* view, background */, width, height,
                             pixels, stride, &error);   /* with the instance's tints */
m2d_status m2d_renderer_update_texture(renderer, index, pixels, w, h, stride, x, y, &error); /* 0.14.0 */
void       m2d_renderer_stats(renderer, &stats);

/* GPU rendering (§8.10): the frame plan for a binding's own backend, or the OpenGL backend */
m2d_status m2d_render_plan_create(model, texture_present, count, &options, &plan, &error);
m2d_status m2d_render_plan_frame(plan, instance, &frame, width, height, &error);
const m2d_render_op* m2d_render_plan_ops(plan, &count);   /* plain structs, in drawing order */
m2d_status m2d_gl_renderer_create(model, textures, count, loader, user, &gl_options, &gl, &error);
m2d_status m2d_gl_renderer_draw(gl, instance, &frame, width, height, framebuffer, &error);
```

Conventions (with bindings to other languages in mind): opaque handles; plain structs
(`m2d_error`, `m2d_drawable_state`, `m2d_allocator`, `m2d_frame`,
`m2d_motion_start`, `m2d_animator_options`); no C++ types across the
boundary; `NULL` handles are safe; strings are UTF-8; caller-owned buffers
where they help (vertex copies, mapping), and pointers into the library's
arrays where zero-copy matters (they live as long as their owner,
evaluation outputs until the next evaluation); strings allocated for the
caller are freed with `m2d_free_string`. The library reads no files: hosts
pass bytes, and resolve the settings' relative paths themselves. Callbacks
(the random sequence, a live lip-sync input and its mix function) are plain
function pointers with a user pointer.

The file objects are immutable once parsed and reference-counted inside:
an animator keeps the model, settings, physics, pose, motions, expressions
and sounds it uses alive, so handles can be destroyed in any order.
`m2d_animator_parameter` reads a parameter's value in the latest frame,
effects included (0.7.0's `getParameter`: the animator values' `get`),
`m2d_animator_set_parameter` sets its base value, which shows from the next
frame, and `m2d_animator_parameter_base` reads it (`getParameterBase`: the
saved value of a model parameter, the free value otherwise), with
`m2d_animator_parameter_base_values` for all of them.

**Packages.** The host reads files, the library resolves them: an
`m2d_file_source` has `read` (bytes for a normalized path, released through
`release`), an optional `list`, an optional `size` (a file's size without
reading it), and a label for messages. A package reads within Mochi2D
0.24.0's file caps (`m2d_package_limits`: 1 GiB a file, 2 GiB in all by
default, each file counted once): a file past one is refused before `read`
when `size` knows it, else before the bytes are copied, with
`M2D_LIMIT_ERROR` and FileLimitError's message (a companion's becomes a
warning, as in Mochi2D's bundle loader). A package owns the
handles it gives out (settings, model, companions, motions, expressions,
sounds); animators and instances made from them keep what they use alive.
`m2d_sound_unusable()` stands for a sound that names a file which cannot be
used: given where a sound is expected, it stops lip sync, as Mochi2D's null
sound does, so idle entries with such a sound behave as in Mochi2D.

**Physics state and rate (0.10.0).** `m2d_animator_save_physics_state`
writes the physics state as a self-describing blob: a magic and the format
version, then Mochi2D's `mochi2d-physics-state/1` (the shape: settings, per
setting its particles and outputs, the work length; the data: the rate
state, then every particle's position, velocity and gravity, every output's
values and the inputs, as doubles), so a restore is bit for bit. A state
saved from other physics settings is refused (`physics-state`), a model
without physics too (`no-physics`). `m2d_animator_set_physics_rate` sets
the steps per second (0 to 1000; `reset` returns to the file's `Fps`).

**Motion sync** (§1.5). A motion-sync file is parsed as the other files;
`m2d_animator_set_motion_sync` gives it to an animator with its options
(before physics; the file's smoothing; the settle time; the gate and the
hangover), and `M2D_EFFECT_MOTION_SYNC` switches it. The host hands over
samples: a sound (its samples, or a WAV through the decoding helper) with
its playback clock (a function that returns the seconds played, or none:
the frames' steps), or a live input it pushes into from any thread. The
library opens no device. Each analysis reports a tick: the element weights
(Silence, A, I, U, E, O), the level, the silence flag and the values
written, polled after a frame or given to a listener. Calibration takes a
recording of each vowel (and of the room) and makes a voice profile, which
reads and writes the same JSON as Mochi2D's. A motion's link: when a start
is accepted, `m2d_animator_bind_motion_sync` binds the entry's sound to its
setting with Mochi2D's runtime rules (it plays once, fades with its motion,
stops when the motion is replaced or stopped early; problems are the
animator's warnings), and `m2d_package_start_motion` does the whole start
of a settings entry, as Mochi2D's runtime starts it.

**Rendering.** A texture takes straight RGBA8 pixels (any stride) and its
own allocator, and is prepared as Mochi2D prepares it; a renderer takes its
model's allocator and keeps the model and its textures alive. A draw writes
premultiplied RGBA8 rows, top to bottom, `stride` bytes apart, into the
caller's buffer (nothing else is touched), with the framing of an optional
frame description (a view, or the canvas fitted into the image) and its
background, and the instance's tints; `m2d_render_framing` gives the
framing without drawing. `options.threads` chooses the threads (§3).

**Stability**: `docs/api-stability.md` lists every function,
type and constant of `mochi2d.h` with its mark for 1.0 (stable or
experimental), generated by `tests/api/api_list.py` from the header and the
rules of `tests/api/marks.txt`; the `api-list` test fails when the header
changes without it. The GPU layer and live motion sync are experimental.
The shared library exports exactly the header's functions: every library
is built with hidden symbols, and the shared one links with a version
script (ELF) or an exported-symbols list (Apple); `api-exports` checks it
with `nm` or `dumpbin` on each platform.

**Packages**: `cmake --install` puts `mochi2d.h`, the shared
library (`mochi2d::mochi2d`, its soname the minor version before 1.0), the
static libraries (`mochi2d::mochi2d_static`, which brings its component
libraries and `M2D_STATIC`), `mochi2dConfig.cmake`, `LICENSE`,
`THIRD_PARTY_NOTICES.md` and the stability list under the prefix; consumers
use `find_package(mochi2d CONFIG)`. `tests/package/package.sh` builds,
installs and archives a platform's package, then builds `tests/package` (a
C program that loads a model, animates it and draws a frame) against it,
shared and static, and runs it. `release.yml` does that on version tags for
Linux x86-64 and arm64, macOS (universal) and Windows x64, runs the
Platforms workflow (macOS and Windows, Metal and Direct3D 11) as part of
the same run, and creates the release only when both have passed, with the
version's `CHANGELOG.md` section as the release notes. Its gate and last step
are one script, `tests/package/publish.sh`. A release starts either from a
run by hand on `main` with `release` checked (the tag is created with the
release, at that commit) or from a pushed tag `v<version>`. The gate, first
and again just before the release is made, requires the version's
changelog section, no release or tag of the version (a pushed tag must be
the version's, at the run's commit, followed through its tag object when
it is annotated), and `main` for a run by hand. Only a push starts a tag's
release: a run by hand from a tag ref without `release` is a dry run. The
last step takes only the package artifacts, requires exactly the four
files, creates the release as a draft with them (a draft has no tag), checks
that it lists those four with their sizes, reads the tag and the releases
again, and publishes it, which creates the tag. The release is titled
"Mochi2D Native <version>"; the tag keeps its "v". Drafts are visible only
to a token that can write, so the first gate (read-only) says that it cannot
see them, and the last step reports and replaces any it finds. The two
starts differ only in `--verify-tag` (the tag exists) or `--target <commit>`
(the tag is made at publishing). A run by hand without `release` runs
everything up to that call as a dry run. A run by hand with `rehearsal`
(private repositories only) makes every call of a release by hand with a
throwaway tag `rehearsal-<run number>`, as a pre-release titled REHEARSAL,
then deletes the release by its id and the tag, and checks that nothing of
that name is left; it writes to nothing else, and removes what it made when
it fails on the way. `tests/package/publish_test.sh`
runs the script against a stand-in `gh` (the ctest `release-publish`). A tag made with
the workflow's token starts no other run, and no workflow but Release
listens for tags. `CONTRIBUTING.md` says how to start a release. CI
and Fuzz run on branches, not on tags: a tag's commit was checked when it
was pushed.

**Planned:** the library form of conformance results (`scenarioResult`).

## 3. Memory, threading and errors

**Memory.** There is no process-wide setting.
An allocator (`mochi2d::Heap`: allocate and deallocate with size, alignment
and a user pointer; the C API's `m2d_allocator`) is given when an object is
created: a model is loaded with one, a file is parsed with one, a validation
runs with one. Everything created from an object inherits its allocator: an
instance or an animator its model's, a snapshot string its instance's. NULL
means malloc and free. While the libraries work on an object, a `HeapScope`
makes its heap the thread's current one, and every allocation (arrays,
strings, hash maps, the objects themselves, shared-pointer control blocks)
goes to the current heap through `mochi2d::Allocator`. Each block starts
with a 32-byte header that records the heap it came from, so it is always
freed by the allocator that made it, whatever scope is current then. A unit
test runs a whole C API session (validation, loading, an instance, the
framework's files and an animator with motions, expressions, physics, pose
and lip sync) with a counting allocator and a counting global `operator
new`: no global allocation happens, and every byte comes back.

When an allocator returns NULL, the library calls `std::abort()` (built
without exceptions it cannot unwind; with exceptions, `std::bad_alloc`).
Allocation happens mostly at load, parse and creation time; evaluation and
frames reuse their buffers, apart from small per-frame lists (events, motion
ends) and the motion queue's entries.

**Threading.** Objects with different allocators never share memory, and an
object's allocator is called from whichever thread uses the object. The
current heap is per thread. There is no global mutable state (only
immutable tables built on first use, thread-safe by C++11's static
initialization). Different objects are independent and can be used on
different threads at once; one object is not used from two threads at once;
a model may be shared read-only by instances on many threads, and a parsed
file by animators (reference counts are atomic; the last owner frees it
into its own allocator, so that allocator must accept calls from the
threads of those animators).

**The renderer's threads** (threads over rows, behind an option a host can
switch off; the library requires no threads). The only threads
the libraries start: a renderer created with `threads` ≠ 1 (0 for the
hardware's concurrency, at most 64) starts n − 1 workers, the platform's
own threads (POSIX or Windows; nothing goes to the global `operator new`),
whose shared state comes from the renderer's heap. Each pass of a draw (a
mesh, a mask build, a layer composite, the clear, the read-back) splits its
rows into bands, eight per thread, that the threads take in turn; the
calling thread takes part, and returns when the pass is done. Every row
belongs to one band and is drawn in the draw order, so the image is the
same, byte for byte, with any number of threads. Workers never allocate
(their scratch is reserved on the calling thread), run under the caller's
floating-point environment, spin briefly for the next pass and then sleep.
Small passes (under 2048 pixels of work) stay on the calling thread.
`MOCHI2D_THREADS=OFF` builds the renderer without threads; `threads` is then
always 1 in effect. A ThreadSanitizer job in CI runs the unit tests (a
four-thread renderer among them).

**Safety.** The core reads files from the internet. Every offset and count
is bounds-checked as Mochi2D's reader, validator and loader check them
(64-bit arithmetic for every `first + count`), the loader rejects whatever
could make evaluation index out of range, loops over runs are bounded by
the arrays they touch, and reads that Mochi2D makes past the end of an
array give NaN (§1.2). The framework's readers take any JSON and any bytes
for WAV. Fuzz targets (`fuzz/`): `fuzz_moc` (reader, both validation levels,
writer round trip, loader, evaluation and forward mapping), `fuzz_json` (JSON
parser and writers, settings and scenario parsers), `fuzz_anim` (every
framework reader, then an animator with the parsed files on a synthetic
model, evaluated each frame) and `fuzz_model` (Mochi2D 0.16.0's
`model` target: a synthetic model folder, `tests/support/model_folder.hpp`,
with one file replaced by the input, opened through `m2d_package_open` with
its physics, pose, motion sync, an expression and a group motion with its
sound, and stepped), with libFuzzer, ASan and UBSan (UB fatal)
under Clang (`-DMOCHI2D_FUZZ=ON`), briefly in CI on every push and longer on
demand, from the committed corpus (`fuzz/corpus/`); with other compilers
they replay seed files as unit tests.

**Bounds on input a stranger made** (`SECURITY.md` lists them per input,
with numbers):

- **`.moc3`:** the reader checks every field's bounds and names and the
  slot order before it allocates an array, in the order Mochi2D meets the
  errors as it reads, so the first error is Mochi2D's. Validation reads
  overlapping sections as Mochi2D does, but stops when together they claim
  more than 4 file lengths (`kMaxClaimedLengths`), and a report lists at most
  10,000 diagnostics (`kMaxDiagnostics`), then a `diagnostics-truncated`
  warning. Both differ from Mochi2D only on files no tool writes.
- **JSON:** a value is 16 bytes (numbers and booleans inline, strings and
  containers boxed), and an object's repeated keys are merged once, at its
  end, by sorting its keys: O(n log n) for any keys, with no hash to collide.
  The result is JSON.parse's: a repeated key keeps its first place and its
  last value.
- **Package files:** Mochi2D's file caps (above).
- **Textures:** the host decodes; the library checks the sizes it is handed
  (`M2D_LIMIT_ERROR` above `M2D_MAX_TEXTURE_SIDE`).

**Floating point.** The CMake targets set the flags themselves (`PRIVATE`
for the libraries' sources and `INTERFACE` for code that includes their
inline headers): `-ffp-contract=off -fno-fast-math` with GCC and Clang,
`-msse2 -mfpmath=sse` on 32-bit x86; `/fp:precise` (no contraction in
VS 2022) and `/arch:SSE2` on 32-bit with MSVC. `f32.hpp` refuses to compile
when `FLT_EVAL_METHOD` is not 0 or -1, or for 32-bit MSVC without SSE2. A
unit test fails if contraction happens: `fp_contraction_off()` in the core
computes a·b + c on inputs whose fused and unfused results differ (float and
double).

**Transcendental functions.** `third_party/fdlibm` is V8's
fdlibm (`src/base/ieee754.cc` of V8 12.4, the version in Node 22), the code
behind Node's `Math.sin`, `cos`, `atan2`, `acos`, `cbrt`, `exp`, `log`,
`pow` and the rest, in `mochi2d::fdlibm`, under the Sun and V8 (BSD)
licenses (`THIRD_PARTY_NOTICES.md`). Every double-precision transcendental
function of the libraries goes through it; `sqrt` stays the standard one
(IEEE sqrt is exact). The cross-check compares 21 functions with Node's
`Math` on about two million inputs, special values included, bit for bit.
The float32 `atan2f`, `atanf`, `sinf` and `cosf` of 0.8.0's rotation chains
are musl 1.2.6's own files (`third_party/musl`: `atan2f.c`, `atanf.c`,
`sinf.c`, `cosf.c`, `__sindf.c`, `__cosdf.c`, `__rem_pio2f.c`,
`__rem_pio2_large.c`, unchanged, as Mochi2D's `THIRD_PARTY_NOTICES.md`
names them; MIT with Sun's notice), compiled as C99 behind an adapter
header that renames them (`mochi2d_musl_*`, hidden). They are compared with
Mochi2D's TypeScript port on its own vectors, and with musl's compiled
build (`musl-gcc`) on every float32 input (atanf, sinf, cosf; atan2f on
16.8 million pairs and the specials), bit for bit (the `libm32` test; for
two NaN arguments atan2f returns x + y, and which NaN that is follows the
compiler's operand order, so those results compare as NaN).

**Errors.** The libraries are built and tested without C++
exceptions (a CI job builds them with `-fno-exceptions`, GCC and Clang): the
reader, the loader, the writer, the validator and the framework return
`bool` or a status with an error (Mochi2D's stable codes and messages), in
the same order of checks as Mochi2D, which the cross-check confirms
message for message. The checks are written as Mochi2D's are, each one a
`TRY(...)` of a helper that fills the error, so the port stays reviewable
line by line. Validation never fails for bad input: every problem is a
diagnostic. The C API returns an `m2d_status` and fills an optional
`m2d_error` (status, stable code, message).

## 4. Porting map

Mochi2D 0.24.1 (`reference/mochi2d-0.24.1/`) → Mochi2D Native.

| Mochi2D | Native | Status |
| --- | --- | --- |
| `src/core/moc/schema.ts`, `data.ts` (layout) | `src/core/moc/schema.{hpp,cpp}` | done |
| `src/core/moc/data.ts` (types), `read.ts` | `src/core/moc/data.hpp`, `read.cpp` | done |
| `src/core/binary/byte-reader.ts`, `utf8.ts` | `src/core/moc/read.cpp`, `src/util/text.*` | done |
| `src/core/moc/io.ts` | `src/core/moc/io.{hpp,cpp}` | done |
| `src/core/moc/structure.ts` | `src/core/moc/structure.cpp` | done |
| `src/core/moc/validate.ts` | `src/core/moc/validate.cpp` | done |
| `src/core/moc/model.ts`, `from-data.ts` | `src/core/moc/model.{hpp,cpp}` | done |
| `src/core/moc/write.ts` (test writer) | not ported: tests use `write_moc_unchecked` and the reference's own builder | — |
| `src/core/eval/f32.ts` | `src/core/eval/f32.hpp` | done |
| `src/core/eval/binding.ts` | `src/core/eval/instance.cpp` (`locate_key`, `evaluation_value`, …) | done |
| `src/core/eval/plan.ts` | `Instance::build_plan` (folding, dropped steps, shared channels, −0 runs) | done |
| `src/core/eval/kernels.ts` (JS kernels), `warp-map.ts` | `src/core/eval/instance.cpp` (`warp_points`, its SSE2 path, interpolation loops) | done |
| `src/core/eval/rotation.ts`, `src/core/math/libm32.ts` (musl's float32 functions) | `src/core/eval/rotation.hpp`, `third_party/musl` (the C files themselves) | done |
| `src/core/eval/jacobian.ts` | `src/core/eval/instance.cpp` (`warp_jacobian`, `map_jacobians`) | done |
| `src/core/eval/kernels.ts` (WebAssembly), `src/core/wasm/` | not needed (native float32; SSE2 for the warp mapping) | — |
| `src/core/eval/instance.ts` | `src/core/eval/instance.{hpp,cpp}` (incremental and full) | done (value patches later) |
| `src/core/eval/render-order.ts` | `src/core/eval/render_order.cpp` | done |
| `src/core/eval/static-output.ts` | `eval::output_uvs`, `output_triangles` | done |
| `src/core/model/snapshot.ts` | `src/core/snapshot.{hpp,cpp}`, `src/util/json.*` | done |
| `Math.*` of V8 | `third_party/fdlibm` | done |
| `src/core/settings/model-settings.ts` | `src/framework/settings.{hpp,cpp}` | done |
| `src/core/io/file-source.ts`, `model-files.ts` | `src/framework/package.*` (`join_path`, `dirname_of`, `classify_model_file`, `FileSource`) | done |
| `src/anim/json.ts` | `src/framework/jsutil.*` | done |
| `src/anim/values.ts` | `src/framework/values.*` | done |
| `src/anim/motion.ts`, `motion-queue.ts` | `src/framework/motion.*`, `motion_queue.*` | done |
| `src/anim/expression.ts` | `src/framework/expression.*` | done |
| `src/anim/physics.ts` | `src/framework/physics.*` | done |
| `src/anim/pose.ts`, `effects.ts` | `src/framework/pose.*`, `effects.*` | done |
| `src/anim/lip-sync.ts` | `src/framework/lip_sync.*` | done |
| `src/anim/live-lip-sync.ts` | `src/framework/live_input.*` | done |
| `src/platform/live-audio.ts` (browser taps) | the host's audio callback pushes samples | — |
| `src/anim/motion-sync/file.ts` | `src/framework/motion_sync.*` | done |
| `src/anim/motion-sync/parameter-filter.ts`, `driver.ts`, `wav.ts` | `src/framework/motion_sync_driver.*` | done |
| `src/anim/motion-sync/analysis.ts` | `src/framework/motion_sync_analysis.*`, `motion_sync_neutral.cpp` (the neutral templates as data) | done |
| `src/anim/motion-sync/voice-synth.ts` | `tests/support/motion_sync_support.*` (test sounds only) | done |
| motion sync in `src/runtime/model-runtime.ts` | `src/framework/motion_sync_runtime.*`, the C API's animator and package | done |
| `src/anim/model-data.ts` | `src/framework/model_data.*` | done |
| `src/anim/animator.ts` | `src/framework/animator.*` | done |
| `src/anim/scenario.ts` | `src/framework/animation_scenario.*` | done |
| `src/conformance/scenario.ts`, `run.ts`, `models.ts` | `src/conformance/scenario.{hpp,cpp}` | done |
| `src/conformance/formats.ts` | `src/conformance/formats.{hpp,cpp}` | done |
| `src/conformance/results.ts` (library form) | planned (§2) | planned |
| `tools/lib/conformance-runner.ts`, `model-cache.ts`, `model-roots.ts` | `src/conformance/scenario.cpp` | done |
| `src/runtime/bundle.ts` | `src/framework/package.*`, `m2d_package_*` | done |
| `src/runtime/model-runtime.ts` | the C API's animator, instance (tints) and package (file caches) | done (items, patches: SDKs, later) |
| `src/runtime/zip-*.ts` | optional, later (zip packages) | planned |
| `src/core/render/{framing,compositing,masks}.ts` | `src/render/` (§8) | done |
| `src/render/model/`, `src/render/gl/`, `src/render/texture/prepare.ts`, `src/harness/main.ts` (WebGL2) | `src/render/`: the software reference renderer (§8), `m2d_texture_*`, `m2d_renderer_*` | done |
| `src/lib/`, `src/viewer/`, `src/platform/` (browser) | not ported: engines draw with their own renderers | — |
| `tools/mochi2d.ts`, `tools/lib/agent/` | `tools/cli/main.cpp` (`mochi2d-native`) | static commands and `run` done |
| `tools/mochi2d-mcp.ts` | possibly later | — |
| `tools/lib/catalog/*`, `judge*.ts`, `result-diff.ts` | used as they are, from the reference (§5) | — |
| tests: `moc-*`, `eval-*`, `anim-*`, `conformance` | `tests/unit/main.cpp`, `tests/crosscheck/`, `tests/fixtures/` | done |

## 5. Conformance plan

The bar is Mochi2D's catalog as its tools generate it (`npm run catalog`
with DeepSeek-chan; for 0.5.0: 827 scenarios, 665 static, 4 sequence, 54
render, 104 animation), judged by Mochi2D's judge against Mochi2D's results,
and bit-exact wherever Mochi2D is.

1. **Cross-check on synthetic models (runs in CI).**
   `tests/crosscheck/run.sh` builds the reference's tools, then:
   - generates random synthetic models of versions 1–6 with the reference's
     own test builder (`test/support/synth.ts`): parameters with repeat and
     out-of-range keys, bands of up to three bindings, nested warps and
     rotations, points outside warp grids, masks, glue, colors, blend shapes
     on every target kind with constraints, nested draw-order groups,
     offscreens, canvas flag bit 0, draw orders outside their group's range,
     and some files the loader rejects;
   - writes static scenarios on them, sequences, and animation scenarios
     with their files (`tests/crosscheck/anim.ts`): settings variants with
     motion groups (fade overrides, sounds), EyeBlink and LipSync groups;
     motions with every segment kind, Model, Parameter and PartOpacity
     curves, curve fades, events, order-rule violations and broken files;
     expressions with every blend; physics files with every input and output
     type, valid and invalid vertex indices, and broken ones; poses with
     links and unknown parts; WAVs of 8, 16, 24 and 32 bits, mono and
     stereo, with LIST chunks, and malformed ones; and scenarios with dt or
     dts steps (zeros and long steps), random lists (some too short), effect
     switches, idle lists, options, every command, and records with
     parameters, parts, free values, every, hits and drawables; plus one
     malformed scenario per `InvalidScenario` rule;
   - runs the reference's `npm run conformance` and `mochi2d-native run` on
     the same files and requires **byte-identical result files** (only the
     producer differs); the reference's judge runs on them as well;
   - compares validation on every case: both levels' verdicts, versions and
     every diagnostic, the loader's verdict, and `write_moc`'s bytes, on
     single-value mutations of synthetic files, broken bytes, and the 61
     validation crafts of P8 applied to synthetic version-5 files;
   - compares the forward mapping (points and Jacobians) bit for bit;
   - compares the vendored fdlibm with Node's `Math` bit for bit.
   Nothing it generates is committed; it lives in the build folder.
2. **Fixtures (every build).** `tests/fixtures/` holds a small committed set
   of the same kind of synthetic models, files and scenarios with the
   reference's results; the `fixtures` test compares `mochi2d-native run`'s
   results byte for byte without Node, so builds without it (CI's
   no-exceptions, sanitizer and ThreadSanitizer jobs, other platforms)
   check bit-exactness too.
3. **DeepSeek-chan's catalog (by hand, where the model is).** With the model in
   the reference's `assets/models/DeepSeek/`: `npm run catalog` generates
   the crafts and the scenarios; `npm run conformance` gives Mochi2D's
   results; `mochi2d-native run` on the static, sequence and animation
   folders gives ours; the judge and the byte comparison check them. The
   repository's `assets/models/` stays gitignored.
4. **Idle weights, sequences, live input.** The cross-check also compares, bit for bit:
   idle weights (`idle.ts`: the reference's motion queue driven frame by
   frame with weights set, changed and reset; `mochi2d_check_idle`);
   evaluation sequences (`eval.ts`: one instance per model, 40 steps of
   partial changes with NaN, ±∞ and huge values, in Mochi2D's incremental
   and full modes; `mochi2d_check_eval`); and the live input (`live.ts`:
   generated sample blocks, sums, gaps, backlogs, setting and rate changes;
   `mochi2d_check_live`). The scenarios run twice, incrementally and with
   `--full-evaluation`, and both must be byte-identical to the reference.
5. **Renders** (§8.8): the reference renderer's results against Mochi2D's
   renders, by Mochi2D's judge.
6. **Float32 functions and threads.** The float32 functions of the rotation chains:
   the vendored musl files against Mochi2D's own port (`libm32.ts`: its
   vectors, with special values, ranges and random inputs;
   `mochi2d_check_libm32`), and against musl's compiled build (`libm32.sh`,
   the `libm32` test with `musl-gcc`: atanf, sinf and cosf on every float32
   input, or every 61st in CI, and atan2f on 16.8 million pairs). The
   generator also makes offscreen blend shapes (version 6) and opacities
   outside [0, 1] in the render scenes. Every render runs with 1 and with
   more threads, and the images must be the same bytes (`renderer_c_api`;
   by hand, `mochi2d-native render --threads N`).
7. **Motion sync.** `tests/crosscheck/motion_sync.sh`
   (the `motion-sync-check` test): synthetic sounds made by the reference's
   own test support (vowels of a male and a female voice, glides, noise,
   silence, a tone, bursts, mixes, stereo, quiet, loud and clipped clips, at
   8 to 192 kHz, in every WAV encoding), the crafted settings files and
   variants, played through Mochi2D's driver and through
   `mochi2d-native motion-sync-trace` with the same options (frame rates,
   gates, hangovers, the file's smoothing off, live input, stops and fades,
   voice profiles): every analysis (raw weights, voicing, openness, level,
   features), every tick and the values written after each frame must be
   the same bytes; and so must the voice profiles of calibrations
   (`mochi2d-native voice-profile`) and the library's neutral profile.
   `tests/crosscheck/motion_sync_model.sh` (the `motion-sync-model-check`
   test) starts the crafted settings' "Talk" entries on Mochi2D's model
   runtime and through the C API's package helper
   (`mochi2d-native motion-sync-play`), on a synthetic package or, given its
   folder, on DeepSeek-chan, and compares every frame's mouth parameters,
   tick, bound setting and motions playing, and the warnings.
8. **Where each check runs.** On every push (Linux, `ci.yml`): GCC and
   Clang builds with every test, the cross-checks with Node (GCC), musl's
   own build of the float32 functions, the render check with Chromium; the
   no-exceptions build without threads; address, undefined-behavior and
   thread sanitizers. By hand and on version tags (`platforms.yml`): macOS
   (ARM64, Apple Clang, the scalar warp path) and Windows (MSVC, x64), each
   running the unit tests and fuzz replays, the committed fixtures (the
   reference's results without Node), the vendored musl functions against
   the committed digests of musl's own build, and the render fixtures with
   one and four threads against the committed image bytes
   (tests/fixtures/README.md).

## 6. Known risks

- **JSON nesting.** The JSON parser follows V8's (Node 22) on UTF-16 code
  units, so a file that is not valid JSON gives V8's exact message
  (positions, line and column, the excerpt around an unexpected token; the
  cross-check compares 50,000 broken texts), and strings keep lone
  surrogates as WTF-8, printed as `\uXXXX` as `JSON.stringify` does. It
  stops at a nesting depth of 1000 (recursion), where V8 has no limit; no
  model file comes near it.
- **The judge and NaN.** Mochi2D's judge scores a `null` (non-finite)
  value against the same `null` as an infinite difference. Two synthetic
  animation cases with NaN parameters are reported that way although the
  files are byte-identical; the byte comparison is the measure.
- **Math.random.** Mochi2D's animator draws from `Math.random` unless given
  a sequence; the native default is a fixed-seed xorshift128+ (the algorithm
  of V8's `Math.random`, not its seed). Scenarios always give their sequence.
- **Compilers.** Bit-exactness relies on IEEE float32 without contraction;
  the CMake flags enforce it on GCC, Clang and MSVC, and the contraction
  test and the `FLT_EVAL_METHOD` guard catch builds that override them.
- **Incremental against full evaluation.** Since 0.10.0 the two modes agree
  (§1.2); the cross-check still runs both (`--full-evaluation`).
- **Motion sync is Mochi2D's own analysis.** The mouth shapes follow
  Mochi2D's analysis (§1.5), bit for bit; no other analysis is used or
  compared with here. Real voices vary more than the
  synthetic ones of the checks; a voice profile helps.
- **Settings-file ties.** When no settings path is given, Mochi2D picks the
  shallowest `*.model3.json` and breaks ties with `localeCompare`; the
  package helper breaks them in code-point order.
- **Number text.** Result files print numbers as JavaScript does
  (`std::to_chars` shortest round trip, reformatted); libc++ provides
  floating `to_chars` from macOS 13.3.

## 7. Performance

**Evaluation, measured** (`tests/bench/run.sh`): a synthetic model of
DeepSeek-chan's size, built with the reference's own builder from the
structural facts Mochi2D's tests state about it (509 parameters, 147 parts,
723 warps and 99 rotations with the same parent pairs, 715 art meshes with
58,967 vertices and about 88,700 triangles, 155 bands of the same sizes, 38
glues, blend shapes on 349 warps, 13 meshes and 22 rotations, 3.65 million
keyform position floats; 15.7 MiB like the original). Per frame, on one
core of the CI-class machine (Xeon 2.1 GHz, 4 cores), 300 frames each, the
median of three runs:

| frame | full, SIMD | incremental, SIMD | full, scalar | incremental, scalar | recomputed (incremental) | Mochi2D 0.9.0, full / incremental (Node 22, WebAssembly) |
| --- | --- | --- | --- | --- | --- | --- |
| still (no change) | 1.28 ms | 0.14 ms | 2.29 ms | 0.18 ms | nothing | 2.10 / 0.47 ms |
| one parameter changes | 1.76 ms | 0.38 ms | 2.56 ms | 0.47 ms | 78 of 822 deformers, 66 of 715 meshes | 2.76 / 0.94 ms |
| 16 parameters change | 1.49 ms | 1.49 ms | 2.36 ms | 2.31 ms | everything | 2.30 / 2.37 ms |
| all 509 change | 1.81 ms | 1.79 ms | 2.82 ms | 2.86 ms | everything | 2.87 / 2.86 ms |

Every frame's outputs are bit for bit the same in both modes, and the SIMD
path gives the scalar path's bits (§1.2). SIMD makes a full evaluation 1.45
to 1.8 times as fast: the warp mapping (every warp grid through its parents,
every vertex through its deformer) is most of it. The incremental gain is
large when little moves (a paused model, a slider, an eye blink); an idle
animation that moves parameters near the root of the deformer tree (body
angles, breath) recomputes nearly everything, in Mochi2D too.

**Rendering, measured** (`tests/bench/render_bench.cpp`, from `run.sh`):
the same model with its meshes shaped as artwork (`model.ts --render`: each
mesh a triangulated jittered grid over part of its deformer, UVs in its own
cell of a 27 × 27 atlas; 93,872 triangles), one generated 2048 × 2048
texture, the idle workload, and the reference renderer's configuration
(4096² mask buffers; the model's 299 mask entries give 97 mask builds a
frame). The mean of two runs of 10 frames; every thread count gives the
one-thread image bytes in every frame:

| image | fragments a frame | 1 thread | 2 threads | 4 threads |
| --- | --- | --- | --- | --- |
| 512 × 1024 | 1.18 million | 99 ms | 61 ms (1.6×) | 42 ms (2.4×) |
| 1024 × 2048 | 4.72 million | 269 ms | 155 ms (1.7×) | 89 ms (3.0×) |

Before the round's exact shading shortcuts (§8.1), one thread took about
400 ms at 1024 × 2048. At the smaller size the passes are smaller, so more
of them stay on the calling thread and the handoffs weigh more; the mask
builds (the same mask-buffer work at both sizes) scale least.

**Next:** threads for independent subtrees of the evaluation, and SIMD on
ARM (NEON, with an ARM runner to check it against the scalar path).

## 8. The reference renderer (done)

The reference renderer draws an evaluated instance as Mochi2D's reference
renders do: Mochi2D's WebGL2 renderer (`src/render/model/model-renderer.ts`,
`shaders.ts`, `src/render/texture/prepare.ts`) in the reference
configuration of 4f that its render harness uses (`src/harness/main.ts`).
Its results are `mochi2d-render/0` files and premultiplied RGBA8 PNGs that
Mochi2D's judge compares with Mochi2D's renders: same size, RMS ≤ 1.0,
F₄ ≤ 2 %, F₈ ≤ 0.5 % and N₁₆ ≤ max(8, 0.03 % of W·H) on premultiplied
pixels.

### 8.1 Target: a portable software rasterizer

Mochi2D's renders come from WebGL2 in headless Chromium, which here (and on
machines without a GPU) is ANGLE over Vulkan over SwiftShader, a CPU
implementation. The native reference renderer is a software rasterizer in
standard C++17, for these reasons:

- **A reference must not depend on a driver.** The same image on Linux,
  macOS and Windows, x86 and ARM, in sanitizer builds and in CI without a
  GPU; the judge's tolerances then absorb only the differences between this
  rasterizer and Mochi2D's GPU path, not between drivers.
- **No dependencies**, as for `core` and `framework`: no GL loader, EGL or
  window system. The library takes RGBA8 textures; decoding PNG files
  belongs to the tools (§8.7).
- **It is the yardstick for engine renderers.** The SDKs draw with their
  engines (Unity, Godot, Unreal) and compare against the reference
  renderer's images. GPU backends (§8.10) execute the frame plan, the same
  decisions as a list of operations; the OpenGL backend is the first.

Speed is secondary (a reference render is not interactive), but it matters
for the SDKs' tests and for tools: the rows of every pass can be split over
threads (§3), and the shading takes exact shortcuts: b/255 from a table of
the same quotients, round-to-nearest of x·255 by adding and subtracting 2²³
(both identical over every float input), and texture wrapping without a
division for coordinates in range. The measurements are in §7.

### 8.2 The pipeline, as Mochi2D's WebGL2 renderer

Per frame, from the instance's draw data (render order, visibility,
opacities, multiply and screen colors, vertices) and the model's static data
(UVs, triangles, textures, flags, masks, blend modes, offscreens):

1. **Framing** (§2i, `framing.ts`): the image's center in output space and
   k image pixels per unit, from the scenario's view or the canvas fitted
   into the image; output space → image pixels.
2. **Clear** to the background, premultiplied: (r·a, g·a, b·a, a), stored
   as bytes.
3. **Draws in render order** (`drawDirect`): every visible drawable whose
   opacity (times its tint's alpha) is not 0, negative, NaN and infinite
   ones too (0.8.0), clamped at fixed points: the
   compatible blends clamp the source to [0, 1] (NaN to 0), so a negative or
   NaN opacity changes nothing there, and the advanced codes clamp their
   stored result, so such an opacity can brighten or erase; a tint alpha
   of 0 hides the drawable whatever its opacity.
4. **Each draw**: the drawable's triangles (winding already adjusted for y-up
   output) rasterized as the reference's driver rasterizes them (§8.8);
   single-sided drawables (flag bit 2 clear) culled when back-facing
   (counterclockwise is front); per fragment the texel at the interpolated
   UV (§8.3), the fragment color of §2c (rgb·M, then + S·a − rgb·S, then
   the tint), times opacity and the mask factor (§8.4), blended into the
   8-bit target (§8.5).
5. **Version 6 and blend codes** (§2h, `drawLayered`): the layered pipeline
   (§8.6) when the model has offscreens or a drawable blend code the direct
   pipeline cannot draw.
6. **Output**: premultiplied RGBA8, rows top to bottom (the harness's
   readback), with Mochi2D's statistics where they apply.

### 8.3 Textures and sampling

- **Preparation, exact** (§2b, `prepare.ts`): straight RGBA8 texels
  premultiplied as ⌊c·a/255 + ½⌋; a full mip chain whose texels are the mean
  of the 2×2 block below, rounded to nearest with ties to even. Since 0.10.0
  (§2b.3) the rule covers every size: a level is ⌊w/2⌋ × ⌊h/2⌋ (at least 1),
  and a block that reaches past the level above reads its last texel again.
  Up to 0.9.0, other sizes used the platform's `generateMipmap`, which the
  port approximated with a bilinear blit; that is gone.
- **Sampling as GL ES 3.0** with `LINEAR_MIPMAP_LINEAR` minification,
  `LINEAR` magnification and `REPEAT` wrapping: texel coordinates u·w − ½,
  bilinear weights in float32 on bytes/255, trilinear between ⌊λ⌋ and
  ⌊λ⌋ + 1, magnification at λ ≤ 0. For an affine triangle the UV
  derivatives are constant, so λ is computed once per triangle, the way
  the driver computes it: L the larger squared length of the derivative
  vectors in texels (float32), and λ = log₂ √L ≈ ¼·log₂ L² read off the
  float bits of L² (the exponent plus the mantissa as a fraction: log₂
  interpolated linearly between powers of two). The exact log₂ is off by
  up to 0.02 levels; using the driver's form halved the cross-check's RMS.
- **Render targets** (mask buffers, layers) are sampled with
  `CLAMP_TO_EDGE`, as Mochi2D creates them; the left and bottom edges of a
  masked drawable read the buffer's first texels.
- A texture larger than 8192 fails with `TextureTooLarge`, as in the
  harness (WebGL's maximum there).

### 8.4 Masks

The reference configuration (§2g.3, C8, C13), as `model-renderer.ts`:

- **Groups.** Drawables with the same set of mask meshes share a group
  (`maskGroups`), numbered in file order; offscreens likewise.
- **Per-drawable buffers.** Before each masked draw, its group's mask meshes
  are rasterized into an S × S buffer (S = 4096): cleared to 1, then for each
  mask mesh red ← red·(1 − α) with α the mesh's texel alpha (the blend
  ZERO, ONE_MINUS_SRC_ALPHA), stored as a byte after each mesh. Every mask
  mesh is drawn, inactive ones at their stale vertices (C13), culled as
  drawables are. The group box (the members' vertex bounds, with the quirk
  of §2g.2: the maximum starts at the smallest positive double) maps output
  space into the buffer: one buffer pixel per canvas pixel when the box fits,
  else the box plus 5 % per side stretched over the buffer.
- **Only what is read.** Mochi2D clears and draws only inside the box plus
  2 pixels (the scissor), and keeps the buffer when consecutive masked draws
  share a group; the port does the same, so a 4096² buffer costs only its
  used region. Only the red channel is kept (one byte per pixel), since it
  is the only one read.
- **Sampling.** The masked fragment samples the buffer bilinearly
  (clamped to its edges) at its interpolated mask coordinate; the factor is
  1 − red, or red for inverted masks (flag bit 3).
- **Offscreen masks** use their own 256 × 256 buffer; their box covers every
  drawable under the owners (without the quirk; the union over the group's
  owners, C9).

### 8.5 Blend modes and targets

- **Targets are RGBA8**, as Mochi2D's (the canvas, layers, the destination
  copy, mask buffers). A blend reads the destination as byte/255, computes
  in float32 and stores round(255·clamp(x, 0, 1)).
- **Legacy modes** (files up to version 5, §2d), from flag bits 0 and 1
  (additive wins): normal (ONE, ONE_MINUS_SRC_ALPHA for color and alpha),
  additive (ONE, ONE for color; ZERO, ONE for alpha), multiplicative
  (DST_COLOR, ONE_MINUS_SRC_ALPHA for color; ZERO, ONE for alpha).
- **Version-6 blend codes** (§2h.1): codes the direct pipeline can draw
  (0, or color part 1 or 2) blend as the legacy modes; any other code is
  advanced: the shader's color functions B(s, d) of §2h.3 (codes 3–17,
  including the non-separable hue, saturation, color and luminosity
  functions) and the alpha weights (p₁, p₂, p₃) of the alpha parts 0–4, on
  straight colors (premultiplied / α, 0 below α = 10⁻⁵), with the screen
  color applied without the factor a, the mask on the source alpha only,
  and the result written without fixed-function blending.

### 8.6 Offscreens and the layered pipeline (§2h.2–4)

A stack of image-sized RGBA8 layers, cleared to transparent: an offscreen in
render order opens a layer, after closing the layers whose owner is not a
proper ancestor of its owner; a drawable closes the layers whose owner is
not its part or an ancestor of it, then draws into the top layer. Closing a
layer composites it into the layer below as a drawable covering the image:
its texels read one to one (Mochi2D 0.18.0's linearly filtered quad, whose
coordinates fall on texel centers), the offscreen's multiply and screen
colors, opacity, blend code and mask (the mask coordinate of each pixel's
center through D = A · V⁻¹ from its clip-space position, rule I, §8.15); advanced codes read a copy of the layer below,
and their composite covers the whole parent layer (0.8.0). At the end, the
bottom layer goes over the destination (normal blend).

### 8.7 Interfaces

- **C++** (`src/render/`): `render::Texture` (straight RGBA8 in, prepared:
  premultiplied with its mip chain), `render::Renderer` (a model and its
  textures; `draw(instance, frame, image)` with the framing, background and
  tints), `render::Image` (premultiplied RGBA8).
- **C++** also `draw(instance, frame, pixels, stride)` into caller memory,
  `set_threads(n)` and `thread_count()`.
- **C API** (§2): `m2d_texture_create` (straight RGBA8, any stride, its own
  allocator), `m2d_renderer_create` (model, textures, mask sizes, threads;
  the model's allocator), `m2d_renderer_draw` (instance, view, background,
  the instance's tints) into a caller buffer with any stride,
  `m2d_render_framing`, `m2d_renderer_stats`, and `m2d_renderer_update_texture`
  (0.14.0 `updateTexture`, below). A unit test runs it with a
  counting allocator: nothing goes to the global `operator new`, with or
  without threads, and every byte comes back.
- **CLI**: `mochi2d-native render <scenario.json | folder>... --out <dir>
  [--threads N]` writes `<id>.png` (premultiplied) and `<id>.render.json` with the fields
  of Mochi2D's render runner (format `mochi2d-render/0`, scenario, producer,
  error, png, alpha, width, height, pixelsPerUnit, center, masks,
  statistics, notes). PNG decoding and encoding live in the tools
  (a vendored, permissively licensed decoder; a plain encoder).

### 8.8 Matching Mochi2D's renders within the judge's tolerances

The port keeps every formula of Mochi2D's shaders and blend states; what is
left is the reference's rasterizer, which the port follows where it decides
which pixels a triangle covers, and approximates where it only moves values
by a rounding step.

**Rasterization, as the driver does it** (SwiftShader, the CPU Vulkan
driver under ANGLE; GL window coordinates, y up, are its framebuffer
coordinates for offscreen targets):

1. *Clipping.* A triangle with a vertex outside the frustum's sides
   (x or y outside [−w, w]) is clipped in float32 against left, right, top
   and bottom, in that order, each stage keeping the vertices with
   distance ≥ 0 and adding (d_j·V_i − d_i·V_j)·(1/(d_j − d_i)) where an edge
   crosses; a triangle entirely outside one side, or with a non-finite
   coordinate, draws nothing.
2. *Snapping.* Every vertex (the polygon's after clipping) is projected and
   rounded to 1/16 pixel with pixel centers at the integers:
   X = round(16·(W/2) − 8 + x·(1/w)·16·(W/2)) in float32, ties to even.
3. *Facing* from the original triangle's projected vertices: the float32
   area A = (y₀ − y₂)·x₁ + (y₂ − y₁)·x₀ + (y₁ − y₀)·x₂; A = 0 draws nothing,
   A > 0 is back-facing (culled for single-sided drawables), and the outline
   is walked forward for A > 0 and backward otherwise, so that its edges
   toward larger y form its left side.
4. *Spans.* Each non-horizontal outline edge from Y₁ to Y₂ (Y₁ < Y₂) sets,
   for the rows ⌈Y₁/16⌉ ≤ y < ⌈Y₂/16⌉, the left end (an edge toward larger
   y) or the right end (toward smaller y) of the row's span at
   ⌈x-intercept⌉, clamped to the scissor, later edges overwriting earlier;
   a row covers [left, right). Pixel centers on a left edge, or on a
   horizontal edge at the triangle's smallest window y, are inside; on a
   right edge, or a horizontal edge at its largest y, outside.
5. *Varyings* by barycentric weights of the original triangle's snapped
   vertices at the pixel center (exact integers, then float32), extrapolated
   where the clipped polygon reaches past it.

Clipping matters for long edges: the new vertices on the viewport's border
are snapped, which turns the edge inside the image by up to 1/32 pixel, so
whole runs of pixels along it flip. Before the port clipped, zoomed views
failed on such lines; after, no pixel of a version 1–5 render differs by
more than 3.

| Source of difference | Reference (SwiftShader under ANGLE) | Port | Effect, measured |
| --- | --- | --- | --- |
| Coverage | clip, snap, spans, facing as above | the same | none seen in 432 renders, beyond the layered case below |
| Level of detail | log₂ approximated from float bits, per 2×2 quad | the same approximation, per triangle (the derivatives are constant) | ±1 after rounding |
| Varyings | float32 plane equations | barycentrics of snapped vertices | sub-texel; ±1 after rounding |
| Bilinear filter | float32 for these textures (a 16-bit fixed-point emulation matched worse: RMS 0.17 against 0.085) | float32 | ±1 after rounding |
| Blending | float, stored as bytes | the same | ties only |
| Mip chains | Mochi2D's own levels (0.10.0, every size) | the same levels, exactly | none |
| Layers with advanced codes | color without alpha in a layer (below) | the same formulas | isolated pixels flip |

**The layered pipeline's unstable pixels.** An advanced draw adds its screen
color without the texel's alpha (§2h.3, `advancedSource`), and divides by
the alpha for the straight color, which is 0 below α = 10⁻⁵. Where a soft
alpha edge thins out, a texel footprint with alpha exactly 0 draws nothing,
while one with alpha 10⁻⁴ writes the full screen color into the layer, with
an alpha that rounds to 0 or 1. The layer's composite then sees either no
color or a straight color far above 1. A ±1 difference in sampling decides
between the two, so such pixels differ by 30–70 between any two correct
implementations. In the synthetic scenes they are a few isolated pixels per
version-6 render. Once, two such pixels in a 48 × 64 render pushed its RMS
over 1. They stay: 0.8.0's clamp concerns offscreen targets' keyform values,
not layer pixels, and the formula is kept.

**Measuring it.** `tests/crosscheck/render.sh` (a ctest test when
Playwright's Chromium is present; CI installs it) builds synthetic textured
models with the reference's own builder: versions 1–6; textures of
power-of-two and other sizes, with soft alpha edges, noise and one-pixel
checkers; meshes with repeat UVs, reversed windings, culling, legacy blends,
masks and inverted masks, multiply and screen colors; in version 6, blend
codes with every color and alpha part and nested parts owning offscreens
with their codes, colors, opacity and masks. Each model gets four scenarios
(the whole canvas, a posed portrait framing, a zoomed view, a 48 × 64
image). Mochi2D's own harness renders them in headless Chromium,
`mochi2d-native render` renders them, and Mochi2D's judge compares the two:

| Seed, models (against 0.10.0) | Scenarios passed | With advisories | Largest RMS (limit 1) | Largest N₁₆ |
| --- | --- | --- | --- | --- |
| 7, 12 (the ctest default) | 48/48 | 7 | 0.143 | 0 |
| 11, 48 | 192/192 | 25 | 0.839 | 3 |

In both runs, versions 1–5 stay at or below RMS 0.154 with no pixel
differing by more than 3. With Mochi2D's own mip levels for every size, the
advisories fell from 13 and 71 (against 0.9.0) to 7 and 25. The
larger values are the version-6 renders' unstable pixels. (Against 0.7.0:
48/48, 192/192 and, with seed 23, 191/192, the case above.) The images are the same bytes with any
number of threads. The catalog's 54
renders use DeepSeek-chan and crafts made from it, so they run by hand,
where the model is, with `mochi2d-native render`.

### 8.9 Order of work

1. Done: textures (premultiplication, mip chains), framing, the rasterizer,
   the sampler, the direct pipeline with legacy blends and culling; the
   CLI's `render`; the render cross-check.
2. Done: masks (drawable and offscreen buffers, groups, boxes, scissor,
   reuse).
3. Done: the layered pipeline: layers, offscreen compositing, advanced
   codes.
4. Done: 0.8.0's opacity and clamping rules; the C API; rows
   over threads; exact shading shortcuts.
5. Done: 0.10.0's mip levels for every size.
6. Done: the frame plan and the OpenGL backend (§8.10, §8.11).
7. Done: the reference driver for the GL tests (ANGLE over
   SwiftShader, §8.11), the bindings' C API additions, the Vulkan backend
   (§8.12).
8. Done: the Metal and Direct3D 11 backends of the plan (§8.13, §8.14).

### 8.10 The render interface and the OpenGL backend (done)

**The frame plan** (`src/render/plan.hpp`, `plan.cpp`) is what the core
gives a GPU backend: Mochi2D's `ModelRenderer.draw` (the direct and the
layered pipeline, `drawMesh`, `compositeOffscreen`, the drawable and
offscreen masks with their groups, boxes, scissors and reuse) makes its
decisions, and `plan_frame` writes them as operations in drawing order:

| operation | fields |
|---|---|
| `Clear` | the background, premultiplied |
| `BuildMask` | the buffer (per-drawable or offscreen), its size, the scissor, the mask meshes, the mapping |
| `OpenLayer` | the layer (a frame-sized target cleared to transparent) |
| `CopyDestination` | the layer advanced draws read |
| `DrawMesh` | the drawable, the target, the blend (normal, additive, multiplicative, or an advanced code with its color function and alpha mode), multiply and screen colors, the opacity (tints' alpha included) and the tint's color, the mask (buffer, mapping, inverted), culling |
| `Composite` | the layer, the offscreen (or the model layer), the target, and the same blend, colors and mask fields |

with the view (output space to clip space), the number of layers open at
once, and Mochi2D's frame statistics. A `RenderModel` keeps what is
computed once per model (the pipeline, the blend of each drawable, the
mask groups, the offscreens' box members, the output triangles). The plan
holds no GPU object: positions come from the instance, UVs and triangles
from the model, textures from the backend. The software renderer keeps its
own walk of the same decisions (it was first, and its images are
committed byte for byte); the C-API test below checks that the plan's
statistics equal the software renderer's.

**What a backend owns.** Its textures (the prepared levels of
`render::Texture`, uploaded level by level: Mochi2D's exact mips, not the
driver's), one vertex buffer for every drawable (positions per frame,
uploaded only for drawables whose `drawable_vertex_version` changed, keyed
on the instance's serial, since a new instance can take a destroyed one's
address), the UVs and an index buffer, the two mask buffers (RGBA8,
linear, clamped), the layers and the destination copy (RGBA8, nearest,
clamped), and its programs. Its memory comes from the library's
allocators like every object's; the GPU memory is the driver's.

**The host's context and target.** The library opens no window and makes
no context, device or swap chain. The OpenGL backend
(`src/render/gl/gl_renderer.*`) runs in the host's current context and
draws into the host's framebuffer (an RGBA8 color attachment, or 0 for the
default one); the host hands over its loader (`gl_api.hpp`: the functions
are fetched by name, so the library links no GL library and needs no GL
header). Backends for Vulkan, Metal or Direct3D will take the host's device
and command buffer instead; the plan is the same.

**OpenGL ES 3.0 and desktop OpenGL 3.3 core, one code.** The shaders are
Mochi2D's `shaders.ts` as they are (the mesh, layer and mask programs,
with and without the advanced blend functions); only the version line
differs (`#version 300 es` or `#version 330 core`; desktop GLSL accepts the
precision qualifiers). Everything else is the common subset: vertex arrays,
`texelFetch` (the destination copy), `glUniformMatrix4fv` (the mask
matrices), `glBlitFramebuffer` for the destination copy, sized `RGBA8`
textures, `BlendFuncSeparate`. The state is Mochi2D's: blending per kind as
in `blend.ts`, the mask build's scissor, red-only writes and `ZERO,
ONE_MINUS_SRC_ALPHA`, counter-clockwise front faces and back-face culling
for single-sided drawables, no dithering. After a draw, blending, culling
and the scissor test are off, texture units 0–2 and the vertex array are
unbound, and the host's framebuffer is bound.

**The C API** (§2): `m2d_render_plan_*` (create for a model and the
textures a backend has, plan a frame, read the operations as a flat array
of plain `m2d_render_op` structs, the mask meshes, the view, the layer
count, the statistics), for bindings that execute the plan with an
engine's own objects ([bindings.md](bindings.md)); `m2d_gl_renderer_*`
(create with the host's loader, draw into the host's framebuffer, stats);
`m2d_model_drawable_texture_uvs` (the stored UVs, which GPU backends sample
with); and `m2d_gl_options` (ES or desktop, mask sizes, the texture limit).

**Texture updates in place** (0.14.0 `updateTexture`): a texture, or a
region of it the size of a straight-alpha image, replaced after creation.
Level 0's rectangle is premultiplied again, and each level below takes the
rectangle x0 = min(x0 >> 1, w − 1), y0 likewise, x1 = min((x1 + 1) >> 1, w),
y1 likewise, recomputed with the mip rule of §8.3, so the levels equal a
texture made from the new image, byte for byte. The software renderer
copies a texture it shares before it writes (the caller's stays as it was);
the GL backend uploads the rewritten rectangles with `glTexSubImage2D`, the
Vulkan backend copies them from a staging buffer on the context's queue
and waits. A region that does not fit is refused (`texture-region`).
`m2d_renderer_update_texture`, `m2d_gl_renderer_update_texture`,
`m2d_vk_renderer_update_texture`; the tests check that a frame after an
update equals a new renderer's made with the new image, byte for byte.

**The texture limit**: the GL backend takes the context's
`GL_MAX_TEXTURE_SIZE`, as Mochi2D takes the driver's (Mesa's is 16384, so
the catalog's 16384 × 4 texture draws there as in Mochi2D on Mesa);
`max_texture_size` caps it, `M2D_MAX_TEXTURE_SIZE` (8192) for the reference
configuration. `m2d_texture_create` takes sides up to 32768; the software
renderer refuses textures above 8192 when it is created
(`texture-too-large`), the GL backend above its limit (`gl-texture-size`),
both with `M2D_LIMIT_ERROR`.
The test tools' runners (GL and Vulkan) cap at 8192 by default, the
reference configuration's TextureTooLarge, for conformance
runs; `--max-texture-size device` takes the driver's limit, as Mochi2D on
that driver does (for the comparison with Mochi2D on Mesa). The library's
default stays the driver's limit.

### 8.11 Testing the OpenGL backend headlessly

**The drivers.** Two, both without a window system or a GPU:

- **ANGLE over SwiftShader's Vulkan driver**: the reference
  renders' own configuration (Chromium's ANGLE on SwiftShader). ANGLE is
  built from source (`tests/gl/build_angle.sh`: the chromium/8010 branch,
  Playwright's Chromium's, Vulkan backend only; vcpkg's ANGLE port builds
  only the OpenGL backend on Linux), and runs on ANGLE's offscreen Vulkan
  display (`EGL_PLATFORM_ANGLE_ANGLE`, Vulkan, native platform
  `EGL_PLATFORM_SURFACELESS_MESA`) with `VK_ICD_FILENAMES` naming the
  SwiftShader driver beside Playwright's Chromium. OpenGL ES only (ANGLE
  has no desktop OpenGL). Test tooling: the library never links it.
  **In CI** it is a prebuilt asset: `.github/workflows/angle.yml`,
  started by hand when the branch moves, builds it on the runner and
  attaches `libEGL.so`, `libGLESv2.so` and the Vulkan loader ANGLE
  builds and loads from beside them (`libvulkan.so.1`: the system's loader
  refuses ANGLE's instance), with their licenses (`LICENSE-ANGLE`,
  `LICENSE-vulkan-loader`) and the exact revision (`REVISION`), to the release
  `angle-chromium-8010` of this repository
  (`angle-chromium-8010-linux-x64.tar.gz`); CI's gcc job downloads it
  and configures `-DMOCHI2D_ANGLE_DIR` with it, so the ANGLE tests run there
  (they are left out while no such release exists).
- **Mesa's llvmpipe** through EGL's surfaceless platform
  (`EGL_PLATFORM_SURFACELESS_MESA`): an OpenGL ES 3.0 context (Mesa gives
  3.2) and a desktop OpenGL 3.3 core context (Mesa gives 4.5 core).

The test tool loads EGL with `dlopen`: the system's `libEGL.so.1`, or
ANGLE's with `--egl <libEGL.so>`. (Playwright's Chromium links ANGLE into
its own binary, so its `libEGL.so` cannot serve; Mesa's Zink does not take
SwiftShader's Vulkan device.)

**The test tool** (`tests/gl/gl_render.cpp`, `mochi2d-gl-render`, built when
EGL is found) is a host: it makes the context, a framebuffer per frame
size, and reads the pixels back. `render` runs scenarios through the same
runner as `mochi2d-native render` (the drawer is a parameter of
`conformance::run_render`), `compare` compares two folders of PNGs, `capi`
goes through the C API.

**The judge, against the reference renders** (ANGLE over
SwiftShader): `tests/crosscheck/render.sh <build> 12 7 gl-es-angle` (with
`MOCHI2D_ANGLE` naming ANGLE's folder):

| seed, models (renders) | GL backend (ES 3.0) on ANGLE over SwiftShader vs Mochi2D's renders |
|---|---|
| 7, 12 (48) | 48 pass, no advisories; **every PNG byte-identical** |
| 11, 48 (192) | 192 pass, no advisories; **every PNG byte-identical** |

The backend issues what Mochi2D's WebGL2 renderer issues, through the same
ANGLE on the same driver, so the images are the reference's, bit for bit.

**The judge, on the same driver** (Mesa). Mochi2D's own WebGL2 renderer can run on
Mesa too: Chromium with ANGLE over the system's OpenGL ES
(`--use-angle=gl-egl`). `tests/crosscheck/render.sh <build> 12 7 gl-es`
(and `gl-desktop`) renders the synthetic models with Mochi2D twice, on
SwiftShader and on ANGLE over Mesa (`bundle.mjs` swaps that one flag when it
bundles the harness's client; the reference's files are not changed), and
judges the GL backend against the Mesa renders, which it must pass; its
numbers against the SwiftShader renders, and Mochi2D's two drivers against
each other, are reported:

| seed, models (renders) | GL backend vs Mochi2D, both on Mesa | GL backend vs Mochi2D on SwiftShader | Mochi2D on Mesa vs on SwiftShader |
|---|---|---|---|
| 7, 12 (48), ES 3.0 | 48 pass, largest RMS 0.075, no advisories | 31 pass, largest RMS 2.05 | 31 pass, largest RMS 2.05 |
| 7, 12 (48), GL 3.3 core | 48 pass, largest RMS 0.28 | 31 pass | 31 pass |
| 11, 48 (192), ES 3.0 | 191 pass, largest RMS 1.52 (one edge pixel, below) | 112 pass, largest RMS 3.74 | 112 pass, largest RMS 3.74 |
| 11, 48 (192), GL 3.3 core | 191 pass, largest RMS 1.52 (the same pixel) | 112 pass, largest RMS 3.74 | 112 pass |

The renders that fail against SwiftShader are the same, with the same
numbers, for Mochi2D's own renderer on Mesa: llvmpipe's rasterization and
filtering (edge pixels of masks and meshes, minified mips) differ from
SwiftShader's by more than the judge's tolerances, which were set for one
driver. The one failure on the same driver is a single pixel on an edge
where the GL backend gives what SwiftShader and the software renderer give
and Mochi2D through ANGLE on Mesa does not (ANGLE's own transform of
positions on that driver).

**The ctest tests:** `gl-render-es` and `gl-render-desktop` render the
committed render fixtures through the backend and compare them with the
software renderer (RMS ≤ 3 per image: the two follow the same pipeline on
different rasterizers); `gl-capi-*` draw two frames through the C API on a
model with masks and one with offscreens and blend codes, and require the
frame plan's statistics to equal the software renderer's; and
`rendercheck-gl-es`, `rendercheck-gl-desktop` run the judge above. They
skip without an EGL context; CI installs Mesa's EGL and checks that both
contexts exist.

**The catalog** (on the test models, where they are). On ANGLE over
SwiftShader, against Mochi2D's own renders:

```
tests/gl/build_angle.sh ~/angle-build            # once; 1–2 hours (or the release asset, below)
cd reference/mochi2d-0.24.1
npm run render -- out/catalog/render --out out/mochi2d-render
VK_ICD_FILENAMES=<Playwright's chrome-linux64>/vk_swiftshader_icd.json ../../build/tests/mochi2d-gl-render render \
  out/catalog/render --out out/gl-render-angle --models assets/models --api es --egl ~/angle-build/angle/out/vk/libEGL.so
npm run judge -- out/mochi2d-render out/gl-render-angle --catalog out/catalog
```

On Mesa, Mochi2D's render tool on Mesa is the same bundle swap,

```
cd reference/mochi2d-0.24.1
node ../../tests/crosscheck/bundle.mjs . tools/render.ts ../../build/render-mesa.mjs gl-egl
node ../../build/render-mesa.mjs out/catalog/render --out out/mochi2d-render-mesa
../../build/tests/mochi2d-gl-render render out/catalog/render --out out/gl-render --models assets/models --api es \
  --max-texture-size device                      # Mochi2D on Mesa takes Mesa's limit
npm run judge -- out/mochi2d-render-mesa out/gl-render --catalog out/catalog
npm run judge -- out/mochi2d-render out/gl-render --catalog out/catalog
```

### 8.12 The Vulkan backend (done)

`src/render/vk/` (`mochi2d_render_vk`, built where the Vulkan headers are
found): the frame plan executed with Vulkan 1.1 (1.0 and a negative
viewport height), in the host's device, recorded into the host's command
buffer, drawn into the host's image.

**The programs** are the GL backend's text: `render::shader_source` makes a
GLSL 4.50 dialect from it mechanically (the uniforms into one 120-byte
push-constant block, `VulkanPushConstants`, the mask matrix as its rows 0
and 1; samplers at set 0, bindings 0–2;
varyings at explicit locations; `gl_VertexIndex`; `gl_FragCoord` read
through `m2dFragCoord()`, which undoes a flipped viewport).
`tests/vk/make_spirv.sh` compiles it with glslangValidator and writes the
SPIR-V words into `src/render/vk/spirv.inc`, which is committed, so builds
need no shader compiler; the `vk-spirv` test fails while the committed file
is stale (where the same glslang version is installed).

**The host's side.** `VkContext`: its `vkGetInstanceProcAddr`, instance,
physical device, device, and a queue with its family; every function is
fetched through them (`vk_api.hpp`), so the library links no Vulkan loader.
Creation uploads the textures' prepared levels (Mochi2D's exact mips) on
that queue and waits. A draw takes a command buffer in the recording
state, outside a render pass, and a `VkTarget`: an image with a view, its
format (any color format the device blends to), the layout it is in and
the layout to leave it in. The host submits the command buffers to that
queue in the order they were recorded, each before the next draw records;
a draw at another frame size than before waits for the device to be
idle, then remakes the layers (they have the frame's size: rule L samples
a whole layer); and the host
calls `forget_target` before destroying a view drawn into (a framebuffer
is kept per view).

**What the backend owns,** made once: samplers (textures trilinear and
repeating; masks and layers bilinear and clamped; the destination copy
nearest), one descriptor set
layout and pipeline layout, a descriptor set per (texture or layer, mask,
destination copy) in use, one render pass per target format and
orientation (load and store, the image in `COLOR_ATTACHMENT_OPTIMAL`
throughout, layouts changed by barriers between passes), and its pipelines
(program × blend kind × culling); the vertex buffers (UVs and indices
host-visible and static; positions device-local); the mask buffers, layers
and destination copy (RGBA8, the internal format); a 1 × 1 image for unused
bindings.

**A frame,** as the plan says: positions of the drawables whose vertex
version changed (keyed on the instance's serial) with `vkCmdUpdateBuffer`,
recorded into the command buffer, between barriers (so no per-frame buffers
and no frames-in-flight count); then each operation: clears with
`vkCmdClearAttachments` (a mask build's inside its scissor), draws with the
op's pipeline, push constants and descriptor set, the destination copy with
`vkCmdCopyImage`, a render pass begun whenever the target changes and an
image barrier wherever an image changes from being drawn to being read or
copied, or is loaded again by a later pass.

**Orientation.** Masks and layers are laid out as in OpenGL (row 0 where
clip y = −1, `gl_FragCoord.y` counting rows from there), so the programs
and the plan's scissors work unchanged, and front faces are
`VK_FRONT_FACE_CLOCKWISE` (Vulkan's area has the other sign). Into the
host's image, with `flip_y` (the default), the viewport's height is
negative: the image comes out with its top row first, front faces are
counter-clockwise there, and the layer programs read `uFlip` to find their
pixel in the layers.

**The C API**: `m2d_vk_available`, `m2d_vk_renderer_create` (the context
as plain handles, `m2d_vk_context`, so `mochi2d.h` needs no Vulkan
header), `m2d_vk_renderer_draw` (a `VkCommandBuffer` and an
`m2d_vk_target`), `m2d_vk_renderer_forget_target`, stats and the texture
limit (the device's `maxImageDimension2D` by default, as Mochi2D takes the
driver's; `max_texture_size` caps it, `M2D_MAX_TEXTURE_SIZE` (8192) for the
reference configuration: SwiftShader allows 16384, so the
catalog's 16384 × 4 texture draws by default and is refused under the cap,
TextureTooLarge as in the reference, which `mochi2d-vk-render render`
does by default; `vk-capi-*` check both); `m2d_render_shader_source` with
`M2D_SHADER_VULKAN_GLSL_450` and `m2d_render_shader_spirv`.

**Tests** (`tests/vk/vk_render.cpp`, `mochi2d-vk-render`: a headless host
with an instance, a device, an RGBA8 image per frame size and a read-back
buffer): on SwiftShader's Vulkan driver (the one beside Playwright's
Chromium) and on Mesa's lavapipe, the render fixtures against the software
renderer (`vk-render-*`, RMS ≤ 3), two frames through the C API on a model
with masks and one with offscreens and blend codes (`vk-capi-*`, the
statistics equal to the software renderer's), and the judge
(`rendercheck-vk`, on SwiftShader against Mochi2D's own renders;
`render.sh … vk-lavapipe` on lavapipe against Mochi2D on Mesa):

| seed, models (renders) | Vulkan backend on SwiftShader vs Mochi2D's renders | on lavapipe vs Mochi2D on Mesa |
|---|---|---|
| 7, 12 (48) | 48 pass, no advisories, largest RMS 0.010 (no channel more than 1 off) | 48 pass, 6 with advisories, largest RMS 0.28 |
| 11, 48 (192) | 192 pass, 1 with advisories, largest RMS 0.41 | 191 pass (the GL backend's one edge pixel of §8.11, the same numbers) |

On lavapipe the numbers are the GL backend's on Mesa: the driver, not the
API, decides them. Against the SwiftShader renders, lavapipe gives what
Mochi2D on Mesa gives (31 of 48, 112 of 192).

### 8.13 The Metal backend (done)

`src/render/mtl/mtl_renderer.{hpp,mm}` (`MtlRenderer`; Objective-C++ with
ARC, built on Apple platforms): the frame plan executed with Metal in the
host's device, encoded into the host's command buffer, drawn into the
host's texture. The header has no Objective-C; the Metal objects cross as
pointers and the renderer retains what it keeps.

**The programs** are the Vulkan dialect for APIs whose clip space puts
y = +1 at the target's row 0 (`ShaderDialect::Cross450`: the vertex shaders
negate y unless uFlip), compiled to SPIR-V by glslang and translated by
SPIRV-Cross (`tests/gpu/make_shaders.sh`) into MSL 2.0, committed in
`src/render/gpu/cross_sources.inc` (the `gpu-shaders` test fails while it
is stale). Metal compiles them the first time a device is used, and every
renderer on that device shares them. Their resources
are Vulkan's: the 120-byte block at `buffer(0)` in both stages
(`setVertexBytes`, `setFragmentBytes`), uTex, uMask, uDst at texture and
sampler 0–2, the positions and UVs at buffers 1 and 2.

**Orientation.** With flip_y (the default) the host's texture is drawn
upright and the programs leave y alone; masks, layers and a flip_y-off
target are drawn with y negated, so they lie as in OpenGL (row r is
OpenGL's y = r) and the programs' `m2dFragCoord()` and the plan's mask
scissors need no change. Front faces are OpenGL's counter-clockwise as
they look in the image: counter-clockwise into an upright target,
clockwise into the others (the Vulkan backend's rule).

**A frame:** a render pass per change of target (load, or clear for the
plan's Clear and OpenLayer); a mask build clears its scissor to
(1, 1, 1, 1) by a blit of 0xff bytes, then draws its meshes; the
destination copy is a blit. The positions live in one private buffer:
each draw packs the changed drawables' vertices into a staging buffer and
blits only those ranges ahead of its passes, which Metal's hazard tracking
orders after the frames encoded before (as `vkCmdUpdateBuffer`
in Vulkan). Texture updates are blitted at the start of the next draw's
command buffer. The texture limit is 16384 on
Apple and Mac GPUs of Metal 2 (8192 before), capped by
`max_texture_size`.

**C API:** `m2d_mtl_available`, `m2d_mtl_options_default`,
`m2d_mtl_renderer_create` (the device), `_draw` (a command buffer and a
texture), `_stats`, `_max_texture_size`, `_update_texture`, `_destroy`.

### 8.14 The Direct3D 11 backend (done)

`src/render/d3d11/d3d11_renderer.{hpp,cpp}` (`D3d11Renderer`): the frame
plan executed with Direct3D 11 at feature level 11_0 or above, through the
host's device and context, into the host's render target view. It links
no Direct3D library (the host's device makes every object).

**The programs** are the same translation in HLSL for shader model 5.0
(`src/render/gpu/hlsl/`, committed), compiled by fxc, the Windows SDK's
compiler, when the library is built (`/Gis`, IEEE strictness); the backend
is left out where fxc is missing. The block is a constant buffer at b0,
the textures t0–t2 with samplers s0–s2, aPos and aUv TEXCOORD0 and
TEXCOORD1 from two vertex buffers.

**Orientation and faces** as Metal's (§8.13): Direct3D's clip space also
puts y = +1 at row 0, and its rasterizer's winding is the image's.

**A frame:** render targets bound per change of target, the read views
unbound first; a mask build clears its scissor with ClearView
(Direct3D 11.1, or tiles of 0xff bytes through UpdateSubresource without
it); the destination copy is CopySubresourceRegion. Positions and texture
updates go through UpdateSubresource on the context, ordered after the
work already issued. A draw sets the state it needs and leaves no view of
its own bound. The texture limit is 16384 (feature level 11_0), capped by
`max_texture_size`.

**C API:** `m2d_d3d11_available`, `m2d_d3d11_options_default`,
`m2d_d3d11_renderer_create` (device and context), `_draw` (a render target
view), `_stats`, `_max_texture_size`, `_update_texture`, `_destroy`.

**Tests, both backends** (`tests/gpu/gpu_tool.{hpp,cpp}`: one command
line for `mochi2d-mtl-render`, a Metal host on the system's device, and
`mochi2d-d3d11-render`, a Direct3D 11 host on WARP): the render fixtures
against the software renderer (`mtl-render`, `d3d11-render`, RMS ≤ 3), and
through the C API (`*-capi-*`: two frames with the reference renderer's
statistics, the texture limit and its cap, the bottom-row-first
orientation against the upright one, a texture update in place equal to a
new renderer's frame byte for byte, refusals). `platforms.yml` runs them
on the macOS and Windows runners, renders the render cross-check's
scenarios through each backend, and judges them on Linux against
Mochi2D's renders, made once in that run.

### 8.15 Mochi2D 0.18.0's render rules (done)

Mochi2D 0.17.0 and 0.18.0 perform four rendering operations in a fixed
float32 order and rounding (its `docs/rendering.md`), and Mochi2D Native
performs them the same way. Each is mathematically the same as the form
before, but not bit for bit. `render/mask_matrix.{hpp,cpp}` holds
the CPU side, with the rules' vectors as the `render_rules_0_18_0` unit test.

- **V, texture coordinates:** v sampled at f32(1 − f32(1 − v)).
  `RenderModel::uvs` (and the software renderer's own copy) holds the UVs
  so, made once per model; every backend uploads those, mask meshes
  included, and `m2d_render_plan_drawable_uvs` gives them to other plan
  executors.
- **M, mask coordinates:** two float32 matrices per mask mapping, texture
  T(ℓ)·S(s)·T(−b) and clip T(−1, −1)·S(2, 2)·T(ℓ)·S(s)·T(−b), composed
  from the identity left to right, each entry the four-term sum in
  increasing inner index with every addition rounded to float32
  (`multiply_f32`); applied in the vertex shaders as A·(x, y, 0, 1)
  (`uMaskTex`, `uMaskClip`). ℓ is 0: every mask has a buffer of its own.
- **L, layers:** composited by a quad over the viewport, a triangle strip
  of 4 vertices with texture coordinates 0 to 1, the layer sampled with
  linear filtering (layers' samplers and GL filters are linear). So a
  layer must have the frame's size exactly: the Vulkan, Metal and Direct3D
  11 backends remake their layers when the frame's size changes (they had
  kept the largest frame's, which `texelFetch` allowed).
- **I, a masked layer's mask:** D = A · V⁻¹, V the view matrix (output
  space → clip space, float32 entries), V⁻¹ computed in double from them
  and stored as float32, applied to the quad's clip-space corners and
  interpolated.

**In the plan:** `MaskUse::matrix` holds rows 0 and 1 of the matrix a draw
applies (rows 2 and 3 are the identity's): the texture matrix for a mesh,
D for a composite, the clip matrix for a mask build; the C API's
`m2d_render_op.mask_matrix` gives it out. The GL programs take full `mat4`
uniforms as Mochi2D's; the Vulkan block (and through it MSL and HLSL) holds
the two rows and rebuilds the `mat4`, so the product is the same text.

**The software renderer** applies V, M and I with the same matrices in
float32 (A·p + c per vertex, D at each pixel center's clip-space position);
it reads layers one to one as before, which equals rule L's filtered read
at texel centers. It stays not bit-exact with a GPU by design (§8.8): on
the render fixtures, 9 of 30 renders change, by one level in 1 to 14
pixels each.


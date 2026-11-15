/**
 * A model instance: parameter values and part opacities in, drawable and
 * offscreen state out (§1c.0–1c.14). Every arithmetic step is
 * rounded to float32.
 *
 * Keyform interpolation is the float32 weighted sum over the corners of the
 * bindings that are off their keys (S2): starting from +0,
 * r ← f32(r + f32(w·Q)) for each corner in ascending order, each weight a
 * running product in band order of t or f32(1 − t). Draw orders then get
 * their own formula, with its fixed tolerance of 0.001 (see drawOrder).
 *
 * Performance structure (round 01b), with float32 operations kept in exactly
 * the order of the reference formulation:
 * - static data comes from a per-model plan (plan.ts): compact keyform value
 *   arrays and exactly constant-folded properties;
 * - each band's corner weights and offsets are computed once per frame, when
 *   its bindings moved;
 * - position runs are summed four corners per kernel pass;
 * - work whose inputs did not change since the previous evaluation is skipped:
 *   a deformer or mesh is recomputed only if its band, its blend shapes or its
 *   parent deformer changed; glue is re-run from cached pre-glue positions;
 * - all bulk float data (keyform positions, warp grids, vertices) lives in one
 *   heap, processed by kernels (kernels.ts): WebAssembly when available, with a
 *   JavaScript fallback that gives identical results;
 * - the per-frame path allocates nothing, except tables that grow the first
 *   time more than four bindings of a band are off their keys.
 */
import type { MocModel } from "../moc/model.js";
import { appliedValue, evaluationValue, locateBlendKeyAt, locateKeyAt } from "./binding.js";
import { PROBE_ROTATION, PROBE_WARP, probedAngle, rotationCS } from "./rotation.js";
import {
  DRAW_ORDER_TOLERANCE,
  TARGET_ANGLE_LIMIT,
  TARGET_DRAW_ORDER_MAX,
  TARGET_SCALE_MAX,
  TARGET_SCALE_MIN,
  clampTarget,
  fr,
  lerp32,
} from "./f32.js";
import { RenderOrderer } from "./render-order.js";
import { planFor, type EvalPlan, type ScalarProp } from "./plan.js";
import { createKernels, type KernelChoice, type Kernels } from "./kernels.js";
import { rotationJacobian, warpJacobian } from "./jacobian.js";
import { applyPatches, dataRevision, type ValuePatch } from "./patch.js";

export interface InstanceOptions {
  /** Kernel implementation: "auto" (default) uses WebAssembly when available. */
  kernels?: KernelChoice;
  /**
   * Skip work whose inputs did not change (default true). False re-evaluates
   * everything on every call; results are identical (a testing reference).
   */
  incremental?: boolean;
  /**
   * Evaluation stages to leave out (experimental). Both default to true.
   * `glue: false` skips the glue pass, so glued meshes keep their own
   * positions. `blendShapes: false` ignores every blend-shape keyform
   * binding, as if the file had none.
   */
  evaluation?: EvaluationOptions;
}

/** Evaluation stages that can be switched off (experimental); each defaults to true. */
export interface EvaluationOptions {
  /** Join glued meshes' vertices (default true). */
  glue?: boolean;
  /** Apply blend-shape keyform bindings (default true). */
  blendShapes?: boolean;
}

/**
 * The space of mapped points: "model" (model units as in drawableVertices:
 * the output space of §1c.11, y up unless canvas flag bit 0 is set) or
 * "keyform" (the space of keyform positions and world forms, y down).
 */
export type MapSpace = "model" | "keyform";

/** Points per chunk of {@link ModelInstance.mapPoints} through the heap. */
const MAP_CHUNK = 512;

export class ModelInstance {
  // ---- inputs (as applied) ----
  /** Parameter values as applied/reported (§1c.1). */
  readonly parameterValues: Float32Array;
  /** Part opacities as applied (clamped to [0, 1]). */
  readonly partOpacities: Float32Array;

  // ---- outputs ----
  readonly drawableActive: Uint8Array;
  readonly drawableVisible: Uint8Array;
  readonly drawableOpacity: Float32Array;
  readonly drawableDrawOrder: Int32Array;
  readonly drawableRenderOrder: Int32Array;
  /**
   * RGB per drawable: clamped to [0, 1] when combined with a parent
   * deformer's colors or when the mesh is a blend-shape target (version 5
   * and later), otherwise as interpolated.
   */
  readonly drawableMultiply: Float32Array;
  readonly drawableScreen: Float32Array;
  /** Output-space vertices per drawable (y up unless canvas flag bit 0). */
  readonly drawableVertices: Float32Array[];
  /**
   * Per drawable, a counter that changes whenever an evaluation may have
   * written its vertex array. Equal counters mean equal vertices, so renderers
   * can skip re-uploading them.
   */
  readonly drawableVertexVersion: Uint32Array;
  /** How many times {@link evaluate} ran (the creation-time evaluation included). */
  evaluations = 0;
  readonly offscreenOpacity: Float32Array;
  readonly offscreenRenderOrder: Int32Array;
  /** RGB per offscreen: clamped to [0, 1] only for offscreen targets. */
  readonly offscreenMultiply: Float32Array;
  readonly offscreenScreen: Float32Array;
  readonly partActive: Uint8Array;
  readonly partDrawOrder: Int32Array;
  readonly deformerActive: Uint8Array;
  /** The kernel implementation in use. */
  readonly backend: "wasm" | "wasm-scalar" | "js";

  // ---- static ----
  private readonly plan: EvalPlan;
  private readonly hasColors: boolean;
  /** Whether the glue pass runs (`evaluation.glue`). */
  private readonly glueOn: boolean;
  /** Blend-shape targets' own values are clamped (version 5 and later). */
  private readonly clampTargets: boolean;
  private readonly flipOutput: boolean;
  private readonly paramIndexById = new Map<string, number>();
  private readonly partIndexById = new Map<string, number>();
  /** Parts whose opacity multiplies into each mesh (parent chain, stopping at offscreen owners). */
  private readonly meshPartChain: Int32Array[];

  // ---- per-frame binding state ----
  private readonly evalValues: Float32Array;
  private readonly segIndex: Int32Array;
  private readonly segT: Float32Array;
  private readonly segOutOfRange: Uint8Array;
  private readonly segChanged: Uint8Array;
  private readonly bandBase: Int32Array;
  private readonly bandActive: Int32Array;
  /** Active (t ≠ 0) strides and t values, K per band, innermost first. */
  private readonly bandStride: Int32Array;
  private readonly bandT: Float32Array;
  /** Corner weights and keyform offsets (from the band base), 16 per band, for up to 4 active bindings. */
  private readonly bandW: Float32Array;
  private readonly bandO: Int32Array;
  /** Corner tables of one band with more than 4 active bindings, computed on demand. */
  private bigW = new Float32Array(0);
  private bigO = new Int32Array(0);
  private bigBand = -1;
  private bigFrame = -1;
  private frame = 0;
  private readonly bandOutOfRange: Uint8Array;
  private readonly bandChanged: Uint8Array;
  private readonly blendIndex: Int32Array;
  private readonly blendT: Float32Array;
  /** The weights of a blend shape's two keyforms in its segment (see blendStep). */
  private readonly blendWa: Float32Array;
  private readonly blendWb: Float32Array;
  private readonly blendWeight: Float32Array;
  private readonly blendChanged: Uint8Array;
  /** Result slot of locateKeyAt. */
  private readonly locIndex = new Int32Array(1);
  private readonly locT = new Float32Array(1);
  /** Slots per band in bandStride / bandT. */
  private readonly K: number;
  private firstEvaluation = true;
  private readonly incremental: boolean;

  // ---- heap (float indices) ----
  private readonly k: Kernels;
  private readonly heap: Float32Array;
  /** Warp grid per deformer (-1 for rotations). Keyform positions sit at the start of the heap. */
  private readonly gridOffset: Int32Array;
  /** Model-space vertices per mesh before glue. */
  private readonly localOffset: Int32Array;
  /**
   * Each drawable's persistent vertex array, viewed by drawableVertices (C4):
   * refreshed only while the drawable is active, zeros until it
   * first is, and modified in place by glue on every evaluation.
   */
  private readonly outOffset: Int32Array;
  /** Whether each mesh takes part in a glue. */
  private readonly isGlued: Uint8Array;
  /** Activity of each mesh in the previous evaluation. */
  private readonly wasActive: Uint8Array;
  /** Longest float run of any warp grid or mesh. */
  private readonly maxRun: number;
  /** maxRun zeros, never written: what a blend shape's base keyform reads (S4). */
  private readonly zeroOffset: number;
  /** Working space for the warp kernel (16 floats). */
  private readonly scratchOffset: number;
  /** Heap scratch for {@link mapPoints}: MAP_CHUNK points. */
  private readonly mapOffset: number;
  /** Objects a patch touched, recomputed at the next evaluation (see {@link patch}). */
  private readonly meshPatched: Uint8Array;
  private readonly deformerPatched: Uint8Array;
  private gluePatched = false;
  private patched = false;
  /** The model's data revision this instance's heap and state hold; a newer one forces a full pass. */
  private revision: number;
  private fullPass = false;
  /** Two input and two output points for a rotation origin inside a warp. */
  private readonly probeOffset: number;

  // ---- deformer world forms ----
  private readonly deformerDirty: Uint8Array;
  private readonly deformerOpacity: Float32Array;
  /** Accumulated multiply (3) and screen (3) per deformer. */
  private readonly deformerColors: Float32Array;
  private readonly sigma: Float32Array;
  private readonly rotOx: Float32Array;
  private readonly rotOy: Float32Array;
  private readonly rotAngle: Float32Array;
  private readonly rotScale: Float32Array;
  /** C = f32(s_w·cos r) and S = f32(s_w·sin r): the rotation with its world scale. */
  private readonly rotC: Float32Array;
  private readonly rotS: Float32Array;
  private readonly rotMirrorX: Uint8Array;
  private readonly rotMirrorY: Uint8Array;

  // ---- meshes ----
  /** Local vertices recomputed in this evaluation. */
  private readonly meshEvaluated: Uint8Array;
  /** Inputs changed while the mesh was inactive: recompute when it is active again. */
  private readonly meshStale: Uint8Array;
  /** Property values of the object being evaluated (see ObjectPlan.props). */
  private readonly pv = new Float32Array(16);
  /** Single-value result slot. */
  private readonly gv = new Float64Array(1);
  private readonly colors = new Float32Array(6);
  private readonly orderer: RenderOrderer;

  constructor(
    readonly model: MocModel,
    options: InstanceOptions = {},
  ) {
    const m = model;
    const plan = (this.plan = planFor(m, options.evaluation?.blendShapes ?? true));
    this.glueOn = options.evaluation?.glue ?? true;
    const P = m.parameters.ids.length;
    this.parameterValues = Float32Array.from(m.parameters.defaults);
    this.evalValues = new Float32Array(P);
    this.partOpacities = Float32Array.from(m.parts.initialOpacity);
    m.parameters.ids.forEach(
      (id, i) => this.paramIndexById.has(id) || this.paramIndexById.set(id, i),
    );
    m.parts.ids.forEach((id, i) => this.partIndexById.has(id) || this.partIndexById.set(id, i));
    const nb = m.bindings.keys.length;
    this.segIndex = new Int32Array(nb);
    this.segT = new Float32Array(nb);
    this.segOutOfRange = new Uint8Array(nb);
    this.segChanged = new Uint8Array(nb);
    const NB = m.bands.length;
    const K = (this.K = Math.max(1, plan.maxBandBindings));
    this.bandBase = new Int32Array(NB);
    this.bandActive = new Int32Array(NB);
    this.bandStride = new Int32Array(NB * K);
    this.bandT = new Float32Array(NB * K);
    this.bandW = new Float32Array(NB * 16);
    this.bandO = new Int32Array(NB * 16);
    this.bandOutOfRange = new Uint8Array(NB);
    this.bandChanged = new Uint8Array(NB);
    const NBL = plan.blends.length;
    this.blendIndex = new Int32Array(NBL);
    this.blendT = new Float32Array(NBL);
    this.blendWa = new Float32Array(NBL);
    this.blendWb = new Float32Array(NBL);
    this.blendWeight = new Float32Array(NBL);
    this.blendChanged = new Uint8Array(NBL);
    const D = m.deformers.ids.length;
    this.deformerActive = new Uint8Array(D);
    this.deformerDirty = new Uint8Array(D);
    this.deformerOpacity = new Float32Array(D);
    this.deformerColors = new Float32Array(D * 6);
    this.sigma = new Float32Array(D);
    this.rotOx = new Float32Array(D);
    this.rotOy = new Float32Array(D);
    this.rotAngle = new Float32Array(D);
    this.rotScale = new Float32Array(D);
    this.rotC = new Float32Array(D);
    this.rotS = new Float32Array(D);
    this.rotMirrorX = new Uint8Array(D);
    this.rotMirrorY = new Uint8Array(D);
    const N = m.meshes.ids.length;
    this.drawableActive = new Uint8Array(N);
    this.drawableVisible = new Uint8Array(N);
    this.drawableOpacity = new Float32Array(N);
    this.drawableDrawOrder = new Int32Array(N);
    this.drawableRenderOrder = new Int32Array(N);
    this.drawableMultiply = new Float32Array(N * 3);
    this.drawableScreen = new Float32Array(N * 3);
    this.meshEvaluated = new Uint8Array(N);
    this.meshStale = new Uint8Array(N).fill(1);
    this.wasActive = new Uint8Array(N);
    this.meshPartChain = Array.from(m.meshes.part, (part) => {
      const chain: number[] = [];
      for (let p = part; p >= 0; p = m.parts.parent[p]!) {
        if (m.parts.offscreen[p]! >= 0) break;
        chain.push(p);
      }
      return Int32Array.from(chain);
    });
    const O = m.offscreens.part.length;
    this.offscreenOpacity = new Float32Array(O);
    this.offscreenRenderOrder = new Int32Array(O);
    this.offscreenMultiply = new Float32Array(O * 3);
    this.offscreenScreen = new Float32Array(O * 3);
    this.partActive = new Uint8Array(m.parts.ids.length);
    this.partDrawOrder = new Int32Array(m.parts.ids.length);
    this.hasColors = m.version >= 4;
    // Version 5; version 6 is assumed to behave the same.
    this.clampTargets = m.version >= 5;
    // Files before version 4 have no colors: every drawable, never-active ones
    // included, reports multiply (1, 1, 1) and screen (0, 0, 0) (C23).
    if (!this.hasColors) this.drawableMultiply.fill(1);
    this.flipOutput = (m.canvas.flags & 1) === 0;
    this.orderer = new RenderOrderer(m);

    // Heap layout: keyform positions first (so plan offsets index the heap
    // directly), then per-object buffers, each 16-byte aligned.
    const align = (n: number): number => (n + 3) & ~3;
    let top = align(m.positions.length);
    const alloc = (n: number): number => {
      const at = top;
      top += align(n);
      return at;
    };
    const vertexCount = Array.from(m.meshes.vertexCount);
    this.gridOffset = Int32Array.from(plan.deformers, (d) =>
      d.kind === 0 ? alloc(d.gridLength) : -1,
    );
    this.localOffset = Int32Array.from(vertexCount, (V) => alloc(2 * V));
    this.isGlued = new Uint8Array(N);
    if (this.glueOn) for (const d of plan.glueMeshes) this.isGlued[d] = 1;
    this.outOffset = Int32Array.from(vertexCount, (V) => alloc(2 * V));
    let maxRun = 4;
    for (const d of plan.deformers) maxRun = Math.max(maxRun, d.gridLength);
    for (const V of vertexCount) maxRun = Math.max(maxRun, 2 * V);
    this.maxRun = maxRun;
    this.zeroOffset = alloc(maxRun);
    this.scratchOffset = alloc(16);
    this.mapOffset = alloc(2 * MAP_CHUNK);
    this.probeOffset = alloc(8);
    this.k = createKernels(top, options.kernels);
    this.backend = this.k.kind;
    const heap = (this.heap = this.k.heap);
    heap.set(m.positions, 0);
    this.drawableVertices = vertexCount.map((V, i) =>
      heap.subarray(this.outOffset[i]!, this.outOffset[i]! + 2 * V),
    );
    this.drawableVertexVersion = new Uint32Array(vertexCount.length);
    this.meshPatched = new Uint8Array(N);
    this.deformerPatched = new Uint8Array(D);
    this.revision = dataRevision(m);
    this.incremental = options.incremental ?? true;
    // The runtime evaluates once at creation, with default parameters and the
    // initial part opacities (C4).
    this.evaluate();
  }

  // ---------------------------------------------------------------- inputs

  /** Index of the first parameter with this ID, or -1. */
  parameterIndex(id: string): number {
    return this.paramIndexById.get(id) ?? -1;
  }

  /** Index of the first part with this ID, or -1. */
  partIndex(id: string): number {
    return this.partIndexById.get(id) ?? -1;
  }

  /** Sets a parameter; the stored value is clamped unless the parameter repeats (§1c.1). */
  setParameter(index: number, value: number): void {
    const p = this.model.parameters;
    this.parameterValues[index] = appliedValue(
      value,
      p.min[index]!,
      p.max[index]!,
      p.repeat[index] === 1,
    );
  }

  /** Sets a part opacity, clamped to [0, 1]. */
  setPartOpacity(index: number, value: number): void {
    const v = fr(value);
    this.partOpacities[index] = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // ------------------------------------------------------------ mapping

  /**
   * The forward mapping: maps points from deformer `deformer`'s input space
   * through its world form at the latest evaluation (§1c.7, §1c.8, the
   * outside regions of warps included), with the evaluator's own float32
   * operations, so a mesh vertex maps exactly as the evaluator maps it.
   * `points` holds x, y pairs; −1 stands for no deformer (the identity).
   * Space "model" (default) is that of `drawableVertices`: y is negated
   * unless canvas flag bit 0 is set (§1c.11). "keyform" is the space of
   * keyform positions, y down. Writes to `out` when given.
   */
  mapPoints(
    deformer: number,
    points: ArrayLike<number>,
    space: MapSpace = "model",
    out?: Float32Array,
  ): Float32Array {
    const n = this.mapCount(deformer, points);
    const result = out ?? new Float32Array(2 * n);
    if (result.length < 2 * n)
      throw new RangeError(`out holds ${result.length} floats, not ${2 * n}`);
    const h = this.heap;
    const at = this.mapOffset;
    const flip = space === "model" && this.flipOutput;
    for (let start = 0; start < n; start += MAP_CHUNK) {
      const count = Math.min(MAP_CHUNK, n - start);
      for (let i = 0; i < 2 * count; i++) h[at + i] = points[2 * start + i]!;
      if (deformer >= 0) this.mapThrough(deformer, at, at, count);
      for (let i = 0; i < count; i++) {
        result[2 * (start + i)] = h[at + 2 * i]!;
        const y = h[at + 2 * i + 1]!;
        result[2 * (start + i) + 1] = flip ? -y : y;
      }
    }
    return result;
  }

  /**
   * The 2×2 Jacobian of {@link mapPoints} at each point, analytic per region
   * (see `jacobian.ts`): ∂x/∂px, ∂x/∂py, ∂y/∂px, ∂y/∂py per point, in the
   * same space (in "model", the y row is negated with y).
   */
  mapJacobians(
    deformer: number,
    points: ArrayLike<number>,
    space: MapSpace = "model",
    out?: Float64Array,
  ): Float64Array {
    const n = this.mapCount(deformer, points);
    const result = out ?? new Float64Array(4 * n);
    if (result.length < 4 * n)
      throw new RangeError(`out holds ${result.length} values, not ${4 * n}`);
    const plan = deformer >= 0 ? this.plan.deformers[deformer]! : null;
    const flip = space === "model" && this.flipOutput;
    for (let i = 0; i < n; i++) {
      const o = 4 * i;
      if (!plan) {
        result[o] = 1;
        result[o + 1] = 0;
        result[o + 2] = 0;
        result[o + 3] = 1;
      } else if (plan.kind === 1)
        rotationJacobian(
          this.rotC[deformer]!,
          this.rotS[deformer]!,
          1,
          this.rotMirrorX[deformer] === 1,
          this.rotMirrorY[deformer] === 1,
          result,
          o,
        );
      else
        warpJacobian(
          this.heap,
          this.gridOffset[deformer]!,
          plan.rows,
          plan.columns,
          plan.bilinear,
          points[2 * i]!,
          points[2 * i + 1]!,
          result,
          o,
        );
      if (flip) {
        result[o + 2] = -result[o + 2]!;
        result[o + 3] = -result[o + 3]!;
      }
    }
    return result;
  }

  /** Checks a mapping's arguments; returns the number of points. */
  private mapCount(deformer: number, points: ArrayLike<number>): number {
    if (!(Number.isInteger(deformer) && deformer >= -1 && deformer < this.plan.deformers.length))
      throw new RangeError(`no deformer ${deformer}`);
    if (points.length % 2 !== 0) throw new RangeError("points must hold x, y pairs");
    return points.length / 2;
  }

  // ------------------------------------------------------------ patches

  /**
   * In-place value patches: new values for elements of the model's keyform
   * positions, opacities, draw orders, colors, rotation values, and glue
   * intensities and weights (blend-shape keyforms included), named by their
   * {@link MocData} array and index (see {@link ValuePatch}). The model's
   * arrays change, so every instance of it sees them at its next evaluation;
   * this one recomputes only the objects they touch, as if it had been built
   * from the patched data. Inactive meshes keep their last vertices until
   * they are active again (C4), as for any change. Throws, and applies
   * nothing, if a patch names an array that cannot be patched or elements
   * outside it.
   */
  patch(patches: ValuePatch | readonly ValuePatch[]): void {
    const list: readonly ValuePatch[] = "group" in patches ? [patches] : patches;
    const current = this.revision === dataRevision(this.model);
    const e = applyPatches(this.model, list);
    const positions = this.model.positions;
    for (const [a, b] of e.positions) this.heap.set(positions.subarray(a, b), a);
    for (const d of e.deformers) this.deformerPatched[d] = 1;
    for (const i of e.meshVertices) this.meshPatched[i] = 1;
    if (e.glue) this.gluePatched = true;
    this.patched = true;
    // Behind already (another instance patched the model): the next evaluation refreshes in full.
    if (current) this.revision = dataRevision(this.model);
  }

  // ------------------------------------------------------------ evaluation

  /** Runs the whole pipeline for the current inputs. */
  evaluate(): void {
    const revision = dataRevision(this.model);
    if (revision !== this.revision) {
      // Another instance patched the model: take its positions, and evaluate everything.
      this.heap.set(this.model.positions, 0);
      this.revision = revision;
      this.fullPass = true;
    }
    this.locateBindings();
    this.evaluateParts();
    this.evaluateDeformers();
    this.evaluateMeshes();
    this.applyGlue();
    this.convertOutput();
    this.evaluateOffscreens();
    this.computeRenderOrder();
    this.firstEvaluation = false;
    this.fullPass = false;
    this.evaluations++;
    if (this.patched) {
      this.meshPatched.fill(0);
      this.deformerPatched.fill(0);
      this.gluePatched = false;
      this.patched = false;
    }
  }

  /** §1c.13. */
  private computeRenderOrder(): void {
    this.orderer.compute(this);
  }

  /** §1c.1 + §1c.2 for every parameter binding, then per-band corners and blend-shape locations. */
  private locateBindings(): void {
    const m = this.model;
    const p = m.parameters;
    const ev = this.evalValues;
    for (let i = 0; i < ev.length; i++) {
      ev[i] = evaluationValue(this.parameterValues[i]!, p.min[i]!, p.max[i]!, p.repeat[i] === 1);
    }
    const li = this.locIndex;
    const lt = this.locT;
    const keys = m.bindings.keys;
    const owner = m.bindings.parameter;
    const eps = m.bindings.epsilon;
    for (let b = 0; b < keys.length; b++) {
      const oor = locateKeyAt(keys[b]!, ev[owner[b]!]!, li, lt, 0, eps[b]!);
      const index = li[0]!;
      const t = lt[0]!;
      this.segChanged[b] = index !== this.segIndex[b] || t !== this.segT[b] ? 1 : 0;
      this.segIndex[b] = index;
      this.segT[b] = t;
      this.segOutOfRange[b] = oor ? 1 : 0;
    }
    // Bands: lower corner, active (t ≠ 0) bindings, range and change flags.
    const K = this.K;
    for (let bi = 0; bi < m.bands.length; bi++) {
      const band = m.bands[bi]!;
      let base = 0;
      let active = 0;
      let oor = 0;
      let changed = 0;
      for (let j = 0; j < band.bindings.length; j++) {
        const b = band.bindings[j]!;
        const s = band.strides[j]!;
        base += this.segIndex[b]! * s;
        const t = this.segT[b]!;
        if (t !== 0) {
          this.bandStride[bi * K + active] = s;
          this.bandT[bi * K + active] = t;
          active++;
        }
        oor |= this.segOutOfRange[b]!;
        changed |= this.segChanged[b]!;
      }
      this.bandBase[bi] = base;
      this.bandActive[bi] = active;
      this.bandOutOfRange[bi] = oor;
      this.bandChanged[bi] = changed;
      if (active <= 4 && (changed || this.firstEvaluation || !this.incremental))
        this.cornerTables(bi, active, this.bandW, this.bandO, bi * 16);
    }
    this.frame++;
    // Blend shapes: location (without snapping) and weight once per binding.
    const blends = this.plan.blends;
    for (let g = 0; g < blends.length; g++) {
      const bs = blends[g]!.binding;
      locateBlendKeyAt(bs.keys, ev[bs.parameter]!, li, lt, 0); // no snapping (C1)
      const index = li[0]!;
      const t = lt[0]!;
      this.blendShapeWeight(g);
      const w = this.gv[0]!;
      const old = this.blendWeight[g]!;
      // The sign of a zero weight can matter (r + w·0 with r = −0), so compare exactly.
      const sameWeight = w === old && (w !== 0 || 1 / w === 1 / old);
      this.blendChanged[g] =
        index !== this.blendIndex[g] || t !== this.blendT[g] || !sameWeight ? 1 : 0;
      this.blendIndex[g] = index;
      this.blendT[g] = t;
      this.blendWeight[g] = w;
      // The S2 weights (1 − t, t), except in the segment that
      // starts at the base key, whose keyform reads as zeros: there the other
      // keyform weighs f32(1 − f32(1 − t)).
      const u = fr(1 - t);
      this.blendWa[g] = u;
      this.blendWb[g] = index === bs.baseKey ? fr(1 - u) : t;
    }
  }

  /**
   * S2's corner weights and keyform offsets of a band into W[at…], O[at…]:
   * for corner c (bit L = the L-th active binding at its upper key), the
   * float32 running product over the active bindings in band order of t or
   * f32(1 − t), starting from 1, and the sum of the strides of the bits set.
   */
  private cornerTables(band: number, active: number, W: Float32Array, O: Int32Array, at: number) {
    const row = band * this.K;
    const n = 1 << active;
    for (let c = 0; c < n; c++) {
      let w = 1;
      let o = 0;
      for (let L = 0; L < active; L++) {
        const t = this.bandT[row + L]!;
        if (c & (1 << L)) {
          w = fr(w * t);
          o += this.bandStride[row + L]!;
        } else w = fr(w * fr(1 - t));
      }
      W[at + c] = w;
      O[at + c] = o;
    }
  }

  /** The corner tables of a band with more than 4 active bindings (bigW, bigO), cached per frame. */
  private bigTables(band: number): void {
    if (this.bigBand === band && this.bigFrame === this.frame) return;
    const n = 1 << this.bandActive[band]!;
    if (this.bigW.length < n) {
      this.bigW = new Float32Array(n);
      this.bigO = new Int32Array(n);
    }
    this.cornerTables(band, this.bandActive[band]!, this.bigW, this.bigO, 0);
    this.bigBand = band;
    this.bigFrame = this.frame;
  }

  /**
   * Weight of a blend-shape binding into gv[0]: min(1, c₁, …, c_m) over its
   * constraints' values, so 1 without constraints; a weight above 1 does not
   * amplify, and a negative one is used as stored (§1c.4 step 3). (Results
   * go to slots rather than return values, which V8 would box
   * when the call is not inlined.)
   */
  private blendShapeWeight(g: number): void {
    const constraints = this.plan.blends[g]!.binding.constraints;
    if (constraints.length === 0) {
      this.gv[0] = 1;
      return;
    }
    let w = 1;
    for (let c = 0; c < constraints.length; c++) {
      const con = constraints[c]!;
      const u = this.evalValues[con.parameter]!;
      const ks = con.keys;
      const ws = con.weights;
      let cv: number;
      if (u <= ks[0]!) cv = ws[0]!;
      else if (u >= ks[ks.length - 1]!) cv = ws[ws.length - 1]!;
      else {
        let i = 0;
        while (i + 1 < ks.length && !(u < ks[i + 1]!)) i++;
        const t = fr(fr(u - ks[i]!) / fr(ks[i + 1]! - ks[i]!));
        // The weighted form of keyforms, not a lerp.
        cv = fr(fr(fr(1 - t) * ws[i]!) + fr(t * ws[i + 1]!));
      }
      if (cv < w) w = cv;
    }
    this.gv[0] = w;
  }

  private blendsChanged(list: Int32Array): boolean {
    for (let j = 0; j < list.length; j++) if (this.blendChanged[list[j]!]) return true;
    return false;
  }

  /**
   * Evaluates the first `count` scalar properties of an object into pv[0…]
   * (§1c.3 interpolation as S2's weighted sum, then §1c.4 blend shapes with
   * S4). Folded properties are copied while exact; a property shared with its
   * predecessor is evaluated once. Property `drawOrderAt` is the object's draw
   * order, which gets the formula of {@link drawOrder}; `target` = the object
   * is the target of at least one blend-shape keyform binding.
   */
  private evalProps(
    props: ScalarProp[],
    count: number,
    band: number,
    blends: Int32Array,
    drawOrderAt = -1,
    target = false,
  ): void {
    const pv = this.pv;
    const active = this.bandActive[band]!;
    for (let p = 0; p < count; p++) {
      const prop = props[p]!;
      if (p === drawOrderAt) {
        pv[p] = this.drawOrder(prop, band, blends, target);
        continue;
      }
      if (p > 0 && prop === props[p - 1] && p - 1 !== drawOrderAt) {
        pv[p] = pv[p - 1]!;
        continue;
      }
      if (prop.constant === prop.constant && active <= prop.foldActive) {
        pv[p] = prop.constant; // folded (not NaN), exact at this many active bindings
        continue;
      }
      this.sumInterp(prop.values, band);
      let r = this.gv[0]!;
      const slots = prop.blendSlots;
      for (let j = 0; j < slots.length; j++) {
        this.blendStep(blends[slots[j]!]!, prop.blendValues[j]!);
        r = fr(r + this.gv[0]!);
      }
      pv[p] = r;
    }
  }

  /**
   * One blend-shape contribution f32(w·s) of binding g into gv[0] (§1c.4,
   * S4): s = Q(i) on a key, otherwise f32(f32(wa·Q(i)) + f32(wb·Q(i+1)))
   * (wa = 1 − t and wb = t, but wb = f32(1 − f32(1 − t)) in the segment that
   * starts at the base key, whose value is 0).
   */
  private blendStep(g: number, vals: Float32Array): void {
    const i = this.blendIndex[g]!;
    const s =
      this.blendT[g] === 0
        ? vals[i]!
        : fr(fr(this.blendWa[g]! * vals[i]!) + fr(this.blendWb[g]! * vals[i + 1]!));
    this.gv[0] = fr(this.blendWeight[g]! * s);
  }

  /**
   * The draw order of an art mesh (§1c.9) or a part (§1c.6):
   * n = trunc(f32(D + 0.001)), D being the weighted sum of its normal
   * keyforms (S2) and trunc toward zero; any object that is not a version-5
   * blend-shape target gets n, which can be negative (version-4 targets are
   * not clamped). A version-5 target adds its blend-shape
   * contributions w·s to n one at a time in binding order,
   * r ← f32(r + f32(w·s)), and gets min(1000, max(0, trunc(f32(r + 0.001)))),
   * even when they are all zero. Assumed, as not settled: the one-at-a-time
   * order for draw orders, and the interpolation rule at the bit level. This value is also the object's key
   * in its draw-order group (§1c.13).
   */
  private drawOrder(prop: ScalarProp, band: number, blends: Int32Array, target: boolean): number {
    let D: number;
    if (prop.constant === prop.constant && this.bandActive[band]! <= prop.foldActive)
      D = prop.constant;
    else {
      this.sumInterp(prop.values, band);
      D = this.gv[0]!;
    }
    const n = Math.trunc(fr(D + DRAW_ORDER_TOLERANCE));
    if (!target || !this.clampTargets) return n;
    let r = n;
    const slots = prop.blendSlots;
    for (let j = 0; j < slots.length; j++) {
      this.blendStep(blends[slots[j]!]!, prop.blendValues[j]!);
      r = fr(r + this.gv[0]!);
    }
    return Math.min(TARGET_DRAW_ORDER_MAX, Math.max(0, Math.trunc(fr(r + DRAW_ORDER_TOLERANCE))));
  }

  /**
   * A version-5 blend-shape target's own opacity and colors, pv[at…at+6]
   * (opacity, then multiply and screen r g b when there are colors), clamped
   * to [0, 1] once, after its blend shapes and before anything from a parent
   * NaN stays NaN.
   */
  private clampTargetColors(at: number, colors: boolean): void {
    const pv = this.pv;
    pv[at] = clampTarget(pv[at]!, 0, 1);
    if (colors) for (let ch = 1; ch <= 6; ch++) pv[at + ch] = clampTarget(pv[at + ch]!, 0, 1);
  }

  /** S2's weighted sum of a scalar property into gv[0]. */
  private sumInterp(values: Float32Array, band: number): void {
    const active = this.bandActive[band]!;
    const base = this.bandBase[band]!;
    if (active === 0) {
      this.gv[0] = 0 + values[base]!;
      return;
    }
    let W = this.bandW;
    let O = this.bandO;
    let at = band * 16;
    if (active > 4) {
      this.bigTables(band);
      W = this.bigW;
      O = this.bigO;
      at = 0;
    }
    if (active === 1) {
      const r = fr(0 + fr(W[at]! * values[base]!));
      this.gv[0] = fr(r + fr(W[at + 1]! * values[base + O[at + 1]!]!));
      return;
    }
    const n = 1 << active;
    let r = 0;
    for (let c = 0; c < n; c++) r = fr(r + fr(W[at + c]! * values[base + O[at + c]!]!));
    this.gv[0] = r;
  }

  /**
   * §1c.3 with S2 for a run of `length` floats of keyform positions into
   * heap[dst…]: the weighted sum over the band's corners, four per kernel
   * pass. With every binding on a key it is 0 + Q, a plain copy unless the
   * run holds −0.
   */
  private interpPositions(
    offsets: Int32Array,
    plain: Uint8Array,
    band: number,
    dst: number,
    length: number,
  ): void {
    const k = this.k;
    const active = this.bandActive[band]!;
    const base = this.bandBase[band]!;
    if (active === 0) {
      if (plain[base]) k.copy(dst, offsets[base]!, length);
      else k.sum1(dst, offsets[base]!, 1, length);
      return;
    }
    let W = this.bandW;
    let O = this.bandO;
    let at = band * 16;
    if (active > 4) {
      this.bigTables(band);
      W = this.bigW;
      O = this.bigO;
      at = 0;
    }
    if (active === 1) {
      k.sum2(dst, offsets[base]!, offsets[base + O[at + 1]!]!, W[at]!, W[at + 1]!, length);
      return;
    }
    const n = 1 << active;
    for (let c = 0; c < n; c += 4) {
      const i = at + c;
      k.sum4(
        dst,
        offsets[base + O[i]!]!,
        offsets[base + O[i + 1]!]!,
        offsets[base + O[i + 2]!]!,
        offsets[base + O[i + 3]!]!,
        W[i]!,
        W[i + 1]!,
        W[i + 2]!,
        W[i + 3]!,
        length,
        c > 0 ? 1 : 0,
      );
    }
  }

  /** Adds positional blend shapes to heap[dst…] (§1c.4, S4: the base keyform reads as zeros). */
  private blendPositions(dst: number, length: number, blends: Int32Array): void {
    const zero = this.zeroOffset;
    for (let j = 0; j < blends.length; j++) {
      const g = blends[j]!;
      const offsets = this.plan.blends[g]!.positionOffsets;
      const i = this.blendIndex[g]!;
      const t = this.blendT[g]!;
      const w = this.blendWeight[g]!;
      const a = offsets[i]! < 0 ? zero : offsets[i]!;
      if (t === 0) this.k.blend0(dst, a, w, length);
      else {
        const b = offsets[i + 1]! < 0 ? zero : offsets[i + 1]!;
        this.k.blend1(dst, a, b, this.blendWa[g]!, this.blendWb[g]!, w, length);
      }
    }
  }

  // ---------------------------------------------------------------- parts

  /** §1c.5 (parts) and §1c.6. */
  private evaluateParts(): void {
    const parts = this.model.parts;
    const plans = this.plan.parts;
    for (let p = 0; p < plans.length; p++) {
      const plan = plans[p]!;
      const parent = parts.parent[p]!;
      this.partActive[p] =
        parts.enabled[p] &&
        !this.bandOutOfRange[plan.band] &&
        (parent < 0 || this.partActive[parent])
          ? 1
          : 0;
      // The draw-order formula (as for art meshes).
      this.evalProps(plan.props, 1, plan.band, plan.blends, 0, plan.blends.length > 0);
      this.partDrawOrder[p] = this.pv[0]!;
    }
  }

  // ------------------------------------------------------------ deformers

  /** §1c.5 (deformers) and §1c.7, skipping deformers whose inputs did not change. */
  private evaluateDeformers(): void {
    const d = this.model.deformers;
    const plans = this.plan.deformers;
    const first = this.firstEvaluation || !this.incremental || this.fullPass;
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!;
      const parent = d.parent[i]!;
      const part = d.part[i]!;
      const band = plan.band;
      this.deformerActive[i] =
        d.enabled[i] &&
        !this.bandOutOfRange[band] &&
        (part < 0 || this.partActive[part]) &&
        (parent < 0 || this.deformerActive[parent])
          ? 1
          : 0;
      const dirty =
        first ||
        this.deformerPatched[i] === 1 ||
        this.bandChanged[band] === 1 ||
        this.blendsChanged(plan.blends) ||
        (parent >= 0 && this.deformerDirty[parent] === 1);
      this.deformerDirty[i] = dirty ? 1 : 0;
      if (!dirty) continue;
      // Opacity, colors and (rotations) angle, origin, scale into pv.
      const pv = this.pv;
      this.evalProps(plan.props, plan.kind === 1 ? 11 : 7, band, plan.blends);
      if (this.clampTargets && plan.blends.length > 0) {
        // A target's own values, before the parent's are combined in;
        // a rotation's keyform angle before its base angle is added. Origins are not clamped.
        this.clampTargetColors(0, this.hasColors);
        if (plan.kind === 1) {
          pv[7] = clampTarget(pv[7]!, -TARGET_ANGLE_LIMIT, TARGET_ANGLE_LIMIT);
          pv[10] = clampTarget(pv[10]!, TARGET_SCALE_MIN, TARGET_SCALE_MAX);
        }
      }
      if (plan.kind === 0) this.evaluateWarp(i, parent);
      else this.evaluateRotation(i, parent);
      const opacity = pv[0]!;
      this.deformerOpacity[i] = parent >= 0 ? fr(opacity * this.deformerOpacity[parent]!) : opacity;
      const base = i * 6;
      const acc = this.deformerColors;
      if (this.hasColors) {
        for (let ch = 0; ch < 6; ch++) acc[base + ch] = pv[1 + ch]!;
        if (parent >= 0) combineColors(acc, base, acc, parent * 6);
      } else {
        acc[base] = 1;
        acc[base + 1] = 1;
        acc[base + 2] = 1;
        acc[base + 3] = 0;
        acc[base + 4] = 0;
        acc[base + 5] = 0;
      }
    }
  }

  private evaluateWarp(i: number, parent: number): void {
    const plan = this.plan.deformers[i]!;
    const band = plan.band;
    const grid = this.gridOffset[i]!;
    const length = plan.gridLength;
    const base = this.bandBase[band]!;
    if (
      parent >= 0 &&
      this.bandActive[band] === 0 &&
      plan.blends.length === 0 &&
      plan.plainRun[base]
    ) {
      // A single keyform without blend shapes, and 0 + Q = Q: map it straight from the keyform data.
      this.mapThrough(parent, plan.positionOffsets[base]!, grid, length / 2);
    } else {
      this.interpPositions(plan.positionOffsets, plan.plainRun, band, grid, length);
      if (plan.blends.length) this.blendPositions(grid, length, plan.blends);
      if (parent >= 0) this.mapThrough(parent, grid, grid, length / 2);
    }
    this.sigma[i] =
      parent < 0
        ? 1
        : this.plan.deformers[parent]!.kind === 1
          ? this.rotScale[parent]!
          : this.sigma[parent]!;
  }

  private evaluateRotation(i: number, parent: number): void {
    const plan = this.plan.deformers[i]!;
    const band = plan.band;
    const kf = this.model.keyforms;
    // Evaluated by evalProps (slots 7–10).
    const a = this.pv[7]!;
    const x = this.pv[8]!;
    const y = this.pv[9]!;
    const s = this.pv[10]!;
    const cornerKeyform = plan.firstKeyform + this.bandBase[band]!;
    this.rotMirrorX[i] = kf.rotationMirrorX[cornerKeyform] === 1 ? 1 : 0;
    this.rotMirrorY[i] = kf.rotationMirrorY[cornerKeyform] === 1 ? 1 : 0;
    const base = plan.baseAngle;
    let ox: number, oy: number, angle: number, scale: number;
    if (parent < 0) {
      ox = x;
      oy = y;
      angle = fr(a + base);
      scale = s;
    } else {
      // The parent's orientation, read back from two mapped probe points
      // as two points: the origin, and a point L above it in file
      // coordinates (y down), L = 10 under a rotation and f32(0.1) under a
      // warp. A parent's mirror flags act through the probe.
      const rotationParent = this.plan.deformers[parent]!.kind === 1;
      const h = this.heap;
      const pr = this.probeOffset;
      h[pr] = x;
      h[pr + 1] = y;
      h[pr + 2] = x;
      h[pr + 3] = fr(y - (rotationParent ? PROBE_ROTATION : PROBE_WARP));
      this.mapThrough(parent, pr, pr + 4, 2);
      ox = h[pr + 4]!;
      oy = h[pr + 5]!;
      angle = probedAngle(a, base, ox, oy, h[pr + 6]!, h[pr + 7]!);
      scale = fr(s * (rotationParent ? this.rotScale[parent]! : this.sigma[parent]!));
    }
    // Radians without reduction, the library's float32 sine and cosine, and
    // the world scale folded into them (rotation.ts).
    const [c, sn] = rotationCS(angle, scale);
    this.rotOx[i] = ox;
    this.rotOy[i] = oy;
    this.rotAngle[i] = angle;
    this.rotScale[i] = scale;
    this.rotC[i] = c;
    this.rotS[i] = sn;
  }

  /** Maps `count` points heap[src…] → heap[dst…] (src = dst allowed) through deformer `def`'s world form. */
  private mapThrough(def: number, src: number, dst: number, count: number): void {
    const plan = this.plan.deformers[def]!;
    if (plan.kind === 1) {
      // The scale is already in C and S: f32(1·v) = v.
      this.k.rotate(
        src,
        dst,
        count,
        this.rotC[def]!,
        this.rotS[def]!,
        1,
        this.rotOx[def]!,
        this.rotOy[def]!,
        this.rotMirrorX[def]!,
        this.rotMirrorY[def]!,
      );
      return;
    }
    this.k.warp(
      this.gridOffset[def]!,
      plan.rows,
      plan.columns,
      plan.bilinear ? 1 : 0,
      src,
      dst,
      count,
      this.scratchOffset,
    );
  }

  // --------------------------------------------------------------- meshes

  /**
   * §1c.5 (art meshes) and §1c.9. Vertices only for active meshes whose inputs
   * changed (or changed while they were inactive); inactive meshes keep their
   * arrays (C4).
   */
  private evaluateMeshes(): void {
    const me = this.model.meshes;
    const plans = this.plan.meshes;
    const first = this.firstEvaluation || !this.incremental || this.fullPass;
    const colors = this.colors;
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!;
      const band = plan.band;
      const part = me.part[i]!;
      const def = me.deformer[i]!;
      this.drawableActive[i] =
        me.enabled[i] &&
        !this.bandOutOfRange[band] &&
        (part < 0 || this.partActive[part]) &&
        (def < 0 || this.deformerActive[def])
          ? 1
          : 0;
      // Vertices.
      const dirty =
        first ||
        this.meshPatched[i] === 1 ||
        this.bandChanged[band] === 1 ||
        this.blendsChanged(plan.blends) ||
        (def >= 0 && this.deformerDirty[def] === 1);
      const evaluate = this.drawableActive[i] === 1 && (dirty || this.meshStale[i] === 1);
      if (!this.drawableActive[i] && dirty) this.meshStale[i] = 1;
      this.meshEvaluated[i] = evaluate ? 1 : 0;
      if (evaluate) {
        this.meshStale[i] = 0;
        const V = me.vertexCount[i]!;
        const local = this.localOffset[i]!;
        const base = this.bandBase[band]!;
        if (
          def >= 0 &&
          this.bandActive[band] === 0 &&
          plan.blends.length === 0 &&
          plan.plainRun[base]
        ) {
          // A single keyform without blend shapes, and 0 + Q = Q: map it straight from the keyform data.
          this.mapThrough(def, plan.positionOffsets[base]!, local, V);
        } else {
          this.interpPositions(plan.positionOffsets, plan.plainRun, band, local, 2 * V);
          if (plan.blends.length) this.blendPositions(local, 2 * V, plan.blends);
          if (def >= 0) this.mapThrough(def, local, local, V);
        }
      }
      // Opacity, draw order and colors: an inactive drawable keeps those of its
      // last active evaluation, or zeros if it was never active
      // (C10). Render order never reads them (inactive drawables sort by their
      // group's minimum).
      if (this.drawableActive[i] === 0) {
        // C29: every evaluation still adds an inactive mesh's
        // blend-shape position contribution (§1c.4) to its reported vertices,
        // in keyform space (no deformer, no y negation). The additions
        // accumulate on the last active output, or on zeros. They make its
        // vertices stale: once active again it is evaluated in full, even when
        // its own inputs are unchanged, as a full evaluation would.
        if (plan.blends.length) {
          this.blendPositions(this.outOffset[i]!, 2 * me.vertexCount[i]!, plan.blends);
          this.drawableVertexVersion[i]!++;
          this.meshStale[i] = 1;
        }
        this.drawableVisible[i] = 0;
        continue;
      }
      const pv = this.pv;
      // Property 1 is the draw order.
      this.evalProps(plan.props, 8, band, plan.blends, 1, plan.blends.length > 0);
      if (this.clampTargets && plan.blends.length > 0) {
        // A target's own opacity and colors, before the deformer and parts.
        pv[0] = clampTarget(pv[0]!, 0, 1);
        if (this.hasColors) for (let ch = 2; ch < 8; ch++) pv[ch] = clampTarget(pv[ch]!, 0, 1);
      }
      // Ancestor opacities combine top-down: the deformers' product
      // from the outermost down (deformerOpacity, f32(dacc·o) at each level), the
      // parts' product from the topmost part of the chain down to the mesh's own,
      // then f32(f32(own·dacc)·acc). (Deformers and a deep part tree together are
      // assumed to follow the same order: not observed.)
      let op = pv[0]!;
      if (def >= 0) op = fr(op * this.deformerOpacity[def]!);
      const chain = this.meshPartChain[i]!;
      if (chain.length) {
        let acc = this.partOpacities[chain[chain.length - 1]!]!;
        for (let c = chain.length - 2; c >= 0; c--) acc = fr(acc * this.partOpacities[chain[c]!]!);
        op = fr(op * acc);
      }
      this.drawableOpacity[i] = op;
      this.drawableDrawOrder[i] = pv[1]!;
      // Colors. The final clamp belongs to the combination with the parent
      // deformer's colors: a mesh without one reports its colors as
      // interpolated (a target's were clamped above).
      const base = i * 3;
      if (this.hasColors) {
        if (def >= 0) {
          for (let ch = 0; ch < 6; ch++) colors[ch] = pv[2 + ch]!;
          combineColors(colors, 0, this.deformerColors, def * 6);
          for (let ch = 0; ch < 3; ch++) {
            this.drawableMultiply[base + ch] = clamp01(colors[ch]!);
            this.drawableScreen[base + ch] = clamp01(colors[3 + ch]!);
          }
        } else
          for (let ch = 0; ch < 3; ch++) {
            this.drawableMultiply[base + ch] = pv[2 + ch]!;
            this.drawableScreen[base + ch] = pv[5 + ch]!;
          }
      } else {
        this.drawableMultiply[base] = 1;
        this.drawableMultiply[base + 1] = 1;
        this.drawableMultiply[base + 2] = 1;
        this.drawableScreen[base] = 0;
        this.drawableScreen[base + 1] = 0;
        this.drawableScreen[base + 2] = 0;
      }
      // Visible when active and its opacity is not 0: negative and NaN opacities
      // are visible (not > 0, as §1c.12 said).
      this.drawableVisible[i] = op !== 0 ? 1 : 0;
    }
  }

  /**
   * §1c.10 with C4: glues in file order, pairs applied
   * sequentially, in place on the persistent arrays of all glued meshes,
   * active or not. Active glued meshes start from their fresh positions and
   * are converted to output space afterwards; inactive ones keep their array
   * as it stands (so their glue changes accumulate from call to call).
   */
  private applyGlue(): void {
    const g = this.model.glues;
    const plans = this.plan.glues;
    const meshes = this.plan.glueMeshes;
    if (plans.length === 0 || !this.glueOn) return;
    let run = this.firstEvaluation || !this.incremental || this.fullPass || this.gluePatched;
    for (let k = 0; !run && k < meshes.length; k++) {
      const d = meshes[k]!;
      // An inactive glued mesh changes on every call; activity changes and new positions too.
      if (!this.drawableActive[d] || !this.wasActive[d] || this.meshEvaluated[d]) run = true;
    }
    for (let k = 0; !run && k < plans.length; k++) {
      if (this.bandChanged[plans[k]!.band] || this.blendsChanged(plans[k]!.blends)) run = true;
    }
    if (!run) return;
    const vertexCount = this.model.meshes.vertexCount;
    for (let k = 0; k < meshes.length; k++) {
      const d = meshes[k]!;
      // Glue writes every glued mesh's array, active or not.
      this.drawableVertexVersion[d]!++;
      if (this.drawableActive[d])
        this.k.copy(this.outOffset[d]!, this.localOffset[d]!, 2 * vertexCount[d]!);
    }
    const h = this.heap;
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!;
      this.evalProps(plan.props, 1, plan.band, plan.blends);
      // A target glue's intensity is clamped to [0, 1], even with zero
      // contributions; others act as stored, beyond [0, 1] too.
      const intensity =
        this.clampTargets && plan.blends.length > 0 ? clampTarget(this.pv[0]!, 0, 1) : this.pv[0]!;
      const A = this.outOffset[g.meshA[i]!]!;
      const B = this.outOffset[g.meshB[i]!]!;
      const va = g.vertexA[i]!;
      const vb = g.vertexB[i]!;
      const wa = g.weightA[i]!;
      const wb = g.weightB[i]!;
      // Each pair in list order, both vertices read before either is written:
      // a′ = a + ((b − a)·w_A)·I and b′ = b + ((a − b)·w_B)·I. A vertex listed twice
      // in one glue sees its first move (assumed from the order across glues: not
      // observed).
      for (let p = 0; p < va.length; p++) {
        const ia = A + 2 * va[p]!;
        const ib = B + 2 * vb[p]!;
        const fa = wa[p]!;
        const fb = wb[p]!;
        const ax = h[ia]!;
        const ay = h[ia + 1]!;
        const bx = h[ib]!;
        const by = h[ib + 1]!;
        h[ia] = fr(ax + fr(fr(fr(bx - ax) * fa) * intensity));
        h[ia + 1] = fr(ay + fr(fr(fr(by - ay) * fa) * intensity));
        h[ib] = fr(bx + fr(fr(fr(ax - bx) * fb) * intensity));
        h[ib + 1] = fr(by + fr(fr(fr(ay - by) * fb) * intensity));
      }
    }
    if (!this.flipOutput) return;
    for (let k = 0; k < meshes.length; k++) {
      const d = meshes[k]!;
      if (this.drawableActive[d])
        this.k.flipY(this.outOffset[d]!, this.outOffset[d]!, 2 * vertexCount[d]!);
    }
  }

  /**
   * §1c.11 for the meshes without glue that were evaluated in this call:
   * negate y unless canvas flag bit 0 is set. Arrays of meshes that were not
   * evaluated keep their contents (C4).
   */
  private convertOutput(): void {
    const vertexCount = this.model.meshes.vertexCount;
    for (let i = 0; i < vertexCount.length; i++) {
      if (this.isGlued[i] || !this.meshEvaluated[i]) continue;
      this.drawableVertexVersion[i]!++;
      const n = 2 * vertexCount[i]!;
      if (this.flipOutput) this.k.flipY(this.outOffset[i]!, this.localOffset[i]!, n);
      else this.k.copy(this.outOffset[i]!, this.localOffset[i]!, n);
    }
    this.wasActive.set(this.drawableActive);
  }

  /** §1c.14 (opacity and colors; render order is assigned with drawables). */
  private evaluateOffscreens(): void {
    const plans = this.plan.offscreens;
    for (let o = 0; o < plans.length; o++) {
      const plan = plans[o]!;
      const pv = this.pv;
      this.evalProps(plan.props, 7, plan.band, plan.blends);
      // An offscreen target (count 37) is clamped like an art-mesh target:
      // opacity and colors to [0, 1], once, after all its deltas (zero ones
      // too), before the part opacities; NaN stays NaN. Other offscreens are
      // not clamped, colors included.
      if (this.clampTargets && plan.blends.length > 0) this.clampTargetColors(0, true);
      let op = fr(pv[0]! * this.partOpacities[plan.owner]!);
      const chain = plan.partChain;
      for (let c = 0; c < chain.length; c++) op = fr(op * this.partOpacities[chain[c]!]!);
      this.offscreenOpacity[o] = op;
      for (let ch = 0; ch < 3; ch++) {
        this.offscreenMultiply[o * 3 + ch] = pv[1 + ch]!;
        this.offscreenScreen[o * 3 + ch] = pv[4 + ch]!;
      }
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Combines local colors at colors[cBase…] (multiply r g b, screen r g b) with
 * the parent's accumulated colors at acc[pBase…], in place.
 */
function combineColors(
  colors: Float32Array,
  cBase: number,
  acc: Float32Array,
  pBase: number,
): void {
  for (let ch = 0; ch < 3; ch++) {
    colors[cBase + ch] = fr(colors[cBase + ch]! * acc[pBase + ch]!);
    const s = colors[cBase + 3 + ch]!;
    const ps = acc[pBase + 3 + ch]!;
    colors[cBase + 3 + ch] = fr(fr(s + ps) - fr(s * ps));
  }
}

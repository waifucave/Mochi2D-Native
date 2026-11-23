/**
 * Static evaluation plan, built once per model: compact per-object keyform
 * value arrays, position offsets, flattened blend-shape bindings and
 * constant-folded properties. The instance reads only these flat arrays in its
 * per-frame path.
 *
 * Interpolation is the weighted sum over corners (S2): starting
 * from +0, r ← f32(r + f32(w·Q)) for each corner. A blend shape's base
 * keyform reads as zeros (S4), so its step is r ← f32(r + f32(w·s)). Draw
 * orders add their blend shapes separately (see the instance).
 *
 * Constant folding is exact. A property is folded when every keyform value
 * that can reach it is the same float32 c and every blend-shape binding that
 * applies to it contributes ±0 (below). The folded value is exact for at most
 * `foldActive` bindings off their keys:
 * - c = ±0, any number: every term is ±0, and a sum from +0 of ±0 terms is +0;
 * - c = ±2^k with k ≥ 0: up to one binding, since f32(f32(f32(1 − t)·c) +
 *   f32(t·c)) = c·f32(f32(1 − t) + t) = c;
 * - any other finite c: only when every binding is on a key (0 + c = c).
 * A draw order's interpolated value D is folded by the same rules whatever
 * its blend shapes, which the instance sums separately.
 *
 * A blend-shape step is dropped when the binding's values for the property,
 * with the base key's taken as zero, are all ±0 and its weights are finite: it
 * adds ±0, which changes no running value but −0, and the weighted sum never
 * produces −0 (a float32 sum is −0 only if both addends are). Identical
 * neighbouring color channels share one ScalarProp, so they are evaluated
 * once.
 *
 * (Parameter values of NaN are outside the evaluation's domain: the reference
 * formulation itself then reads keyforms out of range. Results for NaN inputs
 * are not specified and may differ from a step-by-step evaluation.)
 */
import type { BlendShapeBinding, ColorIndices, MocModel } from "../moc/model.js";
import { WARP_KIND } from "../moc/model.js";

/** A scalar property of one object. */
export interface ScalarProp {
  /** Values at the object's normal keyforms, relative to its first keyform. */
  values: Float32Array;
  /** Blend-shape steps that can change the value, in order: positions in the object's binding list. */
  blendSlots: Int32Array;
  /** Values at each kept binding's keys, the base key's taken as zero (S4). */
  blendValues: Float32Array[];
  /** Folded value, or NaN when the property must be evaluated. */
  constant: number;
  /** The folded value is exact while at most this many bindings are off their keys. */
  foldActive: number;
}

/** A flattened blend-shape keyform binding. */
export interface BlendPlan {
  binding: BlendShapeBinding;
  /**
   * Positions-pool offset of each key's keyform (warp / mesh targets), else
   * empty. The base key's entry is −1: its keyform reads as zeros (S4).
   */
  positionOffsets: Int32Array;
}

export interface ObjectPlan {
  band: number;
  /** Global indices into {@link EvalPlan.blends}. */
  blends: Int32Array;
  /**
   * The object's scalar properties in evaluation order. Deformers: opacity,
   * multiply r g b, screen r g b, then (rotations) angle, origin x, origin y,
   * scale. Meshes: opacity, draw order, multiply r g b, screen r g b. Parts:
   * draw order. Glues: intensity. Offscreens: opacity, multiply r g b, screen
   * r g b. Equal neighbours share one ScalarProp (evaluated once).
   */
  props: ScalarProp[];
}

export interface DeformerPlan extends ObjectPlan {
  kind: 0 | 1;
  /** Positions-pool offsets of the normal keyforms (warps). */
  positionOffsets: Int32Array;
  /** Per normal keyform (warps): 1 if its run holds no −0, so 0 + Q = Q for every float. */
  plainRun: Uint8Array;
  /** Floats per grid (warps). */
  gridLength: number;
  rows: number;
  columns: number;
  bilinear: boolean;
  baseAngle: number;
  firstKeyform: number;
  opacity: ScalarProp;
  /** multiply r, g, b, screen r, g, b (v4+). */
  colors: ScalarProp[];
  angle: ScalarProp;
  originX: ScalarProp;
  originY: ScalarProp;
  scale: ScalarProp;
}

export interface MeshPlan extends ObjectPlan {
  positionOffsets: Int32Array;
  /** Per normal keyform: 1 if its run holds no −0, so 0 + Q = Q for every float. */
  plainRun: Uint8Array;
  opacity: ScalarProp;
  drawOrder: ScalarProp;
  colors: ScalarProp[];
}

export interface OffscreenPlan extends ObjectPlan {
  /** Owning part. */
  owner: number;
  /** Parts whose opacity multiplies in after the owner's (parent chain up to the next offscreen). */
  partChain: Int32Array;
  opacity: ScalarProp;
  /** multiply r, g, b, screen r, g, b. */
  colors: ScalarProp[];
}

export interface EvalPlan {
  blends: BlendPlan[];
  deformers: DeformerPlan[];
  meshes: MeshPlan[];
  parts: (ObjectPlan & { drawOrder: ScalarProp })[];
  glues: (ObjectPlan & { intensity: ScalarProp })[];
  offscreens: OffscreenPlan[];
  /** Largest number of bindings in any band. */
  maxBandBindings: number;
  /** Meshes that take part in at least one glue. */
  glueMeshes: Int32Array;
}

/** Cached plans per model: with blend shapes, and without (`evaluation.blendShapes: false`). */
const plans = new WeakMap<MocModel, EvalPlan>();
const plansWithoutBlendShapes = new WeakMap<MocModel, EvalPlan>();

/**
 * Returns the (cached) plan for a model. With `blendShapes` false, every
 * object's blend-shape keyform bindings are left out, as if the file had none.
 */
export function planFor(model: MocModel, blendShapes = true): EvalPlan {
  const cache = blendShapes ? plans : plansWithoutBlendShapes;
  let p = cache.get(model);
  if (!p) {
    p = buildPlan(model, blendShapes);
    cache.set(model, p);
  }
  return p;
}

type BlendShapeLists = MocModel["blendShapes"];

/** The model's blend-shape lists, or the same shape with every list empty. */
function blendShapeLists(m: MocModel, blendShapes: boolean): BlendShapeLists {
  if (blendShapes) return m.blendShapes;
  const none = (lists: BlendShapeBinding[][]) => lists.map(() => []);
  const b = m.blendShapes;
  return {
    warp: none(b.warp),
    mesh: none(b.mesh),
    part: none(b.part),
    rotation: none(b.rotation),
    glue: none(b.glue),
    offscreen: none(b.offscreen),
  };
}

/** Folded value and its exactness bound (see the module comment), or null. */
function fold(values: Float32Array): { constant: number; foldActive: number } | null {
  const c = values.length ? values[0]! : NaN;
  for (let i = 1; i < values.length; i++) if (!Object.is(values[i], c)) return null;
  if (!Number.isFinite(c)) return null;
  if (c === 0) return { constant: 0, foldActive: Infinity };
  const e = Math.log2(Math.abs(c));
  return { constant: c, foldActive: Number.isInteger(e) && e >= 0 ? 1 : 0 };
}

/** Every value is ±0. */
function allZero(values: Float32Array): boolean {
  for (let i = 0; i < values.length; i++) if (values[i] !== 0) return false;
  return true;
}

function sameArrays(a: Float32Array, b: Float32Array): boolean {
  return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

/** Same content, so the same evaluation result. */
function sameProp(a: ScalarProp, b: ScalarProp): boolean {
  return (
    Object.is(a.constant, b.constant) &&
    a.foldActive === b.foldActive &&
    sameArrays(a.values, b.values) &&
    a.blendSlots.length === b.blendSlots.length &&
    a.blendSlots.every((x, i) => x === b.blendSlots[i]) &&
    a.blendValues.every((x, i) => sameArrays(x, b.blendValues[i]!))
  );
}

/** Channels equal to the previous one share its ScalarProp (the instance evaluates it once). */
function shareEqualNeighbours(props: ScalarProp[]): ScalarProp[] {
  for (let ch = 1; ch < props.length; ch++)
    if (sameProp(props[ch]!, props[ch - 1]!)) props[ch] = props[ch - 1]!;
  return props;
}

function finiteWeights(b: BlendShapeBinding): boolean {
  for (const c of b.constraints)
    for (let i = 0; i < c.weights.length; i++) if (!Number.isFinite(c.weights[i])) return false;
  return true;
}

/**
 * Builds the value-derived parts of plans (scalar properties, their folding
 * and blend steps, and the −0 flags of position runs) from a model's current
 * values. {@link buildPlan} uses it for every object, and {@link refreshPlan}
 * again for objects whose values were patched.
 */
class ValueBuilder {
  private readonly v: number;
  constructor(
    private readonly m: MocModel,
    private readonly bs: BlendShapeLists = m.blendShapes,
  ) {
    this.v = m.version;
  }

  private keyformCount(band: number): number {
    return this.m.bands[band]!.keyformCount;
  }

  /**
   * Scalar property from a per-keyform accessor. `withBlends` = blend shapes
   * apply to it; `drawOrder` = its interpolated value is folded whatever its
   * blend shapes (see the module comment). `blendAt` reads the blend-shape
   * keyforms when they are not in the same array as the normal ones
   * (offscreens: normal keyforms through the owner part's, blend-shape
   * keyforms straight from the offscreen keyforms).
   */
  scalar(
    band: number,
    first: number,
    list: readonly BlendShapeBinding[],
    withBlends: boolean,
    at: (keyform: number) => number,
    drawOrder = false,
    blendAt: (keyform: number) => number = at,
  ): ScalarProp {
    const n = this.keyformCount(band);
    const values = Float32Array.from({ length: n }, (_, o) => at(first + o));
    // Blend values with the base key's taken as zero (S4).
    const blend = withBlends
      ? list.map((b) =>
          Float32Array.from({ length: b.keys.length }, (_, k) =>
            k === b.baseKey ? 0 : blendAt(b.firstKeyform + k),
          ),
        )
      : [];
    // A step adds ±0 if all its values are ±0 and its weights are finite (w·0 with
    // w = ±∞ is NaN).
    const keep = blend
      .map((_, j) => j)
      .filter((j) => !(allZero(blend[j]!) && finiteWeights(list[j]!)));
    const folded = keep.length === 0 || drawOrder ? fold(values) : null;
    return {
      values,
      blendSlots: Int32Array.from(keep),
      blendValues: keep.map((j) => blend[j]!),
      constant: folded ? folded.constant : NaN,
      foldActive: folded ? folded.foldActive : -1,
    };
  }

  colorProps(
    band: number,
    first: number,
    list: readonly BlendShapeBinding[],
    withBlends: boolean,
    idx: ColorIndices,
  ): ScalarProp[] {
    if (this.v < 4) return [];
    const m = this.m;
    const out: ScalarProp[] = [];
    for (let ch = 0; ch < 3; ch++)
      out.push(
        this.scalar(
          band,
          first,
          list,
          withBlends,
          (k) => m.multiplyColors[idx.multiply[k]! * 3 + ch]!,
        ),
      );
    for (let ch = 0; ch < 3; ch++)
      out.push(
        this.scalar(band, first, list, withBlends, (k) => m.screenColors[idx.screen[k]! * 3 + ch]!),
      );
    return shareEqualNeighbours(out);
  }

  /** Per normal keyform: 1 if its run of `length` floats holds no −0. */
  plainRuns(offsets: Int32Array, length: number): Uint8Array {
    const positions = this.m.positions;
    return Uint8Array.from(offsets, (o) => {
      for (let i = o; i < o + length; i++)
        if (positions[i] === 0 && 1 / positions[i]! < 0) return 0;
      return 1;
    });
  }

  /** Deformer i's values: warps' −0 flags, opacity, colors, rotation values, and the props list. */
  deformer(
    i: number,
    positionOffsets: Int32Array,
    gridLength: number,
  ): Pick<
    DeformerPlan,
    "plainRun" | "opacity" | "colors" | "angle" | "originX" | "originY" | "scale" | "props"
  > {
    const m = this.m;
    const kf = m.keyforms;
    const d = m.deformers;
    const band = d.band[i]!;
    const k = d.kindIndex[i]!;
    const blend = this.v >= 5;
    let values: Pick<
      DeformerPlan,
      "plainRun" | "opacity" | "colors" | "angle" | "originX" | "originY" | "scale"
    >;
    if (d.kind[i] === WARP_KIND) {
      const first = m.warps.firstKeyform[k]!;
      const list = this.bs.warp[k]!;
      values = {
        plainRun: this.plainRuns(positionOffsets, gridLength),
        opacity: this.scalar(band, first, list, blend, (x) => kf.warpOpacity[x]!),
        colors: this.colorProps(band, first, list, blend, kf.warpColors),
        angle: none(),
        originX: none(),
        originY: none(),
        scale: none(),
      };
    } else {
      const first = m.rotations.firstKeyform[k]!;
      const list = this.bs.rotation[k]!;
      values = {
        plainRun: new Uint8Array(0),
        opacity: this.scalar(band, first, list, blend, (x) => kf.rotationOpacity[x]!),
        colors: this.colorProps(band, first, list, blend, kf.rotationColors),
        angle: this.scalar(band, first, list, blend, (x) => kf.rotationAngle[x]!),
        originX: this.scalar(band, first, list, blend, (x) => kf.rotationOriginX[x]!),
        originY: this.scalar(band, first, list, blend, (x) => kf.rotationOriginY[x]!),
        scale: this.scalar(band, first, list, blend, (x) => kf.rotationScale[x]!),
      };
    }
    const rotation =
      d.kind[i] === WARP_KIND ? [] : [values.angle, values.originX, values.originY, values.scale];
    return {
      ...values,
      props: shareEqualNeighbours([values.opacity, ...sixColors(values.colors), ...rotation]),
    };
  }

  /** Mesh i's values: −0 flags, opacity, draw order, colors, and the props list. */
  mesh(
    i: number,
    positionOffsets: Int32Array,
  ): Pick<MeshPlan, "plainRun" | "opacity" | "drawOrder" | "colors" | "props"> {
    const m = this.m;
    const kf = m.keyforms;
    const me = m.meshes;
    const band = me.band[i]!;
    const first = me.firstKeyform[i]!;
    const list = this.bs.mesh[i]!;
    const full = this.v >= 5;
    const opacity = this.scalar(band, first, list, full, (x) => kf.meshOpacity[x]!);
    const drawOrder = this.scalar(band, first, list, full, (x) => kf.meshDrawOrder[x]!, true);
    const colors = this.colorProps(band, first, list, full, kf.meshColors);
    return {
      plainRun: this.plainRuns(positionOffsets, 2 * me.vertexCount[i]!),
      opacity,
      drawOrder,
      colors,
      props: shareEqualNeighbours([opacity, drawOrder, ...sixColors(colors)]),
    };
  }

  /** Part p's draw order. */
  part(p: number): ScalarProp {
    const m = this.m;
    return this.scalar(
      m.parts.band[p]!,
      m.parts.firstKeyform[p]!,
      this.bs.part[p]!,
      this.v >= 5,
      (x) => m.keyforms.partDrawOrder[x]!,
      true,
    );
  }

  /** Glue g's intensity. */
  glue(g: number): ScalarProp {
    const m = this.m;
    return this.scalar(
      m.glues.band[g]!,
      m.glues.firstKeyform[g]!,
      this.bs.glue[g]!,
      this.v >= 5,
      (x) => m.keyforms.glueIntensity[x]!,
    );
  }

  /**
   * Offscreen o's values. Its normal keyforms are its owner part's, through
   * the part→offscreen keyform map (−1: all zero); its blend shapes are its own, from the
   * offscreen targets (count 37), never the owner part's. Their
   * keyforms are offscreen keyforms, read directly. The colors of those
   * blend-shape keyforms use each keyform's own multiply and screen indices,
   * as for other targets' blend-shape keyforms. Whether the runtime reads
   * these or the first index + position is not settled: the files studied
   * do not tell them apart.
   */
  offscreen(o: number): Pick<OffscreenPlan, "opacity" | "colors" | "props"> {
    const m = this.m;
    const kf = m.keyforms;
    const owner = m.offscreens.part[o]!;
    const band = m.parts.band[owner]!;
    const first = m.parts.firstKeyform[owner]!;
    const list = this.bs.offscreen[o]!;
    const map = kf.partOffscreenKeyform;
    const idx = kf.offscreenColors;
    // A normal keyform without an offscreen keyform (−1) gives opacity and colors 0.
    const prop = (read: (offscreenKeyform: number) => number) =>
      this.scalar(band, first, list, true, (k) => (map[k]! >= 0 ? read(map[k]!) : 0), false, read);
    const colors: ScalarProp[] = [];
    for (let ch = 0; ch < 3; ch++)
      colors.push(prop((ok) => m.multiplyColors[idx.multiply[ok]! * 3 + ch]!));
    for (let ch = 0; ch < 3; ch++)
      colors.push(prop((ok) => m.screenColors[idx.screen[ok]! * 3 + ch]!));
    const opacity = prop((ok) => kf.offscreenOpacity[ok]!);
    return { opacity, colors, props: shareEqualNeighbours([opacity, ...colors]) };
  }
}

function fixed(value: number): ScalarProp {
  return {
    values: Float32Array.of(value),
    blendSlots: new Int32Array(0),
    blendValues: [],
    constant: value,
    foldActive: Infinity,
  };
}
const none = (): ScalarProp => fixed(0);
/** Colors as six props; constant white multiply / black screen before v4. */
const sixColors = (colors: ScalarProp[]): ScalarProp[] =>
  colors.length ? colors : [fixed(1), fixed(1), fixed(1), fixed(0), fixed(0), fixed(0)];

/** The kinds of objects a plan holds values for. */
export type PlanObjectKind = "deformer" | "mesh" | "part" | "glue" | "offscreen";

/**
 * Recomputes the value-derived parts of one object's plan (its scalar
 * properties and −0 flags) from the model's current values, in place, after
 * the model's values were changed. The structure (bindings, offsets) stays.
 */
export function refreshPlan(model: MocModel, kind: PlanObjectKind, index: number): void {
  const on = plans.get(model);
  const off = plansWithoutBlendShapes.get(model);
  // A plan not built yet is built later, from the patched values.
  if (on) refreshObject(on, new ValueBuilder(model), kind, index);
  if (off) refreshObject(off, new ValueBuilder(model, blendShapeLists(model, false)), kind, index);
}

function refreshObject(plan: EvalPlan, b: ValueBuilder, kind: PlanObjectKind, index: number): void {
  switch (kind) {
    case "deformer": {
      const d = plan.deformers[index]!;
      Object.assign(d, b.deformer(index, d.positionOffsets, d.gridLength));
      break;
    }
    case "mesh": {
      const me = plan.meshes[index]!;
      Object.assign(me, b.mesh(index, me.positionOffsets));
      break;
    }
    case "part": {
      const p = plan.parts[index]!;
      p.drawOrder = b.part(index);
      p.props = [p.drawOrder];
      break;
    }
    case "glue": {
      const g = plan.glues[index]!;
      g.intensity = b.glue(index);
      g.props = [g.intensity];
      break;
    }
    case "offscreen":
      Object.assign(plan.offscreens[index]!, b.offscreen(index));
      break;
  }
}

function buildPlan(m: MocModel, blendShapes: boolean): EvalPlan {
  const kf = m.keyforms;
  const bs = blendShapeLists(m, blendShapes);
  const values = new ValueBuilder(m, bs);
  const blends: BlendPlan[] = [];
  const blendIndex = new Map<BlendShapeBinding, number>();
  const register = (
    list: readonly BlendShapeBinding[],
    firstPosition: Int32Array | null,
  ): Int32Array =>
    Int32Array.from(list, (b) => {
      let i = blendIndex.get(b);
      if (i === undefined) {
        i = blends.length;
        const offsets = firstPosition
          ? Int32Array.from({ length: b.keys.length }, (_, k) =>
              k === b.baseKey ? -1 : firstPosition[b.firstKeyform + k]!,
            )
          : new Int32Array(0);
        blends.push({ binding: b, positionOffsets: offsets });
        blendIndex.set(b, i);
      }
      return i;
    });
  const keyformCount = (band: number) => m.bands[band]!.keyformCount;

  // Deformers.
  const deformers: DeformerPlan[] = [];
  const d = m.deformers;
  for (let i = 0; i < d.ids.length; i++) {
    const band = d.band[i]!;
    const k = d.kindIndex[i]!;
    if (d.kind[i] === WARP_KIND) {
      const first = m.warps.firstKeyform[k]!;
      const R = m.warps.rows[k]!;
      const C = m.warps.columns[k]!;
      const positionOffsets = Int32Array.from(
        { length: keyformCount(band) },
        (_, o) => kf.warpFirstPosition[first + o]!,
      );
      const gridLength = 2 * (R + 1) * (C + 1);
      deformers.push({
        kind: 0,
        band,
        blends: register(bs.warp[k]!, kf.warpFirstPosition),
        positionOffsets,
        gridLength,
        rows: R,
        columns: C,
        bilinear: m.warps.bilinear[k] === 1,
        baseAngle: 0,
        firstKeyform: first,
        ...values.deformer(i, positionOffsets, gridLength),
      });
    } else {
      const first = m.rotations.firstKeyform[k]!;
      const positionOffsets = new Int32Array(0);
      deformers.push({
        kind: 1,
        band,
        blends: register(bs.rotation[k]!, null),
        positionOffsets,
        gridLength: 0,
        rows: 0,
        columns: 0,
        bilinear: false,
        baseAngle: m.rotations.baseAngle[k]!,
        firstKeyform: first,
        ...values.deformer(i, positionOffsets, 0),
      });
    }
  }

  // Meshes.
  const meshes: MeshPlan[] = [];
  const me = m.meshes;
  for (let i = 0; i < me.ids.length; i++) {
    const band = me.band[i]!;
    const first = me.firstKeyform[i]!;
    const positionOffsets = Int32Array.from(
      { length: keyformCount(band) },
      (_, o) => kf.meshFirstPosition[first + o]!,
    );
    meshes.push({
      band,
      blends: register(bs.mesh[i]!, kf.meshFirstPosition),
      positionOffsets,
      ...values.mesh(i, positionOffsets),
    });
  }

  // Parts (draw order) and glues (intensity).
  const parts = m.parts.ids.map((_, p) => {
    const drawOrder = values.part(p);
    return {
      band: m.parts.band[p]!,
      blends: register(bs.part[p]!, null),
      drawOrder,
      props: [drawOrder],
    };
  });
  const glues = m.glues.ids.map((_, g) => {
    const intensity = values.glue(g);
    return {
      band: m.glues.band[g]!,
      blends: register(bs.glue[g]!, null),
      intensity,
      props: [intensity],
    };
  });

  // Offscreens: normal keyforms through the owning part's, blend shapes their own.
  const offscreens = Array.from(m.offscreens.part, (owner, o): OffscreenPlan => {
    const chain: number[] = [];
    for (let p = m.parts.parent[owner]!; p >= 0; p = m.parts.parent[p]!) {
      if (m.parts.offscreen[p]! >= 0) break;
      chain.push(p);
    }
    return {
      owner,
      band: m.parts.band[owner]!,
      blends: register(bs.offscreen[o]!, null),
      partChain: Int32Array.from(chain),
      ...values.offscreen(o),
    };
  });

  const glueMeshes = new Set<number>();
  for (let g = 0; g < m.glues.ids.length; g++) {
    glueMeshes.add(m.glues.meshA[g]!);
    glueMeshes.add(m.glues.meshB[g]!);
  }

  return {
    blends,
    deformers,
    meshes,
    parts,
    glues,
    offscreens,
    maxBandBindings: m.bands.reduce((a, b) => Math.max(a, b.bindings.length), 0),
    glueMeshes: Int32Array.from([...glueMeshes].sort((a, b) => a - b)),
  };
}

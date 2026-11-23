/**
 * Builds the object graph of a `.moc3` file (§1b.6) and validates
 * it (§1b.7 plus Mochi2D's stricter rules). The evaluator relies on these
 * checks: a model that passes cannot index out of range, loop or hang.
 */
import {
  MocFormatError,
  SectionAccess,
  readMocSections,
  type MocCanvas,
  type MocSections,
} from "./read.js";
import { Count } from "./schema.js";
import { KEY_EPSILON, keyTolerance, keyformDrawOrder } from "../eval/f32.js";

export const WARP_KIND = 0;
export const ROTATION_KIND = 1;

/** One blend-shape keyform binding attached to a target object (§1b.6.9, §1c.4). */
export interface BlendShapeBinding {
  /** Owner parameter of the blend-shape parameter binding. */
  parameter: number;
  keys: Float32Array;
  baseKey: number;
  /** First keyform, in the target kind's keyform array (one per key). */
  firstKeyform: number;
  constraints: BlendShapeConstraint[];
}

export interface BlendShapeConstraint {
  parameter: number;
  keys: Float32Array;
  weights: Float32Array;
}

export interface Band {
  /** Parameter-binding indices, innermost (fastest-varying) first. */
  bindings: Int32Array;
  /** Keyform strides per binding. */
  strides: Int32Array;
  /** Product of key counts (1 for an empty band). */
  keyformCount: number;
}

export interface GroupObject {
  /** 0 = art mesh, 1 = part. */
  kind: 0 | 1;
  index: number;
  /** Nested group of a part object; -1 for art meshes. */
  nestedGroup: number;
}

/** Keyform color indices: -1 means "no color" (v1–v3). */
export interface ColorIndices {
  multiply: Int32Array;
  screen: Int32Array;
}

export interface MocModel {
  /** Problems found while loading that do not prevent use (see {@link LoadMocOptions}). */
  loadWarnings: string[];
  version: number;
  bigEndian: boolean;
  canvas: MocCanvas;

  parameters: {
    ids: string[];
    min: Float32Array;
    max: Float32Array;
    defaults: Float32Array;
    repeat: Uint8Array;
    /** 0 = normal, 1 = blend shape (always 0 before v4). */
    type: Uint8Array;
    /** Reported key list (§1b.6.6). */
    keyLists: Float32Array[];
    /** Decimal places d (slot 55); the parameter's key tolerance is 10^−d (S1). */
    decimals: Int32Array;
  };
  /** Parameter bindings (interpolation axes). */
  bindings: {
    parameter: Int32Array;
    keys: Float32Array[];
    /** Key snapping and range tolerance ε = f32(10^−d) of the binding's parameter. */
    epsilon: Float32Array;
  };
  bands: Band[];

  parts: {
    ids: string[];
    band: Int32Array;
    firstKeyform: Int32Array;
    initialOpacity: Float32Array;
    enabled: Uint8Array;
    parent: Int32Array;
    /** Offscreen owned by the part, -1 if none (v6). */
    offscreen: Int32Array;
  };
  deformers: {
    ids: string[];
    band: Int32Array;
    enabled: Uint8Array;
    part: Int32Array;
    parent: Int32Array;
    kind: Uint8Array;
    kindIndex: Int32Array;
  };
  warps: {
    band: Int32Array;
    firstKeyform: Int32Array;
    rows: Int32Array;
    columns: Int32Array;
    bilinear: Uint8Array;
  };
  rotations: {
    band: Int32Array;
    firstKeyform: Int32Array;
    baseAngle: Float32Array;
  };
  meshes: {
    ids: string[];
    band: Int32Array;
    firstKeyform: Int32Array;
    enabled: Uint8Array;
    part: Int32Array;
    deformer: Int32Array;
    texture: Int32Array;
    flags: Uint8Array;
    /** Blend mode: v6 slot, or derived from the legacy flags before v6. */
    blendMode: Int32Array;
    vertexCount: Int32Array;
    /** Stored UVs (v top-down), 2 floats per vertex. */
    uvs: Float32Array[];
    /** Stored triangle indices (file winding). */
    triangles: Uint16Array[];
    /** Mask art-mesh indices, -1 entries removed. */
    masks: Int32Array[];
  };
  glues: {
    ids: string[];
    band: Int32Array;
    firstKeyform: Int32Array;
    meshA: Int32Array;
    meshB: Int32Array;
    /** First glue-info entry of each glue (its pairs: a vertex of A, then of B). */
    firstInfo: Int32Array;
    vertexA: Uint16Array[];
    weightA: Float32Array[];
    vertexB: Uint16Array[];
    weightB: Float32Array[];
  };
  groups: {
    objects: GroupObject[][];
    minDrawOrder: Int32Array;
    maxDrawOrder: Int32Array;
    entryCount: Int32Array;
  };
  offscreens: {
    part: Int32Array;
    flags: Uint8Array;
    blendMode: Int32Array;
    masks: Int32Array[];
  };

  keyforms: {
    partDrawOrder: Float32Array;
    partOffscreenKeyform: Int32Array;
    warpOpacity: Float32Array;
    warpFirstPosition: Int32Array;
    warpColors: ColorIndices;
    rotationOpacity: Float32Array;
    rotationAngle: Float32Array;
    rotationOriginX: Float32Array;
    rotationOriginY: Float32Array;
    rotationScale: Float32Array;
    rotationMirrorX: Uint8Array;
    rotationMirrorY: Uint8Array;
    rotationColors: ColorIndices;
    meshOpacity: Float32Array;
    meshDrawOrder: Float32Array;
    meshFirstPosition: Int32Array;
    meshColors: ColorIndices;
    offscreenOpacity: Float32Array;
    offscreenColors: ColorIndices;
    glueIntensity: Float32Array;
  };
  positions: Float32Array;
  /** RGB triples. */
  multiplyColors: Float32Array;
  screenColors: Float32Array;

  blendShapes: {
    warp: BlendShapeBinding[][];
    mesh: BlendShapeBinding[][];
    /** A part target's keyforms change the part's draw order only. */
    part: BlendShapeBinding[][];
    rotation: BlendShapeBinding[][];
    glue: BlendShapeBinding[][];
    /**
     * (v6) Offscreen targets (count 37): their keyforms are offscreen
     * keyforms, after the normal ones, and change the offscreen's opacity and
     * colors.
     */
    offscreen: BlendShapeBinding[][];
  };
}

class Checker {
  check(cond: boolean, message: () => string): asserts cond {
    if (!cond) throw new MocFormatError(message());
  }
  /** `i` must be an integer in [lo, hi). */
  index(i: number, lo: number, hi: number, what: () => string): void {
    if (!(Number.isInteger(i) && i >= lo && i < hi)) {
      throw new MocFormatError(`${what()}: index ${i} out of range [${lo}, ${hi})`);
    }
  }
  /** [first, first + count) must lie within [0, total). An empty range may start anywhere. */
  range(first: number, count: number, total: number, what: () => string): void {
    if (count < 0) throw new MocFormatError(`${what()}: negative count ${count}`);
    if (count === 0) return;
    if (!(first >= 0 && first + count <= total)) {
      throw new MocFormatError(
        `${what()}: range [${first}, ${first + count}) out of bounds (0…${total})`,
      );
    }
  }
}

export interface LoadMocOptions {
  /**
   * Keyform draw orders outside the range of their draw-order group (C12,
   * C25). "warn" (default): the file loads, as in the official
   * runtime, with one warning per object in `loadWarnings` naming the object
   * and its group's range; the keys stay as they are, and the render order
   * sorts by the evaluated draw order. "reject": the opt-in strict mode for
   * validation tooling, which fails the load.
   */
  drawOrderRange?: "warn" | "reject";
  /**
   * Keyform opacities that are NaN or ±∞ (of warps, rotations, art meshes and
   * offscreens). No genuine file has one, so "reject" (default) fails the
   * load. "load" accepts them, as the official runtime does: a NaN opacity is
   * then reported as NaN, and the drawable counts as visible.
   */
  nonFiniteOpacity?: "reject" | "load";
  /**
   * Part keyforms (v6) whose offscreen keyform entry is neither −1 nor an
   * offscreen keyform. The official check rejects such files, and the
   * official runtime loads them. Mochi2D never reads the entries of
   * blend-shape keyforms. "reject" (default) fails the load. "load" accepts them, reading such an entry as
   * −1 (the offscreen's opacity and colors 0), with a warning in
   * `loadWarnings`.
   */
  offscreenKeyformRange?: "reject" | "load";
}

/** Reads and validates a `.moc3` file. Throws {@link MocFormatError}. */
export function loadMoc(
  data: ArrayBuffer | ArrayBufferView,
  options: LoadMocOptions = {},
): MocModel {
  return buildModel(readMocSections(data), options);
}

export function buildModel(sections: MocSections, options: LoadMocOptions = {}): MocModel {
  const loadWarnings: string[] = [];
  const s = new SectionAccess(sections);
  const v = sections.version;
  const c: Checker = new Checker();
  const n = {
    parts: s.count(Count.Parts),
    deformers: s.count(Count.Deformers),
    warps: s.count(Count.Warps),
    rotations: s.count(Count.Rotations),
    meshes: s.count(Count.ArtMeshes),
    parameters: s.count(Count.Parameters),
    partKeyforms: s.count(Count.PartKeyforms),
    warpKeyforms: s.count(Count.WarpKeyforms),
    rotationKeyforms: s.count(Count.RotationKeyforms),
    meshKeyforms: s.count(Count.ArtMeshKeyforms),
    positions: s.count(Count.PositionFloats),
    bindingEntries: s.count(Count.BindingIndexEntries),
    bands: s.count(Count.Bands),
    bindings: s.count(Count.ParameterBindings),
    keys: s.count(Count.KeyValues),
    uvs: s.count(Count.UvFloats),
    triangleEntries: s.count(Count.TriangleIndexEntries),
    maskEntries: s.count(Count.MaskEntries),
    groups: s.count(Count.DrawOrderGroups),
    groupObjects: s.count(Count.DrawOrderGroupObjects),
    glues: s.count(Count.Glues),
    glueInfos: s.count(Count.GlueInfoEntries),
    glueKeyforms: s.count(Count.GlueKeyforms),
    multiplyColors: s.count(Count.MultiplyColors),
    screenColors: s.count(Count.ScreenColors),
    bsBindings: s.count(Count.BlendShapeParameterBindings),
    bsKeyformBindings: s.count(Count.BlendShapeKeyformBindings),
    constraintEntries: s.count(Count.BlendShapeConstraintIndexEntries),
    constraints: s.count(Count.BlendShapeConstraints),
    constraintValues: s.count(Count.BlendShapeConstraintValues),
    offscreens: s.count(Count.Offscreens),
    offscreenKeyforms: s.count(Count.OffscreenKeyforms),
  };
  const keys = s.f32("keys");

  // ---- parameter bindings and their keys ----
  const bindingFirstKey = s.i32("binding.firstKey");
  const bindingKeyCount = s.i32("binding.keyCount");
  const bindingKeys: Float32Array[] = [];
  const keysAt = (first: number, count: number, what: () => string): Float32Array => {
    c.range(first, count, n.keys, what);
    c.check(count >= 1, () => `${what()}: has no keys`);
    const k = keys.subarray(first, first + count);
    for (let i = 1; i < k.length; i++) {
      c.check(
        k[i]! > k[i - 1]!,
        () => `${what()}: keys are not strictly ascending (${k[i - 1]} then ${k[i]})`,
      );
    }
    return k;
  };
  for (let b = 0; b < n.bindings; b++) {
    bindingKeys.push(
      keysAt(bindingFirstKey[b]!, bindingKeyCount[b]!, () => `parameter binding ${b}`),
    );
  }

  // The seven 0/1 fields: the official check rejects any other value (S6).
  for (const key of [
    "part.initiallyVisible",
    "part.enabled",
    "deformer.visible",
    "deformer.enabled",
    "mesh.visible",
    "mesh.enabled",
    "parameter.repeat",
  ] as const) {
    const values = s.i32(key);
    for (let i = 0; i < values.length; i++)
      c.check(
        values[i] === 0 || values[i] === 1,
        () => `${key} ${i}: ${values[i]} is not a flag value (0 or 1)`,
      );
  }

  // ---- parameters ----
  const pIds = s.names("parameter.id");
  const pMin = s.f32("parameter.min");
  const pMax = s.f32("parameter.max");
  const pFirstBinding = s.i32("parameter.firstBinding");
  const pBindingCount = s.i32("parameter.bindingCount");
  const pDecimals = s.i32("parameter.decimals");
  const bindingParameter = new Int32Array(n.bindings).fill(-1);
  const pType = new Uint8Array(n.parameters);
  const pTypeRaw = s.i32("parameter.type");
  for (let p = 0; p < n.parameters; p++) {
    const what = () => `parameter ${p} (${pIds[p]})`;
    c.check(!(pMin[p]! > pMax[p]!), () => `${what()}: min ${pMin[p]} > max ${pMax[p]}`);
    c.check(pDecimals[p]! >= 0, () => `${what()}: negative decimal places ${pDecimals[p]}`);
    c.range(pFirstBinding[p]!, pBindingCount[p]!, n.bindings, () => `${what()} bindings`);
    for (let b = pFirstBinding[p]!; b < pFirstBinding[p]! + pBindingCount[p]!; b++) {
      c.check(bindingParameter[b] === -1, () => `parameter binding ${b} is owned twice`);
      bindingParameter[b] = p;
    }
    if (v >= 4) {
      const t = pTypeRaw[p]!;
      c.check(t === 0 || t === 1, () => `${what()}: unknown type ${t}`);
      pType[p] = t;
    }
  }
  for (let b = 0; b < n.bindings; b++) {
    c.check(
      bindingParameter[b] !== -1,
      () => `parameter binding ${b} is not owned by any parameter`,
    );
  }
  const keyLists: Float32Array[] = [];
  if (v >= 4) {
    const firstKey = s.i32("parameter.firstKey");
    const keyCount = s.i32("parameter.keyCount");
    for (let p = 0; p < n.parameters; p++) {
      c.range(firstKey[p]!, keyCount[p]!, n.keys, () => `parameter ${p} (${pIds[p]}) key list`);
      keyLists.push(keys.slice(firstKey[p]!, firstKey[p]! + keyCount[p]!));
    }
  } else {
    for (let p = 0; p < n.parameters; p++) {
      const set = new Set<number>();
      for (let b = pFirstBinding[p]!; b < pFirstBinding[p]! + pBindingCount[p]!; b++) {
        for (const k of bindingKeys[b]!) set.add(k);
      }
      keyLists.push(Float32Array.from([...set].sort((a, b) => a - b)));
    }
  }

  // ---- bands ----
  const bandFirst = s.i32("band.firstEntry");
  const bandCount = s.i32("band.entryCount");
  const bindingIndex = s.i32("bindingIndex");
  for (let e = 0; e < n.bindingEntries; e++) {
    c.index(bindingIndex[e]!, 0, n.bindings, () => `binding-index entry ${e}`);
  }
  const bands: Band[] = [];
  for (let b = 0; b < n.bands; b++) {
    c.range(bandFirst[b]!, bandCount[b]!, n.bindingEntries, () => `keyform binding ${b}`);
    const list = bindingIndex.slice(bandFirst[b]!, bandFirst[b]! + bandCount[b]!);
    const strides = new Int32Array(list.length);
    let size = 1;
    for (let j = 0; j < list.length; j++) {
      strides[j] = size;
      size *= bindingKeys[list[j]!]!.length;
      c.check(size <= 0x7fffffff, () => `keyform binding ${b}: keyform count overflows`);
    }
    bands.push({ bindings: list, strides, keyformCount: size });
  }
  /** Validates an object's band and keyform range; returns the keyform count. */
  const keyformRange = (
    band: number,
    first: number,
    count: number,
    total: number,
    what: () => string,
  ): void => {
    c.index(band, 0, n.bands, () => `${what()} keyform binding`);
    c.range(first, count, total, () => `${what()} keyforms`);
    const expected = bands[band]!.keyformCount;
    c.check(
      count === expected,
      () => `${what()}: ${count} keyforms but its bindings need ${expected}`,
    );
  };

  // ---- colors ----
  const multiplyColors = new Float32Array(n.multiplyColors * 3);
  const screenColors = new Float32Array(n.screenColors * 3);
  if (v >= 4) {
    const [mr, mg, mb] = [
      s.f32("multiplyColor.r"),
      s.f32("multiplyColor.g"),
      s.f32("multiplyColor.b"),
    ];
    for (let i = 0; i < n.multiplyColors; i++) multiplyColors.set([mr[i]!, mg[i]!, mb[i]!], i * 3);
    const [sr, sg, sb] = [s.f32("screenColor.r"), s.f32("screenColor.g"), s.f32("screenColor.b")];
    for (let i = 0; i < n.screenColors; i++) screenColors.set([sr[i]!, sg[i]!, sb[i]!], i * 3);
  }
  const noColors = (count: number): ColorIndices => ({
    multiply: new Int32Array(count).fill(-1),
    screen: new Int32Array(count).fill(-1),
  });
  /**
   * v5+: the per-keyform color entries (slots 137–142, 162–163). Only
   * blend-shape keyforms keep them: normal keyforms are overwritten below with
   * the object's first color entry + position (C5). Validated by
   * {@link checkColors} once that is done.
   */
  const v5Colors = (
    mKey: Parameters<SectionAccess["i32"]>[0],
    sKey: Parameters<SectionAccess["i32"]>[0],
  ): ColorIndices => ({
    multiply: Int32Array.from(s.i32(mKey)),
    screen: Int32Array.from(s.i32(sKey)),
  });
  /**
   * The per-keyform color indices of every warp, rotation and art-mesh
   * keyform, normal ones too (which Mochi2D does not read): the official
   * check accepts 0…N, N being the table size, and Mochi2D rejects N as well
   * (S6; rotations as warps and art meshes).
   */
  const checkOwnColors = (colors: ColorIndices, what: string): void => {
    for (let k = 0; k < colors.multiply.length; k++) {
      c.index(
        colors.multiply[k]!,
        0,
        n.multiplyColors,
        () => `${what} keyform ${k} multiply color`,
      );
      c.index(colors.screen[k]!, 0, n.screenColors, () => `${what} keyform ${k} screen color`);
    }
  };
  const checkColors = (colors: ColorIndices, what: string): void => {
    for (let k = 0; k < colors.multiply.length; k++) {
      c.index(
        colors.multiply[k]!,
        0,
        n.multiplyColors,
        () => `${what} keyform ${k} multiply color`,
      );
      c.index(colors.screen[k]!, 0, n.screenColors, () => `${what} keyform ${k} screen color`);
    }
  };
  /**
   * v4+: normal keyform k of an object takes both colors from entry C + (k − F),
   * C being the object's first color entry (slots 105–107). In v5+ files this
   * replaces the per-keyform entries, which the runtime does not read for
   * normal keyforms (C5).
   */
  const v4Colors = (
    target: ColorIndices,
    first: number,
    count: number,
    firstColor: number,
    what: () => string,
  ): void => {
    c.range(
      firstColor,
      count,
      Math.min(n.multiplyColors, n.screenColors),
      () => `${what()} colors`,
    );
    for (let k = 0; k < count; k++) {
      target.multiply[first + k] = firstColor + k;
      target.screen[first + k] = firstColor + k;
    }
  };

  // ---- parts ----
  const partIds = s.names("part.id");
  const partBand = s.i32("part.band");
  const partFirst = s.i32("part.firstKeyform");
  const partCount = s.i32("part.keyformCount");
  const partParent = s.i32("part.parent");
  const partOffscreen = v >= 6 ? s.i32("part.offscreen") : new Int32Array(n.parts).fill(-1);
  const partInitial = new Float32Array(n.parts);
  const partEnabled = new Uint8Array(n.parts);
  const rawInitial = s.i32("part.initiallyVisible");
  const rawPartEnabled = s.i32("part.enabled");
  for (let i = 0; i < n.parts; i++) {
    const what = () => `part ${i} (${partIds[i]})`;
    c.check(
      partParent[i]! >= -1 && partParent[i]! < i,
      () => `${what()}: parent ${partParent[i]} must be -1 or an earlier part`,
    );
    keyformRange(partBand[i]!, partFirst[i]!, partCount[i]!, n.partKeyforms, what);
    c.index(partOffscreen[i]!, -1, n.offscreens, () => `${what()} offscreen`);
    partInitial[i] = rawInitial[i] === 1 ? 1 : 0;
    partEnabled[i] = rawPartEnabled[i] !== 0 ? 1 : 0;
  }

  // ---- deformers ----
  const dIds = s.names("deformer.id");
  const dKind = s.i32("deformer.kind");
  const dKindIndex = s.i32("deformer.kindIndex");
  const dPart = s.i32("deformer.part");
  const dParent = s.i32("deformer.parent");
  const dBandRaw = s.i32("deformer.band");
  const dEnabledRaw = s.i32("deformer.enabled");
  const dKindU8 = new Uint8Array(n.deformers);
  const dBand = new Int32Array(n.deformers);
  const dEnabled = new Uint8Array(n.deformers);
  const warpBand = s.i32("warp.band");
  const rotBand = s.i32("rotation.band");
  for (let d = 0; d < n.deformers; d++) {
    const what = () => `deformer ${d} (${dIds[d]})`;
    const kind = dKind[d]!;
    c.check(kind === WARP_KIND || kind === ROTATION_KIND, () => `${what()}: unknown kind ${kind}`);
    c.index(
      dKindIndex[d]!,
      0,
      kind === WARP_KIND ? n.warps : n.rotations,
      () => `${what()} ${kind === WARP_KIND ? "warp" : "rotation"} record`,
    );
    // -1 = no owning part (occurs in real files); then no part gates the deformer.
    c.index(dPart[d]!, -1, n.parts, () => `${what()} owning part`);
    c.check(
      dParent[d]! >= -1 && dParent[d]! < d,
      () => `${what()}: parent ${dParent[d]} must be -1 or an earlier deformer`,
    );
    c.index(dBandRaw[d]!, 0, n.bands, () => `${what()} keyform binding`);
    dKindU8[d] = kind;
    dBand[d] = kind === WARP_KIND ? warpBand[dKindIndex[d]!]! : rotBand[dKindIndex[d]!]!;
    dEnabled[d] = dEnabledRaw[d] !== 0 ? 1 : 0;
  }

  // ---- warps ----
  const warpFirst = s.i32("warp.firstKeyform");
  const warpCount = s.i32("warp.keyformCount");
  const warpRows = s.i32("warp.rows");
  const warpCols = s.i32("warp.columns");
  const warpPoints = s.i32("warp.pointCount");
  const warpBilinear = new Uint8Array(n.warps);
  const rawBilinear = v >= 2 ? s.i32("warp.bilinear") : new Int32Array(n.warps);
  const warpColors =
    v >= 5
      ? v5Colors("warpKeyform.multiplyColor", "warpKeyform.screenColor")
      : noColors(n.warpKeyforms);
  if (v >= 5) checkOwnColors(warpColors, "warp");
  const warpFirstPosition = s.i32("warpKeyform.firstPosition");
  const warpFirstColor = s.i32("warp.firstColor");
  const checkPositions = (first: Int32Array, k: number, floats: number, what: () => string) => {
    c.range(first[k]!, floats, n.positions, () => `${what()} keyform ${k} positions`);
  };
  for (let w = 0; w < n.warps; w++) {
    const what = () => `warp ${w}`;
    const R = warpRows[w]!;
    const C = warpCols[w]!;
    c.check(R >= 1 && C >= 1, () => `${what()}: grid of ${R}×${C} cells`);
    c.check(
      warpPoints[w] === (R + 1) * (C + 1),
      () => `${what()}: ${warpPoints[w]} grid points, expected (R+1)(C+1) = ${(R + 1) * (C + 1)}`,
    );
    keyformRange(warpBand[w]!, warpFirst[w]!, warpCount[w]!, n.warpKeyforms, what);
    for (let k = warpFirst[w]!; k < warpFirst[w]! + warpCount[w]!; k++)
      checkPositions(warpFirstPosition, k, 2 * warpPoints[w]!, what);
    if (v >= 4) v4Colors(warpColors, warpFirst[w]!, warpCount[w]!, warpFirstColor[w]!, what);
    warpBilinear[w] = rawBilinear[w] !== 0 ? 1 : 0;
  }
  if (v >= 5) checkColors(warpColors, "warp");

  // ---- rotations ----
  const rotFirst = s.i32("rotation.firstKeyform");
  const rotCount = s.i32("rotation.keyformCount");
  const rotColors =
    v >= 5
      ? v5Colors("rotationKeyform.multiplyColor", "rotationKeyform.screenColor")
      : noColors(n.rotationKeyforms);
  if (v >= 5) checkOwnColors(rotColors, "rotation");
  const rotFirstColor = s.i32("rotation.firstColor");
  for (let r = 0; r < n.rotations; r++) {
    const what = () => `rotation ${r}`;
    keyformRange(rotBand[r]!, rotFirst[r]!, rotCount[r]!, n.rotationKeyforms, what);
    if (v >= 4) v4Colors(rotColors, rotFirst[r]!, rotCount[r]!, rotFirstColor[r]!, what);
  }
  if (v >= 5) checkColors(rotColors, "rotation");
  const toU8 = (a: Int32Array) => Uint8Array.from(a, (x) => (x !== 0 ? 1 : 0));

  // ---- art meshes ----
  const mIds = s.names("mesh.id");
  const mBand = s.i32("mesh.band");
  const mFirst = s.i32("mesh.firstKeyform");
  const mCount = s.i32("mesh.keyformCount");
  const mPart = s.i32("mesh.part");
  const mDeformer = s.i32("mesh.deformer");
  const mTexture = s.i32("mesh.texture");
  const mFlags = s.u8("mesh.flags");
  const mVertexCount = s.i32("mesh.vertexCount");
  const mFirstUv = s.i32("mesh.firstUv");
  const mFirstTri = s.i32("mesh.firstTriangleIndex");
  const mTriCount = s.i32("mesh.triangleIndexCount");
  const mFirstMask = s.i32("mesh.firstMask");
  const mMaskCount = s.i32("mesh.maskCount");
  const mFirstColor = s.i32("mesh.firstColor");
  const uvsAll = s.f32("uvs");
  const trisAll = s.u16("triangleIndices");
  const masksAll = s.i32("maskEntries");
  // Every mask entry, listed or not, is −1 or an art mesh.
  for (let e = 0; e < masksAll.length; e++)
    c.index(masksAll[e]!, -1, n.meshes, () => `mask entry ${e}`);
  const meshFirstPosition = s.i32("meshKeyform.firstPosition");
  const meshColors =
    v >= 5
      ? v5Colors("meshKeyform.multiplyColor", "meshKeyform.screenColor")
      : noColors(n.meshKeyforms);
  if (v >= 5) checkOwnColors(meshColors, "art-mesh");
  const uvs: Float32Array[] = [];
  const triangles: Uint16Array[] = [];
  const masks: Int32Array[] = [];
  const blendMode = new Int32Array(n.meshes);
  const rawBlend = s.i32("mesh.blendMode");
  for (let m = 0; m < n.meshes; m++) {
    const what = () => `art mesh ${m} (${mIds[m]})`;
    const V = mVertexCount[m]!;
    c.check(V >= 0, () => `${what()}: negative vertex count`);
    keyformRange(mBand[m]!, mFirst[m]!, mCount[m]!, n.meshKeyforms, what);
    c.index(mPart[m]!, -1, n.parts, () => `${what()} parent part`);
    c.index(mDeformer[m]!, -1, n.deformers, () => `${what()} parent deformer`);
    c.check(mTexture[m]! >= 0, () => `${what()}: negative texture index ${mTexture[m]}`);
    c.range(mFirstUv[m]!, 2 * V, n.uvs, () => `${what()} UVs`);
    uvs.push(uvsAll.subarray(mFirstUv[m]!, mFirstUv[m]! + 2 * V));
    c.range(mFirstTri[m]!, mTriCount[m]!, n.triangleEntries, () => `${what()} triangles`);
    c.check(
      mTriCount[m]! % 3 === 0,
      () => `${what()}: ${mTriCount[m]} triangle indices, not a multiple of 3`,
    );
    const tri = trisAll.subarray(mFirstTri[m]!, mFirstTri[m]! + mTriCount[m]!);
    for (let i = 0; i < tri.length; i++)
      c.check(tri[i]! < V, () => `${what()}: triangle index ${tri[i]} ≥ vertex count ${V}`);
    triangles.push(tri);
    c.range(mFirstMask[m]!, mMaskCount[m]!, n.maskEntries, () => `${what()} masks`);
    const mk = masksAll.subarray(mFirstMask[m]!, mFirstMask[m]! + mMaskCount[m]!);
    masks.push(Int32Array.from(mk).filter((e) => e !== -1));
    for (let k = mFirst[m]!; k < mFirst[m]! + mCount[m]!; k++)
      checkPositions(meshFirstPosition, k, 2 * V, what);
    if (v >= 4) v4Colors(meshColors, mFirst[m]!, mCount[m]!, mFirstColor[m]!, what);
    const flags = mFlags[m]!;
    blendMode[m] = v >= 6 ? rawBlend[m]! : flags & 1 ? 1 : flags & 2 ? 2 : 0;
  }

  if (v >= 5) checkColors(meshColors, "art-mesh");

  // The official check's position-run rule: keyform i is
  // tested with object i's run length, whoever owns it. A valid file can fail it;
  // P8's rule is to reject what the official check rejects.
  for (let i = 0; i < n.meshes && i < n.meshKeyforms; i++) {
    const end = meshFirstPosition[i]! + 2 * mVertexCount[i]!;
    c.check(
      end >= 0 && end <= n.positions,
      () =>
        `art-mesh keyform ${i}: start ${meshFirstPosition[i]} + the ${2 * mVertexCount[i]!} position floats of art mesh ${i} ends outside [0, ${n.positions}] (the official check rejects it)`,
    );
  }
  for (let i = 0; i < n.warps && i < n.warpKeyforms; i++) {
    const end = warpFirstPosition[i]! + 2 * warpPoints[i]!;
    c.check(
      end >= 0 && end <= n.positions,
      () =>
        `warp keyform ${i}: start ${warpFirstPosition[i]} + the ${2 * warpPoints[i]!} position floats of warp ${i} ends outside [0, ${n.positions}] (the official check rejects it)`,
    );
  }

  // ---- glues ----
  const gIds = s.names("glue.id");
  const gBand = s.i32("glue.band");
  const gFirst = s.i32("glue.firstKeyform");
  const gCount = s.i32("glue.keyformCount");
  const gA = s.i32("glue.meshA");
  const gB = s.i32("glue.meshB");
  const gFirstInfo = s.i32("glue.firstInfo");
  const gInfoCount = s.i32("glue.infoCount");
  const infoWeight = s.f32("glueInfo.weight");
  const infoVertex = s.u16("glueInfo.vertex");
  const vertexA: Uint16Array[] = [];
  const weightA: Float32Array[] = [];
  const vertexB: Uint16Array[] = [];
  const weightB: Float32Array[] = [];
  for (let g = 0; g < n.glues; g++) {
    const what = () => `glue ${g} (${gIds[g]})`;
    keyformRange(gBand[g]!, gFirst[g]!, gCount[g]!, n.glueKeyforms, what);
    c.index(gA[g]!, 0, n.meshes, () => `${what()} art mesh A`);
    c.index(gB[g]!, 0, n.meshes, () => `${what()} art mesh B`);
    c.range(gFirstInfo[g]!, gInfoCount[g]!, n.glueInfos, () => `${what()} glue info`);
    c.check(gInfoCount[g]! % 2 === 0, () => `${what()}: odd glue-info count ${gInfoCount[g]}`);
    const pairs = gInfoCount[g]! / 2;
    const va = new Uint16Array(pairs);
    const wa = new Float32Array(pairs);
    const vb = new Uint16Array(pairs);
    const wb = new Float32Array(pairs);
    for (let i = 0; i < pairs; i++) {
      const e = gFirstInfo[g]! + 2 * i;
      va[i] = infoVertex[e]!;
      wa[i] = infoWeight[e]!;
      vb[i] = infoVertex[e + 1]!;
      wb[i] = infoWeight[e + 1]!;
      c.check(
        va[i]! < mVertexCount[gA[g]!]!,
        () => `${what()}: vertex ${va[i]} of mesh A out of range`,
      );
      c.check(
        vb[i]! < mVertexCount[gB[g]!]!,
        () => `${what()}: vertex ${vb[i]} of mesh B out of range`,
      );
    }
    vertexA.push(va);
    weightA.push(wa);
    vertexB.push(vb);
    weightB.push(wb);
  }

  // ---- offscreens (v6) ----
  const oPart = s.i32("offscreen.part");
  const oFirstMask = s.i32("offscreen.firstMask");
  const oMaskCount = s.i32("offscreen.maskCount");
  const oMasks: Int32Array[] = [];
  for (let o = 0; o < n.offscreens; o++) {
    const what = () => `offscreen ${o}`;
    c.index(oPart[o]!, 0, n.parts, () => `${what()} owner part`);
    c.check(
      partOffscreen[oPart[o]!] === o,
      () => `${what()}: owner part ${oPart[o]} does not point back to it`,
    );
    c.range(oFirstMask[o]!, oMaskCount[o]!, n.maskEntries, () => `${what()} masks`);
    const mk = masksAll.subarray(oFirstMask[o]!, oFirstMask[o]! + oMaskCount[o]!);
    oMasks.push(Int32Array.from(mk).filter((e) => e !== -1));
  }
  for (let p = 0; p < n.parts; p++) {
    const o = partOffscreen[p]!;
    if (o >= 0) c.check(oPart[o] === p, () => `part ${p}: offscreen ${o} names a different owner`);
  }
  // Every part keyform's offscreen keyform entry is −1 or an offscreen keyform
  // (the official check). Only normal keyforms' entries are read; −1 there gives
  // the offscreen opacity and colors 0. With offscreenKeyformRange "load", an entry
  // out of range reads as −1.
  const partOffscreenKeyform =
    v >= 6
      ? Int32Array.from(s.i32("partKeyform.offscreenKeyform"))
      : new Int32Array(n.partKeyforms).fill(-1);
  const lenientOffscreenKeyforms = options.offscreenKeyformRange === "load";
  for (let k = 0; k < n.partKeyforms; k++) {
    const ok = partOffscreenKeyform[k]!;
    if (lenientOffscreenKeyforms && !(ok >= -1 && ok < n.offscreenKeyforms)) {
      loadWarnings.push(
        `part keyform ${k}: offscreen keyform ${ok} is not −1 or an offscreen keyform; read as −1`,
      );
      partOffscreenKeyform[k] = -1;
      continue;
    }
    c.index(ok, -1, n.offscreenKeyforms, () => `part keyform ${k} offscreen keyform`);
  }
  const offscreenColors =
    v >= 6
      ? v5Colors("offscreenKeyform.multiplyColor", "offscreenKeyform.screenColor")
      : noColors(0);
  if (v >= 6) {
    // Both colors of an owner's offscreen keyform j come from the multiply entry of
    // its first offscreen keyform + j; the screen entries are not read (C5).
    // (A keyform with −1, or an owner whose first keyform has −1, reads no colors.)
    const raw = Int32Array.from(offscreenColors.multiply);
    for (let o = 0; o < n.offscreens; o++) {
      const p = oPart[o]!;
      const firstOk = partOffscreenKeyform[partFirst[p]!]!;
      if (firstOk < 0) continue;
      for (let j = 0; j < partCount[p]!; j++) {
        const ok = partOffscreenKeyform[partFirst[p]! + j]!;
        if (ok < 0) continue;
        offscreenColors.multiply[ok] = raw[firstOk]! + j;
        offscreenColors.screen[ok] = raw[firstOk]! + j;
      }
    }
    checkColors(offscreenColors, "offscreen");
  }

  /** Objects that some blend-shape target record with bindings names (indices not checked yet). */
  const blendShapeTargets = (
    objectKey: "meshTarget.mesh" | "partTarget.part",
    countKey: "meshTarget.bindingCount" | "partTarget.bindingCount",
    objects: number,
    since: number,
  ): Uint8Array => {
    const out = new Uint8Array(objects);
    if (v < since) return out;
    const obj = s.i32(objectKey);
    const cnt = s.i32(countKey);
    for (let t = 0; t < obj.length; t++)
      if (cnt[t]! > 0 && obj[t]! >= 0 && obj[t]! < objects) out[obj[t]!] = 1;
    return out;
  };

  // ---- draw-order groups ----
  const grpFirst = s.i32("group.firstObject");
  const grpCount = s.i32("group.objectCount");
  const objKind = s.i32("groupObject.kind");
  const objIndex = s.i32("groupObject.index");
  const objNested = s.i32("groupObject.nestedGroup");
  const groupObjects: GroupObject[][] = [];
  c.check(n.groups >= 1 || n.meshes === 0, () => "no draw-order groups");
  // Every draw-order object, listed by a group or not: its kind, its
  // index and its child group (−1 allowed here; a listed part needs one, below).
  for (let i = 0; i < n.groupObjects; i++) {
    const kind = objKind[i]!;
    c.check(kind === 0 || kind === 1, () => `draw-order object ${i}: unknown kind ${kind}`);
    c.index(objIndex[i]!, 0, kind === 0 ? n.meshes : n.parts, () => `draw-order object ${i} index`);
    c.index(objNested[i]!, -1, n.groups, () => `draw-order object ${i} child group`);
  }
  for (let g = 0; g < n.groups; g++) {
    c.range(grpFirst[g]!, grpCount[g]!, n.groupObjects, () => `draw-order group ${g} objects`);
    const list: GroupObject[] = [];
    for (let i = grpFirst[g]!; i < grpFirst[g]! + grpCount[g]!; i++) {
      const kind = objKind[i]!;
      c.check(kind === 0 || kind === 1, () => `draw-order object ${i}: unknown kind ${kind}`);
      if (kind === 0) {
        c.index(objIndex[i]!, 0, n.meshes, () => `draw-order object ${i} art mesh`);
        list.push({ kind: 0, index: objIndex[i]!, nestedGroup: -1 });
      } else {
        c.index(objIndex[i]!, 0, n.parts, () => `draw-order object ${i} part`);
        c.index(objNested[i]!, 0, n.groups, () => `draw-order object ${i} nested group`);
        list.push({ kind: 1, index: objIndex[i]!, nestedGroup: objNested[i]! });
      }
    }
    groupObjects.push(list);
  }
  // Every art mesh and offscreen must be reached exactly once from group 0, without cycles.
  if (n.groups > 0) {
    const meshSeen = new Uint8Array(n.meshes);
    const offscreenSeen = new Uint8Array(n.offscreens);
    const groupState = new Uint8Array(n.groups); // 0 new, 1 visiting, 2 done
    const visit = (g: number) => {
      c.check(groupState[g] === 0, () => `draw-order group ${g} is reached twice or forms a cycle`);
      groupState[g] = 1;
      for (const o of groupObjects[g]!) {
        if (o.kind === 0) {
          c.check(
            meshSeen[o.index] === 0,
            () => `art mesh ${o.index} appears in more than one draw-order position`,
          );
          meshSeen[o.index] = 1;
        } else {
          const off = partOffscreen[o.index]!;
          if (off >= 0) {
            c.check(offscreenSeen[off] === 0, () => `offscreen ${off} is reached twice`);
            offscreenSeen[off] = 1;
          }
          visit(o.nestedGroup);
        }
      }
      groupState[g] = 2;
    };
    visit(0);
    // Slot 83 holds each group's total: its drawables plus the offscreens of
    // nested parts, recursively. The runtime trusts it when it assigns render
    // order positions, so reject files where it is wrong (C6).
    const totals = s.i32("group.entryCount");
    const total = (g: number): number => {
      let t = 0;
      for (const o of groupObjects[g]!)
        t += o.kind === 0 ? 1 : (partOffscreen[o.index]! >= 0 ? 1 : 0) + total(o.nestedGroup);
      c.check(
        totals[g] === t,
        () => `draw-order group ${g}: total ${totals[g]} in the file, but it holds ${t} entries`,
      );
      return t;
    };
    total(0);
    // Keyform draw orders should lie in the range of the group that holds the
    // object. Outside it, Mochi2D loads such files, as the official runtime
    // does (C12, C25), with a warning per object, unless strict mode rejects
    // them.
    const gMax = s.i32("group.maxDrawOrder");
    const gMin = s.i32("group.minDrawOrder");
    const meshOrder = s.f32("meshKeyform.drawOrder");
    const partOrder = s.f32("partKeyform.drawOrder");
    const meshFirst = s.i32("mesh.firstKeyform");
    const meshCount = s.i32("mesh.keyformCount");
    const partFirstKf = s.i32("part.firstKeyform");
    const partCountKf = s.i32("part.keyformCount");
    const strict = options.drawOrderRange === "reject";
    // The range holds draw orders as reported: tolerance included, and
    // blend-shape targets clamped at 0.
    const meshTarget = blendShapeTargets("meshTarget.mesh", "meshTarget.bindingCount", n.meshes, 4);
    const partTarget = blendShapeTargets("partTarget.part", "partTarget.bindingCount", n.parts, 5);
    for (let g = 0; g < n.groups; g++)
      for (const o of groupObjects[g]!) {
        const mesh = o.kind === 0;
        const first = (mesh ? meshFirst : partFirstKf)[o.index]!;
        const count = (mesh ? meshCount : partCountKf)[o.index]!;
        const orders = mesh ? meshOrder : partOrder;
        const target = (mesh ? meshTarget : partTarget)[o.index] === 1;
        const outside: number[] = [];
        for (let k = first; k < first + count; k++) {
          const v = orders[k]!;
          const order = keyformDrawOrder(v, target, sections.version);
          if (order >= gMin[g]! && order <= gMax[g]!) continue;
          const what = () =>
            `${mesh ? `art mesh ${mIds[o.index]}` : `part ${partIds[o.index]}`}: keyform draw order ${v} is outside the range [${gMin[g]}, ${gMax[g]}] of draw-order group ${g}`;
          if (strict) c.check(false, what);
          outside.push(v);
        }
        if (outside.length)
          loadWarnings.push(
            `${mesh ? `art mesh ${mIds[o.index]}` : `part ${partIds[o.index]}`}: keyform draw order${outside.length > 1 ? "s" : ""} ${outside.join(", ")} outside the range [${gMin[g]}, ${gMax[g]}] of draw-order group ${g}; drawn by the evaluated value`,
          );
      }
    for (let m = 0; m < n.meshes; m++)
      c.check(meshSeen[m] === 1, () => `art mesh ${m} (${mIds[m]}) is in no draw-order group`);
    for (let o = 0; o < n.offscreens; o++)
      c.check(offscreenSeen[o] === 1, () => `offscreen ${o} is in no draw-order group`);
  }

  // ---- blend shapes (v4+) ----
  const bs = {
    warp: [] as BlendShapeBinding[][],
    mesh: [] as BlendShapeBinding[][],
    part: [] as BlendShapeBinding[][],
    rotation: [] as BlendShapeBinding[][],
    glue: [] as BlendShapeBinding[][],
    offscreen: [] as BlendShapeBinding[][],
  };
  for (let i = 0; i < n.warps; i++) bs.warp.push([]);
  for (let i = 0; i < n.meshes; i++) bs.mesh.push([]);
  for (let i = 0; i < n.parts; i++) bs.part.push([]);
  for (let i = 0; i < n.rotations; i++) bs.rotation.push([]);
  for (let i = 0; i < n.glues; i++) bs.glue.push([]);
  for (let i = 0; i < n.offscreens; i++) bs.offscreen.push([]);
  if (v >= 4) {
    // Owners of blend-shape parameter bindings.
    const bsOwner = new Int32Array(n.bsBindings).fill(-1);
    const pFirstBs = s.i32("parameter.firstBlendShapeBinding");
    const pBsCount = s.i32("parameter.blendShapeBindingCount");
    for (let p = 0; p < n.parameters; p++) {
      c.range(
        pFirstBs[p]!,
        pBsCount[p]!,
        n.bsBindings,
        () => `parameter ${p} (${pIds[p]}) blend-shape bindings`,
      );
      for (let b = pFirstBs[p]!; b < pFirstBs[p]! + pBsCount[p]!; b++) {
        c.check(bsOwner[b] === -1, () => `blend-shape parameter binding ${b} is owned twice`);
        bsOwner[b] = p;
      }
    }
    const bsFirstKey = s.i32("bsBinding.firstKey");
    const bsKeyCount = s.i32("bsBinding.keyCount");
    const bsBase = s.i32("bsBinding.baseKey");
    const bsKeys: Float32Array[] = [];
    for (let b = 0; b < n.bsBindings; b++) {
      c.check(
        bsOwner[b] !== -1,
        () => `blend-shape parameter binding ${b} is not owned by any parameter`,
      );
      bsKeys.push(
        keysAt(bsFirstKey[b]!, bsKeyCount[b]!, () => `blend-shape parameter binding ${b}`),
      );
      c.index(bsBase[b]!, 0, bsKeyCount[b]!, () => `blend-shape parameter binding ${b} base key`);
    }
    // Constraints.
    const conParam = s.i32("constraint.parameter");
    const conFirst = s.i32("constraint.firstValue");
    const conCount = s.i32("constraint.valueCount");
    const cvKey = s.f32("constraintValue.key");
    const cvWeight = s.f32("constraintValue.weight");
    const constraintList: BlendShapeConstraint[] = [];
    for (let k = 0; k < n.constraints; k++) {
      const what = () => `blend-shape constraint ${k}`;
      c.index(conParam[k]!, 0, n.parameters, () => `${what()} parameter`);
      c.range(conFirst[k]!, conCount[k]!, n.constraintValues, () => `${what()} values`);
      c.check(conCount[k]! >= 1, () => `${what()}: no values`);
      const ks = cvKey.slice(conFirst[k]!, conFirst[k]! + conCount[k]!);
      for (let i = 1; i < ks.length; i++)
        c.check(ks[i]! > ks[i - 1]!, () => `${what()}: keys not ascending`);
      constraintList.push({
        parameter: conParam[k]!,
        keys: ks,
        weights: cvWeight.slice(conFirst[k]!, conFirst[k]! + conCount[k]!),
      });
    }
    const conIndex = s.i32("constraintIndex");
    for (let e = 0; e < n.constraintEntries; e++)
      c.index(conIndex[e]!, 0, n.constraints, () => `constraint-index entry ${e}`);
    // Keyform bindings.
    const kbBinding = s.i32("bsKeyformBinding.binding");
    const kbFirst = s.i32("bsKeyformBinding.firstKeyform");
    const kbCount = s.i32("bsKeyformBinding.keyformCount");
    const kbConFirst = s.i32("bsKeyformBinding.firstConstraintEntry");
    const kbConCount = s.i32("bsKeyformBinding.constraintEntryCount");
    const keyformBinding = (
      i: number,
      keyformTotal: number,
      what: () => string,
    ): BlendShapeBinding => {
      c.index(i, 0, n.bsKeyformBindings, what);
      const b = kbBinding[i]!;
      c.index(b, 0, n.bsBindings, () => `${what()} blend-shape parameter binding`);
      c.range(kbFirst[i]!, kbCount[i]!, keyformTotal, () => `${what()} keyforms`);
      c.check(
        kbCount[i] === bsKeys[b]!.length,
        () => `${what()}: ${kbCount[i]} keyforms for ${bsKeys[b]!.length} keys`,
      );
      c.range(kbConFirst[i]!, kbConCount[i]!, n.constraintEntries, () => `${what()} constraints`);
      const constraints: BlendShapeConstraint[] = [];
      for (let e = kbConFirst[i]!; e < kbConFirst[i]! + kbConCount[i]!; e++)
        constraints.push(constraintList[conIndex[e]!]!);
      return {
        parameter: bsOwner[b]!,
        keys: bsKeys[b]!,
        baseKey: bsBase[b]!,
        firstKeyform: kbFirst[i]!,
        constraints,
      };
    };
    const targets = (
      targetKey:
        | "warpTarget"
        | "meshTarget"
        | "partTarget"
        | "rotationTarget"
        | "glueTarget"
        | "offscreenTarget",
      objectField: "warp" | "mesh" | "part" | "rotation" | "glue" | "offscreen",
      count: number,
      objectCount: number,
      keyformTotal: number,
      out: BlendShapeBinding[][],
      after: (object: number, b: BlendShapeBinding, what: () => string) => void,
    ) => {
      const obj = s.i32(`${targetKey}.${objectField}` as never);
      const first = s.i32(`${targetKey}.firstBinding` as never);
      const cnt = s.i32(`${targetKey}.bindingCount` as never);
      for (let t = 0; t < count; t++) {
        const what = () => `${objectField} blend-shape target ${t}`;
        c.index(obj[t]!, 0, objectCount, what);
        c.range(first[t]!, cnt[t]!, n.bsKeyformBindings, () => `${what()} bindings`);
        for (let i = first[t]!; i < first[t]! + cnt[t]!; i++) {
          const b = keyformBinding(i, keyformTotal, () => `${what()} binding ${i}`);
          after(obj[t]!, b, what);
          out[obj[t]!]!.push(b);
        }
      }
    };
    targets(
      "warpTarget",
      "warp",
      s.count(Count.WarpBlendShapeTargets),
      n.warps,
      n.warpKeyforms,
      bs.warp,
      (w, b, what) => {
        for (let k = b.firstKeyform; k < b.firstKeyform + b.keys.length; k++)
          checkPositions(warpFirstPosition, k, 2 * warpPoints[w]!, what);
      },
    );
    targets(
      "meshTarget",
      "mesh",
      s.count(Count.ArtMeshBlendShapeTargets),
      n.meshes,
      n.meshKeyforms,
      bs.mesh,
      (m, b, what) => {
        for (let k = b.firstKeyform; k < b.firstKeyform + b.keys.length; k++)
          checkPositions(meshFirstPosition, k, 2 * mVertexCount[m]!, what);
      },
    );
    if (v >= 5) {
      // A part target's keyforms change its draw order only: their offscreen
      // keyform entries (slot 160) are not read.
      targets(
        "partTarget",
        "part",
        s.count(Count.PartBlendShapeTargets),
        n.parts,
        n.partKeyforms,
        bs.part,
        () => {},
      );
      targets(
        "rotationTarget",
        "rotation",
        s.count(Count.RotationBlendShapeTargets),
        n.rotations,
        n.rotationKeyforms,
        bs.rotation,
        () => {},
      );
      targets(
        "glueTarget",
        "glue",
        s.count(Count.GlueBlendShapeTargets),
        n.glues,
        n.glueKeyforms,
        bs.glue,
        () => {},
      );
    }
    // Offscreen targets (v6, count 37): offscreen opacity and colors receive
    // blend shapes only through them, never through the owner part.
    // Their keyforms lie in the offscreen-keyform array.
    if (v >= 6)
      targets(
        "offscreenTarget",
        "offscreen",
        s.count(Count.OffscreenBlendShapeTargets),
        n.offscreens,
        n.offscreenKeyforms,
        bs.offscreen,
        () => {},
      );
  }

  const rotMirrorX = toU8(s.i32("rotationKeyform.mirrorX"));
  const rotMirrorY = toU8(s.i32("rotationKeyform.mirrorY"));

  // ---- keyform opacities: NaN and ±∞ are rejected unless asked for ----
  if (options.nonFiniteOpacity !== "load")
    for (const [key, what] of [
      ["warpKeyform.opacity", "warp"],
      ["rotationKeyform.opacity", "rotation"],
      ["meshKeyform.opacity", "art-mesh"],
      ["offscreenKeyform.opacity", "offscreen"],
    ] as const) {
      const values = s.f32(key);
      for (let k = 0; k < values.length; k++)
        c.check(
          Number.isFinite(values[k]!),
          () => `${what} keyform ${k} opacity is ${values[k]} (not finite)`,
        );
    }

  return {
    loadWarnings,
    version: v,
    bigEndian: sections.bigEndian,
    canvas: sections.canvas,
    parameters: {
      ids: pIds,
      min: pMin,
      max: pMax,
      defaults: s.f32("parameter.default"),
      repeat: toU8(s.i32("parameter.repeat")),
      type: pType,
      keyLists,
      decimals: Int32Array.from(pDecimals),
    },
    bindings: {
      parameter: bindingParameter,
      keys: bindingKeys,
      epsilon: Float32Array.from(bindingParameter, (p) =>
        p >= 0 ? keyTolerance(pDecimals[p]!) : KEY_EPSILON,
      ),
    },
    bands,
    parts: {
      ids: partIds,
      band: partBand,
      firstKeyform: partFirst,
      initialOpacity: partInitial,
      enabled: partEnabled,
      parent: partParent,
      offscreen: partOffscreen,
    },
    deformers: {
      ids: dIds,
      band: dBand,
      enabled: dEnabled,
      part: dPart,
      parent: dParent,
      kind: dKindU8,
      kindIndex: dKindIndex,
    },
    warps: {
      band: warpBand,
      firstKeyform: warpFirst,
      rows: warpRows,
      columns: warpCols,
      bilinear: warpBilinear,
    },
    rotations: { band: rotBand, firstKeyform: rotFirst, baseAngle: s.f32("rotation.baseAngle") },
    meshes: {
      ids: mIds,
      band: mBand,
      firstKeyform: mFirst,
      enabled: toU8(s.i32("mesh.enabled")),
      part: mPart,
      deformer: mDeformer,
      texture: mTexture,
      flags: mFlags,
      blendMode,
      vertexCount: mVertexCount,
      uvs,
      triangles,
      masks,
    },
    glues: {
      ids: gIds,
      band: gBand,
      firstKeyform: gFirst,
      meshA: gA,
      meshB: gB,
      firstInfo: gFirstInfo,
      vertexA,
      weightA,
      vertexB,
      weightB,
    },
    groups: {
      objects: groupObjects,
      minDrawOrder: s.i32("group.minDrawOrder"),
      maxDrawOrder: s.i32("group.maxDrawOrder"),
      entryCount: s.i32("group.entryCount"),
    },
    offscreens: {
      part: oPart,
      flags: s.u8("offscreen.flags"),
      blendMode: s.i32("offscreen.blendMode"),
      masks: oMasks,
    },
    keyforms: {
      partDrawOrder: s.f32("partKeyform.drawOrder"),
      partOffscreenKeyform,
      warpOpacity: s.f32("warpKeyform.opacity"),
      warpFirstPosition,
      warpColors,
      rotationOpacity: s.f32("rotationKeyform.opacity"),
      rotationAngle: s.f32("rotationKeyform.angle"),
      rotationOriginX: s.f32("rotationKeyform.originX"),
      rotationOriginY: s.f32("rotationKeyform.originY"),
      rotationScale: s.f32("rotationKeyform.scale"),
      rotationMirrorX: rotMirrorX,
      rotationMirrorY: rotMirrorY,
      rotationColors: rotColors,
      meshOpacity: s.f32("meshKeyform.opacity"),
      meshDrawOrder: s.f32("meshKeyform.drawOrder"),
      meshFirstPosition,
      meshColors,
      offscreenOpacity: s.f32("offscreenKeyform.opacity"),
      offscreenColors,
      glueIntensity: s.f32("glueKeyform.intensity"),
    },
    positions: s.f32("positions"),
    multiplyColors,
    screenColors,
    blendShapes: bs,
  };
}

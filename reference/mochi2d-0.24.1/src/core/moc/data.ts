/**
 * `MocData`: the contents of a `.moc3` file as plain, index-based arrays
 * (Mochi2D's public model-data type, docs/moc-data.md). It holds everything a
 * file of versions 1–6 stores. Byte offsets and slot numbers are the
 * writer's business: here, every "first…" field is an element index into
 * the named array, and every "…Count" field is a number of elements.
 *
 * The § labels name groups of Mochi2D's format rules: §1b.4 (canvas), §1b.5
 * (element types and arrays), §1b.6 (the object graph) and §1c (evaluation).
 *
 * Fields that only some file versions have are optional and marked "(v n)":
 * a file of version n or later has them, an earlier one has not. `readMoc`
 * returns exactly the fields of the file's version, and `writeMoc` requires
 * exactly the fields of the version it writes.
 */
import { Count, type FieldKey } from "./schema.js";

/** File versions: 1–6, read and written. */
export type MocVersion = 1 | 2 | 3 | 4 | 5 | 6;

/** The canvas block (§1b.4). Float values are float32 values. */
export interface MocCanvasData {
  /** Canvas pixels per model unit. */
  pixelsPerUnit: number;
  /** The model origin, in canvas pixels from the top-left corner. */
  originX: number;
  originY: number;
  /** Canvas size in pixels. */
  width: number;
  height: number;
  /** Flag byte; bit 0 set: no output conversion (§1b.4). */
  flags: number;
}

/** Parts (count 0, §1b.5 "Parts"; §1c.6). */
export interface MocParts {
  /** Part IDs: UTF-8, at most 63 bytes, no NUL. */
  ids: string[];
  /** Keyform binding (band) index, into `bands` (§1b.6.2–3). */
  band: Int32Array;
  /** First part keyform, into `partKeyforms`. */
  firstKeyform: Int32Array;
  keyformCount: Int32Array;
  /** Initial opacity flag: the part's opacity after loading is 1 if this is 1, else 0. */
  initiallyVisible: Int32Array;
  /** Enabled flag: 0 makes the part inactive (§1c.5). */
  enabled: Int32Array;
  /** Parent part index, −1 = root. */
  parent: Int32Array;
  /** (v6) Offscreen index, into `offscreens`; −1 = none (§1b.6.11). */
  offscreen?: Int32Array;
}

/** Deformers (count 1, §1b.5 "Deformers"; §1c.7). Kind-specific data is in the warp and rotation arrays. */
export interface MocDeformers {
  ids: string[];
  /** Band index; equal to the kind-specific band in all files. */
  band: Int32Array;
  /** "Visible" flag (no observable effect). */
  visible: Int32Array;
  /** Enabled flag: 0 makes the deformer and everything below it inactive. */
  enabled: Int32Array;
  /** Owning part index, −1 = none. */
  part: Int32Array;
  /** Parent deformer index, −1 = root. */
  parent: Int32Array;
  /** 0 = warp, 1 = rotation. */
  kind: Int32Array;
  /** Index into `warpDeformers` (kind 0) or `rotationDeformers` (kind 1). */
  kindIndex: Int32Array;
}

/** Warp deformers (count 2, §1b.5 "Warp deformers"; §1c.8). */
export interface MocWarpDeformers {
  band: Int32Array;
  /** First warp keyform, into `warpKeyforms`. */
  firstKeyform: Int32Array;
  keyformCount: Int32Array;
  /** Grid points: (rows + 1) · (columns + 1). */
  pointCount: Int32Array;
  /** R: cells along v (vertical). */
  rows: Int32Array;
  /** C: cells along u (horizontal). */
  columns: Int32Array;
  /** (v2) Cell interpolation: 0 = two triangles, 1 = bilinear. Version 1 files use triangles. */
  bilinear?: Int32Array;
  /** (v4) First color entry, into `multiplyColors` and `screenColors` (§1b.6.8). */
  firstColor?: Int32Array;
}

/** Rotation deformers (count 3, §1b.5 "Rotation deformers"; §1c.7). */
export interface MocRotationDeformers {
  band: Int32Array;
  /** First rotation keyform, into `rotationKeyforms`. */
  firstKeyform: Int32Array;
  keyformCount: Int32Array;
  /** Base angle in degrees. */
  baseAngle: Float32Array;
  /** (v4) First color entry. */
  firstColor?: Int32Array;
}

/** Art meshes, the drawables (count 4, §1b.5 "Art meshes"; §1c.9). */
export interface MocArtMeshes {
  ids: string[];
  band: Int32Array;
  /** First art-mesh keyform, into `artMeshKeyforms`. */
  firstKeyform: Int32Array;
  keyformCount: Int32Array;
  /** "Visible" flag (no observable effect). */
  visible: Int32Array;
  /** Enabled flag: 0 makes the art mesh inactive. */
  enabled: Int32Array;
  /** Parent part index, −1 = none. */
  part: Int32Array;
  /** Parent deformer index, −1 = none (vertices in model space). */
  deformer: Int32Array;
  /** Texture index into the settings' texture list; never negative. */
  texture: Int32Array;
  /**
   * Drawable flags (§1b.5 "Drawable flag bits"): bit 0 legacy additive,
   * bit 1 legacy multiplicative, bit 2 double-sided, bit 3 inverted mask.
   */
  flags: Uint8Array;
  /** Vertex count V. */
  vertexCount: Int32Array;
  /** First UV float, into `uvs`: 2·V floats (u, v), v stored top-down. */
  firstUv: Int32Array;
  /** First triangle-index entry, into `triangleIndices`. */
  firstTriangleIndex: Int32Array;
  /** Triangle-index entries (3 per triangle). */
  triangleIndexCount: Int32Array;
  /** First mask entry, into `maskEntries`. */
  firstMask: Int32Array;
  maskCount: Int32Array;
  /** (v4) First color entry. */
  firstColor?: Int32Array;
  /** (v6) Blend mode: bits 0–7 color blend code, bits 8–15 alpha blend code (§1b.5 "Blend mode"). */
  blendMode?: Int32Array;
}

/** Parameters (count 5, §1b.5 "Parameters"; §1b.6.1, §1b.6.6). */
export interface MocParameters {
  ids: string[];
  max: Float32Array;
  min: Float32Array;
  defaultValue: Float32Array;
  /** Repeat flag: 1 = cyclic. */
  repeat: Int32Array;
  /** Decimal places (editor display only). */
  decimals: Int32Array;
  /** First parameter binding owned, into `parameterBindings`. */
  firstBinding: Int32Array;
  bindingCount: Int32Array;
  /** (v4) First entry of the parameter's own key list, into `keys`. */
  firstKey?: Int32Array;
  /** (v4) Length of that list. */
  keyCount?: Int32Array;
  /** (v4) 0 = normal, 1 = blend-shape parameter. */
  type?: Int32Array;
  /** (v4) First blend-shape parameter binding owned, into `blendShapeParameterBindings`. */
  firstBlendShapeBinding?: Int32Array;
  /** (v4) Number owned. */
  blendShapeBindingCount?: Int32Array;
}

/** Part keyforms (count 6, §1b.5 "Keyform arrays"). */
export interface MocPartKeyforms {
  drawOrder: Float32Array;
  /**
   * (v6) Offscreen keyform index, into `offscreenKeyforms`, or −1. Only a
   * normal keyform's is read: an offscreen-owning part's normal keyform with
   * −1 gives the offscreen opacity and colors 0. Blend-shape keyforms' are
   * never read (write −1 there; offscreen blend shapes go through
   * `offscreenBlendShapeTargets`). Every entry must be −1 or a valid index.
   */
  offscreenKeyform?: Int32Array;
}

/**
 * Per-keyform color indices (v5, §1b.6.8). For normal keyforms the runtime
 * reads the object's first color entry + the keyform's position instead
 * (C5); genuine files store exactly those values, the same for
 * multiply and screen. Blend-shape keyforms use their own indices.
 */
interface KeyformColorIndices {
  /** (v5) Multiply-color index, into `multiplyColors`. */
  multiplyColor?: Int32Array;
  /** (v5) Screen-color index, into `screenColors`. */
  screenColor?: Int32Array;
}

/** Warp keyforms (count 7). */
export interface MocWarpKeyforms extends KeyformColorIndices {
  opacity: Float32Array;
  /** First position float, into `keyformPositions`: 2·pointCount floats. */
  firstPosition: Int32Array;
}

/** Rotation keyforms (count 8). */
export interface MocRotationKeyforms extends KeyformColorIndices {
  opacity: Float32Array;
  /** Angle in degrees. */
  angle: Float32Array;
  originX: Float32Array;
  originY: Float32Array;
  scale: Float32Array;
  mirrorX: Int32Array;
  mirrorY: Int32Array;
}

/** Art-mesh keyforms (count 9). */
export interface MocArtMeshKeyforms extends KeyformColorIndices {
  opacity: Float32Array;
  drawOrder: Float32Array;
  /** First position float, into `keyformPositions`: 2·V floats. */
  firstPosition: Int32Array;
}

/** Keyform bindings, "bands" (count 12, §1b.6.2): runs of `bindingIndices`. */
export interface MocBands {
  firstEntry: Int32Array;
  entryCount: Int32Array;
}

/** Parameter bindings (count 13): runs of `keys`, ascending. */
export interface MocParameterBindings {
  firstKey: Int32Array;
  keyCount: Int32Array;
}

/** Draw-order groups (count 18, §1b.5; §1c.13). Group 0 is the root. */
export interface MocDrawOrderGroups {
  /** First object, into `drawOrderGroupObjects`. */
  firstObject: Int32Array;
  objectCount: Int32Array;
  /** Render-order entries in the group's subtree: drawables plus offscreens of nested parts (C6). */
  entryCount: Int32Array;
  maxDrawOrder: Int32Array;
  minDrawOrder: Int32Array;
}

/** Draw-order group objects (count 19). */
export interface MocDrawOrderGroupObjects {
  /** 0 = art mesh, 1 = part. */
  kind: Int32Array;
  /** Art-mesh or part index. */
  index: Int32Array;
  /** For a part: the part's own (nested) group; for an art mesh: −1. */
  nestedGroup: Int32Array;
}

/** Glues (count 20, §1b.5 "Glues"; §1c.10). */
export interface MocGlues {
  ids: string[];
  band: Int32Array;
  /** First glue keyform, into `glueKeyforms`. */
  firstKeyform: Int32Array;
  keyformCount: Int32Array;
  artMeshA: Int32Array;
  artMeshB: Int32Array;
  /** First glue-info entry, into `glueInfo`: pairs (vertex of A, then vertex of B). */
  firstInfo: Int32Array;
  /** Glue-info entries, 2 per vertex pair. */
  infoCount: Int32Array;
}

/** Glue-info entries (count 21). */
export interface MocGlueInfo {
  weight: Float32Array;
  vertex: Uint16Array;
}

/** Glue keyforms (count 22). */
export interface MocGlueKeyforms {
  intensity: Float32Array;
}

/** Color entries (v4, counts 23 and 24, §1b.5 "Colors"). */
export interface MocColors {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

/** Blend-shape parameter bindings (v4, count 25, §1b.5 "Blend shapes"; §1c.4). */
export interface MocBlendShapeParameterBindings {
  /** First key value, into `keys`. */
  firstKey: Int32Array;
  keyCount: Int32Array;
  /** Base (neutral) key index, within the binding's keys. */
  baseKey: Int32Array;
}

/** Blend-shape keyform bindings (v4, count 26). */
export interface MocBlendShapeKeyformBindings {
  /** Blend-shape parameter binding index. */
  parameterBinding: Int32Array;
  /** First keyform, in the target kind's keyform array (after its normal keyforms). */
  firstKeyform: Int32Array;
  /** Keyform count (= the binding's key count). */
  keyformCount: Int32Array;
  /** First entry, into `blendShapeConstraintEntries`. */
  firstConstraintEntry: Int32Array;
  constraintEntryCount: Int32Array;
}

/** Blend-shape targets of one object kind (v4: warps and art meshes; v5: parts, rotations, glues). */
export interface MocBlendShapeTargets {
  /** The target object: a warp, art-mesh, part, rotation, glue or offscreen index. */
  object: Int32Array;
  /** First blend-shape keyform binding, into `blendShapeKeyformBindings`. */
  firstBinding: Int32Array;
  bindingCount: Int32Array;
}

/** Blend-shape constraints (v4, count 30). */
export interface MocBlendShapeConstraints {
  /** Parameter index. */
  parameter: Int32Array;
  /** First value entry, into `blendShapeConstraintValues`. */
  firstValue: Int32Array;
  valueCount: Int32Array;
}

/** Blend-shape constraint values (v4, count 31). */
export interface MocBlendShapeConstraintValues {
  key: Float32Array;
  weight: Float32Array;
}

/** Offscreens (v6, count 35, §1b.5 "Offscreens"; §1c.14). */
export interface MocOffscreens {
  /** Owner part index. */
  part: Int32Array;
  /** Flags (the drawable flag bits). */
  flags: Uint8Array;
  /** Blend mode (as for art meshes). */
  blendMode: Int32Array;
  /** First mask entry, into `maskEntries`. */
  firstMask: Int32Array;
  maskCount: Int32Array;
}

/** Offscreen keyforms (v6, count 36). Colors: the owner's first offscreen keyform's multiply index + position (C5). */
export interface MocOffscreenKeyforms {
  opacity: Float32Array;
  multiplyColor: Int32Array;
  screenColor: Int32Array;
}

/** The contents of a `.moc3` file (see the module comment and docs/moc-data.md). */
export interface MocData {
  canvas: MocCanvasData;
  parts: MocParts;
  deformers: MocDeformers;
  warpDeformers: MocWarpDeformers;
  rotationDeformers: MocRotationDeformers;
  artMeshes: MocArtMeshes;
  parameters: MocParameters;
  partKeyforms: MocPartKeyforms;
  warpKeyforms: MocWarpKeyforms;
  rotationKeyforms: MocRotationKeyforms;
  artMeshKeyforms: MocArtMeshKeyforms;
  /** Keyform positions (count 10): x, y pairs. */
  keyformPositions: Float32Array;
  /** Binding-index entries (count 11): parameter-binding indices that `bands` list. */
  bindingIndices: Int32Array;
  bands: MocBands;
  parameterBindings: MocParameterBindings;
  /** Key values (count 14), ascending within each binding. */
  keys: Float32Array;
  /** UVs (count 15). */
  uvs: Float32Array;
  /** Triangle indices (count 16), local to their mesh. */
  triangleIndices: Uint16Array;
  /** Mask entries (count 17): art-mesh indices; −1 entries are ignored. */
  maskEntries: Int32Array;
  drawOrderGroups: MocDrawOrderGroups;
  drawOrderGroupObjects: MocDrawOrderGroupObjects;
  glues: MocGlues;
  glueInfo: MocGlueInfo;
  glueKeyforms: MocGlueKeyforms;
  /** (v4) */
  multiplyColors?: MocColors;
  /** (v4) */
  screenColors?: MocColors;
  /** (v4) */
  blendShapeParameterBindings?: MocBlendShapeParameterBindings;
  /** (v4) */
  blendShapeKeyformBindings?: MocBlendShapeKeyformBindings;
  /** (v4) */
  warpBlendShapeTargets?: MocBlendShapeTargets;
  /** (v4) */
  artMeshBlendShapeTargets?: MocBlendShapeTargets;
  /** (v4) Constraint-index entries (count 29): indices into `blendShapeConstraints`. */
  blendShapeConstraintEntries?: Int32Array;
  /** (v4) */
  blendShapeConstraints?: MocBlendShapeConstraints;
  /** (v4) */
  blendShapeConstraintValues?: MocBlendShapeConstraintValues;
  /** (v5) */
  partBlendShapeTargets?: MocBlendShapeTargets;
  /** (v5) */
  rotationBlendShapeTargets?: MocBlendShapeTargets;
  /**
   * (v5) Glue targets: each binding's keyforms are glue keyforms (intensities)
   * in `glueKeyforms`. Empty in every genuine file studied.
   */
  glueBlendShapeTargets?: MocBlendShapeTargets;
  /** (v6) */
  offscreens?: MocOffscreens;
  /** (v6) */
  offscreenKeyforms?: MocOffscreenKeyforms;
  /**
   * (v6, count 37) Offscreen targets: each binding's keyforms are offscreen
   * keyforms in `offscreenKeyforms`, after the normal ones. They change the
   * offscreen's opacity and colors; a part target changes only the part's
   * draw order.
   */
  offscreenBlendShapeTargets?: MocBlendShapeTargets;
}

/** The array groups of {@link MocData} (everything but the canvas). */
export type MocDataGroup = Exclude<keyof MocData, "canvas">;

/** A group of parallel arrays (`fields`, one element per object) or a single array (`pool`). */
export type GroupLayout =
  { count: Count; fields: Readonly<Record<string, FieldKey>> } | { count: Count; pool: FieldKey };

/**
 * Where each array of {@link MocData} lives in the file: its count-table
 * entry, and the schema field (slot) of each array. The writer and the
 * reader both follow this table; every non-placeholder field of the schema
 * appears exactly once (test/moc-data.test.ts).
 */
export const MOC_DATA_LAYOUT: { readonly [G in MocDataGroup]: GroupLayout } = {
  parts: {
    count: Count.Parts,
    fields: {
      ids: "part.id",
      band: "part.band",
      firstKeyform: "part.firstKeyform",
      keyformCount: "part.keyformCount",
      initiallyVisible: "part.initiallyVisible",
      enabled: "part.enabled",
      parent: "part.parent",
      offscreen: "part.offscreen",
    },
  },
  deformers: {
    count: Count.Deformers,
    fields: {
      ids: "deformer.id",
      band: "deformer.band",
      visible: "deformer.visible",
      enabled: "deformer.enabled",
      part: "deformer.part",
      parent: "deformer.parent",
      kind: "deformer.kind",
      kindIndex: "deformer.kindIndex",
    },
  },
  warpDeformers: {
    count: Count.Warps,
    fields: {
      band: "warp.band",
      firstKeyform: "warp.firstKeyform",
      keyformCount: "warp.keyformCount",
      pointCount: "warp.pointCount",
      rows: "warp.rows",
      columns: "warp.columns",
      bilinear: "warp.bilinear",
      firstColor: "warp.firstColor",
    },
  },
  rotationDeformers: {
    count: Count.Rotations,
    fields: {
      band: "rotation.band",
      firstKeyform: "rotation.firstKeyform",
      keyformCount: "rotation.keyformCount",
      baseAngle: "rotation.baseAngle",
      firstColor: "rotation.firstColor",
    },
  },
  artMeshes: {
    count: Count.ArtMeshes,
    fields: {
      ids: "mesh.id",
      band: "mesh.band",
      firstKeyform: "mesh.firstKeyform",
      keyformCount: "mesh.keyformCount",
      visible: "mesh.visible",
      enabled: "mesh.enabled",
      part: "mesh.part",
      deformer: "mesh.deformer",
      texture: "mesh.texture",
      flags: "mesh.flags",
      vertexCount: "mesh.vertexCount",
      firstUv: "mesh.firstUv",
      firstTriangleIndex: "mesh.firstTriangleIndex",
      triangleIndexCount: "mesh.triangleIndexCount",
      firstMask: "mesh.firstMask",
      maskCount: "mesh.maskCount",
      firstColor: "mesh.firstColor",
      blendMode: "mesh.blendMode",
    },
  },
  parameters: {
    count: Count.Parameters,
    fields: {
      ids: "parameter.id",
      max: "parameter.max",
      min: "parameter.min",
      defaultValue: "parameter.default",
      repeat: "parameter.repeat",
      decimals: "parameter.decimals",
      firstBinding: "parameter.firstBinding",
      bindingCount: "parameter.bindingCount",
      firstKey: "parameter.firstKey",
      keyCount: "parameter.keyCount",
      type: "parameter.type",
      firstBlendShapeBinding: "parameter.firstBlendShapeBinding",
      blendShapeBindingCount: "parameter.blendShapeBindingCount",
    },
  },
  partKeyforms: {
    count: Count.PartKeyforms,
    fields: {
      drawOrder: "partKeyform.drawOrder",
      offscreenKeyform: "partKeyform.offscreenKeyform",
    },
  },
  warpKeyforms: {
    count: Count.WarpKeyforms,
    fields: {
      opacity: "warpKeyform.opacity",
      firstPosition: "warpKeyform.firstPosition",
      multiplyColor: "warpKeyform.multiplyColor",
      screenColor: "warpKeyform.screenColor",
    },
  },
  rotationKeyforms: {
    count: Count.RotationKeyforms,
    fields: {
      opacity: "rotationKeyform.opacity",
      angle: "rotationKeyform.angle",
      originX: "rotationKeyform.originX",
      originY: "rotationKeyform.originY",
      scale: "rotationKeyform.scale",
      mirrorX: "rotationKeyform.mirrorX",
      mirrorY: "rotationKeyform.mirrorY",
      multiplyColor: "rotationKeyform.multiplyColor",
      screenColor: "rotationKeyform.screenColor",
    },
  },
  artMeshKeyforms: {
    count: Count.ArtMeshKeyforms,
    fields: {
      opacity: "meshKeyform.opacity",
      drawOrder: "meshKeyform.drawOrder",
      firstPosition: "meshKeyform.firstPosition",
      multiplyColor: "meshKeyform.multiplyColor",
      screenColor: "meshKeyform.screenColor",
    },
  },
  keyformPositions: { count: Count.PositionFloats, pool: "positions" },
  bindingIndices: { count: Count.BindingIndexEntries, pool: "bindingIndex" },
  bands: {
    count: Count.Bands,
    fields: { firstEntry: "band.firstEntry", entryCount: "band.entryCount" },
  },
  parameterBindings: {
    count: Count.ParameterBindings,
    fields: { firstKey: "binding.firstKey", keyCount: "binding.keyCount" },
  },
  keys: { count: Count.KeyValues, pool: "keys" },
  uvs: { count: Count.UvFloats, pool: "uvs" },
  triangleIndices: { count: Count.TriangleIndexEntries, pool: "triangleIndices" },
  maskEntries: { count: Count.MaskEntries, pool: "maskEntries" },
  drawOrderGroups: {
    count: Count.DrawOrderGroups,
    fields: {
      firstObject: "group.firstObject",
      objectCount: "group.objectCount",
      entryCount: "group.entryCount",
      maxDrawOrder: "group.maxDrawOrder",
      minDrawOrder: "group.minDrawOrder",
    },
  },
  drawOrderGroupObjects: {
    count: Count.DrawOrderGroupObjects,
    fields: {
      kind: "groupObject.kind",
      index: "groupObject.index",
      nestedGroup: "groupObject.nestedGroup",
    },
  },
  glues: {
    count: Count.Glues,
    fields: {
      ids: "glue.id",
      band: "glue.band",
      firstKeyform: "glue.firstKeyform",
      keyformCount: "glue.keyformCount",
      artMeshA: "glue.meshA",
      artMeshB: "glue.meshB",
      firstInfo: "glue.firstInfo",
      infoCount: "glue.infoCount",
    },
  },
  glueInfo: {
    count: Count.GlueInfoEntries,
    fields: { weight: "glueInfo.weight", vertex: "glueInfo.vertex" },
  },
  glueKeyforms: { count: Count.GlueKeyforms, fields: { intensity: "glueKeyform.intensity" } },
  multiplyColors: {
    count: Count.MultiplyColors,
    fields: { r: "multiplyColor.r", g: "multiplyColor.g", b: "multiplyColor.b" },
  },
  screenColors: {
    count: Count.ScreenColors,
    fields: { r: "screenColor.r", g: "screenColor.g", b: "screenColor.b" },
  },
  blendShapeParameterBindings: {
    count: Count.BlendShapeParameterBindings,
    fields: {
      firstKey: "bsBinding.firstKey",
      keyCount: "bsBinding.keyCount",
      baseKey: "bsBinding.baseKey",
    },
  },
  blendShapeKeyformBindings: {
    count: Count.BlendShapeKeyformBindings,
    fields: {
      parameterBinding: "bsKeyformBinding.binding",
      firstKeyform: "bsKeyformBinding.firstKeyform",
      keyformCount: "bsKeyformBinding.keyformCount",
      firstConstraintEntry: "bsKeyformBinding.firstConstraintEntry",
      constraintEntryCount: "bsKeyformBinding.constraintEntryCount",
    },
  },
  warpBlendShapeTargets: {
    count: Count.WarpBlendShapeTargets,
    fields: {
      object: "warpTarget.warp",
      firstBinding: "warpTarget.firstBinding",
      bindingCount: "warpTarget.bindingCount",
    },
  },
  artMeshBlendShapeTargets: {
    count: Count.ArtMeshBlendShapeTargets,
    fields: {
      object: "meshTarget.mesh",
      firstBinding: "meshTarget.firstBinding",
      bindingCount: "meshTarget.bindingCount",
    },
  },
  blendShapeConstraintEntries: {
    count: Count.BlendShapeConstraintIndexEntries,
    pool: "constraintIndex",
  },
  blendShapeConstraints: {
    count: Count.BlendShapeConstraints,
    fields: {
      parameter: "constraint.parameter",
      firstValue: "constraint.firstValue",
      valueCount: "constraint.valueCount",
    },
  },
  blendShapeConstraintValues: {
    count: Count.BlendShapeConstraintValues,
    fields: { key: "constraintValue.key", weight: "constraintValue.weight" },
  },
  partBlendShapeTargets: {
    count: Count.PartBlendShapeTargets,
    fields: {
      object: "partTarget.part",
      firstBinding: "partTarget.firstBinding",
      bindingCount: "partTarget.bindingCount",
    },
  },
  rotationBlendShapeTargets: {
    count: Count.RotationBlendShapeTargets,
    fields: {
      object: "rotationTarget.rotation",
      firstBinding: "rotationTarget.firstBinding",
      bindingCount: "rotationTarget.bindingCount",
    },
  },
  glueBlendShapeTargets: {
    count: Count.GlueBlendShapeTargets,
    fields: {
      object: "glueTarget.glue",
      firstBinding: "glueTarget.firstBinding",
      bindingCount: "glueTarget.bindingCount",
    },
  },
  offscreens: {
    count: Count.Offscreens,
    fields: {
      part: "offscreen.part",
      flags: "offscreen.flags",
      blendMode: "offscreen.blendMode",
      firstMask: "offscreen.firstMask",
      maskCount: "offscreen.maskCount",
    },
  },
  offscreenKeyforms: {
    count: Count.OffscreenKeyforms,
    fields: {
      opacity: "offscreenKeyform.opacity",
      multiplyColor: "offscreenKeyform.multiplyColor",
      screenColor: "offscreenKeyform.screenColor",
    },
  },
  offscreenBlendShapeTargets: {
    count: Count.OffscreenBlendShapeTargets,
    fields: {
      object: "offscreenTarget.offscreen",
      firstBinding: "offscreenTarget.firstBinding",
      bindingCount: "offscreenTarget.bindingCount",
    },
  },
};

/** The groups of {@link MocData}, in file (count-table) order. */
export const MOC_DATA_GROUPS = (Object.keys(MOC_DATA_LAYOUT) as MocDataGroup[]).sort(
  (a, b) => MOC_DATA_LAYOUT[a].count - MOC_DATA_LAYOUT[b].count,
);

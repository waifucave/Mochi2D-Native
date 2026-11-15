/**
 * Declarative description of the `.moc3` binary layout (§1b).
 *
 * The file has a fixed header, an offset table of "slots" (absolute byte
 * offsets) and a table of element counts. Every array lives at the offset
 * given by its slot and has the element count of its group's count entry.
 * Both the reader and the test writer are driven by these tables.
 */

/** Lowest and highest file versions accepted. */
export const MIN_VERSION = 1;
export const MAX_VERSION = 6;

export const HEADER_SIZE = 0x40;
export const MAGIC = "MOC3";

/** Number of offset-table slots: 480 for v1–v5, 1440 for v6. */
export function slotTableLength(version: number): number {
  return version >= 6 ? 1440 : 480;
}

/** Highest slot read by each version (slots past it are unused). */
export function lastSlotUsed(version: number): number {
  switch (version) {
    case 1:
      return 100;
    case 2:
    case 3:
      return 101;
    case 4:
      return 136;
    case 5:
      return 151;
    default:
      return 166;
  }
}

/** Number of count-table entries: 32 for v1–v4, 64 for v5–v6. */
export function countTableLength(version: number): number {
  return version >= 5 ? 64 : 32;
}

/** Count-table indices (§1b.3). */
export const Count = {
  Parts: 0,
  Deformers: 1,
  Warps: 2,
  Rotations: 3,
  ArtMeshes: 4,
  Parameters: 5,
  PartKeyforms: 6,
  WarpKeyforms: 7,
  RotationKeyforms: 8,
  ArtMeshKeyforms: 9,
  PositionFloats: 10,
  BindingIndexEntries: 11,
  Bands: 12,
  ParameterBindings: 13,
  KeyValues: 14,
  UvFloats: 15,
  TriangleIndexEntries: 16,
  MaskEntries: 17,
  DrawOrderGroups: 18,
  DrawOrderGroupObjects: 19,
  Glues: 20,
  GlueInfoEntries: 21,
  GlueKeyforms: 22,
  MultiplyColors: 23,
  ScreenColors: 24,
  BlendShapeParameterBindings: 25,
  BlendShapeKeyformBindings: 26,
  WarpBlendShapeTargets: 27,
  ArtMeshBlendShapeTargets: 28,
  BlendShapeConstraintIndexEntries: 29,
  BlendShapeConstraints: 30,
  BlendShapeConstraintValues: 31,
  PartBlendShapeTargets: 32,
  RotationBlendShapeTargets: 33,
  GlueBlendShapeTargets: 34,
  Offscreens: 35,
  OffscreenKeyforms: 36,
  OffscreenBlendShapeTargets: 37,
} as const;
export type Count = (typeof Count)[keyof typeof Count];

/** File version that introduced each count entry. */
export function countSince(index: number): number {
  if (index <= 22) return 1;
  if (index <= 31) return 4;
  if (index <= 34) return 5;
  if (index <= 37) return 6;
  return Number.POSITIVE_INFINITY;
}

export const COUNT_NAMES: Record<number, string> = {
  0: "parts",
  1: "deformers",
  2: "warp deformers",
  3: "rotation deformers",
  4: "art meshes",
  5: "parameters",
  6: "part keyforms",
  7: "warp keyforms",
  8: "rotation keyforms",
  9: "art-mesh keyforms",
  10: "keyform position floats",
  11: "binding-index entries",
  12: "keyform bindings",
  13: "parameter bindings",
  14: "key values",
  15: "UV floats",
  16: "triangle-index entries",
  17: "mask entries",
  18: "draw-order groups",
  19: "draw-order group objects",
  20: "glues",
  21: "glue-info entries",
  22: "glue keyforms",
  23: "multiply-color entries",
  24: "screen-color entries",
  25: "blend-shape parameter bindings",
  26: "blend-shape keyform bindings",
  27: "warp blend-shape targets",
  28: "art-mesh blend-shape targets",
  29: "blend-shape constraint-index entries",
  30: "blend-shape constraints",
  31: "blend-shape constraint values",
  32: "part blend-shape targets",
  33: "rotation blend-shape targets",
  34: "glue blend-shape targets",
  35: "offscreens",
  36: "offscreen keyforms",
  37: "unknown v6 group",
};

export type ElementType = "name" | "placeholder" | "i32" | "f32" | "u16" | "u8";

export const ELEMENT_SIZE: Record<ElementType, number> = {
  name: 64,
  placeholder: 8,
  i32: 4,
  f32: 4,
  u16: 2,
  u8: 1,
};

/**
 * Every array of §1b.5 as [key, slot, element type, count index, first version].
 * Keys are Mochi2D names (`<group>.<field>`). Placeholder arrays are listed
 * so their sections are bounds-checked; their contents are ignored.
 */
const FIELD_TABLE = [
  // Parts
  ["part.reserved", 2, "placeholder", Count.Parts],
  ["part.id", 3, "name", Count.Parts],
  ["part.band", 4, "i32", Count.Parts],
  ["part.firstKeyform", 5, "i32", Count.Parts],
  ["part.keyformCount", 6, "i32", Count.Parts],
  ["part.initiallyVisible", 7, "i32", Count.Parts],
  ["part.enabled", 8, "i32", Count.Parts],
  ["part.parent", 9, "i32", Count.Parts],
  ["part.offscreen", 152, "i32", Count.Parts, 6],
  // Deformers
  ["deformer.reserved", 10, "placeholder", Count.Deformers],
  ["deformer.id", 11, "name", Count.Deformers],
  ["deformer.band", 12, "i32", Count.Deformers],
  ["deformer.visible", 13, "i32", Count.Deformers],
  ["deformer.enabled", 14, "i32", Count.Deformers],
  ["deformer.part", 15, "i32", Count.Deformers],
  ["deformer.parent", 16, "i32", Count.Deformers],
  ["deformer.kind", 17, "i32", Count.Deformers],
  ["deformer.kindIndex", 18, "i32", Count.Deformers],
  // Warp deformers
  ["warp.band", 19, "i32", Count.Warps],
  ["warp.firstKeyform", 20, "i32", Count.Warps],
  ["warp.keyformCount", 21, "i32", Count.Warps],
  ["warp.pointCount", 22, "i32", Count.Warps],
  ["warp.rows", 23, "i32", Count.Warps],
  ["warp.columns", 24, "i32", Count.Warps],
  ["warp.bilinear", 101, "i32", Count.Warps, 2],
  ["warp.firstColor", 105, "i32", Count.Warps, 4],
  // Rotation deformers
  ["rotation.band", 25, "i32", Count.Rotations],
  ["rotation.firstKeyform", 26, "i32", Count.Rotations],
  ["rotation.keyformCount", 27, "i32", Count.Rotations],
  ["rotation.baseAngle", 28, "f32", Count.Rotations],
  ["rotation.firstColor", 106, "i32", Count.Rotations, 4],
  // Art meshes
  ["mesh.reserved0", 29, "placeholder", Count.ArtMeshes],
  ["mesh.reserved1", 30, "placeholder", Count.ArtMeshes],
  ["mesh.reserved2", 31, "placeholder", Count.ArtMeshes],
  ["mesh.reserved3", 32, "placeholder", Count.ArtMeshes],
  ["mesh.id", 33, "name", Count.ArtMeshes],
  ["mesh.band", 34, "i32", Count.ArtMeshes],
  ["mesh.firstKeyform", 35, "i32", Count.ArtMeshes],
  ["mesh.keyformCount", 36, "i32", Count.ArtMeshes],
  ["mesh.visible", 37, "i32", Count.ArtMeshes],
  ["mesh.enabled", 38, "i32", Count.ArtMeshes],
  ["mesh.part", 39, "i32", Count.ArtMeshes],
  ["mesh.deformer", 40, "i32", Count.ArtMeshes],
  ["mesh.texture", 41, "i32", Count.ArtMeshes],
  ["mesh.flags", 42, "u8", Count.ArtMeshes],
  ["mesh.vertexCount", 43, "i32", Count.ArtMeshes],
  ["mesh.firstUv", 44, "i32", Count.ArtMeshes],
  ["mesh.firstTriangleIndex", 45, "i32", Count.ArtMeshes],
  ["mesh.triangleIndexCount", 46, "i32", Count.ArtMeshes],
  ["mesh.firstMask", 47, "i32", Count.ArtMeshes],
  ["mesh.maskCount", 48, "i32", Count.ArtMeshes],
  ["mesh.firstColor", 107, "i32", Count.ArtMeshes, 4],
  ["mesh.blendMode", 153, "i32", Count.ArtMeshes, 6],
  // Parameters
  ["parameter.reserved", 49, "placeholder", Count.Parameters],
  ["parameter.id", 50, "name", Count.Parameters],
  ["parameter.max", 51, "f32", Count.Parameters],
  ["parameter.min", 52, "f32", Count.Parameters],
  ["parameter.default", 53, "f32", Count.Parameters],
  ["parameter.repeat", 54, "i32", Count.Parameters],
  ["parameter.decimals", 55, "i32", Count.Parameters],
  ["parameter.firstBinding", 56, "i32", Count.Parameters],
  ["parameter.bindingCount", 57, "i32", Count.Parameters],
  ["parameter.reserved4", 102, "placeholder", Count.Parameters, 4],
  ["parameter.firstKey", 103, "i32", Count.Parameters, 4],
  ["parameter.keyCount", 104, "i32", Count.Parameters, 4],
  ["parameter.type", 114, "i32", Count.Parameters, 4],
  ["parameter.firstBlendShapeBinding", 115, "i32", Count.Parameters, 4],
  ["parameter.blendShapeBindingCount", 116, "i32", Count.Parameters, 4],
  // Keyforms
  ["partKeyform.drawOrder", 58, "f32", Count.PartKeyforms],
  ["partKeyform.offscreenKeyform", 160, "i32", Count.PartKeyforms, 6],
  ["warpKeyform.opacity", 59, "f32", Count.WarpKeyforms],
  ["warpKeyform.firstPosition", 60, "i32", Count.WarpKeyforms],
  ["warpKeyform.multiplyColor", 137, "i32", Count.WarpKeyforms, 5],
  ["warpKeyform.screenColor", 138, "i32", Count.WarpKeyforms, 5],
  ["rotationKeyform.opacity", 61, "f32", Count.RotationKeyforms],
  ["rotationKeyform.angle", 62, "f32", Count.RotationKeyforms],
  ["rotationKeyform.originX", 63, "f32", Count.RotationKeyforms],
  ["rotationKeyform.originY", 64, "f32", Count.RotationKeyforms],
  ["rotationKeyform.scale", 65, "f32", Count.RotationKeyforms],
  ["rotationKeyform.mirrorX", 66, "i32", Count.RotationKeyforms],
  ["rotationKeyform.mirrorY", 67, "i32", Count.RotationKeyforms],
  ["rotationKeyform.multiplyColor", 139, "i32", Count.RotationKeyforms, 5],
  ["rotationKeyform.screenColor", 140, "i32", Count.RotationKeyforms, 5],
  ["meshKeyform.opacity", 68, "f32", Count.ArtMeshKeyforms],
  ["meshKeyform.drawOrder", 69, "f32", Count.ArtMeshKeyforms],
  ["meshKeyform.firstPosition", 70, "i32", Count.ArtMeshKeyforms],
  ["meshKeyform.multiplyColor", 141, "i32", Count.ArtMeshKeyforms, 5],
  ["meshKeyform.screenColor", 142, "i32", Count.ArtMeshKeyforms, 5],
  ["offscreenKeyform.opacity", 161, "f32", Count.OffscreenKeyforms, 6],
  ["offscreenKeyform.multiplyColor", 162, "i32", Count.OffscreenKeyforms, 6],
  ["offscreenKeyform.screenColor", 163, "i32", Count.OffscreenKeyforms, 6],
  ["glueKeyform.intensity", 100, "f32", Count.GlueKeyforms],
  // Shared pools and bindings
  ["positions", 71, "f32", Count.PositionFloats],
  ["bindingIndex", 72, "i32", Count.BindingIndexEntries],
  ["band.firstEntry", 73, "i32", Count.Bands],
  ["band.entryCount", 74, "i32", Count.Bands],
  ["binding.firstKey", 75, "i32", Count.ParameterBindings],
  ["binding.keyCount", 76, "i32", Count.ParameterBindings],
  ["keys", 77, "f32", Count.KeyValues],
  ["uvs", 78, "f32", Count.UvFloats],
  ["triangleIndices", 79, "u16", Count.TriangleIndexEntries],
  ["maskEntries", 80, "i32", Count.MaskEntries],
  // Draw-order groups
  ["group.firstObject", 81, "i32", Count.DrawOrderGroups],
  ["group.objectCount", 82, "i32", Count.DrawOrderGroups],
  ["group.entryCount", 83, "i32", Count.DrawOrderGroups],
  ["group.maxDrawOrder", 84, "i32", Count.DrawOrderGroups],
  ["group.minDrawOrder", 85, "i32", Count.DrawOrderGroups],
  ["groupObject.kind", 86, "i32", Count.DrawOrderGroupObjects],
  ["groupObject.index", 87, "i32", Count.DrawOrderGroupObjects],
  ["groupObject.nestedGroup", 88, "i32", Count.DrawOrderGroupObjects],
  // Glues
  ["glue.reserved", 89, "placeholder", Count.Glues],
  ["glue.id", 90, "name", Count.Glues],
  ["glue.band", 91, "i32", Count.Glues],
  ["glue.firstKeyform", 92, "i32", Count.Glues],
  ["glue.keyformCount", 93, "i32", Count.Glues],
  ["glue.meshA", 94, "i32", Count.Glues],
  ["glue.meshB", 95, "i32", Count.Glues],
  ["glue.firstInfo", 96, "i32", Count.Glues],
  ["glue.infoCount", 97, "i32", Count.Glues],
  ["glueInfo.weight", 98, "f32", Count.GlueInfoEntries],
  ["glueInfo.vertex", 99, "u16", Count.GlueInfoEntries],
  // Colors (v4)
  ["multiplyColor.r", 108, "f32", Count.MultiplyColors, 4],
  ["multiplyColor.g", 109, "f32", Count.MultiplyColors, 4],
  ["multiplyColor.b", 110, "f32", Count.MultiplyColors, 4],
  ["screenColor.r", 111, "f32", Count.ScreenColors, 4],
  ["screenColor.g", 112, "f32", Count.ScreenColors, 4],
  ["screenColor.b", 113, "f32", Count.ScreenColors, 4],
  // Blend shapes (v4, v5)
  ["bsBinding.firstKey", 117, "i32", Count.BlendShapeParameterBindings, 4],
  ["bsBinding.keyCount", 118, "i32", Count.BlendShapeParameterBindings, 4],
  ["bsBinding.baseKey", 119, "i32", Count.BlendShapeParameterBindings, 4],
  ["bsKeyformBinding.binding", 120, "i32", Count.BlendShapeKeyformBindings, 4],
  ["bsKeyformBinding.firstKeyform", 121, "i32", Count.BlendShapeKeyformBindings, 4],
  ["bsKeyformBinding.keyformCount", 122, "i32", Count.BlendShapeKeyformBindings, 4],
  ["bsKeyformBinding.firstConstraintEntry", 123, "i32", Count.BlendShapeKeyformBindings, 4],
  ["bsKeyformBinding.constraintEntryCount", 124, "i32", Count.BlendShapeKeyformBindings, 4],
  ["warpTarget.warp", 125, "i32", Count.WarpBlendShapeTargets, 4],
  ["warpTarget.firstBinding", 126, "i32", Count.WarpBlendShapeTargets, 4],
  ["warpTarget.bindingCount", 127, "i32", Count.WarpBlendShapeTargets, 4],
  ["meshTarget.mesh", 128, "i32", Count.ArtMeshBlendShapeTargets, 4],
  ["meshTarget.firstBinding", 129, "i32", Count.ArtMeshBlendShapeTargets, 4],
  ["meshTarget.bindingCount", 130, "i32", Count.ArtMeshBlendShapeTargets, 4],
  ["constraintIndex", 131, "i32", Count.BlendShapeConstraintIndexEntries, 4],
  ["constraint.parameter", 132, "i32", Count.BlendShapeConstraints, 4],
  ["constraint.firstValue", 133, "i32", Count.BlendShapeConstraints, 4],
  ["constraint.valueCount", 134, "i32", Count.BlendShapeConstraints, 4],
  ["constraintValue.key", 135, "f32", Count.BlendShapeConstraintValues, 4],
  ["constraintValue.weight", 136, "f32", Count.BlendShapeConstraintValues, 4],
  ["partTarget.part", 143, "i32", Count.PartBlendShapeTargets, 5],
  ["partTarget.firstBinding", 144, "i32", Count.PartBlendShapeTargets, 5],
  ["partTarget.bindingCount", 145, "i32", Count.PartBlendShapeTargets, 5],
  ["rotationTarget.rotation", 146, "i32", Count.RotationBlendShapeTargets, 5],
  ["rotationTarget.firstBinding", 147, "i32", Count.RotationBlendShapeTargets, 5],
  ["rotationTarget.bindingCount", 148, "i32", Count.RotationBlendShapeTargets, 5],
  ["glueTarget.glue", 149, "i32", Count.GlueBlendShapeTargets, 5],
  ["glueTarget.firstBinding", 150, "i32", Count.GlueBlendShapeTargets, 5],
  ["glueTarget.bindingCount", 151, "i32", Count.GlueBlendShapeTargets, 5],
  // Offscreens (v6)
  ["offscreen.reserved", 154, "placeholder", Count.Offscreens, 6],
  ["offscreen.part", 155, "i32", Count.Offscreens, 6],
  ["offscreen.flags", 156, "u8", Count.Offscreens, 6],
  ["offscreen.blendMode", 157, "i32", Count.Offscreens, 6],
  ["offscreen.firstMask", 158, "i32", Count.Offscreens, 6],
  ["offscreen.maskCount", 159, "i32", Count.Offscreens, 6],
  // Offscreen blend-shape targets (v6): their keyforms are offscreen keyforms.
  ["offscreenTarget.offscreen", 164, "i32", Count.OffscreenBlendShapeTargets, 6],
  ["offscreenTarget.firstBinding", 165, "i32", Count.OffscreenBlendShapeTargets, 6],
  ["offscreenTarget.bindingCount", 166, "i32", Count.OffscreenBlendShapeTargets, 6],
] as const;

export type FieldKey = (typeof FIELD_TABLE)[number][0];

export interface FieldSpec {
  /** Key under which the reader stores the array. */
  key: FieldKey;
  slot: number;
  type: ElementType;
  /** Count-table index giving the element count. */
  count: Count;
  /** First file version that has this slot. */
  since: number;
}

export const FIELDS: readonly FieldSpec[] = FIELD_TABLE.map((row) => ({
  key: row[0],
  slot: row[1],
  type: row[2],
  count: row[3],
  since: row.length > 4 ? ((row as readonly unknown[])[4] as number) : 1,
}));

/** Slot 0 holds the count table, slot 1 the canvas block. */
export const COUNT_TABLE_SLOT = 0;
export const CANVAS_SLOT = 1;
export const CANVAS_BLOCK_SIZE = 64;

/** Fields present in a given file version. */
export function fieldsForVersion(version: number): FieldSpec[] {
  return FIELDS.filter((fs) => fs.since <= version);
}

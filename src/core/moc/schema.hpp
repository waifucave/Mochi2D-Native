// The `.moc3` binary layout (port of Mochi2D's src/core/moc/schema.ts and the
// MocData layout of data.ts): the header, the offset table of slots, the
// count table, and every array as (slot, element type, count entry, first
// version), with the MocData group and field it belongs to.
#pragma once

#include <cstddef>
#include <cstdint>

namespace mochi2d::moc {

constexpr int kMinVersion = 1;
constexpr int kMaxVersion = 6;
constexpr std::size_t kHeaderSize = 0x40;
constexpr int kCountTableSlot = 0;
constexpr int kCanvasSlot = 1;
constexpr std::size_t kCanvasBlockSize = 64;

/** Offset-table slots: 480 for v1–v5, 1440 for v6. */
constexpr int slot_table_length(int version) { return version >= 6 ? 1440 : 480; }
/** Count-table entries: 32 for v1–v4, 64 for v5–v6. */
constexpr int count_table_length(int version) { return version >= 5 ? 64 : 32; }

/** Count-table indices (§1b.3). */
enum Count : int {
  kParts = 0,
  kDeformers = 1,
  kWarps = 2,
  kRotations = 3,
  kArtMeshes = 4,
  kParameters = 5,
  kPartKeyforms = 6,
  kWarpKeyforms = 7,
  kRotationKeyforms = 8,
  kArtMeshKeyforms = 9,
  kPositionFloats = 10,
  kBindingIndexEntries = 11,
  kBands = 12,
  kParameterBindings = 13,
  kKeyValues = 14,
  kUvFloats = 15,
  kTriangleIndexEntries = 16,
  kMaskEntries = 17,
  kDrawOrderGroups = 18,
  kDrawOrderGroupObjects = 19,
  kGlues = 20,
  kGlueInfoEntries = 21,
  kGlueKeyforms = 22,
  kMultiplyColors = 23,
  kScreenColors = 24,
  kBlendShapeParameterBindings = 25,
  kBlendShapeKeyformBindings = 26,
  kWarpBlendShapeTargets = 27,
  kArtMeshBlendShapeTargets = 28,
  kBlendShapeConstraintIndexEntries = 29,
  kBlendShapeConstraints = 30,
  kBlendShapeConstraintValues = 31,
  kPartBlendShapeTargets = 32,
  kRotationBlendShapeTargets = 33,
  kGlueBlendShapeTargets = 34,
  kOffscreens = 35,
  kOffscreenKeyforms = 36,
  kOffscreenBlendShapeTargets = 37,
  kCountKinds = 38,
};

/** File version that introduced a count entry (unbounded past 37). */
constexpr int count_since(int index) {
  return index <= 22 ? 1 : index <= 31 ? 4 : index <= 34 ? 5 : index <= 37 ? 6 : 1000;
}

/** Human-readable name of a count entry (for messages). */
const char* count_name(int index);

enum class ElementType : uint8_t { Name, Placeholder, I32, F32, U16, U8 };

constexpr std::size_t element_size(ElementType t) {
  switch (t) {
    case ElementType::Name: return 64;
    case ElementType::Placeholder: return 8;
    case ElementType::I32:
    case ElementType::F32: return 4;
    case ElementType::U16: return 2;
    case ElementType::U8: return 1;
  }
  return 0;
}

/**
 * Every array of §1b.5: X(id, key, slot, type, count, since, group, field).
 * `group` and `field` name it in MocData (docs/moc-data.md); pools have no
 * field, and placeholder arrays belong to no group of the data.
 */
#define MOCHI2D_MOC_FIELDS(X)                                                                         \
  X(part_reserved, "part.reserved", 2, Placeholder, kParts, 1, nullptr, nullptr)                      \
  X(part_id, "part.id", 3, Name, kParts, 1, "parts", "ids")                                           \
  X(part_band, "part.band", 4, I32, kParts, 1, "parts", "band")                                       \
  X(part_firstKeyform, "part.firstKeyform", 5, I32, kParts, 1, "parts", "firstKeyform")               \
  X(part_keyformCount, "part.keyformCount", 6, I32, kParts, 1, "parts", "keyformCount")               \
  X(part_initiallyVisible, "part.initiallyVisible", 7, I32, kParts, 1, "parts", "initiallyVisible")   \
  X(part_enabled, "part.enabled", 8, I32, kParts, 1, "parts", "enabled")                              \
  X(part_parent, "part.parent", 9, I32, kParts, 1, "parts", "parent")                                 \
  X(part_offscreen, "part.offscreen", 152, I32, kParts, 6, "parts", "offscreen")                      \
  X(deformer_reserved, "deformer.reserved", 10, Placeholder, kDeformers, 1, nullptr, nullptr)         \
  X(deformer_id, "deformer.id", 11, Name, kDeformers, 1, "deformers", "ids")                          \
  X(deformer_band, "deformer.band", 12, I32, kDeformers, 1, "deformers", "band")                      \
  X(deformer_visible, "deformer.visible", 13, I32, kDeformers, 1, "deformers", "visible")             \
  X(deformer_enabled, "deformer.enabled", 14, I32, kDeformers, 1, "deformers", "enabled")             \
  X(deformer_part, "deformer.part", 15, I32, kDeformers, 1, "deformers", "part")                      \
  X(deformer_parent, "deformer.parent", 16, I32, kDeformers, 1, "deformers", "parent")                \
  X(deformer_kind, "deformer.kind", 17, I32, kDeformers, 1, "deformers", "kind")                      \
  X(deformer_kindIndex, "deformer.kindIndex", 18, I32, kDeformers, 1, "deformers", "kindIndex")       \
  X(warp_band, "warp.band", 19, I32, kWarps, 1, "warpDeformers", "band")                              \
  X(warp_firstKeyform, "warp.firstKeyform", 20, I32, kWarps, 1, "warpDeformers", "firstKeyform")      \
  X(warp_keyformCount, "warp.keyformCount", 21, I32, kWarps, 1, "warpDeformers", "keyformCount")      \
  X(warp_pointCount, "warp.pointCount", 22, I32, kWarps, 1, "warpDeformers", "pointCount")            \
  X(warp_rows, "warp.rows", 23, I32, kWarps, 1, "warpDeformers", "rows")                              \
  X(warp_columns, "warp.columns", 24, I32, kWarps, 1, "warpDeformers", "columns")                     \
  X(warp_bilinear, "warp.bilinear", 101, I32, kWarps, 2, "warpDeformers", "bilinear")                 \
  X(warp_firstColor, "warp.firstColor", 105, I32, kWarps, 4, "warpDeformers", "firstColor")           \
  X(rotation_band, "rotation.band", 25, I32, kRotations, 1, "rotationDeformers", "band")              \
  X(rotation_firstKeyform, "rotation.firstKeyform", 26, I32, kRotations, 1, "rotationDeformers",      \
    "firstKeyform")                                                                                   \
  X(rotation_keyformCount, "rotation.keyformCount", 27, I32, kRotations, 1, "rotationDeformers",      \
    "keyformCount")                                                                                   \
  X(rotation_baseAngle, "rotation.baseAngle", 28, F32, kRotations, 1, "rotationDeformers",            \
    "baseAngle")                                                                                      \
  X(rotation_firstColor, "rotation.firstColor", 106, I32, kRotations, 4, "rotationDeformers",         \
    "firstColor")                                                                                     \
  X(mesh_reserved0, "mesh.reserved0", 29, Placeholder, kArtMeshes, 1, nullptr, nullptr)               \
  X(mesh_reserved1, "mesh.reserved1", 30, Placeholder, kArtMeshes, 1, nullptr, nullptr)               \
  X(mesh_reserved2, "mesh.reserved2", 31, Placeholder, kArtMeshes, 1, nullptr, nullptr)               \
  X(mesh_reserved3, "mesh.reserved3", 32, Placeholder, kArtMeshes, 1, nullptr, nullptr)               \
  X(mesh_id, "mesh.id", 33, Name, kArtMeshes, 1, "artMeshes", "ids")                                  \
  X(mesh_band, "mesh.band", 34, I32, kArtMeshes, 1, "artMeshes", "band")                              \
  X(mesh_firstKeyform, "mesh.firstKeyform", 35, I32, kArtMeshes, 1, "artMeshes", "firstKeyform")      \
  X(mesh_keyformCount, "mesh.keyformCount", 36, I32, kArtMeshes, 1, "artMeshes", "keyformCount")      \
  X(mesh_visible, "mesh.visible", 37, I32, kArtMeshes, 1, "artMeshes", "visible")                     \
  X(mesh_enabled, "mesh.enabled", 38, I32, kArtMeshes, 1, "artMeshes", "enabled")                     \
  X(mesh_part, "mesh.part", 39, I32, kArtMeshes, 1, "artMeshes", "part")                              \
  X(mesh_deformer, "mesh.deformer", 40, I32, kArtMeshes, 1, "artMeshes", "deformer")                  \
  X(mesh_texture, "mesh.texture", 41, I32, kArtMeshes, 1, "artMeshes", "texture")                     \
  X(mesh_flags, "mesh.flags", 42, U8, kArtMeshes, 1, "artMeshes", "flags")                            \
  X(mesh_vertexCount, "mesh.vertexCount", 43, I32, kArtMeshes, 1, "artMeshes", "vertexCount")         \
  X(mesh_firstUv, "mesh.firstUv", 44, I32, kArtMeshes, 1, "artMeshes", "firstUv")                     \
  X(mesh_firstTriangleIndex, "mesh.firstTriangleIndex", 45, I32, kArtMeshes, 1, "artMeshes",         \
    "firstTriangleIndex")                                                                             \
  X(mesh_triangleIndexCount, "mesh.triangleIndexCount", 46, I32, kArtMeshes, 1, "artMeshes",         \
    "triangleIndexCount")                                                                             \
  X(mesh_firstMask, "mesh.firstMask", 47, I32, kArtMeshes, 1, "artMeshes", "firstMask")               \
  X(mesh_maskCount, "mesh.maskCount", 48, I32, kArtMeshes, 1, "artMeshes", "maskCount")               \
  X(mesh_firstColor, "mesh.firstColor", 107, I32, kArtMeshes, 4, "artMeshes", "firstColor")           \
  X(mesh_blendMode, "mesh.blendMode", 153, I32, kArtMeshes, 6, "artMeshes", "blendMode")              \
  X(parameter_reserved, "parameter.reserved", 49, Placeholder, kParameters, 1, nullptr, nullptr)      \
  X(parameter_id, "parameter.id", 50, Name, kParameters, 1, "parameters", "ids")                      \
  X(parameter_max, "parameter.max", 51, F32, kParameters, 1, "parameters", "max")                     \
  X(parameter_min, "parameter.min", 52, F32, kParameters, 1, "parameters", "min")                     \
  X(parameter_default, "parameter.default", 53, F32, kParameters, 1, "parameters", "defaultValue")    \
  X(parameter_repeat, "parameter.repeat", 54, I32, kParameters, 1, "parameters", "repeat")            \
  X(parameter_decimals, "parameter.decimals", 55, I32, kParameters, 1, "parameters", "decimals")      \
  X(parameter_firstBinding, "parameter.firstBinding", 56, I32, kParameters, 1, "parameters",          \
    "firstBinding")                                                                                   \
  X(parameter_bindingCount, "parameter.bindingCount", 57, I32, kParameters, 1, "parameters",          \
    "bindingCount")                                                                                   \
  X(parameter_reserved4, "parameter.reserved4", 102, Placeholder, kParameters, 4, nullptr, nullptr)   \
  X(parameter_firstKey, "parameter.firstKey", 103, I32, kParameters, 4, "parameters", "firstKey")     \
  X(parameter_keyCount, "parameter.keyCount", 104, I32, kParameters, 4, "parameters", "keyCount")     \
  X(parameter_type, "parameter.type", 114, I32, kParameters, 4, "parameters", "type")                 \
  X(parameter_firstBlendShapeBinding, "parameter.firstBlendShapeBinding", 115, I32, kParameters, 4,   \
    "parameters", "firstBlendShapeBinding")                                                           \
  X(parameter_blendShapeBindingCount, "parameter.blendShapeBindingCount", 116, I32, kParameters, 4,   \
    "parameters", "blendShapeBindingCount")                                                           \
  X(partKeyform_drawOrder, "partKeyform.drawOrder", 58, F32, kPartKeyforms, 1, "partKeyforms",        \
    "drawOrder")                                                                                      \
  X(partKeyform_offscreenKeyform, "partKeyform.offscreenKeyform", 160, I32, kPartKeyforms, 6,         \
    "partKeyforms", "offscreenKeyform")                                                               \
  X(warpKeyform_opacity, "warpKeyform.opacity", 59, F32, kWarpKeyforms, 1, "warpKeyforms", "opacity") \
  X(warpKeyform_firstPosition, "warpKeyform.firstPosition", 60, I32, kWarpKeyforms, 1,                \
    "warpKeyforms", "firstPosition")                                                                  \
  X(warpKeyform_multiplyColor, "warpKeyform.multiplyColor", 137, I32, kWarpKeyforms, 5,               \
    "warpKeyforms", "multiplyColor")                                                                  \
  X(warpKeyform_screenColor, "warpKeyform.screenColor", 138, I32, kWarpKeyforms, 5, "warpKeyforms",   \
    "screenColor")                                                                                    \
  X(rotationKeyform_opacity, "rotationKeyform.opacity", 61, F32, kRotationKeyforms, 1,                \
    "rotationKeyforms", "opacity")                                                                    \
  X(rotationKeyform_angle, "rotationKeyform.angle", 62, F32, kRotationKeyforms, 1,                    \
    "rotationKeyforms", "angle")                                                                      \
  X(rotationKeyform_originX, "rotationKeyform.originX", 63, F32, kRotationKeyforms, 1,                \
    "rotationKeyforms", "originX")                                                                    \
  X(rotationKeyform_originY, "rotationKeyform.originY", 64, F32, kRotationKeyforms, 1,                \
    "rotationKeyforms", "originY")                                                                    \
  X(rotationKeyform_scale, "rotationKeyform.scale", 65, F32, kRotationKeyforms, 1,                    \
    "rotationKeyforms", "scale")                                                                      \
  X(rotationKeyform_mirrorX, "rotationKeyform.mirrorX", 66, I32, kRotationKeyforms, 1,                \
    "rotationKeyforms", "mirrorX")                                                                    \
  X(rotationKeyform_mirrorY, "rotationKeyform.mirrorY", 67, I32, kRotationKeyforms, 1,                \
    "rotationKeyforms", "mirrorY")                                                                    \
  X(rotationKeyform_multiplyColor, "rotationKeyform.multiplyColor", 139, I32, kRotationKeyforms, 5,   \
    "rotationKeyforms", "multiplyColor")                                                              \
  X(rotationKeyform_screenColor, "rotationKeyform.screenColor", 140, I32, kRotationKeyforms, 5,       \
    "rotationKeyforms", "screenColor")                                                                \
  X(meshKeyform_opacity, "meshKeyform.opacity", 68, F32, kArtMeshKeyforms, 1, "artMeshKeyforms",      \
    "opacity")                                                                                        \
  X(meshKeyform_drawOrder, "meshKeyform.drawOrder", 69, F32, kArtMeshKeyforms, 1, "artMeshKeyforms",  \
    "drawOrder")                                                                                      \
  X(meshKeyform_firstPosition, "meshKeyform.firstPosition", 70, I32, kArtMeshKeyforms, 1,             \
    "artMeshKeyforms", "firstPosition")                                                               \
  X(meshKeyform_multiplyColor, "meshKeyform.multiplyColor", 141, I32, kArtMeshKeyforms, 5,            \
    "artMeshKeyforms", "multiplyColor")                                                               \
  X(meshKeyform_screenColor, "meshKeyform.screenColor", 142, I32, kArtMeshKeyforms, 5,                \
    "artMeshKeyforms", "screenColor")                                                                 \
  X(offscreenKeyform_opacity, "offscreenKeyform.opacity", 161, F32, kOffscreenKeyforms, 6,            \
    "offscreenKeyforms", "opacity")                                                                   \
  X(offscreenKeyform_multiplyColor, "offscreenKeyform.multiplyColor", 162, I32, kOffscreenKeyforms,   \
    6, "offscreenKeyforms", "multiplyColor")                                                          \
  X(offscreenKeyform_screenColor, "offscreenKeyform.screenColor", 163, I32, kOffscreenKeyforms, 6,    \
    "offscreenKeyforms", "screenColor")                                                               \
  X(glueKeyform_intensity, "glueKeyform.intensity", 100, F32, kGlueKeyforms, 1, "glueKeyforms",       \
    "intensity")                                                                                      \
  X(positions, "positions", 71, F32, kPositionFloats, 1, "keyformPositions", nullptr)                 \
  X(bindingIndex, "bindingIndex", 72, I32, kBindingIndexEntries, 1, "bindingIndices", nullptr)        \
  X(band_firstEntry, "band.firstEntry", 73, I32, kBands, 1, "bands", "firstEntry")                    \
  X(band_entryCount, "band.entryCount", 74, I32, kBands, 1, "bands", "entryCount")                    \
  X(binding_firstKey, "binding.firstKey", 75, I32, kParameterBindings, 1, "parameterBindings",        \
    "firstKey")                                                                                       \
  X(binding_keyCount, "binding.keyCount", 76, I32, kParameterBindings, 1, "parameterBindings",        \
    "keyCount")                                                                                       \
  X(keys, "keys", 77, F32, kKeyValues, 1, "keys", nullptr)                                            \
  X(uvs, "uvs", 78, F32, kUvFloats, 1, "uvs", nullptr)                                                \
  X(triangleIndices, "triangleIndices", 79, U16, kTriangleIndexEntries, 1, "triangleIndices",         \
    nullptr)                                                                                          \
  X(maskEntries, "maskEntries", 80, I32, kMaskEntries, 1, "maskEntries", nullptr)                     \
  X(group_firstObject, "group.firstObject", 81, I32, kDrawOrderGroups, 1, "drawOrderGroups",          \
    "firstObject")                                                                                    \
  X(group_objectCount, "group.objectCount", 82, I32, kDrawOrderGroups, 1, "drawOrderGroups",          \
    "objectCount")                                                                                    \
  X(group_entryCount, "group.entryCount", 83, I32, kDrawOrderGroups, 1, "drawOrderGroups",            \
    "entryCount")                                                                                     \
  X(group_maxDrawOrder, "group.maxDrawOrder", 84, I32, kDrawOrderGroups, 1, "drawOrderGroups",        \
    "maxDrawOrder")                                                                                   \
  X(group_minDrawOrder, "group.minDrawOrder", 85, I32, kDrawOrderGroups, 1, "drawOrderGroups",        \
    "minDrawOrder")                                                                                   \
  X(groupObject_kind, "groupObject.kind", 86, I32, kDrawOrderGroupObjects, 1,                         \
    "drawOrderGroupObjects", "kind")                                                                  \
  X(groupObject_index, "groupObject.index", 87, I32, kDrawOrderGroupObjects, 1,                       \
    "drawOrderGroupObjects", "index")                                                                 \
  X(groupObject_nestedGroup, "groupObject.nestedGroup", 88, I32, kDrawOrderGroupObjects, 1,           \
    "drawOrderGroupObjects", "nestedGroup")                                                           \
  X(glue_reserved, "glue.reserved", 89, Placeholder, kGlues, 1, nullptr, nullptr)                     \
  X(glue_id, "glue.id", 90, Name, kGlues, 1, "glues", "ids")                                          \
  X(glue_band, "glue.band", 91, I32, kGlues, 1, "glues", "band")                                      \
  X(glue_firstKeyform, "glue.firstKeyform", 92, I32, kGlues, 1, "glues", "firstKeyform")              \
  X(glue_keyformCount, "glue.keyformCount", 93, I32, kGlues, 1, "glues", "keyformCount")              \
  X(glue_meshA, "glue.meshA", 94, I32, kGlues, 1, "glues", "artMeshA")                                \
  X(glue_meshB, "glue.meshB", 95, I32, kGlues, 1, "glues", "artMeshB")                                \
  X(glue_firstInfo, "glue.firstInfo", 96, I32, kGlues, 1, "glues", "firstInfo")                       \
  X(glue_infoCount, "glue.infoCount", 97, I32, kGlues, 1, "glues", "infoCount")                       \
  X(glueInfo_weight, "glueInfo.weight", 98, F32, kGlueInfoEntries, 1, "glueInfo", "weight")           \
  X(glueInfo_vertex, "glueInfo.vertex", 99, U16, kGlueInfoEntries, 1, "glueInfo", "vertex")           \
  X(multiplyColor_r, "multiplyColor.r", 108, F32, kMultiplyColors, 4, "multiplyColors", "r")          \
  X(multiplyColor_g, "multiplyColor.g", 109, F32, kMultiplyColors, 4, "multiplyColors", "g")          \
  X(multiplyColor_b, "multiplyColor.b", 110, F32, kMultiplyColors, 4, "multiplyColors", "b")          \
  X(screenColor_r, "screenColor.r", 111, F32, kScreenColors, 4, "screenColors", "r")                  \
  X(screenColor_g, "screenColor.g", 112, F32, kScreenColors, 4, "screenColors", "g")                  \
  X(screenColor_b, "screenColor.b", 113, F32, kScreenColors, 4, "screenColors", "b")                  \
  X(bsBinding_firstKey, "bsBinding.firstKey", 117, I32, kBlendShapeParameterBindings, 4,              \
    "blendShapeParameterBindings", "firstKey")                                                        \
  X(bsBinding_keyCount, "bsBinding.keyCount", 118, I32, kBlendShapeParameterBindings, 4,              \
    "blendShapeParameterBindings", "keyCount")                                                        \
  X(bsBinding_baseKey, "bsBinding.baseKey", 119, I32, kBlendShapeParameterBindings, 4,                \
    "blendShapeParameterBindings", "baseKey")                                                         \
  X(bsKeyformBinding_binding, "bsKeyformBinding.binding", 120, I32, kBlendShapeKeyformBindings, 4,    \
    "blendShapeKeyformBindings", "parameterBinding")                                                  \
  X(bsKeyformBinding_firstKeyform, "bsKeyformBinding.firstKeyform", 121, I32,                         \
    kBlendShapeKeyformBindings, 4, "blendShapeKeyformBindings", "firstKeyform")                       \
  X(bsKeyformBinding_keyformCount, "bsKeyformBinding.keyformCount", 122, I32,                         \
    kBlendShapeKeyformBindings, 4, "blendShapeKeyformBindings", "keyformCount")                       \
  X(bsKeyformBinding_firstConstraintEntry, "bsKeyformBinding.firstConstraintEntry", 123, I32,         \
    kBlendShapeKeyformBindings, 4, "blendShapeKeyformBindings", "firstConstraintEntry")               \
  X(bsKeyformBinding_constraintEntryCount, "bsKeyformBinding.constraintEntryCount", 124, I32,         \
    kBlendShapeKeyformBindings, 4, "blendShapeKeyformBindings", "constraintEntryCount")               \
  X(warpTarget_warp, "warpTarget.warp", 125, I32, kWarpBlendShapeTargets, 4, "warpBlendShapeTargets", \
    "object")                                                                                         \
  X(warpTarget_firstBinding, "warpTarget.firstBinding", 126, I32, kWarpBlendShapeTargets, 4,          \
    "warpBlendShapeTargets", "firstBinding")                                                          \
  X(warpTarget_bindingCount, "warpTarget.bindingCount", 127, I32, kWarpBlendShapeTargets, 4,          \
    "warpBlendShapeTargets", "bindingCount")                                                          \
  X(meshTarget_mesh, "meshTarget.mesh", 128, I32, kArtMeshBlendShapeTargets, 4,                       \
    "artMeshBlendShapeTargets", "object")                                                             \
  X(meshTarget_firstBinding, "meshTarget.firstBinding", 129, I32, kArtMeshBlendShapeTargets, 4,       \
    "artMeshBlendShapeTargets", "firstBinding")                                                       \
  X(meshTarget_bindingCount, "meshTarget.bindingCount", 130, I32, kArtMeshBlendShapeTargets, 4,       \
    "artMeshBlendShapeTargets", "bindingCount")                                                       \
  X(constraintIndex, "constraintIndex", 131, I32, kBlendShapeConstraintIndexEntries, 4,               \
    "blendShapeConstraintEntries", nullptr)                                                           \
  X(constraint_parameter, "constraint.parameter", 132, I32, kBlendShapeConstraints, 4,                \
    "blendShapeConstraints", "parameter")                                                             \
  X(constraint_firstValue, "constraint.firstValue", 133, I32, kBlendShapeConstraints, 4,              \
    "blendShapeConstraints", "firstValue")                                                            \
  X(constraint_valueCount, "constraint.valueCount", 134, I32, kBlendShapeConstraints, 4,              \
    "blendShapeConstraints", "valueCount")                                                            \
  X(constraintValue_key, "constraintValue.key", 135, F32, kBlendShapeConstraintValues, 4,             \
    "blendShapeConstraintValues", "key")                                                              \
  X(constraintValue_weight, "constraintValue.weight", 136, F32, kBlendShapeConstraintValues, 4,       \
    "blendShapeConstraintValues", "weight")                                                           \
  X(partTarget_part, "partTarget.part", 143, I32, kPartBlendShapeTargets, 5, "partBlendShapeTargets", \
    "object")                                                                                         \
  X(partTarget_firstBinding, "partTarget.firstBinding", 144, I32, kPartBlendShapeTargets, 5,          \
    "partBlendShapeTargets", "firstBinding")                                                          \
  X(partTarget_bindingCount, "partTarget.bindingCount", 145, I32, kPartBlendShapeTargets, 5,          \
    "partBlendShapeTargets", "bindingCount")                                                          \
  X(rotationTarget_rotation, "rotationTarget.rotation", 146, I32, kRotationBlendShapeTargets, 5,      \
    "rotationBlendShapeTargets", "object")                                                            \
  X(rotationTarget_firstBinding, "rotationTarget.firstBinding", 147, I32,                             \
    kRotationBlendShapeTargets, 5, "rotationBlendShapeTargets", "firstBinding")                       \
  X(rotationTarget_bindingCount, "rotationTarget.bindingCount", 148, I32,                             \
    kRotationBlendShapeTargets, 5, "rotationBlendShapeTargets", "bindingCount")                       \
  X(glueTarget_glue, "glueTarget.glue", 149, I32, kGlueBlendShapeTargets, 5, "glueBlendShapeTargets", \
    "object")                                                                                         \
  X(glueTarget_firstBinding, "glueTarget.firstBinding", 150, I32, kGlueBlendShapeTargets, 5,          \
    "glueBlendShapeTargets", "firstBinding")                                                          \
  X(glueTarget_bindingCount, "glueTarget.bindingCount", 151, I32, kGlueBlendShapeTargets, 5,          \
    "glueBlendShapeTargets", "bindingCount")                                                          \
  X(offscreen_reserved, "offscreen.reserved", 154, Placeholder, kOffscreens, 6, nullptr, nullptr)     \
  X(offscreen_part, "offscreen.part", 155, I32, kOffscreens, 6, "offscreens", "part")                 \
  X(offscreen_flags, "offscreen.flags", 156, U8, kOffscreens, 6, "offscreens", "flags")               \
  X(offscreen_blendMode, "offscreen.blendMode", 157, I32, kOffscreens, 6, "offscreens", "blendMode")  \
  X(offscreen_firstMask, "offscreen.firstMask", 158, I32, kOffscreens, 6, "offscreens", "firstMask")  \
  X(offscreen_maskCount, "offscreen.maskCount", 159, I32, kOffscreens, 6, "offscreens", "maskCount")  \
  /* Offscreen blend-shape targets (v6, count 37): their keyforms are offscreen keyforms. */           \
  X(offscreenTarget_offscreen, "offscreenTarget.offscreen", 164, I32, kOffscreenBlendShapeTargets, 6,     \
    "offscreenBlendShapeTargets", "object")                                                              \
  X(offscreenTarget_firstBinding, "offscreenTarget.firstBinding", 165, I32, kOffscreenBlendShapeTargets, 6, \
    "offscreenBlendShapeTargets", "firstBinding")                                                        \
  X(offscreenTarget_bindingCount, "offscreenTarget.bindingCount", 166, I32, kOffscreenBlendShapeTargets, 6, \
    "offscreenBlendShapeTargets", "bindingCount")

/** Field identifiers, in schema-table order. */
enum class F : uint16_t {
#define MOCHI2D_X(id, key, slot, type, count, since, group, field) id,
  MOCHI2D_MOC_FIELDS(MOCHI2D_X)
#undef MOCHI2D_X
};

constexpr std::size_t kFieldCount = 0
#define MOCHI2D_X(id, key, slot, type, count, since, group, field) +1
    MOCHI2D_MOC_FIELDS(MOCHI2D_X)
#undef MOCHI2D_X
    ;

struct FieldSpec {
  F id;
  const char* key;
  int slot;
  ElementType type;
  Count count;
  int since;
  /** MocData group, or nullptr for placeholders. */
  const char* group;
  /** MocData field, or nullptr for pools and placeholders. */
  const char* field;
};

/** The schema table, indexed by F. */
const FieldSpec& spec(F f);
/** Every field, in schema-table order. */
const FieldSpec* all_fields();

/**
 * The groups of MocData in count-table order, each with its count entry and
 * its fields in layout order (data.ts MOC_DATA_LAYOUT).
 */
struct GroupSpec {
  const char* name;
  Count count;
  /** True for a single array (pool). */
  bool pool;
  /** Fields in layout order (pools: the one array). */
  const F* fields;
  std::size_t field_count;
  /** First version holding the group (the earliest of its fields). */
  int since;
};
const GroupSpec* groups(std::size_t& count);
/** The group with this name, or nullptr. */
const GroupSpec* group_by_name(const char* name);

}  // namespace mochi2d::moc

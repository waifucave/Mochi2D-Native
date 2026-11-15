// A small synthetic model, written field by field with the library's own
// writer: shared by the unit tests and the fuzz targets (whose seeds it
// makes). No model data of any third party is involved.
#pragma once

#include <cstdio>

#include "core/moc/data.hpp"
#include "core/moc/io.hpp"
#include "util/alloc.hpp"

namespace mochi2d::testing {

using moc::F;


/**
 * A small model of a version, written field by field: one parameter with
 * keys {0, 1}, one part, one art mesh with a triangle whose x moves by 1
 * between the two keyforms, under an optional 1×1 warp.
 */
inline moc::MocData tiny_model(int version, bool with_warp) {
  moc::MocData d;
  d.canvas = {1, 0, 0, 2, 2, 0};
  for (std::size_t i = 0; i < moc::kFieldCount; i++) {
    const auto& s = moc::all_fields()[i];
    if (s.since <= version && s.type != moc::ElementType::Placeholder) d.fields[i].present = true;
  }
  auto I = [&](F f) -> Vector<int32_t>& { return d.i32(f); };
  auto Fl = [&](F f) -> Vector<float>& { return d.f32(f); };
  // Parameter and binding.
  d.names(F::parameter_id) = {"ParamX"};
  Fl(F::parameter_max) = {1};
  Fl(F::parameter_min) = {0};
  Fl(F::parameter_default) = {0};
  I(F::parameter_repeat) = {0};
  I(F::parameter_decimals) = {3};
  I(F::parameter_firstBinding) = {0};
  I(F::parameter_bindingCount) = {1};
  if (version >= 4) {
    I(F::parameter_firstKey) = {0};
    I(F::parameter_keyCount) = {2};
    I(F::parameter_type) = {0};
    I(F::parameter_firstBlendShapeBinding) = {0};
    I(F::parameter_blendShapeBindingCount) = {0};
  }
  Fl(F::keys) = {0, 1};
  I(F::binding_firstKey) = {0};
  I(F::binding_keyCount) = {2};
  I(F::bindingIndex) = {0};
  I(F::band_firstEntry) = {0, 0};
  I(F::band_entryCount) = {0, 1};  // band 0: none; band 1: the binding
  // Part.
  d.names(F::part_id) = {"Root"};
  I(F::part_band) = {0};
  I(F::part_firstKeyform) = {0};
  I(F::part_keyformCount) = {1};
  I(F::part_initiallyVisible) = {1};
  I(F::part_enabled) = {1};
  I(F::part_parent) = {-1};
  if (version >= 6) I(F::part_offscreen) = {-1};
  Fl(F::partKeyform_drawOrder) = {500};
  if (version >= 6) I(F::partKeyform_offscreenKeyform) = {-1};
  Vector<float>& pos = Fl(F::positions);
  // Warp (optional): identity grid over [0,1]² mapped to [-1,1]².
  if (with_warp) {
    d.names(F::deformer_id) = {"Warp"};
    I(F::deformer_band) = {0};
    I(F::deformer_visible) = {1};
    I(F::deformer_enabled) = {1};
    I(F::deformer_part) = {0};
    I(F::deformer_parent) = {-1};
    I(F::deformer_kind) = {0};
    I(F::deformer_kindIndex) = {0};
    I(F::warp_band) = {0};
    I(F::warp_firstKeyform) = {0};
    I(F::warp_keyformCount) = {1};
    I(F::warp_pointCount) = {4};
    I(F::warp_rows) = {1};
    I(F::warp_columns) = {1};
    if (version >= 2) I(F::warp_bilinear) = {0};
    if (version >= 4) I(F::warp_firstColor) = {0};
    Fl(F::warpKeyform_opacity) = {1};
    I(F::warpKeyform_firstPosition) = {static_cast<int32_t>(pos.size())};
    if (version >= 5) {
      I(F::warpKeyform_multiplyColor) = {0};
      I(F::warpKeyform_screenColor) = {0};
    }
    for (float v : {-1.f, -1.f, 1.f, -1.f, -1.f, 1.f, 1.f, 1.f}) pos.push_back(v);
  }
  // Art mesh: two keyforms.
  d.names(F::mesh_id) = {"Mesh"};
  I(F::mesh_band) = {1};
  I(F::mesh_firstKeyform) = {0};
  I(F::mesh_keyformCount) = {2};
  I(F::mesh_visible) = {1};
  I(F::mesh_enabled) = {1};
  I(F::mesh_part) = {0};
  I(F::mesh_deformer) = {with_warp ? 0 : -1};
  I(F::mesh_texture) = {0};
  d.u8(F::mesh_flags) = {4};
  I(F::mesh_vertexCount) = {3};
  I(F::mesh_firstUv) = {0};
  I(F::mesh_firstTriangleIndex) = {0};
  I(F::mesh_triangleIndexCount) = {3};
  I(F::mesh_firstMask) = {0};
  I(F::mesh_maskCount) = {0};
  if (version >= 4) I(F::mesh_firstColor) = {with_warp ? 1 : 0};
  if (version >= 6) I(F::mesh_blendMode) = {0};
  Fl(F::meshKeyform_opacity) = {1, 0.5f};
  Fl(F::meshKeyform_drawOrder) = {500, 600};
  const int32_t base = static_cast<int32_t>(pos.size());
  I(F::meshKeyform_firstPosition) = {base, base + 6};
  if (version >= 5) {
    const int32_t c = with_warp ? 1 : 0;
    I(F::meshKeyform_multiplyColor) = {c, c + 1};
    I(F::meshKeyform_screenColor) = {c, c + 1};
  }
  for (float v : {0.25f, 0.25f, 0.75f, 0.25f, 0.5f, 0.75f}) pos.push_back(v);
  for (float v : {0.25f, 0.25f, 0.75f, 0.25f, 0.5f, 0.75f}) pos.push_back(v + 0.125f);
  Fl(F::uvs) = {0, 0, 1, 0, 0.5f, 1};
  d.u16(F::triangleIndices) = {0, 1, 2};
  // Colors (v4).
  if (version >= 4) {
    const std::size_t n = with_warp ? 3 : 2;
    for (F f : {F::multiplyColor_r, F::multiplyColor_g, F::multiplyColor_b}) Fl(f).assign(n, 1.0f);
    for (F f : {F::screenColor_r, F::screenColor_g, F::screenColor_b}) Fl(f).assign(n, 0.0f);
    Fl(F::multiplyColor_g)[n - 1] = 0.5f;  // the second mesh keyform's green
  }
  // One draw-order group.
  I(F::group_firstObject) = {0};
  I(F::group_objectCount) = {1};
  I(F::group_entryCount) = {1};
  I(F::group_maxDrawOrder) = {1000};
  I(F::group_minDrawOrder) = {0};
  I(F::groupObject_kind) = {0};
  I(F::groupObject_index) = {0};
  I(F::groupObject_nestedGroup) = {-1};
  return d;
}

/** write_moc, or empty bytes (with the diagnostics printed) when it refuses. */
inline Vector<uint8_t> written(const moc::MocData& data, int version) {
  Vector<uint8_t> bytes;
  Vector<moc::Diagnostic> diags;
  if (!moc::write_moc(data, version, bytes, diags))
    for (const auto& d : diags) std::fprintf(stderr, "  write: %s %s\n", d.code.c_str(), d.message.c_str());
  return bytes;
}

}  // namespace mochi2d::testing

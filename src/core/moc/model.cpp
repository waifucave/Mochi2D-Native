// Port of Mochi2D's src/core/moc/model.ts (buildModel) and from-data.ts.
#include "core/moc/model.hpp"

#include <algorithm>
#include <cmath>
#include <set>

#include "core/eval/f32.hpp"
#include "core/moc/io.hpp"
#include "util/text.hpp"

namespace mochi2d::moc {

namespace {


String num(float x) { return text::js_number(static_cast<double>(x)); }

template <class T>
Vector<T> slice(const Vector<T>& v, long long first, long long count) {
  if (count <= 0) return {};
  return Vector<T>(v.begin() + first, v.begin() + first + count);
}

Vector<uint8_t> to_u8(const Vector<int32_t>& a) {
  Vector<uint8_t> out(a.size());
  for (std::size_t i = 0; i < a.size(); i++) out[i] = a[i] != 0 ? 1 : 0;
  return out;
}

}  // namespace

bool load_moc(const uint8_t* bytes, std::size_t size, const LoadOptions& options, Model& out, Error& err) {
  Sections s;
  if (!read_sections(bytes, size, false, s, err)) return false;
  return build_model(s, options, out, err);
}

#define TRY(expr)              \
  do {                         \
    if (!(expr)) return false; \
  } while (0)

bool build_model(const Sections& sections, const LoadOptions& options, Model& m, Error& err) {
  m = Model();
  err = Error();
  // The loader's checks (model.ts Checker): each returns false and fills err.
  auto reject = [&](const String& message) {
    err.code = "invalid";
    err.message = message;
    return false;
  };
  auto check = [&](bool cond, auto&& message) { return cond || reject(message()); };
  /** `i` must be an integer in [lo, hi). */
  auto index = [&](long long i, long long lo, long long hi, auto&& what) {
    if (i >= lo && i < hi) return true;
    return reject(what() + ": index " + to_str(i) + " out of range [" + to_str(lo) + ", " + to_str(hi) + ")");
  };
  /** [first, first + count) within [0, total); an empty range may start anywhere. */
  auto range = [&](long long first, long long count, long long total, auto&& what) {
    if (count < 0) return reject(what() + ": negative count " + to_str(count));
    if (count == 0) return true;
    if (first >= 0 && first + count <= total) return true;
    return reject(what() + ": range [" + to_str(first) + ", " + to_str(first + count) + ") out of bounds (0…" +
                  to_str(total) + ")");
  };
  const MocData& s = sections.data;
  const int v = sections.version;
  auto cnt = [&](int c) { return static_cast<long long>(sections.count(c)); };
  struct {
    long long parts, deformers, warps, rotations, meshes, parameters, partKeyforms, warpKeyforms, rotationKeyforms,
        meshKeyforms, positions, bindingEntries, bands, bindings, keys, uvs, triangleEntries, maskEntries, groups,
        groupObjects, glues, glueInfos, glueKeyforms, multiplyColors, screenColors, bsBindings, bsKeyformBindings,
        constraintEntries, constraints, constraintValues, offscreens, offscreenKeyforms;
  } n{cnt(kParts), cnt(kDeformers), cnt(kWarps), cnt(kRotations), cnt(kArtMeshes), cnt(kParameters), cnt(kPartKeyforms),
      cnt(kWarpKeyforms), cnt(kRotationKeyforms), cnt(kArtMeshKeyforms), cnt(kPositionFloats),
      cnt(kBindingIndexEntries), cnt(kBands), cnt(kParameterBindings), cnt(kKeyValues), cnt(kUvFloats),
      cnt(kTriangleIndexEntries), cnt(kMaskEntries), cnt(kDrawOrderGroups), cnt(kDrawOrderGroupObjects), cnt(kGlues),
      cnt(kGlueInfoEntries), cnt(kGlueKeyforms), cnt(kMultiplyColors), cnt(kScreenColors),
      cnt(kBlendShapeParameterBindings), cnt(kBlendShapeKeyformBindings), cnt(kBlendShapeConstraintIndexEntries),
      cnt(kBlendShapeConstraints), cnt(kBlendShapeConstraintValues), cnt(kOffscreens), cnt(kOffscreenKeyforms)};
  auto I = [&](F f) -> const Vector<int32_t>& { return s.i32(f); };
  auto Fl = [&](F f) -> const Vector<float>& { return s.f32(f); };
  auto Z = [](long long x) { return static_cast<std::size_t>(x); };
  const auto& keys = Fl(F::keys);

  // ---- parameter bindings and their keys ----
  const auto& bindingFirstKey = I(F::binding_firstKey);
  const auto& bindingKeyCount = I(F::binding_keyCount);
  auto keysAt = [&](long long first, long long count, auto&& what, Vector<Vector<float>>& into) {
    TRY(range(first, count, n.keys, what));
    TRY(check(count >= 1, [&] { return what() + ": has no keys"; }));
    Vector<float> k = slice(keys, first, count);
    for (std::size_t i = 1; i < k.size(); i++)
      TRY(check(k[i] > k[i - 1], [&] {
        return what() + ": keys are not strictly ascending (" + num(k[i - 1]) + " then " + num(k[i]) + ")";
      }));
    into.push_back(std::move(k));
    return true;
  };
  Vector<Vector<float>> bindingKeys;
  for (long long b = 0; b < n.bindings; b++)
    TRY(keysAt(bindingFirstKey[Z(b)], bindingKeyCount[Z(b)], [&] { return "parameter binding " + to_str(b); }, bindingKeys));

  // The seven 0/1 fields (S6).
  const std::pair<F, const char*> flagFields[] = {
      {F::part_initiallyVisible, "part.initiallyVisible"}, {F::part_enabled, "part.enabled"},
      {F::deformer_visible, "deformer.visible"},           {F::deformer_enabled, "deformer.enabled"},
      {F::mesh_visible, "mesh.visible"},                   {F::mesh_enabled, "mesh.enabled"},
      {F::parameter_repeat, "parameter.repeat"}};
  for (const auto& flag : flagFields) {
    const char* key = flag.second;
    const auto& values = I(flag.first);
    for (std::size_t i = 0; i < values.size(); i++)
      TRY(check(values[i] == 0 || values[i] == 1, [&] {
        return String(key) + " " + to_str(i) + ": " + to_str(values[i]) + " is not a flag value (0 or 1)";
      }));
  }

  // ---- parameters ----
  const auto& pIds = s.names(F::parameter_id);
  const auto& pMin = Fl(F::parameter_min);
  const auto& pMax = Fl(F::parameter_max);
  const auto& pFirstBinding = I(F::parameter_firstBinding);
  const auto& pBindingCount = I(F::parameter_bindingCount);
  const auto& pDecimals = I(F::parameter_decimals);
  Vector<int32_t> bindingParameter(Z(n.bindings), -1);
  Vector<uint8_t> pType(Z(n.parameters), 0);
  for (long long p = 0; p < n.parameters; p++) {
    auto what = [&] { return "parameter " + to_str(p) + " (" + pIds[Z(p)] + ")"; };
    TRY(check(!(pMin[Z(p)] > pMax[Z(p)]), [&] { return what() + ": min " + num(pMin[Z(p)]) + " > max " + num(pMax[Z(p)]); }));
    TRY(check(pDecimals[Z(p)] >= 0, [&] { return what() + ": negative decimal places " + to_str(pDecimals[Z(p)]); }));
    TRY(range(pFirstBinding[Z(p)], pBindingCount[Z(p)], n.bindings, [&] { return what() + " bindings"; }));
    for (long long b = pFirstBinding[Z(p)]; b < static_cast<long long>(pFirstBinding[Z(p)]) + pBindingCount[Z(p)]; b++) {
      TRY(check(bindingParameter[Z(b)] == -1, [&] { return "parameter binding " + to_str(b) + " is owned twice"; }));
      bindingParameter[Z(b)] = static_cast<int32_t>(p);
    }
    if (v >= 4) {
      const int32_t t = I(F::parameter_type)[Z(p)];
      TRY(check(t == 0 || t == 1, [&] { return what() + ": unknown type " + to_str(t); }));
      pType[Z(p)] = static_cast<uint8_t>(t);
    }
  }
  for (long long b = 0; b < n.bindings; b++)
    TRY(check(bindingParameter[Z(b)] != -1, [&] { return "parameter binding " + to_str(b) + " is not owned by any parameter"; }));
  Vector<Vector<float>> keyLists;
  if (v >= 4) {
    const auto& firstKey = I(F::parameter_firstKey);
    const auto& keyCount = I(F::parameter_keyCount);
    for (long long p = 0; p < n.parameters; p++) {
      TRY(range(firstKey[Z(p)], keyCount[Z(p)], n.keys, [&] { return "parameter " + to_str(p) + " (" + pIds[Z(p)] + ") key list"; }));
      keyLists.push_back(slice(keys, firstKey[Z(p)], keyCount[Z(p)]));
    }
  } else {
    for (long long p = 0; p < n.parameters; p++) {
      Vector<float> list;
      for (long long b = pFirstBinding[Z(p)]; b < static_cast<long long>(pFirstBinding[Z(p)]) + pBindingCount[Z(p)]; b++)
        for (float k : bindingKeys[Z(b)]) {
          const float key = k == 0 ? 0.0f : k;  // a Set stores −0 as +0
          if (std::find(list.begin(), list.end(), key) == list.end()) list.push_back(key);
        }
      stable_sort(list, [](float a, float b) { return a < b; });
      keyLists.push_back(std::move(list));
    }
  }

  // ---- bands ----
  const auto& bandFirst = I(F::band_firstEntry);
  const auto& bandCount = I(F::band_entryCount);
  const auto& bindingIndex = I(F::bindingIndex);
  for (long long e = 0; e < n.bindingEntries; e++)
    TRY(index(bindingIndex[Z(e)], 0, n.bindings, [&] { return "binding-index entry " + to_str(e); }));
  for (long long b = 0; b < n.bands; b++) {
    TRY(range(bandFirst[Z(b)], bandCount[Z(b)], n.bindingEntries, [&] { return "keyform binding " + to_str(b); }));
    Band band;
    band.bindings = slice(bindingIndex, bandFirst[Z(b)], bandCount[Z(b)]);
    band.strides.resize(band.bindings.size());
    long long size = 1;
    for (std::size_t j = 0; j < band.bindings.size(); j++) {
      band.strides[j] = static_cast<int32_t>(size);
      size *= static_cast<long long>(bindingKeys[Z(band.bindings[j])].size());
      TRY(check(size <= 0x7fffffff, [&] { return "keyform binding " + to_str(b) + ": keyform count overflows"; }));
    }
    band.keyform_count = static_cast<int32_t>(size);
    m.bands.push_back(std::move(band));
  }
  auto keyformRange = [&](long long band, long long first, long long count, long long total,
                          auto&& what) {
    TRY(index(band, 0, n.bands, [&] { return what() + " keyform binding"; }));
    TRY(range(first, count, total, [&] { return what() + " keyforms"; }));
    const long long expected = m.bands[Z(band)].keyform_count;
    TRY(check(count == expected, [&] {
      return what() + ": " + to_str(count) + " keyforms but its bindings need " + to_str(expected);
    }));
    return true;
  };

  // ---- colors ----
  m.multiply_colors.assign(Z(n.multiplyColors * 3), 0.0f);
  m.screen_colors.assign(Z(n.screenColors * 3), 0.0f);
  if (v >= 4) {
    for (long long i = 0; i < n.multiplyColors; i++) {
      m.multiply_colors[Z(i * 3)] = Fl(F::multiplyColor_r)[Z(i)];
      m.multiply_colors[Z(i * 3 + 1)] = Fl(F::multiplyColor_g)[Z(i)];
      m.multiply_colors[Z(i * 3 + 2)] = Fl(F::multiplyColor_b)[Z(i)];
    }
    for (long long i = 0; i < n.screenColors; i++) {
      m.screen_colors[Z(i * 3)] = Fl(F::screenColor_r)[Z(i)];
      m.screen_colors[Z(i * 3 + 1)] = Fl(F::screenColor_g)[Z(i)];
      m.screen_colors[Z(i * 3 + 2)] = Fl(F::screenColor_b)[Z(i)];
    }
  }
  auto noColors = [](long long count) {
    ColorIndices c;
    c.multiply.assign(static_cast<std::size_t>(count), -1);
    c.screen.assign(static_cast<std::size_t>(count), -1);
    return c;
  };
  auto v5Colors = [&](F mk, F sk) {
    ColorIndices c;
    c.multiply = I(mk);
    c.screen = I(sk);
    return c;
  };
  auto checkColors = [&](const ColorIndices& colors, const String& what) {
    for (std::size_t k = 0; k < colors.multiply.size(); k++) {
      TRY(index(colors.multiply[k], 0, n.multiplyColors, [&] { return what + " keyform " + to_str(k) + " multiply color"; }));
      TRY(index(colors.screen[k], 0, n.screenColors, [&] { return what + " keyform " + to_str(k) + " screen color"; }));
    }
    return true;
  };
  auto v4Colors = [&](ColorIndices& target, long long first, long long count, long long firstColor,
                      auto&& what) {
    TRY(range(firstColor, count, std::min(n.multiplyColors, n.screenColors), [&] { return what() + " colors"; }));
    for (long long k = 0; k < count; k++) {
      target.multiply[Z(first + k)] = static_cast<int32_t>(firstColor + k);
      target.screen[Z(first + k)] = static_cast<int32_t>(firstColor + k);
    }
    return true;
  };

  // ---- parts ----
  const auto& partIds = s.names(F::part_id);
  const auto& partBand = I(F::part_band);
  const auto& partFirst = I(F::part_firstKeyform);
  const auto& partCount = I(F::part_keyformCount);
  const auto& partParent = I(F::part_parent);
  const Vector<int32_t> partOffscreen = v >= 6 ? I(F::part_offscreen) : Vector<int32_t>(Z(n.parts), -1);
  Vector<float> partInitial(Z(n.parts));
  Vector<uint8_t> partEnabled(Z(n.parts));
  for (long long i = 0; i < n.parts; i++) {
    auto what = [&] { return "part " + to_str(i) + " (" + partIds[Z(i)] + ")"; };
    TRY(check(partParent[Z(i)] >= -1 && partParent[Z(i)] < i, [&] {
      return what() + ": parent " + to_str(partParent[Z(i)]) + " must be -1 or an earlier part";
    }));
    TRY(keyformRange(partBand[Z(i)], partFirst[Z(i)], partCount[Z(i)], n.partKeyforms, what));
    TRY(index(partOffscreen[Z(i)], -1, n.offscreens, [&] { return what() + " offscreen"; }));
    partInitial[Z(i)] = I(F::part_initiallyVisible)[Z(i)] == 1 ? 1.0f : 0.0f;
    partEnabled[Z(i)] = I(F::part_enabled)[Z(i)] != 0 ? 1 : 0;
  }

  // ---- deformers ----
  const auto& dIds = s.names(F::deformer_id);
  const auto& dKind = I(F::deformer_kind);
  const auto& dKindIndex = I(F::deformer_kindIndex);
  const auto& dPart = I(F::deformer_part);
  const auto& dParent = I(F::deformer_parent);
  const auto& dBandRaw = I(F::deformer_band);
  const auto& warpBand = I(F::warp_band);
  const auto& rotBand = I(F::rotation_band);
  Vector<uint8_t> dKindU8(Z(n.deformers));
  Vector<int32_t> dBand(Z(n.deformers));
  Vector<uint8_t> dEnabled(Z(n.deformers));
  for (long long d = 0; d < n.deformers; d++) {
    auto what = [&] { return "deformer " + to_str(d) + " (" + dIds[Z(d)] + ")"; };
    const int32_t kind = dKind[Z(d)];
    TRY(check(kind == kWarpKind || kind == kRotationKind, [&] { return what() + ": unknown kind " + to_str(kind); }));
    TRY(index(dKindIndex[Z(d)], 0, kind == kWarpKind ? n.warps : n.rotations,
          [&] { return what() + (kind == kWarpKind ? " warp record" : " rotation record"); }));
    TRY(index(dPart[Z(d)], -1, n.parts, [&] { return what() + " owning part"; }));
    TRY(check(dParent[Z(d)] >= -1 && dParent[Z(d)] < d, [&] {
      return what() + ": parent " + to_str(dParent[Z(d)]) + " must be -1 or an earlier deformer";
    }));
    TRY(index(dBandRaw[Z(d)], 0, n.bands, [&] { return what() + " keyform binding"; }));
    dKindU8[Z(d)] = static_cast<uint8_t>(kind);
    dBand[Z(d)] = kind == kWarpKind ? warpBand[Z(dKindIndex[Z(d)])] : rotBand[Z(dKindIndex[Z(d)])];
    dEnabled[Z(d)] = I(F::deformer_enabled)[Z(d)] != 0 ? 1 : 0;
  }

  // ---- warps ----
  const auto& warpFirst = I(F::warp_firstKeyform);
  const auto& warpCount = I(F::warp_keyformCount);
  const auto& warpRows = I(F::warp_rows);
  const auto& warpCols = I(F::warp_columns);
  const auto& warpPoints = I(F::warp_pointCount);
  Vector<uint8_t> warpBilinear(Z(n.warps));
  ColorIndices warpColors = v >= 5 ? v5Colors(F::warpKeyform_multiplyColor, F::warpKeyform_screenColor) : noColors(n.warpKeyforms);
  if (v >= 5) TRY(checkColors(warpColors, "warp"));
  const auto& warpFirstPosition = I(F::warpKeyform_firstPosition);
  auto checkPositions = [&](const Vector<int32_t>& first, long long k, long long floats, auto&& what) {
    return range(first[Z(k)], floats, n.positions, [&] { return what() + " keyform " + to_str(k) + " positions"; });
  };
  for (long long w = 0; w < n.warps; w++) {
    auto what = [&] { return "warp " + to_str(w); };
    const long long R = warpRows[Z(w)];
    const long long C = warpCols[Z(w)];
    TRY(check(R >= 1 && C >= 1, [&] { return what() + ": grid of " + to_str(R) + "×" + to_str(C) + " cells"; }));
    TRY(check(warpPoints[Z(w)] == (R + 1) * (C + 1), [&] {
      return what() + ": " + to_str(warpPoints[Z(w)]) + " grid points, expected (R+1)(C+1) = " + to_str((R + 1) * (C + 1));
    }));
    TRY(keyformRange(warpBand[Z(w)], warpFirst[Z(w)], warpCount[Z(w)], n.warpKeyforms, what));
    for (long long k = warpFirst[Z(w)]; k < static_cast<long long>(warpFirst[Z(w)]) + warpCount[Z(w)]; k++)
      TRY(checkPositions(warpFirstPosition, k, 2LL * warpPoints[Z(w)], what));
    if (v >= 4) TRY(v4Colors(warpColors, warpFirst[Z(w)], warpCount[Z(w)], I(F::warp_firstColor)[Z(w)], what));
    warpBilinear[Z(w)] = v >= 2 && I(F::warp_bilinear)[Z(w)] != 0 ? 1 : 0;
  }
  if (v >= 5) TRY(checkColors(warpColors, "warp"));

  // ---- rotations ----
  const auto& rotFirst = I(F::rotation_firstKeyform);
  const auto& rotCount = I(F::rotation_keyformCount);
  ColorIndices rotColors =
      v >= 5 ? v5Colors(F::rotationKeyform_multiplyColor, F::rotationKeyform_screenColor) : noColors(n.rotationKeyforms);
  if (v >= 5) TRY(checkColors(rotColors, "rotation"));
  for (long long r = 0; r < n.rotations; r++) {
    auto what = [&] { return "rotation " + to_str(r); };
    TRY(keyformRange(rotBand[Z(r)], rotFirst[Z(r)], rotCount[Z(r)], n.rotationKeyforms, what));
    if (v >= 4) TRY(v4Colors(rotColors, rotFirst[Z(r)], rotCount[Z(r)], I(F::rotation_firstColor)[Z(r)], what));
  }
  if (v >= 5) TRY(checkColors(rotColors, "rotation"));

  // ---- art meshes ----
  const auto& mIds = s.names(F::mesh_id);
  const auto& mBand = I(F::mesh_band);
  const auto& mFirst = I(F::mesh_firstKeyform);
  const auto& mCount = I(F::mesh_keyformCount);
  const auto& mPart = I(F::mesh_part);
  const auto& mDeformer = I(F::mesh_deformer);
  const auto& mTexture = I(F::mesh_texture);
  const auto& mFlags = s.u8(F::mesh_flags);
  const auto& mVertexCount = I(F::mesh_vertexCount);
  const auto& mFirstUv = I(F::mesh_firstUv);
  const auto& mFirstTri = I(F::mesh_firstTriangleIndex);
  const auto& mTriCount = I(F::mesh_triangleIndexCount);
  const auto& mFirstMask = I(F::mesh_firstMask);
  const auto& mMaskCount = I(F::mesh_maskCount);
  const auto& uvsAll = Fl(F::uvs);
  const auto& trisAll = s.u16(F::triangleIndices);
  const auto& masksAll = I(F::maskEntries);
  for (long long e = 0; e < static_cast<long long>(masksAll.size()); e++)
    TRY(index(masksAll[Z(e)], -1, n.meshes, [&] { return "mask entry " + to_str(e); }));
  const auto& meshFirstPosition = I(F::meshKeyform_firstPosition);
  ColorIndices meshColors =
      v >= 5 ? v5Colors(F::meshKeyform_multiplyColor, F::meshKeyform_screenColor) : noColors(n.meshKeyforms);
  if (v >= 5) TRY(checkColors(meshColors, "art-mesh"));
  for (long long i = 0; i < n.meshes; i++) {
    auto what = [&] { return "art mesh " + to_str(i) + " (" + mIds[Z(i)] + ")"; };
    const long long V = mVertexCount[Z(i)];
    TRY(check(V >= 0, [&] { return what() + ": negative vertex count"; }));
    TRY(keyformRange(mBand[Z(i)], mFirst[Z(i)], mCount[Z(i)], n.meshKeyforms, what));
    TRY(index(mPart[Z(i)], -1, n.parts, [&] { return what() + " parent part"; }));
    TRY(index(mDeformer[Z(i)], -1, n.deformers, [&] { return what() + " parent deformer"; }));
    TRY(check(mTexture[Z(i)] >= 0, [&] { return what() + ": negative texture index " + to_str(mTexture[Z(i)]); }));
    TRY(range(mFirstUv[Z(i)], 2 * V, n.uvs, [&] { return what() + " UVs"; }));
    m.meshes.uvs.push_back(slice(uvsAll, mFirstUv[Z(i)], 2 * V));
    TRY(range(mFirstTri[Z(i)], mTriCount[Z(i)], n.triangleEntries, [&] { return what() + " triangles"; }));
    TRY(check(mTriCount[Z(i)] % 3 == 0, [&] {
      return what() + ": " + to_str(mTriCount[Z(i)]) + " triangle indices, not a multiple of 3";
    }));
    Vector<uint16_t> tri = slice(trisAll, mFirstTri[Z(i)], mTriCount[Z(i)]);
    for (uint16_t t : tri)
      TRY(check(t < V, [&] { return what() + ": triangle index " + to_str(t) + " ≥ vertex count " + to_str(V); }));
    m.meshes.triangles.push_back(std::move(tri));
    TRY(range(mFirstMask[Z(i)], mMaskCount[Z(i)], n.maskEntries, [&] { return what() + " masks"; }));
    Vector<int32_t> mk;
    for (long long e = mFirstMask[Z(i)]; e < static_cast<long long>(mFirstMask[Z(i)]) + mMaskCount[Z(i)]; e++)
      if (masksAll[Z(e)] != -1) mk.push_back(masksAll[Z(e)]);
    m.meshes.masks.push_back(std::move(mk));
    for (long long k = mFirst[Z(i)]; k < static_cast<long long>(mFirst[Z(i)]) + mCount[Z(i)]; k++)
      TRY(checkPositions(meshFirstPosition, k, 2 * V, what));
    if (v >= 4) TRY(v4Colors(meshColors, mFirst[Z(i)], mCount[Z(i)], I(F::mesh_firstColor)[Z(i)], what));
    const uint8_t flags = mFlags[Z(i)];
    m.meshes.blend_mode.push_back(v >= 6 ? I(F::mesh_blendMode)[Z(i)] : (flags & 1) ? 1 : (flags & 2) ? 2 : 0);
  }
  if (v >= 5) TRY(checkColors(meshColors, "art-mesh"));

  // The official level's position-run rule.
  for (long long i = 0; i < n.meshes && i < n.meshKeyforms; i++) {
    const long long end = static_cast<long long>(meshFirstPosition[Z(i)]) + 2LL * mVertexCount[Z(i)];
    TRY(check(end >= 0 && end <= n.positions, [&] {
      return "art-mesh keyform " + to_str(i) + ": start " + to_str(meshFirstPosition[Z(i)]) + " + the " +
             to_str(2LL * mVertexCount[Z(i)]) + " position floats of art mesh " + to_str(i) + " ends outside [0, " +
             to_str(n.positions) + "] (the official check rejects it)";
    }));
  }
  for (long long i = 0; i < n.warps && i < n.warpKeyforms; i++) {
    const long long end = static_cast<long long>(warpFirstPosition[Z(i)]) + 2LL * warpPoints[Z(i)];
    TRY(check(end >= 0 && end <= n.positions, [&] {
      return "warp keyform " + to_str(i) + ": start " + to_str(warpFirstPosition[Z(i)]) + " + the " +
             to_str(2LL * warpPoints[Z(i)]) + " position floats of warp " + to_str(i) + " ends outside [0, " +
             to_str(n.positions) + "] (the official check rejects it)";
    }));
  }

  // ---- glues ----
  const auto& gIds = s.names(F::glue_id);
  const auto& gBand = I(F::glue_band);
  const auto& gFirst = I(F::glue_firstKeyform);
  const auto& gCount = I(F::glue_keyformCount);
  const auto& gA = I(F::glue_meshA);
  const auto& gB = I(F::glue_meshB);
  const auto& gFirstInfo = I(F::glue_firstInfo);
  const auto& gInfoCount = I(F::glue_infoCount);
  const auto& infoWeight = Fl(F::glueInfo_weight);
  const auto& infoVertex = s.u16(F::glueInfo_vertex);
  for (long long g = 0; g < n.glues; g++) {
    auto what = [&] { return "glue " + to_str(g) + " (" + gIds[Z(g)] + ")"; };
    TRY(keyformRange(gBand[Z(g)], gFirst[Z(g)], gCount[Z(g)], n.glueKeyforms, what));
    TRY(index(gA[Z(g)], 0, n.meshes, [&] { return what() + " art mesh A"; }));
    TRY(index(gB[Z(g)], 0, n.meshes, [&] { return what() + " art mesh B"; }));
    TRY(range(gFirstInfo[Z(g)], gInfoCount[Z(g)], n.glueInfos, [&] { return what() + " glue info"; }));
    TRY(check(gInfoCount[Z(g)] % 2 == 0, [&] { return what() + ": odd glue-info count " + to_str(gInfoCount[Z(g)]); }));
    const long long pairs = gInfoCount[Z(g)] / 2;
    Vector<uint16_t> va(Z(pairs)), vb(Z(pairs));
    Vector<float> wa(Z(pairs)), wb(Z(pairs));
    for (long long i = 0; i < pairs; i++) {
      const long long e = gFirstInfo[Z(g)] + 2 * i;
      va[Z(i)] = infoVertex[Z(e)];
      wa[Z(i)] = infoWeight[Z(e)];
      vb[Z(i)] = infoVertex[Z(e + 1)];
      wb[Z(i)] = infoWeight[Z(e + 1)];
      TRY(check(va[Z(i)] < mVertexCount[Z(gA[Z(g)])], [&] { return what() + ": vertex " + to_str(va[Z(i)]) + " of mesh A out of range"; }));
      TRY(check(vb[Z(i)] < mVertexCount[Z(gB[Z(g)])], [&] { return what() + ": vertex " + to_str(vb[Z(i)]) + " of mesh B out of range"; }));
    }
    m.glues.vertex_a.push_back(std::move(va));
    m.glues.weight_a.push_back(std::move(wa));
    m.glues.vertex_b.push_back(std::move(vb));
    m.glues.weight_b.push_back(std::move(wb));
  }

  // ---- offscreens (v6) ----
  const auto& oPart = I(F::offscreen_part);
  const auto& oFirstMask = I(F::offscreen_firstMask);
  const auto& oMaskCount = I(F::offscreen_maskCount);
  for (long long o = 0; o < n.offscreens; o++) {
    auto what = [&] { return "offscreen " + to_str(o); };
    TRY(index(oPart[Z(o)], 0, n.parts, [&] { return what() + " owner part"; }));
    TRY(check(partOffscreen[Z(oPart[Z(o)])] == o, [&] { return what() + ": owner part " + to_str(oPart[Z(o)]) + " does not point back to it"; }));
    TRY(range(oFirstMask[Z(o)], oMaskCount[Z(o)], n.maskEntries, [&] { return what() + " masks"; }));
    Vector<int32_t> mk;
    for (long long e = oFirstMask[Z(o)]; e < static_cast<long long>(oFirstMask[Z(o)]) + oMaskCount[Z(o)]; e++)
      if (masksAll[Z(e)] != -1) mk.push_back(masksAll[Z(e)]);
    m.offscreens.masks.push_back(std::move(mk));
  }
  for (long long p = 0; p < n.parts; p++) {
    const long long o = partOffscreen[Z(p)];
    if (o >= 0) TRY(check(oPart[Z(o)] == p, [&] { return "part " + to_str(p) + ": offscreen " + to_str(o) + " names a different owner"; }));
  }
  // Every part keyform's offscreen keyform entry is −1 or an offscreen keyform
  // (the official level). Only normal keyforms' entries are read; −1 there gives
  // the offscreen opacity and colors 0. With load_offscreen_keyform_range, an
  // entry out of range reads as −1.
  Vector<int32_t> partOffscreenKeyform =
      v >= 6 ? I(F::partKeyform_offscreenKeyform) : Vector<int32_t>(Z(n.partKeyforms), -1);
  for (long long k = 0; k < n.partKeyforms; k++) {
    const long long ok = partOffscreenKeyform[Z(k)];
    if (options.load_offscreen_keyform_range && !(ok >= -1 && ok < n.offscreenKeyforms)) {
      m.load_warnings.push_back("part keyform " + to_str(k) + ": offscreen keyform " + to_str(ok) +
                                " is not −1 or an offscreen keyform; read as −1");
      partOffscreenKeyform[Z(k)] = -1;
      continue;
    }
    TRY(index(ok, -1, n.offscreenKeyforms, [&] { return "part keyform " + to_str(k) + " offscreen keyform"; }));
  }
  ColorIndices offscreenColors =
      v >= 6 ? v5Colors(F::offscreenKeyform_multiplyColor, F::offscreenKeyform_screenColor) : noColors(0);
  if (v >= 6) {
    const Vector<int32_t> raw = offscreenColors.multiply;
    for (long long o = 0; o < n.offscreens; o++) {
      const long long p = oPart[Z(o)];
      // (A keyform with −1, or an owner whose first keyform has −1, reads no colors.)
      const long long firstOk = partOffscreenKeyform[Z(partFirst[Z(p)])];
      if (firstOk < 0) continue;
      for (long long j = 0; j < partCount[Z(p)]; j++) {
        const long long ok = partOffscreenKeyform[Z(partFirst[Z(p)] + j)];
        if (ok < 0) continue;
        const int32_t c = text::js_to_int32(static_cast<double>(raw[Z(firstOk)]) + static_cast<double>(j));
        offscreenColors.multiply[Z(ok)] = c;
        offscreenColors.screen[Z(ok)] = c;
      }
    }
    TRY(checkColors(offscreenColors, "offscreen"));
  }

  auto blendShapeTargets = [&](F objectF, F countF, long long objects, int since) {
    Vector<uint8_t> out(Z(objects), 0);
    if (v < since) return out;
    const auto& obj = I(objectF);
    const auto& c = I(countF);
    for (std::size_t t = 0; t < obj.size(); t++)
      if (c[t] > 0 && obj[t] >= 0 && obj[t] < objects) out[Z(obj[t])] = 1;
    return out;
  };

  // ---- draw-order groups ----
  const auto& grpFirst = I(F::group_firstObject);
  const auto& grpCount = I(F::group_objectCount);
  const auto& objKind = I(F::groupObject_kind);
  const auto& objIndex = I(F::groupObject_index);
  const auto& objNested = I(F::groupObject_nestedGroup);
  TRY(check(n.groups >= 1 || n.meshes == 0, [] { return String("no draw-order groups"); }));
  for (long long i = 0; i < n.groupObjects; i++) {
    const int32_t kind = objKind[Z(i)];
    TRY(check(kind == 0 || kind == 1, [&] { return "draw-order object " + to_str(i) + ": unknown kind " + to_str(kind); }));
    TRY(index(objIndex[Z(i)], 0, kind == 0 ? n.meshes : n.parts, [&] { return "draw-order object " + to_str(i) + " index"; }));
    TRY(index(objNested[Z(i)], -1, n.groups, [&] { return "draw-order object " + to_str(i) + " child group"; }));
  }
  for (long long g = 0; g < n.groups; g++) {
    TRY(range(grpFirst[Z(g)], grpCount[Z(g)], n.groupObjects, [&] { return "draw-order group " + to_str(g) + " objects"; }));
    Vector<GroupObject> list;
    for (long long i = grpFirst[Z(g)]; i < static_cast<long long>(grpFirst[Z(g)]) + grpCount[Z(g)]; i++) {
      const int32_t kind = objKind[Z(i)];
      if (kind == 0) {
        TRY(index(objIndex[Z(i)], 0, n.meshes, [&] { return "draw-order object " + to_str(i) + " art mesh"; }));
        list.push_back({0, objIndex[Z(i)], -1});
      } else {
        TRY(index(objIndex[Z(i)], 0, n.parts, [&] { return "draw-order object " + to_str(i) + " part"; }));
        TRY(index(objNested[Z(i)], 0, n.groups, [&] { return "draw-order object " + to_str(i) + " nested group"; }));
        list.push_back({1, objIndex[Z(i)], objNested[Z(i)]});
      }
    }
    m.groups.objects.push_back(std::move(list));
  }
  if (n.groups > 0) {
    Vector<uint8_t> meshSeen(Z(n.meshes), 0), offscreenSeen(Z(n.offscreens), 0), groupState(Z(n.groups), 0);
    auto visit = [&](auto& self, long long g) -> bool {
      TRY(check(groupState[Z(g)] == 0, [&] { return "draw-order group " + to_str(g) + " is reached twice or forms a cycle"; }));
      groupState[Z(g)] = 1;
      for (const auto& o : m.groups.objects[Z(g)]) {
        if (o.kind == 0) {
          TRY(check(meshSeen[Z(o.index)] == 0, [&] { return "art mesh " + to_str(o.index) + " appears in more than one draw-order position"; }));
          meshSeen[Z(o.index)] = 1;
        } else {
          const long long off = partOffscreen[Z(o.index)];
          if (off >= 0) {
            TRY(check(offscreenSeen[Z(off)] == 0, [&] { return "offscreen " + to_str(off) + " is reached twice"; }));
            offscreenSeen[Z(off)] = 1;
          }
          TRY(self(self, o.nested_group));
        }
      }
      groupState[Z(g)] = 2;
      return true;
    };
    TRY(visit(visit, 0));
    const auto& totals = I(F::group_entryCount);
    auto total = [&](auto& self, long long g, long long& t) -> bool {
      t = 0;
      for (const auto& o : m.groups.objects[Z(g)]) {
        if (o.kind == 0) {
          t += 1;
          continue;
        }
        long long nested = 0;
        TRY(self(self, o.nested_group, nested));
        t += (partOffscreen[Z(o.index)] >= 0 ? 1 : 0) + nested;
      }
      TRY(check(totals[Z(g)] == t, [&] {
        return "draw-order group " + to_str(g) + ": total " + to_str(totals[Z(g)]) + " in the file, but it holds " +
               to_str(t) + " entries";
      }));
      return true;
    };
    long long groupTotal = 0;
    TRY(total(total, 0, groupTotal));
    const auto& gMax = I(F::group_maxDrawOrder);
    const auto& gMin = I(F::group_minDrawOrder);
    const auto& meshOrder = Fl(F::meshKeyform_drawOrder);
    const auto& partOrder = Fl(F::partKeyform_drawOrder);
    const auto meshTarget = blendShapeTargets(F::meshTarget_mesh, F::meshTarget_bindingCount, n.meshes, 4);
    const auto partTarget = blendShapeTargets(F::partTarget_part, F::partTarget_bindingCount, n.parts, 5);
    for (long long g = 0; g < n.groups; g++)
      for (const auto& o : m.groups.objects[Z(g)]) {
        const bool mesh = o.kind == 0;
        const long long first = (mesh ? mFirst : partFirst)[Z(o.index)];
        const long long count = (mesh ? mCount : partCount)[Z(o.index)];
        const auto& orders = mesh ? meshOrder : partOrder;
        const bool target = (mesh ? meshTarget : partTarget)[Z(o.index)] == 1;
        Vector<float> outside;
        const String label = mesh ? "art mesh " + mIds[Z(o.index)] : "part " + partIds[Z(o.index)];
        for (long long k = first; k < first + count; k++) {
          const float val = orders[Z(k)];
          const double order = eval::keyform_draw_order(val, target, v);
          if (order >= gMin[Z(g)] && order <= gMax[Z(g)]) continue;
          if (options.reject_draw_order_range)
            return reject(label + ": keyform draw order " + num(val) + " is outside the range [" + to_str(gMin[Z(g)]) + ", " +
                   to_str(gMax[Z(g)]) + "] of draw-order group " + to_str(g));
          outside.push_back(val);
        }
        if (!outside.empty()) {
          String list;
          for (std::size_t k = 0; k < outside.size(); k++) list += (k ? ", " : "") + num(outside[k]);
          m.load_warnings.push_back(label + ": keyform draw order" + (outside.size() > 1 ? "s" : "") + " " + list +
                                    " outside the range [" + to_str(gMin[Z(g)]) + ", " + to_str(gMax[Z(g)]) +
                                    "] of draw-order group " + to_str(g) + "; drawn by the evaluated value");
        }
      }
    for (long long i = 0; i < n.meshes; i++)
      TRY(check(meshSeen[Z(i)] == 1, [&] { return "art mesh " + to_str(i) + " (" + mIds[Z(i)] + ") is in no draw-order group"; }));
    for (long long o = 0; o < n.offscreens; o++)
      TRY(check(offscreenSeen[Z(o)] == 1, [&] { return "offscreen " + to_str(o) + " is in no draw-order group"; }));
  }

  // ---- blend shapes (v4+) ----
  auto& bs = m.blend_shapes;
  bs.warp.resize(Z(n.warps));
  bs.mesh.resize(Z(n.meshes));
  bs.part.resize(Z(n.parts));
  bs.rotation.resize(Z(n.rotations));
  bs.glue.resize(Z(n.glues));
  bs.offscreen.resize(Z(n.offscreens));
  if (v >= 4) {
    Vector<int32_t> bsOwner(Z(n.bsBindings), -1);
    const auto& pFirstBs = I(F::parameter_firstBlendShapeBinding);
    const auto& pBsCount = I(F::parameter_blendShapeBindingCount);
    for (long long p = 0; p < n.parameters; p++) {
      TRY(range(pFirstBs[Z(p)], pBsCount[Z(p)], n.bsBindings,
            [&] { return "parameter " + to_str(p) + " (" + pIds[Z(p)] + ") blend-shape bindings"; }));
      for (long long b = pFirstBs[Z(p)]; b < static_cast<long long>(pFirstBs[Z(p)]) + pBsCount[Z(p)]; b++) {
        TRY(check(bsOwner[Z(b)] == -1, [&] { return "blend-shape parameter binding " + to_str(b) + " is owned twice"; }));
        bsOwner[Z(b)] = static_cast<int32_t>(p);
      }
    }
    const auto& bsFirstKey = I(F::bsBinding_firstKey);
    const auto& bsKeyCount = I(F::bsBinding_keyCount);
    const auto& bsBase = I(F::bsBinding_baseKey);
    Vector<Vector<float>> bsKeys;
    for (long long b = 0; b < n.bsBindings; b++) {
      TRY(check(bsOwner[Z(b)] != -1, [&] { return "blend-shape parameter binding " + to_str(b) + " is not owned by any parameter"; }));
      TRY(keysAt(bsFirstKey[Z(b)], bsKeyCount[Z(b)], [&] { return "blend-shape parameter binding " + to_str(b); }, bsKeys));
      TRY(index(bsBase[Z(b)], 0, bsKeyCount[Z(b)], [&] { return "blend-shape parameter binding " + to_str(b) + " base key"; }));
    }
    const auto& conParam = I(F::constraint_parameter);
    const auto& conFirst = I(F::constraint_firstValue);
    const auto& conCount = I(F::constraint_valueCount);
    const auto& cvKey = Fl(F::constraintValue_key);
    const auto& cvWeight = Fl(F::constraintValue_weight);
    for (long long k = 0; k < n.constraints; k++) {
      auto what = [&] { return "blend-shape constraint " + to_str(k); };
      TRY(index(conParam[Z(k)], 0, n.parameters, [&] { return what() + " parameter"; }));
      TRY(range(conFirst[Z(k)], conCount[Z(k)], n.constraintValues, [&] { return what() + " values"; }));
      TRY(check(conCount[Z(k)] >= 1, [&] { return what() + ": no values"; }));
      BlendShapeConstraint con;
      con.parameter = conParam[Z(k)];
      con.keys = slice(cvKey, conFirst[Z(k)], conCount[Z(k)]);
      for (std::size_t i = 1; i < con.keys.size(); i++)
        TRY(check(con.keys[i] > con.keys[i - 1], [&] { return what() + ": keys not ascending"; }));
      con.weights = slice(cvWeight, conFirst[Z(k)], conCount[Z(k)]);
      m.constraints.push_back(std::move(con));
    }
    const auto& conIndex = I(F::constraintIndex);
    for (long long e = 0; e < n.constraintEntries; e++)
      TRY(index(conIndex[Z(e)], 0, n.constraints, [&] { return "constraint-index entry " + to_str(e); }));
    const auto& kbBinding = I(F::bsKeyformBinding_binding);
    const auto& kbFirst = I(F::bsKeyformBinding_firstKeyform);
    const auto& kbCount = I(F::bsKeyformBinding_keyformCount);
    const auto& kbConFirst = I(F::bsKeyformBinding_firstConstraintEntry);
    const auto& kbConCount = I(F::bsKeyformBinding_constraintEntryCount);
    auto keyformBinding = [&](long long i, long long keyformTotal, auto&& what, BlendShapeBinding& out) {
      TRY(index(i, 0, n.bsKeyformBindings, what));
      const long long b = kbBinding[Z(i)];
      TRY(index(b, 0, n.bsBindings, [&] { return what() + " blend-shape parameter binding"; }));
      TRY(range(kbFirst[Z(i)], kbCount[Z(i)], keyformTotal, [&] { return what() + " keyforms"; }));
      TRY(check(kbCount[Z(i)] == static_cast<long long>(bsKeys[Z(b)].size()), [&] {
        return what() + ": " + to_str(kbCount[Z(i)]) + " keyforms for " + to_str(bsKeys[Z(b)].size()) + " keys";
      }));
      TRY(range(kbConFirst[Z(i)], kbConCount[Z(i)], n.constraintEntries, [&] { return what() + " constraints"; }));
      out = BlendShapeBinding();
      for (long long e = kbConFirst[Z(i)]; e < static_cast<long long>(kbConFirst[Z(i)]) + kbConCount[Z(i)]; e++)
        out.constraints.push_back(conIndex[Z(e)]);
      out.parameter = bsOwner[Z(b)];
      out.keys = bsKeys[Z(b)];
      out.base_key = bsBase[Z(b)];
      out.first_keyform = kbFirst[Z(i)];
      return true;
    };
    auto targets = [&](F objF, F firstF, F countF, const char* objectField, long long count, long long objectCount,
                       long long keyformTotal, Vector<Vector<BlendShapeBinding>>& out,
                       auto&& after) {
      const auto& obj = I(objF);
      const auto& first = I(firstF);
      const auto& c = I(countF);
      for (long long t = 0; t < count; t++) {
        auto what = [&] { return String(objectField) + " blend-shape target " + to_str(t); };
        TRY(index(obj[Z(t)], 0, objectCount, what));
        TRY(range(first[Z(t)], c[Z(t)], n.bsKeyformBindings, [&] { return what() + " bindings"; }));
        for (long long i = first[Z(t)]; i < static_cast<long long>(first[Z(t)]) + c[Z(t)]; i++) {
          BlendShapeBinding b;
          TRY(keyformBinding(i, keyformTotal, [&] { return what() + " binding " + to_str(i); }, b));
          TRY(after(obj[Z(t)], b, what));
          out[Z(obj[Z(t)])].push_back(std::move(b));
        }
      }
      return true;
    };
    TRY(targets(F::warpTarget_warp, F::warpTarget_firstBinding, F::warpTarget_bindingCount, "warp", cnt(kWarpBlendShapeTargets),
            n.warps, n.warpKeyforms, bs.warp, [&](long long w, const BlendShapeBinding& b, const auto& what) -> bool {
              for (long long k = b.first_keyform; k < b.first_keyform + static_cast<long long>(b.keys.size()); k++)
                TRY(checkPositions(warpFirstPosition, k, 2LL * warpPoints[Z(w)], what));
              return true;
            }));
    TRY(targets(F::meshTarget_mesh, F::meshTarget_firstBinding, F::meshTarget_bindingCount, "mesh", cnt(kArtMeshBlendShapeTargets),
            n.meshes, n.meshKeyforms, bs.mesh, [&](long long mi, const BlendShapeBinding& b, const auto& what) -> bool {
              for (long long k = b.first_keyform; k < b.first_keyform + static_cast<long long>(b.keys.size()); k++)
                TRY(checkPositions(meshFirstPosition, k, 2LL * mVertexCount[Z(mi)], what));
              return true;
            }));
    if (v >= 5) {
      auto none = [](long long, const BlendShapeBinding&, const auto&) { return true; };
      // A part target's keyforms change its draw order only: their offscreen
      // keyform entries (slot 160) are not read.
      TRY(targets(F::partTarget_part, F::partTarget_firstBinding, F::partTarget_bindingCount, "part", cnt(kPartBlendShapeTargets),
              n.parts, n.partKeyforms, bs.part, none));
      TRY(targets(F::rotationTarget_rotation, F::rotationTarget_firstBinding, F::rotationTarget_bindingCount, "rotation",
              cnt(kRotationBlendShapeTargets), n.rotations, n.rotationKeyforms, bs.rotation, none));
      TRY(targets(F::glueTarget_glue, F::glueTarget_firstBinding, F::glueTarget_bindingCount, "glue", cnt(kGlueBlendShapeTargets),
              n.glues, n.glueKeyforms, bs.glue, none));
    }
    // Offscreen targets (v6, count 37): offscreen opacity and colors receive
    // blend shapes only through them, never through the owner part. Their
    // keyforms lie in the offscreen-keyform array.
    if (v >= 6)
      TRY(targets(F::offscreenTarget_offscreen, F::offscreenTarget_firstBinding, F::offscreenTarget_bindingCount, "offscreen",
                  cnt(kOffscreenBlendShapeTargets), n.offscreens, n.offscreenKeyforms, bs.offscreen,
                  [](long long, const BlendShapeBinding&, const auto&) { return true; }));
  }

  // ---- keyform opacities: NaN and ±∞ are rejected unless asked for ----
  if (!options.load_non_finite_opacity) {
    const std::pair<F, const char*> opacity[] = {{F::warpKeyform_opacity, "warp"},
                                                  {F::rotationKeyform_opacity, "rotation"},
                                                  {F::meshKeyform_opacity, "art-mesh"},
                                                  {F::offscreenKeyform_opacity, "offscreen"}};
    for (const auto& o : opacity) {
      const auto& values = Fl(o.first);
      for (std::size_t k = 0; k < values.size(); k++)
        TRY(check(std::isfinite(values[k]), [&] {
          return String(o.second) + " keyform " + to_str(k) + " opacity is " + num(values[k]) + " (not finite)";
        }));
    }
  }

  // ---- the model ----
  m.version = v;
  m.big_endian = sections.big_endian;
  m.canvas = s.canvas;
  m.parameters.ids = pIds;
  m.parameters.min = pMin;
  m.parameters.max = pMax;
  m.parameters.defaults = Fl(F::parameter_default);
  m.parameters.repeat = to_u8(I(F::parameter_repeat));
  m.parameters.type = pType;
  m.parameters.key_lists = std::move(keyLists);
  m.parameters.decimals = pDecimals;
  m.bindings.parameter = bindingParameter;
  m.bindings.keys = std::move(bindingKeys);
  for (int32_t p : bindingParameter)
    m.bindings.epsilon.push_back(p >= 0 ? eval::key_tolerance(pDecimals[Z(p)]) : eval::kKeyEpsilon);
  m.parts.ids = partIds;
  m.parts.band = partBand;
  m.parts.first_keyform = partFirst;
  m.parts.initial_opacity = partInitial;
  m.parts.enabled = partEnabled;
  m.parts.parent = partParent;
  m.parts.offscreen = partOffscreen;
  m.deformers.ids = dIds;
  m.deformers.band = dBand;
  m.deformers.enabled = dEnabled;
  m.deformers.part = dPart;
  m.deformers.parent = dParent;
  m.deformers.kind = dKindU8;
  m.deformers.kind_index = dKindIndex;
  m.warps.band = warpBand;
  m.warps.first_keyform = warpFirst;
  m.warps.rows = warpRows;
  m.warps.columns = warpCols;
  m.warps.bilinear = warpBilinear;
  m.rotations.band = rotBand;
  m.rotations.first_keyform = rotFirst;
  m.rotations.base_angle = Fl(F::rotation_baseAngle);
  m.meshes.ids = mIds;
  m.meshes.band = mBand;
  m.meshes.first_keyform = mFirst;
  m.meshes.enabled = to_u8(I(F::mesh_enabled));
  m.meshes.part = mPart;
  m.meshes.deformer = mDeformer;
  m.meshes.texture = mTexture;
  m.meshes.flags = mFlags;
  m.meshes.vertex_count = mVertexCount;
  m.glues.ids = gIds;
  m.glues.band = gBand;
  m.glues.first_keyform = gFirst;
  m.glues.mesh_a = gA;
  m.glues.mesh_b = gB;
  m.groups.min_draw_order = I(F::group_minDrawOrder);
  m.groups.max_draw_order = I(F::group_maxDrawOrder);
  m.groups.entry_count = I(F::group_entryCount);
  m.offscreens.part = oPart;
  m.offscreens.flags = s.u8(F::offscreen_flags);
  m.offscreens.blend_mode = I(F::offscreen_blendMode);
  auto& kf = m.keyforms;
  kf.part_draw_order = Fl(F::partKeyform_drawOrder);
  kf.part_offscreen_keyform = partOffscreenKeyform;
  kf.warp_opacity = Fl(F::warpKeyform_opacity);
  kf.warp_first_position = warpFirstPosition;
  kf.warp_colors = std::move(warpColors);
  kf.rotation_opacity = Fl(F::rotationKeyform_opacity);
  kf.rotation_angle = Fl(F::rotationKeyform_angle);
  kf.rotation_origin_x = Fl(F::rotationKeyform_originX);
  kf.rotation_origin_y = Fl(F::rotationKeyform_originY);
  kf.rotation_scale = Fl(F::rotationKeyform_scale);
  kf.rotation_mirror_x = to_u8(I(F::rotationKeyform_mirrorX));
  kf.rotation_mirror_y = to_u8(I(F::rotationKeyform_mirrorY));
  kf.rotation_colors = std::move(rotColors);
  kf.mesh_opacity = Fl(F::meshKeyform_opacity);
  kf.mesh_draw_order = Fl(F::meshKeyform_drawOrder);
  kf.mesh_first_position = meshFirstPosition;
  kf.mesh_colors = std::move(meshColors);
  kf.offscreen_opacity = Fl(F::offscreenKeyform_opacity);
  kf.offscreen_colors = std::move(offscreenColors);
  kf.glue_intensity = Fl(F::glueKeyform_intensity);
  m.positions = Fl(F::positions);
  return true;
}

bool sections_from_data(const MocData& data, int version, Sections& s, Vector<Diagnostic>& diags) {
  Vector<int32_t> counts;
  diags = check_shape(data, version, &counts);
  if (!diags.empty()) return false;
  s = Sections();
  s.version = version;
  s.counts = std::move(counts);
  s.data = data;
  for (std::size_t i = 0; i < kFieldCount; i++)
    if (all_fields()[i].since <= version) s.data.fields[i].present = true;
  return true;
}

bool model_from_data(const MocData& data, int version, const LoadOptions& options, Model& out,
                     Vector<Diagnostic>& write_diagnostics, Error& err) {
  write_diagnostics.clear();
  err = Error();
  Sections s;
  if (!sections_from_data(data, version, s, write_diagnostics)) return false;
  Report report(false);
  check_structure(data, version, report);
  if (report.errors()) {
    write_diagnostics = report.take();
    return false;
  }
  return build_model(s, options, out, err);
}

}  // namespace mochi2d::moc

// Port of Mochi2D's src/core/moc/structure.ts: the structural checks behind
// validate_moc and write_moc, each at its level ("official": what the
// official consistency check rejects; "strict": what Mochi2D's loader
// rejects beyond that), plus warnings.
#include <algorithm>
#include <cmath>
#include <map>
#include <unordered_map>

#include "core/eval/f32.hpp"
#include "core/moc/io.hpp"
#include "util/text.hpp"

namespace mochi2d::moc {

void Report::error(Level level, const String& code, const String& kind, const String& message,
                   std::optional<long long> index, std::optional<String> field) {
  if (level == Level::Official || strict_) {
    Diagnostic d;
    d.code = code;
    d.kind = kind;
    d.index = index;
    d.field = std::move(field);
    d.message = message;
    list.push_back(std::move(d));
  }
}

void Report::warn(const String& code, const String& kind, const String& message,
                  std::optional<long long> index, std::optional<String> field) {
  if (strict_) {
    Diagnostic d;
    d.code = code;
    d.warning = true;
    d.kind = kind;
    d.index = index;
    d.field = std::move(field);
    d.message = message;
    list.push_back(std::move(d));
  }
}

std::size_t Report::errors() const {
  std::size_t n = 0;
  for (const auto& d : list)
    if (!d.warning) n++;
  return n;
}

namespace {

constexpr Level O = Level::Official;
constexpr Level S = Level::Strict;
using text::js_number;

String num(double x) { return js_number(x); }

/** Value of a vector at i, as JavaScript reads it (an out-of-range read never happens here). */
template <class T>
long long at(const Vector<T>& v, long long i) {
  return i >= 0 && static_cast<std::size_t>(i) < v.size() ? static_cast<long long>(v[static_cast<std::size_t>(i)]) : 0;
}

struct Ctx {
  const MocData& d;
  int v;
  Report& r;

  bool is_index(long long x, long long lo, long long hi) const { return x >= lo && x < hi; }

  String ids(const char* kind, long long i) const {
    F f;
    const String k = kind;
    if (k == "parts") f = F::part_id;
    else if (k == "deformers") f = F::deformer_id;
    else if (k == "artMeshes") f = F::mesh_id;
    else if (k == "parameters") f = F::parameter_id;
    else if (k == "glues") f = F::glue_id;
    else return "";
    const auto& names = d.names(f);
    if (i >= 0 && static_cast<std::size_t>(i) < names.size()) return " (" + names[static_cast<std::size_t>(i)] + ")";
    return "";
  }
  String name(const char* kind, long long i) const { return String(kind) + "[" + to_str(i) + "]" + ids(kind, i); }

  bool index(Level level, const char* kind, long long i, const char* field, long long value, long long lo, long long hi,
             const char* target) {
    if (is_index(value, lo, hi)) return true;
    r.error(level, "index-out-of-range", kind,
            name(kind, i) + (field ? String(".") + field : "") + " = " + to_str(value) + " is out of range [" +
                to_str(lo) + ", " + to_str(hi) + ") of " + target,
            i, field ? std::optional<String>(field) : std::nullopt);
    return false;
  }

  bool range(Level level, const char* kind, long long i, const char* field, long long first, long long count,
             long long total, const String& target) {
    if (count < 0) {
      r.error(level, "negative-count", kind, name(kind, i) + ": negative count " + to_str(count) + " for " + target, i,
              String(field));
      return false;
    }
    if (count == 0) return true;
    if (first >= 0 && first + count <= total) return true;
    r.error(level, "range-out-of-bounds", kind,
            name(kind, i) + "." + field + ": [" + to_str(first) + ", " + to_str(first + count) +
                ") is out of bounds of " + target + " (0…" + to_str(total) + ")",
            i, String(field));
    return false;
  }
};

struct PositionRun {
  const char* kind;
  long long i;
  const char* keyform;
  long long k;
  long long floats;
};

}  // namespace

void check_structure(const MocData& d, int v, Report& r) {
  Ctx c{d, v, r};
  auto sz = [&](F f) { return static_cast<long long>(d.size(f)); };
  struct {
    long long parts, deformers, warps, rotations, meshes, parameters, partKeyforms, warpKeyforms, rotationKeyforms,
        meshKeyforms, positions, bindingEntries, bands, bindings, keys, uvs, triangles, masks, groups, groupObjects, glues,
        glueInfo, glueKeyforms, multiplyColors, screenColors, offscreens, offscreenKeyforms;
  } n{sz(F::part_id), sz(F::deformer_id), sz(F::warp_band), sz(F::rotation_band), sz(F::mesh_id),
      sz(F::parameter_id), sz(F::partKeyform_drawOrder), sz(F::warpKeyform_opacity), sz(F::rotationKeyform_opacity),
      sz(F::meshKeyform_opacity), sz(F::positions), sz(F::bindingIndex), sz(F::band_firstEntry),
      sz(F::binding_firstKey), sz(F::keys), sz(F::uvs), sz(F::triangleIndices), sz(F::maskEntries),
      sz(F::group_firstObject), sz(F::groupObject_kind), sz(F::glue_id), sz(F::glueInfo_weight),
      sz(F::glueKeyform_intensity), sz(F::multiplyColor_r), sz(F::screenColor_r), sz(F::offscreen_part),
      sz(F::offscreenKeyform_opacity)};

  // ---- canvas ----
  if (!(d.canvas.pixels_per_unit > 0))
    r.warn("canvas", "canvas", "canvas.pixelsPerUnit = " + num(static_cast<double>(d.canvas.pixels_per_unit)) + " is not positive",
           std::nullopt, String("pixelsPerUnit"));

  // ---- the seven 0/1 fields (official, S6) ----
  auto flags = [&](const char* kind, const char* field, F f) {
    const auto& values = d.i32(f);
    for (std::size_t i = 0; i < values.size(); i++)
      if (values[i] != 0 && values[i] != 1)
        r.error(O, "flag-value", kind,
                c.name(kind, static_cast<long long>(i)) + "." + field + " = " + to_str(values[i]) + ", but a flag is 0 or 1",
                static_cast<long long>(i), String(field));
  };
  flags("parts", "initiallyVisible", F::part_initiallyVisible);
  flags("parts", "enabled", F::part_enabled);
  flags("deformers", "visible", F::deformer_visible);
  flags("deformers", "enabled", F::deformer_enabled);
  flags("artMeshes", "visible", F::mesh_visible);
  flags("artMeshes", "enabled", F::mesh_enabled);
  flags("parameters", "repeat", F::parameter_repeat);

  // ---- parameter bindings and their keys (strict) ----
  const auto& keys = d.f32(F::keys);
  Vector<long long> bindingKeyCount(static_cast<std::size_t>(n.bindings), -1);
  auto keysOk = [&](const char* kind, long long i, const char* firstField, long long first, long long count) {
    if (!c.range(S, kind, i, firstField, first, count, n.keys, "keys")) return false;
    for (long long k = first + 1; k < first + count; k++)
      if (!(keys[static_cast<std::size_t>(k)] > keys[static_cast<std::size_t>(k - 1)])) {
        r.error(S, "keys-unsorted", kind,
                c.name(kind, i) + ": keys are not strictly ascending (" + num(static_cast<double>(keys[static_cast<std::size_t>(k - 1)])) +
                    " then " + num(static_cast<double>(keys[static_cast<std::size_t>(k)])) + ")",
                i, String(firstField));
        return false;
      }
    return true;
  };
  for (long long b = 0; b < n.bindings; b++) {
    const long long first = at(d.i32(F::binding_firstKey), b);
    const long long count = at(d.i32(F::binding_keyCount), b);
    if (count == 0) {
      r.error(S, "no-keys", "parameterBindings", "parameterBindings[" + to_str(b) + "]: has no keys", b, String("keyCount"));
      continue;
    }
    if (keysOk("parameterBindings", b, "firstKey", first, count)) bindingKeyCount[static_cast<std::size_t>(b)] = count;
  }

  // ---- parameters ----
  Vector<long long> bindingOwner(static_cast<std::size_t>(n.bindings), -1);
  for (long long p = 0; p < n.parameters; p++) {
    const float mn = d.f32(F::parameter_min)[static_cast<std::size_t>(p)];
    const float mx = d.f32(F::parameter_max)[static_cast<std::size_t>(p)];
    const float def = d.f32(F::parameter_default)[static_cast<std::size_t>(p)];
    if (mn > mx)
      r.error(S, "min-above-max", "parameters",
              c.name("parameters", p) + ": min " + num(static_cast<double>(mn)) + " > max " + num(static_cast<double>(mx)), p,
              String("min"));
    else if (def < mn || def > mx)
      r.warn("default-outside-range", "parameters",
             c.name("parameters", p) + ": default " + num(static_cast<double>(def)) + " is outside [" +
                 num(static_cast<double>(mn)) + ", " + num(static_cast<double>(mx)) + "]",
             p, String("defaultValue"));
    const long long decimals = at(d.i32(F::parameter_decimals), p);
    if (decimals < 0)
      r.error(O, "value-range", "parameters",
              c.name("parameters", p) + ".decimals = " + to_str(decimals) + " is negative (S6)", p, String("decimals"));
    const long long first = at(d.i32(F::parameter_firstBinding), p);
    const long long count = at(d.i32(F::parameter_bindingCount), p);
    if (c.range(S, "parameters", p, "firstBinding", first, count, n.bindings, "parameterBindings"))
      for (long long b = first; b < first + count; b++) {
        auto& owner = bindingOwner[static_cast<std::size_t>(b)];
        if (owner != -1)
          r.error(S, "binding-ownership", "parameterBindings",
                  "parameterBindings[" + to_str(b) + "] is owned by parameters " + to_str(owner) + " and " + to_str(p), b);
        else
          owner = p;
      }
    if (v >= 4) {
      const long long t = at(d.i32(F::parameter_type), p);
      if (t != 0 && t != 1)
        r.error(S, "parameter-type", "parameters",
                c.name("parameters", p) + ".type = " + to_str(t) + " (0 = normal, 1 = blend shape)", p, String("type"));
      c.range(S, "parameters", p, "firstKey", at(d.i32(F::parameter_firstKey), p), at(d.i32(F::parameter_keyCount), p),
              n.keys, "keys");
    }
  }
  for (long long b = 0; b < n.bindings; b++)
    if (bindingOwner[static_cast<std::size_t>(b)] == -1)
      r.error(S, "binding-ownership", "parameterBindings", "parameterBindings[" + to_str(b) + "] is owned by no parameter", b);

  // ---- bands ----
  const auto& bindingIndices = d.i32(F::bindingIndex);
  for (long long e = 0; e < n.bindingEntries; e++)
    c.index(O, "bindingIndices", e, nullptr, bindingIndices[static_cast<std::size_t>(e)], 0, n.bindings, "parameterBindings");
  Vector<double> bandKeyforms(static_cast<std::size_t>(n.bands), -1);
  for (long long b = 0; b < n.bands; b++) {
    const long long first = at(d.i32(F::band_firstEntry), b);
    const long long count = at(d.i32(F::band_entryCount), b);
    if (!c.range(S, "bands", b, "firstEntry", first, count, n.bindingEntries, "bindingIndices")) continue;
    double size = 1;
    bool ok = true;
    for (long long j = first; j < first + count; j++) {
      const long long binding = bindingIndices[static_cast<std::size_t>(j)];
      const long long keyCount = c.is_index(binding, 0, n.bindings) ? bindingKeyCount[static_cast<std::size_t>(binding)] : -1;
      if (keyCount < 0) {
        ok = false;
        break;
      }
      size *= static_cast<double>(keyCount);
    }
    if (!ok) continue;
    if (size > 2147483647.0) {
      r.error(S, "band-overflow", "bands", "bands[" + to_str(b) + "]: keyform count " + num(size) + " overflows", b);
      continue;
    }
    bandKeyforms[static_cast<std::size_t>(b)] = size;
  }
  auto keyforms = [&](const char* kind, long long i, long long band, long long first, long long count, long long total,
                      const char* target) {
    const bool bandOk = c.index(O, kind, i, "band", band, 0, n.bands, "bands");
    const bool rangeOk = c.range(S, kind, i, "firstKeyform", first, count, total, target);
    if (bandOk && bandKeyforms[static_cast<std::size_t>(band)] >= 0 &&
        static_cast<double>(count) != bandKeyforms[static_cast<std::size_t>(band)])
      r.error(S, "keyform-count", kind,
              c.name(kind, i) + ": " + to_str(count) + " keyforms, but its band's bindings need " +
                  num(bandKeyforms[static_cast<std::size_t>(band)]),
              i, String("keyformCount"));
    return rangeOk;
  };

  const long long colorsN = std::min(n.multiplyColors, n.screenColors);
  Vector<long long> warpNormal(static_cast<std::size_t>(n.warpKeyforms), -1);
  Vector<long long> rotationNormal(static_cast<std::size_t>(n.rotationKeyforms), -1);
  Vector<long long> meshNormal(static_cast<std::size_t>(n.meshKeyforms), -1);

  auto colors = [&](const char* kind, long long i, long long first, long long count, F firstColorField,
                    const char* keyformKind, F kfOpacity, F kfMultiply, F kfScreen, Vector<long long>& owner) {
    // The keyforms of [first, first + count) that exist (Mochi2D loops over the
    // whole run; bounding it to the array gives the same result without
    // billions of empty steps for a huge count).
    const long long lo = std::max(first, 0LL);
    const long long hi = std::min(first + count, static_cast<long long>(owner.size()));
    for (long long k = lo; k < hi; k++) owner[static_cast<std::size_t>(k)] = i;
    if (v < 4 || !d[firstColorField].present) return;
    const long long fc = at(d.i32(firstColorField), i);
    if (fc < 0)
      r.error(O, "index-out-of-range", kind, c.name(kind, i) + ".firstColor = " + to_str(fc) + " is negative", i,
              String("firstColor"));
    else
      c.range(O, kind, i, "firstColor", fc, count, colorsN, "the color entries");
    if (v < 5) return;
    const long long kfn = static_cast<long long>(d.size(kfOpacity));
    for (long long p = 0; p < count; p++) {
      const long long k = first + p;
      if (k < 0 || k >= kfn) break;
      const long long m = at(d.i32(kfMultiply), k);
      const long long s = at(d.i32(kfScreen), k);
      if (m != fc + p || s != fc + p)
        r.warn("color-index", keyformKind,
               String(keyformKind) + "[" + to_str(k) + "]: color indices " + to_str(m) + "/" + to_str(s) +
                   ", but the runtime uses " + c.name(kind, i) + "'s first color entry + " + to_str(p) + " = " +
                   to_str(fc + p) + " for both (C5)",
               k, String("multiplyColor"));
    }
  };
  auto keyformColorIndices = [&](const char* keyformKind, F kfMultiply, F kfScreen) {
    if (v < 5) return;
    const std::pair<const char*, std::pair<F, long long>> fields[] = {{"multiplyColor", {kfMultiply, n.multiplyColors}},
                                                                     {"screenColor", {kfScreen, n.screenColors}}};
    for (const auto& [field, fn] : fields) {
      const auto& values = d.i32(fn.first);
      const long long N = fn.second;
      for (std::size_t k = 0; k < values.size(); k++) {
        const long long x = values[k];
        if (x >= 0 && x < N) continue;
        r.error(x == N ? S : O, "index-out-of-range", keyformKind,
                String(keyformKind) + "[" + to_str(k) + "]." + field + " = " + to_str(x) + " is out of range [0, " +
                    to_str(N) + ") of the color entries" + (x == N ? " (the official check accepts N)" : ""),
                static_cast<long long>(k), String(field));
      }
    }
  };

  // ---- parts ----
  Vector<int32_t> partOffscreen =
      d[F::part_offscreen].present ? d.i32(F::part_offscreen) : Vector<int32_t>(static_cast<std::size_t>(n.parts), -1);
  for (long long p = 0; p < n.parts; p++) {
    const long long parent = at(d.i32(F::part_parent), p);
    if (c.index(O, "parts", p, "parent", parent, -1, n.parts, "parts") && !(parent < p))
      r.error(S, "parent-order", "parts", c.name("parts", p) + ".parent = " + to_str(parent) + " must be -1 or an earlier part",
              p, String("parent"));
    keyforms("parts", p, at(d.i32(F::part_band), p), at(d.i32(F::part_firstKeyform), p),
             at(d.i32(F::part_keyformCount), p), n.partKeyforms, "partKeyforms");
    if (v >= 6) c.index(S, "parts", p, "offscreen", at(partOffscreen, p), -1, n.offscreens, "offscreens");
  }

  // ---- deformers ----
  for (long long i = 0; i < n.deformers; i++) {
    const long long kind = at(d.i32(F::deformer_kind), i);
    if (kind != 0 && kind != 1)
      r.error(O, "kind", "deformers", c.name("deformers", i) + ".kind = " + to_str(kind) + " (0 = warp, 1 = rotation)", i,
              String("kind"));
    else
      c.index(O, "deformers", i, "kindIndex", at(d.i32(F::deformer_kindIndex), i), 0, kind == 0 ? n.warps : n.rotations,
              kind == 0 ? "warpDeformers" : "rotationDeformers");
    c.index(O, "deformers", i, "part", at(d.i32(F::deformer_part), i), -1, n.parts, "parts");
    const long long parent = at(d.i32(F::deformer_parent), i);
    if (c.index(O, "deformers", i, "parent", parent, -1, n.deformers, "deformers") && !(parent < i))
      r.error(S, "parent-order", "deformers",
              c.name("deformers", i) + ".parent = " + to_str(parent) + " must be -1 or an earlier deformer", i,
              String("parent"));
    const long long band = at(d.i32(F::deformer_band), i);
    if (c.index(O, "deformers", i, "band", band, 0, n.bands, "bands")) {
      const long long k = at(d.i32(F::deformer_kindIndex), i);
      const long long own = kind == 0 && c.is_index(k, 0, n.warps)       ? at(d.i32(F::warp_band), k)
                            : kind == 1 && c.is_index(k, 0, n.rotations) ? at(d.i32(F::rotation_band), k)
                                                                         : band;
      if (own != band)
        r.warn("band-mismatch", "deformers",
               c.name("deformers", i) + ".band = " + to_str(band) + ", but its " + (kind == 0 ? "warp" : "rotation") +
                   " record has band " + to_str(own) + ", which is the one evaluated",
               i, String("band"));
    }
  }

  // ---- warps ----
  Vector<PositionRun> positionRuns;
  for (long long w = 0; w < n.warps; w++) {
    const long long R = at(d.i32(F::warp_rows), w);
    const long long C = at(d.i32(F::warp_columns), w);
    const long long points = at(d.i32(F::warp_pointCount), w);
    if (!(R >= 1 && C >= 1))
      r.error(S, "grid-size", "warpDeformers",
              "warpDeformers[" + to_str(w) + "]: grid of " + to_str(R) + "×" + to_str(C) + " cells", w, String("rows"));
    if (points != (R + 1) * (C + 1))
      r.error(O, "grid-points", "warpDeformers",
              "warpDeformers[" + to_str(w) + "]: " + to_str(points) + " grid points, but (rows+1)(columns+1) = " +
                  to_str((R + 1) * (C + 1)),
              w, String("pointCount"));
    const long long first = at(d.i32(F::warp_firstKeyform), w);
    const long long count = at(d.i32(F::warp_keyformCount), w);
    if (keyforms("warpDeformers", w, at(d.i32(F::warp_band), w), first, count, n.warpKeyforms, "warpKeyforms"))
      for (long long k = first; k < first + count; k++) positionRuns.push_back({"warpDeformers", w, "warpKeyforms", k, 2 * points});
    colors("warpDeformers", w, first, count, F::warp_firstColor, "warpKeyforms", F::warpKeyform_opacity,
           F::warpKeyform_multiplyColor, F::warpKeyform_screenColor, warpNormal);
  }

  // ---- rotations ----
  for (long long i = 0; i < n.rotations; i++) {
    const long long first = at(d.i32(F::rotation_firstKeyform), i);
    const long long count = at(d.i32(F::rotation_keyformCount), i);
    keyforms("rotationDeformers", i, at(d.i32(F::rotation_band), i), first, count, n.rotationKeyforms, "rotationKeyforms");
    colors("rotationDeformers", i, first, count, F::rotation_firstColor, "rotationKeyforms", F::rotationKeyform_opacity,
           F::rotationKeyform_multiplyColor, F::rotationKeyform_screenColor, rotationNormal);
  }

  // ---- art meshes ----
  const auto& maskAll = d.i32(F::maskEntries);
  auto maskEntries = [&](const char* kind, long long i, long long first, long long count) {
    c.range(S, kind, i, "firstMask", first, count, n.masks, "maskEntries");
  };
  for (long long e = 0; e < n.masks; e++) {
    const long long m = maskAll[static_cast<std::size_t>(e)];
    if (!c.is_index(m, -1, n.meshes))
      r.error(O, "index-out-of-range", "maskEntries",
              "maskEntries[" + to_str(e) + "] = " + to_str(m) + " is not an art mesh (−1 or 0…" + to_str(n.meshes - 1) + ")",
              e);
  }
  const auto& vertexCount = d.i32(F::mesh_vertexCount);
  for (long long m = 0; m < n.meshes; m++) {
    const long long V = vertexCount[static_cast<std::size_t>(m)];
    if (V < 0)
      r.error(S, "value-range", "artMeshes", c.name("artMeshes", m) + ": negative vertex count " + to_str(V), m,
              String("vertexCount"));
    const long long first = at(d.i32(F::mesh_firstKeyform), m);
    const long long count = at(d.i32(F::mesh_keyformCount), m);
    if (keyforms("artMeshes", m, at(d.i32(F::mesh_band), m), first, count, n.meshKeyforms, "artMeshKeyforms") && V >= 0)
      for (long long k = first; k < first + count; k++) positionRuns.push_back({"artMeshes", m, "artMeshKeyforms", k, 2 * V});
    c.index(S, "artMeshes", m, "part", at(d.i32(F::mesh_part), m), -1, n.parts, "parts");
    c.index(O, "artMeshes", m, "deformer", at(d.i32(F::mesh_deformer), m), -1, n.deformers, "deformers");
    const long long texture = at(d.i32(F::mesh_texture), m);
    if (texture < 0)
      r.error(O, "texture-negative", "artMeshes", c.name("artMeshes", m) + ".texture = " + to_str(texture) + " is negative",
              m, String("texture"));
    c.range(O, "artMeshes", m, "firstUv", at(d.i32(F::mesh_firstUv), m), 2 * std::max(V, 0LL), n.uvs, "uvs");
    const long long tFirst = at(d.i32(F::mesh_firstTriangleIndex), m);
    const long long tCount = at(d.i32(F::mesh_triangleIndexCount), m);
    if (c.range(S, "artMeshes", m, "firstTriangleIndex", tFirst, tCount, n.triangles, "triangleIndices")) {
      if (tCount % 3 != 0)
        r.error(S, "triangle-count", "artMeshes",
                c.name("artMeshes", m) + ": " + to_str(tCount) + " triangle indices, not a multiple of 3", m,
                String("triangleIndexCount"));
      for (long long t = tFirst; t < tFirst + tCount; t++)
        if (d.u16(F::triangleIndices)[static_cast<std::size_t>(t)] >= V) {
          r.error(S, "triangle-index", "artMeshes",
                  c.name("artMeshes", m) + ": triangle index " + to_str(d.u16(F::triangleIndices)[static_cast<std::size_t>(t)]) +
                      " ≥ vertex count " + to_str(V),
                  m, String("firstTriangleIndex"));
          break;
        }
    }
    maskEntries("artMeshes", m, at(d.i32(F::mesh_firstMask), m), at(d.i32(F::mesh_maskCount), m));
    colors("artMeshes", m, first, count, F::mesh_firstColor, "artMeshKeyforms", F::meshKeyform_opacity,
           F::meshKeyform_multiplyColor, F::meshKeyform_screenColor, meshNormal);
  }
  keyformColorIndices("warpKeyforms", F::warpKeyform_multiplyColor, F::warpKeyform_screenColor);
  keyformColorIndices("rotationKeyforms", F::rotationKeyform_multiplyColor, F::rotationKeyform_screenColor);
  keyformColorIndices("artMeshKeyforms", F::meshKeyform_multiplyColor, F::meshKeyform_screenColor);

  // ---- glues ----
  for (long long g = 0; g < n.glues; g++) {
    keyforms("glues", g, at(d.i32(F::glue_band), g), at(d.i32(F::glue_firstKeyform), g), at(d.i32(F::glue_keyformCount), g),
             n.glueKeyforms, "glueKeyforms");
    const long long A = at(d.i32(F::glue_meshA), g);
    const long long B = at(d.i32(F::glue_meshB), g);
    const bool aOk = c.index(S, "glues", g, "artMeshA", A, 0, n.meshes, "artMeshes");
    const bool bOk = c.index(S, "glues", g, "artMeshB", B, 0, n.meshes, "artMeshes");
    const long long first = at(d.i32(F::glue_firstInfo), g);
    const long long count = at(d.i32(F::glue_infoCount), g);
    if (!c.range(S, "glues", g, "firstInfo", first, count, n.glueInfo, "glueInfo")) continue;
    if (count % 2 != 0) {
      r.error(S, "glue-pairs", "glues",
              c.name("glues", g) + ": odd glue-info count " + to_str(count) + " (2 per vertex pair)", g, String("infoCount"));
      continue;
    }
    const auto& vx = d.u16(F::glueInfo_vertex);
    for (long long e = first; e < first + count; e += 2) {
      if (aOk && vx[static_cast<std::size_t>(e)] >= vertexCount[static_cast<std::size_t>(A)])
        r.error(S, "index-out-of-range", "glueInfo",
                "glueInfo[" + to_str(e) + "].vertex = " + to_str(vx[static_cast<std::size_t>(e)]) +
                    " is not a vertex of art mesh A of " + c.name("glues", g),
                e, String("vertex"));
      if (bOk && vx[static_cast<std::size_t>(e + 1)] >= vertexCount[static_cast<std::size_t>(B)])
        r.error(S, "index-out-of-range", "glueInfo",
                "glueInfo[" + to_str(e + 1) + "].vertex = " + to_str(vx[static_cast<std::size_t>(e + 1)]) +
                    " is not a vertex of art mesh B of " + c.name("glues", g),
                e + 1, String("vertex"));
    }
  }

  // ---- offscreens (v6) ----
  Vector<int32_t> partOffscreenKeyform = d[F::partKeyform_offscreenKeyform].present
                                                  ? d.i32(F::partKeyform_offscreenKeyform)
                                                  : Vector<int32_t>(static_cast<std::size_t>(n.partKeyforms), -1);
  if (v >= 6 && d[F::offscreen_part].present && d[F::offscreenKeyform_opacity].present) {
    const auto& oPart = d.i32(F::offscreen_part);
    for (long long i = 0; i < n.offscreens; i++) {
      if (c.index(S, "offscreens", i, "part", oPart[static_cast<std::size_t>(i)], 0, n.parts, "parts") &&
          at(partOffscreen, oPart[static_cast<std::size_t>(i)]) != i)
        r.error(S, "offscreen-link", "offscreens",
                "offscreens[" + to_str(i) + "]: its part " + to_str(oPart[static_cast<std::size_t>(i)]) +
                    " does not point back to it",
                i, String("part"));
      maskEntries("offscreens", i, at(d.i32(F::offscreen_firstMask), i), at(d.i32(F::offscreen_maskCount), i));
    }
    for (long long p = 0; p < n.parts; p++) {
      const long long off = at(partOffscreen, p);
      if (c.is_index(off, 0, n.offscreens) && oPart[static_cast<std::size_t>(off)] != p)
        r.error(S, "offscreen-link", "parts",
                c.name("parts", p) + ".offscreen = " + to_str(off) + ", but that offscreen names part " +
                    to_str(oPart[static_cast<std::size_t>(off)]),
                p, String("offscreen"));
    }
    // Every part keyform's offscreen keyform entry, normal or blend-shape, of any
    // part, is −1 or an offscreen keyform (0.10.0: at both levels). Nothing else
    // about it is checked: it may name another offscreen's keyform, offscreen
    // keyforms may go unreferenced, and an owner's normal keyform may hold −1 (its
    // offscreen then reads as zeros).
    for (long long k = 0; k < n.partKeyforms; k++)
      c.index(O, "partKeyforms", k, "offscreenKeyform", partOffscreenKeyform[static_cast<std::size_t>(k)], -1,
              n.offscreenKeyforms, "offscreenKeyforms");
    const auto& okMul = d.i32(F::offscreenKeyform_multiplyColor);
    Vector<long long> okColors(okMul.begin(), okMul.end());
    Vector<long long> okScreen(d.i32(F::offscreenKeyform_screenColor).begin(), d.i32(F::offscreenKeyform_screenColor).end());
    for (long long p = 0; p < n.parts; p++) {
      if (at(partOffscreen, p) < 0) continue;
      const long long first = at(d.i32(F::part_firstKeyform), p);
      const long long count = at(d.i32(F::part_keyformCount), p);
      if (!(first >= 0 && first + count <= n.partKeyforms)) continue;
      const long long base = at(partOffscreenKeyform, first);
      for (long long j = 0; j < count; j++) {
        const long long ok = partOffscreenKeyform[static_cast<std::size_t>(first + j)];
        if (c.is_index(ok, 0, n.offscreenKeyforms) && c.is_index(base, 0, n.offscreenKeyforms)) {
          // Int32Array arithmetic: the sum wraps like a 32-bit integer.
          const int32_t sum = text::js_to_int32(static_cast<double>(okMul[static_cast<std::size_t>(base)]) + static_cast<double>(j));
          okColors[static_cast<std::size_t>(ok)] = sum;
          okScreen[static_cast<std::size_t>(ok)] = sum;
        }
      }
    }
    for (long long k = 0; k < n.offscreenKeyforms; k++) {
      c.index(S, "offscreenKeyforms", k, "multiplyColor", okColors[static_cast<std::size_t>(k)], 0, n.multiplyColors,
              "multiplyColors");
      c.index(S, "offscreenKeyforms", k, "screenColor", okScreen[static_cast<std::size_t>(k)], 0, n.screenColors,
              "screenColors");
    }
  }

  auto blendShapeTargets = [&](F objectF, F countF, long long objects) {
    Vector<uint8_t> out(static_cast<std::size_t>(objects), 0);
    if (d[objectF].present) {
      const auto& obj = d.i32(objectF);
      const auto& cnt = d.i32(countF);
      for (std::size_t i = 0; i < obj.size(); i++)
        if (cnt[i] > 0 && c.is_index(obj[i], 0, objects)) out[static_cast<std::size_t>(obj[i])] = 1;
    }
    return out;
  };
  const auto meshTarget = blendShapeTargets(F::meshTarget_mesh, F::meshTarget_bindingCount, n.meshes);
  const auto partTarget = blendShapeTargets(F::partTarget_part, F::partTarget_bindingCount, n.parts);

  // ---- draw-order groups ----
  const auto& gFirst = d.i32(F::group_firstObject);
  const auto& gCount = d.i32(F::group_objectCount);
  const auto& oKind = d.i32(F::groupObject_kind);
  const auto& oIndex = d.i32(F::groupObject_index);
  const auto& oNested = d.i32(F::groupObject_nestedGroup);
  for (long long i = 0; i < n.groupObjects; i++) {
    const long long kind = oKind[static_cast<std::size_t>(i)];
    if (kind != 0 && kind != 1)
      r.error(O, "kind", "drawOrderGroupObjects",
              "drawOrderGroupObjects[" + to_str(i) + "].kind = " + to_str(kind) + " (0 = art mesh, 1 = part)", i,
              String("kind"));
    else
      c.index(O, "drawOrderGroupObjects", i, "index", oIndex[static_cast<std::size_t>(i)], 0, kind == 0 ? n.meshes : n.parts,
              kind == 0 ? "artMeshes" : "parts");
    c.index(O, "drawOrderGroupObjects", i, "nestedGroup", oNested[static_cast<std::size_t>(i)], -1, n.groups,
            "drawOrderGroups");
  }
  if (n.groups == 0 && n.meshes > 0)
    r.error(S, "group-structure", "drawOrderGroups", "there are art meshes but no draw-order groups");
  Vector<uint8_t> groupOk(static_cast<std::size_t>(n.groups), 0);
  for (long long g = 0; g < n.groups; g++) {
    const long long first = gFirst[static_cast<std::size_t>(g)];
    const long long count = gCount[static_cast<std::size_t>(g)];
    if (!c.range(S, "drawOrderGroups", g, "firstObject", first, count, n.groupObjects, "drawOrderGroupObjects")) continue;
    bool ok = true;
    for (long long i = first; i < first + count; i++) {
      const long long kind = oKind[static_cast<std::size_t>(i)];
      if (kind == 0) {
        ok = ok && c.is_index(oIndex[static_cast<std::size_t>(i)], 0, n.meshes);
      } else if (kind == 1) {
        ok = ok && c.is_index(oIndex[static_cast<std::size_t>(i)], 0, n.parts);
        if (!c.index(S, "drawOrderGroupObjects", i, "nestedGroup", oNested[static_cast<std::size_t>(i)], 0, n.groups,
                     "drawOrderGroups"))
          ok = false;
      } else {
        ok = false;
      }
    }
    groupOk[static_cast<std::size_t>(g)] = ok ? 1 : 0;
  }
  bool allOk = n.groups > 0;
  for (auto x : groupOk) allOk = allOk && x == 1;
  if (allOk) {
    Vector<uint8_t> meshSeen(static_cast<std::size_t>(n.meshes), 0);
    Vector<uint8_t> offscreenSeen(static_cast<std::size_t>(n.offscreens), 0);
    Vector<uint8_t> state(static_cast<std::size_t>(n.groups), 0);
    Vector<double> totals(static_cast<std::size_t>(n.groups), -1);
    bool broken = false;
    auto visit = [&](auto& self, long long g) -> long long {
      if (state[static_cast<std::size_t>(g)] != 0) {
        r.error(S, "group-structure", "drawOrderGroups",
                "drawOrderGroups[" + to_str(g) + "] is reached twice or forms a cycle", g);
        broken = true;
        return 0;
      }
      state[static_cast<std::size_t>(g)] = 1;
      long long total = 0;
      const long long first = gFirst[static_cast<std::size_t>(g)];
      const long long count = gCount[static_cast<std::size_t>(g)];
      for (long long i = first; i < first + count; i++) {
        const long long idx = oIndex[static_cast<std::size_t>(i)];
        if (oKind[static_cast<std::size_t>(i)] == 0) {
          if (meshSeen[static_cast<std::size_t>(idx)])
            r.error(S, "group-structure", "artMeshes",
                    c.name("artMeshes", idx) + " appears in more than one draw-order position", idx);
          meshSeen[static_cast<std::size_t>(idx)] = 1;
          total += 1;
        } else {
          const long long off = at(partOffscreen, idx);
          if (c.is_index(off, 0, n.offscreens)) {
            if (offscreenSeen[static_cast<std::size_t>(off)])
              r.error(S, "group-structure", "offscreens", "offscreens[" + to_str(off) + "] is reached twice", off);
            offscreenSeen[static_cast<std::size_t>(off)] = 1;
            total += 1;
          }
          if (broken) return total;
          total += self(self, oNested[static_cast<std::size_t>(i)]);
        }
      }
      state[static_cast<std::size_t>(g)] = 2;
      totals[static_cast<std::size_t>(g)] = static_cast<double>(total);
      return total;
    };
    visit(visit, 0);
    if (!broken) {
      const auto& entryCount = d.i32(F::group_entryCount);
      for (long long g = 0; g < n.groups; g++)
        if (state[static_cast<std::size_t>(g)] == 2 &&
            static_cast<double>(entryCount[static_cast<std::size_t>(g)]) != totals[static_cast<std::size_t>(g)])
          r.error(S, "group-total", "drawOrderGroups",
                  "drawOrderGroups[" + to_str(g) + "].entryCount = " + to_str(entryCount[static_cast<std::size_t>(g)]) +
                      ", but the group holds " + num(totals[static_cast<std::size_t>(g)]) + " render-order entries (C6)",
                  g, String("entryCount"));
      for (long long m = 0; m < n.meshes; m++)
        if (!meshSeen[static_cast<std::size_t>(m)])
          r.error(S, "group-structure", "artMeshes", c.name("artMeshes", m) + " is in no draw-order group", m);
      for (long long o = 0; o < n.offscreens; o++)
        if (!offscreenSeen[static_cast<std::size_t>(o)])
          r.error(S, "group-structure", "offscreens", "offscreens[" + to_str(o) + "] is in no draw-order group", o);
      const auto& gMin = d.i32(F::group_minDrawOrder);
      const auto& gMax = d.i32(F::group_maxDrawOrder);
      for (long long g = 0; g < n.groups; g++) {
        if (state[static_cast<std::size_t>(g)] != 2) continue;
        const long long first = gFirst[static_cast<std::size_t>(g)];
        const long long count = gCount[static_cast<std::size_t>(g)];
        for (long long i = first; i < first + count; i++) {
          const bool mesh = oKind[static_cast<std::size_t>(i)] == 0;
          const long long idx = oIndex[static_cast<std::size_t>(i)];
          const char* kind = mesh ? "artMeshes" : "parts";
          const long long kfFirst = at(d.i32(mesh ? F::mesh_firstKeyform : F::part_firstKeyform), idx);
          const long long kfCount = at(d.i32(mesh ? F::mesh_keyformCount : F::part_keyformCount), idx);
          const auto& orders = d.f32(mesh ? F::meshKeyform_drawOrder : F::partKeyform_drawOrder);
          if (!(kfFirst >= 0 && kfFirst + kfCount <= static_cast<long long>(orders.size()))) continue;
          const bool target = (mesh ? meshTarget : partTarget)[static_cast<std::size_t>(idx)] == 1;
          Vector<float> outside;
          for (long long k = kfFirst; k < kfFirst + kfCount; k++) {
            const float o = orders[static_cast<std::size_t>(k)];
            const double order = eval::keyform_draw_order(o, target, v);
            if (!(order >= gMin[static_cast<std::size_t>(g)] && order <= gMax[static_cast<std::size_t>(g)])) outside.push_back(o);
          }
          if (!outside.empty()) {
            String list;
            for (std::size_t k = 0; k < outside.size(); k++) list += (k ? ", " : "") + num(static_cast<double>(outside[k]));
            r.warn("draw-order-range", kind,
                   c.name(kind, idx) + ": keyform draw order" + (outside.size() > 1 ? "s" : "") + " " + list +
                       " outside the range [" + to_str(gMin[static_cast<std::size_t>(g)]) + ", " +
                       to_str(gMax[static_cast<std::size_t>(g)]) + "] of drawOrderGroups[" + to_str(g) +
                       "] (drawn by the evaluated value)",
                   idx);
          }
        }
      }
    }
  }

  // ---- blend shapes (v4+) ----
  if (v >= 4) {
    const long long nBs = sz(F::bsBinding_firstKey);
    Vector<long long> bsOwner(static_cast<std::size_t>(nBs), -1);
    for (long long p = 0; p < n.parameters; p++) {
      const long long first = at(d.i32(F::parameter_firstBlendShapeBinding), p);
      const long long count = at(d.i32(F::parameter_blendShapeBindingCount), p);
      if (!c.range(S, "parameters", p, "firstBlendShapeBinding", first, count, nBs, "blendShapeParameterBindings")) continue;
      for (long long b = first; b < first + count; b++) {
        auto& owner = bsOwner[static_cast<std::size_t>(b)];
        if (owner != -1)
          r.error(S, "binding-ownership", "blendShapeParameterBindings",
                  "blendShapeParameterBindings[" + to_str(b) + "] is owned by parameters " + to_str(owner) + " and " +
                      to_str(p),
                  b);
        else
          owner = p;
      }
    }
    Vector<long long> bsKeyCount(static_cast<std::size_t>(nBs), -1);
    for (long long b = 0; b < nBs; b++) {
      if (bsOwner[static_cast<std::size_t>(b)] == -1)
        r.error(S, "binding-ownership", "blendShapeParameterBindings",
                "blendShapeParameterBindings[" + to_str(b) + "] is owned by no parameter", b);
      const long long count = at(d.i32(F::bsBinding_keyCount), b);
      if (count == 0) {
        r.error(S, "no-keys", "blendShapeParameterBindings", "blendShapeParameterBindings[" + to_str(b) + "]: has no keys",
                b, String("keyCount"));
        continue;
      }
      if (!keysOk("blendShapeParameterBindings", b, "firstKey", at(d.i32(F::bsBinding_firstKey), b), count)) continue;
      bsKeyCount[static_cast<std::size_t>(b)] = count;
      c.index(S, "blendShapeParameterBindings", b, "baseKey", at(d.i32(F::bsBinding_baseKey), b), 0, count, "its keys");
    }
    const long long nCon = sz(F::constraint_parameter);
    const auto& cvKey = d.f32(F::constraintValue_key);
    for (long long k = 0; k < nCon; k++) {
      c.index(S, "blendShapeConstraints", k, "parameter", at(d.i32(F::constraint_parameter), k), 0, n.parameters,
              "parameters");
      const long long first = at(d.i32(F::constraint_firstValue), k);
      const long long count = at(d.i32(F::constraint_valueCount), k);
      if (!c.range(S, "blendShapeConstraints", k, "firstValue", first, count, static_cast<long long>(cvKey.size()),
                   "blendShapeConstraintValues"))
        continue;
      if (count < 1) {
        r.error(S, "no-keys", "blendShapeConstraints", "blendShapeConstraints[" + to_str(k) + "]: no values", k,
                String("valueCount"));
        continue;
      }
      for (long long e = first + 1; e < first + count; e++)
        if (!(cvKey[static_cast<std::size_t>(e)] > cvKey[static_cast<std::size_t>(e - 1)])) {
          r.error(S, "keys-unsorted", "blendShapeConstraints", "blendShapeConstraints[" + to_str(k) + "]: keys not ascending",
                  k, String("firstValue"));
          break;
        }
    }
    const auto& entries = d.i32(F::constraintIndex);
    for (std::size_t e = 0; e < entries.size(); e++)
      c.index(S, "blendShapeConstraintEntries", static_cast<long long>(e), nullptr, entries[e], 0, nCon,
              "blendShapeConstraints");
    const long long nKb = sz(F::bsKeyformBinding_binding);
    auto targets = [&](const char* kind, F objF, F firstF, F countF, long long objectCount, const char* objectKind,
                       long long keyformTotal, auto&& after) {
      if (!d[objF].present) return;
      const auto& obj = d.i32(objF);
      for (long long i = 0; i < static_cast<long long>(obj.size()); i++) {
        const bool objectOk = c.index(S, kind, i, "object", obj[static_cast<std::size_t>(i)], 0, objectCount, objectKind);
        const long long first = at(d.i32(firstF), i);
        const long long count = at(d.i32(countF), i);
        if (!c.range(S, kind, i, "firstBinding", first, count, nKb, "blendShapeKeyformBindings")) continue;
        for (long long b = first; b < first + count; b++) {
          const long long pb = at(d.i32(F::bsKeyformBinding_binding), b);
          const bool pbOk = c.index(S, "blendShapeKeyformBindings", b, "parameterBinding", pb, 0, nBs,
                                    "blendShapeParameterBindings");
          const long long kFirst = at(d.i32(F::bsKeyformBinding_firstKeyform), b);
          const long long kCount = at(d.i32(F::bsKeyformBinding_keyformCount), b);
          const bool kOk = c.range(S, "blendShapeKeyformBindings", b, "firstKeyform", kFirst, kCount, keyformTotal,
                                   String("the ") + objectKind + " keyforms");
          if (pbOk && bsKeyCount[static_cast<std::size_t>(pb)] >= 0 && kCount != bsKeyCount[static_cast<std::size_t>(pb)])
            r.error(S, "keyform-count", "blendShapeKeyformBindings",
                    "blendShapeKeyformBindings[" + to_str(b) + "]: " + to_str(kCount) + " keyforms for " +
                        to_str(bsKeyCount[static_cast<std::size_t>(pb)]) + " keys",
                    b, String("keyformCount"));
          c.range(S, "blendShapeKeyformBindings", b, "firstConstraintEntry",
                  at(d.i32(F::bsKeyformBinding_firstConstraintEntry), b), at(d.i32(F::bsKeyformBinding_constraintEntryCount), b),
                  static_cast<long long>(entries.size()), "blendShapeConstraintEntries");
          if (objectOk && kOk) after(obj[static_cast<std::size_t>(i)], kFirst, kCount);
        }
      }
    };
    targets("warpBlendShapeTargets", F::warpTarget_warp, F::warpTarget_firstBinding, F::warpTarget_bindingCount, n.warps,
            "warpDeformers", n.warpKeyforms, [&](long long w, long long first, long long count) {
              for (long long k = first; k < first + count; k++)
                positionRuns.push_back({"warpDeformers", w, "warpKeyforms", k, 2 * at(d.i32(F::warp_pointCount), w)});
            });
    targets("artMeshBlendShapeTargets", F::meshTarget_mesh, F::meshTarget_firstBinding, F::meshTarget_bindingCount,
            n.meshes, "artMeshes", n.meshKeyforms, [&](long long m, long long first, long long count) {
              for (long long k = first; k < first + count; k++)
                if (vertexCount[static_cast<std::size_t>(m)] >= 0)
                  positionRuns.push_back({"artMeshes", m, "artMeshKeyforms", k, 2LL * vertexCount[static_cast<std::size_t>(m)]});
            });
    if (v >= 5) {
      // A part target's keyforms change its draw order only: their offscreen
      // keyform entries are not read.
      targets("partBlendShapeTargets", F::partTarget_part, F::partTarget_firstBinding, F::partTarget_bindingCount, n.parts,
              "parts", n.partKeyforms, [&](long long, long long, long long) {});
      targets("rotationBlendShapeTargets", F::rotationTarget_rotation, F::rotationTarget_firstBinding,
              F::rotationTarget_bindingCount, n.rotations, "rotationDeformers", n.rotationKeyforms,
              [&](long long, long long, long long) {});
      targets("glueBlendShapeTargets", F::glueTarget_glue, F::glueTarget_firstBinding, F::glueTarget_bindingCount, n.glues,
              "glues", n.glueKeyforms, [&](long long, long long, long long) {});
    }
    // v6: offscreen targets, whose keyforms are offscreen keyforms (count 37).
    if (v >= 6)
      targets("offscreenBlendShapeTargets", F::offscreenTarget_offscreen, F::offscreenTarget_firstBinding,
              F::offscreenTarget_bindingCount, n.offscreens, "offscreens", n.offscreenKeyforms,
              [&](long long, long long, long long) {});
  }

  // ---- keyform positions ----
  auto officialRuns = [&](const char* keyformKind, F startsF, const char* objectKind, long long objects,
                          auto&& length) {
    const auto& starts = d.i32(startsF);
    for (long long i = 0; i < objects && i < static_cast<long long>(starts.size()); i++) {
      const long long s = starts[static_cast<std::size_t>(i)];
      const long long L = length(i);
      const long long end = s + L;
      if (end >= 0 && end <= n.positions) continue;
      r.error(O, "position-run", keyformKind,
              String(keyformKind) + "[" + to_str(i) + "].firstPosition = " + to_str(s) +
                  ": the official level tests keyform " + to_str(i) + " with the run length " + to_str(L) + " of " +
                  c.name(objectKind, i) + ", and " + to_str(s) + " + " + to_str(L) + " = " + to_str(end) +
                  " is outside [0, " + to_str(n.positions) + "]",
              i, String("firstPosition"));
    }
  };
  officialRuns("artMeshKeyforms", F::meshKeyform_firstPosition, "artMeshes", n.meshes,
               [&](long long i) { return 2LL * vertexCount[static_cast<std::size_t>(i)]; });
  officialRuns("warpKeyforms", F::warpKeyform_firstPosition, "warpDeformers", n.warps,
               [&](long long i) { return 2 * at(d.i32(F::warp_pointCount), i); });
  for (const auto& run : positionRuns) {
    if (run.floats <= 0) continue;
    const auto& fp = d.i32(String(run.keyform) == "warpKeyforms" ? F::warpKeyform_firstPosition : F::meshKeyform_firstPosition);
    if (run.k < 0 || run.k >= static_cast<long long>(fp.size())) continue;
    const long long first = fp[static_cast<std::size_t>(run.k)];
    if (!(first >= 0 && first + run.floats <= n.positions))
      r.error(S, "range-out-of-bounds", run.keyform,
              String(run.keyform) + "[" + to_str(run.k) + "].firstPosition: [" + to_str(first) + ", " +
                  to_str(first + run.floats) + ") (of " + c.name(run.kind, run.i) +
                  ") is out of bounds of keyformPositions (0…" + to_str(n.positions) + ")",
              run.k, String("firstPosition"));
  }
  long long nonFinite = 0;
  long long firstNonFinite = -1;
  const auto& pos = d.f32(F::positions);
  for (std::size_t i = 0; i < pos.size(); i++)
    if (!std::isfinite(pos[i])) {
      if (firstNonFinite < 0) firstNonFinite = static_cast<long long>(i);
      nonFinite++;
    }
  if (nonFinite)
    r.warn("position-value", "keyformPositions",
           "keyformPositions holds " + to_str(nonFinite) + " non-finite value" + (nonFinite > 1 ? "s" : "") +
               ", the first at " + to_str(firstNonFinite),
           firstNonFinite);

  // Non-finite keyform opacities pass the official level (Mochi2D Native's loader rejects them by default).
  const std::pair<const char*, F> opacityKinds[] = {{"warpKeyforms", F::warpKeyform_opacity},
                                                     {"rotationKeyforms", F::rotationKeyform_opacity},
                                                     {"artMeshKeyforms", F::meshKeyform_opacity},
                                                     {"offscreenKeyforms", F::offscreenKeyform_opacity}};
  for (const auto& ok : opacityKinds) {
    if (!d[ok.second].present) continue;
    const auto& values = d.f32(ok.second);
    for (std::size_t k = 0; k < values.size(); k++)
      if (!std::isfinite(values[k]))
        r.error(S, "opacity-value", ok.first,
                String(ok.first) + "[" + to_str(k) + "].opacity = " + num(static_cast<double>(values[k])) +
                    " is not finite (the official check accepts it)",
                static_cast<long long>(k), String("opacity"));
  }

  // ---- duplicate IDs ----
  const std::pair<const char*, F> idKinds[] = {{"parts", F::part_id},
                                                {"deformers", F::deformer_id},
                                                {"artMeshes", F::mesh_id},
                                                {"parameters", F::parameter_id},
                                                {"glues", F::glue_id}};
  for (const auto& [kind, f] : idKinds) {
    HashMap<String, std::size_t> seen;
    const auto& list = d.names(f);
    for (std::size_t i = 0; i < list.size(); i++) {
      auto it = seen.find(list[i]);
      if (it != seen.end())
        r.warn("duplicate-id", kind,
               String(kind) + "[" + to_str(i) + "] has the ID \"" + list[i] + "\" of " + kind + "[" +
                   to_str(it->second) + "] (an ID lookup finds the first)",
               static_cast<long long>(i), String("ids"));
      else
        seen.emplace(list[i], i);
    }
  }
}

}  // namespace mochi2d::moc

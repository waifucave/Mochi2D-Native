#include "core/moc/schema.hpp"

#include <algorithm>
#include <cstring>

namespace mochi2d::moc {

namespace {

const FieldSpec kFields[] = {
#define MOCHI2D_X(id, key, slot, type, count, since, group, field) \
  {F::id, key, slot, ElementType::type, count, since, group, field},
    MOCHI2D_MOC_FIELDS(MOCHI2D_X)
#undef MOCHI2D_X
};

const char* const kCountNames[] = {
    "parts", "deformers", "warp deformers", "rotation deformers", "art meshes", "parameters",
    "part keyforms", "warp keyforms", "rotation keyforms", "art-mesh keyforms",
    "keyform position floats", "binding-index entries", "keyform bindings", "parameter bindings",
    "key values", "UV floats", "triangle-index entries", "mask entries", "draw-order groups",
    "draw-order group objects", "glues", "glue-info entries", "glue keyforms",
    "multiply-color entries", "screen-color entries", "blend-shape parameter bindings",
    "blend-shape keyform bindings", "warp blend-shape targets", "art-mesh blend-shape targets",
    "blend-shape constraint-index entries", "blend-shape constraints",
    "blend-shape constraint values", "part blend-shape targets", "rotation blend-shape targets",
    "glue blend-shape targets", "offscreens", "offscreen keyforms", "unknown v6 group",
};

// The group table is built once, in fixed arrays: it allocates nothing.
constexpr std::size_t kMaxGroups = 48;
constexpr std::size_t kMaxGroupFields = 32;

struct GroupTable {
  F fields[kMaxGroups][kMaxGroupFields] = {};
  GroupSpec groups[kMaxGroups] = {};
  std::size_t count = 0;
  GroupTable() {
    const char* names[kMaxGroups] = {};
    for (const auto& f : kFields) {
      if (!f.group) continue;
      bool seen = false;
      for (std::size_t g = 0; g < count; g++) seen = seen || std::strcmp(names[g], f.group) == 0;
      if (!seen) names[count++] = f.group;
    }
    for (std::size_t g = 0; g < count; g++) {
      Count c = kParts;
      int since = 1000;
      bool pool = false;
      std::size_t n = 0;
      for (const auto& f : kFields) {
        if (!f.group || std::strcmp(f.group, names[g]) != 0) continue;
        fields[g][n++] = f.id;
        c = f.count;
        since = std::min(since, f.since);
        pool = f.field == nullptr;
      }
      groups[g] = GroupSpec{names[g], c, pool, fields[g], n, since};
    }
    // Count-table order (MOC_DATA_GROUPS); an insertion sort is stable.
    for (std::size_t a = 1; a < count; a++)
      for (std::size_t b = a; b > 0 && groups[b].count < groups[b - 1].count; b--) std::swap(groups[b], groups[b - 1]);
  }
};

const GroupTable& table() {
  static const GroupTable t;
  return t;
}

}  // namespace

const char* count_name(int index) {
  if (index < 0 || index >= kCountKinds) return "count";
  return kCountNames[index];
}

const FieldSpec& spec(F f) { return kFields[static_cast<std::size_t>(f)]; }
const FieldSpec* all_fields() { return kFields; }

const GroupSpec* groups(std::size_t& count) {
  count = table().count;
  return table().groups;
}

const GroupSpec* group_by_name(const char* name) {
  for (std::size_t g = 0; g < table().count; g++)
    if (std::strcmp(table().groups[g].name, name) == 0) return &table().groups[g];
  return nullptr;
}

}  // namespace mochi2d::moc

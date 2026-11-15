#include "framework/pose.hpp"

namespace mochi2d::framework {

bool parse_pose(std::string_view bytes, std::string_view label, PoseFile& out, FormatError& error) {
  json::Value json;
  if (!parse_json(bytes, label, json, error)) return false;
  return pose_from_json(json, label, out, error);
}

bool pose_from_json(const json::Value& json, std::string_view label, PoseFile& out, FormatError& error) {
  if (!json.is_object()) {
    error.message = String(label.data(), label.size()) + ": not a JSON object";
    return false;
  }
  out = PoseFile();
  out.label = String(label.data(), label.size());
  const auto f = opt_num(member(&json, "FadeInTime"));
  out.fade = !f || *f < 0 ? 0.5 : *f;
  for (const auto& g : arr(member(&json, "Groups"))) {
    Vector<PoseEntry> group;
    for (const auto& e : arr(&g)) {
      PoseEntry entry;
      entry.id = str(member(&e, "Id"));
      for (const auto& x : arr(member(&e, "Link")))
        if (x.is_string()) entry.links.push_back(x.as_string());
      group.push_back(std::move(entry));
    }
    out.groups.push_back(std::move(group));
  }
  return true;
}

void PoseRig::frame(double dt) {
  AnimationValues& v = *values_;
  const auto& groups = file_->groups;
  if (!initialized_) {
    initialized_ = true;
    for (const auto& group : groups)
      for (std::size_t j = 0; j < group.size(); j++) {
        const PoseEntry& e = group[j];
        v.set(e.id, 1);
        v.set_part_opacity(e.id, j == 0 ? 1 : 0);
        v.set(e.id, j == 0 ? 1 : 0);
        for (const auto& link : e.links) v.set(link, 1);
      }
  }
  const double step = dt < 0 ? 0 : dt;
  const double F = file_->fade;
  for (const auto& group : groups) {
    if (group.empty()) continue;
    std::size_t visible = group.size();
    for (std::size_t j = 0; j < group.size(); j++)
      if (v.get(group[j].id) > 0.001) {
        visible = j;
        break;
      }
    double o;
    if (visible == group.size()) {
      visible = 0;
      o = 1;
    } else {
      o = F == 0 ? 1 : js_min(1, v.part_opacity(group[visible].id) + step / F);
    }
    for (std::size_t j = 0; j < group.size(); j++) {
      if (j == visible) continue;
      double a = 1 - o;
      if ((1 - a) * (1 - o) > 0.15) a = 1 - 0.15 / (1 - o);
      v.set_part_opacity(group[j].id, js_min(v.part_opacity(group[j].id), a));
    }
    v.set_part_opacity(group[visible].id, o);
  }
  for (const auto& group : groups)
    for (const auto& e : group) {
      const double op = v.part_opacity(e.id);
      for (const auto& link : e.links) v.set_part_opacity(link, op);
    }
}

}  // namespace mochi2d::framework

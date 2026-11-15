#include "framework/model_data.hpp"

#include <limits>

#include "util/text.hpp"

namespace mochi2d::framework {

Bounds vertex_bounds(const float* v, std::size_t length) {
  const double inf = std::numeric_limits<double>::infinity();
  Bounds b{inf, inf, -inf, -inf};
  for (std::size_t i = 0; i + 1 < length; i += 2) {
    const double x = v[i];
    const double y = v[i + 1];
    if (x < b.min_x) b.min_x = x;
    if (x > b.max_x) b.max_x = x;
    if (y < b.min_y) b.min_y = y;
    if (y > b.max_y) b.max_y = y;
  }
  return b;
}

bool hit_test(const float* vertices, std::size_t length, double x, double y) {
  const Bounds b = vertex_bounds(vertices, length);
  return b.min_x <= x && x <= b.max_x && b.min_y <= y && y <= b.max_y;
}

bool parse_user_data(std::string_view bytes, std::string_view label, UserData& out, FormatError& error) {
  json::Value json;
  if (!parse_json(bytes, label, json, error)) return false;
  return user_data_from_json(json, label, out, error);
}

bool user_data_from_json(const json::Value& json, std::string_view label, UserData& out, FormatError& error) {
  const String lbl(label.data(), label.size());
  if (!json.is_object()) {
    error.message = lbl + ": not a JSON object";
    return false;
  }
  const auto& list = arr(member(&json, "UserData"));
  const double count = num(member(member(&json, "Meta"), "UserDataCount"), static_cast<double>(list.size()));
  if (count > static_cast<double>(list.size())) {
    error.message = lbl + ": UserDataCount " + text::js_number(count) + " exceeds the " + to_str(list.size()) +
                    " entries";
    return false;
  }
  // list.slice(0, Math.max(0, count)): a fractional count is truncated.
  const double take = js_max(0, count);
  const std::size_t n = std::isnan(take) ? 0 : static_cast<std::size_t>(std::trunc(take));
  out = UserData();
  for (std::size_t i = 0; i < n && i < list.size(); i++) {
    const json::Value* e = &list[i];
    out.all.push_back({str(member(e, "Target")), str(member(e, "Id")), str(member(e, "Value"))});
  }
  for (const auto& e : out.all)
    if (e.target == "ArtMesh") out.art_meshes.push_back(e);
  return true;
}

bool parse_display_info(std::string_view bytes, std::string_view label, DisplayInfo& out, FormatError& error) {
  json::Value json;
  if (!parse_json(bytes, label, json, error)) return false;
  return display_info_from_json(json, label, out, error);
}

bool display_info_from_json(const json::Value& json, std::string_view label, DisplayInfo& out, FormatError& error) {
  if (!json.is_object()) {
    error.message = String(label.data(), label.size()) + ": not a JSON object";
    return false;
  }
  out = DisplayInfo();
  auto entries = [](const json::Value* v, Vector<DisplayEntry>& into) {
    for (const auto& e : arr(v)) into.push_back({str(member(&e, "Id")), str(member(&e, "GroupId")), str(member(&e, "Name"))});
  };
  entries(member(&json, "Parameters"), out.parameters);
  entries(member(&json, "ParameterGroups"), out.parameter_groups);
  for (const auto& e : arr(member(&json, "Parts"))) out.parts.push_back({str(member(&e, "Id")), String(), str(member(&e, "Name"))});
  for (const auto& p : arr(member(&json, "CombinedParameters"))) {
    const auto& pair = arr(&p);
    if (pair.size() == 2 && pair[0].is_string() && pair[1].is_string())
      out.combined_parameters.emplace_back(pair[0].as_string(), pair[1].as_string());
  }
  return true;
}

Vector<DisplayLabel> display_labels(const Vector<String>& model_ids, const DisplayInfo* info, DisplayKind kind) {
  Vector<DisplayLabel> labels;
  if (!info) {
    for (std::size_t i = 0; i < model_ids.size(); i++) labels.push_back({model_ids[i], model_ids[i], std::nullopt, i});
    return labels;
  }
  struct Name {
    String name, group_id;
  };
  HashMap<String, Name> names;
  const Vector<DisplayEntry>& list = kind == DisplayKind::Parameters ? info->parameters : info->parts;
  for (const auto& e : list) names.emplace(e.id, Name{e.name, kind == DisplayKind::Parameters ? e.group_id : String()});
  // Groups by ID (first entry wins), and their names in file order.
  HashMap<String, String> groups;
  Vector<String> group_names;
  for (const auto& g : info->parameter_groups)
    if (groups.emplace(g.id, g.name.empty() ? g.id : g.name).second) group_names.push_back(g.name.empty() ? g.id : g.name);
  for (std::size_t i = 0; i < model_ids.size(); i++) {
    const String& id = model_ids[i];
    const auto n = names.find(id);
    std::optional<String> group;
    if (n != names.end() && !n->second.group_id.empty()) {
      const auto g = groups.find(n->second.group_id);
      if (g != groups.end()) group = g->second;
    }
    labels.push_back({id, n != names.end() && !n->second.name.empty() ? n->second.name : id, std::move(group), i});
  }
  if (kind == DisplayKind::Parts) return labels;
  // Top level first, then groups in file order; model order inside each.
  HashMap<String, int> order;
  for (std::size_t i = 0; i < group_names.size(); i++) order.emplace(group_names[i], static_cast<int>(i));
  auto rank = [&](const DisplayLabel& l) { return l.group ? order.find(*l.group)->second : -1; };
  Vector<std::pair<int, std::size_t>> keys;
  for (std::size_t i = 0; i < labels.size(); i++) keys.emplace_back(rank(labels[i]), i);
  stable_sort(keys, [](const std::pair<int, std::size_t>& a, const std::pair<int, std::size_t>& b) {
    return a.first < b.first || (a.first == b.first && a.second < b.second);
  });
  Vector<DisplayLabel> sorted;
  for (const auto& k : keys) sorted.push_back(labels[k.second]);
  return sorted;
}

}  // namespace mochi2d::framework

#include "framework/settings.hpp"

#include "framework/jsutil.hpp"
#include "util/text.hpp"

namespace mochi2d::framework {

namespace {

constexpr const char* kLayoutKeys[] = {"width", "height", "x", "y", "center_x", "center_y", "top", "bottom", "left", "right"};

}  // namespace

const MotionGroup* ModelSettings::motion_group(std::string_view name) const {
  for (const auto& g : motions)
    if (g.group == name) return &g;
  return nullptr;
}

bool parse_model_settings(std::string_view bytes, const String& label, ModelSettings& s, String& error) {
  json::Value v;
  FormatError err;
  if (!parse_json(bytes, label, v, err)) {
    error = err.message;
    return false;
  }
  return settings_from_json(std::move(v), label, s, error);
}

bool settings_from_json(json::Value v, const String& label, ModelSettings& s, String& error) {
  auto fail = [&](const char* m) {
    error = label + m;
    return false;
  };
  if (!v.is_object()) return fail(": not a JSON object");
  const json::Value* r = v.get("FileReferences");
  if (!r || !r->is_object()) return fail(": no FileReferences object");
  const json::Value* moc = r->get("Moc");
  if (!moc || !moc->is_string() || moc->as_string().empty()) return fail(": FileReferences.Moc is missing");
  const json::Value* textures = r->get("Textures");
  if (textures) {
    bool ok = textures->is_array();
    if (ok)
      for (const auto& x : textures->items()) ok = ok && x.is_string();
    if (!ok) return fail(": FileReferences.Textures must be a list of strings");
  }
  ModelSettings out;
  out.moc = moc->as_string();
  if (textures)
    for (const auto& x : textures->items()) out.textures.push_back(x.as_string());
  if (const json::Value* list = r->get("Expressions"); list && list->is_array())
    for (const auto& e : list->items()) {
      const json::Value* file = member(&e, "File");
      if (!e.is_object() || !file || !file->is_string()) continue;
      const json::Value* name = member(&e, "Name");
      out.expressions.push_back({name && name->is_string() ? name->as_string() : file->as_string(), file->as_string()});
    }
  if (const json::Value* motions = r->get("Motions"); motions && motions->is_object())
    for (const auto* m : motions->entries_js_order()) {
      MotionGroup group;
      group.group = m->first;
      if (m->second.is_array())
        for (const auto& e : m->second.items()) {
          const json::Value* file = member(&e, "File");
          if (!e.is_object() || !file || !file->is_string()) continue;
          MotionEntry entry;
          entry.file = file->as_string();
          entry.fade_in_time = opt_num(member(&e, "FadeInTime"));
          entry.fade_out_time = opt_num(member(&e, "FadeOutTime"));
          entry.sound = str(member(&e, "Sound"));
          entry.motion_sync = str(member(&e, "MotionSync"));
          group.entries.push_back(std::move(entry));
        }
      out.motions.push_back(std::move(group));
    }
  if (const json::Value* groups = v.get("Groups"); groups && groups->is_array())
    for (const auto& g : groups->items()) {
      if (!g.is_object()) continue;
      ParameterGroup pg;
      pg.target = str(member(&g, "Target"));
      pg.name = str(member(&g, "Name"));
      for (const auto& x : arr(member(&g, "Ids")))
        if (x.is_string()) pg.ids.push_back(x.as_string());
      out.groups.push_back(std::move(pg));
    }
  if (const json::Value* areas = v.get("HitAreas"); areas && areas->is_array())
    for (const auto& h : areas->items()) {
      const json::Value* id = member(&h, "Id");
      if (!h.is_object() || !id || !id->is_string()) continue;
      out.hit_areas.push_back({id->as_string(), str(member(&h, "Name"))});
    }
  if (const json::Value* layout = v.get("Layout"); layout && layout->is_object())
    for (const char* k : kLayoutKeys)
      if (const auto x = opt_num(layout->get(k))) out.layout.emplace_back(k, *x);
  auto optional = [&](const char* k) {
    const json::Value* x = r->get(k);
    return x && x->is_string() ? x->as_string() : String();
  };
  out.physics = optional("Physics");
  out.pose = optional("Pose");
  out.user_data = optional("UserData");
  out.display_info = optional("DisplayInfo");
  out.motion_sync = optional("MotionSync");
  out.raw = std::move(v);
  s = std::move(out);
  return true;
}

Vector<String> parameter_group_ids(const ModelSettings& settings, std::string_view name) {
  for (const auto& g : settings.groups)
    if (g.name == name) return g.ids;
  return {};
}

bool normalize_path(std::string_view path, String& result) {
  Vector<String> parts;
  String seg;
  auto flush = [&] {
    bool ok = true;
    if (seg.empty() || seg == ".") {
    } else if (seg == "..") {
      if (parts.empty())
        ok = false;  // escapes the root
      else
        parts.pop_back();
    } else {
      parts.push_back(seg);
    }
    seg.clear();
    return ok;
  };
  for (char c : path) {
    if (c == '/' || c == '\\') {
      if (!flush()) return false;
    } else {
      seg.push_back(c);
    }
  }
  if (!flush()) return false;
  result.clear();
  for (std::size_t i = 0; i < parts.size(); i++) result += (i ? "/" : "") + parts[i];
  return true;
}

}  // namespace mochi2d::framework

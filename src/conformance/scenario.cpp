#include "conformance/scenario.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <set>

#include "conformance/formats.hpp"
#include "core/moc/data.hpp"
#include "util/text.hpp"

namespace mochi2d::conformance {

namespace fs = std::filesystem;
using json::Value;

#ifndef MOCHI2D_VERSION
#define MOCHI2D_VERSION "0.3.0"
#endif

String producer_id() { return String("mochi2d-native@") + MOCHI2D_VERSION; }

String path_text(const fs::path& p) { return to_lib(p.u8string()); }

bool read_file(const fs::path& p, String& out) {
  std::error_code ec;
  if (!fs::is_regular_file(p, ec)) return false;
  std::FILE* f = std::fopen(p.u8string().c_str(), "rb");
  if (!f) return false;
  out.clear();
  char buf[65536];
  std::size_t n;
  while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
  const bool ok = !std::ferror(f);
  std::fclose(f);
  return ok;
}

namespace {

bool id_char(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
}

}  // namespace

String known_format(const Value* format) {
  if (!format || !format->is_string()) return "";
  String name = format->as_string();
  if (name.rfind("lively2d-", 0) == 0) name = "mochi2d-" + name.substr(9);
  // /^([A-Za-z0-9._-]+)\/(\d+)(?:\.\d+)*$/
  const auto slash = name.find('/');
  if (slash == String::npos || slash == 0) return "";
  for (std::size_t i = 0; i < slash; i++)
    if (!id_char(name[i])) return "";
  std::size_t i = slash + 1;
  const std::size_t major_start = i;
  while (i < name.size() && name[i] >= '0' && name[i] <= '9') i++;
  if (i == major_start) return "";
  String major = name.substr(major_start, i - major_start);
  while (i < name.size()) {
    if (name[i] != '.') return "";
    const std::size_t d = ++i;
    while (i < name.size() && name[i] >= '0' && name[i] <= '9') i++;
    if (i == d) return "";
  }
  while (major.size() > 1 && major[0] == '0') major.erase(0, 1);  // Number("007") is 7
  const String key = name.substr(0, slash) + "/" + major;
  for (const char* k : {"mochi2d-scenario/0", "mochi2d-sequence/0", "mochi2d-anim-scenario/0"})
    if (key == k) return key;
  return "";
}

bool valid_id(std::string_view id) {
  if (id.empty() || id.size() > 200) return false;
  for (char c : id)
    if (!id_char(c)) return false;
  return true;
}

namespace {

bool is_integer(double x) { return std::isfinite(x) && std::trunc(x) == x; }

}  // namespace

String json_text(const Value* v) { return v ? json::write_compact(*v) : String("undefined"); }

bool number_record(const Value* v, std::string_view field, Vector<std::pair<String, double>>& out, String& error) {
  out.clear();
  if (!v) return true;
  const String f(field.data(), field.size());
  if (!v->is_object()) {
    error = "\"" + f + "\" must be an object";
    return false;
  }
  for (const auto* m : v->entries_js_order()) {
    if (!m->second.is_number() || !std::isfinite(m->second.as_number())) {
      error = "\"" + f + "." + m->first + "\" must be a finite number";
      return false;
    }
    // out[k] = n on a plain object: "__proto__" is the prototype setter, which ignores numbers.
    if (m->first == "__proto__") continue;
    out.emplace_back(m->first, m->second.as_number());
  }
  return true;
}

bool parse_scenario(const Value& o, Scenario& sc, String& error) {
  auto fail = [&](const String& m) {
    error = m;
    return false;
  };
  if (!o.is_object()) return fail("scenario must be a JSON object");
  if (known_format(o.get("format")) != "mochi2d-scenario/0")
    return fail(String("\"format\" must be \"mochi2d-scenario/0\" (got ") + json_text(o.get("format")) + ")");
  const Value* id = o.get("id");
  if (!id || !id->is_string() || !valid_id(id->as_string()))
    return fail("\"id\" must match /^[A-Za-z0-9._-]{1,200}$/ (it is used as a file name)");
  const Value* builtin = o.get("x-builtinScene");
  if (builtin && !builtin->is_string()) return fail("\"x-builtinScene\" must be a string");
  const Value* model = o.get("model");
  if (model && !model->is_string()) return fail("\"model\" must be a string");
  if (!model && !builtin) return fail("\"model\" is required");
  sc = Scenario();
  sc.id = id->as_string();
  if (!number_record(o.get("parameters"), "parameters", sc.request.parameters, error)) return false;
  if (!number_record(o.get("partOpacities"), "partOpacities", sc.request.part_opacities, error)) return false;
  if (model) sc.model = model->as_string();
  if (const Value* t = o.get("x-tints")) {
    if (!t->is_object()) return fail("\"x-tints\" must be an object");
    for (const Value::Member* m : t->entries_js_order()) {
      if (!m->second.is_array()) return fail("\"x-tints\" values must be arrays of numbers");
      Vector<double> rgba;
      for (const auto& n : m->second.items()) {
        if (!n.is_number()) return fail("\"x-tints\" values must be arrays of numbers");
        rgba.push_back(n.as_number());
      }
      sc.tints.emplace_back(m->first, std::move(rgba));
    }
  }
  if (const Value* r = o.get("render")) {
    if (!r->is_object() && !r->is_array()) return fail("\"render\" must be an object");
    auto ok = [](const Value* n) {
      return n && n->is_number() && is_integer(n->as_number()) && n->as_number() >= 1 && n->as_number() <= 8192;
    };
    if (!ok(r->get("width")) || !ok(r->get("height")))
      return fail("\"render.width\" and \"render.height\" must be integers in [1, 8192]");
    sc.render.present = true;
    sc.render.width = static_cast<int>(r->get("width")->as_number());
    sc.render.height = static_cast<int>(r->get("height")->as_number());
    if (const Value* bg = r->get("background")) {
      bool good = bg->is_array() && bg->items().size() == 4;
      if (good)
        for (const auto& x : bg->items()) good = good && x.is_number() && x.as_number() >= 0 && x.as_number() <= 1;
      if (!good) return fail("\"render.background\" must be 4 numbers in [0, 1] (straight RGBA)");
      for (std::size_t k = 0; k < 4; k++) sc.render.background[k] = bg->items()[k].as_number();
    }
    if (const Value* view = r->get("view")) {
      auto finite = [](const Value* n) { return n && n->is_number() && std::isfinite(n->as_number()); };
      if (!(view->is_object() || view->is_array()) || !finite(view->get("x")) || !finite(view->get("y")) ||
          !finite(view->get("pixelsPerUnit")) || !(view->get("pixelsPerUnit")->as_number() > 0))
        return fail("\"render.view\" must be { x, y, pixelsPerUnit } with finite numbers and pixelsPerUnit > 0");
      sc.render.has_view = true;
      sc.render.view_x = view->get("x")->as_number();
      sc.render.view_y = view->get("y")->as_number();
      sc.render.view_pixels_per_unit = view->get("pixelsPerUnit")->as_number();
    }
  }
  return true;
}

Vector<fs::path> model_search_dirs(const fs::path& root, const fs::path& models_dir) {
  std::error_code ec;
  const fs::path r = fs::absolute(root, ec).lexically_normal();
  const fs::path m = models_dir.empty() ? r / "assets" / "models" : fs::absolute(models_dir, ec).lexically_normal();
  return {m, r};
}

ModelCache::ModelCache(Vector<fs::path> search_dirs, moc::LoadOptions options, std::size_t capacity)
    : dirs_(std::move(search_dirs)), options_(options), capacity_(capacity) {}

namespace {

String file_version(const fs::path& p) {
  std::error_code ec;
  if (!fs::is_regular_file(p, ec)) return "";
  const auto t = fs::last_write_time(p, ec);
  const auto size = fs::file_size(p, ec);
  return to_str(static_cast<long long>(t.time_since_epoch().count())) + ":" + to_str(static_cast<long long>(size));
}

bool forbidden(std::string_view rel) {
  std::size_t i = 0;
  bool first = true;
  while (i <= rel.size()) {
    const std::size_t j = std::min(rel.find('/', i), rel.size());
    const std::string_view seg = rel.substr(i, j - i);
    if (!seg.empty()) {
      if (seg[0] == '.') return true;
      if (first && seg == "node_modules") return true;
      first = false;
    }
    i = j + 1;
  }
  return false;
}

/** The path inside `dir` that a relative reference names (the reference's resolve + prefix check). */
bool inside(const fs::path& dir, std::string_view ref, fs::path& out) {
  String rel;
  if (!framework::normalize_path(ref, rel)) return false;
  out = (dir / fs::u8path(to_std(rel))).lexically_normal();
  return true;
}

}  // namespace

bool ModelCache::load(std::string_view model_path, LoadedModel& out, ErrorInfo& error) {
  auto fail = [&](const char* kind, const String& message) {
    error.kind = kind;
    error.message = message;
    return false;
  };
  String rel;
  if (!framework::normalize_path(model_path, rel))
    return fail("Error", "Path escapes the source root: \"" + to_lib(model_path) + "\"");
  Vector<fs::path> tried;
  fs::path settings_file;
  if (!forbidden(rel))
    for (const auto& dir : dirs_) {
      const fs::path full = (dir / fs::u8path(to_std(rel))).lexically_normal();
      if (full == dir) continue;
      tried.push_back(full);
      std::error_code ec;
      if (settings_file.empty() && fs::is_regular_file(full, ec)) settings_file = full;
    }
  if (settings_file.empty()) {
    if (tried.empty()) return fail("ModelLoadError", "model path \"" + to_lib(model_path) + "\" is not allowed");
    String list;
    for (std::size_t i = 0; i < tried.size(); i++) list += (i ? ", " : "") + path_text(tried[i]);
    return fail("ModelLoadError", "model not found: \"" + to_lib(model_path) + "\" (tried " + list + ")");
  }
  out = LoadedModel();
  out.settings_file = settings_file;
  const fs::path dir = settings_file.parent_path();
  out.read = [dir](std::string_view path, String& bytes) {
    fs::path full;
    if (!inside(dir, path, full)) return false;
    return read_file(full, bytes);
  };
  {
    String bytes, message;
    if (!read_file(settings_file, bytes))
      return fail("ModelLoadError", "settings file " + to_lib(model_path) + ": cannot read the file");
    if (!framework::parse_model_settings(bytes, to_lib(model_path), out.settings, message))
      return fail("ModelLoadError", "settings file " + to_lib(model_path) + ": " + message);
  }
  fs::path moc_file;
  if (!inside(dir, out.settings.moc, moc_file))
    return fail("Error", "Path escapes the source root: \"" + out.settings.moc + "\"");
  const String version = file_version(moc_file);
  if (version.empty())
    return fail("ModelLoadError", "the .moc3 file " + out.settings.moc + " of " + to_lib(model_path) + " is missing");
  const String key = path_text(moc_file);
  for (std::size_t i = 0; i < entries_.size(); i++)
    if (entries_[i].path == key && entries_[i].version == version) {
      Entry e = entries_[i];
      entries_.erase(entries_.begin() + static_cast<long>(i));
      entries_.push_back(e);
      out.model = e.model;
      return true;
    }
  String bytes;
  if (!read_file(moc_file, bytes)) return fail("ModelLoadError", out.settings.moc + ": cannot read the file");
  auto model = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
  moc::Error err;
  if (!moc::load_moc(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), options_, *model, err))
    return fail("ModelLoadError", out.settings.moc + ": " + err.message);
  out.model = model;
  entries_.erase(std::remove_if(entries_.begin(), entries_.end(), [&](const Entry& e) { return e.path == key; }),
                 entries_.end());
  entries_.push_back({key, version, out.model});
  while (entries_.size() > capacity_) entries_.erase(entries_.begin());
  return true;
}

Value invalid_result(std::string_view id, std::string_view format, std::string_view producer, std::string_view kind,
                     std::string_view message) {
  Value r = Value::object();
  Value err = Value::object();
  err.set("kind", kind);
  err.set("message", message);
  if (format == "mochi2d-sequence-result/0") {
    r.set("format", format);
    r.set("producer", producer);
    r.set("error", std::move(err));
    r.set("warnings", Value::array());
    r.set("sequence", id);
    r.set("canvas", Value::object());
    r.set("steps", Value::array());
    return r;
  }
  if (format == "mochi2d-anim-result/0") {
    r.set("format", format);
    r.set("producer", producer);
    r.set("error", std::move(err));
    r.set("warnings", Value::array());
    r.set("scenario", id);
    Value ids = Value::object();
    ids.set("parameters", Value::array());
    ids.set("parts", Value::array());
    ids.set("free", Value::array());
    r.set("ids", std::move(ids));
    r.set("frames", Value::array());
    r.set("starts", Value::array());
    r.set("randomUsed", 0);
    return r;
  }
  r.set("format", "mochi2d-result/0");
  r.set("scenario", id);
  r.set("producer", producer);
  r.set("error", std::move(err));
  r.set("canvas", Value::object());
  r.set("parameters", Value::array());
  r.set("parts", Value::array());
  r.set("drawables", Value::array());
  r.set("warnings", Value::array());
  return r;
}

Value run_static(const Scenario& sc, ModelCache& models, std::string_view producer) {
  if (sc.model.empty())
    return invalid_result(sc.id, "mochi2d-result/0", producer, "Error",
                          "Scenario has no \"model\" (built-in scenes are render-only)");
  LoadedModel loaded;
  ErrorInfo err;
  if (!models.load(sc.model, loaded, err)) return invalid_result(sc.id, "mochi2d-result/0", producer, err.kind, err.message);
  eval::Instance inst(loaded.model, models.instance_options);  // the creation evaluation
  Vector<String> warnings = loaded.model->load_warnings;
  for (auto& w : apply_request(inst, sc.request)) warnings.push_back(std::move(w));
  inst.evaluate();
  Value r = Value::object();
  r.set("format", "mochi2d-result/0");
  r.set("scenario", sc.id);
  r.set("producer", producer);
  r.set("error", nullptr);
  snapshot_into(inst, r);
  Value w = Value::array();
  for (auto& s : warnings) w.push(s);
  r.set("warnings", std::move(w));
  return r;
}

Value run_scenario_json(std::string_view kind, const Value& json, std::string_view id, ModelCache& models,
                        std::string_view producer) {
  String error;
  if (kind == "static") {
    Scenario sc;
    if (!parse_scenario(json, sc, error)) return invalid_result(id, "mochi2d-result/0", producer, "InvalidScenario", error);
    return run_static(sc, models, producer);
  }
  if (kind == "sequence") return run_sequence_json(json, id, models, producer);
  return run_animation_json(json, id, models, producer);
}

namespace {

struct Item {
  String file;
  String id;
  String kind;  // static, sequence, animation, invalid
  Value json;
  String model;
  String error;
  String result_format = "mochi2d-result/0";
};

void collect_json(const fs::path& dir, Vector<fs::path>& out) {
  std::error_code ec;
  for (fs::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
    const auto& ent = *it;
    if (ent.is_directory(ec)) {
      collect_json(ent.path(), out);
    } else if (ent.is_regular_file(ec)) {
      String ext = path_text(ent.path().extension());
      std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
      if (ext == ".json") out.push_back(ent.path());
    }
  }
}

String fallback_id(const fs::path& file) {
  String base = path_text(file.filename());
  if (base.size() >= 5) {
    String tail = base.substr(base.size() - 5);
    std::transform(tail.begin(), tail.end(), tail.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (tail == ".json") base.erase(base.size() - 5);
  }
  // Each UTF-16 unit outside [A-Za-z0-9._-] becomes "_".
  String out;
  for (std::size_t i = 0; i < base.size();) {
    const unsigned char c = static_cast<unsigned char>(base[i]);
    if (c < 0x80) {
      out.push_back(id_char(static_cast<char>(c)) ? static_cast<char>(c) : '_');
      i++;
    } else {
      const std::size_t len = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2;
      out += len == 4 ? "__" : "_";
      i += len;
    }
  }
  return out.empty() ? String("scenario") : out;
}

Vector<Item> read_items(const Vector<String>& inputs) {
  Vector<fs::path> files;
  for (const auto& in : inputs) {
    std::error_code ec;
    const fs::path p = fs::absolute(fs::u8path(to_std(in)), ec);
    if (fs::is_directory(p, ec)) {
      Vector<fs::path> found;
      collect_json(p, found);
      std::sort(found.begin(), found.end(), [](const fs::path& a, const fs::path& b) { return path_text(a) < path_text(b); });
      files.insert(files.end(), found.begin(), found.end());
    } else {
      files.push_back(p);
    }
  }
  Vector<Item> items;
  for (const auto& file : files) {
    const String fallback = fallback_id(file);
    String text;
    Value json;
    json::ParseError err;
    if (!read_file(file, text)) {
      items.push_back({path_text(file), fallback, "invalid", {}, "", "cannot read scenario file: no such file"});
      continue;
    }
    text = text::sanitize_utf8(text);
    if (text.rfind("\xEF\xBB\xBF", 0) == 0) text.erase(0, 3);
    if (!json::parse(text, json, err)) {
      items.push_back({path_text(file), fallback, "invalid", {}, "", "cannot read scenario file: " + err.message});
      continue;
    }
    if (json.is_object()) {
      const Value* f = json.get("format");
      if (f && f->is_string()) {
        String name = f->as_string();
        if (name.rfind("lively2d-", 0) == 0) name = "mochi2d-" + name.substr(9);
        if (name.rfind("mochi2d-catalog/", 0) == 0) continue;
      }
    }
    Vector<Value> list;
    if (json.is_array())
      list = json.items();
    else
      list.push_back(json);
    for (std::size_t i = 0; i < list.size(); i++) {
      const Value& o = list[i];
      const Value* id = o.is_object() ? o.get("id") : nullptr;
      Item it;
      it.file = path_text(file);
      it.id = id && id->is_string() && valid_id(id->as_string()) ? id->as_string()
              : list.size() > 1                                  ? fallback + "." + to_str(i)
                                                                 : fallback;
      const String format = known_format(o.is_object() ? o.get("format") : nullptr);
      if (format.empty()) {
        it.kind = "invalid";
        it.error = "unknown format " + json_text(o.is_object() ? o.get("format") : nullptr);
        items.push_back(std::move(it));
        continue;
      }
      it.kind = format == "mochi2d-scenario/0" ? "static" : format == "mochi2d-sequence/0" ? "sequence" : "animation";
      it.json = o;
      const Value* model = o.is_object() ? o.get("model") : nullptr;
      if (model) {
        if (model->is_string())
          it.model = model->as_string();
        else if (model->is_number())
          it.model = text::js_number(model->as_number());
        else if (!model->is_null())
          it.model = json::write_compact(*model);
        else
          it.model = "null";
      }
      items.push_back(std::move(it));
    }
  }
  return items;
}

}  // namespace

Vector<ScenarioFile> read_scenario_files(const Vector<String>& inputs) {
  Vector<ScenarioFile> out;
  for (auto& item : read_items(inputs)) out.push_back({item.id, item.kind, std::move(item.json), item.model, item.error});
  return out;
}

RunSummary run_conformance(const Vector<String>& inputs, const fs::path& out_dir, ModelCache& models,
                           std::string_view producer, const std::function<void(const String&)>& log) {
  std::error_code ec;
  fs::create_directories(out_dir, ec);
  Vector<Item> items = read_items(inputs);
  Vector<std::size_t> order(items.size());
  for (std::size_t i = 0; i < order.size(); i++) order[i] = i;
  // Scenarios on the same model run together, so the parsed model is reused.
  std::stable_sort(order.begin(), order.end(), [&](std::size_t a, std::size_t b) {
    const String& ma = items[a].kind == "invalid" ? String() : items[a].model;
    const String& mb = items[b].kind == "invalid" ? String() : items[b].model;
    return ma < mb;
  });
  RunSummary summary;
  summary.total = items.size();
  std::set<String> seen;
  for (std::size_t idx : order) {
    const Item& item = items[idx];
    Value r;
    if (seen.count(item.id)) {
      r = invalid_result(item.id, "mochi2d-result/0", producer, "InvalidScenario",
                         "duplicate scenario id \"" + item.id + "\"");
    } else if (item.kind == "invalid") {
      r = invalid_result(item.id, item.result_format, producer, "InvalidScenario", item.error);
    } else {
      r = run_scenario_json(item.kind, item.json, item.id, models, producer);
    }
    seen.insert(item.id);
    // Animation results mix float32 and double quantities: every number prints as a double.
    const String text = json::write_result(r, item.kind == "animation" ? json::Numbers::Double : json::Numbers::Float32);
    const fs::path out_file = out_dir / fs::u8path(to_std(item.id + ".result.json"));
    if (std::FILE* f = std::fopen(out_file.u8string().c_str(), "wb")) {
      std::fwrite(text.data(), 1, text.size(), f);
      std::fclose(f);
    }
    const Value* err = r.get("error");
    String e;
    if (err && err->is_object()) e = err->get("kind")->as_string() + ": " + err->get("message")->as_string();
    if (!e.empty()) summary.failed++;
    if (log) log((e.empty() ? "ok   " : "FAIL ") + item.id + (e.empty() ? "" : " — " + e));
  }
  return summary;
}

}  // namespace mochi2d::conformance

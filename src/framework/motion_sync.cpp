#include "framework/motion_sync.hpp"

#include <initializer_list>

#include "util/text.hpp"

namespace mochi2d::framework {

const char* const kMotionSyncElements[kMotionSyncElementCount] = {"Silence", "A", "I", "U", "E", "O"};
const char* const kMotionSyncAnalysisType = "CRI";

int motion_sync_element_index(std::string_view id) {
  for (int i = 0; i < kMotionSyncElementCount; i++)
    if (id == kMotionSyncElements[i]) return i;
  return -1;
}

double js_integer_of_number(double n) {
  const String s = text::js_number(n);
  std::size_t i = 0;
  bool negative = false;
  if (i < s.size() && (s[i] == '-' || s[i] == '+')) negative = s[i++] == '-';
  std::size_t j = i;
  while (j < s.size() && s[j] >= '0' && s[j] <= '9') j++;
  if (j == i) return 0;  // NaN: not finite
  double v = 0;
  if (!text::parse_double(s.data() + i, s.data() + j, v)) return 0;
  if (negative) v = -v;
  if (!std::isfinite(v)) return 0;
  return v + 0.0;  // -0 reads as +0
}

namespace {

using json::Value;

const char* const kRootKeys[] = {"Version", "Meta", "Settings"};
const char* const kMetaKeys[] = {"SettingCount", "Dictionary"};
const char* const kDictionaryKeys[] = {"Id", "Name"};
const char* const kSettingKeys[] = {"Id",         "AnalysisType",    "UseCase",       "CubismParameters",
                                    "AudioParameters", "Mappings", "PostProcessing"};
const char* const kParameterKeys[] = {"Name", "Id", "Min", "Max", "Damper", "Smooth"};
const char* const kElementKeys[] = {"Name", "Id", "Min", "Max", "Scale", "Enabled"};
const char* const kMappingKeys[] = {"Type", "Id", "Targets"};
const char* const kTargetKeys[] = {"Id", "Value"};
const char* const kPostKeys[] = {"BlendRatio", "Smoothing", "SampleRate"};

struct KeyList {
  const char* const* keys;
  std::size_t count;
  bool has(std::string_view k) const {
    for (std::size_t i = 0; i < count; i++)
      if (k == keys[i]) return true;
    return false;
  }
};
template <std::size_t N>
KeyList keys(const char* const (&k)[N]) {
  return {k, N};
}

const Value kEmptyObject = Value::object();
const Vector<Value> kEmptyList;

class Reader {
 public:
  Reader(std::string_view label, const MotionSyncReadOptions& options, Vector<String>& warnings)
      : label_(label), options_(options), warnings_(warnings) {}

  void warn(const String& path, const String& what) { warnings_.push_back(label_ + ": " + path + " " + what); }

  void lint(const Value& o, const String& path, KeyList known) {
    if (!options_.lint) return;
    for (const auto* m : o.entries_js_order())
      if (!known.has(m->first)) warn(path.empty() ? m->first : path + "." + m->first, "is not part of the format; ignored");
  }

  const Value& object(const Value* v, const String& path) {
    if (v && v->is_object()) return *v;
    warn(path, v ? "is not an object" : "is missing");
    return kEmptyObject;
  }

  const Vector<Value>& list(const Value* v, const String& path) {
    if (v && v->is_array()) return v->items();
    warn(path, v ? "is not a list; empty is used" : "is missing; empty is used");
    return kEmptyList;
  }

  double number(const Value* v, const String& path) {
    if (v && v->is_number()) return v->as_number();
    warn(path, String(v ? "is not a number" : "is missing") + "; 0 is used");
    return 0;
  }

  double integer(const Value* v, const String& path) { return js_integer_of_number(number(v, path)); }

  String text(const Value* v, const String& path) {
    if (v && v->is_string()) return v->as_string();
    warn(path, v ? "is not a string" : "is missing");
    return String();
  }

  bool flag(const Value* v, const String& path) {
    if (v && v->is_bool()) return v->as_bool();
    warn(path, String(v ? "is not true or false" : "is missing") + "; read as false");
    return false;
  }

  double limited(double x, double lo, double hi, const String& path) {
    if (x >= lo && x <= hi) return x;
    const double y = js_min(hi, js_max(lo, x));
    warn(path, text::js_number(x) + " is outside [" + text::js_number(lo) + ", " + text::js_number(hi) + "]; " +
                   text::js_number(y) + " is used");
    return y;
  }

 private:
  String label_;
  const MotionSyncReadOptions& options_;
  Vector<String>& warnings_;
};

/** obj[key] of a JSON object (an own member), or undefined. */
const Value* at(const Value& o, std::string_view key) { return o.is_object() ? o.get(key) : nullptr; }
/** list[i], or undefined past its end. */
const Value* at(const Vector<Value>& l, std::size_t i) { return i < l.size() ? &l[i] : nullptr; }

String idx(const char* prefix, std::size_t i, const char* suffix = "]") {
  return String(prefix) + to_str(static_cast<unsigned long long>(i)) + suffix;
}

struct Mapping {
  String id;
  Vector<std::pair<String, double>> targets;
};

}  // namespace

bool parse_motion_sync(std::string_view bytes, std::string_view label_view, MotionSyncFile& out, FormatError& error,
                       const MotionSyncReadOptions& options) {
  const String label(label_view);
  Value root;
  if (!parse_json(bytes, label, root, error)) return false;
  if (!root.is_object()) {
    error.message = label + ": not a JSON object";
    return false;
  }
  MotionSyncFile f;
  f.label = label;
  Reader r(label, options, f.warnings);
  r.lint(root, "", keys(kRootKeys));
  f.version = r.integer(at(root, "Version"), "Version");
  if (f.version != 1) r.warn("Version", "is " + text::js_number(f.version) + ", not 1; read as version 1");
  const Value& meta = r.object(at(root, "Meta"), "Meta");
  r.lint(meta, "Meta", keys(kMetaKeys));
  const double count = r.integer(at(meta, "SettingCount"), "Meta.SettingCount");
  const Vector<Value>& dictionary = r.list(at(meta, "Dictionary"), "Meta.Dictionary");
  const Vector<Value>& setting_list = r.list(at(root, "Settings"), "Settings");
  const double listed = static_cast<double>(setting_list.size());
  const double n = js_max(0, js_min(count, listed));
  if (count != listed)
    r.warn("Meta.SettingCount", "is " + text::js_number(count) + ", but Settings has " + text::js_number(listed) + "; " +
                                    text::js_number(n) + " read");
  const std::size_t settings = static_cast<std::size_t>(n);
  for (std::size_t i = 0; i < settings; i++) {
    const String path = idx("Settings[", i);
    const String dict = idx("Meta.Dictionary[", i);
    const Value& s = r.object(at(setting_list, i), path);
    r.lint(s, path, keys(kSettingKeys));
    const Value& entry = r.object(at(dictionary, i), dict);
    r.lint(entry, dict, keys(kDictionaryKeys));
    MotionSyncSetting st;
    st.index = static_cast<int>(i);
    st.id = r.text(at(s, "Id"), path + ".Id");
    st.name = r.text(at(entry, "Name"), dict + ".Name");
    const String dict_id = r.text(at(entry, "Id"), dict + ".Id");
    if (dict_id != st.id) r.warn(dict + ".Id", "is \"" + dict_id + "\", not \"" + st.id + "\"");
    st.analysis_type = r.text(at(s, "AnalysisType"), path + ".AnalysisType");
    st.usable = st.analysis_type == kMotionSyncAnalysisType;
    if (!st.usable)
      r.warn(path + ".AnalysisType", "\"" + st.analysis_type + "\" is not supported; the setting is ignored");
    st.use_case = r.text(at(s, "UseCase"), path + ".UseCase");
    if (st.use_case != "Mouth") r.warn(path + ".UseCase", "is \"" + st.use_case + "\", not \"Mouth\"; used anyway");

    const Vector<Value>& params = r.list(at(s, "CubismParameters"), path + ".CubismParameters");
    for (std::size_t k = 0; k < params.size(); k++) {
      const String pa = path + idx(".CubismParameters[", k);
      const Value& o = r.object(&params[k], pa);
      r.lint(o, pa, keys(kParameterKeys));
      MotionSyncParameter p;
      const double damper = r.number(at(o, "Damper"), pa + ".Damper");
      p.id = r.text(at(o, "Id"), pa + ".Id");
      p.name = str(at(o, "Name"));
      p.min = r.number(at(o, "Min"), pa + ".Min");
      p.max = r.number(at(o, "Max"), pa + ".Max");
      // A negative dead band acts as none.
      p.damper = damper > 0 ? damper : 0;
      p.smooth = r.limited(r.number(at(o, "Smooth"), pa + ".Smooth"), 0, 100, pa + ".Smooth");
      st.parameters.push_back(std::move(p));
    }

    const Vector<Value>& elements = r.list(at(s, "AudioParameters"), path + ".AudioParameters");
    for (std::size_t k = 0; k < elements.size(); k++) {
      const String pa = path + idx(".AudioParameters[", k);
      const Value& o = r.object(&elements[k], pa);
      r.lint(o, pa, keys(kElementKeys));
      MotionSyncElement e;
      e.id = r.text(at(o, "Id"), pa + ".Id");
      e.known = motion_sync_element_index(e.id) >= 0;
      if (!e.known) r.warn(pa + ".Id", "\"" + e.id + "\" is not one of Silence, A, I, U, E, O; its weight is 0");
      e.name = str(at(o, "Name"));
      e.min = r.number(at(o, "Min"), pa + ".Min");
      e.max = r.number(at(o, "Max"), pa + ".Max");
      e.scale = r.limited(r.number(at(o, "Scale"), pa + ".Scale"), 0.1, 10, pa + ".Scale");
      e.enabled = r.flag(at(o, "Enabled"), pa + ".Enabled");
      st.elements.push_back(std::move(e));
    }

    // As many mappings as elements, by position; each element takes the first
    // of those whose Id is its own, and each driven parameter the target with its Id.
    const Vector<Value>& mapping_list = r.list(at(s, "Mappings"), path + ".Mappings");
    Vector<Mapping> mappings;
    for (std::size_t k = 0; k < mapping_list.size() && k < st.elements.size(); k++) {
      const String pa = path + idx(".Mappings[", k);
      const Value& o = r.object(&mapping_list[k], pa);
      r.lint(o, pa, keys(kMappingKeys));
      const String type = r.text(at(o, "Type"), pa + ".Type");
      if (type != "Shape") r.warn(pa + ".Type", "is \"" + type + "\", not \"Shape\"; used anyway");
      Mapping m;
      const Vector<Value>& targets = r.list(at(o, "Targets"), pa + ".Targets");
      for (std::size_t j = 0; j < targets.size(); j++) {
        const String ta = pa + idx(".Targets[", j);
        const Value& to = r.object(&targets[j], ta);
        r.lint(to, ta, keys(kTargetKeys));
        String id = r.text(at(to, "Id"), ta + ".Id");
        const double value = r.number(at(to, "Value"), ta + ".Value");
        m.targets.emplace_back(std::move(id), value);
      }
      m.id = r.text(at(o, "Id"), pa + ".Id");
      mappings.push_back(std::move(m));
    }
    for (const auto& e : st.elements) {
      const Mapping* m = nullptr;
      for (const auto& x : mappings)
        if (x.id == e.id) {
          m = &x;
          break;
        }
      Vector<double> shape;
      if (!m) {
        r.warn(path + ".Mappings", "have no shape for element \"" + e.id + "\"; 0 is used");
        shape.assign(st.parameters.size(), 0.0);
      } else {
        for (const auto& p : st.parameters) {
          const std::pair<String, double>* t = nullptr;
          for (const auto& x : m->targets)
            if (x.first == p.id) {
              t = &x;
              break;
            }
          if (t) {
            shape.push_back(t->second);
          } else {
            r.warn(path + ".Mappings", "\"" + e.id + "\" has no target for \"" + p.id + "\"; 0 is used");
            shape.push_back(0);
          }
        }
      }
      st.shapes.push_back(std::move(shape));
    }

    const String pp = path + ".PostProcessing";
    const Value& post = r.object(at(s, "PostProcessing"), pp);
    r.lint(post, pp, keys(kPostKeys));
    st.blend_ratio = r.limited(r.number(at(post, "BlendRatio"), pp + ".BlendRatio"), 0, 1, pp + ".BlendRatio");
    st.smoothing = r.limited(r.integer(at(post, "Smoothing"), pp + ".Smoothing"), 1, 100, pp + ".Smoothing");
    double rate = r.number(at(post, "SampleRate"), pp + ".SampleRate");
    if (!(rate > 0)) {
      r.warn(pp + ".SampleRate", "is " + text::js_number(rate) + "; 60 is used");
      rate = 60;
    } else {
      rate = r.limited(rate, 1, 120, pp + ".SampleRate");
    }
    st.sample_rate = rate;
    f.settings.push_back(std::move(st));
  }
  out = std::move(f);
  return true;
}

const MotionSyncSetting* find_motion_sync_setting(const MotionSyncFile& file, std::string_view ref) {
  for (const auto& s : file.settings)
    if (s.name == ref) return &s;
  for (const auto& s : file.settings)
    if (s.id == ref) return &s;
  return nullptr;
}

}  // namespace mochi2d::framework

#include "conformance/formats.hpp"

#include <cmath>

#include "core/snapshot.hpp"
#include "framework/animation_scenario.hpp"
#include "framework/jsutil.hpp"
#include "util/text.hpp"

namespace mochi2d::conformance {

using json::Value;

namespace {

constexpr const char* kSequenceFormat = "mochi2d-sequence/0";
constexpr const char* kSequenceResult = "mochi2d-sequence-result/0";
constexpr const char* kAnimFormat = "mochi2d-anim-scenario/0";
constexpr const char* kAnimResult = "mochi2d-anim-result/0";

bool finite(const Value* v) { return v && v->is_number() && std::isfinite(v->as_number()); }
bool is_integer(const Value* v) {
  return v && v->is_number() && std::isfinite(v->as_number()) && std::trunc(v->as_number()) == v->as_number();
}

/** The checks of the scenario header (format, id, model); false with the InvalidScenario message. */
bool header(const Value& json, const char* format, String& id, String& model, String& error) {
  if (!json.is_object()) {
    error = "scenario must be a JSON object";
    return false;
  }
  if (known_format(json.get("format")) != format) {
    error = String("\"format\" must be \"") + format + "\" (got " + json_text(json.get("format")) + ")";
    return false;
  }
  const Value* i = json.get("id");
  if (!i || !i->is_string() || !valid_id(i->as_string())) {
    error = "\"id\" must match /^[A-Za-z0-9._-]{1,200}$/ (it is used as a file name)";
    return false;
  }
  const Value* m = json.get("model");
  if (!m || !m->is_string() || m->as_string().empty()) {
    error = "\"model\" is required";
    return false;
  }
  id = i->as_string();
  model = m->as_string();
  return true;
}

/** The members of a snapshot for a sequence step: label, parameters, parts, drawables, offscreens. */
Value step_record(const String& label, const Value& snapshot) {
  Value r = Value::object();
  r.set("label", label);
  for (const auto& m : snapshot.members())
    if (m.first != "canvas") r.set(m.first, m.second);
  return r;
}

// ---------------------------------------------------------------- sequences

struct SequenceStep {
  String label;
  Vector<std::pair<String, double>> parameters, part_opacities;
};

bool parse_sequence(const Value& json, String& id, String& model, Vector<SequenceStep>& steps, String& error) {
  if (!header(json, kSequenceFormat, id, model, error)) return false;
  const Value* list = json.get("steps");
  if (!list || !list->is_array()) {
    error = "\"steps\" must be an array";
    return false;
  }
  for (std::size_t i = 0; i < list->items().size(); i++) {
    const Value& s = list->items()[i];
    const String at = "steps[" + to_str(i) + "]";
    if (!s.is_object()) {
      error = at + " must be an object";
      return false;
    }
    const Value* label = s.get("label");
    if (label && !label->is_string()) {
      error = at + ".label must be a string";
      return false;
    }
    SequenceStep step;
    step.label = label ? label->as_string() : "s" + to_str(i + 1);
    if (!number_record(s.get("parameters"), at + ".parameters", step.parameters, error)) return false;
    if (!number_record(s.get("partOpacities"), at + ".partOpacities", step.part_opacities, error)) return false;
    steps.push_back(std::move(step));
  }
  return true;
}

// ---------------------------------------------------------------- animations

using framework::Effect;
using framework::ScenarioCommand;

struct AnimFile {
  String id, model;
  Vector<double> steps;
  Vector<double> random;
  framework::EffectOverrides effects;
  std::optional<Vector<String>> idle_motions;
  framework::AnimationScenario::Options options;
  Vector<std::pair<std::size_t, ScenarioCommand>> commands;
  struct {
    bool all_parameters = true, all_parts = true;
    Vector<String> parameters, parts, free;
    double every = 1;
    Vector<framework::ScenarioFrameHit> hits;
    Vector<std::size_t> drawables;
  } record;
};

/** The effect names of 4i and the switches they set. */
constexpr std::pair<const char*, Effect> kEffects[] = {
    {"idle", Effect::Idle},       {"blink", Effect::EyeBlink},   {"expressions", Effect::Expressions},
    {"look", Effect::Look},       {"breath", Effect::Breath},    {"physics", Effect::Physics},
    {"lipsync", Effect::LipSync}, {"pose", Effect::Pose},
};

/**
 * EFFECTS[name] of the reference: one of the effects, Effect::None for a
 * name that finds a property of Object.prototype (truthy, and ignored), or
 * false for anything else.
 */
bool effect_named(std::string_view name, Effect& out) {
  for (const auto& e : kEffects)
    if (name == e.first) {
      out = e.second;
      return true;
    }
  if (framework::is_object_prototype_key(name)) {
    out = Effect::None;
    return true;
  }
  return false;
}

void set_effect(framework::EffectOverrides& o, Effect e, bool v) {
  switch (e) {
    case Effect::Idle: o.idle = v; break;
    case Effect::EyeBlink: o.eye_blink = v; break;
    case Effect::Expressions: o.expressions = v; break;
    case Effect::Look: o.look = v; break;
    case Effect::Breath: o.breath = v; break;
    case Effect::Physics: o.physics = v; break;
    case Effect::LipSync: o.lip_sync = v; break;
    case Effect::Pose: o.pose = v; break;
    case Effect::None: break;
  }
}

/** The validators of formats.ts: each fails with its message. */
struct Checks {
  String& error;
  bool fail(String m) {
    error = std::move(m);
    return false;
  }
  bool boolean(const Value* v, const String& what, bool fallback, bool& out) {
    if (!v) {
      out = fallback;
      return true;
    }
    if (!v->is_bool()) return fail(what + " must be true or false");
    out = v->as_bool();
    return true;
  }
  bool num(const Value* v, const String& what, double& out) {
    if (!finite(v)) return fail(what + " must be a finite number");
    out = v->as_number();
    return true;
  }
  bool str(const Value* v, const String& what, String& out) {
    if (!v || !v->is_string() || v->as_string().empty()) return fail(what + " must be a non-empty string");
    out = v->as_string();
    return true;
  }
  bool pair(const Value* v, const String& what, std::pair<double, double>& out) {
    bool ok = v && v->is_array() && v->items().size() == 2;
    if (ok)
      for (const auto& x : v->items()) ok = ok && finite(&x);
    if (!ok) return fail(what + " must be [x, y]");
    out = {v->items()[0].as_number(), v->items()[1].as_number()};
    return true;
  }
  bool id_list(const Value* v, const String& what, Vector<String>& out) {
    bool ok = v && v->is_array();
    if (ok)
      for (const auto& x : v->items()) ok = ok && x.is_string();
    if (!ok) return fail(what + " must be a list of IDs");
    out.clear();
    for (const auto& x : v->items()) out.push_back(x.as_string());
    return true;
  }
};

bool parse_command(const Value& c, const String& what, Checks& ck, ScenarioCommand& cmd) {
  using Kind = ScenarioCommand::Kind;
  const Value* op = c.get("do");
  const String name = op && op->is_string() ? op->as_string() : String();
  const bool is_string = op && op->is_string();
  if (is_string && name == "motion") {
    const bool has_file = c.get("file") != nullptr;
    const bool has_group = c.get("group") != nullptr || c.get("index") != nullptr;
    if (has_file == has_group) return ck.fail(what + ": a motion needs \"file\", or \"group\" and \"index\"");
    cmd.kind = Kind::StartMotion;
    if (has_file) {
      String f;
      if (!ck.str(c.get("file"), what + ".file", f)) return false;
      cmd.file = f;
    } else {
      String g;
      if (!ck.str(c.get("group"), what + ".group", g)) return false;
      cmd.group = g;
      const Value* index = c.get("index");
      if (!is_integer(index) || index->as_number() < 0) return ck.fail(what + ".index must be an integer ≥ 0");
      cmd.index = index->as_number();
      if (c.get("FadeInTime") || c.get("FadeOutTime"))
        return ck.fail(what + ": FadeInTime and FadeOutTime are allowed only with \"file\"");
    }
    double x;
    if (!c.get("priority")) {
      cmd.priority = 2;
    } else {
      if (!ck.num(c.get("priority"), what + ".priority", x)) return false;
      cmd.priority = x;
    }
    if (c.get("FadeInTime")) {
      if (!ck.num(c.get("FadeInTime"), what + ".FadeInTime", x)) return false;
      cmd.fade_in = x;
    }
    if (c.get("FadeOutTime")) {
      if (!ck.num(c.get("FadeOutTime"), what + ".FadeOutTime", x)) return false;
      cmd.fade_out = x;
    }
    bool b = false;
    if (!ck.boolean(c.get("loop"), what + ".loop", false, b)) return false;
    cmd.loop = b;
    if (!ck.boolean(c.get("loopFade"), what + ".loopFade", true, b)) return false;
    cmd.loop_fade_in = b;
    if (!c.get("weight")) {
      cmd.weight = 1;
    } else {
      if (!ck.num(c.get("weight"), what + ".weight", x)) return false;
      cmd.weight = x;
    }
    if (!c.get("offset")) {
      cmd.offset = 0;
    } else {
      if (!ck.num(c.get("offset"), what + ".offset", x)) return false;
      cmd.offset = x;
    }
    if (!ck.boolean(c.get("legacyLoop"), what + ".legacyLoop", false, b)) return false;
    cmd.legacy_loop = b;
    return true;
  }
  if (is_string && name == "expression") {
    const bool no_file = c.get("file") == nullptr;
    const bool no_name = c.get("name") == nullptr;
    if (no_file == no_name) return ck.fail(what + ": an expression needs \"file\" or \"name\"");
    cmd.kind = Kind::StartExpression;
    String s;
    if (!no_file) {
      if (!ck.str(c.get("file"), what + ".file", s)) return false;
      cmd.file = s;
    } else {
      if (!ck.str(c.get("name"), what + ".name", s)) return false;
      cmd.name = s;
    }
    return true;
  }
  if (is_string && name == "look") {
    cmd.kind = Kind::SetLookTarget;
    return ck.num(c.get("x"), what + ".x", cmd.x) && ck.num(c.get("y"), what + ".y", cmd.y);
  }
  if (is_string && name == "sound") {
    cmd.kind = Kind::StartSound;
    String s;
    if (!ck.str(c.get("file"), what + ".file", s)) return false;
    cmd.file = s;
    return true;
  }
  if (is_string && name == "partOpacity") {
    cmd.kind = Kind::SetPartOpacity;
    return ck.str(c.get("id"), what + ".id", cmd.id) && ck.num(c.get("value"), what + ".value", cmd.value);
  }
  if (is_string && name == "stopMotions") {
    cmd.kind = Kind::StopMotions;
    return true;
  }
  if (is_string && name == "enable") {
    cmd.kind = Kind::Enable;
    String s;
    if (!ck.str(c.get("effect"), what + ".effect", s)) return false;
    if (!effect_named(s, cmd.effect))
      return ck.fail(what + ".effect must be one of idle, blink, expressions, look, breath, physics, lipsync, pose");
    return true;
  }
  return ck.fail(what + ": unknown command " + json_text(op));
}

bool parse_anim(const Value& json, AnimFile& sc, String& error) {
  Checks ck{error};
  if (!header(json, kAnimFormat, sc.id, sc.model, error)) return false;
  const Value& o = json;
  // Steps: dt and frames, or dts.
  if (const Value* dts = o.get("dts")) {
    if (o.get("dt") || o.get("frames")) return ck.fail("give either \"dt\" and \"frames\" or \"dts\"");
    bool ok = dts->is_array();
    if (ok)
      for (const auto& d : dts->items()) ok = ok && finite(&d) && d.as_number() >= 0;
    if (!ok) return ck.fail("\"dts\" must be a list of steps ≥ 0");
    for (const auto& d : dts->items()) sc.steps.push_back(d.as_number());
  } else {
    double dt;
    if (!ck.num(o.get("dt"), "\"dt\"", dt)) return false;
    if (dt < 0) return ck.fail("\"dt\" must be ≥ 0");
    const Value* frames = o.get("frames");
    if (!is_integer(frames) || frames->as_number() < 0) return ck.fail("\"frames\" must be an integer ≥ 0");
    // new Array(n) takes lengths below 2³².
    if (frames->as_number() >= 4294967296.0) {
      error = "\x01RangeError\x01Invalid array length";
      return false;
    }
    sc.steps.assign(static_cast<std::size_t>(frames->as_number()), dt);
  }
  const double N = static_cast<double>(sc.steps.size());
  const String n_text = to_str(sc.steps.size());
  // o.random ?? []: null counts as missing.
  if (const Value* random = o.get("random"); random && !random->is_null()) {
    bool ok = random->is_array();
    if (ok)
      for (const auto& r : random->items()) ok = ok && finite(&r) && r.as_number() >= 0 && r.as_number() < 1;
    if (!ok) return ck.fail("\"random\" must be a list of numbers in [0, 1)");
    for (const auto& r : random->items()) sc.random.push_back(r.as_number());
  }
  if (const Value* effects = o.get("effects")) {
    if (!effects->is_object()) return ck.fail("\"effects\" must be an object");
    for (const auto* m : effects->entries_js_order()) {
      Effect e;
      if (!effect_named(m->first, e)) continue;
      bool v = false;
      if (!ck.boolean(&m->second, "\"effects." + m->first + "\"", true, v)) return false;
      set_effect(sc.effects, e, v);
    }
  }
  if (const Value* idle = o.get("idleMotions")) {
    bool ok = idle->is_array();
    if (ok)
      for (const auto& x : idle->items()) ok = ok && x.is_string() && !x.as_string().empty();
    if (!ok) return ck.fail("\"idleMotions\" must be a list of motion files");
    Vector<String> list;
    for (const auto& x : idle->items()) list.push_back(x.as_string());
    sc.idle_motions = std::move(list);
  }
  if (const Value* op = o.get("options")) {
    if (!op->is_object()) return ck.fail("\"options\" must be an object");
    bool b = false;
    std::pair<double, double> p;
    if (const Value* v = op->get("wrap")) {
      if (!ck.boolean(v, "\"options.wrap\"", false, b)) return false;
      sc.options.wrap = b;
    }
    if (const Value* v = op->get("gravity")) {
      if (!ck.pair(v, "\"options.gravity\"", p)) return false;
      sc.options.gravity = p;
    }
    if (const Value* v = op->get("wind")) {
      if (!ck.pair(v, "\"options.wind\"", p)) return false;
      sc.options.wind = p;
    }
    if (const Value* v = op->get("settle")) {
      if (!ck.boolean(v, "\"options.settle\"", false, b)) return false;
      sc.options.settle = b;
    }
    if (const Value* t = op->get("blinkTiming")) {
      bool ok = t->is_array() && t->items().size() == 4;
      if (ok)
        for (const auto& x : t->items()) ok = ok && finite(&x) && x.as_number() >= 0;
      if (!ok) return ck.fail("\"options.blinkTiming\" must be [interval, closing, closed, opening]");
      framework::EyeBlinkTiming timing;
      timing.interval = t->items()[0].as_number();
      timing.closing = t->items()[1].as_number();
      timing.closed = t->items()[2].as_number();
      timing.opening = t->items()[3].as_number();
      sc.options.eye_blink = timing;
    }
  }
  if (const Value* commands = o.get("commands")) {
    if (!commands->is_array()) return ck.fail("\"commands\" must be an array");
    double last = 0;
    for (std::size_t i = 0; i < commands->items().size(); i++) {
      const Value& c = commands->items()[i];
      const String what = "commands[" + to_str(i) + "]";
      if (!c.is_object()) return ck.fail(what + " must be an object");
      const Value* frame = c.get("frame");
      if (!is_integer(frame) || frame->as_number() < 0 || frame->as_number() >= N)
        return ck.fail(what + ".frame must be an integer in [0, " + n_text + ")");
      if (frame->as_number() < last) return ck.fail(what + ": commands must be in non-decreasing frame order");
      last = frame->as_number();
      ScenarioCommand cmd;
      if (!parse_command(c, what, ck, cmd)) return false;
      sc.commands.emplace_back(static_cast<std::size_t>(frame->as_number()), std::move(cmd));
    }
  }
  const Value* rec = o.get("record");
  if (rec && !rec->is_object()) return ck.fail("\"record\" must be an object");
  auto field = [&](const char* k) { return rec ? rec->get(k) : nullptr; };
  if (const Value* every = field("every")) {
    if (!is_integer(every) || every->as_number() < 1) return ck.fail("\"record.every\" must be an integer ≥ 1");
    sc.record.every = every->as_number();
  }
  const Value* hits = field("hits");
  if (hits && !hits->is_array()) return ck.fail("\"record.hits\" must be an array");
  const Value* drawables = field("drawables");
  if (drawables && !drawables->is_array()) return ck.fail("\"record.drawables\" must be a list of frames");
  auto all_or = [&](const char* k, const char* what, bool& all, Vector<String>& list) {
    const Value* v = field(k);
    if (!v || (v->is_string() && v->as_string() == "all")) {
      all = true;
      return true;
    }
    all = false;
    return ck.id_list(v, what, list);
  };
  if (!all_or("parameters", "\"record.parameters\"", sc.record.all_parameters, sc.record.parameters)) return false;
  if (!all_or("parts", "\"record.parts\"", sc.record.all_parts, sc.record.parts)) return false;
  if (const Value* f = field("free"))
    if (!ck.id_list(f, "\"record.free\"", sc.record.free)) return false;
  auto frame_in = [&](const Value* f, const String& what, std::size_t& out) {
    if (!is_integer(f) || f->as_number() < 0 || f->as_number() >= N)
      return ck.fail(what + " must be a frame number in [0, " + n_text + ")");
    out = static_cast<std::size_t>(f->as_number());
    return true;
  };
  if (hits)
    for (std::size_t i = 0; i < hits->items().size(); i++) {
      const Value& h = hits->items()[i];
      const String what = "record.hits[" + to_str(i) + "]";
      if (!h.is_object()) return ck.fail(what + " must be an object");
      framework::ScenarioFrameHit hit;
      if (!frame_in(h.get("frame"), what + ".frame", hit.frame)) return false;
      if (!ck.str(h.get("drawable"), what + ".drawable", hit.hit.drawable)) return false;
      if (!ck.num(h.get("x"), what + ".x", hit.hit.x)) return false;
      if (!ck.num(h.get("y"), what + ".y", hit.hit.y)) return false;
      sc.record.hits.push_back(std::move(hit));
    }
  if (drawables)
    for (std::size_t i = 0; i < drawables->items().size(); i++) {
      std::size_t f;
      if (!frame_in(&drawables->items()[i], "record.drawables[" + to_str(i) + "]", f)) return false;
      sc.record.drawables.push_back(f);
    }
  return true;
}

/** Files of a loaded model for the scenario runner. */
class ModelFiles : public framework::FileSource {
 public:
  explicit ModelFiles(const LoadedModel& m) : m_(m) {}
  bool read(std::string_view path, String& bytes) override { return m_.read && m_.read(path, bytes); }

 private:
  const LoadedModel& m_;
};

Value string_array(const Vector<String>& list) {
  Value a = Value::array();
  for (const auto& s : list) a.push(s);
  return a;
}

Value anim_result(const String& id, std::string_view producer, const Vector<String>& free) {
  Value r = Value::object();
  r.set("format", kAnimResult);
  r.set("producer", producer);
  r.set("error", nullptr);
  r.set("warnings", Value::array());
  r.set("scenario", id);
  Value ids = Value::object();
  ids.set("parameters", Value::array());
  ids.set("parts", Value::array());
  ids.set("free", string_array(free));
  r.set("ids", std::move(ids));
  r.set("frames", Value::array());
  r.set("starts", Value::array());
  r.set("randomUsed", 0);
  return r;
}

Value error_value(std::string_view kind, std::string_view message) {
  Value e = Value::object();
  e.set("kind", kind);
  e.set("message", message);
  return e;
}

Value run_anim(const AnimFile& sc, ModelCache& models, std::string_view producer) {
  Value result = anim_result(sc.id, producer, sc.record.free);
  LoadedModel loaded;
  ErrorInfo err;
  if (!models.load(sc.model, loaded, err)) {
    result.set("error", error_value(err.kind, err.message));
    return result;
  }
  const moc::Model& model = *loaded.model;
  Vector<String> warnings = model.load_warnings;
  const Vector<String>& param_ids = sc.record.all_parameters ? model.parameters.ids : sc.record.parameters;
  const Vector<String>& part_ids = sc.record.all_parts ? model.parts.ids : sc.record.parts;
  {
    Value ids = Value::object();
    ids.set("parameters", string_array(param_ids));
    ids.set("parts", string_array(part_ids));
    ids.set("free", string_array(sc.record.free));
    result.set("ids", std::move(ids));
  }
  auto indexer = [](const Vector<String>& all, const Vector<String>& wanted) {
    HashMap<String, int> map;
    for (std::size_t i = 0; i < all.size(); i++) map.emplace(all[i], static_cast<int>(i));
    Vector<int> out;
    for (const auto& id : wanted) {
      const auto it = map.find(id);
      out.push_back(it == map.end() ? -1 : it->second);
    }
    return out;
  };
  const Vector<int> p_idx = indexer(model.parameters.ids, param_ids);
  const Vector<int> part_idx = indexer(model.parts.ids, part_ids);
  for (std::size_t k = 0; k < p_idx.size(); k++)
    if (p_idx[k] < 0) warnings.push_back("unknown parameter " + param_ids[k] + " in record.parameters");
  for (std::size_t k = 0; k < part_idx.size(); k++)
    if (part_idx[k] < 0) warnings.push_back("unknown part " + part_ids[k] + " in record.parts");
  auto set_warnings = [&] { result.set("warnings", string_array(warnings)); };

  ModelFiles files(loaded);
  framework::AnimationScenario run;
  run.model = loaded.model;
  run.instance_options = models.instance_options;
  run.settings = &loaded.settings;
  run.files = &files;
  run.steps = sc.steps;
  run.commands = sc.commands;
  run.random = sc.random;
  run.effects = sc.effects;
  run.idle_motions = sc.idle_motions;
  run.options = sc.options;
  run.record.free_values = sc.record.free;
  run.record.hits = sc.record.hits;
  run.record.drawables = sc.record.drawables;
  framework::AnimationReport report;
  framework::Fault fault;
  if (!framework::run_animation_scenario(run, report, fault)) {
    // The settings name a physics or pose file that is missing or invalid (4j).
    result.set("error", error_value(fault.kind == "AnimationFormatError" ? String("ModelLoadError") : fault.kind,
                                    fault.message));
    set_warnings();
    return result;
  }
  for (auto& w : report.warnings) warnings.push_back(std::move(w));
  set_warnings();
  const std::size_t N = sc.steps.size();
  HashSet<std::size_t> forced;
  for (const auto& h : sc.record.hits) forced.insert(h.frame);
  for (const std::size_t f : sc.record.drawables) forced.insert(f);
  Value frames = Value::array();
  for (const auto& f : report.frames) {
    const std::size_t k = f.frame;
    if (!(std::fmod(static_cast<double>(k), sc.record.every) == 0 || k + 1 == N || forced.count(k))) continue;
    Value out = Value::object();
    out.set("frame", k);
    out.set("time", f.time);
    Value params = Value::array();
    for (const int i : p_idx)
      params.push(i < 0 ? Value() : Value(static_cast<double>(f.parameters[static_cast<std::size_t>(i)])));
    out.set("parameters", std::move(params));
    Value parts = Value::array();
    for (const int i : part_idx)
      parts.push(i < 0 ? Value() : Value(static_cast<double>(f.part_opacities[static_cast<std::size_t>(i)])));
    out.set("parts", std::move(parts));
    Value free = Value::array();
    for (const auto& v : f.free_values) free.push(v ? Value(*v) : Value());
    out.set("free", std::move(free));
    out.set("modelOpacity", f.model_opacity);
    out.set("motionAdvanced", f.motion_updated);
    out.set("queueEmpty", f.queue_empty);
    out.set("events", string_array(f.events));
    out.set("lipsync", f.lip_sync ? Value(*f.lip_sync) : Value());
    if (f.has_hit_records) {
      Value hits = Value::array();
      for (const auto& h : f.hit_records) {
        Value v = Value::object();
        v.set("drawable", h.hit.drawable);
        v.set("x", h.hit.x);
        v.set("y", h.hit.y);
        v.set("hit", h.inside);
        if (h.has_box) {
          Value box = Value::array();
          for (const double b : h.box) box.push(b);
          v.set("box", std::move(box));
        } else {
          v.set("box", nullptr);
        }
        hits.push(std::move(v));
      }
      out.set("hits", std::move(hits));
    }
    if (f.has_drawables) out.set("drawables", f.drawables);
    frames.push(std::move(out));
  }
  result.set("frames", std::move(frames));
  Value starts = Value::array();
  for (const auto& s : report.starts) {
    Value v = Value::object();
    v.set("frame", s.frame);
    if (s.command) v.set("command", *s.command);
    if (s.idle) v.set("idle", *s.idle);
    v.set("started", s.started);
    starts.push(std::move(v));
  }
  result.set("starts", std::move(starts));
  result.set("randomUsed", report.random_used);
  if (report.random_exhausted)
    result.set("error", error_value("RandomExhausted", "the random list (" + to_str(sc.random.size()) +
                                                           " numbers) ran out in frame " + to_str(report.frames.size())));
  return result;
}

}  // namespace

Value run_sequence_json(const Value& json, std::string_view id, ModelCache& models, std::string_view producer) {
  String seq_id, model_path, error;
  Vector<SequenceStep> steps;
  if (!parse_sequence(json, seq_id, model_path, steps, error))
    return invalid_result(id, kSequenceResult, producer, "InvalidScenario", error);
  Value result = Value::object();
  result.set("format", kSequenceResult);
  result.set("producer", producer);
  result.set("error", nullptr);
  result.set("warnings", Value::array());
  result.set("sequence", seq_id);
  result.set("canvas", Value::object());
  result.set("steps", Value::array());
  LoadedModel loaded;
  ErrorInfo err;
  if (!models.load(model_path, loaded, err)) {
    result.set("error", error_value(err.kind, err.message));
    return result;
  }
  Vector<String> warnings = loaded.model->load_warnings;
  eval::Instance inst(loaded.model, models.instance_options);  // the creation evaluation
  Value list = Value::array();
  {
    Value first = Value::object();
    snapshot_into(inst, first);
    if (const Value* canvas = first.get("canvas")) result.set("canvas", *canvas);
    list.push(step_record("create", first));
  }
  for (const auto& step : steps) {
    // Values persist from step to step (4e).
    for (const auto& [pid, value] : step.parameters) {
      const int i = inst.parameter_index(pid);
      if (i < 0)
        warnings.push_back(step.label + ": unknown parameter " + pid);
      else
        inst.set_parameter(i, value);
    }
    for (const auto& [pid, value] : step.part_opacities) {
      const int i = inst.part_index(pid);
      if (i < 0)
        warnings.push_back(step.label + ": unknown part " + pid);
      else
        inst.set_part_opacity(i, value);
    }
    inst.evaluate();
    Value s = Value::object();
    snapshot_into(inst, s);
    list.push(step_record(step.label, s));
  }
  result.set("warnings", string_array(warnings));
  result.set("steps", std::move(list));
  return result;
}

Value run_animation_json(const Value& json, std::string_view id, ModelCache& models, std::string_view producer) {
  AnimFile sc;
  String error;
  if (!parse_anim(json, sc, error)) {
    // A RangeError of the reference's parser (marked with \x01) keeps its own kind.
    if (!error.empty() && error[0] == '\x01') {
      const auto sep = error.find('\x01', 1);
      Value r = invalid_result(id, kAnimResult, producer, "InvalidScenario", "");
      r.set("error", error_value(error.substr(1, sep - 1), error.substr(sep + 1)));
      return r;
    }
    return invalid_result(id, kAnimResult, producer, "InvalidScenario", error);
  }
  return run_anim(sc, models, producer);
}

}  // namespace mochi2d::conformance

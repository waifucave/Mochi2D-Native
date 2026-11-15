#include "framework/animation_scenario.hpp"

#include "core/snapshot.hpp"
#include "framework/model_data.hpp"
#include "util/text.hpp"

namespace mochi2d::framework {

namespace {

const char* const kRandomExhausted = "RandomExhaustedError";

/** The scenario's random sequence: running out is RandomExhaustedError. */
class ListRandom : public RandomSource {
 public:
  explicit ListRandom(const Vector<double>& list) : list_(list) {}
  bool next(double& out, Fault& fault) override {
    if (used >= list_.size()) {
      fault.kind = kRandomExhausted;
      fault.message = "the scenario's random sequence ran out";
      return false;
    }
    out = list_[used++];
    return true;
  }
  std::size_t used = 0;

 private:
  const Vector<double>& list_;
};

class Runner : public IdleMotions {
 public:
  Runner(const AnimationScenario& sc, AnimationReport& report) : sc_(sc), report_(report) {}

  bool lookup(std::string_view path, String& bytes) { return sc_.files && sc_.files->read(path, bytes); }

  std::shared_ptr<const Motion> motion_file(const String& path) {
    const auto it = motions_.find(path);
    if (it != motions_.end()) return it->second;
    std::shared_ptr<const Motion> m;
    String bytes;
    if (!lookup(path, bytes)) {
      report_.warnings.push_back("motion file " + path + " is missing; its starts are dropped");
    } else {
      auto parsed = std::allocate_shared<Motion>(Allocator<Motion>());
      FormatError err;
      if (parse_motion(bytes, path, *parsed, err))
        m = std::move(parsed);
      else
        report_.warnings.push_back("motion file " + path + " is invalid (" + err.message + "); its starts are dropped");
    }
    motions_.emplace(path, m);
    return m;
  }

  std::shared_ptr<const WavSound> sound(const String& path) {
    String bytes;
    if (!lookup(path, bytes)) {
      report_.warnings.push_back("sound file " + path + " is missing");
      return nullptr;
    }
    auto w = std::allocate_shared<WavSound>(Allocator<WavSound>());
    String err;
    if (!decode_wav(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), *w, err)) {
      report_.warnings.push_back("sound file " + path + " cannot be loaded (" + err + ")");
      return nullptr;
    }
    return w;
  }

  /** groupMotion: false when the settings have no such entry. */
  bool group_motion(const String& group, double index, ResolvedMotion& out) {
    const MotionGroup* g = sc_.settings->motion_group(group);
    if (!g || !(index >= 0) || index >= static_cast<double>(g->entries.size())) return false;
    const MotionEntry& entry = g->entries[static_cast<std::size_t>(index)];
    out = ResolvedMotion();
    out.motion = motion_file(entry.file);
    out.fade_in = entry.fade_in_time;
    out.fade_out = entry.fade_out_time;
    if (!entry.sound.empty()) {
      out.has_sound = true;
      out.sound = sound(entry.sound);
    }
    return true;
  }

  std::shared_ptr<const Expression> expression_file(const String& path) {
    const auto it = expressions_.find(path);
    if (it != expressions_.end()) return it->second;
    std::shared_ptr<const Expression> x;
    String bytes;
    if (!lookup(path, bytes)) {
      report_.warnings.push_back("expression file " + path + " is missing; ignored");
    } else {
      auto parsed = std::allocate_shared<Expression>(Allocator<Expression>());
      FormatError err;
      if (parse_expression(bytes, path, *parsed, err))
        x = std::move(parsed);
      else
        report_.warnings.push_back("expression file " + path + " is invalid (" + err.message + "); ignored");
    }
    expressions_.emplace(path, x);
    return x;
  }

  // IdleMotions
  std::size_t count() const override {
    if (sc_.idle_motions) return sc_.idle_motions->size();
    const MotionGroup* g = sc_.settings->motion_group("Idle");
    return g ? g->entries.size() : 0;
  }
  bool motion(std::size_t index, ResolvedMotion& out) override {
    if (sc_.idle_motions) {
      if (index >= sc_.idle_motions->size()) return false;
      out = ResolvedMotion();
      out.motion = motion_file((*sc_.idle_motions)[index]);
      return true;
    }
    return group_motion("Idle", static_cast<double>(index), out);
  }
  void started(std::size_t index, bool accepted) override {
    MotionStartRecord r;
    r.frame = frame;
    r.idle = index;
    r.started = accepted;
    report_.starts.push_back(r);
  }

  void apply(Animator& animator, std::size_t index, const ScenarioCommand& c) {
    using Kind = ScenarioCommand::Kind;
    switch (c.kind) {
      case Kind::StartMotion: {
        ResolvedMotion resolved;
        bool found = true;
        if (c.file) {
          resolved.motion = motion_file(*c.file);
        } else {
          found = group_motion(c.group.value_or(String()), c.index.value_or(0), resolved);
          if (!found)
            report_.warnings.push_back("no motion " + c.group.value_or(String()) + "[" +
                                       text::js_number(c.index.value_or(0)) + "] in the settings");
        }
        MotionStart start;
        start.priority = c.priority.value_or(2);
        start.fade_in = c.fade_in;
        start.fade_out = c.fade_out;
        start.loop = c.loop;
        start.loop_fade_in = c.loop_fade_in;
        start.weight = c.weight;
        start.offset = c.offset;
        start.legacy_loop = c.legacy_loop;
        const bool started = found ? animator.start_motion(resolved, start) : false;
        MotionStartRecord r;
        r.frame = frame;
        r.command = index;
        r.started = started;
        report_.starts.push_back(r);
        break;
      }
      case Kind::StartExpression: {
        String path;
        if (c.file) {
          path = *c.file;
        } else {
          bool found = false;
          for (const auto& e : sc_.settings->expressions)
            if (c.name && e.name == *c.name) {
              path = e.file;
              found = true;
              break;
            }
          if (!found) {
            report_.warnings.push_back("no expression named " + c.name.value_or(String("undefined")) + "; ignored");
            break;
          }
        }
        if (auto x = expression_file(path)) animator.start_expression(std::move(x));
        break;
      }
      case Kind::SetLookTarget:
        animator.set_look_target(c.x, c.y);
        break;
      case Kind::StartSound:
        animator.start_sound(sound(c.file.value_or(String())));
        break;
      case Kind::SetPartOpacity:
        animator.set_part_opacity(c.id, c.value);
        break;
      case Kind::StopMotions:
        animator.stop_motions();
        break;
      case Kind::Enable:
        switch (c.effect) {
          case Effect::Idle: animator.enabled.idle = true; break;
          case Effect::EyeBlink: animator.enabled.eye_blink = true; break;
          case Effect::Expressions: animator.enabled.expressions = true; break;
          case Effect::Look: animator.enabled.look = true; break;
          case Effect::Breath: animator.enabled.breath = true; break;
          case Effect::Physics: animator.enabled.physics = true; break;
          case Effect::LipSync: animator.enabled.lip_sync = true; break;
          case Effect::Pose: animator.enabled.pose = true; break;
          case Effect::None: break;
        }
        break;
    }
  }

  std::size_t frame = 0;

 private:
  const AnimationScenario& sc_;
  AnimationReport& report_;
  HashMap<String, std::shared_ptr<const Motion>> motions_;
  HashMap<String, std::shared_ptr<const Expression>> expressions_;
};

void apply_overrides(EffectSwitches& on, const EffectOverrides& o) {
  if (o.idle) on.idle = *o.idle;
  if (o.eye_blink) on.eye_blink = *o.eye_blink;
  if (o.expressions) on.expressions = *o.expressions;
  if (o.look) on.look = *o.look;
  if (o.breath) on.breath = *o.breath;
  if (o.physics) on.physics = *o.physics;
  if (o.lip_sync) on.lip_sync = *o.lip_sync;
  if (o.pose) on.pose = *o.pose;
}

}  // namespace

bool run_animation_scenario(const AnimationScenario& sc, AnimationReport& out, Fault& error) {
  out = AnimationReport();
  const ModelSettings& settings = *sc.settings;
  Runner runner(sc, out);
  auto required = [&](const String& path, String& bytes) {
    if (runner.lookup(path, bytes)) return true;
    error.kind = "AnimationFormatError";
    error.message = "file " + path + " is missing";
    return false;
  };
  PhysicsFile physics;
  PoseFile pose;
  const bool has_physics = !settings.physics.empty();
  const bool has_pose = !settings.pose.empty();
  if (has_physics) {
    String bytes;
    if (!required(settings.physics, bytes)) return false;
    FormatError err;
    if (!parse_physics(bytes, settings.physics, physics, err)) {
      error.kind = "AnimationFormatError";
      error.message = err.message;
      return false;
    }
  }
  if (has_pose) {
    String bytes;
    if (!required(settings.pose, bytes)) return false;
    FormatError err;
    if (!parse_pose(bytes, settings.pose, pose, err)) {
      error.kind = "AnimationFormatError";
      error.message = err.message;
      return false;
    }
  }
  ListRandom random(sc.random);
  AnimatorOptions options;
  options.random = &random;
  options.idle = &runner;
  options.wrap = sc.options.wrap.value_or(false);
  options.gravity = sc.options.gravity;
  options.wind = sc.options.wind;
  options.settle = sc.options.settle.value_or(false);
  if (sc.options.eye_blink) options.eye_blink = *sc.options.eye_blink;
  Animator animator(sc.model, settings, has_physics ? &physics : nullptr, has_pose ? &pose : nullptr, options);
  if (!animator.ok()) {
    error = animator.fault();
    return false;
  }
  apply_overrides(animator.enabled, sc.effects);

  const auto& rec = sc.record;
  const bool any_hits = !rec.hits.empty();
  const bool any_drawables = !rec.drawables.empty();
  const bool evaluate_every_frame = rec.evaluate_every_frame || !rec.hit_tests.empty() || any_hits || any_drawables;
  // A fresh instance: its creation evaluation uses the defaults (4j step 1).
  std::optional<eval::Instance> instance;
  if (evaluate_every_frame) instance.emplace(sc.model, sc.instance_options);
  HashMap<String, std::size_t> mesh_index;
  const auto& mesh_ids = sc.model->meshes.ids;
  for (std::size_t i = 0; i < mesh_ids.size(); i++) mesh_index.emplace(mesh_ids[i], i);
  auto hit_record = [&](const ScenarioHit& h) {
    HitRecord r;
    r.hit = h;
    const auto it = mesh_index.find(h.drawable);
    if (it == mesh_index.end()) return r;
    const auto& v = instance->drawable_vertices[it->second];
    const Bounds b = vertex_bounds(v.data(), v.size());
    r.inside = b.min_x <= h.x && h.x <= b.max_x && b.min_y <= h.y && h.y <= b.max_y;
    r.has_box = true;
    r.box[0] = b.min_x;
    r.box[1] = b.max_x;
    r.box[2] = b.min_y;
    r.box[3] = b.max_y;
    return r;
  };

  double time = 0;
  for (std::size_t frame = 0; frame < sc.steps.size(); frame++) {
    runner.frame = frame;
    const double dt = sc.steps[frame];
    for (std::size_t k = 0; k < sc.commands.size(); k++)
      if (sc.commands[k].first == frame) runner.apply(animator, k, sc.commands[k].second);
    FrameResult r;
    Fault fault;
    if (!animator.frame(dt, r, fault)) {
      if (fault.kind == kRandomExhausted) {
        out.random_exhausted = true;
        break;
      }
      out.random_used = random.used;
      error = std::move(fault);
      return false;
    }
    time += dt;
    const AnimationValues& v = animator.values;
    FrameRecord record;
    record.frame = frame;
    record.time = time;
    record.parameters = v.values;
    record.part_opacities = v.part_opacities;
    for (const auto& id : rec.free_values) {
      const int p = v.index(id);
      if (p >= 0)
        record.free_values.emplace_back(static_cast<double>(v.values[static_cast<std::size_t>(p)]));
      else if (const double* f = v.free_value(id))
        record.free_values.emplace_back(*f);
      else
        record.free_values.emplace_back(std::nullopt);
    }
    record.model_opacity = v.model_opacity;
    record.motion_updated = r.motion_updated;
    record.queue_empty = r.queue_empty;
    record.events = std::move(r.events);
    record.lip_sync = r.lip_sync;
    if (instance) {
      animator.apply_to(*instance);
      instance->evaluate();
      for (const auto& h : rec.hit_tests) record.hits.push_back(hit_record(h).inside ? 1 : 0);
      for (const auto& h : rec.hits)
        if (h.frame == frame) {
          record.has_hit_records = true;
          record.hit_records.push_back(hit_record(h.hit));
        }
      bool snapshot = false;
      for (const std::size_t f : rec.drawables) snapshot = snapshot || f == frame;
      if (snapshot) {
        json::Value s = json::Value::object();
        snapshot_into(*instance, s);
        if (const json::Value* d = s.get("drawables")) record.drawables = *d;
        record.has_drawables = true;
      }
    }
    out.frames.push_back(std::move(record));
  }
  out.random_used = random.used;
  return true;
}

}  // namespace mochi2d::framework

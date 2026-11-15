#include "framework/animator.hpp"

#include <cmath>

#include "util/text.hpp"

namespace mochi2d::framework {

namespace {
/** The LipSync IDs, or Mochi2D's runtime fallback when the settings list none and the model has it. */
Vector<String> lip_sync_ids(const ModelSettings& settings, const moc::Model& model, const std::optional<String>& fallback) {
  Vector<String> ids = parameter_group_ids(settings, "LipSync");
  if (ids.empty() && fallback)
    for (const auto& id : model.parameters.ids)
      if (id == *fallback) {
        ids.push_back(*fallback);
        break;
      }
  return ids;
}
}  // namespace

Animator::Animator(std::shared_ptr<const moc::Model> model, const ModelSettings& settings, const PhysicsFile* physics_file,
                   const PoseFile* pose_file, AnimatorOptions options)
    : values(*model),
      motions(parameter_group_ids(settings, "EyeBlink"), lip_sync_ids(settings, *model, options.lip_sync_fallback)),
      breath(options.breath ? std::move(*options.breath) : reference_breath()),
      look(options.look ? std::move(*options.look) : reference_look()),
      model_(std::move(model)),
      settings_(&settings),
      random_(options.random),
      idle_(options.idle) {
  values.wrap = options.wrap;
  Vector<String> blink = parameter_group_ids(settings, "EyeBlink");
  Vector<String> lip = lip_sync_ids(settings, *model_, options.lip_sync_fallback);
  if (parameter_group_ids(settings, "LipSync").empty() && !lip.empty()) lip_sync_fallback = lip[0];
  if (!blink.empty()) eye_blink.emplace(std::move(blink), static_cast<RandomDraw*>(this), options.eye_blink);
  if (!lip.empty()) lip_sync.emplace(std::move(lip));
  if (physics_file) {
    physics.emplace(*physics_file, values);
    if (options.gravity) {
      physics->gravity[0] = options.gravity->first;
      physics->gravity[1] = options.gravity->second;
    }
    if (options.wind) {
      physics->wind[0] = options.wind->first;
      physics->wind[1] = options.wind->second;
    }
    if (options.settle && !physics->settle(fault_)) ok_ = false;
  }
  if (pose_file) pose.emplace(*pose_file, values);
  if (idle_) {
    idle_count = idle_->count();
  } else if (const MotionGroup* g = settings.motion_group("Idle")) {
    idle_count = g->entries.size();
  }
  enabled.idle = idle_count > 0;
  enabled.eye_blink = eye_blink.has_value();
  enabled.physics = physics.has_value();
  enabled.lip_sync = lip_sync.has_value();
  enabled.pose = pose.has_value();
}

bool Animator::draw(double& r, Fault& fault) {
  if (random_) {
    if (!random_->next(r, fault)) return false;
  } else {
    // xorshift128+, as V8's Math.random, with a fixed seed.
    uint64_t s1 = rng_[0];
    const uint64_t s0 = rng_[1];
    rng_[0] = s0;
    s1 ^= s1 << 23;
    s1 ^= s1 >> 17;
    s1 ^= s0;
    s1 ^= s0 >> 26;
    rng_[1] = s1;
    r = static_cast<double>(rng_[0] >> 11) / 9007199254740992.0;
  }
  if (!(r >= 0 && r < 1)) {
    fault.kind = "RangeError";
    fault.message = "random draw " + text::js_number(r) + " is not in [0, 1)";
    return false;
  }
  return true;
}

bool Animator::start_motion(const ResolvedMotion& resolved, const MotionStart& opts) {
  MotionStart start = opts;
  if (!start.fade_in && resolved.fade_in) start.fade_in = resolved.fade_in;
  if (!start.fade_out && resolved.fade_out) start.fade_out = resolved.fade_out;
  const bool accepted = motions.start(resolved.motion, start);
  if (accepted && resolved.has_sound) start_sound(resolved.sound);
  return accepted;
}

void Animator::start_sound(std::shared_ptr<const WavSound> sound) {
  if (lip_sync) lip_sync->start(std::move(sound));
}

bool Animator::set_live_lip_sync(LiveLipSyncSource* source, LiveLipSyncMix mix) {
  if (!lip_sync) return false;
  lip_sync->set_live(source, mix);
  return true;
}

void Animator::set_base_parameter(int index, double value) {
  values.set_at(index, value);
  values.saved[static_cast<std::size_t>(index)] = values.values[static_cast<std::size_t>(index)];
}

void Animator::attach_motion_sync(std::shared_ptr<const MotionSyncFile> file, const MotionSyncOptions& options) {
  motion_sync.reset();
  if (file) motion_sync.emplace(std::move(file), values, options);
  enabled.motion_sync = motion_sync.has_value();
}

bool Animator::frame(double dt, FrameResult& out, Fault& fault) {
  AnimationValues& v = values;
  const EffectSwitches& on = enabled;
  out = FrameResult();
  v.restore();
  bool motion_updated = false;
  if (motions.empty()) {
    if (on.idle && idle_count > 0) {
      double r;
      if (!draw(r, fault)) return false;
      const double picked = std::floor(r * static_cast<double>(idle_count));
      const auto index = static_cast<std::size_t>(picked);
      ResolvedMotion resolved;
      bool started = false;
      MotionStart idle_start;
      idle_start.priority = 1;
      if (idle_ && idle_->motion(index, resolved)) started = start_motion(resolved, idle_start);
      if (idle_) idle_->started(index, started);
    }
  } else {
    motions.advance(dt, v, out.events);
    motion_updated = true;
  }
  v.save();
  // Eye blink runs while no motion plays (3j), and, not reference behavior,
  // while every queued motion is held at its end (unless started with blink_while_held off).
  if (eye_blink && on.eye_blink && (!motion_updated || motions.blink_allowed()))
    if (!eye_blink->frame(dt, v, fault)) return false;
  if (on.expressions) {
    expressions.advance(dt, v);
    expression_layers.advance(dt, v);
  }
  if (on.look) look.frame(dt, v);
  if (on.breath) breath.frame(dt, v);
  MotionSyncDriver* sync = motion_sync && on.motion_sync ? &*motion_sync : nullptr;
  if (sync && sync->options().before_physics) sync->frame(dt);
  if (physics && on.physics)
    if (!physics->frame(dt, fault)) return false;
  if (lip_sync && on.lip_sync) {
    // Lip sync leaves the parameters that motion sync drives.
    lip_sync->frame(dt, v, sync && sync->setting() ? &sync->driven_ids() : nullptr);
    out.lip_sync = lip_sync->value;
  }
  // Motion sync: after lip sync, before pose (or before physics, above).
  if (sync && !sync->options().before_physics) sync->frame(dt);
  if (pose && on.pose) pose->frame(dt);
  out.motion_updated = motion_updated;
  out.queue_empty = motions.empty();
  out.ends = motions.take_ends();
  return true;
}

void Animator::apply_to(eval::Instance& inst) const {
  for (std::size_t i = 0; i < values.values.size(); i++) inst.set_parameter(static_cast<int>(i), values.values[i]);
  for (std::size_t i = 0; i < values.part_opacities.size(); i++)
    inst.set_part_opacity(static_cast<int>(i), values.part_opacities[i]);
}

}  // namespace mochi2d::framework

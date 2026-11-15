// The frame procedure of 3j: restore, motions, save, the effects in
// their fixed order, then evaluation by the caller. Port of Mochi2D's
// src/anim/animator.ts.
#pragma once

#include <cstdint>
#include <memory>
#include <optional>

#include "core/eval/instance.hpp"
#include "core/moc/model.hpp"
#include "framework/effects.hpp"
#include "framework/expression.hpp"
#include "framework/lip_sync.hpp"
#include "framework/motion_queue.hpp"
#include "framework/motion_sync_driver.hpp"
#include "framework/physics.hpp"
#include "framework/pose.hpp"
#include "framework/settings.hpp"
#include "framework/values.hpp"

namespace mochi2d::framework {

/** Which components run (3w.1). A component that is not present never runs. */
struct EffectSwitches {
  /** Idle playback of the `Idle` group (3l.7). */
  bool idle = false;
  bool eye_blink = false;
  bool expressions = true;
  bool look = true;
  bool breath = true;
  bool physics = false;
  bool lip_sync = false;
  bool pose = false;
  /** Motion sync: a sound or live input bound to a setting drives the mouth (not reference behavior). */
  bool motion_sync = false;
};

/** A motion file and its sound, as resolved by the application. */
struct ResolvedMotion {
  /** Null when the file failed validation (3c.4). */
  std::shared_ptr<const Motion> motion;
  /** Fade-time overrides from the settings entry (3b.2). */
  std::optional<double> fade_in, fade_out;
  /** Whether the entry names a sound; `sound` is null when it could not be loaded. */
  bool has_sound = false;
  std::shared_ptr<const WavSound> sound;
};

/** Where the animator gets the motions of idle playback (3l.7). */
class IdleMotions {
 public:
  virtual ~IdleMotions() = default;
  /** Number of motions to pick from. */
  virtual std::size_t count() const = 0;
  /** The motion with this index; false when there is none. */
  virtual bool motion(std::size_t index, ResolvedMotion& out) = 0;
  /** Called after each idle start attempt with the picked index. */
  virtual void started(std::size_t index, bool accepted) {
    (void)index;
    (void)accepted;
  }
};

/** The random sequence (3v.2) of the animator. */
class RandomSource {
 public:
  virtual ~RandomSource() = default;
  /** The next number; false with a fault when there is none. */
  virtual bool next(double& out, Fault& fault) = 0;
};

struct AnimatorOptions {
  /** Wrap mode (3g.2); default off. */
  bool wrap = false;
  /** Physics gravity and wind (3n.2); defaults (0, −1) and (0, 0). */
  std::optional<std::pair<double, double>> gravity, wind;
  /** Run the physics settle procedure (3n.8) once after load. */
  bool settle = false;
  EyeBlinkTiming eye_blink;
  std::optional<Vector<BreathEntry>> breath;
  std::optional<Vector<LookEntry>> look;
  /**
   * The shared random sequence; must outlive the animator. Without one, a
   * built-in generator with a fixed seed is used (the reference uses
   * Math.random).
   */
  RandomSource* random = nullptr;
  /** The idle motions; none by default. Must outlive the animator. */
  IdleMotions* idle = nullptr;
  /**
   * Mochi2D's runtime option `lipSyncFallback` (not reference behavior):
   * when the settings list no LipSync parameters (no group, or one with no
   * IDs), lip sync and the motions' LipSync curves drive this parameter, if
   * the model has it. None (the default here) keeps the reference rule; the
   * C API defaults to Mochi2D's "ParamMouthOpenY".
   */
  std::optional<String> lip_sync_fallback;
};

struct FrameResult {
  bool motion_updated = false;
  bool queue_empty = true;
  Vector<String> events;
  /** The lip-sync value of this frame, if lip sync ran. */
  std::optional<double> lip_sync;
  /** Motions that ended in this frame (or, held, reached their end). */
  Vector<MotionEnded> ends;
};

class Animator : private RandomDraw {
 public:
  /**
   * The model, the settings and the physics and pose files must outlive the
   * animator (physics and pose may be null). False from `ok()` with the fault
   * of the settle procedure.
   */
  Animator(std::shared_ptr<const moc::Model> model, const ModelSettings& settings, const PhysicsFile* physics,
           const PoseFile* pose, AnimatorOptions options = {});
  Animator(const Animator&) = delete;
  Animator& operator=(const Animator&) = delete;

  /** False when construction failed (the settle procedure raised an error); see `fault()`. */
  bool ok() const { return ok_; }
  const Fault& fault() const { return fault_; }

  AnimationValues values;
  MotionQueue motions;
  ExpressionQueue expressions;
  /** Expressions added on top of the queue, several at once (not reference behavior). */
  ExpressionLayers expression_layers;
  std::optional<EyeBlink> eye_blink;
  Breath breath;
  Look look;
  std::optional<PhysicsRig> physics;
  std::optional<LipSync> lip_sync;
  std::optional<PoseRig> pose;
  /** Motion sync, when the model has a motion-sync file (see attach_motion_sync). */
  std::optional<MotionSyncDriver> motion_sync;
  EffectSwitches enabled;
  /** Number of motions of idle playback. */
  std::size_t idle_count = 0;
  /** The parameter the lip-sync fallback drives, or empty when it does not apply. */
  String lip_sync_fallback;

  const moc::Model& model() const { return *model_; }
  const ModelSettings& settings() const { return *settings_; }

  /** Starts a motion (3l.4); its sound starts too when the start is accepted. */
  bool start_motion(const ResolvedMotion& resolved, const MotionStart& opts = {});
  void start_expression(std::shared_ptr<const Expression> expression) { expressions.start(std::move(expression)); }
  void set_look_target(double x, double y) { look.set_target(x, y); }
  /** Starts lip sync on a sound; null (a file that could not be loaded) stops it. */
  void start_sound(std::shared_ptr<const WavSound> sound);
  /** Adds a live lip-sync input (nullptr removes it); false when there is no lip sync. */
  bool set_live_lip_sync(LiveLipSyncSource* source, LiveLipSyncMix mix = LiveLipSyncMix::Add);
  void set_part_opacity(const String& id, double value) { values.set_part_opacity(id, value); }
  void stop_motions() { motions.stop_all(); }
  /**
   * An application edit of a parameter's base value (a viewer slider): it is
   * saved, so it persists like a motion's result, and effects apply on top.
   */
  void set_base_parameter(int index, double value);

  /**
   * Gives the animator the model's motion-sync file (Mochi2D's
   * `assets.motionSync` with `options.motionSync`): a new driver, which
   * runs before physics with `options.before_physics`, else after lip sync
   * and before pose. Null removes it. The effect switch follows.
   */
  void attach_motion_sync(std::shared_ptr<const MotionSyncFile> file, const MotionSyncOptions& options = {});

  /**
   * One frame of the procedure of 3j (steps 1–4), with step dt. False with
   * the fault when the reference raises an error during the frame (the
   * random sequence ran out, a physics file it cannot run); the frame is then
   * incomplete.
   */
  bool frame(double dt, FrameResult& out, Fault& fault);

  /** Step 5's input: hands parameter values and part opacities to an evaluation instance. */
  void apply_to(eval::Instance& inst) const;

 private:
  bool draw(double& out, Fault& fault) override;

  std::shared_ptr<const moc::Model> model_;
  const ModelSettings* settings_;
  RandomSource* random_;
  IdleMotions* idle_;
  uint64_t rng_[2] = {0x9e3779b97f4a7c15ull, 0xd1b54a32d192ed03ull};
  bool ok_ = true;
  Fault fault_;
};

}  // namespace mochi2d::framework

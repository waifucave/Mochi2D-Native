// Motion playback (3l): a queue with its own clock, sine fades, looping
// with the end interval, events, and the reference viewer's priorities. Port
// of Mochi2D's src/anim/motion-queue.ts.
#pragma once

#include <cstdint>
#include <memory>
#include <optional>

#include "framework/motion.hpp"
#include "framework/values.hpp"
#include "util/alloc.hpp"

namespace mochi2d::framework {

/** The easing E of 3l.3 b. */
double ease(double x);

/** How a motion is started (3l.1, 3w.2). Unset members take their defaults. */
struct MotionStart {
  /** 0 none, 1 idle, 2 normal (default), 3 force (3l.4). */
  std::optional<double> priority;
  /** Override the file's fade times; used only when ≥ 0. */
  std::optional<double> fade_in, fade_out;
  /** Default 1. */
  std::optional<double> weight;
  /** Start this many seconds into the motion; default 0. */
  std::optional<double> offset;
  /** Default off. */
  std::optional<bool> loop;
  /** Each loop starts a new fade-in; default on. */
  std::optional<bool> loop_fade_in;
  /** Legacy loop behavior of 3l.5: L = Duration, no end interval, restart at T. */
  std::optional<bool> legacy_loop;
  /**
   * Hold the last frame (not reference behavior; ignored with `loop`): no
   * fade-out at the end, and the values at the end stay until the queue is
   * stopped or another motion starts. A held motion that reached its end no
   * longer keeps the priority. Default off.
   */
  std::optional<bool> hold;
  /** With `hold`: whether eye blink may run while the motion stays at its end. Default on. */
  std::optional<bool> blink_while_held;
};

/** Why a motion ended. */
enum class MotionEndReason : uint8_t { Finished, Replaced, Stopped };

/** A motion that ended: it left the queue, or (held) reached its end. */
struct MotionEnded {
  /** The number of its start (see MotionQueue::last_ticket). */
  uint32_t ticket = 0;
  std::shared_ptr<const Motion> motion;
  MotionEndReason reason = MotionEndReason::Finished;
};

class MotionQueue {
 public:
  /** IDs of the settings' EyeBlink and LipSync groups (the first 64 of each are used). */
  MotionQueue(const Vector<String>& eye_blink, const Vector<String>& lip_sync);

  /** The queue clock T. */
  double time = 0;
  /** The current priority (3l.4). */
  double current_priority = 0;
  /** The number of the latest accepted start (1, 2, …; 0 before any). */
  uint32_t last_ticket = 0;
  /**
   * Idle weights (not reference behavior): for a parameter ID, how far
   * motions started at the idle priority (1) move it, in [0, 1]. A motion
   * that would move it by w of the way to its curve value moves it by w·k.
   * At 0 they leave it untouched. IDs not listed weigh 1, as without
   * weights. Other motions are not affected.
   */
  HashMap<String, double> idle_weights;
  /**
   * Sets an idle weight as Mochi2D's runtime does (setIdleWeight): limited to
   * [0, 1], and 1 removes it. False for NaN (the runtime's RangeError).
   */
  bool set_idle_weight(const String& id, double weight);
  /** An idle weight; 1 unless set. */
  double idle_weight(const String& id) const;

  bool empty() const { return entries_.empty(); }
  std::size_t size() const { return entries_.size(); }
  /**
   * Whether eye blink may run in a frame that advanced the queue: the queue
   * holds motions, every one held at its end, none started with
   * blink_while_held off.
   */
  bool blink_allowed() const;
  /** The motions in the queue, oldest first. */
  Vector<std::shared_ptr<const Motion>> motions() const;
  /** Whether a start with this priority would be accepted (3l.4). */
  bool accepts(double priority = 2) const { return priority == 3 || priority > current_priority; }
  /**
   * Starts a motion (3l.4). A null motion stands for a file that failed
   * validation: the start is dropped. Returns whether the motion was enqueued.
   */
  bool start(std::shared_ptr<const Motion> motion, const MotionStart& opts = {});
  /** Empties the queue. */
  void stop_all();
  /** The ends recorded since the last call, oldest first. */
  Vector<MotionEnded> take_ends();
  /** The fade-out time of the start `ticket` once it was asked to fade out and has not ended (fadeOutOf). */
  std::optional<double> fade_out_of(uint32_t ticket) const;
  /** 3l.3: advances the queue by dt, writing into `values`; appends the events fired. */
  void advance(double dt, AnimationValues& values, Vector<String>& events);

 private:
  struct Entry {
    uint32_t ticket = 0;
    std::shared_ptr<const Motion> motion;
    /** Started at the idle priority (1): its parameter writes follow the idle weights. */
    bool idle = false;
    bool hold = false, holding = false, blink_while_held = true, ended = false;
    double fade_in = 0, fade_out = 0, weight = 1, offset = 0;
    bool loop = false, loop_fade_in = true, legacy = false, started = false;
    double s = 0, f = 0;
    bool has_e = false;
    double e = 0;
    bool fade_out_requested = false;
    double t_prev = 0;
    Vector<const MotionCurve*> model, parameters, part_opacities;
    HashSet<String> parameter_ids;
  };
  void end(Entry& en, MotionEndReason reason);

  Vector<Entry> entries_;
  Vector<MotionEnded> ended_;
  Vector<String> blink_, lip_;
  HashSet<String> blink_set_, lip_set_;
};

}  // namespace mochi2d::framework

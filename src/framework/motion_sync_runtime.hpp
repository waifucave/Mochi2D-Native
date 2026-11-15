// The motion-sync part of Mochi2D's model runtime
// (src/runtime/model-runtime.ts): a motion's linked sound bound to its
// entry's setting when the start is accepted, sounds played through a
// setting, live inputs, and the end of a motion's sound: it plays once, fades
// out with its motion over the motion's fade-out time, and stops when the
// motion is stopped or replaced early.
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string_view>

#include "framework/animator.hpp"
#include "framework/motion_sync_driver.hpp"

namespace mochi2d::framework {

class MotionSyncRuntime {
 public:
  /** The animator must outlive the runtime. */
  explicit MotionSyncRuntime(Animator& animator) : animator_(&animator) {}

  /** Warnings, as Mochi2D's runtime words them; the caller takes them. */
  Vector<String> warnings;

  enum class Find { Found, None, Unknown };
  /**
   * A setting by dictionary name or ID (`ref`), or with none the first
   * usable one: None without a file or usable setting, Unknown (with
   * Mochi2D's RangeError message) for a `ref` the file lacks.
   */
  Find find(const std::string_view* ref, int& index, String& message) const;

  /**
   * bindMotionSound: binds the sound of the start `ticket` to its entry's
   * setting `ref`. `path` is the sound's resolved path; `sound` its decoding
   * for motion sync, null when it cannot be decoded (with `failure` the
   * reason the first time, null later: the warning is given once). True
   * when the sound was bound.
   */
  bool bind_motion_sound(uint32_t ticket, std::string_view path, std::shared_ptr<const MotionSyncSound> sound,
                         const String* failure, std::string_view ref, MotionSyncClock* clock);
  /**
   * The first half of bindMotionSound: the setting a link names, or null
   * with Mochi2D's warning (no motion-sync file; a setting missing or that
   * cannot run). The sound is decoded only after this, as in Mochi2D.
   */
  const MotionSyncSetting* link_setting(std::string_view path, std::string_view ref);
  /** The second half: binds the decoded sound (null: the decoding's warning, once) to `setting`. */
  bool bind_linked(uint32_t ticket, std::string_view path, const MotionSyncSetting& setting,
                   std::shared_ptr<const MotionSyncSound> sound, const String* failure, MotionSyncClock* clock);

  /**
   * startMotionSync: plays a sound through `ref` (null: the first usable
   * setting). False when the model has no usable setting, or `ref` names an
   * unusable one; Unknown sets `unknown` with the message.
   */
  bool start(std::shared_ptr<const MotionSyncSound> sound, const std::string_view* ref, MotionSyncClock* clock,
             bool& unknown, String& message);
  /** setMotionSyncInput: null stops the input (true when there is motion sync). */
  bool set_input(MotionSyncInput* input, const std::string_view* ref, bool& unknown, String& message);
  /** stopMotionSync. */
  void stop(double fade = 0);

  /** After each frame: a motion's sound fades out with it, or stops when it ends early. */
  void after_frame(const Vector<MotionEnded>& ends);

  /** The start whose sound is bound, if any. */
  std::optional<uint32_t> motion_ticket() const;

 private:
  void take_warnings();
  Animator* animator_;
  struct Motion {
    uint32_t ticket;
    bool fading;
  };
  std::optional<Motion> motion_;
};

}  // namespace mochi2d::framework

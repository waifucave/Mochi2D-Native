#include "framework/motion_sync_runtime.hpp"

namespace mochi2d::framework {

MotionSyncRuntime::Find MotionSyncRuntime::find(const std::string_view* ref, int& index, String& message) const {
  index = -1;
  const MotionSyncDriver* driver = animator_->motion_sync ? &*animator_->motion_sync : nullptr;
  if (!driver) return Find::None;
  const MotionSyncFile& file = driver->file();
  if (!ref) {
    for (const auto& s : file.settings)
      if (s.usable) {
        index = s.index;
        return Find::Found;
      }
    return Find::None;
  }
  const MotionSyncSetting* s = find_motion_sync_setting(file, *ref);
  if (!s) {
    message = file.label + ": no motion-sync setting \"" + String(*ref) + "\"";
    return Find::Unknown;
  }
  index = s->index;
  return Find::Found;
}

void MotionSyncRuntime::take_warnings() {
  if (!animator_->motion_sync) return;
  auto& w = animator_->motion_sync->warnings;
  for (auto& x : w) warnings.push_back(std::move(x));
  w.clear();
}

const MotionSyncSetting* MotionSyncRuntime::link_setting(std::string_view path, std::string_view ref) {
  MotionSyncDriver* driver = animator_->motion_sync ? &*animator_->motion_sync : nullptr;
  const String p(path), r(ref);
  if (!driver) {
    warnings.push_back(p + ": the motion names motion-sync setting \"" + r +
                       "\", but the model has no motion-sync file");
    return nullptr;
  }
  const MotionSyncSetting* setting = find_motion_sync_setting(driver->file(), ref);
  if (!setting || !setting->usable) {
    warnings.push_back(p + ": motion-sync setting \"" + r + "\" " + (setting ? "cannot run" : "is not in the file") +
                       "; the sound plays without motion sync");
    return nullptr;
  }
  return setting;
}

bool MotionSyncRuntime::bind_linked(uint32_t ticket, std::string_view path, const MotionSyncSetting& setting,
                                    std::shared_ptr<const MotionSyncSound> sound, const String* failure,
                                    MotionSyncClock* clock) {
  if (!sound) {
    if (failure) warnings.push_back(String(path) + ": " + *failure + "; no motion sync");
    return false;
  }
  animator_->motion_sync->play_sound(setting.index, std::move(sound), clock);
  take_warnings();
  motion_ = Motion{ticket, false};
  return true;
}

bool MotionSyncRuntime::bind_motion_sound(uint32_t ticket, std::string_view path,
                                          std::shared_ptr<const MotionSyncSound> sound, const String* failure,
                                          std::string_view ref, MotionSyncClock* clock) {
  const MotionSyncSetting* setting = link_setting(path, ref);
  return setting && bind_linked(ticket, path, *setting, std::move(sound), failure, clock);
}

bool MotionSyncRuntime::start(std::shared_ptr<const MotionSyncSound> sound, const std::string_view* ref,
                              MotionSyncClock* clock, bool& unknown, String& message) {
  unknown = false;
  int index;
  const Find f = find(ref, index, message);
  if (f == Find::Unknown) {
    unknown = true;
    return false;
  }
  MotionSyncDriver* driver = animator_->motion_sync ? &*animator_->motion_sync : nullptr;
  if (!driver || f == Find::None) return false;
  const bool ok = driver->play_sound(index, std::move(sound), clock);
  motion_.reset();
  take_warnings();
  return ok;
}

bool MotionSyncRuntime::set_input(MotionSyncInput* input, const std::string_view* ref, bool& unknown,
                                  String& message) {
  unknown = false;
  MotionSyncDriver* driver = animator_->motion_sync ? &*animator_->motion_sync : nullptr;
  if (!driver) return false;
  if (!input) {
    driver->stop();
    return true;
  }
  int index;
  const Find f = find(ref, index, message);
  if (f == Find::Unknown) {
    unknown = true;
    return false;
  }
  if (f == Find::None) return false;
  const bool ok = driver->set_input(index, input);
  take_warnings();
  return ok;
}

void MotionSyncRuntime::stop(double fade) {
  if (animator_->motion_sync) animator_->motion_sync->stop(fade);
}

void MotionSyncRuntime::after_frame(const Vector<MotionEnded>& ends) {
  MotionSyncDriver* driver = animator_->motion_sync ? &*animator_->motion_sync : nullptr;
  // A motion-sync sound fades out with its motion, over the motion's fade-out time.
  if (motion_ && !motion_->fading) {
    const std::optional<double> fade = animator_->motions.fade_out_of(motion_->ticket);
    if (fade) {
      motion_->fading = true;
      if (driver) driver->stop(*fade);
    }
  }
  // A motion-sync sound plays once; a motion stopped early stops it (when it
  // was not already fading with its motion).
  for (const auto& e : ends) {
    if (motion_ && e.ticket == motion_->ticket) {
      const bool fading = motion_->fading;
      motion_.reset();
      if (e.reason != MotionEndReason::Finished && !fading && driver) driver->stop(0);
    }
  }
}

std::optional<uint32_t> MotionSyncRuntime::motion_ticket() const {
  if (!motion_) return std::nullopt;
  return motion_->ticket;
}

}  // namespace mochi2d::framework

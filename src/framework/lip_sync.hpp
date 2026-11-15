// Lip sync (3s): WAV decoding as in 3s.1 and the per-frame RMS analysis
// of 3s.2, with an optional live input (not reference behavior). Port of
// Mochi2D's src/anim/lip-sync.ts.
#pragma once

#include <cstdint>
#include <memory>
#include <string_view>

#include "framework/jsutil.hpp"
#include "framework/values.hpp"
#include "util/alloc.hpp"

namespace mochi2d::framework {

struct WavSound {
  double channels = 0;
  double sample_rate = 0;
  double bits_per_sample = 0;
  /** Samples per channel. NaN for a file whose samples have no size (bits 0) and no data. */
  double frames = 0;
  /** Decoded samples, one array per channel (float32 values). */
  Vector<Vector<double>> samples;
};

/**
 * Decodes a RIFF WAV file (3s.1): linear PCM only, 8-bit unsigned or
 * 16/24-bit signed little-endian samples, any channel count and rate; other
 * sample sizes load but read as silence. False with the reference's message
 * for files that are not loaded.
 */
bool decode_wav(const uint8_t* bytes, std::size_t size, WavSound& out, String& error);

/** A live lip-sync input, such as a microphone: one value per frame (not reference behavior). */
class LiveLipSyncSource {
 public:
  virtual ~LiveLipSyncSource() = default;
  /** The value to add to the LipSync parameters this frame, ≥ 0. */
  virtual double next(double dt) = 0;
};

/** How a live value combines with each lip-sync parameter (not reference behavior). */
enum class LiveLipSyncMix : uint8_t { Add, Replace, Max, Function };

/** A mix function: the value to write from the live value, the value so far and the parameter ID. */
using LiveLipSyncMixFunction = double (*)(double live, double current, const char* id, void* user);

/**
 * 3s.2: the RMS of the samples since the previous frame, added to the LipSync
 * parameters. A live input is applied after the sound, by its mix mode.
 */
class LipSync {
 public:
  explicit LipSync(Vector<String> ids) : ids_(std::move(ids)) {}

  double time = 0;
  /**
   * The value of the latest frame: the sound's, plus the live input's (with
   * Replace or a function, the live input's; with Max, the larger). 0 with
   * neither; NaN when a frame covered no sample of the sound and there is no
   * live input.
   */
  double value = 0;
  /** The sound's part of `value`: 0 with no sound, NaN for an empty window. */
  double sound_value = 0;
  /** The live input's part of `value`. */
  double live_value = 0;
  LiveLipSyncMix live_mix = LiveLipSyncMix::Add;
  LiveLipSyncMixFunction mix_function = nullptr;
  void* mix_user = nullptr;

  LiveLipSyncSource* live_source() const { return live_; }
  /** Adds a live input alongside sounds (nullptr removes it); it must outlive its use. */
  void set_live(LiveLipSyncSource* source, LiveLipSyncMix mix = LiveLipSyncMix::Add);
  /** Starts a sound (nullptr stops lip sync). */
  void start(std::shared_ptr<const WavSound> sound);
  /** A sound is loaded and not finished. */
  bool playing() const { return sound_ && position_ < sound_->frames; }
  /**
   * One frame. Parameters whose IDs are in `skip` (may be null) are left
   * alone: motion sync drives them in this frame (not reference behavior).
   */
  void frame(double dt, AnimationValues& values, const Vector<String>* skip = nullptr);

 private:
  void sound_frame(double dt, AnimationValues& values, const Vector<String>* skip);
  Vector<String> ids_;
  std::shared_ptr<const WavSound> sound_;
  LiveLipSyncSource* live_ = nullptr;
  double position_ = 0;
};

}  // namespace mochi2d::framework

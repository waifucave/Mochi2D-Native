// Motion sync at runtime, port of Mochi2D's
// src/anim/motion-sync/parameter-filter.ts and driver.ts: a sound or a live
// input bound to one setting of a model's motion-sync file drives that
// setting's parameters.
//
// Each frame, for the bound setting:
//
// 1. Audio. A sound advances to its playback position (the clock given at
//    binding, else the sum of the frames' steps); a live input hands over
//    the samples captured since the previous frame.
// 2. Tick. The setting's clock decides whether the frame analyzes
//    (TickClock: at most once per frame, every 1/SampleRate).
// 3. Analysis (motion_sync_analysis.hpp). A sound is analyzed ahead of its
//    playback: the window is centered on the sample being played. A live
//    input's window ends at its newest sample.
// 4. Engine (SettingEngine): the gate, `Enabled`, `Scale`, the weights
//    normalized, the blend by `BlendRatio`, the shape, and a non-linear
//    smoothing (slew limits) set by `Smoothing`.
// 5. Filter (ParameterFilter): the file's per-parameter smoothing and dead
//    band.
// 6. Write. Each resolved driven parameter takes the filter's output, every
//    frame once the setting has a result (the parameter's range applies).
//
// When a sound ends, the setting is fed silence until every parameter is
// within its `Damper` of the Silence shape, or for 0.5 s, and then stops
// writing. A sound stopped early fades over the given time first. Only the
// bound setting writes. Binding another setting starts it from the
// parameters' current values; consecutive sounds on the same setting carry
// its state over.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>

#include "framework/motion_sync.hpp"
#include "framework/motion_sync_analysis.hpp"
#include "framework/values.hpp"

namespace mochi2d::framework {

/**
 * The per-parameter post-filter of a setting, in double precision: for
 * driven parameter k, S ← ((100 − Smooth)·y + Smooth·S) / 100 (or S = y with
 * the smoothing off), then the dead band: D keeps its value while
 * |S − D| < Damper, else takes S. A y that is NaN leaves both as they are.
 */
class ParameterFilter {
 public:
  ParameterFilter() = default;
  ParameterFilter(Vector<double> smooth, Vector<double> damper, bool smoothing = true);
  Vector<double> smooth, damper;
  /** Step 1 on (the file's rule) or off (S = y). */
  bool smoothing = true;
  /** Smoothed values S. */
  Vector<double> smoothed;
  /** Output values D. */
  Vector<double> output;
  /** S = D = values. */
  void reset(const double* values);
  /** One analysis result. */
  void step(const double* y);
};

/**
 * The analysis tick of a setting: each frame of step dt adds max(dt, 0) to
 * a time T; when T reaches h = 1/SampleRate, the frame analyzes once and T
 * keeps its remainder modulo h.
 */
class TickClock {
 public:
  explicit TickClock(double sample_rate = 60) : sample_rate(sample_rate) {}
  double time = 0;
  double sample_rate;
  /** Advances by one frame; true when this frame analyzes. */
  bool advance(double dt);
};

/**
 * Mochi2D's engine for one setting: from raw element weights to one value
 * per driven parameter, with slew limits towards a shape further from the
 * Silence shape (attack) and back (release, 1.5 times slower). Non-linear.
 */
class SettingEngine {
 public:
  explicit SettingEngine(const MotionSyncSetting& setting);
  /** Element weights after normalization, in the setting's element order. */
  Vector<double> weights;
  /** Engine outputs. */
  Vector<double> values;
  /** Forgets the smoothing state: the next step starts from its own shape. */
  void reset() { started_ = false; }
  /** One tick of dt seconds with the analysis `a`. */
  void step(const Analysis& a, double dt);

 private:
  const MotionSyncSetting* setting_;
  bool started_ = false;
  Vector<double> span_, rest_;
  Vector<int> slot_;
};

/** A decoded sound: channels of samples in [−1, 1] at `sample_rate`, and its signal for the analysis. */
struct MotionSyncSound {
  double sample_rate = 0;
  Vector<Vector<float>> channels;
  /** Mono at the analysis rate (Mochi2D's toAnalysisRate), made by `prepare`. */
  Vector<float> signal;
  std::size_t frames() const { return channels.empty() ? 0 : channels[0].size(); }
  /** Makes the signal; call once the channels are set. */
  void prepare();
};

/**
 * Sample rates motion sync takes, in Hz: 1000 to 1000000. Mochi2D takes any
 * rate, and at extreme ones its resampler's table or output grows without
 * bound; the library refuses those instead.
 */
constexpr double kMotionSyncMinRate = 1000;
constexpr double kMotionSyncMaxRate = 1000000;
/** A WAV file's rates (0.16.0 decodeMotionSyncWav: beyond them, a damaged file). */
constexpr double kMotionSyncWavMinRate = 1000;
constexpr double kMotionSyncWavMaxRate = 768000;
inline bool motion_sync_rate_supported(double rate) {
  return rate >= kMotionSyncMinRate && rate <= kMotionSyncMaxRate;
}

/**
 * Decodes a WAV file for motion sync (Mochi2D's decodeMotionSyncWav): linear
 * PCM with 8-bit unsigned or 16-, 24- or 32-bit signed samples, 32- or 64-bit
 * float samples, also in the extensible format; any channel count, and a
 * rate motion sync takes. False with Mochi2D's message.
 */
bool decode_motion_sync_wav(const uint8_t* bytes, std::size_t size, MotionSyncSound& out, String& message);

/** A sound's playback position from the app's audio clock. */
class MotionSyncClock {
 public:
  virtual ~MotionSyncClock() = default;
  /** The position in seconds; false when there is none (the frames' steps count then). */
  virtual bool position(double& seconds) = 0;
};

/** A live audio input (a microphone, a stream): mono samples as they arrive. */
class MotionSyncInput {
 public:
  virtual ~MotionSyncInput() = default;
  virtual double sample_rate() const = 0;
  /** The samples captured since the previous call, possibly none. */
  virtual void read(Vector<float>& out) = 0;
};

/**
 * A live input fed by the host: `push` may run on an audio thread while
 * frames run on another. Holds up to `capacity` samples between frames
 * (older ones are dropped).
 */
class MotionSyncLiveInput final : public MotionSyncInput {
 public:
  MotionSyncLiveInput(double sample_rate, std::size_t capacity);
  double sample_rate() const override { return rate_; }
  void read(Vector<float>& out) override;
  void push(const float* samples, std::size_t n);
  /** Samples waiting for the next frame. */
  std::size_t pending() const;
  /** Samples dropped because the buffer was full. */
  uint64_t dropped() const;

 private:
  void lock() const;
  void unlock() const { busy_.clear(std::memory_order_release); }
  double rate_;
  Vector<float> ring_;
  std::size_t head_ = 0, count_ = 0;
  uint64_t dropped_ = 0;
  mutable std::atomic_flag busy_ = ATOMIC_FLAG_INIT;
};

/** What the bound setting reported at its latest tick. */
struct MotionSyncTick {
  /** The setting's index in the file, dictionary name and ID. */
  int setting = -1;
  String name, id;
  /** A live input (else a sound). */
  bool live = false;
  /** The analysis window's level, dBFS. */
  double level = 0;
  /** The gate found the window silent. */
  bool silent = false;
  /** The element weights after the gate, `Enabled` and `Scale`, normalized (Silence, A, I, U, E, O). */
  std::array<double, kMotionSyncElementCount> weights{};
  /** The driven parameters' values written from this tick on, per driven parameter. */
  Vector<double> values;
  /** Seconds of the sound played (live: of input received). */
  double time = 0;
  /** Ticks reported so far by this driver, this one included. */
  uint64_t serial = 0;
  /** The analysis behind it (raw weights, voicing, openness, features). */
  Analysis analysis;
};

struct MotionSyncOptions {
  /** The gate, dBFS; default −50, or 6 dB above the voice profile's floor when higher. */
  std::optional<double> gate;
  /** How long a voiced state holds after the level drops, seconds; default 0.04. */
  std::optional<double> hangover;
  /**
   * The file's per-parameter smoothing (`Smooth`): off by default (Mochi2D
   * 0.20.0's `fileSmoothing`); the dead band (`Damper`) applies either way.
   */
  bool file_smoothing = false;
  /** Seconds of silence fed after a sound ends, at most. */
  double settle_time = 0.5;
  /** Run before physics (else after lip sync, before pose); for the animator. */
  bool before_physics = false;
};

/** Runs a model's motion sync (see the file comment). */
class MotionSyncDriver {
 public:
  /** `values` must outlive the driver; the file is kept alive. */
  MotionSyncDriver(std::shared_ptr<const MotionSyncFile> file, AnimationValues& values,
                   const MotionSyncOptions& options = {});
  MotionSyncDriver(const MotionSyncDriver&) = delete;
  MotionSyncDriver& operator=(const MotionSyncDriver&) = delete;

  const MotionSyncFile& file() const { return *file_; }
  const MotionSyncOptions& options() const { return options_; }
  /** The setting that writes, or null. */
  const MotionSyncSetting* setting() const;
  /** The bound setting's driven parameter IDs (for lip sync to leave alone); empty when none is bound. */
  const Vector<String>& driven_ids() const { return driven_ids_; }
  /** The latest tick of the bound setting, or null before its first. */
  const MotionSyncTick* tick() const { return has_tick_ ? &latest_ : nullptr; }
  /** Calls `listener` after every tick (one listener; null removes it). */
  void set_listener(void (*listener)(const MotionSyncTick& tick, void* user), void* user) {
    listener_ = listener;
    listener_user_ = user;
  }
  /** The voice profile of every setting's analysis (null: the neutral voice). */
  void set_profile(const VoiceProfile* profile);
  const std::optional<VoiceProfile>& profile() const { return profile_; }

  /**
   * Binds a sound to the setting at `index`, from its start; `clock` (may be
   * null, must outlive the binding) gives the playback position. False for
   * an unusable setting.
   */
  bool play_sound(int index, std::shared_ptr<const MotionSyncSound> sound, MotionSyncClock* clock = nullptr);
  /** Binds a live input (must outlive the binding) to the setting at `index`. False for an unusable setting. */
  bool set_input(int index, MotionSyncInput* input);
  /** The sound bound, or null. */
  const std::shared_ptr<const MotionSyncSound>& sound() const { return sound_; }
  /** The live input bound, or null. */
  MotionSyncInput* input() const { return live_ ? input_ : nullptr; }
  /** Something is bound and playing (not yet settling). */
  bool playing() const { return bound_ >= 0 && settling_ < 0; }
  /**
   * Ends the sound or input: the setting is fed silence until it settles,
   * and then stops writing. With fade > 0, a sound fades out first.
   */
  void stop(double fade = 0);
  /** Stops writing at once. */
  void clear();
  /** One frame of step dt: audio, tick, analysis, engine, filter, write. */
  void frame(double dt);

  /** Warnings from resolving settings against the model, taken by the caller. */
  Vector<String> warnings;
  /** Source samples of the bound sound consumed so far. */
  double consumed = 0;

 private:
  struct State {
    const MotionSyncSetting* setting;
    Vector<int> targets;
    TickClock clock;
    SettingEngine engine;
    ParameterFilter filter;
    VowelAnalyzer analyzer;
    bool has_result = false;
    bool fresh = true;
    double since_tick = 0;
  };
  State& state(int index);
  State* bind(int index);
  bool settled(const State& st) const;
  void report(State& st, const Analysis& a);

  std::shared_ptr<const MotionSyncFile> file_;
  AnimationValues* values_;
  MotionSyncOptions options_;
  std::optional<VoiceProfile> profile_;
  Vector<std::optional<State>> states_;
  int bound_ = -1;
  Vector<String> driven_ids_;
  double settling_ = -1;
  bool has_tick_ = false;
  MotionSyncTick latest_;
  uint64_t serial_ = 0;
  void (*listener_)(const MotionSyncTick&, void*) = nullptr;
  void* listener_user_ = nullptr;

  // The binding: a sound or a live input.
  bool live_ = false;
  std::shared_ptr<const MotionSyncSound> sound_;
  MotionSyncClock* clock_ = nullptr;
  double time_ = 0;
  double binding_consumed_ = 0;
  bool fading_ = false;
  double fade_from_ = 0, fade_seconds_ = 0;
  MotionSyncInput* input_ = nullptr;
  std::optional<Resampler> resampler_;
  Vector<float> recent_;
  Vector<float> fresh_, added_;
  Vector<double> fresh_doubles_;

  // Sound statistics by gate, for sounds played again.
  struct Cached {
    std::weak_ptr<const MotionSyncSound> sound;
    double gate;
    SoundStatistics statistics;
  };
  Vector<Cached> statistics_;
};

}  // namespace mochi2d::framework

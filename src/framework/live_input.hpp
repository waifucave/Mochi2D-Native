// Lip sync from live audio, such as a microphone (port of Mochi2D's
// src/anim/live-lip-sync.ts; not reference behavior: the reference analyses
// sound files only, 3s). The host gives the samples; the library measures
// them, so that every engine moves the mouth the same way.
//
// The measure and the mapping are those of 3s.2, applied to the live samples
// since the previous frame: the RMS of all their values (all channels
// pooled). Three adjustable steps follow, in this order:
//
// 1. a noise gate: the gate level g (an RMS amplitude, set in dBFS) is
//    subtracted, max(0, rms − g);
// 2. a gain (the sensitivity) multiplies the result;
// 3. smoothing: one step of a one-pole filter towards that target, with the
//    attack time constant when the target is above the current value and the
//    release time constant otherwise. The step is the duration of the
//    frame's samples, so the result does not depend on the frame rate.
//
// A frame that received no sample keeps the previous value; after 0.1 s
// without samples, frames count as silence, so the mouth closes with the
// release time. An older backlog than the window (0.25 s by default) is
// dropped.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <limits>

#include "framework/lip_sync.hpp"

namespace mochi2d::framework {

struct LiveLipSyncSettings {
  /** The sensitivity: multiplies the gated RMS. */
  double gain = 12;
  /** The noise gate in dBFS, as an RMS level (a full-scale sine is −3 dBFS); −∞: no gate. */
  double gate = -45;
  /** Attack time constant in seconds: how fast the value rises; 0: at once. */
  double attack = 0.03;
  /** Release time constant in seconds: how fast the value falls; 0: at once. */
  double release = 0.12;
};

/** Mochi2D's defaults (LIVE_LIP_SYNC_DEFAULTS), for speech at arm's length. */
constexpr LiveLipSyncSettings kLiveLipSyncDefaults{12, -45, 0.03, 0.12};
/** No gate, gain or smoothing: the value is the 3s.2 RMS (LIVE_LIP_SYNC_NEUTRAL). */
constexpr LiveLipSyncSettings kLiveLipSyncNeutral{1, -std::numeric_limits<double>::infinity(), 0, 0};
/** Seconds of frames without samples after which frames count as silence. */
constexpr double kLiveSilenceAfter = 0.1;

/** An RMS level in dBFS as a linear amplitude (−∞ gives 0), as Mochi2D computes it. */
double dbfs_to_amplitude(double db);

/**
 * Collects live samples between frames and turns them into one lip-sync
 * value per frame. The push functions may run on an audio thread while
 * frames run on another; everything else belongs to the frames' thread.
 */
class LiveLipSyncInput final : public LiveLipSyncSource {
 public:
  explicit LiveLipSyncInput(double sample_rate, const LiveLipSyncSettings& settings = kLiveLipSyncDefaults,
                            double max_window = 0.25);

  /** The settings in use; changes apply from the next frame. */
  LiveLipSyncSettings settings;
  /** The sample rate of the pushed samples, in frames per second. */
  double sample_rate;
  /** The longest span of samples one frame takes, in seconds: an older backlog is dropped. */
  double max_window;
  /** The RMS of the latest frame's samples (the input level), 0 before any. */
  double level = 0;
  /** The value of the latest frame: what goes to the lip-sync parameters. */
  double value = 0;

  /** A block of `frames` samples per channel: `channels` arrays (planar). */
  void push(const float* const* channels, std::size_t channel_count, std::size_t frames);
  /** The same block, interleaved (frame by frame); summed channel by channel, as the planar form. */
  void push_interleaved(const float* samples, std::size_t channel_count, std::size_t frames);
  /**
   * A block given by the sum of its squared values, its number of values
   * (channels × frames) and its number of frames (Mochi2D's pushSums; what
   * its audio worklet sends).
   */
  void push_sums(double sum_squares, double values, double frames);
  /** Seconds of samples waiting for the next frame. */
  double pending() const;
  /** This frame's value, ≥ 0, from the samples pushed since the previous frame. */
  double next(double dt) override;
  /** Clears the pending samples and the value. */
  void reset();

 private:
  double step(double rms, double seconds);
  void lock() const;
  void unlock() const;
  mutable std::atomic_flag busy_ = ATOMIC_FLAG_INIT;
  double sum_ = 0, count_ = 0, frames_ = 0, idle_ = 0;
};

}  // namespace mochi2d::framework

// Mochi2D's own audio analysis for motion sync, port of
// src/anim/motion-sync/analysis.ts (classical speech methods). Ported as it
// is, nothing added:
//
// - Signal path. Mono, resampled to 16 kHz. Each analysis takes a
//   512-sample window (32 ms), removes its mean, and measures its RMS level
//   in dBFS. For the spectrum it is pre-emphasized (x[n] − 0.97·x[n − 1])
//   and Hann-windowed.
// - Band energy: the shares of the 80–3500 Hz energy in 250–1000,
//   1000–2000 and 2000–3500 Hz.
// - Voicing: the window's largest normalized autocorrelation at a pitch
//   period's lag.
// - Spectrum: 20 mel bands from 100 to 4000 Hz.
// - Vowel weights: the window's spectrum against each vowel's templates by
//   the distance between their cepstra (MFCC 1 to 12), after noise masking.
//   The templates are a voice profile's (VoiceCalibration), or without one
//   those of a neutral synthetic voice in four sizes.
// - Gate and openness: below the gate (−50 dBFS by default) the window is
//   silence, with a 40 ms hangover; above it the vowels share a weight that
//   grows with the level, up to a reference level, and with the voicing.
//
// Every step is computed in double precision as Mochi2D computes it (V8's
// fdlibm for log10, exp, pow, sin and cos), so the results are bit for bit
// Mochi2D's.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>

#include "framework/jsutil.hpp"
#include "framework/motion_sync.hpp"
#include "util/alloc.hpp"

namespace mochi2d::framework {

/** The analysis rate, Hz. */
constexpr int kAnalysisRate = 16000;
/** The analysis window, samples at kAnalysisRate (32 ms). */
constexpr int kAnalysisWindow = 512;
/** Cepstral coefficients compared (1 to 12). */
constexpr int kMfccSize = 12;
/** Bands of a window's spectrum: triangular mel filters from 100 to 4000 Hz. */
constexpr int kMelBands = 20;
/** The vowels, in kMotionSyncElements order after Silence. */
constexpr int kVowelCount = 5;
/** Periodicity at or below this is noise; at or above kVoicedPeriodicity, fully voiced. */
constexpr double kNoisePeriodicity = 0.3;
constexpr double kVoicedPeriodicity = 0.6;

/** A spectrum of the mel bands. */
using Spectrum = std::array<double, kMelBands>;

/** Math.round: the nearest integer, ties towards +∞ (−0 for [−0.5, 0)). */
double js_round(double x);

/**
 * A streaming resampler to `out_rate`: windowed-sinc interpolation (a raised
 * cosine window) with its cut-off at the lower Nyquist frequency, 8 zero
 * crossings on each side, the kernel read from a table. `push` returns the
 * output samples that its input so far determines.
 */
class Resampler {
 public:
  Resampler(double in_rate, double out_rate);
  double in_rate() const { return in_rate_; }
  double out_rate() const { return out_rate_; }
  void push(const double* input, std::size_t n, Vector<float>& out);
  /** The rest of the stream, with zeros after its end. */
  void flush(Vector<float>& out);

 private:
  double sample(double t) const;
  void trim();
  double in_rate_, out_rate_, ratio_;
  double half_;
  Vector<double> buffer_;
  /** Input index (into the whole stream) of buffer_[0]. */
  double buffer_start_ = 0;
  /** The next output sample's position in input samples. */
  double next_ = 0;
  Vector<double> kernel_;
};

/** Mono (the channels averaged) at kAnalysisRate. Every channel holds `frames` samples. */
void to_analysis_rate(const float* const* channels, std::size_t channel_count, std::size_t frames, double rate,
                      Vector<float>& out);

/** What one analysis window holds. */
struct WindowFeatures {
  /** RMS level of the window after DC removal, dBFS (−∞ for a silent window). */
  double level = 0;
  /** Shares of the 80–3500 Hz energy: F1 (250–1000), low F2 (1000–2000), high F2–F3 (2000–3500). */
  std::array<double, 3> bands{};
  /** The energies of the mel bands of the window, pre-emphasized and Hann-windowed. */
  Spectrum spectrum{};
  /** How periodic the window is, 0 to 1 (0 for silence). */
  double periodicity = 0;
};

/** The features of the window of kAnalysisWindow samples of `signal` from `start` (outside: 0). */
WindowFeatures window_features(const float* signal, std::size_t length, double start);

/** How voiced a window of periodicity `p` is, 0 to 1. */
double voicing_of(double p);

/** What a whole sound tells the analysis ahead of its playback. */
struct SoundStatistics {
  /** The 70th percentile of the voiced windows' levels (above the gate), with five or more. */
  std::optional<double> reference;
  /** Each band's 10th percentile over the windows that are not voiced, with ten or more. */
  std::optional<Spectrum> noise;
};

/** The statistics of a whole signal at kAnalysisRate, from windows every 20 ms. */
SoundStatistics sound_statistics(const float* signal, std::size_t length, double gate = -50);

/** A voice's vowel templates and levels (Mochi2D's VoiceProfile). */
struct VoiceProfile {
  /** A name for people. */
  String name = "voice";
  /**
   * Per vowel, in the order the profile lists them (its JSON's key order):
   * the vowel (0 A … 4 O) and its spectra, in dB relative to the strongest
   * band (−40 to 0).
   */
  struct Vowel {
    int vowel = 0;
    Vector<Spectrum> templates;
  };
  Vector<Vowel> templates;
  /** The voice's typical level while voiced, dBFS. */
  double voiced_level = -26;
  /** The noise floor recorded as Silence, dBFS. */
  std::optional<double> floor_level;

  /** The templates of a vowel (0 A … 4 O), or null when the profile lists none. */
  const Vector<Spectrum>* vowel_templates(int vowel) const;
};

/**
 * The templates of a neutral synthetic voice in four sizes, from a low
 * voice to a high one: what the analysis uses without a calibrated profile.
 * Mochi2D builds them from its vowel synthesizer; the library holds the
 * same values as data (tests/motion_sync/README.md says how they are made).
 */
VoiceProfile neutral_voice_profile();

/** A voice profile from parsed JSON; false with Mochi2D's TypeError message. */
bool voice_profile_from_json(const json::Value& json, VoiceProfile& out, String& message);
/** The profile as JSON (JSON.stringify of Mochi2D's object: compact, keys in its order). */
String voice_profile_to_json(const VoiceProfile& profile);

/**
 * Per-voice calibration: record each vowel for about a second (and a moment
 * of the room's silence), then `profile` gives the voice's templates.
 */
class VoiceCalibration {
 public:
  explicit VoiceCalibration(String name = "voice") : name(std::move(name)) {}
  String name;
  /**
   * Adds a recording of `element` (0 Silence, 1 A … 5 O): its channels at
   * `rate` Hz, analyzed every 10 ms. For a vowel, only voiced windows louder
   * than −45 dBFS count. Returns how many windows were used.
   */
  int add(int element, const float* const* channels, std::size_t channel_count, std::size_t frames, double rate);
  /** Windows recorded for a vowel (0 A … 4 O). */
  std::size_t recorded(int vowel) const;
  VoiceProfile profile() const;

 private:
  /** Per vowel in the order first recorded: its windows' spectra. */
  Vector<std::pair<int, Vector<Spectrum>>> frames_;
  Vector<double> levels_;
  bool has_floor_ = false;
  double floor_level_ = 0;
  Spectrum floor_spectrum_{};
};

struct AnalyzerOptions {
  /** The gate, dBFS; default −50, or 6 dB above a voice profile's floor when higher. */
  std::optional<double> gate;
  /** A voice profile; null: the neutral synthetic voice. Copied. */
  const VoiceProfile* profile = nullptr;
  /** How long a voiced state holds after the level drops, seconds. Default 0.04. */
  std::optional<double> hangover;
};

/** One analysis: raw element weights and what they came from. */
struct Analysis {
  /** Raw weights ≥ 0 per element, in kMotionSyncElements order, summing to 1. */
  std::array<double, kMotionSyncElementCount> raw{};
  /** The window's level, dBFS. */
  double level = 0;
  /** The gate (with its hangover) found the window silent. */
  bool silent = false;
  /** How voiced the window is, 0 to 1. */
  double voicing = 0;
  /** How open the mouth is from the level and the voicing, 0 to 1. */
  double open = 0;
  WindowFeatures features;
};

/** Follows a live input's noise: per band, the 10th percentile of the last 300 unvoiced windows. */
class NoiseTracker {
 public:
  void push(const Spectrum& spectrum);
  const std::optional<Spectrum>& noise() const { return value_; }
  void reset();

 private:
  Vector<Spectrum> history_;
  std::size_t head_ = 0;
  std::optional<Spectrum> value_;
  int pending_ = 0;
};

/** Turns analysis windows into element weights (Mochi2D's VowelAnalyzer). */
class VowelAnalyzer {
 public:
  explicit VowelAnalyzer(const AnalyzerOptions& options = {});

  double hangover;
  /** A fixed reference level, dBFS, or none to follow the input. */
  std::optional<double> reference;
  /** A fixed noise per band, or none to follow the input. */
  std::optional<Spectrum> noise;

  /** The gate in use, dBFS. */
  double gate() const;
  /** The reference level in use, dBFS. */
  double reference_level() const;
  /** The voice profile in use. */
  const VoiceProfile& profile() const { return profile_; }
  /** Sets the profile (null: the neutral synthetic voice); copied. */
  void set_profile(const VoiceProfile* profile);
  /** Forgets the hangover and what was followed of the input. */
  void reset();
  /** Analyzes the window of `signal` at `start`, `dt` seconds after the previous analysis. */
  Analysis analyze(const float* signal, std::size_t length, double start, double dt);

 private:
  std::optional<double> gate_option_;
  VoiceProfile profile_;
  struct Template {
    int vowel;
    Spectrum t;
  };
  Vector<Template> templates_;
  double sigma_ = 1;
  double since_voiced_;
  std::array<double, kVowelCount> last_vowels_{};
  double last_open_ = 0;
  Vector<double> recent_;
  NoiseTracker tracker_;
};

}  // namespace mochi2d::framework

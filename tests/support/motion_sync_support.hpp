// Test sounds for motion sync, ported from Mochi2D's test support
// (src/anim/motion-sync/voice-synth.ts and test/support/motion-sync.ts):
// a small cascade formant synthesizer for vowels, the male and female
// voices, vowel clips, glides, noise, silence, a tone, and WAV files.
//
// Test code only: the formant filters of the reference's vowel
// synthesizer make test sounds, and are ported for the tests. The
// library holds the neutral templates Mochi2D builds with it as data, and
// tests/motion_sync/make_neutral.cpp regenerates them from this port.
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "framework/motion_sync_analysis.hpp"

namespace mochi2d::test {

/** The profile Mochi2D's neutralVoiceProfile() builds: four synthetic voices, each vowel 0.6 s. */
framework::VoiceProfile build_neutral_profile();

/** Typical formants of an adult male voice, F1, F2, F3 in Hz, for A, I, U, E, O. */
extern const double kVowelFormants[5][3];

struct VoiceOptions {
  double f0 = 120;
  double formant_scale = 1;
  double vibrato = 0.03;
  double vibrato_rate = 0.8;
  /** RMS level of the result, dBFS. */
  double level = -18;
  double fade = 0.02;
};

/** `seconds` of voice at `rate` Hz whose formants at time t are `formants_at(t)` (synthesizeVoice). */
std::vector<float> synthesize_voice(const std::function<std::vector<double>(double)>& formants_at, double seconds,
                                    double rate, const VoiceOptions& options = {});
/** `seconds` of the vowel with these formants (synthesizeVowel). */
std::vector<float> synthesize_vowel(const std::vector<double>& formants, double seconds, double rate,
                                    const VoiceOptions& options = {});

struct VoiceSpec {
  double f0;
  double formant_scale;
};
constexpr VoiceSpec kMale{120, 1};
constexpr VoiceSpec kFemale{220, 1.15};

/** Where a vowel of a clip lies, seconds. */
struct Segment {
  int vowel;  // 0 A … 4 O
  double start, end;
};
struct Clip {
  std::vector<float> samples;
  std::vector<Segment> segments;
};

struct ClipOptions {
  double level = -18;
  double hold = 1;
  double gap = 0.3;
  std::vector<int> vowels{0, 1, 2, 3, 4};
};
/** Each vowel held `hold` seconds, with `gap` seconds of silence before each and after the last (vowelClip). */
Clip vowel_clip(const VoiceSpec& voice, double rate, const ClipOptions& options = {});
/** A→I→U→E→O→A: each held `hold` s, with linear formant transitions of `glide` s (glideClip). */
std::vector<float> glide_clip(const VoiceSpec& voice, double seconds, double rate, double hold = 0.4,
                              double glide = 0.3, double level = -18);
std::vector<float> silence(double seconds, double rate);
/** White noise (uniform, mulberry32), scaled to `level` dBFS RMS. */
std::vector<float> white_noise(double seconds, double rate, double level, uint32_t seed = 1);
/** Pink noise (three-pole 1/f approximation), at `level` dBFS. */
std::vector<float> pink_noise(double seconds, double rate, double level, uint32_t seed = 2);
/** A sine at `hz`, at `level` dBFS RMS. */
std::vector<float> tone(double hz, double seconds, double rate, double level);
/** `count` times: `on` seconds of A, then `off` seconds of silence. */
std::vector<float> burst_clip(double rate, int count = 20, double on = 0.1, double off = 0.1);
std::vector<float> concat(const std::vector<std::vector<float>>& parts);
/** Sample-wise sum. */
std::vector<float> mix(const std::vector<float>& a, const std::vector<float>& b);

enum class WavEncoding { Pcm8, Pcm16, Pcm24, Pcm32, Float32, Float64 };
/** A WAV file of equal-length channels at `rate` (wavFile). */
std::string wav_file(const std::vector<std::vector<float>>& channels, uint32_t rate,
                     WavEncoding encoding = WavEncoding::Pcm16, bool extensible = false);

/** The crafted motion-sync files of Mochi2D's tests: ds-basic, ds-rich and ds-two. */
std::string ds_basic_json();
std::string ds_rich_json();
std::string ds_two_json();

}  // namespace mochi2d::test

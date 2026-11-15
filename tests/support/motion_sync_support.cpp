#include "support/motion_sync_support.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "fdlibm.hpp"
#include "util/json.hpp"

namespace mochi2d::test {

namespace {

constexpr double kPi = 3.141592653589793;
const double kBandwidths[3] = {60, 90, 120};

/** Math.round. */
double js_round(double x) {
  if (!std::isfinite(x) || x == 0) return x;
  if (x > 0 && x < 0.5) return 0.0;
  if (x < 0 && x >= -0.5) return -0.0;
  const double f = std::floor(x);
  return x - f >= 0.5 ? f + 1 : f;
}

double js_min(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == b) return std::signbit(a) ? a : b;
  return a < b ? a : b;
}
double js_max(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == b) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}

double db(double level) { return fdlibm::pow(10, level / 20); }

double rms_db(const std::vector<float>& x) {
  double s = 0;
  for (float v : x) s += static_cast<double>(v) * static_cast<double>(v);
  return 10 * fdlibm::log10(s / js_max(1, static_cast<double>(x.size())));
}

std::vector<float> to_level(const std::vector<float>& x, double level) {
  const double g = db(level) / db(rms_db(x));
  std::vector<float> out(x.size());
  for (std::size_t i = 0; i < x.size(); i++) out[i] = static_cast<float>(static_cast<double>(x[i]) * g);
  return out;
}

/** mulberry32, as Mochi2D's tests seed it. */
struct Seeded {
  uint32_t a;
  explicit Seeded(uint32_t seed) : a(seed) {}
  double operator()() {
    a = a + 0x6d2b79f5u;
    uint32_t t = a;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
  }
};

}  // namespace

const double kVowelFormants[5][3] = {
    {750, 1200, 2600}, {300, 2300, 3000}, {350, 1350, 2400}, {480, 1900, 2600}, {480, 850, 2600}};

std::vector<float> synthesize_voice(const std::function<std::vector<double>(double)>& formants_at, double seconds,
                                    double rate, const VoiceOptions& options) {
  const double count = js_max(0, js_round(seconds * rate));
  const auto n = static_cast<std::size_t>(count);
  const double f0 = options.f0;
  const double depth = options.vibrato;
  const double vrate = options.vibrato_rate;
  const double scale = options.formant_scale;
  // Glottal source: one pulse per period, a −12 dB/octave tilt from two
  // leaky integrators with their corner at 77 Hz, whatever the rate.
  const double leak = fdlibm::exp((-2 * kPi * 77) / rate);
  std::vector<double> y(n, 0.0);
  double phase = 0;
  for (std::size_t i = 0; i < n; i++) {
    phase += (f0 * (1 + depth * fdlibm::sin((2 * kPi * vrate * static_cast<double>(i)) / rate))) / rate;
    if (phase >= 1) {
      phase -= 1;
      y[i] = 1;
    }
  }
  double s1 = 0, s2 = 0, mean = 0;
  for (std::size_t i = 0; i < n; i++) {
    s1 = leak * s1 + y[i];
    s2 = leak * s2 + s1;
    y[i] = s2;
    mean += s2;
  }
  mean /= js_max(1, count);
  for (std::size_t i = 0; i < n; i++) y[i] = y[i] - mean;
  // The resonators in cascade, F1 first.
  double state[6] = {0, 0, 0, 0, 0, 0};
  for (std::size_t i = 0; i < n; i++) {
    const std::vector<double> formants = formants_at(static_cast<double>(i) / rate);
    double x = y[i];
    for (std::size_t k = 0; k < formants.size(); k++) {
      const double f = formants[k] * scale;
      if (!(f < rate / 2)) continue;
      const double bw = k < 3 ? kBandwidths[k] : 120;
      const double c = -fdlibm::exp((-2 * kPi * bw) / rate);
      const double b = 2 * fdlibm::exp((-kPi * bw) / rate) * fdlibm::cos((2 * kPi * f) / rate);
      const double v = (1 - b - c) * x + b * state[2 * k] + c * state[2 * k + 1];
      state[2 * k + 1] = state[2 * k];
      state[2 * k] = v;
      x = v;
    }
    y[i] = x;
  }
  // Fades and level.
  const double fade = js_min(js_round(options.fade * rate), std::floor(count / 2));
  for (double i = 0; i < fade; i++) {
    const double g = i / fade;
    const auto a = static_cast<std::size_t>(i);
    y[a] = y[a] * g;
    y[n - 1 - a] = y[n - 1 - a] * g;
  }
  double sum = 0;
  for (std::size_t i = 0; i < n; i++) sum += y[i] * y[i];
  const double rms = std::sqrt(sum / js_max(1, count));
  const double target = fdlibm::pow(10, options.level / 20);
  const double g = rms > 0 ? target / rms : 0;
  std::vector<float> out(n);
  for (std::size_t i = 0; i < n; i++) out[i] = static_cast<float>(y[i] * g);
  return out;
}

std::vector<float> synthesize_vowel(const std::vector<double>& formants, double seconds, double rate,
                                    const VoiceOptions& options) {
  return synthesize_voice([&](double) { return formants; }, seconds, rate, options);
}

std::vector<float> silence(double seconds, double rate) {
  return std::vector<float>(static_cast<std::size_t>(js_round(seconds * rate)), 0.0f);
}

std::vector<float> concat(const std::vector<std::vector<float>>& parts) {
  std::vector<float> out;
  for (const auto& p : parts) out.insert(out.end(), p.begin(), p.end());
  return out;
}

std::vector<float> mix(const std::vector<float>& a, const std::vector<float>& b) {
  std::vector<float> out(std::max(a.size(), b.size()), 0.0f);
  for (std::size_t i = 0; i < out.size(); i++) {
    const double x = (i < a.size() ? static_cast<double>(a[i]) : 0.0) + (i < b.size() ? static_cast<double>(b[i]) : 0.0);
    out[i] = static_cast<float>(x);
  }
  return out;
}

Clip vowel_clip(const VoiceSpec& voice, double rate, const ClipOptions& options) {
  Clip clip;
  std::vector<std::vector<float>> parts;
  double t = 0;
  for (int v : options.vowels) {
    parts.push_back(silence(options.gap, rate));
    t += options.gap;
    VoiceOptions o;
    o.f0 = voice.f0;
    o.formant_scale = voice.formant_scale;
    o.level = options.level;
    std::vector<float> s = synthesize_vowel({kVowelFormants[v][0], kVowelFormants[v][1], kVowelFormants[v][2]},
                                            options.hold, rate, o);
    const double length = static_cast<double>(s.size());
    clip.segments.push_back({v, t, t + length / rate});
    t += length / rate;
    parts.push_back(std::move(s));
  }
  parts.push_back(silence(options.gap, rate));
  clip.samples = concat(parts);
  return clip;
}

std::vector<float> glide_clip(const VoiceSpec& voice, double seconds, double rate, double hold, double glide,
                              double level) {
  const int order[5] = {0, 1, 2, 3, 4};
  const double period = 5 * (hold + glide);
  VoiceOptions o;
  o.f0 = voice.f0;
  o.formant_scale = voice.formant_scale;
  o.level = level;
  return synthesize_voice(
      [&](double time) {
        const double t = std::fmod(time, period);
        const double i = std::floor(t / (hold + glide));
        const double u = t - i * (hold + glide);
        const int ia = static_cast<int>(i);
        const double* a = kVowelFormants[order[ia]];
        const double* b = kVowelFormants[order[(ia + 1) % 5]];
        const double w = u <= hold ? 0 : (u - hold) / glide;
        std::vector<double> out(3);
        for (int k = 0; k < 3; k++) out[static_cast<std::size_t>(k)] = a[k] + (b[k] - a[k]) * w;
        return out;
      },
      seconds, rate, o);
}

std::vector<float> white_noise(double seconds, double rate, double level, uint32_t seed) {
  Seeded r(seed);
  std::vector<float> x(static_cast<std::size_t>(js_round(seconds * rate)));
  for (auto& v : x) v = static_cast<float>(2 * r() - 1);
  return to_level(x, level);
}

std::vector<float> pink_noise(double seconds, double rate, double level, uint32_t seed) {
  Seeded r(seed);
  double b0 = 0, b1 = 0, b2 = 0;
  std::vector<float> x(static_cast<std::size_t>(js_round(seconds * rate)));
  for (auto& v : x) {
    const double w = 2 * r() - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    v = static_cast<float>(b0 + b1 + b2 + w * 0.1848);
  }
  return to_level(x, level);
}

std::vector<float> tone(double hz, double seconds, double rate, double level) {
  std::vector<float> x(static_cast<std::size_t>(js_round(seconds * rate)));
  for (std::size_t i = 0; i < x.size(); i++)
    x[i] = static_cast<float>(1.4142135623730951 * db(level) *
                              fdlibm::sin((2 * kPi * hz * static_cast<double>(i)) / rate));
  return x;
}

std::vector<float> burst_clip(double rate, int count, double on, double off) {
  VoiceOptions o;
  o.f0 = kMale.f0;
  o.fade = 0.005;
  const std::vector<float> a =
      synthesize_vowel({kVowelFormants[0][0], kVowelFormants[0][1], kVowelFormants[0][2]}, on, rate, o);
  std::vector<std::vector<float>> parts;
  for (int i = 0; i < count; i++) {
    parts.push_back(a);
    parts.push_back(silence(off, rate));
  }
  return concat(parts);
}

std::string wav_file(const std::vector<std::vector<float>>& channels, uint32_t rate, WavEncoding encoding,
                     bool extensible) {
  const int bits = encoding == WavEncoding::Pcm8 ? 8
                   : encoding == WavEncoding::Pcm16 ? 16
                   : encoding == WavEncoding::Pcm24 ? 24
                   : encoding == WavEncoding::Float64 ? 64
                                                       : 32;
  const bool is_float = encoding == WavEncoding::Float32 || encoding == WavEncoding::Float64;
  const uint32_t C = static_cast<uint32_t>(channels.size());
  const std::size_t frames = channels.empty() ? 0 : channels[0].size();
  const uint32_t bytes_per = static_cast<uint32_t>(bits / 8);
  const uint32_t data = static_cast<uint32_t>(frames * C * bytes_per);
  const uint32_t fmt_size = extensible ? 40 : 16;
  std::string b(12 + 8 + fmt_size + 8 + data + (data & 1), '\0');
  const auto u16 = [&](std::size_t o, uint32_t v) {
    b[o] = static_cast<char>(v & 0xff);
    b[o + 1] = static_cast<char>((v >> 8) & 0xff);
  };
  const auto u32 = [&](std::size_t o, uint32_t v) {
    u16(o, v & 0xffff);
    u16(o + 2, v >> 16);
  };
  std::memcpy(&b[0], "RIFF", 4);
  u32(4, static_cast<uint32_t>(b.size() - 8));
  std::memcpy(&b[8], "WAVE", 4);
  std::memcpy(&b[12], "fmt ", 4);
  u32(16, fmt_size);
  const uint32_t code = is_float ? 3 : 1;
  u16(20, extensible ? 0xfffe : code);
  u16(22, C);
  u32(24, rate);
  u32(28, rate * C * bytes_per);
  u16(32, C * bytes_per);
  u16(34, static_cast<uint32_t>(bits));
  if (extensible) {
    u16(36, 22);
    u16(38, static_cast<uint32_t>(bits));
    u32(40, 0);
    u16(44, code);
    const unsigned char suffix[14] = {0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80,
                                      0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
    for (int i = 0; i < 14; i++) b[46 + static_cast<std::size_t>(i)] = static_cast<char>(suffix[i]);
  }
  const std::size_t d = 12 + 8 + fmt_size;
  std::memcpy(&b[d], "data", 4);
  u32(d + 4, data);
  std::size_t o = d + 8;
  for (std::size_t i = 0; i < frames; i++)
    for (uint32_t c = 0; c < C; c++) {
      const double s = channels[c][i];
      const double v = js_max(-1, js_min(1, s));
      if (encoding == WavEncoding::Pcm8) {
        b[o] = static_cast<char>(static_cast<int>(js_round(v * 127)) + 128);
      } else if (encoding == WavEncoding::Pcm16) {
        u16(o, static_cast<uint32_t>(static_cast<int32_t>(js_round(v * 32767))) & 0xffff);
      } else if (encoding == WavEncoding::Pcm24) {
        const auto n = static_cast<int32_t>(js_round(v * 8388607));
        b[o] = static_cast<char>(n & 0xff);
        b[o + 1] = static_cast<char>((n >> 8) & 0xff);
        b[o + 2] = static_cast<char>((n >> 16) & 0xff);
      } else if (encoding == WavEncoding::Pcm32) {
        u32(o, static_cast<uint32_t>(static_cast<int32_t>(js_round(v * 2147483647))));
      } else if (encoding == WavEncoding::Float32) {
        const float f = static_cast<float>(s);
        uint32_t bits32;
        std::memcpy(&bits32, &f, 4);
        u32(o, bits32);
      } else {
        uint64_t bits64;
        std::memcpy(&bits64, &s, 8);
        u32(o, static_cast<uint32_t>(bits64));
        u32(o + 4, static_cast<uint32_t>(bits64 >> 32));
      }
      o += bytes_per;
    }
  return b;
}

namespace {

struct ParamSpec {
  const char* id;
  double damper, smooth;
};
struct SettingSpec {
  const char* id;
  const char* name;
  std::vector<ParamSpec> params;
  std::vector<std::vector<double>> shapes;  // Silence, A, I, U, E, O
  double blend_ratio, smoothing, sample_rate;
};

const SettingSpec& basic() {
  static const SettingSpec s{"MS_Basic",
                             "Mouth basic",
                             {{"ParamMouthOpenY", 0, 25}, {"ParamMouthForm", 0, 25}},
                             {{0, 0}, {1, 0}, {0.35, 1}, {0.3, -1}, {0.6, 0.6}, {0.8, -0.6}},
                             0.5,
                             60,
                             60};
  return s;
}

const SettingSpec& rich() {
  static const SettingSpec s{"MS_Rich",
                             "Mouth rich",
                             {{"ParamMouthOpenY", 0.01, 20},
                              {"ParamMouthForm", 0.02, 20},
                              {"MouthFunnel", 0.02, 30},
                              {"Mouthpucker", 0.02, 30},
                              {"MouthPuckerWiden", 0.02, 30}},
                             {{0, 0, 0, 0, 0},
                              {1, 0.1, 0, 0, 0.2},
                              {0.3, 0.7, 0, 0, 1},
                              {0.25, -0.3, 0.7, 1, 0},
                              {0.55, 0.4, 0, 0, 0.6},
                              {0.75, -0.2, 1, 0.4, 0}},
                             0.3,
                             40,
                             30};
  return s;
}

void range_of(const char* id, double& lo, double& hi) {
  lo = 0;
  hi = 1;
  for (const char* x : {"ParamMouthForm", "MouthPuckerWiden"})
    if (std::strcmp(id, x) == 0) lo = -1;
}

json::Value setting_json(const SettingSpec& spec) {
  static const char* const kElements[6] = {"Silence", "A", "I", "U", "E", "O"};
  json::Value s = json::Value::object();
  s.set("Id", json::Value(spec.id));
  s.set("AnalysisType", json::Value("CRI"));
  s.set("UseCase", json::Value("Mouth"));
  json::Value params = json::Value::array();
  for (const auto& p : spec.params) {
    double lo, hi;
    range_of(p.id, lo, hi);
    json::Value o = json::Value::object();
    o.set("Name", json::Value(p.id));
    o.set("Id", json::Value(p.id));
    o.set("Min", json::Value(lo));
    o.set("Max", json::Value(hi));
    o.set("Damper", json::Value(p.damper));
    o.set("Smooth", json::Value(p.smooth));
    params.push(std::move(o));
  }
  s.set("CubismParameters", std::move(params));
  json::Value elements = json::Value::array();
  for (const char* e : kElements) {
    json::Value o = json::Value::object();
    o.set("Name", json::Value(e));
    o.set("Id", json::Value(e));
    o.set("Min", json::Value(0));
    o.set("Max", json::Value(1));
    o.set("Scale", json::Value(1));
    o.set("Enabled", json::Value(true));
    elements.push(std::move(o));
  }
  s.set("AudioParameters", std::move(elements));
  json::Value mappings = json::Value::array();
  for (int e = 0; e < 6; e++) {
    json::Value m = json::Value::object();
    m.set("Type", json::Value("Shape"));
    m.set("Id", json::Value(kElements[e]));
    json::Value targets = json::Value::array();
    for (std::size_t k = 0; k < spec.params.size(); k++) {
      json::Value t = json::Value::object();
      t.set("Id", json::Value(spec.params[k].id));
      t.set("Value", json::Value(spec.shapes[static_cast<std::size_t>(e)][k]));
      targets.push(std::move(t));
    }
    m.set("Targets", std::move(targets));
    mappings.push(std::move(m));
  }
  s.set("Mappings", std::move(mappings));
  json::Value post = json::Value::object();
  post.set("BlendRatio", json::Value(spec.blend_ratio));
  post.set("Smoothing", json::Value(spec.smoothing));
  post.set("SampleRate", json::Value(spec.sample_rate));
  s.set("PostProcessing", std::move(post));
  return s;
}

std::string file_json(std::initializer_list<const SettingSpec*> specs) {
  json::Value root = json::Value::object();
  root.set("Version", json::Value(1));
  json::Value meta = json::Value::object();
  meta.set("SettingCount", json::Value(static_cast<int>(specs.size())));
  json::Value dictionary = json::Value::array();
  json::Value settings = json::Value::array();
  for (const SettingSpec* s : specs) {
    json::Value d = json::Value::object();
    d.set("Id", json::Value(s->id));
    d.set("Name", json::Value(s->name));
    dictionary.push(std::move(d));
    settings.push(setting_json(*s));
  }
  meta.set("Dictionary", std::move(dictionary));
  root.set("Meta", std::move(meta));
  root.set("Settings", std::move(settings));
  const String text = json::write_compact(root);
  return std::string(text.data(), text.size());
}

}  // namespace

std::string ds_basic_json() { return file_json({&basic()}); }
std::string ds_rich_json() { return file_json({&rich()}); }
std::string ds_two_json() { return file_json({&basic(), &rich()}); }

}  // namespace mochi2d::test

namespace mochi2d::test {

framework::VoiceProfile build_neutral_profile() {
  // NEUTRAL_VOICES: pitch (Hz) and formant scale.
  const double voices[4][2] = {{105, 0.97}, {150, 1.06}, {205, 1.16}, {270, 1.26}};
  framework::VoiceProfile out;
  out.name = "neutral synthetic voice";
  for (const auto& voice : voices) {
    framework::VoiceCalibration cal;
    for (int v = 0; v < 5; v++) {
      VoiceOptions o;
      o.f0 = voice[0];
      o.formant_scale = voice[1];
      const std::vector<float> s =
          synthesize_vowel({kVowelFormants[v][0], kVowelFormants[v][1], kVowelFormants[v][2]}, 0.6, 16000, o);
      const float* ch = s.data();
      cal.add(v + 1, &ch, 1, s.size(), 16000);
    }
    for (auto& entry : cal.profile().templates) {
      framework::VoiceProfile::Vowel* slot = nullptr;
      for (auto& e : out.templates)
        if (e.vowel == entry.vowel) slot = &e;
      if (!slot) {
        out.templates.push_back({entry.vowel, {}});
        slot = &out.templates.back();
      }
      slot->templates.insert(slot->templates.end(), entry.templates.begin(), entry.templates.end());
    }
  }
  out.voiced_level = -26;
  return out;
}

}  // namespace mochi2d::test

#include "framework/motion_sync_analysis.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

#include "fdlibm.hpp"
#include "util/json.hpp"

namespace mochi2d::framework {

namespace {

constexpr double kInf = std::numeric_limits<double>::infinity();
constexpr int kKernelSteps = 1024;
constexpr double kBinHz = static_cast<double>(kAnalysisRate) / kAnalysisWindow;
/** How far below a spectrum's strongest band its bands still count, dB. */
constexpr double kSpectrumRange = 40;
/** A band counts only where it is at least this many times its noise estimate. */
constexpr double kNoiseMargin = 2;
/** Spectra kept to follow a live input's noise. */
constexpr std::size_t kNoiseHistory = 300;
/** Levels of recent voiced windows kept for a reference that follows the input. */
constexpr std::size_t kRecent = 300;

const char* const kVowelIds[kVowelCount] = {"A", "I", "U", "E", "O"};

/** The order of a typed array's sort: numeric, −0 before +0, NaN last. */
bool typed_less(double a, double b) {
  if (std::isnan(a)) return false;
  if (std::isnan(b)) return true;
  if (a != b) return a < b;
  return std::signbit(a) && !std::signbit(b);
}

/** The q-quantile of `values` (nearest rank), as Mochi2D's percentile; `values` is reordered. */
double percentile_inplace(Vector<double>& values, double q) {
  const double n = static_cast<double>(values.size());
  const double rank = js_min(n - 1, std::floor(q * n));
  const auto k = static_cast<std::size_t>(rank);
  std::nth_element(values.begin(), values.begin() + static_cast<std::ptrdiff_t>(k), values.end(), typed_less);
  return values[k];
}

double percentile(const Vector<double>& values, double q) {
  Vector<double> copy(values);
  return percentile_inplace(copy, q);
}

/** Per band, the q-quantile over `spectra`. */
Spectrum band_percentile(const Vector<Spectrum>& spectra, double q) {
  Spectrum out{};
  Vector<double> column(spectra.size());
  for (int m = 0; m < kMelBands; m++) {
    for (std::size_t i = 0; i < spectra.size(); i++) column[i] = spectra[i][m];
    out[m] = percentile_inplace(column, q);
  }
  return out;
}

/** In-place radix-2 FFT of (re, im), length a power of two. */
void fft(double* re, double* im, int n) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      std::swap(re[i], re[j]);
      std::swap(im[i], im[j]);
    }
  }
  for (int len = 2; len <= n; len <<= 1) {
    const double ang = (-2 * kPi) / len;
    const double wr = fdlibm::cos(ang);
    const double wi = fdlibm::sin(ang);
    const int halfLen = len / 2;
    for (int i = 0; i < n; i += len) {
      double cr = 1;
      double ci = 0;
      for (int k = 0; k < halfLen; k++) {
        const int a = i + k;
        const int b = a + halfLen;
        const double xr = re[b] * cr - im[b] * ci;
        const double xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] = re[a] + xr;
        im[a] = im[a] + xi;
        const double t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

double mel(double f) { return 2595 * fdlibm::log10(1 + f / 700); }
double mel_inverse(double m) { return 700 * (fdlibm::pow(10, m / 2595) - 1); }

constexpr int kBins = kAnalysisWindow / 2 + 1;

/** The constant tables: the Hann window, the mel filters and the DCT rows. */
struct Tables {
  double hann[kAnalysisWindow];
  double mel_filters[kMelBands][kBins];
  double dct[kMfccSize][kMelBands];
  Tables() {
    for (int i = 0; i < kAnalysisWindow; i++) hann[i] = 0.5 - 0.5 * fdlibm::cos((2 * kPi * i) / kAnalysisWindow);
    const double lo = mel(100);
    const double hi = mel(4000);
    double edges[kMelBands + 2];
    for (int i = 0; i < kMelBands + 2; i++) edges[i] = mel_inverse(lo + ((hi - lo) * i) / (kMelBands + 1));
    for (int m = 0; m < kMelBands; m++) {
      const double a = edges[m], b = edges[m + 1], c = edges[m + 2];
      for (int k = 0; k < kBins; k++) {
        const double f = k * kBinHz;
        mel_filters[m][k] = 0;
        if (f > a && f < c) mel_filters[m][k] = f <= b ? (f - a) / (b - a) : (c - f) / (c - b);
      }
    }
    for (int i = 0; i < kMfccSize; i++)
      for (int m = 0; m < kMelBands; m++)
        dct[i][m] = fdlibm::cos((kPi * (i + 1) * (m + 0.5)) / kMelBands) * std::sqrt(2.0 / kMelBands);
  }
};

const Tables& tables() {
  static const Tables t;
  return t;
}


/** The window of `signal` at `start` (samples outside read as 0), its mean removed; returns the level. */
double window_at(const float* signal, std::size_t length, double start, double* x) {
  const int N = kAnalysisWindow;
  const double size = static_cast<double>(length);
  for (int i = 0; i < N; i++) {
    const double j = start + i;
    x[i] = j >= 0 && j < size ? static_cast<double>(signal[static_cast<std::size_t>(j)]) : 0.0;
  }
  double mean = 0;
  for (int i = 0; i < N; i++) mean += x[i];
  mean /= N;
  double sum = 0;
  for (int i = 0; i < N; i++) {
    x[i] = x[i] - mean;
    sum += x[i] * x[i];
  }
  const double rms = std::sqrt(sum / N);
  return rms > 0 ? 20 * fdlibm::log10(rms) : -kInf;
}

/** The largest normalized autocorrelation of the window `x` at lags 48 … 266. */
double periodicity_of(const double* x) {
  const int N = kAnalysisWindow;
  double y[kAnalysisWindow];
  for (int i = 0; i < N; i++) y[i] = x[i] - 0.5 * (i > 0 ? x[i - 1] : 0.0);
  // The autocorrelation through a zero-padded FFT: r = IFFT(|FFT(y)|²); the
  // forward transform of that real, even spectrum is the inverse times 2N.
  double re[2 * kAnalysisWindow] = {};
  double im[2 * kAnalysisWindow] = {};
  for (int i = 0; i < N; i++) re[i] = y[i];
  fft(re, im, 2 * N);
  for (int k = 0; k < 2 * N; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k];
    im[k] = 0;
  }
  fft(re, im, 2 * N);
  // Normalized by the energies of the two overlapping parts.
  double energy[kAnalysisWindow + 1];
  energy[0] = 0;
  for (int i = 0; i < N; i++) energy[i + 1] = energy[i] + y[i] * y[i];
  const int lag_min = static_cast<int>(js_round(0.003 * kAnalysisRate));
  const int lag_max = static_cast<int>(std::floor(kAnalysisRate / 60.0));
  double best = 0;
  for (int lag = lag_min; lag <= lag_max; lag++) {
    const double head = energy[N - lag];
    const double tail = energy[N] - energy[lag];
    if (!(head > 0 && tail > 0)) continue;
    const double c = re[lag] / (2 * N) / std::sqrt(head * tail);
    if (c > best) best = c;
  }
  return js_min(1, best);
}

/** A window's spectrum for matching: noise subtracted, dB relative to the strongest band, and its mask. */
void relative_spectrum(const Spectrum& spectrum, const Spectrum* noise, Spectrum& db, Spectrum& mask) {
  Spectrum clean;
  for (int m = 0; m < kMelBands; m++) clean[m] = js_max(0, spectrum[m] - (noise ? (*noise)[m] : 0.0));
  double top = 0;
  for (int m = 0; m < kMelBands; m++) top = js_max(top, clean[m]);
  db.fill(-kSpectrumRange);
  mask.fill(-kSpectrumRange);
  if (!(top > 0)) return;
  for (int m = 0; m < kMelBands; m++) {
    if (noise && (*noise)[m] > 0)
      mask[m] = js_max(-kSpectrumRange, 10 * fdlibm::log10((kNoiseMargin * (*noise)[m]) / top));
    db[m] = clean[m] > 0 ? js_max(mask[m], 10 * fdlibm::log10(clean[m] / top)) : mask[m];
  }
}

/** The cepstral distance (DCT rows 1 … 12) between `db` and `templ`, the template raised to `mask`. */
double masked_distance(const Spectrum& db, const Spectrum& mask, const Spectrum& templ) {
  const Tables& t = tables();
  double diff[kMelBands];
  for (int m = 0; m < kMelBands; m++) diff[m] = db[m] - js_max(templ[m], mask[m]);
  double s = 0;
  for (int r = 0; r < kMfccSize; r++) {
    double c = 0;
    for (int m = 0; m < kMelBands; m++) c += t.dct[r][m] * diff[m];
    s += c * c;
  }
  return std::sqrt(s);
}

}  // namespace

double js_round(double x) {
  if (!std::isfinite(x) || x == 0) return x;
  if (x > 0 && x < 0.5) return 0.0;
  if (x < 0 && x >= -0.5) return -0.0;
  const double f = std::floor(x);
  return x - f >= 0.5 ? f + 1 : f;
}

// ------------------------------------------------------------------ resampling

Resampler::Resampler(double in_rate, double out_rate) : in_rate_(in_rate), out_rate_(out_rate) {
  ratio_ = in_rate / out_rate;
  const double c = js_min(1, out_rate / in_rate);
  const double half = std::ceil(8 / c);
  half_ = half;
  const auto size = static_cast<std::size_t>(half * kKernelSteps + 2);
  kernel_.resize(size);
  for (std::size_t i = 0; i < size; i++) {
    const double x = static_cast<double>(i) / kKernelSteps;
    if (x >= half + 1) {
      kernel_[i] = 0;
      continue;
    }
    const double arg = kPi * x * c;
    const double sinc = x == 0 ? 1 : fdlibm::sin(arg) / arg;
    kernel_[i] = c * sinc * (0.5 + 0.5 * fdlibm::cos((kPi * x) / (half + 1)));
  }
}

void Resampler::push(const double* input, std::size_t n, Vector<float>& out) {
  out.clear();
  if (in_rate_ == out_rate_) {
    out.reserve(n);
    for (std::size_t i = 0; i < n; i++) out.push_back(static_cast<float>(input[i]));
    return;
  }
  buffer_.insert(buffer_.end(), input, input + n);
  const double end = buffer_start_ + static_cast<double>(buffer_.size());
  while (next_ + half_ < end) {
    out.push_back(static_cast<float>(sample(next_)));
    next_ += ratio_;
  }
  trim();
}

void Resampler::flush(Vector<float>& out) {
  out.clear();
  const double end = buffer_start_ + static_cast<double>(buffer_.size());
  while (next_ < end) {
    out.push_back(static_cast<float>(sample(next_)));
    next_ += ratio_;
  }
  buffer_.clear();
  buffer_start_ = std::floor(next_);
}

double Resampler::sample(double t) const {
  const double lo = std::ceil(t - half_);
  const double hi = std::floor(t + half_);
  const double size = static_cast<double>(buffer_.size());
  double s = 0;
  for (double n = lo; n <= hi; n++) {
    const double i = n - buffer_start_;
    if (i < 0 || i >= size) continue;
    // The kernel at |t − n|, interpolated linearly in its table.
    const double p = std::fabs(t - n) * kKernelSteps;
    const double j = std::floor(p);
    const double f = p - j;
    const auto ji = static_cast<std::size_t>(j);
    s += buffer_[static_cast<std::size_t>(i)] * (kernel_[ji] + (kernel_[ji + 1] - kernel_[ji]) * f);
  }
  return s;
}

void Resampler::trim() {
  const double keep = std::floor(next_ - half_) - buffer_start_;
  if (keep > 0) {
    const auto k = static_cast<std::size_t>(js_min(keep, static_cast<double>(buffer_.size())));
    buffer_.erase(buffer_.begin(), buffer_.begin() + static_cast<std::ptrdiff_t>(k));
    buffer_start_ += keep;
  }
}

void to_analysis_rate(const float* const* channels, std::size_t channel_count, std::size_t frames, double rate,
                      Vector<float>& out) {
  if (channel_count == 0) frames = 0;
  Vector<double> mono(frames, 0.0);
  for (std::size_t c = 0; c < channel_count; c++)
    for (std::size_t i = 0; i < frames; i++) mono[i] = mono[i] + static_cast<double>(channels[c][i]);
  if (channel_count > 1)
    for (std::size_t i = 0; i < frames; i++) mono[i] = mono[i] / static_cast<double>(channel_count);
  out.clear();
  if (rate == kAnalysisRate) {
    out.reserve(frames);
    for (double v : mono) out.push_back(static_cast<float>(v));
    return;
  }
  Resampler r(rate, kAnalysisRate);
  Vector<float> a, b;
  r.push(mono.data(), mono.size(), a);
  r.flush(b);
  const double length = js_round((static_cast<double>(frames) * kAnalysisRate) / rate);
  out.assign(static_cast<std::size_t>(length), 0.0f);
  const std::size_t na = std::min(a.size(), out.size());
  std::copy(a.begin(), a.begin() + static_cast<std::ptrdiff_t>(na), out.begin());
  if (a.size() < out.size()) {
    const std::size_t nb = std::min(b.size(), out.size() - a.size());
    std::copy(b.begin(), b.begin() + static_cast<std::ptrdiff_t>(nb), out.begin() + static_cast<std::ptrdiff_t>(a.size()));
  }
}

// --------------------------------------------------------------------- spectra

WindowFeatures window_features(const float* signal, std::size_t length, double start) {
  const Tables& t = tables();
  const int N = kAnalysisWindow;
  double x[kAnalysisWindow];
  WindowFeatures f;
  f.level = window_at(signal, length, start, x);
  double re[kAnalysisWindow];
  double im[kAnalysisWindow] = {};
  for (int i = 0; i < N; i++) re[i] = (x[i] - 0.97 * (i > 0 ? x[i - 1] : 0.0)) * t.hann[i];
  fft(re, im, N);
  double power[kBins];
  for (int k = 0; k < kBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  const auto band = [&](double lo, double hi) {
    double e = 0;
    for (double k = std::ceil(lo / kBinHz); k <= std::floor(hi / kBinHz); k++) e += power[static_cast<int>(k)];
    return e;
  };
  const double total = band(80, 3500);
  const auto share = [&](double lo, double hi) { return total > 0 ? band(lo, hi) / total : 0.0; };
  for (int m = 0; m < kMelBands; m++) {
    double e = 0;
    for (int k = 0; k < kBins; k++) e += t.mel_filters[m][k] * power[k];
    f.spectrum[m] = e;
  }
  f.bands = {share(250, 1000), share(1000, 2000), share(2000, 3500)};
  f.periodicity = std::isfinite(f.level) ? periodicity_of(x) : 0;
  return f;
}

double voicing_of(double p) {
  return js_min(1, js_max(0, (p - kNoisePeriodicity) / (kVoicedPeriodicity - kNoisePeriodicity)));
}

SoundStatistics sound_statistics(const float* signal, std::size_t length, double gate) {
  Vector<double> levels;
  Vector<Spectrum> unvoiced;
  const double hop = js_round(0.02 * kAnalysisRate);
  const double size = static_cast<double>(length);
  for (double s = 0; s + kAnalysisWindow <= size; s += hop) {
    const WindowFeatures f = window_features(signal, length, s);
    const double v = voicing_of(f.periodicity);
    if (f.level >= gate && v >= 0.5) levels.push_back(f.level);
    if (v < 0.5) unvoiced.push_back(f.spectrum);
  }
  SoundStatistics out;
  if (levels.size() >= 5) out.reference = percentile(levels, 0.7);
  if (unvoiced.size() >= 10) out.noise = band_percentile(unvoiced, 0.1);
  return out;
}

// ------------------------------------------------------------- noise tracker

void NoiseTracker::push(const Spectrum& spectrum) {
  // The last 300 spectra, in a ring (their percentiles do not depend on the order).
  if (history_.size() < kNoiseHistory) {
    history_.push_back(spectrum);
  } else {
    history_[head_] = spectrum;
    head_ = (head_ + 1) % kNoiseHistory;
  }
  // Re-estimated every fifth window, once ten are there.
  if (history_.size() >= 10 && (!value_ || ++pending_ >= 5)) {
    value_ = band_percentile(history_, 0.1);
    pending_ = 0;
  }
}

void NoiseTracker::reset() {
  history_.clear();
  head_ = 0;
  value_.reset();
  pending_ = 0;
}

// ------------------------------------------------------------------ profiles

const Vector<Spectrum>* VoiceProfile::vowel_templates(int vowel) const {
  for (const auto& v : templates)
    if (v.vowel == vowel) return &v.templates;
  return nullptr;
}

namespace {
const char* const kProfileFormat = "mochi2d-voice-profile";
}

bool voice_profile_from_json(const json::Value& o, VoiceProfile& out, String& message) {
  const json::Value* format = member(&o, "format");
  const json::Value* version = member(&o, "version");
  // Anything but an object lacks the format (a property of nothing else).
  if (!format || !format->is_string() || format->as_string() != kProfileFormat || !version ||
      !version->is_number() || version->as_number() != 1) {
    message = "not a Mochi2D voice profile (format mochi2d-voice-profile, version 1)";
    return false;
  }
  VoiceProfile p;
  const json::Value* templates = member(&o, "templates");
  for (int v = 0; v < kVowelCount; v++) {
    const json::Value* list = member(templates, kVowelIds[v]);
    if (!list) continue;
    bool ok = list->is_array();
    if (ok)
      for (const auto& t : list->items()) {
        if (!t.is_array() || t.items().size() != kMelBands) {
          ok = false;
          break;
        }
        for (const auto& x : t.items())
          if (!x.is_number() || !std::isfinite(x.as_number())) {
            ok = false;
            break;
          }
        if (!ok) break;
      }
    if (!ok) {
      message = String("voice profile: templates.") + kVowelIds[v] + " must hold spectra of 20 numbers";
      return false;
    }
    VoiceProfile::Vowel entry;
    entry.vowel = v;
    for (const auto& t : list->items()) {
      Spectrum s{};
      for (int m = 0; m < kMelBands; m++) s[m] = t.items()[static_cast<std::size_t>(m)].as_number();
      entry.templates.push_back(s);
    }
    p.templates.push_back(std::move(entry));
  }
  const json::Value* voiced = member(&o, "voicedLevel");
  if (!voiced || !voiced->is_number() || !std::isfinite(voiced->as_number())) {
    message = "voice profile: voicedLevel must be a number";
    return false;
  }
  const json::Value* floor = member(&o, "floorLevel");
  if (floor && !floor->is_null()) {
    if (!floor->is_number() || !std::isfinite(floor->as_number())) {
      message = "voice profile: floorLevel must be a number or null";
      return false;
    }
    p.floor_level = floor->as_number();
  }
  const json::Value* name = member(&o, "name");
  p.name = name && name->is_string() ? name->as_string() : String("voice");
  p.voiced_level = voiced->as_number();
  out = std::move(p);
  return true;
}

String voice_profile_to_json(const VoiceProfile& p) {
  json::Value o = json::Value::object();
  o.set("format", json::Value(kProfileFormat));
  o.set("version", json::Value(1));
  o.set("name", json::Value(p.name));
  json::Value templates = json::Value::object();
  for (const auto& v : p.templates) {
    json::Value list = json::Value::array();
    for (const auto& s : v.templates) {
      json::Value t = json::Value::array();
      for (double x : s) t.push(json::Value(x));
      list.push(std::move(t));
    }
    templates.set(kVowelIds[v.vowel], std::move(list));
  }
  o.set("templates", std::move(templates));
  o.set("voicedLevel", json::Value(p.voiced_level));
  o.set("floorLevel", p.floor_level ? json::Value(*p.floor_level) : json::Value(nullptr));
  return json::write_compact(o);
}

// --------------------------------------------------------------- calibration

int VoiceCalibration::add(int element, const float* const* channels, std::size_t channel_count, std::size_t frames,
                          double rate) {
  Vector<float> signal;
  to_analysis_rate(channels, channel_count, frames, rate, signal);
  const double hop = kAnalysisRate / 100;
  Vector<Spectrum> quiet;
  Vector<double> levels;
  int used = 0;
  const double size = static_cast<double>(signal.size());
  for (double s = 0; s + kAnalysisWindow <= size; s += hop) {
    const WindowFeatures f = window_features(signal.data(), signal.size(), s);
    if (element == 0) {
      if (std::isfinite(f.level)) levels.push_back(f.level);
      quiet.push_back(f.spectrum);
      used++;
      continue;
    }
    if (!(f.level > -45) || voicing_of(f.periodicity) < 0.5) continue;
    const int vowel = element - 1;
    Vector<Spectrum>* list = nullptr;
    for (auto& e : frames_)
      if (e.first == vowel) list = &e.second;
    if (!list) {
      frames_.emplace_back(vowel, Vector<Spectrum>());
      list = &frames_.back().second;
    }
    list->push_back(f.spectrum);
    levels_.push_back(f.level);
    used++;
  }
  if (element == 0 && !quiet.empty()) {
    has_floor_ = true;
    floor_level_ = levels.empty() ? -kInf : percentile(levels, 0.5);
    floor_spectrum_ = band_percentile(quiet, 0.5);
  }
  return used;
}

std::size_t VoiceCalibration::recorded(int vowel) const {
  for (const auto& e : frames_)
    if (e.first == vowel) return e.second.size();
  return 0;
}

VoiceProfile VoiceCalibration::profile() const {
  VoiceProfile p;
  p.name = name;
  const Spectrum* noise = has_floor_ ? &floor_spectrum_ : nullptr;
  for (const auto& [vowel, list] : frames_) {
    Spectrum mean{};
    const double n = static_cast<double>(list.size());
    for (const auto& f : list) {
      Spectrum db, mask;
      relative_spectrum(f, noise, db, mask);
      for (int m = 0; m < kMelBands; m++) mean[m] += db[m] / n;
    }
    VoiceProfile::Vowel v;
    v.vowel = vowel;
    v.templates.push_back(mean);
    p.templates.push_back(std::move(v));
  }
  p.voiced_level = levels_.empty() ? -26 : percentile(levels_, 0.7);
  if (has_floor_ && std::isfinite(floor_level_)) p.floor_level = floor_level_;
  return p;
}

// ------------------------------------------------------------------ analyzer

VowelAnalyzer::VowelAnalyzer(const AnalyzerOptions& options)
    : hangover(options.hangover ? *options.hangover : 0.04), gate_option_(options.gate), since_voiced_(kInf) {
  set_profile(options.profile);
}

double VowelAnalyzer::gate() const {
  if (gate_option_) return *gate_option_;
  return profile_.floor_level ? js_max(-50, *profile_.floor_level + 6) : -50;
}

double VowelAnalyzer::reference_level() const {
  if (reference) return *reference;
  return recent_.size() >= 30 ? percentile(recent_, 0.7) : profile_.voiced_level;
}

void VowelAnalyzer::set_profile(const VoiceProfile* p) {
  profile_ = p ? *p : neutral_voice_profile();
  templates_.clear();
  for (int v = 0; v < kVowelCount; v++)
    if (const auto* list = profile_.vowel_templates(v))
      for (const auto& t : *list) templates_.push_back({v, t});
  // σ: 0.4 of the median distance between templates of different vowels.
  Spectrum open;
  open.fill(-kSpectrumRange);
  Vector<double> d;
  for (std::size_t i = 0; i < templates_.size(); i++)
    for (std::size_t j = i + 1; j < templates_.size(); j++)
      if (templates_[i].vowel != templates_[j].vowel) d.push_back(masked_distance(templates_[i].t, open, templates_[j].t));
  sigma_ = d.empty() ? 1 : js_max(1e-6, 0.4 * percentile(d, 0.5));
}

void VowelAnalyzer::reset() {
  since_voiced_ = kInf;
  last_vowels_.fill(0);
  last_open_ = 0;
  recent_.clear();
  tracker_.reset();
}

Analysis VowelAnalyzer::analyze(const float* signal, std::size_t length, double start, double dt) {
  Analysis a;
  a.features = window_features(signal, length, start);
  const double level = a.features.level;
  a.level = level;
  const double g = gate();
  const bool loud = level >= g;
  since_voiced_ = loud ? 0 : since_voiced_ + js_max(0, dt);
  const double voicing = loud ? voicing_of(a.features.periodicity) : 0;
  a.voicing = voicing;
  if (!noise && voicing < 0.5) tracker_.push(a.features.spectrum);
  if ((!loud && since_voiced_ > hangover) || templates_.empty()) {
    a.raw[0] = 1;
    a.silent = true;
    a.open = 0;
    return a;
  }
  // During the hangover, the last loud window's weights.
  if (loud) {
    std::array<double, kVowelCount> vowels{};
    Spectrum db, mask;
    const Spectrum* n = noise ? &*noise : (tracker_.noise() ? &*tracker_.noise() : nullptr);
    relative_spectrum(a.features.spectrum, n, db, mask);
    const double s2 = 2 * sigma_ * sigma_;
    for (const auto& t : templates_) {
      const double d = masked_distance(db, mask, t.t);
      vowels[t.vowel] = js_max(vowels[t.vowel], fdlibm::exp(-(d * d) / s2));
    }
    double sum = 0;
    for (double v : vowels) sum = sum + v;
    if (sum > 0) {
      for (auto& v : vowels) v = v / sum;
    } else {
      // Far from every template: the nearest takes it all.
      int best = 0;
      double best_d = kInf;
      for (const auto& t : templates_) {
        const double d = masked_distance(db, mask, t.t);
        if (d < best_d) {
          best = t.vowel;
          best_d = d;
        }
      }
      vowels[best] = 1;
    }
    if (voicing >= 0.5) {
      recent_.push_back(level);
      if (recent_.size() > kRecent) recent_.erase(recent_.begin());
    }
    const double full = js_max(g + 6, reference_level() - 6);
    last_open_ = js_min(1, js_max(0, (level - g) / (full - g))) * voicing;
    last_vowels_ = vowels;
  }
  const double open = last_open_;
  a.open = open;
  a.raw[0] = 1 - open;
  for (int i = 0; i < kVowelCount; i++) a.raw[i + 1] = open * last_vowels_[i];
  a.silent = false;
  return a;
}

}  // namespace mochi2d::framework

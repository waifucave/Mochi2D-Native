#include "framework/motion_sync_driver.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

#include "fdlibm.hpp"
#include "util/text.hpp"

namespace mochi2d::framework {

namespace {
constexpr int kSilence = 0;
constexpr double kInf = std::numeric_limits<double>::infinity();
/** The window a settling setting is fed. */
const float kSilent[kAnalysisWindow] = {};
}  // namespace

// ------------------------------------------------------------- filter, clock

ParameterFilter::ParameterFilter(Vector<double> smooth_, Vector<double> damper_, bool smoothing_)
    : smooth(std::move(smooth_)), damper(std::move(damper_)), smoothing(smoothing_) {
  smoothed.assign(smooth.size(), 0.0);
  output.assign(smooth.size(), 0.0);
}

void ParameterFilter::reset(const double* values) {
  for (std::size_t k = 0; k < smoothed.size(); k++) {
    smoothed[k] = values[k];
    output[k] = values[k];
  }
}

void ParameterFilter::step(const double* y) {
  for (std::size_t k = 0; k < smoothed.size(); k++) {
    const double v = y[k];
    if (std::isnan(v)) continue;
    const double w = smooth[k];
    smoothed[k] = smoothing ? ((100 - w) * v + w * smoothed[k]) / 100 : v;
    if (!(std::fabs(smoothed[k] - output[k]) < damper[k])) output[k] = smoothed[k];
  }
}

bool TickClock::advance(double dt) {
  time += dt > 0 ? dt : 0;
  const double h = 1 / sample_rate;
  if (time < h) return false;
  time = std::fmod(time, h);
  return true;
}

// -------------------------------------------------------------------- engine

SettingEngine::SettingEngine(const MotionSyncSetting& setting) : setting_(&setting) {
  const std::size_t P = setting.parameters.size();
  const std::size_t E = setting.elements.size();
  weights.assign(E, 0.0);
  values.assign(P, 0.0);
  for (const auto& e : setting.elements) slot_.push_back(e.known ? motion_sync_element_index(e.id) : -1);
  for (std::size_t k = 0; k < P; k++) {
    double lo = kInf, hi = -kInf;
    for (const auto& s : setting.shapes) {
      lo = js_min(lo, s[k]);
      hi = js_max(hi, s[k]);
    }
    span_.push_back(hi > lo ? hi - lo : 0);
  }
  int silence = -1;
  for (std::size_t e = 0; e < E; e++)
    if (setting.elements[e].id == "Silence") {
      silence = static_cast<int>(e);
      break;
    }
  for (std::size_t k = 0; k < P; k++)
    rest_.push_back(silence >= 0 ? setting.shapes[static_cast<std::size_t>(silence)][k] : 0.0);
}

void SettingEngine::step(const Analysis& a, double dt) {
  const MotionSyncSetting& s = *setting_;
  const std::size_t E = s.elements.size();
  // 1–3: the gate, Enabled (and unknown elements), Scale.
  double sum = 0;
  for (std::size_t e = 0; e < E; e++) {
    const MotionSyncElement& el = s.elements[e];
    const int slot = slot_[e];
    double r = slot < 0 || !el.enabled ? 0.0
               : a.silent              ? (slot == kSilence ? 1.0 : 0.0)
                                       : a.raw[static_cast<std::size_t>(slot)];
    r *= el.scale;
    weights[e] = r;
    sum += r;
  }
  // 4: normalized; with nothing left, the Silence element alone.
  if (sum > 0)
    for (std::size_t e = 0; e < E; e++) weights[e] = weights[e] / sum;
  else
    for (std::size_t e = 0; e < E; e++) weights[e] = s.elements[e].id == "Silence" ? 1 : 0;
  // 5: the most likely element (ties: the earlier), blended with the weights.
  std::ptrdiff_t best = -1;
  for (std::size_t e = 0; e < E; e++)
    if (best < 0 || weights[e] > weights[static_cast<std::size_t>(best)]) best = static_cast<std::ptrdiff_t>(e);
  const double br = s.blend_ratio;
  // 6: the shape.
  for (std::size_t k = 0; k < s.parameters.size(); k++) {
    double v = 0;
    for (std::size_t e = 0; e < E; e++) {
      const double q = br * weights[e] + (static_cast<std::ptrdiff_t>(e) == best ? 1 - br : 0.0);
      v += q * s.shapes[e][k];
    }
    // 7: slew limits.
    if (!started_) {
      values[k] = v;
      continue;
    }
    const double u = values[k];
    const double x = (s.smoothing - 1) / 99;
    const double attack = 0.02 * fdlibm::pow(25, x);
    const double release = 1.5 * attack;
    const double rest = rest_[k];
    const bool opening = std::fabs(v - rest) > std::fabs(u - rest);
    const double limit = span_[k] * (js_max(0, dt) / (opening ? attack : release));
    values[k] = u + js_min(limit, js_max(-limit, v - u));
  }
  started_ = true;
}

// --------------------------------------------------------------------- sounds

void MotionSyncSound::prepare() {
  Vector<const float*> ch;
  for (const auto& c : channels) ch.push_back(c.data());
  to_analysis_rate(ch.data(), ch.size(), frames(), sample_rate, signal);
}

bool decode_motion_sync_wav(const uint8_t* b, std::size_t size, MotionSyncSound& out, String& message) {
  const auto tag = [&](std::size_t o, const char* t) { return std::memcmp(b + o, t, 4) == 0; };
  const auto u16 = [&](std::size_t o) { return static_cast<uint32_t>(b[o]) | (static_cast<uint32_t>(b[o + 1]) << 8); };
  const auto u32 = [&](std::size_t o) { return u16(o) | (u16(o + 2) << 16); };
  if (size < 12 || !tag(0, "RIFF") || !tag(8, "WAVE")) {
    message = "not a RIFF/WAVE file";
    return false;
  }
  uint64_t o = 12;
  int64_t format = -1;
  uint32_t channels = 0, rate = 0, bits = 0;
  bool has_data = false;
  uint64_t data_start = 0, data_size = 0;
  while (o + 8 <= size) {
    const auto at = static_cast<std::size_t>(o);
    const uint64_t chunk = u32(at + 4);
    const uint64_t body = o + 8;
    if (tag(at, "fmt ") && body + 16 <= size) {
      const auto bo = static_cast<std::size_t>(body);
      format = u16(bo);
      channels = u16(bo + 2);
      rate = u32(bo + 4);
      bits = u16(bo + 14);
      // Extensible: the sub-format's first two bytes are the format code.
      if (format == 0xfffe && chunk >= 40 && body + 26 <= size) format = u16(bo + 24);
    } else if (tag(at, "data")) {
      has_data = true;
      data_start = body;
      data_size = std::min<uint64_t>(chunk, size - body);
      break;
    }
    o = body + chunk + (chunk & 1);
  }
  if (format < 0) {
    message = "no fmt chunk";
    return false;
  }
  if (!has_data) {
    message = "no data chunk";
    return false;
  }
  if (channels < 1 || !(rate > 0)) {
    message = "no channels, or no sample rate";
    return false;
  }
  // 0.16.0: the analysis works on windows of the file's own rate; a rate far beyond audio's is a damaged file.
  if (rate < kMotionSyncWavMinRate || rate > kMotionSyncWavMaxRate) {
    message = "a sample rate of " + to_str(rate) + " Hz is outside 1000–768000 Hz";
    return false;
  }
  const bool pcm = format == 1 && (bits == 8 || bits == 16 || bits == 24 || bits == 32);
  const bool is_float = format == 3 && (bits == 32 || bits == 64);
  if (!pcm && !is_float) {
    message = "format " + to_str(static_cast<long long>(format)) + " with " + to_str(bits) +
              "-bit samples is not supported";
    return false;
  }
  const uint64_t bytes_per = bits / 8;
  const uint64_t frames = data_size / (bytes_per * channels);
  MotionSyncSound s;
  s.sample_rate = rate;
  s.channels.resize(channels);
  for (auto& c : s.channels) c.assign(static_cast<std::size_t>(frames), 0.0f);
  for (uint64_t i = 0; i < frames; i++)
    for (uint32_t c = 0; c < channels; c++) {
      const auto p = static_cast<std::size_t>(data_start + (i * channels + c) * bytes_per);
      double v;
      if (is_float) {
        if (bits == 32) {
          const uint32_t w = u32(p);
          float f;
          std::memcpy(&f, &w, 4);
          v = f;
        } else {
          const uint64_t w = static_cast<uint64_t>(u32(p)) | (static_cast<uint64_t>(u32(p + 4)) << 32);
          double d;
          std::memcpy(&d, &w, 8);
          v = d;
        }
      } else if (bits == 8) {
        v = (static_cast<double>(b[p]) - 128) / 128;
      } else if (bits == 16) {
        v = static_cast<int16_t>(static_cast<uint16_t>(u16(p))) / 32768.0;
      } else if (bits == 24) {
        const uint32_t w = static_cast<uint32_t>(b[p]) | (static_cast<uint32_t>(b[p + 1]) << 8) |
                           (static_cast<uint32_t>(b[p + 2]) << 16);
        const int32_t n = static_cast<int32_t>(w << 8) >> 8;
        v = n / 8388608.0;
      } else {
        v = static_cast<int32_t>(u32(p)) / 2147483648.0;
      }
      s.channels[c][static_cast<std::size_t>(i)] = static_cast<float>(v);
    }
  out = std::move(s);
  return true;
}

// ----------------------------------------------------------------- live input

MotionSyncLiveInput::MotionSyncLiveInput(double sample_rate, std::size_t capacity) : rate_(sample_rate) {
  ring_.assign(capacity > 0 ? capacity : 1, 0.0f);
}

void MotionSyncLiveInput::lock() const {
  while (busy_.test_and_set(std::memory_order_acquire)) {
  }
}

void MotionSyncLiveInput::push(const float* samples, std::size_t n) {
  lock();
  const std::size_t cap = ring_.size();
  if (n > cap) {
    dropped_ += n - cap;
    samples += n - cap;
    n = cap;
  }
  if (count_ + n > cap) {
    const std::size_t drop = count_ + n - cap;
    head_ = (head_ + drop) % cap;
    count_ -= drop;
    dropped_ += drop;
  }
  for (std::size_t i = 0; i < n; i++) ring_[(head_ + count_ + i) % cap] = samples[i];
  count_ += n;
  unlock();
}

void MotionSyncLiveInput::read(Vector<float>& out) {
  out.clear();
  lock();
  // The vector's capacity is reused frame to frame; it grows to the buffer's at most.
  out.reserve(ring_.size());
  for (std::size_t i = 0; i < count_; i++) out.push_back(ring_[(head_ + i) % ring_.size()]);
  head_ = 0;
  count_ = 0;
  unlock();
}

std::size_t MotionSyncLiveInput::pending() const {
  lock();
  const std::size_t n = count_;
  unlock();
  return n;
}

uint64_t MotionSyncLiveInput::dropped() const {
  lock();
  const uint64_t n = dropped_;
  unlock();
  return n;
}

// --------------------------------------------------------------------- driver

MotionSyncDriver::MotionSyncDriver(std::shared_ptr<const MotionSyncFile> file, AnimationValues& values,
                                   const MotionSyncOptions& options)
    : file_(std::move(file)), values_(&values), options_(options) {
  states_.resize(file_->settings.size());
}

const MotionSyncSetting* MotionSyncDriver::setting() const {
  return bound_ >= 0 ? states_[static_cast<std::size_t>(bound_)]->setting : nullptr;
}

void MotionSyncDriver::set_profile(const VoiceProfile* profile) {
  if (profile)
    profile_ = *profile;
  else
    profile_.reset();
  for (auto& s : states_)
    if (s) s->analyzer.set_profile(profile_ ? &*profile_ : nullptr);
}

MotionSyncDriver::State& MotionSyncDriver::state(int index) {
  auto& slot = states_[static_cast<std::size_t>(index)];
  if (slot) return *slot;
  const MotionSyncSetting& setting = file_->settings[static_cast<std::size_t>(index)];
  const AnimationValues& v = *values_;
  Vector<int> targets;
  const String& who = setting.name.empty() ? setting.id : setting.name;
  for (const auto& p : setting.parameters) {
    const int i = v.index(p.id);
    if (i < 0) {
      warnings.push_back(file_->label + ": \"" + who + "\" drives " + p.id + ", which the model lacks; it is not written");
    } else {
      const double lo = v.min[static_cast<std::size_t>(i)], hi = v.max[static_cast<std::size_t>(i)];
      if (p.min != lo || p.max != hi)
        warnings.push_back(file_->label + ": \"" + who + "\" gives " + p.id + " the range [" + text::js_number(p.min) +
                           ", " + text::js_number(p.max) + "], the model [" + text::js_number(lo) + ", " +
                           text::js_number(hi) + "]; driven anyway");
    }
    targets.push_back(i);
  }
  AnalyzerOptions ao;
  ao.profile = profile_ ? &*profile_ : nullptr;
  ao.gate = options_.gate;
  ao.hangover = options_.hangover;
  Vector<double> smooth, damper;
  for (const auto& p : setting.parameters) {
    smooth.push_back(p.smooth);
    damper.push_back(p.damper);
  }
  slot.emplace(State{&setting, std::move(targets), TickClock(setting.sample_rate), SettingEngine(setting),
                     ParameterFilter(std::move(smooth), std::move(damper), options_.file_smoothing),
                     VowelAnalyzer(ao)});
  return *slot;
}

MotionSyncDriver::State* MotionSyncDriver::bind(int index) {
  if (index < 0 || static_cast<std::size_t>(index) >= states_.size()) return nullptr;
  if (!file_->settings[static_cast<std::size_t>(index)].usable) return nullptr;
  State& st = state(index);
  if (bound_ != index) {
    // Another setting: it starts afresh from the parameters' current values.
    st.fresh = true;
    st.has_result = false;
    st.clock.time = 0;
    st.since_tick = 0;
    st.engine.reset();
    st.analyzer.reset();
  }
  bound_ = index;
  driven_ids_.clear();
  for (const auto& p : st.setting->parameters) driven_ids_.push_back(p.id);
  settling_ = -1;
  has_tick_ = false;
  return &st;
}

bool MotionSyncDriver::play_sound(int index, std::shared_ptr<const MotionSyncSound> sound, MotionSyncClock* clock) {
  State* st = bind(index);
  if (!st) return false;
  // The sound's own reference level and noise, found ahead of playback.
  const double gate = st->analyzer.gate();
  const SoundStatistics* stats = nullptr;
  for (auto it = statistics_.begin(); it != statistics_.end();) {
    if (it->sound.expired()) {
      it = statistics_.erase(it);
      continue;
    }
    const auto& w = it->sound;
    const bool same = !w.owner_before(sound) && !sound.owner_before(w);
    // Map keys compare by SameValueZero: -0 is +0, NaN is NaN.
    if (same && (it->gate == gate || (std::isnan(it->gate) && std::isnan(gate)))) stats = &it->statistics;
    ++it;
  }
  if (!stats) {
    if (statistics_.size() >= 8) statistics_.erase(statistics_.begin());
    statistics_.push_back({sound, gate, sound_statistics(sound->signal.data(), sound->signal.size(), gate)});
    stats = &statistics_.back().statistics;
  }
  st->analyzer.reference = stats->reference;
  st->analyzer.noise = stats->noise;
  live_ = false;
  input_ = nullptr;
  resampler_.reset();
  sound_ = std::move(sound);
  clock_ = clock;
  time_ = 0;
  binding_consumed_ = 0;
  fading_ = false;
  consumed = 0;
  return true;
}

bool MotionSyncDriver::set_input(int index, MotionSyncInput* input) {
  State* st = bind(index);
  if (!st) return false;
  // The reference level and the noise follow the input.
  st->analyzer.reference.reset();
  st->analyzer.noise.reset();
  live_ = true;
  sound_.reset();
  clock_ = nullptr;
  fading_ = false;
  input_ = input;
  if (input->sample_rate() == kAnalysisRate)
    resampler_.reset();
  else
    resampler_.emplace(input->sample_rate(), kAnalysisRate);
  recent_.assign(kAnalysisWindow, 0.0f);
  time_ = 0;
  return true;
}

void MotionSyncDriver::stop(double fade) {
  if (bound_ < 0) return;
  if (!live_ && fade > 0 && settling_ < 0) {
    fading_ = true;
    fade_from_ = time_;
    fade_seconds_ = fade;
    return;
  }
  if (settling_ < 0) settling_ = 0;
}

void MotionSyncDriver::clear() {
  bound_ = -1;
  driven_ids_.clear();
  live_ = false;
  sound_.reset();
  input_ = nullptr;
  clock_ = nullptr;
  resampler_.reset();
  settling_ = -1;
  has_tick_ = false;
}

void MotionSyncDriver::frame(double dt) {
  if (bound_ < 0) return;
  State& st = *states_[static_cast<std::size_t>(bound_)];
  AnimationValues& v = *values_;
  if (st.fresh) {
    Vector<double> current;
    for (int i : st.targets) current.push_back(i >= 0 ? static_cast<double>(v.values[static_cast<std::size_t>(i)]) : 0.0);
    st.filter.reset(current.data());
    st.fresh = false;
  }
  const double step = dt > 0 ? dt : 0;
  const float* signal;
  std::size_t length;
  double start = 0;
  double gain = 1;
  if (!live_) {
    const MotionSyncSound& sound = *sound_;
    signal = sound.signal.data();
    length = sound.signal.size();
    const double before = time_;
    double position = 0;
    const bool has_position = clock_ && clock_->position(position);
    time_ = has_position ? js_max(time_, position) : time_ + step;
    const double frames = static_cast<double>(sound.frames());
    const double was = js_min(frames, js_round(before * sound.sample_rate));
    const double now = js_min(frames, js_round(time_ * sound.sample_rate));
    binding_consumed_ += now - was;
    consumed = binding_consumed_;
    if (fading_) gain = js_max(0, 1 - (time_ - fade_from_) / fade_seconds_);
    if (settling_ < 0 && (now >= frames || gain <= 0)) settling_ = 0;
    start = js_round(time_ * kAnalysisRate) - kAnalysisWindow / 2;
  } else {
    input_->read(fresh_);
    if (resampler_) {
      fresh_doubles_.assign(fresh_.begin(), fresh_.end());
      resampler_->push(fresh_doubles_.data(), fresh_doubles_.size(), added_);
    } else {
      added_.assign(fresh_.begin(), fresh_.end());
    }
    time_ += static_cast<double>(fresh_.size()) / input_->sample_rate();
    const std::size_t n = added_.size();
    if (n >= static_cast<std::size_t>(kAnalysisWindow)) {
      std::copy(added_.end() - kAnalysisWindow, added_.end(), recent_.begin());
    } else if (n > 0) {
      std::copy(recent_.begin() + static_cast<std::ptrdiff_t>(n), recent_.end(), recent_.begin());
      std::copy(added_.begin(), added_.end(), recent_.end() - static_cast<std::ptrdiff_t>(n));
    }
    signal = recent_.data();
    length = recent_.size();
  }
  if (settling_ >= 0) {
    settling_ += step;
    signal = kSilent;
    length = kAnalysisWindow;
    start = 0;
    gain = 1;
  }
  st.since_tick += step;
  if (st.clock.advance(dt)) {
    const double h = st.since_tick;
    st.since_tick = 0;
    Analysis a = st.analyzer.analyze(signal, length, start, h);
    if (gain < 1) {
      a.level += 20 * fdlibm::log10(gain);
      if (!(a.level >= st.analyzer.gate())) {
        a.silent = true;
        a.raw.fill(0);
        a.raw[kSilence] = 1;
      }
    }
    st.engine.step(a, h);
    st.filter.step(st.engine.values.data());
    st.has_result = true;
    report(st, a);
  }
  if (st.has_result)
    for (std::size_t k = 0; k < st.targets.size(); k++) {
      const int i = st.targets[k];
      const double d = st.filter.output[k];
      if (i >= 0 && !std::isnan(d)) v.set_at(i, d);
    }
  if (settling_ >= 0 && settled(st)) clear();
}

bool MotionSyncDriver::settled(const State& st) const {
  if (settling_ >= options_.settle_time) return true;
  const MotionSyncSetting& s = *st.setting;
  int silence = -1;
  for (std::size_t e = 0; e < s.elements.size(); e++)
    if (s.elements[e].id == "Silence") {
      silence = static_cast<int>(e);
      break;
    }
  for (std::size_t k = 0; k < s.parameters.size(); k++) {
    const double rest = silence >= 0 ? s.shapes[static_cast<std::size_t>(silence)][k] : 0.0;
    if (!(std::fabs(st.filter.output[k] - rest) <= s.parameters[k].damper)) return false;
  }
  return true;
}

void MotionSyncDriver::report(State& st, const Analysis& a) {
  MotionSyncTick& t = latest_;
  t.setting = st.setting->index;
  t.name = st.setting->name;
  t.id = st.setting->id;
  t.live = live_;
  t.level = a.level;
  t.silent = a.silent;
  t.weights.fill(0);
  for (std::size_t e = 0; e < st.setting->elements.size(); e++) {
    const auto& el = st.setting->elements[e];
    if (el.known) {
      const auto slot = static_cast<std::size_t>(motion_sync_element_index(el.id));
      t.weights[slot] += st.engine.weights[e];
    }
  }
  t.values.assign(st.filter.output.begin(), st.filter.output.end());
  t.time = time_;
  t.serial = ++serial_;
  t.analysis = a;
  has_tick_ = true;
  if (listener_) listener_(t, listener_user_);
}

}  // namespace mochi2d::framework

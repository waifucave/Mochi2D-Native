#include "framework/live_input.hpp"

#include <cmath>

#include "fdlibm.hpp"
#include "framework/jsutil.hpp"

namespace mochi2d::framework {

double dbfs_to_amplitude(double db) {
  const double a = fdlibm::pow(10, db / 20);
  return a > 0 ? a : 0;
}

LiveLipSyncInput::LiveLipSyncInput(double rate, const LiveLipSyncSettings& s, double window)
    : settings(s), sample_rate(rate), max_window(window) {}

void LiveLipSyncInput::lock() const {
  while (busy_.test_and_set(std::memory_order_acquire)) {
  }
}

void LiveLipSyncInput::unlock() const { busy_.clear(std::memory_order_release); }

void LiveLipSyncInput::push(const float* const* channels, std::size_t channel_count, std::size_t frames) {
  if (!channels || channel_count == 0 || frames == 0) return;
  double sum = 0;
  for (std::size_t c = 0; c < channel_count; c++) {
    const float* ch = channels[c];
    for (std::size_t i = 0; i < frames; i++) {
      const double x = ch[i];
      sum += x * x;
    }
  }
  push_sums(sum, static_cast<double>(channel_count * frames), static_cast<double>(frames));
}

void LiveLipSyncInput::push_interleaved(const float* samples, std::size_t channel_count, std::size_t frames) {
  if (!samples || channel_count == 0 || frames == 0) return;
  double sum = 0;
  for (std::size_t c = 0; c < channel_count; c++)
    for (std::size_t i = 0; i < frames; i++) {
      const double x = samples[i * channel_count + c];
      sum += x * x;
    }
  push_sums(sum, static_cast<double>(channel_count * frames), static_cast<double>(frames));
}

void LiveLipSyncInput::push_sums(double sum_squares, double values, double frames) {
  if (!(frames > 0) || !(values > 0) || !(sum_squares >= 0)) return;
  lock();
  if (frames_ > 0 && frames_ + frames > max_window * sample_rate) {
    sum_ = 0;
    count_ = 0;
    frames_ = 0;
  }
  sum_ += sum_squares;
  count_ += values;
  frames_ += frames;
  unlock();
}

double LiveLipSyncInput::pending() const {
  lock();
  const double f = frames_;
  unlock();
  return f / sample_rate;
}

double LiveLipSyncInput::next(double dt) {
  lock();
  const double sum = sum_, count = count_, frames = frames_;
  if (count > 0) {
    sum_ = 0;
    count_ = 0;
    frames_ = 0;
  }
  unlock();
  if (count > 0) {
    const double rms = std::sqrt(sum / count);
    const double seconds = frames / sample_rate;
    idle_ = 0;
    level = rms;
    value = step(rms, seconds);
  } else {
    idle_ += dt > 0 ? dt : 0;
    if (idle_ > kLiveSilenceAfter) {
      level = 0;
      value = step(0, dt);
    }
  }
  return value;
}

void LiveLipSyncInput::reset() {
  lock();
  sum_ = 0;
  count_ = 0;
  frames_ = 0;
  unlock();
  idle_ = 0;
  level = 0;
  value = 0;
}

double LiveLipSyncInput::step(double rms, double seconds) {
  const LiveLipSyncSettings& s = settings;
  const double gain = s.gain > 0 && s.gain < std::numeric_limits<double>::infinity() ? s.gain : 0;
  const double target = gain * js_max(0, rms - dbfs_to_amplitude(s.gate));
  const double tau = target > value ? s.attack : s.release;
  if (!(tau > 0)) return target;
  if (!(seconds > 0)) return value;
  return value + (target - value) * (1 - fdlibm::exp(-seconds / tau));
}

}  // namespace mochi2d::framework

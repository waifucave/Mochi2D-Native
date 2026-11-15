#include "framework/lip_sync.hpp"

#include <cmath>
#include <limits>

#include "util/text.hpp"

namespace mochi2d::framework {

namespace {

bool tag_is(const uint8_t* b, uint64_t o, const char* t) {
  return b[o] == static_cast<uint8_t>(t[0]) && b[o + 1] == static_cast<uint8_t>(t[1]) &&
         b[o + 2] == static_cast<uint8_t>(t[2]) && b[o + 3] == static_cast<uint8_t>(t[3]);
}

uint32_t u32(const uint8_t* b, uint64_t o) {
  return static_cast<uint32_t>(b[o]) | static_cast<uint32_t>(b[o + 1]) << 8 | static_cast<uint32_t>(b[o + 2]) << 16 |
         static_cast<uint32_t>(b[o + 3]) << 24;
}

uint16_t u16(const uint8_t* b, uint64_t o) { return static_cast<uint16_t>(b[o] | b[o + 1] << 8); }

bool fail(String& error, String message) {
  error = std::move(message);
  return false;
}

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

}  // namespace

bool decode_wav(const uint8_t* bytes, std::size_t size, WavSound& out, String& error) {
  const uint64_t length = size;
  if (length < 12 || !tag_is(bytes, 0, "RIFF") || !tag_is(bytes, 8, "WAVE")) return fail(error, "not a RIFF/WAVE file");
  if (length < 20 || !tag_is(bytes, 12, "fmt ")) return fail(error, "the fmt chunk does not follow WAVE");
  const uint32_t fmt_size = u32(bytes, 16);
  if (length < 20 + 16) return fail(error, "truncated fmt chunk");
  const uint16_t format = u16(bytes, 20);
  const uint16_t channels = u16(bytes, 22);
  const uint32_t sample_rate = u32(bytes, 24);
  const uint16_t bits = u16(bytes, 34);
  if (format != 1) return fail(error, "format code " + to_str(format) + " is not linear PCM");
  if (channels == 0) return fail(error, "no channels");
  if (bits == 0) return fail(error, "0 bits per sample");  // 0.16.0
  // Skip chunks (by their sizes, no pad bytes) until "data".
  uint64_t o = 20 + static_cast<uint64_t>(fmt_size);
  while (o + 8 <= length && !tag_is(bytes, o, "data")) o += 8 + static_cast<uint64_t>(u32(bytes, o + 4));
  if (o + 8 > length) return fail(error, "no data chunk");
  const uint64_t data_size = std::min<uint64_t>(u32(bytes, o + 4), length - o - 8);
  const uint64_t start = o + 8;
  const uint64_t bytes_per_sample = (static_cast<uint64_t>(bits) + 7) / 8;
  const uint64_t block = bytes_per_sample * channels;
  // Math.floor(size / 0) is Infinity (no typed array of that length) or NaN (a length of 0).
  if (block == 0 && data_size > 0) return fail(error, "Invalid typed array length: Infinity");
  const uint64_t frames = block == 0 ? 0 : data_size / block;
  WavSound w;
  w.channels = channels;
  w.sample_rate = sample_rate;
  w.bits_per_sample = bits;
  w.frames = block == 0 ? kNaN : static_cast<double>(frames);
  w.samples.resize(channels);
  for (auto& s : w.samples) s.assign(static_cast<std::size_t>(frames), 0.0);
  const double scale = 2147483647;  // 2³¹ − 1
  if (bits == 8 || bits == 16 || bits == 24)
    for (uint64_t c = 0; c < channels; c++) {
      auto& s = w.samples[static_cast<std::size_t>(c)];
      for (uint64_t i = 0; i < frames; i++) {
        const uint64_t p = start + (i * channels + c) * bytes_per_sample;
        double v;
        if (bits == 8) {
          v = (static_cast<double>(bytes[p]) - 128) * 16777216;
        } else if (bits == 16) {
          v = static_cast<double>(static_cast<int16_t>(u16(bytes, p))) * 65536;
        } else {
          const uint32_t raw = static_cast<uint32_t>(bytes[p]) | static_cast<uint32_t>(bytes[p + 1]) << 8 |
                               static_cast<uint32_t>(bytes[p + 2]) << 16;
          const int32_t n = raw & 0x800000u ? static_cast<int32_t>(raw) - 0x1000000 : static_cast<int32_t>(raw);
          v = static_cast<double>(n) * 256;
        }
        s[static_cast<std::size_t>(i)] = fround(v / scale);  // C15: decoded samples are float32
      }
    }
  out = std::move(w);
  return true;
}

void LipSync::set_live(LiveLipSyncSource* source, LiveLipSyncMix mix) {
  live_ = source;
  live_mix = mix;
  live_value = 0;
}

void LipSync::start(std::shared_ptr<const WavSound> sound) {
  sound_ = std::move(sound);
  time = 0;
  position_ = 0;
  value = live_value;
  sound_value = 0;
}

namespace {
bool skipped(const Vector<String>* skip, const String& id) {
  if (!skip) return false;
  for (const auto& s : *skip)
    if (s == id) return true;
  return false;
}
}  // namespace

void LipSync::frame(double dt, AnimationValues& values, const Vector<String>* skip) {
  if (skip && skip->empty()) skip = nullptr;
  sound_frame(dt, values, skip);
  value = sound_value;
  if (!live_) return;
  const double v = live_->next(dt);
  const double l = std::isfinite(v) && v > 0 ? v : 0;
  live_value = l;
  if (live_mix == LiveLipSyncMix::Add) {
    if (l > 0)
      for (const auto& id : ids_)
        if (!skipped(skip, id)) values.add(id, l, 1);
    value = std::isnan(value) ? l : value + l;
    return;
  }
  for (const auto& id : ids_) {
    if (skipped(skip, id)) continue;
    const double current = values.get(id);
    double x;
    if (live_mix == LiveLipSyncMix::Replace)
      x = l;
    else if (live_mix == LiveLipSyncMix::Max)
      x = js_max(current, l);
    else
      x = mix_function ? mix_function(l, current, id.c_str(), mix_user) : kNaN;
    if (std::isfinite(x)) values.set(id, x, 1);
  }
  const double sound = std::isnan(value) ? 0 : value;
  value = live_mix == LiveLipSyncMix::Max ? js_max(sound, l) : l;
}

void LipSync::sound_frame(double dt, AnimationValues& values, const Vector<String>* skip) {
  const WavSound* snd = sound_.get();
  if (!snd || position_ >= snd->frames) {
    sound_value = 0;
    return;
  }
  time += dt;
  const double g = js_min(std::floor(time * snd->sample_rate), snd->frames);
  const double from = position_;
  if (g == from) {
    // 0/0 in the reference (NaN written); the write is skipped here.
    sound_value = kNaN;
    return;
  }
  double sum = 0;
  for (const auto& ch : snd->samples) {
    // Out-of-range reads of a typed array give undefined (NaN in the sum).
    const double n = static_cast<double>(ch.size());
    for (double i = from; i < g; i++) {
      const double x = i >= 0 && i < n ? ch[static_cast<std::size_t>(i)] : kNaN;
      sum += x * x;
    }
  }
  const double rms = std::sqrt(sum / (snd->channels * (g - from)));
  position_ = g;
  sound_value = rms;
  for (const auto& id : ids_)
    if (!skipped(skip, id)) values.add(id, rms, 1);
}

}  // namespace mochi2d::framework

// Compares Mochi2D Native's live lip sync with Mochi2D's LiveLipSync, bit for
// bit, on the vectors in <data>/live/expected.json (made by live.ts): the same
// generated sample blocks, sums, settings, rates, resets and frame steps.
//
// usage: mochi2d_check_live <data dir>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <limits>

#include "conformance/scenario.hpp"
#include "fdlibm.hpp"
#include "framework/live_input.hpp"
#include "util/json.hpp"

using namespace mochi2d;
namespace fs = std::filesystem;
namespace fw = mochi2d::framework;

namespace {

constexpr double kPi = 3.141592653589793;

double number(const json::Value& v) {
  if (v.is_number()) return v.as_number();
  const String& s = v.as_string();
  if (s == "NaN") return std::numeric_limits<double>::quiet_NaN();
  return s == "Infinity" ? std::numeric_limits<double>::infinity() : -std::numeric_limits<double>::infinity();
}

bool same(double want, double got) {
  if (std::isnan(want) || std::isnan(got)) return std::isnan(want) && std::isnan(got);
  return std::memcmp(&want, &got, sizeof want) == 0;
}

fw::LiveLipSyncSettings settings_of(const json::Value& v) {
  const auto& a = v.items();
  return {number(a[0]), number(a[1]), number(a[2]), number(a[3])};
}

/** live.ts's blockSamples. */
Vector<Vector<float>> samples(const json::Value& b, double rate) {
  const String kind = b.get("kind")->as_string();
  const double a = b.get("a")->as_number();
  const double f = b.get("f")->as_number();
  const auto seed = static_cast<uint32_t>(b.get("seed")->as_number());
  const double start = b.get("start")->as_number();
  const auto n = static_cast<std::size_t>(b.get("n")->as_number());
  const auto channels = static_cast<std::size_t>(b.get("channels")->as_number());
  const int bad = static_cast<int>(b.get("bad")->as_number());
  const auto at = static_cast<std::size_t>(b.get("at")->as_number());
  Vector<Vector<float>> out;
  for (std::size_t c = 0; c < channels; c++) {
    Vector<float> ch(n);
    uint32_t s = seed + 977u * static_cast<uint32_t>(c);
    for (std::size_t i = 0; i < n; i++) {
      double v = 0;
      if (kind == "sine") {
        v = a * fdlibm::sin((2 * kPi * f * (start + static_cast<double>(i))) / rate + static_cast<double>(c));
      } else if (kind == "noise") {
        s = s * 1664525u + 1013904223u;
        v = a * (s / 2147483648.0 - 1);
      } else if (kind == "square") {
        v = (static_cast<uint64_t>(start) + i) & 1 ? -a : a;
      }
      ch[i] = static_cast<float>(v);
    }
    if (bad && at < n) ch[at] = bad == 1 ? std::numeric_limits<float>::quiet_NaN() : std::numeric_limits<float>::infinity();
    out.push_back(std::move(ch));
  }
  return out;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: mochi2d_check_live <data dir>\n";
    return 2;
  }
  String text;
  json::Value cases;
  json::ParseError err;
  if (!conformance::read_file(fs::path(argv[1]) / "live" / "expected.json", text) || !json::parse(text, cases, err)) {
    std::cerr << "cannot read live/expected.json\n";
    return 2;
  }
  std::size_t total = 0, frames = 0, failures = 0, blocks = 0;
  for (const auto& c : cases.items()) {
    total++;
    double rate = c.get("rate")->as_number();
    fw::LiveLipSyncInput live(rate, settings_of(*c.get("settings")), c.get("window")->as_number());
    const auto& out = c.get("out")->items();
    std::size_t k = 0;
    bool ok = true;
    for (const auto& op : c.get("ops")->items()) {
      const auto& a = op.items();
      const String& kind = a[0].as_string();
      if (kind == "push") {
        blocks++;
        const auto chans = samples(a[1], rate);
        const std::size_t n = chans.empty() ? 0 : chans[0].size();
        if (a[1].get("interleaved")->as_bool()) {
          Vector<float> inter(n * chans.size());
          for (std::size_t i = 0; i < n; i++)
            for (std::size_t ch = 0; ch < chans.size(); ch++) inter[i * chans.size() + ch] = chans[ch][i];
          live.push_interleaved(inter.data(), chans.size(), n);
        } else {
          Vector<const float*> ptrs;
          for (const auto& ch : chans) ptrs.push_back(ch.data());
          live.push(ptrs.data(), ptrs.size(), n);
        }
      } else if (kind == "sums") {
        live.push_sums(number(a[1]), number(a[2]), number(a[3]));
      } else if (kind == "settings") {
        live.settings = settings_of(a[1]);
      } else if (kind == "rate") {
        rate = a[1].as_number();
        live.sample_rate = rate;
      } else if (kind == "reset") {
        live.reset();
      } else {
        frames++;
        const double value = live.next(number(a[1]));
        const auto& want = out[k++].items();
        if (!same(number(want[0]), value) || !same(number(want[1]), live.level)) {
          if (failures < 10)
            std::cerr << "FAIL case " << total << " frame " << k - 1 << ": value " << value << " level " << live.level
                      << " instead of " << number(want[0]) << " " << number(want[1]) << "\n";
          ok = false;
          break;
        }
      }
    }
    if (!ok) failures++;
  }
  std::cout << "live lip sync: " << total << " cases (" << frames << " frames, " << blocks << " blocks), " << failures
            << " failing\n";
  return failures ? 1 : 0;
}

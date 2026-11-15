// Compares Mochi2D Native's idle weights with Mochi2D 0.14.0's, bit for bit,
// on the vectors in <data>/idle/expected.json (made by idle.ts): the motion
// queue and the animation values driven frame by frame as the animator
// drives them, with motions at priorities 1, 2 and 3, idle weights set,
// changed and reset, and base values written.
//
// usage: mochi2d_check_idle <data dir>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <map>

#include "conformance/scenario.hpp"
#include "core/moc/model.hpp"
#include "framework/motion_queue.hpp"
#include "framework/values.hpp"
#include "util/json.hpp"

using namespace mochi2d;
namespace fs = std::filesystem;
namespace fw = mochi2d::framework;

namespace {

uint32_t bits(float x) {
  uint32_t u;
  std::memcpy(&u, &x, sizeof u);
  return u;
}

std::optional<double> opt(const json::Value& o, const char* key) {
  const json::Value* v = o.get(key);
  if (!v || !v->is_number()) return std::nullopt;
  return v->as_number();
}

std::optional<bool> opt_bool(const json::Value& o, const char* key) {
  const json::Value* v = o.get(key);
  if (!v || !v->is_bool()) return std::nullopt;
  return v->as_bool();
}

Vector<String> strings(const json::Value* v) {
  Vector<String> out;
  if (v)
    for (const auto& s : v->items()) out.push_back(s.as_string());
  return out;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: mochi2d_check_idle <data dir>\n";
    return 2;
  }
  const fs::path dir = argv[1];
  String text;
  json::Value cases;
  json::ParseError err;
  if (!conformance::read_file(dir / "idle" / "expected.json", text) || !json::parse(text, cases, err)) {
    std::cerr << "cannot read idle/expected.json\n";
    return 2;
  }
  std::map<String, std::shared_ptr<const moc::Model>> models;
  std::map<String, std::shared_ptr<const fw::Motion>> motions;
  std::size_t total = 0, frames = 0, failures = 0, weighted = 0;
  for (const auto& c : cases.items()) {
    total++;
    const String path = c.get("model")->as_string();
    auto& model = models[path];
    if (!model) {
      String bytes;
      conformance::read_file(dir / "models" / fs::u8path(path), bytes);
      auto m = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
      moc::Error e;
      if (!moc::load_moc(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), moc::LoadOptions(), *m, e)) {
        std::cerr << "cannot load " << path << "\n";
        return 2;
      }
      model = m;
    }
    Vector<std::shared_ptr<const fw::Motion>> files;
    for (const auto& f : c.get("motions")->items()) {
      auto& motion = motions[f.as_string()];
      if (!motion) {
        String bytes;
        conformance::read_file(dir / "models" / fs::u8path(f.as_string()), bytes);
        auto m = std::allocate_shared<fw::Motion>(Allocator<fw::Motion>());
        fw::FormatError fe;
        const String label = f.as_string().substr(f.as_string().find('/') + 1);
        if (!fw::parse_motion(bytes, label, *m, fe)) {
          std::cerr << "cannot parse " << f.as_string() << ": " << fe.message << "\n";
          return 2;
        }
        motion = m;
      }
      files.push_back(motion);
    }
    fw::AnimationValues values(*model);
    values.wrap = c.get("wrap")->as_bool();
    fw::MotionQueue q(strings(c.get("blink")), strings(c.get("lip")));
    const auto& steps = c.get("steps")->items();
    const auto& want_values = c.get("values")->items();
    const auto& want_saved = c.get("saved")->items();
    const auto& want_opacity = c.get("opacity")->items();
    for (std::size_t f = 0; f < steps.size(); f++) {
      frames++;
      const auto& step = steps[f];
      for (const auto& op : step.get("ops")->items()) {
        const auto& a = op.items();
        const String& kind = a[0].as_string();
        if (kind == "start") {
          const json::Value& o = a[2];
          fw::MotionStart start;
          start.priority = opt(o, "priority");
          start.fade_in = opt(o, "fadeIn");
          start.fade_out = opt(o, "fadeOut");
          start.weight = opt(o, "weight");
          start.offset = opt(o, "offset");
          start.loop = opt_bool(o, "loop");
          start.hold = opt_bool(o, "hold");
          q.start(files[static_cast<std::size_t>(a[1].as_number())], start);
        } else if (kind == "weight") {
          q.set_idle_weight(a[1].as_string(), a[2].as_number());
        } else if (kind == "reset") {
          q.idle_weights.clear();
        } else if (kind == "base") {
          const int i = static_cast<int>(a[1].as_number());
          values.set_at(i, a[2].as_number());
          values.saved[static_cast<std::size_t>(i)] = values.values[static_cast<std::size_t>(i)];
        } else {
          q.stop_all();
        }
      }
      if (!q.idle_weights.empty()) weighted++;
      Vector<String> events;
      values.restore();
      q.advance(step.get("dt")->as_number(), values, events);
      values.save();
      bool ok = true;
      const auto& wv = want_values[f].items();
      const auto& ws = want_saved[f].items();
      for (std::size_t k = 0; k < values.values.size(); k++) {
        ok = ok && bits(values.values[k]) == static_cast<uint32_t>(wv[k].as_number());
        ok = ok && bits(values.saved[k]) == static_cast<uint32_t>(ws[k].as_number());
      }
      const double wo = want_opacity[f].is_null() ? NAN : want_opacity[f].as_number();
      ok = ok && (wo == values.model_opacity || (std::isnan(wo) && std::isnan(values.model_opacity)));
      if (!ok) {
        if (failures < 10) std::cerr << "FAIL " << path << " case " << total << " frame " << f << "\n";
        failures++;
        break;
      }
    }
  }
  std::cout << "idle weights: " << total << " cases (" << frames << " frames, " << weighted
            << " with weights), " << failures << " failing\n";
  return failures ? 1 : 0;
}

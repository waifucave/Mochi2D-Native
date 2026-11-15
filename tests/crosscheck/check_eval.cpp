// Compares Mochi2D Native's evaluation with Mochi2D's, bit for bit, on the
// vectors in <data>/eval/expected.json (made by eval.ts): one instance per
// model, evaluated step after step while parameters and part opacities
// change (NaN, ±∞ and huge values included). Each case names Mochi2D's
// mode, incremental (its default) or full, and runs in the same mode here.
//
// usage: mochi2d_check_eval <data dir>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <limits>
#include <map>

#include "conformance/scenario.hpp"
#include "core/eval/instance.hpp"
#include "core/moc/model.hpp"
#include "util/json.hpp"

using namespace mochi2d;
namespace fs = std::filesystem;

namespace {

double number(const json::Value& v) {
  if (v.is_number()) return v.as_number();
  const String& s = v.as_string();
  if (s == "NaN") return std::numeric_limits<double>::quiet_NaN();
  return s == "Infinity" ? std::numeric_limits<double>::infinity() : -std::numeric_limits<double>::infinity();
}

/** The outputs in eval.ts's order. */
void flatten(const eval::Instance& inst, Vector<int64_t>& ints, Vector<float>& floats) {
  ints.clear();
  floats.clear();
  auto I = [&](const auto& a) {
    for (auto x : a) ints.push_back(static_cast<int64_t>(x));
  };
  auto F = [&](const Vector<float>& a) {
    for (float x : a) floats.push_back(x);
  };
  I(inst.drawable_active);
  I(inst.drawable_visible);
  I(inst.drawable_draw_order);
  I(inst.drawable_render_order);
  I(inst.offscreen_render_order);
  I(inst.part_active);
  I(inst.part_draw_order);
  I(inst.deformer_active);
  F(inst.parameter_values);
  F(inst.part_opacities);
  F(inst.drawable_opacity);
  F(inst.drawable_multiply);
  F(inst.drawable_screen);
  for (const auto& v : inst.drawable_vertices) F(v);
  F(inst.offscreen_opacity);
  F(inst.offscreen_multiply);
  F(inst.offscreen_screen);
}

bool same(const json::Value& want, float got) {
  if (want.is_null()) return std::isnan(got);
  if (std::isnan(got)) return false;
  uint32_t u;
  std::memcpy(&u, &got, sizeof u);
  return u == static_cast<uint32_t>(want.as_number());
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: mochi2d_check_eval <data dir>\n";
    return 2;
  }
  const fs::path dir = argv[1];
  String text;
  json::Value cases;
  json::ParseError err;
  if (!conformance::read_file(dir / "eval" / "expected.json", text) || !json::parse(text, cases, err)) {
    std::cerr << "cannot read eval/expected.json\n";
    return 2;
  }
  std::size_t total = 0, steps = 0, failures = 0, values = 0;
  for (const auto& c : cases.items()) {
    const String path = c.get("model")->as_string();
    String bytes;
    conformance::read_file(dir / "models" / fs::u8path(path), bytes);
    auto m = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
    moc::Error e;
    if (!moc::load_moc(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), moc::LoadOptions(), *m, e)) {
      std::cerr << "cannot load " << path << "\n";
      return 2;
    }
    const std::shared_ptr<const moc::Model> model = m;
    const auto& list = c.get("steps")->items();
    const auto& want_ints = c.get("ints")->items();
    const auto& want_floats = c.get("floats")->items();
    {
      const bool incremental = c.get("incremental")->as_bool();
      total++;
      eval::InstanceOptions options;
      options.incremental = incremental;
      eval::Instance inst(model, options);
      Vector<int64_t> ints;
      Vector<float> floats;
      for (std::size_t s = 0; s < list.size(); s++) {
        steps++;
        for (const auto& p : list[s].get("params")->items())
          inst.set_parameter(static_cast<int>(p.items()[0].as_number()), number(p.items()[1]));
        for (const auto& p : list[s].get("parts")->items())
          inst.set_part_opacity(static_cast<int>(p.items()[0].as_number()), number(p.items()[1]));
        inst.evaluate();
        flatten(inst, ints, floats);
        const auto& wi = want_ints[s].items();
        const auto& wf = want_floats[s].items();
        bool ok = wi.size() == ints.size() && wf.size() == floats.size();
        String bad;
        for (std::size_t k = 0; ok && k < ints.size(); k++)
          if (static_cast<int64_t>(wi[k].as_number()) != ints[k]) {
            ok = false;
            bad = String("integer ") + std::to_string(k).c_str() + ": " + std::to_string(ints[k]).c_str() + " instead of " +
                  std::to_string(static_cast<int64_t>(wi[k].as_number())).c_str();
          }
        for (std::size_t k = 0; ok && k < floats.size(); k++)
          if (!same(wf[k], floats[k])) {
            ok = false;
            bad = String("float ") + std::to_string(k).c_str() + ": " + std::to_string(floats[k]).c_str() + " instead of " +
                  (wf[k].is_null() ? String("NaN") : String(std::to_string(static_cast<uint32_t>(wf[k].as_number())).c_str()) + " (bits)");
          }
        values += ints.size() + floats.size();
        if (!ok) {
          if (failures < 10)
            std::cerr << "FAIL " << path << (incremental ? " (incremental)" : " (full)") << " step " << s
                      << ", " << bad << "\n";
          failures++;
          break;
        }
      }
    }
  }
  std::cout << "evaluation: " << total << " runs (" << steps << " steps, " << values << " values, in Mochi2D's mode of each), "
            << failures << " failing\n";
  return failures ? 1 : 0;
}

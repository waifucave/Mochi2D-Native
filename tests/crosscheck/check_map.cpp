// Compares Mochi2D Native's forward mapping (map_points, map_jacobians) with
// the reference's mapPoints and mapJacobians, bit for bit, on the vectors in
// <data>/map/expected.json (made by generate.ts).
//
// usage: mochi2d_check_map <data dir>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <map>

#include "core/eval/instance.hpp"
#include "core/moc/model.hpp"
#include "conformance/scenario.hpp"
#include "util/json.hpp"

using namespace mochi2d;
namespace fs = std::filesystem;

namespace {

bool same(double want, double got) {
  if (std::isnan(want) || std::isnan(got)) return std::isnan(want) && std::isnan(got);
  return std::memcmp(&want, &got, sizeof want) == 0 || (want == 0 && got == 0);
}

double num(const json::Value& v) { return v.is_null() ? NAN : v.as_number(); }

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: mochi2d_check_map <data dir>\n";
    return 2;
  }
  const fs::path dir = argv[1];
  String text;
  json::Value cases;
  json::ParseError err;
  if (!conformance::read_file(dir / "map" / "expected.json", text) || !json::parse(text, cases, err)) {
    std::cerr << "cannot read map/expected.json\n";
    return 2;
  }
  std::map<String, std::shared_ptr<const moc::Model>> models;
  std::size_t total = 0, failures = 0;
  for (const auto& c : cases.items()) {
    total++;
    const String path = c.get("model")->as_string();
    auto& model = models[path];
    if (!model) {
      String bytes;
      conformance::read_file(dir / "models" / fs::u8path(path), bytes);
      auto m = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
      moc::Error e;
      moc::load_moc(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), moc::LoadOptions(), *m, e);
      model = m;
    }
    eval::Instance inst(model);
    for (const auto& p : c.get("params")->items())
      inst.set_parameter(static_cast<int>(p.items()[0].as_number()), p.items()[1].as_number());
    inst.evaluate();
    const int d = static_cast<int>(c.get("deformer")->as_number());
    const auto space = c.get("space")->as_string() == "model" ? eval::Instance::MapSpace::Model : eval::Instance::MapSpace::Keyform;
    Vector<float> points;
    for (const auto& x : c.get("points")->items()) points.push_back(static_cast<float>(x.as_number()));
    const std::size_t n = points.size() / 2;
    Vector<float> out(2 * n);
    Vector<double> jac(4 * n);
    inst.map_points(d, points.data(), n, out.data(), space);
    inst.map_jacobians(d, points.data(), n, jac.data(), space);
    bool ok = true;
    const auto& wo = c.get("out")->items();
    const auto& wj = c.get("jacobians")->items();
    for (std::size_t k = 0; k < 2 * n; k++) ok = ok && same(static_cast<double>(static_cast<float>(num(wo[k]))), out[k]);
    for (std::size_t k = 0; k < 4 * n; k++) ok = ok && same(num(wj[k]), jac[k]);
    if (!ok) {
      if (failures < 10) {
        std::cerr << "FAIL " << path << " deformer " << d << "\n";
        for (std::size_t k = 0; k < 2 * n; k++)
          if (!same(static_cast<double>(static_cast<float>(num(wo[k]))), out[k]))
            std::cerr << "  point float " << k << ": want " << num(wo[k]) << " got " << out[k] << "\n";
        for (std::size_t k = 0; k < 4 * n; k++)
          if (!same(num(wj[k]), jac[k])) std::cerr << "  jacobian " << k << ": want " << num(wj[k]) << " got " << jac[k] << "\n";
      }
      failures++;
    }
  }
  std::cout << total << " forward-mapping cases, " << failures << " failing\n";
  return failures ? 1 : 0;
}

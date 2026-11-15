// Fuzz target: the `.moc3` reader, validator, writer, loader and evaluator
// on arbitrary bytes. Every path must reject bad input with an error, never
// crash, read out of bounds or hang.
#include <cstddef>
#include <cstdint>
#include <memory>

#include "core/eval/instance.hpp"
#include "core/moc/io.hpp"
#include "core/moc/model.hpp"

using namespace mochi2d;

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  moc::validate_moc(data, size, moc::Level::Official);
  moc::validate_moc(data, size, moc::Level::Strict);
  moc::ReadResult r;
  moc::Error err;
  if (moc::read_moc(data, size, r, err) && r.version <= 5) {
    Vector<uint8_t> bytes;
    Vector<moc::Diagnostic> diags;
    if (moc::write_moc(r.data, r.version, bytes, diags)) {
      moc::ReadResult again;
      moc::read_moc(bytes.data(), bytes.size(), again, err);
    }
  }
  moc::LoadOptions opts;
  opts.load_non_finite_opacity = size > 0 && (data[size - 1] & 1);
  auto model = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
  if (!moc::load_moc(data, size, opts, *model, err)) return 0;
  // A loaded model must evaluate: defaults, then values from the last bytes.
  eval::Instance inst(model);
  const std::size_t P = model->parameters.ids.size();
  for (std::size_t i = 0; i < P; i++) {
    const uint8_t b = data[(size - 1 - i % size)];
    inst.set_parameter(static_cast<int>(i), (static_cast<double>(b) - 128.0) / 16.0);
  }
  for (std::size_t i = 0; i < model->parts.ids.size(); i++) inst.set_part_opacity(static_cast<int>(i), (i % 3) / 2.0);
  inst.evaluate();
  float pts[8] = {-3, 0.5f, 0.25f, 0.75f, 1.5f, -0.5f, 9, 9};
  float out[8];
  double jac[16];
  for (int d = -1; d < inst.deformer_count(); d++) {
    inst.map_points(d, pts, 4, out);
    inst.map_jacobians(d, pts, 4, jac);
  }
  return 0;
}

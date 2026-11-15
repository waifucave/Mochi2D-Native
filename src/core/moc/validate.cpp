// Port of Mochi2D's src/core/moc/validate.ts.
#include "core/moc/io.hpp"
#include "core/moc/model.hpp"

namespace mochi2d::moc {

namespace {

Validation finish(const MocData& data, int version, Level level, Report& report, const uint8_t* bytes,
                  std::size_t size) {
  check_structure(data, version, report);
  if (level == Level::Strict && report.errors() == 0) {
    Model model;
    Error err;
    bool loads;
    if (bytes) {
      loads = load_moc(bytes, size, LoadOptions(), model, err);
    } else {
      Sections sections;
      Vector<Diagnostic> ignored;
      loads = sections_from_data(data, version, sections, ignored) && build_model(sections, LoadOptions(), model, err);
    }
    if (!loads) report.error(Level::Strict, "load-error", "file", String("Mochi2D's loader rejects it: ") + err.message);
  }
  Validation v;
  v.valid = report.errors() == 0;
  v.version = version;
  v.diagnostics = std::move(report.list);
  return v;
}

}  // namespace

Validation validate_moc(const uint8_t* bytes, std::size_t size, Level level) {
  Report report(level == Level::Strict);
  ReadResult r;
  Error e;
  if (!read_moc(bytes, size, r, e)) {
    report.error(Level::Official, e.code, "file", e.message);
    Validation v;
    v.valid = false;
    v.version = size > 4 && bytes[4] >= 1 && bytes[4] <= 6 ? bytes[4] : 0;
    v.diagnostics = std::move(report.list);
    return v;
  }
  for (const auto& d : r.diagnostics) {
    if (d.code == "big-endian")
      report.error(Level::Official, "big-endian", "file",
                   "big-endian file: the official consistency check rejects it (Mochi2D and the official loader read it)");
    else
      report.error(Level::Official, d.code, d.kind, d.message, d.index, d.field);
  }
  return finish(r.data, r.version, level, report, bytes, size);
}

Validation validate_moc(const MocData& data, int version, Level level) {
  Report report(level == Level::Strict);
  auto shape = check_shape(data, version, nullptr);
  if (!shape.empty()) {
    Validation v;
    v.valid = false;
    v.version = version >= 1 && version <= 6 ? version : 0;
    v.diagnostics = std::move(shape);
    return v;
  }
  return finish(data, version, level, report, nullptr, 0);
}

}  // namespace mochi2d::moc

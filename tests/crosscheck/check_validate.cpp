// Compares Mochi2D Native's validation, loading and writing with the
// reference's verdicts in <dir>/expected.json (made by generate.ts): both
// levels' validity, version and every diagnostic (code, severity, kind,
// index, field and message), the loader's verdict, and write_moc's bytes.
//
// usage: mochi2d_check_validate <validate dir>
#include <cstdio>
#include <filesystem>
#include <iostream>

#include "core/moc/io.hpp"
#include "core/moc/model.hpp"
#include "conformance/scenario.hpp"
#include "util/json.hpp"

using namespace mochi2d;
using json::Value;
namespace fs = std::filesystem;

namespace {

Value to_json(const moc::Validation& v) {
  Value r = Value::object();
  r.set("valid", v.valid);
  r.set("version", v.version ? Value(v.version) : Value(nullptr));
  Value list = Value::array();
  for (const auto& d : v.diagnostics) {
    Value x = Value::object();
    x.set("code", d.code);
    x.set("severity", d.warning ? "warning" : "error");
    x.set("kind", d.kind);
    if (d.index) x.set("index", *d.index);
    if (d.field) x.set("field", *d.field);
    x.set("message", d.message);
    list.push(std::move(x));
  }
  r.set("diagnostics", std::move(list));
  return r;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: mochi2d_check_validate <validate dir>\n";
    return 2;
  }
  const fs::path dir = argv[1];
  String text;
  if (!conformance::read_file(dir / "expected.json", text)) {
    std::cerr << "cannot read expected.json\n";
    return 2;
  }
  Value expected;
  json::ParseError err;
  if (!json::parse(text, expected, err)) {
    std::cerr << "bad expected.json: " << err.message << "\n";
    return 2;
  }
  std::size_t cases = 0, failures = 0, messages = 0;
  for (const auto& c : expected.items()) {
    cases++;
    const String file = c.get("file")->as_string();
    String bytes;
    conformance::read_file(dir / file, bytes);
    const auto* b = reinterpret_cast<const uint8_t*>(bytes.data());
    bool ok = true;
    auto report = [&](const String& what, const String& want, const String& got) {
      if (failures < 25) std::cerr << "FAIL " << file << " " << what << "\n  want " << want << "\n  got  " << got << "\n";
      ok = false;
    };
    for (const char* level : {"official", "strict"}) {
      const auto v = moc::validate_moc(b, bytes.size(), String(level) == "official" ? moc::Level::Official : moc::Level::Strict);
      const String want = json::write_compact(*c.get(level));
      const String got = json::write_compact(to_json(v));
      if (want != got) {
        // Separate message-only differences from verdict differences.
        Value a = *c.get(level), g = to_json(v);
        for (auto* x : {&a, &g})
          for (auto& d : x->members()[2].second.items()) d.set("message", "");
        if (json::write_compact(a) == json::write_compact(g)) {
          messages++;
          if (messages <= 10) report(String(level) + " (messages only)", want, got);
          else ok = false;
        } else {
          report(level, want, got);
        }
      }
    }
    const Value* loader = c.get("loader");
    String load_error;
    {
      moc::Model m;
      moc::Error e;
      if (!moc::load_moc(b, bytes.size(), moc::LoadOptions(), m, e)) load_error = e.message;
    }
    const bool want_load = loader->is_null();
    if (want_load != load_error.empty())
      report("loader", want_load ? "loads" : loader->as_string(), load_error.empty() ? "loads" : load_error);
    const Value* write = c.get("write");
    moc::ReadResult r;
    moc::Error rerr;
    Vector<uint8_t> out;
    Vector<moc::Diagnostic> wdiags;
    if (moc::read_moc(b, bytes.size(), r, rerr) && r.version != 6 && moc::write_moc(r.data, r.version, out, wdiags)) {
      if (write->is_null()) {
        report("write", "refused", "written");
      } else {
        String want_bytes;
        conformance::read_file(dir / write->as_string(), want_bytes);
        if (want_bytes != String(reinterpret_cast<const char*>(out.data()), out.size()))
          report("write", "bytes of " + write->as_string(), to_str(out.size()) + " different bytes");
      }
    } else if (!write->is_null()) {
      report("write", "written", "refused");
    }
    if (!ok) failures++;
  }
  std::cout << cases << " validation cases, " << failures << " failing (" << messages << " with message differences only)\n";
  return failures ? 1 : 0;
}

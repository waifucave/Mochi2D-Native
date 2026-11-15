// Fuzz target: the JSON parser, the writers, and the settings and scenario
// parsers on arbitrary text.
#include <cstddef>
#include <cstdint>
#include <cstdlib>

#include "conformance/scenario.hpp"
#include "framework/settings.hpp"
#include "util/json.hpp"
#include "util/text.hpp"

using namespace mochi2d;

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  const std::string_view text(reinterpret_cast<const char*>(data), size);
  json::Value v;
  json::ParseError err;
  String message;
  if (json::parse(text, v, err)) {
    // What the writers write parses back to the same text.
    const String compact = json::write_compact(v);
    json::Value again;
    if (!json::parse(compact, again, err) || json::write_compact(again) != compact) std::abort();
    json::write_result(v);
    json::write_pretty(v);
    if (v.is_object()) v.entries_js_order();
    conformance::Scenario sc;
    conformance::parse_scenario(v, sc, message);
    (void)conformance::known_format(v.is_object() ? v.get("format") : nullptr);
  }
  framework::ModelSettings settings;
  framework::parse_model_settings(text, "fuzz", settings, message);
  String path;
  framework::normalize_path(text, path);
  (void)text::sanitize_utf8(text);
  return 0;
}

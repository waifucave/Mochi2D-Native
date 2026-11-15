// Compares the JSON parser's error messages with V8's (tests/crosscheck/json.mjs).
#include <cstdio>
#include <string>

#include "conformance/scenario.hpp"
#include "util/json.hpp"
#include "util/text.hpp"

using namespace mochi2d;

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: mochi2d_check_json <cases.json>\n");
    return 2;
  }
  String text;
  if (!conformance::read_file(std::filesystem::u8path(argv[1]), text)) return 2;
  json::Value cases;
  json::ParseError err;
  if (!json::parse(text, cases, err)) {
    std::fprintf(stderr, "cannot read %s: %s\n", argv[1], err.message.c_str());
    return 2;
  }
  std::size_t failed = 0;
  for (const auto& c : cases.items()) {
    const String& in = c.get("in")->as_string();
    const json::Value* msg = c.get("msg");
    json::Value v;
    json::ParseError e;
    const bool ok = json::parse(in, v, e);
    const bool want_ok = msg->is_null();
    if (ok == want_ok && (ok || e.message == msg->as_string())) continue;
    if (++failed <= 10)
      std::printf("DIFFERS %s\n  native:    %s\n  reference: %s\n", text::json_quote(in).c_str(),
                  ok ? "ok" : text::json_quote(e.message).c_str(), want_ok ? "ok" : text::json_quote(msg->as_string()).c_str());
  }
  std::printf("json: %zu cases, %zu different from V8's JSON.parse\n", cases.items().size(), failed);
  return failed ? 1 : 0;
}

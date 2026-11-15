#include "framework/jsutil.hpp"

#include "util/text.hpp"

namespace mochi2d::framework {

bool is_object_prototype_key(std::string_view key) {
  // Object.getOwnPropertyNames(Object.prototype) in Node 22.
  static constexpr std::string_view kKeys[] = {
      "constructor",    "__defineGetter__", "__defineSetter__",     "hasOwnProperty",
      "__lookupGetter__", "__lookupSetter__", "isPrototypeOf",      "propertyIsEnumerable",
      "toString",       "valueOf",          "__proto__",            "toLocaleString",
  };
  for (const auto k : kKeys)
    if (k == key) return true;
  return false;
}

namespace {

void to_string_rec(const json::Value* v, String& out) {
  if (!v) {
    out += "undefined";
    return;
  }
  switch (v->type()) {
    case json::Value::Type::Null: out += "null"; return;
    case json::Value::Type::Bool: out += v->as_bool() ? "true" : "false"; return;
    case json::Value::Type::Number: out += text::js_number(v->as_number()); return;
    case json::Value::Type::String: out += v->as_string(); return;
    case json::Value::Type::Object: out += "[object Object]"; return;
    case json::Value::Type::Array: {
      // Array.prototype.join(","): null and undefined elements print nothing.
      const auto& items = v->items();
      for (std::size_t i = 0; i < items.size(); i++) {
        if (i) out += ",";
        if (!items[i].is_null()) to_string_rec(&items[i], out);
      }
      return;
    }
  }
}

}  // namespace

String js_to_string(const json::Value* v) {
  String out;
  to_string_rec(v, out);
  return out;
}

const Vector<json::Value>& arr(const json::Value* v) {
  static const Vector<json::Value> kNone;
  return v && v->is_array() ? v->items() : kNone;
}

bool parse_json(std::string_view bytes, std::string_view label, json::Value& out, FormatError& error) {
  String text = text::sanitize_utf8(bytes);
  std::string_view body = text;
  if (body.size() >= 3 && body.substr(0, 3) == "\xEF\xBB\xBF") body.remove_prefix(3);
  json::ParseError err;
  if (json::parse(body, out, err)) return true;
  error.message = String(label.data(), label.size()) + ": invalid JSON (" + err.message + ")";
  return false;
}

}  // namespace mochi2d::framework

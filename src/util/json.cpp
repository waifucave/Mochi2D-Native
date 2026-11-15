#include "util/json.hpp"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "util/text.hpp"

namespace mochi2d::json {

Value& Value::set(String key, Value v) {
  for (auto& m : obj_)
    if (m.first == key) {
      m.second = std::move(v);
      return m.second;
    }
  obj_.emplace_back(std::move(key), std::move(v));
  return obj_.back().second;
}

const Value* Value::get(std::string_view key) const {
  for (const auto& m : obj_)
    if (m.first == key) return &m.second;
  return nullptr;
}

namespace {

/** A canonical array index: "0" or digits without a leading zero, below 2^32 − 1. */
bool array_index(const String& k, uint64_t& out) {
  if (k.empty() || k.size() > 10) return false;
  if (k.size() > 1 && k[0] == '0') return false;
  uint64_t v = 0;
  for (char c : k) {
    if (c < '0' || c > '9') return false;
    v = v * 10 + static_cast<uint64_t>(c - '0');
  }
  if (v >= 4294967295ull) return false;
  out = v;
  return true;
}

}  // namespace

Vector<const Value::Member*> Value::entries_js_order() const {
  Vector<std::pair<uint64_t, const Member*>> idx;
  Vector<const Member*> rest;
  for (const auto& m : obj_) {
    uint64_t i;
    if (array_index(m.first, i))
      idx.emplace_back(i, &m);
    else
      rest.push_back(&m);
  }
  stable_sort(idx, [](const auto& a, const auto& b) { return a.first < b.first; });
  Vector<const Member*> out;
  for (const auto& p : idx) out.push_back(p.second);
  out.insert(out.end(), rest.begin(), rest.end());
  return out;
}

// ------------------------------------------------------------------ parser
//
// JSON.parse as V8 (Node 22) implements it, on the UTF-16 code units of the
// text, so that every error message is V8's, with positions in UTF-16 units
// and line and column numbers. Strings are kept as WTF-8: a lone surrogate
// (from an escape) stays a surrogate, as in JavaScript, and the writers
// print it as an escape, as JSON.stringify does.

namespace {

using U16 = Vector<char16_t>;

enum class Tok : uint8_t { Eos, Number, String, LBrace, RBrace, LBrack, RBrack, True, False, Null, Colon, Comma, Whitespace, Illegal };

Tok one_char(int32_t c) {
  if (c < 0) return Tok::Eos;
  switch (c) {
    case '"': return Tok::String;
    case '-': case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
      return Tok::Number;
    case '{': return Tok::LBrace;
    case '}': return Tok::RBrace;
    case '[': return Tok::LBrack;
    case ']': return Tok::RBrack;
    case 't': return Tok::True;
    case 'f': return Tok::False;
    case 'n': return Tok::Null;
    case ':': return Tok::Colon;
    case ',': return Tok::Comma;
    case ' ': case '\t': case '\n': case '\r': return Tok::Whitespace;
    default: return Tok::Illegal;
  }
}

/** The UTF-16 code units of UTF-8 text (invalid sequences as U+FFFD, as Mochi2D's decoder). */
U16 utf16_units(std::string_view utf8) {
  const String clean = text::sanitize_utf8(utf8);
  U16 out;
  out.reserve(clean.size());
  const auto* b = reinterpret_cast<const unsigned char*>(clean.data());
  for (std::size_t i = 0; i < clean.size();) {
    uint32_t cp;
    if (b[i] < 0x80) {
      cp = b[i];
      i += 1;
    } else if (b[i] < 0xe0) {
      cp = (b[i] & 0x1fu) << 6 | (b[i + 1] & 0x3fu);
      i += 2;
    } else if (b[i] < 0xf0) {
      cp = (b[i] & 0x0fu) << 12 | (b[i + 1] & 0x3fu) << 6 | (b[i + 2] & 0x3fu);
      i += 3;
    } else {
      cp = (b[i] & 0x07u) << 18 | (b[i + 1] & 0x3fu) << 12 | (b[i + 2] & 0x3fu) << 6 | (b[i + 3] & 0x3fu);
      i += 4;
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out.push_back(static_cast<char16_t>(0xd800 + (cp >> 10)));
      out.push_back(static_cast<char16_t>(0xdc00 + (cp & 0x3ff)));
    } else {
      out.push_back(static_cast<char16_t>(cp));
    }
  }
  return out;
}

void put_cp(String& out, uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xc0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 63)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xe0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 63)));
    out.push_back(static_cast<char>(0x80 | (cp & 63)));
  } else {
    out.push_back(static_cast<char>(0xf0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 63)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 63)));
    out.push_back(static_cast<char>(0x80 | (cp & 63)));
  }
}

/** UTF-16 units as WTF-8: pairs as one code point, lone surrogates as themselves. */
String wtf8(const char16_t* u, std::size_t n) {
  String out;
  out.reserve(n);
  for (std::size_t i = 0; i < n; i++) {
    const uint32_t c = u[i];
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < n && u[i + 1] >= 0xdc00 && u[i + 1] <= 0xdfff) {
      put_cp(out, 0x10000 + ((c - 0xd800) << 10) + (u[i + 1] - 0xdc00u));
      i++;
    } else {
      put_cp(out, c);
    }
  }
  return out;
}

int hex_value(int32_t c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool is_digit(int32_t c) { return c >= '0' && c <= '9'; }

bool is_number_part(int32_t c) { return is_digit(c) || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-'; }

struct Parser {
  const U16& s;
  std::size_t i = 0;
  Tok next = Tok::Eos;
  String err;
  int depth = 0;

  explicit Parser(const U16& text) : s(text) {}

  int32_t cur() const { return i < s.size() ? s[i] : -1; }
  int32_t next_char() {
    i++;
    return cur();
  }

  void skip_ws() {
    next = Tok::Eos;
    while (i < s.size()) {
      const Tok t = one_char(s[i] <= 0xff ? s[i] : 0x100);
      if (t != Tok::Whitespace) {
        next = t;
        return;
      }
      i++;
    }
  }
  bool check(Tok t) {
    skip_ws();
    if (next != t) return false;
    i++;
    return true;
  }

  // ---- errors: V8's ReportUnexpectedToken

  /** "(line L column C)" of the current position: \r, \n and \r\n are line breaks. */
  String location() const {
    long line = 1;
    std::size_t last = 0;
    std::size_t k = 0;
    for (; k < i && k < s.size(); k++) {
      if (s[k] == '\r' && k + 1 < i && s[k + 1] == '\n') k++;
      if (s[k] == '\r' || s[k] == '\n') {
        line++;
        last = k + 1;
      }
    }
    return "(line " + to_str(line) + " column " + to_str(static_cast<long long>(k - last) + 1) + ")";
  }
  bool at_position(const char* what) {
    if (err.empty()) err = String(what) + " at position " + to_str(i) + " " + location();
    return false;
  }
  bool is_special_string() const {
    for (const char* special : {"[object Object]", "undefined", "Infinity", "NaN"}) {
      const std::size_t n = std::strlen(special);
      if (s.size() != n) continue;
      bool same = true;
      for (std::size_t k = 0; k < n && same; k++) same = s[k] == static_cast<char16_t>(special[k]);
      if (same) return true;
    }
    return false;
  }
  bool unexpected(Tok token) {
    if (!err.empty()) return false;
    switch (token) {
      case Tok::Eos:
        err = "Unexpected end of JSON input";
        return false;
      case Tok::Number:
        return at_position("Unexpected number in JSON");
      case Tok::String:
        return at_position("Unexpected string in JSON");
      default:
        break;
    }
    if (is_special_string()) {
      err = "\"" + wtf8(s.data(), s.size()) + "\" is not valid JSON";
      return false;
    }
    const String token_char = i < s.size() ? wtf8(&s[i], 1) : String();
    constexpr std::size_t kContext = 10;
    const std::size_t length = s.size();
    if (length <= 2 * kContext) {
      err = "Unexpected token '" + token_char + "', \"" + wtf8(s.data(), length) + "\" is not valid JSON";
      return false;
    }
    std::size_t start = 0, end = length;
    const char* before = "\"";
    const char* after = "\"";
    if (i < kContext) {
      end = i + kContext;
      after = "\"...";
    } else if (i < length - kContext) {
      start = i - kContext;
      end = i + kContext;
      before = "...\"";
      after = "\"...";
    } else {
      start = i - kContext;
      before = "...\"";
    }
    err = "Unexpected token '" + token_char + "', " + before + wtf8(s.data() + start, end - start) + after +
          " is not valid JSON";
    return false;
  }
  bool unexpected_char(int32_t c) { return unexpected(c < 0 ? Tok::Eos : c <= 0xff ? one_char(c) : Tok::Illegal); }
  bool expect(Tok t, const char* message) {
    if (next == t) {
      i++;
      return true;
    }
    return message ? at_position(message) : unexpected(next);
  }
  bool expect_next(Tok t, const char* message) {
    skip_ws();
    return expect(t, message);
  }

  // ---- values

  /** After the opening quote. */
  bool string(String& out) {
    U16 units;
    while (true) {
      while (i < s.size() && s[i] != '"' && s[i] != '\\' && s[i] >= 0x20) units.push_back(s[i++]);
      if (i >= s.size()) return at_position("Unterminated string in JSON");
      if (s[i] == '"') {
        i++;
        out = wtf8(units.data(), units.size());
        return true;
      }
      if (s[i] == '\\') {
        const int32_t c = next_char();
        if (c < 0 || c > 0xff) return unexpected_char(c);
        switch (c) {
          case '"': case '\\': case '/': units.push_back(static_cast<char16_t>(c)); break;
          case 'b': units.push_back(u'\b'); break;
          case 'f': units.push_back(u'\f'); break;
          case 'n': units.push_back(u'\n'); break;
          case 'r': units.push_back(u'\r'); break;
          case 't': units.push_back(u'\t'); break;
          case 'u': {
            uint32_t v = 0;
            for (int k = 0; k < 4; k++) {
              const int d = hex_value(next_char());
              if (d < 0) return at_position("Bad Unicode escape in JSON");
              v = v * 16 + static_cast<uint32_t>(d);
            }
            units.push_back(static_cast<char16_t>(v));
            break;
          }
          default:
            return at_position("Bad escaped character in JSON");
        }
        i++;
        continue;
      }
      return at_position("Bad control character in string literal in JSON");
    }
  }

  bool number(Value& out) {
    const std::size_t start = i;
    int32_t c = cur();
    bool negative = false;
    if (c == '-') {
      negative = true;
      c = next_char();
    }
    if (c == '0') {
      c = next_char();
      if (c >= 0 && c <= 0xff && is_number_part(c)) {
        if (is_digit(c)) return unexpected(Tok::Number);
      } else if (!negative) {
        out = Value(0.0);
        return true;
      }
    } else {
      const std::size_t digits = i;
      while (is_digit(cur())) i++;
      if (i == digits) return at_position("No number after minus sign in JSON");
    }
    if (cur() == '.') {
      if (!is_digit(next_char())) return at_position("Unterminated fractional number in JSON");
      while (is_digit(cur())) i++;
    }
    if (cur() == 'e' || cur() == 'E') {
      c = next_char();
      if (c == '-' || c == '+') c = next_char();
      if (!is_digit(c)) return at_position("Exponent part is missing a number in JSON");
      while (is_digit(cur())) i++;
    }
    char buf[64];
    String big;
    const std::size_t n = i - start;
    const char* text = buf;
    if (n < sizeof buf) {
      for (std::size_t k = 0; k < n; k++) buf[k] = static_cast<char>(s[start + k]);
    } else {
      for (std::size_t k = 0; k < n; k++) big.push_back(static_cast<char>(s[start + k]));
      text = big.data();
    }
    double d = 0;
    text::parse_double(text, text + n, d);
    out = Value(d);
    return true;
  }

  bool literal(const char* word) {
    const std::size_t n = std::strlen(word);
    const std::size_t remaining = s.size() - i;
    bool same = remaining >= n;
    for (std::size_t k = 1; same && k < n; k++) same = s[i + k] == static_cast<char16_t>(word[k]);
    if (same) {
      i += n;
      return true;
    }
    i++;
    for (std::size_t k = 0; k < std::min(n - 1, remaining - 1); k++) {
      if (s[i] != static_cast<char16_t>(word[1 + k])) return unexpected_char(s[i]);
      i++;
    }
    return unexpected(Tok::Eos);
  }

  bool value(Value& out) {
    if (++depth > 1000) {
      // Deeper nesting than any model file needs (V8 has no such limit).
      depth--;
      if (err.empty()) err = "JSON nested too deeply";
      return false;
    }
    bool ok = value_at(out);
    depth--;
    return ok;
  }

  bool value_at(Value& out) {
    skip_ws();
    switch (next) {
      case Tok::String: {
        i++;
        String str;
        if (!string(str)) return false;
        out = Value(std::move(str));
        return true;
      }
      case Tok::Number:
        return number(out);
      case Tok::LBrace: {
        i++;
        out = Value::object();
        if (check(Tok::RBrace)) return true;
        if (!expect_next(Tok::String, "Expected property name or '}' in JSON")) return false;
        while (true) {
          String key;
          if (!string(key)) return false;
          if (!expect_next(Tok::Colon, "Expected ':' after property name in JSON")) return false;
          Value v;
          if (!value(v)) return false;
          out.set(std::move(key), std::move(v));
          if (check(Tok::Comma)) {
            if (!expect_next(Tok::String, "Expected double-quoted property name in JSON")) return false;
            continue;
          }
          return expect(Tok::RBrace, "Expected ',' or '}' after property value in JSON");
        }
      }
      case Tok::LBrack: {
        i++;
        out = Value::array();
        if (check(Tok::RBrack)) return true;
        while (true) {
          Value v;
          if (!value(v)) return false;
          out.push(std::move(v));
          if (check(Tok::Comma)) continue;
          return expect(Tok::RBrack, "Expected ',' or ']' after array element in JSON");
        }
      }
      case Tok::True:
        if (!literal("true")) return false;
        out = Value(true);
        return true;
      case Tok::False:
        if (!literal("false")) return false;
        out = Value(false);
        return true;
      case Tok::Null:
        if (!literal("null")) return false;
        out = Value(nullptr);
        return true;
      default:
        return unexpected_char(cur());
    }
  }
};

}  // namespace

bool parse(std::string_view text, Value& out, ParseError& error) {
  const U16 units = utf16_units(text);
  Parser p(units);
  Value v;
  if (!p.value(v) || (!p.check(Tok::Eos) && !p.at_position("Unexpected non-whitespace character after JSON"))) {
    error.message = p.err;
    return false;
  }
  out = std::move(v);
  return true;
}

// ------------------------------------------------------------------ writers

namespace {

String number_text(double x, Numbers numbers) {
  if (!std::isfinite(x)) return "null";
  double v = numbers == Numbers::Float32 ? static_cast<double>(static_cast<float>(x)) : x;
  if (!std::isfinite(v)) return "null";
  if (v == 0) return "0";
  return text::js_number(v);
}

bool plain(const Value& v) { return !v.is_array() && !v.is_object(); }

void write_rec(const Value& v, int depth, Numbers numbers, String& out) {
  switch (v.type()) {
    case Value::Type::Null: out += "null"; return;
    case Value::Type::Bool: out += v.as_bool() ? "true" : "false"; return;
    case Value::Type::Number: out += number_text(v.as_number(), numbers); return;
    case Value::Type::String: out += text::json_quote(v.as_string()); return;
    default: break;
  }
  const String pad(static_cast<std::size_t>(2 * (depth + 1)), ' ');
  const String end(static_cast<std::size_t>(2 * depth), ' ');
  if (v.is_array()) {
    const auto& a = v.items();
    if (a.empty()) {
      out += "[]";
      return;
    }
    if (std::all_of(a.begin(), a.end(), plain)) {
      out.push_back('[');
      for (std::size_t k = 0; k < a.size(); k++) {
        if (k) out += ", ";
        write_rec(a[k], depth + 1, numbers, out);
      }
      out.push_back(']');
      return;
    }
    out += "[\n";
    for (std::size_t k = 0; k < a.size(); k++) {
      if (k) out += ",\n";
      out += pad;
      write_rec(a[k], depth + 1, numbers, out);
    }
    out += "\n" + end + "]";
    return;
  }
  const auto& m = v.members();
  if (m.empty()) {
    out += "{}";
    return;
  }
  out += "{\n";
  for (std::size_t k = 0; k < m.size(); k++) {
    if (k) out += ",\n";
    out += pad + text::json_quote(m[k].first) + ": ";
    write_rec(m[k].second, depth + 1, numbers, out);
  }
  out += "\n" + end + "}";
}

String stringify_number(double x) {
  if (!std::isfinite(x)) return "null";
  return x == 0 ? "0" : text::js_number(x);
}

void compact_rec(const Value& v, String& out) {
  switch (v.type()) {
    case Value::Type::Null: out += "null"; return;
    case Value::Type::Bool: out += v.as_bool() ? "true" : "false"; return;
    case Value::Type::Number: out += stringify_number(v.as_number()); return;
    case Value::Type::String: out += text::json_quote(v.as_string()); return;
    case Value::Type::Array:
      out.push_back('[');
      for (std::size_t k = 0; k < v.items().size(); k++) {
        if (k) out.push_back(',');
        compact_rec(v.items()[k], out);
      }
      out.push_back(']');
      return;
    case Value::Type::Object:
      out.push_back('{');
      for (std::size_t k = 0; k < v.members().size(); k++) {
        if (k) out.push_back(',');
        out += text::json_quote(v.members()[k].first) + ":";
        compact_rec(v.members()[k].second, out);
      }
      out.push_back('}');
      return;
  }
}

void pretty_rec(const Value& v, int depth, String& out) {
  const String pad(static_cast<std::size_t>(2 * (depth + 1)), ' ');
  const String end(static_cast<std::size_t>(2 * depth), ' ');
  if (v.is_array()) {
    if (v.items().empty()) {
      out += "[]";
      return;
    }
    out += "[\n";
    for (std::size_t k = 0; k < v.items().size(); k++) {
      if (k) out += ",\n";
      out += pad;
      pretty_rec(v.items()[k], depth + 1, out);
    }
    out += "\n" + end + "]";
  } else if (v.is_object()) {
    if (v.members().empty()) {
      out += "{}";
      return;
    }
    out += "{\n";
    for (std::size_t k = 0; k < v.members().size(); k++) {
      if (k) out += ",\n";
      out += pad + text::json_quote(v.members()[k].first) + ": ";
      pretty_rec(v.members()[k].second, depth + 1, out);
    }
    out += "\n" + end + "}";
  } else {
    compact_rec(v, out);
  }
}

}  // namespace

String write_result(const Value& v, Numbers numbers) {
  String out;
  write_rec(v, 0, numbers, out);
  out.push_back('\n');
  return out;
}

String write_compact(const Value& v) {
  String out;
  compact_rec(v, out);
  return out;
}

String write_pretty(const Value& v) {
  String out;
  pretty_rec(v, 0, out);
  return out;
}

}  // namespace mochi2d::json

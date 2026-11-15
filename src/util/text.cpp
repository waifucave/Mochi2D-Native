#include "util/text.hpp"

#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <clocale>
#include <cstdlib>
#include <string>
#include <system_error>
#include <version>

namespace mochi2d::text {

namespace {

void append_utf8(String& out, uint32_t cp) {
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

}  // namespace

String sanitize_utf8(std::string_view bytes) {
  String out;
  out.reserve(bytes.size());
  const auto* b = reinterpret_cast<const unsigned char*>(bytes.data());
  const std::size_t n = bytes.size();
  for (std::size_t i = 0; i < n;) {
    const unsigned b0 = b[i];
    uint32_t cp = 0xfffd;
    std::size_t len = 1;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xc2 && b0 < 0xe0) {
      len = 2;
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      len = 3;
    } else if (b0 >= 0xf0 && b0 < 0xf5) {
      len = 4;
    }
    if (len > 1) {
      bool ok = i + len <= n;
      uint32_t v = b0 & (0xffu >> (len + 1));
      for (std::size_t k = 1; ok && k < len; k++) {
        const unsigned c = b[i + k];
        if ((c & 0xc0) != 0x80)
          ok = false;
        else
          v = (v << 6) | (c & 0x3f);
      }
      const uint32_t min = len == 2 ? 0x80 : len == 3 ? 0x800 : 0x10000;
      if (ok && v >= min && v <= 0x10ffff && !(v >= 0xd800 && v <= 0xdfff)) {
        cp = v;
      } else {
        cp = 0xfffd;
        len = 1;
      }
    }
    i += len;
    append_utf8(out, cp);
  }
  return out;
}

std::size_t utf16_length(std::string_view s) {
  std::size_t n = 0;
  for (std::size_t i = 0; i < s.size(); i++) {
    const auto c = static_cast<unsigned char>(s[i]);
    if ((c & 0xc0) == 0x80) continue;
    n += c >= 0xf0 ? 2 : 1;
  }
  return n;
}

String js_number(double x) {
  if (std::isnan(x)) return "NaN";
  if (std::isinf(x)) return x > 0 ? "Infinity" : "-Infinity";
  if (x == 0) return "0";
  String out;
  if (x < 0) {
    out.push_back('-');
    x = -x;
  }
  // Shortest round-trip digits in scientific form: d[.ddd]e±XX.
  char buf[64];
  const auto r = std::to_chars(buf, buf + sizeof buf, x, std::chars_format::scientific);
  String sci(buf, r.ptr);
  const auto e = sci.find('e');
  String digits;
  for (std::size_t i = 0; i < e; i++)
    if (sci[i] != '.') digits.push_back(sci[i]);
  const int exp10 = std::atoi(sci.c_str() + e + 1);
  const int k = static_cast<int>(digits.size());
  const int n = exp10 + 1;  // x = 0.d1d2… × 10^n
  if (k <= n && n <= 21) {
    out += digits;
    out.append(static_cast<std::size_t>(n - k), '0');
  } else if (0 < n && n <= 21) {
    out += digits.substr(0, static_cast<std::size_t>(n));
    out.push_back('.');
    out += digits.substr(static_cast<std::size_t>(n));
  } else if (-6 < n && n <= 0) {
    out += "0.";
    out.append(static_cast<std::size_t>(-n), '0');
    out += digits;
  } else {
    out.push_back(digits[0]);
    if (k > 1) {
      out.push_back('.');
      out += digits.substr(1);
    }
    out.push_back('e');
    out.push_back(n - 1 >= 0 ? '+' : '-');
    out += to_str(std::abs(n - 1));
  }
  return out;
}

String json_quote(std::string_view s) {
  String out;
  out.reserve(s.size() + 2);
  out.push_back('"');
  for (std::size_t i = 0; i < s.size(); i++) {
    const char ch = s[i];
    const auto c = static_cast<unsigned char>(ch);
    // A lone surrogate (WTF-8: ED A0–BF 80–BF), escaped as JSON.stringify does.
    if (c == 0xed && i + 2 < s.size() && (static_cast<unsigned char>(s[i + 1]) & 0xe0) == 0xa0 &&
        (static_cast<unsigned char>(s[i + 2]) & 0xc0) == 0x80) {
      const unsigned u = 0xd000u | (static_cast<unsigned char>(s[i + 1]) & 0x3fu) << 6 | (static_cast<unsigned char>(s[i + 2]) & 0x3fu);
      char esc[8];
      std::snprintf(esc, sizeof esc, "\\u%04x", u);
      out += esc;
      i += 2;
      continue;
    }
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char u[8];
          std::snprintf(u, sizeof u, "\\u%04x", c);
          out += u;
        } else {
          out.push_back(ch);
        }
    }
  }
  out.push_back('"');
  return out;
}

bool parse_double(const char* begin, const char* end, double& out) {
#if defined(__cpp_lib_to_chars) || defined(_MSC_VER) || (defined(__GLIBCXX__) && defined(__GNUC__) && __GNUC__ >= 11)
  const auto r = std::from_chars(begin, end, out);
  if (r.ec == std::errc() && r.ptr == end) return true;
  if (r.ec != std::errc::result_out_of_range) return false;
#endif
  // Fallback (and out-of-range values): strtod, with the decimal point of the "C" locale.
  String tmp(begin, end);
  const char* point = std::localeconv()->decimal_point;
  if (point && point[0] != '.' && point[0]) {
    const auto dot = tmp.find('.');
    if (dot != String::npos) tmp[dot] = point[0];
  }
  char* stop = nullptr;
  out = std::strtod(tmp.c_str(), &stop);
  return stop && *stop == 0 && !tmp.empty();
}

int32_t js_to_int32(double x) {
  if (!std::isfinite(x)) return 0;
  double t = std::trunc(x);
  double m = std::fmod(t, 4294967296.0);
  if (m < 0) m += 4294967296.0;
  const auto u = static_cast<uint32_t>(m);
  int32_t out;
  std::memcpy(&out, &u, 4);
  return out;
}

uint16_t js_to_uint16(double x) { return static_cast<uint16_t>(static_cast<uint32_t>(js_to_int32(x)) & 0xffffu); }
uint8_t js_to_uint8(double x) { return static_cast<uint8_t>(static_cast<uint32_t>(js_to_int32(x)) & 0xffu); }

}  // namespace mochi2d::text

// Text helpers shared by the libraries and tools: UTF-8 decoding with the
// replacement rules of Mochi2D's decoder, and number formatting that matches
// JavaScript's Number.prototype.toString (the shortest decimal that
// round-trips the double), which Mochi2D's JSON results and messages use.
#pragma once

#include <cstdint>
#include <string>

#include "util/alloc.hpp"
#include <string_view>

namespace mochi2d::text {

/**
 * Decodes UTF-8 bytes the way Mochi2D's decoder does (binary/utf8.ts):
 * every invalid or overlong sequence, surrogate or value above U+10FFFF
 * becomes U+FFFD, one byte at a time. The result is valid UTF-8.
 */
String sanitize_utf8(std::string_view bytes);

/** Number of UTF-16 code units of valid UTF-8 text (JavaScript's String length). */
std::size_t utf16_length(std::string_view utf8);

/** JavaScript's `String(x)` for a double: "NaN", "Infinity", "-0" prints "0", shortest digits. */
String js_number(double x);

/** `String(x)` for an integer value (no exponent below 1e21). */
inline String js_int(long long x) { return to_str(x); }

/** JSON.stringify of a String (UTF-8 in, UTF-8 out; only the required escapes). */
String json_quote(std::string_view s);

/**
 * Parses a decimal number (JSON grammar) to the nearest double, as
 * JavaScript does: overflow gives ±Infinity, underflow ±0. Returns false when
 * the text is not a number.
 */
bool parse_double(const char* begin, const char* end, double& out);

/** JavaScript's ToInt32 (wrapping modulo 2^32; NaN and infinities give 0). */
int32_t js_to_int32(double x);

/** JavaScript's ToUint16 / ToUint8 (wrapping). */
uint16_t js_to_uint16(double x);
uint8_t js_to_uint8(double x);

}  // namespace mochi2d::text

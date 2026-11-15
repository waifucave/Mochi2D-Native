// JavaScript semantics the framework needs to stay bit-exact with Mochi2D
// (Math.min and Math.max with NaN and signed zeros, String() of JSON values,
// the keys every plain object inherits) and the small JSON readers of
// Mochi2D's src/anim/json.ts.
#pragma once

#include <cmath>
#include <limits>
#include <optional>
#include <string_view>

#include "util/alloc.hpp"
#include "util/json.hpp"

namespace mochi2d::framework {

/** Math.PI. */
constexpr double kPi = 3.141592653589793;

/** Math.max(a, b): NaN if either is NaN, +0 above -0. */
inline double js_max(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  if (a == b) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}

/** Math.min(a, b): NaN if either is NaN, -0 below +0. */
inline double js_min(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  if (a == b) return std::signbit(a) ? a : b;
  return a < b ? a : b;
}

/** Math.fround. */
inline double fround(double x) { return static_cast<double>(static_cast<float>(x)); }

/**
 * Whether `key` names a property of Object.prototype ("toString",
 * "constructor", "__proto__" …): looking it up in a plain object literal
 * finds a function or an object instead of undefined.
 */
bool is_object_prototype_key(std::string_view key);

/** String(v) of a JSON value (undefined for nullptr), as a template literal prints it. */
String js_to_string(const json::Value* v);

/** A file that cannot be used (AnimationFormatError's message). */
struct FormatError {
  String message;
};

/**
 * An error the reference raises while it runs (a TypeError, a RangeError…):
 * its error name and message.
 */
struct Fault {
  String kind;
  String message;
};

// ---- readers of json.ts: missing or mistyped values give the fallback ----

/** The member `key` of `o` when `o` is an object, else nullptr (obj(o)[key]). */
inline const json::Value* member(const json::Value* o, std::string_view key) {
  return o && o->is_object() ? o->get(key) : nullptr;
}

/** The items of an array, or none (arr(v)). */
const Vector<json::Value>& arr(const json::Value* v);

/** A number, or `fallback` (num(v, fallback)). */
inline double num(const json::Value* v, double fallback) { return v && v->is_number() ? v->as_number() : fallback; }

/** A number, or nothing (optNum(v)). */
inline std::optional<double> opt_num(const json::Value* v) {
  if (v && v->is_number()) return v->as_number();
  return std::nullopt;
}

/** A string, or `fallback` (str(v, fallback)). */
inline String str(const json::Value* v, std::string_view fallback = {}) {
  return v && v->is_string() ? v->as_string() : String(fallback.data(), fallback.size());
}

/** A boolean, or `fallback` (bool(v, fallback)). */
inline bool boolean(const json::Value* v, bool fallback = false) { return v && v->is_bool() ? v->as_bool() : fallback; }

/**
 * Parses UTF-8 JSON text (invalid sequences as U+FFFD, a byte-order mark
 * skipped); false with "<label>: invalid JSON (<message>)".
 */
bool parse_json(std::string_view bytes, std::string_view label, json::Value& out, FormatError& error);

}  // namespace mochi2d::framework

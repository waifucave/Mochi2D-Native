// A small JSON value, parser and writer. Objects keep their keys in
// insertion order (a repeated key keeps its first position and takes the
// last value, as JSON.parse does). The writer reproduces the layout of
// Mochi2D's result files (formatResultJson).
#pragma once

#include "util/alloc.hpp"
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace mochi2d::json {

class Value {
 public:
  enum class Type { Null, Bool, Number, String, Array, Object };
  using Member = std::pair<String, Value>;

  Value() = default;
  Value(std::nullptr_t) {}
  Value(bool b) : type_(Type::Bool), bool_(b) {}
  Value(double d) : type_(Type::Number), num_(d) {}
  Value(float f) : type_(Type::Number), num_(static_cast<double>(f)) {}
  Value(int i) : type_(Type::Number), num_(i) {}
  Value(long i) : type_(Type::Number), num_(static_cast<double>(i)) {}
  Value(long long i) : type_(Type::Number), num_(static_cast<double>(i)) {}
  Value(unsigned i) : type_(Type::Number), num_(i) {}
  Value(unsigned long i) : type_(Type::Number), num_(static_cast<double>(i)) {}
  Value(unsigned long long i) : type_(Type::Number), num_(static_cast<double>(i)) {}
  Value(const char* s) : type_(Type::String), str_(s) {}
  Value(String s) : type_(Type::String), str_(std::move(s)) {}
  Value(std::string_view s) : type_(Type::String), str_(s) {}

  static Value array() { Value v; v.type_ = Type::Array; return v; }
  static Value object() { Value v; v.type_ = Type::Object; return v; }

  Type type() const { return type_; }
  bool is_null() const { return type_ == Type::Null; }
  bool is_bool() const { return type_ == Type::Bool; }
  bool is_number() const { return type_ == Type::Number; }
  bool is_string() const { return type_ == Type::String; }
  bool is_array() const { return type_ == Type::Array; }
  bool is_object() const { return type_ == Type::Object; }

  bool as_bool() const { return bool_; }
  double as_number() const { return num_; }
  const String& as_string() const { return str_; }
  const Vector<Value>& items() const { return arr_; }
  Vector<Value>& items() { return arr_; }
  const Vector<Member>& members() const { return obj_; }
  Vector<Member>& members() { return obj_; }

  /** Members in the order of JavaScript's Object.entries: array-index keys first, ascending. */
  Vector<const Member*> entries_js_order() const;

  /** Appends to an array. */
  Value& push(Value v) { arr_.push_back(std::move(v)); return arr_.back(); }
  /** Sets a member (keeps the first position of a repeated key). */
  Value& set(String key, Value v);
  /** The member's value, or nullptr. */
  const Value* get(std::string_view key) const;

 private:
  Type type_ = Type::Null;
  bool bool_ = false;
  double num_ = 0;
  String str_;
  Vector<Value> arr_;
  Vector<Member> obj_;
};

/** Parse error with a message in the style of JSON.parse. */
struct ParseError {
  String message;
};

/**
 * Parses JSON text (UTF-8). Returns false and fills `error` when the text is
 * not valid JSON. A leading byte-order mark is not skipped here.
 */
bool parse(std::string_view text, Value& out, ParseError& error);

/** Number formatting of the writer. */
enum class Numbers { Float32, Double };

/**
 * Writes a value as Mochi2D's formatResultJson does: objects indented by two
 * spaces, arrays of plain values on one line, numbers as the shortest
 * JavaScript decimal (of the float32 value with Numbers::Float32), -0 as 0,
 * non-finite numbers as null, and a final newline.
 */
String write_result(const Value& v, Numbers numbers = Numbers::Float32);

/** Compact JSON (JSON.stringify without spacing). */
String write_compact(const Value& v);

/** JSON.stringify(v, null, 2) layout. */
String write_pretty(const Value& v);

}  // namespace mochi2d::json

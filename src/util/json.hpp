// A small JSON value, parser and writer. Objects keep their keys in
// insertion order (a repeated key keeps its first position and takes the
// last value, as JSON.parse does). The writer reproduces the layout of
// Mochi2D's result files (formatResultJson).
#pragma once

#include "util/alloc.hpp"
#include <cstdint>
#include <memory>
#include <new>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace mochi2d::json {

class Value {
 public:
  enum class Type : uint8_t { Null, Bool, Number, String, Array, Object };
  using Member = std::pair<String, Value>;

  Value() noexcept { u_.d = 0; }
  Value(std::nullptr_t) noexcept { u_.d = 0; }
  Value(bool b) noexcept : type_(Type::Bool) { u_.b = b; }
  Value(double d) noexcept : type_(Type::Number) { u_.d = d; }
  Value(float f) noexcept : Value(static_cast<double>(f)) {}
  Value(int i) noexcept : Value(static_cast<double>(i)) {}
  Value(long i) noexcept : Value(static_cast<double>(i)) {}
  Value(long long i) noexcept : Value(static_cast<double>(i)) {}
  Value(unsigned i) noexcept : Value(static_cast<double>(i)) {}
  Value(unsigned long i) noexcept : Value(static_cast<double>(i)) {}
  Value(unsigned long long i) noexcept : Value(static_cast<double>(i)) {}
  Value(const char* s) : Value(String(s)) {}
  Value(String s) : type_(Type::String) { u_.s = box<String>(std::move(s)); }
  Value(std::string_view s) : Value(String(s)) {}

  static Value array() {
    Value v;
    v.u_.a = box<Vector<Value>>();
    v.type_ = Type::Array;
    return v;
  }
  static Value object() {
    Value v;
    v.u_.o = box<Vector<Member>>();
    v.type_ = Type::Object;
    return v;
  }

  Value(const Value& other);
  Value(Value&& other) noexcept : type_(other.type_), u_(other.u_) {
    other.type_ = Type::Null;
    other.u_.d = 0;
  }
  Value& operator=(const Value& other);
  Value& operator=(Value&& other) noexcept {
    if (this != &other) {
      release();
      type_ = other.type_;
      u_ = other.u_;
      other.type_ = Type::Null;
      other.u_.d = 0;
    }
    return *this;
  }
  ~Value() { release(); }

  Type type() const { return type_; }
  bool is_null() const { return type_ == Type::Null; }
  bool is_bool() const { return type_ == Type::Bool; }
  bool is_number() const { return type_ == Type::Number; }
  bool is_string() const { return type_ == Type::String; }
  bool is_array() const { return type_ == Type::Array; }
  bool is_object() const { return type_ == Type::Object; }

  bool as_bool() const { return type_ == Type::Bool && u_.b; }
  double as_number() const { return type_ == Type::Number ? u_.d : 0; }
  /** The string; an empty one for other types. */
  const String& as_string() const;
  /** The array's items; none for other types. */
  const Vector<Value>& items() const;
  /** The array's items, for changing them; a value of another type becomes an empty array first. */
  Vector<Value>& items();
  /** The object's members; none for other types. */
  const Vector<Member>& members() const;
  /** The object's members, for changing them; a value of another type becomes an empty object first. */
  Vector<Member>& members();

  /** Members in the order of JavaScript's Object.entries: array-index keys first, ascending. */
  Vector<const Member*> entries_js_order() const;

  /** Appends to an array. */
  Value& push(Value v) {
    Vector<Value>& a = items();
    a.push_back(std::move(v));
    return a.back();
  }
  /** Sets a member (keeps the first position of a repeated key). */
  Value& set(String key, Value v);
  /** The member's value, or nullptr. */
  const Value* get(std::string_view key) const;

 private:
  // 16 bytes: numbers and booleans inline; strings, arrays and objects boxed
  // (a value per element of a large array costs little).
  template <class T, class... A>
  static T* box(A&&... args) {
    void* p = allocate_bytes(sizeof(T), alignof(T));
    if (!p) out_of_memory_failure();
    return new (p) T(std::forward<A>(args)...);
  }
  template <class T>
  static void unbox(T* p) noexcept {
    p->~T();
    deallocate_bytes(p);
  }
  void release() noexcept;

  Type type_ = Type::Null;
  union {
    bool b;
    double d;
    String* s;
    Vector<Value>* a;
    Vector<Member>* o;
  } u_;
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

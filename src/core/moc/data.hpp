// Model data: everything a `.moc3` file of versions 1–6 stores, as arrays
// (port of Mochi2D's MocData, src/core/moc/data.ts, and the raw sections of
// read.ts). The data is a table of arrays indexed by schema field: each
// field of a MocData group is one array, parallel to the group's other
// fields. Placeholder arrays hold no data.
#pragma once

#include "util/alloc.hpp"
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "core/moc/schema.hpp"

namespace mochi2d::moc {

struct Canvas {
  float pixels_per_unit = 0;
  float origin_x = 0;
  float origin_y = 0;
  float width = 0;
  float height = 0;
  /** Bit 0 set: no output conversion (§1b.4). */
  uint8_t flags = 0;
};

/** One array of the data (the vector of its element type is used). */
struct FieldArray {
  /** The field exists in the data's version (always true for fields read from a file). */
  bool present = false;
  Vector<int32_t> i32;
  Vector<float> f32;
  Vector<uint16_t> u16;
  Vector<uint8_t> u8;
  Vector<String> names;

  std::size_t size(ElementType t) const {
    switch (t) {
      case ElementType::I32: return i32.size();
      case ElementType::F32: return f32.size();
      case ElementType::U16: return u16.size();
      case ElementType::U8: return u8.size();
      case ElementType::Name: return names.size();
      case ElementType::Placeholder: return 0;
    }
    return 0;
  }
};

/** MocData: the canvas and every array. */
struct MocData {
  Canvas canvas;
  std::array<FieldArray, kFieldCount> fields;

  FieldArray& operator[](F f) { return fields[static_cast<std::size_t>(f)]; }
  const FieldArray& operator[](F f) const { return fields[static_cast<std::size_t>(f)]; }

  const Vector<int32_t>& i32(F f) const { return (*this)[f].i32; }
  const Vector<float>& f32(F f) const { return (*this)[f].f32; }
  const Vector<uint16_t>& u16(F f) const { return (*this)[f].u16; }
  const Vector<uint8_t>& u8(F f) const { return (*this)[f].u8; }
  const Vector<String>& names(F f) const { return (*this)[f].names; }
  Vector<int32_t>& i32(F f) { return (*this)[f].i32; }
  Vector<float>& f32(F f) { return (*this)[f].f32; }
  Vector<uint16_t>& u16(F f) { return (*this)[f].u16; }
  Vector<uint8_t>& u8(F f) { return (*this)[f].u8; }
  Vector<String>& names(F f) { return (*this)[f].names; }

  /** Number of elements of a field's array. */
  std::size_t size(F f) const { return (*this)[f].size(spec(f).type); }
  /** Number of elements of a group (the length of its first field). */
  std::size_t group_size(const GroupSpec& g) const;
};

/** One finding of reading, writing or validating (docs/moc-data.md "Diagnostics"). */
struct Diagnostic {
  String code;
  /** "error" or "warning". */
  bool warning = false;
  /** A MocData group, "canvas" or "file". */
  String kind;
  std::optional<long long> index;
  std::optional<String> field;
  String message;
};

/**
 * Why a file cannot be read or loaded (Mochi2D's MocFormatError): a stable
 * code ("magic", "section-bounds", …, "invalid" for the loader's rules) and
 * a message. The libraries do not throw: functions that can fail return
 * false and fill an Error.
 */
struct Error {
  String code;
  String message;
};

/** A problem read_sections reports instead of failing, in lenient mode. */
struct ReadIssue {
  String code;  // "file-length" or "slot-order"
  String message;
};

/** The raw sections of a file: its data with the count table. */
struct Sections {
  int version = 0;
  bool big_endian = false;
  std::size_t byte_length = 0;
  /** Count table (entries the version does not define are 0). */
  Vector<int32_t> counts;
  MocData data;
  Vector<ReadIssue> issues;

  int count(int index) const {
    return index >= 0 && static_cast<std::size_t>(index) < counts.size() ? counts[static_cast<std::size_t>(index)] : 0;
  }
};

/**
 * In lenient mode, the most that overlapping sections may claim together, in
 * file lengths: past it, reading stops with a slot-order error, so that a
 * file's sections cannot make it count more than this many times.
 */
constexpr uint64_t kMaxClaimedLengths = 4;

/**
 * Reads header, tables and every section (read.ts readMocSections). Returns
 * false with an Error whose code is one of (magic, version, file-length, section-bounds,
 * negative-count, name-terminator, slot-order). In lenient mode a file
 * length that is not a multiple of 64 and sections out of slot order are
 * reported in `issues` instead.
 */
bool read_sections(const uint8_t* bytes, std::size_t size, bool lenient, Sections& out, Error& error);

}  // namespace mochi2d::moc

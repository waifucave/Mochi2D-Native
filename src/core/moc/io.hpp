// Reading, writing and validating `.moc3` files as MocData (port of Mochi2D's
// src/core/moc/io.ts, validate.ts and structure.ts; docs/moc-data.md).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "core/moc/data.hpp"

namespace mochi2d::moc {

/** The result of read_moc. */
struct ReadResult {
  MocData data;
  int version = 0;
  /** Problems that did not stop reading: big-endian, slot order, file length. */
  Vector<Diagnostic> diagnostics;
};

/**
 * Reads a file of versions 1–6 into MocData (readMoc). Returns false with an
 * Error when the bytes cannot be read; reports what leaves the data intact.
 */
bool read_moc(const uint8_t* bytes, std::size_t size, ReadResult& out, Error& error);

/** The versions write_moc writes. */
inline bool writable_version(int v) { return v >= 1 && v <= 5; }

/**
 * Checks that the data has exactly the arrays of `version` with parallel
 * lengths and IDs the file can hold (checkMocDataShape). Fills `counts`
 * (the count table) when there are no diagnostics.
 */
Vector<Diagnostic> check_shape(const MocData& data, int version, Vector<int32_t>* counts);

/**
 * Writes MocData as a file of `version` (1–5) in the layout of genuine files
 * (writeMoc). Returns false, with every problem in `diagnostics`
 * (MocWriteError's), when the data does not fit the version or fails the
 * `official` level of validate_moc.
 */
bool write_moc(const MocData& data, int version, Vector<uint8_t>& out, Vector<Diagnostic>& diagnostics);

/** write_moc without the structure checks (for crafted test files). */
bool write_moc_unchecked(const MocData& data, int version, Vector<uint8_t>& out, Vector<Diagnostic>& diagnostics);

enum class Level { Official, Strict };

struct Validation {
  bool valid = false;
  /** The file's version, or 0 when the bytes have none. */
  int version = 0;
  Vector<Diagnostic> diagnostics;
};

/** Validates a file (validateMoc). Never throws for bad input. */
Validation validate_moc(const uint8_t* bytes, std::size_t size, Level level = Level::Strict);
/** Validates MocData of a version. */
Validation validate_moc(const MocData& data, int version, Level level = Level::Strict);

/** Collects diagnostics at a level (structure.ts Report). */
class Report {
 public:
  explicit Report(bool strict) : strict_(strict) {}
  void error(Level level, const String& code, const String& kind, const String& message,
             std::optional<long long> index = std::nullopt, std::optional<String> field = std::nullopt);
  void warn(const String& code, const String& kind, const String& message,
            std::optional<long long> index = std::nullopt, std::optional<String> field = std::nullopt);
  std::size_t errors() const;
  Vector<Diagnostic> list;

 private:
  bool strict_;
};

/** Every structural check of validate_moc on shape-checked data (checkStructure). */
void check_structure(const MocData& d, int version, Report& r);

}  // namespace mochi2d::moc

// Application tints of art meshes (Mochi2D 0.7.0's setTint, clearTint,
// clearTints, getTint, tints and activeTints of src/runtime/model-runtime.ts;
// not reference behavior): an RGBA per drawable, part of the draw data. A
// renderer multiplies a mesh's color, after its multiply and screen colors,
// by r, g and b, and its opacity by a; masks are drawn without tints.
#pragma once

#include <cstddef>
#include <cstdint>

#include "util/alloc.hpp"

namespace mochi2d::framework {

class Tints {
 public:
  /** No drawables; resize() sets the count. */
  Tints() = default;
  explicit Tints(std::size_t drawables) { resize(drawables); }

  /** Sets the number of drawables and removes every tint. */
  void resize(std::size_t drawables);

  /** The largest tint of a color channel (Mochi2D 0.14.0's MAX_TINT): above 1 brightens, up to white. */
  static constexpr double kMaxTint = 2;

  /** Why set() refused a tint (the reference's RangeErrors), or Ok. */
  enum class SetError : uint8_t { Ok, Count, NotFinite, Unknown };
  /**
   * Tints drawable `index` until cleared: `rgba` holds `count` numbers, r, g
   * and b, or r, g, b and a (default 1). Values are limited to [0, kMaxTint]
   * (r, g, b; 0.14.0) and [0, 1] (a), and
   * stored as float32. Checked in the reference's order: the count (3 or 4),
   * every value finite, then the index. On an error nothing changes, and
   * `message` (when not null) gets the reference's message, naming the mesh
   * by `id`.
   */
  SetError set(int index, const double* rgba, int count, const char* id = nullptr, String* message = nullptr);
  /** Removes a drawable's tint; false for an index out of range or a drawable without one. */
  bool clear(int index);
  /** Removes every tint. */
  void clear_all();
  /** A drawable's tint (stored as float32); false, leaving `out` as it is, without one. */
  bool get(int index, float out[4]) const;
  bool has(int index) const;

  /** RGBA per drawable, 4 floats each, 1 where none is set. */
  const Vector<float>& rgba() const { return rgba_; }
  /** rgba() when a tint is set, else null (renderers then skip tinting). */
  const float* active() const { return count_ ? rgba_.data() : nullptr; }
  /** The tinted drawables, by index. */
  Vector<int32_t> tinted() const;
  std::size_t count() const { return count_; }
  /** Changes whenever a tint changes, so a view knows to draw again. */
  uint32_t version() const { return version_; }

 private:
  Vector<float> rgba_;
  Vector<uint8_t> tinted_;
  std::size_t count_ = 0;
  uint32_t version_ = 0;
};

}  // namespace mochi2d::framework

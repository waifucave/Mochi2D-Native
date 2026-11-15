// The values animation reads and writes (port of Mochi2D's src/anim/values.ts,
// 3g): model parameter values (float32, limited to their range or
// wrapped), free values for IDs the model lacks (doubles), part opacities
// (float32) with free entries for unknown part IDs, and the model opacity.
// Every parameter write limits (or wraps) first, then blends with the stored
// value by the weight in double, then stores as float32.
#pragma once

#include <cstdint>

#include "core/moc/model.hpp"
#include "util/alloc.hpp"

namespace mochi2d::framework {

/** The wrap-around of 3g.2 for a value outside [lo, hi]. */
double wrap_value(double x, double lo, double hi);

class AnimationValues {
 public:
  /** The model must outlive the values (its IDs are referenced). */
  explicit AnimationValues(const moc::Model& model);

  /** Parameter IDs in model order. */
  const Vector<String>& ids() const { return *ids_; }
  /** Part IDs in model order. */
  const Vector<String>& part_ids() const { return *part_ids_; }

  /** Current parameter values (float32). */
  Vector<float> values;
  /** Saved parameter values (3j steps 1 and 3). */
  Vector<float> saved;
  Vector<float> min, max;
  Vector<uint8_t> repeat;
  /** Free values (3g.3): doubles, start at 0, never limited, never restored. */
  HashMap<String, double> free;
  /** Wrap mode (3g.2), off by default. */
  bool wrap = false;
  Vector<float> part_opacities;
  /** Opacities of part IDs that are not in the model (float32 values; used only by poses). */
  HashMap<String, double> free_part_opacities;
  /** Model opacity (3g.5). */
  double model_opacity = 1;

  /** Index of the first parameter with this ID, or -1. */
  int index(const String& id) const;
  /** Index of the first part with this ID, or -1. */
  int part_index(const String& id) const;
  /** A parameter's value, else the free value (0 if never written). */
  double get(const String& id) const;
  /** Limits (or, in wrap mode for repeating parameters, wraps) x to parameter i's range. */
  double limit(int i, double x) const;
  /** 3g.1: sets parameter i to x with weight w. */
  void set_at(int i, double x, double w = 1);
  /** Sets an ID: a parameter by 3g.1, otherwise its free value (no limit, double). */
  void set(const String& id, double x, double w = 1);
  /** Sets v + x·w. */
  void add(const String& id, double x, double w = 1);
  void add_at(int i, double x, double w = 1);
  /** Sets v·(1 + (x − 1)·w). */
  void multiply(const String& id, double x, double w = 1);
  /** 3j step 1: every parameter takes its saved value. */
  void restore();
  /** 3j step 3: the saved values become the current ones. */
  void save();
  /** A part's opacity, or a free part entry's (1 if never written). */
  double part_opacity(const String& id) const;
  void set_part_opacity(const String& id, double v);
  /** The free value of an ID, if it was ever written. */
  const double* free_value(const String& id) const;

 private:
  const Vector<String>* ids_;
  const Vector<String>* part_ids_;
  HashMap<String, int> index_by_id_;
  HashMap<String, int> part_index_by_id_;
};

}  // namespace mochi2d::framework

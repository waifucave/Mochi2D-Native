// Motion files `*.motion3.json` (3c) and curve evaluation (3k): port of
// Mochi2D's src/anim/motion.ts. Arithmetic is double precision.
#pragma once

#include <cstdint>
#include <optional>
#include <string_view>

#include "framework/jsutil.hpp"
#include "util/alloc.hpp"
#include "util/json.hpp"

namespace mochi2d::framework {

/** Segment kinds (3c.3). */
enum : uint8_t { kLinear = 0, kBezier = 1, kStepped = 2, kInverseStepped = 3 };

/** What a curve's `Target` names. */
enum class CurveTarget : uint8_t { Model, Parameter, PartOpacity, Other };

struct MotionCurve {
  /** The `Target` as written ("Model", "Parameter", "PartOpacity" or anything else). */
  String target;
  CurveTarget kind = CurveTarget::Other;
  String id;
  /** The curve's own fade times, when set (3l.3 step e). */
  std::optional<double> fade_in, fade_out;
  /** Points as t₀, v₀, t₁, v₁, … */
  Vector<double> points;
  /** Per segment: its kind and the index of its first point. */
  Vector<uint8_t> kinds;
  Vector<uint32_t> starts;
};

struct MotionEvent {
  double time = 0;
  String value;
};

struct Motion {
  String label;
  double duration = 0;
  double fps = 0;
  bool restricted = false;
  /** Fade times from `Meta` (missing or negative: 1). */
  double fade_in = 1, fade_out = 1;
  /** The curves that take effect (3c.2), in file order. */
  Vector<MotionCurve> curves;
  /** Curves left out by the order rule of 3c.2. */
  std::size_t ignored_curves = 0;
  Vector<MotionEvent> events;
};

/** Reads and validates a motion file (3c.4); false with the error when it is unusable. */
bool parse_motion(std::string_view bytes, std::string_view label, Motion& out, FormatError& error);
/** The same from parsed JSON. */
bool motion_from_json(const json::Value& json, std::string_view label, Motion& out, FormatError& error);

/** The Bézier parameter s at time τ in solved mode (3k.3). */
double solve_bezier_parameter(double t0, double t1, double t2, double t3, double tau);

/**
 * The value of a curve at local time τ (3k). `loop_length` is the loop
 * length L of a looping motion: between the last point and L the value runs
 * back to the first point (the end interval of 3k.2).
 */
double evaluate_curve(const MotionCurve& curve, double tau, bool restricted,
                      std::optional<double> loop_length = std::nullopt);

}  // namespace mochi2d::framework

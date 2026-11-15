// Eye blink (3p), breath (3q) and look (3r): port of Mochi2D's
// src/anim/effects.ts.
#pragma once

#include <cstdint>

#include "framework/jsutil.hpp"
#include "framework/values.hpp"
#include "util/alloc.hpp"

namespace mochi2d::framework {

/** The random sequence of eye blink and idle playback (3v.2): numbers in [0, 1). */
class RandomDraw {
 public:
  virtual ~RandomDraw() = default;
  /** The next number; false with a fault when there is none (the reference throws). */
  virtual bool draw(double& out, Fault& fault) = 0;
};

/** Eye-blink timing (3p); the reference configuration by default. */
struct EyeBlinkTiming {
  double interval = 4;
  double closing = 0.1;
  double closed = 0.05;
  double opening = 0.15;
};

/** 3p: a state machine on its own clock, which advances only on frames where it runs. */
class EyeBlink {
 public:
  enum class State : uint8_t { Initial, Waiting, Closing, Closed, Opening };

  /** `random` must outlive the eye blink. */
  EyeBlink(Vector<String> ids, RandomDraw* random, EyeBlinkTiming timing = {})
      : timing(timing), ids_(std::move(ids)), random_(random) {}

  double time = 0;
  State state = State::Initial;
  const EyeBlinkTiming timing;

  /** False with the random sequence's fault. */
  bool frame(double dt, AnimationValues& values, Fault& fault);

 private:
  Vector<String> ids_;
  RandomDraw* random_;
  double next_ = 0;
  double start_ = 0;
};

struct BreathEntry {
  String id;
  double offset = 0, peak = 0, cycle = 0, weight = 0;
};

/** The reference breath configuration (3q). */
Vector<BreathEntry> reference_breath();

/** 3q: adds o + p·sin(φ/c) with weight w, φ = (t·2)·π. */
class Breath {
 public:
  explicit Breath(Vector<BreathEntry> entries = reference_breath()) : entries(std::move(entries)) {}
  double time = 0;
  Vector<BreathEntry> entries;
  void frame(double dt, AnimationValues& values);
};

struct LookEntry {
  String id;
  double fx = 0, fy = 0, fxy = 0;
};

/** The reference look configuration (3r.1). */
Vector<LookEntry> reference_look();

/** 3r.1: a smoothed point following the target, mapped to parameters. */
class Look {
 public:
  explicit Look(Vector<LookEntry> entries = reference_look()) : entries(std::move(entries)) {}
  double target_x = 0, target_y = 0;
  double x = 0, y = 0, vx = 0, vy = 0;
  double time = 0;
  Vector<LookEntry> entries;
  void set_target(double tx, double ty) {
    target_x = tx;
    target_y = ty;
  }
  void frame(double dt, AnimationValues& values);

 private:
  void move(double dt);
  double last_ = 0;
};

}  // namespace mochi2d::framework

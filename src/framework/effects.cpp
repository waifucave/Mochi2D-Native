#include "framework/effects.hpp"

#include <cmath>

#include "fdlibm.hpp"

namespace mochi2d::framework {

bool EyeBlink::frame(double dt, AnimationValues& values, Fault& fault) {
  time += dt;
  const double t = time;
  const EyeBlinkTiming& tm = timing;
  double value = 1;
  switch (state) {
    case State::Initial: {
      double r;
      if (!random_->draw(r, fault)) return false;
      next_ = t + r * (2 * tm.interval - 1);
      state = State::Waiting;
      value = 1;
      break;
    }
    case State::Waiting:
      if (next_ < t) {
        start_ = t;
        state = State::Closing;
      }
      value = 1;
      break;
    case State::Closing: {
      double x = (t - start_) / tm.closing;
      if (x >= 1) {
        x = 1;
        start_ = t;
        state = State::Closed;
      }
      value = 1 - x;
      break;
    }
    case State::Closed: {
      const double x = (t - start_) / tm.closed;
      if (x >= 1) {
        start_ = t;
        state = State::Opening;
      }
      value = 0;
      break;
    }
    case State::Opening: {
      double x = (t - start_) / tm.opening;
      if (x >= 1) {
        x = 1;
        double r;
        if (!random_->draw(r, fault)) return false;
        next_ = t + r * (2 * tm.interval - 1);
        state = State::Waiting;
      }
      value = x;
      break;
    }
  }
  for (const auto& id : ids_) values.set(id, value);
  return true;
}

Vector<BreathEntry> reference_breath() {
  Vector<BreathEntry> v;
  v.push_back({"ParamAngleX", 0, 15, 6.5345, 0.5});
  v.push_back({"ParamAngleY", 0, 8, 3.5345, 0.5});
  v.push_back({"ParamAngleZ", 0, 10, 5.5345, 0.5});
  v.push_back({"ParamBodyAngleX", 0, 4, 15.5345, 0.5});
  v.push_back({"ParamBreath", 0.5, 0.5, 3.2345, 1});
  return v;
}

void Breath::frame(double dt, AnimationValues& values) {
  time += dt;
  const double phi = time * 2 * kPi;
  for (const auto& e : entries) values.add(e.id, e.offset + e.peak * fdlibm::sin(phi / e.cycle), e.weight);
}

Vector<LookEntry> reference_look() {
  Vector<LookEntry> v;
  v.push_back({"ParamAngleX", 30, 0, 0});
  v.push_back({"ParamAngleY", 0, 30, 0});
  v.push_back({"ParamAngleZ", 0, 0, -30});
  v.push_back({"ParamBodyAngleX", 10, 0, 0});
  v.push_back({"ParamEyeBallX", 1, 0, 0});
  v.push_back({"ParamEyeBallY", 0, 1, 0});
  return v;
}

void Look::frame(double dt, AnimationValues& values) {
  move(dt);
  for (const auto& e : entries) values.add(e.id, e.fx * x + e.fy * y + e.fxy * x * y);
}

void Look::move(double dt) {
  time += dt;
  if (last_ == 0) {
    last_ = time;
    return;
  }
  const double kappa = (time - last_) * 30;
  last_ = time;
  const double V = 4.0 / 30;
  const double A = (kappa * V) / 4.5;
  const double dx = target_x - x;
  const double dy = target_y - y;
  if (std::fabs(dx) <= 0.01 && std::fabs(dy) <= 0.01) return;
  const double D = std::sqrt(dx * dx + dy * dy);
  double ax = (V * dx) / D - vx;
  double ay = (V * dy) / D - vy;
  const double al = std::sqrt(ax * ax + ay * ay);
  if (al > A) {
    ax *= A / al;
    ay *= A / al;
  }
  vx += ax;
  vy += ay;
  const double B = 0.5 * (std::sqrt(A * A + 16 * A * D - 8 * A * D) - A);
  const double vl = std::sqrt(vx * vx + vy * vy);
  if (vl > B) {
    vx *= B / vl;
    vy *= B / vl;
  }
  x += vx;
  y += vy;
}

}  // namespace mochi2d::framework

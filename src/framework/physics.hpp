// Pendulum physics: the file format of 3e and the simulation of 3n
// (port of Mochi2D's src/anim/physics.ts). Arithmetic is double precision;
// the input copy and the working copy of the parameter values are float32.
#pragma once

#include <optional>

#include <cstdint>
#include <string_view>

#include "framework/jsutil.hpp"
#include "framework/values.hpp"
#include "util/alloc.hpp"
#include "util/json.hpp"

namespace mochi2d::framework {

enum class PhysicsKind : uint8_t { X, Y, Angle };

struct PhysicsInput {
  String source;
  double weight = 0;
  PhysicsKind type = PhysicsKind::X;
  bool reflect = false;
};

struct PhysicsOutput {
  String destination;
  double vertex_index = 0;
  double scale = 0;
  double weight = 0;
  PhysicsKind type = PhysicsKind::X;
  bool reflect = false;
};

struct PhysicsParticle {
  double x = 0, y = 0, mobility = 0, delay = 0, acceleration = 0, radius = 0;
};

struct Normalization {
  double minimum = 0, default_value = 0, maximum = 0;
};

struct PhysicsSetting {
  String id;
  Vector<PhysicsInput> inputs;
  Vector<PhysicsOutput> outputs;
  Vector<PhysicsParticle> particles;
  Normalization position, angle;
};

struct PhysicsName {
  String id, name;
};

struct PhysicsFile {
  String label;
  /** Internal rate; 0 means one step per frame (3n.3). */
  double fps = 0;
  Vector<PhysicsSetting> settings;
  /** Display names of settings (`Meta.PhysicsDictionary`). */
  Vector<PhysicsName> names;
};

/** Reads a physics file; false when the Meta totals disagree with the file (3e.1) or it is not JSON. */
bool parse_physics(std::string_view bytes, std::string_view label, PhysicsFile& out, FormatError& error);
bool physics_from_json(const json::Value& json, std::string_view label, PhysicsFile& out, FormatError& error);

/** ang(u → w): the angle from u to w, in [−π, π] (3n.6). */
double angle_between(double ux, double uy, double wx, double wy);

/**
 * A physics simulation's state between two frames (Mochi2D 0.10.0's
 * PhysicsState): every particle's position, velocity and last gravity
 * direction, every output's last two values, the step accumulator and
 * interpolation factor, and the float32 input copy of the parameter values.
 * Not included: the options (gravity, wind, strengths, rate). The numbers
 * are kept exactly, −0 included.
 */
struct PhysicsState {
  /** Settings, each one's particle and output counts, and the parameter count, of the saving rig. */
  Vector<int32_t> shape;
  Vector<double> data;
};

class PhysicsRig {
 public:
  /**
   * The most internal steps in one frame (Mochi2D 0.16.0; not reference
   * behavior): 600,000 steps a second at 60 frames a second, far above any
   * rig's rate, and only a moment for a corrupt one (an Fps of 1e308).
   */
  static constexpr int kMaxStepsPerFrame = 10000;
  /** The file and the values must outlive the rig. */
  PhysicsRig(const PhysicsFile& file, AnimationValues& values);

  const PhysicsFile& file() const { return *file_; }
  /** Gravity G and wind V (3n.2): application options, read at every step. */
  double gravity[2] = {0, -1};
  double wind[2] = {0, 0};
  /**
   * Strength (Mochi2D 0.8.0; not reference behavior): how far physics moves
   * its parameters, for the whole rig, times each setting's own (file order).
   * With k ≠ 1 an output moves its parameter from c to c + (r − c)·k instead
   * of to r: 0 leaves it at c, above 1 the result is limited to the
   * parameter's range. 1, the default, is the reference, bit for bit.
   */
  double strength = 1;
  Vector<double> setting_strengths;
  /**
   * Wind multipliers per setting (Mochi2D 0.13.0; not reference behavior,
   * file order): a setting's pendulums feel the wind V times its multiplier,
   * at every step and in settle. 1, the default, is the reference bit for
   * bit; 0 shields the setting from the wind.
   */
  Vector<double> setting_winds;
  /**
   * In a frame with dt ≤ 0, write the last outputs again (not reference
   * behavior: the reference writes none, 3n.3), so a paused view keeps its
   * physics pose.
   */
  bool hold_on_zero_steps = false;
  /**
   * The internal step rate, steps per second (Mochi2D 0.10.0; not reference
   * behavior), instead of the file's Fps: 0 steps once per frame (3n.3).
   * Empty, the default: the file's.
   */
  std::optional<double> rate;
  /** The step rate in use: `rate`, or the file's Fps (0: one step per frame). */
  double step_rate() const { return rate ? *rate : file_->fps; }

  /** A copy of the simulation's state now. */
  void save_state(PhysicsState& out) const;
  /**
   * Puts the simulation back in a saved state: the next frame continues
   * exactly as it did after the save, given the same parameter values, step
   * lengths and options. False (and nothing changed) when the state comes
   * from other physics settings (its shape differs).
   */
  bool restore_state(const PhysicsState& state);

  /**
   * 3n.3: one frame of length dt; writes the interpolated outputs into the
   * parameters. False with the reference's TypeError for a setting without
   * vertices or an output whose vertex index is not an integer.
   */
  bool frame(double dt, Fault& fault);
  /** 3n.8: the optional settle procedure, run once after load. */
  bool settle(Fault& fault);
  /**
   * Destination parameter IDs written with weight ≥ 100 %, with the index
   * of the setting whose inputs drive them (the last one that writes each).
   */
  Vector<std::pair<String, std::size_t>> overwritten_parameters() const;

 private:
  struct ParticleState {
    double x = 0, y = 0, vx = 0, vy = 0, gx = 0, gy = 1;
  };
  struct OutputState {
    double cur = 0, prev = 0;
    int target = -1;
  };
  struct SettingState {
    const PhysicsSetting* setting = nullptr;
    Vector<ParticleState> particles;
    Vector<OutputState> outputs;
    Vector<int> sources;
  };
  double written(const PhysicsOutput& o, int target, double value, double current, double strength = 1) const;
  /** The outputs at interpolation factor λ between the last two steps, into the parameters. */
  void write_outputs(double lambda);
  /** The strength k of setting i: the rig's times the setting's. */
  double strength_of(std::size_t i) const { return strength * setting_strengths[i]; }
  bool step(double h, Fault& fault);
  /** The rig's shape, which a saved state must match, and the state's length. */
  Vector<int32_t> shape() const;
  std::size_t state_size() const;
  void inputs(const SettingState& s, const float* values, double& x, double& y, double& a) const;
  bool pendulum(SettingState& s, double rx, double ry, double a, double h, double wind_scale, Fault& fault);
  /** 3n.7: an output's value; false for an invalid vertex index, or with a fault. */
  bool output_value(const SettingState& s, const PhysicsOutput& o, double& value, bool& faulted, Fault& fault) const;

  const PhysicsFile* file_;
  AnimationValues* values_;
  Vector<SettingState> states_;
  double rho_ = 0;
  /** The interpolation factor of the last outputs written. */
  double lambda_ = 0;
  bool has_input_ = false;
  Vector<float> input_;
  Vector<float> work_;
  bool stepped_ = false;
};

}  // namespace mochi2d::framework

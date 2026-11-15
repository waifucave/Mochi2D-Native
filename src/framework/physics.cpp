#include "framework/physics.hpp"

#include <cmath>
#include <limits>

#include "fdlibm.hpp"
#include "util/text.hpp"

namespace mochi2d::framework {

namespace {

PhysicsKind kind_of(const json::Value* v) {
  const String s = str(v);
  if (v && v->is_string() && s == "Y") return PhysicsKind::Y;
  if (v && v->is_string() && s == "Angle") return PhysicsKind::Angle;
  return PhysicsKind::X;
}

Normalization norm(const json::Value* v) {
  return {num(member(v, "Minimum"), 0), num(member(v, "Default"), 0), num(member(v, "Maximum"), 0)};
}

/** Normalization N(v) of 3n.5. */
double normalize(double v, double pmin, double pmax, const Normalization& n, bool reflect) {
  const double lo = js_min(pmin, pmax);
  const double hi = js_max(pmin, pmax);
  const double x = js_min(js_max(v, lo), hi);
  const double mid = lo + std::fabs(hi - lo) / 2;
  const double n_lo = js_min(n.minimum, n.maximum);
  const double n_hi = js_max(n.minimum, n.maximum);
  const double n_def = n.default_value;
  const double d = x - mid;
  double r;
  if (d > 0)
    r = hi == mid ? 0 : d * ((n_hi - n_def) / (hi - mid)) + n_def;
  else if (d < 0)
    r = lo == mid ? 0 : d * ((n_lo - n_def) / (lo - mid)) + n_def;
  else
    r = n_def;
  return reflect ? r : -r;
}

bool type_error_read(Fault& fault) {
  fault.kind = "TypeError";
  fault.message = "Cannot read properties of undefined (reading 'x')";
  return false;
}

bool type_error_set(Fault& fault) {
  fault.kind = "TypeError";
  fault.message = "Cannot set properties of undefined (setting 'x')";
  return false;
}

}  // namespace

bool parse_physics(std::string_view bytes, std::string_view label, PhysicsFile& out, FormatError& error) {
  json::Value json;
  if (!parse_json(bytes, label, json, error)) return false;
  return physics_from_json(json, label, out, error);
}

bool physics_from_json(const json::Value& json, std::string_view label, PhysicsFile& out, FormatError& error) {
  const String lbl(label.data(), label.size());
  if (!json.is_object()) {
    error.message = lbl + ": not a JSON object";
    return false;
  }
  const json::Value* meta = member(&json, "Meta");
  PhysicsFile file;
  file.label = lbl;
  double inputs = 0, outputs = 0, vertices = 0;
  for (const auto& s : arr(member(&json, "PhysicsSettings"))) {
    PhysicsSetting set;
    set.id = str(member(&s, "Id"));
    for (const auto& i : arr(member(&s, "Input")))
      set.inputs.push_back({str(member(member(&i, "Source"), "Id")), num(member(&i, "Weight"), 0),
                            kind_of(member(&i, "Type")), boolean(member(&i, "Reflect"))});
    for (const auto& o : arr(member(&s, "Output")))
      set.outputs.push_back({str(member(member(&o, "Destination"), "Id")), num(member(&o, "VertexIndex"), 0),
                             num(member(&o, "Scale"), 0), num(member(&o, "Weight"), 0), kind_of(member(&o, "Type")),
                             boolean(member(&o, "Reflect"))});
    for (const auto& v : arr(member(&s, "Vertices"))) {
      const json::Value* p = member(&v, "Position");
      set.particles.push_back({num(member(p, "X"), 0), num(member(p, "Y"), 0), num(member(&v, "Mobility"), 0),
                               num(member(&v, "Delay"), 0), num(member(&v, "Acceleration"), 0),
                               num(member(&v, "Radius"), 0)});
    }
    const json::Value* n = member(&s, "Normalization");
    set.position = norm(member(n, "Position"));
    set.angle = norm(member(n, "Angle"));
    inputs += static_cast<double>(set.inputs.size());
    outputs += static_cast<double>(set.outputs.size());
    vertices += static_cast<double>(set.particles.size());
    file.settings.push_back(std::move(set));
  }
  // 3e.1: the Meta totals size the reader's storage; files that disagree are rejected.
  const std::pair<const char*, double> totals[] = {
      {"PhysicsSettingCount", static_cast<double>(file.settings.size())},
      {"TotalInputCount", inputs},
      {"TotalOutputCount", outputs},
      {"VertexCount", vertices},
  };
  for (const auto& [key, actual] : totals) {
    const double declared = num(member(meta, key), std::numeric_limits<double>::quiet_NaN());
    if (declared != actual) {
      error.message = lbl + ": Meta." + key + " is " + js_to_string(member(meta, key)) + ", but the file has " +
                      text::js_number(actual);
      return false;
    }
  }
  file.fps = num(member(meta, "Fps"), 0);
  for (const auto& d : arr(member(meta, "PhysicsDictionary")))
    file.names.push_back({str(member(&d, "Id")), str(member(&d, "Name"))});
  out = std::move(file);
  return true;
}

double angle_between(double ux, double uy, double wx, double wy) {
  double r = fdlibm::atan2(wy, wx) - fdlibm::atan2(uy, ux);
  if (r > kPi)
    r -= 2 * kPi;
  else if (r < -kPi)
    r += 2 * kPi;
  return r;
}

PhysicsRig::PhysicsRig(const PhysicsFile& file, AnimationValues& values)
    : setting_strengths(file.settings.size(), 1.0), setting_winds(file.settings.size(), 1.0), file_(&file), values_(&values), work_(values.values.size(), 0.0f) {
  for (const auto& s : file.settings) {
    SettingState st;
    st.setting = &s;
    // 3n.1: the root at its file position; particle i at (0, R₁ + … + Rᵢ).
    double sum = 0;
    for (std::size_t i = 0; i < s.particles.size(); i++) {
      const auto& p = s.particles[i];
      if (i > 0) sum += p.radius;
      ParticleState q;
      q.x = i == 0 ? p.x : 0;
      q.y = i == 0 ? p.y : sum;
      st.particles.push_back(q);
    }
    for (const auto& o : s.outputs) {
      OutputState os;
      os.target = values.index(o.destination);
      st.outputs.push_back(os);
    }
    for (const auto& in : s.inputs) st.sources.push_back(values.index(in.source));
    states_.push_back(std::move(st));
  }
}

Vector<std::pair<String, std::size_t>> PhysicsRig::overwritten_parameters() const {
  Vector<std::pair<String, std::size_t>> out;
  for (std::size_t k = 0; k < file_->settings.size(); k++)
    for (const auto& o : file_->settings[k].outputs)
      if (o.weight >= 100 && values_->index(o.destination) >= 0) {
        bool found = false;
        for (auto& e : out)
          if (e.first == o.destination) {
            e.second = k;
            found = true;
          }
        if (!found) out.emplace_back(o.destination, k);
      }
  return out;
}

/**
 * The write rule of 3n.7: scale, limit to the destination's range, blend by
 * the weight, giving r from the current value c. With a strength k ≠ 1 the
 * parameter becomes c + (r − c)·k instead: k = 0 leaves it at c exactly, and
 * above 1 the result is limited to the destination's range again.
 */
double PhysicsRig::written(const PhysicsOutput& o, int target, double value, double current, double strength) const {
  const auto t = static_cast<std::size_t>(target);
  const double sigma = o.type == PhysicsKind::Angle ? o.scale : 0;
  const double lo = values_->min[t];
  const double hi = values_->max[t];
  const double z = js_min(js_max(value * sigma, lo), hi);
  const double w = o.weight / 100;
  const double r = w >= 1 ? z : current * (1 - w) + z * w;
  if (strength == 1) return r;
  if (strength == 0) return current;
  const double e = current + (r - current) * strength;
  return strength > 1 ? js_min(js_max(e, lo), hi) : e;
}

void PhysicsRig::inputs(const SettingState& s, const float* values, double& x, double& y, double& a) const {
  const PhysicsSetting& set = *s.setting;
  x = 0;
  y = 0;
  a = 0;
  for (std::size_t k = 0; k < set.inputs.size(); k++) {
    const PhysicsInput& inp = set.inputs[k];
    const double w = inp.weight / 100;
    const int src = s.sources[k];
    const Normalization& n = inp.type == PhysicsKind::Angle ? set.angle : set.position;
    const auto si = static_cast<std::size_t>(src);
    const double value = src >= 0 ? normalize(values[si], values_->min[si], values_->max[si], n, inp.reflect)
                         : inp.reflect ? n.default_value
                                       : -n.default_value;
    if (inp.type == PhysicsKind::X)
      x += value * w;
    else if (inp.type == PhysicsKind::Y)
      y += value * w;
    else
      a += value * w;
  }
}

bool PhysicsRig::frame(double dt, Fault& fault) {
  if (dt <= 0) {
    if (hold_on_zero_steps && stepped_) write_outputs(lambda_);
    return true;
  }
  rho_ += dt;
  if (rho_ > 5) rho_ = 0;
  AnimationValues& values = *values_;
  if (!has_input_) {
    input_ = values.values;
    has_input_ = true;
  }
  const double fps = step_rate();
  // 0.16.0: an infinite rate (a file's 1e309) steps as without one.
  const double h = fps > 0 && fps < std::numeric_limits<double>::infinity() ? 1 / fps : dt;
  int steps = 0;
  while (rho_ >= h) {
    // 0.16.0 (not reference behavior): at most kMaxStepsPerFrame steps, then
    // the rest of the time is dropped but for the remainder (a rate so high
    // that the steps would never end).
    if (steps++ == kMaxStepsPerFrame) {
      rho_ = std::fmod(rho_, h);
      break;
    }
    if (!step(h, fault)) return false;
    rho_ -= h;
  }
  if (!stepped_) return true;
  lambda_ = rho_ / h;
  write_outputs(lambda_);
  return true;
}

Vector<int32_t> PhysicsRig::shape() const {
  Vector<int32_t> out;
  out.push_back(static_cast<int32_t>(states_.size()));
  for (const SettingState& s : states_) {
    out.push_back(static_cast<int32_t>(s.particles.size()));
    out.push_back(static_cast<int32_t>(s.outputs.size()));
  }
  out.push_back(static_cast<int32_t>(work_.size()));
  return out;
}

std::size_t PhysicsRig::state_size() const {
  std::size_t n = 4 + work_.size();
  for (const SettingState& s : states_) n += 6 * s.particles.size() + 2 * s.outputs.size();
  return n;
}

void PhysicsRig::save_state(PhysicsState& out) const {
  out.shape = shape();
  out.data.assign(state_size(), 0.0);
  double* d = out.data.data();
  d[0] = rho_;
  d[1] = lambda_;
  d[2] = stepped_ ? 1 : 0;
  d[3] = has_input_ ? 1 : 0;
  std::size_t k = 4;
  for (const SettingState& s : states_) {
    for (const ParticleState& p : s.particles) {
      d[k++] = p.x;
      d[k++] = p.y;
      d[k++] = p.vx;
      d[k++] = p.vy;
      d[k++] = p.gx;
      d[k++] = p.gy;
    }
    for (const OutputState& o : s.outputs) {
      d[k++] = o.cur;
      d[k++] = o.prev;
    }
  }
  if (has_input_)
    for (std::size_t i = 0; i < input_.size() && k + i < out.data.size(); i++) d[k + i] = input_[i];
}

bool PhysicsRig::restore_state(const PhysicsState& state) {
  if (state.shape != shape() || state.data.size() != state_size()) return false;
  const double* d = state.data.data();
  rho_ = d[0];
  lambda_ = d[1];
  stepped_ = d[2] == 1;
  std::size_t k = 4;
  for (SettingState& s : states_) {
    for (ParticleState& p : s.particles) {
      p.x = d[k++];
      p.y = d[k++];
      p.vx = d[k++];
      p.vy = d[k++];
      p.gx = d[k++];
      p.gy = d[k++];
    }
    for (OutputState& o : s.outputs) {
      o.cur = d[k++];
      o.prev = d[k++];
    }
  }
  has_input_ = d[3] == 1;
  if (has_input_) {
    input_.resize(work_.size());
    for (std::size_t i = 0; i < work_.size(); i++) input_[i] = static_cast<float>(d[k + i]);
  } else {
    input_.clear();
  }
  return true;
}

void PhysicsRig::write_outputs(double lambda) {
  AnimationValues& values = *values_;
  for (std::size_t i = 0; i < states_.size(); i++) {
    const SettingState& s = states_[i];
    const double k_strength = strength_of(i);
    for (std::size_t k = 0; k < s.setting->outputs.size(); k++) {
      const OutputState& st = s.outputs[k];
      if (st.target < 0) continue;
      const double v = st.prev * (1 - lambda) + st.cur * lambda;
      float& cur = values.values[static_cast<std::size_t>(st.target)];
      cur = static_cast<float>(written(s.setting->outputs[k], st.target, v, cur, k_strength));
    }
  }
}

bool PhysicsRig::step(double h, Fault& fault) {
  for (auto& s : states_)
    for (auto& o : s.outputs) o.prev = o.cur;
  // Input interpolation into the working copy (float32).
  const double u = h / rho_;
  const Vector<float>& v = values_->values;
  for (std::size_t j = 0; j < work_.size(); j++) {
    work_[j] = static_cast<float>(static_cast<double>(input_[j]) * (1 - u) + static_cast<double>(v[j]) * u);
    input_[j] = work_[j];
  }
  for (std::size_t si = 0; si < states_.size(); si++) {
    SettingState& s = states_[si];
    const double k_strength = strength_of(si);
    const PhysicsSetting& set = *s.setting;
    // a. Inputs.
    double x, y, a;
    inputs(s, work_.data(), x, y, a);
    // b. Rotation, with the rotated x in the second line.
    const double theta = (-a / 180) * kPi;
    const double xr = x * fdlibm::cos(theta) - y * fdlibm::sin(theta);
    const double yr = xr * fdlibm::sin(theta) + y * fdlibm::cos(theta);
    // c. Pendulum.
    if (!pendulum(s, xr, yr, a, h, setting_winds[si], fault)) return false;
    // d. Outputs.
    for (std::size_t k = 0; k < set.outputs.size(); k++) {
      OutputState& st = s.outputs[k];
      double value;
      bool faulted = false;
      if (!output_value(s, set.outputs[k], value, faulted, fault)) {
        if (faulted) return false;
        continue;
      }
      st.cur = value;
      if (st.target >= 0) {
        float& c = work_[static_cast<std::size_t>(st.target)];
        c = static_cast<float>(written(set.outputs[k], st.target, value, c, k_strength));
      }
    }
  }
  stepped_ = true;
  return true;
}

bool PhysicsRig::pendulum(SettingState& s, double rx, double ry, double a, double h, double wind_scale,
                          Fault& fault) {
  auto& p = s.particles;
  const PhysicsSetting& set = *s.setting;
  if (p.empty()) return type_error_set(fault);
  p[0].x = rx;
  p[0].y = ry;
  double gx = fdlibm::sin((a / 180) * kPi);
  double gy = fdlibm::cos((a / 180) * kPi);
  const double gl = std::sqrt(gx * gx + gy * gy);
  gx /= gl;
  gy /= gl;
  // The setting's wind: V times its multiplier (exactly V at 1).
  const double Vx = wind[0] * wind_scale;
  const double Vy = wind[1] * wind_scale;
  const double M = set.position.maximum;
  for (std::size_t i = 1; i < p.size(); i++) {
    const PhysicsParticle& cfg = set.particles[i];
    ParticleState& q = p[i];
    const ParticleState& prev = p[i - 1];
    const double Fx = gx * cfg.acceleration + Vx;
    const double Fy = gy * cfg.acceleration + Vy;
    const double last_x = q.x;
    const double last_y = q.y;
    const double k = cfg.delay * h * 30;
    const double rX = q.x - prev.x;
    const double rY = q.y - prev.y;
    const double psi = angle_between(q.gx, q.gy, gx, gy) / 5;
    const double rpx = fdlibm::cos(psi) * rX - rY * fdlibm::sin(psi);
    const double rpy = fdlibm::sin(psi) * rpx + rY * fdlibm::cos(psi);
    q.x = prev.x + rpx;
    q.y = prev.y + rpy;
    q.x = q.x + q.vx * k + Fx * k * k;
    q.y = q.y + q.vy * k + Fy * k * k;
    const double dx = q.x - prev.x;
    const double dy = q.y - prev.y;
    const double len = std::sqrt(dx * dx + dy * dy);
    // C16: normalize first, then scale by the radius.
    q.x = prev.x + (dx / len) * cfg.radius;
    q.y = prev.y + (dy / len) * cfg.radius;
    if (std::fabs(q.x) < 0.001 * M) q.x = 0;
    if (k != 0) {
      q.vx = ((q.x - last_x) / k) * cfg.mobility;
      q.vy = ((q.y - last_y) / k) * cfg.mobility;
    }
    q.gx = gx;
    q.gy = gy;
  }
  return true;
}

bool PhysicsRig::output_value(const SettingState& s, const PhysicsOutput& o, double& value, bool& faulted,
                              Fault& fault) const {
  const auto& p = s.particles;
  const double j = o.vertex_index;
  if (j < 1 || j >= static_cast<double>(p.size())) return false;
  if (std::floor(j) != j) {
    faulted = true;
    return type_error_read(fault);
  }
  const auto i = static_cast<std::size_t>(j);
  const double dx = p[i].x - p[i - 1].x;
  const double dy = p[i].y - p[i - 1].y;
  if (o.type == PhysicsKind::X) {
    value = dx;
  } else if (o.type == PhysicsKind::Y) {
    value = dy;
  } else {
    const double gx = i >= 2 ? p[i - 1].x - p[i - 2].x : -gravity[0];
    const double gy = i >= 2 ? p[i - 1].y - p[i - 2].y : -gravity[1];
    value = angle_between(gx, gy, dx, dy);
  }
  if (o.reflect) value = -value;
  return true;
}

bool PhysicsRig::settle(Fault& fault) {
  AnimationValues& values = *values_;
  Vector<float>& v = values.values;
  work_ = v;
  input_ = v;
  has_input_ = true;
  for (std::size_t si = 0; si < states_.size(); si++) {
    SettingState& s = states_[si];
    const double k_strength = strength_of(si);
    const double Vx = wind[0] * setting_winds[si];
    const double Vy = wind[1] * setting_winds[si];
    const PhysicsSetting& set = *s.setting;
    double x, y, a;
    inputs(s, v.data(), x, y, a);
    const double theta = (-a / 180) * kPi;
    const double xr = x * fdlibm::cos(theta) - y * fdlibm::sin(theta);
    const double yr = xr * fdlibm::sin(theta) + y * fdlibm::cos(theta);
    auto& p = s.particles;
    if (p.empty()) return type_error_set(fault);
    p[0].x = xr;
    p[0].y = yr;
    double gx = fdlibm::sin((a / 180) * kPi);
    double gy = fdlibm::cos((a / 180) * kPi);
    const double gl = std::sqrt(gx * gx + gy * gy);
    gx /= gl;
    gy /= gl;
    const double M = set.position.maximum;
    for (std::size_t i = 1; i < p.size(); i++) {
      const PhysicsParticle& cfg = set.particles[i];
      ParticleState& q = p[i];
      const ParticleState& prev = p[i - 1];
      const double Fx = gx * cfg.acceleration + Vx;
      const double Fy = gy * cfg.acceleration + Vy;
      const double fl = std::sqrt(Fx * Fx + Fy * Fy);
      q.vx = 0;
      q.vy = 0;
      q.x = prev.x + (Fx / fl) * cfg.radius;
      q.y = prev.y + (Fy / fl) * cfg.radius;
      if (std::fabs(q.x) < 0.001 * M) q.x = 0;
      q.gx = gx;
      q.gy = gy;
    }
    for (std::size_t k = 0; k < set.outputs.size(); k++) {
      OutputState& st = s.outputs[k];
      double value;
      bool faulted = false;
      if (!output_value(s, set.outputs[k], value, faulted, fault)) {
        if (faulted) return false;
        continue;
      }
      st.cur = value;
      st.prev = value;
      if (st.target >= 0) {
        const auto t = static_cast<std::size_t>(st.target);
        v[t] = static_cast<float>(written(set.outputs[k], st.target, value, v[t], k_strength));
        work_[t] = static_cast<float>(written(set.outputs[k], st.target, value, work_[t], k_strength));
      }
    }
  }
  stepped_ = true;
  lambda_ = 0;
  return true;
}

}  // namespace mochi2d::framework

#include "framework/motion.hpp"

#include <cmath>

#include "fdlibm.hpp"
#include "util/text.hpp"

namespace mochi2d::framework {

namespace {

String lbl(std::string_view label) { return String(label.data(), label.size()); }

bool fail(FormatError& e, String message) {
  e.message = std::move(message);
  return false;
}

}  // namespace

bool parse_motion(std::string_view bytes, std::string_view label, Motion& out, FormatError& error) {
  json::Value json;
  if (!parse_json(bytes, label, json, error)) return false;
  return motion_from_json(json, label, out, error);
}

bool motion_from_json(const json::Value& json, std::string_view label, Motion& out, FormatError& error) {
  if (!json.is_object()) return fail(error, lbl(label) + ": not a JSON object");
  const json::Value* meta = member(&json, "Meta");
  auto fade = [](const json::Value* v) {
    const auto x = opt_num(v);
    return !x || *x < 0 ? 1.0 : *x;
  };
  const auto& raw_curves = arr(member(&json, "Curves"));
  double segments = 0;
  double point_count = 0;
  Vector<MotionCurve> parsed;
  for (std::size_t k = 0; k < raw_curves.size(); k++) {
    const json::Value* cc = &raw_curves[k];
    const auto& n = arr(member(cc, "Segments"));
    const String where = lbl(label) + ": curve " + to_str(k) + ": ";
    for (const auto& v : n)
      if (!v.is_number()) return fail(error, where + "non-numeric segment data");
    if (n.size() < 2) return fail(error, where + "no first point");
    MotionCurve c;
    c.points.push_back(n[0].as_number());
    c.points.push_back(n[1].as_number());
    std::size_t i = 2;
    while (i < n.size()) {
      const double code = n[i].as_number();
      const std::size_t first = c.points.size() / 2 - 1;
      const std::size_t need = code == kBezier ? 6 : 2;
      if (code != kLinear && code != kBezier && code != kStepped && code != kInverseStepped)
        return fail(error, where + "unknown segment code " + text::js_number(code));
      if (i + need > n.size() - 1) return fail(error, where + "truncated segment");
      for (std::size_t j = 1; j <= need; j++) c.points.push_back(n[i + j].as_number());
      c.kinds.push_back(static_cast<uint8_t>(code));
      c.starts.push_back(static_cast<uint32_t>(first));
      i += need + 1;
    }
    segments += static_cast<double>(c.kinds.size());
    point_count += static_cast<double>(c.points.size() / 2);
    c.fade_in = opt_num(member(cc, "FadeInTime"));
    c.fade_out = opt_num(member(cc, "FadeOutTime"));
    c.target = str(member(cc, "Target"));
    c.kind = c.target == "Model"         ? CurveTarget::Model
             : c.target == "Parameter"   ? CurveTarget::Parameter
             : c.target == "PartOpacity" ? CurveTarget::PartOpacity
                                         : CurveTarget::Other;
    c.id = str(member(cc, "Id"));
    parsed.push_back(std::move(c));
  }
  auto check = [&](const char* key, double actual) {
    const double declared = num(member(meta, key), 0);
    if (declared != actual)
      return fail(error, lbl(label) + ": Meta." + key + " is " + text::js_number(declared) + ", but the file has " +
                             text::js_number(actual));
    return true;
  };
  if (!check("CurveCount", static_cast<double>(raw_curves.size()))) return false;
  if (!check("TotalSegmentCount", segments)) return false;
  if (!check("TotalPointCount", point_count)) return false;
  out = Motion();
  // 3c.2: leading Model curves, then Parameter curves, then PartOpacity
  // curves. The ranks are looked up in a plain object, so a target named
  // after an Object.prototype property ranks as a function: it is kept, and
  // comparisons with it are false.
  constexpr int kUnknown = -1, kPrototype = -2;
  int rank = 0;
  for (auto& c : parsed) {
    const int r = c.kind == CurveTarget::Model         ? 0
                  : c.kind == CurveTarget::Parameter   ? 1
                  : c.kind == CurveTarget::PartOpacity ? 2
                  : is_object_prototype_key(c.target)  ? kPrototype
                                                       : kUnknown;
    if (r == kUnknown) break;
    if (r >= 0 && rank >= 0 && r < rank) break;
    rank = r;
    out.curves.push_back(std::move(c));
  }
  out.ignored_curves = parsed.size() - out.curves.size();
  for (const auto& e : arr(member(&json, "UserData")))
    out.events.push_back({num(member(&e, "Time"), 0), str(member(&e, "Value"))});
  out.label = lbl(label);
  out.duration = num(member(meta, "Duration"), 0);
  out.fps = num(member(meta, "Fps"), 0);
  out.restricted = boolean(member(meta, "AreBeziersRestricted"));
  out.loop = boolean(member(meta, "Loop"));
  out.fade_in = fade(member(meta, "FadeInTime"));
  out.fade_out = fade(member(meta, "FadeOutTime"));
  return true;
}

namespace {

constexpr double kEps = 1e-5;

}  // namespace

double solve_bezier_parameter(double t0, double t1, double t2, double t3, double tau) {
  const double a3 = t3 - 3 * t2 + 3 * t1 - t0;
  const double a2 = 3 * t2 - 6 * t1 + 3 * t0;
  const double a1 = 3 * t1 - 3 * t0;
  const double a0 = t0 - tau;
  double s;
  if (std::fabs(a3) < kEps) {
    if (std::fabs(a2) < kEps)
      s = std::fabs(a1) < kEps ? -a0 : -a0 / a1;
    else
      s = -(a1 + std::sqrt(a1 * a1 - 4 * a2 * a0)) / (2 * a2);
  } else {
    const double b = a2 / a3;
    const double c = a1 / a3;
    const double d = a0 / a3;
    const double p = (3 * c - b * b) / 3;
    const double q = (2 * b * b * b - 9 * b * c + 27 * d) / 27;
    const double D = (q / 2) * (q / 2) + (p / 3) * (p / 3) * (p / 3);
    auto near = [](double x) { return std::fabs(x - 0.5) < 0.51; };
    if (D < 0) {
      const double m = -p / 3;
      const double r = std::sqrt(m * m * m);
      const double phi = fdlibm::acos(js_min(js_max(-q / (2 * r), -1), 1));
      const double k = 2 * fdlibm::cbrt(r);
      auto cand = [&](double j) { return k * fdlibm::cos((phi + 2 * kPi * j) / 3) - b / 3; };
      const double s0 = cand(0);
      if (near(s0)) {
        s = s0;
      } else {
        const double s1 = cand(1);
        s = near(s1) ? s1 : cand(2);
      }
    } else if (D == 0) {
      const double u = fdlibm::cbrt(-q / 2);
      const double first = 2 * u - b / 3;
      s = near(first) ? first : -u - b / 3;
    } else {
      const double root = std::sqrt(D);
      s = fdlibm::cbrt(root - q / 2) - fdlibm::cbrt(root + q / 2) - b / 3;
    }
  }
  return js_min(js_max(s, 0), 1);
}

double evaluate_curve(const MotionCurve& curve, double tau, bool restricted, std::optional<double> loop_length) {
  const auto& p = curve.points;
  const auto& kinds = curve.kinds;
  const auto& starts = curve.starts;
  for (std::size_t k = 0; k < kinds.size(); k++) {
    const uint8_t kind = kinds[k];
    const std::size_t i = starts[k];
    const std::size_t end = kind == kBezier ? i + 3 : i + 1;
    if (!(p[2 * end] > tau)) continue;
    const double t0 = p[2 * i];
    const double v0 = p[2 * i + 1];
    switch (kind) {
      case kLinear: {
        const double t1 = p[2 * end];
        const double v1 = p[2 * end + 1];
        const double s = js_max(0, (tau - t0) / (t1 - t0));
        return v0 + (v1 - v0) * s;
      }
      case kStepped:
        return v0;
      case kInverseStepped:
        return p[2 * end + 1];
      default: {
        const double t1 = p[2 * i + 2];
        const double v1 = p[2 * i + 3];
        const double t2 = p[2 * i + 4];
        const double v2 = p[2 * i + 5];
        const double t3 = p[2 * i + 6];
        const double v3 = p[2 * i + 7];
        const double s = restricted ? js_max(0, (tau - t0) / (t3 - t0)) : solve_bezier_parameter(t0, t1, t2, t3, tau);
        auto lerp = [s](double a, double b) { return a + (b - a) * s; };
        const double q1 = lerp(v0, v1);
        const double q2 = lerp(v1, v2);
        const double q3 = lerp(v2, v3);
        const double r1 = lerp(q1, q2);
        const double r2 = lerp(q2, q3);
        return lerp(r1, r2);
      }
    }
  }
  // No segment qualifies: τ at or after the last point (3k.2).
  const std::size_t last = p.size() / 2 - 1;
  const double t_last = p[2 * last];
  const double v_last = p[2 * last + 1];
  if (loop_length && !kinds.empty() && tau < *loop_length) {
    const double v_first = p[1];
    const uint8_t kind = kinds.back();
    if (kind == kStepped) return v_last;
    if (kind == kInverseStepped) return v_first;
    const double s = js_max(0, (tau - t_last) / (*loop_length - t_last));
    return v_last + (v_first - v_last) * s;
  }
  return v_last;
}

}  // namespace mochi2d::framework

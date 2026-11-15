#include "framework/motion_queue.hpp"

#include <cmath>

#include "fdlibm.hpp"
#include "framework/jsutil.hpp"

namespace mochi2d::framework {

double ease(double x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return 0.5 - 0.5 * fdlibm::cos(kPi * x);
}

MotionQueue::MotionQueue(const Vector<String>& eye_blink, const Vector<String>& lip_sync) {
  for (std::size_t i = 0; i < eye_blink.size() && i < 64; i++) blink_.push_back(eye_blink[i]);
  for (std::size_t i = 0; i < lip_sync.size() && i < 64; i++) lip_.push_back(lip_sync[i]);
  for (const auto& id : blink_) blink_set_.insert(id);
  for (const auto& id : lip_) lip_set_.insert(id);
}

bool MotionQueue::blink_allowed() const {
  if (entries_.empty()) return false;
  for (const auto& e : entries_)
    if (!(e.holding && e.blink_while_held)) return false;
  return true;
}

Vector<std::shared_ptr<const Motion>> MotionQueue::motions() const {
  Vector<std::shared_ptr<const Motion>> out;
  for (const auto& e : entries_) out.push_back(e.motion);
  return out;
}

bool MotionQueue::set_idle_weight(const String& id, double weight) {
  if (std::isnan(weight)) return false;
  const double w = js_min(1, js_max(0, weight));
  if (w == 1)
    idle_weights.erase(id);
  else
    idle_weights[id] = w;
  return true;
}

double MotionQueue::idle_weight(const String& id) const {
  const auto it = idle_weights.find(id);
  return it == idle_weights.end() ? 1 : it->second;
}

bool MotionQueue::start(std::shared_ptr<const Motion> motion, const MotionStart& opts) {
  const double priority = opts.priority.value_or(2);
  if (!accepts(priority) || !motion) return false;
  current_priority = priority;
  // 3l.2: every entry already queued is asked to fade out with its own F_out.
  for (auto& e : entries_) e.fade_out_requested = true;
  auto pick = [](const std::optional<double>& o, double file) { return o && *o >= 0 ? *o : file; };
  Entry en;
  en.ticket = ++last_ticket;
  en.idle = priority == 1;
  en.hold = opts.hold.value_or(false) && !opts.loop.value_or(false);
  en.blink_while_held = opts.blink_while_held.value_or(true);
  en.fade_in = pick(opts.fade_in, motion->fade_in);
  en.fade_out = pick(opts.fade_out, motion->fade_out);
  en.weight = opts.weight.value_or(1);
  en.offset = opts.offset.value_or(0);
  en.loop = opts.loop.value_or(false);
  en.loop_fade_in = opts.loop_fade_in.value_or(true);
  en.legacy = opts.legacy_loop.value_or(false);
  for (const auto& c : motion->curves) {
    if (c.kind == CurveTarget::Model)
      en.model.push_back(&c);
    else if (c.kind == CurveTarget::Parameter)
      en.parameters.push_back(&c);
    else if (c.kind == CurveTarget::PartOpacity)
      en.part_opacities.push_back(&c);
  }
  for (const auto* c : en.parameters) en.parameter_ids.insert(c->id);
  en.motion = std::move(motion);
  entries_.push_back(std::move(en));
  return true;
}

void MotionQueue::stop_all() {
  for (auto& en : entries_) end(en, MotionEndReason::Stopped);
  entries_.clear();
}

Vector<MotionEnded> MotionQueue::take_ends() {
  Vector<MotionEnded> r;
  r.swap(ended_);
  return r;
}

void MotionQueue::end(Entry& en, MotionEndReason reason) {
  if (en.ended) return;
  en.ended = true;
  ended_.push_back({en.ticket, en.motion, reason});
}

void MotionQueue::advance(double dt, AnimationValues& values, Vector<String>& events) {
  time += dt;
  const double T = time;
  Vector<Entry> kept;
  for (auto& en : entries_) {
    const Motion& m = *en.motion;
    // a. Setup at the first processing.
    if (!en.started) {
      en.started = true;
      en.s = T - en.offset;
      en.f = T;
      en.has_e = !(en.loop || en.hold || m.duration <= 0);
      en.e = en.has_e ? en.s + m.duration : 0;
    }
    // b. Weights.
    const double a_in = en.fade_in == 0 ? 1 : ease((T - en.f) / en.fade_in);
    const double a_out = en.fade_out == 0 || !en.has_e ? 1 : ease((en.e - T) / en.fade_out);
    const double w = en.weight * a_in * a_out;
    // c. Local time.
    double tau = js_max(0, T - en.s);
    double L;
    if (en.loop) {
      L = en.legacy ? m.duration : m.duration + 1 / m.fps;
      // The reference never ends this loop when a step changes nothing.
      if (L > 0)
        while (tau > L) {
          const double next = tau - L;
          if (next == tau) break;
          tau = next;
        }
    } else {
      L = m.duration;
      // A held motion stays at its last frame.
      if (en.hold && tau > L) tau = js_max(0, L);
    }
    std::optional<double> end_interval;
    if (en.loop && !en.legacy) end_interval = L;
    auto value = [&](const MotionCurve& c) { return evaluate_curve(c, tau, m.restricted, end_interval); };
    // d. Model curves.
    std::optional<double> b, l;
    for (const auto* c : en.model) {
      if (c->id == "EyeBlink")
        b = value(*c);
      else if (c->id == "LipSync")
        l = value(*c);
      else if (c->id == "Opacity")
        values.model_opacity = value(*c);
    }
    // Idle weights apply to idle motions only; a missing weight is 1 (unchanged arithmetic).
    const HashMap<String, double>* weights = en.idle && !idle_weights.empty() ? &idle_weights : nullptr;
    auto weight_of = [&](const String& id) -> const double* {
      if (!weights) return nullptr;
      const auto it = weights->find(id);
      return it == weights->end() ? nullptr : &it->second;
    };
    // e. Parameter curves.
    for (const auto* c : en.parameters) {
      const double* k = weight_of(c->id);
      if (k && *k == 0) continue;
      const double cur = values.get(c->id);
      double x = value(*c);
      if (b && blink_set_.count(c->id)) x = x * *b;
      if (l && lip_set_.count(c->id)) x = x + *l;
      if (values.wrap) {
        const int i = values.index(c->id);
        if (i >= 0 && values.repeat[static_cast<std::size_t>(i)])
          x = wrap_value(x, values.min[static_cast<std::size_t>(i)], values.max[static_cast<std::size_t>(i)]);
      }
      double w2 = w;
      if (c->fade_in || c->fade_out) {
        const double b_in = !c->fade_in ? a_in : *c->fade_in == 0 ? 1 : ease((T - en.f) / *c->fade_in);
        const double b_out = !c->fade_out ? a_out : *c->fade_out == 0 || !en.has_e ? 1 : ease((en.e - T) / *c->fade_out);
        w2 = en.weight * b_in * b_out;
      }
      values.set(c->id, cur + (x - cur) * (k ? w2 * *k : w2));
    }
    // f. Blink and lip-sync IDs without a curve.
    if (b)
      for (const auto& id : blink_)
        if (!en.parameter_ids.count(id)) {
          const double* k = weight_of(id);
          if (k && *k == 0) continue;
          const double cur = values.get(id);
          values.set(id, cur + (*b - cur) * (k ? w * *k : w));
        }
    if (l)
      for (const auto& id : lip_)
        if (!en.parameter_ids.count(id)) {
          const double* k = weight_of(id);
          if (k && *k == 0) continue;
          const double cur = values.get(id);
          values.set(id, cur + (*l - cur) * (k ? w * *k : w));
        }
    // g. PartOpacity curves: the value named by the ID, weight 1, no fading.
    for (const auto* c : en.part_opacities) values.set(c->id, value(*c));
    // h. End.
    bool finished = false;
    if (T - en.s >= L) {
      if (en.loop) {
        const double start = en.legacy ? T : T - tau;
        en.s = start;
        if (en.loop_fade_in) en.f = start;
      } else if (en.hold && !en.fade_out_requested) {
        en.holding = true;
        end(en, MotionEndReason::Finished);
      } else {
        finished = true;
      }
    }
    if (en.has_e && en.e < T) finished = true;
    // i. Events in (T_prev − s, T − s].
    for (const auto& ev : m.events)
      if (en.t_prev - en.s < ev.time && ev.time <= T - en.s) events.push_back(ev.value);
    en.t_prev = T;
    // j. Remove, or schedule the requested fade-out.
    if (finished) {
      end(en, en.fade_out_requested ? MotionEndReason::Replaced : MotionEndReason::Finished);
      continue;
    }
    if (en.fade_out_requested) {
      const double end_time = T + en.fade_out;
      if (!(en.has_e && en.e <= end_time)) {
        en.has_e = true;
        en.e = end_time;
      }
    }
    kept.push_back(std::move(en));
  }
  entries_.swap(kept);
  // Held motions at their end keep no priority (without holds: an empty queue).
  bool all_holding = true;
  for (const auto& en : entries_) all_holding = all_holding && en.holding;
  if (all_holding) current_priority = 0;
}

std::optional<double> MotionQueue::fade_out_of(uint32_t ticket) const {
  for (const auto& en : entries_)
    if (en.ticket == ticket) {
      if (en.fade_out_requested && !en.ended) return en.fade_out;
      return std::nullopt;
    }
  return std::nullopt;
}

}  // namespace mochi2d::framework

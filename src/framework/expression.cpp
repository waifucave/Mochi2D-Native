#include "framework/expression.hpp"

#include <limits>

#include "framework/motion_queue.hpp"

namespace mochi2d::framework {

bool parse_expression(std::string_view bytes, std::string_view label, Expression& out, FormatError& error) {
  json::Value json;
  if (!parse_json(bytes, label, json, error)) return false;
  return expression_from_json(json, label, out, error);
}

bool expression_from_json(const json::Value& json, std::string_view label, Expression& out, FormatError& error) {
  if (!json.is_object()) {
    error.message = String(label.data(), label.size()) + ": not a JSON object";
    return false;
  }
  out = Expression();
  out.label = String(label.data(), label.size());
  out.fade_in = opt_num(member(&json, "FadeInTime")).value_or(1);
  out.fade_out = opt_num(member(&json, "FadeOutTime")).value_or(1);
  for (const auto& p : arr(member(&json, "Parameters"))) {
    const String blend = str(member(&p, "Blend"));
    ExpressionParameter e;
    e.id = str(member(&p, "Id"));
    e.value = num(member(&p, "Value"), 0);
    e.blend = blend == "Multiply"    ? ExpressionBlend::Multiply
              : blend == "Overwrite" ? ExpressionBlend::Overwrite
                                     : ExpressionBlend::Add;
    out.parameters.push_back(std::move(e));
  }
  return true;
}

ExpressionContributions::ExpressionContributions(const Expression& e) {
  for (const auto& p : e.parameters)
    if (index_.emplace(p.id, list.size()).second) list.push_back(p);
}

const ExpressionParameter* ExpressionContributions::find(const String& id) const {
  const auto it = index_.find(id);
  return it == index_.end() ? nullptr : &list[it->second];
}

Vector<std::shared_ptr<const Expression>> ExpressionQueue::expressions() const {
  Vector<std::shared_ptr<const Expression>> out;
  for (const auto& e : entries_) out.push_back(e.expression);
  return out;
}

void ExpressionQueue::start(std::shared_ptr<const Expression> expression) {
  if (!expression) return;
  for (auto& e : entries_) e.fade_out_requested = true;
  ExpressionContributions by_id(*expression);
  entries_.push_back(Entry{std::move(expression), std::move(by_id)});
}

void ExpressionQueue::advance(double dt, AnimationValues& values) {
  time += dt;
  const double T = time;
  double S = 0;
  double newest_weight = 0;
  for (std::size_t k = 0; k < entries_.size(); k++) {
    Entry& en = entries_[k];
    // a. Track the entry's IDs.
    for (const auto& p : en.by_id.list)
      if (tracked_ids_.insert(p.id).second) tracked_.push_back({p.id, 0, 1, 0});
    // b. First processing.
    if (!en.started) {
      en.started = true;
      en.f = T;
      en.has_e = false;
    }
    // c. Weight.
    const Expression& ex = *en.expression;
    const double a_in = ex.fade_in == 0 ? 1 : ease((T - en.f) / ex.fade_in);
    const double a_out = !en.has_e || ex.fade_out == 0 ? 1 : ease((en.e - T) / ex.fade_out);
    const double w = a_in * a_out;
    newest_weight = w;
    // d. Contributions.
    for (auto& t : tracked_) {
      const double c = values.get(t.id);
      t.O = c;
      const ExpressionParameter* p = en.by_id.find(t.id);
      double a = 0, m = 1, o = c;
      if (p && p->blend == ExpressionBlend::Add)
        a = p->value;
      else if (p && p->blend == ExpressionBlend::Multiply)
        m = p->value;
      else if (p && p->blend == ExpressionBlend::Overwrite)
        o = p->value;
      if (k == 0) {
        t.A = a;
        t.M = m;
        t.O = o;
      } else {
        t.A = t.A * (1 - w) + a * w;
        t.M = t.M * (1 - w) + m * w;
        t.O = t.O * (1 - w) + o * w;
      }
    }
    // e. Sum of fade-ins.
    S += a_in;
    // f. Fade-out request.
    if (en.fade_out_requested) {
      const double end = T + ex.fade_out;
      if (!(en.has_e && en.e <= end)) {
        en.has_e = true;
        en.e = end;
      }
    }
  }
  // g. A fully faded-in newest entry replaces the older ones.
  if (entries_.size() >= 2 && newest_weight >= 1) entries_.erase(entries_.begin(), entries_.end() - 1);
  // h. Write.
  S = js_min(S, 1);
  for (auto& t : tracked_) {
    values.set(t.id, (t.O + t.A) * t.M, S);
    t.A = 0;
    t.M = 1;
  }
}

Vector<std::shared_ptr<const Expression>> ExpressionLayers::active() const {
  Vector<std::shared_ptr<const Expression>> out;
  for (const auto& l : layers_)
    if (!l.has_e) out.push_back(l.expression);
  return out;
}

Vector<std::shared_ptr<const Expression>> ExpressionLayers::all() const {
  Vector<std::shared_ptr<const Expression>> out;
  for (const auto& l : layers_) out.push_back(l.expression);
  return out;
}

bool ExpressionLayers::add(std::shared_ptr<const Expression> expression) {
  if (!expression) return false;
  for (const auto& l : layers_)
    if (!l.has_e && l.expression->label == expression->label) return false;
  ExpressionContributions by_id(*expression);
  const double out = expression->fade_out;
  Layer layer{std::move(expression), std::move(by_id)};
  layer.out = out;
  layers_.push_back(std::move(layer));
  return true;
}

std::size_t ExpressionLayers::remove(const String* label, const double* fade_out) {
  std::size_t n = 0;
  for (auto& l : layers_)
    if (!l.has_e && (!label || l.expression->label == *label)) {
      l.out = fade_out ? *fade_out : l.expression->fade_out;
      // Before its first processing it has no weight to fade from.
      l.has_e = true;
      l.e = !l.has_f ? -std::numeric_limits<double>::infinity() : time + l.out;
      n++;
    }
  return n;
}

void ExpressionLayers::advance(double dt, AnimationValues& values) {
  if (layers_.empty()) return;
  time += dt;
  const double T = time;
  Vector<Layer> kept;
  for (auto& l : layers_) {
    const Expression& ex = *l.expression;
    if (!l.has_f) {
      l.has_f = true;
      l.f = T;
    }
    if (l.has_e && l.e <= T) continue;
    const double a_in = ex.fade_in == 0 ? 1 : ease((T - l.f) / ex.fade_in);
    const double a_out = !l.has_e || l.out == 0 ? 1 : ease((l.e - T) / l.out);
    const double w = a_in * a_out;
    for (const auto& p : l.by_id.list) {
      const double v = values.get(p.id);
      if (p.blend == ExpressionBlend::Add)
        values.set(p.id, v + w * p.value);
      else if (p.blend == ExpressionBlend::Multiply)
        values.set(p.id, v * (1 + w * (p.value - 1)));
      else
        values.set(p.id, v + w * (p.value - v));
    }
    kept.push_back(std::move(l));
  }
  layers_.swap(kept);
}

}  // namespace mochi2d::framework

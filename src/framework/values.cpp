#include "framework/values.hpp"

#include <cmath>

#include "framework/jsutil.hpp"

namespace mochi2d::framework {

double wrap_value(double x, double lo, double hi) {
  const double L = hi - lo;
  auto m = [L](double d) { return d - std::floor(d / L) * L; };
  if (x > hi) {
    const double d = x - hi;
    return !std::isfinite(d) || L == 0 ? hi : lo + m(d);
  }
  if (x < lo) {
    const double d = lo - x;
    return !std::isfinite(d) || L == 0 ? lo : hi - m(d);
  }
  return x;
}

AnimationValues::AnimationValues(const moc::Model& model)
    : values(model.parameters.defaults),
      saved(model.parameters.defaults),
      min(model.parameters.min),
      max(model.parameters.max),
      repeat(model.parameters.repeat),
      part_opacities(model.parts.initial_opacity),
      ids_(&model.parameters.ids),
      part_ids_(&model.parts.ids) {
  for (std::size_t i = 0; i < ids_->size(); i++) index_by_id_.emplace((*ids_)[i], static_cast<int>(i));
  for (std::size_t i = 0; i < part_ids_->size(); i++) part_index_by_id_.emplace((*part_ids_)[i], static_cast<int>(i));
}

int AnimationValues::index(const String& id) const {
  const auto it = index_by_id_.find(id);
  return it == index_by_id_.end() ? -1 : it->second;
}

int AnimationValues::part_index(const String& id) const {
  const auto it = part_index_by_id_.find(id);
  return it == part_index_by_id_.end() ? -1 : it->second;
}

double AnimationValues::get(const String& id) const {
  const auto it = index_by_id_.find(id);
  if (it != index_by_id_.end()) return values[static_cast<std::size_t>(it->second)];
  const auto f = free.find(id);
  return f == free.end() ? 0 : f->second;
}

double AnimationValues::limit(int i, double x) const {
  const auto k = static_cast<std::size_t>(i);
  const double lo = min[k];
  const double hi = max[k];
  if (wrap && repeat[k]) return wrap_value(x, lo, hi);
  return js_min(js_max(x, lo), hi);
}

void AnimationValues::set_at(int i, double x, double w) {
  const double lim = limit(i, x);
  float& v = values[static_cast<std::size_t>(i)];
  v = static_cast<float>(w == 1 ? lim : static_cast<double>(v) * (1 - w) + lim * w);
}

void AnimationValues::set(const String& id, double x, double w) {
  const auto it = index_by_id_.find(id);
  if (it != index_by_id_.end()) {
    set_at(it->second, x, w);
    return;
  }
  auto f = free.find(id);
  const double c = f == free.end() ? 0 : f->second;
  const double v = w == 1 ? x : c * (1 - w) + x * w;
  if (f == free.end())
    free.emplace(id, v);
  else
    f->second = v;
}

void AnimationValues::add(const String& id, double x, double w) { set(id, get(id) + x * w); }

void AnimationValues::add_at(int i, double x, double w) {
  set_at(i, static_cast<double>(values[static_cast<std::size_t>(i)]) + x * w);
}

void AnimationValues::multiply(const String& id, double x, double w) { set(id, get(id) * (1 + (x - 1) * w)); }

void AnimationValues::restore() { values = saved; }

void AnimationValues::save() { saved = values; }

double AnimationValues::part_opacity(const String& id) const {
  const auto it = part_index_by_id_.find(id);
  if (it != part_index_by_id_.end()) return part_opacities[static_cast<std::size_t>(it->second)];
  const auto f = free_part_opacities.find(id);
  return f == free_part_opacities.end() ? 1 : f->second;
}

void AnimationValues::set_part_opacity(const String& id, double v) {
  const auto it = part_index_by_id_.find(id);
  if (it != part_index_by_id_.end()) {
    part_opacities[static_cast<std::size_t>(it->second)] = static_cast<float>(v);
    return;
  }
  free_part_opacities[id] = fround(v);
}

const double* AnimationValues::free_value(const String& id) const {
  const auto f = free.find(id);
  return f == free.end() ? nullptr : &f->second;
}

}  // namespace mochi2d::framework

#include "framework/tints.hpp"

#include <cmath>
#include <cstdio>

#include "framework/jsutil.hpp"

namespace mochi2d::framework {

void Tints::resize(std::size_t drawables) {
  rgba_.assign(4 * drawables, 1.0f);
  tinted_.assign(drawables, 0);
  if (count_) version_++;
  count_ = 0;
}

Tints::SetError Tints::set(int index, const double* rgba, int count, const char* id, String* message) {
  if (count != 3 && count != 4) {
    if (message) {
      char buf[96];
      std::snprintf(buf, sizeof buf, "a tint is [r, g, b] or [r, g, b, a], not %d numbers", count);
      *message = buf;
    }
    return SetError::Count;
  }
  for (int k = 0; k < count; k++)
    if (!std::isfinite(rgba[k])) {
      if (message) {
        const double x = rgba[k];
        *message = "tint of ";
        *message += id ? id : "";
        *message += ": ";
        *message += std::isnan(x) ? "NaN" : x > 0 ? "Infinity" : "-Infinity";
        *message += " is not a finite number";
      }
      return SetError::NotFinite;
    }
  if (index < 0 || static_cast<std::size_t>(index) >= tinted_.size()) return SetError::Unknown;
  const std::size_t d = static_cast<std::size_t>(index);
  for (int k = 0; k < 4; k++)
    rgba_[4 * d + static_cast<std::size_t>(k)] =
        static_cast<float>(js_min(k < 3 ? kMaxTint : 1, js_max(0, k < count ? rgba[k] : 1)));
  if (!tinted_[d]) {
    tinted_[d] = 1;
    count_++;
  }
  version_++;
  return SetError::Ok;
}

bool Tints::clear(int index) {
  if (index < 0 || static_cast<std::size_t>(index) >= tinted_.size()) return false;
  const std::size_t d = static_cast<std::size_t>(index);
  if (!tinted_[d]) return false;
  tinted_[d] = 0;
  count_--;
  for (std::size_t k = 0; k < 4; k++) rgba_[4 * d + k] = 1.0f;
  version_++;
  return true;
}

void Tints::clear_all() {
  if (count_ == 0) return;
  count_ = 0;
  for (auto& t : tinted_) t = 0;
  for (auto& v : rgba_) v = 1.0f;
  version_++;
}

bool Tints::has(int index) const {
  return index >= 0 && static_cast<std::size_t>(index) < tinted_.size() && tinted_[static_cast<std::size_t>(index)];
}

bool Tints::get(int index, float out[4]) const {
  if (!has(index)) return false;
  const std::size_t d = static_cast<std::size_t>(index);
  for (std::size_t k = 0; k < 4; k++) out[k] = rgba_[4 * d + k];
  return true;
}

Vector<int32_t> Tints::tinted() const {
  Vector<int32_t> out;
  for (std::size_t d = 0; d < tinted_.size(); d++)
    if (tinted_[d]) out.push_back(static_cast<int32_t>(d));
  return out;
}

}  // namespace mochi2d::framework

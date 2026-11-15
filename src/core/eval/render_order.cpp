// Port of Mochi2D's src/core/eval/render-order.ts (§1c.13): emit draw-order
// groups recursively, stable-sorting each group's objects by key. The key is
// the evaluated draw order, or the group minimum for an inactive object;
// keys outside the group's range sort by their value (C25, C12).
#include <algorithm>
#include <numeric>

#include "core/eval/instance.hpp"

namespace mochi2d::eval {

void Instance::compute_render_order() {
  int position = 0;
  if (!model_->groups.objects.empty()) emit_group(0, position);
}

void Instance::emit_group(int gi, int& position) {
  const auto& objects = model_->groups.objects[static_cast<std::size_t>(gi)];
  const int32_t min = model_->groups.min_draw_order[static_cast<std::size_t>(gi)];
  const std::size_t n = objects.size();
  Vector<int32_t> keys(n);
  for (std::size_t f = 0; f < n; f++) {
    const auto& o = objects[f];
    const auto idx = static_cast<std::size_t>(o.index);
    if (o.kind == 0)
      keys[f] = drawable_active[idx] ? drawable_draw_order[idx] : min;
    else
      keys[f] = part_active[idx] ? part_draw_order[idx] : min;
  }
  Vector<std::size_t> order(n);
  std::iota(order.begin(), order.end(), std::size_t{0});
  stable_sort(order, [&](std::size_t a, std::size_t b) { return keys[a] < keys[b]; });
  for (std::size_t f : order) {
    const auto& o = objects[f];
    if (o.kind == 0) {
      drawable_render_order[static_cast<std::size_t>(o.index)] = position++;
    } else {
      const int32_t off = model_->parts.offscreen[static_cast<std::size_t>(o.index)];
      if (off >= 0) offscreen_render_order[static_cast<std::size_t>(off)] = position++;
      emit_group(o.nested_group, position);
    }
  }
}

}  // namespace mochi2d::eval

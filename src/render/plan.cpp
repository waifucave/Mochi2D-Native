#include "render/plan.hpp"

#include "render/mask_matrix.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace mochi2d::render {

namespace {

using std::size_t;
constexpr int32_t kUnset = 0x7fffffff;
constexpr int32_t kDoubleSided = 4;
constexpr int32_t kInvertedMask = 8;

size_t Z(int64_t i) { return static_cast<size_t>(i); }

/** Math.max and Math.min of two numbers (NaN wins). */
double js_max(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  return a > b ? a : b;
}
double js_min(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  return a < b ? a : b;
}

int32_t color_part(int32_t code) { return code & 0xff; }
int32_t alpha_part(int32_t code) { return (code >> 8) & 0xff; }
bool compatible(int32_t code) {
  const int32_t c = color_part(code);
  return code == 0 || c == 1 || c == 2;
}
uint8_t compatible_mode(int32_t code) {
  const int32_t c = color_part(code);
  return c == 1 ? 1 : c == 2 ? 2 : 0;
}
uint8_t legacy_mode(int32_t flags) { return (flags & 1) ? 1 : (flags & 2) ? 2 : 0; }
BlendKind kind_of(uint8_t mode) {
  return mode == 1 ? BlendKind::Additive : mode == 2 ? BlendKind::Multiplicative : BlendKind::Normal;
}

bool self_or_ancestor(const Vector<int32_t>& parents, int32_t a, int32_t p) {
  for (int32_t q = p; q >= 0 && Z(q) < parents.size(); q = parents[Z(q)])
    if (q == a) return true;
  return false;
}

struct Box {
  double x0 = 0, y0 = 0, w = 0, h = 0;
};

/** masks.ts drawablesBox; with `quirk` the maxima start at the smallest positive double. */
Box drawables_box(const Vector<int32_t>& drawables, const Vector<Vector<float>>& vertices, bool quirk) {
  double min_x = std::numeric_limits<double>::infinity(), min_y = min_x;
  double max_x = quirk ? std::numeric_limits<double>::denorm_min() : -min_x, max_y = max_x;
  for (int32_t d : drawables) {
    const auto& v = vertices[Z(d)];
    for (size_t i = 0; i + 1 < v.size(); i += 2) {
      const double x = v[i], y = v[i + 1];
      if (x < min_x) min_x = x;
      if (x > max_x) max_x = x;
      if (y < min_y) min_y = y;
      if (y > max_y) max_y = y;
    }
  }
  return {min_x, min_y, max_x - min_x, max_y - min_y};
}

/** masks.ts maskMapping. */
MaskUse mask_mapping(const Box& box, double ppu, int size) {
  MaskUse m;
  const auto axis = [&](double origin, double extent, double& o, double& s) {
    if (extent * ppu <= size) {
      o = origin;
      s = ppu / size;
    } else {
      o = origin - 0.05 * extent;
      s = 1 / (1.1 * extent);
    }
  };
  axis(box.x0, box.w, m.ox, m.sx);
  axis(box.y0, box.h, m.oy, m.sy);
  return m;
}

MaskMapping mapping_of(const MaskUse& u) {
  MaskMapping m;
  m.ox = u.ox;
  m.oy = u.oy;
  m.sx = u.sx;
  m.sy = u.sy;
  return m;
}

/** Rows 0 and 1 of a row-major matrix. */
std::array<float, 8> rows_of(const Mat4& m) { return {m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7]}; }

/** The planner: ModelRenderer.draw's control flow, writing operations instead of GL calls. */
class Planner {
 public:
  Planner(const RenderModel& rm, const moc::Model& m, const eval::Instance& inst, const FrameOptions& frame,
          int mask_size, int offscreen_mask_size, const Vector<uint8_t>& has_texture, FramePlan& out)
      : rm_(rm), m_(m), inst_(inst), frame_(frame), size_(mask_size), offscreen_size_(offscreen_mask_size),
        has_texture_(has_texture), p_(out) {
    group_box_.assign(rm.drawable_groups.groups.size(), Box());
    group_map_.assign(rm.drawable_groups.groups.size(), MaskUse());
    group_mapped_.assign(rm.drawable_groups.groups.size(), 0);
    offscreen_box_.assign(rm.offscreen_groups.groups.size(), Box());
    offscreen_map_.assign(rm.offscreen_groups.groups.size(), MaskUse());
    offscreen_mapped_.assign(rm.offscreen_groups.groups.size(), 0);
  }

  void run() {
    const Framing& f = frame_.framing;
    p_.ops.clear();
    p_.mask_meshes.clear();
    p_.framing = f;
    p_.layered = rm_.layered;
    p_.layers = 0;
    p_.stats = FrameStats();
    p_.stats.layered = rm_.layered;
    const double sx = (2 * f.k) / f.width, sy = (2 * f.k) / f.height;
    p_.view = {sx, sy, -f.center_x * sx, -f.center_y * sy};
    // Render order positions: drawable d as d, offscreen o as −1 − o.
    const size_t N = m_.meshes.ids.size(), O = m_.offscreens.part.size();
    order_.assign(N + O, kUnset);
    for (size_t d = 0; d < N && d < inst_.drawable_render_order.size(); d++) {
      const int32_t pos = inst_.drawable_render_order[d];
      if (pos >= 0 && Z(pos) < order_.size()) order_[Z(pos)] = static_cast<int32_t>(d);
    }
    for (size_t o = 0; o < O && o < inst_.offscreen_render_order.size(); o++) {
      const int32_t pos = inst_.offscreen_render_order[o];
      if (pos >= 0 && Z(pos) < order_.size()) order_[Z(pos)] = -1 - static_cast<int32_t>(o);
    }
    RenderOp clear;
    clear.kind = RenderOp::Kind::Clear;
    const auto& b = frame_.background;
    clear.color = {b[0] * b[3], b[1] * b[3], b[2] * b[3], b[3]};
    p_.ops.push_back(clear);
    if (rm_.layered)
      layered();
    else
      direct();
  }

 private:
  void direct() {
    for (int32_t d : order_) {
      if (d < 0 || d == kUnset) continue;
      if (inst_.drawable_visible[Z(d)]) draw_mesh(d, -1, false);
    }
  }

  bool closes_layer(int32_t o, int32_t e) const {
    const auto& parents = m_.parts.parent;
    const int32_t owner = m_.offscreens.part[Z(o)];
    if (e < 0) {
      const int32_t next = m_.offscreens.part[Z(-1 - e)];
      return owner == next || !self_or_ancestor(parents, owner, next);
    }
    return !self_or_ancestor(parents, owner, m_.meshes.part[Z(e)]);
  }

  void open_layer(int32_t offscreen) {
    stack_.push_back(offscreen);
    const int32_t layer = static_cast<int32_t>(stack_.size()) - 1;
    p_.layers = std::max(p_.layers, layer + 1);
    RenderOp op;
    op.kind = RenderOp::Kind::OpenLayer;
    op.layer = layer;
    p_.ops.push_back(op);
  }

  void close_top() {
    const int32_t layer = static_cast<int32_t>(stack_.size()) - 1;
    const int32_t o = stack_.back();
    stack_.pop_back();
    composite_offscreen(o, layer, layer - 1);
  }

  void layered() {
    open_layer(-1);
    p_.stats.layers = 0;
    for (int32_t e : order_) {
      if (e == kUnset || (e >= 0 && !inst_.drawable_visible[Z(e)])) continue;
      while (stack_.back() >= 0 && closes_layer(stack_.back(), e)) close_top();
      if (e < 0) {
        open_layer(-1 - e);
        p_.stats.layers++;
        continue;
      }
      draw_mesh(e, static_cast<int32_t>(stack_.size()) - 1, true);
    }
    while (stack_.size() > 1) close_top();
    // L₀ over the destination: dst ← L₀ + (1 − L₀.a)·dst.
    RenderOp op;
    op.kind = RenderOp::Kind::Composite;
    op.layer = 0;
    op.target = -1;
    op.index = -1;
    op.blend = BlendKind::Normal;
    p_.ops.push_back(op);
    stack_.clear();
  }

  void draw_mesh(int32_t d, int32_t target, bool in_layer) {
    const size_t D = Z(d);
    const int32_t t = m_.meshes.texture[D];
    if (t < 0 || Z(t) >= has_texture_.size() || !has_texture_[Z(t)]) return;
    const float* tints = frame_.tints;
    const double opacity =
        tints ? static_cast<double>(inst_.drawable_opacity[D]) * static_cast<double>(tints[4 * D + 3])
              : static_cast<double>(inst_.drawable_opacity[D]);
    if (opacity == 0 || (tints && tints[4 * D + 3] == 0)) return;
    const int32_t code = m_.meshes.blend_mode[D];
    const bool advanced = rm_.layered && !compatible(code);
    RenderOp op;
    op.kind = RenderOp::Kind::DrawMesh;
    op.index = d;
    op.target = target;
    const int32_t g = rm_.drawable_groups.group_of[D];
    if (g >= 0) {
      op.mask = drawable_mask(g);
      op.mask.inverted = (m_.meshes.flags[D] & kInvertedMask) != 0;
      p_.stats.masked++;
    }
    if (advanced && in_layer) copy_destination(target);
    for (int c = 0; c < 3; c++) {
      op.multiply[Z(c)] = inst_.drawable_multiply[3 * D + Z(c)];
      op.screen[Z(c)] = inst_.drawable_screen[3 * D + Z(c)];
      op.tint[Z(c)] = tints ? tints[4 * D + Z(c)] : 1.0f;
    }
    op.opacity = static_cast<float>(opacity);
    if (advanced) {
      op.blend = BlendKind::Advanced;
      op.color_fn = color_part(code);
      op.alpha_mode = alpha_part(code);
      p_.stats.advanced_draws++;
    } else {
      op.blend = kind_of(rm_.blend_of[D]);
    }
    op.cull = (m_.meshes.flags[D] & kDoubleSided) == 0;
    p_.ops.push_back(op);
    p_.stats.drawn++;
  }

  void copy_destination(int32_t layer) {
    RenderOp op;
    op.kind = RenderOp::Kind::CopyDestination;
    op.target = layer;
    p_.ops.push_back(op);
  }

  void composite_offscreen(int32_t o, int32_t layer, int32_t below) {
    const size_t I = Z(o);
    RenderOp op;
    op.kind = RenderOp::Kind::Composite;
    op.layer = layer;
    op.target = below;
    op.index = o;
    const int32_t g = rm_.offscreen_groups.group_of[I];
    if (g >= 0) {
      op.mask = offscreen_mask(g);
      op.mask.inverted = (m_.offscreens.flags[I] & kInvertedMask) != 0;
      // Rule I: a layer's mask through D = A · V⁻¹ from the quad's clip-space corners.
      op.mask.matrix = rows_of(layer_mask_matrix(mapping_of(op.mask), view_matrix(p_.view)));
    }
    const int32_t code = m_.offscreens.blend_mode[I];
    if (!compatible(code)) {
      copy_destination(below);
      op.blend = BlendKind::Advanced;
      op.color_fn = color_part(code);
      op.alpha_mode = alpha_part(code);
      p_.stats.advanced_draws++;
    } else {
      op.blend = kind_of(compatible_mode(code));
    }
    for (int c = 0; c < 3; c++) {
      op.multiply[Z(c)] = inst_.offscreen_multiply[3 * I + Z(c)];
      op.screen[Z(c)] = inst_.offscreen_screen[3 * I + Z(c)];
    }
    op.opacity = inst_.offscreen_opacity[I];
    p_.ops.push_back(op);
  }

  MaskUse drawable_mask(int32_t g) {
    const size_t G = Z(g);
    if (!group_mapped_[G]) {
      group_box_[G] = drawables_box(rm_.drawable_groups.groups[G].members, inst_.drawable_vertices, true);
      group_map_[G] = mask_mapping(group_box_[G], m_.canvas.pixels_per_unit, size_);
      group_mapped_[G] = 1;
    }
    if (mask_holds_ != g) {
      build_mask(0, rm_.drawable_groups.groups[G].masks, group_map_[G], group_box_[G], size_);
      mask_holds_ = g;
    }
    MaskUse u = group_map_[G];
    u.buffer = 0;
    u.matrix = rows_of(mask_matrices(mapping_of(u)).texture);
    return u;
  }

  MaskUse offscreen_mask(int32_t g) {
    const size_t G = Z(g);
    if (!offscreen_mapped_[G]) {
      offscreen_box_[G] = drawables_box(rm_.offscreen_box_members[G], inst_.drawable_vertices, false);
      offscreen_map_[G] = mask_mapping(offscreen_box_[G], m_.canvas.pixels_per_unit, offscreen_size_);
      offscreen_mapped_[G] = 1;
    }
    if (offscreen_holds_ != g) {
      build_mask(1, rm_.offscreen_groups.groups[G].masks, offscreen_map_[G], offscreen_box_[G], offscreen_size_);
      offscreen_holds_ = g;
    }
    MaskUse u = offscreen_map_[G];
    u.buffer = 1;
    u.matrix = rows_of(mask_matrices(mapping_of(u)).texture);
    return u;
  }

  void build_mask(int8_t buffer, const Vector<int32_t>& masks, const MaskUse& map, const Box& box, int S) {
    RenderOp op;
    op.kind = RenderOp::Kind::BuildMask;
    op.buffer = buffer;
    op.size = S;
    const auto px = [&](double v, double o, double s) { return (v - o) * s * S; };
    const double x0 = js_max(0, std::floor(px(box.x0, map.ox, map.sx)) - 2);
    const double y0 = js_max(0, std::floor(px(box.y0, map.oy, map.sy)) - 2);
    const double x1 = js_min(S, std::ceil(px(box.x0 + box.w, map.ox, map.sx)) + 2);
    const double y1 = js_min(S, std::ceil(px(box.y0 + box.h, map.oy, map.sy)) + 2);
    const bool full = !(x1 > x0 && y1 > y0 && std::isfinite(x0 + x1 + y0 + y1));
    if (full)
      op.scissor = {0, 0, S, S};
    else
      op.scissor = {static_cast<int32_t>(x0), static_cast<int32_t>(y0), static_cast<int32_t>(x1 - x0),
                    static_cast<int32_t>(y1 - y0)};
    op.mask = map;
    op.mask.buffer = buffer;
    op.mask.matrix = rows_of(mask_matrices(mapping_of(map)).clip);
    op.first = static_cast<uint32_t>(p_.mask_meshes.size());
    for (int32_t mm : masks) {
      p_.mask_meshes.push_back(mm);
      const int32_t t = m_.meshes.texture[Z(mm)];
      if (t >= 0 && Z(t) < has_texture_.size() && has_texture_[Z(t)]) p_.stats.mask_mesh_draws++;
    }
    op.count = static_cast<uint32_t>(masks.size());
    p_.ops.push_back(op);
    p_.stats.mask_builds++;
  }

  const RenderModel& rm_;
  const moc::Model& m_;
  const eval::Instance& inst_;
  const FrameOptions& frame_;
  int size_, offscreen_size_;
  const Vector<uint8_t>& has_texture_;
  FramePlan& p_;
  Vector<int32_t> order_;
  Vector<int32_t> stack_;
  Vector<Box> group_box_, offscreen_box_;
  Vector<MaskUse> group_map_, offscreen_map_;
  Vector<uint8_t> group_mapped_, offscreen_mapped_;
  int32_t mask_holds_ = kUnset, offscreen_holds_ = kUnset;
};

}  // namespace

MaskGrouping mask_groups(const Vector<Vector<int32_t>>& lists) {
  MaskGrouping out;
  out.group_of.assign(lists.size(), -1);
  Vector<Vector<int32_t>> keys;
  for (size_t i = 0; i < lists.size(); i++) {
    const auto& list = lists[i];
    if (list.empty()) continue;
    Vector<int32_t> key(list.begin(), list.end());
    std::sort(key.begin(), key.end());
    key.erase(std::unique(key.begin(), key.end()), key.end());
    size_t g = 0;
    while (g < keys.size() && keys[g] != key) g++;
    if (g == keys.size()) {
      keys.push_back(std::move(key));
      MaskGrouping::Group group;
      group.masks.assign(list.begin(), list.end());
      out.groups.push_back(std::move(group));
    }
    out.groups[g].members.push_back(static_cast<int32_t>(i));
    out.group_of[i] = static_cast<int32_t>(g);
  }
  return out;
}

RenderModel::RenderModel(const moc::Model& m) {
  const size_t N = m.meshes.ids.size();
  for (size_t i = 0; i < N; i++) triangles.push_back(eval::output_triangles(m, static_cast<int>(i)));
  uvs.resize(N);
  for (size_t i = 0; i < N; i++) sampled_uvs(m.meshes.uvs[i].data(), m.meshes.uvs[i].size(), uvs[i]);
  layered = !m.offscreens.part.empty();
  for (int32_t c : m.meshes.blend_mode) layered = layered || !compatible(c);
  for (size_t i = 0; i < N; i++)
    blend_of.push_back(layered ? compatible_mode(m.meshes.blend_mode[i]) : legacy_mode(m.meshes.flags[i]));
  drawable_groups = mask_groups(m.meshes.masks);
  offscreen_groups = mask_groups(m.offscreens.masks);
  for (const auto& g : offscreen_groups.groups) {
    Vector<uint8_t> in(N, 0);
    for (int32_t o : g.members) {
      const int32_t owner = m.offscreens.part[Z(o)];
      for (size_t d = 0; d < N; d++)
        if (self_or_ancestor(m.parts.parent, owner, m.meshes.part[d])) in[d] = 1;
    }
    Vector<int32_t> members;
    for (size_t d = 0; d < N; d++)
      if (in[d]) members.push_back(static_cast<int32_t>(d));
    offscreen_box_members.push_back(std::move(members));
  }
}

void plan_frame(const RenderModel& rm, const moc::Model& model, const eval::Instance& instance,
                const FrameOptions& frame, int mask_size, int offscreen_mask_size, const Vector<uint8_t>& has_texture,
                FramePlan& out) {
  Planner(rm, model, instance, frame, mask_size, offscreen_mask_size, has_texture, out).run();
}

}  // namespace mochi2d::render

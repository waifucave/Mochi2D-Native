#include "core/snapshot.hpp"

namespace mochi2d {

using json::Value;

Vector<String> apply_request(eval::Instance& inst, const EvaluationRequest& request) {
  const auto& m = inst.model();
  Vector<String> warnings;
  for (std::size_t i = 0; i < m.parameters.ids.size(); i++)
    inst.set_parameter(static_cast<int>(i), m.parameters.defaults[i]);
  for (std::size_t i = 0; i < m.parts.ids.size(); i++) inst.set_part_opacity(static_cast<int>(i), m.parts.initial_opacity[i]);
  for (const auto& [id, value] : request.parameters) {
    const int i = inst.parameter_index(id);
    if (i < 0)
      warnings.push_back("unknown parameter " + id);
    else
      inst.set_parameter(i, value);
  }
  for (const auto& [id, value] : request.part_opacities) {
    const int i = inst.part_index(id);
    if (i < 0)
      warnings.push_back("unknown part " + id);
    else
      inst.set_part_opacity(i, value);
  }
  return warnings;
}

namespace {

Value rgba(const Vector<float>& a, std::size_t i) {
  Value v = Value::array();
  v.push(a[i * 3]);
  v.push(a[i * 3 + 1]);
  v.push(a[i * 3 + 2]);
  v.push(1);
  return v;
}

}  // namespace

void snapshot_into(const eval::Instance& inst, Value& out) {
  const auto& m = inst.model();
  Value canvas = Value::object();
  canvas.set("width", m.canvas.width);
  canvas.set("height", m.canvas.height);
  canvas.set("originX", m.canvas.origin_x);
  canvas.set("originY", m.canvas.origin_y);
  canvas.set("pixelsPerUnit", m.canvas.pixels_per_unit);
  out.set("canvas", std::move(canvas));
  Value params = Value::array();
  for (std::size_t i = 0; i < m.parameters.ids.size(); i++) {
    Value p = Value::object();
    p.set("id", m.parameters.ids[i]);
    p.set("value", inst.parameter_values[i]);
    params.push(std::move(p));
  }
  out.set("parameters", std::move(params));
  Value parts = Value::array();
  for (std::size_t i = 0; i < m.parts.ids.size(); i++) {
    Value p = Value::object();
    p.set("id", m.parts.ids[i]);
    p.set("opacity", inst.part_opacities[i]);
    parts.push(std::move(p));
  }
  out.set("parts", std::move(parts));
  Value drawables = Value::array();
  for (std::size_t i = 0; i < m.meshes.ids.size(); i++) {
    Value d = Value::object();
    d.set("id", m.meshes.ids[i]);
    d.set("visible", inst.drawable_visible[i] == 1);
    d.set("opacity", inst.drawable_opacity[i]);
    d.set("drawOrder", inst.drawable_draw_order[i]);
    d.set("renderOrder", inst.drawable_render_order[i]);
    d.set("multiplyColor", rgba(inst.drawable_multiply, i));
    d.set("screenColor", rgba(inst.drawable_screen, i));
    Value verts = Value::array();
    verts.items().reserve(inst.drawable_vertices[i].size());
    for (float x : inst.drawable_vertices[i]) verts.push(x);
    d.set("vertices", std::move(verts));
    drawables.push(std::move(d));
  }
  out.set("drawables", std::move(drawables));
  if (m.version >= 6) {
    Value offs = Value::array();
    for (std::size_t o = 0; o < m.offscreens.part.size(); o++) {
      Value v = Value::object();
      v.set("index", static_cast<long long>(o));
      v.set("ownerPart", m.parts.ids[static_cast<std::size_t>(m.offscreens.part[o])]);
      v.set("opacity", inst.offscreen_opacity[o]);
      v.set("renderOrder", inst.offscreen_render_order[o]);
      v.set("multiplyColor", rgba(inst.offscreen_multiply, o));
      v.set("screenColor", rgba(inst.offscreen_screen, o));
      offs.push(std::move(v));
    }
    out.set("offscreens", std::move(offs));
  }
}

}  // namespace mochi2d

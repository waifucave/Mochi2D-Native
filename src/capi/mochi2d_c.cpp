// The C API over the core and framework libraries. The libraries are built
// without exceptions: every failure is a status. Each handle keeps the
// allocator it was created with, and every call works inside a HeapScope of
// it, so all allocations for the object go to its allocator.
#include "mochi2d.h"

#include <algorithm>

#include "capi/internal.hpp"
#include "core/moc/io.hpp"
#include "core/snapshot.hpp"
#include "framework/model_data.hpp"
#include "util/json.hpp"

m2d_instance::~m2d_instance() { destroy(inst); }

namespace capi {

m2d_model* wrap_model(std::shared_ptr<const moc::Model> model, const Heap& heap) {
  m2d_model* h = create<m2d_model>();
  h->heap = heap;
  h->model = std::move(model);
  const auto& m = *h->model;
  h->vertex_offsets.push_back(0);
  for (std::size_t i = 0; i < m.meshes.ids.size(); i++) {
    h->vertex_offsets.push_back(h->vertex_offsets.back() + m.meshes.vertex_count[i]);
    h->uvs.push_back(eval::output_uvs(m, static_cast<int>(i)));
    h->indices.push_back(eval::output_triangles(m, static_cast<int>(i)));
    h->drawable_index.emplace(m.meshes.ids[i], static_cast<int32_t>(i));
  }
  return h;
}

}  // namespace capi

extern "C" {

uint32_t m2d_version(void) {
  return (static_cast<uint32_t>(M2D_VERSION_MAJOR) << 16) | (static_cast<uint32_t>(M2D_VERSION_MINOR) << 8) |
         static_cast<uint32_t>(M2D_VERSION_PATCH);
}

void m2d_free_string(char* s) { deallocate_bytes(s); }

m2d_status m2d_validate_moc(const void* bytes, size_t size, m2d_level level, const m2d_allocator* allocator,
                            int32_t* valid, char** report_json, m2d_error* error) {
  if (report_json) *report_json = nullptr;
  if (!bytes && size) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "bytes is NULL");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  {
    const auto v = moc::validate_moc(static_cast<const uint8_t*>(bytes), size,
                                     level == M2D_LEVEL_OFFICIAL ? moc::Level::Official : moc::Level::Strict);
    if (valid) *valid = v.valid ? 1 : 0;
    if (report_json) {
      json::Value r = json::Value::object();
      r.set("valid", v.valid);
      r.set("version", v.version ? json::Value(v.version) : json::Value(nullptr));
      json::Value list = json::Value::array();
      for (const auto& d : v.diagnostics) {
        json::Value x = json::Value::object();
        x.set("code", d.code);
        x.set("severity", d.warning ? "warning" : "error");
        x.set("kind", d.kind);
        if (d.index) x.set("index", *d.index);
        if (d.field) x.set("field", *d.field);
        x.set("message", d.message);
        list.push(std::move(x));
      }
      r.set("diagnostics", std::move(list));
      *report_json = dup_string(json::write_compact(r));
      if (!*report_json) {
        set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
        return M2D_OUT_OF_MEMORY;
      }
    }
    return M2D_OK;
  }
}

m2d_status m2d_model_load(const void* bytes, size_t size, uint32_t flags, const m2d_allocator* allocator,
                          m2d_model** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!out || (!bytes && size)) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  {
    moc::LoadOptions opts;
    opts.reject_draw_order_range = (flags & M2D_LOAD_STRICT_DRAW_ORDERS) != 0;
    opts.load_non_finite_opacity = (flags & M2D_LOAD_NON_FINITE_OPACITY) != 0;
    opts.load_offscreen_keyform_range = (flags & M2D_LOAD_OFFSCREEN_KEYFORM_RANGE) != 0;
    auto model = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
    moc::Error err;
    if (!moc::load_moc(static_cast<const uint8_t*>(bytes), size, opts, *model, err)) {
      set_error(error, M2D_FORMAT_ERROR, err.code.c_str(), err.message.c_str());
      return M2D_FORMAT_ERROR;
    }
    *out = wrap_model(std::move(model), heap);
    return M2D_OK;
  }
}


void m2d_model_destroy(m2d_model* model) {
  if (!model) return;
  HeapScope scope(&model->heap);
  destroy(model);
}

int32_t m2d_model_file_version(const m2d_model* model) { return M(model) ? M(model)->version : 0; }

m2d_status m2d_model_canvas(const m2d_model* model, float out[5], uint32_t* flags) {
  const auto* m = M(model);
  if (!m || !out) return M2D_INVALID_ARGUMENT;
  out[0] = m->canvas.width;
  out[1] = m->canvas.height;
  out[2] = m->canvas.origin_x;
  out[3] = m->canvas.origin_y;
  out[4] = m->canvas.pixels_per_unit;
  if (flags) *flags = m->canvas.flags;
  return M2D_OK;
}

int32_t m2d_model_warning_count(const m2d_model* model) {
  return M(model) ? static_cast<int32_t>(M(model)->load_warnings.size()) : 0;
}
const char* m2d_model_warning(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->load_warnings.size()) ? m->load_warnings[static_cast<std::size_t>(i)].c_str() : nullptr;
}

int32_t m2d_model_parameter_count(const m2d_model* model) {
  return M(model) ? static_cast<int32_t>(M(model)->parameters.ids.size()) : 0;
}
const char* m2d_model_parameter_id(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->parameters.ids.size()) ? m->parameters.ids[static_cast<std::size_t>(i)].c_str() : nullptr;
}
m2d_status m2d_model_parameter_range(const m2d_model* model, int32_t i, float out[3]) {
  const auto* m = M(model);
  if (!m || !out || !in(i, m->parameters.ids.size())) return M2D_INVALID_ARGUMENT;
  const auto k = static_cast<std::size_t>(i);
  out[0] = m->parameters.min[k];
  out[1] = m->parameters.max[k];
  out[2] = m->parameters.defaults[k];
  return M2D_OK;
}
int32_t m2d_model_parameter_repeats(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->parameters.ids.size()) ? m->parameters.repeat[static_cast<std::size_t>(i)] : 0;
}
int32_t m2d_model_parameter_type(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->parameters.ids.size()) ? m->parameters.type[static_cast<std::size_t>(i)] : 0;
}
int32_t m2d_model_parameter_index(const m2d_model* model, const char* id) {
  const auto* m = M(model);
  if (!m || !id) return -1;
  for (std::size_t i = 0; i < m->parameters.ids.size(); i++)
    if (m->parameters.ids[i] == id) return static_cast<int32_t>(i);
  return -1;
}

int32_t m2d_model_part_count(const m2d_model* model) {
  return M(model) ? static_cast<int32_t>(M(model)->parts.ids.size()) : 0;
}
const char* m2d_model_part_id(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->parts.ids.size()) ? m->parts.ids[static_cast<std::size_t>(i)].c_str() : nullptr;
}
int32_t m2d_model_part_parent(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->parts.ids.size()) ? m->parts.parent[static_cast<std::size_t>(i)] : -1;
}
int32_t m2d_model_part_index(const m2d_model* model, const char* id) {
  const auto* m = M(model);
  if (!m || !id) return -1;
  for (std::size_t i = 0; i < m->parts.ids.size(); i++)
    if (m->parts.ids[i] == id) return static_cast<int32_t>(i);
  return -1;
}

int32_t m2d_model_drawable_count(const m2d_model* model) {
  return M(model) ? static_cast<int32_t>(M(model)->meshes.ids.size()) : 0;
}
const char* m2d_model_drawable_id(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->meshes.ids.size()) ? m->meshes.ids[static_cast<std::size_t>(i)].c_str() : nullptr;
}
int32_t m2d_model_drawable_index(const m2d_model* model, const char* id) {
  if (!M(model) || !id) return -1;
  auto it = model->drawable_index.find(id);
  return it == model->drawable_index.end() ? -1 : it->second;
}
int32_t m2d_model_drawable_texture(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->meshes.ids.size()) ? m->meshes.texture[static_cast<std::size_t>(i)] : -1;
}
int32_t m2d_model_drawable_blend_mode(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->meshes.ids.size()) ? m->meshes.blend_mode[static_cast<std::size_t>(i)] : 0;
}
uint32_t m2d_model_drawable_flags(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->meshes.ids.size()) ? m->meshes.flags[static_cast<std::size_t>(i)] : 0;
}
int32_t m2d_model_drawable_vertex_count(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->meshes.ids.size()) ? m->meshes.vertex_count[static_cast<std::size_t>(i)] : 0;
}
const float* m2d_model_drawable_uvs(const m2d_model* model, int32_t i) {
  return M(model) && in(i, model->uvs.size()) ? model->uvs[static_cast<std::size_t>(i)].data() : nullptr;
}
const float* m2d_model_drawable_texture_uvs(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->meshes.uvs.size()) ? m->meshes.uvs[static_cast<std::size_t>(i)].data() : nullptr;
}
int32_t m2d_model_drawable_index_count(const m2d_model* model, int32_t i) {
  return M(model) && in(i, model->indices.size()) ? static_cast<int32_t>(model->indices[static_cast<std::size_t>(i)].size())
                                                  : 0;
}
const uint16_t* m2d_model_drawable_indices(const m2d_model* model, int32_t i) {
  return M(model) && in(i, model->indices.size()) ? model->indices[static_cast<std::size_t>(i)].data() : nullptr;
}
int32_t m2d_model_drawable_mask_count(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->meshes.ids.size()) ? static_cast<int32_t>(m->meshes.masks[static_cast<std::size_t>(i)].size()) : 0;
}
const int32_t* m2d_model_drawable_masks(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->meshes.ids.size()) ? m->meshes.masks[static_cast<std::size_t>(i)].data() : nullptr;
}
int32_t m2d_model_offscreen_count(const m2d_model* model) {
  return M(model) ? static_cast<int32_t>(M(model)->offscreens.part.size()) : 0;
}
int32_t m2d_model_offscreen_owner(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->offscreens.part.size()) ? m->offscreens.part[static_cast<std::size_t>(i)] : -1;
}

void m2d_instance_options_default(m2d_instance_options* options) {
  if (!options) return;
  options->incremental = 1;
  options->glue = 1;
  options->blend_shapes = 1;
}

m2d_status m2d_instance_create(m2d_model* model, m2d_instance** out, m2d_error* error) {
  return m2d_instance_create_with_options(model, nullptr, out, error);
}

m2d_status m2d_instance_create_with_options(m2d_model* model, const m2d_instance_options* options,
                                            m2d_instance** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!M(model) || !out) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  HeapScope scope(&model->heap);
  {
    m2d_instance* h = create<m2d_instance>();
    h->heap = model->heap;
    eval::InstanceOptions o;
    if (options) {
      o.incremental = options->incremental != 0;
      o.glue = options->glue != 0;
      o.blend_shapes = options->blend_shapes != 0;
    }
    h->inst = create<eval::Instance>(model->model, o);
    h->tints.resize(model->model->meshes.ids.size());
    *out = h;
    return M2D_OK;
  }
}

void m2d_instance_destroy(m2d_instance* instance) {
  if (!instance) return;
  HeapScope scope(&instance->heap);
  destroy(instance);
}

m2d_status m2d_instance_set_parameter(m2d_instance* instance, int32_t index, float value) {
  auto* inst = Im(instance);
  if (!inst || !in(index, inst->parameter_values.size())) return M2D_INVALID_ARGUMENT;
  inst->set_parameter(index, value);
  return M2D_OK;
}
float m2d_instance_parameter(const m2d_instance* instance, int32_t index) {
  const auto* inst = I(instance);
  return inst && in(index, inst->parameter_values.size()) ? inst->parameter_values[static_cast<std::size_t>(index)] : 0.0f;
}
m2d_status m2d_instance_set_part_opacity(m2d_instance* instance, int32_t index, float value) {
  auto* inst = Im(instance);
  if (!inst || !in(index, inst->part_opacities.size())) return M2D_INVALID_ARGUMENT;
  inst->set_part_opacity(index, value);
  return M2D_OK;
}
float m2d_instance_part_opacity(const m2d_instance* instance, int32_t index) {
  const auto* inst = I(instance);
  return inst && in(index, inst->part_opacities.size()) ? inst->part_opacities[static_cast<std::size_t>(index)] : 0.0f;
}

m2d_status m2d_instance_evaluate(m2d_instance* instance, m2d_error* error) {
  auto* inst = Im(instance);
  if (!inst) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL instance");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  HeapScope scope(&instance->heap);
  {
    inst->evaluate();
    return M2D_OK;
  }
}

int32_t m2d_instance_drawable_visible(const m2d_instance* instance, int32_t i) {
  const auto* inst = I(instance);
  return inst && in(i, inst->drawable_visible.size()) ? inst->drawable_visible[static_cast<std::size_t>(i)] : 0;
}
float m2d_instance_drawable_opacity(const m2d_instance* instance, int32_t i) {
  const auto* inst = I(instance);
  return inst && in(i, inst->drawable_opacity.size()) ? inst->drawable_opacity[static_cast<std::size_t>(i)] : 0.0f;
}
int32_t m2d_instance_drawable_draw_order(const m2d_instance* instance, int32_t i) {
  const auto* inst = I(instance);
  return inst && in(i, inst->drawable_draw_order.size()) ? inst->drawable_draw_order[static_cast<std::size_t>(i)] : 0;
}
int32_t m2d_instance_drawable_render_order(const m2d_instance* instance, int32_t i) {
  const auto* inst = I(instance);
  return inst && in(i, inst->drawable_render_order.size()) ? inst->drawable_render_order[static_cast<std::size_t>(i)] : 0;
}
m2d_status m2d_instance_drawable_colors(const m2d_instance* instance, int32_t i, float multiply[3], float screen[3]) {
  const auto* inst = I(instance);
  if (!inst || !in(i, inst->drawable_opacity.size())) return M2D_INVALID_ARGUMENT;
  for (std::size_t c = 0; c < 3; c++) {
    if (multiply) multiply[c] = inst->drawable_multiply[static_cast<std::size_t>(i) * 3 + c];
    if (screen) screen[c] = inst->drawable_screen[static_cast<std::size_t>(i) * 3 + c];
  }
  return M2D_OK;
}
const float* m2d_instance_drawable_vertices(const m2d_instance* instance, int32_t i) {
  const auto* inst = I(instance);
  return inst && in(i, inst->drawable_vertices.size()) ? inst->drawable_vertices[static_cast<std::size_t>(i)].data() : nullptr;
}
float m2d_instance_offscreen_opacity(const m2d_instance* instance, int32_t i) {
  const auto* inst = I(instance);
  return inst && in(i, inst->offscreen_opacity.size()) ? inst->offscreen_opacity[static_cast<std::size_t>(i)] : 0.0f;
}
int32_t m2d_instance_offscreen_render_order(const m2d_instance* instance, int32_t i) {
  const auto* inst = I(instance);
  return inst && in(i, inst->offscreen_render_order.size()) ? inst->offscreen_render_order[static_cast<std::size_t>(i)] : 0;
}
m2d_status m2d_instance_offscreen_colors(const m2d_instance* instance, int32_t i, float multiply[3], float screen[3]) {
  const auto* inst = I(instance);
  if (!inst || !in(i, inst->offscreen_opacity.size())) return M2D_INVALID_ARGUMENT;
  for (std::size_t c = 0; c < 3; c++) {
    if (multiply) multiply[c] = inst->offscreen_multiply[static_cast<std::size_t>(i) * 3 + c];
    if (screen) screen[c] = inst->offscreen_screen[static_cast<std::size_t>(i) * 3 + c];
  }
  return M2D_OK;
}

m2d_status m2d_instance_drawable_state(const m2d_instance* instance, int32_t i, m2d_drawable_state* out) {
  const auto* inst = I(instance);
  if (!inst || !out || !in(i, inst->drawable_opacity.size())) return M2D_INVALID_ARGUMENT;
  const auto k = static_cast<std::size_t>(i);
  out->visible = inst->drawable_visible[k];
  out->opacity = inst->drawable_opacity[k];
  out->draw_order = inst->drawable_draw_order[k];
  out->render_order = inst->drawable_render_order[k];
  for (std::size_t c = 0; c < 3; c++) {
    out->multiply[c] = inst->drawable_multiply[k * 3 + c];
    out->screen[c] = inst->drawable_screen[k * 3 + c];
  }
  return M2D_OK;
}

m2d_status m2d_instance_copy_drawable_vertices(const m2d_instance* instance, int32_t i, float* out, size_t capacity,
                                               size_t* written) {
  if (written) *written = 0;
  const auto* inst = I(instance);
  if (!inst || !in(i, inst->drawable_vertices.size())) return M2D_INVALID_ARGUMENT;
  const auto& v = inst->drawable_vertices[static_cast<std::size_t>(i)];
  if (capacity < v.size() || (!out && !v.empty())) return M2D_INVALID_ARGUMENT;
  std::copy(v.begin(), v.end(), out);
  if (written) *written = v.size();
  return M2D_OK;
}

int64_t m2d_model_vertex_total(const m2d_model* model) {
  return model && !model->vertex_offsets.empty() ? model->vertex_offsets.back() : 0;
}
int64_t m2d_model_drawable_vertex_offset(const m2d_model* model, int32_t i) {
  return M(model) && in(i, model->vertex_offsets.size() - 1) ? model->vertex_offsets[static_cast<std::size_t>(i)] : -1;
}
uint64_t m2d_instance_serial(const m2d_instance* instance) {
  const auto* inst = I(instance);
  return inst ? inst->serial.value : 0;
}
uint32_t m2d_instance_drawable_vertex_version(const m2d_instance* instance, int32_t i) {
  const auto* inst = I(instance);
  return inst && in(i, inst->drawable_vertex_version.size())
             ? inst->drawable_vertex_version[static_cast<std::size_t>(i)]
             : 0;
}
m2d_status m2d_instance_copy_changed_vertices(const m2d_instance* instance, m2d_vertex_sync* sync, float* out,
                                              size_t capacity, int32_t* changed, int32_t* changed_count) {
  if (changed_count) *changed_count = 0;
  const auto* inst = I(instance);
  if (!inst || !sync || sync->size < sizeof(m2d_vertex_sync)) return M2D_INVALID_ARGUMENT;
  const auto& m = inst->model();
  const std::size_t n = m.meshes.ids.size();
  if (sync->version_count != static_cast<int32_t>(n) || (n > 0 && !sync->versions)) return M2D_INVALID_ARGUMENT;
  int64_t total = 0;
  for (std::size_t i = 0; i < n; i++) total += m.meshes.vertex_count[i];
  if (capacity < static_cast<std::size_t>(total) * 2 || (total > 0 && !out)) return M2D_INVALID_ARGUMENT;
  // Another instance (or a first sync): every drawable is copied.
  const bool all = sync->serial != inst->serial.value;
  sync->serial = inst->serial.value;
  int64_t at = 0;
  int32_t count = 0;
  for (std::size_t i = 0; i < n; i++) {
    const int64_t vc = m.meshes.vertex_count[i];
    const uint32_t version = inst->drawable_vertex_version[i];
    if (all || sync->versions[i] != version) {
      const auto& v = inst->drawable_vertices[i];
      const std::size_t floats = std::min(v.size(), static_cast<std::size_t>(vc) * 2);
      std::copy(v.begin(), v.begin() + static_cast<std::ptrdiff_t>(floats), out + at * 2);
      sync->versions[i] = version;
      if (changed) changed[count] = static_cast<int32_t>(i);
      count++;
    }
    at += vc;
  }
  if (changed_count) *changed_count = count;
  return M2D_OK;
}

m2d_status m2d_instance_set_tint(m2d_instance* instance, int32_t index, const double* rgba, int32_t count) {
  if (!instance || (!rgba && count > 0)) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&instance->heap);
  return instance->tints.set(index, rgba, count) == framework::Tints::SetError::Ok ? M2D_OK : M2D_INVALID_ARGUMENT;
}
int32_t m2d_instance_clear_tint(m2d_instance* instance, int32_t index) {
  return instance && instance->tints.clear(index) ? 1 : 0;
}
void m2d_instance_clear_tints(m2d_instance* instance) {
  if (instance) instance->tints.clear_all();
}
int32_t m2d_instance_tint(const m2d_instance* instance, int32_t index, float out[4]) {
  return instance && out && instance->tints.get(index, out) ? 1 : 0;
}
int32_t m2d_instance_tint_count(const m2d_instance* instance) {
  return instance ? static_cast<int32_t>(instance->tints.count()) : 0;
}
int32_t m2d_instance_tinted_drawable(const m2d_instance* instance, int32_t k) {
  if (!instance || k < 0) return -1;
  const int32_t n = static_cast<int32_t>(instance->tints.rgba().size() / 4);
  for (int32_t d = 0; d < n; d++)
    if (instance->tints.has(d) && k-- == 0) return d;
  return -1;
}
const float* m2d_instance_drawable_tints(const m2d_instance* instance) {
  return instance ? instance->tints.active() : nullptr;
}
uint32_t m2d_instance_tint_version(const m2d_instance* instance) { return instance ? instance->tints.version() : 0; }

int32_t m2d_model_deformer_count(const m2d_model* model) {
  return M(model) ? static_cast<int32_t>(M(model)->deformers.ids.size()) : 0;
}
const char* m2d_model_deformer_id(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->deformers.ids.size()) ? m->deformers.ids[static_cast<std::size_t>(i)].c_str() : nullptr;
}
int32_t m2d_model_drawable_deformer(const m2d_model* model, int32_t i) {
  const auto* m = M(model);
  return m && in(i, m->meshes.ids.size()) ? m->meshes.deformer[static_cast<std::size_t>(i)] : -1;
}

m2d_status m2d_instance_map_points(const m2d_instance* instance, int32_t deformer, const float* points, size_t count,
                                   m2d_space space, float* out) {
  const auto* inst = I(instance);
  if (!inst || (count && (!points || !out))) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&instance->heap);
  return inst->map_points(deformer, points, count, out,
                          space == M2D_SPACE_KEYFORM ? eval::Instance::MapSpace::Keyform : eval::Instance::MapSpace::Model)
             ? M2D_OK
             : M2D_INVALID_ARGUMENT;
}

m2d_status m2d_instance_map_jacobians(const m2d_instance* instance, int32_t deformer, const float* points, size_t count,
                                      m2d_space space, double* out) {
  const auto* inst = I(instance);
  if (!inst || (count && (!points || !out))) return M2D_INVALID_ARGUMENT;
  return inst->map_jacobians(deformer, points, count, out,
                             space == M2D_SPACE_KEYFORM ? eval::Instance::MapSpace::Keyform : eval::Instance::MapSpace::Model)
             ? M2D_OK
             : M2D_INVALID_ARGUMENT;
}

m2d_status m2d_instance_drawable_bounds(const m2d_instance* instance, int32_t i, double out[4]) {
  const auto* inst = I(instance);
  if (!inst || !out || !in(i, inst->drawable_vertices.size())) return M2D_INVALID_ARGUMENT;
  const auto& v = inst->drawable_vertices[static_cast<std::size_t>(i)];
  const auto b = framework::vertex_bounds(v.data(), v.size());
  out[0] = b.min_x;
  out[1] = b.max_x;
  out[2] = b.min_y;
  out[3] = b.max_y;
  return M2D_OK;
}

int32_t m2d_instance_hit_test(const m2d_instance* instance, int32_t i, double x, double y) {
  const auto* inst = I(instance);
  if (!inst || !in(i, inst->drawable_vertices.size())) return 0;
  const auto& v = inst->drawable_vertices[static_cast<std::size_t>(i)];
  return framework::hit_test(v.data(), v.size(), x, y) ? 1 : 0;
}

char* m2d_instance_snapshot_json(const m2d_instance* instance) {
  const auto* inst = I(instance);
  if (!inst) return nullptr;
  HeapScope scope(&instance->heap);
  json::Value v = json::Value::object();
  snapshot_into(*inst, v);
  return dup_string(json::write_result(v));
}

}  // extern "C"

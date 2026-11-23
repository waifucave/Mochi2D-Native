// The C API of the reference renderer (include/mochi2d.h, "rendering"):
// textures, renderers and draws into caller-owned images.
#include <cmath>
#include <cstring>

#include "capi/internal.hpp"
#include "mochi2d.h"
#include "render/gl/gl_renderer.hpp"
#include "render/plan.hpp"
#include "render/renderer.hpp"
#include "render/shaders.hpp"
#include "render/gpu/cross_sources.hpp"
#include "render/vk/spirv.hpp"
#ifdef MOCHI2D_HAS_VULKAN
#include "render/vk/vk_renderer.hpp"
#endif
#ifdef MOCHI2D_HAS_METAL
#include "render/mtl/mtl_renderer.hpp"
#endif
#ifdef MOCHI2D_HAS_D3D11
#include "render/d3d11/d3d11_renderer.hpp"
#endif

using namespace mochi2d;

struct m2d_texture {
  Heap heap;
  std::shared_ptr<const render::Texture> texture;
};

struct m2d_renderer {
  Heap heap;
  std::shared_ptr<const moc::Model> model;
  render::Renderer* renderer = nullptr;
  ~m2d_renderer() { destroy(renderer); }
};

namespace {

constexpr int32_t kMaxImageSide = 16384;
constexpr int32_t kMaxMaskSize = 16384;

m2d_status invalid(m2d_error* error, const char* message, const char* code = "invalid-argument") {
  set_error(error, M2D_INVALID_ARGUMENT, code, message);
  return M2D_INVALID_ARGUMENT;
}

m2d_status too_large(m2d_error* error, const char* message) {
  set_error(error, M2D_LIMIT_ERROR, "texture-too-large", message);
  return M2D_LIMIT_ERROR;
}

m2d_status out_of_memory(m2d_error* error) {
  set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
  return M2D_OUT_OF_MEMORY;
}

/** The framing of a frame description (NULL: the canvas fitted into the image). */
render::Framing framing_of(const moc::Model& model, int32_t width, int32_t height, const m2d_render_frame* frame) {
  render::View view;
  const bool has_view = frame && frame->has_view;
  if (has_view) view = {frame->view_x, frame->view_y, frame->pixels_per_unit};
  return render::frame_image(model.canvas, width, height, has_view ? &view : nullptr);
}

/** A backend that could not be made: M2D_LIMIT_ERROR for a texture above its limit (its "…-texture-size"). */
m2d_status creation_status(const char* code) {
  const std::size_t n = std::strlen(code), k = std::strlen("-texture-size");
  return n >= k && std::strcmp(code + n - k, "-texture-size") == 0 ? M2D_LIMIT_ERROR : M2D_INTERNAL_ERROR;
}

}  // namespace

extern "C" {

m2d_status m2d_texture_create(const void* pixels, int32_t width, int32_t height, int32_t stride,
                              const m2d_allocator* allocator, m2d_texture** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!pixels || !out) return invalid(error, "NULL argument");
  if (width < 1 || height < 1) return invalid(error, "a texture side is below 1");
  if (width > M2D_MAX_TEXTURE_SIDE || height > M2D_MAX_TEXTURE_SIDE)
    return too_large(error, "the texture is larger than the maximum texture side 32768");
  const int64_t row = 4LL * width;
  if (stride == 0) stride = static_cast<int32_t>(row);
  if (stride < row) return invalid(error, "the stride is below 4·width");
  clear_error(error);
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  m2d_texture* h = create<m2d_texture>();
  if (!h) return out_of_memory(error);
  h->heap = heap;
  auto texture = std::allocate_shared<render::Texture>(Allocator<render::Texture>());
  const auto* src = static_cast<const uint8_t*>(pixels);
  if (stride == row) {
    render::prepare_texture(src, width, height, *texture);
  } else {
    Vector<uint8_t> packed(static_cast<std::size_t>(row) * static_cast<std::size_t>(height));
    for (int32_t y = 0; y < height; y++)
      std::memcpy(&packed[static_cast<std::size_t>(row) * static_cast<std::size_t>(y)],
                  src + static_cast<std::ptrdiff_t>(stride) * y, static_cast<std::size_t>(row));
    render::prepare_texture(packed.data(), width, height, *texture);
  }
  h->texture = std::move(texture);
  *out = h;
  return M2D_OK;
}

void m2d_texture_destroy(m2d_texture* texture) {
  if (!texture) return;
  HeapScope scope(&texture->heap);
  destroy(texture);
}

int32_t m2d_texture_width(const m2d_texture* texture) {
  return texture && texture->texture ? texture->texture->width : 0;
}

int32_t m2d_texture_height(const m2d_texture* texture) {
  return texture && texture->texture ? texture->texture->height : 0;
}

void m2d_renderer_options_default(m2d_renderer_options* options) {
  if (!options) return;
  options->mask_size = render::Renderer::kMaskSize;
  options->offscreen_mask_size = render::Renderer::kOffscreenMaskSize;
  options->threads = 1;
}

m2d_status m2d_renderer_create(m2d_model* model, m2d_texture* const* textures, int32_t texture_count,
                               const m2d_renderer_options* options, m2d_renderer** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!M(model) || !out || texture_count < 0 || (texture_count > 0 && !textures)) return invalid(error, "NULL argument");
  m2d_renderer_options o;
  m2d_renderer_options_default(&o);
  if (options) o = *options;
  if (o.mask_size < 1 || o.mask_size > kMaxMaskSize || o.offscreen_mask_size < 1 ||
      o.offscreen_mask_size > kMaxMaskSize)
    return invalid(error, "a mask buffer size must be between 1 and 16384");
  if (o.threads < 0) return invalid(error, "a negative thread count");
  for (int32_t i = 0; i < texture_count; i++)
    if (textures[i] && (m2d_texture_width(textures[i]) > M2D_MAX_TEXTURE_SIZE ||
                        m2d_texture_height(textures[i]) > M2D_MAX_TEXTURE_SIZE))
      return too_large(error, "a texture is larger than the maximum texture size 8192");
  clear_error(error);
  HeapScope scope(&model->heap);
  m2d_renderer* h = create<m2d_renderer>();
  if (!h) return out_of_memory(error);
  h->heap = model->heap;
  h->model = model->model;
  Vector<std::shared_ptr<const render::Texture>> list;
  for (int32_t i = 0; i < texture_count; i++)
    list.push_back(textures[i] ? textures[i]->texture : std::shared_ptr<const render::Texture>());
  h->renderer = create<render::Renderer>(h->model, std::move(list), o.mask_size, o.offscreen_mask_size);
  if (!h->renderer) {
    destroy(h);
    return out_of_memory(error);
  }
  h->renderer->set_threads(o.threads);
  *out = h;
  return M2D_OK;
}

void m2d_renderer_destroy(m2d_renderer* renderer) {
  if (!renderer) return;
  HeapScope scope(&renderer->heap);
  destroy(renderer);
}

void m2d_render_frame_default(m2d_render_frame* frame) {
  if (!frame) return;
  frame->has_view = 0;
  frame->view_x = 0;
  frame->view_y = 0;
  frame->pixels_per_unit = 1;
  for (double& c : frame->background) c = 0;
}

m2d_status m2d_render_framing(const m2d_model* model, int32_t width, int32_t height, const m2d_render_frame* frame,
                              double* pixels_per_unit, double* center_x, double* center_y) {
  if (!M(model) || width < 1 || height < 1) return M2D_INVALID_ARGUMENT;
  const render::Framing f = framing_of(*M(model), width, height, frame);
  if (pixels_per_unit) *pixels_per_unit = f.k;
  if (center_x) *center_x = f.center_x;
  if (center_y) *center_y = f.center_y;
  return M2D_OK;
}

m2d_status m2d_renderer_draw(m2d_renderer* renderer, const m2d_instance* instance, const m2d_render_frame* frame,
                             int32_t width, int32_t height, void* pixels, int32_t stride, m2d_error* error) {
  const eval::Instance* inst = I(instance);
  if (!renderer || !renderer->renderer || !inst || !pixels) return invalid(error, "NULL argument");
  if (&inst->model() != renderer->model.get()) return invalid(error, "the instance is not of the renderer's model");
  if (width < 1 || height < 1 || width > kMaxImageSide || height > kMaxImageSide)
    return invalid(error, "an image side must be between 1 and 16384");
  const int64_t row = 4LL * width;
  if (stride == 0) stride = static_cast<int32_t>(row);
  if (stride < row) return invalid(error, "the stride is below 4·width");
  clear_error(error);
  HeapScope scope(&renderer->heap);
  render::FrameOptions options;
  options.framing = framing_of(*renderer->model, width, height, frame);
  if (frame)
    for (int k = 0; k < 4; k++) options.background[static_cast<std::size_t>(k)] = frame->background[k];
  options.tints = instance->tints.active();
  renderer->renderer->draw(*inst, options, static_cast<uint8_t*>(pixels), stride);
  return M2D_OK;
}

m2d_status m2d_renderer_update_texture(m2d_renderer* renderer, int32_t index, const void* pixels, int32_t width,
                                       int32_t height, int32_t stride, int32_t x, int32_t y, m2d_error* error) {
  if (!renderer || !renderer->renderer || !pixels) return invalid(error, "NULL argument");
  if (width < 1 || height < 1 || (stride != 0 && stride < 4LL * width)) return invalid(error, "a bad image size or stride");
  clear_error(error);
  HeapScope scope(&renderer->heap);
  if (!renderer->renderer->update_texture(index, static_cast<const uint8_t*>(pixels), width, height, stride, x, y))
    return invalid(error, "no such texture, or the region does not fit in it", "texture-region");
  return M2D_OK;
}

void m2d_renderer_stats(const m2d_renderer* renderer, m2d_render_stats* out) {
  if (!out) return;
  *out = m2d_render_stats{};
  if (!renderer || !renderer->renderer) return;
  const render::FrameStats& s = renderer->renderer->stats();
  out->layered = s.layered ? 1 : 0;
  out->drawn = s.drawn;
  out->masked = s.masked;
  out->mask_builds = s.mask_builds;
  out->mask_mesh_draws = s.mask_mesh_draws;
  out->layers = s.layers;
  out->advanced_draws = s.advanced_draws;
  out->fragments = s.fragments;
}

}  // extern "C"

// ------------------------------------------------------ GPU rendering

struct m2d_render_plan {
  Heap heap;
  std::shared_ptr<const moc::Model> model;
  render::RenderModel* rm = nullptr;
  Vector<uint8_t> has_texture;
  int32_t mask_size = 0, offscreen_mask_size = 0;
  render::FramePlan plan;
  Vector<m2d_render_op> ops;
  ~m2d_render_plan() { destroy(rm); }
};

struct m2d_gl_renderer {
  Heap heap;
  std::shared_ptr<const moc::Model> model;
  render::gl::GlRenderer* renderer = nullptr;
  ~m2d_gl_renderer() { destroy(renderer); }
};

namespace {

m2d_status check_mask_sizes(int32_t mask_size, int32_t offscreen_mask_size, m2d_error* error) {
  if (mask_size < 1 || mask_size > kMaxMaskSize || offscreen_mask_size < 1 || offscreen_mask_size > kMaxMaskSize)
    return invalid(error, "a mask buffer size must be between 1 and 16384");
  return M2D_OK;
}

render::FrameOptions frame_options(const moc::Model& model, const m2d_instance* instance, const m2d_render_frame* frame,
                                   int32_t width, int32_t height) {
  render::FrameOptions options;
  options.framing = framing_of(model, width, height, frame);
  if (frame)
    for (int k = 0; k < 4; k++) options.background[static_cast<std::size_t>(k)] = frame->background[k];
  options.tints = instance->tints.active();
  return options;
}

void copy_stats(const render::FrameStats& s, m2d_render_stats* out) {
  out->layered = s.layered ? 1 : 0;
  out->drawn = s.drawn;
  out->masked = s.masked;
  out->mask_builds = s.mask_builds;
  out->mask_mesh_draws = s.mask_mesh_draws;
  out->layers = s.layers;
  out->advanced_draws = s.advanced_draws;
  out->fragments = s.fragments;
}

static_assert(static_cast<int>(render::RenderOp::Kind::Composite) == M2D_OP_COMPOSITE &&
                  static_cast<int>(render::RenderOp::Kind::BuildMask) == M2D_OP_BUILD_MASK &&
                  static_cast<int>(render::RenderOp::Kind::DrawMesh) == M2D_OP_DRAW_MESH,
              "operation kinds");
static_assert(static_cast<int>(render::BlendKind::Advanced) == M2D_BLEND_ADVANCED &&
                  static_cast<int>(render::BlendKind::Multiplicative) == M2D_BLEND_MULTIPLICATIVE,
              "blend kinds");

m2d_render_op to_c(const render::RenderOp& op) {
  m2d_render_op o{};
  o.size = sizeof(m2d_render_op);
  o.kind = static_cast<int32_t>(op.kind);
  o.target = op.target;
  o.index = op.index;
  o.layer = op.layer;
  o.blend = static_cast<int32_t>(op.blend);
  o.color_fn = op.color_fn;
  o.alpha_mode = op.alpha_mode;
  o.cull = op.cull ? 1 : 0;
  for (std::size_t k = 0; k < 3; k++) {
    o.multiply[k] = op.multiply[k];
    o.screen[k] = op.screen[k];
    o.tint[k] = op.tint[k];
  }
  o.opacity = op.opacity;
  o.mask_buffer = op.mask.buffer;
  o.mask_inverted = op.mask.inverted ? 1 : 0;
  o.mask_map[0] = op.mask.ox;
  o.mask_map[1] = op.mask.oy;
  o.mask_map[2] = op.mask.sx;
  o.mask_map[3] = op.mask.sy;
  for (std::size_t k = 0; k < 8; k++) o.mask_matrix[k] = op.mask.matrix[k];
  o.buffer = op.buffer;
  o.buffer_size = op.size;
  for (std::size_t k = 0; k < 4; k++) {
    o.scissor[k] = op.scissor[k];
    o.color[k] = op.color[k];
  }
  o.first = op.first;
  o.count = op.count;
  return o;
}

}  // namespace

extern "C" {

m2d_status m2d_render_plan_create(m2d_model* model, const uint8_t* texture_present, int32_t texture_count,
                                  const m2d_renderer_options* options, m2d_render_plan** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!M(model) || !out || texture_count < 0) return invalid(error, "NULL argument");
  m2d_renderer_options o;
  m2d_renderer_options_default(&o);
  if (options) o = *options;
  if (check_mask_sizes(o.mask_size, o.offscreen_mask_size, error) != M2D_OK) return M2D_INVALID_ARGUMENT;
  clear_error(error);
  HeapScope scope(&model->heap);
  m2d_render_plan* h = create<m2d_render_plan>();
  if (!h) return out_of_memory(error);
  h->heap = model->heap;
  h->model = model->model;
  h->rm = create<render::RenderModel>(*h->model);
  if (!h->rm) {
    destroy(h);
    return out_of_memory(error);
  }
  for (int32_t i = 0; i < texture_count; i++)
    h->has_texture.push_back(!texture_present || texture_present[i] ? 1 : 0);
  h->mask_size = o.mask_size;
  h->offscreen_mask_size = o.offscreen_mask_size;
  *out = h;
  return M2D_OK;
}

void m2d_render_plan_destroy(m2d_render_plan* plan) {
  if (!plan) return;
  HeapScope scope(&plan->heap);
  destroy(plan);
}

int32_t m2d_render_plan_layered(const m2d_render_plan* plan) { return plan && plan->rm && plan->rm->layered ? 1 : 0; }

m2d_status m2d_render_plan_frame(m2d_render_plan* plan, const m2d_instance* instance, const m2d_render_frame* frame,
                                 int32_t width, int32_t height, m2d_error* error) {
  const eval::Instance* inst = I(instance);
  if (!plan || !plan->rm || !inst) return invalid(error, "NULL argument");
  if (&inst->model() != plan->model.get()) return invalid(error, "the instance is not of the plan's model");
  if (width < 1 || height < 1 || width > kMaxImageSide || height > kMaxImageSide)
    return invalid(error, "an image side must be between 1 and 16384");
  clear_error(error);
  HeapScope scope(&plan->heap);
  const render::FrameOptions options = frame_options(*plan->model, instance, frame, width, height);
  render::plan_frame(*plan->rm, *plan->model, *inst, options, plan->mask_size, plan->offscreen_mask_size,
                     plan->has_texture, plan->plan);
  plan->ops.clear();
  for (const auto& op : plan->plan.ops) plan->ops.push_back(to_c(op));
  return M2D_OK;
}

const m2d_render_op* m2d_render_plan_ops(const m2d_render_plan* plan, int32_t* count) {
  if (count) *count = plan ? static_cast<int32_t>(plan->ops.size()) : 0;
  return plan && !plan->ops.empty() ? plan->ops.data() : nullptr;
}

const int32_t* m2d_render_plan_mask_meshes(const m2d_render_plan* plan, int32_t* count) {
  if (count) *count = plan ? static_cast<int32_t>(plan->plan.mask_meshes.size()) : 0;
  return plan && !plan->plan.mask_meshes.empty() ? plan->plan.mask_meshes.data() : nullptr;
}

void m2d_render_plan_view(const m2d_render_plan* plan, double view[4]) {
  if (!view) return;
  for (std::size_t k = 0; k < 4; k++) view[k] = plan ? plan->plan.view[k] : 0;
}

const float* m2d_render_plan_drawable_uvs(const m2d_render_plan* plan, int32_t drawable, int32_t* count) {
  if (count) *count = 0;
  if (!plan || !plan->rm || drawable < 0 || static_cast<std::size_t>(drawable) >= plan->rm->uvs.size()) return nullptr;
  const auto& uv = plan->rm->uvs[static_cast<std::size_t>(drawable)];
  if (count) *count = static_cast<int32_t>(uv.size() / 2);
  return uv.data();
}

uint32_t m2d_render_op_size(void) { return sizeof(m2d_render_op); }

const char* m2d_render_shader_source(int32_t program, int32_t stage, int32_t dialect) {
  constexpr int kPrograms = static_cast<int>(render::ShaderProgram::Count);
  if (program < 0 || program >= kPrograms || stage < 0 || stage > 1 || dialect < 0 || dialect > 5) return nullptr;
  // MSL and HLSL: the committed translations (render/gpu/cross_sources.inc).
  if (dialect >= 4)
    return render::cross_source(static_cast<render::ShaderProgram>(program), static_cast<render::ShaderStage>(stage),
                                dialect == 4 ? render::CrossLanguage::Msl : render::CrossLanguage::Hlsl);
  // Built once (thread-safe static initialization) on the default heap, never freed: an immutable table.
  struct Table {
    String text[kPrograms][2][4];
  };
  static const Table* const table = [] {
    HeapScope scope(nullptr);
    Table* t = create<Table>();
    for (int p = 0; t && p < kPrograms; p++)
      for (int st = 0; st < 2; st++)
        for (int d = 0; d < 4; d++)
          t->text[p][st][d] = render::shader_source(static_cast<render::ShaderProgram>(p),
                                                   static_cast<render::ShaderStage>(st),
                                                   static_cast<render::ShaderDialect>(d));
    return t;
  }();
  return table ? table->text[program][stage][dialect].c_str() : nullptr;
}

const uint32_t* m2d_render_shader_spirv(int32_t program, int32_t stage, size_t* words) {
  if (words) *words = 0;
  if (program < 0 || program >= static_cast<int>(render::ShaderProgram::Count) || stage < 0 || stage > 1)
    return nullptr;
  const render::vk::Spirv s =
      render::vk::spirv(static_cast<render::ShaderProgram>(program), static_cast<render::ShaderStage>(stage));
  if (words) *words = s.count;
  return s.words;
}

int32_t m2d_render_plan_layer_count(const m2d_render_plan* plan) { return plan ? plan->plan.layers : 0; }

void m2d_render_plan_stats(const m2d_render_plan* plan, m2d_render_stats* out) {
  if (!out) return;
  *out = m2d_render_stats{};
  if (plan) copy_stats(plan->plan.stats, out);
}

void m2d_gl_options_default(m2d_gl_options* options) {
  if (!options) return;
  options->desktop = 0;
  options->mask_size = render::Renderer::kMaskSize;
  options->offscreen_mask_size = render::Renderer::kOffscreenMaskSize;
  options->max_texture_size = 0;
}

m2d_status m2d_gl_renderer_create(m2d_model* model, m2d_texture* const* textures, int32_t texture_count,
                                  m2d_gl_loader loader, void* user, const m2d_gl_options* options,
                                  m2d_gl_renderer** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!M(model) || !out || !loader || texture_count < 0 || (texture_count > 0 && !textures))
    return invalid(error, "NULL argument");
  m2d_gl_options o;
  m2d_gl_options_default(&o);
  if (options) o = *options;
  if (check_mask_sizes(o.mask_size, o.offscreen_mask_size, error) != M2D_OK) return M2D_INVALID_ARGUMENT;
  if (o.max_texture_size < 0) return invalid(error, "a negative texture limit");
  render::gl::Api api;
  const char* missing = nullptr;
  if (!render::gl::load(api, loader, user, &missing)) {
    set_error(error, M2D_INTERNAL_ERROR, "gl-function",
              (String("the context has no ") + (missing ? missing : "function")).c_str());
    return M2D_INTERNAL_ERROR;
  }
  clear_error(error);
  HeapScope scope(&model->heap);
  m2d_gl_renderer* h = create<m2d_gl_renderer>();
  if (!h) return out_of_memory(error);
  h->heap = model->heap;
  h->model = model->model;
  Vector<std::shared_ptr<const render::Texture>> list;
  for (int32_t i = 0; i < texture_count; i++)
    list.push_back(textures[i] ? textures[i]->texture : std::shared_ptr<const render::Texture>());
  render::gl::GlOptions go;
  go.desktop = o.desktop != 0;
  go.mask_size = o.mask_size;
  go.offscreen_mask_size = o.offscreen_mask_size;
  go.max_texture_size = o.max_texture_size;
  h->renderer = create<render::gl::GlRenderer>(h->model, std::move(list), api, go);
  if (!h->renderer) {
    destroy(h);
    return out_of_memory(error);
  }
  if (!h->renderer->ok()) {
    const m2d_status status = creation_status(h->renderer->error_code());
    set_error(error, status, h->renderer->error_code(), h->renderer->error().c_str());
    destroy(h);
    return status;
  }
  *out = h;
  return M2D_OK;
}

void m2d_gl_renderer_destroy(m2d_gl_renderer* renderer) {
  if (!renderer) return;
  HeapScope scope(&renderer->heap);
  destroy(renderer);
}

m2d_status m2d_gl_renderer_draw(m2d_gl_renderer* renderer, const m2d_instance* instance,
                                const m2d_render_frame* frame, int32_t width, int32_t height, uint32_t framebuffer,
                                m2d_error* error) {
  const eval::Instance* inst = I(instance);
  if (!renderer || !renderer->renderer || !inst) return invalid(error, "NULL argument");
  if (&inst->model() != renderer->model.get()) return invalid(error, "the instance is not of the renderer's model");
  if (width < 1 || height < 1 || width > kMaxImageSide || height > kMaxImageSide)
    return invalid(error, "an image side must be between 1 and 16384");
  clear_error(error);
  HeapScope scope(&renderer->heap);
  const render::FrameOptions options = frame_options(*renderer->model, instance, frame, width, height);
  if (!renderer->renderer->draw(*inst, options, framebuffer)) {
    set_error(error, M2D_INTERNAL_ERROR, renderer->renderer->error_code(), renderer->renderer->error().c_str());
    return M2D_INTERNAL_ERROR;
  }
  return M2D_OK;
}

m2d_status m2d_gl_renderer_update_texture(m2d_gl_renderer* renderer, int32_t index, const void* pixels, int32_t width,
                                          int32_t height, int32_t stride, int32_t x, int32_t y, m2d_error* error) {
  if (!renderer || !renderer->renderer || !pixels) return invalid(error, "NULL argument");
  if (width < 1 || height < 1 || (stride != 0 && stride < 4LL * width)) return invalid(error, "a bad image size or stride");
  clear_error(error);
  HeapScope scope(&renderer->heap);
  render::gl::GlRenderer& r = *renderer->renderer;
  if (!r.update_texture(index, static_cast<const uint8_t*>(pixels), width, height, stride, x, y)) {
    if (std::strcmp(r.error_code(), "gl-error") == 0 && !r.error().empty() &&
        r.error().find("updating a texture") != String::npos) {
      set_error(error, M2D_INTERNAL_ERROR, "gl-error", r.error().c_str());
      return M2D_INTERNAL_ERROR;
    }
    return invalid(error, "no such texture, or the region does not fit in it", "texture-region");
  }
  return M2D_OK;
}

int32_t m2d_gl_renderer_max_texture_size(const m2d_gl_renderer* renderer) {
  return renderer && renderer->renderer ? renderer->renderer->max_texture_size() : 0;
}

void m2d_gl_renderer_stats(const m2d_gl_renderer* renderer, m2d_render_stats* out) {
  if (!out) return;
  *out = m2d_render_stats{};
  if (renderer && renderer->renderer) copy_stats(renderer->renderer->plan().stats, out);
}

// ----------------------------------------------------------------- Vulkan

}  // extern "C"

struct m2d_vk_renderer {
  Heap heap;
  std::shared_ptr<const moc::Model> model;
#ifdef MOCHI2D_HAS_VULKAN
  render::vk::VkRenderer* renderer = nullptr;
  ~m2d_vk_renderer() { destroy(renderer); }
#endif
};

#ifdef MOCHI2D_HAS_VULKAN
namespace {
/** A non-dispatchable handle from its 64-bit value (a pointer type on 64-bit targets, uint64_t elsewhere). */
template <typename T>
T vk_handle(uint64_t v) {
#if defined(__LP64__) || defined(_WIN64) || (defined(__x86_64__) && !defined(__ILP32__)) || defined(_M_X64) || \
    defined(__ia64) || defined(_M_IA64) || defined(__aarch64__) || defined(__powerpc64__)
  return reinterpret_cast<T>(static_cast<uintptr_t>(v));
#else
  return static_cast<T>(v);
#endif
}
}  // namespace
#endif

extern "C" {

int32_t m2d_vk_available(void) {
#ifdef MOCHI2D_HAS_VULKAN
  return 1;
#else
  return 0;
#endif
}

void m2d_vk_options_default(m2d_vk_options* options) {
  if (!options) return;
  options->mask_size = render::Renderer::kMaskSize;
  options->offscreen_mask_size = render::Renderer::kOffscreenMaskSize;
  options->max_texture_size = 0;
  options->flip_y = 1;
}

m2d_status m2d_vk_renderer_create(m2d_model* model, m2d_texture* const* textures, int32_t texture_count,
                                  const m2d_vk_context* context, const m2d_vk_options* options,
                                  m2d_vk_renderer** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!M(model) || !out || !context || texture_count < 0 || (texture_count > 0 && !textures))
    return invalid(error, "NULL argument");
  if (context->size < sizeof(m2d_vk_context)) return invalid(error, "m2d_vk_context.size is not set");
  m2d_vk_options o;
  m2d_vk_options_default(&o);
  if (options) o = *options;
  if (check_mask_sizes(o.mask_size, o.offscreen_mask_size, error) != M2D_OK) return M2D_INVALID_ARGUMENT;
  if (o.max_texture_size < 0) return invalid(error, "a negative texture limit");
#ifndef MOCHI2D_HAS_VULKAN
  (void)textures;
  set_error(error, M2D_INTERNAL_ERROR, "vk-not-built", "the library was built without the Vulkan backend");
  return M2D_INTERNAL_ERROR;
#else
  clear_error(error);
  HeapScope scope(&model->heap);
  m2d_vk_renderer* h = create<m2d_vk_renderer>();
  if (!h) return out_of_memory(error);
  h->heap = model->heap;
  h->model = model->model;
  Vector<std::shared_ptr<const render::Texture>> list;
  for (int32_t i = 0; i < texture_count; i++)
    list.push_back(textures[i] ? textures[i]->texture : std::shared_ptr<const render::Texture>());
  render::vk::VkContext ctx;
  ctx.get_instance_proc_addr = reinterpret_cast<PFN_vkGetInstanceProcAddr>(context->get_instance_proc_addr);
  ctx.instance = static_cast<VkInstance>(context->instance);
  ctx.physical_device = static_cast<VkPhysicalDevice>(context->physical_device);
  ctx.device = static_cast<VkDevice>(context->device);
  ctx.queue = static_cast<VkQueue>(context->queue);
  ctx.queue_family = context->queue_family;
  render::vk::VkOptions vo;
  vo.mask_size = o.mask_size;
  vo.offscreen_mask_size = o.offscreen_mask_size;
  vo.max_texture_size = o.max_texture_size;
  vo.flip_y = o.flip_y != 0;
  h->renderer = create<render::vk::VkRenderer>(h->model, std::move(list), ctx, vo);
  if (!h->renderer) {
    destroy(h);
    return out_of_memory(error);
  }
  if (!h->renderer->ok()) {
    const m2d_status status = creation_status(h->renderer->error_code());
    set_error(error, status, h->renderer->error_code(), h->renderer->error().c_str());
    destroy(h);
    return status;
  }
  *out = h;
  return M2D_OK;
#endif
}

void m2d_vk_renderer_destroy(m2d_vk_renderer* renderer) {
  if (!renderer) return;
  HeapScope scope(&renderer->heap);
  destroy(renderer);
}

m2d_status m2d_vk_renderer_draw(m2d_vk_renderer* renderer, const m2d_instance* instance,
                                const m2d_render_frame* frame, int32_t width, int32_t height, void* command_buffer,
                                const m2d_vk_target* target, m2d_error* error) {
  const eval::Instance* inst = I(instance);
  if (!renderer || !inst || !command_buffer || !target) return invalid(error, "NULL argument");
  if (target->size < sizeof(m2d_vk_target)) return invalid(error, "m2d_vk_target.size is not set");
  if (&inst->model() != renderer->model.get()) return invalid(error, "the instance is not of the renderer's model");
  if (width < 1 || height < 1 || width > kMaxImageSide || height > kMaxImageSide)
    return invalid(error, "an image side must be between 1 and 16384");
#ifndef MOCHI2D_HAS_VULKAN
  (void)frame;
  set_error(error, M2D_INTERNAL_ERROR, "vk-not-built", "the library was built without the Vulkan backend");
  return M2D_INTERNAL_ERROR;
#else
  clear_error(error);
  HeapScope scope(&renderer->heap);
  const render::FrameOptions options = frame_options(*renderer->model, instance, frame, width, height);
  render::vk::VkTarget t;
  t.image = vk_handle<VkImage>(target->image);
  t.view = vk_handle<VkImageView>(target->view);
  t.format = static_cast<VkFormat>(target->format);
  t.old_layout = static_cast<VkImageLayout>(target->old_layout);
  t.new_layout = static_cast<VkImageLayout>(target->new_layout);
  if (!renderer->renderer->draw(*inst, options, static_cast<VkCommandBuffer>(command_buffer), t)) {
    set_error(error, M2D_INTERNAL_ERROR, renderer->renderer->error_code(), renderer->renderer->error().c_str());
    return M2D_INTERNAL_ERROR;
  }
  return M2D_OK;
#endif
}

void m2d_vk_renderer_forget_target(m2d_vk_renderer* renderer, uint64_t view) {
#ifdef MOCHI2D_HAS_VULKAN
  if (renderer && renderer->renderer) {
    HeapScope scope(&renderer->heap);
    renderer->renderer->forget_target(vk_handle<VkImageView>(view));
  }
#else
  (void)renderer;
  (void)view;
#endif
}

void m2d_vk_renderer_stats(const m2d_vk_renderer* renderer, m2d_render_stats* out) {
  if (!out) return;
  *out = m2d_render_stats{};
#ifdef MOCHI2D_HAS_VULKAN
  if (renderer && renderer->renderer) copy_stats(renderer->renderer->plan().stats, out);
#else
  (void)renderer;
#endif
}

m2d_status m2d_vk_renderer_update_texture(m2d_vk_renderer* renderer, int32_t index, const void* pixels, int32_t width,
                                          int32_t height, int32_t stride, int32_t x, int32_t y, m2d_error* error) {
  if (!renderer || !pixels) return invalid(error, "NULL argument");
  if (width < 1 || height < 1 || (stride != 0 && stride < 4LL * width)) return invalid(error, "a bad image size or stride");
#ifndef MOCHI2D_HAS_VULKAN
  (void)index;
  (void)x;
  (void)y;
  set_error(error, M2D_INTERNAL_ERROR, "vk-not-built", "the library was built without the Vulkan backend");
  return M2D_INTERNAL_ERROR;
#else
  if (!renderer->renderer) return invalid(error, "NULL argument");
  clear_error(error);
  HeapScope scope(&renderer->heap);
  render::vk::VkRenderer& r = *renderer->renderer;
  if (!r.update_texture(index, static_cast<const uint8_t*>(pixels), width, height, stride, x, y)) {
    if (!r.error().empty() && std::strcmp(r.error_code(), "vk-error") == 0) {
      set_error(error, M2D_INTERNAL_ERROR, "vk-error", r.error().c_str());
      return M2D_INTERNAL_ERROR;
    }
    return invalid(error, "no such texture, or the region does not fit in it", "texture-region");
  }
  return M2D_OK;
#endif
}

int32_t m2d_vk_renderer_max_texture_size(const m2d_vk_renderer* renderer) {
#ifdef MOCHI2D_HAS_VULKAN
  return renderer && renderer->renderer ? renderer->renderer->max_texture_size() : 0;
#else
  (void)renderer;
  return 0;
#endif
}

}  // extern "C"

// ------------------------------------------------- Metal and Direct3D 11

struct m2d_mtl_renderer {
  Heap heap;
  std::shared_ptr<const moc::Model> model;
#ifdef MOCHI2D_HAS_METAL
  render::mtl::MtlRenderer* renderer = nullptr;
  ~m2d_mtl_renderer() { destroy(renderer); }
#endif
};

struct m2d_d3d11_renderer {
  Heap heap;
  std::shared_ptr<const moc::Model> model;
#ifdef MOCHI2D_HAS_D3D11
  render::d3d11::D3d11Renderer* renderer = nullptr;
  ~m2d_d3d11_renderer() { destroy(renderer); }
#endif
};

namespace {

/** The arguments every backend's create checks: NULLs, the options' sizes. */
template <class Options>
m2d_status check_create(m2d_model* model, m2d_texture* const* textures, int32_t texture_count, void* const* objects,
                        int object_count, const Options& o, void* out, m2d_error* error) {
  if (!M(model) || !out || texture_count < 0 || (texture_count > 0 && !textures))
    return invalid(error, "NULL argument");
  for (int k = 0; k < object_count; k++)
    if (!objects[k]) return invalid(error, "NULL argument");
  if (check_mask_sizes(o.mask_size, o.offscreen_mask_size, error) != M2D_OK) return M2D_INVALID_ARGUMENT;
  if (o.max_texture_size < 0) return invalid(error, "a negative texture limit");
  return M2D_OK;
}

m2d_status not_built(m2d_error* error, const char* code, const char* what) {
  set_error(error, M2D_INTERNAL_ERROR, code, what);
  return M2D_INTERNAL_ERROR;
}

#if defined(MOCHI2D_HAS_METAL) || defined(MOCHI2D_HAS_D3D11)
Vector<std::shared_ptr<const render::Texture>> texture_list(m2d_texture* const* textures, int32_t count) {
  Vector<std::shared_ptr<const render::Texture>> list;
  for (int32_t i = 0; i < count; i++)
    list.push_back(textures[i] ? textures[i]->texture : std::shared_ptr<const render::Texture>());
  return list;
}

/** The handle around a made renderer: M2D_OK, or its error. */
template <class Handle>
m2d_status finish_create(Handle* h, Handle** out, m2d_error* error) {
  if (!h->renderer) {
    destroy(h);
    return out_of_memory(error);
  }
  if (!h->renderer->ok()) {
    const m2d_status status = creation_status(h->renderer->error_code());
    set_error(error, status, h->renderer->error_code(), h->renderer->error().c_str());
    destroy(h);
    return status;
  }
  *out = h;
  return M2D_OK;
}

/** A texture update through a backend: "texture-region" for a bad region, the backend's error otherwise. */
template <class R>
m2d_status update_through(R& r, int32_t index, const void* pixels, int32_t width, int32_t height, int32_t stride,
                          int32_t x, int32_t y, m2d_error* error) {
  if (!r.update_texture(index, static_cast<const uint8_t*>(pixels), width, height, stride, x, y)) {
    if (!r.error().empty()) {
      set_error(error, M2D_INTERNAL_ERROR, r.error_code(), r.error().c_str());
      return M2D_INTERNAL_ERROR;
    }
    return invalid(error, "no such texture, or the region does not fit in it", "texture-region");
  }
  return M2D_OK;
}
#endif

/** The draw arguments every backend checks. */
template <class Handle>
m2d_status check_draw(const Handle* renderer, const m2d_instance* instance, void* const* objects, int object_count,
                      int32_t width, int32_t height, m2d_error* error) {
  const eval::Instance* inst = I(instance);
  if (!renderer || !inst) return invalid(error, "NULL argument");
  for (int k = 0; k < object_count; k++)
    if (!objects[k]) return invalid(error, "NULL argument");
  if (&inst->model() != renderer->model.get()) return invalid(error, "the instance is not of the renderer's model");
  if (width < 1 || height < 1 || width > kMaxImageSide || height > kMaxImageSide)
    return invalid(error, "an image side must be between 1 and 16384");
  return M2D_OK;
}

m2d_status check_update(const void* renderer, const void* pixels, int32_t width, int32_t height, int32_t stride,
                        m2d_error* error) {
  if (!renderer || !pixels) return invalid(error, "NULL argument");
  if (width < 1 || height < 1 || (stride != 0 && stride < 4LL * width)) return invalid(error, "a bad image size or stride");
  return M2D_OK;
}

}  // namespace

extern "C" {

int32_t m2d_mtl_available(void) {
#ifdef MOCHI2D_HAS_METAL
  return 1;
#else
  return 0;
#endif
}

void m2d_mtl_options_default(m2d_mtl_options* options) {
  if (!options) return;
  options->mask_size = render::Renderer::kMaskSize;
  options->offscreen_mask_size = render::Renderer::kOffscreenMaskSize;
  options->max_texture_size = 0;
  options->flip_y = 1;
}

m2d_status m2d_mtl_renderer_create(m2d_model* model, m2d_texture* const* textures, int32_t texture_count, void* device,
                                   const m2d_mtl_options* options, m2d_mtl_renderer** out, m2d_error* error) {
  if (out) *out = nullptr;
  m2d_mtl_options o;
  m2d_mtl_options_default(&o);
  if (options) o = *options;
  void* const objects[1] = {device};
  if (check_create(model, textures, texture_count, objects, 1, o, out, error) != M2D_OK) return M2D_INVALID_ARGUMENT;
#ifndef MOCHI2D_HAS_METAL
  return not_built(error, "mtl-not-built", "the library was built without the Metal backend");
#else
  clear_error(error);
  HeapScope scope(&model->heap);
  m2d_mtl_renderer* h = create<m2d_mtl_renderer>();
  if (!h) return out_of_memory(error);
  h->heap = model->heap;
  h->model = model->model;
  render::mtl::MtlContext ctx;
  ctx.device = device;
  render::mtl::MtlOptions mo;
  mo.mask_size = o.mask_size;
  mo.offscreen_mask_size = o.offscreen_mask_size;
  mo.max_texture_size = o.max_texture_size;
  mo.flip_y = o.flip_y != 0;
  h->renderer = create<render::mtl::MtlRenderer>(h->model, texture_list(textures, texture_count), ctx, mo);
  return finish_create(h, out, error);
#endif
}

void m2d_mtl_renderer_destroy(m2d_mtl_renderer* renderer) {
  if (!renderer) return;
  HeapScope scope(&renderer->heap);
  destroy(renderer);
}

m2d_status m2d_mtl_renderer_draw(m2d_mtl_renderer* renderer, const m2d_instance* instance,
                                 const m2d_render_frame* frame, int32_t width, int32_t height, void* command_buffer,
                                 void* texture, m2d_error* error) {
  void* const objects[2] = {command_buffer, texture};
  if (check_draw(renderer, instance, objects, 2, width, height, error) != M2D_OK) return M2D_INVALID_ARGUMENT;
#ifndef MOCHI2D_HAS_METAL
  (void)frame;
  return not_built(error, "mtl-not-built", "the library was built without the Metal backend");
#else
  clear_error(error);
  HeapScope scope(&renderer->heap);
  const render::FrameOptions options = frame_options(*renderer->model, instance, frame, width, height);
  render::mtl::MtlTarget t;
  t.texture = texture;
  if (!renderer->renderer->draw(*I(instance), options, command_buffer, t)) {
    set_error(error, M2D_INTERNAL_ERROR, renderer->renderer->error_code(), renderer->renderer->error().c_str());
    return M2D_INTERNAL_ERROR;
  }
  return M2D_OK;
#endif
}

void m2d_mtl_renderer_stats(const m2d_mtl_renderer* renderer, m2d_render_stats* out) {
  if (!out) return;
  *out = m2d_render_stats{};
#ifdef MOCHI2D_HAS_METAL
  if (renderer && renderer->renderer) copy_stats(renderer->renderer->plan().stats, out);
#else
  (void)renderer;
#endif
}

int32_t m2d_mtl_renderer_max_texture_size(const m2d_mtl_renderer* renderer) {
#ifdef MOCHI2D_HAS_METAL
  return renderer && renderer->renderer ? renderer->renderer->max_texture_size() : 0;
#else
  (void)renderer;
  return 0;
#endif
}

m2d_status m2d_mtl_renderer_update_texture(m2d_mtl_renderer* renderer, int32_t index, const void* pixels, int32_t width,
                                           int32_t height, int32_t stride, int32_t x, int32_t y, m2d_error* error) {
  if (check_update(renderer, pixels, width, height, stride, error) != M2D_OK) return M2D_INVALID_ARGUMENT;
#ifndef MOCHI2D_HAS_METAL
  (void)index;
  (void)x;
  (void)y;
  return not_built(error, "mtl-not-built", "the library was built without the Metal backend");
#else
  clear_error(error);
  HeapScope scope(&renderer->heap);
  return update_through(*renderer->renderer, index, pixels, width, height, stride, x, y, error);
#endif
}

int32_t m2d_d3d11_available(void) {
#ifdef MOCHI2D_HAS_D3D11
  return 1;
#else
  return 0;
#endif
}

void m2d_d3d11_options_default(m2d_d3d11_options* options) {
  if (!options) return;
  options->mask_size = render::Renderer::kMaskSize;
  options->offscreen_mask_size = render::Renderer::kOffscreenMaskSize;
  options->max_texture_size = 0;
  options->flip_y = 1;
}

m2d_status m2d_d3d11_renderer_create(m2d_model* model, m2d_texture* const* textures, int32_t texture_count,
                                     void* device, void* context, const m2d_d3d11_options* options,
                                     m2d_d3d11_renderer** out, m2d_error* error) {
  if (out) *out = nullptr;
  m2d_d3d11_options o;
  m2d_d3d11_options_default(&o);
  if (options) o = *options;
  void* const objects[2] = {device, context};
  if (check_create(model, textures, texture_count, objects, 2, o, out, error) != M2D_OK) return M2D_INVALID_ARGUMENT;
#ifndef MOCHI2D_HAS_D3D11
  return not_built(error, "d3d11-not-built", "the library was built without the Direct3D 11 backend");
#else
  clear_error(error);
  HeapScope scope(&model->heap);
  m2d_d3d11_renderer* h = create<m2d_d3d11_renderer>();
  if (!h) return out_of_memory(error);
  h->heap = model->heap;
  h->model = model->model;
  render::d3d11::D3d11Context ctx;
  ctx.device = device;
  ctx.context = context;
  render::d3d11::D3d11Options d;
  d.mask_size = o.mask_size;
  d.offscreen_mask_size = o.offscreen_mask_size;
  d.max_texture_size = o.max_texture_size;
  d.flip_y = o.flip_y != 0;
  h->renderer = create<render::d3d11::D3d11Renderer>(h->model, texture_list(textures, texture_count), ctx, d);
  return finish_create(h, out, error);
#endif
}

void m2d_d3d11_renderer_destroy(m2d_d3d11_renderer* renderer) {
  if (!renderer) return;
  HeapScope scope(&renderer->heap);
  destroy(renderer);
}

m2d_status m2d_d3d11_renderer_draw(m2d_d3d11_renderer* renderer, const m2d_instance* instance,
                                   const m2d_render_frame* frame, int32_t width, int32_t height,
                                   void* render_target_view, m2d_error* error) {
  void* const objects[1] = {render_target_view};
  if (check_draw(renderer, instance, objects, 1, width, height, error) != M2D_OK) return M2D_INVALID_ARGUMENT;
#ifndef MOCHI2D_HAS_D3D11
  (void)frame;
  return not_built(error, "d3d11-not-built", "the library was built without the Direct3D 11 backend");
#else
  clear_error(error);
  HeapScope scope(&renderer->heap);
  const render::FrameOptions options = frame_options(*renderer->model, instance, frame, width, height);
  render::d3d11::D3d11Target t;
  t.view = render_target_view;
  if (!renderer->renderer->draw(*I(instance), options, t)) {
    set_error(error, M2D_INTERNAL_ERROR, renderer->renderer->error_code(), renderer->renderer->error().c_str());
    return M2D_INTERNAL_ERROR;
  }
  return M2D_OK;
#endif
}

void m2d_d3d11_renderer_stats(const m2d_d3d11_renderer* renderer, m2d_render_stats* out) {
  if (!out) return;
  *out = m2d_render_stats{};
#ifdef MOCHI2D_HAS_D3D11
  if (renderer && renderer->renderer) copy_stats(renderer->renderer->plan().stats, out);
#else
  (void)renderer;
#endif
}

int32_t m2d_d3d11_renderer_max_texture_size(const m2d_d3d11_renderer* renderer) {
#ifdef MOCHI2D_HAS_D3D11
  return renderer && renderer->renderer ? renderer->renderer->max_texture_size() : 0;
#else
  (void)renderer;
  return 0;
#endif
}

m2d_status m2d_d3d11_renderer_update_texture(m2d_d3d11_renderer* renderer, int32_t index, const void* pixels,
                                             int32_t width, int32_t height, int32_t stride, int32_t x, int32_t y,
                                             m2d_error* error) {
  if (check_update(renderer, pixels, width, height, stride, error) != M2D_OK) return M2D_INVALID_ARGUMENT;
#ifndef MOCHI2D_HAS_D3D11
  (void)index;
  (void)x;
  (void)y;
  return not_built(error, "d3d11-not-built", "the library was built without the Direct3D 11 backend");
#else
  clear_error(error);
  HeapScope scope(&renderer->heap);
  return update_through(*renderer->renderer, index, pixels, width, height, stride, x, y, error);
#endif
}

}  // extern "C"

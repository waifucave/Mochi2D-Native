// The OpenGL backend (docs/design.md §8.10): Mochi2D's WebGL2 renderer
// (src/render/model/model-renderer.ts and shaders.ts) on OpenGL ES 3.0 or
// desktop OpenGL 3.3 core, the same code for both (only the shaders' version
// line differs). It executes the backend-neutral frame plan (render/plan.hpp)
// in the host's context, into the host's framebuffer: the library creates no
// window and no context.
//
// Every call into it needs the host's context current on the calling
// thread, the one the renderer was created in (or one sharing its objects).
// It owns its GL objects: the model's textures, its vertex and index
// buffers, the mask buffers, the layers and the destination copy, all
// released in its destructor (with the context current). Its own memory goes
// through the library's allocators like every other object.
#pragma once

#include <cstdint>
#include <memory>

#include "render/gl/gl_api.hpp"
#include "render/plan.hpp"
#include "render/renderer.hpp"
#include "util/alloc.hpp"

namespace mochi2d::render::gl {

struct GlOptions {
  /** GLSL ES 3.00 (OpenGL ES 3.0, WebGL2's) or, with `desktop`, GLSL 3.30 core (OpenGL 3.3). */
  bool desktop = false;
  int mask_size = Renderer::kMaskSize;
  int offscreen_mask_size = Renderer::kOffscreenMaskSize;
  /**
   * The largest texture side taken: 0 (the default) the context's
   * GL_MAX_TEXTURE_SIZE, as Mochi2D takes the driver's; n > 0 at most n
   * (kMaxTextureSize, 8192, is the reference configuration's).
   */
  int max_texture_size = 0;
};

class GlRenderer {
 public:
  /**
   * Creates the GL objects for a model and its prepared textures (as the
   * software renderer takes them; a missing texture draws nothing). Check
   * `ok()`: false with `error()` when the context lacks a function, a
   * shader does not compile, or a texture is larger than the context allows.
   */
  GlRenderer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const Texture>> textures, const Api& api,
             const GlOptions& options = {});
  ~GlRenderer();
  GlRenderer(const GlRenderer&) = delete;
  GlRenderer& operator=(const GlRenderer&) = delete;

  bool ok() const { return created_; }
  const String& error() const { return error_; }
  /** The kind of the error: "gl-shader", "gl-texture-size" or "gl-error". */
  const char* error_code() const { return error_code_; }

  /**
   * Draws the instance's latest evaluation into the host's framebuffer
   * `framebuffer` (0: the default one) of framing.width × framing.height,
   * RGBA8. False with `error()` on a GL error (the renderer stays usable).
   */
  bool draw(const eval::Instance& instance, const FrameOptions& frame, GLuint framebuffer);

  /**
   * Replaces texture `index`, or its region at (x, y) the size of the
   * straight-alpha image (w × h, rows `stride` bytes apart, 0 for 4·w), as
   * Mochi2D 0.14.0's updateTexture: the prepared levels recomputed where the
   * region reaches (render::update_texture) and only those rectangles
   * uploaded. Drawn from the next draw. The context must be current. False
   * for a missing texture, a region that does not fit, or a GL error.
   */
  bool update_texture(int index, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x, int y);

  /** The plan of the latest frame. */
  const FramePlan& plan() const { return plan_; }
  bool layered() const { return rm_.layered; }
  /** The texture limit in effect (the context's, or the option's when smaller). */
  int max_texture_size() const { return max_texture_size_; }

 private:
  struct Target {
    GLuint texture = 0, framebuffer = 0;
    int width = 0, height = 0;
  };
  struct Program {
    GLuint id = 0;
    GLint u[24] = {};
  };
  bool fail(const char* what, const String& detail = String(), const char* code = "gl-error");
  bool build_program(Program& p, const String& vs, const String& fs, const char* name);
  bool ensure_target(Target& t, int width, int height, bool linear);
  void release_target(Target& t);
  void upload_vertices(const eval::Instance& instance);
  void set_colors_and_mask(const Program& p, const RenderOp& op);
  void apply_blend(BlendKind kind);
  void draw_elements(int drawable);
  void execute(const RenderOp& op, GLuint frame_fb);

  std::shared_ptr<const moc::Model> model_;
  Vector<std::shared_ptr<const Texture>> textures_;
  Vector<uint8_t> own_texture_;
  Api gl_;
  GlOptions options_;
  RenderModel rm_;
  bool ok_ = true, created_ = false;
  int max_texture_size_ = 0;
  String error_;
  const char* error_code_ = "";
  Vector<GLuint> gl_textures_;
  Vector<uint8_t> has_texture_;
  GLuint vao_ = 0, fullscreen_vao_ = 0, positions_ = 0, uvs_ = 0, indices_ = 0;
  Vector<uint32_t> vertex_start_, index_start_, index_count_;
  Vector<uint32_t> staged_;
  uint64_t staged_for_ = 0;
  Program mesh_, mesh_advanced_, layer_, layer_advanced_, mask_;
  Target mask_target_, offscreen_mask_target_, dst_copy_;
  Vector<Target> layers_;
  FramePlan plan_;
  Framing framing_;
};

}  // namespace mochi2d::render::gl

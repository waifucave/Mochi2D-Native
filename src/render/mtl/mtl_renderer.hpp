// The Metal backend (docs/design.md §8.13): the frame plan (render/plan.hpp)
// executed with Metal, the GL backend's programs translated to MSL
// (render/gpu/cross_sources.hpp, compiled by Metal when the renderer is
// made), encoded into the host's command buffer and drawn into the host's
// texture. The library makes no device, queue or layer, and presents
// nothing. This header has no Objective-C: the Metal objects cross as
// pointers (an `id` bridged to `void*`); mtl_renderer.mm, built on Apple
// platforms with ARC, holds them.
//
// The host's side:
// - its MTLDevice (the renderer retains it);
// - per frame, a command buffer of a queue of that device, with no encoder
//   open, and the target: a 2D texture with RenderTarget usage, in any
//   color pixel format the device can blend into (RGBA8Unorm for Mochi2D's
//   results), the frame's size (a clear clears the whole texture). The
//   renderer encodes its passes into the command buffer and commits
//   nothing; the host commits it, and the command buffers of one renderer
//   go to one queue in the order they were encoded (the renderer's own
//   textures and its positions buffer, written by range by a blit at the
//   start of each draw, rely on Metal's hazard tracking, the default,
//   between them).
// - The programs are compiled once per device and shared by its renderers.
// - Texture updates (update_texture) are encoded into the next draw's
//   command buffer, ahead of its passes.
//
// The image comes out with the top row first (flip_y, the default: the
// programs leave clip space as it is, y = +1 at row 0), premultiplied;
// inside, masks and layers are laid out as in OpenGL (rows from the
// bottom: the programs negate y), so the programs are the GL backend's.
#pragma once

#include <cstdint>
#include <memory>

#include "render/plan.hpp"
#include "render/renderer.hpp"
#include "util/alloc.hpp"

namespace mochi2d::render::mtl {

struct MtlContext {
  /** id<MTLDevice>. */
  void* device = nullptr;
};

struct MtlOptions {
  int mask_size = Renderer::kMaskSize;
  int offscreen_mask_size = Renderer::kOffscreenMaskSize;
  /** The largest texture side: 0 the device's (16384 on Apple and Mac GPUs of Metal 2); n > 0 at most n. */
  int max_texture_size = 0;
  /** The top row first in the host's texture (false: the bottom row first, as OpenGL's framebuffers). */
  bool flip_y = true;
};

struct MtlTarget {
  /** id<MTLTexture>: 2D, RenderTarget usage. */
  void* texture = nullptr;
};

class MtlRenderer {
 public:
  MtlRenderer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const Texture>> textures,
              const MtlContext& context, const MtlOptions& options = {});
  ~MtlRenderer();
  MtlRenderer(const MtlRenderer&) = delete;
  MtlRenderer& operator=(const MtlRenderer&) = delete;

  bool ok() const { return created_; }
  const String& error() const { return error_; }
  /** "mtl-function", "mtl-shader", "mtl-texture-size", "mtl-format" or "mtl-error". */
  const char* error_code() const { return error_code_; }

  /**
   * Encodes the instance's latest evaluation, drawn into `target` of
   * framing.width × framing.height, into `command_buffer`
   * (id<MTLCommandBuffer>). False with `error()` when the target cannot be
   * drawn into (its format, "mtl-format") or Metal refuses an object.
   */
  bool draw(const eval::Instance& instance, const FrameOptions& frame, void* command_buffer, const MtlTarget& target);
  /**
   * Replaces texture `index`, or its region at (x, y), as Mochi2D 0.14.0's
   * updateTexture: the prepared levels recomputed where the region reaches,
   * and those rectangles copied into the texture by a blit at the start of
   * the next draw's command buffer. False for a missing texture or a region
   * that does not fit.
   */
  bool update_texture(int index, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x, int y);

  const FramePlan& plan() const { return plan_; }
  int max_texture_size() const { return max_texture_size_; }
  /** MSL libraries compiled so far in the process: the programs are compiled once per device and shared. */
  static int library_compiles();

  struct Objects;

 private:
  bool fail(const char* what, const char* code = "mtl-error");
  bool create();
  bool execute(const RenderOp& op);

  std::shared_ptr<const moc::Model> model_;
  Vector<std::shared_ptr<const Texture>> textures_;
  Vector<uint8_t> own_texture_;
  MtlOptions options_;
  RenderModel rm_;
  bool ok_ = true, created_ = false;
  String error_;
  const char* error_code_ = "";
  int max_texture_size_ = 0;
  Vector<uint8_t> has_texture_;
  Vector<uint32_t> vertex_start_, index_start_, index_count_, staged_;
  uint64_t staged_for_ = 0;
  FramePlan plan_;
  Framing framing_;
  /** The Metal objects (mtl_renderer.mm). */
  Objects* objects_ = nullptr;
};

}  // namespace mochi2d::render::mtl

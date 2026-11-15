// The Direct3D 11 backend (docs/design.md §8.14): the frame plan
// (render/plan.hpp) executed with Direct3D 11 at feature level 11_0 or
// above, the GL backend's programs translated to HLSL
// (render/gpu/cross_sources.hpp) and compiled by fxc when the library is
// built (shader model 5.0), drawn with the host's device and context into
// the host's render target view. The library makes no device, swap chain
// or window, and links no Direct3D library: the host's device makes every
// object. This header needs no Windows header: the objects cross as
// pointers (COM interfaces), each AddRef'd while the renderer keeps it.
//
// The host's side:
// - its ID3D11Device and an ID3D11DeviceContext of it (the immediate
//   context, or a deferred one whose command lists the host executes in
//   the order they were recorded): textures are uploaded through it at
//   creation, and updated through it (UpdateSubresource, ordered after the
//   work already issued to it);
// - per frame, the target: an ID3D11RenderTargetView of a 2D texture the
//   frame's size (a clear clears the whole view), in any color format the
//   device can blend into (R8G8B8A8_UNORM for Mochi2D's results).
// - A draw sets the context's state as it needs (shaders, input layout,
//   buffers, views, samplers, blend, rasterizer and depth states,
//   viewport, scissor) and leaves no view of its own bound; the host sets
//   its own state again.
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

namespace mochi2d::render::d3d11 {

struct D3d11Context {
  /** ID3D11Device* and ID3D11DeviceContext*. */
  void* device = nullptr;
  void* context = nullptr;
};

struct D3d11Options {
  int mask_size = Renderer::kMaskSize;
  int offscreen_mask_size = Renderer::kOffscreenMaskSize;
  /** The largest texture side: 0 the device's (16384 at feature level 11_0); n > 0 at most n. */
  int max_texture_size = 0;
  /** The top row first in the host's texture (false: the bottom row first, as OpenGL's framebuffers). */
  bool flip_y = true;
};

struct D3d11Target {
  /** ID3D11RenderTargetView* of a 2D texture. */
  void* view = nullptr;
};

class D3d11Renderer {
 public:
  D3d11Renderer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const Texture>> textures,
                const D3d11Context& context, const D3d11Options& options = {});
  ~D3d11Renderer();
  D3d11Renderer(const D3d11Renderer&) = delete;
  D3d11Renderer& operator=(const D3d11Renderer&) = delete;

  bool ok() const { return created_; }
  const String& error() const { return error_; }
  /** "d3d11-function" (no device, or a feature level below 11_0), "d3d11-texture-size", "d3d11-format" or "d3d11-error". */
  const char* error_code() const { return error_code_; }

  /**
   * Draws the instance's latest evaluation into `target` of framing.width ×
   * framing.height through the context. False with `error()` when an object
   * cannot be made or the target is not a 2D texture's view of that size.
   */
  bool draw(const eval::Instance& instance, const FrameOptions& frame, const D3d11Target& target);
  /**
   * Replaces texture `index`, or its region at (x, y), as Mochi2D 0.14.0's
   * updateTexture: the prepared levels recomputed where the region reaches,
   * and those rectangles written into the texture through the context.
   * False for a missing texture or a region that does not fit.
   */
  bool update_texture(int index, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x, int y);

  const FramePlan& plan() const { return plan_; }
  int max_texture_size() const { return max_texture_size_; }

  struct Objects;

 private:
  bool fail(const char* what, const char* code = "d3d11-error", long hr = 0);
  bool check(long hr, const char* what);
  bool create(const D3d11Context& context);
  bool execute(const RenderOp& op);

  std::shared_ptr<const moc::Model> model_;
  Vector<std::shared_ptr<const Texture>> textures_;
  Vector<uint8_t> own_texture_;
  D3d11Options options_;
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
  /** The Direct3D objects (d3d11_renderer.cpp). */
  Objects* objects_ = nullptr;
};

}  // namespace mochi2d::render::d3d11

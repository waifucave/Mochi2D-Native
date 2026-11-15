// The Metal backend's test tool (tests/gpu/gpu_tool.hpp): a headless Metal
// host (the system's device, a queue, an RGBA8 texture per frame size, read
// back through a shared buffer) that renders scenarios through the Metal
// backend, as `mochi2d-native render` does with the reference renderer, and
// checks the C API. `--device <name>` picks a device whose name contains
// it. Exit code 77 without a Metal device. Test code: the library makes no
// device. Objective-C++ with ARC.
#import <Metal/Metal.h>

#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include "gpu/gpu_tool.hpp"
#include "mochi2d.h"
#include "render/mtl/mtl_renderer.hpp"

using namespace mochi2d;
namespace rmtl = mochi2d::render::mtl;

namespace {

struct Host {
  id<MTLDevice> device;
  id<MTLCommandQueue> queue;
};
Host g_host;

/** The host's target: an RGBA8 texture and a buffer the frame is read back through. */
struct Target {
  id<MTLTexture> texture;
  id<MTLBuffer> buffer;
  int width = 0, height = 0;
  bool make(int w, int h) {
    if (texture && width == w && height == h) return true;
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
                                                                                width:static_cast<NSUInteger>(w)
                                                                               height:static_cast<NSUInteger>(h)
                                                                            mipmapped:NO];
    d.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    d.storageMode = MTLStorageModePrivate;
    texture = [g_host.device newTextureWithDescriptor:d];
    buffer = [g_host.device newBufferWithLength:static_cast<NSUInteger>(w) * static_cast<NSUInteger>(h) * 4
                                        options:MTLResourceStorageModeShared];
    width = w;
    height = h;
    return texture && buffer;
  }
  /** The texture copied into the buffer, the command buffer committed and waited for, its rows read. */
  bool finish(id<MTLCommandBuffer> cmd, std::vector<uint8_t>& rgba) {
    id<MTLBlitCommandEncoder> blit = [cmd blitCommandEncoder];
    [blit copyFromTexture:texture
                     sourceSlice:0
                     sourceLevel:0
                    sourceOrigin:MTLOriginMake(0, 0, 0)
                      sourceSize:MTLSizeMake(static_cast<NSUInteger>(width), static_cast<NSUInteger>(height), 1)
                        toBuffer:buffer
               destinationOffset:0
          destinationBytesPerRow:static_cast<NSUInteger>(width) * 4
        destinationBytesPerImage:static_cast<NSUInteger>(width) * static_cast<NSUInteger>(height) * 4];
    [blit endEncoding];
    [cmd commit];
    [cmd waitUntilCompleted];
    if (cmd.status != MTLCommandBufferStatusCompleted) {
      if (cmd.error) std::cerr << "command buffer: " << cmd.error.localizedDescription.UTF8String << "\n";
      return false;
    }
    rgba.resize(static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4);
    std::memcpy(rgba.data(), buffer.contents, rgba.size());
    return true;
  }
};

int device_limit(id<MTLDevice> d) {
  if (@available(macOS 10.15, *))
    if ([d supportsFamily:MTLGPUFamilyApple3] || [d supportsFamily:MTLGPUFamilyMac2]) return 16384;
  return 8192;
}

class MtlDrawer : public conformance::Drawer {
 public:
  MtlDrawer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const render::Texture>> textures,
            const rmtl::MtlOptions& options)
      : r_(std::move(model), std::move(textures), ctx(), options), options_(options) {}
  static rmtl::MtlContext ctx() {
    rmtl::MtlContext c;
    c.device = (__bridge void*)g_host.device;
    return c;
  }
  bool ok(String& error) const {
    if (!r_.ok()) error = r_.error();
    return r_.ok();
  }
  bool draw(const eval::Instance& instance, const render::FrameOptions& frame, render::Image& out,
            String& error) override {
    @autoreleasepool {
      const int w = frame.framing.width, h = frame.framing.height;
      if (!target_.make(w, h)) {
        error = "the host's texture cannot be made";
        return false;
      }
      id<MTLCommandBuffer> cmd = [g_host.queue commandBuffer];
      rmtl::MtlTarget t;
      t.texture = (__bridge void*)target_.texture;
      if (!r_.draw(instance, frame, (__bridge void*)cmd, t)) {
        error = r_.error();
        return false;
      }
      std::vector<uint8_t> px;
      if (!target_.finish(cmd, px)) {
        error = "the frame cannot be read back";
        return false;
      }
      out.width = w;
      out.height = h;
      out.rgba.assign(px.begin(), px.end());
      return true;
    }
  }
  const render::FrameStats& stats() const override { return r_.plan().stats; }
  int mask_size() const override { return options_.mask_size; }
  int offscreen_mask_size() const override { return options_.offscreen_mask_size; }
  String name() const override { return String("mochi2d-native Metal backend (") + g_host.device.name.UTF8String + ")"; }

 private:
  rmtl::MtlRenderer r_;
  Target target_;
  rmtl::MtlOptions options_;
};

/** The C API's renderer and the target it draws into. */
struct Capi {
  m2d_mtl_renderer* r = nullptr;
  Target target;
};

bool open_host(test::GpuTool& t, const std::string& want, std::string& error) {
  NSArray<id<MTLDevice>>* all = MTLCopyAllDevices();
  for (id<MTLDevice> d in all)
    if (want.empty() || std::string(d.name.UTF8String).find(want) != std::string::npos) {
      g_host.device = d;
      break;
    }
  if (!g_host.device && want.empty()) g_host.device = MTLCreateSystemDefaultDevice();
  if (!g_host.device) {
    error = "no Metal device";
    return false;
  }
  g_host.queue = [g_host.device newCommandQueue];
  if (!g_host.queue) {
    error = "no command queue";
    return false;
  }
  t.device = g_host.device.name.UTF8String;
  t.device_limit = device_limit(g_host.device);
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  @autoreleasepool {
    test::GpuTool t;
    t.tool = "mochi2d-mtl-render";
    t.backend = "Metal";
    t.prefix = "mtl";
    t.drawer = [](std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const render::Texture>> textures,
                  int cap, String& error) -> std::unique_ptr<conformance::Drawer> {
      rmtl::MtlOptions o;
      o.max_texture_size = cap;
      auto d = std::make_unique<MtlDrawer>(std::move(model), std::move(textures), o);
      if (!d->ok(error)) return nullptr;
      return d;
    };
    t.available = [] { return m2d_mtl_available(); };
    t.create = [](m2d_model* model, m2d_texture* const* textures, int32_t count, int32_t cap, int32_t flip_y,
                  void** out, m2d_error* err) {
      m2d_mtl_options o;
      m2d_mtl_options_default(&o);
      o.max_texture_size = cap;
      o.flip_y = flip_y;
      auto* c = new Capi();
      const m2d_status st =
          m2d_mtl_renderer_create(model, textures, count, (__bridge void*)g_host.device, &o, &c->r, err);
      if (st != M2D_OK) {
        delete c;
        *out = nullptr;
        return st;
      }
      *out = c;
      return st;
    };
    t.destroy = [](void* p) {
      auto* c = static_cast<Capi*>(p);
      m2d_mtl_renderer_destroy(c->r);
      delete c;
    };
    t.draw = [](void* p, const m2d_instance* inst, const m2d_render_frame* frame, int32_t w, int32_t h,
                std::vector<uint8_t>& rgba, m2d_error* err) {
      @autoreleasepool {
        auto* c = static_cast<Capi*>(p);
        if (!c->target.make(w, h)) return M2D_INTERNAL_ERROR;
        id<MTLCommandBuffer> cmd = [g_host.queue commandBuffer];
        const m2d_status st = m2d_mtl_renderer_draw(c->r, inst, frame, w, h, (__bridge void*)cmd,
                                                    (__bridge void*)c->target.texture, err);
        if (st != M2D_OK) return st;
        return c->target.finish(cmd, rgba) ? M2D_OK : M2D_INTERNAL_ERROR;
      }
    };
    t.update_texture = [](void* p, int32_t index, const void* px, int32_t w, int32_t h, int32_t stride, int32_t x,
                          int32_t y, m2d_error* err) {
      return m2d_mtl_renderer_update_texture(static_cast<Capi*>(p)->r, index, px, w, h, stride, x, y, err);
    };
    t.stats = [](const void* p, m2d_render_stats* out) {
      m2d_mtl_renderer_stats(static_cast<const Capi*>(p)->r, out);
    };
    t.max_texture_size = [](const void* p) { return m2d_mtl_renderer_max_texture_size(static_cast<const Capi*>(p)->r); };
    t.draw_without_target = [](void* p, const m2d_instance* inst, const m2d_render_frame* frame, m2d_error* err) {
      @autoreleasepool {
        id<MTLCommandBuffer> cmd = [g_host.queue commandBuffer];
        return m2d_mtl_renderer_draw(static_cast<Capi*>(p)->r, inst, frame, 16, 16, (__bridge void*)cmd, nullptr,
                                     err);
      }
    };
    // The programs are compiled once per device: another renderer compiles nothing.
    t.extra = [](m2d_model* model, std::string& message) {
      const int before = rmtl::MtlRenderer::library_compiles();
      m2d_mtl_renderer* again = nullptr;
      m2d_error err;
      const bool made = m2d_mtl_renderer_create(model, nullptr, 0, (__bridge void*)g_host.device, nullptr, &again,
                                                &err) == M2D_OK;
      m2d_mtl_renderer_destroy(again);
      const int compiled = rmtl::MtlRenderer::library_compiles() - before;
      message = "library cache: " + std::to_string(rmtl::MtlRenderer::library_compiles()) +
                " MSL libraries compiled in all, " + std::to_string(compiled) + " for another renderer";
      return made && compiled == 0;
    };
    return test::gpu_tool_main(argc, argv, t, open_host);
  }
}

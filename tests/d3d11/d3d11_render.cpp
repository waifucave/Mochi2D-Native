// The Direct3D 11 backend's test tool (tests/gpu/gpu_tool.hpp): a headless
// Direct3D 11 host (a device on WARP, Windows's software rasterizer, by
// default, or `--device hardware`; an RGBA8 texture per frame size, read
// back through a staging texture) that renders scenarios through the
// Direct3D 11 backend, as `mochi2d-native render` does with the reference
// renderer, and checks the C API. Exit code 77 without a device. Test
// code: the library makes no device.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <d3d11.h>
#include <dxgi.h>

#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include "gpu/gpu_tool.hpp"
#include "mochi2d.h"
#include "render/d3d11/d3d11_renderer.hpp"

using namespace mochi2d;
namespace rd3d = mochi2d::render::d3d11;

namespace {

template <class T>
void release(T*& p) {
  if (p) p->Release();
  p = nullptr;
}

struct Host {
  ID3D11Device* device = nullptr;
  ID3D11DeviceContext* context = nullptr;
  ~Host() {
    release(context);
    release(device);
  }
};
Host g_host;

/** The host's target: an RGBA8 texture with a render target view, read back through a staging texture. */
struct Target {
  ID3D11Texture2D* texture = nullptr;
  ID3D11Texture2D* staging = nullptr;
  ID3D11RenderTargetView* view = nullptr;
  int width = 0, height = 0;
  ~Target() { reset(); }
  void reset() {
    release(view);
    release(staging);
    release(texture);
    width = height = 0;
  }
  bool make(int w, int h) {
    if (texture && width == w && height == h) return true;
    reset();
    D3D11_TEXTURE2D_DESC td{};
    td.Width = static_cast<UINT>(w);
    td.Height = static_cast<UINT>(h);
    td.MipLevels = td.ArraySize = 1;
    td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(g_host.device->CreateTexture2D(&td, nullptr, &texture))) return false;
    td.Usage = D3D11_USAGE_STAGING;
    td.BindFlags = 0;
    td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    if (FAILED(g_host.device->CreateTexture2D(&td, nullptr, &staging))) return false;
    if (FAILED(g_host.device->CreateRenderTargetView(texture, nullptr, &view))) return false;
    width = w;
    height = h;
    return true;
  }
  bool read(std::vector<uint8_t>& rgba) {
    g_host.context->CopyResource(staging, texture);
    D3D11_MAPPED_SUBRESOURCE m{};
    if (FAILED(g_host.context->Map(staging, 0, D3D11_MAP_READ, 0, &m))) return false;
    rgba.resize(static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4);
    for (int y = 0; y < height; y++)
      std::memcpy(&rgba[static_cast<std::size_t>(y) * static_cast<std::size_t>(width) * 4],
                  static_cast<const uint8_t*>(m.pData) + static_cast<std::size_t>(y) * m.RowPitch,
                  static_cast<std::size_t>(width) * 4);
    g_host.context->Unmap(staging, 0);
    return true;
  }
};

class D3dDrawer : public conformance::Drawer {
 public:
  D3dDrawer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const render::Texture>> textures,
            const rd3d::D3d11Options& options)
      : r_(std::move(model), std::move(textures), ctx(), options), options_(options) {}
  static rd3d::D3d11Context ctx() {
    rd3d::D3d11Context c;
    c.device = g_host.device;
    c.context = g_host.context;
    return c;
  }
  bool ok(String& error) const {
    if (!r_.ok()) error = r_.error();
    return r_.ok();
  }
  bool draw(const eval::Instance& instance, const render::FrameOptions& frame, render::Image& out,
            String& error) override {
    const int w = frame.framing.width, h = frame.framing.height;
    if (!target_.make(w, h)) {
      error = "the host's texture cannot be made";
      return false;
    }
    rd3d::D3d11Target t;
    t.view = target_.view;
    if (!r_.draw(instance, frame, t)) {
      error = r_.error();
      return false;
    }
    std::vector<uint8_t> px;
    if (!target_.read(px)) {
      error = "the frame cannot be read back";
      return false;
    }
    out.width = w;
    out.height = h;
    out.rgba.assign(px.begin(), px.end());
    return true;
  }
  const render::FrameStats& stats() const override { return r_.plan().stats; }
  int mask_size() const override { return options_.mask_size; }
  int offscreen_mask_size() const override { return options_.offscreen_mask_size; }
  String name() const override { return String("mochi2d-native Direct3D 11 backend (") + name_.c_str() + ")"; }
  static std::string name_;

 private:
  rd3d::D3d11Renderer r_;
  Target target_;
  rd3d::D3d11Options options_;
};
std::string D3dDrawer::name_;

/** The C API's renderer and the target it draws into. */
struct Capi {
  m2d_d3d11_renderer* r = nullptr;
  Target target;
};

std::string adapter_name(ID3D11Device* device) {
  std::string name = "Direct3D 11 device";
  IDXGIDevice* dxgi = nullptr;
  IDXGIAdapter* adapter = nullptr;
  DXGI_ADAPTER_DESC desc{};
  if (SUCCEEDED(device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(&dxgi))) &&
      SUCCEEDED(dxgi->GetAdapter(&adapter)) && SUCCEEDED(adapter->GetDesc(&desc))) {
    char text[256] = {};
    WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, text, sizeof text - 1, nullptr, nullptr);
    name = text;
  }
  release(adapter);
  release(dxgi);
  return name;
}

bool open_host(test::GpuTool& t, const std::string& want, std::string& error) {
  const D3D_DRIVER_TYPE type = want == "hardware" ? D3D_DRIVER_TYPE_HARDWARE : D3D_DRIVER_TYPE_WARP;
  const D3D_FEATURE_LEVEL levels[2] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  D3D_FEATURE_LEVEL got{};
  HRESULT hr = D3D11CreateDevice(nullptr, type, nullptr, 0, levels, 2, D3D11_SDK_VERSION, &g_host.device, &got,
                                 &g_host.context);
  if (FAILED(hr))  // Windows 7's runtime has no 11_1.
    hr = D3D11CreateDevice(nullptr, type, nullptr, 0, levels + 1, 1, D3D11_SDK_VERSION, &g_host.device, &got,
                           &g_host.context);
  if (FAILED(hr)) {
    error = "no Direct3D 11 device at feature level 11_0";
    return false;
  }
  t.device = adapter_name(g_host.device) + (got == D3D_FEATURE_LEVEL_11_1 ? " (feature level 11_1)" : " (feature level 11_0)");
  t.device_limit = D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION;
  D3dDrawer::name_ = t.device;
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  test::GpuTool t;
  t.tool = "mochi2d-d3d11-render";
  t.backend = "Direct3D 11";
  t.prefix = "d3d11";
  t.drawer = [](std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const render::Texture>> textures,
                int cap, String& error) -> std::unique_ptr<conformance::Drawer> {
    rd3d::D3d11Options o;
    o.max_texture_size = cap;
    auto d = std::make_unique<D3dDrawer>(std::move(model), std::move(textures), o);
    if (!d->ok(error)) return nullptr;
    return d;
  };
  t.available = [] { return m2d_d3d11_available(); };
  t.create = [](m2d_model* model, m2d_texture* const* textures, int32_t count, int32_t cap, int32_t flip_y,
                void** out, m2d_error* err) {
    m2d_d3d11_options o;
    m2d_d3d11_options_default(&o);
    o.max_texture_size = cap;
    o.flip_y = flip_y;
    auto* c = new Capi();
    const m2d_status st =
        m2d_d3d11_renderer_create(model, textures, count, g_host.device, g_host.context, &o, &c->r, err);
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
    m2d_d3d11_renderer_destroy(c->r);
    delete c;
  };
  t.draw = [](void* p, const m2d_instance* inst, const m2d_render_frame* frame, int32_t w, int32_t h,
              std::vector<uint8_t>& rgba, m2d_error* err) {
    auto* c = static_cast<Capi*>(p);
    if (!c->target.make(w, h)) return M2D_INTERNAL_ERROR;
    const m2d_status st = m2d_d3d11_renderer_draw(c->r, inst, frame, w, h, c->target.view, err);
    if (st != M2D_OK) return st;
    return c->target.read(rgba) ? M2D_OK : M2D_INTERNAL_ERROR;
  };
  t.update_texture = [](void* p, int32_t index, const void* px, int32_t w, int32_t h, int32_t stride, int32_t x,
                        int32_t y, m2d_error* err) {
    return m2d_d3d11_renderer_update_texture(static_cast<Capi*>(p)->r, index, px, w, h, stride, x, y, err);
  };
  t.stats = [](const void* p, m2d_render_stats* out) {
    m2d_d3d11_renderer_stats(static_cast<const Capi*>(p)->r, out);
  };
  t.max_texture_size = [](const void* p) {
    return m2d_d3d11_renderer_max_texture_size(static_cast<const Capi*>(p)->r);
  };
  t.draw_without_target = [](void* p, const m2d_instance* inst, const m2d_render_frame* frame, m2d_error* err) {
    return m2d_d3d11_renderer_draw(static_cast<Capi*>(p)->r, inst, frame, 16, 16, nullptr, err);
  };
  return test::gpu_tool_main(argc, argv, t, open_host);
}

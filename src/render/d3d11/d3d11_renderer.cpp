// The Direct3D 11 backend (d3d11_renderer.hpp).
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <d3d11_1.h>

#include "render/d3d11/d3d11_renderer.hpp"

#include <algorithm>
#include <cstring>
#include <new>

#include "render/shaders.hpp"

namespace mochi2d::render::d3d11 {

namespace {
// The programs' DXBC: the committed HLSL (render/gpu/hlsl/) compiled by fxc
// when the library is built (CMakeLists.txt), each a `const BYTE kDxbc_*[]`.
#include "d3d11_dxbc/layer_advanced_frag.h"
#include "d3d11_dxbc/layer_advanced_vert.h"
#include "d3d11_dxbc/layer_frag.h"
#include "d3d11_dxbc/layer_vert.h"
#include "d3d11_dxbc/mask_frag.h"
#include "d3d11_dxbc/mask_vert.h"
#include "d3d11_dxbc/mesh_advanced_frag.h"
#include "d3d11_dxbc/mesh_advanced_vert.h"
#include "d3d11_dxbc/mesh_frag.h"
#include "d3d11_dxbc/mesh_vert.h"

using std::size_t;
size_t Z(int64_t i) { return static_cast<size_t>(i); }

constexpr int kPrograms = static_cast<int>(ShaderProgram::Count);
constexpr int kMaskProgram = static_cast<int>(ShaderProgram::Mask);
constexpr DXGI_FORMAT kInternalFormat = DXGI_FORMAT_R8G8B8A8_UNORM;

struct Bytecode {
  const void* data;
  size_t size;
};
template <size_t N>
Bytecode of(const BYTE (&b)[N]) {
  return {b, N};
}
Bytecode bytecode(int program, int stage) {
  const bool v = stage == 0;
  switch (static_cast<ShaderProgram>(program)) {
    case ShaderProgram::Mesh:
      return v ? of(kDxbc_mesh_vert) : of(kDxbc_mesh_frag);
    case ShaderProgram::MeshAdvanced:
      return v ? of(kDxbc_mesh_advanced_vert) : of(kDxbc_mesh_advanced_frag);
    case ShaderProgram::Layer:
      return v ? of(kDxbc_layer_vert) : of(kDxbc_layer_frag);
    case ShaderProgram::LayerAdvanced:
      return v ? of(kDxbc_layer_advanced_vert) : of(kDxbc_layer_advanced_frag);
    default:
      return v ? of(kDxbc_mask_vert) : of(kDxbc_mask_frag);
  }
}

template <class T>
void release(T*& p) {
  if (p) p->Release();
  p = nullptr;
}

/** A side of 0xff bytes, written tile by tile into a mask buffer's scissor where ClearView is missing. */
constexpr int kOnesSide = 256;
/** The constant buffer: the push-constant block rounded up to 16 bytes. */
constexpr std::size_t kConstantBytes = (sizeof(VulkanPushConstants) + 15) / 16 * 16;

}  // namespace

struct D3d11Renderer::Objects {
  struct Image {
    ID3D11Texture2D* texture = nullptr;
    ID3D11ShaderResourceView* srv = nullptr;
    ID3D11RenderTargetView* rtv = nullptr;
    int width = 0, height = 0;
    void reset() {
      release(rtv);
      release(srv);
      release(texture);
      width = height = 0;
    }
  };

  ID3D11Device* device = nullptr;
  ID3D11DeviceContext* context = nullptr;
  ID3D11DeviceContext1* context1 = nullptr;
  ID3D11VertexShader* vs[kPrograms] = {};
  ID3D11PixelShader* ps[kPrograms] = {};
  ID3D11InputLayout* layouts[kPrograms] = {};
  ID3D11SamplerState *texture_sampler = nullptr, *mask_sampler = nullptr, *nearest_sampler = nullptr;
  /** Normal, additive, multiplicative, none (advanced), mask. */
  ID3D11BlendState* blends[5] = {};
  /** [upright][cull]. */
  ID3D11RasterizerState* rasterizers[2][2] = {};
  ID3D11DepthStencilState* no_depth = nullptr;
  ID3D11Buffer *positions = nullptr, *uvs = nullptr, *indices = nullptr, *constants = nullptr;
  Vector<Image> textures;
  Image dummy, mask_target, offscreen_mask_target, dst_copy;
  Vector<Image> layers;
  int layer_width = 0, layer_height = 0;
  Vector<uint8_t> ones;

  // The frame being drawn.
  ID3D11RenderTargetView* host = nullptr;
  int32_t bound_target = -2;

  ~Objects() {
    for (auto& t : textures) t.reset();
    for (auto& l : layers) l.reset();
    dummy.reset();
    mask_target.reset();
    offscreen_mask_target.reset();
    dst_copy.reset();
    for (auto*& v : vs) release(v);
    for (auto*& p : ps) release(p);
    for (auto*& l : layouts) release(l);
    release(texture_sampler);
    release(mask_sampler);
    release(nearest_sampler);
    for (auto*& b : blends) release(b);
    for (auto& r : rasterizers)
      for (auto*& s : r) release(s);
    release(no_depth);
    release(positions);
    release(uvs);
    release(indices);
    release(constants);
    release(context1);
    release(context);
    release(device);
  }
};

// ------------------------------------------------------------------ setup

D3d11Renderer::D3d11Renderer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const Texture>> textures,
                             const D3d11Context& context, const D3d11Options& options)
    : model_(std::move(model)), textures_(std::move(textures)), options_(options), rm_(*model_) {
  void* p = allocate_bytes(sizeof(Objects), alignof(Objects));
  if (!p) {
    fail("out of memory");
    return;
  }
  objects_ = new (p) Objects();
  if (create(context)) created_ = ok_;
}

D3d11Renderer::~D3d11Renderer() {
  if (!objects_) return;
  objects_->~Objects();
  deallocate_bytes(objects_);
}

bool D3d11Renderer::fail(const char* what, const char* code, long hr) {
  ok_ = false;
  error_code_ = code;
  error_ = what;
  if (hr) {
    static const char kHex[] = "0123456789ABCDEF";
    char text[11] = "0x";
    for (int k = 0; k < 8; k++) text[2 + k] = kHex[(static_cast<unsigned long>(hr) >> (28 - 4 * k)) & 15];
    text[10] = 0;
    error_ += String(": HRESULT ") + text;
  }
  return false;
}

bool D3d11Renderer::check(long hr, const char* what) {
  if (SUCCEEDED(hr)) return true;
  return fail((String(what) + " fails").c_str(), "d3d11-error", hr);
}

bool D3d11Renderer::create(const D3d11Context& c) {
  Objects& o = *objects_;
  o.device = static_cast<ID3D11Device*>(c.device);
  o.context = static_cast<ID3D11DeviceContext*>(c.context);
  if (!o.device || !o.context) {
    o.device = nullptr;
    o.context = nullptr;
    return fail("no device or context", "d3d11-function");
  }
  o.device->AddRef();
  o.context->AddRef();
  // ClearView (Direct3D 11.1) clears a mask buffer's scissor; without it, tiles of 0xff bytes.
  if (FAILED(o.context->QueryInterface(__uuidof(ID3D11DeviceContext1), reinterpret_cast<void**>(&o.context1))))
    o.context1 = nullptr;
  ID3D11Device* dev = o.device;
  if (dev->GetFeatureLevel() < D3D_FEATURE_LEVEL_11_0)
    return fail("the device's feature level is below 11_0 (shader model 5.0)", "d3d11-function");
  max_texture_size_ = D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION;
  if (options_.max_texture_size > 0) max_texture_size_ = std::min(max_texture_size_, options_.max_texture_size);

  for (int prog = 0; prog < kPrograms; prog++) {
    const Bytecode v = bytecode(prog, 0), f = bytecode(prog, 1);
    if (!check(dev->CreateVertexShader(v.data, v.size, nullptr, &o.vs[prog]), "CreateVertexShader") ||
        !check(dev->CreatePixelShader(f.data, f.size, nullptr, &o.ps[prog]), "CreatePixelShader"))
      return false;
    const bool mesh_input = prog != static_cast<int>(ShaderProgram::Layer) &&
                            prog != static_cast<int>(ShaderProgram::LayerAdvanced);
    if (mesh_input) {
      // aPos and aUv (TEXCOORD0, TEXCOORD1), each from its own buffer.
      const D3D11_INPUT_ELEMENT_DESC in[2] = {
          {"TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0},
          {"TEXCOORD", 1, DXGI_FORMAT_R32G32_FLOAT, 1, 0, D3D11_INPUT_PER_VERTEX_DATA, 0}};
      if (!check(dev->CreateInputLayout(in, 2, v.data, v.size, &o.layouts[prog]), "CreateInputLayout")) return false;
    }
  }

  // Samplers: textures as Mochi2D's (trilinear, repeat), masks and layers
  // (bilinear, clamped: rule L), the destination copy (read with texelFetch).
  D3D11_SAMPLER_DESC sd{};
  sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_WRAP;
  sd.MaxAnisotropy = 1;
  sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
  sd.MinLOD = 0;
  sd.MaxLOD = D3D11_FLOAT32_MAX;
  if (!check(dev->CreateSamplerState(&sd, &o.texture_sampler), "CreateSamplerState")) return false;
  sd.Filter = D3D11_FILTER_MIN_MAG_LINEAR_MIP_POINT;
  sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  sd.MaxLOD = 0;
  if (!check(dev->CreateSamplerState(&sd, &o.mask_sampler), "CreateSamplerState")) return false;
  sd.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
  if (!check(dev->CreateSamplerState(&sd, &o.nearest_sampler), "CreateSamplerState")) return false;

  // Blending: ONE, ONE_MINUS_SRC_ALPHA; additive; multiplicative; none; the mask's.
  for (int k = 0; k < 5; k++) {
    D3D11_BLEND_DESC bd{};
    D3D11_RENDER_TARGET_BLEND_DESC& t = bd.RenderTarget[0];
    t.BlendEnable = k == 3 ? FALSE : TRUE;
    t.BlendOp = t.BlendOpAlpha = D3D11_BLEND_OP_ADD;
    t.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    t.SrcBlend = t.SrcBlendAlpha = D3D11_BLEND_ONE;
    t.DestBlend = t.DestBlendAlpha = D3D11_BLEND_ZERO;
    if (k == 0) {
      t.DestBlend = t.DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
    } else if (k == 1) {
      t.DestBlend = D3D11_BLEND_ONE;
      t.SrcBlendAlpha = D3D11_BLEND_ZERO;
      t.DestBlendAlpha = D3D11_BLEND_ONE;
    } else if (k == 2) {
      t.SrcBlend = D3D11_BLEND_DEST_COLOR;
      t.DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
      t.SrcBlendAlpha = D3D11_BLEND_ZERO;
      t.DestBlendAlpha = D3D11_BLEND_ONE;
    } else if (k == 4) {
      t.SrcBlend = t.SrcBlendAlpha = D3D11_BLEND_ZERO;
      t.DestBlend = t.DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
      t.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_RED;
    }
    if (!check(dev->CreateBlendState(&bd, &o.blends[k]), "CreateBlendState")) return false;
  }
  // OpenGL's counter-clockwise front faces, as they look in the image: the
  // host's texture is upright with flip_y; masks and layers are upside down.
  for (int upright = 0; upright < 2; upright++)
    for (int cull = 0; cull < 2; cull++) {
      D3D11_RASTERIZER_DESC rd{};
      rd.FillMode = D3D11_FILL_SOLID;
      rd.CullMode = cull ? D3D11_CULL_BACK : D3D11_CULL_NONE;
      rd.FrontCounterClockwise = upright ? TRUE : FALSE;
      rd.DepthClipEnable = TRUE;
      rd.ScissorEnable = TRUE;
      if (!check(dev->CreateRasterizerState(&rd, &o.rasterizers[upright][cull]), "CreateRasterizerState"))
        return false;
    }
  D3D11_DEPTH_STENCIL_DESC dd{};
  dd.DepthEnable = FALSE;
  dd.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ZERO;
  dd.DepthFunc = D3D11_COMPARISON_ALWAYS;
  if (!check(dev->CreateDepthStencilState(&dd, &o.no_depth), "CreateDepthStencilState")) return false;

  // Geometry: every mesh's vertices one after another, as the GL backend.
  const moc::Model& m = *model_;
  const size_t N = m.meshes.ids.size();
  uint32_t vertices = 0;
  Vector<uint32_t> all_indices;
  Vector<float> all_uvs;
  for (size_t i = 0; i < N; i++) {
    const uint32_t count = static_cast<uint32_t>(m.meshes.uvs[i].size() / 2);
    vertex_start_.push_back(vertices);
    index_start_.push_back(static_cast<uint32_t>(all_indices.size()));
    index_count_.push_back(static_cast<uint32_t>(rm_.triangles[i].size()));
    for (uint16_t k : rm_.triangles[i]) all_indices.push_back(vertices + k);
    // Rule V: v as the renderer samples it, flipped twice in float32.
    all_uvs.insert(all_uvs.end(), rm_.uvs[i].begin(), rm_.uvs[i].begin() + 2 * count);
    vertices += count;
  }
  staged_.assign(N, 0);
  const auto buffer = [&](ID3D11Buffer** out, const void* data, size_t bytes, UINT bind, D3D11_USAGE usage) {
    D3D11_BUFFER_DESC bd{};
    bd.ByteWidth = static_cast<UINT>(std::max<size_t>(bytes, 16));
    bd.Usage = usage;
    bd.BindFlags = bind;
    D3D11_SUBRESOURCE_DATA init{};
    init.pSysMem = data;
    return check(dev->CreateBuffer(&bd, data && bytes ? &init : nullptr, out), "CreateBuffer");
  };
  const uint32_t zeros[4] = {};
  if (!buffer(&o.uvs, all_uvs.empty() ? static_cast<const void*>(zeros) : all_uvs.data(), all_uvs.size() * 4,
              D3D11_BIND_VERTEX_BUFFER, D3D11_USAGE_IMMUTABLE) ||
      !buffer(&o.indices, all_indices.empty() ? static_cast<const void*>(zeros) : all_indices.data(),
              all_indices.size() * 4, D3D11_BIND_INDEX_BUFFER, D3D11_USAGE_IMMUTABLE) ||
      !buffer(&o.positions, nullptr, Z(vertices) * 8, D3D11_BIND_VERTEX_BUFFER, D3D11_USAGE_DEFAULT) ||
      !buffer(&o.constants, nullptr, kConstantBytes, D3D11_BIND_CONSTANT_BUFFER, D3D11_USAGE_DEFAULT))
    return false;

  // The textures' prepared levels as they are.
  const auto image = [&](Objects::Image& im, int w, int h, UINT levels, UINT bind,
                         const D3D11_SUBRESOURCE_DATA* init) -> bool {
    D3D11_TEXTURE2D_DESC td{};
    td.Width = static_cast<UINT>(w);
    td.Height = static_cast<UINT>(h);
    td.MipLevels = levels;
    td.ArraySize = 1;
    td.Format = kInternalFormat;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = bind;
    if (!check(dev->CreateTexture2D(&td, init, &im.texture), "CreateTexture2D") ||
        !check(dev->CreateShaderResourceView(im.texture, nullptr, &im.srv), "CreateShaderResourceView"))
      return false;
    if ((bind & D3D11_BIND_RENDER_TARGET) &&
        !check(dev->CreateRenderTargetView(im.texture, nullptr, &im.rtv), "CreateRenderTargetView"))
      return false;
    im.width = w;
    im.height = h;
    return true;
  };
  for (size_t i = 0; i < textures_.size(); i++) {
    const auto& t = textures_[i];
    has_texture_.push_back(t && !t->levels.empty() ? 1 : 0);
    o.textures.push_back(Objects::Image());
    if (!has_texture_.back()) continue;
    if (t->width > max_texture_size_ || t->height > max_texture_size_)
      return fail((String("texture ") + to_str(static_cast<long long>(i)) + " is " + to_str(t->width) + "×" +
                   to_str(t->height) + ", larger than the maximum texture size " + to_str(max_texture_size_))
                      .c_str(),
                  "d3d11-texture-size");
    Vector<D3D11_SUBRESOURCE_DATA> init(t->levels.size());
    for (size_t l = 0; l < t->levels.size(); l++) {
      init[l].pSysMem = t->levels[l].rgba.data();
      init[l].SysMemPitch = static_cast<UINT>(t->levels[l].width * 4);
    }
    if (!image(o.textures.back(), t->width, t->height, static_cast<UINT>(t->levels.size()),
               D3D11_BIND_SHADER_RESOURCE, init.data()))
      return false;
  }
  // A 1 × 1 texture for the bindings a program does not read.
  D3D11_SUBRESOURCE_DATA one{};
  one.pSysMem = zeros;
  one.SysMemPitch = 4;
  const UINT target = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  if (!image(o.dummy, 1, 1, 1, D3D11_BIND_SHADER_RESOURCE, &one) ||
      !image(o.mask_target, options_.mask_size, options_.mask_size, 1, target, nullptr) ||
      !image(o.offscreen_mask_target, options_.offscreen_mask_size, options_.offscreen_mask_size, 1, target, nullptr))
    return false;
  if (!o.context1) o.ones.assign(Z(kOnesSide) * Z(kOnesSide) * 4, 0xff);
  return true;
}

bool D3d11Renderer::update_texture(int index, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x,
                                   int y) {
  if (!created_) return false;
  ok_ = true;
  error_.clear();
  error_code_ = "";
  if (index < 0 || Z(index) >= textures_.size() || !textures_[Z(index)] || !has_texture_[Z(index)]) return false;
  const Texture& cur = *textures_[Z(index)];
  if (w < 1 || h < 1 || x < 0 || y < 0 || x > cur.width - w || y > cur.height - h) return false;
  auto t = own_copy(textures_, own_texture_, Z(index));
  Vector<TextureRegion> changed;
  if (!update_texture_in(*t, straight, w, h, stride, x, y, &changed)) return false;
  Objects& o = *objects_;
  for (const TextureRegion& r : changed) {
    const Texture::Level& lv = t->levels[Z(r.level)];
    const D3D11_BOX box{static_cast<UINT>(r.x), static_cast<UINT>(r.y), 0, static_cast<UINT>(r.x + r.width),
                        static_cast<UINT>(r.y + r.height), 1};
    o.context->UpdateSubresource(o.textures[Z(index)].texture, D3D11CalcSubresource(static_cast<UINT>(r.level), 0, 1),
                                 &box, lv.rgba.data() + (Z(r.y) * Z(lv.width) + Z(r.x)) * 4,
                                 static_cast<UINT>(lv.width * 4), 0);
  }
  return true;
}

// ---------------------------------------------------------------- drawing

bool D3d11Renderer::execute(const RenderOp& op) {
  Objects& o = *objects_;
  ID3D11DeviceContext* ctx = o.context;
  const moc::Model& m = *model_;
  const Framing& f = framing_;
  VulkanPushConstants pc{};
  pc.turn[0] = 1;
  pc.height = static_cast<float>(f.height);
  const auto colors = [&]() {
    for (size_t k = 0; k < 3; k++) {
      pc.multiply[k] = op.multiply[k];
      pc.screen[k] = op.screen[k];
      pc.tint[k] = op.tint[k];
    }
    pc.opacity = op.opacity;
    pc.mask_mode = op.mask.buffer < 0 ? 0 : op.mask.inverted ? 2 : 1;
    // No mask: the zero matrix (its coordinate is never sampled), as Mochi2D sets it.
    for (size_t k = 0; k < 8; k++) pc.mask_rows[k] = op.mask.buffer < 0 ? 0.0f : op.mask.matrix[k];
    pc.color_fn = op.color_fn;
    pc.alpha_mode = op.alpha_mode;
    pc.flip = op.target == -1 && options_.flip_y ? 1.0f : 0.0f;
  };
  ID3D11ShaderResourceView* const no_views[3] = {nullptr, nullptr, nullptr};
  // `target` (-1 the host's view, k layer k, -3/-4 the mask buffers) bound, with its viewport and a full scissor.
  const auto bind_target = [&](int32_t target) {
    if (o.bound_target == target) return;
    // No view of a texture stays bound for reading while it becomes the target.
    ctx->PSSetShaderResources(0, 3, no_views);
    Objects::Image* im = target >= 0 ? &o.layers[Z(target)]
                         : target == -3 ? &o.mask_target
                         : target == -4 ? &o.offscreen_mask_target
                                        : nullptr;
    ID3D11RenderTargetView* rtv = im ? im->rtv : o.host;
    ctx->OMSetRenderTargets(1, &rtv, nullptr);
    const int w = target >= -1 ? f.width : im->width, h = target >= -1 ? f.height : im->height;
    const D3D11_VIEWPORT vp{0, 0, static_cast<float>(w), static_cast<float>(h), 0, 1};
    ctx->RSSetViewports(1, &vp);
    const D3D11_RECT sc{0, 0, w, h};
    ctx->RSSetScissorRects(1, &sc);
    o.bound_target = target;
  };
  const auto upload = [&](const VulkanPushConstants& block) {
    // A constant buffer's size is a multiple of 16 bytes: the block padded.
    unsigned char bytes[kConstantBytes] = {};
    std::memcpy(bytes, &block, sizeof block);
    ctx->UpdateSubresource(o.constants, 0, nullptr, bytes, 0, 0);
    ctx->VSSetConstantBuffers(0, 1, &o.constants);
    ctx->PSSetConstantBuffers(0, 1, &o.constants);
  };
  const auto geometry = [&](int prog) {
    ID3D11Buffer* const vbs[2] = {o.positions, o.uvs};
    const UINT strides[2] = {8, 8}, offsets[2] = {0, 0};
    ctx->IASetInputLayout(o.layouts[prog]);
    ctx->IASetVertexBuffers(0, 2, vbs, strides, offsets);
    ctx->IASetIndexBuffer(o.indices, DXGI_FORMAT_R32_UINT, 0);
    ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  };
  const auto program = [&](int prog, int blend, bool cull, bool upright) {
    ctx->VSSetShader(o.vs[prog], nullptr, 0);
    ctx->PSSetShader(o.ps[prog], nullptr, 0);
    const float factor[4] = {0, 0, 0, 0};
    ctx->OMSetBlendState(o.blends[blend], factor, 0xffffffffu);
    ctx->RSSetState(o.rasterizers[upright ? 1 : 0][cull ? 1 : 0]);
  };
  const auto views = [&](ID3D11ShaderResourceView* tex, bool model_texture, ID3D11ShaderResourceView* mask,
                         ID3D11ShaderResourceView* dst) {
    ID3D11ShaderResourceView* const v[3] = {tex, mask, dst};
    ctx->PSSetShaderResources(0, 3, v);
    ID3D11SamplerState* const s[3] = {model_texture ? o.texture_sampler : o.mask_sampler, o.mask_sampler,
                                      o.nearest_sampler};
    ctx->PSSetSamplers(0, 3, s);
  };
  const auto mask_view = [&]() -> ID3D11ShaderResourceView* {
    if (op.mask.buffer < 0) return o.dummy.srv;
    return op.mask.buffer == 0 ? o.mask_target.srv : o.offscreen_mask_target.srv;
  };
  const bool upright = op.target == -1 && options_.flip_y;
  switch (op.kind) {
    case RenderOp::Kind::Clear: {
      bind_target(-1);
      float c[4];
      for (size_t k = 0; k < 4; k++) c[k] = static_cast<float>(op.color[k]);
      ctx->ClearRenderTargetView(o.host, c);
      return true;
    }
    case RenderOp::Kind::BuildMask: {
      Objects::Image& im = op.buffer == 0 ? o.mask_target : o.offscreen_mask_target;
      if (im.width != op.size) return fail("a mask buffer of another size than the renderer's");
      // The scissor's numbers are OpenGL's: the same rows here (masks are laid out as in OpenGL).
      const int32_t x0 = std::max(0, op.scissor[0]), y0 = std::max(0, op.scissor[1]);
      const int32_t x1 = std::min(op.size, op.scissor[0] + op.scissor[2]);
      const int32_t y1 = std::min(op.size, op.scissor[1] + op.scissor[3]);
      if (x1 <= x0 || y1 <= y0) return true;
      const int32_t target = op.buffer == 0 ? -3 : -4;
      bind_target(target);
      const D3D11_RECT rect{x0, y0, x1, y1};
      const float white[4] = {1, 1, 1, 1};
      if (o.context1) {
        o.context1->ClearView(im.rtv, white, &rect, 1);
      } else {
        for (int32_t ty = y0; ty < y1; ty += kOnesSide)
          for (int32_t tx = x0; tx < x1; tx += kOnesSide) {
            const D3D11_BOX box{static_cast<UINT>(tx), static_cast<UINT>(ty), 0,
                                static_cast<UINT>(std::min(x1, tx + kOnesSide)),
                                static_cast<UINT>(std::min(y1, ty + kOnesSide)), 1};
            ctx->UpdateSubresource(im.texture, 0, &box, o.ones.data(), kOnesSide * 4, 0);
          }
      }
      ctx->RSSetScissorRects(1, &rect);
      VulkanPushConstants mp{};
      for (size_t k = 0; k < 8; k++) mp.mask_rows[k] = op.mask.matrix[k];
      upload(mp);
      geometry(kMaskProgram);
      for (uint32_t k = 0; k < op.count; k++) {
        const int32_t mm = plan_.mask_meshes[op.first + k];
        const int32_t tex = m.meshes.texture[Z(mm)];
        if (tex < 0 || Z(tex) >= o.textures.size() || !has_texture_[Z(tex)] || !index_count_[Z(mm)]) continue;
        program(kMaskProgram, 4, (m.meshes.flags[Z(mm)] & 4) == 0, false);
        views(o.textures[Z(tex)].srv, true, o.dummy.srv, o.dummy.srv);
        ctx->DrawIndexed(index_count_[Z(mm)], index_start_[Z(mm)], 0);
      }
      // The next target sets a full scissor again.
      o.bound_target = -2;
      return true;
    }
    case RenderOp::Kind::OpenLayer: {
      bind_target(op.layer);
      const float clear[4] = {0, 0, 0, 0};
      ctx->ClearRenderTargetView(o.layers[Z(op.layer)].rtv, clear);
      return true;
    }
    case RenderOp::Kind::CopyDestination: {
      const D3D11_BOX box{0, 0, 0, static_cast<UINT>(f.width), static_cast<UINT>(f.height), 1};
      // The copy is read as uDst: no view of it may be bound meanwhile.
      ctx->PSSetShaderResources(0, 3, no_views);
      ctx->CopySubresourceRegion(o.dst_copy.texture, 0, 0, 0, 0, o.layers[Z(op.target)].texture, 0, &box);
      return true;
    }
    case RenderOp::Kind::DrawMesh: {
      const int32_t d = op.index;
      const int32_t tex = m.meshes.texture[Z(d)];
      if (tex < 0 || Z(tex) >= o.textures.size() || !has_texture_[Z(tex)] || !index_count_[Z(d)]) return true;
      bind_target(op.target);
      colors();
      for (size_t k = 0; k < 4; k++) pc.view[k] = static_cast<float>(plan_.view[k]);
      upload(pc);
      const int prog = static_cast<int>(op.blend == BlendKind::Advanced ? ShaderProgram::MeshAdvanced
                                                                         : ShaderProgram::Mesh);
      geometry(prog);
      program(prog, static_cast<int>(op.blend), op.cull, upright);
      views(o.textures[Z(tex)].srv, true, mask_view(), op.blend == BlendKind::Advanced ? o.dst_copy.srv : o.dummy.srv);
      ctx->DrawIndexed(index_count_[Z(d)], index_start_[Z(d)], 0);
      return true;
    }
    case RenderOp::Kind::Composite: {
      bind_target(op.target);
      colors();
      upload(pc);
      const int prog = static_cast<int>(op.blend == BlendKind::Advanced ? ShaderProgram::LayerAdvanced
                                                                         : ShaderProgram::Layer);
      ctx->IASetInputLayout(nullptr);
      // Rule L: a quad over the viewport, a triangle strip of 4 vertices, sampled linearly.
      ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
      program(prog, static_cast<int>(op.blend), false, upright);
      views(o.layers[Z(op.layer)].srv, false, mask_view(),
            op.blend == BlendKind::Advanced ? o.dst_copy.srv : o.dummy.srv);
      ctx->Draw(4, 0);
      return true;
    }
  }
  return true;
}

bool D3d11Renderer::draw(const eval::Instance& instance, const FrameOptions& frame, const D3d11Target& target) {
  if (!created_) return false;
  ok_ = true;
  Objects& o = *objects_;
  auto* host = static_cast<ID3D11RenderTargetView*>(target.view);
  if (!host) return fail("no target");
  framing_ = frame.framing;
  const int w = framing_.width, h = framing_.height;
  if (w < 1 || h < 1) return fail("an empty frame");
  {
    D3D11_RENDER_TARGET_VIEW_DESC vd{};
    host->GetDesc(&vd);
    if (vd.ViewDimension != D3D11_RTV_DIMENSION_TEXTURE2D) return fail("the target is not a 2D texture's view");
    ID3D11Resource* res = nullptr;
    host->GetResource(&res);
    ID3D11Texture2D* tex = nullptr;
    D3D11_TEXTURE2D_DESC td{};
    if (res && SUCCEEDED(res->QueryInterface(__uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&tex)))) {
      tex->GetDesc(&td);
      tex->Release();
    }
    release(res);
    if (static_cast<int>(td.Width) < w || static_cast<int>(td.Height) < h)
      return fail("the target is smaller than the frame");
    UINT support = 0;
    if (FAILED(o.device->CheckFormatSupport(vd.Format, &support)) || !(support & D3D11_FORMAT_SUPPORT_RENDER_TARGET) ||
        !(support & D3D11_FORMAT_SUPPORT_BLENDABLE))
      return fail("the target's format cannot be rendered to with blending", "d3d11-format");
  }
  plan_frame(rm_, *model_, instance, frame, options_.mask_size, options_.offscreen_mask_size, has_texture_, plan_);
  ID3D11Device* dev = o.device;
  ID3D11DeviceContext* ctx = o.context;
  // Layers and the destination copy have the frame's size (rule L samples a whole layer, 0 to 1).
  if (plan_.layers > 0 && (w != o.layer_width || h != o.layer_height || o.layers.size() < Z(plan_.layers))) {
    if (w != o.layer_width || h != o.layer_height) {
      for (auto& l : o.layers) l.reset();
      o.layers.clear();
      o.dst_copy.reset();
      o.layer_width = w;
      o.layer_height = h;
    }
    const auto make = [&](Objects::Image& im, UINT bind) {
      D3D11_TEXTURE2D_DESC td{};
      td.Width = static_cast<UINT>(o.layer_width);
      td.Height = static_cast<UINT>(o.layer_height);
      td.MipLevels = td.ArraySize = 1;
      td.Format = kInternalFormat;
      td.SampleDesc.Count = 1;
      td.Usage = D3D11_USAGE_DEFAULT;
      td.BindFlags = bind;
      if (!check(dev->CreateTexture2D(&td, nullptr, &im.texture), "CreateTexture2D") ||
          !check(dev->CreateShaderResourceView(im.texture, nullptr, &im.srv), "CreateShaderResourceView"))
        return false;
      if ((bind & D3D11_BIND_RENDER_TARGET) &&
          !check(dev->CreateRenderTargetView(im.texture, nullptr, &im.rtv), "CreateRenderTargetView"))
        return false;
      im.width = o.layer_width;
      im.height = o.layer_height;
      return true;
    };
    while (o.layers.size() < Z(plan_.layers)) {
      o.layers.push_back(Objects::Image());
      if (!make(o.layers.back(), D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE)) return false;
    }
    if (!o.dst_copy.texture && !make(o.dst_copy, D3D11_BIND_SHADER_RESOURCE)) return false;
  }
  // The changed drawables' positions, through the context (ordered after the frames before).
  const bool fresh = instance.serial.value != staged_for_;
  staged_for_ = instance.serial.value;
  for (size_t i = 0; i < vertex_start_.size(); i++) {
    const uint32_t version = i < instance.drawable_vertex_version.size() ? instance.drawable_vertex_version[i] : 0;
    if (!fresh && staged_[i] == version) continue;
    staged_[i] = version;
    const auto& v = instance.drawable_vertices[i];
    const size_t floats = std::min(v.size(), model_->meshes.uvs[i].size());
    if (!floats) continue;
    const UINT at = vertex_start_[i] * 8;
    const D3D11_BOX box{at, 0, 0, at + static_cast<UINT>(floats * 4), 1, 1};
    ctx->UpdateSubresource(o.positions, 0, &box, v.data(), 0, 0);
  }
  o.host = host;
  o.bound_target = -2;
  ctx->OMSetDepthStencilState(o.no_depth, 0);
  ctx->GSSetShader(nullptr, nullptr, 0);
  ctx->HSSetShader(nullptr, nullptr, 0);
  ctx->DSSetShader(nullptr, nullptr, 0);
  for (const RenderOp& op : plan_.ops) {
    if (!execute(op)) break;
  }
  // Nothing of the renderer's stays bound.
  ID3D11ShaderResourceView* const no_views[3] = {nullptr, nullptr, nullptr};
  ctx->PSSetShaderResources(0, 3, no_views);
  ctx->OMSetRenderTargets(0, nullptr, nullptr);
  o.host = nullptr;
  o.bound_target = -2;
  return ok_;
}

}  // namespace mochi2d::render::d3d11

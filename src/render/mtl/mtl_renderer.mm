// The Metal backend (mtl_renderer.hpp): Objective-C++ with ARC.
#import <Metal/Metal.h>

#include "render/mtl/mtl_renderer.hpp"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <mutex>
#include <new>

#include "render/gpu/cross_sources.hpp"
#include "render/shaders.hpp"

#if !__has_feature(objc_arc)
#error "mtl_renderer.mm is built with ARC (-fobjc-arc)"
#endif

namespace mochi2d::render::mtl {

namespace {

using std::size_t;
size_t Z(int64_t i) { return static_cast<size_t>(i); }

constexpr int kPrograms = static_cast<int>(ShaderProgram::Count);
constexpr int kMaskProgram = static_cast<int>(ShaderProgram::Mask);
constexpr MTLPixelFormat kInternalFormat = MTLPixelFormatRGBA8Unorm;
/** Vertex buffers after the push-constant block's buffer(0). */
constexpr NSUInteger kPositionsBuffer = 1, kUvsBuffer = 2;

/** The message of an NSError, or a fallback. */
String message_of(NSError* e, const char* fallback) {
  if (e && e.localizedDescription) return String(fallback) + ": " + e.localizedDescription.UTF8String;
  return String(fallback);
}

std::atomic<int> g_library_compiles{0};

/**
 * The programs' functions on a device, compiled once and shared by every
 * renderer on it (kept while the device lives: the table's keys are weak).
 * Nil with a message when a program does not compile.
 */
NSArray<id<MTLFunction>>* device_functions(id<MTLDevice> dev, String& error) {
  static std::mutex lock;
  static NSMapTable<id<MTLDevice>, NSArray<id<MTLFunction>>*>* cache;
  std::lock_guard<std::mutex> hold(lock);
  if (!cache) cache = [NSMapTable weakToStrongObjectsMapTable];
  if (NSArray<id<MTLFunction>>* known = [cache objectForKey:dev]) return known;
  // Each stage its own library (each declares the push-constant block).
  MTLCompileOptions* co = [MTLCompileOptions new];
  co.languageVersion = MTLLanguageVersion2_0;
  NSMutableArray<id<MTLFunction>>* functions = [NSMutableArray arrayWithCapacity:2 * kPrograms];
  for (int prog = 0; prog < kPrograms; prog++)
    for (int st = 0; st < 2; st++) {
      const auto program = static_cast<ShaderProgram>(prog);
      const auto stage = static_cast<ShaderStage>(st);
      NSError* err = nil;
      NSString* src = [NSString stringWithUTF8String:cross_source(program, stage, CrossLanguage::Msl)];
      id<MTLLibrary> lib = [dev newLibraryWithSource:src options:co error:&err];
      g_library_compiles++;
      if (!lib) {
        error = message_of(err, "an MSL program does not compile");
        return nil;
      }
      id<MTLFunction> f = [lib newFunctionWithName:[NSString stringWithUTF8String:msl_function(program, stage)]];
      if (!f) {
        error = "an MSL program lacks its function";
        return nil;
      }
      [functions addObject:f];
    }
  [cache setObject:functions forKey:dev];
  return functions;
}

}  // namespace

int MtlRenderer::library_compiles() { return g_library_compiles.load(); }

struct MtlRenderer::Objects {
  struct Pipelines {
    MTLPixelFormat format = MTLPixelFormatInvalid;
    /** [program][blend kind]; the mask program's slot is blend 0. */
    id<MTLRenderPipelineState> state[kPrograms][4];
  };
  /** A texture update waiting for the next draw: the rectangles in one buffer. */
  struct Pending {
    int index = 0;
    id<MTLBuffer> buffer;
    Vector<TextureRegion> regions;
    Vector<size_t> offsets;
  };

  id<MTLDevice> device;
  id<MTLFunction> functions[kPrograms][2];
  MTLVertexDescriptor* vertex_descriptor;
  id<MTLSamplerState> texture_sampler, mask_sampler, nearest_sampler;
  Vector<Pipelines> pipelines;
  Vector<id<MTLTexture>> textures;
  id<MTLTexture> dummy, mask_target, offscreen_mask_target, dst_copy;
  Vector<id<MTLTexture>> layers;
  int layer_width = 0, layer_height = 0;
  id<MTLBuffer> uvs, indices, positions;
  /** 0xff bytes, copied into a mask buffer's scissor to clear it to (1, 1, 1, 1). */
  id<MTLBuffer> ones;
  Vector<Pending> pending;

  // The frame being encoded.
  id<MTLCommandBuffer> cmd;
  id<MTLTexture> host;
  id<MTLRenderCommandEncoder> encoder;
  int32_t encoder_target = -2;
  /** The frame's pipelines: the host texture's format and the internal one (both made before the ops run). */
  Pipelines* host_pipelines = nullptr;
  Pipelines* internal_pipelines = nullptr;

  void end_encoder() {
    if (encoder) [encoder endEncoding];
    encoder = nil;
    encoder_target = -2;
  }
};

static MtlRenderer::Objects::Pipelines* pipelines_for(MtlRenderer::Objects& o, MTLPixelFormat format, String& error);

// ------------------------------------------------------------------ setup

MtlRenderer::MtlRenderer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const Texture>> textures,
                         const MtlContext& context, const MtlOptions& options)
    : model_(std::move(model)), textures_(std::move(textures)), options_(options), rm_(*model_) {
  void* p = allocate_bytes(sizeof(Objects), alignof(Objects));
  if (!p) {
    fail("out of memory");
    return;
  }
  objects_ = new (p) Objects();
  objects_->device = (__bridge id<MTLDevice>)context.device;
  if (!objects_->device) {
    fail("no device", "mtl-function");
    return;
  }
  if (create()) created_ = ok_;
}

MtlRenderer::~MtlRenderer() {
  if (!objects_) return;
  objects_->end_encoder();
  objects_->~Objects();
  deallocate_bytes(objects_);
}

bool MtlRenderer::fail(const char* what, const char* code) {
  ok_ = false;
  error_code_ = code;
  error_ = what;
  return false;
}

bool MtlRenderer::create() {
  Objects& o = *objects_;
  id<MTLDevice> dev = o.device;
  // Apple GPUs from the A9 and every Mac GPU of Metal 2 take 16384; older ones 8192.
  bool large = false;
  if (@available(macOS 10.15, iOS 13.0, tvOS 13.0, *))
    large = [dev supportsFamily:MTLGPUFamilyApple3] || [dev supportsFamily:MTLGPUFamilyMac2];
  max_texture_size_ = large ? 16384 : 8192;
  if (options_.max_texture_size > 0) max_texture_size_ = std::min(max_texture_size_, options_.max_texture_size);

  // The programs: compiled once per device, then shared.
  {
    String why;
    NSArray<id<MTLFunction>>* functions = device_functions(dev, why);
    if (!functions) return fail(why.c_str(), "mtl-shader");
    for (int prog = 0; prog < kPrograms; prog++)
      for (int st = 0; st < 2; st++) o.functions[prog][st] = functions[static_cast<NSUInteger>(2 * prog + st)];
  }
  MTLVertexDescriptor* vd = [MTLVertexDescriptor vertexDescriptor];
  vd.attributes[0].format = MTLVertexFormatFloat2;
  vd.attributes[0].offset = 0;
  vd.attributes[0].bufferIndex = kPositionsBuffer;
  vd.attributes[1].format = MTLVertexFormatFloat2;
  vd.attributes[1].offset = 0;
  vd.attributes[1].bufferIndex = kUvsBuffer;
  vd.layouts[kPositionsBuffer].stride = 8;
  vd.layouts[kUvsBuffer].stride = 8;
  o.vertex_descriptor = vd;

  // Samplers: textures as Mochi2D's (trilinear, repeat), masks and layers
  // (bilinear, clamped: rule L), the destination copy (read with texelFetch).
  MTLSamplerDescriptor* sd = [MTLSamplerDescriptor new];
  sd.minFilter = sd.magFilter = MTLSamplerMinMagFilterLinear;
  sd.mipFilter = MTLSamplerMipFilterLinear;
  sd.sAddressMode = sd.tAddressMode = sd.rAddressMode = MTLSamplerAddressModeRepeat;
  o.texture_sampler = [dev newSamplerStateWithDescriptor:sd];
  sd.mipFilter = MTLSamplerMipFilterNotMipmapped;
  sd.sAddressMode = sd.tAddressMode = sd.rAddressMode = MTLSamplerAddressModeClampToEdge;
  o.mask_sampler = [dev newSamplerStateWithDescriptor:sd];
  sd.minFilter = sd.magFilter = MTLSamplerMinMagFilterNearest;
  o.nearest_sampler = [dev newSamplerStateWithDescriptor:sd];
  if (!o.texture_sampler || !o.mask_sampler || !o.nearest_sampler) return fail("a sampler cannot be made");

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
  const auto buffer = [&](const void* data, size_t bytes) -> id<MTLBuffer> {
    if (!bytes) return [dev newBufferWithLength:4 options:MTLResourceStorageModeShared];
    return [dev newBufferWithBytes:data length:bytes options:MTLResourceStorageModeShared];
  };
  o.uvs = buffer(all_uvs.data(), all_uvs.size() * 4);
  o.indices = buffer(all_indices.data(), all_indices.size() * 4);
  // The positions, written by range from the frames' staging buffers (draw).
  o.positions = [dev newBufferWithLength:std::max<size_t>(Z(vertices) * 8, 4) options:MTLResourceStorageModePrivate];
  if (!o.uvs || !o.indices || !o.positions) return fail("a buffer cannot be made");

  // The textures' prepared levels as they are.
  for (size_t i = 0; i < textures_.size(); i++) {
    const auto& t = textures_[i];
    has_texture_.push_back(t && !t->levels.empty() ? 1 : 0);
    o.textures.push_back(nil);
    if (!has_texture_.back()) continue;
    if (t->width > max_texture_size_ || t->height > max_texture_size_)
      return fail((String("texture ") + to_str(static_cast<long long>(i)) + " is " + to_str(t->width) + "×" +
                   to_str(t->height) + ", larger than the maximum texture size " + to_str(max_texture_size_))
                      .c_str(),
                  "mtl-texture-size");
    MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:kInternalFormat
                                                                                  width:Z(t->width)
                                                                                 height:Z(t->height)
                                                                              mipmapped:NO];
    td.mipmapLevelCount = t->levels.size();
    td.usage = MTLTextureUsageShaderRead;
    id<MTLTexture> tex = [dev newTextureWithDescriptor:td];
    if (!tex) return fail("a texture cannot be made");
    for (size_t l = 0; l < t->levels.size(); l++) {
      const auto& lv = t->levels[l];
      [tex replaceRegion:MTLRegionMake2D(0, 0, Z(lv.width), Z(lv.height))
             mipmapLevel:l
               withBytes:lv.rgba.data()
             bytesPerRow:Z(lv.width) * 4];
    }
    o.textures.back() = tex;
  }
  // A 1 × 1 texture for the bindings a program does not read.
  MTLTextureDescriptor* dd = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:kInternalFormat
                                                                                width:1
                                                                               height:1
                                                                            mipmapped:NO];
  dd.usage = MTLTextureUsageShaderRead;
  o.dummy = [dev newTextureWithDescriptor:dd];
  if (!o.dummy) return fail("a texture cannot be made");
  const uint32_t zero = 0;
  [o.dummy replaceRegion:MTLRegionMake2D(0, 0, 1, 1) mipmapLevel:0 withBytes:&zero bytesPerRow:4];
  const auto target = [&](int w, int h) -> id<MTLTexture> {
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:kInternalFormat
                                                                                width:Z(w)
                                                                               height:Z(h)
                                                                            mipmapped:NO];
    d.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    d.storageMode = MTLStorageModePrivate;
    return [dev newTextureWithDescriptor:d];
  };
  o.mask_target = target(options_.mask_size, options_.mask_size);
  o.offscreen_mask_target = target(options_.offscreen_mask_size, options_.offscreen_mask_size);
  if (!o.mask_target || !o.offscreen_mask_target) return fail("a mask buffer cannot be made");
  const int side = std::max(options_.mask_size, options_.offscreen_mask_size);
  const size_t ones = Z(side) * Z(side) * 4;
  o.ones = [dev newBufferWithLength:ones options:MTLResourceStorageModeShared];
  if (!o.ones) return fail("a buffer cannot be made");
  std::memset(o.ones.contents, 0xff, ones);
  // The internal format's pipelines now: a program the device refuses shows at creation.
  String why;
  if (!pipelines_for(o, kInternalFormat, why)) return fail(why.c_str(), "mtl-shader");
  return true;
}

/** The pipelines of a target format (made on first use; a pointer stays valid until another format's are made). */
static MtlRenderer::Objects::Pipelines* pipelines_for(MtlRenderer::Objects& o, MTLPixelFormat format, String& error) {
  for (auto& p : o.pipelines)
    if (p.format == format) return &p;
  MtlRenderer::Objects::Pipelines p;
  p.format = format;
  for (int prog = 0; prog < kPrograms; prog++) {
    const bool mesh_input = prog != static_cast<int>(ShaderProgram::Layer) &&
                            prog != static_cast<int>(ShaderProgram::LayerAdvanced);
    const bool advanced = prog == static_cast<int>(ShaderProgram::MeshAdvanced) ||
                          prog == static_cast<int>(ShaderProgram::LayerAdvanced);
    for (int blend = 0; blend < 4; blend++) {
      // Advanced programs draw without blending (kind 3); the others with the three fixed modes; the mask one with its own.
      if (advanced != (blend == 3)) continue;
      if (prog == kMaskProgram && (blend != 0 || format != kInternalFormat)) continue;
      MTLRenderPipelineDescriptor* d = [MTLRenderPipelineDescriptor new];
      d.vertexFunction = o.functions[prog][0];
      d.fragmentFunction = o.functions[prog][1];
      if (mesh_input) d.vertexDescriptor = o.vertex_descriptor;
      MTLRenderPipelineColorAttachmentDescriptor* c = d.colorAttachments[0];
      c.pixelFormat = format;
      c.rgbBlendOperation = c.alphaBlendOperation = MTLBlendOperationAdd;
      if (prog == kMaskProgram) {
        c.blendingEnabled = YES;
        c.sourceRGBBlendFactor = c.sourceAlphaBlendFactor = MTLBlendFactorZero;
        c.destinationRGBBlendFactor = c.destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
        c.writeMask = MTLColorWriteMaskRed;
      } else if (blend == 0) {
        c.blendingEnabled = YES;
        c.sourceRGBBlendFactor = c.sourceAlphaBlendFactor = MTLBlendFactorOne;
        c.destinationRGBBlendFactor = c.destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
      } else if (blend == 1) {
        c.blendingEnabled = YES;
        c.sourceRGBBlendFactor = MTLBlendFactorOne;
        c.destinationRGBBlendFactor = MTLBlendFactorOne;
        c.sourceAlphaBlendFactor = MTLBlendFactorZero;
        c.destinationAlphaBlendFactor = MTLBlendFactorOne;
      } else if (blend == 2) {
        c.blendingEnabled = YES;
        c.sourceRGBBlendFactor = MTLBlendFactorDestinationColor;
        c.destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
        c.sourceAlphaBlendFactor = MTLBlendFactorZero;
        c.destinationAlphaBlendFactor = MTLBlendFactorOne;
      } else {
        c.blendingEnabled = NO;
      }
      NSError* err = nil;
      p.state[prog][blend] = [o.device newRenderPipelineStateWithDescriptor:d error:&err];
      if (!p.state[prog][blend]) {
        error = message_of(err, "the target's pixel format cannot be rendered to with blending");
        return nullptr;
      }
    }
  }
  o.pipelines.push_back(p);
  return &o.pipelines.back();
}

bool MtlRenderer::update_texture(int index, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x,
                                 int y) {
  if (!created_) return false;
  ok_ = true;
  error_.clear();
  error_code_ = "";
  if (index < 0 || Z(index) >= textures_.size() || !textures_[Z(index)] || !has_texture_[Z(index)]) return false;
  const Texture& cur = *textures_[Z(index)];
  if (w < 1 || h < 1 || x < 0 || y < 0 || x > cur.width - w || y > cur.height - h) return false;
  auto t = own_copy(textures_, own_texture_, Z(index));
  Objects::Pending pend;
  pend.index = index;
  if (!update_texture_in(*t, straight, w, h, stride, x, y, &pend.regions)) return false;
  size_t bytes = 4;
  for (const TextureRegion& r : pend.regions) {
    pend.offsets.push_back(bytes - 4);
    bytes += 4 * Z(r.width) * Z(r.height);
  }
  pend.buffer = [objects_->device newBufferWithLength:bytes options:MTLResourceStorageModeShared];
  if (!pend.buffer) return fail("a buffer cannot be made");
  auto* mapped = static_cast<uint8_t*>(pend.buffer.contents);
  for (size_t k = 0; k < pend.regions.size(); k++) {
    const TextureRegion& r = pend.regions[k];
    const Texture::Level& lv = t->levels[Z(r.level)];
    const size_t row = Z(r.width) * 4;
    for (int j = 0; j < r.height; j++)
      std::memcpy(mapped + pend.offsets[k] + row * Z(j), lv.rgba.data() + (Z(r.y + j) * Z(lv.width) + Z(r.x)) * 4, row);
  }
  objects_->pending.push_back(pend);
  return true;
}

// -------------------------------------------------------------- encoding

bool MtlRenderer::execute(const RenderOp& op) {
  Objects& o = *objects_;
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
  // A render pass into `target` (-1 the host's texture, k layer k, -3/-4 the mask buffers), loading or clearing it.
  const auto begin = [&](int32_t target, bool clear, const double* color) -> bool {
    if (o.encoder_target == target && !clear) return true;
    o.end_encoder();
    id<MTLTexture> tex = target == -1 ? o.host
                         : target >= 0 ? o.layers[Z(target)]
                         : target == -3 ? o.mask_target
                                        : o.offscreen_mask_target;
    MTLRenderPassDescriptor* rp = [MTLRenderPassDescriptor renderPassDescriptor];
    rp.colorAttachments[0].texture = tex;
    rp.colorAttachments[0].storeAction = MTLStoreActionStore;
    rp.colorAttachments[0].loadAction = clear ? MTLLoadActionClear : MTLLoadActionLoad;
    if (clear) rp.colorAttachments[0].clearColor = MTLClearColorMake(color[0], color[1], color[2], color[3]);
    o.encoder = [o.cmd renderCommandEncoderWithDescriptor:rp];
    if (!o.encoder) return fail("a render pass cannot be begun");
    const int w = target >= -1 ? f.width : static_cast<int>(tex.width);
    const int h = target >= -1 ? f.height : static_cast<int>(tex.height);
    [o.encoder setViewport:(MTLViewport){0, 0, static_cast<double>(w), static_cast<double>(h), 0, 1}];
    [o.encoder setScissorRect:(MTLScissorRect){0, 0, Z(w), Z(h)}];
    // OpenGL's counter-clockwise front faces, as they look in the image: the
    // host's texture is upright with flip_y; masks and layers are upside down.
    const bool upright = target == -1 && options_.flip_y;
    [o.encoder setFrontFacingWinding:upright ? MTLWindingCounterClockwise : MTLWindingClockwise];
    [o.encoder setVertexBuffer:o.positions offset:0 atIndex:kPositionsBuffer];
    [o.encoder setVertexBuffer:o.uvs offset:0 atIndex:kUvsBuffer];
    o.encoder_target = target;
    return true;
  };
  const auto bind = [&](id<MTLTexture> tex, bool model_texture, id<MTLTexture> mask, id<MTLTexture> dst) {
    [o.encoder setFragmentTexture:tex atIndex:0];
    [o.encoder setFragmentTexture:mask atIndex:1];
    [o.encoder setFragmentTexture:dst atIndex:2];
    [o.encoder setFragmentSamplerState:model_texture ? o.texture_sampler : o.mask_sampler atIndex:0];
    [o.encoder setFragmentSamplerState:o.mask_sampler atIndex:1];
    [o.encoder setFragmentSamplerState:o.nearest_sampler atIndex:2];
    [o.encoder setVertexBytes:&pc length:sizeof pc atIndex:0];
    [o.encoder setFragmentBytes:&pc length:sizeof pc atIndex:0];
  };
  const auto mask_of = [&]() -> id<MTLTexture> {
    if (op.mask.buffer < 0) return o.dummy;
    return op.mask.buffer == 0 ? o.mask_target : o.offscreen_mask_target;
  };
  const auto pipelines = [&]() -> Objects::Pipelines* {
    return op.target == -1 ? o.host_pipelines : o.internal_pipelines;
  };
  switch (op.kind) {
    case RenderOp::Kind::Clear:
      return begin(-1, true, op.color.data());
    case RenderOp::Kind::BuildMask: {
      id<MTLTexture> tex = op.buffer == 0 ? o.mask_target : o.offscreen_mask_target;
      if (static_cast<int>(tex.width) != op.size) return fail("a mask buffer of another size than the renderer's");
      // The scissor's numbers are OpenGL's: the same rows here (masks are laid out as in OpenGL).
      const int32_t x0 = std::max(0, op.scissor[0]), y0 = std::max(0, op.scissor[1]);
      const int32_t x1 = std::min(op.size, op.scissor[0] + op.scissor[2]);
      const int32_t y1 = std::min(op.size, op.scissor[1] + op.scissor[3]);
      if (x1 <= x0 || y1 <= y0) return true;
      o.end_encoder();
      // Cleared to (1, 1, 1, 1) inside the scissor: a copy of 0xff bytes.
      id<MTLBlitCommandEncoder> blit = [o.cmd blitCommandEncoder];
      [blit copyFromBuffer:o.ones
                 sourceOffset:0
            sourceBytesPerRow:Z(x1 - x0) * 4
          sourceBytesPerImage:Z(x1 - x0) * 4 * Z(y1 - y0)
                   sourceSize:MTLSizeMake(Z(x1 - x0), Z(y1 - y0), 1)
                    toTexture:tex
             destinationSlice:0
             destinationLevel:0
            destinationOrigin:MTLOriginMake(Z(x0), Z(y0), 0)];
      [blit endEncoding];
      if (!begin(op.buffer == 0 ? -3 : -4, false, nullptr)) return false;
      [o.encoder setScissorRect:(MTLScissorRect){Z(x0), Z(y0), Z(x1 - x0), Z(y1 - y0)}];
      [o.encoder setRenderPipelineState:o.internal_pipelines->state[kMaskProgram][0]];
      VulkanPushConstants mp{};
      for (size_t k = 0; k < 8; k++) mp.mask_rows[k] = op.mask.matrix[k];
      [o.encoder setVertexBytes:&mp length:sizeof mp atIndex:0];
      [o.encoder setFragmentSamplerState:o.texture_sampler atIndex:0];
      for (uint32_t k = 0; k < op.count; k++) {
        const int32_t mm = plan_.mask_meshes[op.first + k];
        const int32_t tex_index = m.meshes.texture[Z(mm)];
        if (tex_index < 0 || Z(tex_index) >= o.textures.size() || !has_texture_[Z(tex_index)] || !index_count_[Z(mm)])
          continue;
        [o.encoder setFragmentTexture:o.textures[Z(tex_index)] atIndex:0];
        [o.encoder setCullMode:(m.meshes.flags[Z(mm)] & 4) == 0 ? MTLCullModeBack : MTLCullModeNone];
        [o.encoder drawIndexedPrimitives:MTLPrimitiveTypeTriangle
                              indexCount:index_count_[Z(mm)]
                               indexType:MTLIndexTypeUInt32
                             indexBuffer:o.indices
                       indexBufferOffset:Z(index_start_[Z(mm)]) * 4];
      }
      o.end_encoder();
      return true;
    }
    case RenderOp::Kind::OpenLayer: {
      const double transparent[4] = {0, 0, 0, 0};
      return begin(op.layer, true, transparent);
    }
    case RenderOp::Kind::CopyDestination: {
      o.end_encoder();
      id<MTLBlitCommandEncoder> blit = [o.cmd blitCommandEncoder];
      [blit copyFromTexture:o.layers[Z(op.target)]
                sourceSlice:0
                sourceLevel:0
               sourceOrigin:MTLOriginMake(0, 0, 0)
                 sourceSize:MTLSizeMake(Z(f.width), Z(f.height), 1)
                  toTexture:o.dst_copy
           destinationSlice:0
           destinationLevel:0
          destinationOrigin:MTLOriginMake(0, 0, 0)];
      [blit endEncoding];
      return true;
    }
    case RenderOp::Kind::DrawMesh: {
      const int32_t d = op.index;
      const int32_t tex = m.meshes.texture[Z(d)];
      if (tex < 0 || Z(tex) >= o.textures.size() || !has_texture_[Z(tex)] || !index_count_[Z(d)]) return true;
      Objects::Pipelines* p = pipelines();
      if (!p || !begin(op.target, false, nullptr)) return false;
      colors();
      for (size_t k = 0; k < 4; k++) pc.view[k] = static_cast<float>(plan_.view[k]);
      const int prog = static_cast<int>(op.blend == BlendKind::Advanced ? ShaderProgram::MeshAdvanced
                                                                         : ShaderProgram::Mesh);
      [o.encoder setRenderPipelineState:p->state[prog][static_cast<int>(op.blend)]];
      [o.encoder setCullMode:op.cull ? MTLCullModeBack : MTLCullModeNone];
      bind(o.textures[Z(tex)], true, mask_of(), op.blend == BlendKind::Advanced ? o.dst_copy : o.dummy);
      [o.encoder drawIndexedPrimitives:MTLPrimitiveTypeTriangle
                            indexCount:index_count_[Z(d)]
                             indexType:MTLIndexTypeUInt32
                           indexBuffer:o.indices
                     indexBufferOffset:Z(index_start_[Z(d)]) * 4];
      return true;
    }
    case RenderOp::Kind::Composite: {
      Objects::Pipelines* p = pipelines();
      if (!p || !begin(op.target, false, nullptr)) return false;
      colors();
      const int prog = static_cast<int>(op.blend == BlendKind::Advanced ? ShaderProgram::LayerAdvanced
                                                                         : ShaderProgram::Layer);
      [o.encoder setRenderPipelineState:p->state[prog][static_cast<int>(op.blend)]];
      [o.encoder setCullMode:MTLCullModeNone];
      bind(o.layers[Z(op.layer)], false, mask_of(), op.blend == BlendKind::Advanced ? o.dst_copy : o.dummy);
      // Rule L: a quad over the viewport, a triangle strip of 4 vertices.
      [o.encoder drawPrimitives:MTLPrimitiveTypeTriangleStrip vertexStart:0 vertexCount:4];
      return true;
    }
  }
  return true;
}

bool MtlRenderer::draw(const eval::Instance& instance, const FrameOptions& frame, void* command_buffer,
                       const MtlTarget& target) {
  if (!created_) return false;
  ok_ = true;
  Objects& o = *objects_;
  id<MTLCommandBuffer> cmd = (__bridge id<MTLCommandBuffer>)command_buffer;
  id<MTLTexture> host = (__bridge id<MTLTexture>)target.texture;
  if (!cmd || !host) return fail("no command buffer or target");
  framing_ = frame.framing;
  const int w = framing_.width, h = framing_.height;
  if (w < 1 || h < 1) return fail("an empty frame");
  if (static_cast<int>(host.width) < w || static_cast<int>(host.height) < h)
    return fail("the target is smaller than the frame");
  String why;
  if (!pipelines_for(o, host.pixelFormat, why)) return fail(why.c_str(), "mtl-format");
  // Looked up again: making the host's format's pipelines may have moved the internal ones.
  o.host_pipelines = pipelines_for(o, host.pixelFormat, why);
  o.internal_pipelines = pipelines_for(o, kInternalFormat, why);
  plan_frame(rm_, *model_, instance, frame, options_.mask_size, options_.offscreen_mask_size, has_texture_, plan_);
  id<MTLDevice> dev = o.device;
  // Layers and the destination copy have the frame's size (rule L samples a whole layer, 0 to 1).
  if (plan_.layers > 0 && (w != o.layer_width || h != o.layer_height || o.layers.size() < Z(plan_.layers))) {
    if (w != o.layer_width || h != o.layer_height) {
      o.layers.clear();
      o.dst_copy = nil;
      o.layer_width = w;
      o.layer_height = h;
    }
    MTLTextureDescriptor* d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:kInternalFormat
                                                                                width:Z(o.layer_width)
                                                                               height:Z(o.layer_height)
                                                                            mipmapped:NO];
    d.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    d.storageMode = MTLStorageModePrivate;
    while (o.layers.size() < Z(plan_.layers)) {
      id<MTLTexture> layer = [dev newTextureWithDescriptor:d];
      if (!layer) return fail("a layer cannot be made");
      o.layers.push_back(layer);
    }
    if (!o.dst_copy) {
      d.usage = MTLTextureUsageShaderRead;
      o.dst_copy = [dev newTextureWithDescriptor:d];
      if (!o.dst_copy) return fail("a layer cannot be made");
    }
  }
  o.cmd = cmd;
  o.host = host;
  o.encoder = nil;
  o.encoder_target = -2;
  // The changed drawables' positions, by range: packed into one
  // staging buffer, copied into the positions by a blit ahead of the passes.
  // Metal's hazard tracking orders the copy after the frames encoded before,
  // which read the positions, as vkCmdUpdateBuffer does in Vulkan.
  const bool fresh = instance.serial.value != staged_for_;
  staged_for_ = instance.serial.value;
  struct Range {
    size_t from, to, bytes;
  };
  Vector<Range> ranges;
  size_t staged_bytes = 0;
  for (size_t i = 0; i < vertex_start_.size(); i++) {
    const uint32_t version = i < instance.drawable_vertex_version.size() ? instance.drawable_vertex_version[i] : 0;
    if (!fresh && staged_[i] == version) continue;
    staged_[i] = version;
    const size_t floats = std::min(instance.drawable_vertices[i].size(), model_->meshes.uvs[i].size());
    if (!floats) continue;
    ranges.push_back({i, Z(vertex_start_[i]) * 8, floats * 4});
    staged_bytes += floats * 4;
  }
  id<MTLBuffer> staging = nil;
  if (staged_bytes) {
    staging = [dev newBufferWithLength:staged_bytes options:MTLResourceStorageModeShared];
    if (!staging) return fail("a buffer cannot be made");
    auto* at = static_cast<uint8_t*>(staging.contents);
    for (const Range& r : ranges) {
      std::memcpy(at, instance.drawable_vertices[r.from].data(), r.bytes);
      at += r.bytes;
    }
  }
  // The texture updates since the last draw and the positions, ahead of everything.
  if (!o.pending.empty() || staging) {
    id<MTLBlitCommandEncoder> blit = [cmd blitCommandEncoder];
    size_t from = 0;
    for (const Range& r : ranges) {
      [blit copyFromBuffer:staging sourceOffset:from toBuffer:o.positions destinationOffset:r.to size:r.bytes];
      from += r.bytes;
    }
    for (const Objects::Pending& p : o.pending)
      for (size_t k = 0; k < p.regions.size(); k++) {
        const TextureRegion& r = p.regions[k];
        [blit copyFromBuffer:p.buffer
                   sourceOffset:p.offsets[k]
              sourceBytesPerRow:Z(r.width) * 4
            sourceBytesPerImage:Z(r.width) * 4 * Z(r.height)
                     sourceSize:MTLSizeMake(Z(r.width), Z(r.height), 1)
                      toTexture:o.textures[Z(p.index)]
               destinationSlice:0
               destinationLevel:Z(r.level)
              destinationOrigin:MTLOriginMake(Z(r.x), Z(r.y), 0)];
      }
    [blit endEncoding];
    o.pending.clear();
  }
  for (const RenderOp& op : plan_.ops) {
    if (!execute(op)) break;
  }
  o.end_encoder();
  o.cmd = nil;
  o.host = nil;
  return ok_;
}

}  // namespace mochi2d::render::mtl

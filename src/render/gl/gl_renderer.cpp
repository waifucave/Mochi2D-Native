#include "render/gl/gl_renderer.hpp"

#include "render/shaders.hpp"

#include <algorithm>
#include <cstring>

namespace mochi2d::render::gl {

namespace {

using std::size_t;
size_t Z(int64_t i) { return static_cast<size_t>(i); }

enum Uniform {
  kView,
  kTurn,
  kMaskTex,
  kMaskClip,
  kTex,
  kMask,
  kDst,
  kMultiply,
  kScreen,
  kTint,
  kOpacity,
  kMaskMode,
  kColorFn,
  kAlphaMode,
  kUniforms
};
static_assert(kUniforms == kShaderUniforms, "the uniform list");
/** A mask matrix's rows 0 and 1 (RenderOp) as the column-major mat4 glUniformMatrix4fv takes. */
std::array<GLfloat, 16> gl_matrix(const std::array<float, 8>& rows) {
  return {rows[0], rows[4], 0, 0, rows[1], rows[5], 0, 0, rows[2], rows[6], 1, 0, rows[3], rows[7], 0, 1};
}
}  // namespace

bool load(Api& api, Loader loader, void* user, const char** missing) {
#define M2D_GL_LOAD(ret, name, args)                                                               \
  api.name = reinterpret_cast<ret(M2D_GLAPI*) args>(loader ? loader("gl" #name, user) : nullptr); \
  if (!api.name) {                                                                                 \
    if (missing) *missing = "gl" #name;                                                            \
    return false;                                                                                  \
  }
  M2D_GL_FUNCTIONS(M2D_GL_LOAD)
#undef M2D_GL_LOAD
  return true;
}

GlRenderer::GlRenderer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const Texture>> textures,
                       const Api& api, const GlOptions& options)
    : model_(std::move(model)), textures_(std::move(textures)), gl_(api), options_(options), rm_(*model_) {
  const moc::Model& m = *model_;
  while (gl_.GetError() != GL_NO_ERROR) {
  }
  const ShaderDialect dialect = options_.desktop ? ShaderDialect::Glsl330 : ShaderDialect::GlslEs300;
  const auto build = [&](Program& p, ShaderProgram which, const char* name) {
    return build_program(p, shader_source(which, ShaderStage::Vertex, dialect),
                         shader_source(which, ShaderStage::Fragment, dialect), name);
  };
  if (!build(mesh_, ShaderProgram::Mesh, "mesh") || !build(mesh_advanced_, ShaderProgram::MeshAdvanced, "mesh advanced") ||
      !build(layer_, ShaderProgram::Layer, "layer") ||
      !build(layer_advanced_, ShaderProgram::LayerAdvanced, "layer advanced") ||
      !build(mask_, ShaderProgram::Mask, "mask"))
    return;
  // Textures: the prepared levels as they are (Mochi2D prepares the same texels on the GPU).
  GLint max_size = 0;
  gl_.GetIntegerv(GL_MAX_TEXTURE_SIZE, &max_size);
  if (options_.max_texture_size > 0) max_size = std::min<GLint>(max_size, options_.max_texture_size);
  max_texture_size_ = max_size;
  gl_.PixelStorei(GL_UNPACK_ALIGNMENT, 1);
  for (const auto& t : textures_) {
    GLuint id = 0;
    if (t && !t->levels.empty()) {
      if (t->width > max_size || t->height > max_size) {
        fail((String("texture ") + to_str(static_cast<unsigned>(gl_textures_.size())) + " is " +
              to_str(static_cast<unsigned>(t->width)) + "×" + to_str(static_cast<unsigned>(t->height)) +
              ", larger than the maximum texture size " + to_str(static_cast<unsigned>(max_size)))
                 .c_str(),
             String(), "gl-texture-size");
        return;
      }
      gl_.GenTextures(1, &id);
      gl_.BindTexture(GL_TEXTURE_2D, id);
      for (size_t l = 0; l < t->levels.size(); l++) {
        const auto& lv = t->levels[l];
        gl_.TexImage2D(GL_TEXTURE_2D, static_cast<GLint>(l), static_cast<GLint>(GL_RGBA8), lv.width, lv.height, 0,
                       GL_RGBA, GL_UNSIGNED_BYTE, lv.rgba.data());
      }
      const GLint levels = static_cast<GLint>(t->levels.size());
      gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_BASE_LEVEL, 0);
      gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAX_LEVEL, levels - 1);
      gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER,
                        static_cast<GLint>(levels > 1 ? GL_LINEAR_MIPMAP_LINEAR : GL_LINEAR));
      gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, static_cast<GLint>(GL_LINEAR));
      gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, static_cast<GLint>(GL_REPEAT));
      gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, static_cast<GLint>(GL_REPEAT));
    }
    gl_textures_.push_back(id);
    has_texture_.push_back(id != 0 ? 1 : 0);
  }
  gl_.BindTexture(GL_TEXTURE_2D, 0);
  // Geometry: every mesh's vertices one after another; UVs static, positions per frame.
  const size_t N = m.meshes.ids.size();
  uint32_t vertices = 0, indices = 0;
  Vector<uint32_t> all_indices;
  Vector<float> all_uvs;
  for (size_t i = 0; i < N; i++) {
    const uint32_t count = static_cast<uint32_t>(m.meshes.uvs[i].size() / 2);
    vertex_start_.push_back(vertices);
    index_start_.push_back(indices);
    index_count_.push_back(static_cast<uint32_t>(rm_.triangles[i].size()));
    for (uint16_t k : rm_.triangles[i]) all_indices.push_back(vertices + k);
    // Rule V: v as the renderer samples it, flipped twice in float32.
    all_uvs.insert(all_uvs.end(), rm_.uvs[i].begin(), rm_.uvs[i].begin() + 2 * count);
    vertices += count;
    indices += static_cast<uint32_t>(rm_.triangles[i].size());
  }
  staged_.assign(N, 0);
  gl_.GenVertexArrays(1, &vao_);
  gl_.GenVertexArrays(1, &fullscreen_vao_);
  gl_.BindVertexArray(vao_);
  gl_.GenBuffers(1, &positions_);
  gl_.GenBuffers(1, &uvs_);
  gl_.GenBuffers(1, &indices_);
  gl_.BindBuffer(GL_ARRAY_BUFFER, positions_);
  gl_.BufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(std::max<uint32_t>(vertices, 1) * 8), nullptr,
                 GL_DYNAMIC_DRAW);
  gl_.EnableVertexAttribArray(0);
  gl_.VertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE_, 0, nullptr);
  gl_.BindBuffer(GL_ARRAY_BUFFER, uvs_);
  gl_.BufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(std::max<size_t>(all_uvs.size(), 2) * 4),
                 all_uvs.empty() ? nullptr : all_uvs.data(), GL_STATIC_DRAW);
  gl_.EnableVertexAttribArray(1);
  gl_.VertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE_, 0, nullptr);
  gl_.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, indices_);
  gl_.BufferData(GL_ELEMENT_ARRAY_BUFFER, static_cast<GLsizeiptr>(std::max<size_t>(all_indices.size(), 1) * 4),
                 all_indices.empty() ? nullptr : all_indices.data(), GL_STATIC_DRAW);
  gl_.BindVertexArray(0);
  gl_.BindBuffer(GL_ARRAY_BUFFER, 0);
  if (gl_.GetError() != GL_NO_ERROR) fail("a GL error while creating the renderer");
  created_ = ok_;
}

bool GlRenderer::update_texture(int index, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x,
                                int y) {
  if (!created_) return false;
  if (index < 0 || Z(index) >= textures_.size() || !textures_[Z(index)] || !gl_textures_[Z(index)]) return false;
  const Texture& cur = *textures_[Z(index)];
  if (w < 1 || h < 1 || x < 0 || y < 0 || x > cur.width - w || y > cur.height - h) return false;
  auto t = own_copy(textures_, own_texture_, Z(index));
  Vector<TextureRegion> changed;
  if (!update_texture_in(*t, straight, w, h, stride, x, y, &changed)) return false;
  while (gl_.GetError() != GL_NO_ERROR) {
  }
  gl_.BindTexture(GL_TEXTURE_2D, gl_textures_[Z(index)]);
  gl_.PixelStorei(GL_UNPACK_ALIGNMENT, 1);
  Vector<uint8_t> packed;
  for (const TextureRegion& r : changed) {
    const Texture::Level& lv = t->levels[Z(r.level)];
    const size_t row = Z(r.width) * 4;
    packed.resize(row * Z(r.height));
    for (int j = 0; j < r.height; j++)
      std::memcpy(packed.data() + row * Z(j), lv.rgba.data() + (Z(r.y + j) * Z(lv.width) + Z(r.x)) * 4, row);
    gl_.TexSubImage2D(GL_TEXTURE_2D, r.level, r.x, r.y, r.width, r.height, GL_RGBA, GL_UNSIGNED_BYTE, packed.data());
  }
  gl_.BindTexture(GL_TEXTURE_2D, 0);
  const GLenum e = gl_.GetError();
  if (e != GL_NO_ERROR) {
    error_ = "a GL error while updating a texture: " + to_str(static_cast<unsigned>(e));
    error_code_ = "gl-error";
    return false;
  }
  return true;
}

GlRenderer::~GlRenderer() {
  for (GLuint t : gl_textures_)
    if (t) gl_.DeleteTextures(1, &t);
  for (Program* p : {&mesh_, &mesh_advanced_, &layer_, &layer_advanced_, &mask_})
    if (p->id) gl_.DeleteProgram(p->id);
  for (GLuint* b : {&positions_, &uvs_, &indices_})
    if (*b) gl_.DeleteBuffers(1, b);
  for (GLuint* v : {&vao_, &fullscreen_vao_})
    if (*v) gl_.DeleteVertexArrays(1, v);
  release_target(mask_target_);
  release_target(offscreen_mask_target_);
  release_target(dst_copy_);
  for (auto& t : layers_) release_target(t);
}

bool GlRenderer::fail(const char* what, const String& detail, const char* code) {
  ok_ = false;
  error_code_ = code;
  error_ = what;
  if (!detail.empty()) error_ += ": " + detail;
  return false;
}

bool GlRenderer::build_program(Program& p, const String& vs, const String& fs, const char* name) {
  const auto compile = [&](GLenum type, const String& src, GLuint& out) {
    out = gl_.CreateShader(type);
    const char* text = src.c_str();
    gl_.ShaderSource(out, 1, &text, nullptr);
    gl_.CompileShader(out);
    GLint okv = 0;
    gl_.GetShaderiv(out, GL_COMPILE_STATUS, &okv);
    if (okv) return true;
    GLint len = 0;
    gl_.GetShaderiv(out, GL_INFO_LOG_LENGTH, &len);
    String log(static_cast<size_t>(std::max(len, 1)), '\0');
    gl_.GetShaderInfoLog(out, len, nullptr, &log[0]);
    return fail((String("the ") + name + " shader does not compile").c_str(), log, "gl-shader");
  };
  GLuint v = 0, f = 0;
  if (!compile(GL_VERTEX_SHADER, vs, v) || !compile(GL_FRAGMENT_SHADER, fs, f)) return false;
  p.id = gl_.CreateProgram();
  gl_.AttachShader(p.id, v);
  gl_.AttachShader(p.id, f);
  gl_.LinkProgram(p.id);
  gl_.DeleteShader(v);
  gl_.DeleteShader(f);
  GLint linked = 0;
  gl_.GetProgramiv(p.id, GL_LINK_STATUS, &linked);
  if (!linked) {
    GLint len = 0;
    gl_.GetProgramiv(p.id, GL_INFO_LOG_LENGTH, &len);
    String log(static_cast<size_t>(std::max(len, 1)), '\0');
    gl_.GetProgramInfoLog(p.id, len, nullptr, &log[0]);
    return fail((String("the ") + name + " program does not link").c_str(), log, "gl-shader");
  }
  for (int u = 0; u < kUniforms; u++) p.u[u] = gl_.GetUniformLocation(p.id, kShaderUniformNames[u]);
  return true;
}

bool GlRenderer::ensure_target(Target& t, int width, int height, bool linear) {
  if (t.texture && t.width == width && t.height == height) return true;
  if (!t.texture) {
    gl_.GenTextures(1, &t.texture);
    gl_.GenFramebuffers(1, &t.framebuffer);
  }
  t.width = width;
  t.height = height;
  gl_.BindTexture(GL_TEXTURE_2D, t.texture);
  gl_.TexImage2D(GL_TEXTURE_2D, 0, static_cast<GLint>(GL_RGBA8), width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
  const GLint filter = static_cast<GLint>(linear ? GL_LINEAR : GL_NEAREST);
  gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, filter);
  gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, filter);
  gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, static_cast<GLint>(GL_CLAMP_TO_EDGE));
  gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, static_cast<GLint>(GL_CLAMP_TO_EDGE));
  gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAX_LEVEL, 0);
  gl_.BindFramebuffer(GL_FRAMEBUFFER, t.framebuffer);
  gl_.FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, t.texture, 0);
  if (gl_.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
    return fail("a render target is incomplete");
  return true;
}

void GlRenderer::release_target(Target& t) {
  if (t.framebuffer) gl_.DeleteFramebuffers(1, &t.framebuffer);
  if (t.texture) gl_.DeleteTextures(1, &t.texture);
  t = Target();
}

void GlRenderer::upload_vertices(const eval::Instance& inst) {
  // A new instance can take a destroyed one's address: its serial tells them apart.
  const bool fresh = inst.serial.value != staged_for_;
  staged_for_ = inst.serial.value;
  gl_.BindBuffer(GL_ARRAY_BUFFER, positions_);
  for (size_t i = 0; i < vertex_start_.size(); i++) {
    const uint32_t version = i < inst.drawable_vertex_version.size() ? inst.drawable_vertex_version[i] : 0;
    if (!fresh && staged_[i] == version) continue;
    const auto& v = inst.drawable_vertices[i];
    const size_t count = std::min(v.size(), model_->meshes.uvs[i].size());
    if (count) gl_.BufferSubData(GL_ARRAY_BUFFER, static_cast<GLintptr>(vertex_start_[i]) * 8,
                                 static_cast<GLsizeiptr>(count * 4), v.data());
    staged_[i] = version;
  }
  gl_.BindBuffer(GL_ARRAY_BUFFER, 0);
}

void GlRenderer::apply_blend(BlendKind kind) {
  gl_.Enable(GL_BLEND);
  gl_.BlendEquation(GL_FUNC_ADD);
  if (kind == BlendKind::Additive)
    gl_.BlendFuncSeparate(GL_ONE, GL_ONE, GL_ZERO, GL_ONE);
  else if (kind == BlendKind::Multiplicative)
    gl_.BlendFuncSeparate(GL_DST_COLOR, GL_ONE_MINUS_SRC_ALPHA, GL_ZERO, GL_ONE);
  else
    gl_.BlendFuncSeparate(GL_ONE, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
}

void GlRenderer::set_colors_and_mask(const Program& p, const RenderOp& op) {
  gl_.Uniform3f(p.u[kMultiply], op.multiply[0], op.multiply[1], op.multiply[2]);
  gl_.Uniform3f(p.u[kScreen], op.screen[0], op.screen[1], op.screen[2]);
  gl_.Uniform1f(p.u[kOpacity], op.opacity);
  gl_.Uniform3f(p.u[kTint], op.tint[0], op.tint[1], op.tint[2]);
  if (op.mask.buffer < 0) {
    // A draw without a mask: its coordinate is never sampled (the zero matrix, as Mochi2D sets it).
    const GLfloat zero[16] = {};
    gl_.Uniform1i(p.u[kMaskMode], 0);
    gl_.UniformMatrix4fv(p.u[kMaskTex], 1, GL_FALSE_, zero);
  } else {
    gl_.Uniform1i(p.u[kMaskMode], op.mask.inverted ? 2 : 1);
    gl_.UniformMatrix4fv(p.u[kMaskTex], 1, GL_FALSE_, gl_matrix(op.mask.matrix).data());
    gl_.ActiveTexture(GL_TEXTURE0 + 1);
    gl_.BindTexture(GL_TEXTURE_2D, op.mask.buffer == 0 ? mask_target_.texture : offscreen_mask_target_.texture);
    gl_.Uniform1i(p.u[kMask], 1);
  }
  if (op.blend == BlendKind::Advanced) {
    gl_.Uniform1i(p.u[kColorFn], op.color_fn);
    gl_.Uniform1i(p.u[kAlphaMode], op.alpha_mode);
    gl_.ActiveTexture(GL_TEXTURE0 + 2);
    gl_.BindTexture(GL_TEXTURE_2D, dst_copy_.texture);
    gl_.Uniform1i(p.u[kDst], 2);
    gl_.Disable(GL_BLEND);
  } else {
    apply_blend(op.blend);
  }
}

void GlRenderer::draw_elements(int d) {
  const uint32_t n = index_count_[Z(d)];
  if (n == 0) return;
  gl_.DrawElements(GL_TRIANGLES, static_cast<GLsizei>(n), GL_UNSIGNED_INT,
                   reinterpret_cast<const void*>(static_cast<uintptr_t>(index_start_[Z(d)]) * 4));
}

void GlRenderer::execute(const RenderOp& op, GLuint frame_fb) {
  const moc::Model& m = *model_;
  const Framing& f = framing_;
  const auto bind = [&](int32_t target) {
    gl_.BindFramebuffer(GL_FRAMEBUFFER, target < 0 ? frame_fb : layers_[Z(target)].framebuffer);
    gl_.Viewport(0, 0, f.width, f.height);
  };
  switch (op.kind) {
    case RenderOp::Kind::Clear:
      bind(-1);
      gl_.ClearColor(static_cast<float>(op.color[0]), static_cast<float>(op.color[1]), static_cast<float>(op.color[2]),
                     static_cast<float>(op.color[3]));
      gl_.Clear(GL_COLOR_BUFFER_BIT);
      return;
    case RenderOp::Kind::BuildMask: {
      Target& t = op.buffer == 0 ? mask_target_ : offscreen_mask_target_;
      if (!ensure_target(t, op.size, op.size, true)) return;
      gl_.BindFramebuffer(GL_FRAMEBUFFER, t.framebuffer);
      gl_.Viewport(0, 0, op.size, op.size);
      gl_.Enable(GL_SCISSOR_TEST);
      gl_.Scissor(op.scissor[0], op.scissor[1], op.scissor[2], op.scissor[3]);
      gl_.ColorMask(1, 1, 1, 1);
      gl_.ClearColor(1, 1, 1, 1);
      gl_.Clear(GL_COLOR_BUFFER_BIT);
      gl_.ColorMask(1, 0, 0, 0);
      gl_.Enable(GL_BLEND);
      gl_.BlendEquation(GL_FUNC_ADD);
      gl_.BlendFuncSeparate(GL_ZERO, GL_ONE_MINUS_SRC_ALPHA, GL_ZERO, GL_ONE_MINUS_SRC_ALPHA);
      gl_.UseProgram(mask_.id);
      gl_.UniformMatrix4fv(mask_.u[kMaskClip], 1, GL_FALSE_, gl_matrix(op.mask.matrix).data());
      gl_.Uniform1i(mask_.u[kTex], 0);
      gl_.BindVertexArray(vao_);
      gl_.ActiveTexture(GL_TEXTURE0);
      for (uint32_t k = 0; k < op.count; k++) {
        const int32_t mm = plan_.mask_meshes[op.first + k];
        const int32_t tex = m.meshes.texture[Z(mm)];
        if (tex < 0 || Z(tex) >= gl_textures_.size() || !gl_textures_[Z(tex)]) continue;
        gl_.BindTexture(GL_TEXTURE_2D, gl_textures_[Z(tex)]);
        if ((m.meshes.flags[Z(mm)] & 4) == 0)
          gl_.Enable(GL_CULL_FACE);
        else
          gl_.Disable(GL_CULL_FACE);
        draw_elements(mm);
      }
      gl_.ColorMask(1, 1, 1, 1);
      gl_.Disable(GL_SCISSOR_TEST);
      return;
    }
    case RenderOp::Kind::OpenLayer: {
      if (layers_.size() <= Z(op.layer)) layers_.resize(Z(op.layer) + 1);
      // Rule L: layers are read through a linearly filtered quad.
      if (!ensure_target(layers_[Z(op.layer)], f.width, f.height, true)) return;
      bind(op.layer);
      gl_.Disable(GL_SCISSOR_TEST);
      gl_.ColorMask(1, 1, 1, 1);
      gl_.ClearColor(0, 0, 0, 0);
      gl_.Clear(GL_COLOR_BUFFER_BIT);
      return;
    }
    case RenderOp::Kind::CopyDestination:
      if (!ensure_target(dst_copy_, f.width, f.height, false)) return;
      gl_.Disable(GL_SCISSOR_TEST);
      gl_.BindFramebuffer(GL_READ_FRAMEBUFFER, layers_[Z(op.target)].framebuffer);
      gl_.BindFramebuffer(GL_DRAW_FRAMEBUFFER, dst_copy_.framebuffer);
      gl_.BlitFramebuffer(0, 0, f.width, f.height, 0, 0, f.width, f.height, GL_COLOR_BUFFER_BIT, GL_NEAREST);
      return;
    case RenderOp::Kind::DrawMesh: {
      const int32_t d = op.index;
      bind(op.target);
      const Program& p = op.blend == BlendKind::Advanced ? mesh_advanced_ : mesh_;
      gl_.UseProgram(p.id);
      gl_.Uniform4f(p.u[kView], static_cast<float>(plan_.view[0]), static_cast<float>(plan_.view[1]),
                    static_cast<float>(plan_.view[2]), static_cast<float>(plan_.view[3]));
      gl_.Uniform3f(p.u[kTurn], 1, 0, 0);
      set_colors_and_mask(p, op);
      gl_.ActiveTexture(GL_TEXTURE0);
      gl_.BindTexture(GL_TEXTURE_2D, gl_textures_[Z(m.meshes.texture[Z(d)])]);
      gl_.Uniform1i(p.u[kTex], 0);
      if (op.cull)
        gl_.Enable(GL_CULL_FACE);
      else
        gl_.Disable(GL_CULL_FACE);
      gl_.BindVertexArray(vao_);
      draw_elements(d);
      return;
    }
    case RenderOp::Kind::Composite: {
      bind(op.target);
      const Program& p = op.blend == BlendKind::Advanced ? layer_advanced_ : layer_;
      gl_.UseProgram(p.id);
      set_colors_and_mask(p, op);
      gl_.ActiveTexture(GL_TEXTURE0);
      gl_.BindTexture(GL_TEXTURE_2D, layers_[Z(op.layer)].texture);
      gl_.Uniform1i(p.u[kTex], 0);
      gl_.Disable(GL_CULL_FACE);
      gl_.BindVertexArray(fullscreen_vao_);
      gl_.DrawArrays(GL_TRIANGLE_STRIP, 0, 4);
      return;
    }
  }
}

bool GlRenderer::draw(const eval::Instance& instance, const FrameOptions& frame, GLuint framebuffer) {
  if (!created_) return false;
  ok_ = true;
  while (gl_.GetError() != GL_NO_ERROR) {
  }
  framing_ = frame.framing;
  plan_frame(rm_, *model_, instance, frame, options_.mask_size, options_.offscreen_mask_size, has_texture_, plan_);
  upload_vertices(instance);
  // The fixed state every draw relies on.
  gl_.Disable(GL_SCISSOR_TEST);
  gl_.Disable(GL_DEPTH_TEST);
  gl_.Disable(GL_STENCIL_TEST);
  gl_.Disable(GL_DITHER);
  gl_.ColorMask(1, 1, 1, 1);
  gl_.FrontFace(GL_CCW);
  gl_.CullFace(GL_BACK);
  for (const RenderOp& op : plan_.ops) {
    execute(op, framebuffer);
    if (!ok_) break;
  }
  // Leave a predictable state for other code.
  gl_.Disable(GL_BLEND);
  gl_.Disable(GL_CULL_FACE);
  gl_.BindVertexArray(0);
  for (GLenum unit : {2u, 1u, 0u}) {
    gl_.ActiveTexture(GL_TEXTURE0 + unit);
    gl_.BindTexture(GL_TEXTURE_2D, 0);
  }
  gl_.BindFramebuffer(GL_FRAMEBUFFER, framebuffer);
  if (!ok_) return false;
  const GLenum e = gl_.GetError();
  if (e != GL_NO_ERROR) return fail("a GL error while drawing", to_str(static_cast<unsigned>(e)));
  return true;
}

}  // namespace mochi2d::render::gl

// The GL backend's test tool: renders scenarios through the OpenGL backend
// in a headless EGL context (Mesa's surfaceless platform, or any EGL that
// offers a context without a window), as `mochi2d-native render` does with
// the reference renderer, and compares renders.
//
//   mochi2d-gl-render info [--api es|desktop]
//   mochi2d-gl-render render <scenario.json | folder>... --out <folder> [--models <folder>] [--api es|desktop]
//                            [--max-texture-size N | device]
//   mochi2d-gl-render compare <folder a> <folder b> [--max-rms <x>] [--max-diff <n>]
//   mochi2d-gl-render capi <model.moc3> <texture.png>... [--api es|desktop]
//
// `capi` goes through the C API (m2d_gl_renderer_*, the host's loader and
// framebuffer) and compares a frame with m2d_renderer_draw's.
//
// `--api es` (the default) asks for OpenGL ES 3.0, `--api desktop` for
// desktop OpenGL 3.3 core. EGL is the system's (Mesa's surfaceless
// platform), or with `--egl <libEGL.so>` ANGLE's on its Vulkan backend
// without a window system (with VK_ICD_FILENAMES naming SwiftShader's
// driver, the reference renders' configuration). `render` caps textures at
// 8192 by default, the reference configuration's limit (its
// TextureTooLarge), for conformance runs; `--max-texture-size device` takes
// the context's GL_MAX_TEXTURE_SIZE, the backend's own default, as Mochi2D
// takes the driver's limit. Exit code 77 when no context can be made (no EGL
// display or no such context), so ctest skips. Test code: it is the host,
// the library makes no context.
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <dlfcn.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#include "conformance/render.hpp"
#include "mochi2d.h"
#include "render/gl/gl_renderer.hpp"
#include "support/image_compare.hpp"

namespace fs = std::filesystem;
using namespace mochi2d;
namespace gl = mochi2d::render::gl;

namespace {

#ifndef EGL_PLATFORM_SURFACELESS_MESA
#define EGL_PLATFORM_SURFACELESS_MESA 0x31DD
#endif

// EGL's entry points, from the library the tool is told to use: the
// system's libEGL.so.1 (Mesa's, through glvnd) or ANGLE's libEGL.so.
struct Egl {
  void* lib = nullptr;
  PFNEGLGETPROCADDRESSPROC GetProcAddress = nullptr;
  PFNEGLGETDISPLAYPROC GetDisplay = nullptr;
  PFNEGLINITIALIZEPROC Initialize = nullptr;
  PFNEGLCHOOSECONFIGPROC ChooseConfig = nullptr;
  PFNEGLBINDAPIPROC BindAPI = nullptr;
  PFNEGLCREATECONTEXTPROC CreateContext = nullptr;
  PFNEGLMAKECURRENTPROC MakeCurrent = nullptr;
  PFNEGLDESTROYCONTEXTPROC DestroyContext = nullptr;
  PFNEGLTERMINATEPROC Terminate = nullptr;
  bool open(const char* path) {
    lib = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!lib) return false;
#define M2D_EGL(name) name = reinterpret_cast<decltype(name)>(dlsym(lib, "egl" #name));
    M2D_EGL(GetProcAddress)
    M2D_EGL(GetDisplay)
    M2D_EGL(Initialize)
    M2D_EGL(ChooseConfig)
    M2D_EGL(BindAPI)
    M2D_EGL(CreateContext)
    M2D_EGL(MakeCurrent)
    M2D_EGL(DestroyContext)
    M2D_EGL(Terminate)
#undef M2D_EGL
    return GetProcAddress && GetDisplay && Initialize && ChooseConfig && BindAPI && CreateContext && MakeCurrent &&
           DestroyContext && Terminate;
  }
};
Egl g_egl;

#ifndef EGL_PLATFORM_ANGLE_ANGLE
#define EGL_PLATFORM_ANGLE_ANGLE 0x3202
#define EGL_PLATFORM_ANGLE_TYPE_ANGLE 0x3203
#endif
#ifndef EGL_PLATFORM_ANGLE_TYPE_VULKAN_ANGLE
#define EGL_PLATFORM_ANGLE_TYPE_VULKAN_ANGLE 0x3450
#endif
#ifndef EGL_PLATFORM_ANGLE_NATIVE_PLATFORM_TYPE_ANGLE
#define EGL_PLATFORM_ANGLE_NATIVE_PLATFORM_TYPE_ANGLE 0x348F
#endif

struct Context {
  EGLDisplay display = EGL_NO_DISPLAY;
  EGLContext context = EGL_NO_CONTEXT;
  gl::Api api;
  String error;

  /** `angle`: ANGLE's Vulkan backend without a window system (its offscreen display). */
  bool open(bool desktop, const std::string& egl_library) {
    const bool angle = !egl_library.empty();
    if (!g_egl.open(angle ? egl_library.c_str() : "libEGL.so.1")) {
      error = String("no EGL library (") + (angle ? egl_library.c_str() : "libEGL.so.1") + ")";
      return false;
    }
    auto get_platform_display =
        reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(g_egl.GetProcAddress("eglGetPlatformDisplayEXT"));
    if (angle) {
      const EGLint attrs[] = {EGL_PLATFORM_ANGLE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_TYPE_VULKAN_ANGLE,
                              EGL_PLATFORM_ANGLE_NATIVE_PLATFORM_TYPE_ANGLE, EGL_PLATFORM_SURFACELESS_MESA, EGL_NONE};
      if (get_platform_display)
        display = get_platform_display(EGL_PLATFORM_ANGLE_ANGLE, reinterpret_cast<void*>(EGL_DEFAULT_DISPLAY), attrs);
    } else {
      if (get_platform_display)
        display = get_platform_display(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, nullptr);
      if (display == EGL_NO_DISPLAY) display = g_egl.GetDisplay(EGL_DEFAULT_DISPLAY);
    }
    EGLint major = 0, minor = 0;
    if (display == EGL_NO_DISPLAY || !g_egl.Initialize(display, &major, &minor)) {
      error = "no EGL display";
      display = EGL_NO_DISPLAY;
      return false;
    }
    const EGLint config_attrs[] = {EGL_RENDERABLE_TYPE, desktop ? EGL_OPENGL_BIT : EGL_OPENGL_ES3_BIT,
                                   EGL_SURFACE_TYPE, 0, EGL_NONE};
    EGLConfig config = nullptr;
    EGLint n = 0;
    if (!g_egl.ChooseConfig(display, config_attrs, &config, 1, &n)) n = 0;
    if (!g_egl.BindAPI(desktop ? EGL_OPENGL_API : EGL_OPENGL_ES_API)) {
      error = "eglBindAPI fails";
      return false;
    }
    const EGLint es[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 0, EGL_NONE};
    const EGLint core[] = {EGL_CONTEXT_MAJOR_VERSION,       3, EGL_CONTEXT_MINOR_VERSION, 3,
                           EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT, EGL_NONE};
    context = g_egl.CreateContext(display, n ? config : static_cast<EGLConfig>(nullptr), EGL_NO_CONTEXT,
                                  desktop ? core : es);
    if (context == EGL_NO_CONTEXT) {
      error = desktop ? "no OpenGL 3.3 core context" : "no OpenGL ES 3.0 context";
      return false;
    }
    if (!g_egl.MakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, context)) {
      error = "eglMakeCurrent fails without a surface";
      return false;
    }
    const char* missing = nullptr;
    if (!gl::load(api, [](const char* name, void*) { return reinterpret_cast<void*>(g_egl.GetProcAddress(name)); },
                  nullptr, &missing)) {
      error = String("the context lacks ") + missing;
      return false;
    }
    return true;
  }
  ~Context() {
    if (display != EGL_NO_DISPLAY) {
      g_egl.MakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
      if (context != EGL_NO_CONTEXT) g_egl.DestroyContext(display, context);
      g_egl.Terminate(display);
    }
  }
  String describe() const {
    const auto s = [&](gl::GLenum e) {
      const auto* p = api.GetString(e);
      return String(p ? reinterpret_cast<const char*>(p) : "?");
    };
    return s(gl::GL_RENDERER) + " | " + s(gl::GL_VERSION);
  }
};

/** The host's side: a frame-sized RGBA8 framebuffer, the backend draws into it, the pixels are read back. */
class GlDrawer : public conformance::Drawer {
 public:
  GlDrawer(Context& c, std::shared_ptr<const moc::Model> model,
           Vector<std::shared_ptr<const render::Texture>> textures, const gl::GlOptions& options)
      : c_(c),
        r_(std::move(model), std::move(textures), c.api, options),
        desktop_(options.desktop),
        mask_size_(options.mask_size),
        offscreen_mask_size_(options.offscreen_mask_size) {}
  ~GlDrawer() override {
    if (fb_) c_.api.DeleteFramebuffers(1, &fb_);
    if (tex_) c_.api.DeleteTextures(1, &tex_);
  }
  bool ok(String& error) const {
    if (!r_.ok()) error = r_.error();
    return r_.ok();
  }
  bool draw(const eval::Instance& instance, const render::FrameOptions& frame, render::Image& out,
            String& error) override {
    const gl::Api& g = c_.api;
    const int w = frame.framing.width, h = frame.framing.height;
    if (!fb_) {
      g.GenTextures(1, &tex_);
      g.GenFramebuffers(1, &fb_);
    }
    if (w != w_ || h != h_) {
      g.BindTexture(gl::GL_TEXTURE_2D, tex_);
      g.TexImage2D(gl::GL_TEXTURE_2D, 0, static_cast<gl::GLint>(gl::GL_RGBA8), w, h, 0, gl::GL_RGBA,
                   gl::GL_UNSIGNED_BYTE, nullptr);
      g.TexParameteri(gl::GL_TEXTURE_2D, gl::GL_TEXTURE_MIN_FILTER, static_cast<gl::GLint>(gl::GL_NEAREST));
      g.TexParameteri(gl::GL_TEXTURE_2D, gl::GL_TEXTURE_MAG_FILTER, static_cast<gl::GLint>(gl::GL_NEAREST));
      g.BindTexture(gl::GL_TEXTURE_2D, 0);
      g.BindFramebuffer(gl::GL_FRAMEBUFFER, fb_);
      g.FramebufferTexture2D(gl::GL_FRAMEBUFFER, gl::GL_COLOR_ATTACHMENT0, gl::GL_TEXTURE_2D, tex_, 0);
      if (g.CheckFramebufferStatus(gl::GL_FRAMEBUFFER) != gl::GL_FRAMEBUFFER_COMPLETE) {
        error = "the host framebuffer is incomplete";
        return false;
      }
      w_ = w;
      h_ = h;
    }
    if (!r_.draw(instance, frame, fb_)) {
      error = r_.error();
      return false;
    }
    // GL's rows run bottom to top; the image's top to bottom.
    out.width = w;
    out.height = h;
    out.rgba.assign(static_cast<std::size_t>(w) * static_cast<std::size_t>(h) * 4, 0);
    Vector<uint8_t> rows(out.rgba.size());
    g.BindFramebuffer(gl::GL_FRAMEBUFFER, fb_);
    g.PixelStorei(gl::GL_PACK_ALIGNMENT, 1);
    g.ReadPixels(0, 0, w, h, gl::GL_RGBA, gl::GL_UNSIGNED_BYTE, rows.data());
    g.BindFramebuffer(gl::GL_FRAMEBUFFER, 0);
    const std::size_t row = static_cast<std::size_t>(w) * 4;
    for (int y = 0; y < h; y++)
      std::memcpy(out.rgba.data() + row * static_cast<std::size_t>(y),
                  rows.data() + row * static_cast<std::size_t>(h - 1 - y), row);
    if (g.GetError() != gl::GL_NO_ERROR) {
      error = "a GL error while reading the frame";
      return false;
    }
    return true;
  }
  const render::FrameStats& stats() const override { return r_.plan().stats; }
  int mask_size() const override { return mask_size_; }
  int offscreen_mask_size() const override { return offscreen_mask_size_; }
  String name() const override {
    return String("mochi2d-native GL backend (") + (desktop_ ? "OpenGL 3.3 core" : "OpenGL ES 3.0") + "; " +
           c_.describe() + ")";
  }

 private:
  Context& c_;
  gl::GlRenderer r_;
  bool desktop_;
  int mask_size_, offscreen_mask_size_;
  gl::GLuint fb_ = 0, tex_ = 0;
  int w_ = 0, h_ = 0;
};

const char* const kUsage =
    "usage:\n"
    "  mochi2d-gl-render info [--api es|desktop] [--egl <libEGL.so>]\n"
    "  mochi2d-gl-render render <scenario.json | folder>... --out <folder> [--models <folder>] [--api es|desktop]\n"
    "                           [--max-texture-size N | device]\n"
    "  mochi2d-gl-render compare <folder a> <folder b> [--max-rms <x>] [--max-diff <n>]\n"
    "  mochi2d-gl-render capi <model.moc3> <texture.png>... [--api es|desktop]\n";

struct Args {
  std::vector<std::string> positional;
  std::string out, models, api = "es", egl;
  double max_rms = -1, max_diff = -1;
  /** The reference configuration's cap by default (conformance runs); 0 (`device`) the driver's limit. */
  int max_texture_size = M2D_MAX_TEXTURE_SIZE;
};

int compare(const Args& a) {
  if (a.positional.size() != 2) {
    std::cerr << kUsage;
    return 2;
  }
  return test::compare_folders(a.positional[0], a.positional[1], a.max_rms, a.max_diff);
}

/** The C API path: the GL backend into the host's framebuffer, against the reference renderer. */
int capi(const Args& a, Context& c, bool desktop) {
  if (a.positional.empty()) {
    std::cerr << kUsage;
    return 2;
  }
  String bytes;
  if (!test::read_file(fs::u8path(a.positional[0]), bytes)) {
    std::cerr << "cannot read " << a.positional[0] << "\n";
    return 1;
  }
  int failures = 0;
  const auto check = [&](bool ok, const char* what) {
    if (!ok) {
      std::cout << "FAIL " << what << "\n";
      failures++;
    }
  };
  m2d_error err;
  m2d_model* model = nullptr;
  if (m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err) != M2D_OK) {
    std::cerr << "load: " << err.message << "\n";
    return 1;
  }
  std::vector<m2d_texture*> textures;
  std::vector<std::vector<uint8_t>> images;
  std::vector<std::pair<int, int>> sizes;
  for (std::size_t i = 1; i < a.positional.size(); i++) {
    String png, why;
    Vector<uint8_t> rgba;
    int w = 0, h = 0;
    m2d_texture* t = nullptr;
    if (!test::read_file(fs::u8path(a.positional[i]), png) || !conformance::decode_png(png, w, h, rgba, why) ||
        m2d_texture_create(rgba.data(), w, h, 0, nullptr, &t, &err) != M2D_OK) {
      std::cerr << "texture " << a.positional[i] << " fails\n";
      return 1;
    }
    textures.push_back(t);
    images.emplace_back(rgba.begin(), rgba.end());
    sizes.emplace_back(w, h);
  }
  const auto count = static_cast<int32_t>(textures.size());
  m2d_gl_options go;
  m2d_gl_options_default(&go);
  go.desktop = desktop ? 1 : 0;
  const m2d_gl_loader loader = [](const char* name, void*) { return reinterpret_cast<void*>(g_egl.GetProcAddress(name)); };
  m2d_gl_renderer* gl = nullptr;
  check(m2d_gl_renderer_create(model, textures.data(), count, loader, nullptr, &go, &gl, &err) == M2D_OK,
        "m2d_gl_renderer_create");
  m2d_renderer* sw = nullptr;
  check(m2d_renderer_create(model, textures.data(), count, nullptr, &sw, &err) == M2D_OK, "m2d_renderer_create");
  for (m2d_texture* t : textures) m2d_texture_destroy(t);  // the renderers keep their own
  m2d_instance* inst = nullptr;
  check(m2d_instance_create(model, &inst, &err) == M2D_OK, "m2d_instance_create");
  if (!gl || !sw || !inst) return 1;
  // The host's framebuffer.
  const gl::Api& g = c.api;
  const int W = 160, H = 120;
  gl::GLuint tex = 0, fb = 0;
  g.GenTextures(1, &tex);
  g.BindTexture(gl::GL_TEXTURE_2D, tex);
  g.TexImage2D(gl::GL_TEXTURE_2D, 0, static_cast<gl::GLint>(gl::GL_RGBA8), W, H, 0, gl::GL_RGBA, gl::GL_UNSIGNED_BYTE,
               nullptr);
  g.GenFramebuffers(1, &fb);
  g.BindFramebuffer(gl::GL_FRAMEBUFFER, fb);
  g.FramebufferTexture2D(gl::GL_FRAMEBUFFER, gl::GL_COLOR_ATTACHMENT0, gl::GL_TEXTURE_2D, tex, 0);
  m2d_render_frame frame;
  m2d_render_frame_default(&frame);
  frame.background[0] = 0.25;
  frame.background[3] = 1;
  std::vector<uint8_t> a_px(static_cast<std::size_t>(W * H * 4)), b_px(a_px.size()), rows(a_px.size());
  // Two frames: the second after a change, so the vertex upload follows the instance.
  for (int pass = 0; pass < 2; pass++) {
    if (pass == 1 && m2d_model_parameter_count(model) > 0) {
      float range[3];
      m2d_model_parameter_range(model, 0, range);
      m2d_instance_set_parameter(inst, 0, range[1]);
    }
    check(m2d_instance_evaluate(inst, &err) == M2D_OK, "m2d_instance_evaluate");
    check(m2d_gl_renderer_draw(gl, inst, &frame, W, H, fb, &err) == M2D_OK, "m2d_gl_renderer_draw");
    check(m2d_renderer_draw(sw, inst, &frame, W, H, b_px.data(), 0, &err) == M2D_OK, "m2d_renderer_draw");
    g.BindFramebuffer(gl::GL_FRAMEBUFFER, fb);
    g.PixelStorei(gl::GL_PACK_ALIGNMENT, 1);
    g.ReadPixels(0, 0, W, H, gl::GL_RGBA, gl::GL_UNSIGNED_BYTE, rows.data());
    for (int y = 0; y < H; y++)
      std::memcpy(&a_px[static_cast<std::size_t>(y * W * 4)], &rows[static_cast<std::size_t>((H - 1 - y) * W * 4)],
                  static_cast<std::size_t>(W * 4));
    double sum = 0;
    for (std::size_t i = 0; i < a_px.size(); i++) {
      const double d = static_cast<double>(a_px[i]) - static_cast<double>(b_px[i]);
      sum += d * d;
    }
    const double rms = std::sqrt(sum / static_cast<double>(a_px.size()));
    m2d_render_stats gs, ss;
    m2d_gl_renderer_stats(gl, &gs);
    m2d_renderer_stats(sw, &ss);
    std::cout << "frame " << pass << ": RMS " << rms << " against the reference renderer; drawn " << gs.drawn
              << ", masked " << gs.masked << ", layers " << gs.layers << "\n";
    check(rms <= 3.0, "the frame differs from the reference renderer's beyond RMS 3");
    check(gs.drawn == ss.drawn && gs.masked == ss.masked && gs.mask_builds == ss.mask_builds &&
              gs.layers == ss.layers && gs.advanced_draws == ss.advanced_draws && gs.layered == ss.layered,
          "the statistics differ from the reference renderer's");
  }
  // The texture limit: the context's by default, M2D_MAX_TEXTURE_SIZE on request.
  {
    gl::GLint context_limit = 0;
    g.GetIntegerv(gl::GL_MAX_TEXTURE_SIZE, &context_limit);
    check(m2d_gl_renderer_max_texture_size(gl) == context_limit, "the default limit is the context's");
    std::vector<uint8_t> wide(4 * 9000 * 2, 200);
    m2d_texture* big = nullptr;
    check(m2d_texture_create(wide.data(), 9000, 2, 0, nullptr, &big, &err) == M2D_OK, "a 9000-wide texture");
    m2d_gl_renderer* taken = nullptr;
    const m2d_status st = m2d_gl_renderer_create(model, &big, 1, loader, nullptr, &go, &taken, &err);
    check(context_limit >= 9000 ? st == M2D_OK : std::strcmp(err.code, "gl-texture-size") == 0,
          "the context's limit decides");
    m2d_gl_renderer_destroy(taken);
    m2d_gl_options capped = go;
    capped.max_texture_size = M2D_MAX_TEXTURE_SIZE;
    m2d_gl_renderer* refused = nullptr;
    check(m2d_gl_renderer_create(model, &big, 1, loader, nullptr, &capped, &refused, &err) == M2D_LIMIT_ERROR &&
              std::strcmp(err.code, "gl-texture-size") == 0 && refused == nullptr,
          "M2D_MAX_TEXTURE_SIZE caps it");
    std::cout << "texture limit: the context's " << context_limit << "; 9000 wide "
              << (st == M2D_OK ? "taken" : "refused") << ", refused under the cap: " << err.message << "\n";
    m2d_texture_destroy(big);
  }
  // A texture updated in place (0.14.0) draws as a renderer made with the new image, byte for byte.
  if (!images.empty()) {
    const int tw = sizes[0].first, th = sizes[0].second;
    const int pw = std::max(1, tw / 2), ph = std::max(1, th / 3), px = tw / 4, py = th / 4;
    std::vector<uint8_t> patch(static_cast<std::size_t>(4 * pw * ph));
    for (std::size_t i = 0; i < patch.size(); i++) patch[i] = static_cast<uint8_t>((i * 53 + 17) & 255);
    std::vector<uint8_t> patched = images[0];
    for (int j = 0; j < ph; j++)
      std::memcpy(&patched[static_cast<std::size_t>(((py + j) * tw + px) * 4)], &patch[static_cast<std::size_t>(j * pw * 4)],
                  static_cast<std::size_t>(pw * 4));
    std::vector<m2d_texture*> fresh_textures;
    for (std::size_t i = 0; i < images.size(); i++) {
      m2d_texture* t = nullptr;
      m2d_texture_create(i == 0 ? patched.data() : images[i].data(), sizes[i].first, sizes[i].second, 0, nullptr, &t,
                         &err);
      fresh_textures.push_back(t);
    }
    m2d_gl_renderer* fresh = nullptr;
    check(m2d_gl_renderer_create(model, fresh_textures.data(), count, loader, nullptr, &go, &fresh, &err) == M2D_OK,
          "a renderer with the patched image");
    for (m2d_texture* t : fresh_textures) m2d_texture_destroy(t);
    const auto grab = [&](m2d_gl_renderer* r) {
      check(m2d_gl_renderer_draw(r, inst, &frame, W, H, fb, &err) == M2D_OK, "a draw");
      g.BindFramebuffer(gl::GL_FRAMEBUFFER, fb);
      std::vector<uint8_t> out(static_cast<std::size_t>(W * H * 4));
      g.ReadPixels(0, 0, W, H, gl::GL_RGBA, gl::GL_UNSIGNED_BYTE, out.data());
      return out;
    };
    const auto before = grab(gl);
    check(m2d_gl_renderer_update_texture(gl, 0, patch.data(), pw, ph, 0, px, py, &err) == M2D_OK,
          "m2d_gl_renderer_update_texture");
    const auto updated = grab(gl), made = grab(fresh);
    check(updated == made, "a texture updated in place draws as one made with the new image");
    check(updated != before, "the update changes the picture");
    check(m2d_gl_renderer_update_texture(gl, 0, patch.data(), pw, ph, 0, tw - pw + 1, 0, &err) == M2D_INVALID_ARGUMENT,
          "a region that does not fit is refused");
    std::cout << "texture update: " << pw << "×" << ph << " at (" << px << ", " << py << "), "
              << (updated == made ? "the same bytes" : "DIFFERENT") << " as a renderer made with it\n";
    m2d_gl_renderer_destroy(fresh);
  }
  // An instance of another model is refused; the renderer stays usable.
  m2d_model* other = nullptr;
  m2d_instance* foreign = nullptr;
  m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &other, &err);
  m2d_instance_create(other, &foreign, &err);
  check(m2d_gl_renderer_draw(gl, foreign, &frame, W, H, fb, &err) == M2D_INVALID_ARGUMENT, "a foreign instance");
  check(m2d_gl_renderer_draw(gl, inst, &frame, W, H, fb, &err) == M2D_OK, "a draw after a refusal");
  m2d_instance_destroy(foreign);
  m2d_model_destroy(other);
  g.BindFramebuffer(gl::GL_FRAMEBUFFER, 0);
  g.DeleteFramebuffers(1, &fb);
  g.DeleteTextures(1, &tex);
  m2d_gl_renderer_destroy(gl);
  m2d_renderer_destroy(sw);
  m2d_instance_destroy(inst);
  m2d_model_destroy(model);
  std::cout << (failures ? "FAILED" : "ok") << "\n";
  return failures ? 1 : 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << kUsage;
    return 2;
  }
  const std::string cmd = argv[1];
  Args a;
  for (int i = 2; i < argc; i++) {
    const std::string s = argv[i];
    const auto value = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (s == "--out") a.out = value();
    else if (s == "--models") a.models = value();
    else if (s == "--api") a.api = value();
    else if (s == "--egl") a.egl = value();
    else if (s == "--max-rms") a.max_rms = std::atof(value().c_str());
    else if (s == "--max-diff") a.max_diff = std::atof(value().c_str());
    else if (s == "--max-texture-size") {
      const std::string v = value();
      a.max_texture_size = v == "device" ? 0 : std::atoi(v.c_str());
    }
    else a.positional.push_back(s);
  }
  if (cmd == "compare") return compare(a);
  if (a.api != "es" && a.api != "desktop") {
    std::cerr << "--api is es or desktop\n";
    return 2;
  }
  const bool desktop = a.api == "desktop";
  Context c;
  if (!c.open(desktop, a.egl)) {
    std::cerr << "mochi2d-gl-render: " << c.error.c_str() << " (skipped)\n";
    return 77;
  }
  if (cmd == "capi") return capi(a, c, desktop);
  if (cmd == "info") {
    std::cout << c.describe().c_str() << "\n";
    return 0;
  }
  if (cmd != "render" || a.out.empty() || a.positional.empty()) {
    std::cerr << kUsage;
    return 2;
  }
  conformance::RenderOptions options;
  gl::GlOptions glo;
  glo.desktop = desktop;
  glo.max_texture_size = a.max_texture_size;
  gl::GLint context_limit = 0;
  c.api.GetIntegerv(gl::GL_MAX_TEXTURE_SIZE, &context_limit);
  options.max_texture_size =
      a.max_texture_size > 0 ? std::min<int>(a.max_texture_size, context_limit) : static_cast<int>(context_limit);
  options.drawer = [&](std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const render::Texture>> textures,
                       String& error) -> std::unique_ptr<conformance::Drawer> {
    auto d = std::make_unique<GlDrawer>(c, std::move(model), std::move(textures), glo);
    if (!d->ok(error)) return nullptr;
    return d;
  };
  conformance::ModelCache cache(conformance::model_search_dirs(fs::current_path(), fs::u8path(a.models)));
  Vector<String> inputs;
  for (const auto& p : a.positional) inputs.push_back(String(p.c_str()));
  std::cerr << "context: " << c.describe().c_str() << "\n";
  const auto summary = conformance::run_render(inputs, fs::u8path(a.out), cache, conformance::producer_id(), options,
                                               [](const String& line) { std::cerr << line.c_str() << "\n"; });
  std::cout << summary.total << " scenarios, " << summary.failed << " failed\n";
  return summary.total == 0 || summary.failed ? 1 : 0;
}

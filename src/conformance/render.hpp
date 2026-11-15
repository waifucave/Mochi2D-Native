// Reference renders of scenarios (port of Mochi2D's tools/lib/render-runner.ts
// and the harness's render request): each scenario's model and textures are
// loaded, a fresh instance evaluates the scenario's inputs, the reference
// renderer draws it, and `<out>/<id>.png` (premultiplied RGBA8) and
// `<out>/<id>.render.json` (`mochi2d-render/0`) are written. Tool code: it
// reads files and decodes PNG textures.
#pragma once

#include <filesystem>
#include <functional>

#include "conformance/scenario.hpp"
#include "render/renderer.hpp"

namespace mochi2d::conformance {

/** What draws the scenarios: the reference renderer by default, or a GPU backend (the GL tests). */
class Drawer {
 public:
  virtual ~Drawer() = default;
  /** Draws into `out` (premultiplied RGBA8, rows top to bottom); false with a message. */
  virtual bool draw(const eval::Instance& instance, const render::FrameOptions& frame, render::Image& out,
                    String& error) = 0;
  virtual const render::FrameStats& stats() const = 0;
  virtual int mask_size() const = 0;
  virtual int offscreen_mask_size() const = 0;
  /** The `renderer` field of the outcome. */
  virtual String name() const = 0;
};
/** Makes the drawer of a model and its prepared textures; null with a message. */
using DrawerFactory = std::function<std::unique_ptr<Drawer>(
    std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const render::Texture>> textures, String& error)>;

struct RenderOptions {
  /** The per-drawable mask buffer size (the reference's 4096 by default). */
  int mask_size = render::Renderer::kMaskSize;
  /** The renderer's threads (Renderer::set_threads: 1 the calling thread only, 0 the hardware's). */
  int threads = 1;
  /**
   * The largest texture side (Mochi2D's TextureTooLarge above it): the
   * reference configuration's 8192 by default; a GPU drawer passes its
   * context's limit, as Mochi2D takes the driver's.
   */
  int max_texture_size = render::kMaxTextureSize;
  /** Another drawer (empty: the reference renderer with the options above). */
  DrawerFactory drawer;
};

/** Decodes a PNG (any color type, as stb_image reads it) to straight RGBA8; false with a message. */
bool decode_png(const String& bytes, int& width, int& height, Vector<uint8_t>& rgba, String& error);
/** A PNG of RGBA8 pixels (rows top to bottom), stored without compression. */
String encode_png(int width, int height, const uint8_t* rgba);

/** Renders every scenario of the inputs; returns the number rendered and failed. */
RunSummary run_render(const Vector<String>& inputs, const std::filesystem::path& out_dir, ModelCache& models,
                      std::string_view producer, const RenderOptions& options,
                      const std::function<void(const String&)>& log);

}  // namespace mochi2d::conformance

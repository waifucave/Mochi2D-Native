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

/**
 * Caps on what a PNG may declare before it is decoded (Mochi2D 0.24.0's
 * DEFAULT_TEXTURE_LIMITS): 16384 on a side, 2^28 pixels an image, 2^30 for
 * a model's textures together.
 */
struct PngLimits {
  uint32_t max_side = 16384;
  uint64_t max_pixels = uint64_t{1} << 28;
  uint64_t max_total_pixels = uint64_t{1} << 30;
};

/** What a PNG's header declares, read without decoding it. */
struct PngHeader {
  uint32_t width = 0, height = 0;
  /** The fewest bytes a PNG of that size can hold (deflate inflates at most about 1,032:1). */
  uint64_t min_bytes = 0;
};

/**
 * Reads a PNG's IHDR and sums its IDAT data: false, with Mochi2D's
 * TextureFormatError wording, for a file that is not a PNG, a damaged
 * header, or a file too short for the size it declares.
 */
bool read_png_header(const String& bytes, PngHeader& out, String& error);

/** Why decode_png refused: damaged or crafted, or past a cap. */
enum class PngRefusal : uint8_t { None, Format, Limit };

/**
 * Decodes a PNG (any color type, as stb_image reads it) to straight RGBA8;
 * false with a message. The header is read first: a file that is damaged,
 * too short for its declared size, or past `limits` is refused before
 * anything is decoded (`refusal` says which).
 */
bool decode_png(const String& bytes, int& width, int& height, Vector<uint8_t>& rgba, String& error,
                const PngLimits& limits = PngLimits(), PngRefusal* refusal = nullptr);
/** A PNG of RGBA8 pixels (rows top to bottom), stored without compression. */
String encode_png(int width, int height, const uint8_t* rgba);

/** Renders every scenario of the inputs; returns the number rendered and failed. */
RunSummary run_render(const Vector<String>& inputs, const std::filesystem::path& out_dir, ModelCache& models,
                      std::string_view producer, const RenderOptions& options,
                      const std::function<void(const String&)>& log);

}  // namespace mochi2d::conformance

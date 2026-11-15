// The reference renderer (docs/design.md §8): a software rasterizer of
// Mochi2D's WebGL2 renderer in the reference configuration of 4f (port of
// src/render/model/model-renderer.ts and shaders.ts, src/render/texture/
// prepare.ts, src/core/render/{compositing,framing,masks}.ts and the render
// harness's use of them). It draws an evaluated instance into a
// premultiplied RGBA8 image, as Mochi2D's render harness reads it back.
#pragma once

#include <array>
#include <cstdint>
#include <memory>

#include "core/eval/instance.hpp"
#include "core/moc/model.hpp"
#include "render/workers.hpp"
#include "util/alloc.hpp"

namespace mochi2d::render {

/** §2b.1: a premultiplied 8-bit channel, ⌊c·a/255 + ½⌋. */
uint8_t premultiply_byte(int c, int a);
/** §2b.3: the mean of a 2×2 block of bytes, rounded to nearest with ties to even. */
uint8_t mip_average(int a, int b, int c, int d);

/**
 * A texture as Mochi2D's exact preparation makes it (§2b): premultiplied
 * RGBA8 texels, rows top to bottom (texture row 0 is the image's top row,
 * where UV v = 0), and a full mip chain.
 */
struct Texture {
  struct Level {
    int width = 0, height = 0;
    Vector<uint8_t> rgba;
  };
  int width = 0, height = 0;
  Vector<Level> levels;
};

/** The largest texture the reference harness accepts (WebGL's limit there). */
constexpr int kMaxTextureSize = 8192;

/**
 * Prepares a straight-alpha RGBA8 image (rows top to bottom): premultiplied,
 * with a mip chain whose texels are 2×2 means rounded with ties to even, the
 * rule of §2b.3, for every size: levels halve with floor (at least 1), and a
 * block reaching past the level above reads its last texel again (Mochi2D
 * 0.10.0's own rule for sizes that are not powers of two).
 */
void prepare_texture(const uint8_t* straight_rgba, int width, int height, Texture& out);

/** A rectangle of one level of a texture (texels, rows from the top). */
struct TextureRegion {
  int level, x, y, width, height;
};

/**
 * Replaces the region of `t` at (x, y) (texels from the top-left) the size
 * of the straight-alpha image `straight` (w × h, rows `stride` bytes apart, 0
 * for 4·w), as Mochi2D 0.14.0's updateTexture does: level 0 premultiplied as
 * at preparation, then in each further level only the texels whose 2×2 block
 * covers the region, by the same exact rule, so the result equals
 * prepare_texture of the new image. `changed` (if given) receives each
 * level's rewritten rectangle, for GPU uploads. False (nothing changed) when
 * the region does not fit or the texture is empty.
 */
bool update_texture(Texture& t, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x, int y,
                    Vector<TextureRegion>* changed = nullptr);
bool update_texture_in(Texture& t, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x, int y,
                       Vector<TextureRegion>* changed = nullptr);
/** textures[index] as this owner's own copy (copied on the first call; `own` marks the copies). */
std::shared_ptr<Texture> own_copy(Vector<std::shared_ptr<const Texture>>& textures, Vector<uint8_t>& own,
                                  std::size_t index);

/** An explicit view: the output-space point at the image center and image pixels per unit (§2i). */
struct View {
  double x = 0, y = 0, pixels_per_unit = 1;
};

/** Which output-space point sits at the image center, and how many image pixels one unit spans. */
struct Framing {
  int width = 0, height = 0;
  double k = 1, center_x = 0, center_y = 0;
};

/** The framing of a W × H image: `view` if given, else the canvas fitted into the image (framing.ts frameImage). */
Framing frame_image(const moc::Canvas& canvas, int width, int height, const View* view = nullptr);

/** A premultiplied RGBA8 image, rows top to bottom. */
struct Image {
  int width = 0, height = 0;
  Vector<uint8_t> rgba;
};

struct FrameOptions {
  Framing framing;
  /** Straight-alpha RGBA background (§2i); default transparent. */
  std::array<double, 4> background{0, 0, 0, 0};
  /** Application tints, RGBA per drawable (4 floats each), or null for none. */
  const float* tints = nullptr;
};

/** What the renderer did in the last frame (Mochi2D's FrameStats, the parts that apply). */
struct FrameStats {
  bool layered = false;
  uint32_t drawn = 0, masked = 0, mask_builds = 0, mask_mesh_draws = 0, layers = 0, advanced_draws = 0;
  uint64_t fragments = 0;
};

class Renderer {
 public:
  /** The reference mask buffer sizes (§2g.3, C8). */
  static constexpr int kMaskSize = 4096;
  static constexpr int kOffscreenMaskSize = 256;

  /**
   * A renderer for a model and its textures (by texture index; a drawable
   * whose texture is missing draws nothing, as in Mochi2D).
   */
  Renderer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const Texture>> textures,
           int mask_size = kMaskSize, int offscreen_mask_size = kOffscreenMaskSize);
  ~Renderer();
  Renderer(const Renderer&) = delete;
  Renderer& operator=(const Renderer&) = delete;

  /** Draws the instance's latest evaluation into `out` (framing.width × framing.height). */
  void draw(const eval::Instance& instance, const FrameOptions& frame, Image& out);
  /**
   * The same into caller memory: framing.width × framing.height premultiplied
   * RGBA8 pixels, rows top to bottom, `stride` bytes apart (≥ 4·width).
   */
  void draw(const eval::Instance& instance, const FrameOptions& frame, uint8_t* pixels, std::ptrdiff_t stride);

  /** True if the model needs the layered pipeline (§2h.1: offscreens, or a blend code the direct pipeline cannot draw). */
  bool layered() const { return layered_; }
  int mask_size() const { return mask_size_; }
  /**
   * Threads for drawing (rows of the image): 1 draws on the calling thread
   * only, 0 takes the hardware's concurrency, n > 1 takes n (the calling
   * thread and n − 1 workers). The image is the same, byte for byte, with
   * any number. Without thread support (MOCHI2D_NO_THREADS) it stays 1.
   */
  void set_threads(int threads);

  /**
   * Replaces texture `index`, or the region of it at (x, y) the size of the
   * straight-alpha image (w × h, rows `stride` bytes apart, 0 for 4·w), as
   * Mochi2D 0.14.0's updateTexture: drawn from the next draw, every mip level
   * as a fresh preparation of the new image gives it (update_texture). The
   * renderer copies a texture it shares on its first update, so other
   * renderers keep theirs. False for a missing texture or a region that does
   * not fit.
   */
  bool update_texture(int index, const uint8_t* straight, int w, int h, std::ptrdiff_t stride, int x, int y);
  int threads() const { return threads_; }
  /** The threads that draw, the calling thread included. */
  int thread_count() const { return workers_.size(); }
  int offscreen_mask_size() const { return offscreen_mask_size_; }
  const FrameStats& stats() const { return stats_; }

 private:
  /** An RGBA8 target, rows bottom to top as GL stores them (row 0 = window y 0). */
  struct Target {
    int width = 0, height = 0;
    Vector<uint8_t> rgba;
  };
  /** A mask buffer: the red channel only (the one read), one byte per pixel, rows bottom to top. */
  struct MaskBuffer {
    int size = 0;
    Vector<uint8_t> red;
  };
  /** Output space → mask buffer coordinates per axis (masks.ts MaskMapping). */
  struct MaskMap {
    double ox = 0, sx = 0, oy = 0, sy = 0;
  };
  struct Box {
    double x0 = 0, y0 = 0, w = 0, h = 0;
  };
  struct Group {
    Vector<int32_t> masks, members;
  };
  struct MaskSource {
    const MaskBuffer* buffer = nullptr;
    MaskMap map;
  };
  /** The uniforms of one draw (shaders.ts). */
  struct Draw;
  /** A polygon's span per row, [left, right) (the rasterizer's scratch). */
  struct Spans {
    Vector<int32_t> left, right;
  };
  /** One thread's share of a draw: its rows' scratch and the fragments it shaded (a cache line of its own). */
#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable : 4324)  // padded for its alignment, on purpose
#endif
  struct alignas(64) Lane {
    Spans spans;
    uint64_t fragments = 0;
  };
#ifdef _MSC_VER
#pragma warning(pop)
#endif
  /**
   * A vertex as the vertex shader leaves it: clip space, window pixels and
   * mask space; for a vertex inside the frustum also its snapped window y
   * (1/16 pixel, as the rasterizer snaps it).
   */
  struct Vert {
    float cx = 0, cy = 0, wx = 0, wy = 0, mx = 0, my = 0;
    int32_t sy = 0;
    bool inside = false;
  };
  /** The rows a set of vertices can cover: [lo, hi), the whole viewport when one lies outside the frustum. */
  struct Rows {
    int64_t lo = 0, hi = 0;
    float x_lo = 0, x_hi = 0;
  };
  /** A mask mesh of a mask build: its first vertex in mask_verts_, its vertex count and texture. */
  struct MaskMesh {
    int mesh = 0;
    std::size_t first = 0, count = 0;
    const Texture* texture = nullptr;
    bool cull = true;
  };
  struct LayerEntry {
    int target = 0;
    int offscreen = -1;
  };

  void group_masks(const Vector<Vector<int32_t>>& lists, Vector<Group>& groups, Vector<int32_t>& group_of) const;
  void draw_direct(Target& target);
  void draw_layered(const FrameOptions& frame, Target& target);
  void draw_mesh(int d, Target& target, bool layer);
  void composite(const Target& layer, Target& below, const Draw& draw);
  MaskSource drawable_mask(int g);
  MaskSource offscreen_mask(int g);
  void rasterize_masks(const Vector<int32_t>& masks, const MaskMap& map, const Box& box, MaskBuffer& buffer);
  int acquire_layer();
  void release_layer(int layer);
  /**
   * Runs f(lane, y0, y1) over [row0, row1) split into bands, one per thread,
   * when the work (about the pixels it touches) pays for the threads; else
   * once on this thread. Every row belongs to one band.
   */
  template <class F>
  void parallel_rows(int row0, int row1, double work, const F& f);
  /** A target cleared to one RGBA8 value, rows split over the threads. */
  void fill(Target& target, int width, int height, const uint8_t value[4]);

  std::shared_ptr<const moc::Model> model_;
  Vector<std::shared_ptr<const Texture>> textures_;
  /** Textures this renderer copied for an update (its own, so updated in place). */
  Vector<uint8_t> own_texture_;
  int mask_size_, offscreen_mask_size_;
  int threads_ = 1;
  bool layered_ = false;
  FrameStats stats_;
  /** Per drawable: stored UVs, output triangles, legacy or compatible blend (0 normal, 1 additive, 2 multiplicative). */
  Vector<Vector<uint16_t>> triangles_;
  /** Per drawable: its UVs as sampled (rule V). */
  Vector<Vector<float>> uvs_;
  Vector<uint8_t> blend_of_;
  Vector<Group> drawable_groups_, offscreen_groups_;
  Vector<int32_t> drawable_group_of_, offscreen_group_of_;
  Vector<Vector<int32_t>> offscreen_box_members_;
  MaskBuffer mask_, offscreen_mask_;
  int mask_holds_ = -1, offscreen_mask_holds_ = -1;
  Vector<int8_t> group_mapped_, offscreen_mapped_;
  Vector<Box> group_box_, offscreen_box_;
  Vector<MaskMap> group_map_, offscreen_map_;
  Vector<int32_t> order_;
  // Per frame.
  const eval::Instance* inst_ = nullptr;
  Framing framing_;
  const float* tints_ = nullptr;
  float view_[4] = {};
  /** The view matrix V of the frame (rule I), row-major float32. */
  std::array<float, 16> view_matrix_{};
  // Layers (layered pipeline) and the destination copy of advanced blends.
  Vector<Target> layers_;
  Vector<int> free_layers_;
  Target dst_copy_;
  /** The frame's target, kept from frame to frame. */
  Target target_;
  // Threads: the pool, one lane per thread, and the vertices of the draw or mask build at hand.
  Workers workers_;
  Vector<Lane> lanes_;
  Vector<Vert> verts_, mask_verts_;
  Vector<MaskMesh> mask_meshes_;
};

}  // namespace mochi2d::render

// The backend-neutral render interface (docs/design.md §8.10): what the core
// gives a GPU backend for one frame. Mochi2D's WebGL2 renderer
// (src/render/model/model-renderer.ts) decides, per frame, which mask
// buffers to build, which layers to open and close, and how each drawable
// and layer is drawn; `plan_frame` makes the same decisions and writes them
// as a list of operations in drawing order. A backend executes the list
// with its own textures, buffers and render targets, in the host's context
// and into the host's target: the library opens no window and owns no
// device.
//
// Everything a backend needs per draw is in the operation: the drawable or
// layer, the target, the blend (a fixed-function mode or an advanced code,
// with a copy of the destination first), the multiply and screen colors,
// the opacity (tints included) and the tint's color, the mask (which
// buffer, its mapping, inverted or not), and culling. Vertex positions come
// from the instance (`drawable_vertices`), UVs and triangles from the model
// (`RenderModel` keeps the output triangles), textures from the backend.
#pragma once

#include <array>
#include <cstdint>

#include "core/eval/instance.hpp"
#include "core/moc/model.hpp"
#include "render/renderer.hpp"
#include "util/alloc.hpp"

namespace mochi2d::render {

/** Groups of objects with the same set of mask meshes (masks.ts maskGroups). */
struct MaskGrouping {
  struct Group {
    /** Mask meshes in drawing order (the first member's list). */
    Vector<int32_t> masks;
    /** Masked objects in file order. */
    Vector<int32_t> members;
  };
  Vector<Group> groups;
  /** Group of each object, -1 without masks. */
  Vector<int32_t> group_of;
};
MaskGrouping mask_groups(const Vector<Vector<int32_t>>& lists);

/** What a renderer keeps of a model: computed once (the constructor of Mochi2D's ModelRenderer). */
struct RenderModel {
  explicit RenderModel(const moc::Model& model);
  /** §2h.1: offscreens, or a blend code the direct pipeline cannot draw. */
  bool layered = false;
  /** Per drawable, its fixed-function mode: 0 normal, 1 additive, 2 multiplicative. */
  Vector<uint8_t> blend_of;
  MaskGrouping drawable_groups, offscreen_groups;
  /** Per offscreen group: the drawables under its owners, whose box the group's mask uses (§2h.4). */
  Vector<Vector<int32_t>> offscreen_box_members;
  /** Per drawable: its output triangles (indices into its vertices). */
  Vector<Vector<uint16_t>> triangles;
  /** Per drawable: its UVs as the renderer samples them (rule V: v flipped twice in float32). */
  Vector<Vector<float>> uvs;
};

/** How a draw combines with its target. */
enum class BlendKind : uint8_t {
  /** Fixed-function blending: ONE, ONE_MINUS_SRC_ALPHA (and for alpha). */
  Normal,
  /** ONE, ONE; alpha ZERO, ONE. */
  Additive,
  /** DST_COLOR, ONE_MINUS_SRC_ALPHA; alpha ZERO, ONE. */
  Multiplicative,
  /** No blending: the shader computes the pixel from a copy of the destination (§2h.3). */
  Advanced,
};

/** The mask a draw samples (masks.ts MaskMapping into a buffer). */
struct MaskUse {
  /** -1 none, 0 the drawable mask buffer, 1 the offscreen mask buffer. */
  int8_t buffer = -1;
  bool inverted = false;
  /** The mapping: t = (x − ox)·sx, (y − oy)·sy. */
  double ox = 0, oy = 0, sx = 0, sy = 0;
  /**
   * The mapping as the shaders apply it (Mochi2D 0.18.0's rules M and I,
   * render/mask_matrix.hpp): rows 0 and 1 of a row-major 4 × 4 float32
   * matrix, applied as A·(x, y, 0, 1). DrawMesh: the texture matrix, from
   * output space (uMaskTex); Composite: D = A · V⁻¹, from the layer quad's
   * clip-space corners (uMaskTex); BuildMask: the clip matrix of the mask
   * buffer (uMaskClip).
   */
  std::array<float, 8> matrix{};
};

struct RenderOp {
  enum class Kind : uint8_t {
    /** Clear the frame's target to `color` (premultiplied; the whole target). */
    Clear,
    /**
     * Build a mask buffer: clear it to (1, 1, 1, 1) inside the scissor, then
     * for each mask mesh multiply red by 1 − α (colors masked to red; blend
     * ZERO, ONE_MINUS_SRC_ALPHA), with the mask mapping. The meshes are
     * `plan.mask_meshes[first, first + count)`; a mesh whose texture is
     * missing is skipped by the backend.
     */
    BuildMask,
    /** Open layer `layer` (a frame-sized target cleared to transparent black). */
    OpenLayer,
    /** Copy target `target` (a layer) into the destination copy that advanced draws read. */
    CopyDestination,
    /** Draw drawable `index` into `target`. */
    DrawMesh,
    /**
     * Composite layer `layer` into `target`: a quad over the viewport (a
     * triangle strip of 4 vertices), texture coordinates 0 to 1 across it,
     * the layer sampled with linear filtering (rule L); `index` is the
     * offscreen, or -1 for the model layer L₀ composited over the frame's
     * target. The layer is then free.
     */
    Composite,
  };
  Kind kind = Kind::Clear;
  /** Clear: the background (premultiplied RGBA). */
  std::array<double, 4> color{};
  /** BuildMask: the buffer (0 drawable, 1 offscreen), its size, the scissor (x, y, w, h), the mesh range. */
  int8_t buffer = 0;
  int32_t size = 0;
  std::array<int32_t, 4> scissor{};
  uint32_t first = 0, count = 0;
  /** The target: -1 the frame's target, k ≥ 0 layer k. */
  int32_t target = -1;
  /** DrawMesh: the drawable; Composite: the offscreen (-1: L₀). */
  int32_t index = -1;
  /** OpenLayer, Composite: the layer. */
  int32_t layer = 0;
  BlendKind blend = BlendKind::Normal;
  /** Advanced: the color function (code & 0xff) and the alpha mode (code >> 8). */
  int32_t color_fn = 0, alpha_mode = 0;
  /** Uniform values, as Mochi2D sets them (float32 in the shaders). */
  std::array<float, 3> multiply{1, 1, 1}, screen{0, 0, 0}, tint{1, 1, 1};
  float opacity = 1;
  MaskUse mask;
  /** DrawMesh: cull back faces (single-sided drawable). */
  bool cull = false;
};

/** One frame's operations, in drawing order. */
struct FramePlan {
  Framing framing;
  /** Output space → clip space: clip = (x·view[0] + view[2], y·view[1] + view[3]) (framing.ts clipTransform). */
  std::array<double, 4> view{};
  bool layered = false;
  Vector<RenderOp> ops;
  /** Mask meshes of the BuildMask operations. */
  Vector<int32_t> mask_meshes;
  /** Layers open at once at most (the layer indices are below it). */
  int32_t layers = 0;
  /** What Mochi2D's FrameStats would count. */
  FrameStats stats;
};

/**
 * Plans one frame of `instance` (its latest evaluation), as Mochi2D's
 * ModelRenderer draws it with per-drawable masks of `mask_size` (offscreen
 * masks `offscreen_mask_size`). `has_texture(t)` tells whether texture t
 * exists (a drawable whose texture is missing draws nothing).
 */
void plan_frame(const RenderModel& rm, const moc::Model& model, const eval::Instance& instance,
                const FrameOptions& frame, int mask_size, int offscreen_mask_size, const Vector<uint8_t>& has_texture,
                FramePlan& out);

}  // namespace mochi2d::render

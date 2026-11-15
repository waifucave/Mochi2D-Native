// A model instance: parameter values and part opacities in, drawable and
// offscreen state out (port of Mochi2D's src/core/eval/instance.ts with
// plan.ts, kernels.ts, warp-map.ts, binding.ts and render-order.ts;
// §1c). Every arithmetic step is a float32 operation, in the
// order of Mochi2D's evaluator.
//
// As in Mochi2D, static data comes from a per-model plan: compact keyform
// value arrays, exactly constant-folded properties, blend-shape steps that
// can change a value, and equal neighbouring channels evaluated once. By
// default the evaluation is incremental, as Mochi2D's: each band's corner
// tables are recomputed only when its bindings moved, and a deformer or a
// mesh's vertices only when its band, its blend shapes or its parent
// deformer changed (or changed while the mesh was inactive); glue runs only
// when its inputs changed. `incremental = false` evaluates everything on
// every call, with identical results. Either way the instance keeps the
// persistent state the results depend on: inactive drawables keep their
// last outputs, blend-shape contributions of inactive meshes and glue on
// inactive meshes accumulate (C4, C10, C29).
#pragma once

#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "core/moc/model.hpp"

namespace mochi2d::eval {

/**
 * A scalar property of one object (Mochi2D's plan.ts ScalarProp). Folding is
 * exact: a property is folded when every keyform value that can reach it is
 * the same float32 c and no blend-shape step can change it, and the folded
 * value is exact while at most `fold_active` bindings are off their keys
 * (any number for c = ±0, one for c = ±2^k with k ≥ 0, none otherwise).
 */
struct ScalarProp {
  /** Values at the object's normal keyforms, relative to its first keyform. */
  Vector<float> values;
  /** Blend-shape steps that can change the value, in order: positions in the object's binding list. */
  Vector<int32_t> blend_slots;
  /** Values at each kept binding's keys, the base key's taken as zero (S4). */
  Vector<Vector<float>> blend_values;
  /** The folded value, or NaN when the property is evaluated. */
  float constant = std::numeric_limits<float>::quiet_NaN();
  /** The folded value is exact while at most this many bindings are off their keys. */
  int32_t fold_active = -1;
  /** Equal to the object's previous property, so evaluated once (Mochi2D shares the object). */
  bool shared = false;
};

/** How an instance evaluates. */
struct InstanceOptions {
  /**
   * Skip work whose inputs did not change (default, as Mochi2D). False
   * re-evaluates everything on every call; results are identical.
   */
  bool incremental = true;
  /**
   * Evaluation stages to leave out (experimental, Mochi2D 0.21.0's
   * `evaluation`); both default to true, which gives the usual results bit
   * for bit. `glue = false` skips the glue pass, so glued meshes keep their
   * own positions; `blend_shapes = false` ignores every blend-shape keyform
   * binding, as if the file had none.
   */
  bool glue = true;
  bool blend_shapes = true;
};

/** One blend-shape binding of the evaluation, with its keyform position offsets. */
struct BlendPlan {
  const moc::BlendShapeBinding* binding = nullptr;
  /** Positions-pool offset of each key's keyform (warp / mesh targets); -1 for the base key. */
  Vector<int32_t> position_offsets;
};

class Instance {
 public:
  /** Builds an instance and evaluates it once with defaults (C4). */
  explicit Instance(std::shared_ptr<const moc::Model> model, const InstanceOptions& options = {});

  const moc::Model& model() const { return *model_; }
  std::shared_ptr<const moc::Model> model_ptr() const { return model_; }

  /** Index of the first parameter / part with this ID, or -1. */
  int parameter_index(const String& id) const;
  int part_index(const String& id) const;

  /** Sets a parameter; clamped unless it repeats (§1c.1). The value is rounded to float32. */
  void set_parameter(int index, double value);
  /** Sets a part opacity, clamped to [0, 1]. */
  void set_part_opacity(int index, double value);

  /** Runs the whole pipeline for the current inputs. */
  void evaluate();
  /** Whether evaluations skip unchanged work. */
  bool incremental() const { return incremental_; }

  /** The space of mapped points: model units as in drawable_vertices (y up unless canvas flag bit 0), or keyform space (y down). */
  enum class MapSpace { Model, Keyform };

  /**
   * The forward mapping (Mochi2D 0.5.0 mapPoints): maps `count` points (x, y
   * pairs) from deformer `deformer`'s input space through its world form at
   * the latest evaluation, with the evaluator's own float32 operations; -1 is
   * the identity. Returns false for a deformer out of range.
   */
  bool map_points(int deformer, const float* points, std::size_t count, float* out, MapSpace space = MapSpace::Model) const;
  /**
   * The 2×2 Jacobian of map_points at each point (∂x/∂px, ∂x/∂py, ∂y/∂px,
   * ∂y/∂py), analytic per region, in double.
   */
  bool map_jacobians(int deformer, const float* points, std::size_t count, double* out,
                     MapSpace space = MapSpace::Model) const;
  int deformer_count() const { return static_cast<int>(deformers_.size()); }

  // ---- inputs (as applied) ----
  Vector<float> parameter_values;
  Vector<float> part_opacities;

  // ---- outputs ----
  Vector<uint8_t> drawable_active, drawable_visible;
  Vector<float> drawable_opacity;
  Vector<int32_t> drawable_draw_order, drawable_render_order;
  /** RGB per drawable (clamped). */
  Vector<float> drawable_multiply, drawable_screen;
  /** Output-space vertices per drawable (y up unless canvas flag bit 0). */
  Vector<Vector<float>> drawable_vertices;
  /**
   * Per drawable, a counter that changes whenever an evaluation may have
   * written its vertex array. Equal counters mean equal vertices, so renderers
   * can skip uploading them again.
   */
  Vector<uint32_t> drawable_vertex_version;
  /**
   * A number no other instance of the process has had (a copy, or an
   * assignment, takes a new one): with `drawable_vertex_version`, what a GPU
   * backend keys its uploaded vertices on, since a new instance can take a
   * destroyed one's address.
   */
  struct Serial {
    Serial() : value(next()) {}
    Serial(const Serial&) : value(next()) {}
    Serial& operator=(const Serial&) {
      value = next();
      return *this;
    }
    uint64_t value;
    static uint64_t next();
  };
  Serial serial;
  /** How many times evaluate() ran (the creation-time evaluation included). */
  uint32_t evaluations = 0;
  /** What the latest evaluation recomputed (all of it without incremental evaluation). */
  struct Work {
    /** Deformers whose world form was recomputed. */
    uint32_t deformers = 0;
    /** Art meshes whose vertices were recomputed. */
    uint32_t meshes = 0;
    /** Whether glue ran. */
    bool glue = false;
  } last_work;
  Vector<float> offscreen_opacity;
  Vector<int32_t> offscreen_render_order;
  Vector<float> offscreen_multiply, offscreen_screen;
  Vector<uint8_t> part_active;
  Vector<int32_t> part_draw_order;
  Vector<uint8_t> deformer_active;

 private:
  struct DeformerPlan {
    int kind = 0;
    int band = 0;
    Vector<int32_t> blends;
    Vector<int32_t> position_offsets;
    /** Per normal keyform (warps): its run holds no −0, so 0 + Q = Q for every float. */
    Vector<uint8_t> plain_run;
    int grid_length = 0, rows = 0, columns = 0;
    bool bilinear = false;
    float base_angle = 0;
    int first_keyform = 0;
    /** opacity, multiply r g b, screen r g b, then (rotations) angle, origin x, origin y, scale. */
    Vector<ScalarProp> props;
  };
  struct MeshPlan {
    int band = 0;
    Vector<int32_t> blends;
    Vector<int32_t> position_offsets;
    Vector<uint8_t> plain_run;
    /** opacity, draw order, multiply r g b, screen r g b. */
    Vector<ScalarProp> props;
  };
  struct SimplePlan {
    int band = 0;
    Vector<int32_t> blends;
    Vector<ScalarProp> props;
  };
  struct OffscreenPlan {
    int owner = 0;
    int band = 0;
    Vector<int32_t> blends;
    Vector<int32_t> part_chain;
    /** opacity, multiply r g b, screen r g b. */
    Vector<ScalarProp> props;
  };

  void build_plan();
  void locate_bindings();
  /** S2's corner weights and offsets of a band, into W[0 … 2^active), O[0 … 2^active). */
  void corner_tables(int band, int active, float* W, int32_t* O) const;
  /** The corner tables of a band with more than 4 active bindings, cached per evaluation. */
  void big_tables(int band);
  float blend_shape_weight(const moc::BlendShapeBinding& b) const;
  bool blends_changed(const Vector<int32_t>& list) const;
  /** The corner tables of a band (its own, or the big ones). */
  void tables(int band, const float*& W, const int32_t*& O);
  float sum_interp(const Vector<float>& values, int band);
  float blend_step(int g, const Vector<float>& vals) const;
  /**
   * Evaluates the first `count` properties into pv_ (§1c.3 with S2, then
   * §1c.4 with S4): folded ones are copied while exact, a shared one copies
   * its predecessor, and property `draw_order_at` gets the draw-order formula.
   */
  void eval_props(const Vector<ScalarProp>& props, int count, int band, const Vector<int32_t>& blends,
                  int draw_order_at = -1, bool target = false);
  double draw_order(const ScalarProp& prop, int band, const Vector<int32_t>& blends, bool target);
  void interp_positions(const Vector<int32_t>& offsets, const Vector<uint8_t>& plain, int band, float* dst,
                        int length);
  void blend_positions(float* dst, int length, const Vector<int32_t>& blends) const;
  void map_through(int def, const float* src, float* dst, int count) const;
  void evaluate_parts();
  void evaluate_deformers();
  void evaluate_warp(int i, int parent);
  void evaluate_rotation(int i, int parent, const float* pv);
  void evaluate_meshes();
  void apply_glue();
  void convert_output();
  void evaluate_offscreens();
  void compute_render_order();
  void emit_group(int g, int& position);

  std::shared_ptr<const moc::Model> model_;
  bool incremental_ = true;
  /** Whether the glue pass runs (InstanceOptions::glue). */
  bool glue_on_ = true;
  /** Whether blend shapes apply (InstanceOptions::blend_shapes); the plan leaves them out otherwise. */
  bool blend_shapes_on_ = true;
  bool first_evaluation_ = true;
  bool has_colors_ = false;
  bool flip_output_ = false;
  HashMap<String, int> param_index_, part_index_;
  Vector<Vector<int32_t>> mesh_part_chain_;

  Vector<BlendPlan> blends_;
  Vector<DeformerPlan> deformers_;
  Vector<MeshPlan> meshes_;
  Vector<SimplePlan> parts_, glues_;
  Vector<OffscreenPlan> offscreens_;
  Vector<uint8_t> is_glued_;
  Vector<int32_t> glue_meshes_;
  Vector<int32_t> group_offscreen_;

  // ---- per-frame binding state ----
  Vector<float> eval_values_;
  Vector<int32_t> seg_index_;
  Vector<float> seg_t_;
  Vector<uint8_t> seg_out_of_range_, seg_changed_;
  Vector<int32_t> band_base_, band_active_;
  Vector<uint8_t> band_out_of_range_, band_changed_;
  /** Slots per band in band_stride_ / band_t_ (the most bindings of any band, at least 1). */
  std::size_t K_ = 1;
  /** Active (t ≠ 0) strides and t values, K_ per band, in band order. */
  Vector<int32_t> band_stride_;
  Vector<float> band_t_;
  /** Corner weights and keyform offsets, 16 per band, for up to 4 active bindings. */
  Vector<float> band_w_;
  Vector<int32_t> band_o_;
  /** The tables of one band with more than 4 active bindings, made on demand. */
  Vector<float> big_w_;
  Vector<int32_t> big_o_;
  int big_band_ = -1;
  uint32_t big_frame_ = 0, frame_ = 0;
  Vector<int32_t> blend_index_;
  Vector<float> blend_t_, blend_weight_;
  /** The weights of a blend shape's two keyforms in its segment. */
  Vector<float> blend_wa_, blend_wb_;
  Vector<uint8_t> blend_changed_;
  /** Blend-shape targets' own values are clamped (version 5 and later). */
  bool clamp_targets_ = false;
  /** Property values of the object being evaluated. */
  float pv_[16] = {};

  // ---- buffers ----
  Vector<Vector<float>> grids_;
  Vector<Vector<float>> local_;
  Vector<float> zeros_;
  /** Keyform positions read past the end of a list (NaN, as undefined in the reference). */
  Vector<float> nans_;
  /** Local vertices recomputed in this evaluation. */
  Vector<uint8_t> mesh_evaluated_;
  /** Inputs changed while the mesh was inactive: recompute when it is active again. */
  Vector<uint8_t> mesh_stale_;
  /** Activity of each mesh in the previous evaluation. */
  Vector<uint8_t> was_active_;

  // ---- deformer world forms ----
  Vector<uint8_t> deformer_dirty_;
  /** rot_c_ and rot_s_: C = f32(s_w·cos r) and S = f32(s_w·sin r), the rotation with its world scale. */
  Vector<float> deformer_opacity_, deformer_colors_, sigma_, rot_ox_, rot_oy_, rot_angle_, rot_scale_, rot_c_,
      rot_s_;
  Vector<uint8_t> rot_mirror_x_, rot_mirror_y_;
};

/** §1c.1: the value evaluation uses (clamped, or wrapped if repeating). */
float evaluation_value(float given, float min, float max, bool repeat);
/** §1c.1: the value reported after applying (clamped unless repeating). */
float applied_value(double given, float min, float max, bool repeat);

/**
 * Warp mapping W(u, v) (§1c.8) of `count` points from src to dst (src may
 * equal dst): cell interpolation inside the grid, the affine extension far
 * outside, triangle interpolation in the band between.
 */
void warp_points(const float* grid, int rows, int columns, bool bilinear, const float* src, float* dst, int count);
/** The scalar path of warp_points, which the SIMD path (when built) matches bit for bit. */
void warp_points_reference(const float* grid, int rows, int columns, bool bilinear, const float* src, float* dst,
                           int count);
/** True if warp_points runs four points at a time (SSE2). */
bool warp_points_simd();

/** Output UVs of a drawable (v replaced by 1 − v unless canvas flag bit 0). */
Vector<float> output_uvs(const moc::Model& m, int i);
/** Output triangle indices (winding reversed unless canvas flag bit 0). */
Vector<uint16_t> output_triangles(const moc::Model& m, int i);

}  // namespace mochi2d::eval

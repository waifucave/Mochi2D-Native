// The loaded model: the object graph of a `.moc3` file, validated so that
// evaluation cannot index out of range, loop or hang (port of Mochi2D's
// src/core/moc/model.ts, §1b.6–1b.7). Structure of arrays: every object
// kind is a set of parallel arrays.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "core/moc/data.hpp"

namespace mochi2d::moc {

constexpr int kWarpKind = 0;
constexpr int kRotationKind = 1;

struct BlendShapeConstraint {
  int32_t parameter = 0;
  Vector<float> keys;
  Vector<float> weights;
};

/** One blend-shape keyform binding attached to a target object (§1b.6.9, §1c.4). */
struct BlendShapeBinding {
  /** Owner parameter of the blend-shape parameter binding. */
  int32_t parameter = 0;
  Vector<float> keys;
  int32_t base_key = 0;
  /** First keyform, in the target kind's keyform array (one per key). */
  int32_t first_keyform = 0;
  /** Indices into Model::constraints. */
  Vector<int32_t> constraints;
};

struct Band {
  /** Parameter-binding indices, innermost (fastest-varying) first. */
  Vector<int32_t> bindings;
  /** Keyform strides per binding. */
  Vector<int32_t> strides;
  /** Product of key counts (1 for an empty band). */
  int32_t keyform_count = 1;
};

struct GroupObject {
  /** 0 = art mesh, 1 = part. */
  uint8_t kind = 0;
  int32_t index = 0;
  /** Nested group of a part object; -1 for art meshes. */
  int32_t nested_group = -1;
};

/** Keyform color indices: -1 means "no color" (v1–v3). */
struct ColorIndices {
  Vector<int32_t> multiply;
  Vector<int32_t> screen;
};

struct LoadOptions {
  /**
   * Keyform draw orders outside their group's range (C12, C25): false
   * (default) loads with one warning per object; true rejects the file.
   */
  bool reject_draw_order_range = false;
  /**
   * Keyform opacities that are NaN or ±∞ (warps, rotations, art meshes,
   * offscreens): false (default) rejects the file; true loads it, as the
   * official runtime does.
   */
  bool load_non_finite_opacity = false;
  /**
   * (v6) Part keyforms whose offscreen keyform entry is neither −1 nor an
   * offscreen keyform: false (default) rejects the file, as the official
   * check does; true loads it, reading such an entry as −1 (the offscreen's
   * opacity and colors 0), with a load warning (0.10.0's
   * offscreenKeyformRange "load").
   */
  bool load_offscreen_keyform_range = false;
};

struct Model {
  Vector<String> load_warnings;
  int version = 0;
  bool big_endian = false;
  Canvas canvas;

  struct {
    Vector<String> ids;
    Vector<float> min, max, defaults;
    Vector<uint8_t> repeat;
    /** 0 = normal, 1 = blend shape (always 0 before v4). */
    Vector<uint8_t> type;
    /** Reported key list (§1b.6.6). */
    Vector<Vector<float>> key_lists;
    Vector<int32_t> decimals;
  } parameters;
  struct {
    Vector<int32_t> parameter;
    Vector<Vector<float>> keys;
    /** ε = f32(10^−d) of the binding's parameter. */
    Vector<float> epsilon;
  } bindings;
  Vector<Band> bands;

  struct {
    Vector<String> ids;
    Vector<int32_t> band, first_keyform;
    Vector<float> initial_opacity;
    Vector<uint8_t> enabled;
    Vector<int32_t> parent;
    /** Offscreen owned by the part, -1 if none (v6). */
    Vector<int32_t> offscreen;
  } parts;
  struct {
    Vector<String> ids;
    Vector<int32_t> band;
    Vector<uint8_t> enabled;
    Vector<int32_t> part, parent;
    Vector<uint8_t> kind;
    Vector<int32_t> kind_index;
  } deformers;
  struct {
    Vector<int32_t> band, first_keyform, rows, columns;
    Vector<uint8_t> bilinear;
  } warps;
  struct {
    Vector<int32_t> band, first_keyform;
    Vector<float> base_angle;
  } rotations;
  struct {
    Vector<String> ids;
    Vector<int32_t> band, first_keyform;
    Vector<uint8_t> enabled;
    Vector<int32_t> part, deformer, texture;
    Vector<uint8_t> flags;
    /** v6 slot, or derived from the legacy flags before v6. */
    Vector<int32_t> blend_mode;
    Vector<int32_t> vertex_count;
    /** Stored UVs (v top-down), 2 floats per vertex. */
    Vector<Vector<float>> uvs;
    /** Stored triangle indices (file winding). */
    Vector<Vector<uint16_t>> triangles;
    /** Mask art-mesh indices, -1 entries removed. */
    Vector<Vector<int32_t>> masks;
  } meshes;
  struct {
    Vector<String> ids;
    Vector<int32_t> band, first_keyform, mesh_a, mesh_b;
    Vector<Vector<uint16_t>> vertex_a, vertex_b;
    Vector<Vector<float>> weight_a, weight_b;
  } glues;
  struct {
    Vector<Vector<GroupObject>> objects;
    Vector<int32_t> min_draw_order, max_draw_order, entry_count;
  } groups;
  struct {
    Vector<int32_t> part;
    Vector<uint8_t> flags;
    Vector<int32_t> blend_mode;
    Vector<Vector<int32_t>> masks;
  } offscreens;

  struct {
    Vector<float> part_draw_order;
    Vector<int32_t> part_offscreen_keyform;
    Vector<float> warp_opacity;
    Vector<int32_t> warp_first_position;
    ColorIndices warp_colors;
    Vector<float> rotation_opacity, rotation_angle, rotation_origin_x, rotation_origin_y, rotation_scale;
    Vector<uint8_t> rotation_mirror_x, rotation_mirror_y;
    ColorIndices rotation_colors;
    Vector<float> mesh_opacity, mesh_draw_order;
    Vector<int32_t> mesh_first_position;
    ColorIndices mesh_colors;
    Vector<float> offscreen_opacity;
    ColorIndices offscreen_colors;
    Vector<float> glue_intensity;
  } keyforms;
  Vector<float> positions;
  /** RGB triples. */
  Vector<float> multiply_colors, screen_colors;

  Vector<BlendShapeConstraint> constraints;
  struct {
    /** A part target's keyforms change the part's draw order only. */
    Vector<Vector<BlendShapeBinding>> warp, mesh, part, rotation, glue;
    /** (v6) Offscreen targets (count 37): their keyforms are offscreen keyforms and change its opacity and colors. */
    Vector<Vector<BlendShapeBinding>> offscreen;
  } blend_shapes;
};

/** Reads and validates a file (loadMoc). Returns false with an Error (code and message). */
bool load_moc(const uint8_t* bytes, std::size_t size, const LoadOptions& options, Model& out, Error& error);
/** Builds the model from read sections (buildModel). */
bool build_model(const Sections& sections, const LoadOptions& options, Model& out, Error& error);
/**
 * The model straight from MocData (mocModelFromData; it copies the data):
 * fails with `write_diagnostics` for data write_moc refuses (shape, or the
 * official level), and with `error` for data the loader rejects. Takes
 * version 6 data too.
 */
bool model_from_data(const MocData& data, int version, const LoadOptions& options, Model& out,
                     Vector<Diagnostic>& write_diagnostics, Error& error);
/** The loader's view of data, as a written file would give it (sectionsFromData). */
bool sections_from_data(const MocData& data, int version, Sections& out, Vector<Diagnostic>& diagnostics);

}  // namespace mochi2d::moc

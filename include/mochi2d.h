/*
 * Mochi2D Native: the C API.
 *
 * A portable runtime for models made with Live2D Cubism. This header
 * is the stable interface for bindings (C#, GDExtension, Unreal and others).
 *
 * Conventions
 * - Every function is safe to call with NULL handles: it returns an error
 *   code or a neutral value (0, NULL).
 * - No function throws: the library is built without C++ exceptions.
 * - There is no global state. Objects are independent: one model may back
 *   any number of instances, and different objects may be used from
 *   different threads at the same time. A single object must not be used
 *   from two threads at once, except that a model may be shared read-only
 *   by instances on different threads.
 * - Errors: functions that can fail return an m2d_status and, when `error`
 *   is not NULL, fill it with a stable code name and a message.
 * - Strings are UTF-8 and NUL-terminated. Returned pointers stay valid until
 *   the object that owns them is destroyed, or, for evaluation outputs,
 *   until the next m2d_instance_evaluate.
 * - Strings the library allocates for the caller (JSON reports) are freed
 *   with m2d_free_string, into the allocator they came from.
 * - Memory: every object is created with an allocator (m2d_allocator, NULL
 *   for malloc and free), which everything created from it inherits.
 *
 * - Floating point: results are bit for bit those of Mochi2D (the web
 *   runtime) on every platform; the library sets its own floating-point
 *   flags, so it does not depend on the host's.
 *
 * Contents: validation and loading of `.moc3` files, model instances and
 * their evaluation, the forward mapping, and the framework: model settings,
 * motions, expressions, physics, poses, sounds, user data, display info,
 * motion sync and the animator, which runs the frame procedure (motions, eye
 * blink, expressions, look, breath, physics, lip sync, motion sync, pose)
 * and hands its values to an instance; packages; the reference renderer.
 */
#ifndef MOCHI2D_H
#define MOCHI2D_H

#include <stddef.h>
#include <stdint.h>

#if defined(M2D_STATIC)
#define M2D_API
#elif defined(_WIN32)
#if defined(M2D_BUILDING)
#define M2D_API __declspec(dllexport)
#else
#define M2D_API __declspec(dllimport)
#endif
#else
#define M2D_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------ basics */

/** The library version as 0x00MMmmpp (major, minor, patch). */
M2D_API uint32_t m2d_version(void);

typedef enum m2d_status {
  M2D_OK = 0,
  /** A NULL pointer, an index out of range or an unknown option. */
  M2D_INVALID_ARGUMENT = 1,
  /** The data is not a valid `.moc3` file (the error code says why). */
  M2D_FORMAT_ERROR = 2,
  M2D_OUT_OF_MEMORY = 3,
  /** Anything else (should not happen). */
  M2D_INTERNAL_ERROR = 4,
  /**
   * A framework file (settings, motion, expression, physics, pose, sound,
   * user data, display info) cannot be used; the message says why, as
   * Mochi2D words it.
   */
  M2D_FILE_ERROR = 5,
  /**
   * An animator frame stopped where Mochi2D raises an error: the random
   * sequence ran out ("random-exhausted") or gave a number outside [0, 1)
   * ("random-range"), or a physics file cannot run ("type-error": a setting
   * without vertices, or an output vertex index that is not an integer).
   */
  M2D_FRAME_ERROR = 6
} m2d_status;

typedef struct m2d_error {
  m2d_status status;
  /** A stable code, for example "magic", "section-bounds" or "invalid" (docs). */
  char code[32];
  char message[480];
} m2d_error;

/** Frees a string returned by the library. NULL is ignored. */
M2D_API void m2d_free_string(char* s);

/**
 * A host allocator. `allocate` returns `size` bytes aligned to `alignment` (a
 * power of two) or NULL; `deallocate` frees them (size and alignment as
 * allocated). `user` is passed to both.
 *
 * An allocator is given when an object is created (m2d_model_load,
 * m2d_validate_moc, …); NULL means malloc and free. Every heap allocation for
 * the object and everything created from it (an instance inherits its
 * model's allocator) goes through it, strings included. The structure is
 * copied: it need not outlive the call, but its functions and `user` must
 * stay valid as long as the objects live.
 *
 * Threads: objects with different allocators never share memory; an
 * object's allocator is called from whichever thread uses the object.
 */
typedef struct m2d_allocator {
  void* (*allocate)(size_t size, size_t alignment, void* user);
  void (*deallocate)(void* p, size_t size, size_t alignment, void* user);
  void* user;
} m2d_allocator;

/* ------------------------------------------------------------- validation */

typedef enum m2d_level {
  /** What the official consistency check rejects. */
  M2D_LEVEL_OFFICIAL = 0,
  /** Everything the loader rejects, plus warnings. */
  M2D_LEVEL_STRICT = 1
} m2d_level;

/**
 * Validates `.moc3` bytes. Sets *valid to 1 when there are no errors at the
 * level, and, when `report_json` is not NULL, stores a JSON report
 * {"valid", "version", "diagnostics": [{code, severity, kind, index?,
 * field?, message}]} to be freed with m2d_free_string.
 */
M2D_API m2d_status m2d_validate_moc(const void* bytes, size_t size, m2d_level level, const m2d_allocator* allocator,
                                    int32_t* valid, char** report_json, m2d_error* error);

/* ------------------------------------------------------------------ models */

typedef struct m2d_model m2d_model;

/** Load flags. */
enum {
  /** Reject files whose keyform draw orders lie outside their group's range. */
  M2D_LOAD_STRICT_DRAW_ORDERS = 1,
  /** Load keyform opacities that are NaN or infinite (rejected by default). */
  M2D_LOAD_NON_FINITE_OPACITY = 2,
  /**
   * (v6) Load part keyforms whose offscreen keyform entry is neither −1 nor
   * an offscreen keyform, reading it as −1 (the offscreen's opacity and
   * colors 0), with a load warning; rejected by default, as the official
   * check does (Mochi2D 0.10.0's offscreenKeyformRange "load").
   */
  M2D_LOAD_OFFSCREEN_KEYFORM_RANGE = 4
};

/** Loads and validates `.moc3` bytes (copied; the caller keeps its buffer). */
M2D_API m2d_status m2d_model_load(const void* bytes, size_t size, uint32_t flags, const m2d_allocator* allocator,
                                  m2d_model** out, m2d_error* error);
/** Destroys a model. Instances created from it keep it alive until they are destroyed. */
M2D_API void m2d_model_destroy(m2d_model* model);

/** File version (1–6). */
M2D_API int32_t m2d_model_file_version(const m2d_model* model);
/** Canvas: width, height, origin x, origin y (model units) and pixels per unit. */
M2D_API m2d_status m2d_model_canvas(const m2d_model* model, float out[5], uint32_t* flags);
/** Warnings of the load (for example draw orders outside their group's range). */
M2D_API int32_t m2d_model_warning_count(const m2d_model* model);
M2D_API const char* m2d_model_warning(const m2d_model* model, int32_t index);

M2D_API int32_t m2d_model_parameter_count(const m2d_model* model);
M2D_API const char* m2d_model_parameter_id(const m2d_model* model, int32_t index);
/** min, max, default. */
M2D_API m2d_status m2d_model_parameter_range(const m2d_model* model, int32_t index, float out[3]);
/** 1 if the parameter repeats, 0 if not; type 0 = normal, 1 = blend shape. */
M2D_API int32_t m2d_model_parameter_repeats(const m2d_model* model, int32_t index);
M2D_API int32_t m2d_model_parameter_type(const m2d_model* model, int32_t index);
/** The first parameter with this ID, or -1. */
M2D_API int32_t m2d_model_parameter_index(const m2d_model* model, const char* id);

M2D_API int32_t m2d_model_part_count(const m2d_model* model);
M2D_API const char* m2d_model_part_id(const m2d_model* model, int32_t index);
M2D_API int32_t m2d_model_part_parent(const m2d_model* model, int32_t index);
M2D_API int32_t m2d_model_part_index(const m2d_model* model, const char* id);

/** Drawables (art meshes): static data. */
M2D_API int32_t m2d_model_drawable_count(const m2d_model* model);
M2D_API const char* m2d_model_drawable_id(const m2d_model* model, int32_t index);
M2D_API int32_t m2d_model_drawable_index(const m2d_model* model, const char* id);
M2D_API int32_t m2d_model_drawable_texture(const m2d_model* model, int32_t index);
/** Blend mode: 0 normal, 1 additive, 2 multiplicative (and the v6 values). */
M2D_API int32_t m2d_model_drawable_blend_mode(const m2d_model* model, int32_t index);
/** Constant flags byte of the file (bit 2: double-sided, bit 3: inverted mask). */
M2D_API uint32_t m2d_model_drawable_flags(const m2d_model* model, int32_t index);
M2D_API int32_t m2d_model_drawable_vertex_count(const m2d_model* model, int32_t index);
/** Output UVs, 2 floats per vertex (v already flipped for y-up output). */
M2D_API const float* m2d_model_drawable_uvs(const m2d_model* model, int32_t index);
/** The UVs as stored: 2 floats per vertex, (0, 0) the texture image's top-left (GPU backends sample with these). */
M2D_API const float* m2d_model_drawable_texture_uvs(const m2d_model* model, int32_t index);
M2D_API int32_t m2d_model_drawable_index_count(const m2d_model* model, int32_t index);
/** Output triangle indices (winding already adjusted for y-up output). */
M2D_API const uint16_t* m2d_model_drawable_indices(const m2d_model* model, int32_t index);
M2D_API int32_t m2d_model_drawable_mask_count(const m2d_model* model, int32_t index);
M2D_API const int32_t* m2d_model_drawable_masks(const m2d_model* model, int32_t index);

/** Offscreens (version 6). */
M2D_API int32_t m2d_model_offscreen_count(const m2d_model* model);
M2D_API int32_t m2d_model_offscreen_owner(const m2d_model* model, int32_t index);

/* --------------------------------------------------------------- instances */

typedef struct m2d_instance m2d_instance;

/** Creates an instance (evaluated once with defaults), with its model's allocator. */
M2D_API m2d_status m2d_instance_create(m2d_model* model, m2d_instance** out, m2d_error* error);

/** How an instance evaluates (m2d_instance_create_with_options). */
typedef struct m2d_instance_options {
  /** 0 evaluates everything on every call instead of only what changed; the results are the same. Default 1. */
  int32_t incremental;
  /**
   * Experimental (Mochi2D 0.21.0's `evaluation.glue`): 0 skips the glue
   * pass, so glued meshes keep their own positions. Default 1.
   */
  int32_t glue;
  /**
   * Experimental (Mochi2D 0.21.0's `evaluation.blendShapes`): 0 ignores
   * every blend-shape keyform binding, as if the file had none. Default 1.
   * With glue and blend_shapes both 1, results are those of
   * m2d_instance_create, bit for bit.
   */
  int32_t blend_shapes;
} m2d_instance_options;

M2D_API void m2d_instance_options_default(m2d_instance_options* options);
/** m2d_instance_create with options; NULL options are the defaults. */
M2D_API m2d_status m2d_instance_create_with_options(m2d_model* model, const m2d_instance_options* options,
                                                   m2d_instance** out, m2d_error* error);
M2D_API void m2d_instance_destroy(m2d_instance* instance);

/** Sets a parameter (clamped unless it repeats) and reads it back as applied. */
M2D_API m2d_status m2d_instance_set_parameter(m2d_instance* instance, int32_t index, float value);
M2D_API float m2d_instance_parameter(const m2d_instance* instance, int32_t index);
/** Sets a part opacity, clamped to [0, 1]. */
M2D_API m2d_status m2d_instance_set_part_opacity(m2d_instance* instance, int32_t index, float value);
M2D_API float m2d_instance_part_opacity(const m2d_instance* instance, int32_t index);

/** Evaluates the model for the current inputs. */
M2D_API m2d_status m2d_instance_evaluate(m2d_instance* instance, m2d_error* error);

/** Draw data of the last evaluation. */
M2D_API int32_t m2d_instance_drawable_visible(const m2d_instance* instance, int32_t index);
M2D_API float m2d_instance_drawable_opacity(const m2d_instance* instance, int32_t index);
M2D_API int32_t m2d_instance_drawable_draw_order(const m2d_instance* instance, int32_t index);
M2D_API int32_t m2d_instance_drawable_render_order(const m2d_instance* instance, int32_t index);
/** Multiply and screen colors (r, g, b). */
M2D_API m2d_status m2d_instance_drawable_colors(const m2d_instance* instance, int32_t index, float multiply[3],
                                               float screen[3]);
/** Output vertices, 2 floats per vertex (model units, y up unless canvas flag bit 0). */
M2D_API const float* m2d_instance_drawable_vertices(const m2d_instance* instance, int32_t index);
M2D_API float m2d_instance_offscreen_opacity(const m2d_instance* instance, int32_t index);
M2D_API int32_t m2d_instance_offscreen_render_order(const m2d_instance* instance, int32_t index);
M2D_API m2d_status m2d_instance_offscreen_colors(const m2d_instance* instance, int32_t index, float multiply[3],
                                                float screen[3]);

/** A drawable's evaluated state, as one plain struct. */
typedef struct m2d_drawable_state {
  int32_t visible;
  float opacity;
  int32_t draw_order;
  int32_t render_order;
  float multiply[3];
  float screen[3];
} m2d_drawable_state;

M2D_API m2d_status m2d_instance_drawable_state(const m2d_instance* instance, int32_t index, m2d_drawable_state* out);

/**
 * Copies a drawable's output vertices into a caller-owned buffer of
 * `capacity` floats (2 per vertex). Sets *written to the floats copied;
 * M2D_INVALID_ARGUMENT when the buffer is too small.
 */
M2D_API m2d_status m2d_instance_copy_drawable_vertices(const m2d_instance* instance, int32_t index, float* out,
                                                       size_t capacity, size_t* written);

/*
 * Changed vertices, for GPU backends and bindings (docs/bindings.md §6):
 * every evaluation that may write a drawable's vertices changes its
 * version, and equal versions mean equal vertices. An instance's serial is
 * a number no other instance of the process has had (a new instance can
 * take a destroyed one's address), so a cache is keyed on both.
 */
M2D_API uint64_t m2d_instance_serial(const m2d_instance* instance);
M2D_API uint32_t m2d_instance_drawable_vertex_version(const m2d_instance* instance, int32_t index);
/** The model's vertex layout: all drawables' vertices one after another, drawable i from its offset (in vertices). */
M2D_API int64_t m2d_model_vertex_total(const m2d_model* model);
M2D_API int64_t m2d_model_drawable_vertex_offset(const m2d_model* model, int32_t index);

/** What a caller's vertex buffer holds: the instance and each drawable's version it was copied from. */
typedef struct m2d_vertex_sync {
  /** sizeof(m2d_vertex_sync), set by the caller. */
  uint32_t size;
  /** m2d_model_drawable_count entries, the caller's memory (any values at first). */
  int32_t version_count;
  uint32_t* versions;
  /** The instance last copied (0: none; a different serial copies everything). */
  uint64_t serial;
} m2d_vertex_sync;

/**
 * Copies the vertices of the drawables that changed since the last call
 * with `sync` (all of them for another instance) into `out`, in the
 * model's vertex layout (2·m2d_model_vertex_total floats), and updates
 * `sync`. `changed` (NULL, or room for every drawable) receives the
 * indices copied, in order; *changed_count their number.
 */
M2D_API m2d_status m2d_instance_copy_changed_vertices(const m2d_instance* instance, m2d_vertex_sync* sync, float* out,
                                                      size_t capacity, int32_t* changed, int32_t* changed_count);

/*
 * Tints (Mochi2D 0.7.0's setTint; not reference behavior): an application
 * RGBA per art mesh, kept until cleared, and part of the draw data.
 * Evaluation does not change them. A renderer multiplies the mesh's color,
 * after its multiply and screen colors, by r, g and b (1 changes nothing,
 * below darkens, above 1, up to 2, brightens: Mochi2D 0.14.0, the drawn
 * color then limited to white), and its opacity by a; masks are drawn as
 * without tints.
 *
 * m2d_instance_set_tint: `count` is 3 (r, g, b, with a = 1) or 4. r, g and b
 * are limited to [0, 2] (M2D_MAX_TINT), a to [0, 1], and stored as float32. M2D_INVALID_ARGUMENT for another
 * count or a value that is not finite (Mochi2D's RangeErrors), or an index out
 * of range (Mochi2D returns false); nothing changes then.
 */
#define M2D_MAX_TINT 2
M2D_API m2d_status m2d_instance_set_tint(m2d_instance* instance, int32_t index, const double* rgba, int32_t count);
/** Removes a drawable's tint: 1, or 0 for an index out of range or a drawable without one. */
M2D_API int32_t m2d_instance_clear_tint(m2d_instance* instance, int32_t index);
M2D_API void m2d_instance_clear_tints(m2d_instance* instance);
/** A drawable's tint (r, g, b, a): 1, or 0 without one (`out` is left as it is). */
M2D_API int32_t m2d_instance_tint(const m2d_instance* instance, int32_t index, float out[4]);
/** The tinted drawables in index order: their number, and the k-th one's index (-1 out of range). */
M2D_API int32_t m2d_instance_tint_count(const m2d_instance* instance);
M2D_API int32_t m2d_instance_tinted_drawable(const m2d_instance* instance, int32_t k);
/**
 * RGBA per drawable, 4 floats each (1 without a tint), or NULL while no tint
 * is set: renderers then skip tinting.
 */
M2D_API const float* m2d_instance_drawable_tints(const m2d_instance* instance);
/** Changes whenever a tint changes, so a view knows to draw again. */
M2D_API uint32_t m2d_instance_tint_version(const m2d_instance* instance);

/* -------------------------------------------------------- forward mapping */

/** Deformers (static data): count and IDs; index -1 means no deformer. */
M2D_API int32_t m2d_model_deformer_count(const m2d_model* model);
M2D_API const char* m2d_model_deformer_id(const m2d_model* model, int32_t index);
M2D_API int32_t m2d_model_drawable_deformer(const m2d_model* model, int32_t index);

typedef enum m2d_space {
  /** Model units as in m2d_instance_drawable_vertices (y up unless canvas flag bit 0). */
  M2D_SPACE_MODEL = 0,
  /** The space of keyform positions (y down). */
  M2D_SPACE_KEYFORM = 1
} m2d_space;

/**
 * Maps `count` points (x, y pairs) from a deformer's input space through its
 * world form at the last evaluation, bit for bit as vertices are mapped;
 * deformer -1 is the identity. `out` (caller-owned) holds 2·count floats and
 * may equal `points`.
 */
M2D_API m2d_status m2d_instance_map_points(const m2d_instance* instance, int32_t deformer, const float* points,
                                           size_t count, m2d_space space, float* out);
/** The 2×2 Jacobian at each point (∂x/∂px, ∂x/∂py, ∂y/∂px, ∂y/∂py): 4·count doubles. */
M2D_API m2d_status m2d_instance_map_jacobians(const m2d_instance* instance, int32_t deformer, const float* points,
                                              size_t count, m2d_space space, double* out);

/**
 * The instance's state as a `mochi2d-result/0` style JSON object (canvas,
 * parameters, parts, drawables, offscreens), to be freed with m2d_free_string.
 */
M2D_API char* m2d_instance_snapshot_json(const m2d_instance* instance);

/**
 * Hit testing (3t): the inclusive bounding box of a drawable's output
 * vertices at the last evaluation as x min, x max, y min, y max (a drawable
 * without vertices gives +inf, -inf, +inf, -inf), and whether (x, y) lies in
 * it. Visibility does not matter.
 */
M2D_API m2d_status m2d_instance_drawable_bounds(const m2d_instance* instance, int32_t index, double out[4]);
M2D_API int32_t m2d_instance_hit_test(const m2d_instance* instance, int32_t index, double x, double y);

/* ================================================================ framework
 *
 * The framework reads the files that come with a model and animates it.
 * Every file object is parsed from bytes (UTF-8 JSON, a byte-order mark
 * allowed; WAV for sounds) with an allocator, is immutable afterwards, and
 * may be shared by any number of animators: an animator keeps what it uses
 * alive, so a file object may be destroyed while an animator still plays it.
 * `label` (NULL: a default) names the file in messages, as Mochi2D does: use
 * the file's path. Paths in the settings are relative to the settings file;
 * the library reads no files itself.
 */

/* --------------------------------------------------------------- settings */

typedef struct m2d_settings m2d_settings;

/** Parses a model settings file (`*.model3.json`). */
M2D_API m2d_status m2d_settings_parse(const void* bytes, size_t size, const char* label,
                                      const m2d_allocator* allocator, m2d_settings** out, m2d_error* error);
M2D_API void m2d_settings_destroy(m2d_settings* settings);

/** The `.moc3` path. */
M2D_API const char* m2d_settings_moc(const m2d_settings* settings);
M2D_API int32_t m2d_settings_texture_count(const m2d_settings* settings);
M2D_API const char* m2d_settings_texture(const m2d_settings* settings, int32_t index);

typedef enum m2d_file_kind {
  M2D_SETTINGS_PHYSICS = 0,
  M2D_SETTINGS_POSE = 1,
  M2D_SETTINGS_USER_DATA = 2,
  M2D_SETTINGS_DISPLAY_INFO = 3,
  /** The motion-sync file (`*.motionsync3.json`; see m2d_motion_sync_parse). */
  M2D_SETTINGS_MOTION_SYNC = 4
} m2d_file_kind;

/** The path of an optional file, or NULL when the settings name none. */
M2D_API const char* m2d_settings_file(const m2d_settings* settings, m2d_file_kind which);

/** Named expressions, in file order. */
M2D_API int32_t m2d_settings_expression_count(const m2d_settings* settings);
M2D_API const char* m2d_settings_expression_name(const m2d_settings* settings, int32_t index);
M2D_API const char* m2d_settings_expression_file(const m2d_settings* settings, int32_t index);

/** Motion groups, in the order Mochi2D reads them (integer-like names first). */
M2D_API int32_t m2d_settings_motion_group_count(const m2d_settings* settings);
M2D_API const char* m2d_settings_motion_group_name(const m2d_settings* settings, int32_t group);
/** The first group with this name, or -1. */
M2D_API int32_t m2d_settings_motion_group_index(const m2d_settings* settings, const char* name);
M2D_API int32_t m2d_settings_motion_count(const m2d_settings* settings, int32_t group);

/** One entry of a motion group (3b.2). */
typedef struct m2d_motion_entry {
  const char* file;
  /** A WAV file to start with the motion, or NULL. */
  const char* sound;
  /** Fade-time overrides (used only when ≥ 0); NaN when the entry has none. */
  double fade_in;
  double fade_out;
  /** The motion-sync setting for the sound (a dictionary name or setting ID), or NULL. */
  const char* motion_sync;
} m2d_motion_entry;

M2D_API m2d_status m2d_settings_motion(const m2d_settings* settings, int32_t group, int32_t index,
                                       m2d_motion_entry* out);

/** IDs of the first parameter group with this name ("EyeBlink", "LipSync"); none when there is none. */
M2D_API int32_t m2d_settings_group_id_count(const m2d_settings* settings, const char* name);
M2D_API const char* m2d_settings_group_id(const m2d_settings* settings, const char* name, int32_t index);

/** Named hit areas: an art-mesh ID and a name. */
M2D_API int32_t m2d_settings_hit_area_count(const m2d_settings* settings);
M2D_API const char* m2d_settings_hit_area_id(const m2d_settings* settings, int32_t index);
M2D_API const char* m2d_settings_hit_area_name(const m2d_settings* settings, int32_t index);

/** A layout value ("width", "center_x", …): 1 and *value when the settings give it, else 0. */
M2D_API int32_t m2d_settings_layout(const m2d_settings* settings, const char* key, double* value);

/* --------------------------------------------- motions, expressions, sounds */

typedef struct m2d_motion m2d_motion;

/** Parses a motion file (`*.motion3.json`); M2D_FILE_ERROR when it fails validation (3c.4). */
M2D_API m2d_status m2d_motion_parse(const void* bytes, size_t size, const char* label, const m2d_allocator* allocator,
                                    m2d_motion** out, m2d_error* error);
M2D_API void m2d_motion_destroy(m2d_motion* motion);
M2D_API double m2d_motion_duration(const m2d_motion* motion);
M2D_API double m2d_motion_fps(const m2d_motion* motion);
/** The file's fade times (missing or negative: 1). */
M2D_API double m2d_motion_fade_in(const m2d_motion* motion);
M2D_API double m2d_motion_fade_out(const m2d_motion* motion);
/** Curves that take effect, and curves left out by the order rule of 3c.2. */
M2D_API int32_t m2d_motion_curve_count(const m2d_motion* motion);
M2D_API int32_t m2d_motion_ignored_curve_count(const m2d_motion* motion);
/** User-data events: time and value. */
M2D_API int32_t m2d_motion_event_count(const m2d_motion* motion);
M2D_API double m2d_motion_event_time(const m2d_motion* motion, int32_t index);
M2D_API const char* m2d_motion_event_value(const m2d_motion* motion, int32_t index);

typedef struct m2d_expression m2d_expression;

/** Parses an expression file (`*.exp3.json`); the label identifies it among expression layers. */
M2D_API m2d_status m2d_expression_parse(const void* bytes, size_t size, const char* label,
                                        const m2d_allocator* allocator, m2d_expression** out, m2d_error* error);
M2D_API void m2d_expression_destroy(m2d_expression* expression);
M2D_API const char* m2d_expression_label(const m2d_expression* expression);
M2D_API double m2d_expression_fade_in(const m2d_expression* expression);
M2D_API double m2d_expression_fade_out(const m2d_expression* expression);
M2D_API int32_t m2d_expression_parameter_count(const m2d_expression* expression);

typedef struct m2d_sound m2d_sound;

/**
 * Decodes a WAV file for lip sync (3s.1): linear PCM, 8-bit unsigned or
 * 16/24-bit signed samples, any channel count and rate (other sample sizes
 * load as silence).
 */
M2D_API m2d_status m2d_sound_decode(const void* bytes, size_t size, const m2d_allocator* allocator, m2d_sound** out,
                                    m2d_error* error);
M2D_API void m2d_sound_destroy(m2d_sound* sound);
M2D_API int32_t m2d_sound_channels(const m2d_sound* sound);
M2D_API double m2d_sound_sample_rate(const m2d_sound* sound);
M2D_API int32_t m2d_sound_bits_per_sample(const m2d_sound* sound);
/** Samples per channel. */
M2D_API double m2d_sound_frames(const m2d_sound* sound);

/* ------------------------------------------------------------ physics, pose */

typedef struct m2d_physics m2d_physics;

/** Parses a physics file (`*.physics3.json`); M2D_FILE_ERROR when its Meta totals disagree with it (3e.1). */
M2D_API m2d_status m2d_physics_parse(const void* bytes, size_t size, const char* label, const m2d_allocator* allocator,
                                     m2d_physics** out, m2d_error* error);
M2D_API void m2d_physics_destroy(m2d_physics* physics);
/** The internal rate (0: one step per frame). */
M2D_API double m2d_physics_fps(const m2d_physics* physics);
M2D_API int32_t m2d_physics_setting_count(const m2d_physics* physics);
M2D_API const char* m2d_physics_setting_id(const m2d_physics* physics, int32_t index);
/** The display name of a setting (`Meta.PhysicsDictionary`), or NULL. */
M2D_API const char* m2d_physics_setting_name(const m2d_physics* physics, int32_t index);

typedef struct m2d_pose m2d_pose;

/** Parses a pose file (`*.pose3.json`). */
M2D_API m2d_status m2d_pose_parse(const void* bytes, size_t size, const char* label, const m2d_allocator* allocator,
                                  m2d_pose** out, m2d_error* error);
M2D_API void m2d_pose_destroy(m2d_pose* pose);
M2D_API double m2d_pose_fade(const m2d_pose* pose);
M2D_API int32_t m2d_pose_group_count(const m2d_pose* pose);

/* ------------------------------------------------- user data, display info */

typedef struct m2d_user_data m2d_user_data;

/** Parses a user data file (`*.userdata3.json`, 3h). */
M2D_API m2d_status m2d_user_data_parse(const void* bytes, size_t size, const char* label,
                                       const m2d_allocator* allocator, m2d_user_data** out, m2d_error* error);
M2D_API void m2d_user_data_destroy(m2d_user_data* data);
M2D_API int32_t m2d_user_data_count(const m2d_user_data* data);
/** An entry: its target ("ArtMesh", …), ID and value. */
M2D_API const char* m2d_user_data_target(const m2d_user_data* data, int32_t index);
M2D_API const char* m2d_user_data_id(const m2d_user_data* data, int32_t index);
M2D_API const char* m2d_user_data_value(const m2d_user_data* data, int32_t index);

typedef struct m2d_display_info m2d_display_info;

/** Parses a display info file (`*.cdi3.json`, 3i). Playback never reads it. */
M2D_API m2d_status m2d_display_info_parse(const void* bytes, size_t size, const char* label,
                                          const m2d_allocator* allocator, m2d_display_info** out, m2d_error* error);
M2D_API void m2d_display_info_destroy(m2d_display_info* info);

typedef enum m2d_display_kind { M2D_DISPLAY_PARAMETERS = 0, M2D_DISPLAY_PARTS = 1 } m2d_display_kind;

/**
 * Display labels for a model's parameters or parts (answer B3): count, and
 * row `row` in display order (top level first, then groups in file order,
 * model order inside each; parts in model order): the model index, the
 * label (the name, or the ID when there is none) and the group name (NULL at
 * the top level). `info` may be NULL: every label is the ID.
 */
M2D_API int32_t m2d_display_label_count(const m2d_model* model, m2d_display_kind kind);
M2D_API m2d_status m2d_display_label(const m2d_display_info* info, const m2d_model* model, m2d_display_kind kind,
                                     int32_t row, int32_t* index, const char** label, const char** group);

/* ---------------------------------------------------------------- animator */

typedef struct m2d_animator m2d_animator;

/** The components of the frame procedure (3w.1). */
typedef enum m2d_effect {
  /** Idle playback (see m2d_animator_set_idle_motions). */
  M2D_EFFECT_IDLE = 0,
  M2D_EFFECT_EYE_BLINK = 1,
  M2D_EFFECT_EXPRESSIONS = 2,
  M2D_EFFECT_LOOK = 3,
  M2D_EFFECT_BREATH = 4,
  M2D_EFFECT_PHYSICS = 5,
  M2D_EFFECT_LIP_SYNC = 6,
  M2D_EFFECT_POSE = 7,
  /** Motion sync (see m2d_animator_set_motion_sync; not reference behavior). */
  M2D_EFFECT_MOTION_SYNC = 8
} m2d_effect;

typedef struct m2d_animator_options {
  /** Wrap mode for repeating parameters (3g.2); default 0. */
  int32_t wrap;
  /** Run the physics settle procedure (3n.8) once at creation; default 0. */
  int32_t settle;
  /** Physics gravity and wind (3n.2); defaults (0, -1) and (0, 0). */
  double gravity[2];
  double wind[2];
  /** Eye-blink timing (3p): interval, closing, closed, opening; default 4, 0.1, 0.05, 0.15. */
  double blink_timing[4];
  /**
   * The random sequence of eye blink and idle playback (3v.2): stores a
   * number in [0, 1) and returns 1, or returns 0 when there is none (the
   * frame then fails with "random-exhausted"). NULL: a built-in generator
   * with a fixed seed (Mochi2D uses Math.random).
   */
  int32_t (*random)(double* out, void* user);
  void* random_user;
  /**
   * Mochi2D's runtime option `lipSyncFallback` (not reference behavior): when
   * the settings list no LipSync parameters (no group, or one with no IDs),
   * lip sync and the motions' LipSync curves drive this parameter, if the
   * model has it. Default "ParamMouthOpenY", as Mochi2D's runtime; NULL: none.
   * The string is copied.
   */
  const char* lip_sync_fallback;
} m2d_animator_options;

/** Fills the defaults. */
M2D_API void m2d_animator_options_default(m2d_animator_options* options);
/** The parameter the lip-sync fallback drives (see m2d_animator_options), or NULL when it does not apply. */
M2D_API const char* m2d_animator_lip_sync_fallback(const m2d_animator* animator);

/**
 * Creates an animator for a model with its allocator. `settings` gives the
 * EyeBlink and LipSync parameter groups (NULL: none, so no eye blink and no
 * lip sync); `physics` and `pose` are optional (NULL: none); `options` NULL
 * takes the defaults. The animator keeps the model and the files alive.
 * Effects that are present start switched on (idle playback starts off).
 */
M2D_API m2d_status m2d_animator_create(m2d_model* model, const m2d_settings* settings, const m2d_physics* physics,
                                       const m2d_pose* pose, const m2d_animator_options* options, m2d_animator** out,
                                       m2d_error* error);
M2D_API void m2d_animator_destroy(m2d_animator* animator);

/** What a frame did. */
typedef struct m2d_frame {
  /** The motion queue advanced (a motion played). */
  int32_t motion_updated;
  /** The motion queue is empty after the frame. */
  int32_t queue_empty;
  /** The lip-sync value of the frame (NaN for a frame that covered no sample); 0 in has_lip_sync when it did not run. */
  int32_t has_lip_sync;
  double lip_sync;
  /** Events fired and motions that ended in this frame (see m2d_animator_event, m2d_animator_end). */
  int32_t event_count;
  int32_t end_count;
} m2d_frame;

/**
 * One frame of the procedure (3j steps 1–4) with step `dt` seconds: restore
 * the base values, motions, eye blink, expressions, look, breath, physics,
 * lip sync, motion sync and pose (motion sync before physics as an
 * option). M2D_FRAME_ERROR when Mochi2D would raise an error; the frame is
 * then incomplete.
 */
M2D_API m2d_status m2d_animator_frame(m2d_animator* animator, double dt, m2d_frame* out, m2d_error* error);
/** Hands the parameter values and part opacities of the latest frame to an instance (step 5's input). */
M2D_API m2d_status m2d_animator_apply(const m2d_animator* animator, m2d_instance* instance);
/** m2d_animator_frame, then m2d_animator_apply and m2d_instance_evaluate. */
M2D_API m2d_status m2d_animator_update(m2d_animator* animator, m2d_instance* instance, double dt, m2d_frame* out,
                                       m2d_error* error);

/** The events of the latest frame, in order. */
M2D_API const char* m2d_animator_event(const m2d_animator* animator, int32_t index);

typedef enum m2d_motion_end_reason {
  M2D_MOTION_FINISHED = 0,
  /** Another start made it fade out. */
  M2D_MOTION_REPLACED = 1,
  M2D_MOTION_STOPPED = 2
} m2d_motion_end_reason;

/** A motion that ended in the latest frame: the ticket of its start and why. */
M2D_API m2d_status m2d_animator_end(const m2d_animator* animator, int32_t index, uint32_t* ticket,
                                    m2d_motion_end_reason* reason);

/** How a motion starts (3l.1). m2d_motion_start_default fills the defaults. */
typedef struct m2d_motion_start {
  /** 0 none, 1 idle, 2 normal (default), 3 force (3l.4). */
  double priority;
  /** Fade times: NaN (default) for the file's; a negative value also gives the file's. */
  double fade_in;
  double fade_out;
  /** Default 1. */
  double weight;
  /** Seconds into the motion; default 0. */
  double offset;
  /** Default 0. */
  int32_t loop;
  /** Each loop fades in anew; default 1. */
  int32_t loop_fade_in;
  /** The legacy loop of 3l.5; default 0. */
  int32_t legacy_loop;
  /** Hold the last frame (not Mochi2D's reference behavior; ignored with loop); default 0. */
  int32_t hold;
  /** With hold: eye blink may run while the motion stays at its end; default 1. */
  int32_t blink_while_held;
} m2d_motion_start;

M2D_API void m2d_motion_start_default(m2d_motion_start* start);

/**
 * Starts a motion (3l.4); returns 1 when it was accepted (the priority is 3
 * or above the current one), else 0. With `sound` not NULL, lip sync starts
 * on it when the motion is accepted. For an entry of a settings motion
 * group, pass the entry's fade times in `start` (when the caller has none of
 * its own), as Mochi2D does, and when the entry names a sound that cannot be
 * loaded, pass m2d_sound_unusable() (lip sync stops on acceptance);
 * m2d_package_group_motion resolves an entry this way. `start` NULL takes the
 * defaults.
 */
M2D_API int32_t m2d_animator_start_motion(m2d_animator* animator, const m2d_motion* motion,
                                          const m2d_motion_start* start, const m2d_sound* sound);
/** Whether a start with this priority would be accepted. */
M2D_API int32_t m2d_animator_accepts(const m2d_animator* animator, double priority);
M2D_API void m2d_animator_stop_motions(m2d_animator* animator);
/** Motions in the queue, and the ticket of the latest accepted start (1, 2, …). */
M2D_API int32_t m2d_animator_motion_count(const m2d_animator* animator);
M2D_API uint32_t m2d_animator_last_ticket(const m2d_animator* animator);

/** One motion of idle playback, as resolved by the caller from the settings' Idle group. */
typedef struct m2d_idle_motion {
  /** NULL for a file that failed validation: its starts fail, as in Mochi2D. */
  const m2d_motion* motion;
  /** The entry's sound, or NULL; m2d_sound_unusable() for a sound that cannot be used. */
  const m2d_sound* sound;
  /** The entry's fade times, NaN for none. */
  double fade_in;
  double fade_out;
} m2d_idle_motion;

/**
 * Sets the motions of idle playback (3l.7: while the queue is empty, a
 * random one starts with priority 1), copied; a count of 0 removes them.
 * Idle playback is switched on when the list is not empty, and off when it is.
 */
M2D_API m2d_status m2d_animator_set_idle_motions(m2d_animator* animator, const m2d_idle_motion* motions,
                                                 int32_t count);

/** Starts an expression in the expression queue (3m). */
M2D_API m2d_status m2d_animator_start_expression(m2d_animator* animator, const m2d_expression* expression);
/**
 * Expression layers on top of the queue, several at once (not reference
 * behavior): adds one (returns 0 when an active layer has its label), or
 * fades out the active layers with a label (NULL: every one; returns how many).
 */
M2D_API int32_t m2d_animator_add_expression_layer(m2d_animator* animator, const m2d_expression* expression);
M2D_API int32_t m2d_animator_remove_expression_layers(m2d_animator* animator, const char* label);

/*
 * Expression fade times per call (Mochi2D 0.13.0; not reference behavior):
 * seconds that replace the file's for that call, NaN for the file's; each
 * finite and ≥ 0 (M2D_INVALID_ARGUMENT, or −1 / 0 for the int-returning
 * ones, otherwise). An added layer keeps the fade-out it was given for its
 * removal, unless the removal gives one.
 */
M2D_API m2d_status m2d_animator_start_expression_fades(m2d_animator* animator, const m2d_expression* expression,
                                                       double fade_in, double fade_out);
/**
 * Fades the queue's expressions out: starts an empty expression with the
 * newest one's fade-out time, or `fade_out` seconds (NaN: the newest's).
 * Nothing when the queue is empty.
 */
M2D_API m2d_status m2d_animator_clear_expression(m2d_animator* animator, double fade_out);
/** As m2d_animator_add_expression_layer with the call's fade times (−1 for a bad time). */
M2D_API int32_t m2d_animator_add_expression_layer_fades(m2d_animator* animator, const m2d_expression* expression,
                                                        double fade_in, double fade_out);
/** As m2d_animator_remove_expression_layers over `fade_out` seconds (NaN: each layer's own). */
M2D_API int32_t m2d_animator_remove_expression_layers_fade(m2d_animator* animator, const char* label,
                                                           double fade_out);

/** The look target (3r), in [-1, 1] by convention. */
M2D_API void m2d_animator_set_look_target(m2d_animator* animator, double x, double y);

/**
 * A sound that names a file which cannot be used: wherever a sound is
 * given, it stops lip sync instead of starting it (Mochi2D's null sound), as
 * m2d_package_group_motion gives for such an entry. Never destroyed.
 */
M2D_API const m2d_sound* m2d_sound_unusable(void);

/** Starts lip sync on a sound (NULL stops it). M2D_INVALID_ARGUMENT when there is no lip sync. */
M2D_API m2d_status m2d_animator_start_sound(m2d_animator* animator, const m2d_sound* sound);

typedef enum m2d_lip_sync_mix {
  /** Adds the live value to the lip-sync parameters (default). */
  M2D_LIP_SYNC_ADD = 0,
  /** Writes the live value instead. */
  M2D_LIP_SYNC_REPLACE = 1,
  /** Writes the larger of the two. */
  M2D_LIP_SYNC_MAX = 2,
  /** Writes what `mix` returns (a non-finite result leaves the parameter as it is). */
  M2D_LIP_SYNC_FUNCTION = 3
} m2d_lip_sync_mix;

/**
 * A live lip-sync input such as a microphone (not reference behavior):
 * `next` returns the value of a frame of `dt` seconds (≥ 0), applied after a
 * playing sound by `mode`. `next` NULL removes the input. M2D_INVALID_ARGUMENT
 * when there is no lip sync.
 */
M2D_API m2d_status m2d_animator_set_live_lip_sync(m2d_animator* animator, double (*next)(double dt, void* user),
                                                  m2d_lip_sync_mix mode,
                                                  double (*mix)(double live, double current, const char* id,
                                                                void* user),
                                                  void* user);

/* ------------------------------------------------------------- live input
 *
 * Lip sync from live audio, such as a microphone (Mochi2D's LiveLipSync; not
 * reference behavior): the host gives the samples, and the library measures
 * them as Mochi2D does, so that every engine moves the mouth the same way.
 * Per frame: the RMS of the samples pushed since the previous frame (all
 * channels pooled, 3s.2's measure), then a noise gate g (an RMS level in
 * dBFS: max(0, rms − g)), a gain, and one step of attack/release smoothing
 * over the samples' duration, so the result does not depend on the frame
 * rate. A frame without samples keeps the previous value; after 0.1 s
 * without samples, frames count as silence (the mouth closes with the
 * release time). Samples older than the window (0.25 s) are dropped.
 *
 * Threads: the push functions may run on an audio thread while frames run
 * on another; everything else belongs to the frames' thread.
 */

typedef struct m2d_live_input m2d_live_input;

typedef struct m2d_live_input_settings {
  /** The sensitivity: multiplies the gated RMS (default 12). */
  double gain;
  /** The noise gate, an RMS level in dBFS (default −45; a full-scale sine is −3); −INFINITY: none. */
  double gate;
  /** Attack and release time constants in seconds (defaults 0.03 and 0.12); 0: at once. */
  double attack;
  double release;
} m2d_live_input_settings;

/** Mochi2D's defaults, chosen for speech at arm's length with voice processing on. */
M2D_API void m2d_live_input_settings_default(m2d_live_input_settings* settings);
/** No gate, gain or smoothing: the value is the 3s.2 RMS. */
M2D_API void m2d_live_input_settings_neutral(m2d_live_input_settings* settings);
/** An RMS level in dBFS as a linear amplitude (−∞ gives 0), as Mochi2D computes it. */
M2D_API double m2d_dbfs_to_amplitude(double db);

/**
 * Creates a live input for samples at `sample_rate` (frames per second).
 * `settings` NULL takes the defaults; `max_window` ≤ 0 takes 0.25 s.
 */
M2D_API m2d_status m2d_live_input_create(double sample_rate, const m2d_live_input_settings* settings,
                                         double max_window, const m2d_allocator* allocator, m2d_live_input** out);
/** Destroys the handle; an animator it is attached to keeps the input until detached. */
M2D_API void m2d_live_input_destroy(m2d_live_input* input);
/** The settings: changes apply from the next frame. */
M2D_API void m2d_live_input_set_settings(m2d_live_input* input, const m2d_live_input_settings* settings);
M2D_API void m2d_live_input_get_settings(const m2d_live_input* input, m2d_live_input_settings* out);
/** The pushed samples' rate; set it before pushing. */
M2D_API void m2d_live_input_set_sample_rate(m2d_live_input* input, double sample_rate);
/** A block of `frames` float samples per channel (in [−1, 1]): one array per channel. */
M2D_API void m2d_live_input_push(m2d_live_input* input, const float* const* channels, int32_t channel_count,
                                 size_t frames);
/** The same, interleaved (frame by frame); the result is that of the planar form. */
M2D_API void m2d_live_input_push_interleaved(m2d_live_input* input, const float* samples, int32_t channel_count,
                                             size_t frames);
/**
 * A block given by the sum of its squared values, its number of values
 * (channels × frames) and its number of frames, for hosts that measure
 * blocks themselves. Blocks with no frame, no value or a negative or NaN sum
 * are ignored.
 */
M2D_API void m2d_live_input_push_sums(m2d_live_input* input, double sum_squares, double values, double frames);
/** Seconds of samples waiting for the next frame. */
M2D_API double m2d_live_input_pending(const m2d_live_input* input);
/**
 * Takes this frame's value (≥ 0) from the samples pushed since the previous
 * frame. An animator with the input attached calls it in each frame; call it
 * only for an input that is not attached.
 */
M2D_API double m2d_live_input_next(m2d_live_input* input, double dt);
/** The RMS of the latest frame's samples (the input level, for a meter), and its value. */
M2D_API double m2d_live_input_level(const m2d_live_input* input);
M2D_API double m2d_live_input_value(const m2d_live_input* input);
/** Clears the pending samples and the value. */
M2D_API void m2d_live_input_reset(m2d_live_input* input);

/**
 * Attaches a live input as the animator's live lip sync (as
 * m2d_animator_set_live_lip_sync does with a callback, which it replaces):
 * each frame takes its value, applied after a playing sound by `mode`. NULL
 * detaches it. M2D_INVALID_ARGUMENT when there is no lip sync.
 */
M2D_API m2d_status m2d_animator_set_live_input(m2d_animator* animator, m2d_live_input* input, m2d_lip_sync_mix mode,
                                               double (*mix)(double live, double current, const char* id, void* user),
                                               void* user);

/**
 * Parameters (Mochi2D's setParameter, getParameter and getParameterBase).
 * Each frame starts from the parameters' base values, applies the motions
 * (whose results the frame keeps in the base values, so they stay after a
 * motion ends), then expressions and effects (eye blink, breath, look,
 * physics, lip sync) on top.
 *
 * m2d_animator_set_parameter sets a parameter's base value (a viewer slider,
 * tracking): it persists like a motion's result, and effects apply on top;
 * it shows from the next frame (a frame with dt 0 applies it at once).
 * M2D_INVALID_ARGUMENT for an unknown ID. m2d_animator_parameter reads its
 * value in the latest frame, effects included: what is drawn (until the next
 * frame, a base value just set reads back as set). An ID the model lacks
 * reads its free value (0 unless something wrote it).
 * m2d_animator_parameter_base reads the base value: what set_parameter set,
 * or what motions left in it; an ID the model lacks reads as in
 * m2d_animator_parameter. An editor shows and restores base values (restoring
 * one from m2d_animator_parameter would add an effect such as breath twice).
 */
M2D_API m2d_status m2d_animator_set_parameter(m2d_animator* animator, const char* id, double value);
M2D_API double m2d_animator_parameter(const m2d_animator* animator, const char* id);
M2D_API double m2d_animator_parameter_base(const m2d_animator* animator, const char* id);
M2D_API m2d_status m2d_animator_set_parameter_at(m2d_animator* animator, int32_t index, double value);
/** Sets every base value back to the parameter's default. */
M2D_API void m2d_animator_reset_parameters(m2d_animator* animator);
/** The values of the latest frame: one float per model parameter, one per part, and the model opacity. */
M2D_API const float* m2d_animator_parameter_values(const m2d_animator* animator);
/** The base values: one float per model parameter. */
M2D_API const float* m2d_animator_parameter_base_values(const m2d_animator* animator);

/**
 * Idle weights (Mochi2D 0.7.0's setIdleWeight; not reference behavior): how
 * far the idle animation moves a parameter, in [0, 1]. The idle animation is
 * every motion started at priority 1: idle playback, and starts with
 * priority 1. Where such a motion would move the parameter by f of the way
 * from its value v to its curve value c, it moves it by f·w, to
 * v + (c − v)·f·w, stored as float32. At 0 the parameter keeps its base value
 * (so tracking written with m2d_animator_set_parameter shows through); at 1,
 * the default, the motion applies bit for bit as without weights. Other
 * motions, expressions, effects and part-opacity curves are not affected.
 * Change the weight over a few frames to fade a handover. Weights are limited
 * to [0, 1]; M2D_INVALID_ARGUMENT for NaN (Mochi2D's RangeError) or an
 * unknown ID (Mochi2D returns false).
 */
M2D_API m2d_status m2d_animator_set_idle_weight(m2d_animator* animator, const char* id, double weight);
/** A parameter's idle weight: 1 unless set. */
M2D_API double m2d_animator_idle_weight(const m2d_animator* animator, const char* id);
/** Every idle weight back to 1. */
M2D_API void m2d_animator_reset_idle_weights(m2d_animator* animator);

/*
 * Physics at runtime (Mochi2D 0.8.0; not reference behavior, except at
 * strength 1). Each physics output moves its parameter from c, its value
 * before the output is written, to r, the value the physics file's rule
 * gives; with a strength k it becomes c + (r − c)·k instead: 0 leaves the
 * parameters as with physics off, 1 (the default) is the reference bit for
 * bit, and above 1 exaggerates within each parameter's range. The
 * simulation itself runs unchanged, so changing the strength never makes the
 * pendulums jump. The model's strength multiplies each setting's own.
 * Strengths and the wind are kept without a physics file too.
 */
/** The physics settings in file order: their count, and each one's ID and display name (its dictionary entry, or the ID). */
M2D_API int32_t m2d_animator_physics_setting_count(const m2d_animator* animator);
M2D_API const char* m2d_animator_physics_setting_id(const m2d_animator* animator, int32_t index);
M2D_API const char* m2d_animator_physics_setting_name(const m2d_animator* animator, int32_t index);
/** The model's physics strength; negative values are limited to 0, NaN and ±∞ are M2D_INVALID_ARGUMENT. */
M2D_API m2d_status m2d_animator_set_physics_strength(m2d_animator* animator, double strength);
/** The model's physics strength: 1 unless set. */
M2D_API double m2d_animator_physics_strength(const m2d_animator* animator);
/**
 * One physics setting's strength, by its ID: it multiplies the model's for
 * that setting's outputs. Negative values are limited to 0;
 * M2D_INVALID_ARGUMENT for NaN, ±∞ or an ID no setting has (Mochi2D returns
 * false).
 */
M2D_API m2d_status m2d_animator_set_physics_setting_strength(m2d_animator* animator, const char* id, double strength);
/** A setting's strength: 1 unless set. */
M2D_API double m2d_animator_physics_setting_strength(const m2d_animator* animator, const char* id);
/** The model's strength and every setting's back to 1. */
M2D_API void m2d_animator_reset_physics_strengths(m2d_animator* animator);
/**
 * The physics wind V (3n.2), read at every physics step: a change takes
 * effect from the next one. Non-finite values are M2D_INVALID_ARGUMENT.
 */
M2D_API m2d_status m2d_animator_set_physics_wind(m2d_animator* animator, double x, double y);
/** The physics wind: the creation option's (default (0, 0)) unless set. */
M2D_API void m2d_animator_physics_wind(const m2d_animator* animator, double* x, double* y);
/**
 * How much of the wind one physics setting feels, by its ID (Mochi2D
 * 0.13.0's setPhysicsSettingWind; not reference behavior): its pendulum
 * particles get the wind V times `multiplier`, at every step and when
 * settling. 1, the default, is the reference bit for bit; 0 shields the
 * setting; a negative multiplier turns the wind around. The wind is a
 * force, so the pendulums respond over the next steps. M2D_INVALID_ARGUMENT
 * for a non-finite multiplier or an ID no setting has (Mochi2D returns false).
 */
M2D_API m2d_status m2d_animator_set_physics_setting_wind(m2d_animator* animator, const char* id, double multiplier);
/** A setting's wind multiplier: 1 unless set. */
M2D_API double m2d_animator_physics_setting_wind(const m2d_animator* animator, const char* id);
/** Every setting's wind multiplier back to 1 (the wind itself stays). */
M2D_API void m2d_animator_reset_physics_setting_winds(m2d_animator* animator);
/**
 * In frames that take no time (dt ≤ 0), write the last physics outputs again,
 * so physics-driven parameters keep their physics values (Mochi2D's
 * holdPhysicsInZeroSteps, for paused views). Default off: the reference
 * writes none.
 */
M2D_API void m2d_animator_set_physics_hold(m2d_animator* animator, int32_t on);

/**
 * The physics rate (Mochi2D 0.10.0's setPhysicsRate; not reference
 * behavior): the pendulums advance in steps of 1/rate seconds instead of the
 * physics file's Fps, and with 0 step once per frame, by the frame's length.
 * From 0 to 1000 steps per second (else M2D_INVALID_ARGUMENT).
 */
M2D_API m2d_status m2d_animator_set_physics_rate(m2d_animator* animator, double steps_per_second);
/** Back to the physics file's Fps. */
M2D_API void m2d_animator_reset_physics_rate(m2d_animator* animator);
/** The rate in use: the one set, or the file's Fps (0: once per frame); without physics the one set, or 0. */
M2D_API double m2d_animator_physics_rate(const m2d_animator* animator);

/**
 * Physics state (Mochi2D 0.10.0's savePhysicsState and restorePhysicsState),
 * for timeline scrubbing: every particle's position, velocity and gravity
 * direction, every output's last two values, the step accumulator, the
 * interpolation factor and the input copy of the parameter values, as bytes.
 * Restored, the next frame continues exactly as the frame after the save
 * did, bit for bit, given the same parameter values, frame lengths and
 * options (gravity, wind, strengths and rate are not part of the state).
 * The bytes are for this library, on machines of the same byte order.
 *
 * The size of the animator's physics state, in bytes (0 without physics).
 */
M2D_API size_t m2d_animator_physics_state_size(const m2d_animator* animator);
/**
 * Copies the physics state into `out` (`capacity` bytes, at least
 * m2d_animator_physics_state_size); `written` gets its size.
 * M2D_INVALID_ARGUMENT without physics or with too little room.
 */
M2D_API m2d_status m2d_animator_save_physics_state(const m2d_animator* animator, void* out, size_t capacity,
                                                   size_t* written);
/**
 * Puts the physics simulation back in a saved state; the parameters it drives
 * show the restored pose from the next frame. M2D_INVALID_ARGUMENT without
 * physics (code "no-physics") or for bytes that are not a state of these
 * physics settings (code "physics-state").
 */
M2D_API m2d_status m2d_animator_restore_physics_state(m2d_animator* animator, const void* state, size_t size,
                                                      m2d_error* error);
M2D_API const float* m2d_animator_part_opacities(const m2d_animator* animator);
M2D_API double m2d_animator_model_opacity(const m2d_animator* animator);

/** Part opacities persist from frame to frame; an ID the model lacks gets a free entry (used by poses). */
M2D_API void m2d_animator_set_part_opacity(m2d_animator* animator, const char* id, double value);
M2D_API double m2d_animator_part_opacity(const m2d_animator* animator, const char* id);

/** Switches a component on or off; m2d_animator_has_effect tells whether it is present at all. */
M2D_API m2d_status m2d_animator_set_effect(m2d_animator* animator, m2d_effect effect, int32_t on);
M2D_API int32_t m2d_animator_effect(const m2d_animator* animator, m2d_effect effect);
M2D_API int32_t m2d_animator_has_effect(const m2d_animator* animator, m2d_effect effect);

/* ------------------------------------------------------------- motion sync
 *
 * Motion sync moves the mouth with a sound through a setting of the model's
 * `.motionsync3.json` file: each setting names the mouth parameters it
 * drives, the shape each audio element gives them (Silence and the vowels
 * A, I, U, E, O), and how the result is blended and smoothed. The file, its
 * links from the settings and the processing around the analysis follow
 * Mochi2D; the analysis that tells
 * which element a sound is at each tick is Mochi2D's own, bit for bit: the
 * mouth shapes follow Mochi2D's analysis.
 *
 * The host hands over the samples, of a sound with its playback clock or of
 * live audio; the library opens no device. Each frame, the bound setting
 * analyzes at most once (`SampleRate` ticks a second): the window's level
 * and voicing, its spectrum against vowel templates (a voice profile's, or
 * a neutral synthetic voice's), then `Enabled`, `Scale`, the blend, the
 * shape and a non-linear smoothing set by `Smoothing`, then each
 * parameter's `Damper` (and its `Smooth`, with the option file_smoothing,
 * off by default as in Mochi2D 0.20.0); the values are written after lip sync
 * and before pose (or before physics as an option). A sound plays once:
 * when it ends, the mouth is fed silence until it is within `Damper` of the
 * Silence shape, or for 0.5 s, and then motion sync stops writing.
 */

typedef struct m2d_motion_sync m2d_motion_sync;

/** The audio elements, in their usual order. */
typedef enum m2d_motion_sync_element_id {
  M2D_ELEMENT_SILENCE = 0,
  M2D_ELEMENT_A = 1,
  M2D_ELEMENT_I = 2,
  M2D_ELEMENT_U = 3,
  M2D_ELEMENT_E = 4,
  M2D_ELEMENT_O = 5
} m2d_motion_sync_element_id;

/** m2d_motion_sync_parse flag: also warn about keys the format does not define. */
#define M2D_MOTION_SYNC_LINT 1u

/**
 * Parses a motion-sync file. The reader is lenient, as Mochi2D's: a missing
 * or ill-typed value gives a default (0, "", an empty list, false) with a
 * warning, and values are limited to their ranges with a warning (`Scale`
 * [0.1, 10], `BlendRatio` [0, 1], `Smooth` [0, 100], `Smoothing` read as an
 * integer and limited to [1, 100], `SampleRate` [1, 120] or 60 when not
 * positive). A setting whose `AnalysisType` is not the one editor-made
 * files name is kept, unusable. M2D_FILE_ERROR only for invalid JSON or a
 * top level that is not an object.
 */
M2D_API m2d_status m2d_motion_sync_parse(const void* bytes, size_t size, const char* label, uint32_t flags,
                                         const m2d_allocator* allocator, m2d_motion_sync** out, m2d_error* error);
M2D_API void m2d_motion_sync_destroy(m2d_motion_sync* file);
M2D_API const char* m2d_motion_sync_label(const m2d_motion_sync* file);
/** `Version` as read (1 expected; others are read as version 1). */
M2D_API double m2d_motion_sync_version(const m2d_motion_sync* file);
/** What was missing, ill-typed, out of range or not recognized, one line each, as Mochi2D words it. */
M2D_API int32_t m2d_motion_sync_warning_count(const m2d_motion_sync* file);
M2D_API const char* m2d_motion_sync_warning(const m2d_motion_sync* file, int32_t index);
/** Settings, in file order. */
M2D_API int32_t m2d_motion_sync_setting_count(const m2d_motion_sync* file);
/** The setting a motion entry names: the first with this dictionary name, else with this ID; -1 for none. */
M2D_API int32_t m2d_motion_sync_find_setting(const m2d_motion_sync* file, const char* ref);

typedef struct m2d_motion_sync_setting {
  const char* id;
  /** The dictionary name, which motion entries use. */
  const char* name;
  const char* analysis_type;
  const char* use_case;
  /** 0 when the analysis type is not recognized: the setting never runs. */
  int32_t usable;
  int32_t parameter_count;
  int32_t element_count;
  double blend_ratio;
  double smoothing;
  /** Analysis ticks per second. */
  double sample_rate;
} m2d_motion_sync_setting;

typedef struct m2d_motion_sync_parameter {
  const char* id;
  const char* name;
  /** The range the author saw (not used to drive the parameter). */
  double min;
  double max;
  /** The dead band (≥ 0) and the smoothing weight in percent. */
  double damper;
  double smooth;
} m2d_motion_sync_parameter;

typedef struct m2d_motion_sync_element {
  const char* id;
  const char* name;
  double min;
  double max;
  double scale;
  int32_t enabled;
  /** 1 for Silence, A, I, U, E and O; other elements get weight 0. */
  int32_t known;
} m2d_motion_sync_element;

M2D_API m2d_status m2d_motion_sync_get_setting(const m2d_motion_sync* file, int32_t setting,
                                               m2d_motion_sync_setting* out);
M2D_API m2d_status m2d_motion_sync_get_parameter(const m2d_motion_sync* file, int32_t setting, int32_t index,
                                                 m2d_motion_sync_parameter* out);
M2D_API m2d_status m2d_motion_sync_get_element(const m2d_motion_sync* file, int32_t setting, int32_t index,
                                               m2d_motion_sync_element* out);
/** Element `element`'s value for driven parameter `parameter` (its shape); NaN out of range. */
M2D_API double m2d_motion_sync_shape(const m2d_motion_sync* file, int32_t setting, int32_t element,
                                     int32_t parameter);

typedef struct m2d_motion_sync_sound m2d_motion_sync_sound;

/**
 * A sound for motion sync from the host's samples: `channel_count` arrays
 * of `frames` samples in [-1, 1] at `sample_rate` (1000 to 1000000 Hz),
 * copied; the analysis signal (mono, 16 kHz) is made at once.
 */
M2D_API m2d_status m2d_motion_sync_sound_create(const float* const* channels, int32_t channel_count, size_t frames,
                                                double sample_rate, const m2d_allocator* allocator,
                                                m2d_motion_sync_sound** out);
/**
 * A helper: decodes a WAV file for motion sync (Mochi2D's
 * decodeMotionSyncWav): linear PCM with 8-bit unsigned or 16-, 24- or 32-bit
 * signed samples, 32- or 64-bit float samples, also in the extensible
 * format; any channel count. M2D_FILE_ERROR with Mochi2D's message.
 */
M2D_API m2d_status m2d_motion_sync_sound_decode(const void* bytes, size_t size, const m2d_allocator* allocator,
                                                m2d_motion_sync_sound** out, m2d_error* error);
M2D_API void m2d_motion_sync_sound_destroy(m2d_motion_sync_sound* sound);
M2D_API int32_t m2d_motion_sync_sound_channels(const m2d_motion_sync_sound* sound);
M2D_API size_t m2d_motion_sync_sound_frames(const m2d_motion_sync_sound* sound);
M2D_API double m2d_motion_sync_sound_sample_rate(const m2d_motion_sync_sound* sound);
/** A channel's samples (for playback). */
M2D_API const float* m2d_motion_sync_sound_samples(const m2d_motion_sync_sound* sound, int32_t channel);

typedef struct m2d_motion_sync_input m2d_motion_sync_input;

/**
 * A live input (a microphone, a stream) of mono samples at `sample_rate`
 * (1000 to 1000000 Hz), holding up to `capacity` seconds between frames (≤ 0:
 * 1 s; older samples are dropped). m2d_motion_sync_input_push may run on an
 * audio thread while frames run on another.
 */
M2D_API m2d_status m2d_motion_sync_input_create(double sample_rate, double capacity, const m2d_allocator* allocator,
                                                m2d_motion_sync_input** out);
/** Destroys the handle; an animator it is bound to keeps the input until it is replaced or settles. */
M2D_API void m2d_motion_sync_input_destroy(m2d_motion_sync_input* input);
/** Hands over samples captured since the previous push. */
M2D_API void m2d_motion_sync_input_push(m2d_motion_sync_input* input, const float* samples, size_t count);
/** Samples waiting for the next frame, and samples dropped so far. */
M2D_API size_t m2d_motion_sync_input_pending(const m2d_motion_sync_input* input);
M2D_API uint64_t m2d_motion_sync_input_dropped(const m2d_motion_sync_input* input);

typedef struct m2d_voice_profile m2d_voice_profile;

/** The neutral synthetic voice's profile (what the analysis uses without one). */
M2D_API m2d_status m2d_voice_profile_neutral(const m2d_allocator* allocator, m2d_voice_profile** out);
/**
 * Reads a profile from its JSON (as Mochi2D saves it: format
 * "mochi2d-voice-profile", version 1). M2D_FILE_ERROR with Mochi2D's message.
 */
M2D_API m2d_status m2d_voice_profile_parse(const void* json, size_t size, const m2d_allocator* allocator,
                                           m2d_voice_profile** out, m2d_error* error);
/** The profile as JSON, as Mochi2D writes it (JSON.stringify). Free it with m2d_free_string. */
M2D_API char* m2d_voice_profile_to_json(const m2d_voice_profile* profile);
M2D_API void m2d_voice_profile_destroy(m2d_voice_profile* profile);
M2D_API const char* m2d_voice_profile_name(const m2d_voice_profile* profile);
/** The voice's typical level while voiced, and the noise floor recorded as Silence (NaN: none), dBFS. */
M2D_API double m2d_voice_profile_voiced_level(const m2d_voice_profile* profile);
M2D_API double m2d_voice_profile_floor_level(const m2d_voice_profile* profile);
/** A vowel's templates (M2D_ELEMENT_A … M2D_ELEMENT_O): spectra of 20 mel bands in dB. */
M2D_API int32_t m2d_voice_profile_template_count(const m2d_voice_profile* profile, m2d_motion_sync_element_id vowel);
M2D_API const double* m2d_voice_profile_template(const m2d_voice_profile* profile, m2d_motion_sync_element_id vowel,
                                                 int32_t index);

typedef struct m2d_voice_calibration m2d_voice_calibration;

/**
 * Per-voice calibration (Mochi2D's VoiceCalibration): record each vowel for
 * about a second, and a moment of the room's silence if you like, then make
 * the profile. `name` NULL: "voice".
 */
M2D_API m2d_status m2d_voice_calibration_create(const char* name, const m2d_allocator* allocator,
                                                m2d_voice_calibration** out);
M2D_API void m2d_voice_calibration_destroy(m2d_voice_calibration* calibration);
/**
 * Adds a recording of `element`: its channels at `sample_rate`, analyzed
 * every 10 ms (for a vowel, voiced windows louder than -45 dBFS count).
 * Returns the windows used, or -1 for invalid arguments.
 */
M2D_API int32_t m2d_voice_calibration_add(m2d_voice_calibration* calibration, m2d_motion_sync_element_id element,
                                          const float* const* channels, int32_t channel_count, size_t frames,
                                          double sample_rate);
/** Windows recorded for a vowel. */
M2D_API int32_t m2d_voice_calibration_recorded(const m2d_voice_calibration* calibration,
                                               m2d_motion_sync_element_id vowel);
M2D_API m2d_status m2d_voice_calibration_profile(const m2d_voice_calibration* calibration,
                                                 const m2d_allocator* allocator, m2d_voice_profile** out);

typedef struct m2d_motion_sync_options {
  /** Run before physics, so that physics fed by the mouth reacts to speech; default 0 (after lip sync, before pose). */
  int32_t before_physics;
  /** 1 applies the file's per-parameter smoothing (`Smooth`); default 0, off (the dead band applies either way). */
  int32_t file_smoothing;
  /** Seconds of silence fed after a sound ends, at most; default 0.5. */
  double settle_time;
  /** The gate in dBFS; NaN (default): -50, or 6 dB above the voice profile's floor when higher. */
  double gate;
  /** How long a voiced state holds after the level drops, seconds; NaN (default): 0.04. */
  double hangover;
} m2d_motion_sync_options;

M2D_API void m2d_motion_sync_options_default(m2d_motion_sync_options* options);

/**
 * Gives the animator a motion-sync file (as Mochi2D's runtime does for the
 * model's), replacing any before; NULL removes it. M2D_EFFECT_MOTION_SYNC is
 * switched on with a file. `options` NULL takes the defaults.
 */
M2D_API m2d_status m2d_animator_set_motion_sync(m2d_animator* animator, const m2d_motion_sync* file,
                                                const m2d_motion_sync_options* options);
/** The voice profile the analysis uses (copied); NULL: the neutral synthetic voice. */
M2D_API m2d_status m2d_animator_set_voice_profile(m2d_animator* animator, const m2d_voice_profile* profile);

/**
 * A sound's playback position from the host's audio clock: stores the
 * seconds played and returns 1, or returns 0 when there is no position yet
 * (the frames' steps count then). Return 0 seconds until the audio starts,
 * so the mouth waits for it.
 */
typedef int32_t (*m2d_audio_clock)(double* seconds, void* user);

/**
 * Plays a sound through a setting (`setting`: a dictionary name or ID; NULL:
 * the first usable one), from its start; `clock` NULL: the position is the
 * sum of the frames' steps. The host plays the audio. Returns M2D_OK when
 * motion sync started; M2D_INVALID_ARGUMENT with code "no-motion-sync" when
 * the animator has no usable setting (or `setting` names an unusable one),
 * and "unknown-setting" for a name the file lacks. The sound is kept alive.
 */
M2D_API m2d_status m2d_animator_start_motion_sync(m2d_animator* animator, const m2d_motion_sync_sound* sound,
                                                  const char* setting, m2d_audio_clock clock, void* clock_user,
                                                  m2d_error* error);
/**
 * A motion's linked sound, as Mochi2D's runtime binds it when a start is
 * accepted: the sound (decoded for motion sync; NULL when it cannot be) of
 * the start `ticket`, through its entry's `setting`; `path` names the sound
 * in warnings. The sound plays once; it fades out with its motion over the
 * motion's fade-out time, and stops when the motion is stopped or replaced
 * early. Problems are warnings (m2d_animator_warning).
 * m2d_package_start_motion does all of this for a settings entry.
 */
M2D_API m2d_status m2d_animator_bind_motion_sync(m2d_animator* animator, uint32_t ticket,
                                                 const m2d_motion_sync_sound* sound, const char* setting,
                                                 const char* path, m2d_audio_clock clock, void* clock_user);
/**
 * A live input drives the mouth through `setting` (NULL: the first usable
 * one) until replaced or removed with NULL (the mouth then settles to its
 * Silence shape). Errors as for m2d_animator_start_motion_sync. The input is
 * kept alive while bound.
 */
M2D_API m2d_status m2d_animator_set_motion_sync_input(m2d_animator* animator, m2d_motion_sync_input* input,
                                                      const char* setting, m2d_error* error);
/**
 * Ends the sound or input: after `fade` seconds of fading (a sound only),
 * the mouth settles to its Silence shape and motion sync stops writing.
 */
M2D_API void m2d_animator_stop_motion_sync(m2d_animator* animator, double fade);

/** What the bound setting reported at an analysis. */
typedef struct m2d_motion_sync_tick {
  /** Analyses reported so far by this animator, this one included. */
  uint64_t serial;
  /** The setting's index in the file. */
  int32_t setting;
  /** 1 for a live input, 0 for a sound. */
  int32_t live;
  /** The analysis window's level, dBFS. */
  double level;
  /** The gate found the window silent. */
  int32_t silent;
  /** The element weights after the gate, `Enabled` and `Scale`, summing to 1 (m2d_motion_sync_element_id order). */
  double weights[6];
  /** Seconds of the sound played (live: of input received). */
  double time;
  /** The driven parameters' values written from this analysis on, per driven parameter of the setting. */
  int32_t value_count;
  const double* values;
} m2d_motion_sync_tick;

/**
 * The latest analysis (at most one per frame): returns 1 and fills `out`,
 * or 0 while nothing is bound or before the first. `values` stays valid
 * until the next frame.
 */
M2D_API int32_t m2d_animator_motion_sync_tick(const m2d_animator* animator, m2d_motion_sync_tick* out);
/** Calls `listener` at every analysis, during the frame (NULL removes it). */
M2D_API void m2d_animator_set_motion_sync_listener(m2d_animator* animator,
                                                   void (*listener)(const m2d_motion_sync_tick* tick, void* user),
                                                   void* user);
/** The setting that writes (bound), or -1. */
M2D_API int32_t m2d_animator_motion_sync_setting(const m2d_animator* animator);
/** A sound or input is bound and playing (not yet settling). */
M2D_API int32_t m2d_animator_motion_sync_playing(const m2d_animator* animator);
/** Source samples of the bound sound consumed so far. */
M2D_API double m2d_animator_motion_sync_consumed(const m2d_animator* animator);

/**
 * Warnings of the animator's runtime parts, one line each, as Mochi2D words
 * them (motion sync: a setting that drives a parameter the model lacks, a
 * motion's link that cannot run…), in order; m2d_animator_clear_warnings
 * empties the list.
 */
M2D_API int32_t m2d_animator_warning_count(const m2d_animator* animator);
M2D_API const char* m2d_animator_warning(const m2d_animator* animator, int32_t index);
M2D_API void m2d_animator_clear_warnings(m2d_animator* animator);

/**
 * Idle playback with motion sync: entry `index` of the idle motions (see
 * m2d_animator_set_idle_motions) binds `sound` through `setting` when an
 * idle start of it is accepted and the motion is still playing after the
 * frame, as Mochi2D's runtime does. `sound` NULL with `setting` NULL removes
 * the link. Kept until the next m2d_animator_set_idle_motions.
 */
M2D_API m2d_status m2d_animator_set_idle_motion_sync(m2d_animator* animator, int32_t index,
                                                     const m2d_motion_sync_sound* sound, const char* setting,
                                                     const char* path, m2d_audio_clock clock, void* clock_user);

/* ---------------------------------------------------------------- packages
 *
 * A model package: a settings file and the files it names, read through the
 * host (Mochi2D's loadModelBundle, and its model runtime's caches of
 * motions, expressions and sounds). The library reads no files itself: the
 * host's m2d_file_source does, by path.
 *
 * Paths are relative to the source's root, with forward slashes, as
 * Mochi2D's sources take them: backslashes become slashes, "." and empty
 * segments are dropped, and ".." is resolved, never above the root (a path
 * that would escape is an error). A file the settings name resolves against
 * the settings file's folder.
 */

typedef struct m2d_package m2d_package;

/** The host's files: a folder, an archive, an application's assets. */
typedef struct m2d_file_source {
  /** Describes the source in messages, for example a folder name; NULL: "files". */
  const char* label;
  /**
   * Reads a whole file at `path` (normalized, relative to the source's root):
   * sets *data and *size, and returns 1; returns 0 when the file does not
   * exist or cannot be read. The bytes stay valid until `release` is called
   * with them (the library copies them first).
   */
  int32_t (*read)(const char* path, const void** data, size_t* size, void* user);
  /** Releases the bytes of a `read`; NULL when they need no release. */
  void (*release)(const void* data, size_t size, void* user);
  /**
   * Lists the source's files, calling `add` once per path, and returns 1;
   * returns 0 when the source cannot list them (NULL: cannot list). Only
   * needed to find the settings file when no path is given.
   */
  int32_t (*list)(void (*add)(const char* path, void* context), void* context, void* user);
  void* user;
} m2d_file_source;

/**
 * Opens a package: the settings file at `settings_path`, or with NULL the
 * shallowest `*.model3.json` of a listable source (ties in code-point order;
 * Mochi2D uses the locale's order), then its `.moc3` (`flags` as for
 * m2d_model_load) and its optional companions: physics, pose, display info
 * and user data. Problems with optional files become warnings, and the
 * package opens without them. Errors, with Mochi2D's messages:
 * M2D_FILE_ERROR for no settings file, a missing file, a path that escapes
 * the source's root, or a settings file that cannot be used;
 * M2D_FORMAT_ERROR for a `.moc3` that cannot be loaded. The source structure
 * is copied; its functions and `user` must stay valid while the package
 * lives, which reads motions, expressions and sounds later.
 */
M2D_API m2d_status m2d_package_open(const m2d_file_source* source, const char* settings_path, uint32_t flags,
                                    const m2d_allocator* allocator, m2d_package** out, m2d_error* error);
/**
 * Destroys a package and the objects it owns (every object a package
 * function returns). Instances and animators made from them keep what they
 * use alive.
 */
M2D_API void m2d_package_destroy(m2d_package* package);

/** The settings file's path in the source, as given or found. */
M2D_API const char* m2d_package_settings_path(const m2d_package* package);
/** The package's settings and model, owned by the package. */
M2D_API const m2d_settings* m2d_package_settings(const m2d_package* package);
M2D_API m2d_model* m2d_package_model(const m2d_package* package);
/** The optional companions, owned by the package; NULL when the settings name none or it cannot be used. */
M2D_API const m2d_physics* m2d_package_physics(const m2d_package* package);
M2D_API const m2d_pose* m2d_package_pose(const m2d_package* package);
M2D_API const m2d_user_data* m2d_package_user_data(const m2d_package* package);
M2D_API const m2d_display_info* m2d_package_display_info(const m2d_package* package);
/** The motion-sync file, owned by the package; NULL when the settings name none or it cannot be used. */
M2D_API const m2d_motion_sync* m2d_package_motion_sync(const m2d_package* package);
/**
 * Warnings of the opening, one line each, as Mochi2D words them: the `.moc3`'s
 * load warnings ("<moc path>: …"), then problems with optional files
 * ("<path as in the settings>: …"), then the motion-sync file's own warnings.
 */
M2D_API int32_t m2d_package_warning_count(const m2d_package* package);
M2D_API const char* m2d_package_warning(const m2d_package* package, int32_t index);

/**
 * A path named by the settings (a texture, motion, expression or sound),
 * resolved against the settings file's folder, for the source's `read`; NULL
 * when it escapes the root. Free it with m2d_free_string.
 */
M2D_API char* m2d_package_resolve(const m2d_package* package, const char* path);

/**
 * A motion, expression or sound by its path relative to the settings file,
 * read through the source and parsed once (Mochi2D's runtime caches them by
 * resolved path); the object is owned by the package. A motion or
 * expression that cannot be read or used is M2D_FILE_ERROR, and is tried
 * again on the next call. A sound that cannot be read or decoded is
 * M2D_FILE_ERROR with *out set to m2d_sound_unusable(), and stays so: given
 * to a start, it stops lip sync, as in Mochi2D.
 */
M2D_API m2d_status m2d_package_motion(m2d_package* package, const char* path, const m2d_motion** out,
                                      m2d_error* error);
M2D_API m2d_status m2d_package_expression(m2d_package* package, const char* path, const m2d_expression** out,
                                          m2d_error* error);
M2D_API m2d_status m2d_package_sound(m2d_package* package, const char* path, const m2d_sound** out,
                                     m2d_error* error);
/**
 * An expression by its name in the settings (its file read as by
 * m2d_package_expression). M2D_INVALID_ARGUMENT for an unknown name.
 */
M2D_API m2d_status m2d_package_named_expression(m2d_package* package, const char* name, const m2d_expression** out,
                                                m2d_error* error);

/**
 * Entry `index` of a settings motion group, resolved as Mochi2D's runtime
 * starts it: its motion (NULL when the file cannot be used: a start of it
 * fails), its sound (NULL without one; m2d_sound_unusable() when it cannot
 * be used), and the entry's fade times (NaN for none). Use it for a start
 * (the fade times go into m2d_motion_start, the sound to
 * m2d_animator_start_motion) or for m2d_animator_set_idle_motions.
 * M2D_INVALID_ARGUMENT for an unknown group or index; otherwise *out is
 * filled even when a file cannot be used, and the status and `error` give
 * the first such problem.
 */
M2D_API m2d_status m2d_package_group_motion(m2d_package* package, const char* group, int32_t index,
                                            m2d_idle_motion* out, m2d_error* error);

/**
 * A sound decoded for motion sync, by its path relative to the settings
 * file, read and decoded once; owned by the package. M2D_FILE_ERROR when it
 * cannot be read or decoded.
 */
M2D_API m2d_status m2d_package_motion_sync_sound(m2d_package* package, const char* path,
                                                 const m2d_motion_sync_sound** out, m2d_error* error);

/**
 * Starts entry `index` of a settings motion group as Mochi2D's runtime does
 * (startMotion): its motion with the entry's fade times (unless `start` sets
 * its own) and its sound for lip sync; when the start is accepted, the
 * entry has a readable sound and names a motion-sync setting, the sound is
 * bound to it (m2d_animator_bind_motion_sync, with `clock`). The animator
 * must have been made from this package's model and settings, with
 * m2d_animator_set_motion_sync given m2d_package_motion_sync for motion
 * sync. Sets *accepted (may be NULL). M2D_INVALID_ARGUMENT for an unknown
 * group or index; M2D_FILE_ERROR when the motion cannot be used (the start
 * then fails, as in Mochi2D).
 */
M2D_API m2d_status m2d_package_start_motion(m2d_package* package, m2d_animator* animator, const char* group,
                                            int32_t index, const m2d_motion_start* start, m2d_audio_clock clock,
                                            void* clock_user, int32_t* accepted, m2d_error* error);

/* -------------------------------------------------------------- rendering
 *
 * The reference renderer: a software rasterizer that draws an evaluated
 * instance as Mochi2D's WebGL2 renderer draws it in its reference
 * configuration (exact texture preparation, masks, legacy blends, version-6
 * blend codes and offscreens), within the tolerances of Mochi2D's judge. It
 * needs no GPU, and is the yardstick for engine renderers. Images are
 * premultiplied RGBA8, rows top to bottom, in memory the caller owns.
 *
 * Allocators: a texture takes its own; a renderer takes its model's and
 * keeps the model and its textures alive, so handles can be destroyed in
 * any order. A renderer is used by one thread at a time (its worker threads
 * aside, see m2d_renderer_options).
 */

typedef struct m2d_texture m2d_texture;
typedef struct m2d_renderer m2d_renderer;

/**
 * The largest texture side the reference renderer takes, as Mochi2D's
 * reference harness (WebGL's limit there). GPU backends take their
 * context's own limit (Mochi2D takes the driver's), or this one on request.
 */
#define M2D_MAX_TEXTURE_SIZE 8192
/** The largest texture side m2d_texture_create takes (for GPU backends whose limit is above 8192). */
#define M2D_MAX_TEXTURE_SIDE 32768

/**
 * A texture from straight-alpha RGBA8 pixels (rows top to bottom, `stride`
 * bytes apart; 0 for 4·width), prepared as Mochi2D prepares it:
 * premultiplied as ⌊c·a/255 + ½⌋, with a full mip chain (2×2 means rounded
 * with ties to even for power-of-two sizes). M2D_INVALID_ARGUMENT for a
 * side below 1, a stride below 4·width, or a side above
 * M2D_MAX_TEXTURE_SIDE (code "texture-too-large"). The renderers refuse
 * textures above their own limit (m2d_renderer_create above
 * M2D_MAX_TEXTURE_SIZE, Mochi2D's TextureTooLarge).
 */
M2D_API m2d_status m2d_texture_create(const void* pixels, int32_t width, int32_t height, int32_t stride,
                                      const m2d_allocator* allocator, m2d_texture** out, m2d_error* error);
M2D_API void m2d_texture_destroy(m2d_texture* texture);
M2D_API int32_t m2d_texture_width(const m2d_texture* texture);
M2D_API int32_t m2d_texture_height(const m2d_texture* texture);

typedef struct m2d_renderer_options {
  /** The per-drawable mask buffer's side (the reference's 4096, the default) and the offscreen one's (256). */
  int32_t mask_size;
  int32_t offscreen_mask_size;
  /**
   * Worker threads for drawing (rows of the image): 1, the default, draws
   * on the calling thread only; 0 takes the hardware's concurrency; n > 1
   * takes n. Images are the same, byte for byte, with any number. Builds
   * without thread support (MOCHI2D_THREADS off) always draw on the calling
   * thread.
   */
  int32_t threads;
} m2d_renderer_options;

/** Fills the defaults. */
M2D_API void m2d_renderer_options_default(m2d_renderer_options* options);

/**
 * A renderer for a model and its textures, by texture index (the model's
 * art meshes name them): `textures[i]` may be NULL, and a mesh whose
 * texture is missing draws nothing, as in Mochi2D. `options` NULL takes the
 * defaults. M2D_INVALID_ARGUMENT with code "texture-too-large" for a
 * texture side above M2D_MAX_TEXTURE_SIZE.
 */
M2D_API m2d_status m2d_renderer_create(m2d_model* model, m2d_texture* const* textures, int32_t texture_count,
                                       const m2d_renderer_options* options, m2d_renderer** out, m2d_error* error);
M2D_API void m2d_renderer_destroy(m2d_renderer* renderer);

/** How an image frames the model. */
typedef struct m2d_render_frame {
  /**
   * 0 (the default): the model's canvas fitted into the image (Mochi2D's
   * frameImage); 1: the output-space point (view_x, view_y) at the image
   * center, with pixels_per_unit image pixels per output unit.
   */
  int32_t has_view;
  double view_x, view_y, pixels_per_unit;
  /** The background, straight-alpha RGBA in [0, 1]; default (0, 0, 0, 0). */
  double background[4];
} m2d_render_frame;

/** Fills the defaults. */
M2D_API void m2d_render_frame_default(m2d_render_frame* frame);

/**
 * The framing an image of width × height gets: image pixels per output
 * unit, and the output-space point at the image center.
 */
M2D_API m2d_status m2d_render_framing(const m2d_model* model, int32_t width, int32_t height,
                                      const m2d_render_frame* frame, double* pixels_per_unit, double* center_x,
                                      double* center_y);

/**
 * Draws the instance's latest evaluation, with its tints, into `pixels`:
 * width × height premultiplied RGBA8 pixels, rows top to bottom, `stride`
 * bytes apart (0 for 4·width). The instance must be of the renderer's model
 * (M2D_INVALID_ARGUMENT otherwise, or for a side below 1 or above 16384, or
 * a stride below 4·width). `frame` NULL takes the defaults.
 */
M2D_API m2d_status m2d_renderer_draw(m2d_renderer* renderer, const m2d_instance* instance,
                                     const m2d_render_frame* frame, int32_t width, int32_t height, void* pixels,
                                     int32_t stride, m2d_error* error);

/**
 * Texture updates in place (Mochi2D 0.14.0's updateTexture; one call per
 * renderer kind): replaces texture `index`, or the region of it at (x, y)
 * (texels from the top-left) the size of the straight-alpha RGBA8 image
 * `pixels` (width × height, rows `stride` bytes apart, 0 for 4·width).
 * Level 0 is premultiplied as at preparation, and in each mip level only
 * the texels whose 2×2 block covers the region are recomputed, by the same
 * exact rule, so the result equals a renderer made with the new image.
 * Drawn from the next draw. A renderer copies a texture it shares with
 * others on its first update: the m2d_texture and other renderers keep the
 * old pixels. M2D_INVALID_ARGUMENT with code "texture-region" for a missing
 * texture or a region that does not fit.
 */
M2D_API m2d_status m2d_renderer_update_texture(m2d_renderer* renderer, int32_t index, const void* pixels, int32_t width,
                                               int32_t height, int32_t stride, int32_t x, int32_t y,
                                               m2d_error* error);

/** What the last draw did (Mochi2D's frame statistics, the parts that apply). */
typedef struct m2d_render_stats {
  /** 1 when the model needs the layered pipeline (offscreens, or blend codes the direct one cannot draw). */
  int32_t layered;
  uint32_t drawn, masked, mask_builds, mask_mesh_draws, layers, advanced_draws;
  /** Fragments shaded (pixels covered by drawn triangles, masks included). */
  uint64_t fragments;
} m2d_render_stats;

M2D_API void m2d_renderer_stats(const m2d_renderer* renderer, m2d_render_stats* out);

/* ------------------------------------------------------- GPU rendering
 *
 * The backend-neutral render interface (docs/design.md §8.10): for each
 * frame, the list of operations Mochi2D's WebGL2 renderer performs, in
 * drawing order: clears, mask buffer builds, layers opened and composited,
 * destination copies for advanced blends, and mesh draws with their blend,
 * colors, opacity, tint and mask. A backend executes the list with its own
 * textures, buffers and render targets, in the host's context or command
 * buffer and into the host's target; the library opens no window and makes
 * no context or device. Geometry: positions from the instance
 * (m2d_instance_drawable_vertices, output space), triangles from the model
 * (m2d_model_drawable_indices), texture coordinates as the renderer samples
 * them (m2d_render_plan_drawable_uvs, for textures uploaded with their top
 * row first, as m2d_texture keeps them), and output space mapped to clip
 * space by the plan's view.
 *
 * Mochi2D 0.18.0's render rules (its docs/rendering.md), which fix the
 * float32 order and rounding of four operations, are in the plan and the
 * programs: textures sampled at v flipped twice in float32 (V, the plan's
 * UVs); masks mapped through float32 matrices applied as A·p + c (M, the
 * ops' mask_matrix); layers composited by a linearly filtered quad (L); a
 * masked layer's mask through D = A · V⁻¹ at the quad's clip-space corners
 * (I, a COMPOSITE op's mask_matrix).
 *
 * The OpenGL backend executes the plan in OpenGL ES 3.0 or desktop OpenGL
 * 3.3 core, the same code for both. The host makes the context, makes it
 * current on the calling thread for every call (destroy included), and
 * hands over its loader (eglGetProcAddress, SDL_GL_GetProcAddress,
 * glfwGetProcAddress, …); the library links no GL library.
 */

typedef struct m2d_render_plan m2d_render_plan;

typedef enum m2d_render_op_kind {
  /** Clear the frame's target to `color` (premultiplied RGBA). */
  M2D_OP_CLEAR = 0,
  /**
   * Build mask buffer `buffer` (0 per-drawable, 1 offscreen) of buffer_size × buffer_size:
   * clear it to (1, 1, 1, 1) inside `scissor` (x, y, w, h, GL's lower-left
   * origin), then draw the meshes plan.mask_meshes[first, first + count)
   * placed by `mask_matrix` (the mask's clip matrix) writing red only,
   * blended ZERO, ONE_MINUS_SRC_ALPHA, the fragment (0, 0, 0, texture α).
   * Meshes whose texture is missing are skipped; single-sided ones cull back faces.
   */
  M2D_OP_BUILD_MASK = 1,
  /** Open layer `layer`: a frame-sized RGBA8 target (LINEAR, CLAMP_TO_EDGE) cleared to (0, 0, 0, 0). */
  M2D_OP_OPEN_LAYER = 2,
  /** Copy layer `target` into the destination copy that advanced draws read. */
  M2D_OP_COPY_DESTINATION = 3,
  /** Draw drawable `index` into `target`. */
  M2D_OP_DRAW_MESH = 4,
  /**
   * Composite layer `layer` into `target`: a quad over the viewport (a
   * triangle strip of 4 vertices), texture coordinates 0 to 1, the layer
   * sampled linearly; `index` is the offscreen, or −1 for the model layer.
   */
  M2D_OP_COMPOSITE = 5
} m2d_render_op_kind;

typedef enum m2d_render_blend {
  /** ONE, ONE_MINUS_SRC_ALPHA (color and alpha). */
  M2D_BLEND_NORMAL = 0,
  /** ONE, ONE; alpha ZERO, ONE. */
  M2D_BLEND_ADDITIVE = 1,
  /** DST_COLOR, ONE_MINUS_SRC_ALPHA; alpha ZERO, ONE. */
  M2D_BLEND_MULTIPLICATIVE = 2,
  /** No fixed-function blending: the shader blends with the destination copy (color_fn, alpha_mode). */
  M2D_BLEND_ADVANCED = 3
} m2d_render_blend;

typedef struct m2d_render_op {
  /** sizeof(m2d_render_op) of the library: a binding checks it against its own declaration. */
  uint32_t size;
  int32_t kind;
  /** -1 the frame's target, k ≥ 0 layer k. */
  int32_t target;
  /** DRAW_MESH: the drawable; COMPOSITE: the offscreen (-1: the model layer). */
  int32_t index;
  /** OPEN_LAYER, COMPOSITE: the layer. */
  int32_t layer;
  int32_t blend;
  /** ADVANCED: the color function and the alpha mode of the blend code. */
  int32_t color_fn, alpha_mode;
  /** DRAW_MESH: cull back faces (counter-clockwise front faces). */
  int32_t cull;
  float multiply[3], screen[3], tint[3];
  /** The opacity, tints' alpha included. */
  float opacity;
  /** The mask sampled: -1 none, 0 the per-drawable buffer, 1 the offscreen buffer; inverted or not. */
  int32_t mask_buffer, mask_inverted;
  /** The mask mapping (x, y, sx, sy): t = (p − (x, y))·(sx, sy); BUILD_MASK: the mapping of its meshes. */
  double mask_map[4];
  /** BUILD_MASK: the buffer, its side (buffer_size), the scissor, the mesh range. */
  int32_t buffer, buffer_size;
  int32_t scissor[4];
  uint32_t first, count;
  /** CLEAR: the color. */
  double color[4];
  /**
   * The mask's float32 matrix, rows 0 and 1 of a row-major 4 × 4 (x then y;
   * rows 2 and 3 are the identity's), applied as A·(x, y, 0, 1): DRAW_MESH
   * the texture matrix from output space (uMaskTex); COMPOSITE with a mask,
   * D = A · V⁻¹ from the quad's clip-space corners (uMaskTex); BUILD_MASK
   * the clip matrix of the mask buffer (uMaskClip).
   */
  float mask_matrix[8];
} m2d_render_op;

/**
 * A planner for a model. `texture_present[i]` nonzero when the backend has
 * texture i (NULL: all `texture_count` present); a mesh whose texture is
 * missing draws nothing. `options` NULL takes the default mask sizes
 * (`threads` is ignored).
 */
M2D_API m2d_status m2d_render_plan_create(m2d_model* model, const uint8_t* texture_present, int32_t texture_count,
                                          const m2d_renderer_options* options, m2d_render_plan** out,
                                          m2d_error* error);
M2D_API void m2d_render_plan_destroy(m2d_render_plan* plan);
/** 1 when the model needs layers (offscreens, or blend codes the direct pipeline cannot draw). */
M2D_API int32_t m2d_render_plan_layered(const m2d_render_plan* plan);

/** Plans a frame of width × height of the instance's latest evaluation, with its tints. */
M2D_API m2d_status m2d_render_plan_frame(m2d_render_plan* plan, const m2d_instance* instance,
                                         const m2d_render_frame* frame, int32_t width, int32_t height,
                                         m2d_error* error);
/** sizeof(m2d_render_op) of the library (every op's `size` too). */
M2D_API uint32_t m2d_render_op_size(void);
/** The latest frame's operations (valid until the next frame or destroy). */
M2D_API const m2d_render_op* m2d_render_plan_ops(const m2d_render_plan* plan, int32_t* count);
/** The mask meshes the BUILD_MASK operations index. */
M2D_API const int32_t* m2d_render_plan_mask_meshes(const m2d_render_plan* plan, int32_t* count);
/**
 * Drawable `drawable`'s texture coordinates as the renderer samples them
 * (u, v pairs, `count` of them; v flipped twice in float32), valid as long
 * as the plan; NULL for an unknown drawable.
 */
M2D_API const float* m2d_render_plan_drawable_uvs(const m2d_render_plan* plan, int32_t drawable, int32_t* count);
/** Output space to clip space: clip = (x·view[0] + view[2], y·view[1] + view[3]). */
M2D_API void m2d_render_plan_view(const m2d_render_plan* plan, double view[4]);
/** Layers open at once at most (layer indices are below it). */
M2D_API int32_t m2d_render_plan_layer_count(const m2d_render_plan* plan);
/** What the frame does, as m2d_renderer_stats counts it (no fragments). */
M2D_API void m2d_render_plan_stats(const m2d_render_plan* plan, m2d_render_stats* out);

typedef enum m2d_shader_program {
  /** A drawable: texture × colors × opacity × mask, fixed-function blending. */
  M2D_SHADER_MESH = 0,
  /** A drawable with an advanced blend code, reading the destination copy. */
  M2D_SHADER_MESH_ADVANCED = 1,
  /** A layer composited: a quad over the viewport, a triangle strip of 4 vertices. */
  M2D_SHADER_LAYER = 2,
  M2D_SHADER_LAYER_ADVANCED = 3,
  /** A mask mesh into a mask buffer. */
  M2D_SHADER_MASK = 4
} m2d_shader_program;

typedef enum m2d_shader_dialect {
  /** GLSL ES 3.00 (OpenGL ES 3.0, WebGL2). */
  M2D_SHADER_GLSL_ES_300 = 0,
  /** GLSL 3.30 core (desktop OpenGL 3.3). */
  M2D_SHADER_GLSL_330 = 1,
  /**
   * GLSL 4.50 for Vulkan, made from the same text: the uniforms in one
   * 120-byte push-constant block (the mask matrix as its rows 0 and 1), samplers at set 0, bindings 0–2 (uTex,
   * uMask, uDst), and uFlip for a flipped viewport (the Vulkan backend's).
   */
  M2D_SHADER_VULKAN_GLSL_450 = 2,
  /**
   * The Vulkan dialect for APIs whose clip space puts y = +1 at the
   * target's row 0 (Metal, Direct3D): the vertex shaders negate y unless
   * uFlip, so masks and layers are laid out as in OpenGL.
   */
  M2D_SHADER_CROSS_GLSL_450 = 3,
  /**
   * That dialect in MSL 2.0 (SPIRV-Cross; the Metal backend's): the
   * push-constant block at buffer(0) in both stages, uTex, uMask, uDst at
   * texture and sampler 0–2, aPos and aUv at attribute 0 and 1; each stage's
   * function is m2d_<program>_<vert|frag> (mesh, mesh_advanced, layer,
   * layer_advanced, mask).
   */
  M2D_SHADER_MSL = 4,
  /**
   * That dialect in HLSL for shader model 5.0 (SPIRV-Cross; the Direct3D 11
   * backend's): the block as a cbuffer at b0, uTex, uMask, uDst at t0–t2 and
   * s0–s2, aPos and aUv as TEXCOORD0 and TEXCOORD1, the entry point main.
   */
  M2D_SHADER_HLSL = 5
} m2d_shader_dialect;

/**
 * The GPU programs' source (Mochi2D's GLSL, the GL backend's), for plan
 * executors of other APIs: `stage` 0 vertex, 1 fragment. The uniforms are
 * the ops' fields (uView: the plan's view; uMultiply, uScreen, uTint,
 * uOpacity; uMaskMode 0 none, 1 normal, 2 inverted; uMaskTex and, in the
 * mask program, uMaskClip, mat4s from the ops' mask_matrix; uColorFn,
 * uAlphaMode).
 * The text lives as long as the process; NULL for an unknown argument.
 */
M2D_API const char* m2d_render_shader_source(int32_t program, int32_t stage, int32_t dialect);
/** The Vulkan dialect compiled to SPIR-V (the words the Vulkan backend uses), and their count. */
M2D_API const uint32_t* m2d_render_shader_spirv(int32_t program, int32_t stage, size_t* words);

typedef struct m2d_gl_renderer m2d_gl_renderer;

/** The host's loader: a GL function of the current context by name, or NULL. */
typedef void* (*m2d_gl_loader)(const char* name, void* user);

typedef struct m2d_gl_options {
  /** 0 (the default): OpenGL ES 3.0 (GLSL ES 3.00); 1: desktop OpenGL 3.3 core (GLSL 3.30). */
  int32_t desktop;
  int32_t mask_size;
  int32_t offscreen_mask_size;
  /**
   * The largest texture side: 0 (the default) the context's
   * GL_MAX_TEXTURE_SIZE, as Mochi2D takes the driver's; n > 0 caps it at n
   * (M2D_MAX_TEXTURE_SIZE for the reference configuration).
   */
  int32_t max_texture_size;
} m2d_gl_options;

M2D_API void m2d_gl_options_default(m2d_gl_options* options);

/**
 * The GL objects for a model and its textures, in the current context.
 * M2D_INTERNAL_ERROR with code "gl-function" when the loader lacks a
 * function, "gl-shader" when a shader does not compile, "gl-texture-size"
 * when a texture exceeds GL_MAX_TEXTURE_SIZE, "gl-error" otherwise.
 */
M2D_API m2d_status m2d_gl_renderer_create(m2d_model* model, m2d_texture* const* textures, int32_t texture_count,
                                          m2d_gl_loader loader, void* user, const m2d_gl_options* options,
                                          m2d_gl_renderer** out, m2d_error* error);
/** Releases the GL objects (the context current). */
M2D_API void m2d_gl_renderer_destroy(m2d_gl_renderer* renderer);
/**
 * Draws into the host's framebuffer `framebuffer` (0: the default one) of
 * width × height (an RGBA8 color attachment; premultiplied output). It
 * leaves blending, culling and the scissor test off, and the framebuffer bound.
 */
M2D_API m2d_status m2d_gl_renderer_draw(m2d_gl_renderer* renderer, const m2d_instance* instance,
                                        const m2d_render_frame* frame, int32_t width, int32_t height,
                                        uint32_t framebuffer, m2d_error* error);
M2D_API void m2d_gl_renderer_stats(const m2d_gl_renderer* renderer, m2d_render_stats* out);
/** The texture limit in effect (the context's, or the option's when smaller). */
M2D_API int32_t m2d_gl_renderer_max_texture_size(const m2d_gl_renderer* renderer);
/** As m2d_renderer_update_texture, uploading only the rewritten rectangles (the context current; "gl-error"). */
M2D_API m2d_status m2d_gl_renderer_update_texture(m2d_gl_renderer* renderer, int32_t index, const void* pixels,
                                                  int32_t width, int32_t height, int32_t stride, int32_t x, int32_t y,
                                                  m2d_error* error);

/*
 * The Vulkan backend executes the plan with Vulkan 1.1 in the host's device:
 * it records into the host's command buffer and draws into the host's
 * image, and links no Vulkan loader (the host hands over its
 * vkGetInstanceProcAddr). Handles cross as plain values: dispatchable ones
 * (instance, physical device, device, queue, command buffer) as pointers,
 * the others (image, image view) as 64-bit integers, and enums as int32_t,
 * so this header needs no Vulkan header. The host's side (docs/design.md
 * §8.12): the queue runs the one-time texture uploads at creation; command
 * buffers are submitted to it in the order they were recorded, each before
 * the next draw records; a draw at a larger frame than before waits for the
 * device to be idle; m2d_vk_renderer_forget_target before destroying a
 * view drawn into. Builds without the Vulkan headers leave the backend out
 * (m2d_vk_available() 0; create fails with code "vk-not-built").
 */
typedef struct m2d_vk_renderer m2d_vk_renderer;

typedef struct m2d_vk_context {
  /** sizeof(m2d_vk_context), set by the caller. */
  uint32_t size;
  uint32_t queue_family;
  /** PFN_vkGetInstanceProcAddr, VkInstance, VkPhysicalDevice, VkDevice, VkQueue. */
  void* get_instance_proc_addr;
  void* instance;
  void* physical_device;
  void* device;
  void* queue;
} m2d_vk_context;

typedef struct m2d_vk_options {
  int32_t mask_size;
  int32_t offscreen_mask_size;
  /** 0 (the default): the device's maxImageDimension2D; n > 0 caps it (M2D_MAX_TEXTURE_SIZE for the reference). */
  int32_t max_texture_size;
  /** 1 (the default): the top row first in the host's image; 0: the bottom row first, as OpenGL's. */
  int32_t flip_y;
} m2d_vk_options;

typedef struct m2d_vk_target {
  /** sizeof(m2d_vk_target), set by the caller. */
  uint32_t size;
  /** VkFormat (a color format the device renders to with blending; VK_FORMAT_R8G8B8A8_UNORM = 37 for Mochi2D's results). */
  int32_t format;
  /** VkImage and a VkImageView of it (COLOR_ATTACHMENT usage). */
  uint64_t image;
  uint64_t view;
  /** VkImageLayout before the draw (0, UNDEFINED, discards it) and the one to leave it in. */
  int32_t old_layout;
  int32_t new_layout;
} m2d_vk_target;

/** 1 when the library was built with the Vulkan backend. */
M2D_API int32_t m2d_vk_available(void);
M2D_API void m2d_vk_options_default(m2d_vk_options* options);
/**
 * The Vulkan objects for a model and its textures (uploaded on the context's
 * queue, waited for). M2D_INTERNAL_ERROR with code "vk-function" (a missing
 * function, or a device older than Vulkan 1.1), "vk-texture-size",
 * "vk-error" (a Vulkan call failed) or "vk-not-built".
 */
M2D_API m2d_status m2d_vk_renderer_create(m2d_model* model, m2d_texture* const* textures, int32_t texture_count,
                                          const m2d_vk_context* context, const m2d_vk_options* options,
                                          m2d_vk_renderer** out, m2d_error* error);
/** Destroys the Vulkan objects: the host makes sure the device no longer uses them (vkDeviceWaitIdle). */
M2D_API void m2d_vk_renderer_destroy(m2d_vk_renderer* renderer);
/**
 * Records a frame of width × height into `command_buffer` (VkCommandBuffer,
 * recording, outside a render pass), drawn into `target`, which ends in its
 * `new_layout`. Code "vk-format" when the target's format cannot be
 * rendered to with blending.
 */
M2D_API m2d_status m2d_vk_renderer_draw(m2d_vk_renderer* renderer, const m2d_instance* instance,
                                        const m2d_render_frame* frame, int32_t width, int32_t height,
                                        void* command_buffer, const m2d_vk_target* target, m2d_error* error);
/** Drops what the renderer keeps for a target view; call before destroying the view. */
M2D_API void m2d_vk_renderer_forget_target(m2d_vk_renderer* renderer, uint64_t view);
M2D_API void m2d_vk_renderer_stats(const m2d_vk_renderer* renderer, m2d_render_stats* out);
M2D_API int32_t m2d_vk_renderer_max_texture_size(const m2d_vk_renderer* renderer);
/**
 * As m2d_renderer_update_texture: the rewritten rectangles copied on the
 * context's queue, after the work already submitted to it, and waited for
 * ("vk-error").
 */
M2D_API m2d_status m2d_vk_renderer_update_texture(m2d_vk_renderer* renderer, int32_t index, const void* pixels,
                                                  int32_t width, int32_t height, int32_t stride, int32_t x, int32_t y,
                                                  m2d_error* error);

/*
 * The Metal backend executes the plan with Metal in the host's device: it
 * encodes into the host's command buffer (and commits nothing) and draws
 * into the host's texture, the programs in MSL compiled by Metal when the
 * renderer is made. Objects cross as pointers (an `id` bridged to void*:
 * `(__bridge void*)device` under ARC); the renderer retains what it keeps.
 * The host's side (docs/design.md §8.13): a command buffer of a queue of
 * that device, with no encoder open, per draw; one renderer's command
 * buffers committed to one queue in the order they were encoded; a 2D
 * target texture with RenderTarget usage, the frame's size (a clear clears
 * all of it), in a color pixel format the device blends into
 * (MTLPixelFormatRGBA8Unorm for Mochi2D's results). Built on Apple
 * platforms only (m2d_mtl_available() 0 elsewhere; create fails with code
 * "mtl-not-built").
 */
typedef struct m2d_mtl_renderer m2d_mtl_renderer;

typedef struct m2d_mtl_options {
  int32_t mask_size;
  int32_t offscreen_mask_size;
  /** 0 (the default): the device's (16384 on Apple and Mac GPUs of Metal 2); n > 0 caps it (M2D_MAX_TEXTURE_SIZE for the reference). */
  int32_t max_texture_size;
  /** 1 (the default): the top row first in the host's texture; 0: the bottom row first, as OpenGL's. */
  int32_t flip_y;
} m2d_mtl_options;

/** 1 when the library was built with the Metal backend. */
M2D_API int32_t m2d_mtl_available(void);
M2D_API void m2d_mtl_options_default(m2d_mtl_options* options);
/**
 * The Metal objects for a model and its textures on `device`
 * (id<MTLDevice>). M2D_INTERNAL_ERROR with code "mtl-function" (no
 * device), "mtl-shader" (a program Metal does not compile),
 * "mtl-texture-size", "mtl-error" or "mtl-not-built".
 */
M2D_API m2d_status m2d_mtl_renderer_create(m2d_model* model, m2d_texture* const* textures, int32_t texture_count,
                                           void* device, const m2d_mtl_options* options, m2d_mtl_renderer** out,
                                           m2d_error* error);
/** Releases the Metal objects (the command buffers that use them keep them until they complete). */
M2D_API void m2d_mtl_renderer_destroy(m2d_mtl_renderer* renderer);
/**
 * Encodes a frame of width × height into `command_buffer`
 * (id<MTLCommandBuffer>), drawn into `texture` (id<MTLTexture>). Code
 * "mtl-format" when the texture's pixel format cannot be rendered to with
 * blending.
 */
M2D_API m2d_status m2d_mtl_renderer_draw(m2d_mtl_renderer* renderer, const m2d_instance* instance,
                                         const m2d_render_frame* frame, int32_t width, int32_t height,
                                         void* command_buffer, void* texture, m2d_error* error);
M2D_API void m2d_mtl_renderer_stats(const m2d_mtl_renderer* renderer, m2d_render_stats* out);
M2D_API int32_t m2d_mtl_renderer_max_texture_size(const m2d_mtl_renderer* renderer);
/**
 * As m2d_renderer_update_texture: the rewritten rectangles copied into the
 * texture by a blit at the start of the next draw's command buffer.
 */
M2D_API m2d_status m2d_mtl_renderer_update_texture(m2d_mtl_renderer* renderer, int32_t index, const void* pixels,
                                                   int32_t width, int32_t height, int32_t stride, int32_t x,
                                                   int32_t y, m2d_error* error);

/*
 * The Direct3D 11 backend executes the plan with Direct3D 11 (feature level
 * 11_0 or above) through the host's device and context, into the host's
 * render target view; the programs are HLSL compiled by fxc when the
 * library is built. Objects cross as COM pointers (ID3D11Device*,
 * ID3D11DeviceContext*, ID3D11RenderTargetView*); the renderer AddRefs
 * what it keeps. The host's side (docs/design.md §8.14): textures are
 * uploaded and updated through the context; the target is a view of a 2D
 * texture the frame's size (a clear clears all of it), in a color format
 * the device blends into (DXGI_FORMAT_R8G8B8A8_UNORM for Mochi2D's
 * results); a draw sets the context's state as it needs and leaves no view
 * of its own bound. Built on Windows where fxc is found (m2d_d3d11_available()
 * 0 elsewhere; create fails with code "d3d11-not-built").
 */
typedef struct m2d_d3d11_renderer m2d_d3d11_renderer;

typedef struct m2d_d3d11_options {
  int32_t mask_size;
  int32_t offscreen_mask_size;
  /** 0 (the default): the device's (16384 at feature level 11_0); n > 0 caps it (M2D_MAX_TEXTURE_SIZE for the reference). */
  int32_t max_texture_size;
  /** 1 (the default): the top row first in the host's texture; 0: the bottom row first, as OpenGL's. */
  int32_t flip_y;
} m2d_d3d11_options;

/** 1 when the library was built with the Direct3D 11 backend. */
M2D_API int32_t m2d_d3d11_available(void);
M2D_API void m2d_d3d11_options_default(m2d_d3d11_options* options);
/**
 * The Direct3D objects for a model and its textures, made with `device`
 * (ID3D11Device*), the textures uploaded through `context`
 * (ID3D11DeviceContext*). M2D_INTERNAL_ERROR with code "d3d11-function"
 * (no device or context, or a feature level below 11_0),
 * "d3d11-texture-size", "d3d11-error" or "d3d11-not-built".
 */
M2D_API m2d_status m2d_d3d11_renderer_create(m2d_model* model, m2d_texture* const* textures, int32_t texture_count,
                                             void* device, void* context, const m2d_d3d11_options* options,
                                             m2d_d3d11_renderer** out, m2d_error* error);
M2D_API void m2d_d3d11_renderer_destroy(m2d_d3d11_renderer* renderer);
/**
 * Draws a frame of width × height into `render_target_view`
 * (ID3D11RenderTargetView*) through the context. Code "d3d11-format" when
 * the view's format cannot be rendered to with blending.
 */
M2D_API m2d_status m2d_d3d11_renderer_draw(m2d_d3d11_renderer* renderer, const m2d_instance* instance,
                                           const m2d_render_frame* frame, int32_t width, int32_t height,
                                           void* render_target_view, m2d_error* error);
M2D_API void m2d_d3d11_renderer_stats(const m2d_d3d11_renderer* renderer, m2d_render_stats* out);
M2D_API int32_t m2d_d3d11_renderer_max_texture_size(const m2d_d3d11_renderer* renderer);
/** As m2d_renderer_update_texture: the rewritten rectangles written through the context (UpdateSubresource). */
M2D_API m2d_status m2d_d3d11_renderer_update_texture(m2d_d3d11_renderer* renderer, int32_t index, const void* pixels,
                                                     int32_t width, int32_t height, int32_t stride, int32_t x,
                                                     int32_t y, m2d_error* error);

#ifdef __cplusplus
}
#endif

#endif /* MOCHI2D_H */

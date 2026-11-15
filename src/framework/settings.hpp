// The model settings file `*.model3.json` (3b): which files belong to
// the model, parameter groups, hit areas and layout. Keys are case-sensitive
// and unknown keys are ignored. Paths are relative to the directory of the
// settings file. Port of Mochi2D's src/core/settings/model-settings.ts.
#pragma once

#include <optional>
#include <string_view>

#include "util/alloc.hpp"
#include "util/json.hpp"

namespace mochi2d::framework {

/** One entry of a motion group (3b.2). */
struct MotionEntry {
  String file;
  /** Overrides the motion file's fade times, but only when ≥ 0 (3b.2). */
  std::optional<double> fade_in_time, fade_out_time;
  /** A WAV file started together with the motion, if the start is accepted (empty: none). */
  String sound;
  /**
   * The motion-sync setting that drives the mouth with the sound: a dictionary
   * name of the model's motion-sync file, or a setting ID (0.9.0; empty: none).
   */
  String motion_sync;
};

struct MotionGroup {
  String group;
  Vector<MotionEntry> entries;
};

struct ParameterGroup {
  String target, name;
  Vector<String> ids;
};

struct NamedExpression {
  String name, file;
};

struct HitArea {
  /** An art-mesh ID (3t). */
  String id;
  String name;
};

struct ModelSettings {
  /** Path of the `.moc3` file, relative to the settings file. */
  String moc;
  /** Texture paths relative to the settings file, in index order. */
  Vector<String> textures;
  /** Optional files (empty: none); `motion_sync` is the `*.motionsync3.json` file (0.9.0). */
  String physics, pose, user_data, display_info, motion_sync;
  /** Named expressions, in file order. */
  Vector<NamedExpression> expressions;
  /** Motion groups, in the order of JavaScript's Object.entries. */
  Vector<MotionGroup> motions;
  Vector<ParameterGroup> groups;
  /** Named hit areas. */
  Vector<HitArea> hit_areas;
  /** Placement in a viewer: the lower-case keys of 3b.4 that are numbers, in that order. */
  Vector<std::pair<String, double>> layout;
  /** The parsed JSON. */
  json::Value raw;

  /** The motion group with this name, or nullptr. */
  const MotionGroup* motion_group(std::string_view name) const;
};

/** Parses a settings file (UTF-8, a leading BOM skipped); false with an error message (SettingsError's). */
bool parse_model_settings(std::string_view bytes, const String& label, ModelSettings& out, String& error);

/** Settings from already parsed JSON. */
bool settings_from_json(json::Value json, const String& label, ModelSettings& out, String& error);

/** IDs of the first parameter group with this name (3b.3); empty if there is none. */
Vector<String> parameter_group_ids(const ModelSettings& settings, std::string_view name);

/**
 * A normalized relative path: backslashes as slashes, "." and empty
 * segments dropped, ".." resolved. False when it escapes the root.
 */
bool normalize_path(std::string_view path, String& out);

}  // namespace mochi2d::framework

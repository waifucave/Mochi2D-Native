// Hit testing (3t), user data (3h) and display information (3i): port of
// Mochi2D's src/anim/model-data.ts.
#pragma once

#include <optional>
#include <string_view>

#include "framework/jsutil.hpp"
#include "util/alloc.hpp"
#include "util/json.hpp"

namespace mochi2d::framework {

/** Inclusive bounding box of a drawable's vertices in output space (y up). */
struct Bounds {
  double min_x, min_y, max_x, max_y;
};

/** The bounds of x, y pairs (an empty list gives +∞ minima and −∞ maxima). */
Bounds vertex_bounds(const float* vertices, std::size_t length);

/**
 * 3t: whether (x, y) lies in the bounding box of a drawable's vertices from
 * the latest evaluation. Bounds are inclusive; visibility does not matter.
 */
bool hit_test(const float* vertices, std::size_t length, double x, double y);

struct UserDataEntry {
  String target, id, value;
};

struct UserData {
  Vector<UserDataEntry> all;
  /** The `ArtMesh` entries. */
  Vector<UserDataEntry> art_meshes;
};

/** 3h: takes the first `UserDataCount` entries; a count larger than the array is rejected. */
bool parse_user_data(std::string_view bytes, std::string_view label, UserData& out, FormatError& error);
bool user_data_from_json(const json::Value& json, std::string_view label, UserData& out, FormatError& error);

struct DisplayEntry {
  String id, group_id, name;
};

struct DisplayInfo {
  Vector<DisplayEntry> parameters;
  Vector<DisplayEntry> parameter_groups;
  /** Parts have no group: group_id is empty. */
  Vector<DisplayEntry> parts;
  Vector<std::pair<String, String>> combined_parameters;
};

/** 3i. Playback never reads this file. */
bool parse_display_info(std::string_view bytes, std::string_view label, DisplayInfo& out, FormatError& error);
bool display_info_from_json(const json::Value& json, std::string_view label, DisplayInfo& out, FormatError& error);

/** A label and group for one model parameter or part (answer B3). */
struct DisplayLabel {
  String id;
  /** The display name, or the ID when there is none. */
  String label;
  /** Group display name; none for the top level. */
  std::optional<String> group;
  /** The index in the model's list. */
  std::size_t index = 0;
};

enum class DisplayKind { Parameters, Parts };

/**
 * Display rules of answer B3: names by ID, the ID when a name is missing,
 * entries for unknown IDs ignored, groups in file order with members in
 * model order, unknown or empty groups at the top level.
 */
Vector<DisplayLabel> display_labels(const Vector<String>& model_ids, const DisplayInfo* info, DisplayKind kind);

}  // namespace mochi2d::framework

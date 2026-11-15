// Pose files `*.pose3.json` (3f) and the pose effect (3o): mutually
// exclusive part groups (port of Mochi2D's src/anim/pose.ts). An entry's
// "value" is the value named by its part ID (a parameter with that ID, else
// a free value, 3g.3).
#pragma once

#include <string_view>

#include "framework/jsutil.hpp"
#include "framework/values.hpp"
#include "util/alloc.hpp"
#include "util/json.hpp"

namespace mochi2d::framework {

struct PoseEntry {
  String id;
  Vector<String> links;
};

struct PoseFile {
  String label;
  /** Fade time F; missing or negative: 0.5 (3f). */
  double fade = 0.5;
  Vector<Vector<PoseEntry>> groups;
};

bool parse_pose(std::string_view bytes, std::string_view label, PoseFile& out, FormatError& error);
bool pose_from_json(const json::Value& json, std::string_view label, PoseFile& out, FormatError& error);

class PoseRig {
 public:
  /** The file and the values must outlive the rig. */
  PoseRig(const PoseFile& file, AnimationValues& values) : file_(&file), values_(&values) {}
  const PoseFile& file() const { return *file_; }
  /** 3o.1 on the first frame, then 3o.2. */
  void frame(double dt);

 private:
  const PoseFile* file_;
  AnimationValues* values_;
  bool initialized_ = false;
};

}  // namespace mochi2d::framework

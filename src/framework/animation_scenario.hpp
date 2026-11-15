// Animation scenarios (3w; file format and run protocol in 4i–4k) in
// programmatic form: a model and its settings, files by path, frame steps,
// commands attached to frame numbers, the random sequence, which effects run
// and the options. Runs synchronously and records the outputs of 3w.3 per
// frame, the motion start attempts and the random numbers used. Port of
// Mochi2D's src/anim/scenario.ts.
#pragma once

#include <memory>
#include <optional>
#include <string_view>

#include "framework/animator.hpp"
#include "util/json.hpp"

namespace mochi2d::framework {

/** Files by path relative to the settings file's folder. */
class FileSource {
 public:
  virtual ~FileSource() = default;
  /** The file's bytes; false when it is missing. */
  virtual bool read(std::string_view path, String& bytes) = 0;
};

/** An effect a command can switch on. `None` is an effect name the reference accepts and ignores. */
enum class Effect : uint8_t { Idle, EyeBlink, Expressions, Look, Breath, Physics, LipSync, Pose, None };

struct ScenarioCommand {
  enum class Kind : uint8_t { StartMotion, StartExpression, SetLookTarget, StartSound, SetPartOpacity, StopMotions, Enable };
  Kind kind = Kind::StopMotions;
  /** StartMotion: a motion file, or a group name and an index into the settings' Motions. StartExpression, StartSound: a file. */
  std::optional<String> file;
  std::optional<String> group;
  std::optional<double> index;
  std::optional<double> priority, fade_in, fade_out;
  std::optional<bool> loop, loop_fade_in;
  std::optional<double> weight, offset;
  std::optional<bool> legacy_loop;
  /** StartExpression: an expression name from the settings. */
  std::optional<String> name;
  /** SetLookTarget. */
  double x = 0, y = 0;
  /** SetPartOpacity. */
  String id;
  double value = 0;
  /** Enable. */
  Effect effect = Effect::None;
};

struct ScenarioHit {
  String drawable;
  double x = 0, y = 0;
};

struct ScenarioFrameHit {
  std::size_t frame = 0;
  ScenarioHit hit;
};

/** Effect switches set by a scenario (unset: as the settings make them). */
struct EffectOverrides {
  std::optional<bool> idle, eye_blink, expressions, look, breath, physics, lip_sync, pose;
};

struct AnimationScenario {
  std::shared_ptr<const moc::Model> model;
  const ModelSettings* settings = nullptr;
  FileSource* files = nullptr;
  /** One frame per step, in order. */
  Vector<double> steps;
  /** Commands in list order, with their frames; a motion start's `command` index is its index here. */
  Vector<std::pair<std::size_t, ScenarioCommand>> commands;
  /** The random sequence r₁, r₂, … (3v.2); running out ends the run (RandomExhausted). */
  Vector<double> random;
  EffectOverrides effects;
  /** Motion files that replace the settings' Idle group (4i). */
  std::optional<Vector<String>> idle_motions;
  /** How the instance evaluates, when the scenario evaluates. */
  eval::InstanceOptions instance_options;
  struct Options {
    std::optional<bool> wrap;
    std::optional<std::pair<double, double>> gravity, wind;
    std::optional<bool> settle;
    std::optional<EyeBlinkTiming> eye_blink;
  } options;
  struct Record {
    /** Free values to record by ID. */
    Vector<String> free_values;
    /** Hit tests after evaluation (3t), on every frame. */
    Vector<ScenarioHit> hit_tests;
    /** Hit tests after evaluation at given frames (4i record.hits). */
    Vector<ScenarioFrameHit> hits;
    /** Frames at which the full drawable records are taken (4i record.drawables). */
    Vector<std::size_t> drawables;
    /** Evaluate on every frame even when no hit test or drawable record needs it. */
    bool evaluate_every_frame = false;
  } record;
};

/** A hit test with the drawable's box after step 5 (4k): [x_min, x_max, y_min, y_max]. */
struct HitRecord {
  ScenarioHit hit;
  bool inside = false;
  /** False for an unknown drawable ID. */
  bool has_box = false;
  double box[4] = {0, 0, 0, 0};
};

struct FrameRecord {
  std::size_t frame = 0;
  /** The running sum of the steps so far. */
  double time = 0;
  /** After step 4 (3w.3). */
  Vector<float> parameters;
  Vector<float> part_opacities;
  /** By record.free_values: unset for an ID never written. */
  Vector<std::optional<double>> free_values;
  double model_opacity = 1;
  bool motion_updated = false;
  bool queue_empty = true;
  Vector<String> events;
  std::optional<double> lip_sync;
  /** After step 5: record.hit_tests, in order. */
  Vector<uint8_t> hits;
  /** After step 5: this frame's record.hits, in order (when it has any). */
  bool has_hit_records = false;
  Vector<HitRecord> hit_records;
  /** After step 5, on frames listed in record.drawables: the snapshot's drawables array. */
  bool has_drawables = false;
  json::Value drawables;
};

/** A motion start attempt (4k starts). */
struct MotionStartRecord {
  std::size_t frame = 0;
  /** For a command start: the command's index in the whole command list. */
  std::optional<std::size_t> command;
  /** For an idle start: the picked index into the idle list. */
  std::optional<std::size_t> idle;
  /** The start was accepted and its file was valid (3l.4). */
  bool started = false;
};

struct AnimationReport {
  /** One record per completed frame. */
  Vector<FrameRecord> frames;
  Vector<MotionStartRecord> starts;
  /** Random numbers consumed. */
  std::size_t random_used = 0;
  Vector<String> warnings;
  /** The random sequence ran out (RandomExhausted); the frames completed before stay. */
  bool random_exhausted = false;
};

/**
 * Runs a scenario under the protocol of 4j. Missing or invalid motion, sound
 * and expression files give warnings. False with the error when the
 * reference throws: an AnimationFormatError for a missing or invalid physics
 * or pose file, or an error raised while a frame runs.
 */
bool run_animation_scenario(const AnimationScenario& sc, AnimationReport& out, Fault& error);

}  // namespace mochi2d::framework

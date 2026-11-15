// Motion-sync settings files (`*.motionsync3.json`), port of Mochi2D's
// src/anim/motion-sync/file.ts: for each setting, the model parameters it
// drives, the audio elements an analysis reports (Silence and the vowels A,
// I, U, E, O), the shape each element gives the driven parameters, and the
// post-processing values.
//
// The reader is lenient, like Mochi2D's: a missing or ill-typed field never
// fails the load, it yields a default (0, an empty string or list, false),
// with a warning. Values are then limited to their documented ranges, with a
// warning:
//
// - `Scale` to [0.1, 10], `BlendRatio` to [0, 1], `Smooth` to [0, 100];
// - `Smoothing`, read as an integer (its decimal text, the fraction
//   dropped), to [1, 100];
// - `SampleRate` to [1, 120], 60 when it is not positive.
//
// Settings are read by position, `Meta.Dictionary[i]` with `Settings[i]`,
// for the smaller of `SettingCount` and the length of `Settings`. A setting
// whose analysis type is not recognized is kept, unusable. Mappings are
// matched to elements and targets to driven parameters by their IDs.
#pragma once

#include <cstdint>
#include <string_view>

#include "framework/jsutil.hpp"
#include "util/alloc.hpp"

namespace mochi2d::framework {

/** The audio elements of a mouth setting, in their usual order. */
constexpr int kMotionSyncElementCount = 6;
extern const char* const kMotionSyncElements[kMotionSyncElementCount];
/** Index of an element ID in kMotionSyncElements, or -1. */
int motion_sync_element_index(std::string_view id);

/**
 * The analysis type that editor-made files name, read as data; Mochi2D
 * runs its own analysis for it. Settings of other types are unusable.
 */
extern const char* const kMotionSyncAnalysisType;

/** A model parameter a setting drives. */
struct MotionSyncParameter {
  String id;
  String name;
  /** The range the author saw; not used to drive the parameter. */
  double min = 0, max = 0;
  /** The dead band: the written value follows only once it moved this far (≥ 0). */
  double damper = 0;
  /** The weight of the per-parameter smoothing, in percent, [0, 100]. */
  double smooth = 0;
};

/** An audio element of a setting. */
struct MotionSyncElement {
  String id;
  String name;
  double min = 0, max = 0;
  /** Multiplier of the element's weight, [0.1, 10]. */
  double scale = 0;
  bool enabled = false;
  /** One of kMotionSyncElements; other elements get weight 0. */
  bool known = false;
};

struct MotionSyncSetting {
  /** Position in the file. */
  int index = 0;
  String id;
  /** The dictionary name, which motion entries use to refer to the setting. */
  String name;
  String analysis_type;
  String use_case;
  /** False when the analysis type is not recognized: the setting never runs. */
  bool usable = false;
  Vector<MotionSyncParameter> parameters;
  Vector<MotionSyncElement> elements;
  /** shapes[e][k]: element e's value for driven parameter k. */
  Vector<Vector<double>> shapes;
  /** 0: the most likely element's shape; 1: the elements' shapes blended by weight. */
  double blend_ratio = 0;
  /** How smooth the analysis results are, 1 (intense) to 100 (smooth). */
  double smoothing = 1;
  /** Analysis ticks per second, [1, 120]. */
  double sample_rate = 60;
};

struct MotionSyncFile {
  String label;
  /** `Version` as read (an integer; 1 expected, others read as 1). */
  double version = 0;
  Vector<MotionSyncSetting> settings;
  /** What was missing, ill-typed, out of range or not recognized, one line each. */
  Vector<String> warnings;
};

struct MotionSyncReadOptions {
  /** Also warn about keys the format does not define. */
  bool lint = false;
};

/**
 * Reads a `.motionsync3.json` file (UTF-8 bytes). False only for invalid
 * JSON or a top level that is not an object, with Mochi2D's message.
 */
bool parse_motion_sync(std::string_view bytes, std::string_view label, MotionSyncFile& out, FormatError& error,
                       const MotionSyncReadOptions& options = {});

/**
 * The setting a motion entry names: the first whose dictionary name is
 * `ref`, else the first whose ID is `ref`; null when none matches.
 */
const MotionSyncSetting* find_motion_sync_setting(const MotionSyncFile& file, std::string_view ref);

/**
 * `Number.parseInt(String(n), 10)` as an integer field reads a number: the
 * integer of its decimal text (1.9 → 1, 5e-7 → 5, 1e21 → 1), +0 for -0, and
 * 0 when the text has no digits (NaN, ±Infinity).
 */
double js_integer_of_number(double n);

}  // namespace mochi2d::framework

// Conformance scenarios (port of Mochi2D's src/conformance/scenario.ts and
// run.ts, and tools/lib/conformance-runner.ts, model-cache.ts and
// model-roots.ts): reading scenario files, loading their models, running
// scenarios and writing results in Mochi2D's formats. This is tool code: it
// uses std::filesystem, which core and framework do not.
#pragma once

#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <string_view>

#include "core/eval/instance.hpp"
#include "core/moc/model.hpp"
#include "core/snapshot.hpp"
#include "framework/settings.hpp"
#include "util/json.hpp"

namespace mochi2d::conformance {

/** The `error` member of a result: a kind (ModelLoadError, InvalidScenario, …) and a message. */
struct ErrorInfo {
  String kind;
  String message;
};

/** The known format a `format` value names ("mochi2d-scenario/0" …), or "". */
String known_format(const json::Value* format);

/** Scenario IDs: /^[A-Za-z0-9._-]{1,200}$/. */
bool valid_id(std::string_view id);

/** JSON.stringify(v) as a template literal prints it ("undefined" for nullptr). */
String json_text(const json::Value* v);

/**
 * A `{ id: number }` member checked as Mochi2D's numberRecord does: absent is
 * empty, every value a finite number, in Object.entries order; false with the
 * InvalidScenario message.
 */
bool number_record(const json::Value* v, std::string_view field, Vector<std::pair<String, double>>& out,
                   String& error);

/** The render block of a scenario (§2i). */
struct RenderBlock {
  bool present = false;
  int width = 1024, height = 1024;
  /** Straight RGBA; transparent when absent. */
  double background[4] = {0, 0, 0, 0};
  bool has_view = false;
  double view_x = 0, view_y = 0, view_pixels_per_unit = 1;
};

struct Scenario {
  String id;
  String model;
  EvaluationRequest request;
  RenderBlock render;
  /**
   * `x-tints` (an extension, as Mochi2D's harness takes `tints` in a render
   * request): art-mesh tints by ID, [r, g, b] or [r, g, b, a], drawn by the
   * render runner; not part of the evaluation result.
   */
  Vector<std::pair<String, Vector<double>>> tints;
};

/** Validates a parsed JSON value as a static scenario; false with the InvalidScenario message. */
bool parse_scenario(const json::Value& v, Scenario& out, String& error);

/** A loaded model: its settings, its parsed `.moc3`, and its other files. */
struct LoadedModel {
  std::filesystem::path settings_file;
  framework::ModelSettings settings;
  std::shared_ptr<const moc::Model> model;
  /** Reads a file relative to the settings file's folder; false when missing or outside it. */
  std::function<bool(std::string_view path, String& bytes)> read;
  /** After a failed read: FileLimitError's message when the file was past the cap, else empty. */
  std::shared_ptr<String> read_limit = std::make_shared<String>();
};

/**
 * Model loading for scenarios: resolves a scenario's `model` path in the
 * search folders (assets/models/ first, then the root), reads the settings
 * file and the `.moc3`, and keeps a few parsed models.
 */
class ModelCache {
 public:
  ModelCache(Vector<std::filesystem::path> search_dirs, moc::LoadOptions options = {}, std::size_t capacity = 3);
  /** False with ModelLoadError (or Error for paths that escape the root). */
  bool load(std::string_view model_path, LoadedModel& out, ErrorInfo& error);
  /** How the scenarios' instances evaluate (incremental by default, as Mochi2D's). */
  eval::InstanceOptions instance_options;

 private:
  Vector<std::filesystem::path> dirs_;
  moc::LoadOptions options_;
  std::size_t capacity_;
  struct Entry {
    String path;
    String version;
    std::shared_ptr<const moc::Model> model;
  };
  Vector<Entry> entries_;
};

/** Search folders: the models folder (default <root>/assets/models), then the root. */
Vector<std::filesystem::path> model_search_dirs(const std::filesystem::path& root,
                                                const std::filesystem::path& models_dir = {});

/** An empty result of a format with an error. */
json::Value invalid_result(std::string_view id, std::string_view result_format, std::string_view producer,
                           std::string_view kind, std::string_view message);

/** Runs one static scenario (fresh instance, the request, one evaluation). */
json::Value run_static(const Scenario& sc, ModelCache& models, std::string_view producer);

/** Runs a parsed scenario of a kind ("static", "sequence", "animation"). */
json::Value run_scenario_json(std::string_view kind, const json::Value& json, std::string_view id, ModelCache& models,
                              std::string_view producer);

/** A scenario file as read: its ID, kind (static, sequence, animation, invalid), JSON, model and error. */
struct ScenarioFile {
  String id;
  String kind;
  json::Value json;
  String model;
  String error;
};

/** Reads scenario files and folders (recursively, *.json, folders sorted by path). */
Vector<ScenarioFile> read_scenario_files(const Vector<String>& inputs);

struct RunSummary {
  std::size_t total = 0;
  std::size_t failed = 0;
};

/**
 * Reads scenario files and folders (recursively, *.json), runs each scenario
 * and writes `<out>/<id>.result.json`.
 */
RunSummary run_conformance(const Vector<String>& inputs, const std::filesystem::path& out_dir, ModelCache& models,
                           std::string_view producer, const std::function<void(const String&)>& log);

/** The most bytes the tools read from one file: Mochi2D's default file cap, 1 GiB. */
constexpr uint64_t kMaxFileBytes = uint64_t{1} << 30;

/**
 * Reads a whole file; false when it cannot be read. A file past `max_bytes`
 * is refused from its size before it is read (and a file that grows past it
 * while being read, there), with FileLimitError's message in `*limit`. The
 * message names the file as `name` (as a model names it; empty: the path as
 * given), never by a path on disk the caller did not give.
 */
bool read_file(const std::filesystem::path& p, String& out, String* limit = nullptr, uint64_t max_bytes = kMaxFileBytes,
               std::string_view name = {});

/** The producer name of results: "mochi2d-native@<version>". */
String producer_id();

/** A path's UTF-8 text as String. */
String path_text(const std::filesystem::path& p);

}  // namespace mochi2d::conformance

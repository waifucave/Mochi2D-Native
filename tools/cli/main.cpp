// mochi2d-native: the agent-first command line. Every command prints JSON.
//
//   mochi2d-native validate <file.moc3> [--level official|strict]
//   mochi2d-native inspect <file.moc3 | file.model3.json>
//   mochi2d-native evaluate <file.moc3 | file.model3.json> [--param ID=VALUE]... [--part ID=VALUE]...
//   mochi2d-native run <scenario.json | folder>... --out <folder> [--models <folder>] [--root <folder>]
//                      [--strict-draw-orders] [--full-evaluation]
//   mochi2d-native render <scenario.json | folder>... --out <folder> [--models <folder>] [--root <folder>]
//                         [--mask-size N] [--threads N]
//   mochi2d-native motion-sync-trace <sound.wav> <file.motionsync3.json> [--setting REF] [--fps N]
//                         [--seconds S] [--profile FILE] [--gate DB] [--hangover S] [--settle-time S]
//                         [--file-smoothing] [--live] [--stop-at S] [--fade S] [--label TEXT]
//   mochi2d-native voice-profile <ELEMENT=sound.wav>... [--name TEXT]
//   mochi2d-native motion-sync-play <file.model3.json> --group NAME --index N [--seconds S] [--fps N]
//                         [--effects-off LIST] [--motion-sync-off] [--before-physics] [--profile FILE]
//                         [--then GROUP:INDEX@SECONDS[:PRIORITY]]
//
// Exit codes: 0 success, 1 failure (invalid file, failed scenarios), 2 usage.
#include <algorithm>
#include <cstdio>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#include "core/eval/instance.hpp"
#include "core/moc/io.hpp"
#include "core/moc/model.hpp"
#include "core/snapshot.hpp"
#include "conformance/render.hpp"
#include "conformance/scenario.hpp"
#include "framework/motion_sync_analysis.hpp"
#include "framework/motion_sync_driver.hpp"
#include "framework/settings.hpp"
#include "mochi2d.h"
#include "util/json.hpp"
#include "util/text.hpp"

namespace fs = std::filesystem;
using namespace mochi2d;
using json::Value;

namespace {

const char* kUsage =
    "usage:\n"
    "  mochi2d-native validate <file.moc3> [--level official|strict]\n"
    "  mochi2d-native inspect <file.moc3 | file.model3.json>\n"
    "  mochi2d-native evaluate <file.moc3 | file.model3.json> [--param ID=VALUE]... [--part ID=VALUE]...\n"
    "  mochi2d-native run <scenario.json | folder>... --out <folder> [--models <folder>] [--root <folder>]\n"
    "                     [--strict-draw-orders] [--full-evaluation]\n"
    "  mochi2d-native render <scenario.json | folder>... --out <folder> [--models <folder>] [--root <folder>]\n"
    "                        [--mask-size N] [--threads N]\n"
    "  mochi2d-native motion-sync-trace <sound.wav> <file.motionsync3.json> [--setting REF] [--fps N]\n"
    "                        [--seconds S] [--profile FILE] [--gate DB] [--hangover S] [--settle-time S]\n"
    "                        [--file-smoothing] [--live] [--stop-at S] [--fade S] [--label TEXT]\n"
    "  mochi2d-native voice-profile <ELEMENT=sound.wav>... [--name TEXT]\n"
    "  mochi2d-native motion-sync-play <file.model3.json> --group NAME --index N [--seconds S] [--fps N]\n"
    "                        [--effects-off LIST] [--motion-sync-off] [--before-physics] [--profile FILE]\n"
    "                        [--then GROUP:INDEX@SECONDS[:PRIORITY]]\n"
    "  mochi2d-native version\n";

struct Args {
  std::vector<String> positional;
  std::vector<std::pair<String, String>> options;
  bool has(const String& k) const {
    for (const auto& o : options)
      if (o.first == k) return true;
    return false;
  }
  String get(const String& k, const String& def = "") const {
    for (const auto& o : options)
      if (o.first == k) return o.second;
    return def;
  }
};

bool parse_args(int argc, char** argv, int from, const std::vector<String>& flags, Args& out, String& err) {
  for (int i = from; i < argc; i++) {
    String a = argv[i];
    if (a.rfind("--", 0) == 0) {
      String key = a.substr(2), value;
      const auto eq = key.find('=');
      if (eq != String::npos) {
        value = key.substr(eq + 1);
        key = key.substr(0, eq);
      } else if (std::find(flags.begin(), flags.end(), key) == flags.end()) {
        if (i + 1 >= argc) {
          err = "option --" + key + " needs a value";
          return false;
        }
        value = argv[++i];
      }
      out.options.emplace_back(key, value);
    } else {
      out.positional.push_back(a);
    }
  }
  return true;
}

int print(const Value& v, int code) {
  std::cout << json::write_pretty(v) << "\n";
  return code;
}

/** Set when a file was refused past the file cap: the failure is then a FileLimitError. */
bool file_limit_hit = false;

/** Reads a file; false with `err` set to `missing`, or to FileLimitError's message past the cap. */
bool read_input(const fs::path& p, String& bytes, String& err, const String& missing) {
  String limit;
  if (conformance::read_file(p, bytes, &limit)) return true;
  file_limit_hit = !limit.empty();
  err = file_limit_hit ? limit : missing;
  return false;
}

int fail(const String& kind, const String& message, int code = 1) {
  Value v = Value::object();
  Value e = Value::object();
  e.set("kind", file_limit_hit && kind != "Usage" ? String("FileLimitError") : kind);
  e.set("message", message);
  v.set("error", std::move(e));
  return print(v, code);
}

Value diagnostics_json(const Vector<moc::Diagnostic>& list) {
  Value out = Value::array();
  for (const auto& d : list) {
    Value x = Value::object();
    x.set("code", d.code);
    x.set("severity", d.warning ? "warning" : "error");
    x.set("kind", d.kind);
    if (d.index) x.set("index", *d.index);
    if (d.field) x.set("field", *d.field);
    x.set("message", d.message);
    out.push(std::move(x));
  }
  return out;
}

/** A `.moc3` path, or the one a settings file names. */
bool moc_bytes(const String& path, String& bytes, String& err) {
  const fs::path p = fs::u8path(to_std(path));
  String ext = conformance::path_text(p.extension());
  if (ext == ".json") {
    String text;
    if (!read_input(p, text, err, "cannot read " + path)) return false;
    framework::ModelSettings s;
    String rel;
    if (!framework::parse_model_settings(text, path, s, err)) return false;
    if (!framework::normalize_path(s.moc, rel)) {
      err = "Path escapes the source root: \"" + s.moc + "\"";
      return false;
    }
    const fs::path moc = p.parent_path() / fs::u8path(to_std(rel));
    if (!read_input(moc, bytes, err, "the .moc3 file " + s.moc + " of " + path + " is missing")) return false;
    return true;
  }
  if (!read_input(p, bytes, err, "cannot read " + path)) return false;
  return true;
}

int cmd_validate(const Args& a) {
  if (a.positional.size() != 1) return fail("Usage", kUsage, 2);
  const String level = a.get("level", "strict");
  if (level != "official" && level != "strict") return fail("Usage", "--level is official or strict", 2);
  String bytes, err;
  if (!moc_bytes(a.positional[0], bytes, err)) return fail("ReadError", err);
  const auto v = moc::validate_moc(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(),
                                   level == "official" ? moc::Level::Official : moc::Level::Strict);
  Value out = Value::object();
  out.set("file", a.positional[0]);
  out.set("level", level);
  out.set("valid", v.valid);
  out.set("version", v.version ? Value(v.version) : Value(nullptr));
  out.set("diagnostics", diagnostics_json(v.diagnostics));
  return print(out, v.valid ? 0 : 1);
}

std::shared_ptr<const moc::Model> load(const String& path, String& err) {
  String bytes;
  if (!moc_bytes(path, bytes, err)) return nullptr;
  auto m = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
  moc::Error e;
  if (!moc::load_moc(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), moc::LoadOptions(), *m, e)) {
    err = e.message;
    return nullptr;
  }
  return m;
}

int cmd_inspect(const Args& a) {
  if (a.positional.size() != 1) return fail("Usage", kUsage, 2);
  String err;
  auto m = load(a.positional[0], err);
  if (!m) return fail("ModelLoadError", err);
  Value out = Value::object();
  out.set("file", a.positional[0]);
  out.set("version", m->version);
  out.set("bigEndian", m->big_endian);
  Value canvas = Value::object();
  canvas.set("width", m->canvas.width);
  canvas.set("height", m->canvas.height);
  canvas.set("originX", m->canvas.origin_x);
  canvas.set("originY", m->canvas.origin_y);
  canvas.set("pixelsPerUnit", m->canvas.pixels_per_unit);
  canvas.set("flags", static_cast<int>(m->canvas.flags));
  out.set("canvas", std::move(canvas));
  Value counts = Value::object();
  counts.set("parameters", m->parameters.ids.size());
  counts.set("parts", m->parts.ids.size());
  counts.set("deformers", m->deformers.ids.size());
  counts.set("warpDeformers", m->warps.band.size());
  counts.set("rotationDeformers", m->rotations.band.size());
  counts.set("drawables", m->meshes.ids.size());
  counts.set("glues", m->glues.ids.size());
  counts.set("drawOrderGroups", m->groups.objects.size());
  counts.set("offscreens", m->offscreens.part.size());
  counts.set("bands", m->bands.size());
  std::size_t blends = 0;
  for (const auto* list : {&m->blend_shapes.warp, &m->blend_shapes.mesh, &m->blend_shapes.part, &m->blend_shapes.rotation,
                           &m->blend_shapes.glue})
    for (const auto& l : *list) blends += l.size();
  counts.set("blendShapeBindings", blends);
  out.set("counts", std::move(counts));
  Value params = Value::array();
  for (std::size_t i = 0; i < m->parameters.ids.size(); i++) {
    Value p = Value::object();
    p.set("id", m->parameters.ids[i]);
    p.set("min", m->parameters.min[i]);
    p.set("max", m->parameters.max[i]);
    p.set("default", m->parameters.defaults[i]);
    p.set("repeat", m->parameters.repeat[i] == 1);
    p.set("type", m->parameters.type[i] == 1 ? "blendShape" : "normal");
    Value keys = Value::array();
    for (float k : m->parameters.key_lists[i]) keys.push(k);
    p.set("keys", std::move(keys));
    params.push(std::move(p));
  }
  out.set("parameters", std::move(params));
  Value parts = Value::array();
  for (std::size_t i = 0; i < m->parts.ids.size(); i++) {
    Value p = Value::object();
    p.set("id", m->parts.ids[i]);
    p.set("parent", m->parts.parent[i]);
    p.set("initialOpacity", m->parts.initial_opacity[i]);
    parts.push(std::move(p));
  }
  out.set("parts", std::move(parts));
  Value drawables = Value::array();
  for (std::size_t i = 0; i < m->meshes.ids.size(); i++) {
    Value d = Value::object();
    d.set("id", m->meshes.ids[i]);
    d.set("texture", m->meshes.texture[i]);
    d.set("vertices", m->meshes.vertex_count[i]);
    d.set("triangles", m->meshes.triangles[i].size() / 3);
    d.set("blendMode", m->meshes.blend_mode[i]);
    Value masks = Value::array();
    for (int32_t x : m->meshes.masks[i]) masks.push(x);
    d.set("masks", std::move(masks));
    drawables.push(std::move(d));
  }
  out.set("drawables", std::move(drawables));
  Value warnings = Value::array();
  for (const auto& w : m->load_warnings) warnings.push(w);
  out.set("warnings", std::move(warnings));
  return print(out, 0);
}

bool parse_assignment(const String& s, std::pair<String, double>& out) {
  const auto eq = s.rfind('=');
  if (eq == String::npos || eq == 0) return false;
  char* end = nullptr;
  const String num = s.substr(eq + 1);
  const double v = std::strtod(num.c_str(), &end);
  if (num.empty() || *end) return false;
  out = {s.substr(0, eq), v};
  return true;
}

int cmd_evaluate(const Args& a) {
  if (a.positional.size() != 1) return fail("Usage", kUsage, 2);
  EvaluationRequest req;
  for (const auto& [k, v] : a.options) {
    std::pair<String, double> as;
    if (k != "param" && k != "part") return fail("Usage", "unknown option --" + k, 2);
    if (!parse_assignment(v, as)) return fail("Usage", "--" + k + " takes ID=VALUE", 2);
    (k == "param" ? req.parameters : req.part_opacities).push_back(as);
  }
  String err;
  auto m = load(a.positional[0], err);
  if (!m) return fail("ModelLoadError", err);
  eval::Instance inst(m);
  auto warnings = m->load_warnings;
  for (auto& w : apply_request(inst, req)) warnings.push_back(w);
  inst.evaluate();
  Value out = Value::object();
  out.set("format", "mochi2d-result/0");
  out.set("producer", conformance::producer_id());
  out.set("error", nullptr);
  snapshot_into(inst, out);
  Value w = Value::array();
  for (auto& s : warnings) w.push(s);
  out.set("warnings", std::move(w));
  std::cout << json::write_result(out);
  return 0;
}

int cmd_run(const Args& a) {
  const String out = a.get("out");
  if (out.empty() || a.positional.empty()) return fail("Usage", kUsage, 2);
  const fs::path root = a.has("root") ? fs::u8path(to_std(a.get("root"))) : fs::current_path();
  const fs::path models = a.has("models") ? fs::u8path(to_std(a.get("models"))) : fs::path();
  moc::LoadOptions opts;
  opts.reject_draw_order_range = a.has("strict-draw-orders");
  conformance::ModelCache cache(conformance::model_search_dirs(root, models), opts);
  // Every evaluation from scratch instead of incrementally (the results are the same).
  cache.instance_options.incremental = !a.has("full-evaluation");
  const bool quiet = a.has("quiet");
  Vector<String> inputs(a.positional.begin(), a.positional.end());
  auto summary = conformance::run_conformance(inputs, fs::u8path(to_std(out)), cache, conformance::producer_id(),
                                            [&](const String& line) {
                                              if (!quiet) std::cerr << line << "\n";
                                            });
  Value v = Value::object();
  v.set("total", summary.total);
  v.set("succeeded", summary.total - summary.failed);
  v.set("failed", summary.failed);
  v.set("out", out);
  if (summary.total == 0) v.set("error", "No scenarios found.");
  return print(v, summary.total == 0 || summary.failed > 0 ? 1 : 0);
}

/** Reference renders (Mochi2D's npm run render): <id>.png (premultiplied) and <id>.render.json. */
int cmd_render(const Args& a) {
  const String out = a.get("out");
  if (out.empty() || a.positional.empty()) return fail("Usage", kUsage, 2);
  const fs::path root = a.has("root") ? fs::u8path(to_std(a.get("root"))) : fs::current_path();
  const fs::path models = a.has("models") ? fs::u8path(to_std(a.get("models"))) : fs::path();
  conformance::RenderOptions options;
  if (a.has("mask-size")) {
    const String v = a.get("mask-size");
    char* end = nullptr;
    const long n = std::strtol(v.c_str(), &end, 10);
    if (v.empty() || *end || n < 1 || n > 16384) return fail("Usage", "--mask-size must be a positive integer", 2);
    options.mask_size = static_cast<int>(n);
  }
  if (a.has("threads")) {
    const String v = a.get("threads");
    char* end = nullptr;
    const long n = std::strtol(v.c_str(), &end, 10);
    if (v.empty() || *end || n < 0 || n > 64)
      return fail("Usage", "--threads must be between 0 (the hardware's) and 64", 2);
    options.threads = static_cast<int>(n);
  }
  conformance::ModelCache cache(conformance::model_search_dirs(root, models));
  const bool quiet = a.has("quiet");
  Vector<String> inputs(a.positional.begin(), a.positional.end());
  auto summary = conformance::run_render(inputs, fs::u8path(to_std(out)), cache, conformance::producer_id(), options,
                                         [&](const String& line) {
                                           if (!quiet) std::cerr << line << "\n";
                                         });
  Value v = Value::object();
  v.set("total", summary.total);
  v.set("rendered", summary.total - summary.failed);
  v.set("failed", summary.failed);
  v.set("out", out);
  if (summary.total == 0) v.set("error", "No scenarios found.");
  return print(v, summary.total == 0 || summary.failed > 0 ? 1 : 0);
}

// ------------------------------------------------------------- motion sync
//
// The trace tool of the motion-sync cross-check (tests/crosscheck/motion_sync.sh):
// a WAV file through a setting, frame by frame, with every analysis (its raw
// weights, voicing, openness, level, features), the weights and values it
// reported, and the values written after each frame. Its counterpart over
// Mochi2D is tests/crosscheck/motion_sync.ts; both print the same JSON.

namespace fw = mochi2d::framework;

bool number_option(const Args& a, const char* key, double& out) {
  if (!a.has(key)) return true;
  const String v = a.get(key);
  char* end = nullptr;
  out = std::strtod(v.c_str(), &end);
  return !v.empty() && *end == 0;
}

Value numbers(const double* x, std::size_t n) {
  Value out = Value::array();
  for (std::size_t i = 0; i < n; i++) out.push(x[i]);
  return out;
}

bool read_sound(const String& path, fw::MotionSyncSound& out, String& err) {
  String bytes;
  if (!read_input(fs::u8path(to_std(path)), bytes, err, "cannot read " + path)) return false;
  if (!fw::decode_motion_sync_wav(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), out, err)) {
    err = path + ": " + err;
    return false;
  }
  out.prepare();
  return true;
}

bool read_profile(const String& path, fw::VoiceProfile& out, String& err) {
  String text;
  if (!read_input(fs::u8path(to_std(path)), text, err, "cannot read " + path)) return false;
  json::Value v;
  fw::FormatError fe;
  if (!fw::parse_json(text, path, v, fe)) {
    err = fe.message;
    return false;
  }
  return fw::voice_profile_from_json(v, out, err);
}

/** Mono samples handed over per frame, as a live input would. */
struct BlockInput final : fw::MotionSyncInput {
  double rate = 0;
  Vector<float> block;
  double sample_rate() const override { return rate; }
  void read(Vector<float>& out) override {
    out = block;
    block.clear();
  }
};

int cmd_motion_sync_trace(const Args& a) {
  if (a.positional.size() != 2) return fail("Usage", kUsage, 2);
  String err;
  auto sound = std::allocate_shared<fw::MotionSyncSound>(Allocator<fw::MotionSyncSound>());
  if (!read_sound(a.positional[0], *sound, err)) return fail("SoundError", err);
  String text;
  String read_err;
  if (!read_input(fs::u8path(to_std(a.positional[1])), text, read_err, "cannot read " + a.positional[1]))
    return fail("FileError", read_err);
  auto file = std::allocate_shared<fw::MotionSyncFile>(Allocator<fw::MotionSyncFile>());
  fw::FormatError fe;
  if (!fw::parse_motion_sync(text, a.get("label", "ms"), *file, fe)) return fail("FormatError", fe.message);
  int index = -1;
  if (a.has("setting")) {
    const fw::MotionSyncSetting* s = fw::find_motion_sync_setting(*file, a.get("setting"));
    if (!s) return fail("RangeError", "no motion-sync setting \"" + a.get("setting") + "\"");
    index = s->index;
  } else {
    for (const auto& s : file->settings)
      if (s.usable) {
        index = s.index;
        break;
      }
  }
  if (index < 0) return fail("RangeError", "no usable motion-sync setting");
  const fw::MotionSyncSetting& setting = file->settings[static_cast<std::size_t>(index)];
  double fps = 60, seconds = -1, stop_at = -1, fade = 0;
  fw::MotionSyncOptions options;
  double gate = 0, hangover = 0, settle = 0.5;
  if (!number_option(a, "fps", fps) || !number_option(a, "seconds", seconds) || !number_option(a, "stop-at", stop_at) ||
      !number_option(a, "fade", fade) || !number_option(a, "gate", gate) || !number_option(a, "hangover", hangover) ||
      !number_option(a, "settle-time", settle) || !(fps > 0))
    return fail("Usage", "a number option is not a number", 2);
  if (a.has("gate")) options.gate = gate;
  if (a.has("hangover")) options.hangover = hangover;
  options.settle_time = settle;
  options.file_smoothing = a.has("file-smoothing");
  // A model with the setting's parameters: their ranges as the file gives them, defaults 0.
  moc::Model model;
  for (const auto& p : setting.parameters) {
    bool seen = false;
    for (const auto& id : model.parameters.ids) seen = seen || id == p.id;
    if (seen) continue;
    model.parameters.ids.push_back(p.id);
    model.parameters.min.push_back(static_cast<float>(std::min(p.min, p.max)));
    model.parameters.max.push_back(static_cast<float>(std::max(p.min, p.max)));
    model.parameters.defaults.push_back(0);
    model.parameters.repeat.push_back(0);
  }
  fw::AnimationValues values(model);
  fw::MotionSyncDriver driver(file, values, options);
  if (a.has("profile")) {
    fw::VoiceProfile profile;
    if (!read_profile(a.get("profile"), profile, err)) return fail("ProfileError", err);
    driver.set_profile(&profile);
  }
  struct Recorder {
    Value ticks = Value::array();
    int frame = 0;
    static void add(const fw::MotionSyncTick& t, void* user) {
      auto* r = static_cast<Recorder*>(user);
      Value x = Value::object();
      x.set("frame", r->frame);
      x.set("time", t.time);
      x.set("level", t.level);
      x.set("silent", t.silent);
      x.set("raw", numbers(t.analysis.raw.data(), t.analysis.raw.size()));
      x.set("voicing", t.analysis.voicing);
      x.set("open", t.analysis.open);
      x.set("periodicity", t.analysis.features.periodicity);
      x.set("bands", numbers(t.analysis.features.bands.data(), 3));
      x.set("spectrum", numbers(t.analysis.features.spectrum.data(), t.analysis.features.spectrum.size()));
      x.set("weights", numbers(t.weights.data(), t.weights.size()));
      x.set("values", numbers(t.values.data(), t.values.size()));
      r->ticks.push(std::move(x));
    }
  } recorder;
  driver.set_listener(Recorder::add, &recorder);
  const bool live = a.has("live");
  BlockInput input;
  input.rate = sound->sample_rate;
  bool bound = live ? driver.set_input(index, &input) : driver.play_sound(index, sound);
  if (!bound) return fail("RangeError", "the setting cannot run");
  const double length = static_cast<double>(sound->frames()) / sound->sample_rate;
  if (seconds < 0) seconds = length + 1;
  const double dt = 1 / fps;
  const auto frames = static_cast<long>(std::ceil(seconds * fps));
  Value written = Value::array();
  bool stopped = false;
  for (long n = 1; n <= frames; n++) {
    if (stop_at >= 0 && !stopped && static_cast<double>(n - 1) * dt >= stop_at) {
      driver.stop(fade);
      stopped = true;
    }
    if (live) {
      const double from = fw::js_round(static_cast<double>(n - 1) * sound->sample_rate / fps);
      const double to = fw::js_round(static_cast<double>(n) * sound->sample_rate / fps);
      input.block.clear();
      const auto& ch = sound->channels.empty() ? Vector<float>() : sound->channels[0];
      for (double i = from; i < to && i < static_cast<double>(ch.size()); i++)
        input.block.push_back(ch[static_cast<std::size_t>(i)]);
    }
    recorder.frame = static_cast<int>(n);
    driver.frame(dt);
    Value row = Value::array();
    for (const auto& p : setting.parameters) row.push(values.get(p.id));
    written.push(std::move(row));
  }
  Value out = Value::object();
  Value s = Value::object();
  s.set("index", setting.index);
  s.set("id", setting.id);
  s.set("name", setting.name);
  out.set("setting", std::move(s));
  Value warnings = Value::array();
  for (const auto& w : file->warnings) warnings.push(w);
  for (const auto& w : driver.warnings) warnings.push(w);
  out.set("warnings", std::move(warnings));
  out.set("consumed", driver.consumed);
  out.set("ticks", std::move(recorder.ticks));
  out.set("frames", std::move(written));
  const String json_text = json::write_compact(out);
  std::fwrite(json_text.data(), 1, json_text.size(), stdout);
  std::fputc('\n', stdout);
  return 0;
}

int cmd_voice_profile(const Args& a) {
  if (a.positional.empty()) return fail("Usage", kUsage, 2);
  fw::VoiceCalibration cal(a.has("name") ? a.get("name") : String("voice"));
  Value used = Value::array();
  for (const auto& arg : a.positional) {
    const auto eq = arg.find('=');
    const int element = eq == String::npos ? -1 : fw::motion_sync_element_index(std::string_view(arg).substr(0, eq));
    if (element < 0) return fail("Usage", "expected ELEMENT=sound.wav with an element Silence, A, I, U, E or O", 2);
    fw::MotionSyncSound sound;
    String err;
    if (!read_sound(arg.substr(eq + 1), sound, err)) return fail("SoundError", err);
    Vector<const float*> ch;
    for (const auto& c : sound.channels) ch.push_back(c.data());
    used.push(cal.add(element, ch.data(), ch.size(), sound.frames(), sound.sample_rate));
  }
  const String text = fw::voice_profile_to_json(cal.profile());
  std::fwrite(text.data(), 1, text.size(), stdout);
  std::fputc('\n', stdout);
  return 0;
}

// The model check (tests/crosscheck/motion_sync_model.ts): a settings motion
// group entry started as Mochi2D's runtime starts it, through the C API's
// package helper, then frames: the mouth parameters and motion sync's ticks.

struct FolderSource {
  fs::path root;
  /** The file's size from the folder, so that the package refuses one past its cap unread. */
  static int32_t size(const char* path, uint64_t* out, void* user) {
    std::error_code ec;
    const uintmax_t n = fs::file_size(static_cast<FolderSource*>(user)->root / fs::u8path(path), ec);
    if (ec) return 0;
    *out = n;
    return 1;
  }
  static int32_t read(const char* path, const void** data, size_t* size, void* user) {
    auto* self = static_cast<FolderSource*>(user);
    String bytes;
    // The package's own caps decide; this read takes any size the folder holds.
    if (!conformance::read_file(self->root / fs::u8path(path), bytes, nullptr, UINT64_MAX)) return 0;
    char* copy = static_cast<char*>(std::malloc(bytes.size() ? bytes.size() : 1));
    if (!copy) return 0;
    std::memcpy(copy, bytes.data(), bytes.size());
    *data = copy;
    *size = bytes.size();
    return 1;
  }
  static void release(const void* data, size_t, void*) { std::free(const_cast<void*>(data)); }
};

int cmd_motion_sync_play(const Args& a) {
  if (a.positional.size() != 1 || !a.has("group") || !a.has("index")) return fail("Usage", kUsage, 2);
  const fs::path settings_path = fs::u8path(to_std(a.positional[0]));
  FolderSource folder{settings_path.parent_path()};
  m2d_file_source source{};
  source.label = "folder";
  source.read = FolderSource::read;
  source.release = FolderSource::release;
  source.size = FolderSource::size;
  source.user = &folder;
  m2d_package* package = nullptr;
  m2d_error error;
  const String name = conformance::path_text(settings_path.filename());
  if (m2d_package_open(&source, name.c_str(), 0, nullptr, &package, &error) != M2D_OK)
    return fail(error.code, error.message);
  m2d_animator* animator = nullptr;
  if (m2d_animator_create(m2d_package_model(package), m2d_package_settings(package), m2d_package_physics(package),
                          m2d_package_pose(package), nullptr, &animator, &error) != M2D_OK) {
    m2d_package_destroy(package);
    return fail(error.code, error.message);
  }
  m2d_motion_sync_options options;
  m2d_motion_sync_options_default(&options);
  options.before_physics = a.has("before-physics") ? 1 : 0;
  if (m2d_package_motion_sync(package)) m2d_animator_set_motion_sync(animator, m2d_package_motion_sync(package), &options);
  if (a.has("profile")) {
    fw::VoiceProfile profile;
    String err;
    if (!read_profile(a.get("profile"), profile, err)) return fail("ProfileError", err);
    const String json_text = fw::voice_profile_to_json(profile);
    m2d_voice_profile* p = nullptr;
    m2d_voice_profile_parse(json_text.data(), json_text.size(), nullptr, &p, &error);
    m2d_animator_set_voice_profile(animator, p);
    m2d_voice_profile_destroy(p);
  }
  // The effects that vary by chance, off (Mochi2D's model tests turn off the same).
  const String off = a.get("effects-off", "eyeBlink,breath,look,idle");
  const std::pair<const char*, m2d_effect> names[] = {{"idle", M2D_EFFECT_IDLE},       {"eyeBlink", M2D_EFFECT_EYE_BLINK},
                                                      {"expressions", M2D_EFFECT_EXPRESSIONS}, {"look", M2D_EFFECT_LOOK},
                                                      {"breath", M2D_EFFECT_BREATH},   {"physics", M2D_EFFECT_PHYSICS},
                                                      {"lipSync", M2D_EFFECT_LIP_SYNC}, {"pose", M2D_EFFECT_POSE},
                                                      {"motionSync", M2D_EFFECT_MOTION_SYNC}};
  std::size_t start = 0;
  while (start <= off.size()) {
    const std::size_t comma = std::min(off.find(',', start), off.size());
    const String item = off.substr(start, comma - start);
    for (const auto& [n, e] : names)
      if (item == n) m2d_animator_set_effect(animator, e, 0);
    start = comma + 1;
  }
  if (a.has("motion-sync-off")) m2d_animator_set_effect(animator, M2D_EFFECT_MOTION_SYNC, 0);
  double fps = 60, seconds = 8;
  if (!number_option(a, "fps", fps) || !number_option(a, "seconds", seconds) || !(fps > 0))
    return fail("Usage", "a number option is not a number", 2);
  const int index = std::atoi(a.get("index").c_str());
  int32_t accepted = 0;
  const m2d_status started = m2d_package_start_motion(package, animator, a.get("group").c_str(), index, nullptr, nullptr,
                                                      nullptr, &accepted, &error);
  Value out = Value::object();
  out.set("accepted", accepted != 0);
  if (started != M2D_OK) out.set("startError", String(error.message));
  // --then GROUP:INDEX@SECONDS:PRIORITY: another entry started before the frame at that time.
  String then_group;
  int then_index = 0;
  double then_at = -1, then_priority = 2;
  if (a.has("then")) {
    const String t = a.get("then");
    const auto colon = t.find(':'), at = t.find('@'), last = t.rfind(':');
    if (colon == String::npos || at == String::npos || at < colon) return fail("Usage", "--then GROUP:INDEX@SECONDS[:PRIORITY]", 2);
    then_group = t.substr(0, colon);
    then_index = std::atoi(t.substr(colon + 1, at - colon - 1).c_str());
    then_at = std::strtod(t.substr(at + 1).c_str(), nullptr);
    if (last > at) then_priority = std::strtod(t.substr(last + 1).c_str(), nullptr);
  }
  const char* mouth[] = {"ParamMouthOpenY", "ParamMouthForm", "MouthFunnel", "Mouthpucker", "MouthPuckerWiden",
                         "LipPhysics1"};
  Value frames = Value::array();
  const double dt = 1 / fps;
  const auto count = static_cast<long>(std::ceil(seconds * fps));
  bool then_done = false;
  for (long n = 1; n <= count; n++) {
    if (then_at >= 0 && !then_done && static_cast<double>(n - 1) * dt >= then_at) {
      m2d_motion_start st;
      m2d_motion_start_default(&st);
      st.priority = then_priority;
      int32_t ok = 0;
      m2d_package_start_motion(package, animator, then_group.c_str(), then_index, &st, nullptr, nullptr, &ok, &error);
      then_done = true;
    }
    m2d_frame f;
    if (m2d_animator_frame(animator, dt, &f, &error) != M2D_OK) return fail(error.code, error.message);
    Value row = Value::object();
    row.set("frame", static_cast<int>(n));
    Value mv = Value::array();
    for (const char* id : mouth) mv.push(m2d_animator_parameter(animator, id));
    row.set("mouth", std::move(mv));
    m2d_motion_sync_tick tick;
    if (m2d_animator_motion_sync_tick(animator, &tick)) {
      Value t = Value::object();
      t.set("setting", tick.setting);
      t.set("level", tick.level);
      t.set("silent", tick.silent != 0);
      t.set("weights", numbers(tick.weights, 6));
      t.set("values", numbers(tick.values, static_cast<std::size_t>(tick.value_count)));
      t.set("time", tick.time);
      row.set("tick", std::move(t));
    } else {
      row.set("tick", Value(nullptr));
    }
    row.set("bound", m2d_animator_motion_sync_setting(animator));
    row.set("motions", m2d_animator_motion_count(animator));
    frames.push(std::move(row));
  }
  Value warnings = Value::array();
  for (int32_t i = 0; i < m2d_package_warning_count(package); i++) warnings.push(m2d_package_warning(package, i));
  for (int32_t i = 0; i < m2d_animator_warning_count(animator); i++) warnings.push(m2d_animator_warning(animator, i));
  out.set("warnings", std::move(warnings));
  out.set("frames", std::move(frames));
  m2d_animator_destroy(animator);
  m2d_package_destroy(package);
  const String json_text = json::write_compact(out);
  std::fwrite(json_text.data(), 1, json_text.size(), stdout);
  std::fputc('\n', stdout);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << kUsage;
    return 2;
  }
  const String cmd = argv[1];
  if (cmd == "--help" || cmd == "help" || cmd == "-h") {
    std::cout << kUsage;
    return 0;
  }
  if (cmd == "version" || cmd == "--version") {
    Value v = Value::object();
    v.set("name", "mochi2d-native");
    v.set("producer", conformance::producer_id());
    return print(v, 0);
  }
  Args args;
  String err;
  if (!parse_args(argc, argv, 2,
                  {"strict-draw-orders", "quiet", "full-evaluation", "file-smoothing", "live", "motion-sync-off",
                   "before-physics"},
                  args, err))
    return fail("Usage", err, 2);
  if (cmd == "validate") return cmd_validate(args);
  if (cmd == "inspect") return cmd_inspect(args);
  if (cmd == "evaluate") return cmd_evaluate(args);
  if (cmd == "run") return cmd_run(args);
  if (cmd == "render") return cmd_render(args);
  if (cmd == "motion-sync-trace") return cmd_motion_sync_trace(args);
  if (cmd == "voice-profile") return cmd_voice_profile(args);
  if (cmd == "motion-sync-play") return cmd_motion_sync_play(args);
  std::cerr << kUsage;
  return 2;
}

// The framework's part of the C API (include/mochi2d.h): file objects behind
// opaque handles, and the animator. Like the core's handles, each keeps the
// allocator it was created with and works inside a HeapScope of it.
#include <cmath>
#include <cstring>
#include <limits>

#include "capi/internal.hpp"
#include "framework/animator.hpp"
#include "framework/live_input.hpp"
#include "framework/model_data.hpp"
#include "framework/motion_sync_runtime.hpp"
#include "framework/package.hpp"
#include "framework/settings.hpp"

namespace fw = mochi2d::framework;

struct m2d_settings {
  Heap heap;
  std::shared_ptr<const fw::ModelSettings> settings;
};

struct m2d_motion {
  Heap heap;
  std::shared_ptr<const fw::Motion> motion;
};

struct m2d_expression {
  Heap heap;
  std::shared_ptr<const fw::Expression> expression;
};

struct m2d_sound {
  Heap heap;
  std::shared_ptr<const fw::WavSound> sound;
};

struct m2d_physics {
  Heap heap;
  std::shared_ptr<const fw::PhysicsFile> physics;
};

struct m2d_pose {
  Heap heap;
  std::shared_ptr<const fw::PoseFile> pose;
};

struct m2d_user_data {
  Heap heap;
  fw::UserData data;
};

struct m2d_display_info {
  Heap heap;
  fw::DisplayInfo info;
};

struct m2d_motion_sync {
  Heap heap;
  std::shared_ptr<const fw::MotionSyncFile> file;
};

struct m2d_motion_sync_sound {
  Heap heap;
  std::shared_ptr<const fw::MotionSyncSound> sound;
};

struct m2d_motion_sync_input {
  Heap heap;
  std::shared_ptr<fw::MotionSyncLiveInput> input;
};

struct m2d_voice_profile {
  Heap heap;
  fw::VoiceProfile profile;
};

struct m2d_voice_calibration {
  Heap heap;
  fw::VoiceCalibration calibration;
};

/** The host's audio clock behind the framework's interface. */
struct CClock final : fw::MotionSyncClock {
  m2d_audio_clock clock = nullptr;
  void* user = nullptr;
  bool position(double& seconds) override { return clock && clock(&seconds, user) != 0; }
};

/** The animator, with what it uses kept alive, and the callbacks of the C API. */
struct m2d_animator final : fw::RandomSource, fw::IdleMotions, fw::LiveLipSyncSource {
  Heap heap;
  std::shared_ptr<const moc::Model> model;
  std::shared_ptr<const fw::ModelSettings> settings;
  std::shared_ptr<const fw::PhysicsFile> physics;
  std::shared_ptr<const fw::PoseFile> pose;
  fw::Animator* animator = nullptr;
  int32_t (*random)(double*, void*) = nullptr;
  void* random_user = nullptr;
  double (*live)(double, void*) = nullptr;
  double (*mix)(double, double, const char*, void*) = nullptr;
  void* live_user = nullptr;
  /** A live input of the library, instead of `live` (kept alive while attached). */
  std::shared_ptr<fw::LiveLipSyncInput> input;
  struct Idle {
    std::shared_ptr<const fw::Motion> motion;
    /** With a sound (possibly m2d_sound_unusable, whose sound is null). */
    bool has_sound = false;
    std::shared_ptr<const fw::WavSound> sound;
    double fade_in, fade_out;
  };
  Vector<Idle> idle;
  fw::FrameResult last;
  /** Physics at runtime: the model's strength, the settings' (by ID; 1 is not kept), the wind. */
  double physics_strength = 1;
  HashMap<String, double> setting_strengths;
  /** The physics settings' wind multipliers that are not 1, by ID (0.13.0). */
  HashMap<String, double> setting_winds;
  double wind[2] = {0, 0};
  /** The physics rate set (0.10.0), or none: the file's. */
  bool has_physics_rate = false;
  double physics_rate = 0;
  /** Motion sync: the runtime's bindings (after the animator), the bound input kept alive, the clocks. */
  fw::MotionSyncRuntime* sync = nullptr;
  std::shared_ptr<fw::MotionSyncLiveInput> sync_input;
  /** The clock of the sound bound, and a slot for the next binding (a refused one leaves the bound one). */
  CClock clocks[2];
  int clock_slot = 0;
  void (*tick_listener)(const m2d_motion_sync_tick*, void*) = nullptr;
  void* tick_user = nullptr;
  /** Idle motions' motion-sync links, by idle index, and a start of one waiting for the end of its frame. */
  struct IdleSync {
    bool linked = false;
    std::shared_ptr<const fw::MotionSyncSound> sound;
    String setting, path;
    m2d_audio_clock clock = nullptr;
    void* clock_user = nullptr;
  };
  Vector<IdleSync> idle_sync;
  struct PendingSync {
    uint32_t ticket;
    std::shared_ptr<const fw::Motion> motion;
    std::size_t index;
  };
  std::optional<PendingSync> pending_sync;

  ~m2d_animator() override {
    destroy(sync);
    destroy(animator);
  }

  bool next(double& out, fw::Fault& fault) override {
    if (random(&out, random_user)) return true;
    fault.kind = "RandomExhaustedError";
    fault.message = "the random sequence ran out";
    return false;
  }
  std::size_t count() const override { return idle.size(); }
  bool motion(std::size_t index, fw::ResolvedMotion& out) override {
    if (index >= idle.size()) return false;
    const Idle& e = idle[index];
    out = fw::ResolvedMotion();
    out.motion = e.motion;
    if (!std::isnan(e.fade_in)) out.fade_in = e.fade_in;
    if (!std::isnan(e.fade_out)) out.fade_out = e.fade_out;
    if (e.has_sound) {
      out.has_sound = true;
      out.sound = e.sound;
    }
    return true;
  }
  void started(std::size_t index, bool accepted) override {
    // Reported after the frame, if the start was accepted (Mochi2D's pendingSound).
    pending_sync.reset();
    if (accepted && index < idle_sync.size() && idle_sync[index].linked && index < idle.size() && idle[index].motion)
      pending_sync = PendingSync{animator->motions.last_ticket, idle[index].motion, index};
  }
  double next(double dt) override {
    if (input) return input->next(dt);
    return live ? live(dt, live_user) : 0;
  }
  /** The clock slot for a new binding. */
  CClock* next_clock(m2d_audio_clock clock, void* user) {
    CClock& c = clocks[1 - clock_slot];
    c.clock = clock;
    c.user = user;
    return clock ? &c : nullptr;
  }
  /** The new binding took the clock slot. */
  void took_clock() { clock_slot = 1 - clock_slot; }
};

struct m2d_live_input {
  Heap heap;
  std::shared_ptr<fw::LiveLipSyncInput> input;
};

namespace {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

const char* label_or(const char* label, const char* fallback) { return label ? label : fallback; }

bool check_out(const void* bytes, size_t size, const void* out, m2d_error* error) {
  if (!out || (!bytes && size)) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return false;
  }
  clear_error(error);
  return true;
}

m2d_status file_error(m2d_error* error, const String& message) {
  set_error(error, M2D_FILE_ERROR, "file", message.c_str());
  return M2D_FILE_ERROR;
}

std::string_view view(const void* bytes, size_t size) {
  return std::string_view(static_cast<const char*>(bytes), bytes ? size : 0);
}

/** Parses a JSON file object into a shared T with `parse`, as a handle H. */
template <class H, class T, class Parse>
m2d_status parse_shared(const void* bytes, size_t size, const char* label, const char* fallback,
                        const m2d_allocator* allocator, H** out, m2d_error* error,
                        std::shared_ptr<const T> H::*member, Parse parse) {
  if (out) *out = nullptr;
  if (!check_out(bytes, size, out, error)) return M2D_INVALID_ARGUMENT;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  auto value = std::allocate_shared<T>(Allocator<T>());
  fw::FormatError err;
  if (!parse(view(bytes, size), label_or(label, fallback), *value, err)) return file_error(error, err.message);
  H* h = create<H>();
  if (!h) {
    set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
    return M2D_OUT_OF_MEMORY;
  }
  h->heap = heap;
  h->*member = std::move(value);
  *out = h;
  return M2D_OK;
}

template <class H>
void destroy_handle(H* h) {
  if (!h) return;
  HeapScope scope(&h->heap);
  destroy(h);
}

const fw::ModelSettings* S(const m2d_settings* s) { return s ? s->settings.get() : nullptr; }
const fw::Motion* Mo(const m2d_motion* m) { return m ? m->motion.get() : nullptr; }
const fw::Expression* Ex(const m2d_expression* e) { return e ? e->expression.get() : nullptr; }
const fw::WavSound* So(const m2d_sound* s) { return s ? s->sound.get() : nullptr; }
const fw::PhysicsFile* Ph(const m2d_physics* p) { return p ? p->physics.get() : nullptr; }
const fw::PoseFile* Po(const m2d_pose* p) { return p ? p->pose.get() : nullptr; }
fw::Animator* A(m2d_animator* a) { return a ? a->animator : nullptr; }
const fw::Animator* A(const m2d_animator* a) { return a ? a->animator : nullptr; }

template <class V>
int32_t count_of(const V& v) {
  return static_cast<int32_t>(v.size());
}

const char* c_str_or_null(const String& s) { return s.empty() ? nullptr : s.c_str(); }

bool* effect_flag(fw::EffectSwitches& on, m2d_effect e) {
  switch (e) {
    case M2D_EFFECT_IDLE: return &on.idle;
    case M2D_EFFECT_EYE_BLINK: return &on.eye_blink;
    case M2D_EFFECT_EXPRESSIONS: return &on.expressions;
    case M2D_EFFECT_LOOK: return &on.look;
    case M2D_EFFECT_BREATH: return &on.breath;
    case M2D_EFFECT_PHYSICS: return &on.physics;
    case M2D_EFFECT_LIP_SYNC: return &on.lip_sync;
    case M2D_EFFECT_POSE: return &on.pose;
    case M2D_EFFECT_MOTION_SYNC: return &on.motion_sync;
  }
  return nullptr;
}

fw::MotionStart motion_start(const m2d_motion_start* s) {
  fw::MotionStart out;
  if (!s) return out;
  out.priority = s->priority;
  if (!std::isnan(s->fade_in)) out.fade_in = s->fade_in;
  if (!std::isnan(s->fade_out)) out.fade_out = s->fade_out;
  out.weight = s->weight;
  out.offset = s->offset;
  out.loop = s->loop != 0;
  out.loop_fade_in = s->loop_fade_in != 0;
  out.legacy_loop = s->legacy_loop != 0;
  out.hold = s->hold != 0;
  out.blink_while_held = s->blink_while_held != 0;
  return out;
}

double js_mix(double live, double current, const char* id, void* user) {
  auto* a = static_cast<m2d_animator*>(user);
  return a->mix ? a->mix(live, current, id, a->live_user) : kNaN;
}

void release_unbound_input(m2d_animator& h);

/** Binds a motion's linked sound (bindMotionSound); `failure` the first decode failure, else null. */
void bind_sync(m2d_animator& h, uint32_t ticket, const std::shared_ptr<const fw::MotionSyncSound>& sound,
               const String& setting, const String& path, m2d_audio_clock clock, void* clock_user,
               const String* failure) {
  CClock* c = h.next_clock(clock, clock_user);
  // A new binding holds the clock slot now.
  if (h.sync->bind_motion_sound(ticket, path, sound, failure, setting, c)) h.took_clock();
  release_unbound_input(h);
}

void after_frame(m2d_animator& h);

/** The live input the animator keeps alive, released once the driver no longer reads it. */
void release_unbound_input(m2d_animator& h) {
  const fw::MotionSyncDriver* d = h.animator->motion_sync ? &*h.animator->motion_sync : nullptr;
  if (h.sync_input && (!d || d->input() != h.sync_input.get())) h.sync_input.reset();
}

}  // namespace

namespace {

/** m2d_sound_unusable: a sound handle without a sound. */
m2d_sound unusable_sound;

}  // namespace

/** A package: the framework's Package over the host's callbacks, with the handles it hands out. */
struct m2d_package final : fw::FileSource {
  Heap heap;
  m2d_file_source source{};
  String label_text;
  fw::Package package;
  m2d_model* model = nullptr;
  m2d_settings* settings = nullptr;
  m2d_physics* physics = nullptr;
  m2d_pose* pose = nullptr;
  m2d_user_data* user_data = nullptr;
  m2d_display_info* display_info = nullptr;
  m2d_motion_sync* motion_sync = nullptr;
  /** Handles by resolved path. */
  HashMap<String, m2d_motion_sync_sound*> sync_sounds;
  HashMap<String, m2d_motion*> motions;
  HashMap<String, m2d_expression*> expressions;
  HashMap<String, m2d_sound*> sounds;

  ~m2d_package() override {
    destroy(model);
    destroy(settings);
    destroy(physics);
    destroy(pose);
    destroy(user_data);
    destroy(display_info);
    destroy(motion_sync);
    for (auto& [k, h] : sync_sounds) destroy(h);
    for (auto& [k, h] : motions) destroy(h);
    for (auto& [k, h] : expressions) destroy(h);
    for (auto& [k, h] : sounds)
      if (h != &unusable_sound) destroy(h);
  }
  String label() const override { return label_text; }
  bool list(Vector<String>& out) const override {
    if (!source.list) return false;
    out.clear();
    auto add = [](const char* path, void* context) {
      if (path) static_cast<Vector<String>*>(context)->push_back(String(path));
    };
    return source.list(add, &out, source.user) != 0;
  }
  bool read(const String& path, String& bytes) override {
    const void* data = nullptr;
    size_t size = 0;
    if (!source.read || !source.read(path.c_str(), &data, &size, source.user)) return false;
    if (data || size == 0) bytes.assign(static_cast<const char*>(data), data ? size : 0);
    if (source.release) source.release(data, size, source.user);
    return data != nullptr || size == 0;
  }
};

namespace {
fw::LiveLipSyncSettings live_settings(const m2d_live_input_settings* s) {
  fw::LiveLipSyncSettings out = fw::kLiveLipSyncDefaults;
  if (s) out = {s->gain, s->gate, s->attack, s->release};
  return out;
}
fw::LiveLipSyncInput* L(m2d_live_input* i) { return i ? i->input.get() : nullptr; }
const fw::LiveLipSyncInput* Lc(const m2d_live_input* i) { return i ? i->input.get() : nullptr; }
}  // namespace

extern "C" {

// ------------------------------------------------------------------ settings

m2d_status m2d_settings_parse(const void* bytes, size_t size, const char* label, const m2d_allocator* allocator,
                              m2d_settings** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!check_out(bytes, size, out, error)) return M2D_INVALID_ARGUMENT;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  auto settings = std::allocate_shared<fw::ModelSettings>(Allocator<fw::ModelSettings>());
  String message;
  if (!fw::parse_model_settings(view(bytes, size), String(label_or(label, "model settings")), *settings, message))
    return file_error(error, message);
  m2d_settings* h = create<m2d_settings>();
  if (!h) {
    set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
    return M2D_OUT_OF_MEMORY;
  }
  h->heap = heap;
  h->settings = std::move(settings);
  *out = h;
  return M2D_OK;
}

void m2d_settings_destroy(m2d_settings* settings) { destroy_handle(settings); }

const char* m2d_settings_moc(const m2d_settings* settings) { return S(settings) ? S(settings)->moc.c_str() : nullptr; }
int32_t m2d_settings_texture_count(const m2d_settings* settings) {
  return S(settings) ? count_of(S(settings)->textures) : 0;
}
const char* m2d_settings_texture(const m2d_settings* settings, int32_t i) {
  const auto* s = S(settings);
  return s && in(i, s->textures.size()) ? s->textures[static_cast<std::size_t>(i)].c_str() : nullptr;
}
const char* m2d_settings_file(const m2d_settings* settings, m2d_file_kind which) {
  const auto* s = S(settings);
  if (!s) return nullptr;
  switch (which) {
    case M2D_SETTINGS_PHYSICS: return c_str_or_null(s->physics);
    case M2D_SETTINGS_POSE: return c_str_or_null(s->pose);
    case M2D_SETTINGS_USER_DATA: return c_str_or_null(s->user_data);
    case M2D_SETTINGS_DISPLAY_INFO: return c_str_or_null(s->display_info);
    case M2D_SETTINGS_MOTION_SYNC: return c_str_or_null(s->motion_sync);
  }
  return nullptr;
}
int32_t m2d_settings_expression_count(const m2d_settings* settings) {
  return S(settings) ? count_of(S(settings)->expressions) : 0;
}
const char* m2d_settings_expression_name(const m2d_settings* settings, int32_t i) {
  const auto* s = S(settings);
  return s && in(i, s->expressions.size()) ? s->expressions[static_cast<std::size_t>(i)].name.c_str() : nullptr;
}
const char* m2d_settings_expression_file(const m2d_settings* settings, int32_t i) {
  const auto* s = S(settings);
  return s && in(i, s->expressions.size()) ? s->expressions[static_cast<std::size_t>(i)].file.c_str() : nullptr;
}
int32_t m2d_settings_motion_group_count(const m2d_settings* settings) {
  return S(settings) ? count_of(S(settings)->motions) : 0;
}
const char* m2d_settings_motion_group_name(const m2d_settings* settings, int32_t g) {
  const auto* s = S(settings);
  return s && in(g, s->motions.size()) ? s->motions[static_cast<std::size_t>(g)].group.c_str() : nullptr;
}
int32_t m2d_settings_motion_group_index(const m2d_settings* settings, const char* name) {
  const auto* s = S(settings);
  if (!s || !name) return -1;
  for (std::size_t g = 0; g < s->motions.size(); g++)
    if (s->motions[g].group == name) return static_cast<int32_t>(g);
  return -1;
}
int32_t m2d_settings_motion_count(const m2d_settings* settings, int32_t g) {
  const auto* s = S(settings);
  return s && in(g, s->motions.size()) ? count_of(s->motions[static_cast<std::size_t>(g)].entries) : 0;
}
m2d_status m2d_settings_motion(const m2d_settings* settings, int32_t g, int32_t i, m2d_motion_entry* out) {
  const auto* s = S(settings);
  if (!s || !out || !in(g, s->motions.size())) return M2D_INVALID_ARGUMENT;
  const auto& entries = s->motions[static_cast<std::size_t>(g)].entries;
  if (!in(i, entries.size())) return M2D_INVALID_ARGUMENT;
  const fw::MotionEntry& e = entries[static_cast<std::size_t>(i)];
  out->file = e.file.c_str();
  out->sound = c_str_or_null(e.sound);
  out->fade_in = e.fade_in_time.value_or(kNaN);
  out->fade_out = e.fade_out_time.value_or(kNaN);
  out->motion_sync = c_str_or_null(e.motion_sync);
  return M2D_OK;
}
int32_t m2d_settings_group_id_count(const m2d_settings* settings, const char* name) {
  const auto* s = S(settings);
  if (!s || !name) return 0;
  for (const auto& g : s->groups)
    if (g.name == name) return count_of(g.ids);
  return 0;
}
const char* m2d_settings_group_id(const m2d_settings* settings, const char* name, int32_t i) {
  const auto* s = S(settings);
  if (!s || !name) return nullptr;
  for (const auto& g : s->groups)
    if (g.name == name) return in(i, g.ids.size()) ? g.ids[static_cast<std::size_t>(i)].c_str() : nullptr;
  return nullptr;
}
int32_t m2d_settings_hit_area_count(const m2d_settings* settings) {
  return S(settings) ? count_of(S(settings)->hit_areas) : 0;
}
const char* m2d_settings_hit_area_id(const m2d_settings* settings, int32_t i) {
  const auto* s = S(settings);
  return s && in(i, s->hit_areas.size()) ? s->hit_areas[static_cast<std::size_t>(i)].id.c_str() : nullptr;
}
const char* m2d_settings_hit_area_name(const m2d_settings* settings, int32_t i) {
  const auto* s = S(settings);
  return s && in(i, s->hit_areas.size()) ? s->hit_areas[static_cast<std::size_t>(i)].name.c_str() : nullptr;
}
int32_t m2d_settings_layout(const m2d_settings* settings, const char* key, double* value) {
  const auto* s = S(settings);
  if (!s || !key) return 0;
  for (const auto& [k, v] : s->layout)
    if (k == key) {
      if (value) *value = v;
      return 1;
    }
  return 0;
}

// ---------------------------------------------------------------- motions

m2d_status m2d_motion_parse(const void* bytes, size_t size, const char* label, const m2d_allocator* allocator,
                            m2d_motion** out, m2d_error* error) {
  return parse_shared<m2d_motion, fw::Motion>(bytes, size, label, "motion", allocator, out, error, &m2d_motion::motion,
                                              [](std::string_view b, const char* l, fw::Motion& m, fw::FormatError& e) {
                                                return fw::parse_motion(b, l, m, e);
                                              });
}
void m2d_motion_destroy(m2d_motion* motion) { destroy_handle(motion); }
double m2d_motion_duration(const m2d_motion* m) { return Mo(m) ? Mo(m)->duration : 0; }
double m2d_motion_fps(const m2d_motion* m) { return Mo(m) ? Mo(m)->fps : 0; }
double m2d_motion_fade_in(const m2d_motion* m) { return Mo(m) ? Mo(m)->fade_in : 0; }
double m2d_motion_fade_out(const m2d_motion* m) { return Mo(m) ? Mo(m)->fade_out : 0; }
int32_t m2d_motion_curve_count(const m2d_motion* m) { return Mo(m) ? count_of(Mo(m)->curves) : 0; }
int32_t m2d_motion_ignored_curve_count(const m2d_motion* m) {
  return Mo(m) ? static_cast<int32_t>(Mo(m)->ignored_curves) : 0;
}
int32_t m2d_motion_event_count(const m2d_motion* m) { return Mo(m) ? count_of(Mo(m)->events) : 0; }
double m2d_motion_event_time(const m2d_motion* m, int32_t i) {
  return Mo(m) && in(i, Mo(m)->events.size()) ? Mo(m)->events[static_cast<std::size_t>(i)].time : 0;
}
const char* m2d_motion_event_value(const m2d_motion* m, int32_t i) {
  return Mo(m) && in(i, Mo(m)->events.size()) ? Mo(m)->events[static_cast<std::size_t>(i)].value.c_str() : nullptr;
}

// ------------------------------------------------------------- expressions

m2d_status m2d_expression_parse(const void* bytes, size_t size, const char* label, const m2d_allocator* allocator,
                                m2d_expression** out, m2d_error* error) {
  return parse_shared<m2d_expression, fw::Expression>(
      bytes, size, label, "expression", allocator, out, error, &m2d_expression::expression,
      [](std::string_view b, const char* l, fw::Expression& x, fw::FormatError& e) {
        return fw::parse_expression(b, l, x, e);
      });
}
void m2d_expression_destroy(m2d_expression* expression) { destroy_handle(expression); }
const char* m2d_expression_label(const m2d_expression* e) { return Ex(e) ? Ex(e)->label.c_str() : nullptr; }
double m2d_expression_fade_in(const m2d_expression* e) { return Ex(e) ? Ex(e)->fade_in : 0; }
double m2d_expression_fade_out(const m2d_expression* e) { return Ex(e) ? Ex(e)->fade_out : 0; }
int32_t m2d_expression_parameter_count(const m2d_expression* e) { return Ex(e) ? count_of(Ex(e)->parameters) : 0; }

// ----------------------------------------------------------------- sounds

m2d_status m2d_sound_decode(const void* bytes, size_t size, const m2d_allocator* allocator, m2d_sound** out,
                            m2d_error* error) {
  if (out) *out = nullptr;
  if (!check_out(bytes, size, out, error)) return M2D_INVALID_ARGUMENT;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  auto sound = std::allocate_shared<fw::WavSound>(Allocator<fw::WavSound>());
  String message;
  if (!fw::decode_wav(static_cast<const uint8_t*>(bytes), bytes ? size : 0, *sound, message))
    return file_error(error, message);
  m2d_sound* h = create<m2d_sound>();
  if (!h) {
    set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
    return M2D_OUT_OF_MEMORY;
  }
  h->heap = heap;
  h->sound = std::move(sound);
  *out = h;
  return M2D_OK;
}
void m2d_sound_destroy(m2d_sound* sound) {
  if (sound != &unusable_sound) destroy_handle(sound);
}
int32_t m2d_sound_channels(const m2d_sound* s) { return So(s) ? static_cast<int32_t>(So(s)->channels) : 0; }
double m2d_sound_sample_rate(const m2d_sound* s) { return So(s) ? So(s)->sample_rate : 0; }
int32_t m2d_sound_bits_per_sample(const m2d_sound* s) { return So(s) ? static_cast<int32_t>(So(s)->bits_per_sample) : 0; }
double m2d_sound_frames(const m2d_sound* s) { return So(s) ? So(s)->frames : 0; }

// ----------------------------------------------------------- physics, pose

m2d_status m2d_physics_parse(const void* bytes, size_t size, const char* label, const m2d_allocator* allocator,
                             m2d_physics** out, m2d_error* error) {
  return parse_shared<m2d_physics, fw::PhysicsFile>(
      bytes, size, label, "physics", allocator, out, error, &m2d_physics::physics,
      [](std::string_view b, const char* l, fw::PhysicsFile& p, fw::FormatError& e) {
        return fw::parse_physics(b, l, p, e);
      });
}
void m2d_physics_destroy(m2d_physics* physics) { destroy_handle(physics); }
double m2d_physics_fps(const m2d_physics* p) { return Ph(p) ? Ph(p)->fps : 0; }
int32_t m2d_physics_setting_count(const m2d_physics* p) { return Ph(p) ? count_of(Ph(p)->settings) : 0; }
const char* m2d_physics_setting_id(const m2d_physics* p, int32_t i) {
  return Ph(p) && in(i, Ph(p)->settings.size()) ? Ph(p)->settings[static_cast<std::size_t>(i)].id.c_str() : nullptr;
}
const char* m2d_physics_setting_name(const m2d_physics* p, int32_t i) {
  const auto* f = Ph(p);
  if (!f || !in(i, f->settings.size())) return nullptr;
  const String& id = f->settings[static_cast<std::size_t>(i)].id;
  for (const auto& n : f->names)
    if (n.id == id) return n.name.c_str();
  return nullptr;
}

m2d_status m2d_pose_parse(const void* bytes, size_t size, const char* label, const m2d_allocator* allocator,
                          m2d_pose** out, m2d_error* error) {
  return parse_shared<m2d_pose, fw::PoseFile>(bytes, size, label, "pose", allocator, out, error, &m2d_pose::pose,
                                              [](std::string_view b, const char* l, fw::PoseFile& p, fw::FormatError& e) {
                                                return fw::parse_pose(b, l, p, e);
                                              });
}
void m2d_pose_destroy(m2d_pose* pose) { destroy_handle(pose); }
double m2d_pose_fade(const m2d_pose* p) { return Po(p) ? Po(p)->fade : 0; }
int32_t m2d_pose_group_count(const m2d_pose* p) { return Po(p) ? count_of(Po(p)->groups) : 0; }

// ------------------------------------------------- user data, display info

m2d_status m2d_user_data_parse(const void* bytes, size_t size, const char* label, const m2d_allocator* allocator,
                               m2d_user_data** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!check_out(bytes, size, out, error)) return M2D_INVALID_ARGUMENT;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  fw::UserData data;
  fw::FormatError err;
  if (!fw::parse_user_data(view(bytes, size), label_or(label, "user data"), data, err)) return file_error(error, err.message);
  m2d_user_data* h = create<m2d_user_data>();
  if (!h) {
    set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
    return M2D_OUT_OF_MEMORY;
  }
  h->heap = heap;
  h->data = std::move(data);
  *out = h;
  return M2D_OK;
}
void m2d_user_data_destroy(m2d_user_data* data) { destroy_handle(data); }
int32_t m2d_user_data_count(const m2d_user_data* d) { return d ? count_of(d->data.all) : 0; }
const char* m2d_user_data_target(const m2d_user_data* d, int32_t i) {
  return d && in(i, d->data.all.size()) ? d->data.all[static_cast<std::size_t>(i)].target.c_str() : nullptr;
}
const char* m2d_user_data_id(const m2d_user_data* d, int32_t i) {
  return d && in(i, d->data.all.size()) ? d->data.all[static_cast<std::size_t>(i)].id.c_str() : nullptr;
}
const char* m2d_user_data_value(const m2d_user_data* d, int32_t i) {
  return d && in(i, d->data.all.size()) ? d->data.all[static_cast<std::size_t>(i)].value.c_str() : nullptr;
}

m2d_status m2d_display_info_parse(const void* bytes, size_t size, const char* label, const m2d_allocator* allocator,
                                  m2d_display_info** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!check_out(bytes, size, out, error)) return M2D_INVALID_ARGUMENT;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  fw::DisplayInfo info;
  fw::FormatError err;
  if (!fw::parse_display_info(view(bytes, size), label_or(label, "display info"), info, err))
    return file_error(error, err.message);
  m2d_display_info* h = create<m2d_display_info>();
  if (!h) {
    set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
    return M2D_OUT_OF_MEMORY;
  }
  h->heap = heap;
  h->info = std::move(info);
  *out = h;
  return M2D_OK;
}
void m2d_display_info_destroy(m2d_display_info* info) { destroy_handle(info); }

int32_t m2d_display_label_count(const m2d_model* model, m2d_display_kind kind) {
  const auto* m = M(model);
  if (!m) return 0;
  return kind == M2D_DISPLAY_PARTS ? count_of(m->parts.ids) : count_of(m->parameters.ids);
}

m2d_status m2d_display_label(const m2d_display_info* info, const m2d_model* model, m2d_display_kind kind, int32_t row,
                             int32_t* index, const char** label, const char** group) {
  const auto* m = M(model);
  if (!m) return M2D_INVALID_ARGUMENT;
  const Vector<String>& ids = kind == M2D_DISPLAY_PARTS ? m->parts.ids : m->parameters.ids;
  if (!in(row, ids.size())) return M2D_INVALID_ARGUMENT;
  // The labels are computed in the model's heap; the strings returned point
  // into the model and the display info, which outlive the call.
  HeapScope scope(&model->heap);
  const auto labels = fw::display_labels(ids, info ? &info->info : nullptr,
                                         kind == M2D_DISPLAY_PARTS ? fw::DisplayKind::Parts : fw::DisplayKind::Parameters);
  const fw::DisplayLabel& l = labels[static_cast<std::size_t>(row)];
  if (index) *index = static_cast<int32_t>(l.index);
  // The same names, from the model and the display info (which outlive the call).
  const char* name = ids[l.index].c_str();
  const char* group_name = nullptr;
  if (info) {
    const auto& list = kind == M2D_DISPLAY_PARTS ? info->info.parts : info->info.parameters;
    for (const auto& e : list)
      if (e.id == l.id) {
        if (!e.name.empty()) name = e.name.c_str();
        if (l.group)
          for (const auto& g : info->info.parameter_groups)
            if (g.id == e.group_id) {
              group_name = g.name.empty() ? g.id.c_str() : g.name.c_str();
              break;
            }
        break;
      }
  }
  if (label) *label = name;
  if (group) *group = group_name;
  return M2D_OK;
}

// ----------------------------------------------------------------- animator

void m2d_animator_options_default(m2d_animator_options* o) {
  if (!o) return;
  *o = m2d_animator_options{};
  o->gravity[0] = 0;
  o->gravity[1] = -1;
  o->blink_timing[0] = 4;
  o->blink_timing[1] = 0.1;
  o->blink_timing[2] = 0.05;
  o->blink_timing[3] = 0.15;
  o->lip_sync_fallback = "ParamMouthOpenY";
}

const char* m2d_animator_lip_sync_fallback(const m2d_animator* animator) {
  return A(animator) && !A(animator)->lip_sync_fallback.empty() ? A(animator)->lip_sync_fallback.c_str() : nullptr;
}

m2d_status m2d_animator_create(m2d_model* model, const m2d_settings* settings, const m2d_physics* physics,
                               const m2d_pose* pose, const m2d_animator_options* options, m2d_animator** out,
                               m2d_error* error) {
  if (out) *out = nullptr;
  if (!M(model) || !out) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  m2d_animator_options defaults;
  m2d_animator_options_default(&defaults);
  const m2d_animator_options& o = options ? *options : defaults;
  HeapScope scope(&model->heap);
  m2d_animator* h = create<m2d_animator>();
  if (!h) {
    set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
    return M2D_OUT_OF_MEMORY;
  }
  h->heap = model->heap;
  h->model = model->model;
  h->settings = settings ? settings->settings : std::allocate_shared<fw::ModelSettings>(Allocator<fw::ModelSettings>());
  if (physics) h->physics = physics->physics;
  if (pose) h->pose = pose->pose;
  h->random = o.random;
  h->random_user = o.random_user;
  fw::AnimatorOptions ao;
  ao.wrap = o.wrap != 0;
  ao.settle = o.settle != 0;
  ao.gravity = std::make_pair(o.gravity[0], o.gravity[1]);
  ao.wind = std::make_pair(o.wind[0], o.wind[1]);
  h->wind[0] = o.wind[0];
  h->wind[1] = o.wind[1];
  ao.eye_blink.interval = o.blink_timing[0];
  ao.eye_blink.closing = o.blink_timing[1];
  ao.eye_blink.closed = o.blink_timing[2];
  ao.eye_blink.opening = o.blink_timing[3];
  ao.random = o.random ? static_cast<fw::RandomSource*>(h) : nullptr;
  ao.idle = h;
  if (o.lip_sync_fallback) ao.lip_sync_fallback = String(o.lip_sync_fallback);
  h->animator = create<fw::Animator>(h->model, *h->settings, h->physics.get(), h->pose.get(), ao);
  if (!h->animator) {
    destroy(h);
    set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
    return M2D_OUT_OF_MEMORY;
  }
  if (!h->animator->ok()) {
    const fw::Fault fault = h->animator->fault();
    destroy(h);
    set_error(error, M2D_FRAME_ERROR, "type-error", fault.message.c_str());
    return M2D_FRAME_ERROR;
  }
  h->sync = create<fw::MotionSyncRuntime>(*h->animator);
  if (!h->sync) {
    destroy(h);
    set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
    return M2D_OUT_OF_MEMORY;
  }
  *out = h;
  return M2D_OK;
}

void m2d_animator_destroy(m2d_animator* animator) { destroy_handle(animator); }

}  // extern "C"

namespace {

/** Mochi2D's animate() after its frame: an idle start's linked sound, then the motion-sync bookkeeping. */
void after_frame(m2d_animator& h) {
  fw::Animator& a = *h.animator;
  if (h.pending_sync) {
    const auto p = std::move(*h.pending_sync);
    h.pending_sync.reset();
    bool playing = false;
    for (const auto& m : a.motions.motions())
      if (m == p.motion) playing = true;
    if (playing && p.index < h.idle_sync.size()) {
      const auto& link = h.idle_sync[p.index];
      bind_sync(h, p.ticket, link.sound, link.setting, link.path, link.clock, link.clock_user, nullptr);
    }
  }
  h.sync->after_frame(h.last.ends);
}

}  // namespace

extern "C" {

m2d_status m2d_animator_frame(m2d_animator* animator, double dt, m2d_frame* out, m2d_error* error) {
  fw::Animator* a = A(animator);
  if (out) *out = m2d_frame{};
  if (!a) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL animator");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  HeapScope scope(&animator->heap);
  fw::Fault fault;
  animator->pending_sync.reset();
  if (!a->frame(dt, animator->last, fault)) {
    animator->last = fw::FrameResult();
    animator->pending_sync.reset();
    const char* code = fault.kind == "RandomExhaustedError" ? "random-exhausted"
                       : fault.kind == "RangeError"         ? "random-range"
                                                            : "type-error";
    set_error(error, M2D_FRAME_ERROR, code, fault.message.c_str());
    return M2D_FRAME_ERROR;
  }
  after_frame(*animator);
  if (out) {
    const fw::FrameResult& r = animator->last;
    out->motion_updated = r.motion_updated ? 1 : 0;
    out->queue_empty = r.queue_empty ? 1 : 0;
    out->has_lip_sync = r.lip_sync ? 1 : 0;
    out->lip_sync = r.lip_sync.value_or(0);
    out->event_count = count_of(r.events);
    out->end_count = count_of(r.ends);
  }
  return M2D_OK;
}

m2d_status m2d_animator_apply(const m2d_animator* animator, m2d_instance* instance) {
  const fw::Animator* a = A(animator);
  eval::Instance* inst = Im(instance);
  if (!a || !inst || &inst->model() != animator->model.get()) return M2D_INVALID_ARGUMENT;
  a->apply_to(*inst);
  return M2D_OK;
}

m2d_status m2d_animator_update(m2d_animator* animator, m2d_instance* instance, double dt, m2d_frame* out,
                               m2d_error* error) {
  if (!A(animator) || !Im(instance) || &Im(instance)->model() != animator->model.get()) {
    if (out) *out = m2d_frame{};
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL animator or instance of another model");
    return M2D_INVALID_ARGUMENT;
  }
  const m2d_status s = m2d_animator_frame(animator, dt, out, error);
  if (s != M2D_OK) return s;
  m2d_animator_apply(animator, instance);
  return m2d_instance_evaluate(instance, error);
}

const char* m2d_animator_event(const m2d_animator* animator, int32_t i) {
  return animator && in(i, animator->last.events.size()) ? animator->last.events[static_cast<std::size_t>(i)].c_str()
                                                         : nullptr;
}

m2d_status m2d_animator_end(const m2d_animator* animator, int32_t i, uint32_t* ticket, m2d_motion_end_reason* reason) {
  if (!animator || !in(i, animator->last.ends.size())) return M2D_INVALID_ARGUMENT;
  const fw::MotionEnded& e = animator->last.ends[static_cast<std::size_t>(i)];
  if (ticket) *ticket = e.ticket;
  if (reason)
    *reason = e.reason == fw::MotionEndReason::Finished   ? M2D_MOTION_FINISHED
              : e.reason == fw::MotionEndReason::Replaced ? M2D_MOTION_REPLACED
                                                          : M2D_MOTION_STOPPED;
  return M2D_OK;
}

void m2d_motion_start_default(m2d_motion_start* s) {
  if (!s) return;
  s->priority = 2;
  s->fade_in = kNaN;
  s->fade_out = kNaN;
  s->weight = 1;
  s->offset = 0;
  s->loop = 0;
  s->loop_fade_in = 1;
  s->legacy_loop = 0;
  s->hold = 0;
  s->blink_while_held = 1;
}

int32_t m2d_animator_start_motion(m2d_animator* animator, const m2d_motion* motion, const m2d_motion_start* start,
                                  const m2d_sound* sound) {
  fw::Animator* a = A(animator);
  if (!a) return 0;
  HeapScope scope(&animator->heap);
  fw::ResolvedMotion r;
  r.motion = motion ? motion->motion : nullptr;
  if (sound) {
    r.has_sound = true;
    r.sound = sound->sound;
  }
  return a->start_motion(r, motion_start(start)) ? 1 : 0;
}

int32_t m2d_animator_accepts(const m2d_animator* animator, double priority) {
  return A(animator) && A(animator)->motions.accepts(priority) ? 1 : 0;
}
void m2d_animator_stop_motions(m2d_animator* animator) {
  if (!A(animator)) return;
  HeapScope scope(&animator->heap);
  A(animator)->stop_motions();
}
int32_t m2d_animator_motion_count(const m2d_animator* animator) {
  return A(animator) ? static_cast<int32_t>(A(animator)->motions.size()) : 0;
}
uint32_t m2d_animator_last_ticket(const m2d_animator* animator) {
  return A(animator) ? A(animator)->motions.last_ticket : 0;
}

m2d_status m2d_animator_set_idle_motions(m2d_animator* animator, const m2d_idle_motion* motions, int32_t count) {
  fw::Animator* a = A(animator);
  if (!a || count < 0 || (count > 0 && !motions)) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  animator->idle.clear();
  for (int32_t i = 0; i < count; i++) {
    const m2d_idle_motion& m = motions[i];
    animator->idle.push_back(
        {m.motion ? m.motion->motion : nullptr, m.sound != nullptr, m.sound ? m.sound->sound : nullptr, m.fade_in, m.fade_out});
  }
  a->idle_count = animator->idle.size();
  a->enabled.idle = a->idle_count > 0;
  return M2D_OK;
}

m2d_status m2d_animator_start_expression(m2d_animator* animator, const m2d_expression* expression) {
  fw::Animator* a = A(animator);
  if (!a || !expression) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  a->start_expression(expression->expression);
  return M2D_OK;
}

int32_t m2d_animator_add_expression_layer(m2d_animator* animator, const m2d_expression* expression) {
  fw::Animator* a = A(animator);
  if (!a || !expression) return 0;
  HeapScope scope(&animator->heap);
  return a->expression_layers.add(expression->expression) ? 1 : 0;
}

int32_t m2d_animator_remove_expression_layers(m2d_animator* animator, const char* label) {
  return m2d_animator_remove_expression_layers_fade(animator, label, std::numeric_limits<double>::quiet_NaN());
}

namespace {
/** A fade time a call gives: NaN for none (the expression's), else finite and ≥ 0. */
bool fade_ok(double t) { return std::isnan(t) || (std::isfinite(t) && t >= 0); }
/** The expression with the call's fade times (a copy, when there are any; 0.13.0 withFades). */
std::shared_ptr<const fw::Expression> with_fades(const std::shared_ptr<const fw::Expression>& e, double fade_in,
                                                 double fade_out) {
  if (std::isnan(fade_in) && std::isnan(fade_out)) return e;
  auto copy = std::allocate_shared<fw::Expression>(Allocator<fw::Expression>(), *e);
  if (!std::isnan(fade_in)) copy->fade_in = fade_in;
  if (!std::isnan(fade_out)) copy->fade_out = fade_out;
  return copy;
}
}  // namespace

m2d_status m2d_animator_start_expression_fades(m2d_animator* animator, const m2d_expression* expression,
                                               double fade_in, double fade_out) {
  fw::Animator* a = A(animator);
  if (!a || !expression || !fade_ok(fade_in) || !fade_ok(fade_out)) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  a->start_expression(with_fades(expression->expression, fade_in, fade_out));
  return M2D_OK;
}

m2d_status m2d_animator_clear_expression(m2d_animator* animator, double fade_out) {
  fw::Animator* a = A(animator);
  if (!a || !fade_ok(fade_out)) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  const auto list = a->expressions.expressions();
  if (list.empty()) return M2D_OK;
  // 0.13.0 clearExpression: an empty expression with the newest one's fade-out, or the one given.
  const double t = std::isnan(fade_out) ? list.back()->fade_out : fade_out;
  auto none = std::allocate_shared<fw::Expression>(Allocator<fw::Expression>());
  none->label = "(none)";
  none->fade_in = t;
  none->fade_out = t;
  a->start_expression(std::move(none));
  return M2D_OK;
}

int32_t m2d_animator_add_expression_layer_fades(m2d_animator* animator, const m2d_expression* expression,
                                                double fade_in, double fade_out) {
  fw::Animator* a = A(animator);
  if (!a || !expression || !fade_ok(fade_in) || !fade_ok(fade_out)) return -1;
  HeapScope scope(&animator->heap);
  return a->expression_layers.add(with_fades(expression->expression, fade_in, fade_out)) ? 1 : 0;
}

int32_t m2d_animator_remove_expression_layers_fade(m2d_animator* animator, const char* label, double fade_out) {
  fw::Animator* a = A(animator);
  if (!a || !fade_ok(fade_out)) return 0;
  HeapScope scope(&animator->heap);
  const double* out = std::isnan(fade_out) ? nullptr : &fade_out;
  if (!label) return static_cast<int32_t>(a->expression_layers.remove(nullptr, out));
  const String l(label);
  return static_cast<int32_t>(a->expression_layers.remove(&l, out));
}

void m2d_animator_set_look_target(m2d_animator* animator, double x, double y) {
  if (A(animator)) A(animator)->set_look_target(x, y);
}

m2d_status m2d_animator_start_sound(m2d_animator* animator, const m2d_sound* sound) {
  fw::Animator* a = A(animator);
  if (!a || !a->lip_sync) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  a->start_sound(sound ? sound->sound : nullptr);
  return M2D_OK;
}

m2d_status m2d_animator_set_live_lip_sync(m2d_animator* animator, double (*next)(double, void*), m2d_lip_sync_mix mode,
                                          double (*mix)(double, double, const char*, void*), void* user) {
  fw::Animator* a = A(animator);
  if (!a || !a->lip_sync) return M2D_INVALID_ARGUMENT;
  animator->input.reset();
  animator->live = next;
  animator->mix = mix;
  animator->live_user = user;
  const fw::LiveLipSyncMix m = mode == M2D_LIP_SYNC_REPLACE    ? fw::LiveLipSyncMix::Replace
                               : mode == M2D_LIP_SYNC_MAX      ? fw::LiveLipSyncMix::Max
                               : mode == M2D_LIP_SYNC_FUNCTION ? fw::LiveLipSyncMix::Function
                                                               : fw::LiveLipSyncMix::Add;
  a->set_live_lip_sync(next ? animator : nullptr, m);
  a->lip_sync->mix_function = js_mix;
  a->lip_sync->mix_user = animator;
  return M2D_OK;
}

m2d_status m2d_animator_set_live_input(m2d_animator* animator, m2d_live_input* input, m2d_lip_sync_mix mode,
                                      double (*mix)(double, double, const char*, void*), void* user) {
  fw::Animator* a = A(animator);
  if (!a || !a->lip_sync) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  animator->live = nullptr;
  animator->input = input ? input->input : nullptr;
  animator->mix = mix;
  animator->live_user = user;
  const fw::LiveLipSyncMix m = mode == M2D_LIP_SYNC_REPLACE    ? fw::LiveLipSyncMix::Replace
                               : mode == M2D_LIP_SYNC_MAX      ? fw::LiveLipSyncMix::Max
                               : mode == M2D_LIP_SYNC_FUNCTION ? fw::LiveLipSyncMix::Function
                                                               : fw::LiveLipSyncMix::Add;
  a->set_live_lip_sync(input ? animator : nullptr, m);
  a->lip_sync->mix_function = js_mix;
  a->lip_sync->mix_user = animator;
  return M2D_OK;
}

m2d_status m2d_animator_set_parameter(m2d_animator* animator, const char* id, double value) {
  fw::Animator* a = A(animator);
  if (!a || !id) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  const int i = a->values.index(String(id));
  if (i < 0) return M2D_INVALID_ARGUMENT;
  a->set_base_parameter(i, value);
  return M2D_OK;
}

double m2d_animator_parameter(const m2d_animator* animator, const char* id) {
  const fw::Animator* a = A(animator);
  if (!a || !id) return 0;
  HeapScope scope(&animator->heap);
  return a->values.get(String(id));
}

double m2d_animator_parameter_base(const m2d_animator* animator, const char* id) {
  const fw::Animator* a = A(animator);
  if (!a || !id) return 0;
  HeapScope scope(&animator->heap);
  const String key(id);
  const int i = a->values.index(key);
  return i < 0 ? a->values.get(key) : a->values.saved[static_cast<std::size_t>(i)];
}

m2d_status m2d_animator_set_idle_weight(m2d_animator* animator, const char* id, double weight) {
  fw::Animator* a = A(animator);
  if (!a || !id || std::isnan(weight)) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  const String key(id);
  if (a->values.index(key) < 0) return M2D_INVALID_ARGUMENT;
  a->motions.set_idle_weight(key, weight);
  return M2D_OK;
}

double m2d_animator_idle_weight(const m2d_animator* animator, const char* id) {
  const fw::Animator* a = A(animator);
  if (!a || !id) return 1;
  HeapScope scope(&animator->heap);
  return a->motions.idle_weight(String(id));
}

void m2d_animator_reset_idle_weights(m2d_animator* animator) {
  fw::Animator* a = A(animator);
  if (!a) return;
  HeapScope scope(&animator->heap);
  a->motions.idle_weights.clear();
}

int32_t m2d_animator_physics_setting_count(const m2d_animator* animator) {
  return animator && animator->physics ? static_cast<int32_t>(animator->physics->settings.size()) : 0;
}

const char* m2d_animator_physics_setting_id(const m2d_animator* animator, int32_t index) {
  if (!animator || !animator->physics || !in(index, animator->physics->settings.size())) return nullptr;
  return animator->physics->settings[static_cast<std::size_t>(index)].id.c_str();
}

const char* m2d_animator_physics_setting_name(const m2d_animator* animator, int32_t index) {
  if (!animator || !animator->physics || !in(index, animator->physics->settings.size())) return nullptr;
  const fw::PhysicsFile& f = *animator->physics;
  const String& id = f.settings[static_cast<std::size_t>(index)].id;
  for (const auto& n : f.names)
    if (n.id == id) return n.name.c_str();
  return id.c_str();
}

m2d_status m2d_animator_set_physics_strength(m2d_animator* animator, double strength) {
  if (!A(animator) || !std::isfinite(strength)) return M2D_INVALID_ARGUMENT;
  animator->physics_strength = strength > 0 ? strength : 0;
  if (A(animator)->physics) A(animator)->physics->strength = animator->physics_strength;
  return M2D_OK;
}

double m2d_animator_physics_strength(const m2d_animator* animator) { return animator ? animator->physics_strength : 1; }

m2d_status m2d_animator_set_physics_setting_strength(m2d_animator* animator, const char* id, double strength) {
  fw::Animator* a = A(animator);
  if (!a || !id || !std::isfinite(strength)) return M2D_INVALID_ARGUMENT;
  if (!a->physics) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  const String key(id);
  const double k = strength > 0 ? strength : 0;
  bool found = false;
  const auto& settings = a->physics->file().settings;
  for (std::size_t i = 0; i < settings.size(); i++)
    if (settings[i].id == key) {
      a->physics->setting_strengths[i] = k;
      found = true;
    }
  if (!found) return M2D_INVALID_ARGUMENT;
  if (k == 1)
    animator->setting_strengths.erase(key);
  else
    animator->setting_strengths[key] = k;
  return M2D_OK;
}

double m2d_animator_physics_setting_strength(const m2d_animator* animator, const char* id) {
  if (!animator || !id) return 1;
  const auto it = animator->setting_strengths.find(String(id));
  return it == animator->setting_strengths.end() ? 1 : it->second;
}

void m2d_animator_reset_physics_strengths(m2d_animator* animator) {
  fw::Animator* a = A(animator);
  if (!a) return;
  HeapScope scope(&animator->heap);
  animator->physics_strength = 1;
  animator->setting_strengths.clear();
  if (a->physics) {
    a->physics->strength = 1;
    std::fill(a->physics->setting_strengths.begin(), a->physics->setting_strengths.end(), 1.0);
  }
}

m2d_status m2d_animator_set_physics_setting_wind(m2d_animator* animator, const char* id, double multiplier) {
  fw::Animator* a = A(animator);
  if (!a || !id || !std::isfinite(multiplier) || !a->physics) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  const String key(id);
  bool found = false;
  const auto& settings = a->physics->file().settings;
  for (std::size_t i = 0; i < settings.size(); i++)
    if (settings[i].id == key) {
      a->physics->setting_winds[i] = multiplier;
      found = true;
    }
  if (!found) return M2D_INVALID_ARGUMENT;
  if (multiplier == 1)
    animator->setting_winds.erase(key);
  else
    animator->setting_winds[key] = multiplier;
  return M2D_OK;
}

double m2d_animator_physics_setting_wind(const m2d_animator* animator, const char* id) {
  if (!animator || !id) return 1;
  const auto it = animator->setting_winds.find(String(id));
  return it == animator->setting_winds.end() ? 1 : it->second;
}

void m2d_animator_reset_physics_setting_winds(m2d_animator* animator) {
  fw::Animator* a = A(animator);
  if (!a) return;
  HeapScope scope(&animator->heap);
  animator->setting_winds.clear();
  if (a->physics) std::fill(a->physics->setting_winds.begin(), a->physics->setting_winds.end(), 1.0);
}

m2d_status m2d_animator_set_physics_wind(m2d_animator* animator, double x, double y) {
  fw::Animator* a = A(animator);
  if (!a || !std::isfinite(x) || !std::isfinite(y)) return M2D_INVALID_ARGUMENT;
  animator->wind[0] = x;
  animator->wind[1] = y;
  if (a->physics) {
    a->physics->wind[0] = x;
    a->physics->wind[1] = y;
  }
  return M2D_OK;
}

void m2d_animator_physics_wind(const m2d_animator* animator, double* x, double* y) {
  if (x) *x = animator ? animator->wind[0] : 0;
  if (y) *y = animator ? animator->wind[1] : 0;
}

void m2d_animator_set_physics_hold(m2d_animator* animator, int32_t on) {
  fw::Animator* a = A(animator);
  if (a && a->physics) a->physics->hold_on_zero_steps = on != 0;
}

m2d_status m2d_animator_set_physics_rate(m2d_animator* animator, double rate) {
  fw::Animator* a = A(animator);
  if (!a || !(std::isfinite(rate) && rate >= 0 && rate <= 1000)) return M2D_INVALID_ARGUMENT;
  animator->has_physics_rate = true;
  animator->physics_rate = rate;
  if (a->physics) a->physics->rate = rate;
  return M2D_OK;
}

void m2d_animator_reset_physics_rate(m2d_animator* animator) {
  fw::Animator* a = A(animator);
  if (!a) return;
  animator->has_physics_rate = false;
  if (a->physics) a->physics->rate.reset();
}

double m2d_animator_physics_rate(const m2d_animator* animator) {
  const fw::Animator* a = A(animator);
  if (!a) return 0;
  if (a->physics) return a->physics->step_rate();
  return animator->has_physics_rate ? animator->physics_rate : 0;
}

namespace {

/** The bytes of a physics state: "M2DPHYS1", the shape's and the data's counts (u32), the shape (i32), the data (f64). */
constexpr char kPhysicsStateMagic[8] = {'M', '2', 'D', 'P', 'H', 'Y', 'S', '1'};

std::size_t physics_state_bytes(const fw::PhysicsState& s) { return 16 + 4 * s.shape.size() + 8 * s.data.size(); }

}  // namespace

size_t m2d_animator_physics_state_size(const m2d_animator* animator) {
  const fw::Animator* a = A(animator);
  if (!a || !a->physics) return 0;
  HeapScope scope(&animator->heap);
  fw::PhysicsState s;
  a->physics->save_state(s);
  return physics_state_bytes(s);
}

m2d_status m2d_animator_save_physics_state(const m2d_animator* animator, void* out, size_t capacity, size_t* written) {
  if (written) *written = 0;
  const fw::Animator* a = A(animator);
  if (!a || !a->physics || !out) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  fw::PhysicsState s;
  a->physics->save_state(s);
  const std::size_t size = physics_state_bytes(s);
  if (capacity < size) return M2D_INVALID_ARGUMENT;
  auto* p = static_cast<unsigned char*>(out);
  std::memcpy(p, kPhysicsStateMagic, 8);
  const uint32_t counts[2] = {static_cast<uint32_t>(s.shape.size()), static_cast<uint32_t>(s.data.size())};
  std::memcpy(p + 8, counts, 8);
  if (!s.shape.empty()) std::memcpy(p + 16, s.shape.data(), 4 * s.shape.size());
  if (!s.data.empty()) std::memcpy(p + 16 + 4 * s.shape.size(), s.data.data(), 8 * s.data.size());
  if (written) *written = size;
  return M2D_OK;
}

m2d_status m2d_animator_restore_physics_state(m2d_animator* animator, const void* state, size_t size, m2d_error* error) {
  fw::Animator* a = A(animator);
  if (!a || (!state && size > 0)) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  if (!a->physics) {
    set_error(error, M2D_INVALID_ARGUMENT, "no-physics", "the model has no physics");
    return M2D_INVALID_ARGUMENT;
  }
  HeapScope scope(&animator->heap);
  const auto* p = static_cast<const unsigned char*>(state);
  fw::PhysicsState s;
  bool ok = size >= 16 && std::memcmp(p, kPhysicsStateMagic, 8) == 0;
  if (ok) {
    uint32_t counts[2];
    std::memcpy(counts, p + 8, 8);
    ok = static_cast<unsigned long long>(counts[0]) * 4 + static_cast<unsigned long long>(counts[1]) * 8 + 16 == size;
    if (ok) {
      s.shape.resize(counts[0]);
      s.data.resize(counts[1]);
      if (counts[0]) std::memcpy(s.shape.data(), p + 16, 4ull * counts[0]);
      if (counts[1]) std::memcpy(s.data.data(), p + 16 + 4ull * counts[0], 8ull * counts[1]);
    }
  }
  if (!ok || !a->physics->restore_state(s)) {
    set_error(error, M2D_INVALID_ARGUMENT, "physics-state", "this physics state was saved from other physics settings");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  return M2D_OK;
}

m2d_status m2d_animator_set_parameter_at(m2d_animator* animator, int32_t index, double value) {
  fw::Animator* a = A(animator);
  if (!a || !in(index, a->values.values.size())) return M2D_INVALID_ARGUMENT;
  a->set_base_parameter(index, value);
  return M2D_OK;
}

void m2d_animator_reset_parameters(m2d_animator* animator) {
  fw::Animator* a = A(animator);
  if (!a) return;
  const auto& defaults = animator->model->parameters.defaults;
  for (std::size_t i = 0; i < defaults.size(); i++) a->set_base_parameter(static_cast<int>(i), defaults[i]);
}

const float* m2d_animator_parameter_values(const m2d_animator* animator) {
  return A(animator) ? A(animator)->values.values.data() : nullptr;
}
const float* m2d_animator_parameter_base_values(const m2d_animator* animator) {
  return A(animator) ? A(animator)->values.saved.data() : nullptr;
}
const float* m2d_animator_part_opacities(const m2d_animator* animator) {
  return A(animator) ? A(animator)->values.part_opacities.data() : nullptr;
}
double m2d_animator_model_opacity(const m2d_animator* animator) {
  return A(animator) ? A(animator)->values.model_opacity : 1;
}

void m2d_animator_set_part_opacity(m2d_animator* animator, const char* id, double value) {
  fw::Animator* a = A(animator);
  if (!a || !id) return;
  HeapScope scope(&animator->heap);
  a->set_part_opacity(String(id), value);
}

double m2d_animator_part_opacity(const m2d_animator* animator, const char* id) {
  const fw::Animator* a = A(animator);
  if (!a || !id) return 1;
  HeapScope scope(&animator->heap);
  return a->values.part_opacity(String(id));
}

m2d_status m2d_animator_set_effect(m2d_animator* animator, m2d_effect effect, int32_t on) {
  fw::Animator* a = A(animator);
  bool* flag = a ? effect_flag(a->enabled, effect) : nullptr;
  if (!flag) return M2D_INVALID_ARGUMENT;
  *flag = on != 0;
  return M2D_OK;
}

int32_t m2d_animator_effect(const m2d_animator* animator, m2d_effect effect) {
  if (!A(animator)) return 0;
  fw::EffectSwitches on = A(animator)->enabled;
  const bool* flag = effect_flag(on, effect);
  return flag && *flag ? 1 : 0;
}

int32_t m2d_animator_has_effect(const m2d_animator* animator, m2d_effect effect) {
  const fw::Animator* a = A(animator);
  if (!a) return 0;
  switch (effect) {
    case M2D_EFFECT_IDLE: return a->idle_count > 0 ? 1 : 0;
    case M2D_EFFECT_EYE_BLINK: return a->eye_blink ? 1 : 0;
    case M2D_EFFECT_EXPRESSIONS:
    case M2D_EFFECT_LOOK:
    case M2D_EFFECT_BREATH: return 1;
    case M2D_EFFECT_PHYSICS: return a->physics ? 1 : 0;
    case M2D_EFFECT_LIP_SYNC: return a->lip_sync ? 1 : 0;
    case M2D_EFFECT_POSE: return a->pose ? 1 : 0;
    case M2D_EFFECT_MOTION_SYNC: return a->motion_sync ? 1 : 0;
  }
  return 0;
}

// ---------------------------------------------------------------- live input

void m2d_live_input_settings_default(m2d_live_input_settings* s) {
  if (s) *s = {fw::kLiveLipSyncDefaults.gain, fw::kLiveLipSyncDefaults.gate, fw::kLiveLipSyncDefaults.attack,
               fw::kLiveLipSyncDefaults.release};
}

void m2d_live_input_settings_neutral(m2d_live_input_settings* s) {
  if (s) *s = {fw::kLiveLipSyncNeutral.gain, fw::kLiveLipSyncNeutral.gate, fw::kLiveLipSyncNeutral.attack,
               fw::kLiveLipSyncNeutral.release};
}

m2d_status m2d_live_input_create(double sample_rate, const m2d_live_input_settings* settings, double max_window,
                                 const m2d_allocator* allocator, m2d_live_input** out) {
  if (!out) return M2D_INVALID_ARGUMENT;
  *out = nullptr;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  m2d_live_input* h = create<m2d_live_input>();
  if (!h) return M2D_OUT_OF_MEMORY;
  h->heap = heap;
  h->input = std::allocate_shared<fw::LiveLipSyncInput>(Allocator<fw::LiveLipSyncInput>(), sample_rate,
                                                         live_settings(settings), max_window > 0 ? max_window : 0.25);
  *out = h;
  return M2D_OK;
}

void m2d_live_input_destroy(m2d_live_input* input) { destroy_handle(input); }

void m2d_live_input_set_settings(m2d_live_input* input, const m2d_live_input_settings* settings) {
  if (L(input)) L(input)->settings = live_settings(settings);
}

void m2d_live_input_get_settings(const m2d_live_input* input, m2d_live_input_settings* out) {
  if (!out) return;
  const fw::LiveLipSyncSettings s = Lc(input) ? Lc(input)->settings : fw::kLiveLipSyncDefaults;
  *out = {s.gain, s.gate, s.attack, s.release};
}

void m2d_live_input_set_sample_rate(m2d_live_input* input, double sample_rate) {
  if (L(input)) L(input)->sample_rate = sample_rate;
}

void m2d_live_input_push(m2d_live_input* input, const float* const* channels, int32_t channel_count, size_t frames) {
  if (L(input) && channel_count > 0) L(input)->push(channels, static_cast<std::size_t>(channel_count), frames);
}

void m2d_live_input_push_interleaved(m2d_live_input* input, const float* samples, int32_t channel_count,
                                     size_t frames) {
  if (L(input) && channel_count > 0)
    L(input)->push_interleaved(samples, static_cast<std::size_t>(channel_count), frames);
}

void m2d_live_input_push_sums(m2d_live_input* input, double sum_squares, double values, double frames) {
  if (L(input)) L(input)->push_sums(sum_squares, values, frames);
}

double m2d_live_input_pending(const m2d_live_input* input) { return Lc(input) ? Lc(input)->pending() : 0; }

double m2d_live_input_next(m2d_live_input* input, double dt) { return L(input) ? L(input)->next(dt) : 0; }

double m2d_live_input_level(const m2d_live_input* input) { return Lc(input) ? Lc(input)->level : 0; }

double m2d_live_input_value(const m2d_live_input* input) { return Lc(input) ? Lc(input)->value : 0; }

void m2d_live_input_reset(m2d_live_input* input) {
  if (L(input)) L(input)->reset();
}

double m2d_dbfs_to_amplitude(double db) { return fw::dbfs_to_amplitude(db); }

// ------------------------------------------------------------------ packages

const m2d_sound* m2d_sound_unusable(void) { return &unusable_sound; }

m2d_status m2d_package_open(const m2d_file_source* source, const char* settings_path, uint32_t flags,
                            const m2d_allocator* allocator, m2d_package** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!source || !source->read || !out) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  m2d_package* h = create<m2d_package>();
  if (!h) {
    set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
    return M2D_OUT_OF_MEMORY;
  }
  h->heap = heap;
  h->source = *source;
  h->label_text = source->label ? source->label : "files";
  h->source.label = nullptr;
  moc::LoadOptions options;
  options.reject_draw_order_range = (flags & M2D_LOAD_STRICT_DRAW_ORDERS) != 0;
  options.load_non_finite_opacity = (flags & M2D_LOAD_NON_FINITE_OPACITY) != 0;
  options.load_offscreen_keyform_range = (flags & M2D_LOAD_OFFSCREEN_KEYFORM_RANGE) != 0;
  String message;
  fw::PackageError kind = fw::PackageError::None;
  moc::Error moc_error;
  const String given = settings_path ? String(settings_path) : String();
  if (!h->package.open(*h, settings_path ? &given : nullptr, options, message, kind, moc_error)) {
    if (kind == fw::PackageError::Moc)
      set_error(error, M2D_FORMAT_ERROR, moc_error.code.c_str(), message.c_str());
    else
      set_error(error, M2D_FILE_ERROR, kind == fw::PackageError::Settings ? "settings" : "file", message.c_str());
    const m2d_status status = kind == fw::PackageError::Moc ? M2D_FORMAT_ERROR : M2D_FILE_ERROR;
    destroy(h);
    return status;
  }
  fw::Package& p = h->package;
  h->model = capi::wrap_model(p.model, heap);
  h->settings = create<m2d_settings>();
  h->settings->heap = heap;
  h->settings->settings = p.settings;
  if (p.physics) {
    h->physics = create<m2d_physics>();
    h->physics->heap = heap;
    h->physics->physics = p.physics;
  }
  if (p.pose) {
    h->pose = create<m2d_pose>();
    h->pose->heap = heap;
    h->pose->pose = p.pose;
  }
  if (p.user_data) {
    h->user_data = create<m2d_user_data>();
    h->user_data->heap = heap;
    h->user_data->data = *p.user_data;
  }
  if (p.display_info) {
    h->display_info = create<m2d_display_info>();
    h->display_info->heap = heap;
    h->display_info->info = *p.display_info;
  }
  if (p.motion_sync) {
    h->motion_sync = create<m2d_motion_sync>();
    h->motion_sync->heap = heap;
    h->motion_sync->file = p.motion_sync;
  }
  *out = h;
  return M2D_OK;
}

void m2d_package_destroy(m2d_package* package) { destroy_handle(package); }

const char* m2d_package_settings_path(const m2d_package* package) {
  return package ? package->package.settings_path().c_str() : nullptr;
}
const m2d_settings* m2d_package_settings(const m2d_package* package) { return package ? package->settings : nullptr; }
m2d_model* m2d_package_model(const m2d_package* package) { return package ? package->model : nullptr; }
const m2d_physics* m2d_package_physics(const m2d_package* package) { return package ? package->physics : nullptr; }
const m2d_pose* m2d_package_pose(const m2d_package* package) { return package ? package->pose : nullptr; }
const m2d_user_data* m2d_package_user_data(const m2d_package* package) {
  return package ? package->user_data : nullptr;
}
const m2d_display_info* m2d_package_display_info(const m2d_package* package) {
  return package ? package->display_info : nullptr;
}
int32_t m2d_package_warning_count(const m2d_package* package) {
  return package ? count_of(package->package.warnings) : 0;
}
const char* m2d_package_warning(const m2d_package* package, int32_t index) {
  return package && in(index, package->package.warnings.size())
             ? package->package.warnings[static_cast<std::size_t>(index)].c_str()
             : nullptr;
}

char* m2d_package_resolve(const m2d_package* package, const char* path) {
  if (!package || !path) return nullptr;
  HeapScope scope(&package->heap);
  String out;
  if (!package->package.resolve(path, out)) return nullptr;
  return dup_string(out);
}

m2d_status m2d_package_motion(m2d_package* package, const char* path, const m2d_motion** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!package || !path || !out) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  HeapScope scope(&package->heap);
  String key, message;
  if (!package->package.resolve(path, key, &message)) return file_error(error, message);
  if (auto it = package->motions.find(key); it != package->motions.end()) {
    *out = it->second;
    return M2D_OK;
  }
  auto motion = package->package.motion(path, message);
  if (!motion) return file_error(error, message);
  m2d_motion* h = create<m2d_motion>();
  h->heap = package->heap;
  h->motion = std::move(motion);
  package->motions[key] = h;
  *out = h;
  return M2D_OK;
}

m2d_status m2d_package_expression(m2d_package* package, const char* path, const m2d_expression** out,
                                  m2d_error* error) {
  if (out) *out = nullptr;
  if (!package || !path || !out) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  HeapScope scope(&package->heap);
  String key, message;
  if (!package->package.resolve(path, key, &message)) return file_error(error, message);
  if (auto it = package->expressions.find(key); it != package->expressions.end()) {
    *out = it->second;
    return M2D_OK;
  }
  auto expression = package->package.expression(path, message);
  if (!expression) return file_error(error, message);
  m2d_expression* h = create<m2d_expression>();
  h->heap = package->heap;
  h->expression = std::move(expression);
  package->expressions[key] = h;
  *out = h;
  return M2D_OK;
}

m2d_status m2d_package_named_expression(m2d_package* package, const char* name, const m2d_expression** out,
                                        m2d_error* error) {
  if (out) *out = nullptr;
  if (!package || !name || !out) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  for (const auto& e : package->package.settings->expressions)
    if (e.name == name) return m2d_package_expression(package, e.file.c_str(), out, error);
  set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "no expression of that name");
  return M2D_INVALID_ARGUMENT;
}

m2d_status m2d_package_sound(m2d_package* package, const char* path, const m2d_sound** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!package || !path || !out) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  HeapScope scope(&package->heap);
  String key, message;
  if (!package->package.resolve(path, key, &message)) {
    *out = &unusable_sound;
    return file_error(error, message);
  }
  auto it = package->sounds.find(key);
  if (it == package->sounds.end()) {
    auto sound = package->package.sound(path, message);
    m2d_sound* h = &unusable_sound;
    if (sound) {
      h = create<m2d_sound>();
      h->heap = package->heap;
      h->sound = std::move(sound);
    }
    it = package->sounds.emplace(key, h).first;
  }
  *out = it->second;
  if (it->second == &unusable_sound) {
    package->package.sound(path, message);  // the cached reason
    return file_error(error, message);
  }
  return M2D_OK;
}

m2d_status m2d_package_group_motion(m2d_package* package, const char* group, int32_t index, m2d_idle_motion* out,
                                    m2d_error* error) {
  if (out) *out = m2d_idle_motion{nullptr, nullptr, kNaN, kNaN};
  if (!package || !group || !out) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  const fw::MotionGroup* g = package->package.settings->motion_group(group);
  if (!g || !in(index, g->entries.size())) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "no such motion group entry");
    return M2D_INVALID_ARGUMENT;
  }
  const fw::MotionEntry& entry = g->entries[static_cast<std::size_t>(index)];
  if (entry.fade_in_time) out->fade_in = *entry.fade_in_time;
  if (entry.fade_out_time) out->fade_out = *entry.fade_out_time;
  m2d_error first;
  clear_error(&first);
  m2d_status status = m2d_package_motion(package, entry.file.c_str(), &out->motion, &first);
  if (!entry.sound.empty()) {
    m2d_error e;
    const m2d_status s = m2d_package_sound(package, entry.sound.c_str(), &out->sound, &e);
    if (s != M2D_OK && status == M2D_OK) {
      first = e;
      status = s;
    }
  }
  if (error) *error = first;
  return status;
}

// --------------------------------------------------------------- motion sync

}  // extern "C"

namespace {

const fw::MotionSyncFile* MS(const m2d_motion_sync* f) { return f ? f->file.get() : nullptr; }
const fw::MotionSyncSetting* MSS(const m2d_motion_sync* f, int32_t setting) {
  const fw::MotionSyncFile* file = MS(f);
  return file && in(setting, file->settings.size()) ? &file->settings[static_cast<std::size_t>(setting)] : nullptr;
}

/** A sound handle from a framework sound (its signal made). */
m2d_status sound_handle(const Heap& heap, fw::MotionSyncSound&& sound, m2d_motion_sync_sound** out) {
  auto shared = std::allocate_shared<fw::MotionSyncSound>(Allocator<fw::MotionSyncSound>(), std::move(sound));
  shared->prepare();
  m2d_motion_sync_sound* h = create<m2d_motion_sync_sound>();
  if (!h) return M2D_OUT_OF_MEMORY;
  h->heap = heap;
  h->sound = std::move(shared);
  *out = h;
  return M2D_OK;
}

m2d_status profile_handle(const Heap& heap, fw::VoiceProfile&& profile, m2d_voice_profile** out) {
  m2d_voice_profile* h = create<m2d_voice_profile>();
  if (!h) return M2D_OUT_OF_MEMORY;
  h->heap = heap;
  h->profile = std::move(profile);
  *out = h;
  return M2D_OK;
}

/** A setting reference: NULL for none. */
std::optional<std::string_view> ref_of(const char* setting) {
  if (!setting) return std::nullopt;
  return std::string_view(setting);
}

m2d_status no_motion_sync(m2d_error* error) {
  set_error(error, M2D_INVALID_ARGUMENT, "no-motion-sync", "the model has no usable motion-sync setting");
  return M2D_INVALID_ARGUMENT;
}

void tick_trampoline(const fw::MotionSyncTick& t, void* user);

void fill_tick(const fw::MotionSyncTick& t, m2d_motion_sync_tick* out) {
  out->serial = t.serial;
  out->setting = t.setting;
  out->live = t.live ? 1 : 0;
  out->level = t.level;
  out->silent = t.silent ? 1 : 0;
  for (int i = 0; i < 6; i++) out->weights[i] = t.weights[static_cast<std::size_t>(i)];
  out->time = t.time;
  out->value_count = static_cast<int32_t>(t.values.size());
  out->values = t.values.data();
}

void tick_trampoline(const fw::MotionSyncTick& t, void* user) {
  auto* h = static_cast<m2d_animator*>(user);
  if (!h->tick_listener) return;
  m2d_motion_sync_tick c;
  fill_tick(t, &c);
  h->tick_listener(&c, h->tick_user);
}

}  // namespace

extern "C" {

m2d_status m2d_motion_sync_parse(const void* bytes, size_t size, const char* label, uint32_t flags,
                                 const m2d_allocator* allocator, m2d_motion_sync** out, m2d_error* error) {
  fw::MotionSyncReadOptions options;
  options.lint = (flags & M2D_MOTION_SYNC_LINT) != 0;
  return parse_shared(bytes, size, label, "motion sync", allocator, out, error, &m2d_motion_sync::file,
                      [&](std::string_view b, const char* l, fw::MotionSyncFile& o, fw::FormatError& e) {
                        return fw::parse_motion_sync(b, l, o, e, options);
                      });
}

void m2d_motion_sync_destroy(m2d_motion_sync* file) { destroy_handle(file); }
const char* m2d_motion_sync_label(const m2d_motion_sync* file) { return MS(file) ? MS(file)->label.c_str() : nullptr; }
double m2d_motion_sync_version(const m2d_motion_sync* file) { return MS(file) ? MS(file)->version : kNaN; }
int32_t m2d_motion_sync_warning_count(const m2d_motion_sync* file) {
  return MS(file) ? count_of(MS(file)->warnings) : 0;
}
const char* m2d_motion_sync_warning(const m2d_motion_sync* file, int32_t index) {
  return MS(file) && in(index, MS(file)->warnings.size()) ? MS(file)->warnings[static_cast<std::size_t>(index)].c_str()
                                                          : nullptr;
}
int32_t m2d_motion_sync_setting_count(const m2d_motion_sync* file) {
  return MS(file) ? count_of(MS(file)->settings) : 0;
}
int32_t m2d_motion_sync_find_setting(const m2d_motion_sync* file, const char* ref) {
  if (!MS(file) || !ref) return -1;
  const fw::MotionSyncSetting* s = fw::find_motion_sync_setting(*MS(file), ref);
  return s ? s->index : -1;
}

m2d_status m2d_motion_sync_get_setting(const m2d_motion_sync* file, int32_t setting, m2d_motion_sync_setting* out) {
  const fw::MotionSyncSetting* s = MSS(file, setting);
  if (!s || !out) return M2D_INVALID_ARGUMENT;
  out->id = s->id.c_str();
  out->name = s->name.c_str();
  out->analysis_type = s->analysis_type.c_str();
  out->use_case = s->use_case.c_str();
  out->usable = s->usable ? 1 : 0;
  out->parameter_count = count_of(s->parameters);
  out->element_count = count_of(s->elements);
  out->blend_ratio = s->blend_ratio;
  out->smoothing = s->smoothing;
  out->sample_rate = s->sample_rate;
  return M2D_OK;
}

m2d_status m2d_motion_sync_get_parameter(const m2d_motion_sync* file, int32_t setting, int32_t index,
                                         m2d_motion_sync_parameter* out) {
  const fw::MotionSyncSetting* s = MSS(file, setting);
  if (!s || !out || !in(index, s->parameters.size())) return M2D_INVALID_ARGUMENT;
  const fw::MotionSyncParameter& p = s->parameters[static_cast<std::size_t>(index)];
  *out = {p.id.c_str(), p.name.c_str(), p.min, p.max, p.damper, p.smooth};
  return M2D_OK;
}

m2d_status m2d_motion_sync_get_element(const m2d_motion_sync* file, int32_t setting, int32_t index,
                                       m2d_motion_sync_element* out) {
  const fw::MotionSyncSetting* s = MSS(file, setting);
  if (!s || !out || !in(index, s->elements.size())) return M2D_INVALID_ARGUMENT;
  const fw::MotionSyncElement& e = s->elements[static_cast<std::size_t>(index)];
  *out = {e.id.c_str(), e.name.c_str(), e.min, e.max, e.scale, e.enabled ? 1 : 0, e.known ? 1 : 0};
  return M2D_OK;
}

double m2d_motion_sync_shape(const m2d_motion_sync* file, int32_t setting, int32_t element, int32_t parameter) {
  const fw::MotionSyncSetting* s = MSS(file, setting);
  if (!s || !in(element, s->shapes.size()) || !in(parameter, s->parameters.size())) return kNaN;
  return s->shapes[static_cast<std::size_t>(element)][static_cast<std::size_t>(parameter)];
}

m2d_status m2d_motion_sync_sound_create(const float* const* channels, int32_t channel_count, size_t frames,
                                        double sample_rate, const m2d_allocator* allocator,
                                        m2d_motion_sync_sound** out) {
  if (!out) return M2D_INVALID_ARGUMENT;
  *out = nullptr;
  if (channel_count < 0 || (channel_count > 0 && !channels) || !fw::motion_sync_rate_supported(sample_rate))
    return M2D_INVALID_ARGUMENT;
  for (int32_t c = 0; c < channel_count; c++)
    if (!channels[c] && frames) return M2D_INVALID_ARGUMENT;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  fw::MotionSyncSound sound;
  sound.sample_rate = sample_rate;
  sound.channels.resize(static_cast<std::size_t>(channel_count));
  for (int32_t c = 0; c < channel_count; c++)
    sound.channels[static_cast<std::size_t>(c)].assign(channels[c], channels[c] + (channels[c] ? frames : 0));
  return sound_handle(heap, std::move(sound), out);
}

m2d_status m2d_motion_sync_sound_decode(const void* bytes, size_t size, const m2d_allocator* allocator,
                                        m2d_motion_sync_sound** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!check_out(bytes, size, out, error)) return M2D_INVALID_ARGUMENT;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  fw::MotionSyncSound sound;
  String message;
  if (!fw::decode_motion_sync_wav(static_cast<const uint8_t*>(bytes), bytes ? size : 0, sound, message))
    return file_error(error, message);
  const m2d_status s = sound_handle(heap, std::move(sound), out);
  if (s != M2D_OK) set_error(error, s, "out-of-memory", "out of memory");
  return s;
}

void m2d_motion_sync_sound_destroy(m2d_motion_sync_sound* sound) { destroy_handle(sound); }
int32_t m2d_motion_sync_sound_channels(const m2d_motion_sync_sound* sound) {
  return sound ? count_of(sound->sound->channels) : 0;
}
size_t m2d_motion_sync_sound_frames(const m2d_motion_sync_sound* sound) { return sound ? sound->sound->frames() : 0; }
double m2d_motion_sync_sound_sample_rate(const m2d_motion_sync_sound* sound) {
  return sound ? sound->sound->sample_rate : 0;
}
const float* m2d_motion_sync_sound_samples(const m2d_motion_sync_sound* sound, int32_t channel) {
  return sound && in(channel, sound->sound->channels.size())
             ? sound->sound->channels[static_cast<std::size_t>(channel)].data()
             : nullptr;
}

m2d_status m2d_motion_sync_input_create(double sample_rate, double capacity, const m2d_allocator* allocator,
                                        m2d_motion_sync_input** out) {
  if (!out) return M2D_INVALID_ARGUMENT;
  *out = nullptr;
  if (!fw::motion_sync_rate_supported(sample_rate)) return M2D_INVALID_ARGUMENT;
  const double seconds = capacity > 0 ? fw::js_min(capacity, 60) : 1;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  m2d_motion_sync_input* h = create<m2d_motion_sync_input>();
  if (!h) return M2D_OUT_OF_MEMORY;
  h->heap = heap;
  h->input = std::allocate_shared<fw::MotionSyncLiveInput>(Allocator<fw::MotionSyncLiveInput>(), sample_rate,
                                                           static_cast<std::size_t>(std::ceil(seconds * sample_rate)));
  *out = h;
  return M2D_OK;
}

void m2d_motion_sync_input_destroy(m2d_motion_sync_input* input) { destroy_handle(input); }
void m2d_motion_sync_input_push(m2d_motion_sync_input* input, const float* samples, size_t count) {
  if (input && samples && count) input->input->push(samples, count);
}
size_t m2d_motion_sync_input_pending(const m2d_motion_sync_input* input) {
  return input ? input->input->pending() : 0;
}
uint64_t m2d_motion_sync_input_dropped(const m2d_motion_sync_input* input) {
  return input ? input->input->dropped() : 0;
}

m2d_status m2d_voice_profile_neutral(const m2d_allocator* allocator, m2d_voice_profile** out) {
  if (!out) return M2D_INVALID_ARGUMENT;
  *out = nullptr;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  return profile_handle(heap, fw::neutral_voice_profile(), out);
}

m2d_status m2d_voice_profile_parse(const void* json, size_t size, const m2d_allocator* allocator,
                                   m2d_voice_profile** out, m2d_error* error) {
  if (out) *out = nullptr;
  if (!check_out(json, size, out, error)) return M2D_INVALID_ARGUMENT;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  mochi2d::json::Value v;
  fw::FormatError fe;
  if (!fw::parse_json(view(json, size), "voice profile", v, fe)) return file_error(error, fe.message);
  fw::VoiceProfile p;
  String message;
  if (!fw::voice_profile_from_json(v, p, message)) return file_error(error, message);
  return profile_handle(heap, std::move(p), out);
}

char* m2d_voice_profile_to_json(const m2d_voice_profile* profile) {
  if (!profile) return nullptr;
  HeapScope scope(&profile->heap);
  return dup_string(fw::voice_profile_to_json(profile->profile));
}

void m2d_voice_profile_destroy(m2d_voice_profile* profile) { destroy_handle(profile); }
const char* m2d_voice_profile_name(const m2d_voice_profile* profile) {
  return profile ? profile->profile.name.c_str() : nullptr;
}
double m2d_voice_profile_voiced_level(const m2d_voice_profile* profile) {
  return profile ? profile->profile.voiced_level : kNaN;
}
double m2d_voice_profile_floor_level(const m2d_voice_profile* profile) {
  return profile && profile->profile.floor_level ? *profile->profile.floor_level : kNaN;
}
int32_t m2d_voice_profile_template_count(const m2d_voice_profile* profile, m2d_motion_sync_element_id vowel) {
  if (!profile || vowel < M2D_ELEMENT_A || vowel > M2D_ELEMENT_O) return 0;
  const auto* list = profile->profile.vowel_templates(static_cast<int>(vowel) - 1);
  return list ? count_of(*list) : 0;
}
const double* m2d_voice_profile_template(const m2d_voice_profile* profile, m2d_motion_sync_element_id vowel,
                                         int32_t index) {
  if (!profile || vowel < M2D_ELEMENT_A || vowel > M2D_ELEMENT_O) return nullptr;
  const auto* list = profile->profile.vowel_templates(static_cast<int>(vowel) - 1);
  return list && in(index, list->size()) ? (*list)[static_cast<std::size_t>(index)].data() : nullptr;
}

m2d_status m2d_voice_calibration_create(const char* name, const m2d_allocator* allocator,
                                        m2d_voice_calibration** out) {
  if (!out) return M2D_INVALID_ARGUMENT;
  *out = nullptr;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  m2d_voice_calibration* h = create<m2d_voice_calibration>();
  if (!h) return M2D_OUT_OF_MEMORY;
  h->heap = heap;
  h->calibration.name = name ? String(name) : String("voice");
  *out = h;
  return M2D_OK;
}

void m2d_voice_calibration_destroy(m2d_voice_calibration* calibration) { destroy_handle(calibration); }

int32_t m2d_voice_calibration_add(m2d_voice_calibration* calibration, m2d_motion_sync_element_id element,
                                  const float* const* channels, int32_t channel_count, size_t frames,
                                  double sample_rate) {
  if (!calibration || element < M2D_ELEMENT_SILENCE || element > M2D_ELEMENT_O || channel_count < 0 ||
      (channel_count > 0 && !channels) || !fw::motion_sync_rate_supported(sample_rate))
    return -1;
  for (int32_t c = 0; c < channel_count; c++)
    if (!channels[c] && frames) return -1;
  HeapScope scope(&calibration->heap);
  return calibration->calibration.add(static_cast<int>(element), channels, static_cast<std::size_t>(channel_count),
                                      frames, sample_rate);
}

int32_t m2d_voice_calibration_recorded(const m2d_voice_calibration* calibration, m2d_motion_sync_element_id vowel) {
  if (!calibration || vowel < M2D_ELEMENT_A || vowel > M2D_ELEMENT_O) return 0;
  return static_cast<int32_t>(calibration->calibration.recorded(static_cast<int>(vowel) - 1));
}

m2d_status m2d_voice_calibration_profile(const m2d_voice_calibration* calibration, const m2d_allocator* allocator,
                                         m2d_voice_profile** out) {
  if (!calibration || !out) return M2D_INVALID_ARGUMENT;
  *out = nullptr;
  const Heap heap = heap_of(allocator);
  HeapScope scope(&heap);
  return profile_handle(heap, calibration->calibration.profile(), out);
}

void m2d_motion_sync_options_default(m2d_motion_sync_options* o) {
  if (!o) return;
  o->before_physics = 0;
  o->file_smoothing = 0;
  o->settle_time = 0.5;
  o->gate = kNaN;
  o->hangover = kNaN;
}

m2d_status m2d_animator_set_motion_sync(m2d_animator* animator, const m2d_motion_sync* file,
                                        const m2d_motion_sync_options* options) {
  fw::Animator* a = A(animator);
  if (!a) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  m2d_motion_sync_options defaults;
  m2d_motion_sync_options_default(&defaults);
  const m2d_motion_sync_options& o = options ? *options : defaults;
  fw::MotionSyncOptions mo;
  mo.before_physics = o.before_physics != 0;
  mo.file_smoothing = o.file_smoothing != 0;
  mo.settle_time = o.settle_time;
  if (!std::isnan(o.gate)) mo.gate = o.gate;
  if (!std::isnan(o.hangover)) mo.hangover = o.hangover;
  // A new driver: the profile carries over; bindings do not.
  std::optional<fw::VoiceProfile> profile;
  if (a->motion_sync && a->motion_sync->profile()) profile = *a->motion_sync->profile();
  a->attach_motion_sync(file ? file->file : nullptr, mo);
  animator->sync_input.reset();
  if (a->motion_sync) {
    if (profile) a->motion_sync->set_profile(&*profile);
    a->motion_sync->set_listener(tick_trampoline, animator);
  }
  return M2D_OK;
}

m2d_status m2d_animator_set_voice_profile(m2d_animator* animator, const m2d_voice_profile* profile) {
  fw::Animator* a = A(animator);
  if (!a) return M2D_INVALID_ARGUMENT;
  if (!a->motion_sync) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  a->motion_sync->set_profile(profile ? &profile->profile : nullptr);
  return M2D_OK;
}

m2d_status m2d_animator_start_motion_sync(m2d_animator* animator, const m2d_motion_sync_sound* sound,
                                          const char* setting, m2d_audio_clock clock, void* clock_user,
                                          m2d_error* error) {
  if (!A(animator) || !sound) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  HeapScope scope(&animator->heap);
  const auto ref = ref_of(setting);
  bool unknown = false;
  String message;
  CClock* c = animator->next_clock(clock, clock_user);
  const bool ok = animator->sync->start(sound->sound, ref ? &*ref : nullptr, c, unknown, message);
  if (unknown) {
    set_error(error, M2D_INVALID_ARGUMENT, "unknown-setting", message.c_str());
    return M2D_INVALID_ARGUMENT;
  }
  if (!ok) return no_motion_sync(error);
  animator->took_clock();
  release_unbound_input(*animator);
  return M2D_OK;
}

m2d_status m2d_animator_bind_motion_sync(m2d_animator* animator, uint32_t ticket, const m2d_motion_sync_sound* sound,
                                         const char* setting, const char* path, m2d_audio_clock clock,
                                         void* clock_user) {
  if (!A(animator) || !setting) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  bind_sync(*animator, ticket, sound ? sound->sound : nullptr, String(setting), String(path ? path : ""), clock,
            clock_user, nullptr);
  return M2D_OK;
}

m2d_status m2d_animator_set_motion_sync_input(m2d_animator* animator, m2d_motion_sync_input* input,
                                              const char* setting, m2d_error* error) {
  if (!A(animator)) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL animator");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  HeapScope scope(&animator->heap);
  const auto ref = ref_of(setting);
  bool unknown = false;
  String message;
  const bool ok = animator->sync->set_input(input ? input->input.get() : nullptr, ref ? &*ref : nullptr, unknown,
                                            message);
  if (unknown) {
    set_error(error, M2D_INVALID_ARGUMENT, "unknown-setting", message.c_str());
    return M2D_INVALID_ARGUMENT;
  }
  if (!ok) return no_motion_sync(error);
  // The input stays alive while bound (a stopped one until it settled).
  if (input) animator->sync_input = input->input;
  release_unbound_input(*animator);
  return M2D_OK;
}

void m2d_animator_stop_motion_sync(m2d_animator* animator, double fade) {
  if (!A(animator)) return;
  HeapScope scope(&animator->heap);
  animator->sync->stop(fade);
}

int32_t m2d_animator_motion_sync_tick(const m2d_animator* animator, m2d_motion_sync_tick* out) {
  const fw::Animator* a = A(animator);
  if (!a || !out || !a->motion_sync || !a->motion_sync->tick()) return 0;
  fill_tick(*a->motion_sync->tick(), out);
  return 1;
}

void m2d_animator_set_motion_sync_listener(m2d_animator* animator,
                                           void (*listener)(const m2d_motion_sync_tick* tick, void* user),
                                           void* user) {
  if (!animator) return;
  animator->tick_listener = listener;
  animator->tick_user = user;
}

int32_t m2d_animator_motion_sync_setting(const m2d_animator* animator) {
  const fw::Animator* a = A(animator);
  return a && a->motion_sync && a->motion_sync->setting() ? a->motion_sync->setting()->index : -1;
}

int32_t m2d_animator_motion_sync_playing(const m2d_animator* animator) {
  const fw::Animator* a = A(animator);
  return a && a->motion_sync && a->motion_sync->playing() ? 1 : 0;
}

double m2d_animator_motion_sync_consumed(const m2d_animator* animator) {
  const fw::Animator* a = A(animator);
  return a && a->motion_sync ? a->motion_sync->consumed : 0;
}

int32_t m2d_animator_warning_count(const m2d_animator* animator) {
  return animator && animator->sync ? count_of(animator->sync->warnings) : 0;
}

const char* m2d_animator_warning(const m2d_animator* animator, int32_t index) {
  return animator && animator->sync && in(index, animator->sync->warnings.size())
             ? animator->sync->warnings[static_cast<std::size_t>(index)].c_str()
             : nullptr;
}

void m2d_animator_clear_warnings(m2d_animator* animator) {
  if (!animator || !animator->sync) return;
  HeapScope scope(&animator->heap);
  animator->sync->warnings.clear();
}

m2d_status m2d_animator_set_idle_motion_sync(m2d_animator* animator, int32_t index, const m2d_motion_sync_sound* sound,
                                             const char* setting, const char* path, m2d_audio_clock clock,
                                             void* clock_user) {
  if (!A(animator) || !in(index, animator->idle.size())) return M2D_INVALID_ARGUMENT;
  HeapScope scope(&animator->heap);
  if (animator->idle_sync.size() < animator->idle.size()) animator->idle_sync.resize(animator->idle.size());
  auto& link = animator->idle_sync[static_cast<std::size_t>(index)];
  link = m2d_animator::IdleSync();
  if (!setting) return M2D_OK;
  link.linked = true;
  link.sound = sound ? sound->sound : nullptr;
  link.setting = setting;
  link.path = path ? path : "";
  link.clock = clock;
  link.clock_user = clock_user;
  return M2D_OK;
}

const m2d_motion_sync* m2d_package_motion_sync(const m2d_package* package) {
  return package ? package->motion_sync : nullptr;
}

m2d_status m2d_package_motion_sync_sound(m2d_package* package, const char* path, const m2d_motion_sync_sound** out,
                                         m2d_error* error) {
  if (out) *out = nullptr;
  if (!package || !path || !out) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  clear_error(error);
  HeapScope scope(&package->heap);
  String key, message;
  if (!package->package.resolve(path, key, &message)) return file_error(error, message);
  bool first = false;
  auto sound = package->package.motion_sync_sound(path, message, first);
  if (!sound) return file_error(error, message);
  auto it = package->sync_sounds.find(key);
  if (it == package->sync_sounds.end()) {
    m2d_motion_sync_sound* h = create<m2d_motion_sync_sound>();
    if (!h) {
      set_error(error, M2D_OUT_OF_MEMORY, "out-of-memory", "out of memory");
      return M2D_OUT_OF_MEMORY;
    }
    h->heap = package->heap;
    h->sound = std::move(sound);
    it = package->sync_sounds.emplace(key, h).first;
  }
  *out = it->second;
  return M2D_OK;
}

m2d_status m2d_package_start_motion(m2d_package* package, m2d_animator* animator, const char* group, int32_t index,
                                    const m2d_motion_start* start, m2d_audio_clock clock, void* clock_user,
                                    int32_t* accepted, m2d_error* error) {
  if (accepted) *accepted = 0;
  if (!package || !A(animator) || !group) {
    set_error(error, M2D_INVALID_ARGUMENT, "invalid-argument", "NULL argument");
    return M2D_INVALID_ARGUMENT;
  }
  m2d_idle_motion m;
  const m2d_status status = m2d_package_group_motion(package, group, index, &m, error);
  if (status == M2D_INVALID_ARGUMENT) return status;
  const fw::MotionEntry& entry =
      package->package.settings->motion_group(group)->entries[static_cast<std::size_t>(index)];
  m2d_motion_start s;
  if (start)
    s = *start;
  else
    m2d_motion_start_default(&s);
  // The entry's fade times, unless the start gives its own.
  if (std::isnan(s.fade_in) && !std::isnan(m.fade_in)) s.fade_in = m.fade_in;
  if (std::isnan(s.fade_out) && !std::isnan(m.fade_out)) s.fade_out = m.fade_out;
  const int32_t ok = m2d_animator_start_motion(animator, m.motion, &s, entry.sound.empty() ? nullptr : m.sound);
  if (accepted) *accepted = ok;
  if (ok && !entry.sound.empty() && !entry.motion_sync.empty() && m.motion) {
    HeapScope scope(&animator->heap);
    String message;
    const String* bytes = nullptr;
    // Mochi2D binds only a sound whose file was read (its bytes are not empty).
    package->package.sound(entry.sound, message, &bytes);
    if (bytes && !bytes->empty()) {
      String path;
      package->package.resolve(entry.sound, path);
      // bindMotionSound: the link's setting first, then the decoding (its warning once).
      if (const fw::MotionSyncSetting* setting = animator->sync->link_setting(path, entry.motion_sync)) {
        bool first = false;
        auto sound = package->package.motion_sync_sound(entry.sound, message, first);
        CClock* c = animator->next_clock(clock, clock_user);
        if (animator->sync->bind_linked(animator->animator->motions.last_ticket, path, *setting, sound,
                                        first ? &message : nullptr, c))
          animator->took_clock();
        release_unbound_input(*animator);
      }
    }
  }
  return status;
}

}  // extern "C"

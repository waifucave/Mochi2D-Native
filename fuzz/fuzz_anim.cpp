// Fuzz target: the framework's file readers (settings, motions, expressions,
// physics, poses, user data, display info, WAV sounds, motion-sync files,
// motion-sync WAV sounds and voice profiles) on arbitrary bytes; whatever
// parses then runs in an animator on a small synthetic model (motion sync
// with the sound, or a live input fed from the input), which is evaluated
// after every frame. The first bytes of the input also choose the options,
// the steps and the commands.
//
// Inputs on which the reference itself never finishes (a loop length that
// makes its loop endless) are skipped; any physics rate runs (0.16.0).
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>

#include "core/eval/instance.hpp"
#include "core/moc/model.hpp"
#include "framework/animator.hpp"
#include "framework/live_input.hpp"
#include "framework/model_data.hpp"
#include "framework/motion_sync_analysis.hpp"
#include "support/tiny_model.hpp"

using namespace mochi2d;
namespace fw = mochi2d::framework;

namespace {

std::shared_ptr<const moc::Model> make_model() {
  const auto bytes = testing::written(testing::tiny_model(5, true), 5);
  auto m = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
  moc::Error err;
  if (!moc::load_moc(bytes.data(), bytes.size(), moc::LoadOptions(), *m, err)) std::abort();
  return m;
}

const std::shared_ptr<const moc::Model>& model() {
  static const auto m = make_model();
  return m;
}

/** Bytes of the input, cycled, as knobs. */
struct Knobs {
  const uint8_t* data;
  size_t size;
  size_t at = 0;
  uint8_t next() { return size ? data[at++ % size] : 0; }
  double unit() { return next() / 255.0; }
};

/** A random sequence from the input that runs out after a while. */
class InputRandom : public fw::RandomSource {
 public:
  explicit InputRandom(Knobs& k) : k_(k), left_(k.next()) {}
  bool next(double& out, fw::Fault& fault) override {
    if (left_-- == 0) {
      fault.kind = "RandomExhaustedError";
      fault.message = "out";
      return false;
    }
    out = k_.next() / 256.0;
    return true;
  }

 private:
  Knobs& k_;
  unsigned left_;
};

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  const std::string_view text(reinterpret_cast<const char*>(data), size);
  Knobs k{data, size};
  String message;
  fw::FormatError err;
  fw::ModelSettings settings;
  if (!fw::parse_model_settings(text, "fuzz", settings, message)) {
    fw::settings_from_json(json::Value::object(), "fuzz", settings, message);
    fw::ParameterGroup blink, lip;
    blink.name = "EyeBlink";
    blink.ids.push_back("ParamX");
    lip.name = "LipSync";
    lip.ids.push_back("ParamX");
    lip.ids.push_back("Free");
    settings.groups.push_back(blink);
    settings.groups.push_back(lip);
  }
  auto motion = std::allocate_shared<fw::Motion>(Allocator<fw::Motion>());
  const bool has_motion = fw::parse_motion(text, "m", *motion, err);
  auto expression = std::allocate_shared<fw::Expression>(Allocator<fw::Expression>());
  const bool has_expression = fw::parse_expression(text, "e", *expression, err);
  fw::PhysicsFile physics;
  // Any rate: since 0.16.0 a frame takes at most 10,000 physics steps.
  const bool has_physics = fw::parse_physics(text, "p", physics, err);
  fw::PoseFile pose;
  const bool has_pose = fw::parse_pose(text, "q", pose, err);
  fw::UserData user_data;
  fw::parse_user_data(text, "u", user_data, err);
  fw::DisplayInfo info;
  if (fw::parse_display_info(text, "d", info, err)) {
    fw::display_labels(model()->parameters.ids, &info, fw::DisplayKind::Parameters);
    fw::display_labels(model()->parts.ids, &info, fw::DisplayKind::Parts);
  }
  auto sound = std::allocate_shared<fw::WavSound>(Allocator<fw::WavSound>());
  const bool has_sound = fw::decode_wav(data, size, *sound, message);
  auto sync = std::allocate_shared<fw::MotionSyncFile>(Allocator<fw::MotionSyncFile>());
  fw::MotionSyncReadOptions sync_options;
  sync_options.lint = size > 0 && (data[0] & 1);
  const bool has_sync = fw::parse_motion_sync(text, "ms", *sync, err, sync_options);
  auto sync_sound = std::allocate_shared<fw::MotionSyncSound>(Allocator<fw::MotionSyncSound>());
  const bool has_sync_sound = fw::decode_motion_sync_wav(data, size, *sync_sound, message);
  if (has_sync_sound) sync_sound->prepare();
  fw::VoiceProfile profile;
  bool has_profile = false;
  {
    json::Value v;
    if (fw::parse_json(text, "vp", v, err)) {
      has_profile = fw::voice_profile_from_json(v, profile, message);
      if (has_profile) fw::voice_profile_to_json(profile);
    }
  }
  if (!(has_motion || has_expression || has_physics || has_pose || has_sound || has_sync || has_sync_sound))
    return 0;

  InputRandom random(k);
  fw::AnimatorOptions options;
  const uint8_t flags = k.next();
  options.wrap = flags & 1;
  options.settle = flags & 2;
  options.random = &random;
  if (flags & 4) options.gravity = std::make_pair(k.unit() * 2 - 1, k.unit() * 2 - 1);
  if (flags & 8) options.wind = std::make_pair(k.unit() * 4 - 2, 0.0);
  fw::Animator animator(model(), settings, has_physics ? &physics : nullptr, has_pose ? &pose : nullptr, options);
  if (!animator.ok()) return 0;
  eval::Instance instance(model());
  // A live input fed from the input's bytes, with knob settings.
  fw::LiveLipSyncSettings live_settings;
  live_settings.gain = k.unit() * 40 - 5;
  live_settings.gate = -k.unit() * 90;
  live_settings.attack = k.unit() * 0.5 - 0.05;
  live_settings.release = k.unit() * 0.5 - 0.05;
  fw::LiveLipSyncInput live(4000 + 500.0 * (k.next() % 90), live_settings, k.unit());
  const bool live_on = (flags & 16) != 0;
  if (live_on) animator.set_live_lip_sync(&live, static_cast<fw::LiveLipSyncMix>(k.next() % 3));
  // Motion sync: the input's file (or a file whose one setting drives ParamX), with
  // the input's sound, or a live input fed from its bytes.
  if (!has_sync) {
    const char* const one =
        R"({"Version":1,"Meta":{"SettingCount":1,"Dictionary":[{"Id":"S","Name":"s"}]},"Settings":[{"Id":"S",)"
        R"("AnalysisType":"CRI","UseCase":"Mouth","CubismParameters":[{"Name":"X","Id":"ParamX","Min":0,"Max":1,)"
        R"("Damper":0.01,"Smooth":20}],"AudioParameters":[{"Name":"S","Id":"Silence","Min":0,"Max":1,"Scale":1,)"
        R"("Enabled":true},{"Name":"A","Id":"A","Min":0,"Max":1,"Scale":2,"Enabled":true}],"Mappings":[{"Type":)"
        R"("Shape","Id":"Silence","Targets":[{"Id":"ParamX","Value":0}]},{"Type":"Shape","Id":"A","Targets":)"
        R"([{"Id":"ParamX","Value":1}]}],"PostProcessing":{"BlendRatio":0.5,"Smoothing":3,"SampleRate":60}}]})";
    fw::parse_motion_sync(one, "ms", *sync, err);
  }
  fw::MotionSyncOptions mso;
  mso.before_physics = (flags & 32) != 0;
  mso.file_smoothing = (flags & 64) != 0;
  if (flags & 128) mso.gate = -k.unit() * 80;
  if (k.next() & 1) mso.hangover = k.unit() * 0.2;
  animator.attach_motion_sync(sync, mso);
  if (has_profile && (k.next() & 1)) animator.motion_sync->set_profile(&profile);
  fw::MotionSyncLiveInput sync_live(1000 + 1000.0 * (k.next() % 96), 4096);
  int usable = -1;
  for (const auto& st : sync->settings)
    if (st.usable) {
      usable = st.index;
      break;
    }
  const bool sync_live_on = usable >= 0 && (!has_sync_sound || (k.next() & 1));
  if (usable >= 0) {
    if (sync_live_on)
      animator.motion_sync->set_input(usable, &sync_live);
    else
      animator.motion_sync->play_sound(usable, sync_sound);
  }
  auto start_motion = [&] {
    fw::MotionStart start;
    const uint8_t m = k.next();
    start.priority = m % 4;
    start.loop = (m & 4) != 0;
    start.legacy_loop = (m & 8) != 0;
    start.hold = (m & 16) != 0;
    start.blink_while_held = (m & 32) != 0;
    if (m & 64) start.offset = k.unit() * 3 - 1;
    if (m & 128) start.weight = k.unit();
    if (k.next() & 1) start.fade_in = k.unit() - 0.25;
    // A loop shorter than this makes the reference's loop endless for long offsets.
    const double L = start.legacy_loop.value_or(false) ? motion->duration : motion->duration + 1 / motion->fps;
    if (start.loop.value_or(false) && !(L >= 0.01 || L <= 0)) start.loop = false;
    fw::ResolvedMotion r;
    r.motion = motion;
    if (has_sound && (m & 1)) {
      r.has_sound = true;
      r.sound = sound;
    }
    animator.start_motion(r, start);
  };
  if (has_motion) start_motion();
  if (has_expression) {
    animator.start_expression(expression);
    animator.expression_layers.add(expression);
  }
  if (has_sound) animator.start_sound(sound);
  animator.set_look_target(k.unit() * 2 - 1, k.unit() * 2 - 1);
  const int frames = 30 + k.next() % 60;
  for (int f = 0; f < frames; f++) {
    const uint8_t s = k.next();
    const double dt = s < 8 ? 0 : s < 16 ? 0.5 : s < 20 ? 3 : 1.0 / (10 + s % 140);
    if (s == 200 && has_motion) start_motion();
    if (s == 201) animator.stop_motions();
    if (s == 202 && has_expression) animator.expression_layers.remove(nullptr);
    if (s == 203) animator.set_part_opacity("Root", k.unit());
    if (s == 204) animator.set_base_parameter(0, k.unit() * 3 - 1);
    if (s == 207) animator.motion_sync->stop(k.unit());
    if (s == 208) animator.enabled.motion_sync = !animator.enabled.motion_sync;
    if (sync_live_on) {
      float block[256];
      const std::size_t n = k.next();
      for (std::size_t i = 0; i < n; i++) block[i] = (static_cast<float>(k.next()) - 128) / 128.0f;
      sync_live.push(block, n);
    }
    if (live_on) {
      float block[64];
      const std::size_t n = 1 + k.next() % 64;
      for (std::size_t i = 0; i < n; i++) block[i] = (static_cast<float>(k.next()) - 128) / 128.0f;
      const float* channels[1] = {block};
      if (s & 1) live.push(channels, 1, n);
      if (s == 205) live.push_sums(k.unit() * 100 - 1, k.next() - 10.0, k.next() - 10.0);
      if (s == 206) live.reset();
    }
    fw::FrameResult r;
    fw::Fault fault;
    if (!animator.frame(dt, r, fault)) break;
    animator.apply_to(instance);
    instance.evaluate();
    fw::hit_test(instance.drawable_vertices[0].data(), instance.drawable_vertices[0].size(), k.unit(), k.unit());
  }
  return 0;
}

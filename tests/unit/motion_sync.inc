// Motion sync (included by main.cpp, inside its anonymous namespace): the
// file reader against Mochi2D's file tests (T4–T17, lint, lookups), the
// per-parameter filter and the tick against their exact vectors (2.10, T14,
// T16), the engine, the driver on a model with DeepSeek-chan's mouth
// parameters (T1–T3, T18, T21, settling, fades, sample accounting, clocks),
// the analysis on synthetic vowels, WAV files, voice profiles and the C API.
// The bit-for-bit comparison of the analysis with Mochi2D is the trace
// cross-check (tests/crosscheck/motion_sync.sh).

namespace ms {

using namespace mochi2d::framework;
namespace t = mochi2d::test;

const char* const kElementIds[6] = {"Silence", "A", "I", "U", "E", "O"};

/** A model with DeepSeek-chan's mouth parameters (ranges and defaults), plus ParamA. */
std::shared_ptr<const moc::Model> mouth_model() {
  moc::MocData d = tiny_model(3, false);
  struct P {
    const char* id;
    float lo, hi;
  };
  const P extra[] = {{"ParamMouthOpenY", 0, 1},  {"ParamMouthForm", -1, 1},   {"MouthFunnel", 0, 1},
                     {"Mouthpucker", 0, 1},      {"MouthPuckerWiden", -1, 1}, {"ParamA", 0, 1}};
  for (const P& p : extra) {
    d.names(F::parameter_id).push_back(p.id);
    d.f32(F::parameter_max).push_back(p.hi);
    d.f32(F::parameter_min).push_back(p.lo);
    d.f32(F::parameter_default).push_back(0);
    d.i32(F::parameter_repeat).push_back(0);
    d.i32(F::parameter_decimals).push_back(3);
    d.i32(F::parameter_firstBinding).push_back(1);
    d.i32(F::parameter_bindingCount).push_back(0);
  }
  return loaded(written(d, 3));
}

json::Value parsed(const std::string& text) {
  json::Value v;
  json::ParseError e;
  json::parse(text, v, e);
  return v;
}

json::Value& mem(json::Value& o, const char* key) {
  for (auto& m : o.members())
    if (m.first == key) return m.second;
  return o.set(key, json::Value());
}
void erase(json::Value& o, const char* key) {
  auto& m = o.members();
  for (auto it = m.begin(); it != m.end(); ++it)
    if (it->first == key) {
      m.erase(it);
      return;
    }
}
json::Value& setting0(json::Value& j) { return mem(j, "Settings").items()[0]; }
json::Value& param(json::Value& j, std::size_t k) { return mem(setting0(j), "CubismParameters").items()[k]; }
json::Value& element(json::Value& j, std::size_t k) { return mem(setting0(j), "AudioParameters").items()[k]; }
json::Value& mapping(json::Value& j, std::size_t k) { return mem(setting0(j), "Mappings").items()[k]; }
json::Value& post(json::Value& j) { return mem(setting0(j), "PostProcessing"); }

MotionSyncFile read(const json::Value& j, bool lint = false) {
  MotionSyncFile f;
  FormatError e;
  MotionSyncReadOptions o;
  o.lint = lint;
  const String text = json::write_compact(j);
  if (!parse_motion_sync(text, "ms", f, e, o)) std::fprintf(stderr, "  parse: %s\n", e.message.c_str());
  return f;
}
template <class Edit>
MotionSyncFile basic(Edit edit) {
  json::Value j = parsed(t::ds_basic_json());
  edit(j);
  return read(j);
}
std::size_t warned(const MotionSyncFile& f, const char* what) {
  std::size_t n = 0;
  for (const auto& w : f.warnings)
    if (w.find(what) != String::npos) n++;
  return n;
}

const double kBasicShapes[6][2] = {{0, 0}, {1, 0}, {0.35, 1}, {0.3, -1}, {0.6, 0.6}, {0.8, -0.6}};
const double kRichShapes[6][5] = {{0, 0, 0, 0, 0},       {1, 0.1, 0, 0, 0.2},   {0.3, 0.7, 0, 0, 1},
                                  {0.25, -0.3, 0.7, 1, 0}, {0.55, 0.4, 0, 0, 0.6}, {0.75, -0.2, 1, 0.4, 0}};

std::shared_ptr<const MotionSyncSound> sound(const std::vector<float>& samples, double rate,
                                             const std::vector<float>* second = nullptr) {
  auto s = std::allocate_shared<MotionSyncSound>(Allocator<MotionSyncSound>());
  s->sample_rate = rate;
  s->channels.emplace_back(samples.begin(), samples.end());
  if (second) s->channels.emplace_back(second->begin(), second->end());
  s->prepare();
  return s;
}

std::shared_ptr<const MotionSyncFile> file_of(const json::Value& j) {
  auto f = std::allocate_shared<MotionSyncFile>(Allocator<MotionSyncFile>());
  *f = read(j);
  return f;
}

/** An analysis with these raw weights (Silence, A, I, U, E, O). */
Analysis analysis(std::array<double, 6> raw, bool silent = false) {
  Analysis a;
  a.raw = raw;
  a.level = -20;
  a.silent = silent;
  a.voicing = 1;
  a.open = 1;
  return a;
}

MotionSyncSetting setting_of(const json::Value& j, std::size_t i = 0) { return read(j).settings[i]; }

struct Ticks {
  std::vector<MotionSyncTick> list;
  static void add(const MotionSyncTick& tick, void* user) { static_cast<Ticks*>(user)->list.push_back(tick); }
};

int strongest(const MotionSyncTick& t) {
  int best = 0;
  for (int e = 1; e < 6; e++)
    if (t.weights[static_cast<std::size_t>(e)] > t.weights[static_cast<std::size_t>(best)]) best = e;
  return best;
}

/** Plays samples at `rate` through the first setting of `json` at 60 frames a second. */
struct Run {
  std::vector<MotionSyncTick> ticks;
  std::vector<double> open;
};
Run play(const std::vector<float>& samples, double rate, const json::Value& json,
         const VoiceProfile* profile = nullptr) {
  const auto model = mouth_model();
  AnimationValues values(*model);
  MotionSyncDriver d(file_of(json), values);
  if (profile) d.set_profile(profile);
  Ticks ticks;
  d.set_listener(Ticks::add, &ticks);
  d.play_sound(0, sound(samples, rate));
  Run run;
  const int frames = static_cast<int>(std::ceil(static_cast<double>(samples.size()) / rate * 60));
  const int i = values.index("ParamMouthOpenY");
  for (int n = 0; n < frames; n++) {
    d.frame(1.0 / 60);
    run.open.push_back(values.values[static_cast<std::size_t>(i)]);
  }
  run.ticks = std::move(ticks.list);
  return run;
}

/** The share of ticks inside the vowels' nuclei whose strongest element is the vowel. */
double accuracy(const Run& run, const std::vector<t::Segment>& segments, double* worst_vowel = nullptr) {
  int right = 0, total = 0;
  double worst = 1;
  for (const auto& s : segments) {
    int r = 0, n = 0;
    for (const auto& tick : run.ticks)
      if (tick.time > s.start + 0.1 && tick.time < s.end - 0.1) {
        n++;
        if (strongest(tick) == s.vowel + 1) r++;
      }
    right += r;
    total += n;
    if (n) worst = std::min(worst, static_cast<double>(r) / n);
  }
  if (worst_vowel) *worst_vowel = worst;
  return total ? static_cast<double>(right) / total : 0;
}

VoiceProfile calibrate(const t::VoiceSpec& voice) {
  VoiceCalibration cal("test voice");
  for (int v = 0; v < 5; v++) {
    t::VoiceOptions o;
    o.f0 = voice.f0 * 1.04;
    o.formant_scale = voice.formant_scale;
    const auto s = t::synthesize_vowel({t::kVowelFormants[v][0], t::kVowelFormants[v][1], t::kVowelFormants[v][2]}, 1,
                                       48000, o);
    const float* ch = s.data();
    cal.add(v + 1, &ch, 1, s.size(), 48000);
  }
  return cal.profile();
}

}  // namespace ms

TEST(motion_sync_file_crafted) {
  using namespace ms;
  const MotionSyncFile f = read(parsed(t::ds_basic_json()), true);
  CHECK(f.warnings.empty());
  CHECK_EQ(f.version, 1.0);
  CHECK_EQ(f.settings.size(), 1u);
  const MotionSyncSetting& s = f.settings[0];
  CHECK(s.index == 0 && s.id == "MS_Basic" && s.name == "Mouth basic" && s.analysis_type == "CRI" &&
        s.use_case == "Mouth" && s.usable);
  CHECK(s.blend_ratio == 0.5 && s.smoothing == 60 && s.sample_rate == 60);
  CHECK_EQ(s.parameters.size(), 2u);
  CHECK(s.parameters[0].id == "ParamMouthOpenY" && s.parameters[0].name == "ParamMouthOpenY" &&
        s.parameters[0].min == 0 && s.parameters[0].max == 1 && s.parameters[0].damper == 0 &&
        s.parameters[0].smooth == 25);
  CHECK(s.parameters[1].id == "ParamMouthForm" && s.parameters[1].min == -1 && s.parameters[1].max == 1);
  CHECK_EQ(s.elements.size(), 6u);
  for (int e = 0; e < 6; e++) {
    const auto& el = s.elements[static_cast<std::size_t>(e)];
    CHECK(el.id == kElementIds[e] && el.scale == 1 && el.enabled && el.known);
    for (int k = 0; k < 2; k++) CHECK_EQ(s.shapes[static_cast<std::size_t>(e)][static_cast<std::size_t>(k)], kBasicShapes[e][k]);
  }
  const MotionSyncFile rich = read(parsed(t::ds_rich_json()), true);
  CHECK(rich.warnings.empty());
  CHECK(rich.settings[0].blend_ratio == 0.3 && rich.settings[0].smoothing == 40 && rich.settings[0].sample_rate == 30);
  const MotionSyncFile two = read(parsed(t::ds_two_json()), true);
  CHECK(two.warnings.empty());
  CHECK(two.settings.size() == 2 && two.settings[1].index == 1 && two.settings[1].id == "MS_Rich" &&
        two.settings[1].name == "Mouth rich");
  for (int e = 0; e < 6; e++)
    for (int k = 0; k < 5; k++)
      CHECK_EQ(two.settings[1].shapes[static_cast<std::size_t>(e)][static_cast<std::size_t>(k)], kRichShapes[e][k]);
  // Bytes with a byte-order mark read alike; invalid JSON and non-objects fail.
  MotionSyncFile g;
  FormatError err;
  CHECK(parse_motion_sync("\xEF\xBB\xBF" + t::ds_basic_json(), "ms", g, err));
  CHECK(g.settings.size() == 1 && g.warnings.empty());
  CHECK(!parse_motion_sync("{", "ms", g, err));
  CHECK(!parse_motion_sync("[]", "ms", g, err));
  CHECK_EQ(std::string(err.message.c_str()), std::string("ms: not a JSON object"));
}

TEST(motion_sync_file_lookup_and_rules) {
  using namespace ms;
  const MotionSyncFile two = read(parsed(t::ds_two_json()));
  CHECK(find_motion_sync_setting(two, "Mouth rich") && find_motion_sync_setting(two, "Mouth rich")->index == 1);
  CHECK(find_motion_sync_setting(two, "MS_Basic") && find_motion_sync_setting(two, "MS_Basic")->index == 0);
  CHECK(!find_motion_sync_setting(two, "Mouth"));
  json::Value tricky = parsed(t::ds_two_json());
  mem(setting0(tricky), "Id") = json::Value("Mouth rich");
  mem(mem(mem(tricky, "Meta"), "Dictionary").items()[0], "Id") = json::Value("Mouth rich");
  CHECK(find_motion_sync_setting(read(tricky), "Mouth rich")->index == 1);
  // T4: an unknown analysis type.
  json::Value t4 = parsed(t::ds_two_json());
  mem(setting0(t4), "AnalysisType") = json::Value("XYZ");
  const MotionSyncFile f4 = read(t4);
  CHECK(!f4.settings[0].usable && f4.settings[1].usable);
  CHECK_EQ(warned(f4, "Settings[0].AnalysisType"), 1u);
  // T5, T6: another use case or mapping type is used anyway.
  const MotionSyncFile f5 = basic([](json::Value& j) {
    mem(setting0(j), "UseCase") = json::Value("Eyes");
    mem(mapping(j, 1), "Type") = json::Value("Curve");
  });
  CHECK(f5.settings[0].usable);
  CHECK(f5.settings[0].shapes == read(parsed(t::ds_basic_json())).settings[0].shapes);
  CHECK_EQ(warned(f5, "UseCase"), 1u);
  CHECK_EQ(warned(f5, "Mappings[1].Type"), 1u);
  // T7: SettingCount reads the smaller count.
  const MotionSyncFile f7 = basic([](json::Value& j) { mem(mem(j, "Meta"), "SettingCount") = json::Value(2); });
  CHECK(f7.settings.size() == 1 && warned(f7, "Meta.SettingCount") == 1);
  CHECK_EQ(std::string(f7.warnings[0].c_str()), std::string("ms: Meta.SettingCount is 2, but Settings has 1; 1 read"));
  const MotionSyncFile f7b = basic([](json::Value& j) { mem(mem(j, "Meta"), "SettingCount") = json::Value(0); });
  CHECK(f7b.settings.empty() && warned(f7b, "Meta.SettingCount") == 1);
  // T8, T9: mappings and targets in any order.
  const auto want = read(parsed(t::ds_basic_json())).settings[0].shapes;
  const MotionSyncFile f8 = basic([](json::Value& j) {
    auto& m = mem(setting0(j), "Mappings").items();
    std::reverse(m.begin(), m.end());
  });
  CHECK(f8.warnings.empty() && f8.settings[0].shapes == want);
  const MotionSyncFile f9 = basic([](json::Value& j) {
    for (auto& m : mem(setting0(j), "Mappings").items()) {
      auto& tg = mem(m, "Targets").items();
      std::reverse(tg.begin(), tg.end());
    }
  });
  CHECK(f9.warnings.empty() && f9.settings[0].shapes == want);
  // T10: Enabled false; the number 1 reads as false.
  const MotionSyncFile off = basic([](json::Value& j) { mem(element(j, 4), "Enabled") = json::Value(false); });
  CHECK(off.warnings.empty() && off.settings[0].elements[4].id == "E" && !off.settings[0].elements[4].enabled);
  const MotionSyncFile one = basic([](json::Value& j) { mem(element(j, 4), "Enabled") = json::Value(1); });
  CHECK(!one.settings[0].elements[4].enabled && warned(one, "AudioParameters[4].Enabled") == 1);
  // T11, T12: Scale and BlendRatio limited.
  for (const auto& c : {std::pair<double, double>{0.05, 0.1}, {20, 10}}) {
    const double given = c.first;
    const MotionSyncFile f = basic([&](json::Value& j) { mem(element(j, 1), "Scale") = json::Value(given); });
    CHECK(f.settings[0].elements[1].scale == c.second && warned(f, "AudioParameters[1].Scale") == 1);
  }
  const MotionSyncFile f11 = basic([](json::Value& j) { mem(element(j, 1), "Scale") = json::Value(20); });
  CHECK_EQ(std::string(f11.warnings[0].c_str()),
           std::string("ms: Settings[0].AudioParameters[1].Scale 20 is outside [0.1, 10]; 10 is used"));
  for (const auto& c : {std::pair<double, double>{-0.1, 0}, {1.5, 1}}) {
    const double given = c.first;
    const MotionSyncFile f = basic([&](json::Value& j) { mem(post(j), "BlendRatio") = json::Value(given); });
    CHECK(f.settings[0].blend_ratio == c.second && warned(f, "BlendRatio") == 1);
  }
  // T13: Smoothing as an integer, then limited.
  struct S3 {
    double given, used;
    std::size_t warns;
  };
  for (const S3& c : {S3{0, 1, 1}, S3{101, 100, 1}, S3{60.7, 60, 0}, S3{-0.5, 1, 1}, S3{1.9, 1, 0}}) {
    const MotionSyncFile f = basic([&](json::Value& j) { mem(post(j), "Smoothing") = json::Value(c.given); });
    CHECK(f.settings[0].smoothing == c.used && warned(f, "Smoothing") == c.warns);
  }
  // T14: SampleRate.
  for (const S3& c : {S3{0, 60, 1}, S3{-30, 60, 1}, S3{0.5, 1, 1}, S3{120, 120, 0}, S3{240, 120, 1}}) {
    const MotionSyncFile f = basic([&](json::Value& j) { mem(post(j), "SampleRate") = json::Value(c.given); });
    CHECK(f.settings[0].sample_rate == c.used && warned(f, "SampleRate") == c.warns);
  }
  const MotionSyncFile missing_rate = basic([](json::Value& j) { erase(post(j), "SampleRate"); });
  CHECK(missing_rate.settings[0].sample_rate == 60 && warned(missing_rate, "SampleRate") == 2);
  // T16: Smooth limited; a negative Damper acts as 0, silently.
  for (const S3& c : {S3{0, 0, 0}, S3{100, 100, 0}, S3{150, 100, 1}, S3{-5, 0, 1}}) {
    const MotionSyncFile f = basic([&](json::Value& j) { mem(param(j, 0), "Smooth") = json::Value(c.given); });
    CHECK(f.settings[0].parameters[0].smooth == c.used && warned(f, "Smooth") == c.warns);
  }
  for (const auto& c : {std::pair<double, double>{0.05, 0.05}, {1, 1}, {-1, 0}}) {
    const double given = c.first;
    const MotionSyncFile f = basic([&](json::Value& j) { mem(param(j, 1), "Damper") = json::Value(given); });
    CHECK(f.settings[0].parameters[1].damper == c.second && f.warnings.empty());
  }
  // T17: another Version.
  const MotionSyncFile f17 = basic([](json::Value& j) { mem(j, "Version") = json::Value(2); });
  CHECK(f17.version == 2 && f17.settings[0].usable && warned(f17, "Version") == 1);
}

TEST(motion_sync_file_lenient) {
  using namespace ms;
  const MotionSyncFile f = basic([](json::Value& j) {
    mem(param(j, 0), "Smooth") = json::Value("25");
    erase(param(j, 1), "Damper");
    mem(element(j, 2), "Scale") = json::Value(nullptr);
    erase(element(j, 3), "Enabled");
    mem(post(j), "BlendRatio") = json::Value(true);
    mem(mem(mem(j, "Meta"), "Dictionary").items()[0], "Name") = json::Value(7);
  });
  const MotionSyncSetting& s = f.settings[0];
  CHECK(s.parameters[0].smooth == 0 && s.parameters[1].damper == 0 && s.elements[2].scale == 0.1 &&
        !s.elements[3].enabled && s.blend_ratio == 0 && s.name.empty());
  CHECK_EQ(warned(f, "CubismParameters[0].Smooth"), 1u);
  CHECK_EQ(warned(f, "CubismParameters[1].Damper"), 1u);
  CHECK_EQ(warned(f, "AudioParameters[2].Scale"), 2u);
  CHECK_EQ(warned(f, "AudioParameters[3].Enabled"), 1u);
  CHECK_EQ(warned(f, "BlendRatio"), 1u);
  CHECK_EQ(warned(f, "Dictionary[0].Name"), 1u);
  CHECK(warned(f, "ms: Settings[0].CubismParameters[1].Damper is missing; 0 is used") == 1);
  CHECK(warned(f, "ms: Settings[0].AudioParameters[3].Enabled is missing; read as false") == 1);
  // Integer fields from their decimal text.
  CHECK_EQ(basic([](json::Value& j) { mem(j, "Version") = json::Value(1.9); }).version, 1.0);
  CHECK_EQ(basic([](json::Value& j) { mem(mem(j, "Meta"), "SettingCount") = json::Value(1.5); }).settings.size(), 1u);
  CHECK(basic([](json::Value& j) { mem(mem(j, "Meta"), "SettingCount") = json::Value("1"); }).settings.empty());
  CHECK_EQ(js_integer_of_number(5e-7), 5.0);
  CHECK_EQ(js_integer_of_number(1.5e21), 1.0);
  CHECK(js_integer_of_number(-0.5) == 0 && !std::signbit(js_integer_of_number(-0.5)));
  CHECK_EQ(js_integer_of_number(-2.7), -2.0);
  CHECK_EQ(js_integer_of_number(std::numeric_limits<double>::infinity()), 0.0);
  // Targets matched by ID: a missing target or mapping is 0, with a warning.
  const MotionSyncFile target = basic([](json::Value& j) { mem(mapping(j, 1), "Targets").items().pop_back(); });
  CHECK(target.settings[0].shapes[1] == Vector<double>({1, 0}));
  CHECK_EQ(warned(target, "\"A\" has no target for \"ParamMouthForm\""), 1u);
  const MotionSyncFile no_map = basic([](json::Value& j) {
    auto& m = mem(setting0(j), "Mappings").items();
    m.erase(m.begin() + 2);
  });
  CHECK(no_map.settings[0].shapes[2] == Vector<double>({0, 0}));
  CHECK_EQ(warned(no_map, "no shape for element \"I\""), 1u);
  // Mappings beyond the number of elements are ignored.
  const MotionSyncFile extra = basic([](json::Value& j) {
    mem(setting0(j), "AudioParameters").items().pop_back();
    auto& m = mem(setting0(j), "Mappings").items();
    json::Value last = m.back();
    m.pop_back();
    m.insert(m.begin(), last);
  });
  CHECK_EQ(extra.settings[0].elements.size(), 5u);
  CHECK_EQ(warned(extra, "no shape for element \"E\""), 1u);
  // An unknown element.
  const MotionSyncFile ah = basic([](json::Value& j) {
    mem(element(j, 5), "Id") = json::Value("Ah");
    mem(mapping(j, 5), "Id") = json::Value("Ah");
  });
  CHECK(ah.settings[0].elements[5].id == "Ah" && !ah.settings[0].elements[5].known);
  CHECK_EQ(warned(ah, "\"Ah\" is not one of"), 1u);
  // A dictionary ID that differs.
  const MotionSyncFile other = basic([](json::Value& j) {
    mem(mem(mem(j, "Meta"), "Dictionary").items()[0], "Id") = json::Value("Other");
  });
  CHECK(other.settings[0].id == "MS_Basic" && warned(other, "Meta.Dictionary[0].Id") == 1);
  // Lint mode.
  json::Value lint = parsed(t::ds_basic_json());
  mem(lint, "Extra") = json::Value(1);
  mem(post(lint), "VolumeRatio") = json::Value(0);
  mem(mem(mapping(lint, 0), "Targets").items()[0], "Weight") = json::Value(1);
  CHECK(read(lint).warnings.empty());
  const MotionSyncFile linted = read(lint, true);
  CHECK_EQ(linted.warnings.size(), 3u);
  if (linted.warnings.size() == 3) {
    CHECK_EQ(std::string(linted.warnings[0].c_str()), std::string("ms: Extra is not part of the format; ignored"));
    CHECK_EQ(std::string(linted.warnings[1].c_str()),
             std::string("ms: Settings[0].Mappings[0].Targets[0].Weight is not part of the format; ignored"));
    CHECK_EQ(std::string(linted.warnings[2].c_str()),
             std::string("ms: Settings[0].PostProcessing.VolumeRatio is not part of the format; ignored"));
  }
  // The links in model settings.
  ModelSettings ms_settings;
  String message;
  CHECK(parse_model_settings(
      R"({"Version":3,"FileReferences":{"Moc":"m.moc3","Textures":[],"MotionSync":"m.motionsync3.json","Motions":{"Talk":[{"File":"a.motion3.json","Sound":"a.wav","MotionSync":"Mouth basic"},{"File":"a.motion3.json","Sound":"b.wav"},{"File":"b.motion3.json","MotionSync":3}]}}})",
      "s", ms_settings, message));
  CHECK(ms_settings.motion_sync == "m.motionsync3.json");
  const MotionGroup* talk = ms_settings.motion_group("Talk");
  CHECK(talk && talk->entries.size() == 3 && talk->entries[0].motion_sync == "Mouth basic" &&
        talk->entries[1].motion_sync.empty() && talk->entries[2].motion_sync.empty());
}

TEST(motion_sync_filter_and_tick) {
  using namespace ms;
  // The filter vector: Smooth 25, Damper 0.05.
  ParameterFilter f(Vector<double>{25}, Vector<double>{0.05});
  const double zero[1] = {0};
  f.reset(zero);
  const double ys[5] = {1, 1, 1, 0.98, 0.98};
  const double S[5] = {0.75, 0.9375, 0.984375, 0.98109375, 0.9802734375};
  const double D[5] = {0.75, 0.9375, 0.9375, 0.9375, 0.9375};
  for (int i = 0; i < 5; i++) {
    f.step(&ys[i]);
    CHECK_EQ(f.smoothed[0], S[i]);
    CHECK_EQ(f.output[0], D[i]);
  }
  // T16: Smooth 0 passes values through, 100 freezes them; Damper 0 always follows.
  ParameterFilter g(Vector<double>{0, 100, 25}, Vector<double>{0, 0, 0});
  const double start[3] = {0.2, 0.2, 0.2};
  g.reset(start);
  for (double y : {1.0, 0.5, 0.25}) {
    const double yy[3] = {y, y, y};
    g.step(yy);
    CHECK(g.output[0] == y && g.output[1] == 0.2 && g.output[2] == g.smoothed[2]);
  }
  ParameterFilter h(Vector<double>{0}, Vector<double>{1});
  h.reset(zero);
  for (auto [y, want] : {std::pair<double, double>{0.99, 0}, {1, 1}, {0.01, 1}}) {
    h.step(&y);
    CHECK_EQ(h.output[0], want);
  }
  ParameterFilter n(Vector<double>{25, 25}, Vector<double>{0.1, 0.1}, false);
  const double z2[2] = {0, 0};
  n.reset(z2);
  const double a[2] = {std::numeric_limits<double>::quiet_NaN(), 0.5};
  n.step(a);
  CHECK(n.smoothed[0] == 0 && n.smoothed[1] == 0.5 && n.output[0] == 0 && n.output[1] == 0.5);
  const double b[2] = {0.05, 0.55};
  n.step(b);
  CHECK(n.smoothed[0] == 0.05 && n.smoothed[1] == 0.55 && n.output[0] == 0 && n.output[1] == 0.5);
  // The tick schedule vectors.
  const auto ticks = [](double rate, double dt, int frames) {
    TickClock c(rate);
    std::vector<int> out;
    for (int i = 1; i <= frames; i++)
      if (c.advance(dt)) out.push_back(i);
    return out;
  };
  TickClock c(60);
  CHECK(!c.advance(1.0 / 144) && !c.advance(1.0 / 144) && c.advance(1.0 / 144));
  CHECK(std::fabs(c.time - 0.0041667) < 5e-8);
  const auto t144 = ticks(60, 1.0 / 144, 288);
  CHECK(t144.size() == 119 && t144[0] == 3 && t144[1] == 5 && t144[2] == 8 && t144[3] == 10 && t144[4] == 13);
  CHECK_EQ(std::count_if(t144.begin(), t144.end(), [](int x) { return x <= 144; }), 59);
  CHECK_EQ(ticks(60, 1.0 / 30, 60).size(), 60u);
  CHECK_EQ(ticks(60, 1, 5).size(), 5u);
  CHECK(ticks(60, 1.0 / 120, 4) == std::vector<int>({2, 4}));
  CHECK(ticks(60, 0, 100).empty() && ticks(60, -1, 100).empty());
  // T14: rates as the reader limits them, at 30, 60 and 144 fps.
  std::vector<double> rates;
  for (double r : {0.0, 0.5, 120.0, 240.0})
    rates.push_back(basic([&](json::Value& j) { mem(post(j), "SampleRate") = json::Value(r); }).settings[0].sample_rate);
  CHECK(rates == std::vector<double>({60, 1, 120, 120}));
  for (double fps : {30.0, 60.0, 144.0})
    for (double rate : rates) {
      const double count = static_cast<double>(ticks(rate, 1 / fps, static_cast<int>(10 * fps)).size());
      CHECK(std::fabs(count - 10 * std::min(rate, fps)) <= 1);
    }
}

TEST(motion_sync_engine) {
  using namespace ms;
  const auto basic_with = [](auto edit) {
    json::Value j = parsed(t::ds_basic_json());
    edit(j);
    return setting_of(j);
  };
  const auto at = [&](double br, std::array<double, 6> raw) {
    const MotionSyncSetting s = basic_with([&](json::Value& j) { mem(post(j), "BlendRatio") = json::Value(br); });
    SettingEngine e(s);
    e.step(analysis(raw), 1.0 / 60);
    return std::vector<double>(e.values.begin(), e.values.end());
  };
  const std::array<double, 6> raw = {0, 0.5, 0.3, 0, 0.2, 0};
  CHECK(at(0, raw) == std::vector<double>({1, 0}));
  const double blend[2] = {0.5 * 1 + 0.3 * 0.35 + 0.2 * 0.6, 0.3 * 1 + 0.2 * 0.6};
  const auto b1 = at(1, raw);
  const auto b5 = at(0.5, raw);
  for (int k = 0; k < 2; k++) {
    CHECK(std::fabs(b1[static_cast<std::size_t>(k)] - blend[k]) < 1e-12);
    CHECK(std::fabs(b5[static_cast<std::size_t>(k)] - (0.5 * kBasicShapes[1][k] + 0.5 * blend[k])) < 1e-12);
  }
  CHECK(at(0, {0, 0, 0.5, 0.5, 0, 0}) == std::vector<double>({0.35, 1}));
  // Normalized after the gate, Enabled and Scale; with nothing left, Silence.
  const MotionSyncSetting s2 = basic_with([](json::Value& j) {
    mem(element(j, 1), "Enabled") = json::Value(false);
    mem(element(j, 2), "Scale") = json::Value(3);
  });
  SettingEngine e(s2);
  e.step(analysis({0.2, 0.4, 0.2, 0.2, 0, 0}), 1.0 / 60);
  const double w[6] = {0.2, 0, 0.6, 0.2, 0, 0};
  for (int i = 0; i < 6; i++) CHECK(std::fabs(e.weights[static_cast<std::size_t>(i)] - w[i]) < 1e-12);
  e.reset();
  e.step(analysis({0, 1, 0, 0, 0, 0}), 1.0 / 60);
  CHECK(e.weights == Vector<double>({1, 0, 0, 0, 0, 0}) && e.values == Vector<double>({0, 0}));
  e.reset();
  e.step(analysis({0.1, 0, 0.9, 0, 0, 0}, true), 1.0 / 60);
  CHECK(e.weights == Vector<double>({1, 0, 0, 0, 0, 0}));
  // An unknown element gets no weight.
  const MotionSyncSetting s3 = basic_with([](json::Value& j) {
    mem(element(j, 5), "Id") = json::Value("Ah");
    mem(mapping(j, 5), "Id") = json::Value("Ah");
  });
  SettingEngine u(s3);
  u.step(analysis({0, 0, 0, 0, 0, 1}), 1.0 / 60);
  CHECK(u.weights[5] == 0 && u.weights[0] == 1);
  // Slew limits: attack away from Silence, release back, 1.5 times slower.
  for (double smoothing : {1.0, 60.0, 100.0}) {
    const MotionSyncSetting s = basic_with([&](json::Value& j) {
      mem(post(j), "Smoothing") = json::Value(smoothing);
      mem(post(j), "BlendRatio") = json::Value(0);
    });
    SettingEngine x(s);
    const double attack = 0.02 * std::pow(25, (smoothing - 1) / 99);
    const double dt = 1.0 / 120;
    x.step(analysis({1, 0, 0, 0, 0, 0}), dt);
    CHECK_EQ(x.values[0], 0.0);
    x.step(analysis({0, 1, 0, 0, 0, 0}), dt);
    CHECK(std::fabs(x.values[0] - std::min(1.0, dt / attack)) < 1e-12);
    double time = dt;
    while (x.values[0] < 1) {
      x.step(analysis({0, 1, 0, 0, 0, 0}), dt);
      time += dt;
    }
    CHECK(std::fabs(time - std::max(dt, std::ceil(attack / dt - 1e-9) * dt)) < 1e-9);
    x.step(analysis({1, 0, 0, 0, 0, 0}), dt);
    CHECK(std::fabs((1 - x.values[0]) - std::min(1.0, dt / (1.5 * attack))) < 1e-12);
  }
  // Not a linear filter: a step twice as large does not move twice as far.
  const MotionSyncSetting sb = setting_of(parsed(t::ds_basic_json()));
  SettingEngine e1(sb), e2(sb);
  e1.step(analysis({1, 0, 0, 0, 0, 0}), 1.0 / 60);
  e2.step(analysis({1, 0, 0, 0, 0, 0}), 1.0 / 60);
  e1.step(analysis({0, 0, 0, 0, 1, 0}), 1.0 / 60);
  e2.step(analysis({0, 1, 0, 0, 0, 0}), 1.0 / 60);
  CHECK_EQ(e1.values[0], e2.values[0]);
}

TEST(motion_sync_driver) {
  using namespace ms;
  const auto model = mouth_model();
  CHECK(model != nullptr);
  if (!model) return;
  const t::Clip male = t::vowel_clip(t::kMale, 16000);
  // T1–T3: a parameter whose range differs is driven, one the model lacks is not.
  {
    json::Value j = parsed(t::ds_basic_json());
    auto& p = mem(setting0(j), "CubismParameters").items();
    mem(p[1], "Min") = json::Value(0);
    json::Value z = p[0], a = p[0];
    mem(z, "Id") = json::Value("ParamMouthOpenZ");
    mem(z, "Name") = json::Value("Z");
    mem(a, "Id") = json::Value("ParamA");
    mem(a, "Name") = json::Value("A");
    p.push_back(z);
    p.push_back(a);
    for (auto& m : mem(setting0(j), "Mappings").items()) {
      const bool is_a = mem(m, "Id").as_string() == "A";
      json::Value tz = json::Value::object(), ta = json::Value::object();
      tz.set("Id", json::Value("ParamMouthOpenZ"));
      tz.set("Value", json::Value(1));
      ta.set("Id", json::Value("ParamA"));
      ta.set("Value", json::Value(is_a ? 1 : 0));
      mem(m, "Targets").push(tz);
      mem(m, "Targets").push(ta);
    }
    AnimationValues values(*model);
    MotionSyncDriver d(file_of(j), values);
    d.play_sound(0, sound(male.samples, 16000));
    CHECK_EQ(d.warnings.size(), 2u);
    if (d.warnings.size() == 2) {
      CHECK(d.warnings[0].find("ParamMouthForm the range [0, 1], the model [-1, 1]; driven anyway") != String::npos);
      CHECK(d.warnings[1].find("drives ParamMouthOpenZ, which the model lacks; it is not written") != String::npos);
    }
    for (double tt = 0; tt < male.segments[0].start + 0.5; tt += 1.0 / 60) d.frame(1.0 / 60);
    const MotionSyncTick* tick = d.tick();
    CHECK(tick && tick->values[3] > 0.5);
    if (tick) {
      CHECK(std::fabs(values.get("ParamA") - tick->values[3]) < 1e-6);
      CHECK(std::fabs(values.get("ParamMouthOpenY") - tick->values[0]) < 1e-6);
    }
    CHECK_EQ(values.index("ParamMouthOpenZ"), -1);
  }
  // Nothing written before the first tick, then D every frame, ticking or not.
  {
    AnimationValues values(*model);
    MotionSyncDriver d(file_of(parsed(t::ds_basic_json())), values);
    const int i = values.index("ParamMouthOpenY");
    d.play_sound(0, sound(male.samples, 16000));
    const double dt = 1.0 / 144;
    values.set_at(i, 0.42);
    d.frame(dt);
    d.frame(dt);
    CHECK(std::fabs(values.values[static_cast<std::size_t>(i)] - 0.42) < 1e-6);
    Ticks ticks;
    d.set_listener(Ticks::add, &ticks);
    bool exact = true;
    for (int n = 0; n < 400; n++) {
      values.set_at(i, 0.42);
      d.frame(dt);
      exact = exact && d.tick() && values.values[static_cast<std::size_t>(i)] == static_cast<float>(d.tick()->values[0]);
    }
    CHECK(exact);
    CHECK(ticks.list.size() > 150 && ticks.list.size() < 170);
  }
  // Settles to the Silence shape after a sound ends, then stops writing.
  {
    json::Value j = parsed(t::ds_basic_json());
    for (auto& p : mem(setting0(j), "CubismParameters").items()) mem(p, "Damper") = json::Value(0.02);
    AnimationValues values(*model);
    MotionSyncDriver d(file_of(j), values);
    const int i = values.index("ParamMouthOpenY");
    t::ClipOptions o;
    o.vowels = {0};
    o.gap = 0.1;
    o.hold = 0.6;
    const t::Clip a = t::vowel_clip(t::kMale, 16000, o);
    std::vector<float> first(a.samples.begin(), a.samples.begin() + 9600);
    d.play_sound(0, sound(first, 16000));
    for (double tt = 0; tt < 0.6 - 1e-9; tt += 1.0 / 60) d.frame(1.0 / 60);
    CHECK(values.values[static_cast<std::size_t>(i)] > 0.3);
    CHECK(!d.playing());
    double settled_after = -1;
    for (int n = 1; n <= 40; n++) {
      values.set_at(i, 0.9);
      d.frame(1.0 / 60);
      if (!d.setting()) {
        settled_after = n / 60.0;
        break;
      }
    }
    CHECK(settled_after > 0 && settled_after <= 0.5 + 1e-9);
    values.set_at(i, 0.9);
    d.frame(1.0 / 60);
    CHECK(std::fabs(values.values[static_cast<std::size_t>(i)] - 0.9) < 1e-6);
  }
  // An early stop fades the sound out first.
  {
    AnimationValues values(*model);
    MotionSyncDriver d(file_of(parsed(t::ds_basic_json())), values);
    t::ClipOptions o;
    o.vowels = {0};
    o.hold = 3;
    d.play_sound(0, sound(t::vowel_clip(t::kMale, 16000, o).samples, 16000));
    for (int n = 0; n < 60; n++) d.frame(1.0 / 60);
    CHECK(d.tick() && d.tick()->values[0] > 0.5);
    d.stop(0.5);
    CHECK(d.playing());
    std::vector<double> levels;
    for (int n = 0; n < 32 && d.playing(); n++) {
      d.frame(1.0 / 60);
      levels.push_back(d.tick()->level);
    }
    CHECK(levels.size() >= 30 && levels[25] < levels[2] - 10);
    CHECK(!d.playing());
  }
  // T18: only the bound setting writes; a new binding starts from the current values.
  {
    AnimationValues values(*model);
    MotionSyncDriver d(file_of(parsed(t::ds_two_json())), values);
    const auto glide = t::glide_clip(t::kMale, 4, 44100);
    const auto gs = sound(glide, 44100);
    d.play_sound(0, gs);
    for (int n = 0; n < 60; n++) d.frame(1.0 / 60);
    CHECK(d.setting() && d.setting()->index == 0);
    const int funnel = values.index("MouthFunnel");
    values.set_at(funnel, 0.37);
    d.play_sound(1, gs);
    d.frame(1.0 / 240);
    CHECK(std::fabs(values.get("MouthFunnel") - 0.37) < 1e-6);
    for (int n = 0; n < 60; n++) {
      values.set_at(funnel, 0.37);
      d.frame(1.0 / 60);
    }
    CHECK(d.setting() && d.setting()->index == 1 && d.driven_ids().size() == 5 && d.driven_ids()[2] == "MouthFunnel");
    for (std::size_t k = 0; k < 5; k++)
      CHECK(std::fabs(values.get(d.setting()->parameters[k].id) - d.tick()->values[k]) < 1e-6);
  }
  // Consecutive sounds on one setting carry its state over.
  {
    AnimationValues values(*model);
    MotionSyncDriver d(file_of(parsed(t::ds_basic_json())), values);
    t::ClipOptions o;
    o.vowels = {0};
    d.play_sound(0, sound(t::vowel_clip(t::kMale, 16000, o).samples, 16000));
    for (int n = 0; n < 50; n++) d.frame(1.0 / 60);
    const double open = values.get("ParamMouthOpenY");
    CHECK(open > 0.5);
    d.play_sound(0, sound(t::silence(1, 16000), 16000));
    d.frame(1.0 / 60);
    CHECK(values.get("ParamMouthOpenY") > open - 0.2);
  }
  // Every sample accounted for: 2 s at 44.1 kHz consume 88,200.
  {
    AnimationValues values(*model);
    MotionSyncDriver d(file_of(parsed(t::ds_basic_json())), values);
    d.play_sound(0, sound(t::silence(2, 44100), 44100));
    for (int n = 0; n < 120; n++) d.frame(1.0 / 60);
    CHECK_EQ(d.consumed, 88200.0);
    for (int n = 0; n < 30; n++) d.frame(1.0 / 60);
    CHECK_EQ(d.consumed, 88200.0);
  }
  // Follows an audio clock over 60 s without drift.
  {
    AnimationValues values(*model);
    MotionSyncDriver d(file_of(parsed(t::ds_basic_json())), values);
    const double rate = 48000;
    const auto longer = t::glide_clip(t::kMale, 60, rate);
    struct Clock final : MotionSyncClock {
      double time = 0;
      bool position(double& s) override {
        s = time;
        return true;
      }
    } clock;
    d.play_sound(0, sound(longer, rate), &clock);
    bool close = true;
    for (int n = 1; n <= 3610; n++) {
      clock.time = std::min(60.0, n * (1.0 / 60) * 1.001 + (n % 3) * 0.002);
      d.frame(1.0 / 60);
      const double played = js_round(clock.time * rate);
      close = close && std::fabs(d.consumed - played) <= js_round(0.02 * rate);
    }
    CHECK(close);
    CHECK_EQ(d.consumed, static_cast<double>(longer.size()));
  }
  // T21: sounds at 8 kHz and at 192 kHz.
  for (double rate : {8000.0, 192000.0}) {
    AnimationValues values(*model);
    MotionSyncDriver d(file_of(parsed(t::ds_basic_json())), values);
    t::ClipOptions o;
    o.vowels = {0, 1};
    const t::Clip clip = t::vowel_clip(t::kMale, rate, o);
    d.play_sound(0, sound(clip.samples, rate));
    struct Strong {
      const t::Clip* clip;
      int a = 0, i = 0, n = 0;
      static void add(const MotionSyncTick& tick, void* user) {
        auto* s = static_cast<Strong*>(user);
        bool inside = false;
        for (const auto& seg : s->clip->segments)
          if (tick.time > seg.start + 0.1 && tick.time < seg.end - 0.1) inside = true;
        if (!inside) return;
        s->n++;
        const int best = strongest(tick);
        if (best == 1) s->a++;
        if (best == 2) s->i++;
      }
    } strong{&clip};
    d.set_listener(Strong::add, &strong);
    for (int n = 0; n < 180; n++) d.frame(1.0 / 60);
    CHECK_EQ(d.consumed, static_cast<double>(clip.samples.size()));
    CHECK(strong.a + strong.i > 0.9 * strong.n);
    CHECK(std::min(strong.a, strong.i) > 0.4 * strong.n);
  }
}

TEST(motion_sync_analysis) {
  using namespace ms;
  // The neutral profile in the library is the one Mochi2D builds (and the
  // cross-check compares it with Mochi2D's own, byte for byte).
  CHECK(voice_profile_to_json(neutral_voice_profile()) == voice_profile_to_json(t::build_neutral_profile()));
  const VoiceProfile neutral = neutral_voice_profile();
  for (int v = 0; v < 5; v++) CHECK(neutral.vowel_templates(v) && neutral.vowel_templates(v)->size() == 4);
  CHECK_EQ(neutral.voiced_level, -26.0);
  // Vowels: the strongest element, male at 16 kHz and female at 48 kHz, with and without calibration.
  const json::Value basic_json = parsed(t::ds_basic_json());
  for (const auto& [voice, rate] : {std::pair<t::VoiceSpec, double>{t::kMale, 16000}, {t::kFemale, 48000}})
    for (bool calibrated : {false, true}) {
      const t::Clip clip = t::vowel_clip(voice, rate);
      const VoiceProfile p = calibrate(voice);
      const Run run = play(clip.samples, rate, basic_json, calibrated ? &p : nullptr);
      double worst = 0;
      CHECK(accuracy(run, clip.segments, &worst) >= 0.9);
      CHECK(worst >= 0.8);
    }
  // Levels and the gate.
  t::ClipOptions quiet;
  quiet.level = -40;
  const t::Clip q = t::vowel_clip(t::kMale, 16000, quiet);
  CHECK(accuracy(play(q.samples, 16000, basic_json), q.segments) >= 0.9);
  quiet.level = -55;
  const Run gated = play(t::vowel_clip(t::kMale, 16000, quiet).samples, 16000, basic_json);
  bool all_silent = !gated.ticks.empty();
  for (const auto& tick : gated.ticks) all_silent = all_silent && tick.silent && tick.weights[0] == 1;
  for (double v : gated.open) all_silent = all_silent && v == 0;
  CHECK(all_silent);
  for (const auto& samples : {t::silence(2, 44100), t::white_noise(2, 44100, -60)}) {
    const Run run = play(samples, 44100, basic_json);
    bool still = run.ticks.size() > 100;
    for (const auto& tick : run.ticks) still = still && tick.silent;
    for (double v : run.open) still = still && v == 0;
    CHECK(still);
  }
  // A DC offset is removed.
  const t::Clip clip = t::vowel_clip(t::kMale, 16000);
  std::vector<float> dc(clip.samples);
  for (auto& v : dc) v = static_cast<float>(static_cast<double>(v) + 0.1);
  CHECK(accuracy(play(dc, 16000, basic_json), clip.segments) >= 0.9);
  // What a tick reports.
  t::ClipOptions only_a;
  only_a.vowels = {0};
  const Run run = play(t::vowel_clip(t::kMale, 16000, only_a).samples, 16000, basic_json);
  CHECK(run.ticks.size() > 70);
  bool sums = true;
  for (const auto& tick : run.ticks) {
    double s = 0;
    for (double w : tick.weights) s += w;
    sums = sums && std::fabs(s - 1) < 1e-12 && tick.values.size() == 2 && tick.name == "Mouth basic" &&
           tick.id == "MS_Basic" && !tick.live;
  }
  CHECK(sums);
  for (const auto& tick : run.ticks)
    if (tick.time > 0.8) {
      CHECK(std::fabs(tick.level + 18) < 0.5 && !tick.silent);
      break;
    }
  // Voice profiles: JSON both ways; anything else refused.
  const VoiceProfile p = calibrate(t::kMale);
  CHECK(p.templates.size() == 5 && std::fabs(p.voiced_level + 18) < 0.5 && !p.floor_level);
  const String text = voice_profile_to_json(p);
  json::Value v;
  json::ParseError pe;
  CHECK(json::parse(text, v, pe));
  VoiceProfile back;
  String message;
  CHECK(voice_profile_from_json(v, back, message) && voice_profile_to_json(back) == text);
  CHECK(!voice_profile_from_json(parsed(R"({"format":"other"})"), back, message));
  CHECK(message == "not a Mochi2D voice profile (format mochi2d-voice-profile, version 1)");
  json::Value bad = v;
  mem(bad, "templates") = parsed(R"({"A":[[1,2,3]]})");
  CHECK(!voice_profile_from_json(bad, back, message) && message.find("templates.A") != String::npos);
  bad = v;
  mem(bad, "voicedLevel") = json::Value("loud");
  CHECK(!voice_profile_from_json(bad, back, message) && message.find("voicedLevel") != String::npos);
  // A recorded noise floor raises the gate above it.
  VoiceCalibration cal;
  for (int vw = 0; vw < 5; vw++) {
    t::VoiceOptions o;
    o.f0 = 130;
    const auto s = t::synthesize_vowel({t::kVowelFormants[vw][0], t::kVowelFormants[vw][1], t::kVowelFormants[vw][2]},
                                       1, 16000, o);
    const float* ch = s.data();
    cal.add(vw + 1, &ch, 1, s.size(), 16000);
  }
  const auto noise = t::white_noise(1, 16000, -46);
  const float* nch = noise.data();
  CHECK(cal.add(0, &nch, 1, noise.size(), 16000) > 90);
  const VoiceProfile floor = cal.profile();
  CHECK(floor.floor_level && std::fabs(*floor.floor_level + 46) < 0.5);
  {
    const auto model = mouth_model();
    AnimationValues values(*model);
    MotionSyncDriver d(file_of(basic_json), values);
    d.set_profile(&floor);
    d.play_sound(0, sound(t::white_noise(1, 16000, -44), 16000));
    Ticks ticks;
    d.set_listener(Ticks::add, &ticks);
    for (int n = 0; n < 60; n++) d.frame(1.0 / 60);
    int silent = 0;
    for (const auto& tick : ticks.list) silent += tick.silent ? 1 : 0;
    CHECK_EQ(silent, 60);
  }
}

TEST(motion_sync_wav) {
  using namespace ms;
  const double rate = 22050;
  t::ClipOptions o;
  o.vowels = {0, 4};
  const auto clip = t::vowel_clip(t::kMale, rate, o).samples;
  std::vector<float> negated(clip);
  for (auto& x : negated) x = -x;
  const double steps[6] = {1 / 127.0, 1 / 32767.0, 1 / 8388607.0, 1 / 2147483647.0, 0, 0};
  for (int enc = 0; enc < 6; enc++)
    for (bool ext : {false, true}) {
      const std::string bytes = t::wav_file({clip, negated}, 22050, static_cast<t::WavEncoding>(enc), ext);
      MotionSyncSound s;
      String message;
      CHECK(decode_motion_sync_wav(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), s, message));
      CHECK(s.sample_rate == rate && s.channels.size() == 2);
      double worst = 0;
      for (std::size_t i = 0; i < clip.size(); i++)
        worst = std::max(worst, std::fabs(static_cast<double>(s.channels[0][i]) - clip[i]));
      CHECK(worst <= steps[enc] + 1e-7);
      CHECK(std::fabs(s.channels[1][100] + s.channels[0][100]) < 0.01);
    }
  for (uint32_t r : {8000u, 16000u, 22050u, 44100u, 48000u, 96000u, 192000u}) {
    const std::string bytes = t::wav_file({t::silence(0.1, r)}, r);
    MotionSyncSound s;
    String message;
    CHECK(decode_motion_sync_wav(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), s, message));
    CHECK(s.sample_rate == r && s.channels[0].size() == static_cast<std::size_t>(js_round(0.1 * r)));
  }
  const std::string good = t::wav_file({t::silence(0.1, 8000)}, 8000);
  MotionSyncSound s;
  String message;
  const std::string ten(10, '\0');
  CHECK(!decode_motion_sync_wav(reinterpret_cast<const uint8_t*>(ten.data()), ten.size(), s, message));
  CHECK(message == "not a RIFF/WAVE file");
  std::string adpcm = good;
  adpcm[20] = 2;
  CHECK(!decode_motion_sync_wav(reinterpret_cast<const uint8_t*>(adpcm.data()), adpcm.size(), s, message));
  CHECK(message == "format 2 with 16-bit samples is not supported");
  std::string no_data = good.substr(0, 36);
  no_data[4] = 28;
  no_data[5] = no_data[6] = no_data[7] = 0;
  CHECK(!decode_motion_sync_wav(reinterpret_cast<const uint8_t*>(no_data.data()), no_data.size(), s, message));
  CHECK(message == "no data chunk");
}

TEST(motion_sync_c_api) {
  using namespace ms;
  // The file.
  const std::string basic_text = t::ds_two_json();
  m2d_motion_sync* file = nullptr;
  m2d_error err;
  CHECK_EQ(m2d_motion_sync_parse(basic_text.data(), basic_text.size(), "two", M2D_MOTION_SYNC_LINT, nullptr, &file, &err),
           M2D_OK);
  CHECK_EQ(m2d_motion_sync_setting_count(file), 2);
  CHECK_EQ(m2d_motion_sync_warning_count(file), 0);
  CHECK_EQ(m2d_motion_sync_find_setting(file, "Mouth rich"), 1);
  CHECK_EQ(m2d_motion_sync_find_setting(file, "MS_Basic"), 0);
  CHECK_EQ(m2d_motion_sync_find_setting(file, "nope"), -1);
  m2d_motion_sync_setting info;
  CHECK_EQ(m2d_motion_sync_get_setting(file, 1, &info), M2D_OK);
  CHECK(std::string(info.id) == "MS_Rich" && info.usable == 1 && info.parameter_count == 5 && info.element_count == 6 &&
        info.sample_rate == 30);
  m2d_motion_sync_parameter pinfo;
  CHECK(m2d_motion_sync_get_parameter(file, 1, 2, &pinfo) == M2D_OK && std::string(pinfo.id) == "MouthFunnel" &&
        pinfo.damper == 0.02 && pinfo.smooth == 30);
  m2d_motion_sync_element einfo;
  CHECK(m2d_motion_sync_get_element(file, 0, 3, &einfo) == M2D_OK && std::string(einfo.id) == "U" && einfo.known == 1);
  CHECK_EQ(m2d_motion_sync_shape(file, 1, 3, 3), 1.0);
  CHECK(std::isnan(m2d_motion_sync_shape(file, 1, 6, 0)));
  m2d_motion_sync_destroy(file);
  CHECK_EQ(m2d_motion_sync_parse("[1]", 3, "x", 0, nullptr, &file, &err), M2D_FILE_ERROR);
  CHECK(file == nullptr);
  CHECK_EQ(std::string(err.message), std::string("x: not a JSON object"));

  // A package whose motion entry links its sound to a setting.
  MemoryFiles mem;
  const auto model = mouth_model();
  {
    moc::MocData d = tiny_model(3, false);
    for (const char* id : {"ParamMouthOpenY", "ParamMouthForm"}) {
      d.names(F::parameter_id).push_back(id);
      d.f32(F::parameter_max).push_back(1);
      d.f32(F::parameter_min).push_back(std::string(id) == "ParamMouthForm" ? -1.0f : 0.0f);
      d.f32(F::parameter_default).push_back(0);
      d.i32(F::parameter_repeat).push_back(0);
      d.i32(F::parameter_decimals).push_back(3);
      d.i32(F::parameter_firstBinding).push_back(1);
      d.i32(F::parameter_bindingCount).push_back(0);
    }
    const auto bytes = written(d, 3);
    mem.files["m.moc3"] = std::string(bytes.begin(), bytes.end());
  }
  mem.files["talk.motion3.json"] =
      R"({"Version":3,"Meta":{"Duration":4,"Fps":30,"Loop":false,"AreBeziersRestricted":true,"CurveCount":1,"TotalSegmentCount":1,"TotalPointCount":2,"UserDataCount":0,"TotalUserDataSize":0,"FadeInTime":0.2,"FadeOutTime":0.4},"Curves":[{"Target":"Parameter","Id":"ParamMouthOpenY","Segments":[0,0.3,0,4,0.3]}]})";
  t::ClipOptions o;
  o.vowels = {0, 4};
  mem.files["a.wav"] = t::wav_file({t::vowel_clip(t::kMale, 16000, o).samples}, 16000);
  mem.files["two.motionsync3.json"] = basic_text;
  mem.files["m.model3.json"] =
      R"({"Version":3,"FileReferences":{"Moc":"m.moc3","Textures":[],"MotionSync":"two.motionsync3.json",
      "Motions":{"Talk":[{"File":"talk.motion3.json","Sound":"a.wav","MotionSync":"Mouth basic"},
                         {"File":"talk.motion3.json","Sound":"a.wav","MotionSync":"Nope"}]}},
      "Groups":[{"Target":"Parameter","Name":"LipSync","Ids":["ParamMouthOpenY"]}]})";
  const m2d_file_source source = mem.source("box");
  m2d_package* pkg = nullptr;
  CHECK_EQ(m2d_package_open(&source, "m.model3.json", 0, nullptr, &pkg, &err), M2D_OK);
  CHECK(m2d_package_motion_sync(pkg) != nullptr);
  CHECK_EQ(m2d_package_warning_count(pkg), 0);
  m2d_animator* anim = nullptr;
  CHECK_EQ(m2d_animator_create(m2d_package_model(pkg), m2d_package_settings(pkg), nullptr, nullptr, nullptr, &anim, &err),
           M2D_OK);
  CHECK_EQ(m2d_animator_has_effect(anim, M2D_EFFECT_MOTION_SYNC), 0);
  CHECK_EQ(m2d_animator_set_motion_sync(anim, m2d_package_motion_sync(pkg), nullptr), M2D_OK);
  CHECK(m2d_animator_has_effect(anim, M2D_EFFECT_MOTION_SYNC) == 1 && m2d_animator_effect(anim, M2D_EFFECT_MOTION_SYNC) == 1);
  struct Count {
    int ticks = 0;
    static void on(const m2d_motion_sync_tick*, void* user) { static_cast<Count*>(user)->ticks++; }
  } count;
  m2d_animator_set_motion_sync_listener(anim, Count::on, &count);
  int32_t accepted = 0;
  CHECK_EQ(m2d_package_start_motion(pkg, anim, "Talk", 0, nullptr, nullptr, nullptr, &accepted, &err), M2D_OK);
  CHECK_EQ(accepted, 1);
  m2d_frame frame;
  bool mouth_is_motion_sync = true;
  for (int n = 0; n < 90; n++) {
    CHECK_EQ(m2d_animator_frame(anim, 1.0 / 60, &frame, &err), M2D_OK);
    m2d_motion_sync_tick tick;
    if (m2d_animator_motion_sync_tick(anim, &tick))
      mouth_is_motion_sync = mouth_is_motion_sync && tick.value_count == 2 &&
                             m2d_animator_parameter(anim, "ParamMouthOpenY") == static_cast<float>(tick.values[0]);
  }
  CHECK(mouth_is_motion_sync);
  CHECK(count.ticks >= 89);
  CHECK_EQ(m2d_animator_motion_sync_setting(anim), 0);
  CHECK_EQ(m2d_animator_motion_sync_playing(anim), 1);
  // A motion stopped early stops its sound: the mouth settles, and motion sync lets go.
  m2d_animator_stop_motions(anim);
  for (int n = 0; n < 40 && m2d_animator_motion_sync_setting(anim) >= 0; n++) m2d_animator_frame(anim, 1.0 / 60, &frame, &err);
  CHECK_EQ(m2d_animator_motion_sync_setting(anim), -1);
  // A link to a setting the file lacks: a warning, and no motion sync.
  m2d_motion_start force;
  m2d_motion_start_default(&force);
  force.priority = 3;
  CHECK_EQ(m2d_package_start_motion(pkg, anim, "Talk", 1, &force, nullptr, nullptr, &accepted, &err), M2D_OK);
  CHECK_EQ(accepted, 1);
  m2d_animator_frame(anim, 1.0 / 60, &frame, &err);
  CHECK_EQ(m2d_animator_motion_sync_setting(anim), -1);
  CHECK_EQ(m2d_animator_warning_count(anim), 1);
  CHECK_EQ(std::string(m2d_animator_warning(anim, 0)),
           std::string("a.wav: motion-sync setting \"Nope\" is not in the file; the sound plays without motion sync"));
  m2d_animator_clear_warnings(anim);
  CHECK_EQ(m2d_animator_warning_count(anim), 0);
  // Sounds through a setting.
  const m2d_motion_sync_sound* snd = nullptr;
  CHECK_EQ(m2d_package_motion_sync_sound(pkg, "a.wav", &snd, &err), M2D_OK);
  CHECK(snd && m2d_motion_sync_sound_channels(snd) == 1 && m2d_motion_sync_sound_sample_rate(snd) == 16000);
  CHECK_EQ(m2d_animator_start_motion_sync(anim, snd, "Nope", nullptr, nullptr, &err), M2D_INVALID_ARGUMENT);
  CHECK_EQ(std::string(err.code), std::string("unknown-setting"));
  CHECK_EQ(std::string(err.message), std::string("two.motionsync3.json: no motion-sync setting \"Nope\""));
  struct Clock {
    double time = 0;
    static int32_t at(double* s, void* user) {
      *s = static_cast<Clock*>(user)->time;
      return 1;
    }
  } clock;
  CHECK_EQ(m2d_animator_start_motion_sync(anim, snd, "MS_Rich", Clock::at, &clock, &err), M2D_OK);
  for (int n = 0; n < 30; n++) {
    clock.time = n / 60.0;
    m2d_animator_frame(anim, 1.0 / 60, &frame, &err);
  }
  m2d_motion_sync_tick tick;
  CHECK(m2d_animator_motion_sync_tick(anim, &tick) && tick.setting == 1 && tick.value_count == 5 && tick.live == 0);
  CHECK(std::fabs(m2d_animator_motion_sync_consumed(anim) - js_round(29 / 60.0 * 16000)) < 1);
  // A decoded WAV and host samples.
  m2d_motion_sync_sound* own = nullptr;
  CHECK_EQ(m2d_motion_sync_sound_decode(mem.files["a.wav"].data(), mem.files["a.wav"].size(), nullptr, &own, &err), M2D_OK);
  CHECK_EQ(m2d_motion_sync_sound_frames(own), m2d_motion_sync_sound_frames(snd));
  m2d_motion_sync_sound_destroy(own);
  CHECK_EQ(m2d_motion_sync_sound_decode("RIFF", 4, nullptr, &own, &err), M2D_FILE_ERROR);
  CHECK(own == nullptr);
  CHECK_EQ(std::string(err.message), std::string("not a RIFF/WAVE file"));
  const auto tone = t::tone(220, 0.5, 44100, -20);
  const float* ch = tone.data();
  CHECK_EQ(m2d_motion_sync_sound_create(&ch, 1, tone.size(), 50, nullptr, &own), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_motion_sync_sound_create(&ch, 1, tone.size(), 44100, nullptr, &own), M2D_OK);
  CHECK_EQ(m2d_motion_sync_sound_samples(own, 0)[100], tone[100]);
  CHECK_EQ(m2d_animator_start_motion_sync(anim, own, nullptr, nullptr, nullptr, &err), M2D_OK);
  m2d_motion_sync_sound_destroy(own);  // the animator keeps it alive
  for (int n = 0; n < 10; n++) m2d_animator_frame(anim, 1.0 / 60, &frame, &err);
  CHECK(m2d_animator_motion_sync_tick(anim, &tick) && tick.setting == 0);
  // A live input, pushed by the host.
  m2d_motion_sync_input* input = nullptr;
  CHECK_EQ(m2d_motion_sync_input_create(48000, 0, nullptr, &input), M2D_OK);
  CHECK_EQ(m2d_animator_set_motion_sync_input(anim, input, "Mouth basic", &err), M2D_OK);
  t::ClipOptions a_only;
  a_only.vowels = {0};
  a_only.hold = 2;
  const auto live = t::vowel_clip(t::kMale, 48000, a_only).samples;
  double open = 0;
  for (std::size_t n = 0, at = 0; n < 90; n++) {
    const std::size_t take = std::min<std::size_t>(800, live.size() - at);
    m2d_motion_sync_input_push(input, live.data() + at, take);
    at += take;
    CHECK_EQ(m2d_motion_sync_input_pending(input), take);
    m2d_animator_frame(anim, 1.0 / 60, &frame, &err);
    CHECK_EQ(m2d_motion_sync_input_pending(input), 0u);
    open = std::max(open, m2d_animator_parameter(anim, "ParamMouthOpenY"));
  }
  CHECK(open > 0.5);
  CHECK(m2d_animator_motion_sync_tick(anim, &tick) && tick.live == 1);
  CHECK_EQ(m2d_motion_sync_input_dropped(input), 0u);
  // The handle may go: the animator keeps the bound input until it is replaced or settles,
  // also when a motion's link is refused meanwhile (the live input stays bound).
  m2d_motion_sync_input_destroy(input);
  m2d_animator_frame(anim, 1.0 / 60, &frame, &err);
  CHECK_EQ(m2d_package_start_motion(pkg, anim, "Talk", 1, &force, nullptr, nullptr, &accepted, &err), M2D_OK);
  for (int n = 0; n < 3; n++) m2d_animator_frame(anim, 1.0 / 60, &frame, &err);
  CHECK(m2d_animator_motion_sync_tick(anim, &tick) && tick.live == 1);
  m2d_animator_clear_warnings(anim);
  CHECK_EQ(m2d_animator_set_motion_sync_input(anim, nullptr, nullptr, &err), M2D_OK);
  for (int n = 0; n < 40 && m2d_animator_motion_sync_setting(anim) >= 0; n++) m2d_animator_frame(anim, 1.0 / 60, &frame, &err);
  CHECK_EQ(m2d_animator_motion_sync_setting(anim), -1);
  // Voice profiles: the neutral one, JSON both ways, a calibration.
  m2d_voice_profile* neutral = nullptr;
  CHECK_EQ(m2d_voice_profile_neutral(nullptr, &neutral), M2D_OK);
  CHECK(m2d_voice_profile_template_count(neutral, M2D_ELEMENT_A) == 4 && m2d_voice_profile_voiced_level(neutral) == -26 &&
        std::isnan(m2d_voice_profile_floor_level(neutral)));
  char* json_text = m2d_voice_profile_to_json(neutral);
  CHECK(json_text && std::string(json_text) == std::string(voice_profile_to_json(neutral_voice_profile()).c_str()));
  m2d_voice_profile* back = nullptr;
  CHECK_EQ(m2d_voice_profile_parse(json_text, std::strlen(json_text), nullptr, &back, &err), M2D_OK);
  char* again = m2d_voice_profile_to_json(back);
  CHECK(again && std::string(again) == json_text);
  m2d_free_string(again);
  m2d_free_string(json_text);
  m2d_voice_profile* bad = nullptr;
  CHECK_EQ(m2d_voice_profile_parse("{\"format\":1}", 12, nullptr, &bad, &err), M2D_FILE_ERROR);
  CHECK(bad == nullptr);
  CHECK(std::string(err.message).find("not a Mochi2D voice profile") != std::string::npos);
  m2d_voice_calibration* cal = nullptr;
  CHECK_EQ(m2d_voice_calibration_create("me", nullptr, &cal), M2D_OK);
  for (int v = 0; v < 5; v++) {
    const auto s = t::synthesize_vowel({t::kVowelFormants[v][0], t::kVowelFormants[v][1], t::kVowelFormants[v][2]}, 1,
                                       16000, t::VoiceOptions());
    const float* sc = s.data();
    CHECK(m2d_voice_calibration_add(cal, static_cast<m2d_motion_sync_element_id>(v + 1), &sc, 1, s.size(), 16000) > 50);
  }
  CHECK(m2d_voice_calibration_recorded(cal, M2D_ELEMENT_O) > 50);
  m2d_voice_profile* mine = nullptr;
  CHECK_EQ(m2d_voice_calibration_profile(cal, nullptr, &mine), M2D_OK);
  CHECK(std::string(m2d_voice_profile_name(mine)) == "me" && m2d_voice_profile_template_count(mine, M2D_ELEMENT_E) == 1);
  CHECK_EQ(m2d_animator_set_voice_profile(anim, mine), M2D_OK);
  CHECK_EQ(m2d_animator_set_voice_profile(anim, nullptr), M2D_OK);
  m2d_voice_calibration_destroy(cal);
  m2d_voice_profile_destroy(mine);
  m2d_voice_profile_destroy(back);
  m2d_voice_profile_destroy(neutral);
  // The effect switch: off, the bound sound neither analyzes nor writes.
  CHECK_EQ(m2d_animator_start_motion_sync(anim, snd, nullptr, nullptr, nullptr, &err), M2D_OK);
  CHECK_EQ(m2d_animator_set_effect(anim, M2D_EFFECT_MOTION_SYNC, 0), M2D_OK);
  m2d_animator_frame(anim, 1.0 / 60, &frame, &err);
  CHECK_EQ(m2d_animator_motion_sync_tick(anim, &tick), 0);
  m2d_animator_destroy(anim);
  m2d_package_destroy(pkg);
  (void)model;
}

TEST(motion_sync_live_thread) {
  using namespace ms;
  // An audio thread pushes while frames run (the input's lock; run under ThreadSanitizer in CI).
  const auto model = mouth_model();
  AnimationValues values(*model);
  MotionSyncDriver d(file_of(parsed(t::ds_basic_json())), values);
  MotionSyncLiveInput input(48000, 48000);
  CHECK(d.set_input(0, &input));
  t::ClipOptions o;
  o.vowels = {0};
  o.hold = 1;
  const auto clip = t::vowel_clip(t::kMale, 48000, o).samples;
  std::atomic<bool> done{false};
  std::thread audio([&] {
    for (std::size_t at = 0; at < clip.size(); at += 480) {
      input.push(clip.data() + at, std::min<std::size_t>(480, clip.size() - at));
      std::this_thread::sleep_for(std::chrono::microseconds(200));
    }
    done = true;
  });
  int frames = 0;
  while (!done || input.pending() > 0) {
    d.frame(1.0 / 60);
    frames++;
  }
  audio.join();
  CHECK(frames > 0);
  CHECK_EQ(input.dropped(), 0u);
  CHECK(d.tick() == nullptr || d.tick()->live);
}

TEST(lip_sync_fallback) {
  using namespace ms;
  // Mochi2D's runtime option lipSyncFallback: with no LipSync parameters in the
  // settings (no group, or an empty one), lip sync drives ParamMouthOpenY.
  moc::MocData d = tiny_model(3, false);
  d.names(F::parameter_id).push_back("ParamMouthOpenY");
  d.f32(F::parameter_max).push_back(1);
  d.f32(F::parameter_min).push_back(0);
  d.f32(F::parameter_default).push_back(0);
  d.i32(F::parameter_repeat).push_back(0);
  d.i32(F::parameter_decimals).push_back(3);
  d.i32(F::parameter_firstBinding).push_back(1);
  d.i32(F::parameter_bindingCount).push_back(0);
  const auto bytes = written(d, 3);
  m2d_model* model = nullptr;
  m2d_error err;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  const auto wav = t::wav_file({t::tone(200, 1, 16000, -12)}, 16000);
  m2d_sound* sound = nullptr;
  CHECK_EQ(m2d_sound_decode(wav.data(), wav.size(), nullptr, &sound, &err), M2D_OK);
  for (const char* text : {R"({"Version":3,"FileReferences":{"Moc":"m.moc3","Textures":[]}})",
                           R"({"Version":3,"FileReferences":{"Moc":"m.moc3","Textures":[]},"Groups":[{"Target":"Parameter","Name":"LipSync","Ids":[]}]})",
                           R"({"Version":3,"FileReferences":{"Moc":"m.moc3","Textures":[]},"Groups":[{"Target":"Parameter","Name":"LipSync","Ids":["ParamX"]}]})"}) {
    m2d_settings* settings = nullptr;
    CHECK_EQ(m2d_settings_parse(text, std::strlen(text), "s", nullptr, &settings, &err), M2D_OK);
    const bool listed = std::strstr(text, "ParamX") != nullptr;
    for (bool off : {false, true}) {
      m2d_animator_options o;
      m2d_animator_options_default(&o);
      CHECK(o.lip_sync_fallback && std::string(o.lip_sync_fallback) == "ParamMouthOpenY");
      if (off) o.lip_sync_fallback = nullptr;
      m2d_animator* anim = nullptr;
      CHECK_EQ(m2d_animator_create(model, settings, nullptr, nullptr, &o, &anim, &err), M2D_OK);
      const bool applies = !off && !listed;
      CHECK_EQ(m2d_animator_lip_sync_fallback(anim) != nullptr, applies);
      CHECK_EQ(m2d_animator_has_effect(anim, M2D_EFFECT_LIP_SYNC), applies || listed ? 1 : 0);
      if (m2d_animator_has_effect(anim, M2D_EFFECT_LIP_SYNC)) CHECK_EQ(m2d_animator_start_sound(anim, sound), M2D_OK);
      m2d_frame f;
      double open = 0;
      for (int n = 0; n < 10; n++) {
        m2d_animator_frame(anim, 1.0 / 60, &f, &err);
        open = std::max(open, m2d_animator_parameter(anim, "ParamMouthOpenY"));
      }
      CHECK_EQ(open > 0.1, applies);
      m2d_animator_destroy(anim);
    }
    m2d_settings_destroy(settings);
  }
  m2d_sound_destroy(sound);
  m2d_model_destroy(model);
}

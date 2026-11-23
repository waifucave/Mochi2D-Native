// Unit tests of Mochi2D Native that need nothing but the libraries. The
// bit-exactness checks against Mochi2D itself are in tests/crosscheck/.
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <map>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <filesystem>
#include <functional>
#include <string>
#include <vector>
#include <atomic>
#include <chrono>
#include <thread>

#include "core/eval/f32.hpp"
#include "core/eval/fp_check.hpp"
#include "core/eval/instance.hpp"
#include "core/moc/io.hpp"
#include "core/moc/model.hpp"
#include "core/moc/schema.hpp"
#include "core/snapshot.hpp"
#include "conformance/render.hpp"
#include "conformance/scenario.hpp"
#include "framework/lip_sync.hpp"
#include "framework/motion.hpp"
#include "framework/motion_sync.hpp"
#include "framework/motion_sync_analysis.hpp"
#include "framework/motion_sync_driver.hpp"
#include "framework/package.hpp"
#include "framework/physics.hpp"
#include "framework/tints.hpp"
#include "framework/settings.hpp"
#include "mochi2d.h"
#include "render/mask_matrix.hpp"
#include "render/renderer.hpp"
#include "support/motion_sync_support.hpp"
#include "support/model_folder.hpp"
#include "support/tiny_model.hpp"
#include "util/json.hpp"
#include "util/text.hpp"

using namespace mochi2d;
using moc::F;
using testing::tiny_model;
using testing::written;

namespace {

int g_failures = 0;
int g_checks = 0;
std::string g_test;

#define CHECK(cond)                                                                       \
  do {                                                                                    \
    g_checks++;                                                                           \
    if (!(cond)) {                                                                        \
      g_failures++;                                                                       \
      std::fprintf(stderr, "FAIL [%s] %s:%d: %s\n", g_test.c_str(), __FILE__, __LINE__, #cond); \
    }                                                                                     \
  } while (0)

#define CHECK_EQ(a, b)                                                                                        \
  do {                                                                                                        \
    g_checks++;                                                                                               \
    const auto va = (a);                                                                                      \
    const auto vb = (b);                                                                                      \
    if (!(va == vb)) {                                                                                        \
      g_failures++;                                                                                           \
      std::fprintf(stderr, "FAIL [%s] %s:%d: %s == %s\n", g_test.c_str(), __FILE__, __LINE__, #a, #b);        \
    }                                                                                                         \
  } while (0)

std::vector<std::pair<std::string, std::function<void()>>>& tests() {
  static std::vector<std::pair<std::string, std::function<void()>>> t;
  return t;
}

struct Register {
  Register(const char* name, std::function<void()> f) { tests().emplace_back(name, std::move(f)); }
};

#define TEST(name)                         \
  static void test_##name();               \
  static Register reg_##name(#name, test_##name); \
  static void test_##name()

std::shared_ptr<const moc::Model> loaded(const Vector<uint8_t>& bytes) {
  auto m = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
  moc::Error err;
  if (!moc::load_moc(bytes.data(), bytes.size(), moc::LoadOptions(), *m, err)) {
    std::fprintf(stderr, "  load: %s\n", err.message.c_str());
    return nullptr;
  }
  return m;
}

// ------------------------------------------------------------------ tests

TEST(no_floating_point_contraction) {
  // Fails if the core was compiled with fused multiply-adds.
  CHECK(eval::fp_contraction_off());
  volatile float a = 1.0f + 1.0f / 4096.0f;
  volatile float c = -(1.0f + 1.0f / 2048.0f);
  CHECK_EQ(eval::fp_probe_f32(a, a, c), 0.0f);
  CHECK(std::fma(static_cast<float>(a), static_cast<float>(a), static_cast<float>(c)) != 0.0f);  // the inputs do tell
  // The evaluator's own inline helpers, compiled here with the core's interface flags.
  volatile float t = 1.0f + 1.0f / 4096.0f;
  CHECK_EQ(eval::lerp32(static_cast<float>(c), 0.0f, 0.0f) + t * t, (1.0f + 1.0f / 2048.0f) + static_cast<float>(c));
}

TEST(js_number_formatting) {
  using text::js_number;
  CHECK_EQ(js_number(0.1), "0.1");
  CHECK_EQ(js_number(static_cast<double>(0.6f)), "0.6000000238418579");
  CHECK_EQ(js_number(-0.0), "0");
  CHECK_EQ(js_number(1e21), "1e+21");
  CHECK_EQ(js_number(1e20), "100000000000000000000");
  CHECK_EQ(js_number(1.5e-7), "1.5e-7");
  CHECK_EQ(js_number(0.000001), "0.000001");
  CHECK_EQ(js_number(5e-324), "5e-324");
  CHECK_EQ(js_number(-123.456), "-123.456");
  CHECK_EQ(js_number(1e9), "1000000000");
  CHECK_EQ(js_number(NAN), "NaN");
  CHECK_EQ(js_number(-INFINITY), "-Infinity");
}

TEST(js_to_int32) {
  CHECK_EQ(text::js_to_int32(4294967296.0 + 5), 5);
  CHECK_EQ(text::js_to_int32(2147483648.0), -2147483647 - 1);
  CHECK_EQ(text::js_to_int32(-1.9), -1);
  CHECK_EQ(text::js_to_int32(NAN), 0);
}

TEST(utf8_sanitizing) {
  CHECK_EQ(text::sanitize_utf8("a\xC3\xA9"), "a\xC3\xA9");
  CHECK_EQ(text::sanitize_utf8("\xC0\x80"), "\xEF\xBF\xBD\xEF\xBF\xBD");  // overlong: one U+FFFD per byte
  CHECK_EQ(text::sanitize_utf8("\xED\xA0\x80"), "\xEF\xBF\xBD\xEF\xBF\xBD\xEF\xBF\xBD");  // surrogate
}

TEST(json_parse_and_write) {
  json::Value v;
  json::ParseError err;
  CHECK(json::parse(R"({"b": 1, "2": [1, 2.5, "x"], "a": {"c": null}, "1": true, "b": 3})", v, err));
  CHECK_EQ(v.members().size(), 4u);
  CHECK_EQ(v.get("b")->as_number(), 3.0);  // last value, first position
  const auto order = v.entries_js_order();
  CHECK_EQ(order[0]->first, "1");
  CHECK_EQ(order[1]->first, "2");
  CHECK_EQ(order[2]->first, "b");
  CHECK_EQ(json::write_result(*v.get("2")), "[1, 2.5, \"x\"]\n");
  json::Value r = json::Value::object();
  r.set("x", 0.6f);
  r.set("y", json::Value::array());
  CHECK_EQ(json::write_result(r), "{\n  \"x\": 0.6000000238418579,\n  \"y\": []\n}\n");
  CHECK(!json::parse("{\"a\": }", v, err));
  CHECK(!json::parse("[1,]", v, err));
  CHECK(json::parse("1e400", v, err));
  CHECK(std::isinf(v.as_number()));
  // V8's messages, positions in UTF-16 units, with line and column.
  CHECK(!json::parse("{\"a\": }", v, err));
  CHECK_EQ(err.message, "Unexpected token '}', \"{\"a\": }\" is not valid JSON");
  CHECK(!json::parse("[\"\xF0\x9F\x98\x80\",\n 01]", v, err));
  CHECK_EQ(err.message, "Unexpected number in JSON at position 9 (line 2 column 3)");
  CHECK(!json::parse("tru", v, err));
  CHECK_EQ(err.message, "Unexpected end of JSON input");
  // A lone surrogate stays one, and prints as JSON.stringify prints it.
  // (An ordinary literal: MSVC reads \u escapes inside raw strings too, and refuses lone surrogates.)
  CHECK(json::parse("[\"\\ud83d\", \"\\ud83d\\ude00\"]", v, err));
  CHECK_EQ(json::write_compact(v), "[\"\\ud83d\",\"\xF0\x9F\x98\x80\"]");
}

TEST(schema_tables) {
  std::size_t n;
  const auto* g = moc::groups(n);
  CHECK_EQ(n, 38u);
  CHECK_EQ(std::string(g[0].name), "parts");
  CHECK_EQ(std::string(g[n - 1].name), "offscreenBlendShapeTargets");
  CHECK_EQ(moc::spec(F::mesh_blendMode).slot, 153);
  CHECK_EQ(moc::group_by_name("artMeshes")->field_count, 18u);
}

TEST(key_tolerance) {
  CHECK_EQ(eval::key_tolerance(3), static_cast<float>(0.001));
  CHECK_EQ(eval::key_tolerance(0), 1.0f);
  CHECK_EQ(eval::key_tolerance(60), 0.0f);
  CHECK_EQ(eval::keyform_draw_order(499.9995f, false, 5), 500.0);
  CHECK_EQ(eval::keyform_draw_order(-3.5f, true, 5), 0.0);
}

TEST(parameter_values) {
  CHECK_EQ(eval::applied_value(5, 0, 1, false), 1.0f);
  CHECK_EQ(eval::applied_value(5, 0, 1, true), 5.0f);
  // 0.14.0: always wrapped, u = (v − L)/Δ, v′ = (u − ⌊u⌋)·Δ + L, so the maximum wraps to the minimum
  // and values move by their float32 rounding (Mochi2D's own numbers).
  CHECK_EQ(eval::evaluation_value(370, 0, 360, true), static_cast<float>(10.000004768371582));
  CHECK_EQ(eval::evaluation_value(-10, 0, 360, true), 350.0f);
  CHECK_EQ(eval::evaluation_value(360, 0, 360, true), 0.0f);
  CHECK_EQ(eval::evaluation_value(180, -180, 180, true), -180.0f);
  CHECK_EQ(eval::evaluation_value(3, 2, 2, true), 2.0f);
}

TEST(read_errors) {
  auto code = [](const Vector<uint8_t>& b) {
    const auto v = moc::validate_moc(b.data(), b.size());
    return v.diagnostics.empty() ? String() : v.diagnostics[0].code;
  };
  CHECK_EQ(code({}), "file-length");
  Vector<uint8_t> b(64, 0);
  CHECK_EQ(code(b), "magic");
  std::memcpy(b.data(), "MOC3", 4);
  b[4] = 9;
  CHECK_EQ(code(b), "version");
  b[4] = 3;
  CHECK_EQ(code(b), "section-bounds");
}

TEST(write_read_roundtrip_all_versions) {
  for (int v = 1; v <= 5; v++) {
    g_test = "write_read_roundtrip v" + std::to_string(v);
    const auto data = tiny_model(v, v % 2 == 0);
    const auto shape = moc::check_shape(data, v, nullptr);
    CHECK(shape.empty());
    for (const auto& d : shape) std::fprintf(stderr, "  %s %s\n", d.code.c_str(), d.message.c_str());
    Vector<uint8_t> bytes = written(data, v);
    CHECK(!bytes.empty());
    if (bytes.empty()) continue;
    CHECK_EQ(bytes.size() % 64, 0u);
    moc::ReadResult r;
    moc::Error rerr;
    CHECK(moc::read_moc(bytes.data(), bytes.size(), r, rerr));
    CHECK_EQ(r.version, v);
    CHECK(r.diagnostics.empty());
    CHECK(written(r.data, v) == bytes);  // byte identity
    const auto val = moc::validate_moc(bytes.data(), bytes.size());
    CHECK(val.valid);
    CHECK(val.diagnostics.empty());
  }
  g_test = "write_read_roundtrip_all_versions";
  // Version 6 cannot be written yet; MocData of version 6 loads directly.
  Vector<uint8_t> out6;
  Vector<moc::Diagnostic> diags6;
  CHECK(!moc::write_moc(tiny_model(6, true), 6, out6, diags6));
  CHECK(!diags6.empty() && diags6[0].code == "version-unsupported");
  moc::Model m6;
  moc::Error err6;
  CHECK(moc::model_from_data(tiny_model(6, true), 6, moc::LoadOptions(), m6, diags6, err6));
  CHECK_EQ(m6.version, 6);
}

TEST(validation_levels) {
  auto data = tiny_model(4, false);
  data.i32(F::part_parent)[0] = 0;  // itself: the loader rejects it, the official check does not
  auto strict = moc::validate_moc(data, 4, moc::Level::Strict);
  auto official = moc::validate_moc(data, 4, moc::Level::Official);
  CHECK(!strict.valid);
  CHECK(official.valid);
  CHECK_EQ(strict.diagnostics[0].code, "parent-order");
  CHECK_EQ(strict.diagnostics[0].kind, "parts");
  CHECK_EQ(*strict.diagnostics[0].field, "parent");
  CHECK_EQ(strict.diagnostics[0].message, "parts[0] (Root).parent = 0 must be -1 or an earlier part");
  data = tiny_model(4, false);
  data.i32(F::mesh_deformer)[0] = 5;
  official = moc::validate_moc(data, 4, moc::Level::Official);
  CHECK(!official.valid);
  CHECK_EQ(official.diagnostics[0].code, "index-out-of-range");
  data = tiny_model(4, false);
  data.f32(F::meshKeyform_drawOrder)[1] = 5000;  // outside the group's range: a warning
  strict = moc::validate_moc(data, 4, moc::Level::Strict);
  CHECK(strict.valid);
  CHECK_EQ(strict.diagnostics.size(), 1u);
  CHECK_EQ(strict.diagnostics[0].code, "draw-order-range");
  CHECK(strict.diagnostics[0].warning);
  // Shape errors.
  data = tiny_model(4, false);
  data.f32(F::parameter_min).push_back(0);
  strict = moc::validate_moc(data, 4);
  CHECK_EQ(strict.diagnostics[0].code, "length-mismatch");
  CHECK_EQ(moc::validate_moc(tiny_model(4, false), 5).diagnostics[0].code, "missing-field");
}

TEST(evaluation_basics) {
  for (int v : {3, 5}) {
    g_test = "evaluation_basics v" + std::to_string(v);
    const auto bytes = written(tiny_model(v, false), v);
    auto model = loaded(bytes);
    eval::Instance inst(model);
    // Defaults: keyform 0, y flipped for output.
    CHECK_EQ(inst.drawable_vertices[0][0], 0.25f);
    CHECK_EQ(inst.drawable_vertices[0][1], -0.25f);
    CHECK_EQ(inst.drawable_opacity[0], 1.0f);
    CHECK_EQ(inst.drawable_draw_order[0], 500);
    CHECK_EQ(inst.drawable_render_order[0], 0);
    // Halfway: positions and opacity interpolate, draw order truncates.
    inst.set_parameter(0, 0.5);
    inst.evaluate();
    CHECK_EQ(inst.drawable_vertices[0][0], 0.3125f);
    CHECK_EQ(inst.drawable_vertices[0][1], -0.3125f);
    CHECK_EQ(inst.drawable_opacity[0], 0.75f);
    CHECK_EQ(inst.drawable_draw_order[0], 550);
    CHECK_EQ(inst.drawable_multiply[1], v >= 4 ? 0.75f : 1.0f);
    // Within the key tolerance of 1: snapped to the key.
    inst.set_parameter(0, 0.9995);
    inst.evaluate();
    CHECK_EQ(inst.drawable_opacity[0], 0.5f);
    // Clamped above the range.
    inst.set_parameter(0, 7);
    CHECK_EQ(inst.parameter_values[0], 1.0f);
    // A hidden part hides the mesh.
    inst.set_part_opacity(0, 0);
    inst.evaluate();
    CHECK_EQ(inst.drawable_visible[0], 0);
  }
}

TEST(warp_mapping) {
  // The identity-like warp maps [0,1]² onto [-1,1]².
  const float grid[8] = {-1, -1, 1, -1, -1, 1, 1, 1};
  const float in[8] = {0.5f, 0.5f, 0, 0, 0.25f, 0.75f, 2, 0.5f};
  float out[8];
  eval::warp_points(grid, 1, 1, false, in, out, 4);
  CHECK_EQ(out[0], 0.0f);
  CHECK_EQ(out[1], 0.0f);
  CHECK_EQ(out[2], -1.0f);
  CHECK_EQ(out[4], -0.5f);
  CHECK_EQ(out[5], 0.5f);
  CHECK_EQ(out[6], 3.0f);  // outside: the affine extension continues the grid
  // Under a warp in the tiny model, the mesh lands in [-1, 1]².
  const auto bytes = written(tiny_model(4, true), 4);
  auto model = loaded(bytes);
  eval::Instance inst(model);
  CHECK_EQ(inst.drawable_vertices[0][0], -0.5f);
  CHECK_EQ(inst.drawable_vertices[0][1], 0.5f);
}

TEST(warp_mapping_bit_exact_vectors) {
  // Mochi2D 0.14.0's test/bit-exact-vectors.test.ts ("the warp mapping: inside, band and far, both
  // cell flags"): a 2 × 2-cell grid, (u, v), the triangle-cell result and the quad-cell one (the
  // same where only one is given), bit for bit, every point alone and all together, in place
  // too, through the SIMD path and the scalar one.
  const double G[18] = {-1, -1, 0.1, -1.2, 1, -0.9, -1.1, 0.05, 0.2, 0.1, 0.9, -0.1, -0.8, 1.1, 0.15, 0.95, 1.2, 1.05};
  float grid[18];
  for (int i = 0; i < 18; i++) grid[i] = static_cast<float>(G[i]);
  struct Vec {
    double u, v, tx, ty, qx, qy;
    bool quad;
  };
  const Vec W[] = {
      {0.3, 0.2, -0.3799999952316284, -0.7000000476837158, -0.3319999873638153, -0.64000004529953, true},
      {0.8, 0.9, 0.7200000286102295, 0.7799999713897705, 0.7480000257492065, 0.8039999008178711, true},
      {0.75, 0.25, 0.6000000238418579, -0.3999999761581421, 0.550000011920929, -0.5249999761581421, true},
      {0.5, 0.5, 0.20000000298023224, 0.10000000149011612, 0, 0, false},
      {-0.5, 0.25, -2.000000238418579, -0.4874999523162842, 0, 0, false},
      {0.4, -1.3, -0.4450000822544098, -3.629999876022339, 0, 0, false},
      {1.7, 2.2, 2.8399999141693115, 3.533125400543213, 0, 0, false},
      {1, 0.5, 0.8999999761581421, -0.10000000149011612, 0, 0, false},
      {-2, 0.5, -4.900000095367432, 1.1920928955078125e-7, 0, 0, false},
      {4.5, -3.25, 7.349999904632568, -7.431250095367432, 0, 0, false},
  };
  constexpr int N = 10;
  for (int bilinear = 0; bilinear < 2; bilinear++) {
    float uv[2 * N], want[2 * N];
    for (int i = 0; i < N; i++) {
      uv[2 * i] = static_cast<float>(W[i].u);
      uv[2 * i + 1] = static_cast<float>(W[i].v);
      const bool q = bilinear && W[i].quad;
      want[2 * i] = static_cast<float>(q ? W[i].qx : W[i].tx);
      want[2 * i + 1] = static_cast<float>(q ? W[i].qy : W[i].ty);
    }
    const auto same = [](const float* a, const float* b, int n) { return std::memcmp(a, b, sizeof(float) * n) == 0; };
    for (int path = 0; path < 2; path++) {
      const auto map = [&](const float* src, float* dst, int count) {
        if (path == 0)
          eval::warp_points(grid, 2, 2, bilinear == 1, src, dst, count);
        else
          eval::warp_points_reference(grid, 2, 2, bilinear == 1, src, dst, count);
      };
      float out[2 * N];
      map(uv, out, N);
      CHECK(same(out, want, 2 * N));
      float inplace[2 * N];
      std::memcpy(inplace, uv, sizeof uv);
      map(inplace, inplace, N);
      CHECK(same(inplace, want, 2 * N));
      for (int i = 0; i < N; i++) {
        float one[2];
        map(uv + 2 * i, one, 1);
        if (!same(one, want + 2 * i, 2))
          std::fprintf(stderr, "  warp vector %d (%s, %s): %.9g %.9g, want %.9g %.9g\n", i, bilinear ? "quad" : "triangle",
                       path ? "scalar" : "simd", one[0], one[1], want[2 * i], want[2 * i + 1]);
        CHECK(same(one, want + 2 * i, 2));
      }
    }
  }
}

TEST(warp_mapping_simd) {
  // The SIMD path against the scalar one: random grids of both kinds, points
  // inside, on the edges, outside, special values; every count up to 13
  // (whole and partial groups of four); in place too. Equal bits, or NaN on both.
  uint32_t seed = 12345;
  auto rnd = [&] {
    seed = seed * 1664525u + 1013904223u;
    return static_cast<float>(seed >> 8) / 16777216.0f;
  };
  const float specials[] = {0.0f, -0.0f, 1.0f, std::nextafter(1.0f, 0.0f), std::nextafter(0.0f, 1.0f), -1e-30f, 0.5f,
                            1e30f, -1e30f, std::numeric_limits<float>::infinity(),
                            -std::numeric_limits<float>::infinity(), std::numeric_limits<float>::quiet_NaN(), -2.0f,
                            3.0f, 2.9999998f, -1.9999999f};
  int compared = 0, differing = 0;
  for (int round = 0; round < 8000; round++) {
    const int R = 1 + static_cast<int>(rnd() * 9), C = 1 + static_cast<int>(rnd() * 9);
    const bool bilinear = round % 2 == 1;
    Vector<float> grid(static_cast<std::size_t>(2 * (R + 1) * (C + 1)));
    for (std::size_t i = 0; i < grid.size(); i++) grid[i] = (rnd() - 0.5f) * 4.0f;
    if (round % 97 == 5) grid[static_cast<std::size_t>(round) % grid.size()] = std::numeric_limits<float>::quiet_NaN();
    const int count = round % 14;
    float src[28], a[28], b[28];
    for (int k = 0; k < 2 * count; k++) {
      const float r = rnd();
      src[k] = r < 0.15f ? specials[static_cast<int>(rnd() * 16) % 16] : r < 0.8f ? rnd() : rnd() * 5.0f - 2.0f;
    }
    eval::warp_points(grid.data(), R, C, bilinear, src, a, count);
    eval::warp_points_reference(grid.data(), R, C, bilinear, src, b, count);
    float inplace[28];
    std::memcpy(inplace, src, sizeof src);
    eval::warp_points(grid.data(), R, C, bilinear, inplace, inplace, count);
    for (int k = 0; k < 2 * count; k++) {
      compared++;
      const bool same = (std::isnan(a[k]) && std::isnan(b[k])) || std::memcmp(&a[k], &b[k], 4) == 0;
      const bool same_inplace = (std::isnan(inplace[k]) && std::isnan(b[k])) || std::memcmp(&inplace[k], &b[k], 4) == 0;
      if (!same || !same_inplace) differing++;
    }
  }
  CHECK(compared > 50000);
  CHECK_EQ(differing, 0);
}

TEST(snapshot_and_request) {
  const auto bytes = written(tiny_model(4, false), 4);
  auto model = loaded(bytes);
  eval::Instance inst(model);
  EvaluationRequest req;
  req.parameters = {{"ParamX", 1}, {"Nope", 2}};
  req.part_opacities = {{"Root", 0.5}};
  const auto warnings = apply_request(inst, req);
  CHECK_EQ(warnings.size(), 1u);
  CHECK_EQ(warnings[0], "unknown parameter Nope");
  inst.evaluate();
  json::Value v = json::Value::object();
  snapshot_into(inst, v);
  const auto* d = &v.get("drawables")->items()[0];
  CHECK_EQ(d->get("opacity")->as_number(), 0.25);
  CHECK_EQ(d->get("multiplyColor")->items()[1].as_number(), 0.5);
}

TEST(scenario_parsing) {
  json::Value v;
  json::ParseError err;
  CHECK(json::parse(R"({"format":"lively2d-scenario/0.3","id":"a","model":"m.model3.json","parameters":{"P":1}})", v, err));
  conformance::Scenario sc;
  String message;
  CHECK(conformance::parse_scenario(v, sc, message));
  CHECK_EQ(sc.id, "a");
  CHECK_EQ(sc.request.parameters.size(), 1u);
  CHECK(json::parse(R"({"format":"mochi2d-scenario/1","id":"a","model":"m"})", v, err));
  CHECK(!conformance::parse_scenario(v, sc, message));
  CHECK(message.find("\"format\" must be") == 0);
  CHECK(!conformance::valid_id("a/b"));
  String norm;
  CHECK(framework::normalize_path("a\\b/./c/../d", norm));
  CHECK_EQ(norm, "a/b/d");
  CHECK(!framework::normalize_path("../x", norm));
}

TEST(settings_parsing) {
  framework::ModelSettings s;
  String message;
  CHECK(framework::parse_model_settings("\xEF\xBB\xBF{\"FileReferences\":{\"Moc\":\"x.moc3\",\"Textures\":[\"t.png\"]}}", "s", s, message));
  CHECK_EQ(s.moc, "x.moc3");
  CHECK_EQ(s.textures.size(), 1u);
  CHECK(!framework::parse_model_settings("{\"FileReferences\":{}}", "s", s, message));
  CHECK_EQ(message, "s: FileReferences.Moc is missing");
}

}  // namespace

// Every global operator new of the test binary is counted, so a test can
// show that the libraries allocate nothing outside the object's allocator.
// (Not under ThreadSanitizer, whose runtime defines operator new itself: the
// count stays 0 there.)
static std::size_t g_global_news = 0;
#if defined(__SANITIZE_THREAD__)
#define MOCHI2D_TSAN 1
#elif defined(__has_feature)
#if __has_feature(thread_sanitizer)
#define MOCHI2D_TSAN 1
#endif
#endif
#ifndef MOCHI2D_TSAN
void* operator new(std::size_t n) {
  g_global_news++;
  if (void* p = std::malloc(n ? n : 1)) return p;
  std::abort();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
#endif

namespace {

namespace counting {
std::size_t live = 0, calls = 0;
void* allocate(std::size_t size, std::size_t alignment, void*) {
  calls++;
  live += size;
  return ::operator new(size, std::align_val_t(alignment));
}
void deallocate(void* p, std::size_t size, std::size_t alignment, void*) {
  live -= size;
  ::operator delete(p, std::align_val_t(alignment));
}
}  // namespace counting

TEST(no_allocation_outside_the_allocator) {
  const Vector<uint8_t> bytes = written(tiny_model(5, true), 5);
  m2d_allocator a{counting::allocate, counting::deallocate, nullptr};
  m2d_error err;
  const std::size_t before = g_global_news;
  int32_t valid = 0;
  char* report = nullptr;
  m2d_validate_moc(bytes.data(), bytes.size(), M2D_LEVEL_STRICT, &a, &valid, &report, &err);
  m2d_free_string(report);
  m2d_model* model = nullptr;
  m2d_instance* inst = nullptr;
  m2d_model_load(bytes.data(), bytes.size(), 0, &a, &model, &err);
  m2d_instance_create(model, &inst, &err);
  m2d_instance_set_parameter(inst, 0, 0.5f);
  m2d_instance_evaluate(inst, &err);
  float pts[4] = {0.5f, 0.5f, 2, 2};
  m2d_instance_map_points(inst, 0, pts, 2, M2D_SPACE_MODEL, pts);
  m2d_free_string(m2d_instance_snapshot_json(inst));
  m2d_instance_destroy(inst);
  m2d_model_destroy(model);
  CHECK_EQ(g_global_news, before);
  CHECK_EQ(counting::live, 0u);
}

TEST(allocator_per_object) {
  const Vector<uint8_t> bytes = written(tiny_model(5, true), 5);
  m2d_allocator a{counting::allocate, counting::deallocate, nullptr};
  counting::calls = 0;
  m2d_model* model = nullptr;
  m2d_instance* inst = nullptr;
  m2d_error err;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, &a, &model, &err), M2D_OK);
  const std::size_t after_load = counting::live;
  CHECK(after_load > 0);
  CHECK_EQ(m2d_instance_create(model, &inst, &err), M2D_OK);  // the instance inherits the allocator
  CHECK(counting::live > after_load);
  CHECK_EQ(m2d_instance_evaluate(inst, &err), M2D_OK);
  char* snap = m2d_instance_snapshot_json(inst);  // strings too
  CHECK(snap != nullptr);
  const std::size_t with_snapshot = counting::live;
  m2d_free_string(snap);
  CHECK(counting::live < with_snapshot);
  // An object made with the default allocator alongside does not touch it.
  const std::size_t before = counting::calls;
  m2d_model* other = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &other, &err), M2D_OK);
  CHECK_EQ(counting::calls, before);
  m2d_model_destroy(other);
  m2d_model_destroy(model);  // the instance keeps the model alive
  CHECK(counting::live > 0);
  m2d_instance_destroy(inst);
  CHECK_EQ(counting::live, 0u);
}

TEST(c_api) {
  const auto bytes = written(tiny_model(5, true), 5);
  m2d_error err;
  int32_t valid = 0;
  char* report = nullptr;
  CHECK_EQ(m2d_validate_moc(bytes.data(), bytes.size(), M2D_LEVEL_STRICT, nullptr, &valid, &report, &err), M2D_OK);
  CHECK_EQ(valid, 1);
  CHECK(report && std::strstr(report, "\"valid\":true"));
  m2d_free_string(report);
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  CHECK_EQ(m2d_model_drawable_count(model), 1);
  CHECK_EQ(std::string(m2d_model_drawable_id(model, 0)), "Mesh");
  CHECK_EQ(m2d_model_parameter_index(model, "ParamX"), 0);
  CHECK_EQ(m2d_model_drawable_index_count(model, 0), 3);
  CHECK_EQ(m2d_model_drawable_deformer(model, 0), 0);
  CHECK_EQ(m2d_model_deformer_count(model), 1);
  CHECK_EQ(std::string(m2d_model_deformer_id(model, 0)), "Warp");
  CHECK_EQ(m2d_model_drawable_uvs(model, 0)[5], 0.0f);  // 1 − v
  m2d_instance* inst = nullptr;
  CHECK_EQ(m2d_instance_create(model, &inst, &err), M2D_OK);
  m2d_model_destroy(model);  // the instance keeps the model alive
  CHECK_EQ(m2d_instance_set_parameter(inst, 0, 0.5f), M2D_OK);
  CHECK_EQ(m2d_instance_evaluate(inst, &err), M2D_OK);
  CHECK_EQ(m2d_instance_drawable_opacity(inst, 0), 0.75f);
  CHECK(m2d_instance_drawable_vertices(inst, 0) != nullptr);
  CHECK_EQ(m2d_instance_set_parameter(inst, 7, 0.5f), M2D_INVALID_ARGUMENT);
  m2d_drawable_state st;
  CHECK_EQ(m2d_instance_drawable_state(inst, 0, &st), M2D_OK);
  CHECK_EQ(st.opacity, 0.75f);
  float verts[6];
  size_t written = 0;
  CHECK_EQ(m2d_instance_copy_drawable_vertices(inst, 0, verts, 6, &written), M2D_OK);
  CHECK_EQ(written, 6u);
  CHECK_EQ(verts[0], m2d_instance_drawable_vertices(inst, 0)[0]);
  CHECK_EQ(m2d_instance_copy_drawable_vertices(inst, 0, verts, 5, &written), M2D_INVALID_ARGUMENT);
  // Forward mapping: the mesh's keyform positions map to its vertices.
  float pts[2] = {0.5f, 0.5f};
  CHECK_EQ(m2d_instance_map_points(inst, 0, pts, 1, M2D_SPACE_MODEL, pts), M2D_OK);
  CHECK_EQ(pts[0], 0.0f);
  double jac[4];
  float p2[2] = {0.25f, 0.25f};
  CHECK_EQ(m2d_instance_map_jacobians(inst, 0, p2, 1, M2D_SPACE_KEYFORM, jac), M2D_OK);
  CHECK_EQ(jac[0], 2.0);
  CHECK_EQ(jac[3], 2.0);
  CHECK_EQ(m2d_instance_map_points(inst, 5, pts, 1, M2D_SPACE_MODEL, pts), M2D_INVALID_ARGUMENT);
  char* snap = m2d_instance_snapshot_json(inst);
  CHECK(snap && std::strstr(snap, "\"drawables\""));
  m2d_free_string(snap);
  m2d_instance_destroy(inst);
  // Errors are reported, never thrown.
  const uint8_t junk[16] = {};
  CHECK_EQ(m2d_model_load(junk, sizeof junk, 0, nullptr, &model, &err), M2D_FORMAT_ERROR);
  CHECK_EQ(std::string(err.code), "file-length");
  CHECK(model == nullptr);
  CHECK_EQ(m2d_model_load(nullptr, 5, 0, nullptr, &model, &err), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_model_drawable_count(nullptr), 0);
}

// ---------------------------------------------------------------- framework

/** A 16-bit mono WAV of `frames` samples at `rate`, every sample `value` (−32768…32767). */
std::string wav16(uint32_t rate, uint32_t frames, int16_t value) {
  std::string b(44 + 2 * frames, '\0');
  auto u32 = [&](std::size_t o, uint32_t v) {
    for (int k = 0; k < 4; k++) b[o + k] = static_cast<char>((v >> (8 * k)) & 0xff);
  };
  auto u16 = [&](std::size_t o, uint16_t v) {
    b[o] = static_cast<char>(v & 0xff);
    b[o + 1] = static_cast<char>(v >> 8);
  };
  std::memcpy(&b[0], "RIFF", 4);
  u32(4, static_cast<uint32_t>(b.size() - 8));
  std::memcpy(&b[8], "WAVEfmt ", 8);
  u32(16, 16);
  u16(20, 1);
  u16(22, 1);
  u32(24, rate);
  u32(28, rate * 2);
  u16(32, 2);
  u16(34, 16);
  std::memcpy(&b[36], "data", 4);
  u32(40, 2 * frames);
  for (uint32_t i = 0; i < frames; i++) u16(44 + 2 * i, static_cast<uint16_t>(value));
  return b;
}

const char* kMotion = R"({"Version":3,"Meta":{"Duration":1,"Fps":30,"FadeInTime":0,"FadeOutTime":0,
  "CurveCount":2,"TotalSegmentCount":2,"TotalPointCount":4},
  "Curves":[{"Target":"Parameter","Id":"ParamX","Segments":[0,0,0,1,1]},
            {"Target":"Parameter","Id":"FreeY","Segments":[0,5,2,0.5,6]}],
  "UserData":[{"Time":0.5,"Value":"half"}]})";

TEST(motion_files) {
  framework::Motion m;
  framework::FormatError err;
  CHECK(framework::parse_motion(kMotion, "m.motion3.json", m, err));
  CHECK_EQ(m.curves.size(), 2u);
  CHECK_EQ(m.events.size(), 1u);
  CHECK_EQ(framework::evaluate_curve(m.curves[0], 0.25, false), 0.25);
  CHECK_EQ(framework::evaluate_curve(m.curves[1], 0.25, false), 5.0);  // stepped
  CHECK_EQ(framework::evaluate_curve(m.curves[0], 2, false), 1.0);     // after the last point
  CHECK(!framework::parse_motion(R"({"Meta":{"CurveCount":3},"Curves":[]})", "m", m, err));
  CHECK_EQ(err.message, "m: Meta.CurveCount is 3, but the file has 0");
  CHECK(!framework::parse_motion(R"({"Curves":[{"Segments":[0,0,7,1,1]}]})", "m", m, err));
  CHECK_EQ(err.message, "m: curve 0: unknown segment code 7");
  CHECK(!framework::parse_motion("[]", "m", m, err));
  CHECK_EQ(err.message, "m: not a JSON object");
  // 3c.2: a Model curve after a Parameter curve, and what follows, are left out.
  CHECK(framework::parse_motion(R"({"Meta":{"CurveCount":2,"TotalSegmentCount":0,"TotalPointCount":2},
    "Curves":[{"Target":"Parameter","Id":"A","Segments":[0,1]},{"Target":"Model","Id":"Opacity","Segments":[0,1]}]})",
                                "m", m, err));
  CHECK_EQ(m.curves.size(), 1u);
  CHECK_EQ(m.ignored_curves, 1u);
  // The Bézier solver hits the end points.
  CHECK_EQ(framework::solve_bezier_parameter(0, 1.0 / 3, 2.0 / 3, 1, 0), 0.0);
  CHECK_EQ(framework::solve_bezier_parameter(0, 1.0 / 3, 2.0 / 3, 1, 1), 1.0);
}

TEST(wav_decoding) {
  framework::WavSound w;
  String err;
  const std::string b = wav16(8000, 80, 16384);
  CHECK(framework::decode_wav(reinterpret_cast<const uint8_t*>(b.data()), b.size(), w, err));
  CHECK_EQ(w.frames, 80.0);
  CHECK_EQ(w.samples[0][3], static_cast<double>(static_cast<float>(16384.0 * 65536 / 2147483647)));
  std::string bad = b;
  bad[20] = 3;  // float samples
  CHECK(!framework::decode_wav(reinterpret_cast<const uint8_t*>(bad.data()), bad.size(), w, err));
  CHECK_EQ(err, "format code 3 is not linear PCM");
  CHECK(!framework::decode_wav(reinterpret_cast<const uint8_t*>("RIFF"), 4, w, err));
  CHECK_EQ(err, "not a RIFF/WAVE file");
}

TEST(animator_c_api) {
  const auto bytes = written(tiny_model(5, true), 5);
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  const char* settings_json = R"({"Version":3,"FileReferences":{"Moc":"m.moc3","Textures":[],
    "Motions":{"Idle":[{"File":"m.motion3.json","FadeInTime":0.5,"Sound":"s.wav"}],"0":[]}},
    "Groups":[{"Target":"Parameter","Name":"LipSync","Ids":["ParamX"]}],
    "HitAreas":[{"Id":"Mesh","Name":"Body"}],"Layout":{"width":2,"x":"no"}})";
  m2d_settings* settings = nullptr;
  CHECK_EQ(m2d_settings_parse(settings_json, std::strlen(settings_json), "m.model3.json", nullptr, &settings, &err),
           M2D_OK);
  CHECK_EQ(m2d_settings_motion_group_count(settings), 2);
  CHECK_EQ(std::string(m2d_settings_motion_group_name(settings, 0)), "0");  // integer-like keys first
  m2d_motion_entry entry;
  CHECK_EQ(m2d_settings_motion(settings, 1, 0, &entry), M2D_OK);
  CHECK_EQ(std::string(entry.sound), "s.wav");
  CHECK_EQ(entry.fade_in, 0.5);
  CHECK(std::isnan(entry.fade_out));
  CHECK_EQ(m2d_settings_group_id_count(settings, "LipSync"), 1);
  double width = 0;
  CHECK_EQ(m2d_settings_layout(settings, "width", &width), 1);
  CHECK_EQ(width, 2.0);
  CHECK_EQ(m2d_settings_layout(settings, "x", &width), 0);
  CHECK(m2d_settings_file(settings, M2D_SETTINGS_PHYSICS) == nullptr);
  m2d_settings_destroy(settings);
  CHECK_EQ(m2d_settings_parse("{}", 2, "bad", nullptr, &settings, &err), M2D_FILE_ERROR);
  CHECK(settings == nullptr);
  CHECK_EQ(std::string(err.message), "bad: no FileReferences object");
  CHECK_EQ(m2d_settings_parse(settings_json, std::strlen(settings_json), nullptr, nullptr, &settings, &err), M2D_OK);

  m2d_motion* motion = nullptr;
  CHECK_EQ(m2d_motion_parse(kMotion, std::strlen(kMotion), "m.motion3.json", nullptr, &motion, &err), M2D_OK);
  CHECK_EQ(m2d_motion_event_count(motion), 1);
  m2d_animator* anim = nullptr;
  CHECK_EQ(m2d_animator_create(model, settings, nullptr, nullptr, nullptr, &anim, &err), M2D_OK);
  CHECK_EQ(m2d_animator_has_effect(anim, M2D_EFFECT_LIP_SYNC), 1);
  CHECK_EQ(m2d_animator_has_effect(anim, M2D_EFFECT_EYE_BLINK), 0);
  CHECK_EQ(m2d_animator_has_effect(anim, M2D_EFFECT_IDLE), 0);
  m2d_animator_set_effect(anim, M2D_EFFECT_BREATH, 0);
  m2d_animator_set_effect(anim, M2D_EFFECT_LOOK, 0);
  // Base values persist; the latest frame's value includes motions and effects.
  CHECK_EQ(m2d_animator_set_parameter(anim, "ParamX", 0.25), M2D_OK);
  CHECK_EQ(m2d_animator_set_parameter(anim, "Nope", 1), M2D_INVALID_ARGUMENT);
  m2d_frame frame;
  CHECK_EQ(m2d_animator_frame(anim, 0, &frame, &err), M2D_OK);
  CHECK_EQ(m2d_animator_parameter(anim, "ParamX"), 0.25);
  m2d_motion_start start;
  m2d_motion_start_default(&start);
  CHECK_EQ(m2d_animator_start_motion(anim, motion, &start, nullptr), 1);
  m2d_motion_destroy(motion);  // the queue keeps it alive
  m2d_instance* inst = nullptr;
  CHECK_EQ(m2d_instance_create(model, &inst, &err), M2D_OK);
  int events = 0;
  for (int k = 0; k < 40; k++) {
    CHECK_EQ(m2d_animator_update(anim, inst, 1.0 / 30, &frame, &err), M2D_OK);
    for (int e = 0; e < frame.event_count; e++) events += std::string(m2d_animator_event(anim, e)) == "half";
    if (k == 14) {
      CHECK(frame.motion_updated);
      CHECK(m2d_animator_parameter(anim, "ParamX") > 0.4);
      CHECK_EQ(m2d_animator_parameter(anim, "FreeY"), 5.0);  // a free value
      CHECK_EQ(m2d_instance_parameter(inst, 0), m2d_animator_parameter_values(anim)[0]);
    }
    if (frame.end_count) {
      uint32_t ticket = 0;
      m2d_motion_end_reason reason;
      CHECK_EQ(m2d_animator_end(anim, 0, &ticket, &reason), M2D_OK);
      CHECK_EQ(ticket, 1u);
      CHECK_EQ(reason, M2D_MOTION_FINISHED);
    }
  }
  CHECK_EQ(events, 1);
  CHECK(frame.queue_empty);
  // A motion's result persists (it is saved, 3j) until something writes the base again.
  CHECK_EQ(m2d_animator_parameter(anim, "ParamX"), 1.0);
  CHECK_EQ(m2d_animator_set_parameter(anim, "ParamX", 0.25), M2D_OK);
  // Lip sync from a sound: the RMS is added to the LipSync parameters.
  const std::string w = wav16(8000, 8000, 8192);
  m2d_sound* sound = nullptr;
  CHECK_EQ(m2d_sound_decode(w.data(), w.size(), nullptr, &sound, &err), M2D_OK);
  CHECK_EQ(m2d_animator_start_sound(anim, sound), M2D_OK);
  CHECK_EQ(m2d_animator_frame(anim, 0.1, &frame, &err), M2D_OK);
  CHECK_EQ(frame.has_lip_sync, 1);
  CHECK(frame.lip_sync > 0.24 && frame.lip_sync < 0.26);
  CHECK_EQ(m2d_animator_parameter(anim, "ParamX"), static_cast<double>(static_cast<float>(0.25 + frame.lip_sync)));
  // Idle playback with a random sequence that runs out.
  m2d_animator_options opts;
  m2d_animator_options_default(&opts);
  static int draws = 0;
  draws = 0;
  opts.random = [](double* out, void*) -> int32_t {
    if (draws >= 2) return 0;
    draws++;
    *out = 0.5;
    return 1;
  };
  m2d_animator* idle = nullptr;
  CHECK_EQ(m2d_animator_create(model, settings, nullptr, nullptr, &opts, &idle, &err), M2D_OK);
  CHECK_EQ(m2d_motion_parse(kMotion, std::strlen(kMotion), "m.motion3.json", nullptr, &motion, &err), M2D_OK);
  m2d_idle_motion im{motion, sound, std::nan(""), std::nan("")};
  CHECK_EQ(m2d_animator_set_idle_motions(idle, &im, 1), M2D_OK);
  CHECK_EQ(m2d_animator_effect(idle, M2D_EFFECT_IDLE), 1);
  CHECK_EQ(m2d_animator_frame(idle, 0.5, &frame, &err), M2D_OK);  // draws, starts the idle motion
  CHECK_EQ(m2d_animator_motion_count(idle), 1);
  CHECK_EQ(m2d_animator_last_ticket(idle), 1u);
  m2d_animator_stop_motions(idle);
  CHECK_EQ(m2d_animator_frame(idle, 0.5, &frame, &err), M2D_OK);  // the second draw
  m2d_animator_stop_motions(idle);
  CHECK_EQ(m2d_animator_frame(idle, 0.5, &frame, &err), M2D_FRAME_ERROR);
  CHECK_EQ(std::string(err.code), "random-exhausted");
  // Hit testing on the evaluated instance.
  double box[4];
  CHECK_EQ(m2d_instance_drawable_bounds(inst, 0, box), M2D_OK);
  CHECK(box[0] <= box[1] && box[2] <= box[3]);
  CHECK_EQ(m2d_instance_hit_test(inst, 0, box[0], box[2]), 1);
  CHECK_EQ(m2d_instance_hit_test(inst, 0, box[1] + 1, box[2]), 0);
  m2d_motion_destroy(motion);
  m2d_sound_destroy(sound);
  m2d_animator_destroy(idle);
  m2d_animator_destroy(anim);
  m2d_instance_destroy(inst);
  m2d_settings_destroy(settings);
  m2d_model_destroy(model);
}

TEST(idle_weights_base_values_tints) {
  const auto bytes = written(tiny_model(5, true), 5);
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  const char* settings_json = R"({"Version":3,"FileReferences":{"Moc":"m.moc3","Textures":[]}})";
  m2d_settings* settings = nullptr;
  CHECK_EQ(m2d_settings_parse(settings_json, std::strlen(settings_json), "m.model3.json", nullptr, &settings, &err),
           M2D_OK);
  m2d_animator* anim = nullptr;
  CHECK_EQ(m2d_animator_create(model, settings, nullptr, nullptr, nullptr, &anim, &err), M2D_OK);
  m2d_animator_set_effect(anim, M2D_EFFECT_BREATH, 0);
  m2d_animator_set_effect(anim, M2D_EFFECT_LOOK, 0);
  // Idle weights: NaN and unknown IDs are refused; values are limited to [0, 1], and 1 removes one.
  CHECK_EQ(m2d_animator_set_idle_weight(anim, "ParamX", std::nan("")), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_set_idle_weight(anim, "Nope", 0.5), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_idle_weight(anim, "ParamX"), 1.0);
  CHECK_EQ(m2d_animator_set_idle_weight(anim, "ParamX", -3), M2D_OK);
  CHECK_EQ(m2d_animator_idle_weight(anim, "ParamX"), 0.0);
  CHECK(!std::signbit(m2d_animator_idle_weight(anim, "ParamX")));
  CHECK_EQ(m2d_animator_set_idle_weight(anim, "ParamX", 7), M2D_OK);
  CHECK_EQ(m2d_animator_idle_weight(anim, "ParamX"), 1.0);
  CHECK_EQ(m2d_animator_set_idle_weight(anim, "ParamX", 0), M2D_OK);
  // An idle motion (priority 1) leaves a parameter of weight 0 at its base value.
  m2d_motion* motion = nullptr;
  CHECK_EQ(m2d_motion_parse(kMotion, std::strlen(kMotion), "m.motion3.json", nullptr, &motion, &err), M2D_OK);
  CHECK_EQ(m2d_animator_set_parameter(anim, "ParamX", 0.25), M2D_OK);
  m2d_motion_start start;
  m2d_motion_start_default(&start);
  start.priority = 1;
  CHECK_EQ(m2d_animator_start_motion(anim, motion, &start, nullptr), 1);
  m2d_frame frame;
  for (int k = 0; k < 10; k++) CHECK_EQ(m2d_animator_frame(anim, 0.05, &frame, &err), M2D_OK);
  CHECK_EQ(m2d_animator_parameter(anim, "ParamX"), 0.25);
  CHECK_EQ(m2d_animator_parameter(anim, "FreeY"), 5.0);  // a free value: no weight set
  // At 0.5 the motion moves it half as far: v + (c − v)·0.5, with c = 0.5 here.
  CHECK_EQ(m2d_animator_set_idle_weight(anim, "ParamX", 0.5), M2D_OK);
  CHECK_EQ(m2d_animator_frame(anim, 0.05, &frame, &err), M2D_OK);
  CHECK(std::fabs(m2d_animator_parameter(anim, "ParamX") - 0.375) < 1e-6);
  // Other priorities are not affected.
  m2d_animator_reset_idle_weights(anim);
  CHECK_EQ(m2d_animator_idle_weight(anim, "ParamX"), 1.0);
  CHECK_EQ(m2d_animator_set_idle_weight(anim, "ParamX", 0), M2D_OK);
  start.priority = 2;
  CHECK_EQ(m2d_animator_start_motion(anim, motion, &start, nullptr), 1);
  for (int k = 0; k < 12; k++) CHECK_EQ(m2d_animator_frame(anim, 0.05, &frame, &err), M2D_OK);
  CHECK(std::fabs(m2d_animator_parameter(anim, "ParamX") - 0.55) < 1e-6);  // the curve's value
  // Base values: what motions left (saved by the frame), beneath expressions and effects.
  const char* add = R"({"Type":"Live2D Expression","FadeInTime":0,"Parameters":[{"Id":"ParamX","Value":0.125,"Blend":"Add"}]})";
  m2d_expression* expression = nullptr;
  CHECK_EQ(m2d_expression_parse(add, std::strlen(add), "e.exp3.json", nullptr, &expression, &err), M2D_OK);
  m2d_animator_stop_motions(anim);
  CHECK_EQ(m2d_animator_start_expression(anim, expression), M2D_OK);
  for (int k = 0; k < 4; k++) CHECK_EQ(m2d_animator_frame(anim, 0.05, &frame, &err), M2D_OK);
  const double base = m2d_animator_parameter_base(anim, "ParamX");
  CHECK(std::fabs(base - 0.55) < 1e-6);
  CHECK_EQ(m2d_animator_parameter(anim, "ParamX"), static_cast<double>(static_cast<float>(base + 0.125)));
  CHECK_EQ(static_cast<double>(m2d_animator_parameter_base_values(anim)[0]), base);
  CHECK_EQ(m2d_animator_parameter_base(anim, "FreeY"), m2d_animator_parameter(anim, "FreeY"));
  CHECK_EQ(m2d_animator_set_parameter(anim, "ParamX", -0.5), M2D_OK);  // limited to [0, 1]
  CHECK_EQ(m2d_animator_parameter_base(anim, "ParamX"), 0.0);
  CHECK_EQ(m2d_animator_set_parameter(anim, "ParamX", 0.125), M2D_OK);
  CHECK_EQ(m2d_animator_parameter_base(anim, "ParamX"), 0.125);
  CHECK_EQ(m2d_animator_parameter(anim, "ParamX"), 0.125);  // as set, until the next frame
  CHECK_EQ(m2d_animator_frame(anim, 0.05, &frame, &err), M2D_OK);
  CHECK_EQ(m2d_animator_parameter(anim, "ParamX"), 0.25);
  m2d_expression_destroy(expression);
  m2d_motion_destroy(motion);

  // Tints: draw data of the instance, checked in Mochi2D's order, limited to [0, 1].
  m2d_instance* inst = nullptr;
  CHECK_EQ(m2d_instance_create(model, &inst, &err), M2D_OK);
  CHECK(m2d_instance_drawable_tints(inst) == nullptr);
  CHECK_EQ(m2d_instance_tint_count(inst), 0);
  const uint32_t v0 = m2d_instance_tint_version(inst);
  const double two[2] = {1, 1};
  const double inf[3] = {1, INFINITY, 0};
  const double rgb[3] = {0.5, 3, -1};  // 0.14.0: r, g, b limited to [0, 2]
  CHECK_EQ(m2d_instance_set_tint(inst, 0, two, 2), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_instance_set_tint(inst, 0, inf, 3), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_instance_set_tint(inst, 1, rgb, 3), M2D_INVALID_ARGUMENT);  // one mesh only
  CHECK_EQ(m2d_instance_tint_version(inst), v0);
  float t[4] = {9, 9, 9, 9};
  CHECK_EQ(m2d_instance_tint(inst, 0, t), 0);
  CHECK_EQ(t[0], 9.0f);
  CHECK_EQ(m2d_instance_set_tint(inst, 0, rgb, 3), M2D_OK);
  CHECK_EQ(m2d_instance_tint(inst, 0, t), 1);
  CHECK(t[0] == 0.5f && t[1] == 2.0f && t[2] == 0.0f && !std::signbit(t[2]) && t[3] == 1.0f);
  const float* all = m2d_instance_drawable_tints(inst);
  CHECK(all != nullptr && all[0] == 0.5f && all[3] == 1.0f);
  CHECK_EQ(m2d_instance_tint_count(inst), 1);
  CHECK_EQ(m2d_instance_tinted_drawable(inst, 0), 0);
  CHECK_EQ(m2d_instance_tinted_drawable(inst, 1), -1);
  const double rgba[4] = {0.1, 0.2, 0.3, 0.4};
  CHECK_EQ(m2d_instance_set_tint(inst, 0, rgba, 4), M2D_OK);
  CHECK_EQ(m2d_instance_evaluate(inst, &err), M2D_OK);  // evaluation leaves tints alone
  CHECK_EQ(m2d_instance_tint(inst, 0, t), 1);
  CHECK(t[0] == 0.1f && t[1] == 0.2f && t[2] == 0.3f && t[3] == 0.4f);
  const uint32_t v1 = m2d_instance_tint_version(inst);
  CHECK(v1 != v0);
  CHECK_EQ(m2d_instance_clear_tint(inst, 0), 1);
  CHECK_EQ(m2d_instance_clear_tint(inst, 0), 0);
  CHECK(m2d_instance_drawable_tints(inst) == nullptr);
  CHECK(m2d_instance_tint_version(inst) != v1);
  const double bright[4] = {1.5, 2.5, 1, 1.5};
  CHECK_EQ(m2d_instance_set_tint(inst, 0, bright, 4), M2D_OK);
  CHECK_EQ(m2d_instance_tint(inst, 0, t), 1);
  CHECK(t[0] == 1.5f && t[1] == 2.0f && t[2] == 1.0f && t[3] == 1.0f);  // the alpha stays within [0, 1]
  CHECK_EQ(m2d_instance_set_tint(inst, 0, rgba, 3), M2D_OK);
  m2d_instance_clear_tints(inst);
  CHECK_EQ(m2d_instance_tint_count(inst), 0);
  // The reference's messages, for SDKs that raise them.
  framework::Tints tints(2);
  String message;
  CHECK(tints.set(0, two, 5, "Mesh", &message) == framework::Tints::SetError::Count);
  CHECK_EQ(std::string(message), "a tint is [r, g, b] or [r, g, b, a], not 5 numbers");
  CHECK(tints.set(0, inf, 3, "Mesh", &message) == framework::Tints::SetError::NotFinite);
  CHECK_EQ(std::string(message), "tint of Mesh: Infinity is not a finite number");
  const double nan3[3] = {std::nan(""), 0, 0};
  CHECK(tints.set(5, nan3, 3, "X", &message) == framework::Tints::SetError::NotFinite);  // checked before the index
  CHECK_EQ(std::string(message), "tint of X: NaN is not a finite number");
  CHECK(tints.set(5, rgb, 3) == framework::Tints::SetError::Unknown);
  CHECK(tints.active() == nullptr);
  m2d_instance_destroy(inst);
  m2d_animator_destroy(anim);
  m2d_settings_destroy(settings);
  m2d_model_destroy(model);
}

namespace {

/** An in-memory m2d_file_source over a map of files. */
struct MemoryFiles {
  std::map<std::string, std::string> files;
  bool listable = true;
  int reads = 0, releases = 0;
  m2d_file_source source(const char* label) {
    m2d_file_source s{};
    s.label = label;
    s.user = this;
    s.read = [](const char* path, const void** data, size_t* size, void* user) -> int32_t {
      auto* self = static_cast<MemoryFiles*>(user);
      auto it = self->files.find(path);
      if (it == self->files.end()) return 0;
      self->reads++;
      *data = it->second.data();
      *size = it->second.size();
      return 1;
    };
    s.release = [](const void*, size_t, void* user) { static_cast<MemoryFiles*>(user)->releases++; };
    s.list = [](void (*add)(const char*, void*), void* context, void* user) -> int32_t {
      auto* self = static_cast<MemoryFiles*>(user);
      if (!self->listable) return 0;
      for (const auto& f : self->files) add(f.first.c_str(), context);
      return 1;
    };
    return s;
  }
};

}  // namespace

TEST(packages) {
  using framework::join_path;
  String joined, message;
  CHECK(join_path("a/b", "../c/./d.json", joined));
  CHECK_EQ(std::string(joined), "a/c/d.json");
  CHECK(join_path("", "x\\y.moc3", joined));
  CHECK_EQ(std::string(joined), "x/y.moc3");
  CHECK(!join_path("a", "../../b", joined, &message));
  CHECK_EQ(std::string(message), "Path escapes the source root: \"a/../../b\"");
  CHECK_EQ(std::string(framework::dirname_of("a/b/c.model3.json")), "a/b");
  CHECK(framework::classify_model_file("M/X.MODEL3.JSON") == framework::ModelFileKind::Settings);

  MemoryFiles mem;
  const auto moc = written(tiny_model(5, true), 5);
  mem.files["deep/more/b.model3.json"] = "{}";
  mem.files["m/model.model3.json"] = R"({"Version":3,"FileReferences":{"Moc":"../moc/m.moc3","Textures":["t/0.png"],
    "Physics":"broken.physics3.json","Pose":"none.pose3.json","DisplayInfo":"../../x.cdi3.json",
    "Expressions":[{"Name":"smile","File":"e.exp3.json"}],
    "Motions":{"Idle":[{"File":"idle.motion3.json","FadeInTime":0.25,"Sound":"bad.wav"}],
               "Tap":[{"File":"missing.motion3.json"}]}}})";
  mem.files["moc/m.moc3"] = std::string(moc.begin(), moc.end());
  mem.files["m/broken.physics3.json"] = "[";
  mem.files["m/e.exp3.json"] = R"({"Type":"Live2D Expression","Parameters":[{"Id":"ParamX","Value":0.5}]})";
  mem.files["m/idle.motion3.json"] = kMotion;
  mem.files["m/bad.wav"] = "RIFF";
  const m2d_file_source source = mem.source("box");
  m2d_error err;
  m2d_package* pkg = nullptr;
  // Without a path: the shallowest settings file.
  CHECK_EQ(m2d_package_open(&source, nullptr, 0, nullptr, &pkg, &err), M2D_OK);
  CHECK_EQ(std::string(m2d_package_settings_path(pkg)), "m/model.model3.json");
  CHECK(mem.reads == mem.releases);
  CHECK(m2d_package_model(pkg) != nullptr);
  CHECK_EQ(m2d_model_parameter_count(m2d_package_model(pkg)), 1);
  CHECK(m2d_package_physics(pkg) == nullptr);
  CHECK(m2d_package_pose(pkg) == nullptr);
  CHECK(m2d_package_display_info(pkg) == nullptr);
  CHECK_EQ(m2d_package_warning_count(pkg), 3);
  CHECK_EQ(std::string(m2d_package_warning(pkg, 0)),
           "broken.physics3.json: broken.physics3.json: invalid JSON (Unexpected end of JSON input)");
  CHECK_EQ(std::string(m2d_package_warning(pkg, 1)), "none.pose3.json: File not found: \"m/none.pose3.json\" in box");
  CHECK_EQ(std::string(m2d_package_warning(pkg, 2)),
           "../../x.cdi3.json: Path escapes the source root: \"m/../../x.cdi3.json\"");
  char* texture = m2d_package_resolve(pkg, m2d_settings_texture(m2d_package_settings(pkg), 0));
  CHECK_EQ(std::string(texture), "m/t/0.png");
  m2d_free_string(texture);
  CHECK(m2d_package_resolve(pkg, "../../up.png") == nullptr);
  // Motions and expressions, read once.
  const m2d_motion* a = nullptr;
  const m2d_motion* b = nullptr;
  CHECK_EQ(m2d_package_motion(pkg, "idle.motion3.json", &a, &err), M2D_OK);
  const int reads = mem.reads;
  CHECK_EQ(m2d_package_motion(pkg, "./idle.motion3.json", &b, &err), M2D_OK);
  CHECK(a == b && mem.reads == reads);
  CHECK_EQ(m2d_package_motion(pkg, "missing.motion3.json", &b, &err), M2D_FILE_ERROR);
  CHECK(b == nullptr);
  CHECK_EQ(std::string(err.message), "File not found: \"m/missing.motion3.json\" in box");
  const m2d_expression* e = nullptr;
  CHECK_EQ(m2d_package_named_expression(pkg, "smile", &e, &err), M2D_OK);
  CHECK_EQ(m2d_expression_parameter_count(e), 1);
  CHECK_EQ(m2d_package_named_expression(pkg, "frown", &e, &err), M2D_INVALID_ARGUMENT);
  // A sound that cannot be decoded: the unusable sound, cached.
  const m2d_sound* sound = nullptr;
  CHECK_EQ(m2d_package_sound(pkg, "bad.wav", &sound, &err), M2D_FILE_ERROR);
  CHECK(sound == m2d_sound_unusable());
  CHECK_EQ(std::string(err.code), "file");
  // A group entry, resolved as Mochi2D starts it.
  m2d_idle_motion idle;
  CHECK_EQ(m2d_package_group_motion(pkg, "Idle", 0, &idle, &err), M2D_FILE_ERROR);  // the sound
  CHECK(idle.motion == a && idle.sound == m2d_sound_unusable());
  CHECK_EQ(idle.fade_in, 0.25);
  CHECK(std::isnan(idle.fade_out));
  CHECK_EQ(m2d_package_group_motion(pkg, "Tap", 0, &idle, &err), M2D_FILE_ERROR);
  CHECK(idle.motion == nullptr && idle.sound == nullptr);
  CHECK_EQ(m2d_package_group_motion(pkg, "Tap", 1, &idle, &err), M2D_INVALID_ARGUMENT);
  // The package's objects drive an animator, which outlives the package.
  m2d_animator* anim = nullptr;
  CHECK_EQ(m2d_animator_create(m2d_package_model(pkg), m2d_package_settings(pkg), m2d_package_physics(pkg),
                               m2d_package_pose(pkg), nullptr, &anim, &err),
           M2D_OK);
  CHECK_EQ(m2d_package_group_motion(pkg, "Idle", 0, &idle, &err), M2D_FILE_ERROR);
  CHECK_EQ(m2d_animator_set_idle_motions(anim, &idle, 1), M2D_OK);
  m2d_package_destroy(pkg);
  m2d_frame frame;
  for (int k = 0; k < 5; k++) CHECK_EQ(m2d_animator_frame(anim, 0.1, &frame, &err), M2D_OK);
  CHECK_EQ(m2d_animator_motion_count(anim), 1);
  m2d_animator_destroy(anim);
  // Errors: a named settings file that is missing, a broken one, no settings at all.
  CHECK_EQ(m2d_package_open(&source, "nope.model3.json", 0, nullptr, &pkg, &err), M2D_FILE_ERROR);
  CHECK(pkg == nullptr);
  CHECK_EQ(std::string(err.message), "File not found: \"nope.model3.json\" in box");
  CHECK_EQ(m2d_package_open(&source, "deep/more/b.model3.json", 0, nullptr, &pkg, &err), M2D_FILE_ERROR);
  CHECK_EQ(std::string(err.code), "settings");
  CHECK_EQ(std::string(err.message), "deep/more/b.model3.json: no FileReferences object");
  MemoryFiles empty;
  empty.files["model.zip"] = "PK";
  m2d_file_source es = empty.source("downloads");
  CHECK_EQ(m2d_package_open(&es, nullptr, 0, nullptr, &pkg, &err), M2D_FILE_ERROR);
  CHECK_EQ(std::string(err.message), "downloads: no *.model3.json file found; open the zip archive \"model.zip\" itself");
  empty.listable = false;
  CHECK_EQ(m2d_package_open(&es, nullptr, 0, nullptr, &pkg, &err), M2D_FILE_ERROR);
  CHECK_EQ(std::string(err.message),
           "downloads: name the *.model3.json file to load (this source cannot list its files)");
  mem.files["moc/m.moc3"] = "not a moc";
  CHECK_EQ(m2d_package_open(&source, "m/model.model3.json", 0, nullptr, &pkg, &err), M2D_FORMAT_ERROR);
  CHECK(pkg == nullptr);
  CHECK_EQ(std::string(err.message), "file is 9 bytes, shorter than the 64-byte header");
}

TEST(live_input) {
  CHECK_EQ(m2d_dbfs_to_amplitude(-INFINITY), 0.0);
  CHECK(std::fabs(m2d_dbfs_to_amplitude(-20) - 0.1) < 1e-15);
  m2d_live_input_settings neutral, defaults;
  m2d_live_input_settings_neutral(&neutral);
  m2d_live_input_settings_default(&defaults);
  CHECK(neutral.gain == 1 && std::isinf(neutral.gate) && neutral.attack == 0 && neutral.release == 0);
  CHECK(defaults.gain == 12 && defaults.gate == -45 && defaults.attack == 0.03 && defaults.release == 0.12);
  m2d_live_input* input = nullptr;
  CHECK_EQ(m2d_live_input_create(48000, &neutral, 0, nullptr, &input), M2D_OK);
  // A square wave of amplitude 0.25 has RMS 0.25, in planar and interleaved form alike.
  std::vector<float> left(480), right(480), inter(960);
  for (int i = 0; i < 480; i++) {
    left[static_cast<std::size_t>(i)] = i & 1 ? -0.25f : 0.25f;
    right[static_cast<std::size_t>(i)] = -left[static_cast<std::size_t>(i)];
    inter[2 * static_cast<std::size_t>(i)] = left[static_cast<std::size_t>(i)];
    inter[2 * static_cast<std::size_t>(i) + 1] = right[static_cast<std::size_t>(i)];
  }
  const float* planar[2] = {left.data(), right.data()};
  m2d_live_input_push(input, planar, 2, 480);
  CHECK_EQ(m2d_live_input_pending(input), 0.01);
  CHECK_EQ(m2d_live_input_next(input, 1.0 / 60), 0.25);
  CHECK_EQ(m2d_live_input_level(input), 0.25);
  m2d_live_input_push_interleaved(input, inter.data(), 2, 480);
  CHECK_EQ(m2d_live_input_next(input, 1.0 / 60), 0.25);
  // No samples: the value holds, then after 0.1 s counts as silence.
  CHECK_EQ(m2d_live_input_next(input, 0.05), 0.25);
  CHECK_EQ(m2d_live_input_next(input, 0.06), 0.0);
  // The gate and gain of the defaults; bad sums are ignored.
  m2d_live_input_set_settings(input, &defaults);
  m2d_live_input_push_sums(input, NAN, 1, 1);
  m2d_live_input_push_sums(input, -1, 1, 1);
  CHECK_EQ(m2d_live_input_pending(input), 0.0);
  // Attached to an animator, it moves the lip-sync parameters each frame.
  const auto bytes = written(tiny_model(5, true), 5);
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  const char* settings_json = R"({"Version":3,"FileReferences":{"Moc":"m.moc3","Textures":[]},
    "Groups":[{"Target":"Parameter","Name":"LipSync","Ids":["ParamX"]}]})";
  m2d_settings* settings = nullptr;
  CHECK_EQ(m2d_settings_parse(settings_json, std::strlen(settings_json), "m.model3.json", nullptr, &settings, &err),
           M2D_OK);
  m2d_animator* anim = nullptr;
  CHECK_EQ(m2d_animator_create(model, settings, nullptr, nullptr, nullptr, &anim, &err), M2D_OK);
  m2d_animator_set_effect(anim, M2D_EFFECT_BREATH, 0);
  m2d_animator_set_effect(anim, M2D_EFFECT_LOOK, 0);
  m2d_live_input_set_settings(input, &neutral);
  CHECK_EQ(m2d_animator_set_live_input(anim, input, M2D_LIP_SYNC_ADD, nullptr, nullptr), M2D_OK);
  m2d_frame frame;
  CHECK_EQ(m2d_animator_frame(anim, 1.0 / 60, &frame, &err), M2D_OK);
  CHECK_EQ(m2d_animator_parameter(anim, "ParamX"), 0.0);  // no samples yet
  m2d_live_input_push(input, planar, 2, 480);
  m2d_live_input_destroy(input);  // the animator keeps it
  CHECK_EQ(m2d_animator_frame(anim, 1.0 / 60, &frame, &err), M2D_OK);
  CHECK_EQ(m2d_animator_parameter(anim, "ParamX"), 0.25);
  CHECK_EQ(m2d_animator_set_live_input(anim, nullptr, M2D_LIP_SYNC_ADD, nullptr, nullptr), M2D_OK);
  CHECK_EQ(m2d_animator_frame(anim, 1.0 / 60, &frame, &err), M2D_OK);
  CHECK_EQ(m2d_animator_parameter(anim, "ParamX"), 0.0);
  m2d_animator_destroy(anim);
  m2d_settings_destroy(settings);
  m2d_model_destroy(model);
}

TEST(physics_strength_wind_hold) {
  g_test = "physics_strength_wind_hold";
  const auto bytes = written(tiny_model(5, true), 5);
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  const char* physics = R"({"Version":3,"Meta":{"PhysicsSettingCount":1,"TotalInputCount":1,"TotalOutputCount":1,
    "VertexCount":2,"Fps":30,"PhysicsDictionary":[{"Id":"S","Name":"Hair"}]},
    "PhysicsSettings":[{"Id":"S","Input":[{"Source":{"Id":"ParamX"},"Weight":100,"Type":"X","Reflect":false}],
      "Output":[{"Destination":{"Id":"ParamX"},"VertexIndex":1,"Scale":0.1,"Weight":50,"Type":"Angle","Reflect":false}],
      "Vertices":[{"Position":{"X":0,"Y":0},"Mobility":1,"Delay":1,"Acceleration":1,"Radius":0},
                  {"Position":{"X":0,"Y":3},"Mobility":0.9,"Delay":0.8,"Acceleration":1.5,"Radius":3}],
      "Normalization":{"Position":{"Minimum":-10,"Default":0,"Maximum":10},"Angle":{"Minimum":-10,"Default":0,"Maximum":10}}}]})";
  m2d_physics* ph = nullptr;
  CHECK_EQ(m2d_physics_parse(physics, std::strlen(physics), "p.physics3.json", nullptr, &ph, &err), M2D_OK);
  // ParamX after `frames` frames of 1/30 s from a base value of 0.6, then one frame of no time.
  auto run = [&](double strength, double setting, bool hold, double& moving, double& paused) {
    m2d_animator* anim = nullptr;
    CHECK_EQ(m2d_animator_create(model, nullptr, ph, nullptr, nullptr, &anim, &err), M2D_OK);
    m2d_animator_set_effect(anim, M2D_EFFECT_BREATH, 0);
    m2d_animator_set_effect(anim, M2D_EFFECT_LOOK, 0);
    CHECK_EQ(m2d_animator_set_physics_strength(anim, strength), M2D_OK);
    CHECK_EQ(m2d_animator_set_physics_setting_strength(anim, "S", setting), M2D_OK);
    m2d_animator_set_physics_hold(anim, hold ? 1 : 0);
    CHECK_EQ(m2d_animator_set_parameter(anim, "ParamX", 0.6), M2D_OK);
    m2d_frame frame;
    for (int k = 0; k < 20; k++) CHECK_EQ(m2d_animator_frame(anim, 1.0 / 30, &frame, &err), M2D_OK);
    moving = m2d_animator_parameter(anim, "ParamX");
    CHECK_EQ(m2d_animator_frame(anim, 0, &frame, &err), M2D_OK);
    paused = m2d_animator_parameter(anim, "ParamX");
    m2d_animator_destroy(anim);
  };
  double ref_moving, ref_paused, off_moving, off_paused, set_moving, set_paused, held_moving, held_paused, big, big_paused;
  run(1, 1, false, ref_moving, ref_paused);
  run(0, 1, false, off_moving, off_paused);
  run(1, 0, false, set_moving, set_paused);
  run(1, 1, true, held_moving, held_paused);
  run(3, 1, false, big, big_paused);
  CHECK(ref_moving != 0.6);                       // physics moves its output parameter
  CHECK_EQ(ref_paused, static_cast<double>(static_cast<float>(0.6)));  // the reference writes nothing in a zero step
  CHECK_EQ(off_moving, static_cast<double>(static_cast<float>(0.6)));  // strength 0: as with physics off
  CHECK_EQ(set_moving, off_moving);               // the setting's strength multiplies the model's
  CHECK_EQ(held_moving, ref_moving);              // holding changes nothing in frames that take time
  CHECK_EQ(held_paused, ref_moving);              // and keeps the physics pose in a zero step
  CHECK(std::fabs(big - 0.6) > std::fabs(ref_moving - 0.6));  // above 1 exaggerates
  CHECK(big >= 0 && big <= 1);                    // within the parameter's range
  // The API's checks and getters.
  m2d_animator* anim = nullptr;
  CHECK_EQ(m2d_animator_create(model, nullptr, ph, nullptr, nullptr, &anim, &err), M2D_OK);
  CHECK_EQ(m2d_animator_physics_setting_count(anim), 1);
  CHECK_EQ(std::string(m2d_animator_physics_setting_id(anim, 0)), "S");
  CHECK_EQ(std::string(m2d_animator_physics_setting_name(anim, 0)), "Hair");
  CHECK_EQ(m2d_animator_set_physics_strength(anim, std::nan("")), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_set_physics_strength(anim, -2), M2D_OK);
  CHECK_EQ(m2d_animator_physics_strength(anim), 0.0);
  CHECK_EQ(m2d_animator_set_physics_setting_strength(anim, "Nope", 0.5), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_set_physics_setting_strength(anim, "S", 0.5), M2D_OK);
  CHECK_EQ(m2d_animator_physics_setting_strength(anim, "S"), 0.5);
  m2d_animator_reset_physics_strengths(anim);
  CHECK_EQ(m2d_animator_physics_strength(anim), 1.0);
  CHECK_EQ(m2d_animator_physics_setting_strength(anim, "S"), 1.0);
  CHECK_EQ(m2d_animator_set_physics_wind(anim, 1, INFINITY), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_set_physics_wind(anim, 0.25, -0.5), M2D_OK);
  double wx = 0, wy = 0;
  m2d_animator_physics_wind(anim, &wx, &wy);
  CHECK_EQ(wx, 0.25);
  CHECK_EQ(wy, -0.5);
  m2d_animator_destroy(anim);
  m2d_physics_destroy(ph);
  m2d_model_destroy(model);
}

TEST(physics_setting_wind) {
  // Mochi2D 0.13.0's wind per setting: the setting's pendulums feel V times its multiplier, so
  // (V, 2) gives the bits of (2V, 1), (V, 0) those of no wind, and 1 is the reference.
  g_test = "physics_setting_wind";
  const auto bytes = written(tiny_model(5, true), 5);
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  const char* physics = R"({"Version":3,"Meta":{"PhysicsSettingCount":1,"TotalInputCount":1,"TotalOutputCount":1,
    "VertexCount":2,"Fps":30,"PhysicsDictionary":[{"Id":"S","Name":"Hair"}]},
    "PhysicsSettings":[{"Id":"S","Input":[{"Source":{"Id":"ParamX"},"Weight":100,"Type":"X","Reflect":false}],
      "Output":[{"Destination":{"Id":"ParamX"},"VertexIndex":1,"Scale":0.1,"Weight":50,"Type":"Angle","Reflect":false}],
      "Vertices":[{"Position":{"X":0,"Y":0},"Mobility":1,"Delay":1,"Acceleration":1,"Radius":0},
                  {"Position":{"X":0,"Y":3},"Mobility":0.9,"Delay":0.8,"Acceleration":1.5,"Radius":3}],
      "Normalization":{"Position":{"Minimum":-10,"Default":0,"Maximum":10},"Angle":{"Minimum":-10,"Default":0,"Maximum":10}}}]})";
  m2d_physics* ph = nullptr;
  CHECK_EQ(m2d_physics_parse(physics, std::strlen(physics), "p.physics3.json", nullptr, &ph, &err), M2D_OK);
  auto run = [&](double wx, double wy, double multiplier) {
    m2d_animator* anim = nullptr;
    CHECK_EQ(m2d_animator_create(model, nullptr, ph, nullptr, nullptr, &anim, &err), M2D_OK);
    m2d_animator_set_effect(anim, M2D_EFFECT_BREATH, 0);
    m2d_animator_set_effect(anim, M2D_EFFECT_LOOK, 0);
    CHECK_EQ(m2d_animator_set_physics_wind(anim, wx, wy), M2D_OK);
    CHECK_EQ(m2d_animator_set_physics_setting_wind(anim, "S", multiplier), M2D_OK);
    CHECK_EQ(m2d_animator_physics_setting_wind(anim, "S"), multiplier);
    CHECK_EQ(m2d_animator_set_parameter(anim, "ParamX", 0.6), M2D_OK);
    m2d_frame frame;
    std::vector<double> trace;
    for (int k = 0; k < 30; k++) {
      CHECK_EQ(m2d_animator_frame(anim, 1.0 / 30, &frame, &err), M2D_OK);
      trace.push_back(m2d_animator_parameter(anim, "ParamX"));
    }
    m2d_animator_destroy(anim);
    return trace;
  };
  const auto reference = run(0.3, -0.7, 1);
  CHECK(reference != run(0, 0, 1));          // the wind moves the pendulum
  CHECK(run(0.3, -0.7, 2) == run(0.6, -1.4, 1));
  CHECK(run(0.3, -0.7, 0) == run(0, 0, 1));
  CHECK(run(0.3, -0.7, -1) == run(-0.3, 0.7, 1));
  // The API's checks, the getter and the reset.
  m2d_animator* anim = nullptr;
  CHECK_EQ(m2d_animator_create(model, nullptr, ph, nullptr, nullptr, &anim, &err), M2D_OK);
  CHECK_EQ(m2d_animator_physics_setting_wind(anim, "S"), 1.0);
  CHECK_EQ(m2d_animator_set_physics_setting_wind(anim, "Nope", 2), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_set_physics_setting_wind(anim, "S", INFINITY), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_set_physics_setting_wind(anim, "S", 0.5), M2D_OK);
  CHECK_EQ(m2d_animator_physics_setting_wind(anim, "S"), 0.5);
  m2d_animator_reset_physics_setting_winds(anim);
  CHECK_EQ(m2d_animator_physics_setting_wind(anim, "S"), 1.0);
  m2d_animator_destroy(anim);
  m2d_physics_destroy(ph);
  m2d_model_destroy(model);
}

TEST(fuzz_findings_0_16_0) {
  // What Mochi2D 0.16.0's fuzzing found (test/fuzz.test.ts), from the same inputs.
  g_test = "fuzz_findings_0_16_0";
  // Physics: an Fps so high (1e+308, 1e309 read as infinite, 5e-324) that the steps never ended:
  // at most 10,000 internal steps a frame, an infinite rate steps once a frame.
  const auto bytes = written(tiny_model(5, true), 5);
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  const std::string physics = R"({"Version":3,"Meta":{"PhysicsSettingCount":1,"TotalInputCount":1,"TotalOutputCount":1,
    "VertexCount":2,"Fps":30,"PhysicsDictionary":[{"Id":"S","Name":"Hair"}]},
    "PhysicsSettings":[{"Id":"S","Input":[{"Source":{"Id":"ParamX"},"Weight":100,"Type":"X","Reflect":false}],
      "Output":[{"Destination":{"Id":"ParamX"},"VertexIndex":1,"Scale":0.1,"Weight":50,"Type":"Angle","Reflect":false}],
      "Vertices":[{"Position":{"X":0,"Y":0},"Mobility":1,"Delay":1,"Acceleration":1,"Radius":0},
                  {"Position":{"X":0,"Y":3},"Mobility":0.9,"Delay":0.8,"Acceleration":1.5,"Radius":3}],
      "Normalization":{"Position":{"Minimum":-10,"Default":0,"Maximum":10},"Angle":{"Minimum":-10,"Default":0,"Maximum":10}}}]})";
  const auto run = [&](const char* fps) {
    std::string text = physics;
    text.replace(text.find("\"Fps\":30"), 8, std::string("\"Fps\":") + fps);
    m2d_physics* ph = nullptr;
    CHECK_EQ(m2d_physics_parse(text.data(), text.size(), "p.physics3.json", nullptr, &ph, &err), M2D_OK);
    m2d_animator* anim = nullptr;
    CHECK_EQ(m2d_animator_create(model, nullptr, ph, nullptr, nullptr, &anim, &err), M2D_OK);
    const auto t0 = std::chrono::steady_clock::now();
    m2d_frame frame;
    for (int k = 0; k < 5 && anim; k++) CHECK_EQ(m2d_animator_frame(anim, 1.0 / 30, &frame, &err), M2D_OK);
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    CHECK(ms < 2000);
    const double v = anim ? m2d_animator_parameter(anim, "ParamX") : 0;
    m2d_animator_destroy(anim);
    m2d_physics_destroy(ph);
    return v;
  };
  for (const char* fps : {"1e+308", "1e309", "5e-324"}) (void)run(fps);
  CHECK_EQ(framework::PhysicsRig::kMaxStepsPerFrame, 10000);
  m2d_model_destroy(model);
  // .moc3: a corrupt keyform count far beyond the file is refused quickly by the writer and the checks.
  {
    moc::MocData d = tiny_model(5, true);
    d[moc::F::warp_keyformCount].i32[0] = 860049229;
    d[moc::F::mesh_keyformCount].i32[0] = 860049229;
    const auto t0 = std::chrono::steady_clock::now();
    Vector<uint8_t> out;
    Vector<moc::Diagnostic> diags;
    CHECK(!moc::write_moc(d, 5, out, diags));
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    CHECK(ms < 1000);
  }
  // WAV: 0 bits per sample is a format error; motion-sync rates outside 1–768 kHz are refused.
  {
    const std::string wav = test::wav_file({std::vector<float>(10, 0.25f)}, 16000, test::WavEncoding::Pcm16);
    std::string zero = wav;
    zero[34] = zero[35] = 0;
    framework::WavSound sound;
    String why;
    CHECK(!framework::decode_wav(reinterpret_cast<const uint8_t*>(zero.data()), zero.size(), sound, why));
    CHECK(why == "0 bits per sample");
    for (uint32_t rate : {999u, 2143289344u}) {
      std::string odd = wav;
      for (int b = 0; b < 4; b++) odd[24 + b] = static_cast<char>((rate >> (8 * b)) & 255);
      framework::MotionSyncSound ms;
      CHECK(!framework::decode_motion_sync_wav(reinterpret_cast<const uint8_t*>(odd.data()), odd.size(), ms, why));
      CHECK(why.find("is outside 1000–768000 Hz") != String::npos);
    }
    for (uint32_t rate : {8000u, 768000u}) {
      const std::string ok = test::wav_file({std::vector<float>(10, 0.25f)}, rate, test::WavEncoding::Pcm16);
      framework::MotionSyncSound ms;
      CHECK(framework::decode_motion_sync_wav(reinterpret_cast<const uint8_t*>(ok.data()), ok.size(), ms, why));
      CHECK_EQ(ms.sample_rate, static_cast<double>(rate));
    }
  }
}

TEST(evaluation_switches_0_21_0) {
  // Mochi2D 0.21.0's evaluation switches (test/evaluation-switches.test.ts), on the
  // fixtures of tests/crosscheck/switches.ts: its model (two meshes glued, blend
  // shapes on a mesh, the glue and the part) and the same model without its glue,
  // its blend shapes or both, with Mochi2D's outputs at the test's poses.
  g_test = "evaluation_switches_0_21_0";
  const auto file = [](const char* name) {
    std::ifstream in(std::string(MOCHI2D_FIXTURES "/switches/") + name, std::ios::binary);
    return Vector<uint8_t>((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  };
  const auto text = file("expected.json");
  json::Value expected;
  json::ParseError perr;
  CHECK(json::parse(std::string_view(reinterpret_cast<const char*>(text.data()), text.size()), expected, perr));
  const auto full = loaded(file("full.moc3"));
  CHECK(full != nullptr);
  if (!full || !expected.get("cases")) return;
  const auto& poses = expected.get("poses")->items();
  const auto floats = [](const json::Value& v) {
    Vector<float> out;
    for (const auto& x : v.items()) out.push_back(static_cast<float>(x.as_number()));
    return out;
  };
  const auto same_bits = [](const Vector<float>& a, const Vector<float>& b) {
    return a.size() == b.size() && (a.empty() || std::memcmp(a.data(), b.data(), a.size() * 4) == 0);
  };
  // Against the JSON, which writes −0 as 0 (the values are finite): equal values.
  const auto same_values = [](const Vector<float>& a, const Vector<float>& b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); i++)
      if (!(a[i] == b[i])) return false;
    return true;
  };
  // The outputs Mochi2D's test compares, at every pose, from one instance evaluated incrementally.
  struct Out {
    Vector<Vector<float>> vertices;
    Vector<float> opacity, multiply, screen;
    Vector<int32_t> draw_order, render_order, part_draw_order;
  };
  const auto run = [&](std::shared_ptr<const moc::Model> m, eval::InstanceOptions o) {
    Vector<Out> outs;
    eval::Instance inst(std::move(m), o);
    for (const auto& p : poses) {
      inst.set_parameter(0, p.items()[0].as_number());
      inst.set_parameter(1, p.items()[1].as_number());
      inst.evaluate();
      outs.push_back({inst.drawable_vertices, inst.drawable_opacity, inst.drawable_multiply, inst.drawable_screen,
                      inst.drawable_draw_order, inst.drawable_render_order, inst.part_draw_order});
    }
    return outs;
  };
  const auto equal = [&](const Vector<Out>& a, const Vector<Out>& b, bool bits = true) {
    const auto same = [&](const Vector<float>& x, const Vector<float>& y) {
      return bits ? same_bits(x, y) : same_values(x, y);
    };
    if (a.size() != b.size()) return false;
    for (std::size_t k = 0; k < a.size(); k++) {
      if (a[k].vertices.size() != b[k].vertices.size()) return false;
      for (std::size_t d = 0; d < a[k].vertices.size(); d++)
        if (!same(a[k].vertices[d], b[k].vertices[d])) return false;
      if (!same(a[k].opacity, b[k].opacity) || !same(a[k].multiply, b[k].multiply) ||
          !same(a[k].screen, b[k].screen) || a[k].draw_order != b[k].draw_order ||
          a[k].render_order != b[k].render_order || a[k].part_draw_order != b[k].part_draw_order)
        return false;
    }
    return true;
  };
  const auto defaults = run(full, eval::InstanceOptions());
  int cases = 0;
  for (const auto& entry : expected.get("cases")->members()) {
    const json::Value& c = entry.second;
    eval::InstanceOptions o;
    o.glue = c.get("glue")->as_bool();
    o.blend_shapes = c.get("blendShapes")->as_bool();
    for (const bool incremental : {true, false}) {
      o.incremental = incremental;
      const auto ours = run(full, o);
      // Mochi2D's outputs (the same values; the JSON keeps no −0).
      Vector<Out> theirs;
      for (const auto& e : c.get("outputs")->items()) {
        Out x;
        for (const auto& v : e.get("vertices")->items()) x.vertices.push_back(floats(v));
        x.opacity = floats(*e.get("opacity"));
        x.multiply = floats(*e.get("multiply"));
        x.screen = floats(*e.get("screen"));
        for (const auto& v : e.get("drawOrder")->items()) x.draw_order.push_back(static_cast<int32_t>(v.as_number()));
        for (const auto& v : e.get("renderOrder")->items()) x.render_order.push_back(static_cast<int32_t>(v.as_number()));
        for (const auto& v : e.get("partDrawOrder")->items())
          x.part_draw_order.push_back(static_cast<int32_t>(v.as_number()));
        theirs.push_back(std::move(x));
      }
      CHECK(equal(ours, theirs, false));
      // The model without the switched-off features evaluates the same.
      CHECK(equal(ours, run(loaded(file(c.get("same_as")->as_string().c_str())), eval::InstanceOptions())));
      // Left on, the defaults; a switch off, something else (the model uses both).
      CHECK_EQ(equal(ours, defaults), o.glue && o.blend_shapes);
    }
    cases++;
  }
  CHECK_EQ(cases, 4);
  // The C API passes the options to the instance; NULL and the defaults are m2d_instance_create's.
  {
    const auto bytes = file("full.moc3");
    m2d_error err;
    m2d_model* model = nullptr;
    CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
    m2d_instance_options o;
    o.glue = o.blend_shapes = o.incremental = 7;
    m2d_instance_options_default(&o);
    CHECK(o.incremental == 1 && o.glue == 1 && o.blend_shapes == 1);
    const auto vertices = [&](const m2d_instance_options* opt) {
      m2d_instance* inst = nullptr;
      Vector<float> v;
      if (m2d_instance_create_with_options(model, opt, &inst, &err) != M2D_OK) return v;
      m2d_instance_set_parameter(inst, 1, 1.0f);
      m2d_instance_evaluate(inst, &err);
      for (int d = 0; d < 2; d++) {
        const float* p = m2d_instance_drawable_vertices(inst, d);
        v.insert(v.end(), p, p + 6);
      }
      m2d_instance_destroy(inst);
      return v;
    };
    m2d_instance* plain = nullptr;
    CHECK_EQ(m2d_instance_create(model, &plain, &err), M2D_OK);
    m2d_instance_set_parameter(plain, 1, 1.0f);
    m2d_instance_evaluate(plain, &err);
    Vector<float> created;
    for (int d = 0; d < 2; d++) {
      const float* p = m2d_instance_drawable_vertices(plain, d);
      created.insert(created.end(), p, p + 6);
    }
    m2d_instance_destroy(plain);
    CHECK(same_bits(vertices(nullptr), created));
    CHECK(same_bits(vertices(&o), created));
    o.glue = o.blend_shapes = 0;
    const auto off = vertices(&o);
    CHECK(off.size() == 12 && !same_bits(off, created));
    // As the model without either.
    eval::Instance neither(loaded(file("neither.moc3")));
    neither.set_parameter(1, 1.0);
    neither.evaluate();
    Vector<float> want = neither.drawable_vertices[0];
    want.insert(want.end(), neither.drawable_vertices[1].begin(), neither.drawable_vertices[1].end());
    CHECK(same_bits(off, want));
    m2d_model_destroy(model);
  }
}

TEST(motion_sync_defaults_0_20_0) {
  // Mochi2D 0.20.0: the motion-sync file's per-parameter Smooth is off by default (fileSmoothing false).
  g_test = "motion_sync_defaults_0_20_0";
  m2d_motion_sync_options o;
  o.file_smoothing = 7;
  m2d_motion_sync_options_default(&o);
  CHECK_EQ(o.file_smoothing, 0);
  CHECK(!framework::MotionSyncOptions().file_smoothing);
}

TEST(render_rules_0_18_0) {
  // Mochi2D 0.18.0's render rules on the CPU side (docs/rendering.md), with the vectors of
  // test/render-rules.test.ts.
  g_test = "render_rules_0_18_0";
  using render::Mat4;
  const auto bits = [](float x) {
    uint32_t b;
    std::memcpy(&b, &x, 4);
    return b;
  };
  const auto f32 = [](double x) { return static_cast<float>(x); };
  // Rule V: 0.1 moves three units in the last place; values that survive the flips stay.
  CHECK_EQ(bits(0.1f), 0x3dcccccdu);
  CHECK_EQ(bits(f32(1 - static_cast<double>(0.1f))), 0x3f666666u);
  CHECK_EQ(bits(render::sampled_v(0.1f)), 0x3dccccd0u);
  for (float v : {0.0f, 0.25f, 0.5f, 0.75f, 1.0f}) CHECK_EQ(render::sampled_v(v), v);
  CHECK_EQ(render::sampled_v(0.9f), 0.9f);
  {
    const float uv[4] = {0.1f, 0.1f, 0.3f, 0.9f};
    Vector<float> s;
    render::sampled_uvs(uv, 4, s);
    CHECK(s.size() == 4 && s[0] == 0.1f && s[1] == render::sampled_v(0.1f) && s[2] == 0.3f && s[3] == 0.9f);
  }
  // Rule M: each addition rounded to float32 (1 + 1e-8 is 1 in float32, not in double).
  {
    Mat4 a{}, b{};
    a[0] = 1;
    a[1] = f32(1e-8);
    b[0] = 1;
    b[4] = 1;
    CHECK_EQ(render::multiply_f32(a, b)[0], 1.0f);
  }
  // Both matrices against each entry written out from the composition order.
  struct Case {
    double b[2], s[2], l[2];
  };
  const Case cases[] = {{{-0.123456, 0.654321}, {3749.0 / 4096, 3749.0 / 4096}, {0, 0}},
                        {{0.1, -0.7}, {1 / (1.1 * 0.37), 1 / (1.1 * 2.9)}, {0, 0}},
                        {{-0.3, 0.2}, {512.0 / 2048, 512.0 / 2048}, {18.0 / 2048, 530.0 / 2048}}};
  const auto same = [&](const Mat4& x, const Mat4& y) {
    for (std::size_t i = 0; i < 16; i++)
      if (!(x[i] == y[i])) return false;
    return true;
  };
  for (const Case& c : cases) {
    render::MaskMapping map;
    map.ox = c.b[0];
    map.oy = c.b[1];
    map.sx = c.s[0];
    map.sy = c.s[1];
    map.lx = c.l[0];
    map.ly = c.l[1];
    const auto m = render::mask_matrices(map);
    const double bx = f32(c.b[0]), by = f32(c.b[1]), sx = f32(c.s[0]), sy = f32(c.s[1]), lx = f32(c.l[0]),
                 ly = f32(c.l[1]);
    const float tx = f32(lx + f32(sx * -bx)), ty = f32(ly + f32(sy * -by));
    const float cx = f32(f32(2 * lx - 1) + f32(2 * sx * -bx)), cy = f32(f32(2 * ly - 1) + f32(2 * sy * -by));
    const Mat4 texture{f32(sx), 0, 0, tx, 0, f32(sy), 0, ty, 0, 0, 1, 0, 0, 0, 0, 1};
    const Mat4 clip{f32(2 * sx), 0, 0, cx, 0, f32(2 * sy), 0, cy, 0, 0, 1, 0, 0, 0, 0, 1};
    CHECK(same(m.texture, texture));
    CHECK(same(m.clip, clip));
    const Mat4 gl = render::column_major(m.texture);
    CHECK(gl[0] == texture[0] && gl[5] == texture[5] && gl[12] == texture[3] && gl[13] == texture[7]);
  }
  // Rule I: V⁻¹ in double, stored as float32; the numeric vector of docs/rendering.md (a 512 × 512
  // view at (0.08, −0.5), 1,500 pixels per unit, and q2d-leg-pose's offscreen mask A).
  const auto entries = [&](const Mat4& m) { return std::array<uint32_t, 4>{bits(m[0]), bits(m[5]), bits(m[3]), bits(m[7])}; };
  render::Framing fr;
  fr.width = fr.height = 512;
  fr.k = 1500;
  fr.center_x = 0.08;
  fr.center_y = -0.5;
  const double vsx = 2 * fr.k / fr.width, vsy = 2 * fr.k / fr.height;
  const Mat4 v = render::view_matrix({vsx, vsy, -fr.center_x * vsx, -fr.center_y * vsy});
  CHECK((entries(v) == std::array<uint32_t, 4>{0x40bb8000u, 0x40bb8000u, 0xbef00000u, 0x403b8000u}));
  const Mat4 inv = render::inverse_view(v);
  CHECK((entries(inv) == std::array<uint32_t, 4>{0x3e2ec33eu, 0x3e2ec33eu, 0x3da3d70au, 0xbf000000u}));
  Mat4 a = render::identity4();
  const auto from_bits = [](uint32_t b) {
    float x;
    std::memcpy(&x, &b, 4);
    return x;
  };
  a[0] = from_bits(0x40b877b1u);
  a[5] = from_bits(0x3f53da2eu);
  a[3] = from_bits(0xbc39a3e4u);
  a[7] = from_bits(0x3f507c75u);
  const Mat4 d = render::multiply_f32(a, inv);
  CHECK((entries(d) == std::array<uint32_t, 4>{0x3f7bdc14u, 0x3e109fdeu, 0x3ee65134u, 0x3ecd1ebcu}));
  CHECK_EQ(d[3], f32(static_cast<double>(f32(static_cast<double>(a[0]) * inv[3])) + a[3]));
  CHECK(d[3] - 0.449838272605 > 0);
  // A from a mapping, then D through layer_mask_matrix, as the plan builds it.
  {
    render::MaskMapping map;
    map.ox = 0.25;
    map.oy = -0.75;
    map.sx = 1 / (1.1 * 0.4);
    map.sy = 1 / (1.1 * 1.3);
    CHECK(same(render::layer_mask_matrix(map, v), render::multiply_f32(render::mask_matrices(map).texture, inv)));
  }
  // With a rotation, V⁻¹·V is the identity to float32 precision.
  {
    const Mat4 turned = render::view_matrix({0.01, 0.02, 0.3, -0.4}, {std::cos(0.5), 0.6, 0.4});
    const Mat4 back = render::multiply_f32(render::inverse_view(turned), turned);
    const std::pair<int, double> want[] = {{0, 1}, {1, 0}, {3, 0}, {4, 0}, {5, 1}, {7, 0}};
    for (const auto& w : want) CHECK(std::fabs(back[static_cast<std::size_t>(w.first)] - w.second) < 5e-7);
  }
}

TEST(expression_fades_per_call) {
  // Mochi2D 0.13.0's fade times per call: a call's time gives the frames of a file with that
  // time, bit for bit; NaN keeps the file's; an added layer keeps the fade-out it was given.
  g_test = "expression_fades_per_call";
  const auto bytes = written(tiny_model(5, true), 5);
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  const auto parse = [&](const char* text, const char* label) {
    m2d_expression* ex = nullptr;
    CHECK_EQ(m2d_expression_parse(text, std::strlen(text), label, nullptr, &ex, &err), M2D_OK);
    return ex;
  };
  m2d_expression* slow = parse(R"({"FadeInTime":2,"FadeOutTime":3,"Parameters":[{"Id":"ParamX","Value":0.4,"Blend":"Add"}]})", "e");
  m2d_expression* quick = parse(R"({"FadeInTime":0.25,"FadeOutTime":0.75,"Parameters":[{"Id":"ParamX","Value":0.4,"Blend":"Add"}]})", "e");
  // What ParamX does over 40 frames: `start` at frame 0, `stop` at frame 20.
  const auto trace = [&](const std::function<void(m2d_animator*)>& start, const std::function<void(m2d_animator*)>& stop) {
    m2d_animator* anim = nullptr;
    CHECK_EQ(m2d_animator_create(model, nullptr, nullptr, nullptr, nullptr, &anim, &err), M2D_OK);
    m2d_animator_set_effect(anim, M2D_EFFECT_BREATH, 0);
    m2d_animator_set_effect(anim, M2D_EFFECT_LOOK, 0);
    start(anim);
    m2d_frame frame;
    std::vector<double> out;
    for (int k = 0; k < 40; k++) {
      if (k == 20) stop(anim);
      CHECK_EQ(m2d_animator_frame(anim, 1.0 / 30, &frame, &err), M2D_OK);
      out.push_back(m2d_animator_parameter(anim, "ParamX"));
    }
    m2d_animator_destroy(anim);
    return out;
  };
  const auto nothing = [](m2d_animator*) {};
  // The queue: start with the quick times, and clear with the quick fade-out.
  const auto file = trace([&](m2d_animator* a) { m2d_animator_start_expression(a, quick); },
                          [&](m2d_animator* a) { CHECK_EQ(m2d_animator_clear_expression(a, NAN), M2D_OK); });
  const auto call = trace([&](m2d_animator* a) { CHECK_EQ(m2d_animator_start_expression_fades(a, slow, 0.25, 0.75), M2D_OK); },
                          [&](m2d_animator* a) { CHECK_EQ(m2d_animator_clear_expression(a, 0.75), M2D_OK); });
  CHECK(file == call);
  const auto own = trace([&](m2d_animator* a) { m2d_animator_start_expression_fades(a, slow, NAN, NAN); }, nothing);
  const auto plain = trace([&](m2d_animator* a) { m2d_animator_start_expression(a, slow); }, nothing);
  CHECK(own == plain);
  CHECK(own != file);
  // Layers: the fade-out given when adding is the one removal uses, unless removal gives one.
  const auto layer_file = trace([&](m2d_animator* a) { CHECK_EQ(m2d_animator_add_expression_layer(a, quick), 1); },
                                [&](m2d_animator* a) { CHECK_EQ(m2d_animator_remove_expression_layers(a, "e"), 1); });
  const auto layer_add = trace([&](m2d_animator* a) { CHECK_EQ(m2d_animator_add_expression_layer_fades(a, slow, 0.25, 0.75), 1); },
                               [&](m2d_animator* a) { CHECK_EQ(m2d_animator_remove_expression_layers(a, "e"), 1); });
  const auto layer_remove = trace([&](m2d_animator* a) { CHECK_EQ(m2d_animator_add_expression_layer_fades(a, slow, 0.25, NAN), 1); },
                                  [&](m2d_animator* a) { CHECK_EQ(m2d_animator_remove_expression_layers_fade(a, "e", 0.75), 1); });
  CHECK(layer_file == layer_add);
  CHECK(layer_file == layer_remove);
  // Bad times are refused.
  m2d_animator* anim = nullptr;
  CHECK_EQ(m2d_animator_create(model, nullptr, nullptr, nullptr, nullptr, &anim, &err), M2D_OK);
  CHECK_EQ(m2d_animator_start_expression_fades(anim, slow, -1, NAN), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_start_expression_fades(anim, slow, INFINITY, NAN), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_add_expression_layer_fades(anim, slow, NAN, -0.5), -1);
  CHECK_EQ(m2d_animator_clear_expression(anim, -1), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_clear_expression(anim, NAN), M2D_OK);  // an empty queue: nothing to clear
  m2d_animator_destroy(anim);
  m2d_expression_destroy(slow);
  m2d_expression_destroy(quick);
  m2d_model_destroy(model);
}

TEST(offscreen_keyform_range) {
  // 0.10.0: a part keyform's offscreen keyform entry must be −1 or an
  // offscreen keyform; M2D_LOAD_OFFSCREEN_KEYFORM_RANGE reads one out of range
  // as −1, with a warning. A committed version-6 fixture, its first entry
  // patched to 99 (the model has 3 offscreen keyforms at most).
  g_test = "offscreen_keyform_range";
  std::ifstream in(MOCHI2D_FIXTURES "/models/synth005-v6/synth005-v6.moc3", std::ios::binary);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  CHECK(bytes.size() > 0x40 && bytes[5] == 0);
  if (bytes.size() <= 0x40) return;
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);  // its owner keyform −1 loads
  m2d_model_destroy(model);
  const int slot = moc::spec(moc::F::partKeyform_offscreenKeyform).slot;
  uint32_t offset = 0;
  std::memcpy(&offset, &bytes[0x40 + 4 * static_cast<std::size_t>(slot)], 4);
  CHECK(offset + 4 <= bytes.size());
  if (offset + 4 > bytes.size()) return;
  const int32_t bad = 99;
  std::memcpy(&bytes[offset], &bad, 4);
  model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_FORMAT_ERROR);
  CHECK(model == nullptr);
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), M2D_LOAD_OFFSCREEN_KEYFORM_RANGE, nullptr, &model, &err), M2D_OK);
  bool warned = false;
  for (int32_t i = 0; i < m2d_model_warning_count(model); i++)
    warned = warned || std::string(m2d_model_warning(model, i)).find("offscreen keyform 99 is not") != std::string::npos;
  CHECK(warned);
  m2d_model_destroy(model);
  // The validator refuses it at both levels.
  int32_t valid = 1;
  char* report = nullptr;
  CHECK_EQ(m2d_validate_moc(bytes.data(), bytes.size(), M2D_LEVEL_OFFICIAL, nullptr, &valid, &report, &err), M2D_OK);
  CHECK_EQ(valid, 0);
  m2d_free_string(report);
}

TEST(physics_state_and_rate) {
  g_test = "physics_state_and_rate";
  const auto bytes = written(tiny_model(5, true), 5);
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  const char* physics = R"({"Version":3,"Meta":{"PhysicsSettingCount":1,"TotalInputCount":1,"TotalOutputCount":1,
    "VertexCount":2,"Fps":30,"PhysicsDictionary":[{"Id":"S","Name":"Hair"}]},
    "PhysicsSettings":[{"Id":"S","Input":[{"Source":{"Id":"ParamX"},"Weight":100,"Type":"X","Reflect":false}],
      "Output":[{"Destination":{"Id":"ParamX"},"VertexIndex":1,"Scale":0.1,"Weight":50,"Type":"Angle","Reflect":false}],
      "Vertices":[{"Position":{"X":0,"Y":0},"Mobility":1,"Delay":1,"Acceleration":1,"Radius":0},
                  {"Position":{"X":0,"Y":3},"Mobility":0.9,"Delay":0.8,"Acceleration":1.5,"Radius":3}],
      "Normalization":{"Position":{"Minimum":-10,"Default":0,"Maximum":10},"Angle":{"Minimum":-10,"Default":0,"Maximum":10}}}]})";
  m2d_physics* ph = nullptr;
  CHECK_EQ(m2d_physics_parse(physics, std::strlen(physics), "p.physics3.json", nullptr, &ph, &err), M2D_OK);
  m2d_animator* anim = nullptr;
  CHECK_EQ(m2d_animator_create(model, nullptr, ph, nullptr, nullptr, &anim, &err), M2D_OK);
  m2d_animator_set_effect(anim, M2D_EFFECT_BREATH, 0);
  m2d_animator_set_effect(anim, M2D_EFFECT_LOOK, 0);
  m2d_frame frame;
  // Frames of uneven lengths, so the step accumulator and the interpolation matter.
  auto run = [&](int from, int count, std::vector<double>& out) {
    for (int k = from; k < from + count; k++) {
      CHECK_EQ(m2d_animator_set_parameter(anim, "ParamX", 0.6), M2D_OK);
      CHECK_EQ(m2d_animator_frame(anim, (k % 3 + 1) / 70.0, &frame, &err), M2D_OK);
      out.push_back(m2d_animator_parameter(anim, "ParamX"));
    }
  };
  std::vector<double> warmup, first, second;
  run(0, 10, warmup);
  const size_t size = m2d_animator_physics_state_size(anim);
  CHECK(size > 16);
  std::vector<uint8_t> state(size);
  size_t written_size = 0;
  CHECK_EQ(m2d_animator_save_physics_state(anim, state.data(), size - 1, &written_size), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_save_physics_state(anim, state.data(), size, &written_size), M2D_OK);
  CHECK_EQ(written_size, size);
  run(10, 15, first);
  CHECK_EQ(m2d_animator_restore_physics_state(anim, state.data(), size, &err), M2D_OK);
  run(10, 15, second);
  CHECK(std::memcmp(first.data(), second.data(), first.size() * sizeof(double)) == 0);  // bit for bit
  // Without the restore the same frames give other values: the state matters.
  std::vector<double> third;
  run(10, 15, third);
  CHECK(std::memcmp(first.data(), third.data(), first.size() * sizeof(double)) != 0);
  // Bytes of another shape, or broken ones, are refused and change nothing.
  CHECK_EQ(m2d_animator_restore_physics_state(anim, state.data(), size - 8, &err), M2D_INVALID_ARGUMENT);
  CHECK(std::strcmp(err.code, "physics-state") == 0);
  state[0] = 'X';
  CHECK_EQ(m2d_animator_restore_physics_state(anim, state.data(), size, &err), M2D_INVALID_ARGUMENT);
  // The rate: the file's Fps unless set (0: once per frame), from 0 to 1000.
  CHECK_EQ(m2d_animator_physics_rate(anim), 30.0);
  CHECK_EQ(m2d_animator_set_physics_rate(anim, 1001), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_set_physics_rate(anim, std::nan("")), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_animator_set_physics_rate(anim, 120), M2D_OK);
  CHECK_EQ(m2d_animator_physics_rate(anim), 120.0);
  m2d_animator_reset_physics_rate(anim);
  CHECK_EQ(m2d_animator_physics_rate(anim), 30.0);
  // A different rate moves the pendulum differently, from the same state.
  CHECK_EQ(m2d_animator_restore_physics_state(anim, first.empty() ? nullptr : state.data(), 0, &err), M2D_INVALID_ARGUMENT);
  m2d_animator_destroy(anim);
  CHECK_EQ(m2d_animator_create(model, nullptr, ph, nullptr, nullptr, &anim, &err), M2D_OK);
  m2d_animator_set_effect(anim, M2D_EFFECT_BREATH, 0);
  m2d_animator_set_effect(anim, M2D_EFFECT_LOOK, 0);
  CHECK_EQ(m2d_animator_set_physics_rate(anim, 120), M2D_OK);
  std::vector<double> fast;
  run(0, 10, fast);
  CHECK(fast.back() != warmup.back());
  m2d_animator_destroy(anim);
  // Without physics: no state, no restore.
  CHECK_EQ(m2d_animator_create(model, nullptr, nullptr, nullptr, nullptr, &anim, &err), M2D_OK);
  CHECK_EQ(m2d_animator_physics_state_size(anim), 0u);
  CHECK_EQ(m2d_animator_physics_rate(anim), 0.0);
  CHECK_EQ(m2d_animator_restore_physics_state(anim, state.data(), size, &err), M2D_INVALID_ARGUMENT);
  CHECK(std::strcmp(err.code, "no-physics") == 0);
  m2d_animator_destroy(anim);
  m2d_physics_destroy(ph);
  m2d_model_destroy(model);
}

TEST(physics_pose_expressions) {
  const auto bytes = written(tiny_model(5, true), 5);
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  const char* physics = R"({"Version":3,"Meta":{"PhysicsSettingCount":1,"TotalInputCount":1,"TotalOutputCount":1,
    "VertexCount":2,"Fps":30,"PhysicsDictionary":[{"Id":"S","Name":"Hair"}]},
    "PhysicsSettings":[{"Id":"S","Input":[{"Source":{"Id":"ParamX"},"Weight":100,"Type":"X","Reflect":false}],
      "Output":[{"Destination":{"Id":"ParamX"},"VertexIndex":1,"Scale":0.1,"Weight":50,"Type":"Angle","Reflect":false}],
      "Vertices":[{"Position":{"X":0,"Y":0},"Mobility":1,"Delay":1,"Acceleration":1,"Radius":0},
                  {"Position":{"X":0,"Y":3},"Mobility":0.9,"Delay":0.8,"Acceleration":1.5,"Radius":3}],
      "Normalization":{"Position":{"Minimum":-10,"Default":0,"Maximum":10},"Angle":{"Minimum":-10,"Default":0,"Maximum":10}}}]})";
  m2d_physics* ph = nullptr;
  CHECK_EQ(m2d_physics_parse(physics, std::strlen(physics), "p.physics3.json", nullptr, &ph, &err), M2D_OK);
  CHECK_EQ(std::string(m2d_physics_setting_name(ph, 0)), "Hair");
  const char* bad = R"({"Meta":{"PhysicsSettingCount":2},"PhysicsSettings":[]})";
  m2d_physics* none = nullptr;
  CHECK_EQ(m2d_physics_parse(bad, std::strlen(bad), "p", nullptr, &none, &err), M2D_FILE_ERROR);
  CHECK_EQ(std::string(err.message), "p: Meta.PhysicsSettingCount is 2, but the file has 0");
  const char* pose = R"({"FadeInTime":-1,"Groups":[[{"Id":"Root"},{"Id":"Other","Link":["L"]}]]})";
  m2d_pose* po = nullptr;
  CHECK_EQ(m2d_pose_parse(pose, std::strlen(pose), "p.pose3.json", nullptr, &po, &err), M2D_OK);
  CHECK_EQ(m2d_pose_fade(po), 0.5);
  const char* expr = R"({"FadeInTime":0,"Parameters":[{"Id":"ParamX","Value":0.5,"Blend":"Add"},{"Id":"ParamX","Value":9}]})";
  m2d_expression* ex = nullptr;
  CHECK_EQ(m2d_expression_parse(expr, std::strlen(expr), "smile", nullptr, &ex, &err), M2D_OK);
  CHECK_EQ(m2d_expression_parameter_count(ex), 2);
  m2d_animator* anim = nullptr;
  CHECK_EQ(m2d_animator_create(model, nullptr, ph, po, nullptr, &anim, &err), M2D_OK);
  m2d_physics_destroy(ph);  // the animator keeps both
  m2d_pose_destroy(po);
  CHECK_EQ(m2d_animator_has_effect(anim, M2D_EFFECT_PHYSICS), 1);
  CHECK_EQ(m2d_animator_has_effect(anim, M2D_EFFECT_POSE), 1);
  m2d_animator_set_effect(anim, M2D_EFFECT_BREATH, 0);
  m2d_animator_set_effect(anim, M2D_EFFECT_LOOK, 0);
  m2d_animator_set_effect(anim, M2D_EFFECT_PHYSICS, 0);
  CHECK_EQ(m2d_animator_start_expression(anim, ex), M2D_OK);
  m2d_frame frame;
  CHECK_EQ(m2d_animator_frame(anim, 1.0 / 30, &frame, &err), M2D_OK);
  CHECK_EQ(m2d_animator_parameter(anim, "ParamX"), 0.5);  // the first entry of an ID counts
  CHECK_EQ(m2d_animator_part_opacity(anim, "Root"), 1.0);
  CHECK_EQ(m2d_animator_part_opacity(anim, "L"), 0.0);  // a free part entry, linked to "Other"
  CHECK_EQ(m2d_animator_add_expression_layer(anim, ex), 1);
  CHECK_EQ(m2d_animator_add_expression_layer(anim, ex), 0);  // the same label is active
  CHECK_EQ(m2d_animator_remove_expression_layers(anim, "smile"), 1);
  m2d_animator_set_effect(anim, M2D_EFFECT_PHYSICS, 1);
  m2d_animator_set_parameter(anim, "ParamX", 1);
  for (int k = 0; k < 10; k++) CHECK_EQ(m2d_animator_frame(anim, 1.0 / 60, &frame, &err), M2D_OK);
  CHECK(m2d_animator_parameter(anim, "ParamX") >= 0 && m2d_animator_parameter(anim, "ParamX") <= 1);
  m2d_expression_destroy(ex);
  m2d_animator_destroy(anim);
  // Display labels without display info: the IDs in model order.
  int32_t index = -1;
  const char* label = nullptr;
  const char* group = "x";
  CHECK_EQ(m2d_display_label(nullptr, model, M2D_DISPLAY_PARAMETERS, 0, &index, &label, &group), M2D_OK);
  CHECK_EQ(index, 0);
  CHECK_EQ(std::string(label), "ParamX");
  CHECK(group == nullptr);
  const char* cdi = R"({"Parameters":[{"Id":"ParamX","GroupId":"G","Name":"Head X"}],"ParameterGroups":[{"Id":"G","Name":"Head"}],"Parts":[]})";
  m2d_display_info* info = nullptr;
  CHECK_EQ(m2d_display_info_parse(cdi, std::strlen(cdi), "m.cdi3.json", nullptr, &info, &err), M2D_OK);
  CHECK_EQ(m2d_display_label(info, model, M2D_DISPLAY_PARAMETERS, 0, &index, &label, &group), M2D_OK);
  CHECK_EQ(std::string(label), "Head X");
  CHECK_EQ(std::string(group), "Head");
  m2d_display_info_destroy(info);
  const char* ud = R"({"Meta":{"UserDataCount":1},"UserData":[{"Target":"ArtMesh","Id":"Mesh","Value":"v"},{"Target":"x"}]})";
  m2d_user_data* data = nullptr;
  CHECK_EQ(m2d_user_data_parse(ud, std::strlen(ud), "u.userdata3.json", nullptr, &data, &err), M2D_OK);
  CHECK_EQ(m2d_user_data_count(data), 1);
  CHECK_EQ(std::string(m2d_user_data_value(data, 0)), "v");
  m2d_user_data_destroy(data);
  m2d_model_destroy(model);
}

TEST(renderer) {
  g_test = "renderer";
  // Exact preparation (§2b): premultiplication and the 2×2 means with ties to even.
  CHECK_EQ(render::premultiply_byte(255, 128), 128);
  CHECK_EQ(render::premultiply_byte(100, 51), 20);
  CHECK_EQ(render::premultiply_byte(7, 0), 0);
  CHECK_EQ(render::mip_average(1, 2, 1, 2), 2);  // 1.5: to the even 2
  CHECK_EQ(render::mip_average(0, 0, 1, 1), 0);  // 0.5: to the even 0
  CHECK_EQ(render::mip_average(0, 1, 1, 1), 1);  // 0.75
  {
    Vector<uint8_t> px(4 * 4 * 4, 255);
    render::Texture t;
    render::prepare_texture(px.data(), 4, 4, t);
    CHECK_EQ(t.levels.size(), std::size_t{3});
    CHECK_EQ(t.levels[2].width, 1);
    CHECK_EQ(t.levels[2].rgba[3], 255);
    // A non-power-of-two size gets a full chain too (5 × 3: 5×3, 2×1, 1×1).
    Vector<uint8_t> np(5 * 3 * 4, 255);
    render::prepare_texture(np.data(), 5, 3, t);
    CHECK_EQ(t.levels.size(), std::size_t{3});
    CHECK_EQ(t.levels[1].width, 2);
    CHECK_EQ(t.levels[1].height, 1);
  }
  auto white = [] {
    Vector<uint8_t> px(2 * 2 * 4, 255);
    auto t = std::allocate_shared<render::Texture>(Allocator<render::Texture>());
    render::prepare_texture(px.data(), 2, 2, *t);
    Vector<std::shared_ptr<const render::Texture>> v;
    v.push_back(std::move(t));
    return v;
  };
  auto count_alpha = [](const render::Image& im, int a) {
    int n = 0;
    for (std::size_t i = 3; i < im.rgba.size(); i += 4) n += im.rgba[i] == a;
    return n;
  };
  for (int v : {3, 5}) {
    // Version 5 also gets the blend code 10 (screen) of a version-6 file, set in
    // memory (the writer refuses version 6): an advanced code, the layered pipeline.
    g_test = "renderer v" + std::to_string(v);
    auto file = loaded(written(tiny_model(v, false), v));
    if (!file) {
      CHECK(file != nullptr);
      continue;
    }
    std::shared_ptr<const moc::Model> model = file;
    if (v == 5) {
      auto m = std::allocate_shared<moc::Model>(Allocator<moc::Model>(), *file);
      m->meshes.blend_mode[0] = 10;
      model = m;
    }
    eval::Instance inst(model);
    render::Renderer r(model, white(), 1024);
    CHECK_EQ(r.layered(), v == 5);
    render::FrameOptions frame;
    frame.framing = render::frame_image(model->canvas, 64, 64);
    render::Image a, b;
    r.draw(inst, frame, a);
    r.draw(inst, frame, b);
    CHECK_EQ(a.width, 64);
    CHECK(a.rgba == b.rgba);  // deterministic
    CHECK_EQ(r.stats().drawn, 1u);
    // Opaque white where the triangle is (area ⅛ unit², k² pixels per unit²), transparent elsewhere.
    const int covered = count_alpha(a, 255);
    const double expected = 0.125 * frame.framing.k * frame.framing.k;
    CHECK(std::fabs(covered - expected) <= 0.1 * expected + 8);
    CHECK_EQ(covered + count_alpha(a, 0), 64 * 64);
    // The second keyform: opacity ½.
    inst.set_parameter(0, 1);
    inst.evaluate();
    r.draw(inst, frame, a);
    CHECK_EQ(count_alpha(a, 255), 0);
    CHECK(count_alpha(a, 128) > 0);
    // A tint's alpha multiplies the opacity, its RGB the color.
    const float tint[4] = {1, 0.5f, 1, 0.5f};
    frame.tints = tint;
    r.draw(inst, frame, a);
    CHECK(count_alpha(a, 64) > 0);
    // Green: the tint's ½, and from version 4 the keyform's multiply green ½ too.
    const int green = v >= 4 ? 16 : 32;
    int tinted = 0, other = 0;
    for (std::size_t i = 0; i < a.rgba.size(); i += 4)
      if (a.rgba[i + 3] == 64) (a.rgba[i] == 64 && a.rgba[i + 1] == green && a.rgba[i + 2] == 64 ? tinted : other)++;
    CHECK(tinted > 0);
    CHECK_EQ(other, 0);
    frame.tints = nullptr;
    // A view inside the triangle: every pixel covered (the triangle is clipped to the image).
    inst.set_parameter(0, 0);
    inst.evaluate();
    const auto& vx = inst.drawable_vertices[0];
    render::View view{(vx[0] + vx[2] + vx[4]) / 3.0, (vx[1] + vx[3] + vx[5]) / 3.0, 4000};
    frame.framing = render::frame_image(model->canvas, 32, 48, &view);
    r.draw(inst, frame, a);
    CHECK_EQ(a.height, 48);
    CHECK_EQ(count_alpha(a, 255), 32 * 48);
    // A background shows where nothing is drawn.
    frame.framing = render::frame_image(model->canvas, 16, 16);
    frame.background = {0, 0, 1, 0.5};
    r.draw(inst, frame, a);
    CHECK_EQ(a.rgba[0], 0);
    CHECK_EQ(a.rgba[2], 128);
    CHECK_EQ(a.rgba[3], 128);
  }
}

TEST(texture_update_in_place) {
  // Mochi2D 0.14.0's updateTexture: a region replaced, and each mip level recomputed only where
  // the region reaches, equals a fresh preparation of the new image, at every level, for sizes
  // of all kinds and regions anywhere (edges, single texels, the whole image).
  g_test = "texture_update_in_place";
  uint32_t seed = 12345;
  const auto rnd = [&](uint32_t n) {
    seed = seed * 1664525u + 1013904223u;
    return (seed >> 8) % n;
  };
  const int sizes[][2] = {{1, 1}, {1, 7}, {37, 20}, {64, 64}, {33, 65}, {128, 3}, {5, 200}};
  int cases = 0, mismatches = 0;
  for (const auto& wh : sizes) {
    const int W = wh[0], H = wh[1];
    std::vector<uint8_t> image(static_cast<std::size_t>(4 * W * H));
    for (auto& b : image) b = static_cast<uint8_t>(rnd(256));
    render::Texture t;
    render::prepare_texture(image.data(), W, H, t);
    for (int k = 0; k < 12; k++) {
      const int w = 1 + static_cast<int>(rnd(static_cast<uint32_t>(W)));
      const int h = 1 + static_cast<int>(rnd(static_cast<uint32_t>(H)));
      const int x = static_cast<int>(rnd(static_cast<uint32_t>(W - w + 1)));
      const int y = static_cast<int>(rnd(static_cast<uint32_t>(H - h + 1)));
      // The patch with a padded stride, written into the image too.
      const int stride = 4 * w + 8;
      std::vector<uint8_t> patch(static_cast<std::size_t>(stride * h), 0xEE);
      for (int j = 0; j < h; j++)
        for (int i = 0; i < 4 * w; i++) {
          const uint8_t b = static_cast<uint8_t>(rnd(256));
          patch[static_cast<std::size_t>(j * stride + i)] = b;
          image[static_cast<std::size_t>(((y + j) * W + x) * 4 + i)] = b;
        }
      Vector<render::TextureRegion> changed;
      CHECK(render::update_texture(t, patch.data(), w, h, stride, x, y, &changed));
      CHECK_EQ(changed.size(), t.levels.size());
      render::Texture fresh;
      render::prepare_texture(image.data(), W, H, fresh);
      cases++;
      bool same = fresh.levels.size() == t.levels.size();
      for (std::size_t l = 0; same && l < t.levels.size(); l++) same = fresh.levels[l].rgba == t.levels[l].rgba;
      if (!same) mismatches++;
    }
  }
  CHECK(cases > 0);
  CHECK_EQ(mismatches, 0);
  // Regions that do not fit change nothing.
  render::Texture t;
  std::vector<uint8_t> four(16, 200);
  render::prepare_texture(four.data(), 2, 2, t);
  const auto before = t.levels[0].rgba;
  CHECK(!render::update_texture(t, four.data(), 2, 2, 0, 1, 0));
  CHECK(!render::update_texture(t, four.data(), 3, 1, 0, 0, 0));
  CHECK(!render::update_texture(t, four.data(), 1, 1, 0, -1, 0));
  CHECK(t.levels[0].rgba == before);
}

TEST(renderer_update_texture_c_api) {
  // A renderer's texture updated in place draws as a renderer made with the new image, byte for
  // byte; the m2d_texture and other renderers keep the old pixels.
  g_test = "renderer_update_texture_c_api";
  const Vector<uint8_t> bytes = written(tiny_model(5, false), 5);
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  m2d_instance* inst = nullptr;
  CHECK_EQ(m2d_instance_create(model, &inst, &err), M2D_OK);
  CHECK_EQ(m2d_instance_evaluate(inst, &err), M2D_OK);
  const int W = 16, H = 12;
  std::vector<uint8_t> a(4 * W * H), b(4 * W * H);
  for (int i = 0; i < 4 * W * H; i++) {
    a[static_cast<std::size_t>(i)] = static_cast<uint8_t>((i * 37 + 11) & 255);
    b[static_cast<std::size_t>(i)] = static_cast<uint8_t>((i * 91 + 5) & 255);
  }
  // `mixed`: a with b's 5 × 4 block at (7, 3).
  std::vector<uint8_t> mixed = a;
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 20; i++)
      mixed[static_cast<std::size_t>(((3 + j) * W + 7) * 4 + i)] = b[static_cast<std::size_t>(((3 + j) * W + 7) * 4 + i)];
  std::vector<uint8_t> block(4 * 5 * 4);
  for (int j = 0; j < 4; j++)
    std::memcpy(&block[static_cast<std::size_t>(j * 20)], &b[static_cast<std::size_t>(((3 + j) * W + 7) * 4)], 20);
  const auto make = [&](const std::vector<uint8_t>& px) {
    m2d_texture* t = nullptr;
    CHECK_EQ(m2d_texture_create(px.data(), W, H, 0, nullptr, &t, &err), M2D_OK);
    return t;
  };
  m2d_texture* ta = make(a);
  m2d_texture* tb = make(b);
  m2d_texture* tm = make(mixed);
  const auto renderer = [&](m2d_texture* t) {
    m2d_renderer* r = nullptr;
    CHECK_EQ(m2d_renderer_create(model, &t, 1, nullptr, &r, &err), M2D_OK);
    return r;
  };
  m2d_renderer* updated = renderer(ta);
  m2d_renderer* other = renderer(ta);
  m2d_renderer* with_b = renderer(tb);
  m2d_renderer* with_mixed = renderer(tm);
  const auto draw = [&](m2d_renderer* r) {
    std::vector<uint8_t> px(4 * 96 * 80);
    CHECK_EQ(m2d_renderer_draw(r, inst, nullptr, 96, 80, px.data(), 0, &err), M2D_OK);
    return px;
  };
  const auto original = draw(other);
  CHECK(original != draw(with_b));
  CHECK_EQ(m2d_renderer_update_texture(updated, 0, block.data(), 5, 4, 0, 7, 3, &err), M2D_OK);
  CHECK(draw(updated) == draw(with_mixed));
  CHECK(draw(other) == original);  // the shared texture is not changed
  CHECK_EQ(m2d_renderer_update_texture(updated, 0, b.data(), W, H, 0, 0, 0, &err), M2D_OK);
  CHECK(draw(updated) == draw(with_b));
  CHECK_EQ(m2d_renderer_update_texture(updated, 0, block.data(), 5, 4, 0, 12, 0, &err), M2D_INVALID_ARGUMENT);
  CHECK(std::strcmp(err.code, "texture-region") == 0);
  CHECK_EQ(m2d_renderer_update_texture(updated, 1, block.data(), 5, 4, 0, 0, 0, &err), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_renderer_update_texture(updated, 0, block.data(), 5, 4, 8, 0, 0, &err), M2D_INVALID_ARGUMENT);
  for (m2d_renderer* r : {updated, other, with_b, with_mixed}) m2d_renderer_destroy(r);
  for (m2d_texture* t : {ta, tb, tm}) m2d_texture_destroy(t);
  m2d_instance_destroy(inst);
  m2d_model_destroy(model);
}

TEST(renderer_c_api) {
  g_test = "renderer_c_api";
  const Vector<uint8_t> bytes = written(tiny_model(5, false), 5);
  m2d_allocator a{counting::allocate, counting::deallocate, nullptr};
  counting::calls = 0;
  // 64 × 64 images into rows of 260 bytes: the padding stays untouched.
  std::vector<uint8_t> image(260 * 64, 7);
  std::vector<uint8_t> one(4 * 256 * 256), four(4 * 256 * 256);
  const std::size_t news = g_global_news;
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, &a, &model, &err), M2D_OK);
  // A 2 × 2 white texture, rows 12 bytes apart (4 bytes of padding each).
  uint8_t px[24];
  std::memset(px, 255, sizeof px);
  m2d_texture* tex = nullptr;
  CHECK_EQ(m2d_texture_create(px, 2, 2, 7, &a, &tex, &err), M2D_INVALID_ARGUMENT);  // stride below 4·width
  CHECK_EQ(m2d_texture_create(px, 40000, 1, 0, &a, &tex, &err), M2D_LIMIT_ERROR);
  CHECK(std::strcmp(err.code, "texture-too-large") == 0);
  {
    // Above 8192 a texture is made (GPU backends may take it); the reference renderer refuses it.
    Vector<uint8_t> wide(4 * 9000, 255);  // not the global operator new
    m2d_texture* big = nullptr;
    CHECK_EQ(m2d_texture_create(wide.data(), 9000, 1, 0, &a, &big, &err), M2D_OK);
    m2d_renderer* refused_big = nullptr;
    CHECK_EQ(m2d_renderer_create(model, &big, 1, nullptr, &refused_big, &err), M2D_LIMIT_ERROR);
    CHECK(std::strcmp(err.code, "texture-too-large") == 0);
    CHECK(refused_big == nullptr);
    m2d_texture_destroy(big);
  }
  CHECK_EQ(m2d_texture_create(px, 2, 2, 12, &a, &tex, &err), M2D_OK);
  CHECK_EQ(m2d_texture_width(tex), 2);
  m2d_renderer_options options;
  m2d_renderer_options_default(&options);
  CHECK_EQ(options.mask_size, 4096);
  CHECK_EQ(options.threads, 1);
  options.mask_size = 512;
  m2d_renderer* r = nullptr;
  CHECK_EQ(m2d_renderer_create(model, &tex, 1, &options, &r, &err), M2D_OK);
  // The same with three worker threads (four bands at once); negative counts are refused.
  m2d_renderer_options threaded = options;
  threaded.threads = 4;
  m2d_renderer* r4 = nullptr;
  CHECK_EQ(m2d_renderer_create(model, &tex, 1, &threaded, &r4, &err), M2D_OK);
  threaded.threads = -1;
  m2d_renderer* refused = nullptr;
  CHECK_EQ(m2d_renderer_create(model, &tex, 1, &threaded, &refused, &err), M2D_INVALID_ARGUMENT);
  CHECK(refused == nullptr);
  m2d_texture_destroy(tex);  // the renderers keep it
  m2d_instance* inst = nullptr;
  CHECK_EQ(m2d_instance_create(model, &inst, &err), M2D_OK);
  CHECK_EQ(m2d_instance_evaluate(inst, &err), M2D_OK);
  m2d_render_frame frame;
  m2d_render_frame_default(&frame);
  CHECK_EQ(m2d_renderer_draw(r, inst, &frame, 64, 64, image.data(), 100, &err), M2D_INVALID_ARGUMENT);
  CHECK_EQ(m2d_renderer_draw(r, inst, &frame, 64, 64, image.data(), 260, &err), M2D_OK);
  int covered = 0, padding = 0;
  for (int y = 0; y < 64; y++) {
    for (int x = 0; x < 64; x++) covered += image[static_cast<std::size_t>(y * 260 + 4 * x + 3)] == 255;
    for (int k = 256; k < 260; k++) padding += image[static_cast<std::size_t>(y * 260 + k)] == 7;
  }
  double k = 0, cx = 0, cy = 0;
  CHECK_EQ(m2d_render_framing(model, 64, 64, &frame, &k, &cx, &cy), M2D_OK);
  const double expected = 0.125 * k * k;
  CHECK(std::fabs(covered - expected) <= 0.1 * expected + 8);
  CHECK_EQ(padding, 64 * 4);
  m2d_render_stats stats;
  m2d_renderer_stats(r, &stats);
  CHECK_EQ(stats.layered, 0);
  CHECK_EQ(stats.drawn, 1u);
  CHECK(stats.fragments > 0);
  // The instance's tints: alpha ½ halves the alpha.
  const double tint[4] = {1, 1, 1, 0.5};
  CHECK_EQ(m2d_instance_set_tint(inst, 0, tint, 4), M2D_OK);
  CHECK_EQ(m2d_renderer_draw(r, inst, nullptr, 64, 64, image.data(), 260, &err), M2D_OK);
  int half = 0;
  for (int y = 0; y < 64; y++)
    for (int x = 0; x < 64; x++) half += image[static_cast<std::size_t>(y * 260 + 4 * x + 3)] == 128;
  CHECK_EQ(half, covered);
  // Rows over threads: the same bytes and the same fragments.
  CHECK_EQ(m2d_renderer_draw(r, inst, nullptr, 256, 256, one.data(), 0, &err), M2D_OK);
  CHECK_EQ(m2d_renderer_draw(r4, inst, nullptr, 256, 256, four.data(), 0, &err), M2D_OK);
  CHECK(one == four);
  m2d_render_stats stats4;
  m2d_renderer_stats(r, &stats);
  m2d_renderer_stats(r4, &stats4);
  CHECK(stats.fragments > 1000);
  CHECK_EQ(stats4.fragments, stats.fragments);
  // An instance of another model is refused.
  m2d_model* other = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, &a, &other, &err), M2D_OK);
  m2d_instance* foreign = nullptr;
  CHECK_EQ(m2d_instance_create(other, &foreign, &err), M2D_OK);
  CHECK_EQ(m2d_renderer_draw(r, foreign, nullptr, 8, 8, image.data(), 0, &err), M2D_INVALID_ARGUMENT);
  CHECK_EQ(g_global_news, news);  // nothing from the global operator new
  m2d_instance_destroy(foreign);
  m2d_model_destroy(other);
  // Everything goes back to the allocator, in any order.
  m2d_model_destroy(model);
  m2d_renderer_destroy(r);
  m2d_renderer_destroy(r4);
  CHECK(counting::live > 0);
  m2d_instance_destroy(inst);
  CHECK_EQ(counting::live, 0u);
}

TEST(render_plan_c_api) {
  g_test = "render_plan_c_api";
  const Vector<uint8_t> bytes = written(tiny_model(5, false), 5);
  m2d_allocator a{counting::allocate, counting::deallocate, nullptr};
  const std::size_t news = g_global_news;
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, &a, &model, &err), M2D_OK);
  m2d_instance* inst = nullptr;
  CHECK_EQ(m2d_instance_create(model, &inst, &err), M2D_OK);
  // The stored UVs: the output ones with v flipped (a y-up canvas).
  const float* uv = m2d_model_drawable_texture_uvs(model, 0);
  const float* out = m2d_model_drawable_uvs(model, 0);
  CHECK(uv && out);
  if (uv && out) CHECK_EQ(out[1], 1.0f - uv[1]);
  CHECK(m2d_model_drawable_texture_uvs(model, 99) == nullptr);
  // With its texture: a clear, then the drawable, normal blending, no mask.
  const uint8_t present = 1;
  m2d_render_plan* plan = nullptr;
  CHECK_EQ(m2d_render_plan_create(model, &present, 1, nullptr, &plan, &err), M2D_OK);
  CHECK_EQ(m2d_render_plan_layered(plan), 0);
  m2d_render_frame frame;
  m2d_render_frame_default(&frame);
  frame.background[3] = 1;
  CHECK_EQ(m2d_render_plan_frame(plan, inst, &frame, 64, 32, &err), M2D_OK);
  int32_t count = 0;
  const m2d_render_op* ops = m2d_render_plan_ops(plan, &count);
  CHECK_EQ(count, 2);
  if (count == 2) {
    CHECK_EQ(ops[0].kind, M2D_OP_CLEAR);
    CHECK_EQ(ops[0].color[3], 1.0);
    CHECK_EQ(ops[1].kind, M2D_OP_DRAW_MESH);
    CHECK_EQ(ops[1].index, 0);
    CHECK_EQ(ops[1].target, -1);
    CHECK_EQ(ops[1].blend, M2D_BLEND_NORMAL);
    CHECK_EQ(ops[1].mask_buffer, -1);
    CHECK_EQ(ops[1].opacity, 1.0f);
  }
  double view[4];
  m2d_render_plan_view(plan, view);
  double k = 0, cx = 0, cy = 0;
  CHECK_EQ(m2d_render_framing(model, 64, 32, &frame, &k, &cx, &cy), M2D_OK);
  CHECK(std::fabs(view[0] - 2 * k / 64) < 1e-12);
  CHECK(std::fabs(view[1] - 2 * k / 32) < 1e-12);
  m2d_render_stats stats;
  m2d_render_plan_stats(plan, &stats);
  CHECK_EQ(stats.drawn, 1u);
  // The instance's tint alpha goes into the opacity.
  const double tint[4] = {1, 0.5, 1, 0.5};
  CHECK_EQ(m2d_instance_set_tint(inst, 0, tint, 4), M2D_OK);
  CHECK_EQ(m2d_render_plan_frame(plan, inst, nullptr, 8, 8, &err), M2D_OK);
  ops = m2d_render_plan_ops(plan, &count);
  if (count == 2) {
    CHECK_EQ(ops[1].opacity, 0.5f);
    CHECK_EQ(ops[1].tint[1], 0.5f);
  }
  if (count == 2) CHECK_EQ(ops[0].size, m2d_render_op_size());
  CHECK_EQ(m2d_render_op_size(), static_cast<uint32_t>(sizeof(m2d_render_op)));
  m2d_render_plan_destroy(plan);
  // Without the texture: nothing but the clear.
  const uint8_t missing = 0;
  CHECK_EQ(m2d_render_plan_create(model, &missing, 1, nullptr, &plan, &err), M2D_OK);
  CHECK_EQ(m2d_render_plan_frame(plan, inst, nullptr, 8, 8, &err), M2D_OK);
  m2d_render_plan_ops(plan, &count);
  CHECK_EQ(count, 1);
  CHECK_EQ(m2d_render_plan_frame(plan, inst, nullptr, 0, 8, &err), M2D_INVALID_ARGUMENT);
  m2d_render_plan_destroy(plan);
  // The GL backend: a loader without the functions is refused before any GL call.
  m2d_gl_options go;
  m2d_gl_options_default(&go);
  CHECK_EQ(go.desktop, 0);
  m2d_gl_renderer* gl = nullptr;
  const m2d_gl_loader none = [](const char*, void*) -> void* { return nullptr; };
  CHECK_EQ(m2d_gl_renderer_create(model, nullptr, 0, none, nullptr, &go, &gl, &err), M2D_INTERNAL_ERROR);
  CHECK(std::strcmp(err.code, "gl-function") == 0);
  CHECK(gl == nullptr);
  // The shader sources: both dialects, every program and stage; NULL out of range.
  for (int p = 0; p <= M2D_SHADER_MASK; p++)
    for (int st = 0; st < 2; st++) {
      const char* es = m2d_render_shader_source(p, st, M2D_SHADER_GLSL_ES_300);
      const char* core = m2d_render_shader_source(p, st, M2D_SHADER_GLSL_330);
      CHECK(es && std::strncmp(es, "#version 300 es", 15) == 0);
      CHECK(core && std::strncmp(core, "#version 330 core", 17) == 0);
      if (es && core) CHECK(std::strcmp(es + 15, core + 17) == 0);  // the same text after the version line
    }
  CHECK(std::strstr(m2d_render_shader_source(M2D_SHADER_MESH_ADVANCED, 1, 0), "blendColor") != nullptr);
  CHECK(std::strstr(m2d_render_shader_source(M2D_SHADER_MESH, 1, 0), "blendColor") == nullptr);
  CHECK(m2d_render_shader_source(5, 0, 0) == nullptr);
  CHECK(m2d_render_shader_source(0, 2, 0) == nullptr);
  CHECK(m2d_render_shader_source(0, 0, 6) == nullptr);
  // The dialect for Metal and Direct3D 11, and its MSL and HLSL.
  for (int p = 0; p <= M2D_SHADER_MASK; p++)
    for (int st = 0; st < 2; st++) {
      const char* cross = m2d_render_shader_source(p, st, M2D_SHADER_CROSS_GLSL_450);
      const char* msl = m2d_render_shader_source(p, st, M2D_SHADER_MSL);
      const char* hlsl = m2d_render_shader_source(p, st, M2D_SHADER_HLSL);
      CHECK(cross && std::strncmp(cross, "#version 450", 12) == 0);
      CHECK(cross && (st == 1) == (std::strstr(cross, "gl_Position.y = -gl_Position.y") == nullptr));
      CHECK(msl && std::strstr(msl, "#include <metal_stdlib>") != nullptr &&
            std::strstr(msl, st == 0 ? "vertex " : "fragment ") != nullptr);
      CHECK(hlsl && std::strstr(hlsl, "main(SPIRV_Cross_Input") != nullptr);
    }
  CHECK(std::strstr(m2d_render_shader_source(M2D_SHADER_MESH, 1, M2D_SHADER_MSL), "m2d_mesh_frag(") != nullptr);
  CHECK(std::strstr(m2d_render_shader_source(M2D_SHADER_MESH, 0, M2D_SHADER_HLSL), "cbuffer M2dPushConstants") !=
        nullptr);
  // Without the backends (Linux), creation is refused as not built; NULL arguments first.
  {
    m2d_mtl_options mo;
    m2d_mtl_options_default(&mo);
    CHECK_EQ(mo.flip_y, 1);
    m2d_mtl_renderer* mr = nullptr;
    int fake = 0;
    CHECK_EQ(m2d_mtl_renderer_create(model, nullptr, 0, nullptr, nullptr, &mr, &err), M2D_INVALID_ARGUMENT);
    if (!m2d_mtl_available()) {
      CHECK_EQ(m2d_mtl_renderer_create(model, nullptr, 0, &fake, nullptr, &mr, &err), M2D_INTERNAL_ERROR);
      CHECK(std::strcmp(err.code, "mtl-not-built") == 0);
    }
    m2d_d3d11_options dopt;
    m2d_d3d11_options_default(&dopt);
    CHECK_EQ(dopt.flip_y, 1);
    m2d_d3d11_renderer* dr = nullptr;
    CHECK_EQ(m2d_d3d11_renderer_create(model, nullptr, 0, &fake, nullptr, nullptr, &dr, &err), M2D_INVALID_ARGUMENT);
    if (!m2d_d3d11_available()) {
      CHECK_EQ(m2d_d3d11_renderer_create(model, nullptr, 0, &fake, &fake, nullptr, &dr, &err), M2D_INTERNAL_ERROR);
      CHECK(std::strcmp(err.code, "d3d11-not-built") == 0);
    }
    CHECK(mr == nullptr && dr == nullptr);
  }
  // The Vulkan dialect and its SPIR-V (the committed words start with SPIR-V's magic number).
  for (int p = 0; p <= M2D_SHADER_MASK; p++)
    for (int st = 0; st < 2; st++) {
      const char* vk = m2d_render_shader_source(p, st, M2D_SHADER_VULKAN_GLSL_450);
      CHECK(vk && std::strncmp(vk, "#version 450", 12) == 0 && std::strstr(vk, "push_constant") != nullptr);
      size_t words = 0;
      const uint32_t* spirv = m2d_render_shader_spirv(p, st, &words);
      CHECK(spirv != nullptr && words > 5 && spirv[0] == 0x07230203u);
    }
  size_t no_words = 1;
  CHECK(m2d_render_shader_spirv(5, 0, &no_words) == nullptr && no_words == 0);
  // Without a Vulkan context, creation is refused before any Vulkan call.
  m2d_vk_options vo;
  m2d_vk_options_default(&vo);
  CHECK_EQ(vo.flip_y, 1);
  m2d_vk_context vc{};
  m2d_vk_renderer* vkr = nullptr;
  CHECK_EQ(m2d_vk_renderer_create(model, nullptr, 0, &vc, &vo, &vkr, &err), M2D_INVALID_ARGUMENT);  // no size
  vc.size = sizeof vc;
  CHECK_EQ(m2d_vk_renderer_create(model, nullptr, 0, &vc, &vo, &vkr, &err), M2D_INTERNAL_ERROR);
  CHECK(std::strcmp(err.code, m2d_vk_available() ? "vk-function" : "vk-not-built") == 0);
  CHECK(vkr == nullptr);
  CHECK_EQ(g_global_news, news);
  m2d_instance_destroy(inst);
  m2d_model_destroy(model);
  CHECK_EQ(counting::live, 0u);
}

TEST(changed_vertices_c_api) {
  g_test = "changed_vertices_c_api";
  const Vector<uint8_t> bytes = written(tiny_model(5, false), 5);
  m2d_error err;
  m2d_model* model = nullptr;
  CHECK_EQ(m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err), M2D_OK);
  if (!model) return;
  const int32_t n = m2d_model_drawable_count(model);
  const int64_t total = m2d_model_vertex_total(model);
  CHECK(n >= 1 && total >= 3);
  int64_t sum = 0;
  for (int32_t i = 0; i < n; i++) {
    CHECK_EQ(m2d_model_drawable_vertex_offset(model, i), sum);
    sum += m2d_model_drawable_vertex_count(model, i);
  }
  CHECK_EQ(sum, total);
  CHECK_EQ(m2d_model_drawable_vertex_offset(model, n), -1);
  m2d_instance* a = nullptr;
  m2d_instance* b = nullptr;
  CHECK_EQ(m2d_instance_create(model, &a, &err), M2D_OK);
  CHECK_EQ(m2d_instance_create(model, &b, &err), M2D_OK);
  CHECK(m2d_instance_serial(a) != 0 && m2d_instance_serial(a) != m2d_instance_serial(b));
  std::vector<float> buffer(static_cast<std::size_t>(total) * 2, -7.0f);
  std::vector<uint32_t> versions(static_cast<std::size_t>(n), 0);
  std::vector<int32_t> changed(static_cast<std::size_t>(n), -1);
  m2d_vertex_sync sync{sizeof(m2d_vertex_sync), n, versions.data(), 0};
  int32_t count = -1;
  // Too small a buffer, or a wrong count, is refused.
  CHECK_EQ(m2d_instance_copy_changed_vertices(a, &sync, buffer.data(), buffer.size() - 1, changed.data(), &count),
           M2D_INVALID_ARGUMENT);
  m2d_vertex_sync wrong = sync;
  wrong.version_count = n + 1;
  CHECK_EQ(m2d_instance_copy_changed_vertices(a, &wrong, buffer.data(), buffer.size(), nullptr, &count),
           M2D_INVALID_ARGUMENT);
  // The first copy takes everything, in the model's layout.
  CHECK_EQ(m2d_instance_copy_changed_vertices(a, &sync, buffer.data(), buffer.size(), changed.data(), &count), M2D_OK);
  CHECK_EQ(count, n);
  CHECK_EQ(sync.serial, m2d_instance_serial(a));
  const float* v0 = m2d_instance_drawable_vertices(a, 0);
  CHECK(v0 && buffer[0] == v0[0] && buffer[1] == v0[1]);
  CHECK_EQ(versions[0], m2d_instance_drawable_vertex_version(a, 0));
  // Nothing changed: nothing copied.
  CHECK_EQ(m2d_instance_copy_changed_vertices(a, &sync, buffer.data(), buffer.size(), changed.data(), &count), M2D_OK);
  CHECK_EQ(count, 0);
  // A parameter that moves the mesh: its drawable is copied again, with the new vertices.
  const uint32_t before = m2d_instance_drawable_vertex_version(a, 0);
  float range[3];
  m2d_model_parameter_range(model, 0, range);
  CHECK_EQ(m2d_instance_set_parameter(a, 0, range[1]), M2D_OK);
  CHECK_EQ(m2d_instance_evaluate(a, &err), M2D_OK);
  CHECK(m2d_instance_drawable_vertex_version(a, 0) != before);
  CHECK_EQ(m2d_instance_copy_changed_vertices(a, &sync, buffer.data(), buffer.size(), changed.data(), &count), M2D_OK);
  CHECK(count >= 1 && changed[0] == 0);
  v0 = m2d_instance_drawable_vertices(a, 0);
  CHECK(v0 && buffer[0] == v0[0] && buffer[1] == v0[1]);
  // Another instance: everything again, whatever the versions say.
  CHECK_EQ(m2d_instance_copy_changed_vertices(b, &sync, buffer.data(), buffer.size(), nullptr, &count), M2D_OK);
  CHECK_EQ(count, n);
  CHECK_EQ(sync.serial, m2d_instance_serial(b));
  m2d_instance_destroy(a);
  m2d_instance_destroy(b);
  m2d_model_destroy(model);
}

TEST(instance_serial) {
  g_test = "instance_serial";
  const Vector<uint8_t> bytes = written(tiny_model(5, false), 5);
  const auto model = loaded(bytes);
  CHECK(model != nullptr);
  if (!model) return;
  eval::Instance one(model);
  eval::Instance two(model);
  eval::Instance copy(one);
  CHECK(one.serial.value != two.serial.value);
  CHECK(copy.serial.value != one.serial.value);
  const uint64_t before = two.serial.value;
  two = one;
  CHECK(two.serial.value != before && two.serial.value != one.serial.value);
}

TEST(framework_allocations) {
  // A whole framework session with an allocator: nothing goes anywhere else,
  // and everything comes back.
  const auto bytes = written(tiny_model(5, true), 5);
  m2d_allocator a{counting::allocate, counting::deallocate, nullptr};
  m2d_error err;
  const char* settings_json = R"({"FileReferences":{"Moc":"m.moc3"},"Groups":[{"Name":"EyeBlink","Ids":["ParamX"]},{"Name":"LipSync","Ids":["ParamX","FreeLip"]}]})";
  const std::string w = wav16(8000, 4000, 3000);
  const std::size_t before = g_global_news;
  const char* physics = R"({"Meta":{"PhysicsSettingCount":1,"TotalInputCount":1,"TotalOutputCount":1,"VertexCount":2},
    "PhysicsSettings":[{"Input":[{"Source":{"Id":"ParamX"},"Weight":100,"Type":"Angle"}],
      "Output":[{"Destination":{"Id":"ParamX"},"VertexIndex":1,"Scale":1,"Weight":100,"Type":"Angle"}],
      "Vertices":[{"Position":{"X":0,"Y":0}},{"Position":{"X":0,"Y":1},"Mobility":1,"Delay":1,"Acceleration":1,"Radius":1}],
      "Normalization":{"Position":{"Minimum":-1,"Maximum":1},"Angle":{"Minimum":-10,"Maximum":10}}}]})";
  const char* pose = R"({"Groups":[[{"Id":"Root"},{"Id":"B"}]]})";
  const char* expr = R"({"Parameters":[{"Id":"ParamX","Value":0.5,"Blend":"Multiply"}]})";
  m2d_model* model = nullptr;
  m2d_settings* settings = nullptr;
  m2d_motion* motion = nullptr;
  m2d_sound* sound = nullptr;
  m2d_physics* ph = nullptr;
  m2d_pose* po = nullptr;
  m2d_expression* ex = nullptr;
  m2d_animator* anim = nullptr;
  m2d_instance* inst = nullptr;
  m2d_model_load(bytes.data(), bytes.size(), 0, &a, &model, &err);
  m2d_settings_parse(settings_json, std::strlen(settings_json), "s", &a, &settings, &err);
  m2d_motion_parse(kMotion, std::strlen(kMotion), "m", &a, &motion, &err);
  m2d_sound_decode(w.data(), w.size(), &a, &sound, &err);
  m2d_physics_parse(physics, std::strlen(physics), "p", &a, &ph, &err);
  m2d_pose_parse(pose, std::strlen(pose), "q", &a, &po, &err);
  m2d_expression_parse(expr, std::strlen(expr), "e", &a, &ex, &err);
  CHECK_EQ(m2d_animator_create(model, settings, ph, po, nullptr, &anim, &err), M2D_OK);
  m2d_instance_create(model, &inst, &err);
  m2d_motion_start start;
  m2d_motion_start_default(&start);
  start.loop = 1;
  m2d_animator_start_motion(anim, motion, &start, sound);
  m2d_animator_start_expression(anim, ex);
  m2d_animator_add_expression_layer(anim, ex);
  m2d_animator_set_look_target(anim, 0.5, -0.5);
  m2d_animator_set_part_opacity(anim, "Free", 0.5);
  m2d_frame frame;
  for (int k = 0; k < 90; k++) CHECK_EQ(m2d_animator_update(anim, inst, 1.0 / 30, &frame, &err), M2D_OK);
  m2d_free_string(m2d_instance_snapshot_json(inst));
  m2d_animator_stop_motions(anim);
  m2d_animator_frame(anim, 1.0 / 30, &frame, &err);
  m2d_motion_destroy(motion);
  m2d_sound_destroy(sound);
  m2d_physics_destroy(ph);
  m2d_pose_destroy(po);
  m2d_expression_destroy(ex);
  m2d_settings_destroy(settings);
  m2d_animator_destroy(anim);
  m2d_instance_destroy(inst);
  m2d_model_destroy(model);
  CHECK_EQ(g_global_news, before);
  CHECK_EQ(counting::live, 0u);
}

#include "unit/motion_sync.inc"

}  // namespace

/** Writes seed inputs for the fuzz targets (synthetic files made here; none is committed). */
// ------------------------------------------- input a stranger made

namespace peak {
std::size_t live = 0, top = 0;
void* allocate(std::size_t size, std::size_t alignment, void*) {
  live += size;
  top = std::max(top, live);
  return ::operator new(size, std::align_val_t(alignment));
}
void deallocate(void* p, std::size_t size, std::size_t alignment, void*) {
  live -= size;
  ::operator delete(p, std::align_val_t(alignment));
}
/** The allocator, its peak reset. */
m2d_allocator fresh() {
  top = live;
  return m2d_allocator{allocate, deallocate, nullptr};
}
}  // namespace peak

namespace {

void put32(Vector<uint8_t>& b, std::size_t o, uint32_t v) { std::memcpy(&b[o], &v, 4); }
uint32_t get32(const Vector<uint8_t>& b, std::size_t o) {
  uint32_t v;
  std::memcpy(&v, &b[o], 4);
  return v;
}
void put_be32(std::string& b, uint32_t v) {
  for (int k = 3; k >= 0; k--) b.push_back(static_cast<char>((v >> (8 * k)) & 0xff));
}
/** A PNG of `width` × `height` RGBA8 that holds only `idat` bytes of image data. */
std::string crafted_png(uint32_t width, uint32_t height, std::size_t idat) {
  std::string b("\x89PNG\r\n\x1a\n", 8);
  put_be32(b, 13);
  b += "IHDR";
  put_be32(b, width);
  put_be32(b, height);
  b += std::string("\x08\x06\x00\x00\x00", 5);  // 8 bits, RGBA
  put_be32(b, 0);                                // CRC (not read before decoding)
  put_be32(b, static_cast<uint32_t>(idat));
  b += "IDAT" + std::string(idat, '\0');
  put_be32(b, 0);
  put_be32(b, 0);
  b += "IEND";
  put_be32(b, 0);
  return b;
}

}  // namespace

TEST(crafted_inputs_refused_before_their_cost) {
  m2d_error err;
  const Vector<uint8_t> model = written(tiny_model(5, true), 5);
  const std::size_t count_table = get32(model, 64);
  // A .moc3 whose counts declare 2^31 − 1 of everything: refused by the
  // section bounds before any array is allocated.
  {
    Vector<uint8_t> b = model;
    for (int i = 0; i < moc::count_table_length(5); i++) put32(b, count_table + 4u * static_cast<unsigned>(i), 0x7fffffff);
    m2d_allocator a = peak::fresh();
    m2d_model* m = nullptr;
    CHECK_EQ(m2d_model_load(b.data(), b.size(), 0, &a, &m, &err), M2D_FORMAT_ERROR);
    CHECK_EQ(std::string(err.code), "section-bounds");
    CHECK(peak::top - peak::live < 16384);
    a = peak::fresh();
    int32_t valid = 1;
    char* report = nullptr;
    CHECK_EQ(m2d_validate_moc(b.data(), b.size(), M2D_LEVEL_STRICT, &a, &valid, &report, &err), M2D_OK);
    CHECK_EQ(valid, 0);
    CHECK(std::strstr(report, "section-bounds") != nullptr);
    m2d_free_string(report);
    CHECK(peak::top - peak::live < 16384);
  }
  // Every section on the same 64 KiB of zeros: in bounds, but together the
  // sections claim several times the file. The loader stops at the slot
  // order, validation at the claim, both before reading an array.
  {
    Vector<uint8_t> b = model;
    const std::size_t at = b.size(), zeros = 65536;
    b.resize(at + zeros, 0);
    for (int i = 2; i < moc::slot_table_length(5); i++) put32(b, 64 + 4u * static_cast<unsigned>(i), static_cast<uint32_t>(at));
    for (int i = 0; i < moc::count_table_length(5); i++)
      put32(b, count_table + 4u * static_cast<unsigned>(i), static_cast<uint32_t>(zeros / 64));
    m2d_allocator a = peak::fresh();
    m2d_model* m = nullptr;
    CHECK_EQ(m2d_model_load(b.data(), b.size(), 0, &a, &m, &err), M2D_FORMAT_ERROR);
    CHECK_EQ(std::string(err.code), "slot-order");
    CHECK(peak::top - peak::live < b.size());
    a = peak::fresh();
    int32_t valid = 1;
    char* report = nullptr;
    CHECK_EQ(m2d_validate_moc(b.data(), b.size(), M2D_LEVEL_STRICT, &a, &valid, &report, &err), M2D_OK);
    CHECK_EQ(valid, 0);
    CHECK(std::strstr(report, "reads no further") != nullptr);
    m2d_free_string(report);
    CHECK(peak::top - peak::live < b.size());
  }
  // A report lists at most kMaxDiagnostics, then says how many it left out.
  {
    moc::MocData d = tiny_model(5, false);
    const std::size_t n = 12000;
    for (std::size_t i = 0; i < moc::kFieldCount; i++) {
      const auto& f = moc::all_fields()[i];
      if (!f.group || std::strcmp(f.group, "parts") != 0 || f.since > 5) continue;
      auto& arr = d[f.id];
      if (!arr.names.empty()) arr.names.resize(n, arr.names[0]);
      if (!arr.i32.empty()) arr.i32.resize(n, arr.i32[0]);
      if (!arr.f32.empty()) arr.f32.resize(n, arr.f32[0]);
    }
    for (auto& parent : d.i32(F::part_parent)) parent = 999999;
    const moc::Validation v = moc::validate_moc(d, 5, moc::Level::Strict);
    CHECK(!v.valid);
    CHECK_EQ(v.diagnostics.size(), moc::kMaxDiagnostics + 1);
    CHECK_EQ(std::string(v.diagnostics.back().code), "diagnostics-truncated");
    CHECK(v.diagnostics.back().warning);
  }
  // JSON: an object of 200,000 keys parses in O(n log n), a repeated key keeps
  // its first place and takes its last value, and memory stays a small
  // multiple of the text.
  {
    std::string text = "{\"Version\":3,\"Meta\":{\"Duration\":1,\"Fps\":30,\"CurveCount\":2000000000,"
                       "\"TotalSegmentCount\":2000000000,\"TotalPointCount\":2000000000,\"UserDataCount\":2000000000,"
                       "\"TotalUserDataSize\":2000000000},\"Curves\":[],\"UserData\":[]";
    for (int i = 0; i < 200000; i++) text += ",\"k" + std::to_string(i) + "\":0";
    text += "}";
    m2d_allocator a = peak::fresh();
    m2d_motion* m = nullptr;
    const auto t0 = std::chrono::steady_clock::now();
    // Its Meta declares 2·10^9 curves, segments, points and user data: nothing is
    // allocated for them, and the file is refused for not holding them.
    CHECK_EQ(m2d_motion_parse(text.data(), text.size(), "m", &a, &m, &err), M2D_FILE_ERROR);
    CHECK(std::chrono::steady_clock::now() - t0 < std::chrono::seconds(5));
    CHECK(peak::top - peak::live < 32 * text.size());
    m2d_motion_destroy(m);
    json::Value v;
    json::ParseError pe;
    std::string rep = "{";
    for (int i = 0; i < 40; i++) rep += "\"k" + std::to_string(i % 17) + "\":" + std::to_string(i) + (i < 39 ? "," : "}");
    CHECK(json::parse(rep, v, pe));
    CHECK_EQ(v.members().size(), 17u);
    CHECK_EQ(std::string(v.members()[3].first), "k3");
    CHECK_EQ(v.members()[3].second.as_number(), 37.0);
    std::string deep(100000, '[');
    CHECK_EQ(m2d_motion_parse(deep.data(), deep.size(), "m", nullptr, &m, &err), M2D_FILE_ERROR);
  }
  // A WAV header that declares 4 GiB of samples in a 44-byte file: the data
  // read is the data there is.
  {
    std::string wav = "RIFF";
    for (uint32_t v : {0xffffffffu}) wav.append(reinterpret_cast<const char*>(&v), 4);
    wav += "WAVEfmt ";
    const uint32_t fmt_size = 16, rate = 44100, byte_rate = 44100 * 4, data_size = 0xfffffff0u;
    const uint16_t pcm = 1, channels = 2, align = 4, bits = 16;
    wav.append(reinterpret_cast<const char*>(&fmt_size), 4);
    wav.append(reinterpret_cast<const char*>(&pcm), 2);
    wav.append(reinterpret_cast<const char*>(&channels), 2);
    wav.append(reinterpret_cast<const char*>(&rate), 4);
    wav.append(reinterpret_cast<const char*>(&byte_rate), 4);
    wav.append(reinterpret_cast<const char*>(&align), 2);
    wav.append(reinterpret_cast<const char*>(&bits), 2);
    wav += "data";
    wav.append(reinterpret_cast<const char*>(&data_size), 4);
    CHECK_EQ(wav.size(), 44u);
    m2d_allocator a = peak::fresh();
    m2d_sound* sound = nullptr;
    CHECK_EQ(m2d_sound_decode(wav.data(), wav.size(), &a, &sound, &err), M2D_OK);
    CHECK_EQ(m2d_sound_frames(sound), 0.0);
    m2d_sound_destroy(sound);
    CHECK(peak::top - peak::live < 4096);
    // Motion sync's decoder: no samples either; what it allocates is its fixed analysis tables.
    a = peak::fresh();
    m2d_motion_sync_sound* ms = nullptr;
    CHECK_EQ(m2d_motion_sync_sound_decode(wav.data(), wav.size(), &a, &ms, &err), M2D_OK);
    m2d_motion_sync_sound_destroy(ms);
    CHECK(peak::top - peak::live < 256 * 1024);
  }
  // A texture past M2D_MAX_TEXTURE_SIDE: "too large", from its sizes alone.
  {
    uint8_t px[4] = {0, 0, 0, 0};
    m2d_allocator a = peak::fresh();
    m2d_texture* t = nullptr;
    CHECK_EQ(m2d_texture_create(px, 40000, 40000, 0, &a, &t, &err), M2D_LIMIT_ERROR);
    CHECK_EQ(std::string(err.code), "texture-too-large");
    CHECK(t == nullptr);
    CHECK_EQ(peak::top - peak::live, 0u);
  }
  // A package's files past the caps: refused from a known size before the
  // read, and from a read's size before the copy; companions become warnings.
  {
    MemoryFiles mem;
    for (const auto& f : mochi2d::testing::model_folder()) mem.files[f.first] = f.second;
    std::string settings_name;
    for (const auto& f : mem.files)
      if (f.first.size() > 12 && f.first.compare(f.first.size() - 12, 12, ".model3.json") == 0) settings_name = f.first;
    CHECK(!settings_name.empty());
    m2d_file_source source = mem.source("box");
    static uint64_t declared = 0;
    declared = uint64_t{3} << 30;
    source.size = [](const char* path, uint64_t* size, void*) -> int32_t {
      if (std::strstr(path, ".moc3") == nullptr) return 0;
      *size = declared;
      return 1;
    };
    m2d_package* pkg = nullptr;
    const int reads = mem.reads;
    m2d_allocator a = peak::fresh();
    CHECK_EQ(m2d_package_open(&source, settings_name.c_str(), 0, &a, &pkg, &err), M2D_LIMIT_ERROR);
    CHECK_EQ(std::string(err.code), "file-limit");
    CHECK(std::strstr(err.message, "holds 3221225472 bytes or more, more than the 1073741824 allowed for one file") != nullptr);
    CHECK_EQ(mem.reads, reads + 1);  // the settings file only
    source.size = nullptr;
    m2d_package_limits caps;
    m2d_package_limits_default(&caps);
    CHECK_EQ(caps.max_file_bytes, uint64_t{1} << 30);
    CHECK_EQ(caps.max_total_bytes, uint64_t{1} << 31);
    // A 16 MiB .moc3 past a 1 MiB cap: refused after the read, before the copy.
    std::string original_moc;
    std::size_t moc_size = 0;
    for (auto& f : mem.files)
      if (f.first.find(".moc3") != std::string::npos) {
        original_moc = f.second;
        f.second.resize(16u << 20);
      }
    caps.max_file_bytes = 1u << 20;
    a = peak::fresh();
    CHECK_EQ(m2d_package_open_with_limits(&source, settings_name.c_str(), 0, &caps, &a, &pkg, &err), M2D_LIMIT_ERROR);
    CHECK(std::strstr(err.message, "holds 16777216 bytes or more, more than the 1048576 allowed for one file") != nullptr);
    CHECK(peak::top - peak::live < (1u << 20));  // not copied
    for (auto& f : mem.files)
      if (f.first.find(".moc3") != std::string::npos) {
        f.second = original_moc;
        moc_size = f.second.size();
      }
    // The total: what the settings file and the .moc3 leave is too little for the companions.
    caps.max_file_bytes = UINT64_MAX;
    caps.max_total_bytes = mem.files[settings_name].size() + moc_size;
    CHECK_EQ(m2d_package_open_with_limits(&source, settings_name.c_str(), 0, &caps, nullptr, &pkg, &err), M2D_OK);
    bool total_warned = false;
    for (int32_t i = 0; i < m2d_package_warning_count(pkg); i++)
      total_warned = total_warned || std::strstr(m2d_package_warning(pkg, i), "allowed in total") != nullptr;
    CHECK(total_warned);
    m2d_package_destroy(pkg);
  }
  // The tools: a PNG is read from its header before stb_image sees it, and a
  // file past the tools' cap is refused from its size.
  {
    int w = 0, h = 0;
    Vector<uint8_t> rgba;
    String why;
    conformance::PngRefusal refusal = conformance::PngRefusal::None;
    // 30,000 × 30,000 (3.6 GB decoded) in 87 bytes: too short for its size.
    const std::string bomb = crafted_png(30000, 30000, 20);
    CHECK(!conformance::decode_png(String(bomb.data(), bomb.size()), w, h, rgba, why, {}, &refusal));
    CHECK(refusal == conformance::PngRefusal::Format);
    CHECK(why.find("too few for a PNG file of that size") != String::npos);
    // 16,385 × 1 with all its data: past the cap on a side.
    const std::string wide = crafted_png(16385, 1, 200);
    CHECK(!conformance::decode_png(String(wide.data(), wide.size()), w, h, rgba, why, {}, &refusal));
    CHECK(refusal == conformance::PngRefusal::Limit);
    CHECK(why.find("allowed on a side") != String::npos);
    namespace fs = std::filesystem;
    const fs::path file = fs::temp_directory_path() / "mochi2d-crafted-input.bin";
    { std::ofstream(file, std::ios::binary) << std::string(300, 'x'); }
    String bytes, limit;
    CHECK(!conformance::read_file(file, bytes, &limit, 100));
    CHECK(limit.find("holds 300 bytes or more, more than the 100 allowed for one file") != String::npos);
    CHECK(bytes.empty());
    // Named as the model names it, not by the path on disk.
    CHECK(!conformance::read_file(file, bytes, &limit, 100, "textures/t.png"));
    CHECK(limit.find("\"textures/t.png\" holds 300 bytes") == 0);
    CHECK(limit.find(file.filename().u8string().c_str()) == String::npos);
    CHECK(conformance::read_file(file, bytes, &limit));
    CHECK_EQ(bytes.size(), 300u);
    fs::remove(file);
  }
}

int write_seeds(const std::string& dir) {
  namespace fs = std::filesystem;
  fs::create_directories(fs::u8path(dir) / "moc");
  fs::create_directories(fs::u8path(dir) / "json");
  auto put = [](const fs::path& p, const std::string& bytes) {
    std::FILE* f = std::fopen(p.u8string().c_str(), "wb");
    if (!f) return;
    std::fwrite(bytes.data(), 1, bytes.size(), f);
    std::fclose(f);
  };
  for (int v = 1; v <= 5; v++)
    for (bool warp : {false, true}) {
      const auto b = written(tiny_model(v, warp), v);
      put(fs::u8path(dir) / "moc" / ("tiny-v" + std::to_string(v) + (warp ? "-warp" : "") + ".moc3"),
          std::string(b.begin(), b.end()));
    }
  put(fs::u8path(dir) / "json" / "scenario.json",
      R"({"format":"mochi2d-scenario/0","id":"a","model":"m/m.model3.json","parameters":{"P":1,"2":0.5},"partOpacities":{"Q":0},"render":{"width":64,"height":64,"background":[0,0,0,1],"view":{"x":0,"y":0,"pixelsPerUnit":10}}})");
  put(fs::u8path(dir) / "json" / "settings.json",
      "\xEF\xBB\xBF{\"Version\":3,\"FileReferences\":{\"Moc\":\"m.moc3\",\"Textures\":[\"t.png\"],\"Physics\":\"p.json\"},\"Groups\":[]}");
  put(fs::u8path(dir) / "json" / "values.json", "[1e400, -0, \"\\u00e9\\ud83d\\ude00\\ud800\", {\"a\": {\"b\": [null, true, false]}}, 0.1]");
  // The framework's files.
  fs::create_directories(fs::u8path(dir) / "anim");
  const fs::path anim = fs::u8path(dir) / "anim";
  put(anim / "motion.motion3.json", kMotion);
  put(anim / "model.motion3.json",
      R"({"Meta":{"Duration":2,"Fps":30,"FadeInTime":0.2,"FadeOutTime":0.3,"AreBeziersRestricted":false,"CurveCount":4,"TotalSegmentCount":5,"TotalPointCount":10},"Curves":[{"Target":"Model","Id":"EyeBlink","Segments":[0,1,1,0.3,0.2,0.6,0,1,1]},{"Target":"Model","Id":"Opacity","Segments":[0,1,2,1,0.5]},{"Target":"Parameter","Id":"ParamX","FadeInTime":0.5,"Segments":[0,0,3,1,1,0,1.5,0.5]},{"Target":"PartOpacity","Id":"Root","Segments":[0,1,0,2,0]}],"UserData":[{"Time":1,"Value":"e"}]})");
  put(anim / "expression.exp3.json",
      R"({"FadeInTime":0.3,"FadeOutTime":0.2,"Parameters":[{"Id":"ParamX","Value":0.5,"Blend":"Multiply"},{"Id":"Free","Value":2,"Blend":"Overwrite"},{"Id":"ParamX","Value":1}]})");
  put(anim / "physics.physics3.json",
      R"({"Meta":{"PhysicsSettingCount":1,"TotalInputCount":2,"TotalOutputCount":2,"VertexCount":3,"Fps":30},"PhysicsSettings":[{"Id":"S","Input":[{"Source":{"Id":"ParamX"},"Weight":100,"Type":"Angle","Reflect":true},{"Source":{"Id":"Free"},"Weight":50,"Type":"Y"}],"Output":[{"Destination":{"Id":"ParamX"},"VertexIndex":2,"Scale":2,"Weight":60,"Type":"Angle"},{"Destination":{"Id":"ParamX"},"VertexIndex":1,"Scale":1,"Weight":100,"Type":"X"}],"Vertices":[{"Position":{"X":0,"Y":0},"Mobility":1,"Delay":1,"Acceleration":1,"Radius":0},{"Position":{"X":0,"Y":3},"Mobility":0.9,"Delay":0.9,"Acceleration":1.5,"Radius":3},{"Position":{"X":0,"Y":6},"Mobility":0.8,"Delay":0.6,"Acceleration":2,"Radius":3}],"Normalization":{"Position":{"Minimum":-10,"Default":0,"Maximum":10},"Angle":{"Minimum":-10,"Default":0,"Maximum":10}}}]})");
  put(anim / "pose.pose3.json", R"({"FadeInTime":0.4,"Groups":[[{"Id":"Root","Link":["L"]},{"Id":"B"}],[]]})");
  put(anim / "settings.model3.json",
      R"({"FileReferences":{"Moc":"m.moc3","Motions":{"Idle":[{"File":"a","Sound":"s.wav","FadeInTime":0}]},"Expressions":[{"Name":"n","File":"e"}]},"Groups":[{"Name":"EyeBlink","Ids":["ParamX"]},{"Name":"LipSync","Ids":["ParamX"]}],"Layout":{"width":2}})");
  put(anim / "user.userdata3.json", R"({"Meta":{"UserDataCount":1},"UserData":[{"Target":"ArtMesh","Id":"Mesh","Value":"v"}]})");
  put(anim / "info.cdi3.json",
      R"({"Parameters":[{"Id":"ParamX","GroupId":"G","Name":"X"}],"ParameterGroups":[{"Id":"G","Name":"Group"}],"Parts":[{"Id":"Root","Name":"R"}],"CombinedParameters":[["ParamX","ParamX"]]})");
  put(anim / "sound.wav", wav16(8000, 400, 9000));
  // Motion sync: the crafted ds-two file, a short vowel in a 24-bit WAV, the neutral voice profile.
  put(anim / "two.motionsync3.json", test::ds_two_json());
  {
    test::ClipOptions o;
    o.vowels = {0};
    o.hold = 0.12;
    o.gap = 0.04;
    put(anim / "vowel.wav", test::wav_file({test::vowel_clip(test::kMale, 16000, o).samples}, 16000, test::WavEncoding::Pcm24));
  }
  {
    const String profile = framework::voice_profile_to_json(framework::neutral_voice_profile());
    put(anim / "profile.json", std::string(profile.data(), profile.size()));
  }
  // A whole model folder (fuzz_model): one seed per file, its index first.
  fs::create_directories(fs::u8path(dir) / "model");
  {
    const auto folder = mochi2d::testing::model_folder();
    for (std::size_t i = 0; i < folder.size(); i++)
      put(fs::u8path(dir) / "model" / ("seed-" + std::to_string(i) + "-" + folder[i].first),
          std::string(1, static_cast<char>(i)) + folder[i].second);
    // Mochi2D 0.16.0's regression inputs: the physics file at rates whose steps never ended.
    for (std::size_t i = 0; i < folder.size(); i++) {
      if (folder[i].first != "m.physics3.json") continue;
      for (const char* fps : {"1e+308", "1e309", "5e-324"}) {
        std::string text = folder[i].second;
        text.replace(text.find("\"Fps\":30"), 8, std::string("\"Fps\":") + fps);
        put(fs::u8path(dir) / "model" / (std::string("fps-") + fps), std::string(1, static_cast<char>(i)) + text);
      }
    }
  }
  std::printf("seeds written to %s\n", dir.c_str());
  return 0;
}

int main(int argc, char** argv) {
  if (argc == 3 && std::string(argv[1]) == "--write-seeds") return write_seeds(argv[2]);
  for (auto& [name, f] : tests()) {
    g_test = name;
    const int before = g_failures;
    f();
    std::printf("%s %s\n", g_failures == before ? "ok  " : "FAIL", name.c_str());
  }
  std::printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures ? 1 : 0;
}

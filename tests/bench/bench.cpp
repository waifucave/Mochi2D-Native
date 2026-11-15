// Evaluation benchmark: incremental against full evaluation on one model
// (tests/bench/model.ts makes a synthetic one of DeepSeek-chan's size), in
// four workloads per frame:
//
//   still  no parameter changes (a paused model);
//   one    one parameter changes, the next bound one every frame (a slider,
//          an eye blink, the mouth);
//   idle   16 bound parameters change, as an idle motion with breath, eye
//          blink and look moves a model;
//   all    every parameter changes.
//
// Each workload runs the same frames on an incremental and on a full
// instance, checks that every frame's outputs are bit for bit the same, and
// reports how much the incremental instance recomputed on average.
//
// usage: mochi2d_bench <model.moc3> [frames]
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "core/eval/instance.hpp"
#include "core/moc/model.hpp"

using namespace mochi2d;
using Clock = std::chrono::steady_clock;

namespace {

double ms_since(Clock::time_point t) { return std::chrono::duration<double, std::milli>(Clock::now() - t).count(); }

template <class V>
bool same_bits(const V& a, const V& b) {
  return a.size() == b.size() && (a.empty() || std::memcmp(a.data(), b.data(), a.size() * sizeof a[0]) == 0);
}

bool same_outputs(const eval::Instance& a, const eval::Instance& b) {
  if (!same_bits(a.drawable_opacity, b.drawable_opacity) || !same_bits(a.drawable_multiply, b.drawable_multiply) ||
      !same_bits(a.drawable_screen, b.drawable_screen) || !same_bits(a.drawable_draw_order, b.drawable_draw_order) ||
      !same_bits(a.drawable_render_order, b.drawable_render_order) || !same_bits(a.drawable_visible, b.drawable_visible) ||
      !same_bits(a.part_draw_order, b.part_draw_order))
    return false;
  for (std::size_t i = 0; i < a.drawable_vertices.size(); i++)
    if (!same_bits(a.drawable_vertices[i], b.drawable_vertices[i])) return false;
  return true;
}

struct Workload {
  const char* name;
  std::vector<int> params;
  /** Change one of `params` per frame, in turn, instead of all of them. */
  bool one_at_a_time = false;
};

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: mochi2d_bench <model.moc3> [frames]\n");
    return 2;
  }
  const int frames = argc > 2 ? std::max(1, std::atoi(argv[2])) : 300;
  std::ifstream in(argv[1], std::ios::binary);
  const std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  if (bytes.empty()) {
    std::fprintf(stderr, "cannot read %s\n", argv[1]);
    return 2;
  }
  auto t = Clock::now();
  auto m = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
  moc::Error err;
  if (!moc::load_moc(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), moc::LoadOptions(), *m, err)) {
    std::fprintf(stderr, "cannot load %s: %s\n", argv[1], err.message.c_str());
    return 2;
  }
  const double load_ms = ms_since(t);
  const std::shared_ptr<const moc::Model> model = m;
  const auto& p = model->parameters;
  const int P = static_cast<int>(p.ids.size());
  std::size_t vertices = 0;
  for (int32_t v : model->meshes.vertex_count) vertices += static_cast<std::size_t>(v);
  std::printf("model: %s (%.1f MiB): %d parameters, %zu parts, %zu warps, %zu rotations, %zu art meshes, %zu vertices, "
              "%zu glues\n",
              argv[1], static_cast<double>(bytes.size()) / 1048576.0, P, model->parts.ids.size(),
              model->warps.rows.size(), model->rotations.base_angle.size(), model->meshes.ids.size(), vertices,
              model->glues.ids.size());
  std::printf("load: %.1f ms\n", load_ms);

  // Parameters with bindings, for the idle workload: 16 spread over them.
  std::vector<uint8_t> is_bound(static_cast<std::size_t>(P), 0);
  for (int32_t i : model->bindings.parameter) is_bound[static_cast<std::size_t>(i)] = 1;
  for (const auto* lists : {&model->blend_shapes.warp, &model->blend_shapes.mesh, &model->blend_shapes.rotation,
                            &model->blend_shapes.part, &model->blend_shapes.glue})
    for (const auto& list : *lists)
      for (const auto& b : list) is_bound[static_cast<std::size_t>(b.parameter)] = 1;
  std::vector<int> bound;
  for (int i = 0; i < P; i++)
    if (is_bound[static_cast<std::size_t>(i)]) bound.push_back(i);
  std::vector<int> idle;
  for (int k = 0; k < 16 && !bound.empty(); k++) idle.push_back(bound[static_cast<std::size_t>(k) * bound.size() / 16]);
  std::vector<int> all(static_cast<std::size_t>(P));
  for (int i = 0; i < P; i++) all[static_cast<std::size_t>(i)] = i;
  const Workload workloads[] = {{"still", {}}, {"one", bound, true}, {"idle", idle}, {"all", all}};

  t = Clock::now();
  eval::Instance probe(model);
  std::printf("instance (plan and first evaluation): %.1f ms\n\n", ms_since(t));
  std::printf("%-6s %10s %10s %8s %10s %10s %6s %s\n", "frame", "full ms", "incr. ms", "speedup", "deformers", "meshes",
              "glue", "identical frames");
  bool all_same = true;
  for (const auto& w : workloads) {
    eval::InstanceOptions full_options;
    full_options.incremental = false;
    eval::Instance full(model, full_options);
    eval::Instance incremental(model);
    double full_ms = 0, incremental_ms = 0;
    double deformers = 0, meshes = 0, glue = 0;
    int same = 0;
    for (int f = 0; f < frames; f++) {
      // Smooth motion inside each range, a different phase per parameter.
      auto move = [&](int i) {
        const auto k = static_cast<std::size_t>(i);
        const double u = 0.5 + 0.5 * std::sin(0.05 * f + 0.7 * i);
        const double v = p.min[k] + (p.max[k] - p.min[k]) * u;
        full.set_parameter(i, v);
        incremental.set_parameter(i, v);
      };
      if (w.one_at_a_time) {
        if (!w.params.empty()) move(w.params[static_cast<std::size_t>(f) % w.params.size()]);
      } else {
        for (int i : w.params) move(i);
      }
      auto s = Clock::now();
      full.evaluate();
      full_ms += ms_since(s);
      s = Clock::now();
      incremental.evaluate();
      incremental_ms += ms_since(s);
      deformers += incremental.last_work.deformers;
      meshes += incremental.last_work.meshes;
      glue += incremental.last_work.glue ? 1 : 0;
      if (same_outputs(full, incremental)) same++;
    }
    all_same = all_same && same == frames;
    std::printf("%-6s %10.3f %10.3f %7.1fx %10.1f %10.1f %5.0f%% %d/%d\n", w.name, full_ms / frames,
                incremental_ms / frames, full_ms / std::max(incremental_ms, 1e-9), deformers / frames, meshes / frames,
                100 * glue / frames, same, frames);
  }
  return all_same ? 0 : 1;
}

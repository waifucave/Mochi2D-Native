// Render benchmark: the reference renderer (src/render) drawing one model
// (tests/bench/model.ts makes a synthetic one of DeepSeek-chan's size) with
// a generated 2048 × 2048 texture, on 1, 2, 4, ... threads, at a few image
// sizes. Every frame moves 16 bound parameters as an idle motion does, and
// every thread count must give the same image bytes as one thread.
//
// usage: mochi2d_render_bench <model.moc3> [frames] [WxH ...] [threads=1,2,4]
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "core/eval/instance.hpp"
#include "core/moc/model.hpp"
#include "render/renderer.hpp"

using namespace mochi2d;
using Clock = std::chrono::steady_clock;

namespace {

double ms_since(Clock::time_point t) { return std::chrono::duration<double, std::milli>(Clock::now() - t).count(); }

uint64_t fnv1a(const uint8_t* p, std::size_t n) {
  uint64_t h = 1469598103934665603ULL;
  for (std::size_t i = 0; i < n; i++) h = (h ^ p[i]) * 1099511628211ULL;
  return h;
}

/** A 2048² straight-alpha texture: color ramps, a checker of alpha, some fully transparent cells. */
std::vector<uint8_t> make_texture(int n) {
  std::vector<uint8_t> px(static_cast<std::size_t>(n) * static_cast<std::size_t>(n) * 4);
  for (int y = 0; y < n; y++)
    for (int x = 0; x < n; x++) {
      uint8_t* p = &px[(static_cast<std::size_t>(y) * static_cast<std::size_t>(n) + static_cast<std::size_t>(x)) * 4];
      p[0] = static_cast<uint8_t>(x * 255 / (n - 1));
      p[1] = static_cast<uint8_t>(y * 255 / (n - 1));
      p[2] = static_cast<uint8_t>((x ^ y) & 255);
      const int cell = (x >> 6) + (y >> 6);
      p[3] = cell % 9 == 0 ? 0 : static_cast<uint8_t>(cell % 2 ? 255 : 128 + (x + y) % 128);
    }
  return px;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: mochi2d_render_bench <model.moc3> [frames] [WxH ...] [threads=1,2,4]\n");
    return 2;
  }
  const int frames = argc > 2 ? std::max(1, std::atoi(argv[2])) : 30;
  std::vector<std::pair<int, int>> sizes;
  std::vector<int> counts;
  for (int i = 3; i < argc; i++) {
    int w = 0, h = 0;
    if (std::strncmp(argv[i], "threads=", 8) == 0) {
      for (const char* q = argv[i] + 8; *q;) {
        char* end = nullptr;
        const long n = std::strtol(q, &end, 10);
        if (end == q) break;
        if (n >= 1 && n <= 64) counts.push_back(static_cast<int>(n));
        q = *end == ',' ? end + 1 : end;
      }
    } else if (std::sscanf(argv[i], "%dx%d", &w, &h) == 2 && w > 0 && h > 0) {
      sizes.push_back({w, h});
    }
  }
  if (sizes.empty()) sizes = {{512, 1024}, {1024, 2048}};
  std::ifstream in(argv[1], std::ios::binary);
  const std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  if (bytes.empty()) {
    std::fprintf(stderr, "cannot read %s\n", argv[1]);
    return 2;
  }
  auto m = std::allocate_shared<moc::Model>(Allocator<moc::Model>());
  moc::Error err;
  if (!moc::load_moc(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), moc::LoadOptions(), *m, err)) {
    std::fprintf(stderr, "cannot load %s: %s\n", argv[1], err.message.c_str());
    return 2;
  }
  const std::shared_ptr<const moc::Model> model = m;
  const auto& p = model->parameters;
  const int P = static_cast<int>(p.ids.size());
  std::size_t triangles = 0;
  for (std::size_t d = 0; d < model->meshes.ids.size(); d++) triangles += eval::output_triangles(*model, static_cast<int>(d)).size() / 3;
  constexpr int kTexture = 2048;
  const std::vector<uint8_t> pixels = make_texture(kTexture);
  auto t = Clock::now();
  auto tex = std::allocate_shared<render::Texture>(Allocator<render::Texture>());
  render::prepare_texture(pixels.data(), kTexture, kTexture, *tex);
  const double prepare_ms = ms_since(t);
  std::printf("render: %zu art meshes, %zu triangles, one %d x %d texture (prepared in %.1f ms), %d frames per run\n",
              model->meshes.ids.size(), triangles, kTexture, kTexture, prepare_ms, frames);

  // The idle workload of the evaluation benchmark: 16 parameters spread over the bound ones.
  std::vector<uint8_t> is_bound(static_cast<std::size_t>(P), 0);
  for (int32_t i : model->bindings.parameter) is_bound[static_cast<std::size_t>(i)] = 1;
  std::vector<int> bound;
  for (int i = 0; i < P; i++)
    if (is_bound[static_cast<std::size_t>(i)]) bound.push_back(i);
  std::vector<int> idle;
  for (int k = 0; k < 16 && !bound.empty(); k++) idle.push_back(bound[static_cast<std::size_t>(k) * bound.size() / 16]);

  const int hardware = render::Workers::hardware();
  if (counts.empty()) {
    counts = {1, 2, 4};
    if (hardware > 4) counts.push_back(hardware);
  }
  if (counts.front() != 1) counts.insert(counts.begin(), 1);
  std::printf("hardware concurrency: %d\n\n", hardware);
  std::printf("%-11s %7s %10s %8s %12s %7s %s\n", "image", "threads", "ms/frame", "speedup", "fragments", "masks",
              "identical frames");
  bool all_same = true;
  for (const auto& [w, h] : sizes) {
    std::vector<uint64_t> reference;
    double one_ms = 0;
    for (int threads : counts) {
      Vector<std::shared_ptr<const render::Texture>> textures;
      textures.push_back(tex);
      render::Renderer renderer(model, std::move(textures));
      renderer.set_threads(threads);
      if (renderer.thread_count() != threads) {
        std::printf("%-11s %7d (only %d threads available)\n", "", threads, renderer.thread_count());
        continue;
      }
      eval::Instance inst(model);
      render::FrameOptions frame;
      frame.framing = render::frame_image(model->canvas, w, h);
      render::Image image;
      double ms = 0;
      int same = 0;
      uint64_t fragments = 0;
      uint32_t masks = 0;
      for (int f = 0; f < frames; f++) {
        for (int i : idle) {
          const auto k = static_cast<std::size_t>(i);
          inst.set_parameter(i, p.min[k] + (p.max[k] - p.min[k]) * (0.5 + 0.5 * std::sin(0.05 * f + 0.7 * i)));
        }
        inst.evaluate();
        const auto s = Clock::now();
        renderer.draw(inst, frame, image);
        ms += ms_since(s);
        const uint64_t hash = fnv1a(image.rgba.data(), image.rgba.size());
        if (threads == 1) reference.push_back(hash);
        if (hash == reference[static_cast<std::size_t>(f)]) same++;
        fragments += renderer.stats().fragments;
        masks += renderer.stats().mask_builds;
      }
      if (threads == 1) one_ms = ms;
      all_same = all_same && same == frames;
      char image_size[32];
      std::snprintf(image_size, sizeof image_size, "%dx%d", w, h);
      std::printf("%-11s %7d %10.2f %7.2fx %12.0f %7.1f %d/%d\n", image_size, threads, ms / frames, one_ms / ms,
                  static_cast<double>(fragments) / frames, static_cast<double>(masks) / frames, same, frames);
    }
  }
  return all_same ? 0 : 1;
}

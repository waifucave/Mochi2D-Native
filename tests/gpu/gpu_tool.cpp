#include "gpu/gpu_tool.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>

#include "support/image_compare.hpp"

namespace fs = std::filesystem;

namespace mochi2d::test {

namespace {

struct Args {
  std::vector<std::string> positional;
  std::string out, models, device;
  /** The reference configuration's cap by default (conformance runs); 0 (`device`) the device's limit. */
  int max_texture_size = M2D_MAX_TEXTURE_SIZE;
  double max_rms = -1, max_diff = -1;
};

void usage(const GpuTool& t) {
  std::cerr << "usage:\n"
            << "  " << t.tool << " info [--device <name>]\n"
            << "  " << t.tool << " render <scenario.json | folder>... --out <folder> [--models <folder>]\n"
            << "      [--max-texture-size N | device] [--device <name>]\n"
            << "  " << t.tool << " capi <model.moc3> <texture.png>... [--device <name>]\n"
            << "  " << t.tool << " compare <folder a> <folder b> [--max-rms <x>] [--max-diff <n>]\n";
}

double rms_of(const std::vector<uint8_t>& a, const std::vector<uint8_t>& b) {
  if (a.size() != b.size() || a.empty()) return 1e9;
  double sum = 0;
  for (std::size_t i = 0; i < a.size(); i++) {
    const double d = static_cast<double>(a[i]) - static_cast<double>(b[i]);
    sum += d * d;
  }
  return std::sqrt(sum / static_cast<double>(a.size()));
}

std::string code(const GpuTool& t, const char* what) { return std::string(t.prefix) + "-" + what; }

/** The C API path: create, two frames (a change between them), stats, the texture limit, an update, refusals. */
int capi(const Args& a, GpuTool& t) {
  if (a.positional.empty()) {
    usage(t);
    return 2;
  }
  String bytes;
  if (!read_file(fs::u8path(a.positional[0]), bytes)) return 1;
  int failures = 0;
  const auto check = [&](bool ok, const char* what) {
    if (!ok) {
      std::cout << "FAIL " << what << "\n";
      failures++;
    }
  };
  m2d_error err;
  m2d_model* model = nullptr;
  if (m2d_model_load(bytes.data(), bytes.size(), 0, nullptr, &model, &err) != M2D_OK) return 1;
  std::vector<m2d_texture*> textures;
  std::vector<std::vector<uint8_t>> images;
  std::vector<std::pair<int, int>> sizes;
  for (std::size_t i = 1; i < a.positional.size(); i++) {
    String png, why;
    Vector<uint8_t> rgba;
    int w = 0, hh = 0;
    m2d_texture* tex = nullptr;
    if (!read_file(fs::u8path(a.positional[i]), png) || !conformance::decode_png(png, w, hh, rgba, why) ||
        m2d_texture_create(rgba.data(), w, hh, 0, nullptr, &tex, &err) != M2D_OK)
      return 1;
    textures.push_back(tex);
    images.emplace_back(rgba.begin(), rgba.end());
    sizes.emplace_back(w, hh);
  }
  const auto count = static_cast<int32_t>(textures.size());
  check(t.available() == 1, "the backend is in the library");
  void* gpu = nullptr;
  check(t.create(model, textures.data(), count, 0, 1, &gpu, &err) == M2D_OK, "create");
  m2d_renderer* sw = nullptr;
  check(m2d_renderer_create(model, textures.data(), count, nullptr, &sw, &err) == M2D_OK, "m2d_renderer_create");
  m2d_instance* inst = nullptr;
  check(m2d_instance_create(model, &inst, &err) == M2D_OK, "m2d_instance_create");
  if (!gpu || !sw || !inst) {
    std::cout << "create: " << err.message << "\n";
    return 1;
  }
  // The texture limit: the device's by default, M2D_MAX_TEXTURE_SIZE (8192, the reference configuration's) on request.
  {
    check(t.max_texture_size(gpu) == t.device_limit, "the default limit is the device's");
    std::vector<uint8_t> wide(4 * 9000 * 2, 200);
    m2d_texture* big = nullptr;
    check(m2d_texture_create(wide.data(), 9000, 2, 0, nullptr, &big, &err) == M2D_OK, "a 9000-wide texture");
    void* taken = nullptr;
    const m2d_status st = t.create(model, &big, 1, 0, 1, &taken, &err);
    check(t.device_limit >= 9000 ? st == M2D_OK : code(t, "texture-size") == err.code, "the device's limit decides");
    if (taken) t.destroy(taken);
    void* refused = nullptr;
    check(t.create(model, &big, 1, M2D_MAX_TEXTURE_SIZE, 1, &refused, &err) == M2D_INTERNAL_ERROR &&
              code(t, "texture-size") == err.code && refused == nullptr,
          "M2D_MAX_TEXTURE_SIZE caps it");
    const std::string refusal = err.message;
    void* capped = nullptr;
    check(t.create(model, nullptr, 0, M2D_MAX_TEXTURE_SIZE, 1, &capped, &err) == M2D_OK &&
              t.max_texture_size(capped) == std::min(t.device_limit, M2D_MAX_TEXTURE_SIZE),
          "the capped limit");
    if (capped) t.destroy(capped);
    std::cout << "texture limit: the device's " << t.device_limit << "; 9000 wide "
              << (st == M2D_OK ? "taken" : "refused") << ", refused under the cap: " << refusal << "\n";
    m2d_texture_destroy(big);
  }
  const int W = 160, H = 120;
  m2d_render_frame frame;
  m2d_render_frame_default(&frame);
  frame.background[0] = 0.25;
  frame.background[3] = 1;
  std::vector<uint8_t> b_px(static_cast<std::size_t>(W * H * 4));
  for (int pass = 0; pass < 2; pass++) {
    if (pass == 1 && m2d_model_parameter_count(model) > 0) {
      float range[3];
      m2d_model_parameter_range(model, 0, range);
      m2d_instance_set_parameter(inst, 0, range[1]);
    }
    check(m2d_instance_evaluate(inst, &err) == M2D_OK, "m2d_instance_evaluate");
    std::vector<uint8_t> a_px;
    check(t.draw(gpu, inst, &frame, W, H, a_px, &err) == M2D_OK, "draw");
    check(m2d_renderer_draw(sw, inst, &frame, W, H, b_px.data(), 0, &err) == M2D_OK, "m2d_renderer_draw");
    const double rms = rms_of(a_px, b_px);
    m2d_render_stats vs, ss;
    t.stats(gpu, &vs);
    m2d_renderer_stats(sw, &ss);
    std::cout << "frame " << pass << ": RMS " << rms << " against the reference renderer; drawn " << vs.drawn
              << ", masked " << vs.masked << ", layers " << vs.layers << "\n";
    check(rms <= 3.0, "the frame differs from the reference renderer's beyond RMS 3");
    check(vs.drawn == ss.drawn && vs.masked == ss.masked && vs.mask_builds == ss.mask_builds &&
              vs.layers == ss.layers && vs.advanced_draws == ss.advanced_draws && vs.layered == ss.layered,
          "the statistics differ from the reference renderer's");
  }
  // The bottom row first (flip_y 0): the same picture upside down (edges may round the other way).
  {
    void* bottom = nullptr;
    check(t.create(model, textures.data(), count, 0, 0, &bottom, &err) == M2D_OK, "create with flip_y 0");
    std::vector<uint8_t> up, down;
    check(bottom && t.draw(gpu, inst, &frame, W, H, up, &err) == M2D_OK &&
              t.draw(bottom, inst, &frame, W, H, down, &err) == M2D_OK,
          "draws in both orientations");
    std::vector<uint8_t> flipped(down.size());
    for (int y = 0; y < H && down.size() == flipped.size() && !down.empty(); y++)
      std::memcpy(&flipped[static_cast<std::size_t>(y * W * 4)], &down[static_cast<std::size_t>((H - 1 - y) * W * 4)],
                  static_cast<std::size_t>(W * 4));
    const double rms = rms_of(up, flipped);
    std::cout << "flip_y 0: RMS " << rms << " against flip_y 1, rows reversed\n";
    check(rms <= 3.0, "the bottom-row-first frame is not the top-row-first one upside down");
    if (bottom) t.destroy(bottom);
  }
  // A texture updated in place (0.14.0) draws as a renderer made with the new image, byte for byte.
  if (!images.empty()) {
    const int tw = sizes[0].first, th = sizes[0].second;
    const int pw = std::max(1, tw / 2), ph = std::max(1, th / 3), px = tw / 4, py = th / 4;
    std::vector<uint8_t> patch(static_cast<std::size_t>(4 * pw * ph));
    for (std::size_t i = 0; i < patch.size(); i++) patch[i] = static_cast<uint8_t>((i * 53 + 17) & 255);
    std::vector<uint8_t> patched = images[0];
    for (int j = 0; j < ph; j++)
      std::memcpy(&patched[static_cast<std::size_t>(((py + j) * tw + px) * 4)],
                  &patch[static_cast<std::size_t>(j * pw * 4)], static_cast<std::size_t>(pw * 4));
    std::vector<m2d_texture*> fresh_textures;
    for (std::size_t i = 0; i < images.size(); i++) {
      m2d_texture* tex = nullptr;
      m2d_texture_create(i == 0 ? patched.data() : images[i].data(), sizes[i].first, sizes[i].second, 0, nullptr,
                         &tex, &err);
      fresh_textures.push_back(tex);
    }
    void* fresh = nullptr;
    check(t.create(model, fresh_textures.data(), count, 0, 1, &fresh, &err) == M2D_OK,
          "a renderer with the patched image");
    for (m2d_texture* tex : fresh_textures) m2d_texture_destroy(tex);
    const auto grab = [&](void* r) {
      std::vector<uint8_t> out;
      check(r && t.draw(r, inst, &frame, W, H, out, &err) == M2D_OK, "a draw");
      return out;
    };
    const auto before = grab(gpu);
    check(t.update_texture(gpu, 0, patch.data(), pw, ph, 0, px, py, &err) == M2D_OK, "update_texture");
    const auto updated = grab(gpu), made = grab(fresh);
    check(updated == made, "a texture updated in place draws as one made with the new image");
    check(updated != before, "the update changes the picture");
    check(t.update_texture(gpu, 0, patch.data(), pw, ph, 0, tw - pw + 1, 0, &err) == M2D_INVALID_ARGUMENT,
          "a region that does not fit is refused");
    std::cout << "texture update: " << pw << "×" << ph << " at (" << px << ", " << py << "), "
              << (updated == made ? "the same bytes" : "DIFFERENT") << " as a renderer made with it\n";
    if (fresh) t.destroy(fresh);
  }
  check(t.draw_without_target(gpu, inst, &frame, &err) == M2D_INVALID_ARGUMENT, "a draw without a target is refused");
  if (t.extra) {
    std::string message;
    const bool held = t.extra(model, message);
    std::cout << message << "\n";
    check(held, "the backend's own checks");
  }
  for (m2d_texture* tex : textures) m2d_texture_destroy(tex);
  t.destroy(gpu);
  m2d_renderer_destroy(sw);
  m2d_instance_destroy(inst);
  m2d_model_destroy(model);
  std::cout << (failures ? "FAILED" : "ok") << "\n";
  return failures ? 1 : 0;
}

}  // namespace

int gpu_tool_main(int argc, char** argv, GpuTool& t,
                  const std::function<bool(GpuTool&, const std::string& device, std::string& error)>& open) {
  if (argc < 2) {
    usage(t);
    return 2;
  }
  const std::string cmd = argv[1];
  Args a;
  for (int i = 2; i < argc; i++) {
    const std::string s = argv[i];
    const auto value = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (s == "--out") {
      a.out = value();
    } else if (s == "--models") {
      a.models = value();
    } else if (s == "--device") {
      a.device = value();
    } else if (s == "--max-texture-size") {
      const std::string v = value();
      a.max_texture_size = v == "device" ? 0 : std::atoi(v.c_str());
    } else if (s == "--max-rms") {
      a.max_rms = std::atof(value().c_str());
    } else if (s == "--max-diff") {
      a.max_diff = std::atof(value().c_str());
    } else {
      a.positional.push_back(s);
    }
  }
  if (cmd == "compare") {
    if (a.positional.size() != 2) {
      usage(t);
      return 2;
    }
    return compare_folders(a.positional[0], a.positional[1], a.max_rms, a.max_diff);
  }
  std::string why;
  if (!open(t, a.device, why)) {
    std::cerr << t.tool << ": " << why << " (skipped)\n";
    return 77;
  }
  if (cmd == "info") {
    std::cout << t.device << "\n";
    return 0;
  }
  if (cmd == "capi") return capi(a, t);
  if (cmd != "render" || a.out.empty() || a.positional.empty()) {
    usage(t);
    return 2;
  }
  conformance::RenderOptions options;
  const int cap = a.max_texture_size;
  options.drawer = [&](std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const render::Texture>> textures,
                       String& error) { return t.drawer(std::move(model), std::move(textures), cap, error); };
  // The runner's TextureTooLarge limit: the device's, capped as the backend is.
  options.max_texture_size = cap > 0 ? std::min(t.device_limit, cap) : t.device_limit;
  conformance::ModelCache cache(conformance::model_search_dirs(fs::current_path(), fs::u8path(a.models)));
  Vector<String> inputs;
  for (const auto& p : a.positional) inputs.push_back(String(p.c_str()));
  std::cerr << "device: " << t.device << "\n";
  const auto summary = conformance::run_render(inputs, fs::u8path(a.out), cache, conformance::producer_id(), options,
                                               [](const String& line) { std::cerr << line.c_str() << "\n"; });
  std::cout << summary.total << " scenarios, " << summary.failed << " failed\n";
  return summary.total == 0 || summary.failed ? 1 : 0;
}

}  // namespace mochi2d::test

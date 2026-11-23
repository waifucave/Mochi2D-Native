#include "conformance/render.hpp"

#include <algorithm>
#include <charconv>
#include <chrono>
#include <initializer_list>
#include <cstdio>
#include <cstring>

#include "core/snapshot.hpp"
#include "framework/tints.hpp"
#include "util/json.hpp"

#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wsign-conversion"
#pragma GCC diagnostic ignored "-Wconversion"
#pragma GCC diagnostic ignored "-Wcast-qual"
#pragma GCC diagnostic ignored "-Wdouble-promotion"
#pragma GCC diagnostic ignored "-Wshadow"
#pragma GCC diagnostic ignored "-Wunused-function"
#pragma GCC diagnostic ignored "-Wimplicit-fallthrough"
#pragma GCC diagnostic ignored "-Wold-style-cast"
#pragma GCC diagnostic ignored "-Wuseless-cast"
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#endif
#define STBI_ONLY_PNG
#define STBI_NO_STDIO
#define STBI_NO_LINEAR
#define STBI_NO_HDR
#define STBI_ASSERT(x) ((void)0)
#define STB_IMAGE_STATIC
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

namespace fs = std::filesystem;

namespace mochi2d::conformance {

using json::Value;

namespace {

uint32_t be32(const String& b, std::size_t o) {
  return static_cast<uint32_t>(static_cast<uint8_t>(b[o])) << 24 | static_cast<uint32_t>(static_cast<uint8_t>(b[o + 1])) << 16 |
         static_cast<uint32_t>(static_cast<uint8_t>(b[o + 2])) << 8 | static_cast<uint32_t>(static_cast<uint8_t>(b[o + 3]));
}

/** Bits per pixel of a PNG color type and bit depth; 0 for a combination PNG does not have. */
uint32_t png_bits_per_pixel(uint8_t color_type, uint8_t depth) {
  auto in = [depth](std::initializer_list<uint8_t> list) { return std::find(list.begin(), list.end(), depth) != list.end(); };
  switch (color_type) {
    case 0: return in({1, 2, 4, 8, 16}) ? depth : 0u;
    case 2: return in({8, 16}) ? 3u * depth : 0u;
    case 3: return in({1, 2, 4, 8}) ? depth : 0u;
    case 4: return in({8, 16}) ? 2u * depth : 0u;
    case 6: return in({8, 16}) ? 4u * depth : 0u;
    default: return 0;
  }
}

String count_text(uint64_t n) {
  char buf[24];
  const auto r = std::to_chars(buf, buf + sizeof buf, n);
  return String(buf, r.ptr);
}

}  // namespace

bool read_png_header(const String& b, PngHeader& out, String& error) {
  static const unsigned char signature[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
  if (b.size() < 8 || std::memcmp(b.data(), signature, 8) != 0) {
    error = "not a PNG file, or its header is damaged";
    return false;
  }
  if (b.size() < 33 || be32(b, 8) != 13 || b.compare(12, 4, "IHDR") != 0 || be32(b, 16) == 0 || be32(b, 20) == 0) {
    error = "damaged PNG header";
    return false;
  }
  const uint32_t width = be32(b, 16), height = be32(b, 20);
  const auto depth = static_cast<uint8_t>(b[24]), color = static_cast<uint8_t>(b[25]);
  const uint32_t bpp = png_bits_per_pixel(color, depth);
  if (bpp == 0) {
    error = "damaged PNG header (color type " + to_str(color) + ", bit depth " + to_str(depth) + ")";
    return false;
  }
  // The IDAT data, walking the chunks (to IEND or the end of the bytes).
  uint64_t data = 0;
  for (uint64_t o = 8; o + 8 <= b.size();) {
    const uint64_t len = be32(b, static_cast<std::size_t>(o));
    const uint64_t avail = std::min<uint64_t>(len, b.size() - (o + 8));
    if (b.compare(static_cast<std::size_t>(o + 4), 4, "IDAT") == 0) data += avail;
    if (b.compare(static_cast<std::size_t>(o + 4), 4, "IEND") == 0 || avail < len) break;
    o += 12 + len;
  }
  // The filtered image inflates from the IDAT data, at most about 1,032:1.
  const uint64_t raw = static_cast<uint64_t>(height) * (1 + (static_cast<uint64_t>(width) * bpp + 7) / 8);
  out.width = width;
  out.height = height;
  out.min_bytes = b.size() - data + (raw > 64 ? (raw - 64 + 1031) / 1032 : 0);
  if (b.size() < out.min_bytes) {
    error = "declares " + count_text(width) + "×" + count_text(height) + " pixels but is " + count_text(b.size()) +
            " bytes, too few for a PNG file of that size (damaged or crafted)";
    return false;
  }
  return true;
}

bool decode_png(const String& bytes, int& width, int& height, Vector<uint8_t>& rgba, String& error,
                const PngLimits& limits, PngRefusal* refusal) {
  if (refusal) *refusal = PngRefusal::None;
  PngHeader header;
  if (!read_png_header(bytes, header, error)) {
    if (refusal) *refusal = PngRefusal::Format;
    return false;
  }
  const uint64_t pixels = static_cast<uint64_t>(header.width) * header.height;
  const uint32_t side = std::max(header.width, header.height);
  if (side > limits.max_side || pixels > limits.max_pixels) {
    // TextureLimitError's wording; nothing is decoded.
    error = side > limits.max_side
                ? "declares " + count_text(header.width) + "×" + count_text(header.height) + " pixels, more than the " +
                      count_text(limits.max_side) + " allowed on a side"
                : "declares " + count_text(header.width) + "×" + count_text(header.height) + " = " + count_text(pixels) +
                      " pixels, more than the " + count_text(limits.max_pixels) + " allowed for one texture";
    if (refusal) *refusal = PngRefusal::Limit;
    return false;
  }
  int w = 0, h = 0, comp = 0;
  const auto* data = reinterpret_cast<const stbi_uc*>(bytes.data());
  const int len = static_cast<int>(std::min<std::size_t>(bytes.size(), 0x7fffffff));
  stbi_uc* px = stbi_load_from_memory(data, len, &w, &h, &comp, 4);
  if (!px) {
    error = String("cannot decode the image (") + stbi_failure_reason() + ")";
    return false;
  }
  width = w;
  height = h;
  rgba.assign(px, px + static_cast<std::size_t>(w) * static_cast<std::size_t>(h) * 4);
  stbi_image_free(px);
  return true;
}

namespace {

uint32_t crc_table[256];

void init_crc() {
  for (uint32_t n = 0; n < 256; n++) {
    uint32_t c = n;
    for (int k = 0; k < 8; k++) c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1;
    crc_table[n] = c;
  }
}

uint32_t crc32(const uint8_t* p, std::size_t n, uint32_t c = 0xffffffffu) {
  for (std::size_t i = 0; i < n; i++) c = crc_table[(c ^ p[i]) & 0xff] ^ (c >> 8);
  return c;
}

void put32(String& out, uint32_t v) {
  for (int s = 24; s >= 0; s -= 8) out.push_back(static_cast<char>((v >> s) & 0xff));
}

void chunk(String& out, const char* type, const String& data) {
  put32(out, static_cast<uint32_t>(data.size()));
  String body(type, 4);
  body += data;
  out += body;
  put32(out, crc32(reinterpret_cast<const uint8_t*>(body.data()), body.size()) ^ 0xffffffffu);
}

}  // namespace

String encode_png(int width, int height, const uint8_t* rgba) {
  static const bool ready = (init_crc(), true);
  (void)ready;
  String out("\x89PNG\r\n\x1a\n", 8);
  String ihdr;
  put32(ihdr, static_cast<uint32_t>(width));
  put32(ihdr, static_cast<uint32_t>(height));
  ihdr += String("\x08\x06\x00\x00\x00", 5);  // 8 bits, RGBA, deflate, no filter method, no interlace
  chunk(out, "IHDR", ihdr);
  // The raw scanlines (filter 0 each) in stored deflate blocks.
  String raw;
  const std::size_t row = static_cast<std::size_t>(width) * 4;
  raw.reserve((row + 1) * static_cast<std::size_t>(height));
  for (int y = 0; y < height; y++) {
    raw.push_back('\0');
    raw.append(reinterpret_cast<const char*>(rgba + row * static_cast<std::size_t>(y)), row);
  }
  String z("\x78\x01", 2);
  std::size_t at = 0;
  do {
    const std::size_t n = std::min<std::size_t>(65535, raw.size() - at);
    const bool last = at + n == raw.size();
    z.push_back(last ? '\x01' : '\x00');
    z.push_back(static_cast<char>(n & 0xff));
    z.push_back(static_cast<char>(n >> 8));
    z.push_back(static_cast<char>(~n & 0xff));
    z.push_back(static_cast<char>((~n >> 8) & 0xff));
    z.append(raw, at, n);
    at += n;
  } while (at < raw.size());
  uint32_t a = 1, b = 0;
  for (unsigned char c : raw) {
    a = (a + c) % 65521;
    b = (b + a) % 65521;
  }
  put32(z, (b << 16) | a);
  chunk(out, "IDAT", z);
  chunk(out, "IEND", String());
  return out;
}

namespace {

bool write_file(const fs::path& p, const String& text) {
  std::FILE* f = std::fopen(p.u8string().c_str(), "wb");
  if (!f) return false;
  const bool ok = std::fwrite(text.data(), 1, text.size(), f) == text.size();
  return std::fclose(f) == 0 && ok;
}

/** The reference renderer as a drawer. */
class SoftwareDrawer : public Drawer {
 public:
  SoftwareDrawer(std::shared_ptr<const moc::Model> model, Vector<std::shared_ptr<const render::Texture>> textures,
                 const RenderOptions& options)
      : r_(std::move(model), std::move(textures), options.mask_size) {
    r_.set_threads(options.threads);
  }
  bool draw(const eval::Instance& instance, const render::FrameOptions& frame, render::Image& out, String&) override {
    r_.draw(instance, frame, out);
    return true;
  }
  const render::FrameStats& stats() const override { return r_.stats(); }
  int mask_size() const override { return r_.mask_size(); }
  int offscreen_mask_size() const override { return r_.offscreen_mask_size(); }
  String name() const override { return "mochi2d-native (software rasterizer)"; }

 private:
  render::Renderer r_;
};

/** The model of the latest scenarios, with its prepared textures and drawer. */
struct Loaded {
  String key;
  LoadedModel model;
  std::unique_ptr<Drawer> renderer;
};

}  // namespace

RunSummary run_render(const Vector<String>& inputs, const fs::path& out_dir, ModelCache& models,
                      std::string_view producer, const RenderOptions& options,
                      const std::function<void(const String&)>& log) {
  std::error_code ec;
  fs::create_directories(out_dir, ec);
  Vector<ScenarioFile> items = read_scenario_files(inputs);
  // Scenarios on the same model render together, so its textures are decoded once.
  Vector<std::size_t> order(items.size());
  for (std::size_t i = 0; i < order.size(); i++) order[i] = i;
  stable_sort(order, [&](std::size_t a, std::size_t b) {
    const String& ma = items[a].kind == "invalid" ? String() : items[a].model;
    const String& mb = items[b].kind == "invalid" ? String() : items[b].model;
    return ma < mb;
  });
  RunSummary summary;
  summary.total = items.size();
  Loaded cache;
  for (std::size_t idx : order) {
    const ScenarioFile& item = items[idx];
    const auto t0 = std::chrono::steady_clock::now();
    Value outcome = Value::object();
    outcome.set("format", "mochi2d-render/0");
    outcome.set("scenario", item.id);
    outcome.set("producer", String(producer));
    outcome.set("error", nullptr);
    outcome.set("png", nullptr);
    ErrorInfo error;
    auto fail = [&](const char* kind, const String& message) {
      error.kind = kind;
      error.message = message;
    };
    Scenario sc;
    String message;
    if (item.kind == "invalid") {
      fail("InvalidScenario", item.error);
    } else if (item.kind != "static" || !parse_scenario(item.json, sc, message)) {
      fail("InvalidScenario", message.empty() ? String("not a static scenario with a render block") : message);
    } else if (sc.model.empty()) {
      fail("InvalidScenario", "built-in scenes are not supported by mochi2d-native");
    }
    if (error.kind.empty() && cache.key != sc.model) {
      // A new model: its files, its textures (full resolution, exact preparation), a renderer.
      cache = Loaded();
      ErrorInfo load_error;
      LoadedModel loaded;
      if (!models.load(sc.model, loaded, load_error)) {
        error = load_error;
      } else {
        Vector<std::shared_ptr<const render::Texture>> textures;
        uint64_t total_pixels = 0;
        for (const auto& path : loaded.settings.textures) {
          String bytes;
          if (!loaded.read || !loaded.read(path, bytes)) {
            if (loaded.read_limit && !loaded.read_limit->empty()) fail("FileLimitError", *loaded.read_limit);
            else fail("ModelLoadError", "File not found: \"" + path + "\"");
            break;
          }
          // The header first: a damaged or crafted file, or one past a cap, is refused before decoding.
          PngHeader header;
          String why;
          if (!read_png_header(bytes, header, why)) {
            fail("TextureFormatError", "\"" + path + "\": " + why);
            break;
          }
          const PngLimits caps;
          const uint64_t pixels = static_cast<uint64_t>(header.width) * header.height;
          if (std::max(header.width, header.height) <= caps.max_side && pixels <= caps.max_pixels &&
              total_pixels + pixels > caps.max_total_pixels) {
            fail("TextureLimitError", "\"" + path + "\" (" + to_str(static_cast<long long>(header.width)) + "×" +
                                          to_str(static_cast<long long>(header.height)) +
                                          ") takes the model's textures to " +
                                          to_str(static_cast<long long>(total_pixels + pixels)) +
                                          " pixels, more than the " +
                                          to_str(static_cast<long long>(caps.max_total_pixels)) + " allowed in total");
            break;
          }
          total_pixels += pixels;
          int w = static_cast<int>(std::min<uint32_t>(header.width, 0x7fffffff));
          int h = static_cast<int>(std::min<uint32_t>(header.height, 0x7fffffff));
          if (std::max(header.width, header.height) <= caps.max_side &&
              (w > options.max_texture_size || h > options.max_texture_size)) {
            fail("TextureTooLarge", path + " is " + std::to_string(w).c_str() + "×" + std::to_string(h).c_str() +
                                        ", larger than the maximum texture size " +
                                        std::to_string(options.max_texture_size).c_str());
            break;
          }
          Vector<uint8_t> rgba;
          PngRefusal refusal = PngRefusal::None;
          if (!decode_png(bytes, w, h, rgba, why, caps, &refusal)) {
            if (refusal == PngRefusal::Limit) fail("TextureLimitError", "\"" + path + "\" " + why);
            else fail("ModelLoadError", path + ": " + why);
            break;
          }
          auto tex = std::allocate_shared<render::Texture>(Allocator<render::Texture>());
          render::prepare_texture(rgba.data(), w, h, *tex);
          textures.push_back(std::move(tex));
        }
        if (error.kind.empty()) {
          String why;
          std::unique_ptr<Drawer> drawer =
              options.drawer ? options.drawer(loaded.model, std::move(textures), why)
                             : std::make_unique<SoftwareDrawer>(loaded.model, std::move(textures), options);
          if (!drawer) {
            fail("Error", why);
          } else {
            cache.key = sc.model;
            cache.model = loaded;
            cache.renderer = std::move(drawer);
          }
        }
      }
    }
    if (error.kind.empty()) {
      // A fresh instance per scenario: the creation-time evaluation, then the scenario's inputs.
      eval::Instance inst(cache.model.model, models.instance_options);
      apply_request(inst, sc.request);
      inst.evaluate();
      render::View view{sc.render.view_x, sc.render.view_y, sc.render.view_pixels_per_unit};
      render::FrameOptions frame;
      frame.framing = render::frame_image(cache.model.model->canvas, sc.render.width, sc.render.height,
                                          sc.render.has_view ? &view : nullptr);
      for (int k = 0; k < 4; k++) frame.background[static_cast<std::size_t>(k)] = sc.render.background[k];
      // x-tints, as Mochi2D's harness takes a request's tints (unknown IDs ignored, with a note).
      framework::Tints tints;
      if (!sc.tints.empty()) {
        const auto& ids = cache.model.model->meshes.ids;
        tints.resize(ids.size());
        for (const auto& [id, rgba] : sc.tints) {
          std::size_t d = 0;
          while (d < ids.size() && ids[d] != id) d++;
          if (d == ids.size()) continue;
          double v[4] = {1, 1, 1, 1};
          for (std::size_t k = 0; k < 4 && k < rgba.size(); k++) v[k] = rgba[k];
          tints.set(static_cast<int>(d), v, 4);
        }
        frame.tints = tints.active();
      }
      render::Image image;
      String why;
      const String png = item.id + ".png";
      if (!cache.renderer->draw(inst, frame, image, why)) {
        fail("Error", why);
      } else if (!write_file(out_dir / fs::u8path(to_std(png)), encode_png(image.width, image.height, image.rgba.data()))) {
        fail("Error", "cannot write " + png);
      } else {
        outcome.set("png", png);
        outcome.set("alpha", "premultiplied");
        outcome.set("width", image.width);
        outcome.set("height", image.height);
        outcome.set("renderer", cache.renderer->name());
        outcome.set("pixelsPerUnit", frame.framing.k);
        Value center = Value::array();
        center.push(frame.framing.center_x);
        center.push(frame.framing.center_y);
        outcome.set("center", std::move(center));
        Value masks = Value::object();
        masks.set("mode", "per-drawable");
        masks.set("size", cache.renderer->mask_size());
        masks.set("offscreenSize", cache.renderer->offscreen_mask_size());
        masks.set("meshes", "all");
        outcome.set("masks", std::move(masks));
        const auto& st = cache.renderer->stats();
        Value stats = Value::object();
        stats.set("pipeline", st.layered ? "layered" : "direct");
        stats.set("masks", "per-drawable");
        stats.set("drawn", st.drawn);
        stats.set("masked", st.masked);
        stats.set("maskBuilds", st.mask_builds);
        stats.set("maskMeshDraws", st.mask_mesh_draws);
        stats.set("layers", st.layers);
        stats.set("advancedDraws", st.advanced_draws);
        stats.set("fragments", static_cast<double>(st.fragments));
        outcome.set("stats", std::move(stats));
        if (!cache.model.model->load_warnings.empty()) {
          Value notes = Value::array();
          for (const auto& w : cache.model.model->load_warnings) notes.push(w);
          outcome.set("notes", std::move(notes));
        }
      }
    }
    if (!error.kind.empty()) {
      Value e = Value::object();
      e.set("kind", error.kind);
      e.set("message", error.message);
      outcome.set("error", std::move(e));
      summary.failed++;
    }
    const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    outcome.set("milliseconds", static_cast<double>(static_cast<long long>(ms + 0.5)));
    write_file(out_dir / fs::u8path(to_std(item.id + ".render.json")), json::write_pretty(outcome) + "\n");
    if (log)
      log((error.kind.empty() ? "ok   " : "FAIL ") + item.id +
          (error.kind.empty() ? " → " + item.id + ".png" : " — " + error.kind + ": " + error.message));
  }
  return summary;
}

}  // namespace mochi2d::conformance

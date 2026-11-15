// What the Metal and Direct3D 11 backends' test tools share: the command
// line (info, render, capi, compare), the runner's texture cap, and the C
// API checks (two frames against the reference renderer, the texture limit,
// a texture update in place, the bottom-row-first orientation, refusals).
// Each tool opens its host (a device, a target it reads back) and fills a
// GpuTool with it.
//
//   <tool> info [--device <name>]
//   <tool> render <scenario.json | folder>... --out <folder> [--models <folder>] [--max-texture-size N | device]
//   <tool> capi <model.moc3> <texture.png>...
//   <tool> compare <folder a> <folder b> [--max-rms <x>] [--max-diff <n>]
//
// Exit code 77 when the host cannot be opened (no device), so ctest skips.
#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "conformance/render.hpp"
#include "mochi2d.h"

namespace mochi2d::test {

struct GpuTool {
  /** The tool's name and the backend's ("Metal", "Direct3D 11"), and its error-code prefix ("mtl", "d3d11"). */
  const char* tool = "";
  const char* backend = "";
  const char* prefix = "";
  /** Filled by `open`: the device's name and texture limit. */
  std::string device;
  int device_limit = 0;
  /** The `render` command's drawer for a model, with its texture cap (0: the device's). */
  std::function<std::unique_ptr<conformance::Drawer>(std::shared_ptr<const moc::Model>,
                                                     Vector<std::shared_ptr<const render::Texture>>, int max_texture_size,
                                                     String& error)>
      drawer;
  // The C API: a renderer as an opaque pointer.
  std::function<int32_t()> available;
  std::function<m2d_status(m2d_model*, m2d_texture* const*, int32_t count, int32_t max_texture_size, int32_t flip_y,
                           void** out, m2d_error*)>
      create;
  std::function<void(void*)> destroy;
  /** Draws into the host's target of width × height and reads it back (rows as they lie in memory). */
  std::function<m2d_status(void*, const m2d_instance*, const m2d_render_frame*, int32_t width, int32_t height,
                           std::vector<uint8_t>& rgba, m2d_error*)>
      draw;
  std::function<m2d_status(void*, int32_t index, const void*, int32_t w, int32_t h, int32_t stride, int32_t x,
                           int32_t y, m2d_error*)>
      update_texture;
  std::function<void(const void*, m2d_render_stats*)> stats;
  std::function<int32_t(const void*)> max_texture_size;
  /** Checks of the backend's own (the Metal library cache): true when they hold, else false with a message. */
  std::function<bool(m2d_model*, std::string& message)> extra;
  /** A draw the C API refuses (a NULL target): M2D_INVALID_ARGUMENT expected. */
  std::function<m2d_status(void*, const m2d_instance*, const m2d_render_frame*, m2d_error*)> draw_without_target;
};

/** Parses the command line, opens the host with `open(tool, device option, error)`, and runs the command. */
int gpu_tool_main(int argc, char** argv, GpuTool& tool,
                  const std::function<bool(GpuTool&, const std::string& device, std::string& error)>& open);

}  // namespace mochi2d::test

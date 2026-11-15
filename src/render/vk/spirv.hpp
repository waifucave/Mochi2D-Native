// The GPU programs as SPIR-V for Vulkan: render/shaders.cpp's Vulkan dialect
// compiled by tests/vk/make_spirv.sh into the committed spirv.inc (builds
// need no shader compiler; the vk-spirv test fails while it is stale).
#pragma once

#include <cstddef>
#include <cstdint>

#include "render/shaders.hpp"

namespace mochi2d::render::vk {

struct Spirv {
  const uint32_t* words = nullptr;
  std::size_t count = 0;
};

Spirv spirv(ShaderProgram program, ShaderStage stage);

}  // namespace mochi2d::render::vk

#include "render/vk/spirv.hpp"

namespace mochi2d::render::vk {

namespace {
#include "render/vk/spirv.inc"

template <std::size_t N>
Spirv of(const uint32_t (&words)[N]) {
  return {words, N};
}
}  // namespace

Spirv spirv(ShaderProgram program, ShaderStage stage) {
  const bool v = stage == ShaderStage::Vertex;
  switch (program) {
    case ShaderProgram::Mesh:
      return v ? of(kSpirv_mesh_vert) : of(kSpirv_mesh_frag);
    case ShaderProgram::MeshAdvanced:
      return v ? of(kSpirv_mesh_advanced_vert) : of(kSpirv_mesh_advanced_frag);
    case ShaderProgram::Layer:
      return v ? of(kSpirv_layer_vert) : of(kSpirv_layer_frag);
    case ShaderProgram::LayerAdvanced:
      return v ? of(kSpirv_layer_advanced_vert) : of(kSpirv_layer_advanced_frag);
    case ShaderProgram::Mask:
      return v ? of(kSpirv_mask_vert) : of(kSpirv_mask_frag);
    case ShaderProgram::Count:
      break;
  }
  return {};
}

}  // namespace mochi2d::render::vk

#include "render/gpu/cross_sources.hpp"

namespace mochi2d::render {

namespace {
#include "render/gpu/cross_sources.inc"

struct Entry {
  const char* msl[2];
  const char* hlsl[2];
  const char* function[2];
};
const Entry kEntries[static_cast<int>(ShaderProgram::Count)] = {
    {{kMsl_mesh_vert, kMsl_mesh_frag}, {kHlsl_mesh_vert, kHlsl_mesh_frag}, {"m2d_mesh_vert", "m2d_mesh_frag"}},
    {{kMsl_mesh_advanced_vert, kMsl_mesh_advanced_frag},
     {kHlsl_mesh_advanced_vert, kHlsl_mesh_advanced_frag},
     {"m2d_mesh_advanced_vert", "m2d_mesh_advanced_frag"}},
    {{kMsl_layer_vert, kMsl_layer_frag}, {kHlsl_layer_vert, kHlsl_layer_frag}, {"m2d_layer_vert", "m2d_layer_frag"}},
    {{kMsl_layer_advanced_vert, kMsl_layer_advanced_frag},
     {kHlsl_layer_advanced_vert, kHlsl_layer_advanced_frag},
     {"m2d_layer_advanced_vert", "m2d_layer_advanced_frag"}},
    {{kMsl_mask_vert, kMsl_mask_frag}, {kHlsl_mask_vert, kHlsl_mask_frag}, {"m2d_mask_vert", "m2d_mask_frag"}},
};

bool valid(ShaderProgram program, ShaderStage stage) {
  const int p = static_cast<int>(program), s = static_cast<int>(stage);
  return p >= 0 && p < static_cast<int>(ShaderProgram::Count) && s >= 0 && s < 2;
}
}  // namespace

const char* cross_source(ShaderProgram program, ShaderStage stage, CrossLanguage language) {
  if (!valid(program, stage)) return nullptr;
  const Entry& e = kEntries[static_cast<int>(program)];
  return language == CrossLanguage::Msl ? e.msl[static_cast<int>(stage)] : e.hlsl[static_cast<int>(stage)];
}

const char* msl_function(ShaderProgram program, ShaderStage stage) {
  return valid(program, stage) ? kEntries[static_cast<int>(program)].function[static_cast<int>(stage)] : nullptr;
}

}  // namespace mochi2d::render

// Writes the GPU programs' Vulkan GLSL (render/shaders.hpp, the dialect made
// from the GL backend's text) to <dir>/<program>.<vert|frag>, for
// tests/vk/make_spirv.sh to compile to SPIR-V; with --cross, the dialect for
// Metal and Direct3D 11 (tests/gpu/make_shaders.sh).
//
// usage: mochi2d-shader-sources <dir> [--cross]
#include <cstdio>
#include <string>

#include "render/shaders.hpp"

using namespace mochi2d::render;

int main(int argc, char** argv) {
  const bool cross = argc == 3 && std::string(argv[2]) == "--cross";
  if (argc != 2 && !cross) {
    std::fprintf(stderr, "usage: mochi2d-shader-sources <dir> [--cross]\n");
    return 2;
  }
  const char* const names[] = {"mesh", "mesh_advanced", "layer", "layer_advanced", "mask"};
  for (int p = 0; p < static_cast<int>(ShaderProgram::Count); p++)
    for (int st = 0; st < 2; st++) {
      const std::string path = std::string(argv[1]) + "/" + names[p] + (st == 0 ? ".vert" : ".frag");
      const auto text = shader_source(static_cast<ShaderProgram>(p), static_cast<ShaderStage>(st),
                                      cross ? ShaderDialect::Cross450 : ShaderDialect::Vulkan450);
      std::FILE* f = std::fopen(path.c_str(), "wb");
      if (!f || std::fwrite(text.data(), 1, text.size(), f) != text.size() || std::fclose(f) != 0) {
        std::fprintf(stderr, "cannot write %s\n", path.c_str());
        return 1;
      }
    }
  return 0;
}

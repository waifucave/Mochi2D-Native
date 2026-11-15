// The GPU programs for Metal and Direct3D 11 (docs/design.md §8.13):
// render/shaders.cpp's Cross450 dialect, compiled to SPIR-V and translated
// by SPIRV-Cross into MSL 2.0 and HLSL (shader model 5.0) by
// tests/gpu/make_shaders.sh, which writes the committed cross_sources.inc
// and hlsl/ (builds need no shader compiler; the gpu-shaders test fails
// while they are stale). Their resources are the Vulkan dialect's: the
// 128-byte block of VulkanPushConstants (MSL buffer(0) in both stages,
// the HLSL cbuffer at b0), the textures uTex, uMask, uDst at texture and
// sampler 0, 1, 2 (HLSL t0–t2, s0–s2), the vertex attributes aPos and aUv
// at 0 and 1 (HLSL TEXCOORD0 and TEXCOORD1).
#pragma once

#include "render/shaders.hpp"

namespace mochi2d::render {

enum class CrossLanguage : int { Msl, Hlsl };

/** The program's stage in that language (a static text). */
const char* cross_source(ShaderProgram program, ShaderStage stage, CrossLanguage language);
/** The MSL function of the stage: m2d_<program>_<vert|frag>. */
const char* msl_function(ShaderProgram program, ShaderStage stage);

}  // namespace mochi2d::render

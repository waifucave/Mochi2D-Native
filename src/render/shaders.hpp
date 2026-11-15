// The GPU programs (docs/design.md §8.10): Mochi2D's GLSL
// (src/render/model/shaders.ts), as it is: its formulas mirror
// src/core/render/compositing.ts. One text for every backend; only the
// version line differs between GLSL ES 3.00 (OpenGL ES 3.0, WebGL2) and
// GLSL 3.30 core (desktop OpenGL 3.3, where precision qualifiers are
// accepted and ignored). Plan executors of other APIs start from the same
// text (m2d_render_shader_source).
#pragma once

#include <cstdint>

#include "util/alloc.hpp"

namespace mochi2d::render {

enum class ShaderProgram : int {
  /** A drawable: texture × colors × opacity × mask, fixed-function blending. */
  Mesh,
  /** A drawable with an advanced blend code, reading the destination copy. */
  MeshAdvanced,
  /** A layer composited: a quad over the viewport (a triangle strip of 4), sampled linearly (rule L). */
  Layer,
  LayerAdvanced,
  /** A mask mesh into a mask buffer (α only). */
  Mask,
  Count
};
enum class ShaderStage : int { Vertex, Fragment };
enum class ShaderDialect : int {
  GlslEs300,
  Glsl330,
  /**
   * GLSL 4.50 for Vulkan (SPIR-V), made from the same text: the uniforms
   * in one push-constant block (kVulkanPushConstants bytes, the layout of
   * `VulkanPushConstants`), samplers at set 0, bindings 0 (uTex), 1 (uMask)
   * and 2 (uDst), varyings at explicit locations, gl_VertexIndex, and
   * gl_FragCoord read through m2dFragCoord(), which undoes a flipped
   * viewport (uFlip, the target's height uHeight).
   */
  Vulkan450,
  /**
   * The Vulkan dialect for Metal and Direct3D 11 (translated from its
   * SPIR-V by SPIRV-Cross, tests/gpu/make_shaders.sh): their clip space
   * puts y = +1 at the target's row 0 (Vulkan's, with a flipped viewport),
   * so the vertex shaders negate y unless uFlip (the target's top row
   * first): masks and layers are then laid out as in OpenGL, rows from the
   * bottom, and gl_FragCoord reads through m2dFragCoord() as in Vulkan.
   */
  Cross450,
};

/** The push constants of the Vulkan dialect (std430: a vec3 and a scalar share 16 bytes). */
struct VulkanPushConstants {
  float view[4];
  /** Rows 0 and 1 of the mask matrix (uMaskTex, or uMaskClip in the mask program): RenderOp's mask.matrix. */
  float mask_rows[8];
  float multiply[3];
  float opacity;
  float screen[3];
  int32_t mask_mode;
  float tint[3];
  int32_t color_fn;
  float turn[3];
  int32_t alpha_mode;
  float flip;
  /** The target's height (m2dFragCoord). */
  float height;
};
constexpr int kVulkanPushConstants = 120;
static_assert(sizeof(VulkanPushConstants) == kVulkanPushConstants, "the push-constant block");

/** The program's stage, with its version line. */
String shader_source(ShaderProgram program, ShaderStage stage, ShaderDialect dialect);

/** The uniforms the programs use, by name (a program may lack some). */
constexpr int kShaderUniforms = 14;
extern const char* const kShaderUniformNames[kShaderUniforms];

}  // namespace mochi2d::render

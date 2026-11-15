#include "render/shaders.hpp"

namespace mochi2d::render {

namespace {


// Mochi2D 0.18.0's programs (src/render/model/shaders.ts), with its render rules
// (docs/rendering.md): UVs as sampled (rule V, prepared on upload), mask
// coordinates through float32 matrices applied as A·p + c (rule M), layers
// through a linearly filtered quad (rule L) whose mask comes from D = A · V⁻¹
// at its clip-space corners (rule I).
const char* const kMeshVs = R"(
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
uniform vec4 uView;    // clip = aPos * uView.xy + uView.zw
uniform vec3 uTurn;    // view rotation in clip space (clipTurn); (1, 0, 0) for none
uniform mat4 uMaskTex; // output space → mask texture (maskMatrices)
out vec2 vUv;
out vec2 vMask;
void main() {
  vUv = aUv; // origin at the image's top-left = texture row 0
  vMask = (uMaskTex * vec4(aPos, 0.0, 1.0)).xy;
  vec2 p = aPos * uView.xy + uView.zw;
  if (uTurn != vec3(1.0, 0.0, 0.0))
    p = vec2(uTurn.x * p.x - uTurn.y * p.y, uTurn.z * p.x + uTurn.x * p.y);
  gl_Position = vec4(p, 0.0, 1.0);
})";

const char* const kLayerVs = R"(
uniform mat4 uMaskTex; // clip space → mask texture (layerMaskMatrix)
out vec2 vUv;
out vec2 vMask;
void main() {
  vec2 uv = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 clip = uv * 2.0 - 1.0;
  vUv = uv;
  vMask = (uMaskTex * vec4(clip, 0.0, 1.0)).xy;
  gl_Position = vec4(clip, 0.0, 1.0);
})";

const char* const kMaskVs = R"(
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
uniform mat4 uMaskClip; // output space → the mask buffer's clip space (maskMatrices)
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uMaskClip * vec4(aPos, 0.0, 1.0);
})";

const char* const kMaskFs = R"(
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = vec4(0.0, 0.0, 0.0, texture(uTex, vUv).a);
})";

const char* const kAdvancedFunctions = R"(
float lum(vec3 c) { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }
float satOf(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  vec3 o = c;
  if (n < 0.0) o = l + (o - l) * l / (l - n);
  if (x > 1.0) o = l + (o - l) * (1.0 - l) / (x - l);
  return o;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
vec3 setSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float md = c.r + c.g + c.b - mx - mn;
  float nmx = 0.0;
  float nmd = 0.0;
  float nmn = 0.0;
  if (mn < mx) {
    nmx = s;
    nmd = (md - mn) * s / (mx - mn);
  }
  if (c.r == mx) return c.b < c.g ? vec3(nmx, nmd, nmn) : vec3(nmx, nmn, nmd);
  if (c.g == mx) return c.r < c.b ? vec3(nmn, nmx, nmd) : vec3(nmd, nmx, nmn);
  return c.g < c.r ? vec3(nmd, nmn, nmx) : vec3(nmn, nmd, nmx);
}
float channel(int code, float s, float d) {
  if (code == 3) return min(s + d, 1.0);
  if (code == 4) return s + d;
  if (code == 5) return min(s, d);
  if (code == 6) return s * d;
  if (code == 7) return abs(d - 1.0) < 1e-6 ? 1.0 : (abs(s) < 1e-6 ? 0.0 : 1.0 - min(1.0, (1.0 - d) / s));
  if (code == 8) return max(0.0, s + d - 1.0);
  if (code == 9) return max(s, d);
  if (code == 10) return s + d - s * d;
  if (code == 11) return d <= 0.0 ? 0.0 : (s == 1.0 ? 1.0 : min(1.0, d / (1.0 - s)));
  if (code == 12) return d < 0.5 ? 2.0 * s * d : 1.0 - 2.0 * (1.0 - s) * (1.0 - d);
  if (code == 13) {
    if (s <= 0.5) return d - (1.0 - 2.0 * s) * d * (1.0 - d);
    if (d <= 0.25) return d + (2.0 * s - 1.0) * d * ((16.0 * d - 12.0) * d + 3.0);
    return d + (2.0 * s - 1.0) * (sqrt(d) - d);
  }
  if (code == 14) return s < 0.5 ? 2.0 * s * d : 1.0 - 2.0 * (1.0 - s) * (1.0 - d);
  if (code == 15) return s < 0.5 ? max(0.0, 2.0 * s + d - 1.0) : min(1.0, 2.0 * (s - 0.5) + d);
  return s;
}
vec3 blendColor(int code, vec3 s, vec3 d) {
  if (code == 16) return setLum(setSat(s, satOf(d)), lum(d));
  if (code == 17) return setLum(s, lum(d));
  return vec3(channel(code, s.r, d.r), channel(code, s.g, d.g), channel(code, s.b, d.b));
}
vec3 weights(int mode, float As, float Ad) {
  if (mode == 1) return vec3(As * Ad, 0.0, Ad * (1.0 - As));
  if (mode == 2) return vec3(0.0, 0.0, Ad * (1.0 - As));
  if (mode == 3) return vec3(min(As, Ad), max(As - Ad, 0.0), max(Ad - As, 0.0));
  if (mode == 4) return vec3(max(As + Ad - 1.0, 0.0), min(As, 1.0 - Ad), min(Ad, 1.0 - As));
  return vec3(As * Ad, As * (1.0 - Ad), Ad * (1.0 - As));
}
)";

/** fragmentSource(advanced) of shaders.ts: meshes and whole layers alike. */
String fragment_source(bool advanced) {
  String s = "\nprecision highp float;\nprecision highp int;\nin vec2 vUv;\nin vec2 vMask;";
  s += R"(
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform highp sampler2D uDst;
uniform vec3 uMultiply;
uniform vec3 uScreen;
uniform vec3 uTint;     // an application tint of the final color (not reference behavior)
uniform float uOpacity;
uniform int uMaskMode; // 0 none, 1 normal, 2 inverted
uniform int uColorFn;
uniform int uAlphaMode;
out vec4 outColor;
// Each channel clamped to [0, 1], NaN becoming 0 (the comparison is false for NaN).
float unit1(float x) { return x > 0.0 ? min(x, 1.0) : 0.0; }
vec4 unit(vec4 v) { return vec4(unit1(v.r), unit1(v.g), unit1(v.b), unit1(v.a)); }
)";
  if (advanced) s += kAdvancedFunctions;
  s += "float maskFactor() {\n  if (uMaskMode == 0) return 1.0;\n  float m = 1.0 - texture(uMask, vMask).r;\n"
       "  return uMaskMode == 1 ? m : 1.0 - m;\n}\nvoid main() {\n  vec4 t = texture(uTex, vUv)";
  s += ";\n  vec3 rgb = t.rgb * uMultiply;\n";
  if (advanced)
    s += R"(  rgb = rgb + uScreen - rgb * uScreen; // no factor a (§2h.3)
  if (uTint != vec3(1.0)) rgb *= uTint;
  // A tint above 1 brightens up to white: the color (straight) is limited to 1.
  if (any(greaterThan(uTint, vec3(1.0)))) rgb = min(rgb, vec3(t.a));
  vec4 c = vec4(rgb, t.a) * uOpacity;
  float As = c.a;
  vec3 Cs = As >= 1e-5 ? c.rgb / As : vec3(0.0);
  As *= maskFactor();
  vec4 d = texelFetch(uDst, ivec2(gl_FragCoord.xy), 0);
  float Ad = d.a;
  vec3 Cd = Ad >= 1e-5 ? d.rgb / Ad : vec3(0.0);
  vec3 B = blendColor(uColorFn, Cs, Cd);
  vec3 p = weights(uAlphaMode, As, Ad);
  // The source alpha is not clamped above; the stored result is.
  outColor = unit(vec4(p.x * B + p.y * Cs + p.z * Cd, p.x + p.y + p.z));)";
  else
    s += R"(  rgb = rgb + uScreen * t.a - rgb * uScreen;
  if (uTint != vec3(1.0)) rgb *= uTint;
  // A tint above 1 brightens up to white: the color (premultiplied) is limited to its alpha.
  if (any(greaterThan(uTint, vec3(1.0)))) rgb = min(rgb, vec3(t.a));
  // The opacity is not clamped before the product (+∞ saturates); the source is.
  outColor = unit(vec4(rgb, t.a) * uOpacity * maskFactor());)";
  s += "\n}";
  return s;
}

}  // namespace

const char* const kShaderUniformNames[kShaderUniforms] = {
    "uView",    "uTurn",     "uMaskTex", "uMaskClip", "uTex",      "uMask",   "uDst",
    "uMultiply", "uScreen",  "uTint",    "uOpacity",  "uMaskMode", "uColorFn", "uAlphaMode"};

namespace {

// The uniforms as one push-constant block of 120 bytes (std430 offsets: uView 0,
// the mask matrix's rows 16 and 32, then a vec3 with a scalar at 48, 64, 80 and 96,
// uFlip 112, uHeight 116). uMaskTex and uMaskClip are the same two rows (rows 2 and
// 3 of the affine matrices are the identity's), rebuilt as a mat4 so that the
// product is the GLSL text's.
const char* const kVulkanBlock = R"(
layout(push_constant) uniform M2dPushConstants {
  vec4 uView;
  vec4 uMaskRow0;
  vec4 uMaskRow1;
  vec3 uMultiply; float uOpacity;
  vec3 uScreen; int uMaskMode;
  vec3 uTint; int uColorFn;
  vec3 uTurn; int uAlphaMode;
  float uFlip; float uHeight;
} pc;
#define m2dMaskMatrix mat4(pc.uMaskRow0.x, pc.uMaskRow1.x, 0.0, 0.0, pc.uMaskRow0.y, pc.uMaskRow1.y, 0.0, 0.0, pc.uMaskRow0.z, pc.uMaskRow1.z, 1.0, 0.0, pc.uMaskRow0.w, pc.uMaskRow1.w, 0.0, 1.0)
#define uView pc.uView
#define uMaskTex m2dMaskMatrix
#define uMaskClip m2dMaskMatrix
#define uMultiply pc.uMultiply
#define uOpacity pc.uOpacity
#define uScreen pc.uScreen
#define uMaskMode pc.uMaskMode
#define uTint pc.uTint
#define uColorFn pc.uColorFn
#define uTurn pc.uTurn
#define uAlphaMode pc.uAlphaMode
#define uFlip pc.uFlip
#define uHeight pc.uHeight)";

const char* const kVulkanFragCoord = R"(
// The pixel as OpenGL numbers it (rows from the bottom), whatever the viewport's direction.
vec2 m2dFragCoord() {
  return uFlip > 0.5 ? vec2(gl_FragCoord.x, uHeight - gl_FragCoord.y) : gl_FragCoord.xy;
})";

void replace_all(String& s, const char* from, const char* to) {
  const std::size_t n = std::char_traits<char>::length(from);
  for (std::size_t at = s.find(from); at != String::npos; at = s.find(from, at + std::char_traits<char>::length(to)))
    s.replace(at, n, to);
}

/** The GLSL ES 3.00 text (without its version line) as Vulkan GLSL 4.50. */
String to_vulkan(const String& body, bool fragment) {
  String out = "#version 450";
  out += kVulkanBlock;
  if (fragment) out += kVulkanFragCoord;
  std::size_t at = 0;
  while (at <= body.size()) {
    std::size_t end = body.find('\n', at);
    if (end == String::npos) end = body.size();
    String line = body.substr(at, end - at);
    at = end + 1;
    // Plain uniforms move into the push-constant block; samplers get bindings; varyings locations.
    if (line.rfind("uniform ", 0) == 0) {
      if (line.find("sampler2D uTex;") != String::npos)
        line = "layout(set = 0, binding = 0) uniform sampler2D uTex;";
      else if (line.find("sampler2D uMask;") != String::npos)
        line = "layout(set = 0, binding = 1) uniform sampler2D uMask;";
      else if (line.find("sampler2D uDst;") != String::npos)
        line = "layout(set = 0, binding = 2) uniform highp sampler2D uDst;";
      else
        continue;
    } else if (line == "out vec2 vUv;" || line == "in vec2 vUv;") {
      line = "layout(location = 0) " + line;
    } else if (line == "out vec2 vMask;" || line == "in vec2 vMask;") {
      line = "layout(location = 1) " + line;
    } else if (line == "out vec4 outColor;") {
      line = "layout(location = 0) " + line;
    }
    out += "\n";
    out += line;
  }
  replace_all(out, "gl_VertexID", "gl_VertexIndex");
  replace_all(out, "gl_FragCoord.xy", "m2dFragCoord()");
  // m2dFragCoord itself reads the real one.
  replace_all(out, "? vec2(gl_FragCoord.x, uHeight - gl_FragCoord.y) : m2dFragCoord();",
              "? vec2(gl_FragCoord.x, uHeight - gl_FragCoord.y) : gl_FragCoord.xy;");
  return out;
}

}  // namespace

String shader_source(ShaderProgram program, ShaderStage stage, ShaderDialect dialect) {
  if (dialect == ShaderDialect::Cross450) {
    String s = shader_source(program, stage, ShaderDialect::Vulkan450);
    if (stage == ShaderStage::Vertex) {
      // y = +1 at row 0: negated unless the target is drawn with its top row first.
      const std::size_t end = s.rfind('}');
      s.insert(end, "  if (uFlip < 0.5) gl_Position.y = -gl_Position.y;\n");
    }
    return s;
  }
  if (dialect == ShaderDialect::Vulkan450) {
    const String es = shader_source(program, stage, ShaderDialect::GlslEs300);
    return to_vulkan(es.substr(std::char_traits<char>::length("#version 300 es")), stage == ShaderStage::Fragment);
  }
  String s = dialect == ShaderDialect::Glsl330 ? "#version 330 core" : "#version 300 es";
  const bool vertex = stage == ShaderStage::Vertex;
  switch (program) {
    case ShaderProgram::Mesh:
    case ShaderProgram::MeshAdvanced:
      s += vertex ? String(kMeshVs) : fragment_source(program == ShaderProgram::MeshAdvanced);
      break;
    case ShaderProgram::Layer:
    case ShaderProgram::LayerAdvanced:
      s += vertex ? String(kLayerVs) : fragment_source(program == ShaderProgram::LayerAdvanced);
      break;
    case ShaderProgram::Mask:
    case ShaderProgram::Count:
      s += vertex ? kMaskVs : kMaskFs;
      break;
  }
  return s;
}

}  // namespace mochi2d::render

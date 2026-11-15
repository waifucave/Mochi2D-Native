/**
 * GLSL for the model renderer. The formulas mirror
 * src/core/render/compositing.ts, which tests check against the worked
 * examples of §2j.
 *
 * The source of a draw is either a mesh (MESH_VS) or a whole layer, an
 * offscreen or the model's (LAYER_VS); both sample their texture at an
 * interpolated coordinate. The blend is either compatible (fixed-function
 * blending, §2c/§2d) or advanced (the shader computes the new pixel from a
 * copy of the destination, §2h.3).
 *
 * Three rules fix the images' float32 order and rounding (docs/rendering.md):
 * texture v sampled flipped twice in float32 (V, on upload), mask coordinates
 * through float32 matrices (M, `maskMatrices`), layers through a linearly
 * filtered quad (L).
 *
 * Opacities are used as given, negative, NaN and infinite ones too, and the
 * output is clamped at fixed points: the
 * compatible source color and alpha before blending, the advanced result
 * when it is stored, with NaN becoming 0 in both. An 8-bit target clamps
 * the same way; `unit` makes it explicit, NaN included.
 */

/**
 * Mesh vertices: output-space positions → clip space; UVs as sampled (rule V,
 * prepared on upload); mask-texture coordinates through the mask's texture
 * matrix (rule M), applied as A·p + c.
 */
export const MESH_VS = `#version 300 es
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
}`;

/**
 * A whole layer (rule L): a quad over the viewport, texture coordinates 0 to
 * 1 across it, as a triangle strip of 4 vertices. A masked layer's mask
 * coordinate is its lookup matrix D = A · V⁻¹ applied to the quad's
 * clip-space corners and interpolated (rule I).
 */
export const LAYER_VS = `#version 300 es
uniform mat4 uMaskTex; // clip space → mask texture (layerMaskMatrix)
out vec2 vUv;
out vec2 vMask;
void main() {
  vec2 uv = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 clip = uv * 2.0 - 1.0;
  vUv = uv;
  vMask = (uMaskTex * vec4(clip, 0.0, 1.0)).xy;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

/**
 * Mask meshes into the mask buffer (§2g.3): red ← red·(1 − α) by blending,
 * positions through the mask's clip matrix (rule M).
 */
export const MASK_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
uniform mat4 uMaskClip; // output space → the mask buffer's clip space (maskMatrices)
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uMaskClip * vec4(aPos, 0.0, 1.0);
}`;

export const MASK_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = vec4(0.0, 0.0, 0.0, texture(uTex, vUv).a);
}`;

const ADVANCED_FUNCTIONS = `
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
`;

/**
 * Fragment program, for meshes (MESH_VS) and whole layers (LAYER_VS, §2h.4)
 * alike: uTex sampled at the interpolated texture coordinate, the mask at the
 * coordinate from the vertex shader. A layer's texture is filtered linearly
 * (rule L).
 */
export function fragmentSource(advanced: boolean): string {
  return `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
in vec2 vMask;
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
${advanced ? ADVANCED_FUNCTIONS : ""}
float maskFactor() {
  if (uMaskMode == 0) return 1.0;
  float m = 1.0 - texture(uMask, vMask).r;
  return uMaskMode == 1 ? m : 1.0 - m;
}
void main() {
  vec4 t = texture(uTex, vUv);
  vec3 rgb = t.rgb * uMultiply;
${
  advanced
    ? `  rgb = rgb + uScreen - rgb * uScreen; // no factor a (§2h.3)
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
  outColor = unit(vec4(p.x * B + p.y * Cs + p.z * Cd, p.x + p.y + p.z));`
    : `  rgb = rgb + uScreen * t.a - rgb * uScreen;
  if (uTint != vec3(1.0)) rgb *= uTint;
  // A tint above 1 brightens up to white: the color (premultiplied) is limited to its alpha.
  if (any(greaterThan(uTint, vec3(1.0)))) rgb = min(rgb, vec3(t.a));
  // The opacity is not clamped before the product (+∞ saturates); the source is.
  outColor = unit(vec4(rgb, t.a) * uOpacity * maskFactor());`
}
}`;
}

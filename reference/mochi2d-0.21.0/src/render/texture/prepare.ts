/**
 * Exact texture preparation on the GPU (§2b):
 *
 * - premultiplication of straight 8-bit texels, c′ = ⌊c·a/255 + ½⌋ (§2b.1);
 * - a complete mip chain where each texel is the mean of the 2×2 block below
 *   it, rounded to nearest with ties to even (§2b.3). Levels halve with
 *   floor (⌊w/2⌋, at least 1); a block reaching past the level above (only
 *   where that level is 1 texel wide or high) reads its last texel again.
 *   Power-of-two sizes follow §2b.3 exactly. Other sizes use the same rule
 *   (not reference behavior: the reference leaves them to the platform's
 *   mipmap generator), so no render depends on the GPU driver.
 *
 * Both passes work on exact integers (texel values ×255, rounded), so the
 * results do not depend on the GPU's float precision.
 */
import { GlError } from "../gl/context.js";
import { ShaderProgram } from "../gl/shader.js";

const FULLSCREEN_VS = `#version 300 es
void main() {
  // One triangle covering the viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const PREMULTIPLY_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform ivec2 uOffset; // where the source's first texel goes (a region update)
out vec4 outColor;
void main() {
  vec4 c = floor(texelFetch(uSrc, ivec2(gl_FragCoord.xy) - uOffset, 0) * 255.0 + 0.5);
  // c·a ≤ 65025 is exact; c·a/255 is never within 1/510 of a half.
  vec3 p = floor(c.rgb * c.a / 255.0 + 0.5);
  outColor = vec4(p, c.a) / 255.0;
}`;

const MIP_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc; // the level above, as the only sampled level
uniform ivec2 uSrcSize;
out vec4 outColor;
ivec4 texel(ivec2 p) {
  return ivec4(floor(texelFetch(uSrc, min(p, uSrcSize - 1), 0) * 255.0 + 0.5));
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  ivec4 sum = texel(p) + texel(p + ivec2(1, 0)) + texel(p + ivec2(0, 1)) + texel(p + ivec2(1, 1));
  ivec4 q = sum >> 2;
  ivec4 r = sum & 3;
  // Round to nearest; a remainder of exactly 2 is a tie, which goes to the even neighbour.
  q += ivec4(greaterThan(r, ivec4(2))) + ivec4(equal(r, ivec4(2))) * (q & 1);
  outColor = vec4(q) / 255.0;
}`;

/** Number of levels in a complete mip chain. */
export const mipLevels = (width: number, height: number): number =>
  Math.floor(Math.log2(Math.max(width, height))) + 1;

export class TexturePreparer {
  private readonly premultiply: ShaderProgram;
  private readonly mip: ShaderProgram;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly vao: WebGLVertexArrayObject;

  constructor(readonly gl: WebGL2RenderingContext) {
    this.premultiply = new ShaderProgram(gl, FULLSCREEN_VS, PREMULTIPLY_FS, "texture premultiply");
    this.mip = new ShaderProgram(gl, FULLSCREEN_VS, MIP_FS, "texture mip level");
    const fb = gl.createFramebuffer();
    const vao = gl.createVertexArray();
    if (!fb || !vao) throw new GlError("Failed to create framebuffer (context lost?)");
    this.framebuffer = fb;
    this.vao = vao;
  }

  /**
   * Creates the final texture from a straight-alpha RGBA8 source texture
   * (level 0 only): premultiplied, with a full mip chain if `mipmaps`, trilinear
   * minification, bilinear magnification and repeat wrapping (§2b.3).
   */
  prepare(
    straight: WebGLTexture,
    width: number,
    height: number,
    opts: { mipmaps: boolean; wrap?: "repeat" | "clamp" },
  ): WebGLTexture {
    const gl = this.gl;
    const levels = opts.mipmaps ? mipLevels(width, height) : 1;
    const tex = gl.createTexture();
    if (!tex) throw new GlError("createTexture returned null (context lost?)");
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    try {
      // Level 0: premultiply.
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.checkComplete("premultiply");
      gl.viewport(0, 0, width, height);
      this.premultiply.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, straight);
      gl.uniform1i(this.premultiply.uniform("uSrc"), 0);
      gl.uniform2i(this.premultiply.uniform("uOffset"), 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (levels > 1) this.exactMips(tex, width, height, levels);
    } finally {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);
      gl.bindVertexArray(null);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = (opts.wrap ?? "repeat") === "repeat" ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  /**
   * Replaces the region (x, y, w, h) of a texture made by {@link prepare}
   * (width × height, `levels` levels) with a straight-alpha RGBA8 source
   * texture of w × h texels: level 0 premultiplied as {@link prepare} does,
   * then in each further level only the texels whose 2×2 block covers the
   * region, by the same exact rule, so the result equals a full preparation
   * of the new image.
   */
  updateRegion(
    tex: WebGLTexture,
    width: number,
    height: number,
    levels: number,
    straight: WebGLTexture,
    region: { x: number; y: number; w: number; h: number },
  ): void {
    const gl = this.gl;
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.checkComplete("premultiply");
      gl.viewport(0, 0, width, height);
      gl.scissor(region.x, region.y, region.w, region.h);
      this.premultiply.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, straight);
      gl.uniform1i(this.premultiply.uniform("uSrc"), 0);
      gl.uniform2i(this.premultiply.uniform("uOffset"), region.x, region.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (levels > 1) this.exactMips(tex, width, height, levels, region);
    } finally {
      gl.disable(gl.SCISSOR_TEST);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);
      gl.bindVertexArray(null);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Levels 1… from the level above with the 2×2 ties-to-even rule, on clamped
   * blocks; with `region` (of level 0), only the texels whose block covers it
   * (the scissor test must be enabled).
   */
  private exactMips(
    tex: WebGLTexture,
    width: number,
    height: number,
    levels: number,
    region?: { x: number; y: number; w: number; h: number },
  ): void {
    const gl = this.gl;
    let x0 = region?.x ?? 0;
    let y0 = region?.y ?? 0;
    let x1 = region ? region.x + region.w : width;
    let y1 = region ? region.y + region.h : height;
    this.mip.use();
    gl.uniform1i(this.mip.uniform("uSrc"), 0);
    gl.activeTexture(gl.TEXTURE0);
    let w = width;
    let h = height;
    for (let level = 1; level < levels; level++) {
      const sw = w;
      const sh = h;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      // Texel p of this level reads texels 2p and 2p + 1 above (clamped).
      x0 = Math.min(x0 >> 1, w - 1);
      y0 = Math.min(y0 >> 1, h - 1);
      x1 = Math.min((x1 + 1) >> 1, w);
      y1 = Math.min((y1 + 1) >> 1, h);
      if (region) gl.scissor(x0, y0, x1 - x0, y1 - y0);
      // Sample only the level above while rendering this one (no feedback loop).
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, level - 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level - 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, level);
      this.checkComplete(`mip level ${level}`);
      gl.viewport(0, 0, w, h);
      gl.uniform2i(this.mip.uniform("uSrcSize"), sw, sh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  private checkComplete(what: string): void {
    const gl = this.gl;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE)
      throw new GlError(
        `Texture preparation (${what}): framebuffer incomplete (0x${status.toString(16)})`,
      );
  }

  dispose(): void {
    this.premultiply.dispose();
    this.mip.dispose();
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteVertexArray(this.vao);
  }
}

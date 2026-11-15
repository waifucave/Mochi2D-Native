/**
 * GPU side of items: each item is drawn by its own renderer into an offscreen
 * image (premultiplied alpha) at about its size on screen, and that image is
 * drawn onto the canvas as one rotated, scaled quad. The reference renderer
 * is not changed for this.
 */
import { ShaderProgram } from "../../render/gl/shader.js";

const VERTEX = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform mat3 uMap;
out vec2 vUv;
void main() {
  vUv = aPos;
  vec3 p = uMap * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUv) * uOpacity;
}`;

export class ItemCompositor {
  private readonly program: ShaderProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly probeFb: WebGLFramebuffer;

  constructor(readonly gl: WebGL2RenderingContext) {
    this.program = new ShaderProgram(gl, VERTEX, FRAGMENT, "item composite");
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    const fb = gl.createFramebuffer();
    if (!vao || !buffer || !fb) throw new Error("could not create GL objects (context lost?)");
    this.vao = vao;
    this.buffer = buffer;
    this.probeFb = fb;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Draws `texture` over the currently bound framebuffer (`width × height`):
   * texture coordinates (s, t) ∈ [0, 1]² go to clip space through `map`
   * (column-major 3 × 3), blended as premultiplied color.
   */
  draw(texture: WebGLTexture, map: Float32Array, width: number, height: number, opacity = 1): void {
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program.program);
    gl.uniformMatrix3fv(this.program.uniform("uMap"), false, map);
    gl.uniform1f(this.program.uniform("uOpacity"), opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.program.uniform("uTex"), 0);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disable(gl.BLEND);
  }

  /**
   * Reads one texel's alpha (0–1) of a texture's level 0. (u, v) are texture
   * coordinates with v = 0 at row 0; they wrap around like the renderer's
   * repeat mode.
   */
  readAlpha(texture: WebGLTexture, width: number, height: number, u: number, v: number): number {
    const gl = this.gl;
    const x = Math.min(width - 1, Math.floor((u - Math.floor(u)) * width));
    const y = Math.min(height - 1, Math.floor((v - Math.floor(v)) * height));
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const px = new Uint8Array(4);
    let alpha = Number.NaN;
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      alpha = px[3]! / 255;
    }
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    return alpha;
  }

  dispose(): void {
    const gl = this.gl;
    this.program.dispose();
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.buffer);
    gl.deleteFramebuffer(this.probeFb);
  }
}

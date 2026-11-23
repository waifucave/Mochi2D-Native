/**
 * Pixel readback from a render target or the default framebuffer, with the
 * output alpha convention chosen by the caller.
 */
import { convertAlpha, type AlphaMode } from "../../core/image/alpha.js";
import { encodePngRgba8 } from "../../platform/png-encode.js";
import { readFramebufferRgba, type RenderTarget } from "./render-target.js";

export interface ReadbackOptions {
  /** Alpha convention of the framebuffer contents. Default "premultiplied". */
  source?: AlphaMode;
  /** Alpha convention of the returned pixels. Default "straight" (what PNG viewers expect). */
  output?: AlphaMode;
  /** Sub-rectangle in framebuffer pixels (origin bottom-left, as in GL). Default: everything. */
  rect?: { x: number; y: number; width: number; height: number };
}

export interface RgbaPixels {
  width: number;
  height: number;
  /** RGBA8, rows top to bottom. */
  data: Uint8Array;
  alpha: AlphaMode;
}

/**
 * Reads RGBA8 pixels. `target` null means the default framebuffer, in which
 * case call this in the same task that drew the frame (or use
 * `preserveDrawingBuffer`).
 */
export function readbackRgba(
  gl: WebGL2RenderingContext,
  target: RenderTarget | null,
  options: ReadbackOptions = {},
): RgbaPixels {
  const source = options.source ?? "premultiplied";
  const output = options.output ?? "straight";
  const full = target
    ? { x: 0, y: 0, width: target.width, height: target.height }
    : { x: 0, y: 0, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
  const r = options.rect ?? full;
  const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target ? target.framebuffer : null);
  try {
    const px = readFramebufferRgba(gl, r.x, r.y, r.width, r.height);
    return {
      width: r.width,
      height: r.height,
      data: source === output ? px : convertAlpha(px, source, output),
      alpha: output,
    };
  } finally {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
  }
}

/** Reads back and encodes a PNG in one step. */
export function readbackPng(
  gl: WebGL2RenderingContext,
  target: RenderTarget | null,
  options: ReadbackOptions = {},
): Uint8Array {
  const px = readbackRgba(gl, target, options);
  return encodePngRgba8(px.width, px.height, px.data);
}

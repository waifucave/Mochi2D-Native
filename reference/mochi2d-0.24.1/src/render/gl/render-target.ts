import { GlError } from "./context.js";
import type { GpuMemoryTracker } from "./gpu-memory.js";

export interface RenderTargetOptions {
  /** Attach an 8-bit stencil buffer. Default false. */
  stencil?: boolean;
  /** Sampling filter of the color texture. Default "linear". */
  filter?: "linear" | "nearest";
  memory?: GpuMemoryTracker;
  label?: string;
}

/** An offscreen RGBA8 color target (optionally with a stencil buffer). */
export class RenderTarget {
  readonly framebuffer: WebGLFramebuffer;
  readonly texture: WebGLTexture;
  readonly withStencil: boolean;
  readonly filter: "linear" | "nearest";
  private stencil: WebGLRenderbuffer | null = null;
  private _width = 0;
  private _height = 0;
  private readonly memory: GpuMemoryTracker | undefined;
  private readonly label: string;

  constructor(
    readonly gl: WebGL2RenderingContext,
    width: number,
    height: number,
    options: RenderTargetOptions | boolean = {},
  ) {
    const opts: RenderTargetOptions = typeof options === "boolean" ? { stencil: options } : options;
    this.withStencil = opts.stencil ?? false;
    this.filter = opts.filter ?? "linear";
    this.memory = opts.memory;
    this.label = opts.label ?? "render target";
    const fb = gl.createFramebuffer();
    const tex = gl.createTexture();
    if (!fb || !tex) throw new GlError("Failed to create framebuffer/texture (context lost?)");
    this.framebuffer = fb;
    this.texture = tex;
    this.resize(width, height);
  }

  get width(): number {
    return this._width;
  }
  get height(): number {
    return this._height;
  }

  /** Nominal GPU bytes (color + stencil). */
  get bytes(): number {
    return this._width * this._height * (4 + (this.withStencil ? 1 : 0));
  }

  resize(width: number, height: number): void {
    if (width === this._width && height === this._height) return;
    const gl = this.gl;
    const max = Math.min(
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    );
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > max ||
      height > max
    ) {
      throw new GlError(`Render target size ${width}x${height} outside [1, ${max}]`);
    }
    this._width = width;
    this._height = height;
    const filter = this.filter === "nearest" ? gl.NEAREST : gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    if (this.withStencil) {
      if (!this.stencil) this.stencil = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.stencil);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, width, height);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.STENCIL_ATTACHMENT,
        gl.RENDERBUFFER,
        this.stencil,
      );
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new GlError(`Framebuffer incomplete: 0x${status.toString(16)} (${width}x${height})`);
    }
    this.memory?.set(
      this,
      "render-target",
      `${this.label} ${width}x${height}${this.withStencil ? "+stencil" : ""}`,
      this.bytes,
    );
  }

  /** Binds this target for drawing and sets the viewport to its full size. */
  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
    this.gl.viewport(0, 0, this._width, this._height);
  }

  /** Reads back RGBA8 pixels exactly as stored, rows top-to-bottom. */
  readPixels(): Uint8Array {
    const gl = this.gl;
    const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
    const px = readFramebufferRgba(gl, 0, 0, this._width, this._height);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
    return px;
  }

  dispose(): void {
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteTexture(this.texture);
    if (this.stencil) this.gl.deleteRenderbuffer(this.stencil);
    this.memory?.delete(this);
  }
}

/**
 * Reads RGBA8 pixels from the currently bound read framebuffer and flips them
 * so row 0 is the top of the image.
 */
export function readFramebufferRgba(
  gl: WebGL2RenderingContext,
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const row = width * 4;
  const tmp = new Uint8Array(row);
  for (let r = 0; r < height >> 1; r++) {
    const a = r * row;
    const b = (height - 1 - r) * row;
    tmp.set(px.subarray(a, a + row));
    px.copyWithin(a, b, b + row);
    px.set(tmp, b);
  }
  return px;
}

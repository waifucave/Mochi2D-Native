export interface GlContextOptions {
  /** Default `true`: the canvas is composited as premultiplied alpha. */
  premultipliedAlpha?: boolean;
  /** Default `true`, so the drawing buffer can be read back after presenting. */
  preserveDrawingBuffer?: boolean;
  antialias?: boolean;
  alpha?: boolean;
  stencil?: boolean;
}

export class GlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlError";
  }
}

/** Creates a WebGL2 context or throws a descriptive {@link GlError}. */
export function createGl2Context(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: GlContextOptions = {},
): WebGL2RenderingContext {
  const attrs: WebGLContextAttributes = {
    alpha: options.alpha ?? true,
    premultipliedAlpha: options.premultipliedAlpha ?? true,
    preserveDrawingBuffer: options.preserveDrawingBuffer ?? true,
    antialias: options.antialias ?? false,
    stencil: options.stencil ?? true,
    depth: false,
  };
  const gl = canvas.getContext("webgl2", attrs) as WebGL2RenderingContext | null;
  if (!gl) throw new GlError("WebGL2 is not available in this browser / environment.");
  return gl;
}

const ERROR_NAMES: Record<number, string> = {
  0x0500: "INVALID_ENUM",
  0x0501: "INVALID_VALUE",
  0x0502: "INVALID_OPERATION",
  0x0505: "OUT_OF_MEMORY",
  0x0506: "INVALID_FRAMEBUFFER_OPERATION",
  0x9242: "CONTEXT_LOST_WEBGL",
};

/** Throws if `gl.getError()` reports anything. Use in tests and debug paths. */
export function assertNoGlError(gl: WebGL2RenderingContext, where: string): void {
  const errs: string[] = [];
  for (let e = gl.getError(), n = 0; e !== gl.NO_ERROR && n < 8; e = gl.getError(), n++) {
    errs.push(ERROR_NAMES[e] ?? `0x${e.toString(16)}`);
  }
  if (errs.length) throw new GlError(`GL error(s) after ${where}: ${errs.join(", ")}`);
}

/**
 * Resizes a canvas's drawing buffer to its CSS size times the device pixel
 * ratio. Returns `true` if the size changed.
 */
export function resizeCanvasToDisplaySize(
  canvas: HTMLCanvasElement,
  dpr = globalThis.devicePixelRatio || 1,
): boolean {
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

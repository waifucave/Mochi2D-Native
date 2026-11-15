/**
 * A canvas with a WebGL2 context and a render loop: playback clock, frame
 * statistics, background, screenshots, drawing-buffer sizing and context
 * loss. Draws whatever {@link StageModel} is set, and skips frames that would
 * repeat the last one.
 */
import { createGl2Context, resizeCanvasToDisplaySize } from "../render/gl/context.js";
import { readbackRgba } from "../render/gl/readback.js";
import { GpuMemoryTracker } from "../render/gl/gpu-memory.js";
import { encodePngRgba8 } from "../platform/png-encode.js";
import { PlaybackClock } from "./clock.js";
import { FrameStats } from "./frame-stats.js";
import type { StageModel } from "./stage-model.js";

export type FrameListener = (info: { dt: number; realDt: number; time: number }) => void;

export interface StageOptions {
  /** Default true. */
  antialias?: boolean;
  /** Upper limit of the device pixel ratio used for the drawing buffer. Default: none. */
  maxPixelRatio?: number;
  /** Size the drawing buffer to the canvas's CSS size every frame. Default true. */
  autoResize?: boolean;
}

export class Stage {
  readonly gl: WebGL2RenderingContext;
  readonly memory = new GpuMemoryTracker();
  readonly clock = new PlaybackClock();
  readonly stats = new FrameStats();
  /** Straight-alpha RGB in [0, 1]; ignored when `transparent`. */
  background: [number, number, number] = [0.91, 0.91, 0.93];
  transparent = false;
  model: StageModel | null = null;
  /** True if the last frame was not redrawn because nothing changed. */
  idle = false;
  /** Upper limit of the device pixel ratio for the drawing buffer. */
  maxPixelRatio: number;
  autoResize: boolean;
  /**
   * Whether frames draw. While false, the loop and {@link tick} still advance
   * the clock and update the model (and call the frame listeners), but leave
   * the canvas as it is; {@link draw} draws the current state.
   */
  drawing = true;
  /** The WebGL context is lost (until it is restored). */
  contextLost = false;
  /** Called when the context is lost, and when it is restored (GPU resources must be recreated). */
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;
  private readonly listeners: FrameListener[] = [];
  private readonly beforeListeners: FrameListener[] = [];
  private drawnKey = "";
  private drawnModel: StageModel | null = null;
  private screenshotWaiters: ((png: Uint8Array) => void)[] = [];
  private last = 0;
  private running = false;
  private rafId = 0;
  private readonly unbind: () => void;

  constructor(
    readonly canvas: HTMLCanvasElement,
    options: StageOptions = {},
  ) {
    this.gl = createGl2Context(canvas, {
      preserveDrawingBuffer: false,
      antialias: options.antialias ?? true,
      premultipliedAlpha: true,
    });
    this.maxPixelRatio = options.maxPixelRatio ?? Infinity;
    this.autoResize = options.autoResize ?? true;
    const lost = (e: Event) => {
      e.preventDefault(); // allow the context to be restored
      this.contextLost = true;
      this.drawnKey = "";
      this.onContextLost?.();
    };
    const restored = () => {
      this.contextLost = false;
      this.memory.clear();
      this.onContextRestored?.();
    };
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    this.unbind = () => {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
    };
  }

  /** Listens to every frame, after drawing. Returns a function that removes the listener. */
  onFrame(fn: FrameListener): () => void {
    this.listeners.push(fn);
    return () => this.listeners.splice(this.listeners.indexOf(fn) >>> 0, 1);
  }

  /** Listens to every frame, before the model updates (to set inputs). */
  onBeforeUpdate(fn: FrameListener): () => void {
    this.beforeListeners.push(fn);
    return () => this.beforeListeners.splice(this.beforeListeners.indexOf(fn) >>> 0, 1);
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    const loop = (t: number) => {
      if (!this.running) return;
      this.frame(t);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** The device pixel ratio the drawing buffer uses. */
  get pixelRatio(): number {
    return Math.min(globalThis.devicePixelRatio || 1, this.maxPixelRatio);
  }

  /** Sizes the drawing buffer to the canvas's CSS size now. Returns whether it changed. */
  resize(): boolean {
    return resizeCanvasToDisplaySize(this.canvas, this.pixelRatio);
  }

  /** Resolves with a PNG (straight alpha) of the next rendered frame. */
  screenshot(): Promise<Uint8Array> {
    if (!this.running || !this.drawing) {
      const p = new Promise<Uint8Array>((resolve) => this.screenshotWaiters.push(resolve));
      this.tick(0, true);
      return p;
    }
    return new Promise((resolve) => this.screenshotWaiters.push(resolve));
  }

  /**
   * Runs one frame now with `realDt` seconds of real time (for hosts that
   * drive their own loop). With `draw` false (default: {@link drawing}), it
   * updates without drawing.
   */
  tick(realDt: number, draw = this.drawing): void {
    this.step(realDt, realDt * 1000, draw);
  }

  /** Draws the current state now (a frame that takes no time), even while {@link drawing} is off. */
  draw(): void {
    this.tick(0, true);
  }

  private frame(t: number): void {
    const realDt = this.last ? (t - this.last) / 1000 : 0;
    const interval = this.last ? t - this.last : 0;
    this.last = t;
    this.step(realDt, interval, this.drawing);
  }

  private step(realDt: number, interval: number, draw: boolean): void {
    if (this.contextLost || this.gl.isContextLost()) return;
    const cpu0 = performance.now();
    const gl = this.gl;
    if (this.autoResize) this.resize();
    const dt = this.clock.tick(realDt);
    for (const l of this.beforeListeners) l({ dt, realDt, time: this.clock.time });
    this.model?.update(dt, this.clock.time);

    // Skip frames that would repeat the last one: the canvas keeps showing it.
    const { width, height } = this.canvas;
    const key = `${width}x${height} ${this.transparent ? "transparent" : this.background.join(",")}`;
    // Without drawing, the state is drawn later: the model keeps what changed.
    const redraw =
      draw &&
      (this.screenshotWaiters.length > 0 ||
        key !== this.drawnKey ||
        this.model !== this.drawnModel ||
        (this.model?.needsRedraw?.(width, height) ?? true));
    this.idle = draw && !redraw;
    if (redraw) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      if (this.transparent) gl.clearColor(0, 0, 0, 0);
      else gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.model?.draw(width, height);
      this.drawnKey = key;
      this.drawnModel = this.model;
    }

    if (redraw && this.screenshotWaiters.length) {
      // Must happen in the same task as the draw (the drawing buffer is not preserved).
      const px = readbackRgba(gl, null, { source: "premultiplied", output: "straight" });
      const png = encodePngRgba8(px.width, px.height, px.data);
      for (const w of this.screenshotWaiters.splice(0)) w(png);
    }
    this.stats.record(interval, performance.now() - cpu0);
    for (const l of this.listeners) l({ dt, realDt, time: this.clock.time });
  }

  /** Stops the loop and removes the stage's listeners (the model is not disposed). */
  dispose(): void {
    this.stop();
    this.unbind();
    this.listeners.length = 0;
    this.beforeListeners.length = 0;
  }
}

/** Parses "#rrggbb" into [0, 1] RGB. */
export function parseHexColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Converts a CSS "rgb(r, g, b)" / "rgba(...)" string to "#rrggbb" (fallback for anything else). */
export function cssColorToHex(css: string, fallback = "#e9e9ee"): string {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(css);
  if (!m) return fallback;
  return "#" + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("");
}

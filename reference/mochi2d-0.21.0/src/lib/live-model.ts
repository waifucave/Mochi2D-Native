/**
 * A model on screen: a {@link ModelRuntime} (animation and evaluation) drawn
 * by the {@link ModelRenderer} with its textures, under a movable view.
 *
 * Every frame runs the animation frame procedure (3j) with the
 * stage's time step, then evaluates the model and hands the new vertices to
 * the renderer only if a value changed. Unlike reference renders, drawing
 * uses the canvas's antialiasing and the mask atlas by default (an
 * approximation, see mask-atlas.ts; the per-drawable reference masks are a
 * setting away), the view can be zoomed and panned, and nothing is redrawn
 * while nothing changes.
 */
import type { LoadedModel } from "../core/model/evaluate.js";
import type { ModelInstance } from "../core/eval/instance.js";
import {
  frameImage,
  imagePosition,
  outputPosition,
  outputStep,
  type Framing,
} from "../core/render/framing.js";
import {
  ModelRenderer,
  REFERENCE_MASK_SIZE,
  type FrameInsert,
} from "../render/model/model-renderer.js";
import type { TextureLoader, LoadedTexture } from "../render/texture/loader.js";
import type { TextureSource } from "../render/gl/texture.js";
import type { GpuMemoryTracker } from "../render/gl/gpu-memory.js";
import type { Animator, FrameResult } from "../anim/animator.js";
import type { Motion } from "../anim/motion.js";
import type { Expression } from "../anim/expression.js";
import type { DisplayInfo } from "../anim/model-data.js";
import type { ModelRuntime, MotionPlayback } from "../runtime/model-runtime.js";
import type { ParameterInfo, PartInfo, StageModel } from "./stage-model.js";
import { downscaleNotice } from "./texture-notice.js";

/**
 * Mask settings: the atlas at 2 (default) or 4 texels per image pixel, or
 * per-drawable masks with a buffer of 2048 or the reference 4096.
 */
export type MaskSetting = "atlas" | "atlas-fine" | "2048" | "4096";
export const DEFAULT_MASK_SETTING: MaskSetting = "atlas";

/** Per-drawable buffer size used by the atlas setting when its layout does not fit. */
const FALLBACK_MASK_SIZE = 2048;

/** The default view leaves this fraction of the image for the model's canvas rectangle. */
export const DEFAULT_FIT = 0.95;

/** The effects the viewer offers switches for. */
export type ViewerEffect = "physics" | "eyeBlink" | "breath" | "look" | "lipSync";

export interface LiveModelOptions {
  memory?: GpuMemoryTracker;
  masks?: MaskSetting;
  /** Fraction of the image the model's canvas rectangle fills in the default view. */
  fit?: number;
  /** Time draws on the GPU when the browser allows it (stats only). Default true. */
  gpuTiming?: boolean;
  /**
   * Which mask meshes are rasterized: "active" (default; after the first
   * frame, only the meshes the latest evaluation recomputed, C13) or "all"
   * (the reference renders' rule, 4f).
   */
  maskMeshes?: "active" | "all";
}

/**
 * Something drawn with a model and updated after it: the items of a view
 * (items/item-layer.ts).
 */
export interface ModelOverlay {
  /** After the model's own frame (its evaluation is current). */
  update(dt: number, main: LiveModel): void;
  /** Whether the next frame would differ from the last one drawn. */
  needsRedraw(width: number, height: number, main: LiveModel): boolean;
  /** Offscreen work before anything is drawn onto the canvas. */
  prepare(width: number, height: number, main: LiveModel): void;
  /** Draws onto the canvas behind (`front` false) or in front of the model. */
  draw(width: number, height: number, main: LiveModel, front: boolean): void;
  /** What to draw at places in the model's render order this frame, or null. */
  inserts?(width: number, height: number, main: LiveModel): ReadonlyMap<number, FrameInsert> | null;
}

export class LiveModel implements StageModel {
  readonly name: string;
  readonly parameters: ParameterInfo[];
  readonly parts: PartInfo[];
  readonly runtime: ModelRuntime;
  readonly renderer: ModelRenderer;
  /**
   * View relative to the default framing: zoom factor, the model point at the
   * image center as an offset from the default one (output units, y up), and
   * the counterclockwise turn of the picture about the image center (degrees).
   */
  readonly view = { zoom: 1, dx: 0, dy: 0, rotation: 0 };
  /** Text of the downscaled-textures notice, or null. */
  readonly textureNotice: string | null;
  fit: number;
  /** Milliseconds of the last animation frame, evaluation, and vertex hand-off. */
  lastAnimationMs = 0;
  lastEvaluationMs = 0;
  lastUpdateMs = 0;
  /** Called after each animation frame that ran. */
  onFrame: ((frame: FrameResult) => void) | null = null;
  /** Drawn with the model and updated after it (a view's items), or null. */
  overlay: ModelOverlay | null = null;
  /** Counts the evaluations handed to the renderer. */
  renderVersion = 0;
  /** The instance's evaluation count the renderer was last given. */
  private shownEvaluation = -1;
  /** Something changed since the last draw. */
  private changed = true;
  private drawnKey = "";
  private maskSetting: MaskSetting;
  private disposed = false;

  constructor(
    readonly gl: WebGL2RenderingContext,
    runtime: ModelRuntime,
    readonly textures: LoadedTexture[],
    private readonly loader: TextureLoader,
    private readonly options: LiveModelOptions = {},
  ) {
    this.runtime = runtime;
    this.name = runtime.settingsPath;
    this.fit = options.fit ?? DEFAULT_FIT;
    this.parameters = runtime.parameters.map((p) => ({
      id: p.id,
      label: p.name + (p.blendShape ? " (blend shape)" : ""),
      ...(p.group !== undefined ? { group: p.group } : {}),
      min: p.min,
      max: p.max,
      default: p.default,
    }));
    this.parts = runtime.parts.map((p) => ({
      id: p.id,
      label: p.name,
      defaultOpacity: p.defaultOpacity,
    }));
    const masks = options.masks ?? DEFAULT_MASK_SETTING;
    this.maskSetting = masks;
    this.renderer = new ModelRenderer(
      gl,
      runtime.model,
      textures.map((t) => t.texture),
      {
        ...LiveModel.rendererMasks(masks),
        // After its first frame, a viewer's flags hold only the latest
        // evaluation's recomputed meshes: the active ones (C13).
        maskMeshes: options.maskMeshes ?? "active",
        gpuTiming: options.gpuTiming ?? true,
        ...(options.memory ? { memory: options.memory } : {}),
      },
    );
    this.textureNotice = downscaleNotice(
      textures.map((t) => ({
        label: t.label,
        originalWidth: t.originalWidth,
        originalHeight: t.originalHeight,
        width: t.texture.width,
        height: t.texture.height,
      })),
    );
  }

  // ------------------------------------------------- runtime pass-through

  get instance(): ModelInstance {
    return this.runtime.instance;
  }

  get animator(): Animator {
    return this.runtime.animator;
  }

  /** The settings, settings path and `.moc3` model. */
  get loaded(): LoadedModel {
    const r = this.runtime;
    return { settings: r.settings, settingsPath: r.settingsPath, model: r.model };
  }

  get displayInfo(): DisplayInfo | null {
    return this.runtime.bundle.displayInfo;
  }

  get physicsDriven(): ReadonlyMap<string, string> {
    return this.runtime.physicsDriven;
  }

  get lipSyncFallback(): string | null {
    return this.runtime.lipSyncFallback;
  }

  get warnings(): string[] {
    return this.runtime.warnings;
  }

  get lastFrame(): FrameResult | null {
    return this.runtime.lastFrame;
  }

  get recentEvents(): string[] {
    return this.runtime.recentEvents;
  }

  // ------------------------------------------------------------- masks

  private static rendererMasks(setting: MaskSetting) {
    if (setting === "atlas" || setting === "atlas-fine")
      return {
        masks: "atlas" as const,
        maskSize: FALLBACK_MASK_SIZE,
        maskOversample: setting === "atlas" ? 2 : 4,
      };
    return {
      masks: "per-drawable" as const,
      maskSize: setting === "4096" ? REFERENCE_MASK_SIZE : 2048,
      maskOversample: 2,
    };
  }

  get masks(): MaskSetting {
    return this.maskSetting;
  }

  setMasks(setting: MaskSetting): void {
    if (setting === this.maskSetting) return;
    this.maskSetting = setting;
    const r = LiveModel.rendererMasks(setting);
    this.renderer.setMaskMode(r.masks, r.maskOversample);
    this.renderer.setMaskSize(r.maskSize);
    this.changed = true;
  }

  // ------------------------------------------------------------ inputs

  getParameter(id: string): number {
    return this.runtime.getParameter(id);
  }

  setParameter(id: string, value: number): void {
    this.runtime.setParameter(id, value);
  }

  getPartOpacity(id: string): number {
    return this.runtime.getPartOpacity(id);
  }

  setPartOpacity(id: string, value: number): void {
    this.runtime.setPartOpacity(id, value);
  }

  effect(name: ViewerEffect): boolean {
    return this.runtime.effect(name);
  }

  effectAvailable(name: ViewerEffect): boolean {
    return this.runtime.effectAvailable(name);
  }

  setEffect(name: ViewerEffect, on: boolean): void {
    this.runtime.setEffect(name, on);
  }

  lookRouting(): { target: string; writes: string }[] {
    return this.runtime.lookRouting();
  }

  /** Starts a motion with the defaults of answer Q8 (priority 2, the file's fades). */
  playMotion(
    motion: Motion,
    opts: {
      loop?: boolean;
      hold?: boolean;
      blinkWhileHeld?: boolean;
      fadeIn?: number;
      fadeOut?: number;
      sound?: Uint8Array | null;
    } = {},
  ): MotionPlayback | false {
    const accepted = this.runtime.playMotion(motion, {
      loop: opts.loop ?? false,
      ...(opts.hold ? { hold: true } : {}),
      ...(opts.blinkWhileHeld === false ? { blinkWhileHeld: false } : {}),
      ...(opts.fadeIn !== undefined ? { fadeIn: opts.fadeIn } : {}),
      ...(opts.fadeOut !== undefined ? { fadeOut: opts.fadeOut } : {}),
    });
    if (accepted && opts.sound !== undefined) this.startLipSync(opts.sound);
    return accepted;
  }

  playExpression(expression: Expression): void {
    this.runtime.playExpression(expression);
  }

  /** Stops all motions and clears the current priority (see {@link ModelRuntime.stopMotions}). */
  stopMotions(): void {
    this.runtime.stopMotions();
  }

  /** Starts lip sync on a WAV file (3s.1); returns false if it cannot be analysed. */
  startLipSync(bytes: Uint8Array | null): boolean {
    return this.runtime.startLipSyncWav(bytes);
  }

  /** Image pixel → look target, the way the reference viewer maps the pointer (3r.2). */
  lookTarget(px: number, py: number, width: number, height: number): [number, number] {
    const [x, y] = outputPosition(this.framing(width, height), px, py);
    const base = this.baseFraming(width, height);
    const half = Math.min(width, height) / 2;
    return [(base.k * (x - base.centerX)) / half, (base.k * (y - base.centerY)) / half];
  }

  /**
   * Sets the look target from an image pixel: origin at the canvas center, y
   * up, the shorter side spanning [−1, 1], with the view's zoom and pan
   * applied (3r.2).
   */
  lookAtPixel(px: number, py: number, width: number, height: number): void {
    const [x, y] = this.lookTarget(px, py, width, height);
    this.runtime.lookAt(x, y);
  }

  releaseLook(): void {
    this.runtime.releaseLook();
  }

  // ------------------------------------------------------------- frames

  update(dt: number): void {
    const t0 = performance.now();
    const r = this.runtime.animate(dt);
    const t1 = performance.now();
    if (r) this.lastAnimationMs = t1 - t0;
    // Evaluates when values changed or after a patch. An evaluation made
    // outside (`runtime.update(0)` between frames) is handed over too.
    const evaluated = this.runtime.evaluate();
    const inst = this.runtime.instance;
    if (inst.evaluations !== this.shownEvaluation) {
      const t2 = performance.now();
      this.renderer.update(inst);
      this.shownEvaluation = inst.evaluations;
      this.renderVersion++;
      if (evaluated) this.lastEvaluationMs = t2 - t1;
      this.lastUpdateMs = performance.now() - t2;
      this.changed = true;
    }
    if (r) this.onFrame?.(r);
    this.overlay?.update(dt, this);
  }

  needsRedraw(width: number, height: number): boolean {
    return (
      this.changed ||
      this.drawKey(width, height) !== this.drawnKey ||
      (this.overlay?.needsRedraw(width, height, this) ?? false)
    );
  }

  private drawKey(width: number, height: number): string {
    const v = this.view;
    const tints = this.runtime.tintVersion;
    return `${width}x${height} ${v.zoom} ${v.dx} ${v.dy} ${v.rotation} ${this.fit} ${tints}`;
  }

  // ---------------------------------------------------------------- view

  private baseFraming(width: number, height: number): Framing {
    const f = frameImage(this.runtime.model.canvas, width, height);
    return { ...f, k: f.k * this.fit };
  }

  /** The framing of a width × height image under the current view. */
  framing(width: number, height: number): Framing {
    const f = this.baseFraming(width, height);
    const rotation = this.view.rotation;
    return {
      ...f,
      k: f.k * this.view.zoom,
      centerX: f.centerX + this.view.dx,
      centerY: f.centerY + this.view.dy,
      ...(rotation ? { rotation } : {}),
    };
  }

  /** Image pixel → model output units (y up). */
  toModel(px: number, py: number, width: number, height: number): [number, number] {
    return outputPosition(this.framing(width, height), px, py);
  }

  /** Model output units (y up) → image pixel: the inverse of {@link toModel}. */
  toImage(x: number, y: number, width: number, height: number): [number, number] {
    return imagePosition(this.framing(width, height), x, y);
  }

  /** Zooms by `factor`, keeping the model point under image pixel (px, py) in place. */
  zoomAt(factor: number, px: number, py: number, width: number, height: number): void {
    const [x0, y0] = outputPosition(this.framing(width, height), px, py);
    this.view.zoom = Math.min(64, Math.max(1 / 16, this.view.zoom * factor));
    const [x1, y1] = outputPosition(this.framing(width, height), px, py);
    this.view.dx += x0 - x1;
    this.view.dy += y0 - y1;
  }

  /** An image-pixel step (y down) as a step in model output units (y up), under the view. */
  toModelStep(dx: number, dy: number, width: number, height: number): [number, number] {
    return outputStep(this.framing(width, height), dx, dy);
  }

  /** Moves the model by (dx, dy) image pixels (y down) on screen, whatever the rotation. */
  panBy(dx: number, dy: number, width: number, height: number): void {
    const [ux, uy] = this.toModelStep(dx, dy, width, height);
    this.view.dx -= ux;
    this.view.dy -= uy;
  }

  /** Turns the picture to `degrees` (counterclockwise) about the image center. */
  setRotation(degrees: number): void {
    this.view.rotation = Number.isFinite(degrees) ? degrees : 0;
  }

  resetView(): void {
    this.view.zoom = 1;
    this.view.dx = 0;
    this.view.dy = 0;
    this.view.rotation = 0;
  }

  // ---------------------------------------------------------- hit areas

  /**
   * Image-space boxes of the settings' hit areas, from the latest evaluation
   * (3t). Under a rotated view, each is the box around the turned area.
   */
  hitAreaBoxes(
    width: number,
    height: number,
  ): { name: string; id: string; x: number; y: number; w: number; h: number }[] {
    const f = this.framing(width, height);
    return this.runtime.hitAreaBounds().map((a) => {
      const b = a.bounds;
      if (!f.rotation) {
        const [x0, y0] = imagePosition(f, b.minX, b.maxY);
        const [x1, y1] = imagePosition(f, b.maxX, b.minY);
        return { name: a.name, id: a.id, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      const corners = [
        imagePosition(f, b.minX, b.minY),
        imagePosition(f, b.maxX, b.minY),
        imagePosition(f, b.minX, b.maxY),
        imagePosition(f, b.maxX, b.maxY),
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      return {
        name: a.name,
        id: a.id,
        x: x0,
        y: y0,
        w: Math.max(...xs) - x0,
        h: Math.max(...ys) - y0,
      };
    });
  }

  /**
   * What lies under an image pixel: the hit areas whose drawable's box
   * contains it (3t), and the topmost visible drawable whose box does.
   */
  hitsAt(
    px: number,
    py: number,
    width: number,
    height: number,
  ): { hitAreas: string[]; topDrawable: string | null } {
    const [x, y] = this.toModel(px, py, width, height);
    return { hitAreas: this.runtime.hitAreasAt(x, y), topDrawable: this.runtime.drawableAt(x, y) };
  }

  draw(width: number, height: number): void {
    // The stage has cleared the canvas to its background.
    const overlay = this.overlay;
    if (overlay) {
      overlay.prepare(width, height, this);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      overlay.draw(width, height, this, false);
    }
    this.renderer.draw({
      framing: this.framing(width, height),
      target: null,
      clear: false,
      tints: this.runtime.activeTints,
      inserts: overlay?.inserts?.(width, height, this) ?? null,
    });
    overlay?.draw(width, height, this, true);
    this.drawnKey = this.drawKey(width, height);
    this.changed = false;
  }

  /**
   * Replaces texture `index`, or the region of it at (x, y), with `source`
   * (straight alpha), prepared as at load; drawn from the next frame.
   */
  updateTexture(index: number, source: TextureSource, x = 0, y = 0): void {
    const t = this.textures[index];
    if (!t) throw new RangeError(`texture ${index}: the model has ${this.textures.length}`);
    this.loader.updateTexture(t, source, x, y);
    // The picture changed: draw again (views, items and sprites key on renderVersion).
    this.renderVersion++;
    this.changed = true;
  }

  /**
   * The same model shown with another runtime (other model data, for
   * `MochiModel.replace`): a new renderer over this one's textures, with this
   * one's view, fit and mask settings. This one hands its textures over and
   * is disposed.
   */
  withRuntime(runtime: ModelRuntime): LiveModel {
    const fresh = new LiveModel(this.gl, runtime, this.textures, this.loader, {
      ...this.options,
      masks: this.maskSetting,
      fit: this.fit,
    });
    Object.assign(fresh.view, this.view);
    this.disposed = true;
    this.renderer.dispose();
    return fresh;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.dispose();
    this.loader.release(this.textures);
    this.loader.dispose();
  }
}

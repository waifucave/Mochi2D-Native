/**
 * Mochi2D in a PixiJS v8 scene: {@link MochiSprite}, a display object that
 * shows a model.
 *
 * ```ts
 * import { Application } from "pixi.js";
 * import { MochiSprite } from "mochi2d/pixi";
 *
 * const app = new Application();
 * await app.init({ width: 800, height: 600 });
 * const chan = await MochiSprite.from("models/chan/chan.model3.json", {
 *   renderer: app.renderer,
 *   ticker: app.ticker,
 * });
 * chan.scale.set(0.25);
 * app.stage.addChild(chan);
 * chan.on("hit", (e) => chan.model.startMotion("TapBody"));
 * ```
 *
 * The model is drawn by Mochi2D's renderer into a texture of Pixi's, on
 * Pixi's own WebGL context, before each Pixi frame; Pixi then draws that
 * texture like a sprite's, so the sprite takes its transform, alpha, tint,
 * blend mode, masks and filters from Pixi as any sprite does. The texture
 * follows the sprite's size on screen. With a WebGPU renderer (or `context:
 * "own"`), the model is drawn in a WebGL context of its own and the picture
 * is handed to Pixi as a canvas texture.
 *
 * This module re-exports the whole browser API (`mochi2d`), so a Pixi app
 * imports everything from `mochi2d/pixi` and has one copy of Mochi2D.
 * PixiJS is a peer dependency: this bundle imports `pixi.js` and does not
 * include it.
 */
import {
  CanvasSource,
  Container,
  RendererType,
  RenderTexture,
  Sprite,
  Texture,
  Ticker,
  UPDATE_PRIORITY,
  type ContainerOptions,
  type DestroyOptions,
  type FederatedPointerEvent,
  type Matrix,
  type PointData,
  type Renderer,
  type RenderOptions,
  type WebGLRenderer,
} from "pixi.js";
import type { ModelRuntime, MotionEnd, RuntimeOptions } from "../runtime/model-runtime.js";
import { frameImage } from "../core/render/framing.js";
import { LiveModel, type MaskSetting } from "./live-model.js";
import { loadLiveModel } from "./load.js";
import { MochiModel, type ModelHost } from "./model.js";
import { openModelInput, type ModelInput } from "./sources.js";
import { SpeechPlayer, type SpeechPlayback } from "./speech.js";
import { LiveInputs } from "./live-lip-sync.js";
import {
  deviceProfile,
  resolveTextureBudget,
  type TextureBudgetSetting,
} from "./texture-budget.js";

export * from "./index.js";

export interface MochiSpriteOptions {
  /** The Pixi renderer the sprite is drawn with (`app.renderer`). */
  renderer: Renderer;
  /**
   * The ticker that advances the model's animation: `app.ticker`, another
   * ticker, or null to advance it yourself with {@link MochiSprite.update}.
   * Default `Ticker.shared`.
   */
  ticker?: Ticker | null;
  /** Which settings file to load when the input holds several (path inside the input). */
  settings?: string;
  /**
   * Where the model is drawn: "shared" draws on the Pixi renderer's WebGL
   * context into a Pixi texture; "own" draws in a WebGL context of the
   * sprite's own and uploads the picture to Pixi. Default "shared" with a
   * WebGL 2 renderer, "own" otherwise (WebGPU).
   */
  context?: "shared" | "own";
  /**
   * The eyes and head follow the pointer over the Pixi canvas ("follow"), or
   * not ("off"). Default "follow".
   */
  look?: "follow" | "off";
  /**
   * What counts as the sprite for Pixi's pointer events: "meshes" (default),
   * the boxes of the visible art meshes; "canvas", the model's whole canvas
   * rectangle.
   */
  hitArea?: "meshes" | "canvas";
  /**
   * Texture pixels per screen pixel. Default the renderer's resolution. The
   * texture follows the sprite's scale on screen in steps of an eighth of an
   * octave.
   */
  resolution?: number;
  /** Largest texture side, in pixels. Default 4096 (or the GPU's limit if lower). */
  maxTextureSize?: number;
  /**
   * Extra room around the model's canvas rectangle, in the sprite's local
   * units (canvas pixels), for models that reach outside it. Default 0.
   */
  padding?: number;
  /** Masks: the atlas (default), the finer atlas, or per-drawable reference masks. */
  masks?: "atlas" | "atlas-fine" | "reference";
  /** Texture budget, as for {@link MochiView}. Default "auto". */
  textureBudget?: TextureBudgetSetting;
  /** Options of the model's runtime. */
  runtime?: RuntimeOptions;
  /** Other Pixi container options (position, scale, label, …). */
  container?: ContainerOptions;
}

/** A tap on the sprite over one or more hit areas. */
export interface MochiHitEvent {
  /** The hit areas under the pointer (names, or IDs without a name), as `TapEvent.areas`. */
  areas: string[];
  /** The point in model units (x right, y up). */
  x: number;
  y: number;
  /** Pixi's pointer event. */
  event: FederatedPointerEvent;
}

/** The sprite's own events, besides Pixi's. */
export interface MochiSpriteEvents {
  /** A tap (pointertap) over hit areas. */
  hit: [MochiHitEvent];
  /** A motion's user event. */
  motionevent: [{ value: string }];
  /** A motion ended (finished, stopped or replaced). */
  motionend: [MotionEnd];
  /** The model's textures and renderer are back after a lost WebGL context. */
  contextrestored: [Record<string, never>];
  /** Loading again after a lost context failed. */
  error: [{ error: unknown }];
}

const MASKS: Record<NonNullable<MochiSpriteOptions["masks"]>, MaskSetting> = {
  atlas: "atlas",
  "atlas-fine": "atlas-fine",
  reference: "4096",
};

// ------------------------------------------------------------ the GL share

/**
 * The sprites of one renderer. Before each Pixi frame (the `prerender`
 * runner) it draws the sprites the frame shows. Sprites drawing on the
 * renderer's WebGL context then hand it back with `renderer.resetState()`,
 * as Pixi asks of other code that uses its context; while a model loads on
 * the context, its GL work runs between Pixi frames, and the context is
 * handed back before and after each frame.
 */
class FrameHook {
  private static readonly hooks = new WeakMap<Renderer, FrameHook>();
  readonly sprites = new Set<MochiSprite>();
  /** Loads in progress on the context. */
  loading = 0;
  /** Mochi2D changed GL state since Pixi's last frame. */
  dirty = false;
  private readonly runner = {
    prerender: (options: RenderOptions) => this.prerender(options),
    postrender: () => this.postrender(),
    // Emitted when a lost WebGL context is restored (Pixi rebuilds its own objects).
    contextChange: () => {
      for (const s of this.sprites) s._contextRestored(true);
    },
  };

  static of(renderer: Renderer): FrameHook {
    let hook = FrameHook.hooks.get(renderer);
    if (!hook) {
      hook = new FrameHook(renderer);
      FrameHook.hooks.set(renderer, hook);
    }
    return hook;
  }

  private constructor(readonly renderer: Renderer) {
    renderer.runners.prerender.add(this.runner);
    renderer.runners.postrender.add(this.runner);
    renderer.runners.contextChange.add(this.runner);
  }

  /** The renderer's WebGL 2 context (a WebGL renderer's only). */
  get gl(): WebGL2RenderingContext {
    return (this.renderer as WebGLRenderer).gl as WebGL2RenderingContext;
  }

  get webgl(): WebGLRenderer {
    return this.renderer as WebGLRenderer;
  }

  /** Before Mochi2D's GL work: Pixi's vertex array is not to be touched. */
  enter(): WebGL2RenderingContext {
    const gl = this.gl;
    gl.bindVertexArray(null);
    this.dirty = true;
    return gl;
  }

  private prerender(options: RenderOptions): void {
    const root = options.container;
    for (const s of this.sprites) if (shownUnder(s, root)) s._beforeFrame();
    if (this.dirty || this.loading > 0) this.renderer.resetState();
    this.dirty = false;
  }

  private postrender(): void {
    // A load's GL work may run before the next frame: unbind Pixi's state.
    if (this.loading > 0) this.renderer.resetState();
  }

  remove(sprite: MochiSprite): void {
    this.sprites.delete(sprite);
  }
}

/** Whether a frame rendering `root` shows `c` (visible and renderable up to root). */
function shownUnder(c: Container, root: Container | undefined): boolean {
  for (let n: Container | null = c; n; n = n.parent) {
    if (!n.visible || !n.renderable) return false;
    if (n === root) return true;
  }
  return root === undefined;
}

// ---------------------------------------------------------------- the sprite

/** Scale steps: the texture changes size when the screen scale crosses 2^(n/8). */
function stepScale(s: number): number {
  if (!(s > 0) || !Number.isFinite(s)) return 1;
  return 2 ** (Math.ceil(Math.log2(s) * 8 - 1e-6) / 8);
}

/**
 * A model in a Pixi scene. Its local coordinates are the model's canvas in
 * pixels: (0, 0) at the canvas's top-left corner, `canvasWidth` ×
 * `canvasHeight`, y down, as for a sprite of the model's art at full size.
 * Position, scale, rotate, fade, tint, mask and filter it as any Pixi
 * container. {@link model} is Mochi2D's model API (parameters, motions,
 * expressions, look, lip sync, physics, tints).
 */
export class MochiSprite extends Container implements ModelHost {
  /** Mochi2D's model API. */
  readonly model: MochiModel;
  /** The model's canvas size in pixels: the sprite's local size before padding. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** @internal */
  readonly speech = new SpeechPlayer();
  /** @internal */
  readonly liveInputs = new LiveInputs(() => this.speech.context());
  private readonly view: Sprite;
  /** The renderer's hook; `shared` when drawing on its context. */
  private readonly hook: FrameHook;
  private readonly share: FrameHook | null;
  private readonly ownCanvas: HTMLCanvasElement | null;
  private readonly glContext: WebGL2RenderingContext;
  private readonly padding: number;
  private readonly resolutionOption: number | undefined;
  private readonly maxSide: number;
  private target: RenderTexture | CanvasSource | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private attached: WebGLTexture | null = null;
  private drawnKey = "";
  private drawnLive: LiveModel | null = null;
  private readonly renderer: Renderer;
  private ticker: Ticker | null = null;
  private waiters: { done: () => boolean; resolve: () => void }[] = [];
  private unbindLook: (() => void) | null = null;
  private stopEnds: (() => void) | null = null;
  private gone = false;
  /** Textures and renderer are being loaded again after a lost context: draw nothing. */
  private restoring = 0;
  private readonly reloadOptions: { textureBudget: number | undefined; masks: MaskSetting };

  /**
   * Loads a model and makes a sprite of it: a URL of its settings file, a
   * zip, files, or a file source (see {@link ModelInput}).
   */
  static async from(input: ModelInput, options: MochiSpriteOptions): Promise<MochiSprite> {
    const renderer = options.renderer;
    const webgl2 =
      renderer.type === RendererType.WEBGL &&
      (renderer as WebGLRenderer).context.webGLVersion === 2;
    const mode = options.context ?? (webgl2 ? "shared" : "own");
    if (mode === "shared" && !webgl2)
      throw new Error('context "shared" needs a WebGL 2 renderer; use "own" with this one');
    const hook = FrameHook.of(renderer);
    const share = mode === "shared" ? hook : null;
    const canvas = share ? null : document.createElement("canvas");
    const gl = share
      ? share.gl
      : canvas!.getContext("webgl2", {
          alpha: true,
          premultipliedAlpha: true,
          antialias: false,
          depth: false,
          stencil: false,
          preserveDrawingBuffer: true,
        });
    if (!gl) throw new Error("WebGL 2 is not available for the model");
    const opened = await openModelInput(input, options.settings);
    const profile = deviceProfile();
    // The sprite exists before the runtime so that motion sounds play through it.
    let sprite: MochiSprite | null = null;
    if (share) share.loading++;
    let live: LiveModel;
    try {
      if (share) share.enter();
      live = await loadLiveModel(gl, opened.source, opened.settingsPath, {
        textureBudget: resolveTextureBudget(options.textureBudget ?? "auto", profile).bytes,
        ...(profile.constrained ? { decodeWorkers: 1 } : {}),
        masks: MASKS[options.masks ?? "atlas"],
        fit: 1,
        runtime: {
          ...options.runtime,
          onSound: (_path, bytes) => (sprite ? sprite.playMotionSound(bytes) : () => null),
        },
      });
      if (share) share.enter();
      live.update(0);
    } finally {
      if (share) share.loading--;
    }
    sprite = new MochiSprite(live, options, hook, share, canvas, gl);
    return sprite;
  }

  private constructor(
    live: LiveModel,
    options: MochiSpriteOptions,
    hook: FrameHook,
    share: FrameHook | null,
    canvas: HTMLCanvasElement | null,
    gl: WebGL2RenderingContext,
  ) {
    super(options.container);
    this.hook = hook;
    this.share = share;
    this.renderer = options.renderer;
    this.ownCanvas = canvas;
    this.glContext = gl;
    this.padding = Math.max(0, options.padding ?? 0);
    this.reloadOptions = {
      textureBudget: resolveTextureBudget(options.textureBudget ?? "auto", deviceProfile()).bytes,
      masks: MASKS[options.masks ?? "atlas"],
    };
    this.resolutionOption = options.resolution;
    this.maxSide = Math.min(
      options.maxTextureSize ?? 4096,
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    );
    const c = live.runtime.model.canvas;
    this.canvasWidth = c.width;
    this.canvasHeight = c.height;
    this.model = new MochiModel(this, live);
    this.view = new Sprite(Texture.EMPTY);
    this.view.label = "mochi2d-picture";
    this.addChild(this.view);
    this.attach();
    // Pointer events: hit areas on tap, and the sprite's shape for Pixi.
    if (this.eventMode === "passive" || this.eventMode === "auto") this.eventMode = "static";
    if ((options.hitArea ?? "meshes") === "meshes")
      this.hitArea = { contains: (x: number, y: number) => this.meshAt(x, y) };
    this.on("pointertap", (e: FederatedPointerEvent) => this.onTap(e));
    if ((options.look ?? "follow") === "follow") this.followPointer(options.renderer);
    // Updates.
    this.setTicker(options.ticker === undefined ? Ticker.shared : options.ticker);
    hook.sprites.add(this);
    if (canvas) {
      // A context of its own: keep it restorable, and load again when it is back.
      const lost = (e: Event) => {
        e.preventDefault();
        this.restoring++;
      };
      const restored = () => {
        this.restoring--;
        this._contextRestored(false);
      };
      canvas.addEventListener("webglcontextlost", lost);
      canvas.addEventListener("webglcontextrestored", restored);
    }
  }

  /**
   * @internal After a lost WebGL context came back (Pixi's `contextChange` for
   * the shared context, the canvas's event for an own one): loads the
   * textures and renderer again with the same runtime, keeping the animation
   * state, as `MochiView` does. Draws nothing meanwhile; emits
   * `"contextrestored"` when done (`"error"` with the error otherwise).
   */
  _contextRestored(shared: boolean): void {
    if (this.gone || this.model.disposed || shared !== (this.share !== null)) return;
    void this.reloadGpu();
  }

  private async reloadGpu(): Promise<void> {
    const share = this.share;
    const gl = this.glContext;
    this.restoring++;
    if (share) share.loading++;
    this.framebuffer = null;
    this.attached = null;
    this.drawnKey = "";
    try {
      let old = this.model.live;
      const load = (from: LiveModel) => {
        share?.enter();
        return loadLiveModel(gl, from.runtime.source, from.runtime.settingsPath, {
          reuse: from.runtime,
          textureBudget: this.reloadOptions.textureBudget,
          masks: from.masks,
          fit: 1,
        });
      };
      let fresh = await load(old);
      // Other data was shown meanwhile (model.replace): load for that.
      while (this.model.live !== old && !this.model.disposed) {
        fresh.dispose();
        old = this.model.live;
        fresh = await load(old);
      }
      share?.enter();
      old.dispose();
      if (this.gone || this.model.disposed) return fresh.dispose();
      this.model.live = fresh;
      fresh.runtime.touch();
      fresh.update(0);
      this.attach();
      this.emit("contextrestored", {});
    } catch (error) {
      this.emit("error", { error });
    } finally {
      if (share) share.loading--;
      this.restoring--;
    }
  }

  // ------------------------------------------------------------ updates

  /**
   * The ticker that advances the animation, or null (advance it with
   * {@link update}).
   */
  setTicker(ticker: Ticker | null): void {
    this.ticker?.remove(this.tick, this);
    this.ticker = ticker;
    ticker?.add(this.tick, this, UPDATE_PRIORITY.NORMAL);
  }

  private tick(ticker: Ticker): void {
    this.update(ticker.deltaMS / 1000);
  }

  /** Advances the animation by `seconds` and evaluates the model. */
  update(seconds: number): void {
    if (this.gone || this.model.disposed || this.restoring > 0) return;
    this.share?.enter();
    this.model.live.update(seconds);
    for (const w of this.waiters.filter((w) => w.done())) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.resolve();
    }
  }

  // ------------------------------------------------------------ drawing

  /** The texture size and framing for the sprite's current scale on screen. */
  private layout(): { width: number; height: number; scale: number } {
    const m: Matrix = this.getGlobalTransform(undefined, false);
    const screen = Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
    const res = this.resolutionOption ?? this.renderer.resolution;
    const w = this.canvasWidth + 2 * this.padding;
    const h = this.canvasHeight + 2 * this.padding;
    let s = stepScale(screen * res);
    const fitMax = this.maxSide / Math.max(w, h);
    if (s > fitMax) s = fitMax;
    return {
      width: Math.max(1, Math.ceil(w * s)),
      height: Math.max(1, Math.ceil(h * s)),
      scale: s,
    };
  }

  /** Draws the model if anything changed: into `fb`, `width` × `height` image pixels. */
  private drawModel(fb: WebGLFramebuffer | null, width: number, height: number, s: number): void {
    const live = this.model.live;
    const c = live.runtime.model.canvas;
    const base = frameImage(c, c.width, c.height);
    live.renderer.draw({
      framing: { width, height, k: base.k * s, centerX: base.centerX, centerY: base.centerY },
      target: fb,
      clear: true,
      background: [0, 0, 0, 0],
      tints: live.runtime.activeTints,
    });
  }

  /** Places the picture: `width` × `height` texture pixels at `s` per local unit. */
  private place(width: number, height: number, s: number, flipped: boolean): void {
    const v = this.view;
    const x = this.canvasWidth / 2 - width / (2 * s);
    const y = this.canvasHeight / 2 - height / (2 * s);
    v.position.set(x, flipped ? y + height / s : y);
    v.scale.set(1 / s, flipped ? -1 / s : 1 / s);
  }

  private changeKey(width: number, height: number): string {
    const live = this.model.live;
    return `${width}x${height} ${live.renderVersion} ${live.runtime.tintVersion} ${live === this.drawnLive}`;
  }

  /** @internal Before a Pixi frame that shows the sprite: draws the model if anything changed. */
  _beforeFrame(): void {
    if (this.gone || this.model.disposed || this.restoring > 0) return;
    if (this.share) this.drawShared(this.share);
    else this.drawOwn();
  }

  private drawShared(share: FrameHook): void {
    const { width, height, scale } = this.layout();
    const key = this.changeKey(width, height);
    let rt = this.target as RenderTexture | null;
    if (!rt) {
      rt = RenderTexture.create({ width, height, resolution: 1, antialias: false, dynamic: true });
      rt.source.style.scaleMode = "linear";
      this.target = rt;
      this.view.texture = rt;
    } else if (rt.source.pixelWidth !== width || rt.source.pixelHeight !== height) {
      rt.source.resize(width, height, 1);
    } else if (key === this.drawnKey) return;
    const gl = share.enter();
    const glTexture = share.webgl.texture.getGlSource(rt.source).texture;
    if (!this.framebuffer) this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    if (this.attached !== glTexture) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glTexture, 0);
      this.attached = glTexture;
    }
    this.drawModel(this.framebuffer, width, height, scale);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Pixi's texture rows run top to bottom; the renderer's GL images bottom to top.
    this.place(width, height, scale, true);
    this.drawnLive = this.model.live;
    this.drawnKey = this.changeKey(width, height);
  }

  /** Draws in the sprite's own context and hands the canvas to Pixi. */
  private drawOwn(): void {
    const canvas = this.ownCanvas!;
    const { width, height, scale } = this.layout();
    const key = this.changeKey(width, height);
    if (key === this.drawnKey && this.target) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.drawModel(null, width, height, scale);
    let source = this.target as CanvasSource | null;
    if (!source) {
      source = new CanvasSource({ resource: canvas, resolution: 1, scaleMode: "linear" });
      this.target = source;
      this.view.texture = new Texture({ source });
    } else if (source.pixelWidth !== width || source.pixelHeight !== height) {
      source.resize(width, height, 1);
      this.view.texture = new Texture({ source });
    }
    source.update();
    this.place(width, height, scale, false);
    this.drawnLive = this.model.live;
    this.drawnKey = this.changeKey(width, height);
  }

  // ---------------------------------------------------------- pointer

  /** Model units (x right, y up) of a point in the sprite's local coordinates. */
  localToModel(x: number, y: number): { x: number; y: number } {
    const c = this.model.live.runtime.model.canvas;
    const base = frameImage(c, c.width, c.height);
    return {
      x: base.centerX + (x - c.width / 2) / base.k,
      y: base.centerY - (y - c.height / 2) / base.k,
    };
  }

  /** Model units of a point in Pixi's global (stage) coordinates. */
  toModel(global: PointData): { x: number; y: number } {
    const p = this.toLocal(global);
    return this.localToModel(p.x, p.y);
  }

  /** The hit areas at a point in global coordinates (names, or IDs without a name). */
  hitTest(global: PointData): string[] {
    const p = this.toModel(global);
    return this.model.runtime.hitAreasAt(p.x, p.y);
  }

  /** The topmost visible art mesh whose box holds a global point, or null. */
  meshAtPoint(global: PointData): string | null {
    const p = this.toModel(global);
    return this.model.runtime.drawableAt(p.x, p.y);
  }

  private meshAt(x: number, y: number): boolean {
    if (this.model.disposed) return false;
    const p = this.localToModel(x, y);
    return this.model.runtime.drawableAt(p.x, p.y) !== null;
  }

  private onTap(event: FederatedPointerEvent): void {
    if (this.model.disposed) return;
    const p = this.toModel(event.global);
    const areas = this.model.runtime.hitAreasAt(p.x, p.y);
    if (areas.length) this.emit("hit", { areas, x: p.x, y: p.y, event } satisfies MochiHitEvent);
  }

  /**
   * Look target from a global point: the model's canvas center is the
   * origin, x right and y up, the canvas's shorter side spans [−1, 1].
   */
  lookAtPoint(global: PointData): void {
    const p = this.toLocal(global);
    const half = Math.min(this.canvasWidth, this.canvasHeight) / 2;
    this.model.lookAt((p.x - this.canvasWidth / 2) / half, -(p.y - this.canvasHeight / 2) / half);
  }

  private followPointer(renderer: Renderer): void {
    const move = (e: FederatedPointerEvent) => this.lookAtPoint(e.global);
    this.on("globalpointermove", move);
    const canvas = renderer.canvas as HTMLCanvasElement;
    const leave = () => this.model.stopLooking();
    canvas.addEventListener?.("pointerleave", leave);
    this.unbindLook = () => {
      this.off("globalpointermove", move);
      canvas.removeEventListener?.("pointerleave", leave);
    };
  }

  // ------------------------------------------------------- model host

  private attach(): void {
    const model = this.model;
    model.live.onFrame = (r) => {
      for (const value of r.events) this.emit("motionevent", { value });
    };
    this.stopEnds?.();
    this.stopEnds = model.runtime.onMotionEnd((end) => this.emit("motionend", end));
  }

  /** @internal The model's own GL work (a texture update) on Pixi's context: hand it back after. */
  beforeGl(): void {
    this.share?.enter();
  }

  /** @internal */
  waitUntil(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ done, resolve }));
  }

  /** @internal */
  release(model: MochiModel): void {
    if (model !== this.model) return;
    this.share?.enter();
    this.stopEnds?.();
    this.stopEnds = null;
    for (const w of this.waiters.splice(0)) w.resolve();
    this.view.visible = false;
  }

  /** @internal */
  replaceRuntime(model: MochiModel, runtime: ModelRuntime): void {
    this.share?.enter();
    const fresh = model.live.withRuntime(runtime);
    model.live = fresh;
    fresh.runtime.touch();
    fresh.update(0);
    this.attach();
  }

  private playMotionSound(bytes: Uint8Array): () => number | null {
    let playback: SpeechPlayback | null = null;
    let failed = false;
    void (async () => {
      try {
        const p = await this.speech.prepare(bytes);
        if (p.buffer) playback = this.speech.play(p.buffer);
        else failed = true;
      } catch {
        failed = true;
      }
    })();
    return () => (playback ? playback.position() : failed ? null : 0);
  }

  /** Removes the sprite, disposes the model and frees its GPU resources. */
  override destroy(options?: DestroyOptions): void {
    if (this.gone) return super.destroy(options);
    this.setTicker(null);
    this.unbindLook?.();
    this.model.dispose();
    this.gone = true;
    this.hook.remove(this);
    if (this.share) {
      const gl = this.share.enter();
      if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    } else {
      this.glContext.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.view.texture = Texture.EMPTY;
    if (this.target instanceof RenderTexture) this.target.destroy(true);
    else this.target?.destroy();
    this.target = null;
    this.speech.dispose();
    super.destroy(options);
  }
}

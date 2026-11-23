/**
 * The embeddable player: a canvas that shows a model, animates it every frame,
 * and turns pointer input into look, taps and hit tests (and optionally zoom
 * and pan).
 *
 * ```ts
 * const view = new MochiView(canvas);
 * const model = await view.load("models/my-model/my-model.model3.json");
 * view.on("hit", (e) => model.startMotion("TapBody"));
 * ```
 */
import type { ArchiveLimits } from "../runtime/zip-source.js";
import type { FileLimits } from "../core/io/file-limits.js";
import type { TextureLimits } from "../core/image/texture-limits.js";
import {
  skippedSoundReason,
  skippedSoundWarning,
  type SoundOptions,
} from "../anim/sound-format.js";
import { mocInputBytes, sourceWithMoc, type MocInput } from "../runtime/moc-input.js";
import type { ModelRuntime, MotionEnd, RuntimeOptions } from "../runtime/model-runtime.js";
import { Emitter } from "./events.js";
import { bindGestures, type DragMode, type PressInfo } from "./gestures.js";
import { LiveModel, DEFAULT_FIT, type MaskSetting } from "./live-model.js";
import { loadLiveModel } from "./load.js";
import { MochiModel, type ModelHost } from "./model.js";
import { MochiItem, type ItemHost, type ItemLayoutEntry } from "./item.js";
import { ItemLayer, type ItemEntry } from "./items/item-layer.js";
import { readItemSettings } from "./items/item-settings.js";
import { checkedPlacement, type ItemPlacement } from "./items/placement.js";
import { openModelInput, type ModelInput } from "./sources.js";
import { SpeechPlayer, type SpeechPlayback } from "./speech.js";
import { LiveInputs } from "./live-lip-sync.js";
import type { LiveAudioChoice, RecordedAudio } from "./live-motion-sync.js";
import { currentFormatName } from "../core/format-names.js";
import { Stage } from "./stage.js";
import {
  defaultMaxPixelRatio,
  deviceProfile,
  resolveTextureBudget,
  type TextureBudgetSetting,
} from "./texture-budget.js";

export interface ViewOptions {
  /** A CSS color, or "transparent" (the page shows through). Default "transparent". */
  background?: string;
  /**
   * How the model looks at the pointer: "follow" (the mouse over the canvas,
   * or a finger dragging on it), "drag" (only while pressing), or "off".
   * Default "follow".
   */
  look?: "follow" | "drag" | "off";
  /** Wheel and pinch zoom; a double tap resets the view. Default false. */
  zoom?: boolean;
  /**
   * Dragging pans: shift-, middle- or right-drag with a mouse, any drag when
   * look is off. Default false.
   */
  pan?: boolean;
  /** Fraction of the canvas the model's own canvas rectangle fills. Default 0.95. */
  fit?: number;
  /**
   * Texture memory budget: "auto" (256 MiB on phones and tablets, 1 GiB
   * otherwise), "full" (no budget), or MiB. Default "auto".
   */
  textureBudget?: TextureBudgetSetting;
  /**
   * Clipping masks: "atlas" (fast, default), "atlas-fine", or "reference"
   * (the per-drawable masks of reference renders; slow).
   */
  masks?: "atlas" | "atlas-fine" | "reference";
  /**
   * Which mask meshes are rasterized: "active" (default; after the first
   * frame, only the meshes the latest evaluation recomputed) or "all"
   * (reference renders, 4f).
   */
  maskMeshes?: "active" | "all";
  /** Limit of the device pixel ratio for the drawing buffer. Default 2 on phones and tablets, else none. */
  maxPixelRatio?: number;
  /** Size the drawing buffer to the canvas's CSS size. Default true. */
  autoResize?: boolean;
  /** Start the render loop now. Default true. */
  autoStart?: boolean;
  /** Default true. */
  antialias?: boolean;
  /** Options for the models' runtimes (look through physics, lip-sync fallback, animation options). */
  runtime?: RuntimeOptions;
  /**
   * Pressing on an item drags it. A pinned item is pinned again where it is
   * dropped. Default false.
   */
  dragItems?: boolean;
  /**
   * While the clock is paused (and in `advance(0)`), physics-driven
   * parameters keep their last physics values, so hair and clothes stay
   * where they were when something else changes. Not reference behavior:
   * the reference writes no physics outputs in frames that take no time, so
   * those parameters fall back to their base values (false gives that).
   * Applies to the main model and to items. Default true.
   */
  holdPhysicsWhenPaused?: boolean;
}

/**
 * A view's zoom, offset and rotation, relative to the fitted view: the model's
 * canvas rectangle ({@link MochiModel.canvas}) centered in the canvas,
 * filling `fit` of it (0.95 by default) along its limiting side.
 */
export interface ViewTransform {
  /** Scale factor of the fitted view: 2 shows the model twice as large. */
  zoom: number;
  /**
   * The model point at the center of the canvas, as an offset from the
   * center of the model's canvas rectangle, in model units: x to the right,
   * y up, in the model's own directions (they turn with the model). Positive
   * x moves the model left on screen, positive y moves it down; 0, 0 centers
   * it. To move by screen pixels, use {@link MochiView.panBy}, or divide by
   * `pixelsPerUnit`.
   */
  x: number;
  y: number;
  /** Degrees the model is turned on screen, counterclockwise, about the canvas center. */
  rotation: number;
  /** CSS pixels one model unit spans on screen now (read only; 0 without a model). */
  pixelsPerUnit: number;
}

export interface AddItemOptions extends LoadOptions {
  /** Placement values to use instead of the defaults (see {@link ItemPlacement}). */
  placement?: Partial<ItemPlacement>;
  /**
   * The item's id in the view (unique; a duplicate is an error). Default
   * `<settings path>#<n>` (see {@link MochiItem.id}).
   */
  id?: string;
}

/**
 * Mochi2D's own file for where a view's items are: `mochi2d-item-layout/1`.
 * Files saved before the rename (`lively2d-item-layout/1`) are read too.
 * Items are matched by id, then the rest by settings path in order.
 */
export interface ItemLayout {
  format: "mochi2d-item-layout/1" | "lively2d-item-layout/1";
  /** The main model's settings path when the layout was saved (informational). */
  model: string | null;
  items: ItemLayoutEntry[];
}

export interface LoadOptions {
  /** Which settings file to load when the input holds several (path inside the input). */
  settings?: string;
  /**
   * Caps on what a zip input may inflate to (default `DEFAULT_ARCHIVE_LIMITS`):
   * `{ maxEntryBytes, maxTotalBytes, maxEntries }`.
   */
  archive?: ArchiveLimits;
  /**
   * Caps on the files read from a folder, a drop or a URL, a zip included
   * (default `DEFAULT_FILE_LIMITS`): `{ maxFileBytes, maxTotalBytes }`. A
   * download is streamed and stopped at the cap.
   */
  files?: FileLimits;
  /**
   * Caps on what the model's textures may declare (default
   * `DEFAULT_TEXTURE_LIMITS`): `{ maxSide, maxPixels, maxTotalPixels }`,
   * checked from their headers before anything is decoded.
   */
  textures?: TextureLimits;
  /**
   * How the model's motion sounds play: by default only WAV files;
   * `{ compressed: true }` lets the browser decode MP3, Ogg, FLAC and other
   * compressed sounds, for models you trust. Sounds that won't play are named
   * in the model's `warnings`.
   */
  sounds?: SoundOptions;
  /** Keep the current model's view (zoom, pan, rotation) for the new one. Default false. */
  keepView?: boolean;
  /**
   * The model as `.moc3` bytes or `{ data, version }` (written with
   * `writeMoc`), in place of the settings' `.moc3`, which then need not exist
   * in the input (experimental). The settings, textures and other files still
   * come from the input.
   */
  moc?: MocInput;
}

/** A tap (or click) on the canvas, with what lies under it. */
export interface TapEvent {
  model: MochiModel;
  /** Hit areas of the settings under the point (3t), by name. */
  areas: string[];
  /** The topmost visible drawable under the point, or null. */
  drawable: string | null;
  /** The point in model units (y up). */
  x: number;
  y: number;
  /** The point in page coordinates. */
  clientX: number;
  clientY: number;
}

export interface ViewEvents {
  /** Every tap or click that is not a drag. */
  tap: TapEvent;
  /** A tap on at least one of the settings' hit areas. */
  hit: TapEvent;
  /** A user event of a playing motion (3l.6). */
  motionevent: { model: MochiModel; value: string };
  /**
   * A motion ended (each motion once, idle motions included): which one, how
   * it was started, why it ended, and whether the queue is now empty (the
   * event before 0.4.0 fired only then). See {@link MotionEnd}.
   */
  motionend: MotionEnd & { model: MochiModel };
  /** A model was loaded and is shown. */
  load: { model: MochiModel };
  /** After every frame. `dt` is the model time step in seconds. */
  frame: { dt: number; time: number };
  /** An error in the background (for example reloading after a lost GPU context). */
  error: { error: unknown };
  /** The GPU context was lost; drawing pauses until it is restored. */
  contextlost: Record<string, never>;
  /** The GPU context is back and the model has been reloaded. */
  contextrestored: Record<string, never>;
}

const MASK_SETTINGS: Record<NonNullable<ViewOptions["masks"]>, MaskSetting> = {
  atlas: "atlas",
  "atlas-fine": "atlas-fine",
  reference: "4096",
};

export class MochiView implements ModelHost, ItemHost {
  readonly canvas: HTMLCanvasElement;
  readonly options: Readonly<ViewOptions>;
  /** @internal */
  readonly stage: Stage;
  /** @internal */
  readonly speech = new SpeechPlayer();
  /** @internal */
  readonly liveInputs = new LiveInputs(() => this.speech.context());
  private readonly events = new Emitter<ViewEvents>();
  private current: MochiModel | null = null;
  private loadToken = 0;
  private waiters: { done: () => boolean; resolve: () => void }[] = [];
  private readonly unbindGestures: () => void;
  private stopEnds: (() => void) | null = null;
  private disposed = false;
  private backgroundCss = "transparent";
  /** @internal */
  readonly itemLayer: ItemLayer;
  private readonly itemList: MochiItem[] = [];
  private itemDrag: { entry: ItemEntry; repin: boolean } | null = null;

  constructor(canvas: HTMLCanvasElement, options: ViewOptions = {}) {
    this.canvas = canvas;
    this.options = { ...options };
    const profile = deviceProfile();
    this.stage = new Stage(canvas, {
      antialias: options.antialias ?? true,
      maxPixelRatio: options.maxPixelRatio ?? defaultMaxPixelRatio(profile),
      autoResize: options.autoResize ?? true,
    });
    this.itemLayer = new ItemLayer(this.stage.gl);
    this.background = options.background ?? "transparent";
    const look = options.look ?? "follow";
    if (look !== "off" || options.zoom || options.pan) canvas.style.touchAction = "none";
    this.unbindGestures = bindGestures(
      canvas,
      {
        press: (x, y, info) => this.press(x, y, info),
        drag: (x, y, dx, dy, mode) => {
          const live = this.current?.live;
          if (!live) return;
          if (mode === "look") live.lookAtPixel(x, y, canvas.width, canvas.height);
          else if (mode === "pan") live.panBy(dx, dy, canvas.width, canvas.height);
          else if (mode === "item" && this.itemDrag) {
            const [ux, uy] = live.toModelStep(dx, dy, canvas.width, canvas.height);
            const p = this.itemDrag.entry.placement;
            p.x += ux;
            p.y += uy;
            this.itemLayer.touch();
          }
        },
        release: (mode) => {
          if (mode === "look") this.current?.live.releaseLook();
          if (mode === "item" && this.itemDrag) {
            if (this.itemDrag.repin) this.itemLayer.pin(this.itemDrag.entry);
            this.itemDrag = null;
          }
        },
        tap: (x, y, info) => {
          if (info.button === 0) this.tap(x, y);
        },
        ...(options.zoom || options.pan ? { doubleTap: () => this.resetView() } : {}),
        ...(options.zoom
          ? {
              pinch: (f: number, cx: number, cy: number, dx: number, dy: number) => {
                const live = this.current?.live;
                if (!live) return;
                live.zoomAt(f, cx, cy, canvas.width, canvas.height);
                live.panBy(dx, dy, canvas.width, canvas.height);
              },
              wheel: (f: number, x: number, y: number) =>
                this.current?.live.zoomAt(f, x, y, canvas.width, canvas.height),
            }
          : {}),
        ...(look === "follow"
          ? {
              hover: (x: number, y: number) =>
                this.current?.live.lookAtPixel(x, y, canvas.width, canvas.height),
              leave: () => this.current?.live.releaseLook(),
            }
          : {}),
      },
      { wheel: options.zoom ?? false },
    );
    this.stage.onFrame(({ dt, time }) => this.afterFrame(dt, time));
    this.stage.onContextLost = () => this.events.emit("contextlost", {});
    this.stage.onContextRestored = () => void this.restoreGpu();
    if (options.autoStart ?? true) this.stage.start();
  }

  // ------------------------------------------------------------- events

  on<K extends keyof ViewEvents>(type: K, listener: (event: ViewEvents[K]) => void): () => void {
    return this.events.on(type, listener);
  }

  once<K extends keyof ViewEvents>(type: K, listener: (event: ViewEvents[K]) => void): () => void {
    return this.events.once(type, listener);
  }

  off<K extends keyof ViewEvents>(type: K, listener: (event: ViewEvents[K]) => void): void {
    this.events.off(type, listener);
  }

  // ------------------------------------------------------------- models

  /** The model shown, or null. */
  get model(): MochiModel | null {
    return this.current;
  }

  /**
   * Loads a model and shows it in place of the current one, which is
   * disposed once the new one is ready. See {@link ModelInput} for inputs.
   */
  async load(input: ModelInput, options: LoadOptions = {}): Promise<MochiModel> {
    if (this.disposed) throw new Error("the view is disposed");
    const token = ++this.loadToken;
    const opened = await openModelInput(input, options.settings, options.archive, options.files);
    const source =
      options.moc === undefined
        ? opened.source
        : await sourceWithMoc(opened.source, opened.settingsPath, mocInputBytes(options.moc));
    const profile = deviceProfile();
    let loaded: LiveModel | null = null;
    const live = await loadLiveModel(this.stage.gl, source, opened.settingsPath, {
      textureBudget: resolveTextureBudget(this.options.textureBudget ?? "auto", profile).bytes,
      ...(options.textures ? { textures: options.textures } : {}),
      ...(options.sounds ? { sounds: options.sounds } : {}),
      ...(profile.constrained ? { decodeWorkers: 1 } : {}),
      masks: MASK_SETTINGS[this.options.masks ?? "atlas"],
      ...(this.options.maskMeshes ? { maskMeshes: this.options.maskMeshes } : {}),
      fit: this.options.fit ?? DEFAULT_FIT,
      memory: this.stage.memory,
      runtime: {
        ...this.runtimeOptions(),
        onSound: (path, bytes) =>
          this.playMotionSound(bytes, path, options.sounds, () => loaded?.runtime.warnings),
      },
    });
    loaded = live;
    if (token !== this.loadToken || this.disposed) {
      // A later load (or dispose) won.
      live.dispose();
      throw new DOMException("the load was superseded by a later one", "AbortError");
    }
    live.update(0);
    const model = new MochiModel(this, live);
    const previous = this.current;
    if (options.keepView && previous) Object.assign(live.view, previous.live.view);
    this.current = model;
    this.attach(model);
    previous?.dispose();
    this.events.emit("load", { model });
    return model;
  }

  /** Removes and disposes the current model. */
  unload(): void {
    this.current?.dispose();
  }

  private attach(model: MochiModel, keepPins = false): void {
    this.stage.model = model.live;
    this.itemLayer.attach(model.live, { keepPins });
    model.live.onFrame = (r) => {
      for (const value of r.events) this.events.emit("motionevent", { model, value });
    };
    this.stopEnds?.();
    this.stopEnds = model.runtime.onMotionEnd((end) =>
      this.events.emit("motionend", { ...end, model }),
    );
  }

  /** @internal */
  release(model: MochiModel): void {
    if (this.current !== model) return;
    this.stopEnds?.();
    this.stopEnds = null;
    this.current = null;
    this.stage.model = null;
    this.itemLayer.attach(null);
    for (const w of this.waiters.splice(0)) w.resolve();
  }

  /** The options of the runtimes this view loads: the app's, and the physics hold. */
  private runtimeOptions(): RuntimeOptions {
    return {
      ...this.options.runtime,
      holdPhysicsInZeroSteps: this.options.holdPhysicsWhenPaused ?? true,
    };
  }

  /** @internal */
  replaceRuntime(model: MochiModel, runtime: ModelRuntime): void {
    if (this.current === model) this.itemLayer.keepPinsFor(runtime.model);
    const fresh = model.live.withRuntime(runtime);
    model.live = fresh;
    fresh.runtime.touch();
    fresh.update(0);
    if (this.current === model) this.attach(model, true);
  }

  /** @internal */
  waitUntil(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ done, resolve }));
  }

  /**
   * Plays a motion's sound once decoded. Returns its clock for motion sync:
   * 0 while it decodes, then the playback position; null (count the frames)
   * when it cannot be played.
   */
  private playMotionSound(
    bytes: Uint8Array,
    path: string,
    sounds: SoundOptions | undefined,
    warnings: () => string[] | undefined,
  ): () => number | null {
    // A sound that won't play is named in the model's warnings, never dropped silently.
    const skip = (reason: string) => {
      const w = skippedSoundWarning(path, reason);
      const list = warnings();
      if (list && !list.includes(w)) list.push(w);
    };
    const reason = skippedSoundReason(bytes, sounds);
    if (reason) {
      skip(reason);
      return () => null;
    }
    let playback: SpeechPlayback | null = null;
    let failed = false;
    void (async () => {
      try {
        const p = await this.speech.prepare(bytes, { wavOnly: !sounds?.compressed });
        if (p.buffer) playback = this.speech.play(p.buffer);
        else {
          failed = true;
          skip("the browser could not decode it");
        }
      } catch (error) {
        failed = true;
        this.events.emit("error", { error });
      }
    })();
    return () => (playback ? playback.position() : failed ? null : 0);
  }

  /** After a lost GPU context: textures and renderer again, same animation state. */
  private async restoreGpu(): Promise<void> {
    this.itemLayer.resetGpu();
    await this.restoreItems();
    const model = this.current;
    if (!model) return this.events.emit("contextrestored", {});
    try {
      const reload = (old: LiveModel) =>
        loadLiveModel(this.stage.gl, old.runtime.source, old.runtime.settingsPath, {
          reuse: old.runtime,
          textureBudget: resolveTextureBudget(this.options.textureBudget ?? "auto", deviceProfile())
            .bytes,
          ...(old.textureLimits ? { textures: old.textureLimits } : {}),
          masks: old.masks,
          ...(this.options.maskMeshes ? { maskMeshes: this.options.maskMeshes } : {}),
          fit: old.fit,
          memory: this.stage.memory,
        });
      let old = model.live;
      let fresh = await reload(old);
      // Other data was shown meanwhile (MochiModel.replace): reload for that.
      while (model.live !== old && !model.disposed && this.current === model) {
        fresh.dispose();
        old = model.live;
        fresh = await reload(old);
      }
      Object.assign(fresh.view, old.view);
      old.dispose();
      if (model.disposed || this.current !== model) return fresh.dispose();
      model.live = fresh;
      fresh.runtime.touch();
      fresh.update(0);
      this.attach(model, true);
      this.events.emit("contextrestored", {});
    } catch (error) {
      this.events.emit("error", { error });
    }
  }

  // -------------------------------------------------------------- items

  /** The items over the main model, in drawing order within each side. */
  get items(): readonly MochiItem[] {
    return this.itemList;
  }

  /**
   * Loads a further model as an item over the current model. It takes the
   * same inputs as {@link load}. The item animates
   * on its own; when its folder has a `.vtube.json` with `ItemSettings`, it
   * is also fed the main model's head angles. By default it is centered on
   * the main model's canvas, at the same pixel size, in front.
   */
  async addItem(input: ModelInput, options: AddItemOptions = {}): Promise<MochiItem> {
    if (this.disposed) throw new Error("the view is disposed");
    if (!this.current) throw new Error("load a model before adding items");
    if (options.id !== undefined && this.itemList.some((i) => i.id === options.id))
      throw new Error(`the view already has an item with id "${options.id}"`);
    const opened = await openModelInput(input, options.settings, options.archive, options.files);
    const profile = deviceProfile();
    const live = await loadLiveModel(this.stage.gl, opened.source, opened.settingsPath, {
      textureBudget: resolveTextureBudget(this.options.textureBudget ?? "auto", profile).bytes,
      ...(options.textures ? { textures: options.textures } : {}),
      // Items play no motion sounds of their own; an app's onSound gets them.
      sounds: { ...options.sounds, played: this.options.runtime?.onSound !== undefined },
      ...(profile.constrained ? { decodeWorkers: 1 } : {}),
      masks: MASK_SETTINGS[this.options.masks ?? "atlas"],
      ...(this.options.maskMeshes ? { maskMeshes: this.options.maskMeshes } : {}),
      memory: this.stage.memory,
      runtime: this.runtimeOptions(),
    });
    if (this.disposed) {
      live.dispose();
      throw new DOMException("the view was disposed", "AbortError");
    }
    live.update(0);
    const settings = await readItemSettings(opened.source, opened.settingsPath);
    let id = options.id;
    if (id !== undefined && this.itemList.some((i) => i.id === id)) {
      live.dispose();
      throw new Error(`the view already has an item with id "${id}"`);
    }
    if (id === undefined) {
      const used = new Set(this.itemList.map((i) => i.id));
      let n = 1;
      while (used.has(`${opened.settingsPath}#${n}`)) n++;
      id = `${opened.settingsPath}#${n}`;
    }
    const entry = this.itemLayer.add(live, settings, options.placement);
    const item = new MochiItem(this, entry, id);
    this.itemList.push(item);
    return item;
  }

  /** The item with this id, or null. */
  item(id: string): MochiItem | null {
    return this.itemList.find((i) => i.id === id) ?? null;
  }

  /** @internal */
  raiseItem(item: MochiItem): void {
    const i = this.itemList.indexOf(item);
    if (i < 0) return;
    this.itemList.splice(i, 1);
    this.itemList.push(item);
    this.itemLayer.raise(item.entry);
  }

  /** @internal */
  releaseItem(item: MochiItem): void {
    const i = this.itemList.indexOf(item);
    if (i < 0) return;
    this.itemList.splice(i, 1);
    if (this.itemDrag?.entry === item.entry) this.itemDrag = null;
    this.itemLayer.remove(item.entry);
  }

  /** The item drawn topmost at a point given in page coordinates, or null. */
  itemAt(clientX: number, clientY: number): MochiItem | null {
    const [px, py] = this.pixel(clientX, clientY);
    return this.itemAtPixel(px, py);
  }

  private itemAtPixel(px: number, py: number): MochiItem | null {
    const live = this.current?.live;
    if (!live) return null;
    const [x, y] = live.toModel(px, py, this.canvas.width, this.canvas.height);
    const entry = this.itemLayer.itemAt(x, y);
    return this.itemList.find((i) => i.entry === entry) ?? null;
  }

  /**
   * Where the items are, as Mochi2D's own layout file (JSON-serializable).
   * The entries come in drawing order, as {@link items} lists them.
   */
  exportItemLayout(): ItemLayout {
    return {
      format: "mochi2d-item-layout/1",
      model: this.current?.name ?? null,
      items: this.itemList.map((item) => item.exportLayout()),
    };
  }

  /**
   * Applies a saved layout to the loaded items: entries are matched to items
   * by id first, then the remaining ones by settings path, in order (layouts
   * saved before 0.4.0 have no ids). Returns how many items it placed. A pin
   * is restored when the main model has its drawable and triangle; the
   * rotation is taken relative to the main model's current pose. The
   * entries' order is the drawing order: the placed items are drawn in it,
   * above the items the layout does not place, which keep their order.
   */
  applyItemLayout(layout: ItemLayout): number {
    if (
      currentFormatName(layout?.format) !== "mochi2d-item-layout/1" ||
      !Array.isArray(layout.items)
    )
      throw new Error("not a mochi2d-item-layout/1 file");
    // Malformed entries throw before anything is applied.
    layout.items.forEach((saved, k) => {
      try {
        checkedPlacement(saved?.placement ?? {});
      } catch (error) {
        throw new TypeError(`item layout entry ${k}: ${(error as Error).message}`);
      }
    });
    const free = [...this.itemList];
    const take = (match: (item: MochiItem) => boolean): MochiItem | null => {
      const i = free.findIndex(match);
      return i < 0 ? null : free.splice(i, 1)[0]!;
    };
    const targets = layout.items.map((saved) =>
      typeof saved?.id === "string" ? take((item) => item.id === saved.id) : null,
    );
    const order: MochiItem[] = [];
    layout.items.forEach((saved, k) => {
      const item = targets[k] ?? take((i) => i.name === saved?.name);
      if (!item) return;
      item.applyLayout(saved);
      order.push(item);
    });
    for (const item of order) this.raiseItem(item);
    return order.length;
  }

  /** After a lost GPU context: each item's textures and renderer again. */
  private async restoreItems(): Promise<void> {
    for (const item of this.itemList) {
      const old = item.entry.live;
      try {
        const fresh = await loadLiveModel(
          this.stage.gl,
          old.runtime.source,
          old.runtime.settingsPath,
          {
            reuse: old.runtime,
            textureBudget: resolveTextureBudget(
              this.options.textureBudget ?? "auto",
              deviceProfile(),
            ).bytes,
            ...(old.textureLimits ? { textures: old.textureLimits } : {}),
            masks: old.masks,
            memory: this.stage.memory,
          },
        );
        old.dispose();
        item.entry.live = fresh;
        fresh.runtime.touch();
        fresh.update(0);
      } catch (error) {
        this.events.emit("error", { error });
      }
    }
    this.itemLayer.touch();
  }

  // --------------------------------------------------------------- loop

  /** Starts the render loop (it starts by itself unless `autoStart` is false). */
  start(): void {
    this.stage.start();
  }

  /** Stops the render loop; the canvas keeps the last frame. */
  stop(): void {
    this.stage.stop();
  }

  get running(): boolean {
    return this.stage.isRunning;
  }

  /** Pauses animation (drawing continues, so the view can still move). */
  get paused(): boolean {
    return !this.stage.clock.playing;
  }

  set paused(on: boolean) {
    this.stage.clock.playing = !on;
  }

  /** Animation speed: model seconds per real second. Default 1. */
  get speed(): number {
    return this.stage.clock.speed;
  }

  set speed(v: number) {
    this.stage.clock.speed = v;
  }

  /** Model time in seconds. */
  get time(): number {
    return this.stage.clock.time;
  }

  /**
   * Advances the animation by `seconds` and draws, for applications that run
   * their own loop (with `autoStart: false`). Zero just draws.
   *
   * With `draw: false` (or while {@link drawing} is off) it advances without
   * drawing: motions and their events, expressions, physics, live lip sync,
   * items and the parameter values all move on, and `"frame"` events fire,
   * but the canvas keeps its last picture. {@link draw} shows the state
   * later, the same picture as drawing every frame would have shown.
   */
  advance(seconds: number, options: { draw?: boolean } = {}): void {
    const playing = this.stage.clock.playing;
    this.stage.clock.playing = true;
    const max = this.stage.clock.maxRealStep;
    this.stage.clock.maxRealStep = Math.max(max, seconds);
    this.stage.tick(seconds, options.draw ?? this.stage.drawing);
    this.stage.clock.maxRealStep = max;
    this.stage.clock.playing = playing;
  }

  /**
   * Whether frames draw; default true. While false, the render loop and
   * {@link advance} keep the model moving without drawing (a window nobody
   * sees: a hidden or minimized one); {@link draw} and `screenshot()` still
   * draw.
   */
  get drawing(): boolean {
    return this.stage.drawing;
  }

  set drawing(on: boolean) {
    this.stage.drawing = on;
  }

  /** Draws the current state now, without advancing (also while {@link drawing} is off). */
  draw(): void {
    this.stage.draw();
  }

  /** Sizes the drawing buffer to the canvas's current CSS size now. */
  resize(): void {
    this.stage.resize();
  }

  private afterFrame(dt: number, time: number): void {
    if (this.waiters.length) {
      const still: typeof this.waiters = [];
      for (const w of this.waiters) w.done() ? w.resolve() : still.push(w);
      this.waiters = still;
    }
    this.events.emit("frame", { dt, time });
  }

  // ------------------------------------------------------------- display

  /** A CSS color, or "transparent". */
  get background(): string {
    return this.backgroundCss;
  }

  set background(css: string) {
    this.backgroundCss = css;
    const rgb = parseCssColor(css);
    this.stage.transparent = rgb === null;
    if (rgb) this.stage.background = rgb;
  }

  /**
   * The view relative to the fitted view (see {@link ViewTransform}): zoom,
   * the model point at the canvas center, rotation, and the CSS pixels per
   * model unit on screen.
   */
  get viewTransform(): ViewTransform {
    const live = this.current?.live;
    const v = live?.view ?? { zoom: 1, dx: 0, dy: 0, rotation: 0 };
    const k = live ? live.framing(this.canvas.width, this.canvas.height).k : 0;
    const css = this.canvas.getBoundingClientRect().width;
    const scale = this.canvas.width > 0 && css > 0 ? css / this.canvas.width : 1;
    return { zoom: v.zoom, x: v.dx, y: v.dy, rotation: v.rotation, pixelsPerUnit: k * scale };
  }

  /**
   * Changes the view; fields left out keep their value. `zoom` scales the
   * fitted view, `x` and `y` are the model point shown at the canvas center
   * (model units, offset from the center of the model's canvas rectangle,
   * x right and y up in the model's own directions), and `rotation` turns
   * the picture counterclockwise about the canvas center, in degrees. See
   * {@link ViewTransform}.
   */
  setView(view: { zoom?: number; x?: number; y?: number; rotation?: number }): void {
    const live = this.current?.live;
    if (!live) return;
    if (view.zoom !== undefined) live.view.zoom = view.zoom;
    if (view.x !== undefined) live.view.dx = view.x;
    if (view.y !== undefined) live.view.dy = view.y;
    if (view.rotation !== undefined) live.setRotation(view.rotation);
  }

  /**
   * Moves the model on screen by (dx, dy) CSS pixels, x right and y down
   * (screen directions, whatever the rotation), as a drag does.
   */
  panBy(dx: number, dy: number): void {
    const live = this.current?.live;
    if (!live) return;
    const r = this.canvas.getBoundingClientRect();
    const sx = r.width > 0 ? this.canvas.width / r.width : 1;
    const sy = r.height > 0 ? this.canvas.height / r.height : 1;
    live.panBy(dx * sx, dy * sy, this.canvas.width, this.canvas.height);
  }

  /** Back to the fitted view: zoom 1, centered, not rotated. */
  resetView(): void {
    this.current?.live.resetView();
  }

  /** Page coordinates → drawing-buffer pixels. */
  private pixel(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [
      ((clientX - r.left) * this.canvas.width) / Math.max(1, r.width),
      ((clientY - r.top) * this.canvas.height) / Math.max(1, r.height),
    ];
  }

  /** Page coordinates → model units (y up), or null without a model. */
  toModel(clientX: number, clientY: number): { x: number; y: number } | null {
    const live = this.current?.live;
    if (!live) return null;
    const [px, py] = this.pixel(clientX, clientY);
    const [x, y] = live.toModel(px, py, this.canvas.width, this.canvas.height);
    return { x, y };
  }

  /**
   * Model units (y up) → page coordinates (the viewport coordinates of
   * `clientX` and `clientY`), or null without a model: the inverse of
   * {@link toModel} under the current view, for placing page elements over
   * the model.
   */
  toPage(x: number, y: number): { x: number; y: number } | null {
    const live = this.current?.live;
    if (!live) return null;
    const { width, height } = this.canvas;
    if (!(width > 0 && height > 0)) return null;
    const [px, py] = live.toImage(x, y, width, height);
    const r = this.canvas.getBoundingClientRect();
    return {
      x: r.left + (px * Math.max(1, r.width)) / width,
      y: r.top + (py * Math.max(1, r.height)) / height,
    };
  }

  /** Makes the model look at a point given in page coordinates. */
  lookAt(clientX: number, clientY: number): void {
    const live = this.current?.live;
    if (!live) return;
    const [px, py] = this.pixel(clientX, clientY);
    live.lookAtPixel(px, py, this.canvas.width, this.canvas.height);
  }

  /** What lies under a point given in page coordinates. */
  hitTest(clientX: number, clientY: number): Omit<TapEvent, "model"> | null {
    const live = this.current?.live;
    if (!live) return null;
    const [px, py] = this.pixel(clientX, clientY);
    return this.hitAtPixel(live, px, py);
  }

  private hitAtPixel(live: LiveModel, px: number, py: number): Omit<TapEvent, "model"> {
    const { width, height } = this.canvas;
    const [x, y] = live.toModel(px, py, width, height);
    const r = this.canvas.getBoundingClientRect();
    return {
      areas: live.runtime.hitAreasAt(x, y),
      drawable: live.runtime.drawableAt(x, y),
      x,
      y,
      clientX: r.left + (px * r.width) / Math.max(1, width),
      clientY: r.top + (py * r.height) / Math.max(1, height),
    };
  }

  private press(x: number, y: number, info: PressInfo): DragMode {
    const live = this.current?.live;
    if (!live) return "none";
    if (this.options.dragItems && info.button === 0 && !info.shift) {
      const item = this.itemAtPixel(x, y);
      if (item) {
        const repin = item.pin !== null;
        item.unpin();
        this.itemDrag = { entry: item.entry, repin };
        return "item";
      }
    }
    const look = this.options.look ?? "follow";
    const pan = this.options.pan ?? false;
    if (pan && (info.button !== 0 || info.shift)) return "pan";
    if (look !== "off" && info.button === 0) {
      live.lookAtPixel(x, y, this.canvas.width, this.canvas.height);
      return "look";
    }
    return pan ? "pan" : "none";
  }

  private tap(px: number, py: number): void {
    const model = this.current;
    if (!model) return;
    const e = { model, ...this.hitAtPixel(model.live, px, py) };
    this.events.emit("tap", e);
    if (e.areas.length) this.events.emit("hit", e);
  }

  /** A PNG image of the next frame (straight alpha). */
  async screenshot(): Promise<Blob> {
    const png = await this.stage.screenshot();
    return new Blob([png as BlobPart], { type: "image/png" });
  }

  /**
   * Records `seconds` (up to 60) of the microphone, or of `options.stream`,
   * mixed to mono: a clip for voice calibration (`VoiceCalibration.add`).
   * Call it from a click or tap handler. Resolves when the clip is complete;
   * time spent waiting for the audio to start does not count. As for live
   * motion sync, `voiceProcessing` defaults to false. The clip is only
   * handed back: it is never stored or sent anywhere.
   */
  recordAudio(seconds: number, options: LiveAudioChoice = {}): Promise<RecordedAudio> {
    return this.liveInputs.record(seconds, options);
  }

  /** Stops the loop, disposes the model and frees the GPU context's resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadToken++;
    this.current?.dispose();
    for (const item of [...this.itemList]) item.dispose();
    this.itemLayer.dispose();
    this.unbindGestures();
    this.stage.dispose();
    this.liveInputs.dispose();
    this.speech.dispose();
    this.events.clear();
  }
}

/** Parses a CSS color to straight-alpha RGB in [0, 1]; null for transparent. */
export function parseCssColor(css: string): [number, number, number] | null {
  const c = css.trim().toLowerCase();
  if (c === "" || c === "transparent" || c === "none") return null;
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (m) {
    const h = m[1]!.length === 3 ? [...m[1]!].map((x) => x + x).join("") : m[1]!;
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(c);
  if (m) {
    const parts = m[1]!
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((v) => Number.isFinite(v))) {
      if (parts.length >= 4 && parts[3] === 0) return null;
      return [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255];
    }
  }
  // Named and other colors: let the browser resolve them.
  if (typeof document !== "undefined") {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      const sentinel = "#010203";
      ctx.fillStyle = sentinel;
      ctx.fillStyle = c;
      const v = ctx.fillStyle;
      if (typeof v === "string" && v !== sentinel && v !== c) return parseCssColor(v);
    }
  }
  return null;
}

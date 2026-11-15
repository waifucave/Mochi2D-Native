/**
 * The items of a view: further models placed over the
 * main model, each with its own animation, drawn as a whole behind it, in
 * front of it or at a place in its render order (or in two parts, each at
 * its own place), optionally pinned to it and fed its head angles.
 *
 * The layer is a {@link ModelOverlay} of the main {@link LiveModel}: it
 * updates after the main model's frame and draws around it. It outlives a
 * main model: {@link ItemLayer.attach} moves it to the next one (pins are
 * released then, keeping each item's placement).
 */
import { clipTransform, clipTurn, type Framing } from "../../core/render/framing.js";
import { RenderTarget } from "../../render/gl/render-target.js";
import { maxTextureSize } from "../../render/gl/texture.js";
import type { FrameInsert, InsertHook } from "../../render/model/model-renderer.js";
import type { MocModel } from "../../core/moc/model.js";
import type { LiveModel, ModelOverlay } from "../live-model.js";
import { ItemCompositor } from "./compositor.js";
import { HeadAngleSmoother, type ItemSettings } from "./item-settings.js";
import { findPinTarget, pinPose, type PinTarget } from "./pin.js";
import {
  anchorPoint,
  applyAffine,
  canvasRect,
  checkedPlacement,
  copyPlacement,
  defaultPlacement,
  invertAffine,
  itemToMain,
  placeMesh,
  unitScale,
  type Affine,
  type CanvasRect,
  type ItemDepth,
  type ItemPlacement,
} from "./placement.js";

/** The head-angle parameters fed from the main model to items with item settings. */
export const HEAD_ANGLE_IDS = ["ParamAngleX", "ParamAngleY", "ParamAngleZ"] as const;

/** Largest side of an item's offscreen image. */
const MAX_OFFSCREEN = 4096;

/**
 * Where one part of an item is drawn in a frame. `key` orders places:
 * −∞ behind the main model, +∞ in front of it, 2p just below the drawable at
 * render-order position p and 2p + 1 just above it.
 */
export interface ResolvedPlace {
  key: number;
  /** The main model's drawable it is drawn at, or −1 (behind or in front of the whole model). */
  drawable: number;
  above: boolean;
}

/** Art mesh indices by ID, per model. */
const meshIndices = new WeakMap<MocModel, Map<string, number>>();

/** The index of a model's art mesh by ID, or −1. */
export function meshIndex(model: MocModel, id: string): number {
  let map = meshIndices.get(model);
  if (!map) {
    map = new Map(model.meshes.ids.map((m, i) => [m, i]));
    meshIndices.set(model, map);
  }
  return map.get(id) ?? -1;
}

/**
 * Where an item part with depth `depth` is drawn over `main`: a mesh place
 * whose art mesh `main` does not have, or none, stands for `front`.
 */
export function resolvePlace(
  depth: ItemDepth | null | undefined,
  front: boolean,
  main: LiveModel,
): ResolvedPlace {
  if (depth === "front" || depth === "behind") front = depth === "front";
  else if (depth) {
    const d = meshIndex(main.runtime.model, placeMesh(depth)!);
    if (d >= 0) {
      const above = "above" in depth;
      const pos = main.runtime.instance.drawableRenderOrder[d]!;
      return { key: 2 * pos + (above ? 1 : 0), drawable: d, above };
    }
  }
  return { key: front ? Infinity : -Infinity, drawable: -1, above: front };
}

/** A pinned item: its target on the main model and its rotation when pinned. */
export interface ItemPin {
  target: PinTarget;
  /** The item's rotation (degrees) when it was pinned. */
  rotation: number;
}

/** One item: its model, placement, pin and forwarded inputs. */
export class ItemEntry {
  /** The placement as set (a pinned item's position and rotation come from its pin). */
  placement: ItemPlacement;
  pin: ItemPin | null = null;
  /** Opacity of the whole item, 0–1. */
  opacity = 1;
  /** Shown (drawn and updated). */
  visible = true;
  readonly smoothers: HeadAngleSmoother[];
  /** Values last fed to ParamAngleX/Y/Z, or null. */
  readonly forwarded: (number | null)[] = [null, null, null];
  /** @internal The item's image; for a split item, its front part. */
  target: RenderTarget | null = null;
  /** @internal A split item's back part, or null. */
  backTarget: RenderTarget | null = null;
  /** @internal The render-order position where the images were split, or null (whole). */
  renderedSplit: number | null = null;
  /** @internal */ renderedKey = "";
  /** @internal */ drawnKey = "";
  private readonly rect: CanvasRect;

  constructor(
    public live: LiveModel,
    readonly settings: ItemSettings | null,
    placement: ItemPlacement,
  ) {
    this.placement = copyPlacement(placement);
    this.rect = canvasRect(live.runtime.model.canvas);
    const s = settings?.smoothing;
    this.smoothers = [s?.x ?? 0, s?.y ?? 0, s?.z ?? 0].map((v) => new HeadAngleSmoother(v));
  }

  get canvas(): CanvasRect {
    return this.rect;
  }

  /** The placement now: a pinned item's position and rotation follow its pin. */
  effectivePlacement(main: LiveModel | null): ItemPlacement {
    const p = copyPlacement(this.placement);
    if (!this.pin || !main) return p;
    const pose = pinPose(main.runtime.instance, this.pin.target);
    return {
      ...p,
      x: pose.x,
      y: pose.y,
      rotation: this.pin.rotation + (pose.angle * 180) / Math.PI,
    };
  }

  /**
   * The render-order position of a split item where its front part starts,
   * or null: not split, the item has no art mesh with the split's ID, or
   * nothing is before it.
   */
  splitPosition(): number | null {
    const s = this.placement.split;
    if (!s) return null;
    const r = this.live.runtime;
    const d = meshIndex(r.model, s.mesh);
    const pos = d < 0 ? 0 : r.instance.drawableRenderOrder[d]!;
    return pos > 0 ? pos : null;
  }

  /** Item units → main-model units under the current placement. */
  toMain(main: LiveModel): Affine {
    return itemToMain(
      this.rect,
      canvasRect(main.runtime.model.canvas),
      this.effectivePlacement(main),
    );
  }
}

export class ItemLayer implements ModelOverlay {
  readonly entries: ItemEntry[] = [];
  private main: LiveModel | null = null;
  private compositor: ItemCompositor | null = null;
  private maxSize: number | undefined;

  constructor(readonly gl: WebGL2RenderingContext) {}

  /** The main model the items are placed over, or null. */
  get model(): LiveModel | null {
    return this.main;
  }

  /**
   * Places the items over `main` (or none). Pins refer to the previous main
   * model's meshes, so they are released, keeping each item where it is.
   */
  attach(main: LiveModel | null, options: { keepPins?: boolean } = {}): void {
    if (main === this.main) return;
    if (this.main?.overlay === this) this.main.overlay = null;
    if (!options.keepPins) for (const e of this.entries) if (e.pin) this.unpin(e);
    this.main = main;
    if (main) main.overlay = this;
    this.touch();
  }

  /** A new item over the main model; `placement` overrides the defaults. */
  add(
    live: LiveModel,
    settings: ItemSettings | null,
    placement: Partial<ItemPlacement> = {},
  ): ItemEntry {
    const base = this.main
      ? defaultPlacement(canvasRect(this.main.runtime.model.canvas))
      : defaultPlacement(canvasRect(live.runtime.model.canvas));
    const e = new ItemEntry(live, settings, { ...base, ...checkedPlacement(placement) });
    this.entries.push(e);
    this.touch();
    return e;
  }

  /** Removes an item (its model is disposed). */
  remove(e: ItemEntry): void {
    const i = this.entries.indexOf(e);
    if (i < 0) return;
    this.entries.splice(i, 1);
    e.target?.dispose();
    e.backTarget?.dispose();
    e.target = e.backTarget = null;
    e.live.dispose();
    this.touch();
  }

  /** Moves an item to the end of the drawing order (on top of the items at its place). */
  raise(e: ItemEntry): void {
    const i = this.entries.indexOf(e);
    if (i < 0) return;
    this.entries.splice(i, 1);
    this.entries.push(e);
    this.touch();
  }

  // ------------------------------------------------------------- pinning

  /** Reads one texel's alpha of the main model's texture, for pinning. */
  private probe = (texture: number, u: number, v: number): number | undefined => {
    const t = this.main?.textures[texture]?.texture;
    if (!t) return undefined;
    const a = this.gpu().readAlpha(t.texture, t.width, t.height, u, v);
    return Number.isNaN(a) ? undefined : a;
  };

  /**
   * Pins an item at its anchor: records the topmost visible drawable of the
   * main model there (where its texture is not transparent), a triangle and
   * barycentric coordinates. Returns false (and changes nothing) when nothing
   * of the main model is under the anchor.
   */
  pin(e: ItemEntry): boolean {
    const main = this.main;
    if (!main) return false;
    const p = e.effectivePlacement(main);
    const target = findPinTarget(main.runtime.model, main.runtime.instance, p.x, p.y, this.probe);
    if (!target) return false;
    e.placement = p;
    e.pin = { target, rotation: p.rotation };
    this.touch();
    return true;
  }

  /**
   * Pins an item to a given triangle of a drawable of the main model (a saved
   * layout). Its current placement becomes the reference. False if the main
   * model has no such drawable or triangle.
   */
  pinTo(e: ItemEntry, drawableId: string, triangle: number, weights: readonly number[]): boolean {
    const main = this.main;
    if (!main || weights.length !== 3) return false;
    const model = main.runtime.model;
    const d = model.meshes.ids.indexOf(drawableId);
    const tris = d < 0 ? undefined : model.meshes.triangles[d];
    if (!tris || 3 * triangle + 2 >= tris.length) return false;
    const vertices = [
      tris[3 * triangle]!,
      tris[3 * triangle + 1]!,
      tris[3 * triangle + 2]!,
    ] as const;
    const v = main.runtime.instance.drawableVertices[d]!;
    const pts = vertices.map((i) => [v[2 * i]!, v[2 * i + 1]!] as const);
    const cx = (pts[0]![0] + pts[1]![0] + pts[2]![0]) / 3;
    const cy = (pts[0]![1] + pts[1]![1] + pts[2]![1]) / 3;
    const target: PinTarget = {
      drawable: d,
      drawableId,
      triangle,
      vertices,
      weights: [weights[0]!, weights[1]!, weights[2]!],
      reference: pts.flatMap(([px, py]) => [px - cx, py - cy]),
    };
    e.pin = { target, rotation: e.placement.rotation };
    this.touch();
    return true;
  }

  /**
   * Before the main model shows other data (`MochiModel.replace`): keeps
   * each pin whose drawable, by ID, has the same triangle in `next` (at the
   * drawable's new index) and releases the others where they are.
   */
  keepPinsFor(next: MocModel): void {
    for (const e of this.entries) {
      const pin = e.pin;
      if (!pin) continue;
      const t = pin.target;
      const d = next.meshes.ids.indexOf(t.drawableId);
      const tris = d < 0 ? undefined : next.meshes.triangles[d];
      const same =
        tris !== undefined &&
        3 * t.triangle + 2 < tris.length &&
        t.vertices.every((v, k) => tris[3 * t.triangle + k] === v);
      if (same) e.pin = { ...pin, target: { ...t, drawable: d } };
      else this.unpin(e);
    }
  }

  /** Releases a pin, keeping the item's current position and rotation. */
  unpin(e: ItemEntry): void {
    if (!e.pin) return;
    e.placement = e.effectivePlacement(this.main);
    e.pin = null;
    this.touch();
  }

  // ------------------------------------------------------------ hit tests

  /** The item drawn topmost at a point in main-model units, or null. */
  itemAt(x: number, y: number): ItemEntry | null {
    const main = this.main;
    if (!main) return null;
    // Front items, then items in the main model's render order from the top,
    // then behind items; at one place the last item is on top. A split item
    // counts at its front part's place.
    const shown = this.entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.visible)
      .map(({ e, i }) => ({ e, i, key: this.frontPlace(e, main).key }));
    shown.sort((a, b) => (a.key === b.key ? b.i - a.i : b.key - a.key));
    for (const { e } of shown) {
      const [ix, iy] = applyAffine(invertAffine(e.toMain(main)), x, y);
      const r = e.live.runtime;
      if (findPinTarget(r.model, r.instance, ix, iy)) return e;
    }
    return null;
  }

  /** The anchor of an item in main-model units. */
  anchorOf(e: ItemEntry): [number, number] {
    const p = e.effectivePlacement(this.main);
    return [p.x, p.y];
  }

  /**
   * Moves an item's anchor to the item point now under (x, y) in main-model
   * units, keeping the item where it is on screen.
   */
  setAnchorAt(e: ItemEntry, x: number, y: number): void {
    const main = this.main;
    if (!main) return;
    const wasPinned = e.pin !== null;
    if (wasPinned) this.unpin(e);
    const [ix, iy] = applyAffine(invertAffine(e.toMain(main)), x, y);
    const r = e.canvas;
    e.placement.anchorX = (ix - r.left) / (r.right - r.left);
    e.placement.anchorY = (r.top - iy) / (r.top - r.bottom);
    e.placement.x = x;
    e.placement.y = y;
    if (wasPinned) this.pin(e);
    this.touch();
  }

  // -------------------------------------------------------------- frames

  private version = 0;
  private drawnVersion = -1;

  /** Something about the items changed: redraw. */
  touch(): void {
    this.version++;
  }

  update(dt: number, main: LiveModel): void {
    const values = HEAD_ANGLE_IDS.map((id) =>
      hasParameter(main, id) ? main.runtime.getParameter(id) : null,
    );
    for (const e of this.entries) {
      if (!e.visible) continue;
      const s = e.settings;
      if (s) {
        const mult = [s.multiplier.x, s.multiplier.y, s.multiplier.z];
        const shift = [s.shift.x, s.shift.y, s.shift.z];
        // A mirrored item turns with the main model on screen: ParamAngleX and
        // ParamAngleZ come in negated (ParamAngleY as is); the item settings'
        // multiplier and shift then apply as for any item.
        const mirrored = e.placement.mirror === true;
        HEAD_ANGLE_IDS.forEach((id, k) => {
          const v = values[k];
          if (v === null || v === undefined || !hasParameter(e.live, id)) return;
          const input = mirrored && k !== 1 ? -v : v;
          const target = mult[k]! * input + shift[k]!;
          const smoothed = e.smoothers[k]!.step(target, dt);
          e.forwarded[k] = smoothed;
          e.live.runtime.setParameter(id, smoothed);
        });
      }
      e.live.update(dt);
    }
  }

  /** The key of what an item's offscreen image shows, and its size and scale. */
  private offscreenOf(e: ItemEntry, main: LiveModel, width: number, height: number) {
    const k = main.framing(width, height).k;
    const r = e.canvas;
    const w = r.right - r.left;
    const h = r.top - r.bottom;
    // Item pixels per item unit on screen, limited to the largest offscreen size.
    const max = (this.maxSize ??= Math.min(MAX_OFFSCREEN, maxTextureSize(this.gl)));
    let kpx = k * unitScale(r, canvasRect(main.runtime.model.canvas), e.placement.scale);
    kpx = Math.min(kpx, max / w, max / h);
    const W = Math.max(1, Math.ceil(w * kpx));
    const H = Math.max(1, Math.ceil(h * kpx));
    const framing: Framing = {
      width: W,
      height: H,
      k: kpx,
      centerX: (r.left + r.right) / 2,
      centerY: (r.bottom + r.top) / 2,
    };
    const tints = e.live.runtime.tintVersion;
    const split = e.splitPosition();
    return {
      framing,
      split,
      key: `${e.live.renderVersion} ${tints} ${W}x${H} ${kpx} ${split ?? "whole"}`,
    };
  }

  needsRedraw(width: number, height: number, main: LiveModel): boolean {
    if (this.version !== this.drawnVersion) return true;
    for (const e of this.entries) {
      if (!e.visible) continue;
      if (this.offscreenOf(e, main, width, height).key !== e.renderedKey) return true;
      if (this.compositeKey(e, main, width, height) !== e.drawnKey) return true;
    }
    return false;
  }

  private compositeKey(e: ItemEntry, main: LiveModel, width: number, height: number): string {
    const p = e.effectivePlacement(main);
    const f = main.framing(width, height);
    const places = this.partsOf(e, main).map((q) => q.place.key);
    return `${p.x} ${p.y} ${p.scale} ${p.rotation} ${p.anchorX} ${p.anchorY} ${p.front} ${p.mirror ?? false} ${places} ${e.opacity} ${f.k} ${f.centerX} ${f.centerY} ${f.rotation ?? 0} ${width}x${height}`;
  }

  private gpu(): ItemCompositor {
    return (this.compositor ??= new ItemCompositor(this.gl));
  }

  prepare(width: number, height: number, main: LiveModel): void {
    for (const e of this.entries) {
      if (!e.visible) continue;
      const { framing, key, split } = this.offscreenOf(e, main, width, height);
      if (key === e.renderedKey && e.target) continue;
      const image = (t: RenderTarget | null, label: string) => {
        if (!t) return new RenderTarget(this.gl, framing.width, framing.height, { label });
        t.resize(framing.width, framing.height);
        return t;
      };
      const render = (t: RenderTarget, range: { from: number; to: number } | null) =>
        e.live.renderer.draw({
          framing,
          target: t.framebuffer,
          clear: true,
          tints: e.live.runtime.activeTints,
          range,
        });
      e.target = image(e.target, "item");
      if (split === null) {
        e.backTarget?.dispose();
        e.backTarget = null;
        render(e.target, null);
      } else {
        e.backTarget = image(e.backTarget, "item back");
        render(e.backTarget, { from: 0, to: split });
        render(e.target, { from: split, to: Infinity });
      }
      e.renderedSplit = split;
      e.renderedKey = key;
    }
  }

  /** Where an item's front part (or the whole item) is drawn. */
  private frontPlace(e: ItemEntry, main: LiveModel): ResolvedPlace {
    return resolvePlace(e.placement.layer, e.placement.front, main);
  }

  /**
   * An item's images and where each is drawn, in drawing order: the whole
   * item, or a split item's back part, then its front part. A back part
   * that would be in front of the front part is drawn at its place.
   */
  private partsOf(e: ItemEntry, main: LiveModel): { target: RenderTarget; place: ResolvedPlace }[] {
    const front = this.frontPlace(e, main);
    const split = e.placement.split;
    if (!e.target) return [];
    if (!split || e.renderedSplit === null || !e.backTarget)
      return [{ target: e.target, place: front }];
    let back = resolvePlace(split.back, e.placement.front, main);
    if (back.key > front.key) back = front;
    return [
      { target: e.backTarget, place: back },
      { target: e.target, place: front },
    ];
  }

  /** Draws the item parts behind (`front` false) or in front of the whole main model. */
  draw(width: number, height: number, main: LiveModel, front: boolean): void {
    for (const e of this.entries) {
      if (!e.visible || !e.target) continue;
      for (const part of this.partsOf(e, main)) {
        const p = part.place;
        if (p.drawable < 0 && p.key > 0 === front)
          this.composite(e, part.target, width, height, main);
      }
      // Every part of the item is drawn by the end of the front pass.
      if (front) e.drawnKey = this.compositeKey(e, main, width, height);
    }
    if (front) this.drawnVersion = this.version;
  }

  /**
   * The item parts drawn at places in the main model's render order, for
   * its renderer ({@link FrameInsert}), or null when there are none.
   */
  inserts(width: number, height: number, main: LiveModel): ReadonlyMap<number, FrameInsert> | null {
    let map: Map<number, { below: InsertHook[]; above: InsertHook[] }> | null = null;
    for (const e of this.entries) {
      if (!e.visible || !e.target) continue;
      for (const part of this.partsOf(e, main)) {
        const p = part.place;
        if (p.drawable < 0) continue;
        map ??= new Map();
        let at = map.get(p.drawable);
        if (!at) map.set(p.drawable, (at = { below: [], above: [] }));
        const target = part.target;
        (p.above ? at.above : at.below).push(() => this.composite(e, target, width, height, main));
      }
    }
    return map;
  }

  /** Draws one image of an item onto the bound framebuffer at its placement. */
  private composite(
    e: ItemEntry,
    image: RenderTarget,
    width: number,
    height: number,
    main: LiveModel,
  ): void {
    const f = main.framing(width, height);
    const [sx, sy, tx, ty] = clipTransform(f);
    const [t0, t1, t2] = clipTurn(f);
    const mainRect = canvasRect(main.runtime.model.canvas);
    const p = e.effectivePlacement(main);
    const r = e.canvas;
    const [a, b, c, d, ee, ff] = itemToMain(r, mainRect, p);
    // The offscreen image spans its framing, centered on the item canvas.
    const off = this.offscreenOf(e, main, width, height).framing;
    const w = off.width / off.k;
    const h = off.height / off.k;
    const left = off.centerX - w / 2;
    const bottom = off.centerY - h / 2;
    const cols = [
      [sx * a * w, sy * b * w],
      [sx * c * h, sy * d * h],
      [sx * (a * left + c * bottom + ee) + tx, sy * (b * left + d * bottom + ff) + ty],
    ];
    // The view rotation, in clip space (identity without one).
    const map = new Float32Array(9);
    cols.forEach(([X, Y], k) => {
      map[3 * k] = t0 * X! - t1 * Y!;
      map[3 * k + 1] = t2 * X! + t0 * Y!;
    });
    map[8] = 1;
    this.gpu().draw(image.texture, map, width, height, e.opacity);
  }

  /** After a lost GPU context: forget GL objects (they are gone) so they are made again. */
  resetGpu(): void {
    this.compositor = null;
    for (const e of this.entries) {
      e.target = e.backTarget = null;
      e.renderedSplit = null;
      e.renderedKey = "";
    }
    this.touch();
  }

  /** Removes every item and frees the layer's GPU resources. */
  dispose(): void {
    for (const e of [...this.entries]) this.remove(e);
    this.compositor?.dispose();
    this.compositor = null;
    this.attach(null);
  }
}

const hasParameter = (live: LiveModel, id: string) => live.runtime.animator.values.index(id) >= 0;

export { anchorPoint };

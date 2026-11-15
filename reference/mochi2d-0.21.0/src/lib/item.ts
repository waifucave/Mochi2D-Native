/**
 * The public handle of an item in a {@link MochiView}: a further model
 * placed over the main model. It animates on its own
 * (physics, breath, motions, expressions), is drawn in front of or behind the
 * main model or between its art meshes (whole, or in two parts), and can be
 * pinned to it.
 */
import {
  liveTextures,
  updateLiveTexture,
  type TextureImage,
  type TextureInfo,
  type TextureRegion,
} from "./model.js";
import type {
  EffectName,
  MotionOptions,
  MotionPlayback,
  ModelRuntime,
} from "../runtime/model-runtime.js";
import type {
  ExpressionFades,
  ParameterInfo,
  PartInfo,
  PhysicsSettingInfo,
} from "../runtime/model-runtime.js";
import type { ItemSettings } from "./items/item-settings.js";
import { meshIndex, type ItemEntry, type ItemLayer } from "./items/item-layer.js";
import {
  checkedPlacement,
  copyDepth,
  isDepth,
  placeMesh,
  type ItemDepth,
  type ItemMeshPlace,
  type ItemPlacement,
  type ItemSplit,
} from "./items/placement.js";
import {
  LiveLipSyncSlot,
  type LiveInputs,
  type LiveLipSyncControl,
  type LiveLipSyncOptions,
} from "./live-lip-sync.js";
import {
  LiveSlot,
  type LiveMotionSyncControl,
  type LiveMotionSyncOptions,
} from "./live-motion-sync.js";
import type { MotionSyncTick } from "../anim/motion-sync/driver.js";
import type { VoiceProfile } from "../anim/motion-sync/analysis.js";
import type { PhysicsState } from "../anim/physics.js";

export type { ItemDepth, ItemMeshPlace, ItemPlacement, ItemSettings, ItemSplit };

/** What an item needs from its view. */
export interface ItemHost {
  /** @internal */
  readonly itemLayer: ItemLayer;
  /** @internal */
  readonly liveInputs: LiveInputs;
  /** Removes the item from the view. */
  releaseItem(item: MochiItem): void;
  /** Moves the item to the top of the drawing order, in the view's list too. */
  raiseItem(item: MochiItem): void;
}

/**
 * One item's entry in an item layout (`mochi2d-item-layout/1`): what
 * {@link MochiItem.exportLayout} gives and {@link MochiItem.applyLayout} takes.
 */
export interface ItemLayoutEntry {
  /** The item's id in its view when saved ({@link MochiItem.id}); absent in layouts before 0.4.0. */
  id?: string;
  /** The item's settings path. */
  name: string;
  placement: ItemPlacement;
  opacity: number;
  visible: boolean;
  /** The main model's drawable ID, triangle index and barycentric weights, or null. */
  pin: { drawable: string; triangle: number; weights: number[] } | null;
}

/** Where a pinned item is attached to the main model. */
export interface ItemPinInfo {
  /** The ID of the main model's drawable. */
  drawable: string;
  /** The triangle's index in the drawable's triangle list, and its vertex indices. */
  triangle: number;
  vertices: readonly [number, number, number];
  /** Barycentric coordinates of the pinned point in the triangle. */
  weights: readonly [number, number, number];
}

export class MochiItem {
  private gone = false;
  private readonly liveSlot = new LiveLipSyncSlot(
    () => this.host.liveInputs,
    () => this.runtime,
  );
  private readonly motionSlot = new LiveSlot<LiveMotionSyncControl>();

  /** @internal Created by {@link MochiView.addItem}. */
  constructor(
    private readonly host: ItemHost,
    /** @internal */ public entry: ItemEntry,
    /**
     * The item's id in its view: the one given to `addItem`, or
     * `<settings path>#<n>`, n counting items with the same settings path
     * from 1 (the smallest free number). Layouts match items by it, so items
     * added in the same order get the same ids again.
     */
    readonly id: string,
  ) {}

  /** The item's runtime: animation, evaluation and the parsed files (advanced use). */
  get runtime(): ModelRuntime {
    return this.entry.live.runtime;
  }

  /** Path of the settings file inside its source. */
  get name(): string {
    return this.runtime.settingsPath;
  }

  /** The `ItemSettings` of the item's `.vtube.json`, or null (then no inputs are forwarded). */
  get settings(): ItemSettings | null {
    return this.entry.settings;
  }

  get disposed(): boolean {
    return this.gone;
  }

  // ---------------------------------------------------------- placement

  /** The placement now (a pinned item's position and rotation follow the main model). */
  get placement(): ItemPlacement {
    return this.entry.effectivePlacement(this.host.itemLayer.model);
  }

  /**
   * Changes the placement. Changing the position or rotation of a pinned item
   * unpins it first (it keeps its current placement, then moves). Giving
   * `front` without `layer` draws the item in front of or behind the whole
   * main model again. A malformed `layer` or `split` throws a TypeError;
   * their art mesh IDs are not checked here (see {@link MochiItem.layer}).
   */
  place(p: Partial<ItemPlacement>): void {
    const layer = this.host.itemLayer;
    const q = checkedPlacement(p);
    if (q.front !== undefined && q.layer === undefined) q.layer = null;
    if (this.entry.pin && (q.x !== undefined || q.y !== undefined || q.rotation !== undefined))
      layer.unpin(this.entry);
    Object.assign(this.entry.placement, q);
    layer.touch();
  }

  /**
   * Drawn in front of the main model (true, the default) or behind it. Setting
   * it draws the item in front of or behind the whole model (it clears
   * {@link MochiItem.layer}'s art mesh place).
   */
  get front(): boolean {
    return this.entry.placement.front;
  }

  set front(on: boolean) {
    this.place({ front: on });
  }

  /**
   * Where the item is drawn: `"front"` or `"behind"` the whole main model, or
   * at a place in its render order, `{ above: meshId }` or
   * `{ below: meshId }`: just above or below the main model's art mesh with
   * that ID, wherever the main model's draw order puts it. The item is then
   * drawn into whatever the art mesh is drawn into: inside an offscreen of
   * the main model, it is composited with the offscreen's opacity, colors,
   * blending and mask. The main model's clipping masks do not apply to the
   * item, nor the item's to the main model (each drawable keeps its own).
   *
   * Setting an art mesh place throws a RangeError when the main model has no
   * art mesh with that ID. A place whose art mesh is gone (another main model
   * was loaded, or a layout names one) draws the item per
   * {@link MochiItem.front}. Several items at one place are drawn in item
   * order ({@link MochiItem.raise} puts one on top).
   */
  get layer(): ItemDepth {
    const p = this.entry.placement;
    return p.layer ? copyDepth(p.layer) : p.front ? "front" : "behind";
  }

  set layer(depth: ItemDepth) {
    if (depth === "front" || depth === "behind") {
      this.place({ front: depth === "front" });
      return;
    }
    this.checkMainMesh(depth);
    this.place({ layer: depth });
  }

  /**
   * Draws the item in two parts, each at its own place (see
   * {@link ItemSplit}): its art mesh `mesh` and the drawables after it in its
   * render order are drawn at {@link MochiItem.layer}, the drawables before
   * it at `back`. The back part is never drawn in front of the front part.
   * An offscreen of the item that the split crosses is composited in each
   * part. Null (the default): drawn whole.
   *
   * Setting it throws a RangeError when the item has no art mesh `mesh`, or
   * `back` names an art mesh the main model does not have. A split whose
   * art mesh the item does not have draws the item whole.
   */
  get split(): ItemSplit | null {
    const s = this.entry.placement.split;
    return s ? { mesh: s.mesh, back: copyDepth(s.back) } : null;
  }

  set split(split: ItemSplit | null) {
    if (split) {
      checkedPlacement({ split });
      if (meshIndex(this.runtime.model, split.mesh) < 0)
        throw new RangeError(`the item has no art mesh ${JSON.stringify(split.mesh)}`);
      this.checkMainMesh(split.back);
    }
    this.place({ split });
  }

  private checkMainMesh(depth: ItemDepth): void {
    if (!isDepth(depth))
      throw new TypeError(
        'an item depth is "front", "behind", { above: meshId } or { below: meshId }',
      );
    const id = placeMesh(depth);
    const main = this.host.itemLayer.model;
    if (id !== null && main && meshIndex(main.runtime.model, id) < 0)
      throw new RangeError(`the main model has no art mesh ${JSON.stringify(id)}`);
  }

  /**
   * Flipped horizontally: the item's left and right swapped about its anchor
   * (before its rotation). Drawing, hit tests (`itemAt`), dragging and pins
   * all follow it; a pinned item stays pinned. The forwarded head angles
   * `ParamAngleX` and `ParamAngleZ` are negated, so the item turns with the
   * main model on screen; the multipliers and shifts of its item settings
   * apply on top. Default false.
   */
  get mirror(): boolean {
    return this.entry.placement.mirror ?? false;
  }

  set mirror(on: boolean) {
    this.place({ mirror: on });
  }

  /** Opacity of the whole item, 0–1. */
  get opacity(): number {
    return this.entry.opacity;
  }

  set opacity(v: number) {
    this.entry.opacity = Math.min(1, Math.max(0, v));
    this.host.itemLayer.touch();
  }

  /** Hidden items are neither drawn nor animated. */
  get visible(): boolean {
    return this.entry.visible;
  }

  set visible(on: boolean) {
    this.entry.visible = on;
    this.host.itemLayer.touch();
  }

  /**
   * Draws this item above the other items at its place (and every other
   * item's place). It moves to the end of {@link MochiView.items}, which
   * lists the items in drawing order.
   */
  raise(): void {
    this.host.raiseItem(this);
  }

  /** This item's layout entry (JSON-serializable): id, settings path, placement, opacity, visibility, pin. */
  exportLayout(): ItemLayoutEntry {
    const pin = this.pin;
    return {
      id: this.id,
      name: this.name,
      placement: this.placement,
      opacity: this.opacity,
      visible: this.visible,
      pin: pin
        ? { drawable: pin.drawable, triangle: pin.triangle, weights: [...pin.weights] }
        : null,
    };
  }

  /**
   * Applies a layout entry to this item, whatever its id and name: placement,
   * opacity, visibility and pin. A pin is restored when the main model has its
   * drawable and triangle (the rotation is taken relative to the main model's
   * current pose); returns false when a pin was given but could not be.
   */
  applyLayout(entry: Omit<ItemLayoutEntry, "id" | "name">): boolean {
    this.unpin();
    // Layouts before 0.10.0 have no layer or split: whole, per `front`.
    this.place({ layer: null, split: null, ...entry.placement });
    this.opacity = entry.opacity ?? 1;
    this.visible = entry.visible ?? true;
    const pin = entry.pin;
    if (!pin) return true;
    return this.host.itemLayer.pinTo(this.entry, pin.drawable, pin.triangle, pin.weights);
  }

  // ------------------------------------------------------------- pinning

  /** Where the item is pinned, or null. */
  get pin(): ItemPinInfo | null {
    const t = this.entry.pin?.target;
    if (!t) return null;
    return {
      drawable: t.drawableId,
      triangle: t.triangle,
      vertices: t.vertices,
      weights: t.weights,
    };
  }

  /**
   * Pins the item to the main model at its anchor: to the topmost visible
   * drawable there (where its texture is not transparent). From then on the
   * item follows that point and the triangle's rotation. Returns false when
   * no part of the main model is under the anchor.
   */
  pinToModel(): boolean {
    return this.host.itemLayer.pin(this.entry);
  }

  /** Releases the pin; the item stays where it is. */
  unpin(): void {
    this.host.itemLayer.unpin(this.entry);
  }

  /** The values last fed to the item's ParamAngleX, Y and Z from the main model (null: not fed). */
  get headAngles(): readonly (number | null)[] {
    return this.entry.forwarded;
  }

  // ------------------------------------------------- the model's controls

  get parameters(): readonly ParameterInfo[] {
    return this.runtime.parameters;
  }

  get parts(): readonly PartInfo[] {
    return this.runtime.parts;
  }

  getParameter(id: string): number {
    return this.runtime.getParameter(id);
  }

  /** As {@link MochiModel.getParameterBase}. */
  getParameterBase(id: string): number {
    return this.runtime.getParameterBase(id);
  }

  /** As {@link MochiModel.setIdleWeight}. */
  setIdleWeight(id: string, weight: number): boolean {
    return this.runtime.setIdleWeight(id, weight);
  }

  /** As {@link MochiModel.getIdleWeight}. */
  getIdleWeight(id: string): number {
    return this.runtime.getIdleWeight(id);
  }

  /** As {@link MochiModel.resetIdleWeights}. */
  resetIdleWeights(): void {
    this.runtime.resetIdleWeights();
  }

  /** As {@link MochiModel.physicsSettings}. */
  get physicsSettings(): readonly PhysicsSettingInfo[] {
    return this.runtime.physicsSettings;
  }

  /** As {@link MochiModel.setPhysicsStrength}. */
  setPhysicsStrength(strength: number): void {
    this.runtime.setPhysicsStrength(strength);
  }

  /** As {@link MochiModel.physicsStrength}. */
  get physicsStrength(): number {
    return this.runtime.physicsStrength;
  }

  /** As {@link MochiModel.setPhysicsSettingStrength}. */
  setPhysicsSettingStrength(id: string, strength: number): boolean {
    return this.runtime.setPhysicsSettingStrength(id, strength);
  }

  /** As {@link MochiModel.getPhysicsSettingStrength}. */
  getPhysicsSettingStrength(id: string): number {
    return this.runtime.getPhysicsSettingStrength(id);
  }

  /** As {@link MochiModel.resetPhysicsStrengths}. */
  resetPhysicsStrengths(): void {
    this.runtime.resetPhysicsStrengths();
  }

  /** As {@link MochiModel.setPhysicsWind}. */
  setPhysicsWind(x: number, y: number): void {
    this.runtime.setPhysicsWind(x, y);
  }

  /** As {@link MochiModel.physicsWind}. */
  get physicsWind(): [number, number] {
    return this.runtime.physicsWind;
  }

  /** As {@link MochiModel.setPhysicsSettingWind}. */
  setPhysicsSettingWind(id: string, multiplier: number): boolean {
    return this.runtime.setPhysicsSettingWind(id, multiplier);
  }

  /** As {@link MochiModel.getPhysicsSettingWind}. */
  getPhysicsSettingWind(id: string): number {
    return this.runtime.getPhysicsSettingWind(id);
  }

  /** As {@link MochiModel.resetPhysicsSettingWinds}. */
  resetPhysicsSettingWinds(): void {
    this.runtime.resetPhysicsSettingWinds();
  }

  /** As {@link MochiModel.setPhysicsRate}. */
  setPhysicsRate(rate: number | null): void {
    this.runtime.setPhysicsRate(rate);
  }

  /** As {@link MochiModel.physicsRate}. */
  get physicsRate(): number {
    return this.runtime.physicsRate;
  }

  /** As {@link MochiModel.savePhysicsState}. */
  savePhysicsState(): PhysicsState | null {
    return this.runtime.savePhysicsState();
  }

  /** As {@link MochiModel.restorePhysicsState}. */
  restorePhysicsState(state: PhysicsState): void {
    this.runtime.restorePhysicsState(state);
  }

  /** As {@link MochiModel.textures}: the item's textures. */
  get textures(): TextureInfo[] {
    return liveTextures(this.entry.live);
  }

  /** As {@link MochiModel.updateTexture}: replaces an item texture, or a region of it, in place. */
  updateTexture(index: number, image: TextureImage, at?: TextureRegion): void {
    updateLiveTexture(this.entry.live, index, image, at);
  }

  /** As {@link MochiModel.setTint}: tints one of the item's art meshes. */
  setTint(meshId: string, rgba: readonly number[]): boolean {
    return this.runtime.setTint(meshId, rgba);
  }

  /** As {@link MochiModel.clearTint}. */
  clearTint(meshId: string): boolean {
    return this.runtime.clearTint(meshId);
  }

  /** As {@link MochiModel.clearTints}. */
  clearTints(): void {
    this.runtime.clearTints();
  }

  /** As {@link MochiModel.getTint}. */
  getTint(meshId: string): [number, number, number, number] | null {
    return this.runtime.getTint(meshId);
  }

  /** As {@link MochiModel.tints}. */
  get tints(): Map<string, [number, number, number, number]> {
    return this.runtime.tints;
  }

  /**
   * Sets a parameter's base value. Forwarded head angles overwrite
   * ParamAngleX, Y and Z every frame.
   */
  setParameter(id: string, value: number): boolean {
    return this.runtime.setParameter(id, value);
  }

  resetParameters(): void {
    this.runtime.resetParameters();
  }

  getPartOpacity(id: string): number {
    return this.runtime.getPartOpacity(id);
  }

  setPartOpacity(id: string, value: number): void {
    this.runtime.setPartOpacity(id, value);
  }

  get motionGroups(): { name: string; count: number }[] {
    return this.runtime.motionGroups;
  }

  /** As {@link MochiModel.startMotion}: the playback, or false when refused by priority. */
  startMotion(
    group: string,
    index?: number,
    options?: MotionOptions,
  ): Promise<MotionPlayback | false> {
    return this.runtime.startMotion(group, index, options);
  }

  startMotionFile(path: string, options?: MotionOptions): Promise<MotionPlayback | false> {
    return this.runtime.startMotionFile(path, options);
  }

  stopMotions(): void {
    this.runtime.stopMotions();
  }

  get expressions(): string[] {
    return this.runtime.expressionNames;
  }

  setExpression(nameOrPath: string, fades?: ExpressionFades): Promise<void> {
    return this.runtime.setExpression(nameOrPath, fades);
  }

  clearExpression(fades?: Pick<ExpressionFades, "fadeOut">): void {
    this.runtime.clearExpression(fades);
  }

  /** As {@link MochiModel.addExpression}. */
  addExpression(nameOrPath: string, fades?: ExpressionFades): Promise<boolean> {
    return this.runtime.addExpression(nameOrPath, fades);
  }

  removeExpression(nameOrPath?: string | null, fades?: Pick<ExpressionFades, "fadeOut">): boolean {
    return this.runtime.removeExpression(nameOrPath, fades);
  }

  effect(name: EffectName): boolean {
    return this.runtime.effect(name);
  }

  effectAvailable(name: EffectName): boolean {
    return this.runtime.effectAvailable(name);
  }

  setEffect(name: EffectName, on: boolean): void {
    this.runtime.setEffect(name, on);
  }

  // ---------------------------------------------------- live lip sync

  /**
   * Moves this item's mouth with the microphone, or with `options.stream`,
   * as {@link MochiModel.startLiveLipSync} does for a model. Only this item
   * follows it; the main model and other items have their own.
   */
  startLiveLipSync(options: LiveLipSyncOptions = {}): Promise<LiveLipSyncControl> {
    if (this.gone) return Promise.reject(new Error("the item is disposed"));
    return this.liveSlot.start(options);
  }

  stopLiveLipSync(): void {
    this.liveSlot.stop();
  }

  /** The running live lip sync, or null. */
  get liveLipSync(): LiveLipSyncControl | null {
    return this.liveSlot.current;
  }

  // ------------------------------------------------- live motion sync

  /**
   * Moves this item's mouth by motion sync with the microphone, or with
   * `options.stream`, as {@link MochiModel.startLiveMotionSync} does for a
   * model. Only this item follows it.
   */
  startLiveMotionSync(options: LiveMotionSyncOptions = {}): Promise<LiveMotionSyncControl> {
    if (this.gone) return Promise.reject(new Error("the item is disposed"));
    return this.motionSlot.start(
      () => this.host.liveInputs.startMotionSync(() => this.runtime, options),
      "live motion sync",
    );
  }

  stopLiveMotionSync(): void {
    this.motionSlot.stop();
  }

  /** The running live motion sync, or null. */
  get liveMotionSync(): LiveMotionSyncControl | null {
    return this.motionSlot.current;
  }

  /** The latest motion-sync analysis (weights, level, values), or null. */
  get motionSync(): MotionSyncTick | null {
    return this.runtime.motionSync;
  }

  /** The voice profile motion sync analyzes with, or null for the neutral voice. */
  get voiceProfile(): VoiceProfile | null {
    return this.runtime.voiceProfile;
  }

  setVoiceProfile(profile: VoiceProfile | null): void {
    this.runtime.setVoiceProfile(profile);
  }

  /** Removes the item from its view and frees its GPU resources (its motions end with "stopped"). */
  dispose(): void {
    if (this.gone) return;
    this.stopLiveLipSync();
    this.stopLiveMotionSync();
    this.runtime.stopMotions();
    this.gone = true;
    this.host.releaseItem(this);
  }
}

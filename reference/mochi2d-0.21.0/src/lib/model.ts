/**
 * The public handle of a model shown in a {@link MochiView}: parameters and
 * parts, motions, expressions, look, lip sync, effects.
 */
import type { ValuePatch } from "../core/eval/patch.js";
import type { MocData, MocVersion } from "../core/moc/data.js";
import type {
  MotionOptions,
  MotionPlayback,
  ModelRuntime,
  EffectName,
  PhysicsDriver,
} from "../runtime/model-runtime.js";
import type {
  ExpressionFades,
  ParameterInfo,
  PartInfo,
  PhysicsSettingInfo,
} from "../runtime/model-runtime.js";
import type { LiveModel } from "./live-model.js";
import { audioBytes, type AudioData, type SpeechPlayer } from "./speech.js";
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
import type { PreparedSound } from "./speech.js";
import type { MotionSyncSound, MotionSyncTick } from "../anim/motion-sync/driver.js";
import type { VoiceProfile } from "../anim/motion-sync/analysis.js";
import type { PhysicsState } from "../anim/physics.js";

/** What a model needs from its view. */
export interface ModelHost {
  readonly speech: SpeechPlayer;
  /** @internal */
  readonly liveInputs: LiveInputs;
  /** Resolves once `done()` holds after a frame (or when the model is disposed). */
  waitUntil(done: () => boolean): Promise<void>;
  /** Removes the model from the view. */
  release(model: MochiModel): void;
  /** Shows the model with a runtime of other data, keeping its textures and view. */
  replaceRuntime(model: MochiModel, runtime: ModelRuntime): void;
  /** @internal Before the model's own GL work outside a frame (a host sharing its context). */
  beforeGl?(): void;
}

/**
 * Pixels for {@link MochiModel.updateTexture}, in straight (not
 * premultiplied) alpha: an ImageBitmap (made with `premultiplyAlpha:
 * "none"`), a canvas, ImageData, an image element, or RGBA8 rows from the top.
 */
export type TextureImage =
  | ImageBitmap
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLImageElement
  | ImageData
  | { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

/** A model texture as drawn: its size on the GPU and in its file. */
export interface TextureInfo {
  /** The file's path. */
  label: string;
  /** Size on the GPU (smaller than the file's when the texture budget downscaled it). */
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

/** Where {@link MochiModel.updateTexture} writes: the region's top-left texel. Default (0, 0). */
export interface TextureRegion {
  x?: number;
  y?: number;
}

/** Texture `index` of `live` replaced (wholly, or the region at `at`) by `image`. */
export function updateLiveTexture(
  live: LiveModel,
  index: number,
  image: TextureImage,
  at: TextureRegion = {},
): void {
  live.updateTexture(index, image, at.x ?? 0, at.y ?? 0);
}

/** The textures of `live`, as {@link TextureInfo}. */
export function liveTextures(live: LiveModel): TextureInfo[] {
  return live.textures.map((t) => ({
    label: t.label,
    width: t.texture.width,
    height: t.texture.height,
    originalWidth: t.originalWidth,
    originalHeight: t.originalHeight,
  }));
}

export interface SpeakOptions {
  /** Output volume, 0–1. Default 1. */
  volume?: number;
  /** Play the sound audibly. Default true; false only drives lip sync. */
  play?: boolean;
  /**
   * Drive lip sync from the browser's decoded samples when the file is not a
   * WAV file the reference decoder reads (MP3, AAC, Ogg, float WAV): a
   * convenience. Default true; false plays such sounds without lip sync.
   */
  lipSyncFromDecodedAudio?: boolean;
  /**
   * Move the mouth by motion sync instead of lip sync: true for the model's
   * first usable setting, or a setting's dictionary name or ID. The model
   * needs a motion-sync file. Mochi2D's own analysis drives the mouth (not
   * reference behavior; see docs/api.md, "Motion sync"). Any format the
   * browser decodes works.
   */
  motionSync?: boolean | string;
}

/** A prepared sound's samples for motion sync: the browser's decoding, else the WAV decoder's. */
function motionSyncSound(p: PreparedSound): MotionSyncSound | null {
  if (p.buffer)
    return {
      sampleRate: p.buffer.sampleRate,
      channels: Array.from({ length: p.buffer.numberOfChannels }, (_, c) =>
        p.buffer!.getChannelData(c),
      ),
    };
  return p.sound ? { sampleRate: p.sound.sampleRate, channels: p.sound.samples } : null;
}

export class MochiModel {
  private speechToken = 0;
  private replaceToken = 0;
  private gone = false;
  private readonly liveSlot = new LiveLipSyncSlot(
    () => this.host.liveInputs,
    () => this.runtime,
  );
  private readonly motionSlot = new LiveSlot<LiveMotionSyncControl>();
  /** The sound {@link speak} plays through motion sync, if any. */
  private speechSound: MotionSyncSound | null = null;

  /** @internal Created by {@link MochiView.load}. */
  constructor(
    private readonly host: ModelHost,
    /** @internal The drawn model; replaced when the GPU context is restored. */
    public live: LiveModel,
  ) {}

  /** The model's runtime: animation, evaluation and the parsed files (advanced use). */
  get runtime(): ModelRuntime {
    return this.live.runtime;
  }

  /** Path of the settings file inside its source. */
  get name(): string {
    return this.runtime.settingsPath;
  }

  /** Parameters with display names and ranges, in display order. */
  get parameters(): readonly ParameterInfo[] {
    return this.runtime.parameters;
  }

  get parts(): readonly PartInfo[] {
    return this.runtime.parts;
  }

  /** The settings' motion groups and their sizes. */
  get motionGroups(): { name: string; count: number }[] {
    return this.runtime.motionGroups;
  }

  /** Names of the settings' expressions. */
  get expressions(): string[] {
    return this.runtime.expressionNames;
  }

  /** The settings' hit areas. */
  get hitAreas(): { id: string; name: string }[] {
    return this.runtime.hitAreas;
  }

  /** Files of the model folder (relative to the settings file), or undefined if the source cannot list them. */
  get files(): string[] | undefined {
    return this.runtime.files;
  }

  /** Problems with optional files (physics, pose, motions, …). */
  get warnings(): readonly string[] {
    return this.runtime.warnings;
  }

  /** Text saying which textures were downscaled to fit the budget, or null. */
  get textureNotice(): string | null {
    return this.live.textureNotice;
  }

  /**
   * The model's canvas rectangle in model units (x right, y up): what the
   * fitted view shows. Its center is the view's (0, 0).
   */
  get canvas(): { left: number; right: number; bottom: number; top: number } {
    const c = this.runtime.model.canvas;
    const ppu = c.pixelsPerUnit;
    return {
      left: -c.originX / ppu,
      right: (c.width - c.originX) / ppu,
      bottom: (c.originY - c.height) / ppu,
      top: c.originY / ppu,
    };
  }

  /** The model's opacity from its motions (3u). */
  get opacity(): number {
    return this.runtime.opacity;
  }

  get disposed(): boolean {
    return this.gone;
  }

  // ------------------------------------------------------------ values

  /**
   * A parameter's value in the latest frame: its base value with motions,
   * expressions and effects (breath, physics, look…) applied.
   */
  getParameter(id: string): number {
    return this.runtime.getParameter(id);
  }

  /**
   * A parameter's base value: what {@link setParameter} set, or what motions
   * left in it; expressions and effects apply on top of it, and
   * {@link getParameter} reads the result.
   */
  getParameterBase(id: string): number {
    return this.runtime.getParameterBase(id);
  }

  /**
   * How far the idle animation moves a parameter, 0–1 (default 1): 0 keeps
   * the idle animation off it, so tracking written with `setParameter`
   * shows; one-shot motions still apply. See `ModelRuntime.setIdleWeight`.
   * Returns false for an unknown ID.
   */
  setIdleWeight(id: string, weight: number): boolean {
    return this.runtime.setIdleWeight(id, weight);
  }

  /** A parameter's idle weight; 1 unless set. */
  getIdleWeight(id: string): number {
    return this.runtime.getIdleWeight(id);
  }

  /** Every idle weight back to 1. */
  resetIdleWeights(): void {
    this.runtime.resetIdleWeights();
  }

  /**
   * The physics settings in file order: ID, display name (the dictionary's,
   * or the ID) and whether the dictionary names it. Empty without physics.
   */
  get physicsSettings(): readonly PhysicsSettingInfo[] {
    return this.runtime.physicsSettings;
  }

  /**
   * How strongly physics moves the parameters (not reference behavior):
   * each output moves its parameter by k times the way it would, so 0 leaves
   * them as they are, 1 (the default) is the reference and above 1
   * exaggerates within each parameter's range. The pendulums run unchanged.
   * See `ModelRuntime.setPhysicsStrength`.
   */
  setPhysicsStrength(strength: number): void {
    this.runtime.setPhysicsStrength(strength);
  }

  /** The model's physics strength; 1 unless set. */
  get physicsStrength(): number {
    return this.runtime.physicsStrength;
  }

  /**
   * One physics setting's strength, times the model's (see
   * {@link physicsSettings}). Returns false for an unknown ID.
   */
  setPhysicsSettingStrength(id: string, strength: number): boolean {
    return this.runtime.setPhysicsSettingStrength(id, strength);
  }

  /** A physics setting's strength; 1 unless set. */
  getPhysicsSettingStrength(id: string): number {
    return this.runtime.getPhysicsSettingStrength(id);
  }

  /** The model's physics strength and every setting's back to 1. */
  resetPhysicsStrengths(): void {
    this.runtime.resetPhysicsStrengths();
  }

  /**
   * The physics wind, a force on every pendulum particle in the physics'
   * units (gravity is (0, −1)); it takes effect from the next physics step.
   */
  setPhysicsWind(x: number, y: number): void {
    this.runtime.setPhysicsWind(x, y);
  }

  /** The physics wind; (0, 0) unless set. */
  get physicsWind(): [number, number] {
    return this.runtime.physicsWind;
  }

  /**
   * How much of the wind one physics setting feels, by ID: its pendulums get
   * the wind times `multiplier` (1, the default, is the reference; 0
   * shields the setting). Returns false for an unknown ID.
   */
  setPhysicsSettingWind(id: string, multiplier: number): boolean {
    return this.runtime.setPhysicsSettingWind(id, multiplier);
  }

  /** A physics setting's wind multiplier (see {@link setPhysicsSettingWind}); 1 unless set. */
  getPhysicsSettingWind(id: string): number {
    return this.runtime.getPhysicsSettingWind(id);
  }

  /** Every setting's wind multiplier back to 1. */
  resetPhysicsSettingWinds(): void {
    this.runtime.resetPhysicsSettingWinds();
  }

  /**
   * Sets the physics simulation rate, in steps per second, instead of the
   * physics file's `Fps` (not reference behavior); null restores the file's.
   * 0 steps once per frame. See `ModelRuntime.setPhysicsRate`.
   */
  setPhysicsRate(rate: number | null): void {
    this.runtime.setPhysicsRate(rate);
  }

  /** The physics rate in use, steps per second (0: once per frame). */
  get physicsRate(): number {
    return this.runtime.physicsRate;
  }

  /**
   * A copy of the physics simulation's state, or null without physics; see
   * `ModelRuntime.savePhysicsState`.
   */
  savePhysicsState(): PhysicsState | null {
    return this.runtime.savePhysicsState();
  }

  /**
   * Puts the physics back in a saved state: the next frame continues as the
   * one after the save did, bit for bit. See `ModelRuntime.restorePhysicsState`.
   */
  restorePhysicsState(state: PhysicsState): void {
    this.runtime.restorePhysicsState(state);
  }

  /** The model's textures in the settings' order: their size on the GPU and in the file. */
  get textures(): TextureInfo[] {
    return liveTextures(this.live);
  }

  /**
   * Replaces texture `index` (in the settings' order), or the region of it
   * whose top-left texel is `at` (pixels from the top-left corner), with
   * `image` (straight alpha), without reloading anything: drawn from the
   * next frame. The image is prepared as textures are at load: premultiplied
   * exactly, and the mip texels over the region recomputed by the same exact
   * rule, so the result equals loading a file with the new pixels. It must
   * fit inside the texture as stored: `textures[index].width × height`,
   * which is smaller than the file when the texture budget downscaled it.
   * Throws a RangeError otherwise. (Not reference behavior.)
   */
  updateTexture(index: number, image: TextureImage, at?: TextureRegion): void {
    this.host.beforeGl?.();
    updateLiveTexture(this.live, index, image, at);
  }

  /**
   * Tints an art mesh until cleared (not reference behavior): `rgba` is
   * `[r, g, b]` or `[r, g, b, a]`. Its drawn color, after its multiply and
   * screen colors, is multiplied by r, g and b (0–2: 1 changes nothing,
   * above 1 brightens up to white), and its opacity by a (0–1). It still masks as before. Returns false
   * for an unknown ID. See `ModelRuntime.setTint`.
   */
  setTint(meshId: string, rgba: readonly number[]): boolean {
    return this.runtime.setTint(meshId, rgba);
  }

  /** Removes an art mesh's tint; false for an unknown ID or a mesh without one. */
  clearTint(meshId: string): boolean {
    return this.runtime.clearTint(meshId);
  }

  /** Removes every tint. */
  clearTints(): void {
    this.runtime.clearTints();
  }

  /** An art mesh's tint `[r, g, b, a]`, or null. */
  getTint(meshId: string): [number, number, number, number] | null {
    return this.runtime.getTint(meshId);
  }

  /** The tinted art meshes: ID → `[r, g, b, a]`. */
  get tints(): Map<string, [number, number, number, number]> {
    return this.runtime.tints;
  }

  /**
   * In-place value patches for an editor: new values for keyform positions,
   * opacities, draw orders, colors, rotation values and glue intensities and
   * weights, by their MocData array and index (see {@link ValuePatch}),
   * without reloading. They show at the next frame. Throws, and applies
   * nothing, for an array that cannot be patched or elements outside it.
   */
  patch(patches: ValuePatch | readonly ValuePatch[]): void {
    this.runtime.patch(patches);
  }

  /**
   * Sets a parameter's base value; it stays until changed, and motions,
   * expressions and effects apply on top. Returns false for an unknown ID.
   * It shows at the next frame (`runtime.update(0)` applies it at once).
   */
  setParameter(id: string, value: number): boolean {
    return this.runtime.setParameter(id, value);
  }

  /** Sets every parameter back to its default. */
  resetParameters(): void {
    this.runtime.resetParameters();
  }

  getPartOpacity(id: string): number {
    return this.runtime.getPartOpacity(id);
  }

  setPartOpacity(id: string, value: number): void {
    this.runtime.setPartOpacity(id, value);
  }

  // ------------------------------------------------------------ motions

  /**
   * Starts motion `index` of a group from the settings (a random one when
   * omitted). Resolves to the playback, whose `ended` promise resolves when
   * this motion ends and says why (see {@link MotionEnd}), or to false when a
   * motion of higher priority plays. `options.hold` keeps the last frame.
   */
  startMotion(
    group: string,
    index?: number,
    options?: MotionOptions,
  ): Promise<MotionPlayback | false> {
    return this.runtime.startMotion(group, index, options);
  }

  /** Starts a motion file by its path relative to the settings file (as {@link startMotion}). */
  startMotionFile(path: string, options?: MotionOptions): Promise<MotionPlayback | false> {
    return this.runtime.startMotionFile(path, options);
  }

  /** Stops all motions, held ones included; their playbacks end with "stopped". */
  stopMotions(): void {
    this.runtime.stopMotions();
  }

  /** Paths of the playing motions, oldest first. */
  get motions(): string[] {
    return this.runtime.playingMotions;
  }

  // ------------------------------------------------------- expressions

  /**
   * Starts an expression by settings name, or by file path relative to the
   * settings file. `fades` (seconds) replaces the file's fade times for this
   * start.
   */
  setExpression(nameOrPath: string, fades?: ExpressionFades): Promise<void> {
    return this.runtime.setExpression(nameOrPath, fades);
  }

  /**
   * Fades the current expression out (the one of {@link setExpression}),
   * over its fade-out or `fades.fadeOut` seconds.
   */
  clearExpression(fades?: Pick<ExpressionFades, "fadeOut">): void {
    this.runtime.clearExpression(fades);
  }

  /**
   * Adds an expression on top of the others, with its file's fade-in, so
   * several show at once (applied in the order they were added, after the
   * one of {@link setExpression}, which keeps replacing). Resolves false when
   * it is already added.
   */
  addExpression(nameOrPath: string, fades?: ExpressionFades): Promise<boolean> {
    return this.runtime.addExpression(nameOrPath, fades);
  }

  /**
   * Fades out an expression added with {@link addExpression} (over its
   * fade-out, or `fades.fadeOut` seconds); without a name (or null), all of
   * them. Returns whether one was removed.
   */
  removeExpression(nameOrPath?: string | null, fades?: Pick<ExpressionFades, "fadeOut">): boolean {
    return this.runtime.removeExpression(nameOrPath, fades);
  }

  /** Paths of the expressions added with {@link addExpression}, oldest first. */
  get addedExpressions(): string[] {
    return this.runtime.addedExpressions;
  }

  // -------------------------------------------------------------- look

  /**
   * Parameters physics overwrites (weight 100 %) while it runs, each with the
   * model parameters that drive it, largest weight first. While physics
   * runs, writing such a parameter has no visible effect (DeepSeek-chan's
   * physics writes `ParamAngleX` from `AngleX`): map head tracking and
   * sliders to a driving input instead. Look does this itself (the runtime's
   * `lookThroughPhysics`); see {@link lookRouting}. Empty without physics.
   */
  get physicsInputs(): ReadonlyMap<string, readonly PhysicsDriver[]> {
    return this.runtime.physicsInputs;
  }

  /**
   * The parameters look writes: for each look target (`ParamAngleX`, …), the
   * one written, which is the physics input when physics overwrites the
   * target and `lookThroughPhysics` is on.
   */
  lookRouting(): { target: string; writes: string }[] {
    return this.runtime.lookRouting();
  }

  /** Look target: x right and y up, in [−1, 1]. See also {@link MochiView.lookAt}. */
  lookAt(x: number, y: number): void {
    this.runtime.lookAt(x, y);
  }

  stopLooking(): void {
    this.runtime.releaseLook();
  }

  // ---------------------------------------------------------- lip sync

  /**
   * Plays a sound and moves the mouth with it (lip sync). Resolves when the
   * sound ends or is stopped. Browsers only play audio after a user gesture:
   * call it from a click or tap handler. WAV files are analysed as the
   * reference does; other formats from the browser's decoded samples.
   */
  async speak(audio: AudioData, options: SpeakOptions = {}): Promise<void> {
    const bytes = await audioBytes(audio);
    const prepared = await this.host.speech.prepare(bytes);
    if (!prepared.buffer && !prepared.sound) throw new Error("the audio could not be decoded");
    this.stopSpeaking();
    const token = ++this.speechToken;
    if (options.motionSync !== undefined && options.motionSync !== false) {
      await this.speakWithMotionSync(prepared, options, token);
      return;
    }
    const lipSync =
      prepared.exact || options.lipSyncFromDecodedAudio !== false ? prepared.sound : null;
    this.runtime.startLipSync(lipSync);
    if (!lipSync && !(options.play !== false && prepared.buffer))
      throw new Error("the audio is not a WAV file the lip-sync decoder reads");
    if (options.play !== false && prepared.buffer) {
      await new Promise<void>((resolve) =>
        this.host.speech.play(prepared.buffer!, options.volume ?? 1, resolve),
      );
    } else {
      await this.host.waitUntil(
        () => token !== this.speechToken || !(this.runtime.animator.lipSync?.playing ?? false),
      );
    }
  }

  /** Motion sync's part of {@link speak}. */
  private async speakWithMotionSync(
    p: PreparedSound,
    options: SpeakOptions,
    token: number,
  ): Promise<void> {
    const sound = motionSyncSound(p);
    if (!sound) throw new Error("the audio could not be decoded");
    const setting = typeof options.motionSync === "string" ? options.motionSync : undefined;
    const audible = options.play !== false && p.buffer !== null;
    // The mouth follows the audio clock once playback starts (0 until then).
    let position: (() => number) | null = null;
    const clock = audible ? () => position?.() ?? 0 : undefined;
    if (
      !this.runtime.startMotionSync(sound, {
        ...(setting ? { setting } : {}),
        ...(clock ? { clock } : {}),
      })
    )
      throw new Error("the model has no motion-sync setting to run");
    this.speechSound = sound;
    if (audible) {
      await new Promise<void>((resolve) => {
        position = this.host.speech.play(p.buffer!, options.volume ?? 1, resolve).position;
      });
    } else {
      await this.host.waitUntil(
        () => token !== this.speechToken || this.runtime.motionSyncSource !== sound,
      );
    }
  }

  /** Stops the sound, and lip sync or motion sync. */
  stopSpeaking(): void {
    this.speechToken++;
    this.host.speech.stop();
    this.runtime.startLipSync(null);
    if (this.speechSound && this.runtime.motionSyncSource === this.speechSound)
      this.runtime.stopMotionSync();
    this.speechSound = null;
  }

  /**
   * Moves the mouth with the microphone, or with `options.stream` (lip sync
   * from live audio; not reference behavior). Call it from a click or tap
   * handler: the browser asks for the microphone, and iOS Safari starts
   * audio only in a gesture. Resolves once the input is set up; rejects with
   * a `LiveAudioError` whose message can be shown (an insecure page, a denied
   * permission…). Runs alongside {@link speak}. Audio is processed in memory
   * only: it is never recorded, stored or sent anywhere.
   */
  startLiveLipSync(options: LiveLipSyncOptions = {}): Promise<LiveLipSyncControl> {
    if (this.gone) return Promise.reject(new Error("the model is disposed"));
    return this.liveSlot.start(options);
  }

  /** Stops live lip sync. */
  stopLiveLipSync(): void {
    this.liveSlot.stop();
  }

  /** The running live lip sync, or null. */
  get liveLipSync(): LiveLipSyncControl | null {
    return this.liveSlot.current;
  }

  // ------------------------------------------------------- motion sync

  /** The settings of the model's motion-sync file (ID, name, whether it runs); empty without one. */
  get motionSyncSettings(): readonly { id: string; name: string; usable: boolean }[] {
    return this.runtime.motionSyncSettings;
  }

  /**
   * The latest motion-sync analysis: the setting, the level (dBFS), the
   * element weights (Silence, A, I, U, E, O, summing to 1) and the values
   * written. Null while motion sync plays nothing.
   */
  get motionSync(): MotionSyncTick | null {
    return this.runtime.motionSync;
  }

  /** Calls `listener` at every motion-sync analysis; returns a function that removes it. */
  onMotionSyncTick(listener: (tick: MotionSyncTick) => void): () => void {
    return this.runtime.onMotionSyncTick(listener);
  }

  /**
   * Moves the mouth by motion sync with the microphone, or with
   * `options.stream`, through a setting of the model's motion-sync file
   * (Mochi2D's own analysis; not reference behavior). Call it from a click or
   * tap handler, as {@link startLiveLipSync}. Resolves once the input is set
   * up; rejects with a `LiveAudioError` (code `"no-motion-sync"` for a model
   * without a usable setting) or a RangeError for an unknown setting. Audio
   * is processed in memory only: it is never stored or sent anywhere.
   */
  startLiveMotionSync(options: LiveMotionSyncOptions = {}): Promise<LiveMotionSyncControl> {
    if (this.gone) return Promise.reject(new Error("the model is disposed"));
    return this.motionSlot.start(
      () => this.host.liveInputs.startMotionSync(() => this.runtime, options),
      "live motion sync",
    );
  }

  /** Stops live motion sync: the mouth settles to its Silence shape. */
  stopLiveMotionSync(): void {
    this.motionSlot.stop();
  }

  /** The running live motion sync, or null. */
  get liveMotionSync(): LiveMotionSyncControl | null {
    return this.motionSlot.current;
  }

  /** The voice profile motion sync analyzes with (from `VoiceCalibration`), or null for the neutral voice. */
  get voiceProfile(): VoiceProfile | null {
    return this.runtime.voiceProfile;
  }

  setVoiceProfile(profile: VoiceProfile | null): void {
    this.runtime.setVoiceProfile(profile);
  }

  // ----------------------------------------------------------- effects

  /** Whether a component runs (physics, eyeBlink, breath, look, idle, lipSync, pose, expressions, motionSync). */
  effect(name: EffectName): boolean {
    return this.runtime.effect(name);
  }

  /** Whether the model has what a component needs (e.g. a physics file). */
  effectAvailable(name: EffectName): boolean {
    return this.runtime.effectAvailable(name);
  }

  setEffect(name: EffectName, on: boolean): void {
    this.runtime.setEffect(name, on);
  }

  /**
   * Replaces the model's data and keeps the rest: its textures (not decoded
   * or uploaded again), the settings and their files, the view (zoom, pan,
   * rotation), and the parameter base values, part opacities and effect
   * switches, matched by ID. For an editor's structural edits, which patches
   * cannot make. `moc` is `.moc3` bytes, or {@link MocData} with its
   * `version` (as `mocModelFromData` takes them). Motions, expressions and
   * speech stop (motions end with "stopped"); a live lip-sync input stays.
   * Items pinned to a mesh stay pinned if the mesh (by ID) keeps the pinned
   * triangle; others are released where they are. Resolves once the new data
   * is shown. If it does not load, it rejects, and the current data stays.
   * One that a later call (or dispose) overtakes rejects with an
   * `AbortError` and shows nothing. `runtime` is a new object afterwards.
   */
  async replace(moc: Uint8Array | ArrayBuffer | MocData, version?: MocVersion): Promise<void> {
    if (this.gone) throw new Error("the model is disposed");
    const token = ++this.replaceToken;
    const runtime = await this.runtime.withData(moc, version);
    if (this.gone || token !== this.replaceToken)
      throw new DOMException("the replacement was superseded by a later one", "AbortError");
    this.stopSpeaking();
    this.runtime.stopMotions();
    this.host.replaceRuntime(this, runtime);
  }

  /** Removes the model from its view and frees its GPU resources (its motions end with "stopped"). */
  dispose(): void {
    if (this.gone) return;
    this.stopSpeaking();
    this.stopLiveLipSync();
    this.stopLiveMotionSync();
    this.runtime.stopMotions();
    this.gone = true;
    this.host.release(this);
    this.live.dispose();
  }
}

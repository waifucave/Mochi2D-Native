/**
 * The frame procedure of 3j: restore, motions, save, the effects
 * in their fixed order, then evaluation by the caller.
 */
import type { MocModel } from "../core/moc/model.js";
import type { ModelInstance } from "../core/eval/instance.js";
import { parameterGroupIds, type ModelSettings } from "../core/settings/model-settings.js";
import { AnimationValues } from "./values.js";
import { MotionQueue, type MotionEnded, type MotionStart } from "./motion-queue.js";
import type { Motion } from "./motion.js";
import { ExpressionLayers, ExpressionQueue, type Expression } from "./expression.js";
import { PhysicsRig, type PhysicsFile } from "./physics.js";
import { PoseRig, type PoseFile } from "./pose.js";
import {
  Breath,
  EyeBlink,
  Look,
  REFERENCE_BREATH,
  REFERENCE_EYE_BLINK,
  REFERENCE_LOOK,
  type BreathEntry,
  type EyeBlinkTiming,
  type LookEntry,
} from "./effects.js";
import { LipSync, type LiveLipSyncMix, type LiveLipSyncSource, type WavSound } from "./lip-sync.js";
import type { MotionSyncFile } from "./motion-sync/file.js";
import { MotionSyncDriver, type MotionSyncDriverOptions } from "./motion-sync/driver.js";

/** Which components run (3w.1). A component that is not present never runs. */
export interface EffectSwitches {
  /** Idle playback of the `Idle` group (3l.7). */
  idle: boolean;
  eyeBlink: boolean;
  expressions: boolean;
  look: boolean;
  breath: boolean;
  physics: boolean;
  lipSync: boolean;
  pose: boolean;
  /** Motion sync: a sound or live input bound to a setting drives the mouth (not reference behavior). */
  motionSync: boolean;
}

export interface AnimatorOptions {
  /** Wrap mode (3g.2); default off. */
  wrap?: boolean;
  /** Physics gravity and wind (3n.2); defaults (0, −1) and (0, 0). */
  gravity?: [number, number];
  wind?: [number, number];
  /** Run the physics settle procedure (3n.8) once after load. */
  settle?: boolean;
  eyeBlink?: Partial<EyeBlinkTiming>;
  breath?: readonly BreathEntry[];
  look?: readonly LookEntry[];
  /** The shared random sequence (3v.2), numbers in [0, 1); default Math.random. */
  random?: () => number;
  /** Motions of a group by index, for idle playback; default none. */
  groupMotion?: (group: string, index: number) => ResolvedMotion | null;
  /**
   * A list that replaces the settings' `Idle` group for idle playback (the
   * animation scenarios' `idleMotions`, 4i): its length and its motions by index.
   */
  idleList?: { count: number; motion: (index: number) => ResolvedMotion | null };
  /** Called after each idle start attempt with the picked index (3l.7). */
  onIdleStart?: (index: number, started: boolean) => void;
  /** Motion sync: the analysis, the file's smoothing, and where it runs in the frame. */
  motionSync?: MotionSyncDriverOptions & {
    /**
     * Run motion sync before physics, so that physics fed by the mouth
     * parameters reacts to speech. Default false: after lip sync, before
     * pose, so physics sees the motions' mouth values.
     */
    beforePhysics?: boolean;
  };
}

/** A motion file and its sound, as resolved by the application. */
export interface ResolvedMotion {
  /** null when the file failed validation (3c.4). */
  motion: Motion | null;
  /** Fade-time overrides from the settings entry (3b.2). */
  fadeIn?: number;
  fadeOut?: number;
  /** The entry's sound: decoded, null if it could not be loaded, undefined if none. */
  sound?: WavSound | null;
}

export interface FrameResult {
  motionUpdated: boolean;
  queueEmpty: boolean;
  events: string[];
  /** The lip-sync value of this frame, or null when lip sync did not run. */
  lipSync: number | null;
  /** Motions that ended in this frame (or, held, reached their end). */
  ends: MotionEnded[];
}

export class Animator {
  readonly values: AnimationValues;
  readonly motions: MotionQueue;
  readonly expressions = new ExpressionQueue();
  /** Expressions added on top of the queue, several at once (not reference behavior). */
  readonly expressionLayers = new ExpressionLayers();
  readonly eyeBlink: EyeBlink | null;
  readonly breath: Breath;
  readonly look: Look;
  readonly physics: PhysicsRig | null;
  readonly lipSync: LipSync | null;
  private poseRig: PoseRig | null;
  /** Motion sync, when the model has a motion-sync file. */
  readonly motionSync: MotionSyncDriver | null;
  private readonly motionSyncBeforePhysics: boolean;
  readonly enabled: EffectSwitches;
  /** The `idleList` option's count, if given. */
  private readonly idleListCount: number | undefined;
  private readonly random: () => number;
  private readonly idleMotion: (index: number) => ResolvedMotion | null;
  private readonly onIdleStart: AnimatorOptions["onIdleStart"];

  /** The pose, when the model has a pose file (or one was set, {@link setPose}). */
  get pose(): PoseRig | null {
    return this.poseRig;
  }

  /**
   * Replaces the pose with `file`'s (null: no pose), for an editor that
   * changes it. The new pose sets the parts up on its first frame, as at
   * load; turning the pose effect on stays the caller's choice.
   */
  setPose(file: PoseFile | null): void {
    this.poseRig = file ? new PoseRig(file, this.values) : null;
  }

  /**
   * Number of motions idle playback picks from: the settings' `Idle` group
   * as it is now (an editor may change the settings' motions), or the
   * `idleList` option's count.
   */
  get idleCount(): number {
    return (
      this.idleListCount ??
      this.settings.motions.find((g) => g.group === "Idle")?.entries.length ??
      0
    );
  }

  constructor(
    readonly model: MocModel,
    readonly settings: ModelSettings,
    assets: {
      physics?: PhysicsFile | null;
      pose?: PoseFile | null;
      motionSync?: MotionSyncFile | null;
    } = {},
    options: AnimatorOptions = {},
  ) {
    const v = (this.values = new AnimationValues(model));
    v.wrap = options.wrap ?? false;
    this.random = options.random ?? Math.random;
    const groupMotion = options.groupMotion;
    this.idleMotion = options.idleList?.motion ?? ((index) => groupMotion?.("Idle", index) ?? null);
    this.onIdleStart = options.onIdleStart;
    const blink = parameterGroupIds(settings, "EyeBlink");
    const lip = parameterGroupIds(settings, "LipSync");
    this.motions = new MotionQueue({ eyeBlink: blink, lipSync: lip });
    this.eyeBlink =
      blink.length > 0
        ? new EyeBlink(blink, () => this.draw(), { ...REFERENCE_EYE_BLINK, ...options.eyeBlink })
        : null;
    this.breath = new Breath(options.breath ?? REFERENCE_BREATH);
    this.look = new Look(options.look ?? REFERENCE_LOOK);
    this.lipSync = lip.length > 0 ? new LipSync(lip) : null;
    this.physics = assets.physics ? new PhysicsRig(assets.physics, v) : null;
    if (this.physics) {
      if (options.gravity) this.physics.gravity = options.gravity;
      if (options.wind) this.physics.wind = options.wind;
      if (options.settle) this.physics.settle();
    }
    this.poseRig = assets.pose ? new PoseRig(assets.pose, v) : null;
    const { beforePhysics, ...syncOptions } = options.motionSync ?? {};
    this.motionSync = assets.motionSync
      ? new MotionSyncDriver(assets.motionSync, v, syncOptions)
      : null;
    this.motionSyncBeforePhysics = beforePhysics === true;
    this.idleListCount = options.idleList?.count;
    this.enabled = {
      idle: this.idleCount > 0,
      eyeBlink: this.eyeBlink !== null,
      expressions: true,
      look: true,
      breath: true,
      physics: this.physics !== null,
      lipSync: this.lipSync !== null,
      pose: this.poseRig !== null,
      motionSync: this.motionSync !== null,
    };
  }

  private draw(): number {
    const r = this.random();
    if (!(r >= 0 && r < 1)) throw new RangeError(`random draw ${r} is not in [0, 1)`);
    return r;
  }

  // ------------------------------------------------------------- commands

  /** Starts a motion (3l.4); its sound starts too when the start is accepted. */
  startMotion(resolved: ResolvedMotion, opts: MotionStart = {}): boolean {
    const start: MotionStart = { ...opts };
    if (start.fadeIn === undefined && resolved.fadeIn !== undefined) start.fadeIn = resolved.fadeIn;
    if (start.fadeOut === undefined && resolved.fadeOut !== undefined)
      start.fadeOut = resolved.fadeOut;
    const accepted = this.motions.start(resolved.motion, start);
    if (accepted && resolved.sound !== undefined) this.startSound(resolved.sound);
    return accepted;
  }

  startExpression(expression: Expression): void {
    this.expressions.start(expression);
  }

  setLookTarget(x: number, y: number): void {
    this.look.setTarget(x, y);
  }

  /** Starts lip sync on a sound; null (a file that could not be loaded) stops it. */
  startSound(sound: WavSound | null): void {
    this.lipSync?.start(sound);
  }

  /**
   * Adds a live lip-sync input (a microphone; not reference behavior), or
   * removes it with null. Returns false when there is no lip sync.
   */
  setLiveLipSync(source: LiveLipSyncSource | null, mix: LiveLipSyncMix = "add"): boolean {
    if (!this.lipSync) return false;
    this.lipSync.setLive(source, mix);
    return true;
  }

  setPartOpacity(id: string, value: number): void {
    this.values.setPartOpacity(id, value);
  }

  stopMotions(): void {
    this.motions.stopAll();
  }

  /**
   * An application edit of a parameter's base value (a viewer slider): it is
   * saved, so it persists like a motion's result, and effects apply on top.
   */
  setBaseParameter(index: number, value: number): void {
    const v = this.values;
    v.setAt(index, value);
    v.saved[index] = v.values[index]!;
  }

  // ---------------------------------------------------------------- frame

  /** One frame of the procedure of 3j (steps 1–4), with step Δ. */
  frame(dt: number): FrameResult {
    const v = this.values;
    const on = this.enabled;
    v.restore();
    let motionUpdated = false;
    let events: string[] = [];
    if (this.motions.empty) {
      if (on.idle && this.idleCount > 0) {
        const index = Math.floor(this.draw() * this.idleCount);
        const resolved = this.idleMotion(index);
        const started = resolved ? this.startMotion(resolved, { priority: 1 }) : false;
        this.onIdleStart?.(index, started);
      }
    } else {
      events = this.motions.advance(dt, v);
      motionUpdated = true;
    }
    v.save();
    // Eye blink runs while no motion plays (3j), and, not reference behavior,
    // while every queued motion is held at its end (unless started with blinkWhileHeld false).
    if (this.eyeBlink && on.eyeBlink && (!motionUpdated || this.motions.blinkAllowed))
      this.eyeBlink.frame(dt, v);
    if (on.expressions) {
      this.expressions.advance(dt, v);
      this.expressionLayers.advance(dt, v);
    }
    if (on.look) this.look.frame(dt, v);
    if (on.breath) this.breath.frame(dt, v);
    const sync = this.motionSync && on.motionSync ? this.motionSync : null;
    if (sync && this.motionSyncBeforePhysics) sync.frame(dt);
    if (this.physics && on.physics) this.physics.frame(dt);
    let lipSync: number | null = null;
    if (this.lipSync && on.lipSync) {
      // Lip sync leaves the parameters that motion sync drives.
      const driven = sync?.setting ? new Set(sync.drivenIds) : undefined;
      this.lipSync.frame(dt, v, driven);
      lipSync = this.lipSync.value;
    }
    // Motion sync: after lip sync, before pose (or before physics, above).
    if (sync && !this.motionSyncBeforePhysics) sync.frame(dt);
    if (this.poseRig && on.pose) this.poseRig.frame(dt);
    return {
      motionUpdated,
      queueEmpty: this.motions.empty,
      events,
      lipSync,
      ends: this.motions.takeEnds(),
    };
  }

  /** Step 5's input: hands parameter values and part opacities to an evaluation instance. */
  applyTo(inst: ModelInstance): void {
    const v = this.values;
    for (let i = 0; i < v.values.length; i++) inst.setParameter(i, v.values[i]!);
    for (let i = 0; i < v.partOpacities.length; i++) inst.setPartOpacity(i, v.partOpacities[i]!);
  }
}

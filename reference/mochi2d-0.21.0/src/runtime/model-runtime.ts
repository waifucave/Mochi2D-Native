/**
 * A loaded model with its animation, ready to drive: the evaluation instance,
 * the frame procedure of 3j, and the application-level pieces
 * around it that the procedure leaves to the host: starting motions by group or
 * file, expressions by name, display names, hit testing in model space, and
 * change tracking so a frame is only evaluated when a value changed.
 *
 * Pure TypeScript (no DOM, no Node APIs). The browser runtime (`src/lib`)
 * adds GPU drawing on top; on its own it evaluates models headlessly.
 *
 * Three conveniences are not reference behavior. All are on by default and
 * can be switched off (`RuntimeOptions`):
 * - `lookThroughPhysics`: when physics overwrites a look target (DeepSeek-chan
 *   drives `ParamAngleX` from `AngleX`, 3e.2), look writes the physics input
 *   instead, scaled by the ratio of the two ranges, so looking stays visible
 *   with physics on. Apps do the same with `physicsInputs`, which lists every
 *   parameter physics overwrites and the inputs that drive it;
 * - `lipSyncFallback`: when the settings list no `LipSync` parameters, lip
 *   sync drives `ParamMouthOpenY` (if the model has it);
 * - `stopClearsPriority`: `stopMotions()` also clears the current priority,
 *   so the next start is always accepted (the frame procedure keeps it, C19).
 */
import { MAX_TINT } from "../core/tint.js";

export { MAX_TINT };
import { dirnameOf, joinPath, type FileSource } from "../core/io/file-source.js";
import { ModelInstance, type EvaluationOptions, type MapSpace } from "../core/eval/instance.js";
import type { ValuePatch } from "../core/eval/patch.js";
import { loadMoc, type LoadMocOptions, type MocModel } from "../core/moc/model.js";
import type { MocData, MocVersion } from "../core/moc/data.js";
import { mocModelFromData } from "../core/moc/from-data.js";
import { parameterGroupIds, type ModelSettings } from "../core/settings/model-settings.js";
import {
  Animator,
  type AnimatorOptions,
  type EffectSwitches,
  type FrameResult,
  type ResolvedMotion,
} from "../anim/animator.js";
import type { MotionEndReason, MotionEnded, MotionStart } from "../anim/motion-queue.js";
import { parseMotion, type Motion } from "../anim/motion.js";
import { parseExpression, type Expression } from "../anim/expression.js";
import { REFERENCE_LOOK, type LookEntry } from "../anim/effects.js";
import {
  decodeWav,
  type LiveLipSyncMix,
  type LiveLipSyncSource,
  type WavSound,
} from "../anim/lip-sync.js";
import { displayLabels, vertexBounds, type Bounds } from "../anim/model-data.js";
import type { PhysicsState } from "../anim/physics.js";
import { loadModelBundle, type ModelBundle } from "./bundle.js";
import { findMotionSyncSetting, type MotionSyncSetting } from "../anim/motion-sync/file.js";
import type {
  MotionSyncClock,
  MotionSyncInput,
  MotionSyncSound,
  MotionSyncTick,
} from "../anim/motion-sync/driver.js";
import { decodeMotionSyncWav } from "../anim/motion-sync/wav.js";
import type { VoiceProfile } from "../anim/motion-sync/analysis.js";

/** A model parameter as shown to users. */
export interface ParameterInfo {
  id: string;
  /** Display name from the display-info file (answer B3), or the ID. */
  name: string;
  /** Display group name, if the display-info file puts the parameter in one. */
  group?: string;
  min: number;
  max: number;
  default: number;
  /** A blend-shape parameter (its keyforms are added, C1). */
  blendShape: boolean;
}

/** A model parameter that drives a physics-overwritten parameter (see {@link ModelRuntime.physicsInputs}). */
export interface PhysicsDriver {
  /** The input parameter's ID. */
  id: string;
  /** Its weight in the physics setting, in percent. */
  weight: number;
  /** What the input moves: the pendulum's base in x or y, or its angle. */
  type: "X" | "Y" | "Angle";
  /**
   * The input's own `Reflect` flag in the physics file. The overwritten
   * parameter's output has a `Reflect` flag of its own, not included here.
   */
  reflect: boolean;
}

/** A model part as shown to users. */
export interface PartInfo {
  id: string;
  /** Display name from the display-info file, or the ID. */
  name: string;
  defaultOpacity: number;
}

/** A physics setting, as {@link ModelRuntime.physicsSettings} lists it. */
export interface PhysicsSettingInfo {
  id: string;
  /** Its name in the physics file's dictionary, or the ID when the dictionary has none. */
  name: string;
  /** Whether the dictionary names it: false when `name` is only the ID. */
  named: boolean;
}

/**
 * Fade times in seconds that an expression call uses instead of the
 * expression file's (not reference behavior). Each must be finite and ≥ 0;
 * an absent one keeps the file's.
 */
export interface ExpressionFades {
  fadeIn?: number;
  fadeOut?: number;
}

function checkFades(f: ExpressionFades | undefined): void {
  for (const key of ["fadeIn", "fadeOut"] as const) {
    const v = f?.[key];
    if (v !== undefined && !(Number.isFinite(v) && v >= 0))
      throw new RangeError(`the expression ${key} ${v} is not a finite time ≥ 0`);
  }
}

/** The expression with the call's fade times (a copy, when there are any). */
function withFades(e: Expression, f: ExpressionFades | undefined): Expression {
  if (f?.fadeIn === undefined && f?.fadeOut === undefined) return e;
  return { ...e, fadeIn: f.fadeIn ?? e.fadeIn, fadeOut: f.fadeOut ?? e.fadeOut };
}

/** A deformer of the model, as {@link ModelRuntime.deformers} lists it. */
export interface DeformerInfo {
  id: string;
  kind: "warp" | "rotation";
  /** The parent deformer's ID, or null at the root. */
  parent: string | null;
}

/** Options of {@link ModelRuntime.mapPoints}. */
export interface MapPointsOptions {
  /**
   * "model" (default): model units as the drawables' vertices and the hit
   * tests have them, y up (unless the canvas keeps y down). "keyform": the
   * space of keyform positions, y down.
   */
  space?: MapSpace;
  /** Also return the 2×2 Jacobian at each point. Default false. */
  jacobian?: boolean;
}

/** The result of {@link ModelRuntime.mapPoints}. */
export interface MappedPoints {
  /** x, y pairs. */
  points: Float32Array;
  /** With `jacobian`: ∂x/∂px, ∂x/∂py, ∂y/∂px, ∂y/∂py per point. */
  jacobians?: Float64Array;
}

/** The components of the frame procedure that can be switched on and off (3w.1). */
export type EffectName = keyof EffectSwitches;

export interface RuntimeOptions {
  /**
   * Look writes the physics input of a target that physics overwrites
   * (convenience, not reference behavior). Default true.
   */
  lookThroughPhysics?: boolean;
  /**
   * The parameter lip sync drives when the settings list no `LipSync`
   * parameters, or false for none (convenience). Default "ParamMouthOpenY".
   */
  lipSyncFallback?: string | false;
  /** Options of the frame procedure: wrap mode, gravity, wind, settle, eye blink timing, random source. */
  animation?: Omit<AnimatorOptions, "groupMotion">;
  /**
   * Evaluation stages to leave out (experimental): `{ glue: false }` skips
   * the glue pass, `{ blendShapes: false }` ignores blend-shape keyform
   * bindings. Both default to true. See {@link EvaluationOptions}.
   */
  evaluation?: EvaluationOptions;
  /**
   * Called when an accepted motion start has a sound file (3b.2), with its
   * bytes, so the host can play it. Lip sync starts on its own. When it
   * returns a function, that is the sound's playback clock (a
   * `MotionSyncClock`), which motion sync then follows; otherwise motion
   * sync counts the frames' steps.
   */
  onSound?: (path: string, bytes: Uint8Array) => unknown;
  /**
   * Reject files whose keyform draw orders lie outside their draw-order
   * group's range (opt-in strict mode, for validation tooling). Default
   * false: such files load, as in the official runtime, with a warning per
   * object in `warnings`, and drawables are sorted by their evaluated draw
   * order (C12 decision and C25).
   */
  strictDrawOrders?: boolean;
  /**
   * Load files whose keyform opacities are NaN or ±∞, as the official
   * runtime does ("load"). Default "reject": no genuine file has one, so the
   * load fails. Loaded, such drawables are drawn with the renderer's
   * clamping rules (see `loadMoc`).
   */
  nonFiniteOpacity?: "reject" | "load";
  /**
   * Load files (v6) whose part keyforms hold an offscreen keyform index that
   * is neither −1 nor valid, as the official runtime does ("load"; such an
   * index reads as −1). Default "reject": the official check rejects them.
   */
  offscreenKeyformRange?: "reject" | "load";
  /**
   * In frames that take no time (`update(0)`, a paused clock), write the
   * last physics outputs again, so physics-driven parameters keep their
   * physics values (not reference behavior). The reference writes no
   * outputs then, so they show their base values (3n.3). Default false;
   * `MochiView` turns it on for the models it shows (its
   * `holdPhysicsWhenPaused` option).
   */
  holdPhysicsInZeroSteps?: boolean;
  /**
   * The physics simulation rate, steps per second, instead of the physics
   * file's `Fps` (not reference behavior; see `ModelRuntime.setPhysicsRate`).
   * Default the file's.
   */
  physicsRate?: number;
  /**
   * `stopMotions()` also clears the current priority, so the next start is
   * accepted (convenience; the frame procedure keeps the priority, C19).
   * Default true.
   */
  stopClearsPriority?: boolean;
}

/** How a motion starts. */
export interface MotionOptions {
  /** 1 idle, 2 normal, 3 force (3l.4). Default 2. */
  priority?: number;
  /** Default false. */
  loop?: boolean;
  /** Override the fade times of the file and of the settings entry (used when ≥ 0). */
  fadeIn?: number;
  fadeOut?: number;
  /** In [0, 1]; default 1. */
  weight?: number;
  /** Start the settings entry's sound, if it has one. Default true. */
  sound?: boolean;
  /**
   * Hold the last frame: the values at the motion's end stay until
   * `stopMotions()` or the next motion (which fades it out with its own
   * fade-out time). Not reference behavior; ignored with `loop`. While a
   * motion holds, idle motions do not start. Default false.
   */
  hold?: boolean;
  /**
   * With `hold`: eye blink runs once the motion has reached its end and stays
   * there (default true). False keeps eye blink off while it holds, as while
   * any motion plays.
   */
  blinkWhileHeld?: boolean;
}

export type { MotionEndReason };

/**
 * How a motion ended. `reason`: "finished" (it played to its end; a held
 * motion when it reaches its last frame), "replaced" (another motion started
 * while it played, so it faded out), or "stopped" (`stopMotions()`, or its
 * model was disposed).
 */
export interface MotionEnd {
  /** The motion file's path in the source (as in `playingMotions`). */
  motion: string;
  /** The settings group and index it was started from, or null (a file). */
  group: string | null;
  index: number | null;
  reason: MotionEndReason;
  /** Whether the motion queue is empty after this end. */
  queueEmpty: boolean;
}

/** An accepted motion start. */
export interface MotionPlayback {
  /** The motion file's path in the source. */
  motion: string;
  group: string | null;
  index: number | null;
  /** Resolves when this motion ends (see {@link MotionEnd}). Never rejects. */
  ended: Promise<MotionEnd>;
}

/** One animation frame's outcome. */
export interface RuntimeFrame extends FrameResult {
  /** Parameter values or part opacities changed, so the model needs evaluating. */
  changed: boolean;
}

const DEFAULT_LIP_SYNC = "ParamMouthOpenY";

export class ModelRuntime {
  readonly source: FileSource;
  readonly settingsPath: string;
  readonly settings: ModelSettings;
  readonly model: MocModel;
  readonly instance: ModelInstance;
  /**
   * Application tints of the art meshes (see {@link setTint}): RGBA per
   * drawable, 4 floats each, 1 where none is set. For renderers.
   */
  readonly drawableTints: Float32Array;
  /** Changes whenever a tint changes, so a view knows to draw again. */
  tintVersion = 0;
  /** Art meshes with a tint, by index. */
  private readonly tinted = new Set<number>();
  readonly animator: Animator;
  readonly parameters: readonly ParameterInfo[];
  readonly parts: readonly PartInfo[];
  /** The deformers in file order (warps and rotations), with their parents. */
  readonly deformers: readonly DeformerInfo[];
  /** Parameters physics overwrites (weight 100 %), with their largest-weight model-parameter input. */
  readonly physicsDriven: ReadonlyMap<string, string>;
  /**
   * Parameters physics overwrites (weight 100 %) while it runs, each with the
   * model parameters that drive it, largest weight first. While physics runs,
   * writing such a parameter (setParameter, a motion, head tracking) has no
   * visible effect: write a driving input instead, as look does with
   * `lookThroughPhysics`. Empty without physics.
   */
  readonly physicsInputs: ReadonlyMap<string, readonly PhysicsDriver[]>;
  /** The parameter lip sync drives because the settings list none, or null. */
  readonly lipSyncFallback: string | null;
  /** Problems with optional files and motions, one line each. */
  readonly warnings: string[];
  readonly bundle: ModelBundle;
  /** Events of recent frames, newest last (at most 20). */
  readonly recentEvents: string[] = [];
  /** The latest frame's result, or null before the first frame. */
  lastFrame: FrameResult | null = null;
  lookThroughPhysics: boolean;
  onSound: ((path: string, bytes: Uint8Array) => unknown) | undefined;

  private readonly dir: string;
  private readonly lastParams: Float32Array;
  private readonly lastParts: Float32Array;
  private dirty = true;
  private needsEvaluation = true;
  private readonly motions = new Map<string, Promise<Motion>>();
  /** Motions that finished loading, for idle playback (which is synchronous). */
  private readonly readyMotions = new Map<string, Motion | null>();
  private readonly readySounds = new Map<string, { bytes: Uint8Array; sound: WavSound | null }>();
  private readonly expressions = new Map<string, Promise<Expression>>();
  private pendingSound: {
    motion: Motion;
    path: string;
    bytes: Uint8Array;
    motionSync?: string;
    /** The queue ticket of the start, once accepted. */
    ticket?: number;
  } | null = null;
  /**
   * The start (by queue ticket) whose sound motion sync plays, and whether
   * that sound is already fading out.
   */
  private motionSyncMotion: { ticket: number; fading: boolean } | null = null;
  /** Motion-sync decodings of sounds, by path (null: not readable). */
  private readonly motionSyncSounds = new Map<string, MotionSyncSound | null>();
  /** Accepted starts by queue ticket: where they came from, and their `ended` resolver. */
  private readonly starts = new Map<
    number,
    { group: string | null; index: number | null; resolve?: (end: MotionEnd) => void }
  >();
  private readonly endListeners = new Set<(end: MotionEnd) => void>();

  /** Loads a model's files from a source and prepares it (see {@link ModelRuntime}). */
  static async load(
    source: FileSource,
    settingsPath?: string,
    options: RuntimeOptions = {},
  ): Promise<ModelRuntime> {
    const runtime = new ModelRuntime(
      await loadModelBundle(source, settingsPath, loadOptionsOf(options)),
      options,
    );
    await runtime.preloadGroup("Idle");
    return runtime;
  }

  /** The options this runtime was made with (for {@link withModel}). */
  private readonly options: RuntimeOptions;
  /** Physics strength and wind (see {@link setPhysicsStrength}, {@link setPhysicsWind}). */
  private physicsStrengthValue = 1;
  /** The physics rate set, or null: the file's (see {@link setPhysicsRate}). */
  private physicsRateValue: number | null = null;
  private readonly settingStrengths = new Map<string, number>();
  private readonly settingWinds = new Map<string, number>();
  private windValue: [number, number];

  /** The `loadMoc` options this runtime loads files with (from its {@link RuntimeOptions}). */
  get loadOptions(): LoadMocOptions {
    return loadOptionsOf(this.options);
  }

  constructor(bundle: ModelBundle, options: RuntimeOptions = {}) {
    this.options = options;
    this.bundle = bundle;
    this.source = bundle.source;
    this.settingsPath = bundle.settingsPath;
    this.model = bundle.model;
    this.dir = dirnameOf(bundle.settingsPath);
    this.warnings = [...bundle.warnings];
    this.lookThroughPhysics = options.lookThroughPhysics ?? true;
    this.stopClearsPriority = options.stopClearsPriority ?? true;
    this.onSound = options.onSound;
    const m = bundle.model;
    this.instance = new ModelInstance(m, { evaluation: options.evaluation });
    this.drawableTints = new Float32Array(4 * m.meshes.ids.length).fill(1);
    // Display order (answer B3) can differ from model order.
    const paramIndex = new Map(m.parameters.ids.map((id, i) => [id, i]));
    this.parameters = displayLabels(m.parameters.ids, bundle.displayInfo, "parameters").map((l) => {
      const i = paramIndex.get(l.id)!;
      return {
        id: l.id,
        name: l.label,
        ...(l.group !== undefined ? { group: l.group } : {}),
        min: m.parameters.min[i]!,
        max: m.parameters.max[i]!,
        default: m.parameters.defaults[i]!,
        blendShape: m.parameters.type[i] === 1,
      };
    });
    const partIndex = new Map(m.parts.ids.map((id, i) => [id, i]));
    this.deformers = m.deformers.ids.map((id, i) => ({
      id,
      kind: m.deformers.kind[i] === 1 ? "rotation" : "warp",
      parent: m.deformers.parent[i]! >= 0 ? m.deformers.ids[m.deformers.parent[i]!]! : null,
    }));
    this.parts = displayLabels(m.parts.ids, bundle.displayInfo, "parts").map((l) => ({
      id: l.id,
      name: l.label,
      defaultOpacity: m.parts.initialOpacity[partIndex.get(l.id)!]!,
    }));
    // Lip sync: the settings' group, or the fallback parameter.
    let settings = bundle.settings;
    const fallback = options.lipSyncFallback ?? DEFAULT_LIP_SYNC;
    this.lipSyncFallback = null;
    if (
      fallback !== false &&
      parameterGroupIds(settings, "LipSync").length === 0 &&
      m.parameters.ids.includes(fallback)
    ) {
      this.lipSyncFallback = fallback;
      settings = {
        ...settings,
        groups: [
          ...settings.groups.filter((g) => g.name !== "LipSync"),
          { target: "Parameter", name: "LipSync", ids: [fallback] },
        ],
      };
    }
    this.settings = bundle.settings;
    const animation = options.animation;
    this.animator = new Animator(
      m,
      settings,
      { physics: bundle.physics, pose: bundle.pose, motionSync: bundle.motionSync },
      {
        ...animation,
        groupMotion: (group, index) => this.readyGroupMotion(group, index),
        onIdleStart: (index, started) => {
          if (started) {
            this.starts.set(this.animator.motions.lastTicket, {
              group: animation?.idleList ? null : "Idle",
              index,
            });
            if (this.pendingSound) this.pendingSound.ticket = this.animator.motions.lastTicket;
          }
          animation?.onIdleStart?.(index, started);
        },
      },
    );
    if (this.animator.physics && options.holdPhysicsInZeroSteps)
      this.animator.physics.holdOnZeroSteps = true;
    if (options.physicsRate !== undefined) this.setPhysicsRate(options.physicsRate);
    const rigWind = this.animator.physics?.wind ?? animation?.wind ?? [0, 0];
    this.windValue = [rigWind[0], rigWind[1]];
    const driven = new Map<string, string>();
    const drivers = new Map<string, PhysicsDriver[]>();
    if (this.animator.physics)
      for (const [dest, inputs] of this.animator.physics.overwrittenParameters()) {
        const list = inputs
          .filter((i) => m.parameters.ids.includes(i.source))
          .map((i) => ({ id: i.source, weight: i.weight, type: i.type, reflect: i.reflect }))
          .sort((a, b) => b.weight - a.weight);
        drivers.set(dest, list);
        if (list[0]) driven.set(dest, list[0].id);
      }
    this.physicsDriven = driven;
    this.physicsInputs = drivers;
    this.updateLookTargets();
    this.lastParams = new Float32Array(m.parameters.ids.length).fill(NaN);
    this.lastParts = new Float32Array(m.parts.ids.length).fill(NaN);
  }

  // ------------------------------------------------------------ files

  /** Resolves a path relative to the settings file's directory to a source path. */
  resolve(path: string): string {
    return joinPath(this.dir, path);
  }

  /**
   * Files of the source below the settings file's directory, relative to it,
   * or undefined if the source cannot list its files (HTTP).
   */
  get files(): string[] | undefined {
    const all = this.source.list();
    if (!all) return undefined;
    if (!this.dir) return [...all];
    const prefix = this.dir + "/";
    return all.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  }

  /** Motion groups of the settings, with their number of entries. */
  get motionGroups(): { name: string; count: number }[] {
    return this.settings.motions.map((g) => ({ name: g.group, count: g.entries.length }));
  }

  /** Names of the settings' expressions, in file order. */
  get expressionNames(): string[] {
    return this.settings.expressions.map((e) => e.name);
  }

  /** Hit areas of the settings: art-mesh ID and name (3t). */
  get hitAreas(): { id: string; name: string }[] {
    return this.settings.hitAreas.map((h) => ({ ...h }));
  }

  /** Reads and validates a motion file (path relative to the settings file). Cached. */
  loadMotion(path: string): Promise<Motion> {
    const p = this.resolve(path);
    let pending = this.motions.get(p);
    if (!pending) {
      pending = this.source.read(p).then((bytes) => parseMotion(bytes, p));
      this.motions.set(p, pending);
      pending.then(
        (motion) => this.readyMotions.set(p, motion),
        () => {
          this.readyMotions.set(p, null);
          this.motions.delete(p);
        },
      );
    }
    return pending;
  }

  /** Reads an expression file (path relative to the settings file). Cached. */
  loadExpression(path: string): Promise<Expression> {
    const p = this.resolve(path);
    let pending = this.expressions.get(p);
    if (!pending) {
      pending = this.source.read(p).then((bytes) => parseExpression(bytes, p));
      this.expressions.set(p, pending);
      pending.catch(() => this.expressions.delete(p));
    }
    return pending;
  }

  /**
   * Loads every motion of a settings group (and the entries' sounds), so the
   * group can play without waiting. Invalid files become warnings.
   */
  async preloadGroup(group: string): Promise<void> {
    const entries = this.settings.motions.find((g) => g.group === group)?.entries ?? [];
    await Promise.all(
      entries.map(async (entry) => {
        try {
          await this.loadMotion(entry.file);
        } catch (e) {
          this.warnings.push(`${entry.file}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (entry.sound) await this.loadSound(entry.sound);
      }),
    );
  }

  private async loadSound(path: string): Promise<{ bytes: Uint8Array; sound: WavSound | null }> {
    const p = this.resolve(path);
    const ready = this.readySounds.get(p);
    if (ready) return ready;
    let bytes: Uint8Array;
    try {
      bytes = await this.source.read(p);
    } catch {
      bytes = new Uint8Array(0);
    }
    let sound: WavSound | null = null;
    try {
      sound = decodeWav(bytes);
    } catch {
      sound = null; // lip sync stops for a sound that cannot be loaded (3s.1)
    }
    const r = { bytes, sound };
    this.readySounds.set(p, r);
    return r;
  }

  /** The idle path of the frame procedure: only motions that are already loaded can start. */
  private readyGroupMotion(group: string, index: number): ResolvedMotion | null {
    const entry = this.settings.motions.find((g) => g.group === group)?.entries[index];
    if (!entry) return null;
    const p = this.resolve(entry.file);
    if (!this.readyMotions.has(p)) {
      void this.loadMotion(entry.file).catch(() => {});
      return null;
    }
    const r: ResolvedMotion = { motion: this.readyMotions.get(p)! };
    if (entry.fadeInTime !== undefined) r.fadeIn = entry.fadeInTime;
    if (entry.fadeOutTime !== undefined) r.fadeOut = entry.fadeOutTime;
    if (entry.sound) {
      const path = this.resolve(entry.sound);
      const s = this.readySounds.get(path);
      if (s) {
        r.sound = s.sound;
        // Reported after the frame, if the start was accepted.
        if (s.bytes.length && r.motion)
          this.pendingSound = {
            motion: r.motion,
            path,
            bytes: s.bytes,
            ...(entry.motionSync ? { motionSync: entry.motionSync } : {}),
          };
      }
    }
    return r;
  }

  // ------------------------------------------------------------ values

  /**
   * A parameter's value in the latest frame: its base value with motions,
   * expressions and effects applied. An ID the model lacks reads its free
   * value (0 unless a motion wrote it).
   */
  getParameter(id: string): number {
    return this.animator.values.get(id);
  }

  /**
   * A parameter's base value: what {@link setParameter} set, or what motions
   * left in it (the frame procedure keeps a motion's result, so it persists
   * after the motion ends). Expressions and effects (eye blink, breath,
   * look, physics, lip sync) apply on top of it; {@link getParameter} reads
   * the result. An ID the model lacks reads as in `getParameter`.
   */
  getParameterBase(id: string): number {
    const v = this.animator.values;
    const i = v.index(id);
    return i < 0 ? v.get(id) : v.saved[i]!;
  }

  /**
   * Sets a parameter's base value. It persists like a motion's result (it is
   * restored every frame), and effects apply on top. It shows at the next
   * {@link update}; `update(0)` applies it at once. Returns false for an
   * unknown ID.
   */
  setParameter(id: string, value: number): boolean {
    const i = this.animator.values.index(id);
    if (i < 0) return false;
    this.animator.setBaseParameter(i, value);
    this.dirty = true;
    return true;
  }

  /**
   * How far the idle animation moves a parameter, in [0, 1] (not reference
   * behavior): at 0 it leaves the parameter at its base value, so tracking
   * written with {@link setParameter} shows through; at 1 (the default) it
   * applies as usual. The idle animation is every motion started at the
   * idle priority (1): the settings' `Idle` group and motions started with
   * `priority: 1`. A curve that would move the parameter by w of the way to
   * its value moves it by w·weight. Other motions, expressions and effects
   * are not affected, nor are part-opacity curves. Change the weight over
   * frames to fade a handover. Values are limited to [0, 1]; returns false
   * for an unknown ID. NaN throws a RangeError.
   */
  setIdleWeight(id: string, weight: number): boolean {
    if (Number.isNaN(weight)) throw new RangeError(`the idle weight of ${id} is NaN`);
    if (this.animator.values.index(id) < 0) return false;
    const w = Math.min(1, Math.max(0, weight));
    const weights = this.animator.motions.idleWeights;
    if (w === 1) weights.delete(id);
    else weights.set(id, w);
    this.dirty = true;
    return true;
  }

  /** A parameter's idle weight (see {@link setIdleWeight}); 1 unless set. */
  getIdleWeight(id: string): number {
    return this.animator.motions.idleWeights.get(id) ?? 1;
  }

  /** The idle weights that are not 1, by parameter ID. */
  get idleWeights(): ReadonlyMap<string, number> {
    return new Map(this.animator.motions.idleWeights);
  }

  /** Every idle weight back to 1. */
  resetIdleWeights(): void {
    this.animator.motions.idleWeights.clear();
    this.dirty = true;
  }

  // ------------------------------------------------- physics strength, wind

  /**
   * The model's physics settings in file order: ID and display name (from
   * the file's dictionary, or the ID; `named` tells which). Empty without a
   * physics file.
   */
  get physicsSettings(): readonly PhysicsSettingInfo[] {
    const file = this.animator.physics?.file;
    if (!file) return [];
    return file.settings.map((s) => {
      const entry = file.names.find((n) => n.id === s.id);
      return { id: s.id, name: entry ? entry.name : s.id, named: entry !== undefined };
    });
  }

  /**
   * How strongly physics moves the model's parameters (not reference
   * behavior). Each physics output moves its parameter from c, its value
   * before the output is written, to r, the value the physics file's rule
   * gives; with a strength k the parameter becomes c + (r − c)·k instead.
   * At 0 physics leaves its parameters as they are; at 1 (the default) it is
   * the reference, bit for bit; above 1 it exaggerates, limited to each
   * parameter's range. The simulation itself runs unchanged: its inputs,
   * gravity and wind act as before, so changing the strength never makes
   * the pendulums jump. The model's strength multiplies each setting's own
   * ({@link setPhysicsSettingStrength}). Negative values are limited to 0;
   * NaN and ±∞ throw a RangeError.
   */
  setPhysicsStrength(strength: number): void {
    this.physicsStrengthValue = checkedStrength(strength, "the physics strength");
    if (this.animator.physics) this.animator.physics.strength = this.physicsStrengthValue;
    this.dirty = true;
  }

  /** The model's physics strength (see {@link setPhysicsStrength}); 1 unless set. */
  get physicsStrength(): number {
    return this.physicsStrengthValue;
  }

  /**
   * One physics setting's strength, by its ID (see {@link physicsSettings}):
   * it multiplies the model's strength for that setting's outputs (see
   * {@link setPhysicsStrength}). Returns false for an unknown ID.
   */
  setPhysicsSettingStrength(id: string, strength: number): boolean {
    const k = checkedStrength(strength, `the physics strength of ${id}`);
    const rig = this.animator.physics;
    const indices = rig ? rig.file.settings.flatMap((s, i) => (s.id === id ? [i] : [])) : [];
    if (indices.length === 0) return false;
    for (const i of indices) rig!.settingStrengths[i] = k;
    if (k === 1) this.settingStrengths.delete(id);
    else this.settingStrengths.set(id, k);
    this.dirty = true;
    return true;
  }

  /** A physics setting's strength (see {@link setPhysicsSettingStrength}); 1 unless set. */
  getPhysicsSettingStrength(id: string): number {
    return this.settingStrengths.get(id) ?? 1;
  }

  /** The physics settings' strengths that are not 1, by setting ID. */
  get physicsSettingStrengths(): ReadonlyMap<string, number> {
    return new Map(this.settingStrengths);
  }

  /** The model's physics strength and every setting's back to 1. */
  resetPhysicsStrengths(): void {
    this.physicsStrengthValue = 1;
    this.settingStrengths.clear();
    const rig = this.animator.physics;
    if (rig) {
      rig.strength = 1;
      rig.settingStrengths.fill(1);
    }
    this.dirty = true;
  }

  /**
   * The physics wind V (3n.2), a force added to every pendulum particle's,
   * in the physics' own units (gravity is (0, −1)), read at every physics
   * step: a change takes effect from the next one. Default (0, 0), or the
   * `animation.wind` option. Non-finite values throw a RangeError.
   */
  setPhysicsWind(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new RangeError(`the physics wind (${x}, ${y}) is not finite`);
    this.windValue = [x, y];
    if (this.animator.physics) this.animator.physics.wind = [x, y];
    this.dirty = true;
  }

  /** The physics wind (see {@link setPhysicsWind}). */
  get physicsWind(): [number, number] {
    return [this.windValue[0], this.windValue[1]];
  }

  /**
   * How much of the wind one physics setting feels, by its ID (not
   * reference behavior): its pendulum particles get the wind V times
   * `multiplier` instead of V, at every step and in the settle procedure.
   * 1, the default, is the reference, bit for bit; 0 shields the setting
   * from the wind; 2 doubles it; a negative multiplier turns it around. The
   * wind is a force, so the pendulums respond over the next steps; nothing
   * jumps. Gravity and the strengths are unaffected. Returns false for an
   * unknown ID; a non-finite multiplier throws a RangeError.
   */
  setPhysicsSettingWind(id: string, multiplier: number): boolean {
    if (!Number.isFinite(multiplier))
      throw new RangeError(`the wind multiplier of ${id} (${multiplier}) is not finite`);
    const rig = this.animator.physics;
    const indices = rig ? rig.file.settings.flatMap((s, i) => (s.id === id ? [i] : [])) : [];
    if (indices.length === 0) return false;
    for (const i of indices) rig!.settingWinds[i] = multiplier;
    if (multiplier === 1) this.settingWinds.delete(id);
    else this.settingWinds.set(id, multiplier);
    this.dirty = true;
    return true;
  }

  /** A physics setting's wind multiplier (see {@link setPhysicsSettingWind}); 1 unless set. */
  getPhysicsSettingWind(id: string): number {
    return this.settingWinds.get(id) ?? 1;
  }

  /** The physics settings' wind multipliers that are not 1, by setting ID. */
  get physicsSettingWinds(): ReadonlyMap<string, number> {
    return new Map(this.settingWinds);
  }

  /** Every setting's wind multiplier back to 1 (the wind itself stays). */
  resetPhysicsSettingWinds(): void {
    this.settingWinds.clear();
    this.animator.physics?.settingWinds.fill(1);
    this.dirty = true;
  }

  /**
   * The physics simulation rate, in steps per second (not reference
   * behavior): the pendulums advance in steps of 1/rate seconds, and each
   * frame's outputs are interpolated between the last two steps (3n.3). 0
   * steps once per frame, by the frame's length. Null restores the physics
   * file's `Fps`. A change takes effect from the next frame; the pendulums
   * do not jump. Above 1000, below 0 or non-finite throws a RangeError.
   */
  setPhysicsRate(rate: number | null): void {
    if (rate !== null && !(Number.isFinite(rate) && rate >= 0 && rate <= 1000))
      throw new RangeError(`the physics rate ${rate} is not from 0 to 1000 steps per second`);
    this.physicsRateValue = rate;
    if (this.animator.physics) this.animator.physics.rate = rate;
    this.dirty = true;
  }

  /**
   * The physics rate in use, in steps per second (0: once per frame): the
   * one set ({@link setPhysicsRate}), or the physics file's `Fps`. 0 without
   * physics.
   */
  get physicsRate(): number {
    return this.animator.physics?.stepRate ?? this.physicsRateValue ?? 0;
  }

  /**
   * A copy of the physics simulation's state now, or null without physics:
   * every pendulum's particles, the last outputs and the step timing (see
   * `PhysicsState`). For an editor that scrubs a timeline: save the state
   * after a frame, and {@link restorePhysicsState} later continues from
   * there bit for bit. The options (gravity, wind, strengths, rate) are not
   * part of it.
   */
  savePhysicsState(): PhysicsState | null {
    return this.animator.physics?.saveState() ?? null;
  }

  /**
   * Puts the physics simulation back in a saved state ({@link
   * savePhysicsState}): the next frame continues exactly as the frame after
   * the save did, given the same parameter values, frame lengths and
   * options. The parameters physics drives show the restored pose from the
   * next frame (with `holdPhysicsInZeroSteps`, a frame of 0 s shows it).
   * RangeError when the model has no physics or the state was saved from
   * other physics settings.
   */
  restorePhysicsState(state: PhysicsState): void {
    const rig = this.animator.physics;
    if (!rig) throw new RangeError("the model has no physics");
    rig.restoreState(state);
    this.dirty = true;
  }

  // ----------------------------------------------------------- motion sync

  /**
   * The settings of the model's motion-sync file, in file order: ID,
   * dictionary name, and whether Mochi2D can run it. Empty without a file.
   */
  get motionSyncSettings(): readonly { id: string; name: string; usable: boolean }[] {
    return (this.bundle.motionSync?.settings ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      usable: s.usable,
    }));
  }

  /** A setting by dictionary name or ID, or the first usable one. */
  private motionSyncSetting(ref: string | undefined): MotionSyncSetting | null {
    const file = this.bundle.motionSync;
    if (!file) return null;
    if (ref === undefined) return file.settings.find((s) => s.usable) ?? null;
    const s = findMotionSyncSetting(file, ref);
    if (!s) throw new RangeError(`${file.label}: no motion-sync setting "${ref}"`);
    return s;
  }

  /** Binds the sound of the start `ticket` to its entry's setting (see the motion-sync docs). */
  private bindMotionSound(
    ticket: number,
    path: string,
    bytes: Uint8Array,
    ref: string,
    clock: unknown,
  ): void {
    const driver = this.animator.motionSync;
    const file = this.bundle.motionSync;
    if (!driver || !file) {
      this.warnings.push(
        `${path}: the motion names motion-sync setting "${ref}", but the model has no motion-sync file`,
      );
      return;
    }
    const setting = findMotionSyncSetting(file, ref);
    if (!setting || !setting.usable) {
      this.warnings.push(
        `${path}: motion-sync setting "${ref}" ${setting ? "cannot run" : "is not in the file"}; the sound plays without motion sync`,
      );
      return;
    }
    let sound = this.motionSyncSounds.get(path);
    if (sound === undefined) {
      try {
        sound = decodeMotionSyncWav(bytes);
      } catch (e) {
        sound = null;
        this.warnings.push(
          `${path}: ${e instanceof Error ? e.message : String(e)}; no motion sync`,
        );
      }
      this.motionSyncSounds.set(path, sound);
    }
    if (!sound) return;
    driver.playSound(
      setting,
      sound,
      typeof clock === "function" ? (clock as MotionSyncClock) : null,
    );
    this.takeMotionSyncWarnings();
    this.motionSyncMotion = { ticket, fading: false };
    this.dirty = true;
  }

  private takeMotionSyncWarnings(): void {
    const w = this.animator.motionSync?.warnings;
    if (w?.length) this.warnings.push(...w.splice(0));
  }

  /**
   * Plays a sound through motion sync (not reference behavior: Mochi2D's own
   * analysis drives the mouth): WAV bytes, or decoded channels. `setting` is a
   * dictionary name or ID, by default the first usable setting. `clock`
   * gives the playback position in seconds (an audio clock); without one, the
   * position is the sum of the frames' steps. The app plays the audio itself.
   * Returns false when the model has no usable motion-sync setting; throws a
   * RangeError for an unknown setting, and a `MotionSyncAudioError` for WAV
   * bytes it cannot read.
   */
  startMotionSync(
    sound: Uint8Array | MotionSyncSound,
    options: { setting?: string; clock?: MotionSyncClock } = {},
  ): boolean {
    const driver = this.animator.motionSync;
    const setting = this.motionSyncSetting(options.setting);
    if (!driver || !setting) return false;
    const decoded = sound instanceof Uint8Array ? decodeMotionSyncWav(sound) : sound;
    const ok = driver.playSound(setting, decoded, options.clock ?? null);
    this.motionSyncMotion = null;
    this.takeMotionSyncWarnings();
    this.dirty = true;
    return ok;
  }

  /**
   * A live input (a microphone, an audio stream) drives the mouth through
   * `setting` (default the first usable one) until replaced or removed with
   * null (the mouth then settles to its Silence shape). Returns false when
   * the model has no usable motion-sync setting.
   */
  setMotionSyncInput(input: MotionSyncInput | null, setting?: string): boolean {
    const driver = this.animator.motionSync;
    if (!driver) return false;
    if (!input) {
      driver.stop();
      return true;
    }
    const s = this.motionSyncSetting(setting);
    if (!s) return false;
    const ok = driver.setInput(s, input);
    this.takeMotionSyncWarnings();
    this.dirty = true;
    return ok;
  }

  /**
   * Ends motion sync's sound or input: after `fade` seconds of fading (a
   * sound only), the mouth settles to its Silence shape and motion sync
   * stops writing.
   */
  stopMotionSync(fade = 0): void {
    this.animator.motionSync?.stop(fade);
  }

  /**
   * The latest motion-sync tick: the setting, the level (dBFS), the element
   * weights (Silence, A, I, U, E, O; they sum to 1), and the values written.
   * Null while nothing is bound. Updated at every tick (`SampleRate` per
   * second at most).
   */
  get motionSync(): MotionSyncTick | null {
    return this.animator.motionSync?.tick ?? null;
  }

  /** What motion sync plays: the decoded sound or the live input, or null. */
  get motionSyncSource(): MotionSyncSound | MotionSyncInput | null {
    return this.animator.motionSync?.source ?? null;
  }

  /** Calls `listener` at every motion-sync tick; returns a function that removes it. */
  onMotionSyncTick(listener: (tick: MotionSyncTick) => void): () => void {
    return this.animator.motionSync?.onTick(listener) ?? (() => {});
  }

  /** The voice profile motion sync analyzes with, or null (the neutral synthetic voice). */
  get voiceProfile(): VoiceProfile | null {
    return this.animator.motionSync?.profile ?? null;
  }

  /** Sets the voice profile (from `VoiceCalibration.profile()`), or null. */
  setVoiceProfile(profile: VoiceProfile | null): void {
    this.animator.motionSync?.setProfile(profile);
  }

  /** Sets every parameter's base value back to its default. */
  resetParameters(): void {
    const ids = this.model.parameters.ids;
    for (let i = 0; i < ids.length; i++)
      this.animator.setBaseParameter(i, this.model.parameters.defaults[i]!);
    this.dirty = true;
  }

  getPartOpacity(id: string): number {
    return this.animator.values.partOpacity(id);
  }

  setPartOpacity(id: string, value: number): void {
    this.animator.setPartOpacity(id, value);
    this.dirty = true;
  }

  // ------------------------------------------------------------ tints

  /**
   * Tints an art mesh, until cleared (not reference behavior): `rgba` is
   * `[r, g, b]` or `[r, g, b, a]`. The drawn color, after the mesh's
   * multiply and screen colors, is multiplied by r, g and b, in [0, 2]:
   * below 1 a tint darkens, 1 leaves the mesh as it is, and above 1 it
   * brightens, the color limited to 1 (white) per channel. Its opacity is
   * multiplied by a, in [0, 1] (default 1). The mesh still masks as before
   * (masks use no colors or opacities). Values are limited to those ranges;
   * a value that is not finite throws a RangeError. Returns false for an
   * unknown ID.
   */
  setTint(meshId: string, rgba: readonly number[]): boolean {
    if (rgba.length !== 3 && rgba.length !== 4)
      throw new RangeError(`a tint is [r, g, b] or [r, g, b, a], not ${rgba.length} numbers`);
    for (const x of rgba)
      if (typeof x !== "number" || !Number.isFinite(x))
        throw new RangeError(`tint of ${meshId}: ${String(x)} is not a finite number`);
    const d = this.model.meshes.ids.indexOf(meshId);
    if (d < 0) return false;
    const t = this.drawableTints;
    for (let k = 0; k < 4; k++)
      t[4 * d + k] = Math.min(k < 3 ? MAX_TINT : 1, Math.max(0, rgba[k] ?? 1));
    this.tinted.add(d);
    this.tintVersion++;
    return true;
  }

  /** Removes an art mesh's tint. Returns false for an unknown ID or a mesh without one. */
  clearTint(meshId: string): boolean {
    const d = this.model.meshes.ids.indexOf(meshId);
    if (d < 0 || !this.tinted.delete(d)) return false;
    this.drawableTints.fill(1, 4 * d, 4 * d + 4);
    this.tintVersion++;
    return true;
  }

  /** Removes every tint. */
  clearTints(): void {
    if (this.tinted.size === 0) return;
    this.tinted.clear();
    this.drawableTints.fill(1);
    this.tintVersion++;
  }

  /** An art mesh's tint as `[r, g, b, a]` (stored as float32), or null without one. */
  getTint(meshId: string): [number, number, number, number] | null {
    const d = this.model.meshes.ids.indexOf(meshId);
    if (d < 0 || !this.tinted.has(d)) return null;
    const t = this.drawableTints;
    return [t[4 * d]!, t[4 * d + 1]!, t[4 * d + 2]!, t[4 * d + 3]!];
  }

  /** The tinted art meshes: ID → `[r, g, b, a]`. */
  get tints(): Map<string, [number, number, number, number]> {
    const ids = this.model.meshes.ids;
    return new Map(
      [...this.tinted].sort((a, b) => a - b).map((d) => [ids[d]!, this.getTint(ids[d]!)!]),
    );
  }

  /** {@link drawableTints} when a tint is set, else null (renderers then skip tinting). */
  get activeTints(): Float32Array | null {
    return this.tinted.size > 0 ? this.drawableTints : null;
  }

  /** The model opacity of the latest frame (3u). */
  get opacity(): number {
    return this.animator.values.modelOpacity;
  }

  // ------------------------------------------------------------ effects

  /** Whether a component runs; components the model lacks are reported off. */
  effect(name: EffectName): boolean {
    return this.effectAvailable(name) && this.animator.enabled[name];
  }

  /** Whether the model has what a component needs (a physics file, an EyeBlink group, …). */
  effectAvailable(name: EffectName): boolean {
    const a = this.animator;
    switch (name) {
      case "physics":
        return a.physics !== null;
      case "eyeBlink":
        return a.eyeBlink !== null;
      case "lipSync":
        return a.lipSync !== null;
      case "pose":
        return a.pose !== null;
      case "motionSync":
        return a.motionSync !== null;
      case "idle":
        return a.idleCount > 0;
      default:
        return true;
    }
  }

  setEffect(name: EffectName, on: boolean): void {
    this.animator.enabled[name] = on;
    if (name === "physics") this.updateLookTargets();
    if (name === "look" && !on) this.animator.setLookTarget(0, 0);
    this.dirty = true;
  }

  /** `stopMotions()` clears the current priority (convenience). */
  stopClearsPriority: boolean;
  /** Look writes the physics input of a target that physics overwrites (convenience). */
  updateLookTargets(): void {
    const m = this.model;
    const redirect =
      this.lookThroughPhysics && this.animator.enabled.physics && this.animator.physics !== null;
    const range = (id: string) => {
      const i = m.parameters.ids.indexOf(id);
      return i < 0 ? 1 : m.parameters.max[i]! - m.parameters.min[i]! || 1;
    };
    this.animator.look.entries = REFERENCE_LOOK.map((e): LookEntry => {
      const src = redirect ? this.physicsDriven.get(e.id) : undefined;
      if (!src) return e;
      const s = range(src) / range(e.id);
      return { id: src, fx: e.fx * s, fy: e.fy * s, fxy: e.fxy * s };
    });
  }

  /** The look targets in use, as target and written parameter. */
  lookRouting(): { target: string; writes: string }[] {
    return REFERENCE_LOOK.map((e, k) => ({
      target: e.id,
      writes: this.animator.look.entries[k]!.id,
    }));
  }

  // ------------------------------------------------------------ motions

  /**
   * Starts motion `index` of a settings group (a random one when omitted),
   * with the entry's fades and sound. Resolves to the playback (with an
   * `ended` promise), or false when the start is refused by priority (3l.4);
   * rejects for an unknown group or a file that fails validation.
   */
  async startMotion(
    group: string,
    index?: number,
    options: MotionOptions = {},
  ): Promise<MotionPlayback | false> {
    const entries = this.settings.motions.find((g) => g.group === group)?.entries;
    if (!entries || entries.length === 0)
      throw new Error(`${this.settingsPath}: no motion group "${group}"`);
    const i = index ?? Math.floor(Math.random() * entries.length);
    const entry = entries[i];
    if (!entry) throw new RangeError(`motion group "${group}" has no entry ${i}`);
    const motion = await this.loadMotion(entry.file);
    const sound =
      entry.sound && options.sound !== false ? await this.loadSound(entry.sound) : undefined;
    const accepted = this.animator.startMotion(
      {
        motion,
        ...(entry.fadeInTime !== undefined ? { fadeIn: entry.fadeInTime } : {}),
        ...(entry.fadeOutTime !== undefined ? { fadeOut: entry.fadeOutTime } : {}),
        ...(sound ? { sound: sound.sound } : {}),
      },
      this.motionStart(options),
    );
    if (accepted && sound && sound.bytes.length && entry.sound) {
      const clock = this.onSound?.(this.resolve(entry.sound), sound.bytes);
      if (entry.motionSync && motion)
        this.bindMotionSound(
          this.animator.motions.lastTicket,
          this.resolve(entry.sound),
          sound.bytes,
          entry.motionSync,
          clock,
        );
    }
    this.dirty = true;
    return accepted ? this.playback(motion, group, i) : false;
  }

  /**
   * Starts a motion file (path relative to the settings file) with its own
   * fades. Resolves to the playback, or false when refused by priority.
   */
  async startMotionFile(
    path: string,
    options: MotionOptions = {},
  ): Promise<MotionPlayback | false> {
    return this.playMotion(await this.loadMotion(path), options);
  }

  /** Starts an already parsed motion: the playback, or false when refused by priority. */
  playMotion(motion: Motion, options: MotionOptions = {}): MotionPlayback | false {
    const accepted = this.animator.startMotion({ motion }, this.motionStart(options));
    this.dirty = true;
    return accepted ? this.playback(motion, null, null) : false;
  }

  /** The playback of the start just accepted. */
  private playback(motion: Motion, group: string | null, index: number | null): MotionPlayback {
    const record: { group: string | null; index: number | null; resolve?: (e: MotionEnd) => void } =
      { group, index };
    const ended = new Promise<MotionEnd>((resolve) => (record.resolve = resolve));
    this.starts.set(this.animator.motions.lastTicket, record);
    return { motion: motion.label, group, index, ended };
  }

  private motionStart(o: MotionOptions): MotionStart {
    return {
      priority: o.priority ?? 2,
      loop: o.loop ?? false,
      ...(o.fadeIn !== undefined ? { fadeIn: o.fadeIn } : {}),
      ...(o.fadeOut !== undefined ? { fadeOut: o.fadeOut } : {}),
      ...(o.weight !== undefined ? { weight: o.weight } : {}),
      ...(o.hold ? { hold: true } : {}),
      ...(o.blinkWhileHeld === false ? { blinkWhileHeld: false } : {}),
    };
  }

  /**
   * Calls `listener` for every motion that ends (each motion once; see
   * {@link MotionEnd}), idle motions included. Returns a function that
   * removes the listener.
   */
  onMotionEnd(listener: (end: MotionEnd) => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  /** Resolves the playbacks of ended motions and tells the listeners. */
  private reportEnds(ends: readonly MotionEnded[]): void {
    if (ends.length === 0) return;
    const queueEmpty = this.animator.motions.empty;
    for (const e of ends) {
      // A motion-sync sound plays once; a motion stopped early fades it out
      // (when it was not already fading with its motion).
      const ms = this.motionSyncMotion;
      if (ms && e.ticket === ms.ticket) {
        this.motionSyncMotion = null;
        if (e.reason !== "finished" && !ms.fading) this.animator.motionSync?.stop(0);
      }
      const start = this.starts.get(e.ticket);
      this.starts.delete(e.ticket);
      const end: MotionEnd = {
        motion: e.motion.label,
        group: start?.group ?? null,
        index: start?.index ?? null,
        reason: e.reason,
        queueEmpty,
      };
      start?.resolve?.(end);
      for (const listener of [...this.endListeners]) listener(end);
    }
  }

  /**
   * Stops all motions (their playbacks end with "stopped"). By default this
   * also clears the current priority, so the next start is accepted (the
   * frame procedure itself only clears it when an advance empties the queue,
   * C19); see `RuntimeOptions.stopClearsPriority`.
   */
  stopMotions(): void {
    this.animator.stopMotions();
    if (this.stopClearsPriority) this.animator.motions.currentPriority = 0;
    this.dirty = true;
    this.reportEnds(this.animator.motions.takeEnds());
  }

  /** Labels (paths) of the motions in the queue, oldest first. */
  get playingMotions(): string[] {
    return this.animator.motions.motions.map((m) => m.label);
  }

  // -------------------------------------------------------- expressions

  /**
   * Starts an expression by its settings name, or by file path (relative to
   * the settings file) when no expression has that name. `fades` replaces
   * the file's fade-in and fade-out times (seconds) for this start.
   */
  async setExpression(nameOrPath: string, fades?: ExpressionFades): Promise<void> {
    checkFades(fades);
    const named = this.settings.expressions.find((e) => e.name === nameOrPath);
    this.playExpression(
      withFades(await this.loadExpression(named ? named.file : nameOrPath), fades),
    );
  }

  playExpression(expression: Expression): void {
    this.animator.startExpression(expression);
    this.dirty = true;
  }

  /**
   * Fades the current expressions out: starts an empty expression with the
   * newest one's fade-out time, or `fades.fadeOut` seconds.
   */
  clearExpression(fades?: Pick<ExpressionFades, "fadeOut">): void {
    checkFades(fades);
    const list = this.animator.expressions.expressions;
    const newest = list[list.length - 1];
    if (!newest) return;
    const t = fades?.fadeOut ?? newest.fadeOut;
    this.playExpression({ label: "(none)", fadeIn: t, fadeOut: t, parameters: [] });
  }

  /** Labels (paths) of the expressions in the queue, oldest first. */
  get playingExpressions(): string[] {
    return this.animator.expressions.expressions.map((e) => e.label);
  }

  /** The source path an expression name or path stands for. */
  private expressionPath(nameOrPath: string): string {
    const named = this.settings.expressions.find((e) => e.name === nameOrPath);
    return this.resolve(named ? named.file : nameOrPath);
  }

  /**
   * Adds an expression on top of the others, with its file's fade-in (not
   * reference behavior): several can show at once, applied in the order they
   * were added, after the expression of {@link setExpression}, which keeps
   * replacing. Resolves true, or false when it is already added.
   */
  async addExpression(nameOrPath: string, fades?: ExpressionFades): Promise<boolean> {
    checkFades(fades);
    const named = this.settings.expressions.find((e) => e.name === nameOrPath);
    const expression = withFades(await this.loadExpression(named ? named.file : nameOrPath), fades);
    const added = this.animator.expressionLayers.add(expression);
    this.dirty = true;
    return added;
  }

  /**
   * Fades out an expression added with {@link addExpression}, with its
   * fade-out (the file's, the one {@link addExpression} gave, or
   * `fades.fadeOut` seconds); without a name (or with null), every added
   * one. Returns whether one was removed.
   */
  removeExpression(nameOrPath?: string | null, fades?: Pick<ExpressionFades, "fadeOut">): boolean {
    checkFades(fades);
    const label = nameOrPath == null ? null : this.expressionPath(nameOrPath);
    const n = this.animator.expressionLayers.remove(label, fades?.fadeOut);
    this.dirty = true;
    return n > 0;
  }

  /** Labels (paths) of the expressions added with {@link addExpression} and not removed, oldest first. */
  get addedExpressions(): string[] {
    return this.animator.expressionLayers.active.map((e) => e.label);
  }

  // --------------------------------------------------- look and lip sync

  /** Sets the look target: x right and y up, in [−1, 1] (3r). */
  lookAt(x: number, y: number): void {
    this.animator.setLookTarget(x, y);
    this.dirty = true;
  }

  /** Returns the look target to the center. */
  releaseLook(): void {
    this.lookAt(0, 0);
  }

  /** Starts lip sync on a decoded sound; null stops it. */
  startLipSync(sound: WavSound | null): void {
    this.animator.startSound(sound);
    this.dirty = true;
  }

  /** Starts lip sync on a WAV file (3s.1). Returns false (and stops lip sync) if it cannot be analysed. */
  startLipSyncWav(bytes: Uint8Array | null): boolean {
    let sound: WavSound | null = null;
    if (bytes)
      try {
        sound = decodeWav(bytes);
      } catch {
        sound = null;
      }
    this.startLipSync(sound);
    return sound !== null && this.animator.lipSync !== null;
  }

  /**
   * Adds a live lip-sync input, such as a microphone (`LiveLipSync`, not
   * reference behavior), or removes it with null. Every frame while the
   * lip-sync effect is on, its value is combined with the lip-sync
   * parameters by `mix` (added by default, after a playing sound; see
   * {@link LiveLipSyncMix}). Returns false when the model has no lip sync.
   */
  setLiveLipSync(source: LiveLipSyncSource | null, mix: LiveLipSyncMix = "add"): boolean {
    this.dirty = true;
    return this.animator.setLiveLipSync(source, mix);
  }

  /** The live lip-sync input, or null. */
  get liveLipSync(): LiveLipSyncSource | null {
    return this.animator.lipSync?.liveSource ?? null;
  }

  /** How the live input combines with the lip-sync parameters (see {@link LiveLipSyncMix}). */
  get liveLipSyncMix(): LiveLipSyncMix {
    return this.animator.lipSync?.liveMix ?? "add";
  }

  set liveLipSyncMix(mix: LiveLipSyncMix) {
    if (this.animator.lipSync) this.animator.lipSync.liveMix = mix;
    this.dirty = true;
  }

  // ------------------------------------------------------------- frames

  /** Marks the model as changed, so the next frame runs even with a zero step. */
  touch(): void {
    this.dirty = true;
  }

  /**
   * Runs one frame of the procedure of 3j (steps 1–4) with step `dt`
   * seconds. A zero step with nothing changed is skipped (returns null).
   */
  animate(dt: number): RuntimeFrame | null {
    if (dt === 0 && !this.dirty) return null;
    const r = this.animator.frame(dt);
    this.lastFrame = r;
    const sound = this.pendingSound;
    this.pendingSound = null;
    if (
      sound &&
      sound.ticket !== undefined &&
      this.animator.motions.motions.includes(sound.motion)
    ) {
      const clock = this.onSound?.(sound.path, sound.bytes);
      if (sound.motionSync)
        this.bindMotionSound(sound.ticket, sound.path, sound.bytes, sound.motionSync, clock);
    }
    // A motion-sync sound fades out with its motion, over the motion's fade-out time.
    const ms = this.motionSyncMotion;
    if (ms && !ms.fading) {
      const fade = this.animator.motions.fadeOutOf(ms.ticket);
      if (fade !== null) {
        ms.fading = true;
        this.animator.motionSync?.stop(fade);
      }
    }
    for (const e of r.events) this.recentEvents.push(e);
    if (this.recentEvents.length > 20) this.recentEvents.splice(0, this.recentEvents.length - 20);
    this.reportEnds(r.ends);
    this.dirty = false;
    const v = this.animator.values;
    const same =
      v.values.every((x, i) => Object.is(x, this.lastParams[i])) &&
      v.partOpacities.every((x, i) => Object.is(x, this.lastParts[i]));
    if (!same) {
      this.lastParams.set(v.values);
      this.lastParts.set(v.partOpacities);
      this.needsEvaluation = true;
    }
    return { ...r, changed: !same };
  }

  /** Evaluates the model with the current values (3j step 5) if they changed. Returns whether it did. */
  evaluate(): boolean {
    if (!this.needsEvaluation) return false;
    this.animator.applyTo(this.instance);
    this.instance.evaluate();
    this.needsEvaluation = false;
    return true;
  }

  /**
   * In-place value patches (see {@link ModelInstance.patch}): new values for
   * keyform positions, opacities, draw orders, colors, rotation values and
   * glue intensities and weights, by their MocData array and index. Like a
   * parameter change, they show at the next {@link update} (in a view, the
   * next frame); `update(0)` applies them at once. Throws, and applies
   * nothing, for an array that cannot be patched or elements outside it.
   */
  patch(patches: ValuePatch | readonly ValuePatch[]): void {
    this.instance.patch(patches);
    this.needsEvaluation = true;
    this.dirty = true;
  }

  /**
   * A runtime for other data of this model (an editor's structural edit):
   * the same settings, files, source and options with `model` in place of
   * the `.moc3`. It starts from this runtime's parameter base values, part
   * opacities, idle weights, tints and effect switches, matched by ID, and reuses the motion,
   * expression and sound files already read. Playing motions, expressions
   * and listeners do not carry over. This runtime is unchanged.
   */
  async withModel(model: MocModel): Promise<ModelRuntime> {
    const moc = `${this.settings.moc}: `;
    const next = new ModelRuntime(
      {
        ...this.bundle,
        model,
        warnings: [
          ...model.loadWarnings.map((w) => moc + w),
          ...this.bundle.warnings.filter((w) => !w.startsWith(moc)),
        ],
      },
      this.options,
    );
    const saved = this.animator.values.saved;
    this.model.parameters.ids.forEach((id, i) => next.setParameter(id, saved[i]!));
    for (const p of this.parts) next.setPartOpacity(p.id, this.getPartOpacity(p.id));
    for (const name of Object.keys(this.animator.enabled) as EffectName[])
      next.setEffect(name, this.animator.enabled[name]);
    for (const [id, w] of this.animator.motions.idleWeights) next.setIdleWeight(id, w);
    next.setVoiceProfile(this.voiceProfile);
    next.setPhysicsStrength(this.physicsStrengthValue);
    for (const [id, k] of this.settingStrengths) next.setPhysicsSettingStrength(id, k);
    for (const [id, k] of this.settingWinds) next.setPhysicsSettingWind(id, k);
    next.setPhysicsWind(...this.windValue);
    next.setPhysicsRate(this.physicsRateValue);
    for (const [id, rgba] of this.tints) next.setTint(id, rgba);
    if (this.liveLipSync) next.setLiveLipSync(this.liveLipSync, this.liveLipSyncMix);
    // A live motion-sync input carries over (a sound does not, as motions do not).
    const sync = this.animator.motionSync;
    const input = sync?.source;
    if (sync?.playing && input && "read" in input && sync.setting)
      next.setMotionSyncInput(input, sync.setting.id || sync.setting.name);
    // Read motions, expressions and sounds do not depend on the model data.
    for (const [k, v] of this.motions) next.motions.set(k, v);
    for (const [k, v] of this.readyMotions) next.readyMotions.set(k, v);
    for (const [k, v] of this.readySounds) next.readySounds.set(k, v);
    for (const [k, v] of this.expressions) next.expressions.set(k, v);
    await next.preloadGroup("Idle");
    return next;
  }

  /**
   * {@link withModel} from `.moc3` bytes, or from {@link MocData} of a
   * `version` (as `mocModelFromData`), loaded with this runtime's options.
   * Rejects with the errors of `loadMoc` and `mocModelFromData`.
   */
  async withData(
    moc: Uint8Array | ArrayBuffer | MocData,
    version?: MocVersion,
  ): Promise<ModelRuntime> {
    const options = this.loadOptions;
    if (moc instanceof Uint8Array || moc instanceof ArrayBuffer)
      return this.withModel(loadMoc(moc, options));
    if (version === undefined) throw new TypeError("MocData needs its version");
    return this.withModel(mocModelFromData(moc, version, options));
  }

  /** {@link animate} then {@link evaluate}. */
  update(dt: number): RuntimeFrame | null {
    const r = this.animate(dt);
    this.evaluate();
    return r;
  }

  // ------------------------------------------------------------ mapping

  /**
   * Maps points from a deformer's input space (a warp's normalized grid
   * space, a rotation's local space) to model units through the deformer's
   * world form at the latest evaluation, its ancestors included, exactly as
   * the evaluator maps the vertices of its child meshes (outside regions of
   * warps included). `deformer` is a deformer ID, or null for none: the
   * points are then already in model space. `points` holds x, y pairs. With
   * `jacobian`, also the 2×2 Jacobian at each point, analytic per region.
   * Throws for an unknown deformer ID.
   */
  mapPoints(
    deformer: string | null,
    points: ArrayLike<number>,
    options: MapPointsOptions = {},
  ): MappedPoints {
    const d = deformer === null ? -1 : this.model.deformers.ids.indexOf(deformer);
    if (d < 0 && deformer !== null) throw new RangeError(`no deformer "${deformer}"`);
    const space = options.space ?? "model";
    const mapped: MappedPoints = { points: this.instance.mapPoints(d, points, space) };
    if (options.jacobian) mapped.jacobians = this.instance.mapJacobians(d, points, space);
    return mapped;
  }

  // ----------------------------------------------------------- hit tests

  /** Bounding box of a drawable's vertices from the latest evaluation (model units, y up). */
  drawableBounds(id: string): Bounds | null {
    const d = this.model.meshes.ids.indexOf(id);
    return d < 0 ? null : vertexBounds(this.instance.drawableVertices[d]!);
  }

  /** The settings' hit areas with their boxes from the latest evaluation (3t). */
  hitAreaBounds(): { id: string; name: string; bounds: Bounds }[] {
    return this.settings.hitAreas.flatMap((a) => {
      const bounds = this.drawableBounds(a.id);
      return bounds ? [{ id: a.id, name: a.name || a.id, bounds }] : [];
    });
  }

  /** Names (or IDs) of the hit areas whose box contains the point (model units, 3t). */
  hitAreasAt(x: number, y: number): string[] {
    return this.hitAreaBounds()
      .filter((a) => inside(a.bounds, x, y))
      .map((a) => a.name);
  }

  /** The topmost drawn drawable (visible, opacity above 0) whose box contains the point, or null. */
  drawableAt(x: number, y: number): string | null {
    const inst = this.instance;
    const ids = this.model.meshes.ids;
    let top = -1;
    for (let d = 0; d < ids.length; d++)
      if (
        inst.drawableVisible[d] &&
        inst.drawableOpacity[d]! > 0 &&
        inside(vertexBounds(inst.drawableVertices[d]!), x, y)
      )
        if (top < 0 || inst.drawableRenderOrder[d]! > inst.drawableRenderOrder[top]!) top = d;
    return top < 0 ? null : ids[top]!;
  }
}

const inside = (b: Bounds, x: number, y: number) =>
  b.minX <= x && x <= b.maxX && b.minY <= y && y <= b.maxY;

/** The `loadMoc` options of a runtime's options. */
function loadOptionsOf(o: RuntimeOptions): LoadMocOptions {
  return {
    ...(o.strictDrawOrders ? { drawOrderRange: "reject" as const } : {}),
    ...(o.nonFiniteOpacity ? { nonFiniteOpacity: o.nonFiniteOpacity } : {}),
    ...(o.offscreenKeyformRange ? { offscreenKeyformRange: o.offscreenKeyformRange } : {}),
  };
}

/** A strength value: finite, limited below to 0. */
function checkedStrength(k: number, what: string): number {
  if (!Number.isFinite(k)) throw new RangeError(`${what} is ${k} (not finite)`);
  return Math.max(0, k);
}

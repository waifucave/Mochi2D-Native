/**
 * Animation scenarios (3w; file format and run protocol in 4i–4k) in
 * programmatic form: a model and its settings, files by path,
 * frame steps, commands attached to frame numbers, the random sequence, which
 * effects run and the options. Runs synchronously and records the outputs of
 * 3w.3 per frame, the motion start attempts and the random numbers used.
 */
import type { MocModel } from "../core/moc/model.js";
import { ModelInstance } from "../core/eval/instance.js";
import type { ModelSettings } from "../core/settings/model-settings.js";
import { snapshotInstance, type DrawableSnapshot } from "../core/model/snapshot.js";
import { Animator, type EffectSwitches, type ResolvedMotion } from "./animator.js";
import { parseMotion, type Motion } from "./motion.js";
import { parseExpression, type Expression } from "./expression.js";
import { parsePhysics } from "./physics.js";
import { parsePose } from "./pose.js";
import { decodeWav, type WavSound } from "./lip-sync.js";
import type { EyeBlinkTiming } from "./effects.js";
import { vertexBounds } from "./model-data.js";
import { AnimationFormatError } from "./json.js";

export type ScenarioCommand =
  | {
      kind: "startMotion";
      /** A motion file, or a group name and an index into the settings' `Motions`. */
      file?: string;
      group?: string;
      index?: number;
      priority?: number;
      fadeIn?: number;
      fadeOut?: number;
      loop?: boolean;
      loopFadeIn?: boolean;
      weight?: number;
      offset?: number;
      legacyLoop?: boolean;
    }
  | { kind: "startExpression"; file?: string; name?: string }
  | { kind: "setLookTarget"; x: number; y: number }
  | { kind: "startSound"; file: string }
  | { kind: "setPartOpacity"; id: string; value: number }
  | { kind: "stopMotions" }
  /** Switches on an effect that was off (C19). */
  | { kind: "enable"; effect: keyof EffectSwitches };

/** Files by path relative to the settings file's folder: a map, or a lookup (undefined: missing). */
export type ScenarioFiles =
  ReadonlyMap<string, Uint8Array | string> | ((path: string) => Uint8Array | string | undefined);

export interface ScenarioHit {
  drawable: string;
  x: number;
  y: number;
}

export interface AnimationScenario {
  model: MocModel;
  settings: ModelSettings;
  files: ScenarioFiles;
  /** One frame per step, in order (answer B2). */
  steps: readonly number[];
  /** Commands in list order; a motion start's `command` index is its index here. */
  commands?: readonly { frame: number; command: ScenarioCommand }[];
  /** The random sequence r₁, r₂, … (3v.2); running out ends the run (RandomExhausted). */
  random?: readonly number[];
  /** Which components run; by default every one the settings make present. */
  effects?: Partial<EffectSwitches>;
  /** Motion files that replace the settings' `Idle` group (4i). */
  idleMotions?: readonly string[];
  options?: {
    wrap?: boolean;
    gravity?: [number, number];
    wind?: [number, number];
    settle?: boolean;
    eyeBlink?: Partial<EyeBlinkTiming>;
  };
  record?: {
    /** Free values to record by ID. */
    freeValues?: readonly string[];
    /** Hit tests after evaluation (3t), on every frame. */
    hitTests?: readonly ScenarioHit[];
    /** Hit tests after evaluation at given frames (4i `record.hits`). */
    hits?: readonly (ScenarioHit & { frame: number })[];
    /** Frames at which the full drawable records are taken (4i `record.drawables`). */
    drawables?: readonly number[];
    /**
     * Evaluate on every frame even when no hit test or drawable record needs
     * the outputs. Whenever any is requested, every frame is evaluated (C22).
     */
    evaluateEveryFrame?: boolean;
  };
}

/** A hit test with the drawable's box after step 5 (4k): [x_min, x_max, y_min, y_max]. */
export interface HitRecord extends ScenarioHit {
  hit: boolean;
  /** null for an unknown drawable ID. */
  box: [number, number, number, number] | null;
}

export interface FrameRecord {
  frame: number;
  /** The running sum of the steps so far. */
  time: number;
  /** After step 4 (3w.3). */
  parameters: Float32Array;
  partOpacities: Float32Array;
  /** null for an ID that has never been written (C21). */
  freeValues: Record<string, number | null>;
  modelOpacity: number;
  motionUpdated: boolean;
  queueEmpty: boolean;
  events: string[];
  lipSync: number | null;
  /** After step 5: `record.hitTests`, in order. */
  hits?: boolean[];
  /** After step 5: this frame's `record.hits`, in order. */
  hitRecords?: HitRecord[];
  /** After step 5, on frames listed in `record.drawables`. */
  drawables?: DrawableSnapshot[];
}

/** A motion start attempt (4k `starts`). */
export interface MotionStartRecord {
  frame: number;
  /**
   * For a command start: the command's index in the whole `commands` list,
   * counting commands of every kind, from 0 (4k).
   */
  command?: number;
  /** For an idle start: the picked index into the idle list. */
  idle?: number;
  /** The start was accepted and its file was valid (3l.4). */
  started: boolean;
}

export interface AnimationReport {
  /** One record per completed frame. */
  frames: FrameRecord[];
  starts: MotionStartRecord[];
  /** Random numbers consumed. */
  randomUsed: number;
  warnings: string[];
  /** The random sequence ran out (RandomExhausted); the frames completed before stay. */
  randomExhausted: boolean;
}

/** The random sequence ran out (3v.2; error kind `RandomExhausted` in 4b). */
export class RandomExhaustedError extends RangeError {
  constructor() {
    super("the scenario's random sequence ran out");
    this.name = "RandomExhaustedError";
  }
}

/** A random source over a fixed sequence that fails when it runs out. */
export function sequenceRandom(list: readonly number[]): () => number {
  let i = 0;
  return () => {
    if (i >= list.length) throw new RandomExhaustedError();
    return list[i++]!;
  };
}

/** Runs a scenario; throws when the random sequence runs out. */
export function runAnimationScenario(sc: AnimationScenario): FrameRecord[] {
  const report = runAnimationScenarioReport(sc);
  if (report.randomExhausted) throw new RandomExhaustedError();
  return report.frames;
}

/**
 * Runs a scenario under the protocol of 4j and returns every completed frame,
 * the motion start attempts and the random numbers used. Missing or invalid
 * motion, sound and expression files are handled as in 4j, with warnings;
 * problems with the settings, physics or pose files throw.
 */
export function runAnimationScenarioReport(sc: AnimationScenario): AnimationReport {
  const { model, settings } = sc;
  const warnings: string[] = [];
  const lookup =
    typeof sc.files === "function"
      ? sc.files
      : (path: string) => (sc.files as ReadonlyMap<string, Uint8Array | string>).get(path);
  const required = (path: string): Uint8Array | string => {
    const f = lookup(path);
    if (f === undefined) throw new AnimationFormatError(`file ${path} is missing`);
    return f;
  };
  const motions = new Map<string, Motion | null>();
  const motionFile = (path: string): Motion | null => {
    if (!motions.has(path)) {
      let m: Motion | null = null;
      const f = lookup(path);
      if (f === undefined) warnings.push(`motion file ${path} is missing; its starts are dropped`);
      else
        try {
          m = parseMotion(f, path);
        } catch (e) {
          if (!(e instanceof AnimationFormatError)) throw e;
          warnings.push(`motion file ${path} is invalid (${e.message}); its starts are dropped`);
        }
      motions.set(path, m);
    }
    return motions.get(path)!;
  };
  const sound = (path: string): WavSound | null => {
    const f = lookup(path);
    if (f === undefined || typeof f === "string") {
      warnings.push(`sound file ${path} ${f === undefined ? "is missing" : "is not binary"}`);
      return null;
    }
    try {
      return decodeWav(f);
    } catch (e) {
      warnings.push(`sound file ${path} cannot be loaded (${(e as Error).message})`);
      return null;
    }
  };
  const groupMotion = (group: string, index: number): ResolvedMotion | null => {
    const entry = settings.motions.find((g) => g.group === group)?.entries[index];
    if (!entry) return null;
    const r: ResolvedMotion = { motion: motionFile(entry.file) };
    if (entry.fadeInTime !== undefined) r.fadeIn = entry.fadeInTime;
    if (entry.fadeOutTime !== undefined) r.fadeOut = entry.fadeOutTime;
    if (entry.sound) r.sound = sound(entry.sound);
    return r;
  };
  const expressions = new Map<string, Expression | null>();
  const expressionFile = (path: string): Expression | null => {
    if (!expressions.has(path)) {
      let x: Expression | null = null;
      const f = lookup(path);
      if (f === undefined) warnings.push(`expression file ${path} is missing; ignored`);
      else
        try {
          x = parseExpression(f, path);
        } catch (e) {
          if (!(e instanceof AnimationFormatError)) throw e;
          warnings.push(`expression file ${path} is invalid (${e.message}); ignored`);
        }
      expressions.set(path, x);
    }
    return expressions.get(path)!;
  };

  const random = sc.random ?? [];
  let randomUsed = 0;
  const draw = () => {
    if (randomUsed >= random.length) throw new RandomExhaustedError();
    return random[randomUsed++]!;
  };
  const starts: MotionStartRecord[] = [];
  let frame = 0;
  const opts = sc.options ?? {};
  const idle = sc.idleMotions;
  const animator = new Animator(
    model,
    settings,
    {
      physics: settings.physics ? parsePhysics(required(settings.physics), settings.physics) : null,
      pose: settings.pose ? parsePose(required(settings.pose), settings.pose) : null,
    },
    {
      random: draw,
      groupMotion,
      ...(idle
        ? {
            idleList: {
              count: idle.length,
              motion: (i: number) => ({ motion: motionFile(idle[i]!) }),
            },
          }
        : {}),
      onIdleStart: (index, started) => starts.push({ frame, idle: index, started }),
      ...(opts.wrap !== undefined ? { wrap: opts.wrap } : {}),
      ...(opts.gravity ? { gravity: opts.gravity } : {}),
      ...(opts.wind ? { wind: opts.wind } : {}),
      ...(opts.settle !== undefined ? { settle: opts.settle } : {}),
      ...(opts.eyeBlink ? { eyeBlink: opts.eyeBlink } : {}),
    },
  );
  Object.assign(animator.enabled, sc.effects ?? {});

  const rec = sc.record ?? {};
  const hitsAt = new Map<number, ScenarioHit[]>();
  for (const h of rec.hits ?? []) {
    const list = hitsAt.get(h.frame) ?? [];
    list.push({ drawable: h.drawable, x: h.x, y: h.y });
    hitsAt.set(h.frame, list);
  }
  const drawablesAt = new Set(rec.drawables ?? []);
  const evaluateEveryFrame =
    rec.evaluateEveryFrame === true ||
    (rec.hitTests?.length ?? 0) > 0 ||
    hitsAt.size > 0 ||
    drawablesAt.size > 0;
  // A fresh instance: its creation evaluation uses the defaults (4j step 1).
  const instance = evaluateEveryFrame ? new ModelInstance(model) : null;
  const meshIndex = new Map<string, number>();
  model.meshes.ids.forEach((id, i) => meshIndex.has(id) || meshIndex.set(id, i));
  const hitRecord = (h: ScenarioHit): HitRecord => {
    const d = meshIndex.get(h.drawable);
    if (d === undefined) return { ...h, hit: false, box: null };
    const b = vertexBounds(instance!.drawableVertices[d]!);
    const hit = b.minX <= h.x && h.x <= b.maxX && b.minY <= h.y && h.y <= b.maxY;
    return { ...h, hit, box: [b.minX, b.maxX, b.minY, b.maxY] };
  };

  const byFrame = new Map<number, { index: number; command: ScenarioCommand }[]>();
  (sc.commands ?? []).forEach((c, index) => {
    const list = byFrame.get(c.frame) ?? [];
    list.push({ index, command: c.command });
    byFrame.set(c.frame, list);
  });
  const frames: FrameRecord[] = [];
  let time = 0;
  let randomExhausted = false;
  const apply = (index: number, c: ScenarioCommand) => {
    switch (c.kind) {
      case "startMotion": {
        let resolved: ResolvedMotion | null;
        if (c.file !== undefined) resolved = { motion: motionFile(c.file) };
        else {
          resolved = groupMotion(c.group ?? "", c.index ?? 0);
          if (!resolved) warnings.push(`no motion ${c.group}[${c.index}] in the settings`);
        }
        const start = {
          priority: c.priority ?? 2,
          ...(c.fadeIn !== undefined ? { fadeIn: c.fadeIn } : {}),
          ...(c.fadeOut !== undefined ? { fadeOut: c.fadeOut } : {}),
          ...(c.loop !== undefined ? { loop: c.loop } : {}),
          ...(c.loopFadeIn !== undefined ? { loopFadeIn: c.loopFadeIn } : {}),
          ...(c.weight !== undefined ? { weight: c.weight } : {}),
          ...(c.offset !== undefined ? { offset: c.offset } : {}),
          ...(c.legacyLoop !== undefined ? { legacyLoop: c.legacyLoop } : {}),
        };
        const started = resolved ? animator.startMotion(resolved, start) : false;
        starts.push({ frame, command: index, started });
        break;
      }
      case "startExpression": {
        const path = c.file ?? settings.expressions.find((e) => e.name === c.name)?.file;
        if (path === undefined) {
          warnings.push(`no expression named ${c.name}; ignored`);
          break;
        }
        const x = expressionFile(path);
        if (x) animator.startExpression(x);
        break;
      }
      case "setLookTarget":
        animator.setLookTarget(c.x, c.y);
        break;
      case "startSound":
        animator.startSound(sound(c.file));
        break;
      case "setPartOpacity":
        animator.setPartOpacity(c.id, c.value);
        break;
      case "stopMotions":
        animator.stopMotions();
        break;
      case "enable":
        animator.enabled[c.effect] = true;
        break;
    }
  };
  try {
    for (frame = 0; frame < sc.steps.length; frame++) {
      const dt = sc.steps[frame]!;
      for (const { index, command } of byFrame.get(frame) ?? []) apply(index, command);
      const r = animator.frame(dt);
      time += dt;
      const v = animator.values;
      const record: FrameRecord = {
        frame,
        time,
        parameters: Float32Array.from(v.values),
        partOpacities: Float32Array.from(v.partOpacities),
        freeValues: Object.fromEntries(
          (rec.freeValues ?? []).map((id) => {
            const p = v.index(id);
            return [id, p >= 0 ? v.values[p]! : (v.free.get(id) ?? null)];
          }),
        ),
        modelOpacity: v.modelOpacity,
        motionUpdated: r.motionUpdated,
        queueEmpty: r.queueEmpty,
        events: r.events,
        lipSync: r.lipSync,
      };
      if (instance) {
        animator.applyTo(instance);
        instance.evaluate();
        if (rec.hitTests?.length) record.hits = rec.hitTests.map((h) => hitRecord(h).hit);
        const hs = hitsAt.get(frame);
        if (hs) record.hitRecords = hs.map(hitRecord);
        if (drawablesAt.has(frame)) record.drawables = snapshotInstance(instance).drawables;
      }
      frames.push(record);
    }
  } catch (e) {
    if (!(e instanceof RandomExhaustedError)) throw e;
    randomExhausted = true;
  }
  return { frames, starts, randomUsed, warnings, randomExhausted };
}

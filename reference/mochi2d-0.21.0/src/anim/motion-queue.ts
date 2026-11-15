/**
 * Motion playback (3l): a queue with its own clock, sine fades,
 * looping with the end interval, events, and the reference viewer's
 * priorities.
 */
import type { Motion, MotionCurve } from "./motion.js";
import { evaluateCurve } from "./motion.js";
import { wrapValue, type AnimationValues } from "./values.js";

/** The easing E of 3l.3 b. */
export function ease(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/** How a motion is started (3l.1, 3w.2). */
export interface MotionStart {
  /** 0 none, 1 idle, 2 normal (default), 3 force (3l.4). */
  priority?: number;
  /** Override the file's fade times; used only when ≥ 0. */
  fadeIn?: number;
  fadeOut?: number;
  /** In [0, 1]; default 1. */
  weight?: number;
  /** Start this many seconds into the motion; default 0. */
  offset?: number;
  /** Default off. */
  loop?: boolean;
  /** Each loop starts a new fade-in; default on. */
  loopFadeIn?: boolean;
  /** Legacy loop behavior of 3l.5: L = Duration, no end interval, restart at T. */
  legacyLoop?: boolean;
  /**
   * Hold the last frame (not reference behavior; ignored with `loop`): no
   * fade-out at the end, and the values at the end stay until the queue is
   * stopped or another motion starts. A held motion that reached its end no
   * longer keeps the priority. Default off.
   */
  hold?: boolean;
  /**
   * With `hold`: whether eye blink may run while the motion stays at its end
   * (see {@link MotionQueue.blinkAllowed}). Default true; false keeps eye
   * blink off, as while a motion plays.
   */
  blinkWhileHeld?: boolean;
}

/** Why a motion ended: it played to its end, another start made it fade out, or the queue was stopped. */
export type MotionEndReason = "finished" | "replaced" | "stopped";

/**
 * A motion that ended: it left the queue, or (held) reached its end. `ticket`
 * is the number of its start (see {@link MotionQueue.lastTicket}).
 */
export interface MotionEnded {
  ticket: number;
  motion: Motion;
  reason: MotionEndReason;
}

interface Entry {
  ticket: number;
  motion: Motion;
  /** Started at the idle priority (1): its parameter writes follow the idle weights. */
  idle: boolean;
  hold: boolean;
  /** Held at its end (see {@link MotionStart.hold}). */
  holding: boolean;
  blinkWhileHeld: boolean;
  /** Its end has been recorded. */
  ended: boolean;
  fadeIn: number;
  fadeOut: number;
  weight: number;
  offset: number;
  loop: boolean;
  loopFadeIn: boolean;
  legacy: boolean;
  started: boolean;
  s: number;
  f: number;
  e: number | null;
  fadeOutRequested: boolean;
  tPrev: number;
  model: MotionCurve[];
  parameters: MotionCurve[];
  partOpacities: MotionCurve[];
  parameterIds: Set<string>;
}

/** IDs whose values a motion's `EyeBlink` and `LipSync` curves affect (3b.3, first 64 of each). */
export interface MotionGroups {
  eyeBlink: readonly string[];
  lipSync: readonly string[];
}

export class MotionQueue {
  /** The queue clock T. */
  time = 0;
  /** The current priority p_c (3l.4). */
  currentPriority = 0;
  /** The number of the latest accepted start (1, 2, …; 0 before any). */
  lastTicket = 0;
  /**
   * Idle weights (not reference behavior): for a parameter ID, how far
   * motions started at the idle priority (1) move it, in [0, 1]. A motion
   * that would move it by w of the way to its curve value moves it by w·k.
   * At 0 they leave it untouched. IDs not listed weigh 1, as without
   * weights. Other motions are not affected.
   */
  readonly idleWeights = new Map<string, number>();
  private entries: Entry[] = [];
  private ended: MotionEnded[] = [];
  private readonly blink: string[];
  private readonly lip: string[];
  private readonly blinkSet: Set<string>;
  private readonly lipSet: Set<string>;

  constructor(groups: MotionGroups) {
    this.blink = groups.eyeBlink.slice(0, 64);
    this.lip = groups.lipSync.slice(0, 64);
    this.blinkSet = new Set(this.blink);
    this.lipSet = new Set(this.lip);
  }

  get empty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * Whether eye blink may run in a frame that advanced the queue: the queue
   * still holds motions, every one of them is held at its end, and none was
   * started with `blinkWhileHeld` false. False when the queue is empty: the
   * frame in which the last motion ended keeps eye blink off (3j).
   */
  get blinkAllowed(): boolean {
    return this.entries.length > 0 && this.entries.every((e) => e.holding && e.blinkWhileHeld);
  }

  get size(): number {
    return this.entries.length;
  }

  /** Motions in the queue, oldest first. */
  get motions(): Motion[] {
    return this.entries.map((e) => e.motion);
  }

  /** Whether a start with this priority would be accepted (3l.4). */
  accepts(priority = 2): boolean {
    return priority === 3 || priority > this.currentPriority;
  }

  /**
   * Starts a motion (3l.4): accepted when the priority is 3 or above the
   * current one. `motion` null stands for a file that failed validation: the
   * start is then dropped. Returns whether the motion was enqueued.
   */
  start(motion: Motion | null, opts: MotionStart = {}): boolean {
    const priority = opts.priority ?? 2;
    if (!this.accepts(priority) || !motion) return false;
    this.currentPriority = priority;
    // 3l.2: every entry already queued is asked to fade out with its own F_out.
    for (const e of this.entries) e.fadeOutRequested = true;
    const pick = (o: number | undefined, file: number) => (o !== undefined && o >= 0 ? o : file);
    const curves = (t: string) => motion.curves.filter((c) => c.target === t);
    const parameters = curves("Parameter");
    this.entries.push({
      ticket: ++this.lastTicket,
      motion,
      idle: priority === 1,
      hold: (opts.hold ?? false) && !(opts.loop ?? false),
      holding: false,
      blinkWhileHeld: opts.blinkWhileHeld ?? true,
      ended: false,
      fadeIn: pick(opts.fadeIn, motion.fadeIn),
      fadeOut: pick(opts.fadeOut, motion.fadeOut),
      weight: opts.weight ?? 1,
      offset: opts.offset ?? 0,
      loop: opts.loop ?? false,
      loopFadeIn: opts.loopFadeIn ?? true,
      legacy: opts.legacyLoop ?? false,
      started: false,
      s: 0,
      f: 0,
      e: null,
      fadeOutRequested: false,
      tPrev: 0,
      model: curves("Model"),
      parameters,
      partOpacities: curves("PartOpacity"),
      parameterIds: new Set(parameters.map((c) => c.id)),
    });
    return true;
  }

  /**
   * The fade-out time of the motion started as `ticket`, once another start
   * has asked it to fade out; null while it plays on, or when it is gone.
   */
  fadeOutOf(ticket: number): number | null {
    const en = this.entries.find((e) => e.ticket === ticket);
    return en && en.fadeOutRequested && !en.ended ? en.fadeOut : null;
  }

  /** Empties the queue. */
  stopAll(): void {
    for (const en of this.entries) this.end(en, "stopped");
    this.entries = [];
  }

  /** The ends recorded since the last call, oldest first. */
  takeEnds(): MotionEnded[] {
    if (this.ended.length === 0) return [];
    const r = this.ended;
    this.ended = [];
    return r;
  }

  private end(en: Entry, reason: MotionEndReason): void {
    if (en.ended) return;
    en.ended = true;
    this.ended.push({ ticket: en.ticket, motion: en.motion, reason });
  }

  /** 3l.3: advances the queue by Δ, writing into `values`; returns the events fired. */
  advance(dt: number, values: AnimationValues): string[] {
    this.time += dt;
    const T = this.time;
    const events: string[] = [];
    const kept: Entry[] = [];
    for (const en of this.entries) {
      const m = en.motion;
      // a. Setup at the first processing.
      if (!en.started) {
        en.started = true;
        en.s = T - en.offset;
        en.f = T;
        en.e = en.loop || en.hold || m.duration <= 0 ? null : en.s + m.duration;
      }
      // b. Weights.
      const aIn = en.fadeIn === 0 ? 1 : ease((T - en.f) / en.fadeIn);
      const aOut = en.fadeOut === 0 || en.e === null ? 1 : ease((en.e - T) / en.fadeOut);
      const w = en.weight * aIn * aOut;
      // c. Local time.
      let tau = Math.max(0, T - en.s);
      let L: number;
      if (en.loop) {
        L = en.legacy ? m.duration : m.duration + 1 / m.fps;
        if (L > 0) while (tau > L) tau -= L;
      } else {
        L = m.duration;
        // A held motion stays at its last frame.
        if (en.hold && tau > L) tau = Math.max(0, L);
      }
      const endInterval = en.loop && !en.legacy ? L : undefined;
      const value = (c: MotionCurve) => evaluateCurve(c, tau, m.restricted, endInterval);
      // d. Model curves.
      let b: number | undefined;
      let l: number | undefined;
      for (const c of en.model) {
        if (c.id === "EyeBlink") b = value(c);
        else if (c.id === "LipSync") l = value(c);
        else if (c.id === "Opacity") values.modelOpacity = value(c);
      }
      // Idle weights apply to idle motions only; a missing weight is 1 (unchanged arithmetic).
      const weights = en.idle && this.idleWeights.size > 0 ? this.idleWeights : null;
      // e. Parameter curves.
      for (const c of en.parameters) {
        const k = weights?.get(c.id);
        if (k === 0) continue;
        const cur = values.get(c.id);
        let x = value(c);
        if (b !== undefined && this.blinkSet.has(c.id)) x = x * b;
        if (l !== undefined && this.lipSet.has(c.id)) x = x + l;
        if (values.wrap) {
          const i = values.index(c.id);
          if (i >= 0 && values.repeat[i]) x = wrapValue(x, values.min[i]!, values.max[i]!);
        }
        let w2 = w;
        if (c.fadeIn !== undefined || c.fadeOut !== undefined) {
          const bIn =
            c.fadeIn === undefined ? aIn : c.fadeIn === 0 ? 1 : ease((T - en.f) / c.fadeIn);
          const bOut =
            c.fadeOut === undefined
              ? aOut
              : c.fadeOut === 0 || en.e === null
                ? 1
                : ease((en.e - T) / c.fadeOut);
          w2 = en.weight * bIn * bOut;
        }
        values.set(c.id, cur + (x - cur) * (k === undefined ? w2 : w2 * k));
      }
      // f. Blink and lip-sync IDs without a curve.
      if (b !== undefined)
        for (const id of this.blink)
          if (!en.parameterIds.has(id)) {
            const k = weights?.get(id);
            if (k === 0) continue;
            const cur = values.get(id);
            values.set(id, cur + (b - cur) * (k === undefined ? w : w * k));
          }
      if (l !== undefined)
        for (const id of this.lip)
          if (!en.parameterIds.has(id)) {
            const k = weights?.get(id);
            if (k === 0) continue;
            const cur = values.get(id);
            values.set(id, cur + (l - cur) * (k === undefined ? w : w * k));
          }
      // g. PartOpacity curves: the value named by the ID, weight 1, no fading.
      for (const c of en.partOpacities) values.set(c.id, value(c));
      // h. End.
      let finished = false;
      if (T - en.s >= L) {
        if (en.loop) {
          const start = en.legacy ? T : T - tau;
          en.s = start;
          if (en.loopFadeIn) en.f = start;
        } else if (en.hold && !en.fadeOutRequested) {
          en.holding = true;
          this.end(en, "finished");
        } else {
          finished = true;
        }
      }
      if (en.e !== null && en.e < T) finished = true;
      // i. Events in (T_prev − s, T − s].
      for (const ev of m.events)
        if (en.tPrev - en.s < ev.time && ev.time <= T - en.s) events.push(ev.value);
      en.tPrev = T;
      // j. Remove, or schedule the requested fade-out.
      if (finished) {
        this.end(en, en.fadeOutRequested ? "replaced" : "finished");
        continue;
      }
      if (en.fadeOutRequested) {
        const end = T + en.fadeOut;
        if (!(en.e !== null && en.e <= end)) en.e = end;
      }
      kept.push(en);
    }
    this.entries = kept;
    // Held motions at their end keep no priority (without holds: an empty queue).
    if (kept.every((en) => en.holding)) this.currentPriority = 0;
    return events;
  }
}

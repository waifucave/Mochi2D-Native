/**
 * Eye blink (3p), breath (3q) and look (3r).
 */
import type { AnimationValues } from "./values.js";

/** Eye-blink timing (3p); the reference configuration by default. */
export interface EyeBlinkTiming {
  interval: number;
  closing: number;
  closed: number;
  opening: number;
}

export const REFERENCE_EYE_BLINK: EyeBlinkTiming = {
  interval: 4,
  closing: 0.1,
  closed: 0.05,
  opening: 0.15,
};

type BlinkState = "initial" | "waiting" | "closing" | "closed" | "opening";

/** 3p: a state machine on its own clock, which advances only on frames where it runs. */
export class EyeBlink {
  time = 0;
  state: BlinkState = "initial";
  private next = 0;
  private start = 0;

  constructor(
    private readonly ids: readonly string[],
    private readonly random: () => number,
    readonly timing: EyeBlinkTiming = REFERENCE_EYE_BLINK,
  ) {}

  frame(dt: number, values: AnimationValues): void {
    this.time += dt;
    const t = this.time;
    const tm = this.timing;
    let value = 1;
    switch (this.state) {
      case "initial":
        this.next = t + this.random() * (2 * tm.interval - 1);
        this.state = "waiting";
        value = 1;
        break;
      case "waiting":
        if (this.next < t) {
          this.start = t;
          this.state = "closing";
        }
        value = 1;
        break;
      case "closing": {
        let x = (t - this.start) / tm.closing;
        if (x >= 1) {
          x = 1;
          this.start = t;
          this.state = "closed";
        }
        value = 1 - x;
        break;
      }
      case "closed": {
        const x = (t - this.start) / tm.closed;
        if (x >= 1) {
          this.start = t;
          this.state = "opening";
        }
        value = 0;
        break;
      }
      case "opening": {
        let x = (t - this.start) / tm.opening;
        if (x >= 1) {
          x = 1;
          this.next = t + this.random() * (2 * tm.interval - 1);
          this.state = "waiting";
        }
        value = x;
        break;
      }
    }
    for (const id of this.ids) values.set(id, value);
  }
}

export interface BreathEntry {
  id: string;
  offset: number;
  peak: number;
  cycle: number;
  weight: number;
}

/** The reference breath configuration (3q). */
export const REFERENCE_BREATH: readonly BreathEntry[] = [
  { id: "ParamAngleX", offset: 0, peak: 15, cycle: 6.5345, weight: 0.5 },
  { id: "ParamAngleY", offset: 0, peak: 8, cycle: 3.5345, weight: 0.5 },
  { id: "ParamAngleZ", offset: 0, peak: 10, cycle: 5.5345, weight: 0.5 },
  { id: "ParamBodyAngleX", offset: 0, peak: 4, cycle: 15.5345, weight: 0.5 },
  { id: "ParamBreath", offset: 0.5, peak: 0.5, cycle: 3.2345, weight: 1 },
];

/** 3q: adds o + p·sin(φ/c) with weight w, φ = (t·2)·π. */
export class Breath {
  time = 0;

  constructor(readonly entries: readonly BreathEntry[] = REFERENCE_BREATH) {}

  frame(dt: number, values: AnimationValues): void {
    this.time += dt;
    const phi = this.time * 2 * Math.PI;
    for (const e of this.entries)
      values.add(e.id, e.offset + e.peak * Math.sin(phi / e.cycle), e.weight);
  }
}

export interface LookEntry {
  id: string;
  fx: number;
  fy: number;
  fxy: number;
}

/** The reference look configuration (3r.1). */
export const REFERENCE_LOOK: readonly LookEntry[] = [
  { id: "ParamAngleX", fx: 30, fy: 0, fxy: 0 },
  { id: "ParamAngleY", fx: 0, fy: 30, fxy: 0 },
  { id: "ParamAngleZ", fx: 0, fy: 0, fxy: -30 },
  { id: "ParamBodyAngleX", fx: 10, fy: 0, fxy: 0 },
  { id: "ParamEyeBallX", fx: 1, fy: 0, fxy: 0 },
  { id: "ParamEyeBallY", fx: 0, fy: 1, fxy: 0 },
];

/** 3r.1: a smoothed point following the target, mapped to parameters. */
export class Look {
  targetX = 0;
  targetY = 0;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  time = 0;
  private last = 0;

  constructor(public entries: readonly LookEntry[] = REFERENCE_LOOK) {}

  setTarget(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
  }

  frame(dt: number, values: AnimationValues): void {
    this.move(dt);
    for (const e of this.entries)
      values.add(e.id, e.fx * this.x + e.fy * this.y + e.fxy * this.x * this.y);
  }

  private move(dt: number): void {
    this.time += dt;
    if (this.last === 0) {
      this.last = this.time;
      return;
    }
    const kappa = (this.time - this.last) * 30;
    this.last = this.time;
    const V = 4 / 30;
    const A = (kappa * V) / 4.5;
    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    if (Math.abs(dx) <= 0.01 && Math.abs(dy) <= 0.01) return;
    const D = Math.sqrt(dx * dx + dy * dy);
    let ax = (V * dx) / D - this.vx;
    let ay = (V * dy) / D - this.vy;
    const al = Math.sqrt(ax * ax + ay * ay);
    if (al > A) {
      ax *= A / al;
      ay *= A / al;
    }
    this.vx += ax;
    this.vy += ay;
    const B = 0.5 * (Math.sqrt(A * A + 16 * A * D - 8 * A * D) - A);
    const vl = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (vl > B) {
      this.vx *= B / vl;
      this.vy *= B / vl;
    }
    this.x += this.vx;
    this.y += this.vy;
  }
}

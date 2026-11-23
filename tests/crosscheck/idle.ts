/**
 * Idle-weight vectors (Mochi2D's idle weights, since 0.7.0, which the scenario
 * formats do not carry): the reference's own MotionQueue and
 * AnimationValues, driven frame by frame as the animator drives them
 * (restore, advance, save), with motions started at priorities 1, 2 and 3,
 * idle weights set, changed and reset between frames the way the runtime's
 * setIdleWeight sets them, and base values written. Every frame's values and
 * base values are recorded as float32 bits; mochi2d_check_idle replays the
 * cases with Mochi2D Native's queue and compares.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MotionQueue, type MotionStart } from "../../reference/mochi2d-0.24.1/src/anim/motion-queue.js";
import { AnimationValues } from "../../reference/mochi2d-0.24.1/src/anim/values.js";
import { parseMotion, type Motion } from "../../reference/mochi2d-0.24.1/src/anim/motion.js";
import type { MocModel } from "../../reference/mochi2d-0.24.1/src/core/moc/model.js";

function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Op =
  | ["start", number, MotionStart]
  | ["weight", string, number]
  | ["reset"]
  | ["base", number, number]
  | ["stop"];

export interface IdleCase {
  model: string;
  motions: string[];
  blink: string[];
  lip: string[];
  wrap: boolean;
  steps: { dt: number; ops: Op[] }[];
  /** Per step: the parameter values and the base values, as float32 bits. */
  values: number[][];
  saved: number[][];
  opacity: number[];
}

const bits = (a: Float32Array) => Array.from(new Uint32Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)));

/** The runtime's setIdleWeight on a queue (an unknown ID is refused there; these IDs are the model's). */
function setIdleWeight(q: MotionQueue, id: string, weight: number): void {
  const w = Math.min(1, Math.max(0, weight));
  if (w === 1) q.idleWeights.delete(id);
  else q.idleWeights.set(id, w);
}

export function idleVectors(name: string, dir: string, model: MocModel, seed: number, count: number): IdleCase[] {
  const rnd = lcg(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const ids = [...model.parameters.ids];
  if (ids.length === 0) return [];
  const files: string[] = [];
  const motions: Motion[] = [];
  for (let k = 0; k < 8; k++) {
    const file = `motions/m${k}.motion3.json`;
    try {
      motions.push(parseMotion(readFileSync(join(dir, file)), file));
      files.push(`${name}/${file}`);
    } catch {
      // Only motions that parse are started.
    }
  }
  if (motions.length === 0) return [];
  const cases: IdleCase[] = [];
  for (let c = 0; c < count; c++) {
    const subset = (p: number) => ids.filter(() => rnd() < p);
    const blink = [...subset(0.25), ...(rnd() < 0.5 ? ["FreeBlink"] : [])];
    const lip = [...subset(0.25), ...(rnd() < 0.5 ? ["FreeLip"] : [])];
    const values = new AnimationValues(model);
    values.wrap = rnd() < 0.3;
    const q = new MotionQueue({ eyeBlink: blink, lipSync: lip });
    const kase: IdleCase = {
      model: `${name}/${name}.moc3`,
      motions: files,
      blink,
      lip,
      wrap: values.wrap,
      steps: [],
      values: [],
      saved: [],
      opacity: [],
    };
    const frames = 60 + Math.floor(rnd() * 120);
    for (let f = 0; f < frames; f++) {
      const ops: Op[] = [];
      const r = rnd();
      if (f === 0 || r < 0.06 || (q.size === 0 && r < 0.3)) {
        const opts: MotionStart = { priority: pick([1, 1, 1, 2, 3]) };
        if (rnd() < 0.4) opts.fadeIn = pick([0, 0.2, 0.5, -1, rnd()]);
        if (rnd() < 0.4) opts.fadeOut = pick([0, 0.2, 0.5, rnd()]);
        if (rnd() < 0.3) opts.weight = rnd();
        if (rnd() < 0.4) opts.loop = true;
        if (rnd() < 0.2) opts.hold = true;
        if (rnd() < 0.2) opts.offset = rnd() * 2;
        ops.push(["start", Math.floor(rnd() * motions.length), opts]);
      }
      const n = rnd() < 0.15 ? 1 + Math.floor(rnd() * 4) : 0;
      for (let k = 0; k < n; k++)
        ops.push(["weight", pick(ids), pick([0, 0, 1, 0.5, 0.25, 1.5, -0.5, rnd(), rnd(), Math.fround(rnd())])]);
      if (rnd() < 0.01) ops.push(["reset"]);
      if (rnd() < 0.05) ops.push(["base", Math.floor(rnd() * ids.length), -2 + 4 * rnd()]);
      if (rnd() < 0.01) ops.push(["stop"]);
      const dt = pick([1 / 60, 1 / 60, 1 / 30, 0.1, 0, 0.5]);
      for (const op of ops) {
        if (op[0] === "start") q.start(motions[op[1]]!, op[2]);
        else if (op[0] === "weight") setIdleWeight(q, op[1], op[2]);
        else if (op[0] === "reset") q.idleWeights.clear();
        else if (op[0] === "base") {
          values.setAt(op[1], op[2]);
          values.saved[op[1]] = values.values[op[1]]!;
        } else q.stopAll();
      }
      // The animator's frame for the motion part (3j steps 1–3).
      values.restore();
      q.advance(dt, values);
      values.save();
      kase.steps.push({ dt, ops });
      kase.values.push(bits(values.values));
      kase.saved.push(bits(values.saved));
      kase.opacity.push(values.modelOpacity);
    }
    cases.push(kase);
  }
  return cases;
}

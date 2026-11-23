/**
 * Live lip-sync vectors: the reference's LiveLipSync (src/anim/live-lip-sync.ts)
 * fed with generated sample blocks (sine, noise, square, silence, with NaN
 * and ∞ samples now and then), bare sums, gaps, backlogs, settings and rate
 * changes and resets, one frame step after another (odd ones included).
 * Blocks are described, not stored: mochi2d_check_live makes the same float32
 * samples (integer noise, and sines through the vendored fdlibm, which equals
 * V8's Math.sin bit for bit) and compares every frame's value and level.
 */
import {
  LIVE_LIP_SYNC_DEFAULTS,
  LIVE_LIP_SYNC_NEUTRAL,
  LiveLipSync,
  type LiveLipSyncSettings,
} from "../../reference/mochi2d-0.24.1/src/anim/live-lip-sync.js";

function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Num = number | "NaN" | "Infinity" | "-Infinity";
const num = (x: number): Num =>
  Number.isNaN(x) ? "NaN" : x === Infinity ? "Infinity" : x === -Infinity ? "-Infinity" : x;

/** A block of samples, made the same way on both sides. */
export interface Block {
  /** "sine", "noise", "square" or "silence". */
  kind: string;
  /** Amplitude, frequency (sine) and seed (noise), first sample index. */
  a: number;
  f: number;
  seed: number;
  start: number;
  /** Frames and channels; `bad` puts NaN (1) or ∞ (2) at frame `at`. */
  n: number;
  channels: number;
  interleaved: boolean;
  bad: number;
  at: number;
}

/** The samples of a block, one Float32Array per channel. */
export function blockSamples(b: Block, rate: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < b.channels; c++) {
    const ch = new Float32Array(b.n);
    let s = (b.seed + 977 * c) >>> 0;
    for (let i = 0; i < b.n; i++) {
      let v = 0;
      if (b.kind === "sine") v = b.a * Math.sin((2 * Math.PI * b.f * (b.start + i)) / rate + c);
      else if (b.kind === "noise") {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        v = b.a * (s / 2147483648 - 1);
      } else if (b.kind === "square") v = (b.start + i) & 1 ? -b.a : b.a;
      ch[i] = v;
    }
    if (b.bad && b.at < b.n) ch[b.at] = b.bad === 1 ? NaN : Infinity;
    out.push(ch);
  }
  return out;
}

type Op =
  | ["push", Block]
  | ["sums", Num, Num, Num]
  | ["settings", [Num, Num, Num, Num]]
  | ["rate", number]
  | ["reset"]
  | ["next", Num];

export interface LiveCase {
  rate: number;
  window: number;
  settings: [Num, Num, Num, Num];
  ops: Op[];
  /** Per next: [value, level]. */
  out: [Num, Num][];
}

const pick = <T>(rnd: () => number, a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;

export function liveVectors(seed: number, count: number): LiveCase[] {
  const rnd = lcg(seed);
  const cases: LiveCase[] = [];
  const randomSettings = (): LiveLipSyncSettings => ({
    gain: pick(rnd, [0, 1, 12, 30, 2.5, -1, Infinity, NaN]),
    gate: pick(rnd, [-Infinity, -60, -45, -30, -20, 0, NaN]),
    attack: pick(rnd, [0, 0.01, 0.03, 0.12, 1, -1, NaN]),
    release: pick(rnd, [0, 0.05, 0.12, 0.3, 2, -1, NaN]),
  });
  for (let k = 0; k < count; k++) {
    const rate = pick(rnd, [44100, 48000, 16000, 8000, 22050]);
    const window = pick(rnd, [0.25, 0.25, 0.05, 1]);
    const settings = k % 4 === 0 ? { ...LIVE_LIP_SYNC_NEUTRAL } : k % 4 === 1 ? { ...LIVE_LIP_SYNC_DEFAULTS } : randomSettings();
    const live = new LiveLipSync(rate, settings, window);
    const s4 = (s: LiveLipSyncSettings): [Num, Num, Num, Num] => [num(s.gain), num(s.gate), num(s.attack), num(s.release)];
    const c: LiveCase = { rate, window, settings: s4(settings), ops: [], out: [] };
    let clock = 0;
    let currentRate = rate;
    const frames = 120 + Math.floor(rnd() * 120);
    for (let f = 0; f < frames; f++) {
      const r = rnd();
      // Blocks before the frame: none (a gap), one or several.
      const blocks = r < 0.15 ? 0 : r < 0.75 ? 1 : 1 + Math.floor(rnd() * 3);
      const silentStretch = f % 50 > 40;
      for (let b = 0; b < (silentStretch ? 0 : blocks); b++) {
        const kind = pick(rnd, ["sine", "sine", "noise", "square", "silence"]);
        const block: Block = {
          kind,
          a: pick(rnd, [0.001, 0.01, 0.05, 0.2, 0.5, 1, 0.0056]),
          f: pick(rnd, [110, 220, 440.5, 1000]),
          seed: Math.floor(rnd() * 2 ** 31),
          start: clock,
          n: pick(rnd, [64, 128, 256, 480, 735, 1024, 4096, 1]),
          channels: pick(rnd, [1, 1, 2, 3]),
          interleaved: rnd() < 0.3,
          bad: rnd() < 0.02 ? 1 : rnd() < 0.02 ? 2 : 0,
          at: Math.floor(rnd() * 64),
        };
        clock += block.n;
        live.push(blockSamples(block, currentRate));
        c.ops.push(["push", block]);
      }
      if (rnd() < 0.04) {
        const sum = pick(rnd, [0, 1.5, 100, -1, NaN, Infinity, 1e-9]);
        const values = pick(rnd, [0, 256, 512, -2, NaN]);
        const frames2 = pick(rnd, [0, 256, 128, NaN, 1e9]);
        live.pushSums(sum, values, frames2);
        c.ops.push(["sums", num(sum), num(values), num(frames2)]);
      }
      if (rnd() < 0.02) {
        const s = randomSettings();
        Object.assign(live.settings, s);
        c.ops.push(["settings", s4(s)]);
      }
      if (rnd() < 0.01) {
        currentRate = pick(rnd, [44100, 48000, 16000]);
        live.sampleRate = currentRate;
        c.ops.push(["rate", currentRate]);
      }
      if (rnd() < 0.01) {
        live.reset();
        c.ops.push(["reset"]);
      }
      const dt = pick(rnd, [1 / 60, 1 / 60, 1 / 30, 1 / 144, 0.0213, 0, 0.5, -0.1]);
      const value = live.next(dt);
      c.ops.push(["next", num(dt)]);
      c.out.push([num(value), num(live.level)]);
    }
    cases.push(c);
  }
  return cases;
}

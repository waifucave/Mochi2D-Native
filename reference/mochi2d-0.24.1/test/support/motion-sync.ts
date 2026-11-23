/**
 * Crafted motion-sync inputs, generated at test time: settings files for
 * DeepSeek-chan's mouth (ds-basic, ds-rich, ds-two and a model settings file
 * that links them), and synthetic WAV clips (silence, noise, a tone, vowels
 * of a male and a female voice, glides, bursts, stereo mixes).
 */
import {
  VOWEL_FORMANTS,
  synthesizeVoice,
  synthesizeVowel,
} from "../../src/anim/motion-sync/voice-synth.js";

export type Vowel = "A" | "I" | "U" | "E" | "O";
export const VOWELS: readonly Vowel[] = ["A", "I", "U", "E", "O"];
export const ELEMENTS = ["Silence", "A", "I", "U", "E", "O"] as const;

// ---------------------------------------------------------------- files

export interface ParamSpec {
  id: string;
  min?: number;
  max?: number;
  damper?: number;
  smooth?: number;
}

export interface SettingSpec {
  id: string;
  name: string;
  params: ParamSpec[];
  /** Per element (Silence, A, I, U, E, O), the value of each driven parameter. */
  shapes: Record<(typeof ELEMENTS)[number], number[]>;
  blendRatio: number;
  smoothing: number;
  sampleRate: number;
}

/** The ranges of DeepSeek-chan's mouth parameters. */
const RANGES: Record<string, [number, number]> = {
  ParamMouthOpenY: [0, 1],
  ParamMouthForm: [-1, 1],
  MouthFunnel: [0, 1],
  Mouthpucker: [0, 1],
  MouthPuckerWiden: [-1, 1],
  ParamA: [0, 1],
};

/** Opening and form: Silence closed, A open, I and E smiling, U and O frowning. */
export const BASIC: SettingSpec = {
  id: "MS_Basic",
  name: "Mouth basic",
  params: [
    { id: "ParamMouthOpenY", damper: 0, smooth: 25 },
    { id: "ParamMouthForm", damper: 0, smooth: 25 },
  ],
  shapes: {
    Silence: [0, 0],
    A: [1, 0],
    I: [0.35, 1],
    U: [0.3, -1],
    E: [0.6, 0.6],
    O: [0.8, -0.6],
  },
  blendRatio: 0.5,
  smoothing: 60,
  sampleRate: 60,
};

/** Five mouth parameters: U and O round with funnel and pucker, I and E widen. */
export const RICH: SettingSpec = {
  id: "MS_Rich",
  name: "Mouth rich",
  params: [
    { id: "ParamMouthOpenY", damper: 0.01, smooth: 20 },
    { id: "ParamMouthForm", damper: 0.02, smooth: 20 },
    { id: "MouthFunnel", damper: 0.02, smooth: 30 },
    { id: "Mouthpucker", damper: 0.02, smooth: 30 },
    { id: "MouthPuckerWiden", damper: 0.02, smooth: 30 },
  ],
  shapes: {
    Silence: [0, 0, 0, 0, 0],
    A: [1, 0.1, 0, 0, 0.2],
    I: [0.3, 0.7, 0, 0, 1],
    U: [0.25, -0.3, 0.7, 1, 0],
    E: [0.55, 0.4, 0, 0, 0.6],
    O: [0.75, -0.2, 1, 0.4, 0],
  },
  blendRatio: 0.3,
  smoothing: 40,
  sampleRate: 30,
};

type JsonObject = Record<string, unknown>;

/** One setting as the file holds it. */
export function settingJson(spec: SettingSpec): JsonObject {
  return {
    Id: spec.id,
    AnalysisType: "CRI",
    UseCase: "Mouth",
    CubismParameters: spec.params.map((p) => {
      const [lo, hi] = RANGES[p.id] ?? [0, 1];
      return {
        Name: p.id,
        Id: p.id,
        Min: p.min ?? lo,
        Max: p.max ?? hi,
        Damper: p.damper ?? 0,
        Smooth: p.smooth ?? 25,
      };
    }),
    AudioParameters: ELEMENTS.map((e) => ({
      Name: e,
      Id: e,
      Min: 0,
      Max: 1,
      Scale: 1,
      Enabled: true,
    })),
    Mappings: ELEMENTS.map((e) => ({
      Type: "Shape",
      Id: e,
      Targets: spec.params.map((p, k) => ({ Id: p.id, Value: spec.shapes[e][k]! })),
    })),
    PostProcessing: {
      BlendRatio: spec.blendRatio,
      Smoothing: spec.smoothing,
      SampleRate: spec.sampleRate,
    },
  };
}

/** A whole file with these settings. */
export function motionSyncJson(...specs: SettingSpec[]): JsonObject {
  return {
    Version: 1,
    Meta: {
      SettingCount: specs.length,
      Dictionary: specs.map((s) => ({ Id: s.id, Name: s.name })),
    },
    Settings: specs.map(settingJson),
  };
}

export const dsBasic = () => motionSyncJson(BASIC);
export const dsRich = () => motionSyncJson(RICH);
export const dsTwo = () => motionSyncJson(BASIC, RICH);

/** A deep copy of `json` changed by `edit`. */
export function edited(json: JsonObject, edit: (j: any) => void): JsonObject {
  const copy = JSON.parse(JSON.stringify(json)) as JsonObject;
  edit(copy);
  return copy;
}

/** The clips the crafted model settings name, under sounds/. */
export const TALK_SOUNDS = {
  male: "sounds/vowels-male-16k.wav",
  female: "sounds/vowels-female-48k.wav",
  noise: "sounds/noise-white-44k.wav",
  silence: "sounds/silence-44k.wav",
};

/**
 * DeepSeek-chan's own model settings plus the motion-sync file (ds-two) and
 * a group "Talk": IDLE with male vowels linked by name, 脱捕 with female
 * vowels linked to the rich setting, IDLE again with noise linked by setting
 * ID, and a motion with silence and no link.
 */
export function dsMotionSyncSettings(own: JsonObject): JsonObject {
  const s = JSON.parse(JSON.stringify(own)) as { FileReferences: JsonObject };
  s.FileReferences.MotionSync = "ds-two.motionsync3.json";
  s.FileReferences.Motions = {
    Talk: [
      { File: "Animation/IDLE.motion3.json", Sound: TALK_SOUNDS.male, MotionSync: "Mouth basic" },
      { File: "Animation/脱捕.motion3.json", Sound: TALK_SOUNDS.female, MotionSync: "Mouth rich" },
      { File: "Animation/IDLE.motion3.json", Sound: TALK_SOUNDS.noise, MotionSync: "MS_Basic" },
      { File: "Animation/举手切默认手.motion3.json", Sound: TALK_SOUNDS.silence },
    ],
  };
  return s;
}

// ---------------------------------------------------------------- audio

/** A seeded generator of numbers in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const db = (level: number) => 10 ** (level / 20);

export function rmsDb(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return 10 * Math.log10(s / Math.max(1, to - from));
}

/** Scales `x` to an RMS of `level` dBFS. */
export function toLevel(x: Float32Array, level: number): Float32Array {
  const g = db(level) / db(rmsDb(x));
  return Float32Array.from(x, (v) => v * g);
}

export const silence = (seconds: number, rate: number) =>
  new Float32Array(Math.round(seconds * rate));

/** White noise (uniform), scaled to `level` dBFS RMS. */
export function whiteNoise(seconds: number, rate: number, level: number, seed = 1): Float32Array {
  const r = seeded(seed);
  return toLevel(
    Float32Array.from({ length: Math.round(seconds * rate) }, () => 2 * r() - 1),
    level,
  );
}

/** Pink noise (white noise through a three-pole 1/f approximation), at `level` dBFS. */
export function pinkNoise(seconds: number, rate: number, level: number, seed = 2): Float32Array {
  const r = seeded(seed);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  const x = Float32Array.from({ length: Math.round(seconds * rate) }, () => {
    const w = 2 * r() - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    return b0 + b1 + b2 + w * 0.1848;
  });
  return toLevel(x, level);
}

/** A sine at `hz`, at `level` dBFS RMS. */
export const tone = (hz: number, seconds: number, rate: number, level: number) =>
  Float32Array.from(
    { length: Math.round(seconds * rate) },
    (_, i) => Math.SQRT2 * db(level) * Math.sin((2 * Math.PI * hz * i) / rate),
  );

export interface VoiceSpec {
  f0: number;
  formantScale: number;
}
export const MALE: VoiceSpec = { f0: 120, formantScale: 1 };
export const FEMALE: VoiceSpec = { f0: 220, formantScale: 1.15 };

export function concat(...parts: ArrayLike<number>[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p as ArrayLike<number>, o);
    o += p.length;
  }
  return out;
}

/** Where each vowel of {@link vowelClip} lies, seconds. */
export interface Segment {
  vowel: Vowel;
  start: number;
  end: number;
}

/**
 * Each vowel held `hold` seconds (20 ms fades), with `gap` seconds of
 * silence before each and after the last, each vowel at `level` dBFS RMS.
 */
export function vowelClip(
  voice: VoiceSpec,
  rate: number,
  options: { level?: number; hold?: number; gap?: number; vowels?: readonly Vowel[] } = {},
): { samples: Float32Array; segments: Segment[] } {
  const hold = options.hold ?? 1;
  const gap = options.gap ?? 0.3;
  const parts: Float32Array[] = [];
  const segments: Segment[] = [];
  let t = 0;
  for (const v of options.vowels ?? VOWELS) {
    parts.push(silence(gap, rate));
    t += gap;
    const s = synthesizeVowel(VOWEL_FORMANTS[v], hold, rate, {
      f0: voice.f0,
      formantScale: voice.formantScale,
      level: options.level ?? -18,
    });
    parts.push(s);
    segments.push({ vowel: v, start: t, end: t + s.length / rate });
    t += s.length / rate;
  }
  parts.push(silence(gap, rate));
  return { samples: concat(...parts), segments };
}

/** A→I→U→E→O→A: each held `hold` s, with linear formant transitions of `glide` s. */
export function glideClip(
  voice: VoiceSpec,
  seconds: number,
  rate: number,
  options: { hold?: number; glide?: number; level?: number } = {},
): Float32Array {
  const order: Vowel[] = ["A", "I", "U", "E", "O"];
  const hold = options.hold ?? 0.4;
  const glide = options.glide ?? 0.3;
  const period = order.length * (hold + glide);
  return synthesizeVoice(
    (time) => {
      const t = time % period;
      const i = Math.floor(t / (hold + glide));
      const u = t - i * (hold + glide);
      const a = VOWEL_FORMANTS[order[i]!];
      const b = VOWEL_FORMANTS[order[(i + 1) % order.length]!];
      const w = u <= hold ? 0 : (u - hold) / glide;
      return a.map((f, k) => f + (b[k]! - f) * w);
    },
    seconds,
    rate,
    { f0: voice.f0, formantScale: voice.formantScale, level: options.level ?? -18 },
  );
}

/** `count` times: `on` seconds of A, then `off` seconds of silence. */
export function burstClip(rate: number, count = 20, on = 0.1, off = 0.1): Float32Array {
  const a = synthesizeVowel(VOWEL_FORMANTS.A, on, rate, { f0: MALE.f0, fade: 0.005 });
  const parts: Float32Array[] = [];
  for (let i = 0; i < count; i++) parts.push(a, silence(off, rate));
  return concat(...parts);
}

/**
 * A look-ahead peak limiter: each sample's gain keeps the largest peak within
 * ±`window` seconds at `peak` dBFS (no waveshaping, so no new harmonics
 * beyond the gain's own changes).
 */
export function limit(x: Float32Array, peak: number, rate: number, window = 0.005): Float32Array {
  const p = db(peak);
  const W = Math.max(1, Math.round(window * rate));
  // Sliding maximum of |x| over [i − W, i + W] with a monotonic queue.
  const out = new Float32Array(x.length);
  const queue: number[] = [];
  let head = 0;
  let next = 0;
  for (let i = 0; i < x.length; i++) {
    for (; next < x.length && next <= i + W; next++) {
      while (queue.length > head && Math.abs(x[queue[queue.length - 1]!]!) <= Math.abs(x[next]!))
        queue.pop();
      queue.push(next);
    }
    while (queue[head]! < i - W) head++;
    const m = Math.abs(x[queue[head]!]!);
    out[i] = m > p ? (x[i]! * p) / m : x[i]!;
  }
  return out;
}

/** `x` with `gain` dB, hard-clipped at full scale. */
export const clipped = (x: Float32Array, gain: number) =>
  Float32Array.from(x, (v) => Math.max(-1, Math.min(1, v * db(gain))));

// ---------------------------------------------------------------- WAV

export type WavEncoding = "pcm8" | "pcm16" | "pcm24" | "pcm32" | "float32" | "float64";

/** A WAV file of `channels` (equal lengths, samples in [−1, 1]) at `rate`. */
export function wavFile(
  channels: readonly ArrayLike<number>[],
  rate: number,
  encoding: WavEncoding = "pcm16",
  options: { extensible?: boolean } = {},
): Uint8Array {
  const bits = { pcm8: 8, pcm16: 16, pcm24: 24, pcm32: 32, float32: 32, float64: 64 }[encoding];
  const float = encoding.startsWith("float");
  const C = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytesPer = bits / 8;
  const data = frames * C * bytesPer;
  const ext = options.extensible ?? false;
  const fmtSize = ext ? 40 : 16;
  const b = new Uint8Array(12 + 8 + fmtSize + 8 + data + (data & 1));
  const dv = new DataView(b.buffer);
  const text = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  dv.setUint32(4, b.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  dv.setUint32(16, fmtSize, true);
  const code = float ? 3 : 1;
  dv.setUint16(20, ext ? 0xfffe : code, true);
  dv.setUint16(22, C, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * C * bytesPer, true);
  dv.setUint16(32, C * bytesPer, true);
  dv.setUint16(34, bits, true);
  if (ext) {
    dv.setUint16(36, 22, true);
    dv.setUint16(38, bits, true);
    dv.setUint32(40, 0, true);
    // The sub-format GUID: the format code, then the standard suffix.
    dv.setUint16(44, code, true);
    const suffix = [
      0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
    ];
    suffix.forEach((v, i) => (b[46 + i] = v));
  }
  const d = 12 + 8 + fmtSize;
  text(d, "data");
  dv.setUint32(d + 4, data, true);
  let o = d + 8;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < C; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i]!));
      if (encoding === "pcm8") b[o] = Math.round(v * 127) + 128;
      else if (encoding === "pcm16") dv.setInt16(o, Math.round(v * 32767), true);
      else if (encoding === "pcm24") {
        const n = Math.round(v * 8388607);
        b[o] = n & 0xff;
        b[o + 1] = (n >> 8) & 0xff;
        b[o + 2] = (n >> 16) & 0xff;
      } else if (encoding === "pcm32") dv.setInt32(o, Math.round(v * 2147483647), true);
      else if (encoding === "float32") dv.setFloat32(o, channels[c]![i]!, true);
      else dv.setFloat64(o, channels[c]![i]!, true);
      o += bytesPer;
    }
  return b;
}

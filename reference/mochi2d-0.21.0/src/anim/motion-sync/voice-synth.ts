/**
 * A small formant synthesizer for vowels: a glottal pulse train with a slow
 * vibrato through three resonators in cascade, one per formant (classical
 * cascade formant synthesis). Mochi2D builds its default vowel templates
 * from a neutral synthetic voice with it, and the tests synthesize their
 * male and female vowels, and glides between vowels, the same way.
 */

/** Typical formants of an adult male voice, F1, F2, F3 in Hz. */
export const VOWEL_FORMANTS: Readonly<Record<"A" | "I" | "U" | "E" | "O", readonly number[]>> = {
  A: [750, 1200, 2600],
  I: [300, 2300, 3000],
  U: [350, 1350, 2400],
  E: [480, 1900, 2600],
  O: [480, 850, 2600],
};

/** Formant bandwidths, Hz. */
const BANDWIDTHS = [60, 90, 120];

export interface VoiceOptions {
  /** Fundamental frequency, Hz. Default 120. */
  f0?: number;
  /** Multiplies every formant (about 1.15 for a female voice). Default 1. */
  formantScale?: number;
  /** Vibrato depth (±fraction of f0) and rate (Hz). Default 0.03 and 0.8. */
  vibrato?: number;
  vibratoRate?: number;
  /** RMS level of the result, dBFS. Default −18. */
  level?: number;
  /** Fade-in and fade-out, seconds. Default 0.02. */
  fade?: number;
}

/**
 * `seconds` of voice at `rate` Hz whose formants (F1, F2, F3, Hz) at time t
 * are `formantsAt(t)`, faded in and out, scaled to `level` dBFS RMS. Each
 * resonator is y[n] = a·x[n] + b·y[n−1] + c·y[n−2] with unity gain at 0 Hz,
 * its coefficients following the formant sample by sample.
 */
export function synthesizeVoice(
  formantsAt: (t: number) => readonly number[],
  seconds: number,
  rate: number,
  options: VoiceOptions = {},
): Float32Array {
  const n = Math.max(0, Math.round(seconds * rate));
  const f0 = options.f0 ?? 120;
  const depth = options.vibrato ?? 0.03;
  const vrate = options.vibratoRate ?? 0.8;
  const scale = options.formantScale ?? 1;
  // Glottal source: one pulse per period, a −12 dB/octave tilt from two
  // leaky integrators with their corner at 77 Hz, whatever the rate.
  const leak = Math.exp((-2 * Math.PI * 77) / rate);
  const y = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += (f0 * (1 + depth * Math.sin((2 * Math.PI * vrate * i) / rate))) / rate;
    if (phase >= 1) {
      phase -= 1;
      y[i] = 1;
    }
  }
  let s1 = 0;
  let s2 = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    s1 = leak * s1 + y[i]!;
    s2 = leak * s2 + s1;
    y[i] = s2;
    mean += s2;
  }
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i++) y[i] = y[i]! - mean;
  // The resonators in cascade, F1 first.
  const state = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const formants = formantsAt(i / rate);
    let x = y[i]!;
    for (let k = 0; k < formants.length; k++) {
      const f = formants[k]! * scale;
      if (!(f < rate / 2)) continue;
      const bw = BANDWIDTHS[k] ?? 120;
      const c = -Math.exp((-2 * Math.PI * bw) / rate);
      const b = 2 * Math.exp((-Math.PI * bw) / rate) * Math.cos((2 * Math.PI * f) / rate);
      const v = (1 - b - c) * x + b * state[2 * k]! + c * state[2 * k + 1]!;
      state[2 * k + 1] = state[2 * k]!;
      state[2 * k] = v;
      x = v;
    }
    y[i] = x;
  }
  // Fades and level.
  const fade = Math.min(Math.round((options.fade ?? 0.02) * rate), Math.floor(n / 2));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    y[i] = y[i]! * g;
    y[n - 1 - i] = y[n - 1 - i]! * g;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += y[i]! * y[i]!;
  const rms = Math.sqrt(sum / Math.max(1, n));
  const target = 10 ** ((options.level ?? -18) / 20);
  const g = rms > 0 ? target / rms : 0;
  return Float32Array.from(y, (v) => v * g);
}

/** `seconds` of the vowel with formants `formants` (F1, F2, F3); see {@link synthesizeVoice}. */
export function synthesizeVowel(
  formants: readonly number[],
  seconds: number,
  rate: number,
  options: VoiceOptions = {},
): Float32Array {
  return synthesizeVoice(() => formants, seconds, rate, options);
}

/**
 * Loudness measurement on raw audio samples (pure TypeScript, no WebAudio).
 * Values are linear amplitudes for samples in [-1, 1]; a full-scale sine has
 * RMS 1/√2. How loudness drives model parameters is defined elsewhere.
 */

/** Root mean square of `samples[start, end)`; 0 for an empty range. */
export function rms(samples: ArrayLike<number>, start = 0, end = samples.length): number {
  const s = Math.max(0, start);
  const e = Math.min(samples.length, end);
  if (e <= s) return 0;
  let sum = 0;
  for (let i = s; i < e; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / (e - s));
}

/** Largest absolute sample value in `samples[start, end)`. */
export function peakAbs(samples: ArrayLike<number>, start = 0, end = samples.length): number {
  let p = 0;
  for (let i = Math.max(0, start); i < Math.min(samples.length, end); i++) {
    const a = Math.abs(samples[i]!);
    if (a > p) p = a;
  }
  return p;
}

/** Linear amplitude to decibels relative to full scale, floored at `floorDb`. */
export function toDecibels(amplitude: number, floorDb = -100): number {
  return amplitude > 0 ? Math.max(floorDb, 20 * Math.log10(amplitude)) : floorDb;
}

/** Averages channels into one. */
export function mixDown(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i]! += c[i]! / channels.length;
  return out;
}

/**
 * One-pole envelope follower with separate attack and release time constants
 * (seconds). Frame-rate independent: pass the elapsed time with each value.
 */
export class EnvelopeFollower {
  value = 0;
  constructor(
    public attackSeconds = 0.01,
    public releaseSeconds = 0.15,
  ) {}

  process(input: number, dt: number): number {
    const tau = input > this.value ? this.attackSeconds : this.releaseSeconds;
    const k = tau > 0 && dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
    this.value += (input - this.value) * k;
    return this.value;
  }

  reset(value = 0): void {
    this.value = value;
  }
}

/**
 * Per-frame RMS of a whole signal: value `i` is the RMS of the window of
 * `windowSeconds` that ends at time `i / frameRate` (the most recent audio at
 * that frame, like a live analyser). Frames before the window is full use the
 * samples available so far; frame 0 is 0.
 */
export function rmsEnvelope(
  samples: Float32Array,
  sampleRate: number,
  frameRate: number,
  windowSeconds = 1 / frameRate,
): Float32Array {
  if (!(sampleRate > 0) || !(frameRate > 0))
    throw new RangeError("sampleRate and frameRate must be positive");
  const frames = Math.floor((samples.length / sampleRate) * frameRate) + 1;
  const win = Math.max(1, Math.round(windowSeconds * sampleRate));
  // Prefix sums of squares make each window O(1).
  const prefix = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i++) prefix[i + 1] = prefix[i]! + samples[i]! * samples[i]!;
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const end = Math.min(samples.length, Math.round((f / frameRate) * sampleRate));
    const start = Math.max(0, end - win);
    out[f] =
      end > start ? Math.sqrt(Math.max(0, prefix[end]! - prefix[start]!) / (end - start)) : 0;
  }
  return out;
}

/**
 * Mochi2D's own audio analysis for motion sync, built on classical speech
 * methods:
 *
 * - **Signal path.** Mono, resampled to 16 kHz. Each analysis takes a
 *   512-sample window (32 ms), removes its mean (DC), and measures its RMS
 *   level in dBFS (a full-scale sine is −3 dBFS). For the spectrum it is
 *   pre-emphasized (x[n] − 0.97·x[n − 1]) and Hann-windowed.
 * - **Band energy.** The shares of the spectrum's energy in an F1 region
 *   (250–1000 Hz), a low F2 region (1000–2000 Hz) and a high F2–F3 region
 *   (2000–3500 Hz), of the energy from 80 to 3500 Hz.
 * - **Voicing.** The window's periodicity, its largest normalized
 *   autocorrelation at a pitch period's lag: near 1 for a voice, low for
 *   noise.
 * - **Spectrum.** 20 mel bands from 100 to 4000 Hz, where the vowels'
 *   formants lie.
 * - **Vowel weights.** The window's spectrum is compared with each vowel's
 *   templates by the distance between their cepstra (MFCC 1 to 12), after
 *   noise masking: the noise estimated in each band is subtracted, and
 *   bands within twice their noise, or more than 40 dB below the strongest
 *   band, do not count, in the window or in the template. The templates are
 *   a voice profile's ({@link VoiceCalibration}), or without one, those of a
 *   neutral synthetic voice in four sizes.
 * - **Gate and openness.** Below the gate level (−50 dBFS by default) the
 *   window is silence. A hangover keeps a voiced state for 40 ms after the
 *   level drops, so word ends do not flap. Above the gate, the vowels share
 *   a weight that grows with the level, up to a reference level, and with
 *   the voicing; Silence takes the rest.
 */
import { MOTION_SYNC_ELEMENTS, type MotionSyncElementId } from "./file.js";
import { VOWEL_FORMANTS, synthesizeVowel } from "./voice-synth.js";

/** The analysis rate, Hz. */
export const ANALYSIS_RATE = 16000;
/** The analysis window, samples at {@link ANALYSIS_RATE} (32 ms). */
export const ANALYSIS_WINDOW = 512;
/** Cepstral coefficients compared (1 to 12). */
export const MFCC_SIZE = 12;

const VOWELS = ["A", "I", "U", "E", "O"] as const;
type Vowel = (typeof VOWELS)[number];

// -------------------------------------------------------------- resampling

/** Table steps per input sample of the resampling kernel. */
const KERNEL_STEPS = 1024;

/**
 * A streaming resampler to `outRate`: windowed-sinc interpolation (a raised
 * cosine window) with its cut-off at the lower Nyquist frequency, 8 zero
 * crossings on each side, the kernel read from a table. `push` returns the
 * output samples that its input so far determines.
 */
export class Resampler {
  private readonly ratio: number;
  private readonly half: number;
  private buffer: Float64Array = new Float64Array(0);
  /** Input index (into the whole stream) of buffer[0]. */
  private bufferStart = 0;
  /** The next output sample's position in input samples. */
  private next = 0;

  /** The kernel at offsets i / KERNEL_STEPS input samples, i = 0 … half·KERNEL_STEPS + 1. */
  private readonly kernel: Float64Array;

  constructor(
    readonly inRate: number,
    readonly outRate: number,
  ) {
    this.ratio = inRate / outRate;
    const c = Math.min(1, outRate / inRate);
    const half = Math.ceil(8 / c);
    this.half = half;
    this.kernel = Float64Array.from({ length: half * KERNEL_STEPS + 2 }, (_, i) => {
      const x = i / KERNEL_STEPS;
      if (x >= half + 1) return 0;
      const arg = Math.PI * x * c;
      const sinc = x === 0 ? 1 : Math.sin(arg) / arg;
      return c * sinc * (0.5 + 0.5 * Math.cos((Math.PI * x) / (half + 1)));
    });
  }

  push(input: ArrayLike<number>): Float32Array {
    if (this.inRate === this.outRate) return Float32Array.from(input);
    const merged = new Float64Array(this.buffer.length + input.length);
    merged.set(this.buffer);
    for (let i = 0; i < input.length; i++) merged[this.buffer.length + i] = input[i]!;
    this.buffer = merged;
    const out: number[] = [];
    const end = this.bufferStart + merged.length;
    while (this.next + this.half < end) {
      out.push(this.sample(this.next));
      this.next += this.ratio;
    }
    this.trim();
    return Float32Array.from(out);
  }

  /** The rest of the stream, with zeros after its end. */
  flush(): Float32Array {
    const out: number[] = [];
    const end = this.bufferStart + this.buffer.length;
    while (this.next < end) {
      out.push(this.sample(this.next));
      this.next += this.ratio;
    }
    this.buffer = new Float64Array(0);
    this.bufferStart = Math.floor(this.next);
    return Float32Array.from(out);
  }

  private sample(t: number): number {
    const b = this.buffer;
    const kernel = this.kernel;
    const lo = Math.ceil(t - this.half);
    const hi = Math.floor(t + this.half);
    let s = 0;
    for (let n = lo; n <= hi; n++) {
      const i = n - this.bufferStart;
      if (i < 0 || i >= b.length) continue;
      // The kernel at |t − n|, interpolated linearly in its table.
      const p = Math.abs(t - n) * KERNEL_STEPS;
      const j = Math.floor(p);
      const f = p - j;
      s += b[i]! * (kernel[j]! + (kernel[j + 1]! - kernel[j]!) * f);
    }
    return s;
  }

  private trim(): void {
    const keep = Math.floor(this.next - this.half) - this.bufferStart;
    if (keep > 0) {
      this.buffer = this.buffer.slice(keep);
      this.bufferStart += keep;
    }
  }
}

/** Mono (the channels averaged) at {@link ANALYSIS_RATE}. */
export function toAnalysisRate(channels: readonly ArrayLike<number>[], rate: number): Float32Array {
  const frames = channels[0]?.length ?? 0;
  const mono = new Float64Array(frames);
  for (const ch of channels) for (let i = 0; i < frames; i++) mono[i] = mono[i]! + ch[i]!;
  if (channels.length > 1) for (let i = 0; i < frames; i++) mono[i] = mono[i]! / channels.length;
  if (rate === ANALYSIS_RATE) return Float32Array.from(mono);
  const r = new Resampler(rate, ANALYSIS_RATE);
  const a = r.push(mono);
  const b = r.flush();
  const out = new Float32Array(Math.round((frames * ANALYSIS_RATE) / rate));
  out.set(a.subarray(0, out.length));
  out.set(b.subarray(0, Math.max(0, out.length - a.length)), a.length);
  return out;
}

// ----------------------------------------------------------------- spectra

/** In-place radix-2 FFT of (re, im), length a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const HANN = Float64Array.from(
  { length: ANALYSIS_WINDOW },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / ANALYSIS_WINDOW),
);
const BIN_HZ = ANALYSIS_RATE / ANALYSIS_WINDOW;
const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const melInverse = (m: number) => 700 * (10 ** (m / 2595) - 1);

/** Bands of a window's spectrum: triangular mel filters from 100 to 4000 Hz. */
export const MEL_BANDS = 20;

/** The mel filters, as weights per spectrum bin. */
const MEL_FILTERS: Float64Array[] = (() => {
  const lo = mel(100);
  const hi = mel(4000);
  const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) =>
    melInverse(lo + ((hi - lo) * i) / (MEL_BANDS + 1)),
  );
  return Array.from({ length: MEL_BANDS }, (_, m) => {
    const w = new Float64Array(ANALYSIS_WINDOW / 2 + 1);
    const [a, b, c] = [edges[m]!, edges[m + 1]!, edges[m + 2]!];
    for (let k = 0; k < w.length; k++) {
      const f = k * BIN_HZ;
      if (f > a && f < c) w[k] = f <= b ? (f - a) / (b - a) : (c - f) / (c - b);
    }
    return w;
  });
})();

/** Orthonormal DCT-II rows 1 … MFCC_SIZE over the bands' log energies (row 0, the mean, is left out). */
const DCT: Float64Array[] = Array.from({ length: MFCC_SIZE }, (_, i) =>
  Float64Array.from(
    { length: MEL_BANDS },
    (_, m) => Math.cos((Math.PI * (i + 1) * (m + 0.5)) / MEL_BANDS) * Math.sqrt(2 / MEL_BANDS),
  ),
);

/** What one analysis window holds. */
export interface WindowFeatures {
  /** RMS level of the window after DC removal, dBFS. */
  level: number;
  /** Shares of the 80–3500 Hz energy: F1 (250–1000), low F2 (1000–2000), high F2–F3 (2000–3500). */
  bands: [number, number, number];
  /**
   * The energies of the {@link MEL_BANDS} mel bands of the window,
   * pre-emphasized (x[n] − 0.97·x[n − 1]) and Hann-windowed.
   */
  spectrum: Float64Array;
  /**
   * How periodic the window is, 0 to 1: the largest normalized
   * autocorrelation of the lightly pre-emphasized window (x[n] − 0.5·x[n − 1])
   * at a lag of 3 to 16.7 ms. A voice with a pitch of 60 Hz or more is
   * periodic at such a lag (higher pitches at twice or three times their
   * period). Near 1 for a voiced sound, below about 0.3 for noise; 0 for
   * silence.
   */
  periodicity: number;
}

const LAG_MIN = Math.round(0.003 * ANALYSIS_RATE);
const LAG_MAX = Math.floor(ANALYSIS_RATE / 60);

/** The window of `signal` at `start` (samples outside read as 0), its mean removed. */
function windowAt(signal: ArrayLike<number>, start: number): { x: Float64Array; level: number } {
  const N = ANALYSIS_WINDOW;
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const j = start + i;
    x[i] = j >= 0 && j < signal.length ? signal[j]! : 0;
  }
  let mean = 0;
  for (let i = 0; i < N; i++) mean += x[i]!;
  mean /= N;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    x[i] = x[i]! - mean;
    sum += x[i]! * x[i]!;
  }
  const rms = Math.sqrt(sum / N);
  return { x, level: rms > 0 ? 20 * Math.log10(rms) : -Infinity };
}

/** The largest normalized autocorrelation of the window `x` at lags LAG_MIN … LAG_MAX. */
function periodicityOf(x: Float64Array): number {
  const N = x.length;
  const y = new Float64Array(N);
  for (let i = 0; i < N; i++) y[i] = x[i]! - 0.5 * (i > 0 ? x[i - 1]! : 0);
  // The autocorrelation through a zero-padded FFT: r = IFFT(|FFT(y)|²). The
  // forward transform of that real, even spectrum is the inverse times 2N.
  const re = new Float64Array(2 * N);
  const im = new Float64Array(2 * N);
  re.set(y);
  fft(re, im);
  for (let k = 0; k < 2 * N; k++) {
    re[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    im[k] = 0;
  }
  fft(re, im);
  // Normalized by the energies of the two overlapping parts.
  const energy = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) energy[i + 1] = energy[i]! + y[i]! * y[i]!;
  let best = 0;
  for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
    const head = energy[N - lag]!;
    const tail = energy[N]! - energy[lag]!;
    if (!(head > 0 && tail > 0)) continue;
    const c = re[lag]! / (2 * N) / Math.sqrt(head * tail);
    if (c > best) best = c;
  }
  return Math.min(1, best);
}

/**
 * The features of the window of {@link ANALYSIS_WINDOW} samples of `signal`
 * (at {@link ANALYSIS_RATE}) starting at `start`; samples outside the signal
 * read as 0.
 */
export function windowFeatures(signal: ArrayLike<number>, start: number): WindowFeatures {
  const N = ANALYSIS_WINDOW;
  const { x, level } = windowAt(signal, start);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (x[i]! - 0.97 * (i > 0 ? x[i - 1]! : 0)) * HANN[i]!;
  fft(re, im);
  const power = new Float64Array(N / 2 + 1);
  for (let k = 0; k < power.length; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  const band = (lo: number, hi: number) => {
    let e = 0;
    for (let k = Math.ceil(lo / BIN_HZ); k <= Math.floor(hi / BIN_HZ); k++) e += power[k]!;
    return e;
  };
  const total = band(80, 3500);
  const share = (lo: number, hi: number) => (total > 0 ? band(lo, hi) / total : 0);
  const spectrum = Float64Array.from(MEL_FILTERS, (w) => {
    let e = 0;
    for (let k = 0; k < w.length; k++) e += w[k]! * power[k]!;
    return e;
  });
  return {
    level,
    bands: [share(250, 1000), share(1000, 2000), share(2000, 3500)],
    spectrum,
    periodicity: Number.isFinite(level) ? periodicityOf(x) : 0,
  };
}

/** Periodicity at or below this is noise; at or above {@link VOICED_PERIODICITY}, fully voiced. */
export const NOISE_PERIODICITY = 0.3;
export const VOICED_PERIODICITY = 0.6;

/** How voiced a window of periodicity `p` is, 0 to 1 (linear between the two thresholds). */
export function voicingOf(p: number): number {
  return Math.min(
    1,
    Math.max(0, (p - NOISE_PERIODICITY) / (VOICED_PERIODICITY - NOISE_PERIODICITY)),
  );
}

/** The `q`-quantile of `values` (nearest rank); `values` is not changed. */
function percentile(values: ArrayLike<number>, q: number): number {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

// ----------------------------------------------------- spectra compared

/** How far below a spectrum's strongest band its bands still count, dB. */
const SPECTRUM_RANGE = 40;
/** A band counts only where it is at least this many times its noise estimate. */
const NOISE_MARGIN = 2;

/**
 * A window's spectrum for matching: each band's noise estimate subtracted,
 * in dB relative to the strongest band, and its mask: per band, the level
 * below which the band does not count (40 dB below the strongest band, or
 * twice the band's noise, whichever is higher). The spectrum is raised to
 * its mask, and so is each template it is compared with (noise masking).
 */
function relativeSpectrum(
  spectrum: ArrayLike<number>,
  noise: ArrayLike<number> | null,
): { db: Float64Array; mask: Float64Array } {
  const clean = Float64Array.from({ length: MEL_BANDS }, (_, m) =>
    Math.max(0, spectrum[m]! - (noise ? noise[m]! : 0)),
  );
  let top = 0;
  for (let m = 0; m < MEL_BANDS; m++) top = Math.max(top, clean[m]!);
  const db = new Float64Array(MEL_BANDS).fill(-SPECTRUM_RANGE);
  const mask = new Float64Array(MEL_BANDS).fill(-SPECTRUM_RANGE);
  if (!(top > 0)) return { db, mask };
  for (let m = 0; m < MEL_BANDS; m++) {
    if (noise && noise[m]! > 0)
      mask[m] = Math.max(-SPECTRUM_RANGE, 10 * Math.log10((NOISE_MARGIN * noise[m]!) / top));
    db[m] = clean[m]! > 0 ? Math.max(mask[m]!, 10 * Math.log10(clean[m]! / top)) : mask[m]!;
  }
  return { db, mask };
}

/** The cepstral distance (DCT rows 1 … 12) between `db` and `template`, the template raised to `mask`. */
function maskedDistance(db: Float64Array, mask: Float64Array, template: ArrayLike<number>): number {
  const diff = new Float64Array(MEL_BANDS);
  for (let m = 0; m < MEL_BANDS; m++) diff[m] = db[m]! - Math.max(template[m]!, mask[m]!);
  let s = 0;
  for (const row of DCT) {
    let c = 0;
    for (let m = 0; m < MEL_BANDS; m++) c += row[m]! * diff[m]!;
    s += c * c;
  }
  return Math.sqrt(s);
}

/** What a whole sound tells the analysis ahead of its playback. */
export interface SoundStatistics {
  /**
   * The reference level, dBFS: the 70th percentile of the levels of the
   * voiced windows (above the gate and voiced at least half). Null with
   * fewer than five.
   */
  reference: number | null;
  /**
   * Each band's noise: the 10th percentile of the band's energy over the
   * windows that are not voiced (half or less). Null with fewer than ten.
   */
  noise: Float64Array | null;
}

/** The statistics of a whole signal at {@link ANALYSIS_RATE}, from windows every 20 ms. */
export function soundStatistics(signal: ArrayLike<number>, gate = -50): SoundStatistics {
  const levels: number[] = [];
  const unvoiced: Float64Array[] = [];
  const hop = Math.round(0.02 * ANALYSIS_RATE);
  for (let s = 0; s + ANALYSIS_WINDOW <= signal.length; s += hop) {
    const f = windowFeatures(signal, s);
    const v = voicingOf(f.periodicity);
    if (f.level >= gate && v >= 0.5) levels.push(f.level);
    if (v < 0.5) unvoiced.push(f.spectrum);
  }
  return {
    reference: levels.length >= 5 ? percentile(levels, 0.7) : null,
    noise: unvoiced.length >= 10 ? bandPercentile(unvoiced, 0.1) : null,
  };
}

/** Per band, the `q`-quantile over `spectra`. */
function bandPercentile(spectra: readonly ArrayLike<number>[], q: number): Float64Array {
  return Float64Array.from({ length: MEL_BANDS }, (_, m) =>
    percentile(
      spectra.map((s) => s[m]!),
      q,
    ),
  );
}

/** Spectra kept to follow a live input's noise. */
const NOISE_HISTORY = 300;

/**
 * Follows a live input's noise: per band, the 10th percentile of the
 * windows that are not voiced, among the last 300 such windows.
 */
class NoiseTracker {
  private history: Float64Array[] = [];
  private value: Float64Array | null = null;
  private pending = 0;

  push(spectrum: Float64Array): void {
    this.history.push(spectrum);
    if (this.history.length > NOISE_HISTORY) this.history.shift();
    // Re-estimated every fifth window, once ten are there.
    if (this.history.length >= 10 && (this.value === null || ++this.pending >= 5)) {
      this.value = bandPercentile(this.history, 0.1);
      this.pending = 0;
    }
  }

  get noise(): Float64Array | null {
    return this.value;
  }

  reset(): void {
    this.history = [];
    this.value = null;
    this.pending = 0;
  }
}

// -------------------------------------------------------------- templates

/** A voice's vowel templates and levels (see {@link VoiceCalibration}). */
export interface VoiceProfile {
  format: "mochi2d-voice-profile";
  version: 1;
  /** A name for people. */
  name: string;
  /**
   * Per vowel, one or more spectra: the {@link MEL_BANDS} mel bands from 100
   * to 4000 Hz, in dB relative to the strongest band (−40 to 0).
   */
  templates: Partial<Record<Vowel, number[][]>>;
  /** The voice's typical level while voiced, dBFS (the mouth is fully open from 6 dB below it). */
  voicedLevel: number;
  /** The noise floor recorded as Silence, dBFS, or null. */
  floorLevel: number | null;
}

/** The voices of the neutral templates: pitch (Hz) and formant scale. */
const NEUTRAL_VOICES: readonly [number, number][] = [
  [105, 0.97],
  [150, 1.06],
  [205, 1.16],
  [270, 1.26],
];

let neutralProfile: VoiceProfile | null = null;

/**
 * The templates of a neutral synthetic voice in four sizes, from a low
 * voice to a high one, built once: what the analysis uses without a
 * calibrated profile.
 */
export function neutralVoiceProfile(): VoiceProfile {
  if (neutralProfile) return neutralProfile;
  const templates: VoiceProfile["templates"] = {};
  for (const [f0, formantScale] of NEUTRAL_VOICES) {
    const cal = new VoiceCalibration();
    for (const v of VOWELS)
      cal.add(
        v,
        [synthesizeVowel(VOWEL_FORMANTS[v], 0.6, ANALYSIS_RATE, { f0, formantScale })],
        ANALYSIS_RATE,
      );
    for (const [v, list] of Object.entries(cal.profile().templates))
      (templates[v as Vowel] ??= []).push(...list);
  }
  neutralProfile = {
    format: "mochi2d-voice-profile",
    version: 1,
    name: "neutral synthetic voice",
    templates,
    voicedLevel: -26,
    floorLevel: null,
  };
  return neutralProfile;
}

/**
 * Per-voice calibration: record each vowel for about a second (and, if you
 * like, a moment of the room's silence), then {@link profile} gives the
 * voice's templates, as JSON to save and load. Only the recordings'
 * spectra are kept.
 */
export class VoiceCalibration {
  private readonly frames = new Map<Vowel, Float64Array[]>();
  private readonly levels: number[] = [];
  private floor: { level: number; spectrum: Float64Array } | null = null;

  constructor(public name = "voice") {}

  /**
   * Adds a recording of `element` (a vowel, or "Silence" for the room's
   * noise): its channels at `rate` Hz, analyzed every 10 ms. For a vowel,
   * only voiced windows louder than −45 dBFS count. Returns how many
   * windows were used.
   */
  add(element: MotionSyncElementId, channels: readonly ArrayLike<number>[], rate: number): number {
    const signal = toAnalysisRate(channels, rate);
    const hop = ANALYSIS_RATE / 100;
    const quiet: Float64Array[] = [];
    const levels: number[] = [];
    let used = 0;
    for (let s = 0; s + ANALYSIS_WINDOW <= signal.length; s += hop) {
      const f = windowFeatures(signal, s);
      if (element === "Silence") {
        if (Number.isFinite(f.level)) levels.push(f.level);
        quiet.push(f.spectrum);
        used++;
        continue;
      }
      if (!(f.level > -45) || voicingOf(f.periodicity) < 0.5) continue;
      const list = this.frames.get(element as Vowel) ?? [];
      list.push(f.spectrum);
      this.frames.set(element as Vowel, list);
      this.levels.push(f.level);
      used++;
    }
    if (element === "Silence" && quiet.length)
      this.floor = {
        level: levels.length ? percentile(levels, 0.5) : -Infinity,
        spectrum: bandPercentile(quiet, 0.5),
      };
    return used;
  }

  /** The vowels recorded so far. */
  get recorded(): MotionSyncElementId[] {
    return VOWELS.filter((v) => (this.frames.get(v)?.length ?? 0) > 0);
  }

  /**
   * The profile: each vowel's mean spectrum (relative dB, the room's noise
   * subtracted when Silence was recorded), the voiced level and the floor.
   */
  profile(): VoiceProfile {
    const templates: VoiceProfile["templates"] = {};
    const noise = this.floor?.spectrum ?? null;
    for (const [v, list] of this.frames) {
      const mean = new Array<number>(MEL_BANDS).fill(0);
      for (const f of list) {
        const { db } = relativeSpectrum(f, noise);
        for (let m = 0; m < MEL_BANDS; m++) mean[m]! += db[m]! / list.length;
      }
      templates[v] = [mean];
    }
    const floor = this.floor?.level ?? null;
    return {
      format: "mochi2d-voice-profile",
      version: 1,
      name: this.name,
      templates,
      voicedLevel: this.levels.length ? percentile(this.levels, 0.7) : -26,
      floorLevel: floor !== null && Number.isFinite(floor) ? floor : null,
    };
  }
}

/** Checks a voice profile read from JSON; throws a TypeError when it is not one. */
export function voiceProfileFromJson(json: unknown): VoiceProfile {
  const o = json as Partial<VoiceProfile> | null;
  if (!o || o.format !== "mochi2d-voice-profile" || o.version !== 1)
    throw new TypeError("not a Mochi2D voice profile (format mochi2d-voice-profile, version 1)");
  const templates: VoiceProfile["templates"] = {};
  for (const v of VOWELS) {
    const list = (o.templates as Record<string, unknown> | undefined)?.[v];
    if (list === undefined) continue;
    if (
      !Array.isArray(list) ||
      !list.every(
        (t) => Array.isArray(t) && t.length === MEL_BANDS && t.every((x) => Number.isFinite(x)),
      )
    )
      throw new TypeError(
        `voice profile: templates.${v} must hold spectra of ${MEL_BANDS} numbers`,
      );
    templates[v] = list.map((t) => [...(t as number[])]);
  }
  if (!Number.isFinite(o.voicedLevel))
    throw new TypeError("voice profile: voicedLevel must be a number");
  const floor = o.floorLevel ?? null;
  if (floor !== null && !Number.isFinite(floor))
    throw new TypeError("voice profile: floorLevel must be a number or null");
  return {
    format: "mochi2d-voice-profile",
    version: 1,
    name: typeof o.name === "string" ? o.name : "voice",
    templates,
    voicedLevel: o.voicedLevel!,
    floorLevel: floor,
  };
}

// --------------------------------------------------------------- analyzer

export interface AnalyzerOptions {
  /**
   * The gate, dBFS: quieter windows are silence. Default −50, or 6 dB above
   * a voice profile's recorded noise floor when that is higher.
   */
  gate?: number;
  /** A voice profile; default the neutral synthetic voice's templates. */
  profile?: VoiceProfile | null;
  /** How long a voiced state holds after the level drops, seconds. Default 0.04. */
  hangover?: number;
}

/** One analysis: raw element weights and what they came from. */
export interface Analysis {
  /** Raw weights ≥ 0 per element, in {@link MOTION_SYNC_ELEMENTS} order, summing to 1. */
  raw: Float64Array;
  /** The window's level, dBFS. */
  level: number;
  /** The gate (with its hangover) found the window silent. */
  silent: boolean;
  /** How voiced the window is, 0 to 1 ({@link voicingOf} its periodicity). */
  voicing: number;
  /** How open the mouth is from the level and the voicing, 0 to 1. */
  open: number;
  features: WindowFeatures;
}

/** Levels of recent voiced windows kept for a reference that follows the input. */
const RECENT = 300;

/**
 * Turns analysis windows into element weights:
 *
 * - below the gate (after the hangover), Silence alone;
 * - otherwise the vowels take a weight o·v, shared by how close the window's
 *   spectrum is to each vowel's templates, and Silence the rest, 1 − o·v.
 *   Here v is how voiced the window is (noise is not), and o how open the
 *   level makes the mouth: 0 at the gate, 1 from 6 dB below the reference
 *   level.
 *
 * Spectra are compared by the distance d between their cepstra (the DCT of
 * the bands' dB levels, coefficients 1 to 12) after noise masking, and a
 * template's weight is exp(−d²/2σ²), σ being 0.4 times the median distance
 * between templates of different vowels.
 *
 * A sound's reference level and noise come from the whole sound
 * ({@link soundStatistics}), set by the player; otherwise both follow the
 * input: the reference is the 70th percentile of the last 300 voiced
 * windows' levels (at first the voice profile's level), and the noise as
 * {@link NoiseTracker} says.
 */
export class VowelAnalyzer {
  /** The gate given, or null for the default. */
  private readonly gateOption: number | null;
  hangover: number;
  /** A fixed reference level, dBFS, or null to follow the input. */
  reference: number | null = null;
  /** A fixed noise per band, or null to follow the input. */
  noise: Float64Array | null = null;
  private profileValue!: VoiceProfile;
  private templates: { vowel: number; t: number[] }[] = [];
  private sigma = 1;
  /** Seconds since the level was last above the gate. */
  private sinceVoiced = Infinity;
  private lastVowels = new Float64Array(VOWELS.length);
  private lastOpen = 0;
  private recent: number[] = [];
  private readonly tracker = new NoiseTracker();

  constructor(options: AnalyzerOptions = {}) {
    this.gateOption = options.gate ?? null;
    this.hangover = options.hangover ?? 0.04;
    this.profile = options.profile ?? null;
  }

  /** The gate in use, dBFS. */
  get gate(): number {
    if (this.gateOption !== null) return this.gateOption;
    const floor = this.profileValue.floorLevel;
    return floor === null ? -50 : Math.max(-50, floor + 6);
  }

  /** The reference level in use, dBFS. */
  get referenceLevel(): number {
    if (this.reference !== null) return this.reference;
    return this.recent.length >= 30 ? percentile(this.recent, 0.7) : this.profileValue.voicedLevel;
  }

  /** The voice profile in use (null: the neutral synthetic voice). */
  get profile(): VoiceProfile {
    return this.profileValue;
  }

  set profile(p: VoiceProfile | null) {
    this.profileValue = p ?? neutralVoiceProfile();
    this.templates = [];
    VOWELS.forEach((v, i) => {
      for (const t of this.profileValue.templates[v] ?? []) this.templates.push({ vowel: i, t });
    });
    // σ: 0.4 of the median distance between templates of different vowels.
    const open = new Float64Array(MEL_BANDS).fill(-SPECTRUM_RANGE);
    const d: number[] = [];
    for (let i = 0; i < this.templates.length; i++)
      for (let j = i + 1; j < this.templates.length; j++)
        if (this.templates[i]!.vowel !== this.templates[j]!.vowel)
          d.push(
            maskedDistance(Float64Array.from(this.templates[i]!.t), open, this.templates[j]!.t),
          );
    this.sigma = d.length ? Math.max(1e-6, 0.4 * percentile(d, 0.5)) : 1;
  }

  /** Forgets the hangover and what was followed of the input. */
  reset(): void {
    this.sinceVoiced = Infinity;
    this.lastVowels.fill(0);
    this.lastOpen = 0;
    this.recent = [];
    this.tracker.reset();
  }

  /** Analyzes the window of `signal` at `start`, `dt` seconds after the previous analysis. */
  analyze(signal: ArrayLike<number>, start: number, dt: number): Analysis {
    const features = windowFeatures(signal, start);
    const raw = new Float64Array(MOTION_SYNC_ELEMENTS.length);
    const level = features.level;
    const gate = this.gate;
    const loud = level >= gate;
    this.sinceVoiced = loud ? 0 : this.sinceVoiced + Math.max(0, dt);
    const voicing = loud ? voicingOf(features.periodicity) : 0;
    if (this.noise === null && voicing < 0.5) this.tracker.push(features.spectrum);
    if ((!loud && this.sinceVoiced > this.hangover) || this.templates.length === 0) {
      raw[0] = 1;
      return { raw, level, silent: true, voicing, open: 0, features };
    }
    // During the hangover, the last loud window's weights.
    let vowels = this.lastVowels;
    let open = this.lastOpen;
    if (loud) {
      vowels = new Float64Array(VOWELS.length);
      const { db, mask } = relativeSpectrum(features.spectrum, this.noise ?? this.tracker.noise);
      const s2 = 2 * this.sigma * this.sigma;
      for (const { vowel, t } of this.templates) {
        const d = maskedDistance(db, mask, t);
        vowels[vowel] = Math.max(vowels[vowel]!, Math.exp(-(d * d) / s2));
      }
      const sum = vowels.reduce((a, b) => a + b, 0);
      if (sum > 0) for (let i = 0; i < vowels.length; i++) vowels[i] = vowels[i]! / sum;
      else {
        // Far from every template: the nearest takes it all.
        let best = 0;
        let bestD = Infinity;
        for (const { vowel, t } of this.templates) {
          const d = maskedDistance(db, mask, t);
          if (d < bestD) [best, bestD] = [vowel, d];
        }
        vowels[best] = 1;
      }
      if (voicing >= 0.5) {
        this.recent.push(level);
        if (this.recent.length > RECENT) this.recent.shift();
      }
      const full = Math.max(gate + 6, this.referenceLevel - 6);
      open = Math.min(1, Math.max(0, (level - gate) / (full - gate))) * voicing;
      this.lastVowels = vowels;
      this.lastOpen = open;
    }
    raw[0] = 1 - open;
    for (let i = 0; i < VOWELS.length; i++) raw[i + 1] = open * vowels[i]!;
    return { raw, level, silent: false, voicing, open, features };
  }
}

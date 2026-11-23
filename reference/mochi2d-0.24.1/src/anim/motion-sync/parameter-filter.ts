/**
 * The per-parameter post-filter of a motion-sync setting, as the file
 * defines it, in double precision. For driven parameter k, each analysis
 * result y_k goes through:
 *
 * 1. smoothing: S_k ← ((100 − Smooth_k)·y_k + Smooth_k·S_k) / 100;
 * 2. a dead band: D_k keeps its value while |S_k − D_k| < Damper_k, and
 *    takes S_k otherwise.
 *
 * D_k is what is written. A y_k that is not a number leaves both as they are.
 *
 * The smoothing of step 1 is a fixed linear filter. It lives here on its own,
 * behind one switch (`smoothing`, the runtime's `motionSync.fileSmoothing`
 * option, off by default), so that it can be turned off, leaving S_k = y_k,
 * or replaced without touching anything else. Mochi2D's own analyzer smooths
 * differently (see engine.ts).
 */
export class ParameterFilter {
  /** Smoothed values S_k. */
  readonly smoothed: Float64Array;
  /** Output values D_k. */
  readonly output: Float64Array;

  constructor(
    /** Smooth_k, percent. */
    readonly smooth: Float64Array,
    /** Damper_k, ≥ 0. */
    readonly damper: Float64Array,
    /** Step 1 on (the file's rule) or off (S_k = y_k). */
    public smoothing = true,
  ) {
    this.smoothed = new Float64Array(smooth.length);
    this.output = new Float64Array(smooth.length);
  }

  /** S_k = D_k = values[k]. */
  reset(values: ArrayLike<number>): void {
    for (let k = 0; k < this.smoothed.length; k++) {
      this.smoothed[k] = values[k]!;
      this.output[k] = values[k]!;
    }
  }

  /** One analysis result. */
  step(y: ArrayLike<number>): void {
    const S = this.smoothed;
    const D = this.output;
    for (let k = 0; k < S.length; k++) {
      const v = y[k]!;
      if (Number.isNaN(v)) continue;
      const w = this.smooth[k]!;
      S[k] = this.smoothing ? ((100 - w) * v + w * S[k]!) / 100 : v;
      if (!(Math.abs(S[k]! - D[k]!) < this.damper[k]!)) D[k] = S[k]!;
    }
  }
}

/**
 * The analysis tick of a setting. Each frame of step Δ adds max(Δ, 0) to an
 * accumulated time T. When T reaches h = 1/SampleRate, the frame analyzes
 * once and T keeps its remainder modulo h. So a frame analyzes at most once,
 * longer frames drop the extra ticks, and the first tick comes no earlier
 * than h after the start.
 */
export class TickClock {
  /** The accumulated time T, seconds. */
  time = 0;

  constructor(
    /** Ticks per second. */
    public sampleRate: number,
  ) {}

  /** Advances by one frame; true when this frame analyzes. */
  advance(dt: number): boolean {
    this.time += dt > 0 ? dt : 0;
    const h = 1 / this.sampleRate;
    if (this.time < h) return false;
    this.time %= h;
    return true;
  }
}

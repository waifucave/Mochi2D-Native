/**
 * Playback clock for the viewer: play / pause / single-step / speed. Pure
 * logic (no DOM), driven by real elapsed time.
 */
export class PlaybackClock {
  playing = true;
  /** Model seconds per real second. */
  speed = 1;
  /** Total model time in seconds. */
  time = 0;
  /** Real-time gaps longer than this (e.g. a background tab) are clamped. */
  maxRealStep = 0.1;
  /** Length of one {@link step} in model seconds. */
  stepSeconds = 1 / 60;
  private pendingStep = 0;

  /**
   * Advances by `realDt` real seconds. Returns the model-time delta for this
   * frame: scaled by `speed` while playing, plus any requested steps.
   */
  tick(realDt: number): number {
    let dt = 0;
    if (this.playing && realDt > 0) dt = Math.min(realDt, this.maxRealStep) * this.speed;
    dt += this.pendingStep;
    this.pendingStep = 0;
    this.time += dt;
    return dt;
  }

  /** Requests a step of `frames × stepSeconds` model time at the next tick (pauses playback). */
  step(frames = 1): void {
    this.playing = false;
    this.pendingStep += frames * this.stepSeconds;
  }

  toggle(): boolean {
    this.playing = !this.playing;
    return this.playing;
  }

  reset(): void {
    this.time = 0;
    this.pendingStep = 0;
  }
}

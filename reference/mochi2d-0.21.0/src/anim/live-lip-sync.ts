/**
 * Lip sync from live audio, such as a microphone. This is not reference
 * behavior: the reference analyses sound files only (3s).
 *
 * The measure and the mapping are those of 3s.2, applied to the live samples
 * since the previous frame: the RMS of all their values (all channels
 * pooled), added with weight 1 to the `LipSync` parameters, which limits it
 * to their range. A microphone also needs three adjustable steps, applied to
 * that RMS in this order:
 *
 * 1. a noise gate: the gate level g (an RMS amplitude, set in dBFS) is
 *    subtracted, max(0, rms − g). Levels at or below the gate give 0, and the
 *    value grows continuously above it, so it does not flicker at the gate;
 * 2. a gain (the sensitivity) multiplies the result;
 * 3. smoothing: one step of a one-pole filter towards that target, with the
 *    attack time constant when the target is above the current value and the
 *    release time constant otherwise. The step is the duration of the
 *    frame's samples, so the result does not depend on the frame rate.
 *
 * With gain 1, no gate and no smoothing ({@link LIVE_LIP_SYNC_NEUTRAL}), the
 * value is the 3s.2 RMS of the same samples.
 *
 * Live audio arrives in blocks that do not line up with frames. A frame that
 * received no sample keeps the previous value: 3s.2 skips the write instead,
 * which would close the mouth for that frame. After
 * {@link LIVE_SILENCE_AFTER} seconds without samples (a suspended audio
 * context, a stalled stream), frames count as silence, so the mouth closes
 * with the release time.
 *
 * Pure TypeScript: the browser side (src/platform/live-audio.ts) pushes the
 * samples, and the frame procedure takes one value per frame.
 */
import type { LiveLipSyncSource } from "./lip-sync.js";

export interface LiveLipSyncSettings {
  /** The sensitivity: multiplies the gated RMS. */
  gain: number;
  /**
   * The noise gate in dBFS, as an RMS level (a full-scale sine is −3 dBFS).
   * `-Infinity`: no gate.
   */
  gate: number;
  /** Attack time constant in seconds: how fast the value rises. 0: at once. */
  attack: number;
  /** Release time constant in seconds: how fast the value falls. 0: at once. */
  release: number;
}

/**
 * The defaults, chosen for speech at arm's length with the browser's voice
 * processing on (docs/api.md, "Lip sync from the microphone"): such speech
 * gives frame RMS levels of about −35 to −15 dBFS, which open a 0–1 mouth
 * parameter to about 0.15–1, while a quiet room stays below the gate.
 */
export const LIVE_LIP_SYNC_DEFAULTS: Readonly<LiveLipSyncSettings> = Object.freeze({
  gain: 12,
  gate: -45,
  attack: 0.03,
  release: 0.12,
});

/** No gate, gain or smoothing: the value is the 3s.2 RMS. */
export const LIVE_LIP_SYNC_NEUTRAL: Readonly<LiveLipSyncSettings> = Object.freeze({
  gain: 1,
  gate: -Infinity,
  attack: 0,
  release: 0,
});

/** Seconds of frames without samples after which frames count as silence. */
export const LIVE_SILENCE_AFTER = 0.1;

/** An RMS level in dBFS as a linear amplitude (−Infinity gives 0). */
export function dbfsToAmplitude(db: number): number {
  const a = 10 ** (db / 20);
  return a > 0 ? a : 0;
}

/**
 * Collects live samples between frames and turns them into one lip-sync
 * value per frame (see the module comment).
 */
export class LiveLipSync implements LiveLipSyncSource {
  /** The settings in use; changes apply from the next frame. */
  readonly settings: LiveLipSyncSettings;
  /** The RMS of the latest frame's samples (the input level), 0 before any. */
  level = 0;
  /** The value of the latest frame: what is added to the lip-sync parameters. */
  value = 0;
  /** Called at the start of each frame before the samples are taken (for a tap that is polled). */
  pull: (() => void) | null = null;
  private sum = 0;
  private count = 0;
  private frames = 0;
  private idle = 0;

  constructor(
    /** Sample rate of the pushed samples, in frames per second. */
    public sampleRate: number,
    settings: Partial<LiveLipSyncSettings> = {},
    /** The longest span of samples one frame takes, in seconds: an older backlog is dropped. */
    readonly maxWindow = 0.25,
  ) {
    this.settings = { ...LIVE_LIP_SYNC_DEFAULTS };
    for (const key of ["gain", "gate", "attack", "release"] as const)
      if (settings[key] !== undefined) this.settings[key] = settings[key];
  }

  /** Adds a block of samples: one array per channel, all of the same length. */
  push(channels: readonly ArrayLike<number>[]): void {
    const n = channels[0]?.length ?? 0;
    if (n === 0) return;
    let sum = 0;
    for (const ch of channels) for (let i = 0; i < n; i++) sum += ch[i]! * ch[i]!;
    this.pushSums(sum, channels.length * n, n);
  }

  /**
   * Adds a block given by the sum of its squared values, its number of values
   * (channels × frames) and its number of frames.
   */
  pushSums(sumSquares: number, values: number, frames: number): void {
    if (!(frames > 0) || !(values > 0) || !(sumSquares >= 0)) return;
    if (this.frames > 0 && this.frames + frames > this.maxWindow * this.sampleRate) {
      this.sum = 0;
      this.count = 0;
      this.frames = 0;
    }
    this.sum += sumSquares;
    this.count += values;
    this.frames += frames;
  }

  /** Seconds of samples waiting for the next frame. */
  get pending(): number {
    return this.frames / this.sampleRate;
  }

  /** This frame's value, ≥ 0, from the samples pushed since the previous frame. */
  next(dt: number): number {
    this.pull?.();
    if (this.count > 0) {
      const rms = Math.sqrt(this.sum / this.count);
      const seconds = this.frames / this.sampleRate;
      this.sum = 0;
      this.count = 0;
      this.frames = 0;
      this.idle = 0;
      this.level = rms;
      this.value = this.step(rms, seconds);
    } else {
      this.idle += dt > 0 ? dt : 0;
      if (this.idle > LIVE_SILENCE_AFTER) {
        this.level = 0;
        this.value = this.step(0, dt);
      }
    }
    return this.value;
  }

  /** Clears the pending samples and the value. */
  reset(): void {
    this.sum = 0;
    this.count = 0;
    this.frames = 0;
    this.idle = 0;
    this.level = 0;
    this.value = 0;
  }

  /** Gate, gain and one smoothing step for a window of `seconds` with this RMS. */
  private step(rms: number, seconds: number): number {
    const s = this.settings;
    const gain = s.gain > 0 && s.gain < Infinity ? s.gain : 0;
    const target = gain * Math.max(0, rms - dbfsToAmplitude(s.gate));
    const tau = target > this.value ? s.attack : s.release;
    if (!(tau > 0)) return target;
    if (!(seconds > 0)) return this.value;
    return this.value + (target - this.value) * (1 - Math.exp(-seconds / tau));
  }
}

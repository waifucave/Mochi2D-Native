/**
 * Lip sync (3s): WAV decoding as in 3s.1 and the per-frame RMS
 * analysis of 3s.2.
 */
import type { AnimationValues } from "./values.js";

export interface WavSound {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Samples per channel. */
  frames: number;
  /** Decoded samples, one array per channel (float32 values, C15). */
  samples: Float64Array[];
}

/** Why a WAV file could not be loaded. */
export class WavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavFormatError";
  }
}

const tag = (b: Uint8Array, o: number) =>
  String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/**
 * Decodes a RIFF WAV file (3s.1): linear PCM only, 8-bit unsigned or 16/24-bit
 * signed little-endian samples, any channel count and rate. Other sample
 * sizes load but read as silence. Throws {@link WavFormatError} for files that
 * are not loaded (not RIFF/WAVE, `fmt ` not right after `WAVE`, format ≠ 1,
 * no channels, 0 bits per sample).
 */
export function decodeWav(bytes: Uint8Array): WavSound {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE")
    throw new WavFormatError("not a RIFF/WAVE file");
  if (bytes.length < 20 || tag(bytes, 12) !== "fmt ")
    throw new WavFormatError("the fmt chunk does not follow WAVE");
  const fmtSize = dv.getUint32(16, true);
  if (bytes.length < 20 + 16) throw new WavFormatError("truncated fmt chunk");
  const format = dv.getUint16(20, true);
  const channels = dv.getUint16(22, true);
  const sampleRate = dv.getUint32(24, true);
  const bits = dv.getUint16(34, true);
  if (format !== 1) throw new WavFormatError(`format code ${format} is not linear PCM`);
  if (channels === 0) throw new WavFormatError("no channels");
  if (bits === 0) throw new WavFormatError("0 bits per sample");
  // Skip chunks (by their sizes, no pad bytes) until "data".
  let o = 20 + fmtSize;
  while (o + 8 <= bytes.length && tag(bytes, o) !== "data") o += 8 + dv.getUint32(o + 4, true);
  if (o + 8 > bytes.length) throw new WavFormatError("no data chunk");
  const size = Math.min(dv.getUint32(o + 4, true), bytes.length - o - 8);
  const start = o + 8;
  const bytesPerSample = Math.ceil(bits / 8);
  const frames = Math.floor(size / (bytesPerSample * channels));
  const samples = Array.from({ length: channels }, () => new Float64Array(frames));
  const scale = 2147483647; // 2³¹ − 1
  if (bits === 8 || bits === 16 || bits === 24)
    for (let c = 0; c < channels; c++) {
      const s = samples[c]!;
      for (let i = 0; i < frames; i++) {
        const p = start + (i * channels + c) * bytesPerSample;
        let v: number;
        if (bits === 8) v = (bytes[p]! - 128) * 16777216;
        else if (bits === 16) v = dv.getInt16(p, true) * 65536;
        else v = (((bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16)) << 8) >> 8) * 256;
        s[i] = Math.fround(v / scale); // C15: decoded samples are float32
      }
    }
  return { channels, sampleRate, bitsPerSample: bits, frames, samples };
}

/**
 * A live lip-sync input, such as a microphone (src/anim/live-lip-sync.ts):
 * one value per frame. Not reference behavior.
 */
export interface LiveLipSyncSource {
  /** The value to add to the `LipSync` parameters this frame, ≥ 0. */
  next(dt: number): number;
}

/**
 * How a live lip-sync value combines with each lip-sync parameter (not
 * reference behavior), given the parameter's value so far in the frame (base,
 * motions, expressions, effects and a playing sound): "add" (the default)
 * adds the live value, "replace" writes it instead, "max" writes the larger
 * of the two. A function receives the live value, the value so far and the
 * parameter ID, and returns the value to write (limited to the range; a
 * non-finite result leaves the parameter as it is). It runs every frame for
 * every lip-sync parameter and must not throw.
 */
export type LiveLipSyncMix =
  "add" | "replace" | "max" | ((live: number, current: number, id: string) => number);

/**
 * 3s.2: the RMS of the samples since the previous frame, added to the
 * `LipSync` parameters. A live input (not reference behavior) is applied
 * after the sound, by its mix mode; with no live input, a frame is exactly
 * 3s.2.
 */
export class LipSync {
  private sound: WavSound | null = null;
  private live: LiveLipSyncSource | null = null;
  /** How the live input's value combines with the lip-sync parameters. */
  liveMix: LiveLipSyncMix = "add";
  time = 0;
  private position = 0;
  /**
   * The value of the latest frame: the sound's, plus the live input's (with
   * mix "replace" or a function, the live input's; with "max", the larger).
   * 0 with neither; NaN when a frame covered no sample of the sound and
   * there is no live input.
   */
  value = 0;
  /** The sound's part of {@link value} (3s.2): 0 with no sound, NaN for an empty window. */
  soundValue = 0;
  /** The live input's part of {@link value}. */
  liveValue = 0;

  constructor(private readonly ids: readonly string[]) {}

  /** The live input, or null. */
  get liveSource(): LiveLipSyncSource | null {
    return this.live;
  }

  /** Adds a live input alongside sounds (null removes it), combined by `mix`. */
  setLive(source: LiveLipSyncSource | null, mix: LiveLipSyncMix = "add"): void {
    this.live = source;
    this.liveMix = mix;
    this.liveValue = 0;
  }

  /** Starts a sound (null stops lip sync). */
  start(sound: WavSound | null): void {
    this.sound = sound;
    this.time = 0;
    this.position = 0;
    this.value = this.liveValue;
    this.soundValue = 0;
  }

  /** A sound is loaded and not finished. */
  get playing(): boolean {
    return this.sound !== null && this.position < this.sound.frames;
  }

  /**
   * One frame. Parameters in `skip` are left alone (motion sync drives them
   * in this frame; not reference behavior).
   */
  frame(dt: number, values: AnimationValues, skip?: ReadonlySet<string>): void {
    const ids = skip?.size ? this.ids.filter((id) => !skip.has(id)) : this.ids;
    this.soundFrame(dt, values, ids);
    this.value = this.soundValue;
    const live = this.live;
    if (!live) return;
    const v = live.next(dt);
    const l = Number.isFinite(v) && v > 0 ? v : 0;
    this.liveValue = l;
    const mix = this.liveMix;
    if (mix === "add") {
      if (l > 0) for (const id of ids) values.add(id, l, 1);
      this.value = Number.isNaN(this.value) ? l : this.value + l;
      return;
    }
    for (const id of ids) {
      const current = values.get(id);
      const x = mix === "replace" ? l : mix === "max" ? Math.max(current, l) : mix(l, current, id);
      if (Number.isFinite(x)) values.set(id, x, 1);
    }
    const sound = Number.isNaN(this.value) ? 0 : this.value;
    this.value = mix === "max" ? Math.max(sound, l) : l;
  }

  /** Step 4f for the sound (3s.2). */
  private soundFrame(dt: number, values: AnimationValues, ids: readonly string[]): void {
    const snd = this.sound;
    if (!snd || this.position >= snd.frames) {
      this.soundValue = 0;
      return;
    }
    this.time += dt;
    const g = Math.min(Math.floor(this.time * snd.sampleRate), snd.frames);
    const from = this.position;
    if (g === from) {
      // 0/0 in the reference (NaN written); the write is skipped here.
      this.soundValue = NaN;
      return;
    }
    let sum = 0;
    for (const ch of snd.samples) for (let i = from; i < g; i++) sum += ch[i]! * ch[i]!;
    const rms = Math.sqrt(sum / (snd.channels * (g - from)));
    this.position = g;
    this.soundValue = rms;
    for (const id of ids) values.add(id, rms, 1);
  }
}

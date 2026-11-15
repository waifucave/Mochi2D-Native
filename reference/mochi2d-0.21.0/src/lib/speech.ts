/**
 * Audio for speech: plays a sound file through Web Audio and provides the
 * decoded samples lip sync analyses.
 *
 * Lip sync follows 3s: WAV files are decoded as in 3s.1 (linear
 * PCM). As a convenience that is not reference behavior, other formats the
 * browser can decode (MP3, AAC, Ogg, float WAV) are analysed from the
 * browser's decoded samples.
 */
import { decodeWav, type WavSound } from "../anim/lip-sync.js";

/** A sound file: its URL, or its contents. */
export type AudioData = string | URL | Blob | ArrayBuffer | Uint8Array;

/** Fetches or reads audio data into bytes. */
export async function audioBytes(data: AudioData): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string" || data instanceof URL) {
    const res = await fetch(data);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${String(data)}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  return new Uint8Array(await data.arrayBuffer());
}

/** Lip-sync samples from a decoded Web Audio buffer (not reference behavior, see above). */
export function soundFromAudioBuffer(buffer: AudioBuffer): WavSound {
  const samples = Array.from(
    { length: buffer.numberOfChannels },
    (_, c) => new Float64Array(buffer.getChannelData(c)),
  );
  return {
    channels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
    bitsPerSample: 32,
    frames: buffer.length,
    samples,
  };
}

export interface PreparedSound {
  /** For playback, or null if neither the browser nor the WAV decoder could decode it. */
  buffer: AudioBuffer | null;
  /** For lip sync, or null. */
  sound: WavSound | null;
  /** The lip-sync samples come from the WAV decoder of 3s.1 (reference behavior). */
  exact: boolean;
}

/** A sound playing. */
export interface SpeechPlayback {
  /**
   * Seconds of the sound heard so far: the audio clock since its start, less
   * the output latency the browser reports.
   */
  position(): number;
}

export class SpeechPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private ended: (() => void) | null = null;

  /** The audio context, created on first use. Browsers start it suspended until a user gesture. */
  context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Decodes a sound for playback and for lip sync. */
  async prepare(bytes: Uint8Array): Promise<PreparedSound> {
    let sound: WavSound | null = null;
    try {
      sound = decodeWav(bytes);
    } catch {
      sound = null;
    }
    const ctx = this.context();
    let buffer: AudioBuffer | null = null;
    try {
      buffer = await ctx.decodeAudioData(bytes.slice().buffer);
    } catch {
      buffer = null;
    }
    if (!buffer && sound && sound.frames > 0) {
      // A WAV file the browser cannot play: play the decoder's samples.
      buffer = ctx.createBuffer(sound.channels, sound.frames, sound.sampleRate);
      for (let c = 0; c < sound.channels; c++)
        buffer.getChannelData(c).set(Float32Array.from(sound.samples[c]!));
    }
    if (sound) return { buffer, sound, exact: true };
    return { buffer, sound: buffer ? soundFromAudioBuffer(buffer) : null, exact: false };
  }

  /** Plays a buffer (stopping the previous one); `onEnded` runs when it ends or is stopped. */
  play(buffer: AudioBuffer, volume = 1, onEnded?: () => void): SpeechPlayback {
    this.stop();
    const ctx = this.context();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain!);
    this.gain!.gain.value = volume;
    this.ended = onEnded ?? null;
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      const done = this.ended;
      this.ended = null;
      done?.();
    };
    this.source = src;
    const start = ctx.currentTime;
    src.start(start);
    return {
      position: () => {
        const latency = ctx.outputLatency || ctx.baseLatency || 0;
        return Math.max(0, ctx.currentTime - start - latency);
      },
    };
  }

  get playing(): boolean {
    return this.source !== null;
  }

  stop(): void {
    const src = this.source;
    const done = this.ended;
    this.source = null;
    this.ended = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // not started
      }
      src.disconnect();
    }
    done?.();
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.gain = null;
  }
}

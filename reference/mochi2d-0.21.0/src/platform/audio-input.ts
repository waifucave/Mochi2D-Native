/**
 * Audio input for the viewer: decoded audio files (played audibly) and the
 * microphone (not played back), both measured per frame through an
 * AnalyserNode. Loudness is the RMS of the analyser's most recent window,
 * smoothed by an envelope follower. The microphone is a {@link LiveAudioInput},
 * which also feeds live lip sync (src/platform/live-audio.ts).
 */
import { EnvelopeFollower, mixDown, peakAbs, rms, rmsEnvelope } from "../core/audio/loudness.js";
import { LiveAudioInput } from "./live-audio.js";

export type AudioSourceKind = "none" | "file" | "microphone";

export interface LoudnessSample {
  kind: AudioSourceKind;
  /** RMS of the latest analyser window (linear, 0-1). */
  rms: number;
  /** Peak absolute sample in that window. */
  peak: number;
  /** RMS after the envelope follower. */
  envelope: number;
  /** Seconds since the source started (file: playback position). */
  time: number;
}

export interface PlayOptions {
  loop?: boolean;
  /** Output gain for file playback (does not affect measurement). Default 1. */
  volume?: number;
}

export class AudioInput {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** The microphone while it is in use. */
  live: LiveAudioInput | null = null;
  /** The browser's voice processing for the microphone (echo cancellation, noise suppression, auto gain). */
  voiceProcessing = true;
  /** Called after each change of the microphone's state (see {@link LiveAudioInput}). */
  onMicrophoneState: ((input: LiveAudioInput) => void) | null = null;
  private buffer: AudioBuffer | null = null;
  private window: Float32Array<ArrayBuffer> = new Float32Array(2048);
  private startedAt = 0;
  private loop = false;
  /** Per-frame RMS of the current file (60 fps), for deterministic lookups. */
  fileEnvelope: Float32Array | null = null;
  readonly follower = new EnvelopeFollower();
  kind: AudioSourceKind = "none";
  label = "";
  onEnded: (() => void) | null = null;

  constructor(readonly analyserWindow = 2048) {
    this.window = new Float32Array(analyserWindow);
  }

  /** Creates (or resumes) the AudioContext. Call from a user gesture in browsers. */
  async context(): Promise<AudioContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.analyserWindow;
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }

  /** Decodes an encoded audio file (WAV, MP3, OGG… as supported by the browser). */
  async decode(bytes: Uint8Array): Promise<AudioBuffer> {
    const ctx = await this.context();
    return ctx.decodeAudioData(bytes.slice().buffer);
  }

  /** Decodes and plays a file; measurement follows playback. */
  async playFile(bytes: Uint8Array, label: string, opts: PlayOptions = {}): Promise<AudioBuffer> {
    const buffer = await this.decode(bytes);
    this.playBuffer(buffer, label, opts);
    return buffer;
  }

  playBuffer(buffer: AudioBuffer, label: string, opts: PlayOptions = {}): void {
    this.stop();
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = opts.loop ?? false;
    src.connect(this.analyser!);
    src.connect(this.gain!);
    this.gain!.gain.value = opts.volume ?? 1;
    src.onended = () => {
      if (this.source === src) {
        this.source = null;
        this.kind = "none";
        this.onEnded?.();
      }
    };
    src.start();
    this.source = src;
    this.buffer = buffer;
    this.loop = src.loop;
    this.startedAt = ctx.currentTime;
    this.kind = "file";
    this.label = label;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
      buffer.getChannelData(i),
    );
    this.fileEnvelope = rmsEnvelope(mixDown(channels), buffer.sampleRate, 60);
    this.follower.reset();
  }

  /**
   * Starts measuring the microphone (it is not played back). Call it from a
   * click or tap. Rejects with a LiveAudioError (an insecure page, a denied
   * permission…).
   */
  async startMicrophone(): Promise<LiveAudioInput> {
    const ctx = await this.context();
    this.stop();
    const live = await LiveAudioInput.open(ctx, { voiceProcessing: this.voiceProcessing });
    live.output.connect(this.analyser!);
    this.live = live;
    live.onChange(() => {
      if (live.state === "stopped" && this.live === live) {
        this.live = null;
        this.kind = "none";
        this.label = "";
      } else if (this.live === live) this.label = live.label || "microphone";
      this.onMicrophoneState?.(live);
    });
    this.startedAt = ctx.currentTime;
    this.kind = "microphone";
    this.label = live.label || "microphone";
    this.fileEnvelope = null;
    this.follower.reset();
    return live;
  }

  stop(): void {
    if (this.source) {
      this.source.disconnect();
      if (this.source instanceof AudioBufferSourceNode) {
        this.source.onended = null;
        try {
          this.source.stop();
        } catch {
          // already stopped
        }
      }
    }
    const live = this.live;
    this.live = null;
    this.source = null;
    this.kind = "none";
    this.label = "";
    live?.stop();
  }

  /** Playback position of the current file in seconds (wraps when looping). */
  playbackTime(): number {
    if (!this.ctx || this.kind === "none") return 0;
    const t = this.ctx.currentTime - this.startedAt;
    if (this.kind === "file" && this.buffer && this.loop) return t % this.buffer.duration;
    return t;
  }

  /** Measures the latest window. Call once per frame with the frame's elapsed seconds. */
  sample(dt: number): LoudnessSample {
    let r = 0;
    let p = 0;
    if (this.analyser && this.kind !== "none") {
      this.analyser.getFloatTimeDomainData(this.window);
      r = rms(this.window);
      p = peakAbs(this.window);
    }
    const envelope = this.follower.process(r, dt);
    return { kind: this.kind, rms: r, peak: p, envelope, time: this.playbackTime() };
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.ctx?.close();
    this.ctx = null;
  }
}

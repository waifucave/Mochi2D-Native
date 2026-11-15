/**
 * Motion sync from the microphone, or from any MediaStream, for the models
 * and items of a {@link MochiView}: the live audio drives the mouth through
 * a setting of the model's motion-sync file, with Mochi2D's own analysis.
 * Also the recording of short clips for voice calibration.
 *
 * Audio is processed in memory as it arrives: it is never stored or sent
 * anywhere. A recording for calibration is handed to the caller only.
 */
import type { MotionSyncInput, MotionSyncTick } from "../anim/motion-sync/driver.js";
import type { ModelRuntime } from "../runtime/model-runtime.js";
import type {
  LiveAudioError,
  LiveAudioInput,
  LiveAudioSink,
  LiveInputState,
  LiveTapMethod,
} from "../platform/live-audio.js";

/** Which live audio to follow (shared with live lip sync). */
export interface LiveAudioChoice {
  /**
   * Audio to follow instead of the microphone: a call, a `<video>`'s
   * `captureStream()`, a Web Audio `MediaStreamAudioDestinationNode`…
   * Mochi2D never stops its tracks.
   */
  stream?: MediaStream;
  /**
   * For the microphone: the browser's echo cancellation, noise suppression
   * and automatic gain control. Default true for live lip sync, which follows
   * only the loudness; false for live motion sync and recordings, because
   * noise suppression changes the vowels' spectra. Turn it on for motion
   * sync when echo (speakers near the microphone) or steady noise (a fan)
   * moves the mouth more than the processing changes the vowels.
   */
  voiceProcessing?: boolean;
  /** For the microphone: release it while the page is hidden. Default true. */
  releaseWhenHidden?: boolean;
  /** How samples are taken: `"auto"` (default), `"worklet"` or `"analyser"`. */
  tap?: LiveTapMethod;
  /** For the microphone: the `deviceId` of the input to open, asked for exactly. */
  deviceId?: string;
}

export interface LiveMotionSyncOptions extends LiveAudioChoice {
  /** The setting to drive: a dictionary name or ID. Default the first usable one. */
  setting?: string;
}

/** @internal The samples of a live input as they arrive, mono, until read. */
export class LiveSampleQueue implements LiveAudioSink, MotionSyncInput {
  sampleRate = 48000;
  pull: (() => void) | null = null;
  private chunks: Float32Array[] = [];
  private length = 0;

  /** `keep`: seconds of unread samples kept, the oldest dropped beyond. */
  constructor(private readonly keep = 2) {}

  push(channels: readonly ArrayLike<number>[]): void {
    const n = channels[0]?.length ?? 0;
    if (n === 0) return;
    const mono = new Float32Array(n);
    for (const ch of channels)
      for (let i = 0; i < n; i++) mono[i] = mono[i]! + ch[i]! / channels.length;
    this.chunks.push(mono);
    this.length += n;
    // Unread audio beyond `keep` seconds is dropped, oldest first.
    while (this.length > this.keep * this.sampleRate && this.chunks.length > 1)
      this.length -= this.chunks.shift()!.length;
  }

  /** The samples since the previous call. */
  read(): Float32Array {
    this.pull?.();
    const out = new Float32Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    this.length = 0;
    return out;
  }

  /** How many samples wait to be read. */
  get waiting(): number {
    return this.length;
  }
}

/** A running live motion sync, returned by `startLiveMotionSync()`. */
export class LiveMotionSyncControl {
  /** Called with the new state after each change, last with `"stopped"`. */
  onstatechange: ((state: LiveInputState) => void) | null = null;
  private ended = false;
  private readonly unsubscribe: () => void;

  /** @internal */
  constructor(
    private readonly input: LiveAudioInput,
    private readonly queue: LiveSampleQueue,
    private readonly runtime: () => ModelRuntime,
    private readonly detach: () => void,
  ) {
    this.unsubscribe = input.onChange(() => {
      if (input.state === "stopped") this.stop();
      else this.onstatechange?.(input.state);
    });
  }

  /** See {@link LiveInputState}: `running`, `suspended` (waiting for a tap), `paused` (page hidden)… */
  get state(): LiveInputState {
    return this.ended ? "stopped" : this.input.state;
  }

  /** Why it stopped, when the microphone or stream failed. */
  get error(): LiveAudioError | null {
    return this.input.error;
  }

  /**
   * The latest analysis: the level (dBFS), the element weights (Silence, A,
   * I, U, E, O) and the values written; null before the first.
   */
  get tick(): MotionSyncTick | null {
    const rt = this.runtime();
    return !this.ended && rt.motionSyncSource === this.queue ? rt.motionSync : null;
  }

  /** The stream in use: the microphone's (null while released) or the one passed in. */
  get stream(): MediaStream | null {
    return this.ended ? null : this.input.currentStream;
  }

  /** The microphone's name, when the browser tells it. */
  get label(): string {
    return this.input.label;
  }

  /** How samples are taken: `"worklet"` or `"analyser"` (null once stopped). */
  get tap(): "worklet" | "analyser" | null {
    return this.ended ? null : this.input.tapMethod;
  }

  /** Stops: the mouth settles to its Silence shape. A shared microphone closes when nothing uses it. */
  stop(): void {
    if (this.ended) return;
    this.ended = true;
    this.unsubscribe();
    this.detach();
    this.onstatechange?.("stopped");
  }
}

/** A clip of live audio, mono. */
export interface RecordedAudio {
  sampleRate: number;
  channels: [Float32Array];
}

/** @internal At most one running control at a time (a model's or an item's). */
export class LiveSlot<C extends { stop(): void; readonly state: LiveInputState }> {
  private control: C | null = null;
  private token = 0;

  async start(open: () => Promise<C>, what: string): Promise<C> {
    this.stop();
    const token = ++this.token;
    const control = await open();
    if (token !== this.token) {
      control.stop();
      throw new DOMException(`${what} was stopped while it started`, "AbortError");
    }
    this.control = control;
    return control;
  }

  /** The running control, or null. */
  get current(): C | null {
    const c = this.control;
    return c && c.state !== "stopped" ? c : null;
  }

  stop(): void {
    this.token++;
    const c = this.control;
    this.control = null;
    c?.stop();
  }
}

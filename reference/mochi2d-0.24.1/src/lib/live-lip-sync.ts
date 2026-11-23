/**
 * Lip sync from the microphone, or from any MediaStream, for the models and
 * items of a {@link MochiView}. Not reference behavior: the mapping is in
 * src/anim/live-lip-sync.ts and the browser side in
 * src/platform/live-audio.ts. See docs/api.md, "Lip sync from the
 * microphone".
 *
 * Audio is processed in memory as it arrives: it is never recorded, stored or
 * sent anywhere.
 */
import { LiveLipSync, type LiveLipSyncSettings } from "../anim/live-lip-sync.js";
import type { ModelRuntime } from "../runtime/model-runtime.js";
import type { LiveLipSyncMix } from "../anim/lip-sync.js";
import {
  LiveAudioError,
  LiveAudioInput,
  type LiveInputState,
  type LiveTapMethod,
} from "../platform/live-audio.js";
import {
  LiveMotionSyncControl,
  LiveSampleQueue,
  type LiveAudioChoice,
  type LiveMotionSyncOptions,
  type RecordedAudio,
} from "./live-motion-sync.js";

export interface LiveLipSyncOptions extends Partial<LiveLipSyncSettings> {
  /**
   * Audio to follow instead of the microphone: a call, a `<video>`'s
   * `captureStream()`, a Web Audio `MediaStreamAudioDestinationNode`…
   * Mochi2D never stops its tracks.
   */
  stream?: MediaStream;
  /**
   * For the microphone: the browser's echo cancellation, noise suppression
   * and automatic gain control. Default true.
   */
  voiceProcessing?: boolean;
  /**
   * For the microphone: release it while the page is hidden and open it
   * again when the page is visible. Default true.
   */
  releaseWhenHidden?: boolean;
  /**
   * How samples are taken: `"auto"` (default) uses an AudioWorklet where it
   * loads, else an AnalyserNode; `"analyser"` avoids the worklet's `blob:`
   * module (a strict Content Security Policy may refuse it).
   */
  tap?: LiveTapMethod;
  /**
   * How the live value combines with the lip-sync parameters, in the same
   * frame: `"add"` (default) adds it to their value so far (base, motions,
   * expressions, a playing sound), `"replace"` writes it instead, `"max"`
   * the larger of the two; a function `(live, current, id) => value` decides
   * (see {@link LiveLipSyncMix}). Can be changed later on the control.
   */
  mix?: LiveLipSyncMix;
  /**
   * For the microphone: the `deviceId` of the input to open (from
   * `navigator.mediaDevices.enumerateDevices()`), asked for exactly. Default:
   * the browser's choice. Ignored with `stream`.
   */
  deviceId?: string;
}

/** A running live lip sync, returned by `startLiveLipSync()`. */
export class LiveLipSyncControl {
  /** The mapping settings in use. Change them at any time; they apply from the next frame. */
  readonly settings: LiveLipSyncSettings;
  /** Called with the new state after each change, last with `"stopped"`. */
  onstatechange: ((state: LiveInputState) => void) | null = null;
  private ended = false;
  private readonly unsubscribe: () => void;

  /** @internal */
  constructor(
    private readonly input: LiveAudioInput,
    private readonly lip: LiveLipSync,
    private readonly detach: () => void,
    private readonly runtime: ModelRuntime,
  ) {
    this.settings = lip.settings;
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

  /** The RMS of the latest frame's samples (the input level, linear). */
  get level(): number {
    return this.lip.level;
  }

  /** The value of the latest frame: what is combined with the lip-sync parameters. */
  get value(): number {
    return this.lip.value;
  }

  /** How the value combines with the lip-sync parameters; changes apply from the next frame. */
  get mix(): LiveLipSyncMix {
    return this.runtime.liveLipSync === this.lip ? this.runtime.liveLipSyncMix : "add";
  }

  set mix(mix: LiveLipSyncMix) {
    if (!this.ended && this.runtime.liveLipSync === this.lip) this.runtime.liveLipSyncMix = mix;
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

  /** Stops live lip sync on this model. A shared microphone closes when nothing uses it. */
  stop(): void {
    if (this.ended) return;
    this.ended = true;
    this.unsubscribe();
    this.detach();
    this.onstatechange?.("stopped");
  }
}

interface SharedInput {
  input: Promise<LiveAudioInput>;
  users: number;
}

/**
 * @internal The live inputs of a view: one microphone per setting, shared by
 * its models and items, and one input per stream passed in.
 */
export class LiveInputs {
  private readonly shared = new Map<string, SharedInput>();
  private readonly open = new Set<LiveAudioInput>();
  private disposed = false;

  constructor(private readonly context: () => AudioContext) {}

  /** Starts live lip sync on a runtime. */
  async start(runtime: ModelRuntime, options: LiveLipSyncOptions): Promise<LiveLipSyncControl> {
    if (this.disposed) throw new Error("the view is disposed");
    if (!runtime.animator.lipSync)
      throw new LiveAudioError(
        "no-lip-sync",
        "The model has no lip-sync parameter: its settings list no LipSync parameters, " +
          "and it has no ParamMouthOpenY.",
      );
    const { input, release } = await this.acquire(options);
    const lip = new LiveLipSync(input.ctx.sampleRate, options);
    input.addSink(lip);
    runtime.setLiveLipSync(lip, options.mix ?? "add");
    return new LiveLipSyncControl(
      input,
      lip,
      () => {
        if (runtime.liveLipSync === lip) runtime.setLiveLipSync(null);
        input.removeSink(lip);
        release();
      },
      runtime,
    );
  }

  /** Starts live motion sync on a runtime (read when needed: a replaced model's is the new one). */
  async startMotionSync(
    runtime: () => ModelRuntime,
    options: LiveMotionSyncOptions,
  ): Promise<LiveMotionSyncControl> {
    if (this.disposed) throw new Error("the view is disposed");
    const settings = runtime().motionSyncSettings;
    if (!settings.some((s) => s.usable))
      throw new LiveAudioError(
        "no-motion-sync",
        "The model has no motion-sync setting to run: its settings name no .motionsync3.json " +
          "file, or none of the file's settings has a known analysis type.",
      );
    const ref = options.setting;
    if (ref !== undefined && !settings.some((s) => s.name === ref || s.id === ref))
      throw new RangeError(`no motion-sync setting "${ref}"`);
    // The vowels' spectra as spoken: no noise suppression unless asked for.
    const { input, release } = await this.acquire({
      ...options,
      voiceProcessing: options.voiceProcessing ?? false,
    });
    const queue = new LiveSampleQueue();
    input.addSink(queue);
    runtime().setMotionSyncInput(queue, ref);
    return new LiveMotionSyncControl(input, queue, runtime, () => {
      const rt = runtime();
      if (rt.motionSyncSource === queue) rt.setMotionSyncInput(null);
      input.removeSink(queue);
      release();
    });
  }

  /**
   * Records `seconds` of live audio, mono (for voice calibration). Waits
   * while the audio context is suspended; the clip is only handed back.
   */
  async record(seconds: number, options: LiveAudioChoice = {}): Promise<RecordedAudio> {
    if (this.disposed) throw new Error("the view is disposed");
    if (!(seconds > 0 && seconds <= 60))
      throw new RangeError("a recording lasts from 0 to 60 seconds");
    // Heard as live motion sync hears it (see startMotionSync).
    const { input, release } = await this.acquire({
      ...options,
      voiceProcessing: options.voiceProcessing ?? false,
    });
    const queue = new LiveSampleQueue(seconds + 1);
    input.addSink(queue);
    try {
      const chunks: Float32Array[] = [];
      let n = 0;
      await new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          if (input.state === "stopped" || this.disposed) {
            clearInterval(timer);
            reject(input.error ?? new LiveAudioError("failed", "The microphone stopped."));
            return;
          }
          const got = queue.read();
          if (got.length) {
            chunks.push(got);
            n += got.length;
          }
          if (n >= seconds * queue.sampleRate) {
            clearInterval(timer);
            resolve();
          }
        }, 40);
      });
      const out = new Float32Array(Math.round(seconds * queue.sampleRate));
      let o = 0;
      for (const c of chunks) {
        out.set(c.subarray(0, Math.max(0, out.length - o)), o);
        o += c.length;
      }
      return { sampleRate: queue.sampleRate, channels: [out] };
    } finally {
      input.removeSink(queue);
      release();
    }
  }

  private track(input: LiveAudioInput): LiveAudioInput {
    this.open.add(input);
    input.onChange(() => {
      if (input.state === "stopped") this.open.delete(input);
    });
    return input;
  }

  private async acquire(
    options: LiveAudioChoice,
  ): Promise<{ input: LiveAudioInput; release: () => void }> {
    const settings = {
      ...(options.voiceProcessing !== undefined
        ? { voiceProcessing: options.voiceProcessing }
        : {}),
      ...(options.releaseWhenHidden !== undefined
        ? { releaseWhenHidden: options.releaseWhenHidden }
        : {}),
      ...(options.tap ? { tap: options.tap } : {}),
      ...(options.deviceId ? { deviceId: options.deviceId } : {}),
    };
    if (options.stream) {
      const input = this.track(
        await LiveAudioInput.open(this.context(), { ...settings, stream: options.stream }),
      );
      return { input, release: () => input.stop() };
    }
    const key = JSON.stringify([
      settings.voiceProcessing ?? true,
      settings.releaseWhenHidden ?? true,
      settings.tap ?? "auto",
      settings.deviceId ?? "",
    ]);
    for (let attempt = 0; ; attempt++) {
      let entry = this.shared.get(key);
      if (!entry) {
        entry = { input: LiveAudioInput.open(this.context(), settings), users: 0 };
        const created = entry;
        this.shared.set(key, created);
        created.input.then(
          (input) => {
            this.track(input).onChange(() => {
              if (input.state === "stopped" && this.shared.get(key) === created)
                this.shared.delete(key);
            });
          },
          () => {
            if (this.shared.get(key) === created) this.shared.delete(key);
          },
        );
      }
      entry.users++;
      let input: LiveAudioInput;
      try {
        input = await entry.input;
      } catch (e) {
        entry.users--;
        throw e;
      }
      if (input.state === "stopped") {
        // It failed after opening (the entry is gone): open it again once.
        entry.users--;
        if (attempt === 0) continue;
        throw input.error ?? new LiveAudioError("failed", "The microphone stopped.");
      }
      if (this.disposed) {
        entry.users--;
        if (entry.users === 0) input.stop();
        throw new DOMException("the view was disposed", "AbortError");
      }
      const used = entry;
      let released = false;
      return {
        input,
        release: () => {
          if (released) return;
          released = true;
          if (--used.users > 0) return;
          if (this.shared.get(key) === used) this.shared.delete(key);
          input.stop();
        },
      };
    }
  }

  /** Stops every input. */
  dispose(): void {
    this.disposed = true;
    for (const input of [...this.open]) input.stop();
    for (const entry of this.shared.values())
      void entry.input.then(
        (i) => i.stop(),
        () => {},
      );
    this.shared.clear();
  }
}

/** @internal A model's or item's live lip sync: at most one at a time. */
export class LiveLipSyncSlot {
  private control: LiveLipSyncControl | null = null;
  private token = 0;

  constructor(
    private readonly inputs: () => LiveInputs,
    private readonly runtime: () => ModelRuntime,
  ) {}

  async start(options: LiveLipSyncOptions): Promise<LiveLipSyncControl> {
    this.stop();
    const token = ++this.token;
    const control = await this.inputs().start(this.runtime(), options);
    if (token !== this.token) {
      control.stop();
      throw new DOMException("live lip sync was stopped while it started", "AbortError");
    }
    this.control = control;
    return control;
  }

  /** The running control, or null. */
  get current(): LiveLipSyncControl | null {
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

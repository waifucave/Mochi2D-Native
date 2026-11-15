/**
 * Live audio for lip sync in browsers: the microphone, or a MediaStream from
 * the application, tapped through Web Audio. The samples are measured in
 * memory as they arrive and then dropped: nothing is recorded, stored or
 * sent anywhere.
 *
 * - **Taps.** An AudioWorklet passes the sum of squares of each 256-frame
 *   block to the main thread, so every sample is counted once. Where
 *   AudioWorklet is missing or its module cannot load (it is loaded from a
 *   `blob:` URL, which a strict Content Security Policy may refuse), an
 *   AnalyserNode is read each frame instead: the samples rendered since the
 *   previous read, by the context's clock, mixed to mono.
 * - **Secure pages.** Browsers offer the microphone only on HTTPS pages and
 *   on localhost ({@link liveAudioProblem}).
 * - **Suspended audio.** The audio context may start suspended (autoplay
 *   rules; iOS Safari starts audio only in a tap) or be interrupted later
 *   (iOS: a call, Siri, another app taking the audio). The input then waits
 *   and resumes on the next tap, click or key press, or when the page is
 *   shown again.
 * - **Hidden pages.** A microphone opened here is released while the page is
 *   hidden, so the browser's recording indicator goes off while nothing is
 *   drawn, and opened again when the page is visible (browsers that keep the
 *   permission do not ask again). A stream passed in is never stopped here.
 */

export type LiveAudioErrorCode =
  /** The page is not a secure context (plain HTTP on an address other than localhost). */
  | "insecure-context"
  /** The browser has no microphone access or no Web Audio. */
  | "unsupported"
  /** Live motion sync: the model has no motion-sync setting to run. */
  | "no-motion-sync"
  /** The permission was denied or the prompt dismissed. */
  | "denied"
  /** Blocked by a permissions policy (an iframe without `allow="microphone"`). */
  | "blocked"
  /** No microphone, or a stream without an audio track. */
  | "no-device"
  /** The microphone could not be opened (in use elsewhere, a hardware error). */
  | "busy"
  /** The microphone or stream stopped while in use. */
  | "ended"
  /** The model has no lip-sync parameter. */
  | "no-lip-sync"
  | "failed";

/** Why live audio could not start or stopped; the message can be shown to people. */
export class LiveAudioError extends Error {
  constructor(
    readonly code: LiveAudioErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LiveAudioError";
  }
}

/** The page's address as people see it, for messages. */
function pageAddress(): string {
  return location.origin && location.origin !== "null" ? location.origin : location.protocol;
}

/** Why the microphone cannot be used on this page, or null when it can be tried. */
export function liveAudioProblem(): LiveAudioError | null {
  if (typeof window === "undefined" || typeof navigator === "undefined")
    return new LiveAudioError("unsupported", "Live audio needs a browser.");
  if (!window.isSecureContext)
    return new LiveAudioError(
      "insecure-context",
      `Browsers offer the microphone only on secure pages: HTTPS, or http://localhost. ` +
        `This page is ${pageAddress()}, so the microphone is not available here.`,
    );
  if (!navigator.mediaDevices?.getUserMedia)
    return new LiveAudioError(
      "unsupported",
      "This browser does not offer microphone access (getUserMedia).",
    );
  if (typeof AudioContext === "undefined")
    return new LiveAudioError("unsupported", "This browser has no Web Audio.");
  return null;
}

/** A getUserMedia (or other) failure as a {@link LiveAudioError}. */
export function liveAudioError(e: unknown): LiveAudioError {
  if (e instanceof LiveAudioError) return e;
  const name = (e as { name?: unknown } | null)?.name;
  const options = { cause: e };
  switch (name) {
    case "NotAllowedError":
      return new LiveAudioError(
        "denied",
        "Microphone access was denied. Allow the microphone for this site (in the address bar " +
          "or the site settings), then try again. Some browsers also refuse a request that " +
          "does not come from a tap or click.",
        options,
      );
    case "SecurityError":
      return new LiveAudioError(
        "blocked",
        "The microphone is blocked on this page: by the page that embeds it (a permissions " +
          "policy), or because the page is not secure.",
        options,
      );
    case "NotFoundError":
      return new LiveAudioError("no-device", "No microphone was found.", options);
    case "OverconstrainedError":
      return new LiveAudioError(
        "no-device",
        "No microphone was found that fits the request: the one asked for may be " +
          "unplugged, or its device ID may have changed.",
        options,
      );
    case "NotReadableError":
    case "AbortError":
      return new LiveAudioError(
        "busy",
        "The microphone could not be opened. Another app may be using it.",
        options,
      );
    default: {
      const detail = e instanceof Error && e.message ? `: ${e.message}` : "";
      return new LiveAudioError("failed", `Live audio could not start${detail}`, options);
    }
  }
}

// ------------------------------------------------------------------ taps

const TAP_PROCESSOR = "mochi2d-live-tap";
const TAP_BLOCK = 256;
// Posts, every TAP_BLOCK frames or so: the sum of squares of all samples,
// their count, the frame count, and the frames mixed to mono.
const TAP_SOURCE = `registerProcessor(${JSON.stringify(TAP_PROCESSOR)}, class extends AudioWorkletProcessor {
  constructor() { super(); this.s = 0; this.v = 0; this.f = 0; this.m = new Float32Array(${4 * TAP_BLOCK}); }
  process(inputs) {
    const input = inputs[0];
    const n = input && input.length > 0 ? input[0].length : 0;
    if (n > 0) {
      let s = 0;
      if (this.f + n > this.m.length) { const m = new Float32Array(2 * (this.f + n)); m.set(this.m.subarray(0, this.f)); this.m = m; }
      for (let i = 0; i < n; i++) this.m[this.f + i] = 0;
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < n; i++) { s += ch[i] * ch[i]; this.m[this.f + i] += ch[i] / input.length; }
      }
      this.s += s; this.v += input.length * n; this.f += n;
      if (this.f >= ${TAP_BLOCK}) {
        const mono = this.m.slice(0, this.f);
        this.port.postMessage([this.s, this.v, this.f, mono], [mono.buffer]);
        this.s = 0; this.v = 0; this.f = 0;
      }
    }
    return true;
  }
});`;

const tapModules = new WeakMap<BaseAudioContext, Promise<void>>();

function loadTapModule(ctx: BaseAudioContext): Promise<void> {
  let p = tapModules.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: "text/javascript" }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    p.catch(() => tapModules.delete(ctx));
    tapModules.set(ctx, p);
  }
  return p;
}

/** How a tap takes samples: an AudioWorklet, an AnalyserNode, or the first that works. */
export type LiveTapMethod = "auto" | "worklet" | "analyser";

/**
 * What a tap feeds: blocks of samples as they arrive ({@link LiveLipSync},
 * or a queue of samples for motion sync). A sink with `pushSums` takes the
 * worklet's sums of squares instead of its samples.
 */
export interface LiveAudioSink {
  /** Set by the tap: the input's sample rate. */
  sampleRate: number;
  /** Set by the tap: analyser taps hand over their samples when this is called. */
  pull: (() => void) | null;
  /** The next block, per channel. */
  push(channels: readonly ArrayLike<number>[]): void;
  /** The next block as the sum of the squares of its samples, their count and its frames. */
  pushSums?(sumSquares: number, values: number, frames: number): void;
}

/** Hands the samples of an audio node to its sinks. */
export class LiveAudioTap {
  private readonly sinks = new Set<LiveAudioSink>();
  private readonly node: AudioWorkletNode | AnalyserNode;
  private readonly window: Float32Array<ArrayBuffer> | null = null;
  private clock = 0;

  static async create(
    ctx: AudioContext,
    input: AudioNode,
    method: LiveTapMethod = "auto",
  ): Promise<LiveAudioTap> {
    if (method !== "analyser" && typeof AudioWorkletNode === "function" && ctx.audioWorklet) {
      try {
        await loadTapModule(ctx);
        return new LiveAudioTap(ctx, input, "worklet");
      } catch (e) {
        if (method === "worklet") throw e;
      }
    } else if (method === "worklet") {
      throw new LiveAudioError("unsupported", "This browser has no AudioWorklet.");
    }
    return new LiveAudioTap(ctx, input, "analyser");
  }

  private constructor(
    readonly ctx: AudioContext,
    input: AudioNode,
    readonly method: "worklet" | "analyser",
  ) {
    if (method === "worklet") {
      const node = new AudioWorkletNode(ctx, TAP_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (e: MessageEvent<[number, number, number, Float32Array]>) => {
        const [sum, values, frames, mono] = e.data;
        for (const sink of this.sinks)
          if (sink.pushSums) sink.pushSums(sum, values, frames);
          else sink.push([mono]);
      };
      input.connect(node);
      // The processor writes no output: this silent connection only keeps it running.
      node.connect(ctx.destination);
      this.node = node;
    } else {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 8192;
      input.connect(analyser);
      this.node = analyser;
      this.window = new Float32Array(analyser.fftSize);
      this.clock = ctx.currentTime;
    }
  }

  /** Feeds a sink from now on (and sets its sample rate). */
  add(sink: LiveAudioSink): void {
    sink.sampleRate = this.ctx.sampleRate;
    sink.pull = this.window ? () => this.poll() : null;
    this.sinks.add(sink);
  }

  remove(sink: LiveAudioSink): void {
    if (this.sinks.delete(sink)) sink.pull = null;
  }

  get sinkCount(): number {
    return this.sinks.size;
  }

  /** Analyser taps: hands the samples rendered since the previous call to the sinks. */
  poll(): void {
    const w = this.window;
    if (!w) return;
    const now = this.ctx.currentTime;
    const n = Math.min(w.length, Math.round((now - this.clock) * this.ctx.sampleRate));
    if (n <= 0) return;
    this.clock = now;
    (this.node as AnalyserNode).getFloatTimeDomainData(w);
    const block = w.subarray(w.length - n);
    for (const sink of this.sinks) sink.push([block]);
  }

  dispose(): void {
    for (const sink of this.sinks) sink.pull = null;
    this.sinks.clear();
    this.node.disconnect();
    if (this.node instanceof AudioWorkletNode) {
      this.node.port.onmessage = null;
      this.node.port.close();
    }
  }
}

// ---------------------------------------------------------------- inputs

/**
 * - `starting`: asking for the microphone, or opening it again;
 * - `running`: audio flows;
 * - `suspended`: the audio context is suspended or interrupted, waiting for a
 *   tap, click or key press (or for the page to be shown) to resume;
 * - `paused`: the page is hidden and the microphone released until it is
 *   visible again;
 * - `stopped`: stopped, or failed (see `error`).
 */
export type LiveInputState = "starting" | "running" | "suspended" | "paused" | "stopped";

export interface LiveInputOptions {
  /** A stream to use instead of opening the microphone. It is never stopped here. */
  stream?: MediaStream;
  /**
   * For the microphone: the browser's voice processing (echo cancellation,
   * noise suppression, automatic gain control). Default true.
   */
  voiceProcessing?: boolean;
  /** For the microphone: release it while the page is hidden. Default true. */
  releaseWhenHidden?: boolean;
  /** How samples are taken. Default "auto". */
  tap?: LiveTapMethod;
  /** For the microphone: the device to open, asked for exactly. Default: the browser's choice. */
  deviceId?: string;
}

const GESTURES = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;

/** The microphone (or a stream) feeding live lip sync, with its lifecycle. */
export class LiveAudioInput {
  state: LiveInputState = "starting";
  /** Why the input stopped, if it failed. */
  error: LiveAudioError | null = null;
  /** Carries the input audio, for a meter. It stays the same when the microphone is reopened. */
  readonly output: GainNode;
  /** The microphone was opened here (not a stream passed in). */
  readonly own: boolean;
  readonly voiceProcessing: boolean;
  readonly releaseWhenHidden: boolean;
  /** The microphone asked for, or null for the browser's choice. */
  readonly deviceId: string | null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private tap: LiveAudioTap | null = null;
  private readonly listeners = new Set<(input: LiveAudioInput) => void>();
  private unarm: (() => void) | null = null;
  private generation = 0;

  /**
   * Opens the microphone (or uses `options.stream`). Call it from a tap or
   * click: the audio context is resumed first, while the gesture lasts.
   * Rejects with a {@link LiveAudioError}.
   */
  static async open(ctx: AudioContext, options: LiveInputOptions = {}): Promise<LiveAudioInput> {
    const input = new LiveAudioInput(ctx, options);
    try {
      await input.init(options);
    } catch (e) {
      input.error = liveAudioError(e);
      input.close();
      throw input.error;
    }
    return input;
  }

  private constructor(
    readonly ctx: AudioContext,
    options: LiveInputOptions,
  ) {
    this.own = !options.stream;
    this.voiceProcessing = options.voiceProcessing ?? true;
    this.releaseWhenHidden = options.releaseWhenHidden ?? true;
    this.deviceId = options.deviceId || null;
    this.output = ctx.createGain();
    this.tryResume();
  }

  private async init(options: LiveInputOptions): Promise<void> {
    let stream = options.stream ?? null;
    if (!stream) {
      const problem = liveAudioProblem();
      if (problem) throw problem;
      stream = await navigator.mediaDevices.getUserMedia({ audio: this.constraints() });
    }
    this.stream = stream;
    if (stream.getAudioTracks().length === 0)
      throw new LiveAudioError("no-device", "The stream has no audio track.");
    this.tap = await LiveAudioTap.create(this.ctx, this.output, options.tap ?? "auto");
    if (this.state === "stopped") return;
    this.attachStream(stream);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.ctx.addEventListener("statechange", this.onContextState);
    this.updateRunning();
    if (document.visibilityState === "hidden") this.onVisibility();
  }

  /** The stream in use (null while released or after stop). */
  get currentStream(): MediaStream | null {
    return this.stream;
  }

  /** The microphone's name, when the browser tells it. */
  get label(): string {
    return this.stream?.getAudioTracks()[0]?.label ?? "";
  }

  /** How samples are taken: "worklet" or "analyser". */
  get tapMethod(): "worklet" | "analyser" | null {
    return this.tap?.method ?? null;
  }

  /** Calls `listener` after each state change; returns a function that removes it. */
  onChange(listener: (input: LiveAudioInput) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addSink(sink: LiveAudioSink): void {
    this.tap?.add(sink);
  }

  removeSink(sink: LiveAudioSink): void {
    this.tap?.remove(sink);
  }

  /** Stops: releases a microphone opened here (a stream passed in keeps running). */
  stop(): void {
    this.close();
  }

  // ------------------------------------------------------------ internals

  private constraints(): MediaTrackConstraints {
    const on = this.voiceProcessing;
    return {
      echoCancellation: on,
      noiseSuppression: on,
      autoGainControl: on,
      ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
    };
  }

  private attachStream(stream: MediaStream): void {
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.output);
    for (const t of stream.getAudioTracks()) t.addEventListener("ended", this.onTrackEnded);
  }

  private detachStream(stopTracks: boolean): void {
    const stream = this.stream;
    this.source?.disconnect();
    this.source = null;
    this.stream = null;
    if (!stream) return;
    for (const t of stream.getAudioTracks()) {
      t.removeEventListener("ended", this.onTrackEnded);
      if (stopTracks) t.stop();
    }
  }

  private setState(state: LiveInputState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.listeners]) listener(this);
  }

  private fail(error: LiveAudioError): void {
    this.error = error;
    this.close();
  }

  private close(): void {
    if (this.state === "stopped") return;
    this.generation++;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.ctx.removeEventListener("statechange", this.onContextState);
    this.disarm();
    this.detachStream(this.own);
    this.tap?.dispose();
    this.tap = null;
    this.output.disconnect();
    this.setState("stopped");
  }

  private readonly onTrackEnded = (): void => {
    if (this.state === "stopped" || !this.stream) return;
    if (!this.stream.getAudioTracks().every((t) => t.readyState === "ended")) return;
    this.fail(
      new LiveAudioError(
        "ended",
        this.own
          ? "The microphone stopped: it was unplugged, or its permission was withdrawn."
          : "The audio stream ended.",
      ),
    );
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      if (
        this.own &&
        this.releaseWhenHidden &&
        (this.state === "running" || this.state === "suspended")
      ) {
        this.disarm();
        this.detachStream(true);
        this.setState("paused");
      }
    } else if (this.state === "paused") void this.reopen();
    else if (this.state === "suspended") this.tryResume();
  };

  /** Opens the microphone again after the page was hidden. */
  private async reopen(): Promise<void> {
    const generation = ++this.generation;
    this.setState("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: this.constraints() });
    } catch (e) {
      if (generation === this.generation) this.fail(liveAudioError(e));
      return;
    }
    if (generation !== this.generation || this.state !== "starting") {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.attachStream(stream);
    this.updateRunning();
    if (document.visibilityState === "hidden") this.onVisibility();
  }

  private readonly onContextState = (): void => this.updateRunning();

  private updateRunning(): void {
    if (!this.source || this.state === "stopped" || this.state === "paused") return;
    const s = this.ctx.state as string; // Safari also reports "interrupted"
    if (s === "running") {
      this.disarm();
      this.setState("running");
    } else if (s === "closed") {
      this.fail(new LiveAudioError("failed", "The audio context was closed."));
    } else {
      this.setState("suspended");
      this.arm();
    }
  }

  /** Resumes the audio context on the next gesture. */
  private arm(): void {
    if (this.unarm) return;
    const resume = () => this.tryResume();
    for (const type of GESTURES)
      window.addEventListener(type, resume, { capture: true, passive: true });
    this.unarm = () => {
      for (const type of GESTURES) window.removeEventListener(type, resume, { capture: true });
    };
    this.tryResume();
  }

  private disarm(): void {
    this.unarm?.();
    this.unarm = null;
  }

  private tryResume(): void {
    const s = this.ctx.state as string;
    if (s !== "running" && s !== "closed") void this.ctx.resume().catch(() => {});
  }
}

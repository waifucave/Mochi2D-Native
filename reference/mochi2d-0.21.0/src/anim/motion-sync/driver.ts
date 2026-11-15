/**
 * Motion sync at runtime: a sound or a live input bound to one setting of a
 * model's motion-sync file drives that setting's parameters.
 *
 * Each frame, for the bound setting:
 *
 * 1. **Audio.** A sound advances to its playback position (the clock given at
 *    binding, else the sum of the frames' steps); a live input hands over the
 *    samples captured since the previous frame.
 * 2. **Tick.** The setting's clock decides whether the frame analyzes
 *    (`TickClock`: at most once per frame, every 1/SampleRate).
 * 3. **Analysis** (analysis.ts). A sound is analyzed ahead of its playback:
 *    the window is centered on the sample being played, so the mouth is not
 *    late. A live input's window ends at its newest sample.
 * 4. **Engine** ({@link SettingEngine}): the gate, `Enabled`, `Scale`, the
 *    weights normalized, the blend by `BlendRatio`, the shape, and a
 *    non-linear smoothing (slew limits) set by `Smoothing`.
 * 5. **Filter** (parameter-filter.ts): the file's per-parameter smoothing and
 *    dead band.
 * 6. **Write.** Each resolved driven parameter takes D_k, every frame once the
 *    setting has a result, replacing what it held (the parameter's range
 *    applies).
 *
 * When a sound ends, the setting is fed silence until every parameter is
 * within its `Damper` of the Silence shape, or for 0.5 s, and then stops
 * writing: the parameters show what motions give them again. A sound stopped
 * early (its motion replaced or faded out) fades over the given time first.
 * Only the bound setting writes. Binding another setting starts it from the
 * parameters' current values; consecutive sounds on the same setting carry
 * its state over, so the mouth stays continuous.
 */
import type { AnimationValues } from "../values.js";
import {
  ANALYSIS_RATE,
  ANALYSIS_WINDOW,
  Resampler,
  VowelAnalyzer,
  soundStatistics,
  toAnalysisRate,
  type Analysis,
  type AnalyzerOptions,
  type SoundStatistics,
  type VoiceProfile,
} from "./analysis.js";
import { MOTION_SYNC_ELEMENTS, type MotionSyncFile, type MotionSyncSetting } from "./file.js";
import { ParameterFilter, TickClock } from "./parameter-filter.js";

/** A decoded sound: channels of samples in [−1, 1] at `sampleRate`. */
export interface MotionSyncSound {
  sampleRate: number;
  channels: readonly ArrayLike<number>[];
}

/**
 * A sound's playback position, seconds, from the app's audio clock; null
 * when there is no clock (the position then advances by the frames' steps).
 * Return 0 until the audio starts, so the mouth waits for it.
 */
export type MotionSyncClock = () => number | null;

/** A live audio input (a microphone, a stream): mono samples as they arrive. */
export interface MotionSyncInput {
  readonly sampleRate: number;
  /** The samples captured since the previous call (mono), possibly none. */
  read(): ArrayLike<number>;
}

/** What the bound setting reported at its latest tick. */
export interface MotionSyncTick {
  /** The setting's dictionary name and ID. */
  setting: { name: string; id: string };
  source: "sound" | "live";
  /** The analysis window's level, dBFS. */
  level: number;
  /** The gate found the window silent. */
  silent: boolean;
  /**
   * The element weights after the gate, `Enabled` and `Scale`, normalized to
   * sum to 1 (Silence, A, I, U, E, O; elements the setting lacks are 0).
   */
  weights: Record<(typeof MOTION_SYNC_ELEMENTS)[number], number>;
  /** The driven parameters' values written from this tick on, by ID. */
  values: Record<string, number>;
  /** Seconds of the sound played (live: of input received). */
  time: number;
}

export interface MotionSyncDriverOptions extends AnalyzerOptions {
  /**
   * The file's per-parameter smoothing (`Smooth`), a fixed linear filter.
   * Default false (since 0.20.0): the analysis's own smoothing (the
   * setting's `Smoothing`) shapes the motion, and the dead band (`Damper`)
   * stays. true applies the file's `Smooth` too.
   */
  fileSmoothing?: boolean;
  /** Seconds of silence fed after a sound ends, at most. Default 0.5. */
  settleTime?: number;
}

const SILENCE = 0;

/**
 * Steps 1–7 of Mochi2D's engine for one setting: from raw element weights
 * to one value per driven parameter. The smoothing (step 7) limits how fast
 * each value moves: towards a shape further from the Silence shape at its
 * attack rate, back at its release rate, both in units of the parameter's
 * span per second. `Smoothing` 1 gives a full swing in 20 ms, 100 in 0.5 s
 * (release 1.5 times slower). It is non-linear: no fixed impulse response.
 */
export class SettingEngine {
  /** Element weights p_e (after normalization), in the setting's element order. */
  readonly weights: Float64Array;
  /** Engine outputs y_k. */
  readonly values: Float64Array;
  private started = false;
  private readonly span: Float64Array;
  private readonly rest: Float64Array;
  private readonly slot: Int32Array;

  constructor(readonly setting: MotionSyncSetting) {
    const P = setting.parameters.length;
    this.weights = new Float64Array(setting.elements.length);
    this.values = new Float64Array(P);
    this.slot = Int32Array.from(setting.elements, (e) =>
      e.known ? (MOTION_SYNC_ELEMENTS as readonly string[]).indexOf(e.id) : -1,
    );
    this.span = Float64Array.from({ length: P }, (_, k) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of setting.shapes) {
        lo = Math.min(lo, s[k]!);
        hi = Math.max(hi, s[k]!);
      }
      return hi > lo ? hi - lo : 0;
    });
    const silence = setting.elements.findIndex((e) => e.id === "Silence");
    this.rest = Float64Array.from({ length: P }, (_, k) =>
      silence >= 0 ? setting.shapes[silence]![k]! : 0,
    );
  }

  /** Forgets the smoothing state: the next step starts from its own shape. */
  reset(): void {
    this.started = false;
  }

  /** One tick of `dt` seconds with the analysis `a`. */
  step(a: Analysis, dt: number): void {
    const s = this.setting;
    const E = s.elements.length;
    const p = this.weights;
    // 1–3: the gate, Enabled (and unknown elements), Scale.
    let sum = 0;
    for (let e = 0; e < E; e++) {
      const el = s.elements[e]!;
      const slot = this.slot[e]!;
      let r = slot < 0 || !el.enabled ? 0 : a.silent ? (slot === SILENCE ? 1 : 0) : a.raw[slot]!;
      r *= el.scale;
      p[e] = r;
      sum += r;
    }
    // 4: normalized; with nothing left, the Silence element alone.
    if (sum > 0) for (let e = 0; e < E; e++) p[e] = p[e]! / sum;
    else for (let e = 0; e < E; e++) p[e] = s.elements[e]!.id === "Silence" ? 1 : 0;
    // 5: the most likely element (ties: the earlier), blended with the weights.
    let best = -1;
    for (let e = 0; e < E; e++) if (best < 0 || p[e]! > p[best]!) best = e;
    const br = s.blendRatio;
    // 6: the shape.
    for (let k = 0; k < s.parameters.length; k++) {
      let v = 0;
      for (let e = 0; e < E; e++) {
        const q = br * p[e]! + (e === best ? 1 - br : 0);
        v += q * s.shapes[e]![k]!;
      }
      // 7: slew limits.
      if (!this.started) {
        this.values[k] = v;
        continue;
      }
      const u = this.values[k]!;
      const x = (s.smoothing - 1) / 99;
      const attack = 0.02 * 25 ** x;
      const release = 1.5 * attack;
      const rest = this.rest[k]!;
      const opening = Math.abs(v - rest) > Math.abs(u - rest);
      const limit = this.span[k]! * (Math.max(0, dt) / (opening ? attack : release));
      this.values[k] = u + Math.min(limit, Math.max(-limit, v - u));
    }
    this.started = true;
  }
}

/** The state that a setting keeps between the sounds bound to it. */
interface SettingState {
  setting: MotionSyncSetting;
  /** Model parameter index per driven parameter, −1 when the model lacks it. */
  targets: Int32Array;
  clock: TickClock;
  engine: SettingEngine;
  filter: ParameterFilter;
  analyzer: VowelAnalyzer;
  hasResult: boolean;
  /** Reset from the current parameter values at the next frame. */
  fresh: boolean;
  /** Seconds since the previous tick (the time a tick's analysis covers). */
  sinceTick: number;
}

interface SoundBinding {
  kind: "sound";
  sound: MotionSyncSound;
  signal: Float32Array;
  sourceRate: number;
  sourceFrames: number;
  clock: MotionSyncClock | null;
  time: number;
  consumed: number;
  fade: { from: number; seconds: number } | null;
}

interface LiveBinding {
  kind: "live";
  input: MotionSyncInput;
  resampler: Resampler | null;
  /** The newest samples at the analysis rate (the last window's worth). */
  recent: Float32Array;
  time: number;
}

/** Each sound's signal at the analysis rate, and its statistics per gate. */
const signals = new WeakMap<
  MotionSyncSound,
  { signal: Float32Array; statistics: Map<number, SoundStatistics> }
>();

/** Runs a model's motion sync (see the module comment). */
export class MotionSyncDriver {
  private readonly states = new Map<number, SettingState>();
  private bound: SettingState | null = null;
  private binding: SoundBinding | LiveBinding | null = null;
  /** Seconds of silence fed since the sound ended, or −1 while it plays. */
  private settling = -1;
  private latest: MotionSyncTick | null = null;
  private readonly listeners = new Set<(tick: MotionSyncTick) => void>();
  /** Warnings from resolving settings against the model. */
  readonly warnings: string[] = [];
  /** Source samples of the bound sound consumed so far (sample accounting). */
  consumed = 0;
  profile: VoiceProfile | null;

  constructor(
    readonly file: MotionSyncFile,
    private readonly values: AnimationValues,
    readonly options: MotionSyncDriverOptions = {},
  ) {
    this.profile = options.profile ?? null;
  }

  /** The setting that writes, or null. */
  get setting(): MotionSyncSetting | null {
    return this.bound?.setting ?? null;
  }

  /** The bound setting's driven parameter IDs (for lip sync to leave alone). */
  get drivenIds(): readonly string[] {
    return this.bound?.setting.parameters.map((p) => p.id) ?? [];
  }

  /** The latest tick of the bound setting, or null before its first. */
  get tick(): MotionSyncTick | null {
    return this.latest;
  }

  /** Calls `listener` after every tick; returns a function that removes it. */
  onTick(listener: (tick: MotionSyncTick) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sets the voice profile of every setting's analysis (null: the neutral voice). */
  setProfile(profile: VoiceProfile | null): void {
    this.profile = profile;
    for (const s of this.states.values()) s.analyzer.profile = profile;
  }

  private state(setting: MotionSyncSetting): SettingState {
    let st = this.states.get(setting.index);
    if (st) return st;
    const v = this.values;
    const targets = Int32Array.from(setting.parameters, (p) => {
      const i = v.index(p.id);
      if (i < 0)
        this.warnings.push(
          `${this.file.label}: "${setting.name || setting.id}" drives ${p.id}, which the model lacks; it is not written`,
        );
      else if (p.min !== v.min[i] || p.max !== v.max[i])
        this.warnings.push(
          `${this.file.label}: "${setting.name || setting.id}" gives ${p.id} the range [${p.min}, ${p.max}], the model [${v.min[i]}, ${v.max[i]}]; driven anyway`,
        );
      return i;
    });
    const analyzerOptions: AnalyzerOptions = { profile: this.profile };
    if (this.options.gate !== undefined) analyzerOptions.gate = this.options.gate;
    if (this.options.hangover !== undefined) analyzerOptions.hangover = this.options.hangover;
    st = {
      setting,
      targets,
      clock: new TickClock(setting.sampleRate),
      engine: new SettingEngine(setting),
      filter: new ParameterFilter(
        Float64Array.from(setting.parameters, (p) => p.smooth),
        Float64Array.from(setting.parameters, (p) => p.damper),
        this.options.fileSmoothing ?? false,
      ),
      analyzer: new VowelAnalyzer(analyzerOptions),
      hasResult: false,
      fresh: true,
      sinceTick: 0,
    };
    this.states.set(setting.index, st);
    return st;
  }

  private bind(setting: MotionSyncSetting): SettingState | null {
    if (!setting.usable) return null;
    const st = this.state(setting);
    if (this.bound !== st) {
      // Another setting: it starts afresh from the parameters' current values.
      st.fresh = true;
      st.hasResult = false;
      st.clock.time = 0;
      st.sinceTick = 0;
      st.engine.reset();
      st.analyzer.reset();
    }
    this.bound = st;
    this.settling = -1;
    this.latest = null;
    return st;
  }

  /**
   * Binds a decoded sound to `setting`, from its start. `clock` gives the
   * playback position (an audio clock); without one, the position is the
   * sum of the frames' steps. Returns false for an unusable setting.
   */
  playSound(
    setting: MotionSyncSetting,
    sound: MotionSyncSound,
    clock: MotionSyncClock | null = null,
  ): boolean {
    const st = this.bind(setting);
    if (!st) return false;
    let cached = signals.get(sound);
    if (!cached) {
      cached = { signal: toAnalysisRate(sound.channels, sound.sampleRate), statistics: new Map() };
      signals.set(sound, cached);
    }
    const { signal } = cached;
    // The sound's own reference level and noise, found ahead of playback.
    const gate = st.analyzer.gate;
    let stats = cached.statistics.get(gate);
    if (!stats) {
      stats = soundStatistics(signal, gate);
      cached.statistics.set(gate, stats);
    }
    st.analyzer.reference = stats.reference;
    st.analyzer.noise = stats.noise;
    this.binding = {
      kind: "sound",
      sound,
      signal,
      sourceRate: sound.sampleRate,
      sourceFrames: sound.channels[0]?.length ?? 0,
      clock,
      time: 0,
      consumed: 0,
      fade: null,
    };
    this.consumed = 0;
    return true;
  }

  /** Binds a live input to `setting`. Returns false for an unusable setting. */
  setInput(setting: MotionSyncSetting, input: MotionSyncInput): boolean {
    const st = this.bind(setting);
    if (!st) return false;
    // The reference level and the noise follow the input.
    st.analyzer.reference = null;
    st.analyzer.noise = null;
    this.binding = {
      kind: "live",
      input,
      resampler:
        input.sampleRate === ANALYSIS_RATE ? null : new Resampler(input.sampleRate, ANALYSIS_RATE),
      recent: new Float32Array(ANALYSIS_WINDOW),
      time: 0,
    };
    return true;
  }

  /** The sound or live input bound, or null. */
  get source(): MotionSyncSound | MotionSyncInput | null {
    const b = this.binding;
    return b ? (b.kind === "sound" ? b.sound : b.input) : null;
  }

  /** A sound is bound and playing (not yet settling). */
  get playing(): boolean {
    return this.binding !== null && this.settling < 0;
  }

  /**
   * Ends the sound or input: the setting is fed silence until it settles, and
   * then stops writing. With `fade` > 0, a sound fades out over that many
   * seconds first.
   */
  stop(fade = 0): void {
    const b = this.binding;
    if (!b) return;
    if (b.kind === "sound" && fade > 0 && this.settling < 0) {
      b.fade = { from: b.time, seconds: fade };
      return;
    }
    if (this.settling < 0) this.settling = 0;
  }

  /** Stops writing at once. */
  clear(): void {
    this.binding = null;
    this.bound = null;
    this.settling = -1;
    this.latest = null;
  }

  /** One frame of step `dt`: audio, tick, analysis, engine, filter, write. */
  frame(dt: number): void {
    const st = this.bound;
    const b = this.binding;
    if (!st || !b) return;
    const v = this.values;
    if (st.fresh) {
      st.filter.reset(Array.from(st.targets, (i) => (i >= 0 ? v.values[i]! : 0)));
      st.fresh = false;
    }
    const step = dt > 0 ? dt : 0;
    let signal: ArrayLike<number> = b.kind === "sound" ? b.signal : b.recent;
    let start = 0;
    let gain = 1;
    if (b.kind === "sound") {
      const before = b.time;
      const position = b.clock?.() ?? null;
      b.time = position === null ? b.time + step : Math.max(b.time, position);
      const was = Math.min(b.sourceFrames, Math.round(before * b.sourceRate));
      const now = Math.min(b.sourceFrames, Math.round(b.time * b.sourceRate));
      b.consumed += now - was;
      this.consumed = b.consumed;
      if (b.fade) gain = Math.max(0, 1 - (b.time - b.fade.from) / b.fade.seconds);
      if (this.settling < 0 && (now >= b.sourceFrames || gain <= 0)) this.settling = 0;
      start = Math.round(b.time * ANALYSIS_RATE) - ANALYSIS_WINDOW / 2;
    } else {
      const fresh = b.input.read();
      const add = b.resampler ? b.resampler.push(fresh) : Float32Array.from(fresh);
      b.time += fresh.length / b.input.sampleRate;
      if (add.length >= ANALYSIS_WINDOW) b.recent = add.slice(add.length - ANALYSIS_WINDOW);
      else if (add.length > 0) {
        const r = new Float32Array(ANALYSIS_WINDOW);
        r.set(b.recent.subarray(add.length));
        r.set(add, ANALYSIS_WINDOW - add.length);
        b.recent = r;
      }
      signal = b.recent;
    }
    if (this.settling >= 0) {
      this.settling += step;
      signal = SILENT;
      start = 0;
      gain = 1;
    }
    st.sinceTick += step;
    if (st.clock.advance(dt)) {
      const h = st.sinceTick;
      st.sinceTick = 0;
      const a = st.analyzer.analyze(signal, start, h);
      if (gain < 1) {
        a.level += 20 * Math.log10(gain);
        if (!(a.level >= st.analyzer.gate)) {
          a.silent = true;
          a.raw.fill(0);
          a.raw[SILENCE] = 1;
        }
      }
      st.engine.step(a, h);
      st.filter.step(st.engine.values);
      st.hasResult = true;
      this.report(st, a, b);
    }
    if (st.hasResult)
      st.targets.forEach((i, k) => {
        const d = st.filter.output[k]!;
        if (i >= 0 && !Number.isNaN(d)) v.setAt(i, d);
      });
    if (this.settling >= 0 && this.settled(st)) this.clear();
  }

  /** Every parameter within its Damper of the Silence shape, or the settle time is up. */
  private settled(st: SettingState): boolean {
    if (this.settling >= (this.options.settleTime ?? 0.5)) return true;
    const s = st.setting;
    const silence = s.elements.findIndex((e) => e.id === "Silence");
    return s.parameters.every((p, k) => {
      const rest = silence >= 0 ? s.shapes[silence]![k]! : 0;
      return Math.abs(st.filter.output[k]! - rest) <= p.damper;
    });
  }

  private report(st: SettingState, a: Analysis, b: SoundBinding | LiveBinding): void {
    const weights = Object.fromEntries(
      MOTION_SYNC_ELEMENTS.map((e) => [e, 0]),
    ) as MotionSyncTick["weights"];
    st.setting.elements.forEach((e, i) => {
      if (e.known) weights[e.id as keyof typeof weights] += st.engine.weights[i]!;
    });
    const values: Record<string, number> = {};
    st.setting.parameters.forEach((p, k) => (values[p.id] = st.filter.output[k]!));
    this.latest = {
      setting: { name: st.setting.name, id: st.setting.id },
      source: b.kind,
      level: a.level,
      silent: a.silent,
      weights,
      values,
      time: b.time,
    };
    for (const l of this.listeners) l(this.latest);
  }
}

const SILENT = new Float32Array(ANALYSIS_WINDOW);

/**
 * Audio panel: open an audio file or use the microphone, play sounds found in
 * the model folder, and show the per-frame loudness (RMS) envelope.
 *
 * While the microphone runs, it also drives lip sync (not reference
 * behavior): {@link AudioPanel.liveLipSync} is handed to the main
 * model, and the sliders set its sensitivity, noise gate, attack and
 * release (src/anim/live-lip-sync.ts). Audio is processed in memory only:
 * nothing is recorded, stored or sent anywhere.
 */
import { AudioInput, type LoudnessSample } from "../platform/audio-input.js";
import { liveAudioProblem, type LiveAudioInput } from "../platform/live-audio.js";
import { toDecibels } from "../core/audio/loudness.js";
import {
  LIVE_LIP_SYNC_DEFAULTS,
  LiveLipSync,
  type LiveLipSyncSettings,
} from "../anim/live-lip-sync.js";

/** Where the panel keeps its microphone settings between visits. */
export interface PanelStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

interface MicSlider {
  key: keyof LiveLipSyncSettings;
  label: string;
  title: string;
  min: number;
  max: number;
  step: number;
  /** Setting → slider position, and back. */
  toSlider(v: number): number;
  fromSlider(x: number): number;
  format(v: number): string;
}

const MIC_SLIDERS: MicSlider[] = [
  {
    key: "gain",
    label: "Sensitivity",
    title: "Multiplies the loudness above the noise gate (the gain)",
    min: 0,
    max: 40,
    step: 0.5,
    toSlider: (v) => 20 * Math.log10(Math.max(1, v)),
    fromSlider: (x) => 10 ** (x / 20),
    format: (v) => `×${v < 10 ? v.toFixed(1) : v.toFixed(0)}`,
  },
  {
    key: "gate",
    label: "Noise gate",
    title: "Loudness at or below this level (RMS, dBFS) keeps the mouth closed",
    min: -80,
    max: -20,
    step: 1,
    toSlider: (v) => Math.min(-20, Math.max(-80, v)),
    fromSlider: (x) => x,
    format: (v) => `${v.toFixed(0)} dB`,
  },
  {
    key: "attack",
    label: "Attack",
    title: "Time constant of the mouth opening",
    min: 0,
    max: 200,
    step: 5,
    toSlider: (v) => v * 1000,
    fromSlider: (x) => x / 1000,
    format: (v) => `${Math.round(v * 1000)} ms`,
  },
  {
    key: "release",
    label: "Release",
    title: "Time constant of the mouth closing",
    min: 0,
    max: 500,
    step: 10,
    toSlider: (v) => v * 1000,
    fromSlider: (x) => x / 1000,
    format: (v) => `${Math.round(v * 1000)} ms`,
  },
];

const STORE_KEY = "micLipSync";

/** What to do on a page where browsers do not offer the microphone. */
export function insecureMicrophoneMessage(loc: Location = location): string {
  const local = `${loc.protocol}//localhost${loc.port ? `:${loc.port}` : ""}${loc.pathname}`;
  return (
    `The microphone needs a secure page. This page is ${loc.origin}, and browsers offer the ` +
    `microphone only on HTTPS pages or on localhost. To use it on this device, open the ` +
    `viewer over HTTPS: for example, a static build (npm run build:static) on an HTTPS host. ` +
    `On the computer that runs the viewer, ${local} works.`
  );
}

export class AudioPanel {
  readonly input = new AudioInput();
  readonly element: HTMLElement;
  /** Live lip sync from the microphone; it is fed while the microphone runs. */
  readonly lip: LiveLipSync;
  private readonly meterRms: HTMLElement;
  private readonly meterEnv: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly nowPlaying: HTMLElement;
  private readonly folderList: HTMLElement;
  private readonly loop: HTMLInputElement;
  private readonly micButton: HTMLButtonElement;
  private readonly micNote: HTMLElement;
  private readonly mouthMeter: HTMLElement;
  private readonly mouthReadout: HTMLElement;
  private readonly processing: HTMLInputElement;
  private readonly sliders = new Map<keyof LiveLipSyncSettings, HTMLInputElement>();
  private readonly outputs = new Map<keyof LiveLipSyncSettings, HTMLOutputElement>();
  last: LoudnessSample | null = null;
  /** Called when a sound file starts playing, with its bytes (for lip sync). */
  onPlay: ((label: string, bytes: Uint8Array) => void) | null = null;
  /** Called when playback is stopped or the microphone starts. */
  onStop: (() => void) | null = null;
  /** Called with the live lip sync when the microphone starts, and with null when it stops. */
  onLiveLipSync: ((lip: LiveLipSync | null) => void) | null = null;
  /** What lip sync drives on the model (a note under the sliders), or null when it cannot. */
  lipSyncNote: () => string | null = () => null;
  /** Which lip sync drives the mouth now, in words (shown at the top of the panel). */
  activeNote: () => string = () => "";
  private readonly activeLine: HTMLElement;
  private shownState = "";
  private mouthAccum = 0;

  constructor(
    private readonly setStatus: (text: string, error?: boolean) => void,
    private readonly store: PanelStore | null = null,
  ) {
    const saved = this.loadSettings();
    this.lip = new LiveLipSync(48000, saved);
    this.input.voiceProcessing = saved.voiceProcessing;
    const root = document.createElement("div");
    root.className = "audio-panel";
    root.innerHTML = `
      <p class="active-lipsync" aria-live="polite"></p>
      <div class="row">
        <label class="btn small">Open audio…<input type="file" accept="audio/*,.wav,.mp3,.ogg" hidden /></label>
        <button type="button" class="btn small" data-act="mic">Microphone</button>
        <button type="button" class="btn small" data-act="stop">Stop</button>
        <label class="check"><input type="checkbox" data-act="loop" /> loop</label>
      </div>
      <div class="now-playing empty">Idle</div>
      <div class="meter" role="meter" aria-label="Loudness" aria-valuemin="0" aria-valuemax="1">
        <div class="meter-rms"></div><div class="meter-env"></div>
      </div>
      <div class="mono readout">–</div>
      <div class="mic-lipsync">
        <div class="mic-title">Microphone lip sync</div>
        <div class="slider-rows mic-sliders"></div>
        <label class="check" title="The browser's echo cancellation, noise suppression and automatic gain control"><input type="checkbox" data-act="processing" /> voice processing</label>
        <div class="meter mouth" role="meter" aria-label="Mouth" aria-valuemin="0" aria-valuemax="1">
          <div class="meter-rms"></div>
        </div>
        <div class="mono readout mic-readout">–</div>
        <div class="empty mic-note"></div>
      </div>
      <div class="folder-sounds"></div>`;
    this.element = root;
    this.activeLine = root.querySelector(".active-lipsync")!;
    this.meterRms = root.querySelector(".meter:not(.mouth) .meter-rms")!;
    this.meterEnv = root.querySelector(".meter-env")!;
    this.readout = root.querySelector(".readout")!;
    this.nowPlaying = root.querySelector(".now-playing")!;
    this.folderList = root.querySelector(".folder-sounds")!;
    this.loop = root.querySelector('[data-act="loop"]')!;
    this.micButton = root.querySelector('[data-act="mic"]')!;
    this.micNote = root.querySelector(".mic-note")!;
    this.mouthMeter = root.querySelector(".meter.mouth .meter-rms")!;
    this.mouthReadout = root.querySelector(".mic-readout")!;
    this.processing = root.querySelector('[data-act="processing"]')!;
    this.processing.checked = saved.voiceProcessing;
    this.processing.addEventListener("change", () => void this.setProcessing());
    this.buildSliders(root.querySelector(".mic-sliders")!);
    const file = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (f) void this.play(f.name, async () => new Uint8Array(await f.arrayBuffer()));
      file.value = "";
    });
    this.micButton.addEventListener("click", () => void this.toggleMic());
    root.querySelector('[data-act="stop"]')!.addEventListener("click", () => {
      this.input.stop();
      this.onStop?.();
      this.updateLabel();
    });
    this.input.onEnded = () => this.updateLabel();
    this.input.onMicrophoneState = (live) => this.microphoneState(live);
    const problem = liveAudioProblem();
    if (problem) {
      this.micButton.title =
        problem.code === "insecure-context" ? insecureMicrophoneMessage() : problem.message;
      this.micButton.classList.add("unavailable");
      this.micNote.textContent = this.micButton.title;
    }
  }

  /** The live lip sync while the microphone runs, else null. */
  get liveLipSync(): LiveLipSync | null {
    return this.input.live ? this.lip : null;
  }

  // ------------------------------------------------------------ settings

  private loadSettings(): LiveLipSyncSettings & { voiceProcessing: boolean } {
    const out = { ...LIVE_LIP_SYNC_DEFAULTS, voiceProcessing: true };
    try {
      const raw = JSON.parse(this.store?.get(STORE_KEY) ?? "null") as Record<
        string,
        unknown
      > | null;
      for (const key of ["gain", "gate", "attack", "release"] as const) {
        const v = raw?.[key];
        if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
      }
      if (typeof raw?.voiceProcessing === "boolean") out.voiceProcessing = raw.voiceProcessing;
    } catch {
      // ignore a broken entry
    }
    return out;
  }

  private saveSettings(): void {
    this.store?.set(
      STORE_KEY,
      JSON.stringify({ ...this.lip.settings, voiceProcessing: this.processing.checked }),
    );
  }

  private buildSliders(container: HTMLElement): void {
    for (const s of MIC_SLIDERS) {
      const row = document.createElement("div");
      row.className = "slider-row";
      row.title = s.title;
      const label = document.createElement("label");
      label.textContent = s.label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step);
      input.dataset.mic = s.key;
      input.setAttribute("aria-label", s.label);
      label.htmlFor = input.id = `mic-${s.key}`;
      const output = document.createElement("output");
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "reset";
      reset.textContent = "↺";
      reset.title = `Default: ${s.format(LIVE_LIP_SYNC_DEFAULTS[s.key])}`;
      input.addEventListener("input", () => {
        this.lip.settings[s.key] = s.fromSlider(Number(input.value));
        this.showSetting(s);
        this.saveSettings();
      });
      reset.addEventListener("click", () => {
        this.lip.settings[s.key] = LIVE_LIP_SYNC_DEFAULTS[s.key];
        this.showSetting(s);
        this.saveSettings();
      });
      row.append(label, input, output, reset);
      container.append(row);
      this.sliders.set(s.key, input);
      this.outputs.set(s.key, output);
      this.showSetting(s);
    }
  }

  private showSetting(s: MicSlider): void {
    const v = this.lip.settings[s.key];
    this.sliders.get(s.key)!.value = String(s.toSlider(v));
    this.outputs.get(s.key)!.textContent = s.format(v);
  }

  /** Sets the lip-sync settings (from code or a test); missing keys keep their values. */
  setLipSyncSettings(settings: Partial<LiveLipSyncSettings>): void {
    for (const s of MIC_SLIDERS) {
      const v = settings[s.key];
      if (v === undefined) continue;
      this.lip.settings[s.key] = v;
      this.showSetting(s);
    }
    this.saveSettings();
  }

  private async setProcessing(): Promise<void> {
    this.input.voiceProcessing = this.processing.checked;
    this.saveSettings();
    // Reopen a running microphone with the new constraints.
    if (this.input.kind === "microphone") {
      this.stopMicrophone();
      await this.toggleMic();
    }
  }

  // --------------------------------------------------------------- sounds

  /** Lists sound files of the loaded model folder with play buttons. */
  setFolderSounds(paths: readonly string[], read: (path: string) => Promise<Uint8Array>): void {
    this.folderList.replaceChildren();
    if (paths.length === 0) return;
    const title = document.createElement("div");
    title.className = "empty";
    title.textContent = "Sounds in the model folder:";
    this.folderList.append(title);
    for (const p of paths) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link";
      b.textContent = `▶ ${p}`;
      b.title = p;
      b.addEventListener("click", () => void this.play(p, () => read(p)));
      this.folderList.append(b);
    }
  }

  /** Plays a sound given as bytes (e.g. a motion's sound); lip sync starts through onPlay. */
  playBytes(label: string, bytes: Uint8Array): Promise<void> {
    return this.play(label, async () => bytes);
  }

  private async play(label: string, bytes: () => Promise<Uint8Array>): Promise<void> {
    try {
      const data = await bytes();
      // Playing a file stops the microphone (and its lip sync, via microphoneState).
      await this.input.playFile(data, label, { loop: this.loop.checked });
      this.onPlay?.(label, data);
      this.updateLabel();
    } catch (e) {
      this.setStatus(`Audio: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  // ----------------------------------------------------------- microphone

  private async toggleMic(): Promise<void> {
    if (this.input.kind === "microphone") {
      this.stopMicrophone();
      return;
    }
    const problem = liveAudioProblem();
    if (problem) {
      const text =
        problem.code === "insecure-context" ? insecureMicrophoneMessage() : problem.message;
      this.micNote.textContent = text;
      this.setStatus(`Microphone: ${text}`, true);
      return;
    }
    try {
      const live = await this.input.startMicrophone();
      this.onStop?.();
      this.lip.reset();
      live.addSink(this.lip);
      this.onLiveLipSync?.(this.lip);
      this.micNote.textContent = "";
      this.updateLabel();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      this.micNote.textContent = text;
      this.setStatus(`Microphone: ${text}`, true);
      this.updateLabel();
    }
  }

  /** Stops the microphone; its lip sync stops through {@link microphoneState}. */
  private stopMicrophone(): void {
    this.input.stop();
    this.updateLabel();
  }

  private microphoneState(live: LiveAudioInput): void {
    if (live.state === "stopped") {
      if (live.error) {
        this.micNote.textContent = live.error.message;
        this.setStatus(`Microphone: ${live.error.message}`, true);
      }
      if (!this.input.live) {
        this.lip.reset();
        this.onLiveLipSync?.(null);
      }
    }
    this.updateLabel();
  }

  private updateLabel(): void {
    const k = this.input.kind;
    const state = this.input.live?.state ?? "";
    this.shownState = `${k}|${this.input.label}|${state}`;
    let text = "Idle";
    if (k === "file") text = `Playing: ${this.input.label}`;
    else if (k === "microphone")
      text =
        state === "suspended"
          ? "Microphone waiting: tap or click anywhere to resume the audio"
          : state === "paused"
            ? "Microphone released while the page is hidden"
            : state === "starting"
              ? "Opening the microphone…"
              : `Listening: ${this.input.label}`;
    this.nowPlaying.textContent = text;
    this.nowPlaying.classList.toggle("empty", k === "none");
    this.micButton.classList.toggle("active", k === "microphone");
  }

  // ---------------------------------------------------------------- frames

  /** Call once per frame. */
  update(dt: number): LoudnessSample {
    const s = this.input.sample(dt);
    this.last = s;
    if (
      `${this.input.kind}|${this.input.label}|${this.input.live?.state ?? ""}` !== this.shownState
    )
      this.updateLabel();
    const pct = (v: number) => `${Math.min(100, v * 141.42).toFixed(1)}%`; // full-scale sine → 100 %
    this.meterRms.style.width = pct(s.rms);
    this.meterEnv.style.left = pct(s.envelope);
    this.element.querySelector(".meter")!.setAttribute("aria-valuenow", s.envelope.toFixed(3));
    this.readout.textContent =
      s.kind === "none"
        ? "–"
        : `rms ${s.rms.toFixed(3)} (${toDecibels(s.rms).toFixed(1)} dBFS) · env ${s.envelope.toFixed(3)} · t ${s.time.toFixed(2)} s`;
    const live = this.liveLipSync;
    const mouth = live ? live.value : 0;
    this.mouthMeter.style.width = `${Math.min(100, mouth * 100).toFixed(1)}%`;
    this.mouthAccum += dt;
    if (this.mouthAccum >= 0.1 || !live) {
      this.mouthAccum = 0;
      this.activeLine.textContent = this.activeNote();
      const note = this.lipSyncNote();
      this.mouthReadout.textContent = live
        ? `level ${toDecibels(live.level).toFixed(1)} dBFS · gate ${live.settings.gate.toFixed(0)} dBFS → lip sync ${mouth.toFixed(2)}${note ? ` · ${note}` : ""}`
        : (note ?? "Press Microphone: the mouth follows your voice.");
    }
    return s;
  }
}

/**
 * The viewer's animation controls:
 *
 * - the Animation menu: feature toggles for expressions, blinking, physics,
 *   pose switching, motion sync, idle motion, cursor tracking, breathing,
 *   parameter repetition and lip sync;
 * - a status line of what plays;
 * - playing motions and expressions from the resource tree (answer Q8:
 *   priority 2; the settings' fades, else the file's; an expression without
 *   fades fades over the viewer's 500 ms);
 * - notes about the loaded model, for the model settings view;
 * - the hit-area overlay (3t).
 */
import { skippedSoundReason, skippedSoundWarning } from "../anim/sound-format.js";
import type { FileSource } from "../core/io/file-source.js";
import type { EffectName } from "../runtime/model-runtime.js";
import { parseMotion } from "../anim/motion.js";
import { parseExpression } from "../anim/expression.js";
import type { SliderList } from "./controls/slider-list.js";
import { LiveModel } from "../lib/live-model.js";
import type { StageModel } from "../lib/stage-model.js";
import { DEFAULT_FADES } from "./settings-views.js";

export interface AnimationUiOptions {
  setStatus(text: string, error?: boolean): void;
  model(): StageModel | null;
  /** Plays a sound audibly; the audio panel's hook then starts lip sync. */
  playSound(label: string, bytes: Uint8Array): void;
  parameterList(): SliderList | null;
  /** The Animation menu's popup. */
  menu: HTMLElement;
  /** Where the status line goes. */
  status: HTMLElement;
  /** Whether hit areas are outlined (the Display menu). */
  showHitAreas(): boolean;
  overlay: HTMLCanvasElement;
  canvas: HTMLCanvasElement;
}

/** A toggle of the Animation menu: an effect switch, or parameter repetition (wrap mode). */
type Toggle = { key: EffectName | "wrap"; label: string; title: string };

const TOGGLES: Toggle[] = [
  { key: "expressions", label: "Expressions", title: "Expressions play over the motions" },
  {
    key: "eyeBlink",
    label: "Automatic blinking",
    title: "Automatic blinking of the EyeBlink parameters",
  },
  { key: "physics", label: "Physics", title: "Pendulum physics from the model's physics file" },
  { key: "pose", label: "Pose switching", title: "One part visible per pose group" },
  {
    key: "motionSync",
    label: "Motion sync",
    title: "Sounds bound to a motion-sync setting drive the mouth (Mochi2D's own analysis)",
  },
  { key: "idle", label: "Idle motion", title: 'The "Idle" group plays when no motion does' },
  {
    key: "look",
    label: "Cursor tracking",
    title: "Dragging on the model turns the head and body toward the cursor",
  },
  {
    key: "breath",
    label: "Breathing",
    title: "The breath cycle on the angle and breath parameters",
  },
  {
    key: "wrap",
    label: "Parameter repetition",
    title: "Values of repeating parameters wrap around their range instead of stopping at its ends",
  },
  {
    key: "lipSync",
    label: "Lip sync",
    title:
      "A WAV file or the microphone moves the lip-sync parameters by its volume (Lip sync panel)",
  },
];

const short = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export class AnimationUi {
  private source: FileSource | null = null;
  private readonly boxes = new Map<Toggle["key"], HTMLInputElement>();

  constructor(private readonly opts: AnimationUiOptions) {
    const root = opts.menu;
    root.replaceChildren();
    for (const t of TOGGLES) {
      const label = document.createElement("label");
      label.className = "menu-item check";
      label.title = t.title;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.effect = t.key;
      box.addEventListener("change", () => {
        const m = this.live();
        if (!m) return;
        if (t.key === "wrap") m.runtime.animator.values.wrap = box.checked;
        else m.runtime.setEffect(t.key, box.checked);
        this.updateNotes();
      });
      label.append(box, ` ${t.label}`);
      root.append(label);
      this.boxes.set(t.key, box);
    }
    this.attach(null);
  }

  private live(): LiveModel | null {
    const m = this.opts.model();
    return m instanceof LiveModel ? m : null;
  }

  /** Where motion and expression files are read from. */
  setSource(source: FileSource | null): void {
    this.source = source;
  }

  /** Shows a newly loaded model's state in the controls. */
  attach(m: LiveModel | null): void {
    for (const [key, box] of this.boxes) {
      const available = !!m && (key === "wrap" || m.runtime.effectAvailable(key));
      box.disabled = !available;
      box.checked = !!m && this.isOn(m, key);
      box.parentElement!.classList.toggle("unavailable", !available);
    }
    this.updateNotes();
    this.refresh();
  }

  private isOn(m: LiveModel, key: Toggle["key"]): boolean {
    return key === "wrap" ? m.runtime.animator.values.wrap : m.runtime.effect(key);
  }

  /** Notes about the loaded model, for the model settings view. */
  notes(): string[] {
    const m = this.live();
    if (!m) return [];
    const notes: string[] = [];
    if (m.animator.physics)
      notes.push(`Physics: ${m.animator.physics.file.settings.length} settings.`);
    else notes.push("No physics file in the settings.");
    if (!m.animator.eyeBlink) notes.push("No EyeBlink group: automatic blinking is off.");
    if (m.lipSyncFallback)
      notes.push(
        `Lip sync drives ${m.lipSyncFallback} (a viewer fallback: the settings list no LipSync parameters).`,
      );
    else if (!m.animator.lipSync)
      notes.push("No LipSync parameters and no ParamMouthOpenY: lip sync is off.");
    if (m.loaded.settings.hitAreas.length === 0)
      notes.push("No hit areas in the settings: clicking reports the topmost drawable instead.");
    notes.push(...m.warnings);
    return notes;
  }

  /** Marks physics-driven parameter sliders and explains the look routing. */
  updateNotes(): void {
    const m = this.live();
    const list = this.opts.parameterList();
    if (!m || !list) return;
    const physicsOn = m.effect("physics");
    for (const [dest, src] of m.physicsDriven)
      list.setNote(dest, physicsOn ? `physics ← ${src}` : null, physicsOn);
    const routed = m.lookRouting().filter((r) => r.target !== r.writes);
    const box = this.boxes.get("look")!;
    box.parentElement!.title =
      TOGGLES.find((e) => e.key === "look")!.title +
      (routed.length
        ? `. With physics on, it writes ${routed.map((r) => `${r.writes} (→ ${r.target})`).join(", ")}`
        : "");
  }

  /** Updates the status line (call a few times per second). */
  refresh(): void {
    const m = this.live();
    if (!m) {
      this.opts.status.textContent = "No model loaded.";
      return;
    }
    // Keep the toggles in step with changes made through the model's API.
    let changed = false;
    for (const [key, box] of this.boxes) {
      const on = this.isOn(m, key);
      if (box.checked !== on) {
        box.checked = on;
        changed = true;
      }
    }
    if (changed) this.updateNotes();
    const a = m.animator;
    const motions = a.motions.motions.map((x) => short(x.label));
    const exps = a.expressions.expressions.map((x) => short(x.label));
    const parts = [
      motions.length ? `motion: ${motions.join(" → ")}` : "no motion",
      exps.length ? `expression: ${exps.join(" → ")}` : "no expression",
    ];
    if (a.lipSync && m.lastFrame?.lipSync !== null && m.lastFrame?.lipSync !== undefined)
      parts.push(
        `lip sync ${Number.isNaN(m.lastFrame.lipSync) ? "–" : m.lastFrame.lipSync.toFixed(3)}`,
      );
    if (a.values.modelOpacity !== 1)
      parts.push(`model opacity ${a.values.modelOpacity.toFixed(3)}`);
    this.opts.status.textContent = parts.join(" · ");
  }

  /** Stops every motion. */
  stopMotions(): void {
    this.live()?.stopMotions();
  }

  /**
   * Plays a motion file: the given fades (the settings entry's) or the file's,
   * looping when asked; the entry's sound plays along.
   */
  async playMotion(
    path: string,
    options: { fadeIn?: number; fadeOut?: number; sound?: string; loop?: boolean } = {},
  ): Promise<void> {
    const m = this.live();
    const src = this.source;
    if (!m || !src) return this.opts.setStatus("Load a model first", true);
    try {
      const motion = parseMotion(await src.read(path), path);
      const accepted = m.playMotion(motion, {
        loop: options.loop ?? false,
        ...(options.fadeIn !== undefined ? { fadeIn: options.fadeIn } : {}),
        ...(options.fadeOut !== undefined ? { fadeOut: options.fadeOut } : {}),
      });
      if (accepted && options.sound) {
        // A model's motion sounds play only as WAV files; one that won't is named, never dropped.
        const bytes = await src.read(options.sound);
        const skipped = skippedSoundReason(bytes);
        if (skipped) {
          const w = skippedSoundWarning(options.sound, skipped);
          if (!m.warnings.includes(w)) m.warnings.push(w);
          this.opts.setStatus(w, true);
          return;
        }
        this.opts.playSound(options.sound, bytes);
      }
      this.opts.setStatus(
        accepted
          ? `Motion ${short(path)}: ${motion.duration.toFixed(2)} s, fades ${motion.fadeIn}/${motion.fadeOut} s` +
              (motion.ignoredCurves
                ? `, ${motion.ignoredCurves} curves ignored: out of target order`
                : "")
          : `Motion ${short(path)} refused: a motion of higher priority is playing`,
      );
    } catch (e) {
      this.opts.setStatus(
        `Motion ${short(path)}: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    }
  }

  /** Plays an expression file; one without fades fades over the viewer's default. */
  async playExpression(path: string): Promise<void> {
    const m = this.live();
    const src = this.source;
    if (!m || !src) return this.opts.setStatus("Load a model first", true);
    try {
      const bytes = await src.read(path);
      const exp = parseExpression(bytes, path);
      const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      // The viewer's default fade, where the file sets none (the library's is 1 s).
      if (typeof raw.FadeInTime !== "number") exp.fadeIn = DEFAULT_FADES.expression / 1000;
      if (typeof raw.FadeOutTime !== "number") exp.fadeOut = DEFAULT_FADES.expression / 1000;
      m.playExpression(exp);
      this.opts.setStatus(`Expression ${short(path)}`);
    } catch (e) {
      this.opts.setStatus(
        `Expression ${short(path)}: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    }
  }

  /** Draws the hit-area outlines over the canvas (call every frame). */
  drawOverlay(): void {
    const o = this.opts.overlay;
    const c = this.opts.canvas;
    if (o.width !== c.width || o.height !== c.height) {
      o.width = c.width;
      o.height = c.height;
    }
    const ctx = o.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, o.width, o.height);
    const m = this.live();
    if (!m || !this.opts.showHitAreas()) return;
    const dpr = c.width / Math.max(1, c.clientWidth);
    ctx.lineWidth = 1.5 * dpr;
    ctx.font = `${12 * dpr}px sans-serif`;
    ctx.strokeStyle = "rgba(230, 60, 60, 0.9)";
    ctx.fillStyle = "rgba(230, 60, 60, 0.95)";
    for (const b of m.hitAreaBoxes(c.width, c.height)) {
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.fillText(b.name, b.x + 3 * dpr, b.y - 4 * dpr);
    }
  }
}

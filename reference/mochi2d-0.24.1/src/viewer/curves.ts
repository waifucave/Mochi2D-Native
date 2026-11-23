/**
 * A motion's curves as a graph (the viewer's curve view): every curve over
 * the motion's duration, each scaled to its target's range (a parameter's
 * minimum to maximum, 0 to 1 for opacities), with a check box per curve.
 * Curves are evaluated as playback evaluates them (`evaluateCurve`).
 */
import { evaluateCurve, type Motion } from "../anim/motion.js";

export interface CurveRange {
  min: number;
  max: number;
}

/** Hue of curve k (golden-angle steps, so neighbours differ). */
const hue = (k: number) => (k * 137.508) % 360;

export class CurveGraph {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly shown: boolean[];

  constructor(
    private readonly motion: Motion,
    private readonly rangeOf: (target: string, id: string) => CurveRange | null,
    initiallyShown = 8,
  ) {
    this.element = document.createElement("div");
    this.element.className = "curve-graph";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "curve-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute(
      "aria-label",
      `Curves of ${motion.label} over ${motion.duration.toFixed(2)} s`,
    );
    this.shown = motion.curves.map((_, k) => k < initiallyShown);
    const legend = document.createElement("div");
    legend.className = "curve-legend";
    motion.curves.forEach((c, k) => {
      const label = document.createElement("label");
      label.className = "check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = this.shown[k]!;
      box.addEventListener("change", () => {
        this.shown[k] = box.checked;
        this.draw();
      });
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = `hsl(${hue(k)} 70% 50%)`;
      label.append(box, swatch, ` ${c.target === "Parameter" ? "" : `${c.target} `}${c.id}`);
      legend.append(label);
    });
    const info = document.createElement("p");
    info.className = "empty";
    info.textContent = `${motion.curves.length} curves, ${motion.duration.toFixed(2)} s at ${motion.fps} fps; each curve is drawn over its target's range.`;
    this.element.append(info, this.canvas, legend);
    // Size the drawing buffer once the canvas is laid out.
    requestAnimationFrame(() => this.draw());
  }

  /** The sampled values of curve k: [time, value scaled to 0–1] pairs. */
  samples(k: number, n = 200): [number, number][] {
    const c = this.motion.curves[k]!;
    const d = Math.max(this.motion.duration, 1e-6);
    const range = this.rangeOf(c.target, c.id) ?? { min: 0, max: 1 };
    const span = range.max - range.min || 1;
    const out: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const t = (d * i) / n;
      const v = evaluateCurve(c, t, this.motion.restricted);
      out.push([t, (v - range.min) / span]);
    }
    return out;
  }

  draw(): void {
    const cv = this.canvas;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cv.clientWidth * dpr));
    const h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const pad = 6 * dpr;
    const d = Math.max(this.motion.duration, 1e-6);
    const x = (t: number) => pad + ((w - 2 * pad) * t) / d;
    const y = (v: number) => h - pad - (h - 2 * pad) * Math.min(1, Math.max(0, v));
    // Second marks.
    ctx.strokeStyle = "rgba(128, 128, 140, 0.35)";
    ctx.lineWidth = 1;
    ctx.font = `${10 * dpr}px sans-serif`;
    ctx.fillStyle = "rgba(128, 128, 140, 0.9)";
    for (let s = 0; s <= d + 1e-9; s += d > 10 ? 5 : 1) {
      ctx.beginPath();
      ctx.moveTo(x(s), pad);
      ctx.lineTo(x(s), h - pad);
      ctx.stroke();
      ctx.fillText(`${s} s`, x(s) + 2 * dpr, h - pad - 2 * dpr);
    }
    ctx.lineWidth = 1.5 * dpr;
    this.motion.curves.forEach((_, k) => {
      if (!this.shown[k]) return;
      ctx.strokeStyle = `hsl(${hue(k)} 70% 50%)`;
      ctx.beginPath();
      this.samples(k).forEach(([t, v], i) => (i ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
      ctx.stroke();
    });
  }
}

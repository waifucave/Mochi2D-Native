/**
 * Interactive-path render benchmark: per frame, the time to set
 * the pose and evaluate, hand the vertices to the renderer, record the draw
 * commands, and wait for the GPU to finish (a 1-pixel readback). A separate
 * pass counts the WebGL calls of a frame by name.
 *
 * Software rasterizers such as SwiftShader only allow relative comparisons,
 * so the counts matter as much as the times.
 */
import type { MocModel } from "../core/moc/model.js";
import { ModelInstance } from "../core/eval/instance.js";
import { applyRequest } from "../core/model/snapshot.js";
import { animatedPose, benchPoses } from "../core/testing/bench.js";
import { frameImage } from "../core/render/framing.js";
import { ModelRenderer, type ModelRendererOptions } from "../render/model/model-renderer.js";
import { RenderTarget } from "../render/gl/render-target.js";
import { countGlCalls, summarizeGlCalls } from "../render/gl/call-counter.js";
import type { Texture2D } from "../render/gl/texture.js";

/** static: one pose, redrawn; animated: a smooth animation at 60 fps; random: a new random pose per frame. */
export type RenderBenchMode = "static" | "animated" | "random";

export interface RenderBenchRequest {
  model: string;
  mode: RenderBenchMode;
  /** Timed frames. Default 120. */
  frames?: number;
  /** Untimed frames first. Default 20. */
  warmup?: number;
  /** Frames of the call-profiling pass. Default 10. */
  profileFrames?: number;
  /** Image size. Default 1280 × 720. */
  width?: number;
  height?: number;
  /** Renderer options under test. */
  renderer?: Omit<ModelRendererOptions, "memory">;
}

export interface Summary {
  mean: number;
  median: number;
  p95: number;
}

export interface RenderBenchResult {
  mode: RenderBenchMode;
  width: number;
  height: number;
  frames: number;
  renderer: Omit<ModelRendererOptions, "memory">;
  /** Milliseconds per frame. `draw` is CPU time to record the frame; `sync` waits for the GPU. */
  ms: Record<"evaluate" | "update" | "draw" | "sync" | "frame", Summary>;
  /** Means over the timed frames of the renderer's numeric frame statistics. */
  stats: Record<string, number>;
  /** Mean WebGL calls per frame, by name, and summarized by kind. */
  glCalls: Record<string, number>;
  glSummary: Record<string, number>;
}

const summary = (xs: number[]): Summary => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    mean: xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length),
    median: s[Math.floor(s.length / 2)] ?? 0,
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0,
  };
};

/** Numeric leaves of a stats object, flattened with dotted names. */
function numericLeaves(o: unknown, prefix = "", out: Record<string, number> = {}) {
  if (typeof o === "number") out[prefix] = o;
  else if (o && typeof o === "object")
    for (const [k, v] of Object.entries(o)) numericLeaves(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

export async function runRenderBenchmark(
  gl: WebGL2RenderingContext,
  model: MocModel,
  textures: readonly Texture2D[],
  req: RenderBenchRequest,
): Promise<RenderBenchResult> {
  const frames = req.frames ?? 120;
  const warmup = req.warmup ?? 20;
  const profileFrames = req.profileFrames ?? 10;
  const width = req.width ?? 1280;
  const height = req.height ?? 720;
  const options = req.renderer ?? {};
  const total = warmup + frames + profileFrames;
  const random = req.mode === "random" ? benchPoses(model, "random-all", total, 7) : [];
  const inst = new ModelInstance(model);
  const renderer = new ModelRenderer(gl, model, textures, options);
  const target = new RenderTarget(gl, width, height);
  const base = frameImage(model.canvas, width, height);
  const framing = { ...base, k: base.k * 0.95 };
  const px = new Uint8Array(4);
  const times = { evaluate: [], update: [], draw: [], sync: [], frame: [] } as Record<
    keyof RenderBenchResult["ms"],
    number[]
  >;
  const statSums: Record<string, number> = {};
  let counter: ReturnType<typeof countGlCalls> | null = null;
  try {
    for (let f = 0; f < total; f++) {
      if (f === warmup + frames) counter = countGlCalls(gl);
      const pose =
        req.mode === "random"
          ? random[f]!
          : req.mode === "animated"
            ? animatedPose(model, f / 60)
            : null;
      const t0 = performance.now();
      const evaluate = f === 0 || pose !== null;
      if (pose) applyRequest(inst, pose);
      if (evaluate) inst.evaluate();
      const t1 = performance.now();
      if (evaluate) renderer.update(inst);
      const t2 = performance.now();
      renderer.draw({ framing, background: [0.91, 0.91, 0.93, 1], target: target.framebuffer });
      const t3 = performance.now();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t4 = performance.now();
      if (f >= warmup && f < warmup + frames) {
        times.evaluate.push(t1 - t0);
        times.update.push(t2 - t1);
        times.draw.push(t3 - t2);
        times.sync.push(t4 - t3);
        times.frame.push(t4 - t0);
        for (const [k, v] of Object.entries(numericLeaves(renderer.stats)))
          statSums[k] = (statSums[k] ?? 0) + v;
      }
      // Let timer queries and the page breathe, as a real frame loop would.
      if (f % 10 === 9) await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    counter?.stop();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    target.dispose();
    renderer.dispose();
  }
  const calls = Object.fromEntries(
    [...(counter?.counts ?? new Map<string, number>())]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, v / profileFrames]),
  );
  const glSummary = Object.fromEntries(
    Object.entries(summarizeGlCalls(counter?.counts ?? new Map())).map(([k, v]) => [
      k,
      v / profileFrames,
    ]),
  );
  return {
    mode: req.mode,
    width,
    height,
    frames,
    renderer: options,
    ms: {
      evaluate: summary(times.evaluate),
      update: summary(times.update),
      draw: summary(times.draw),
      sync: summary(times.sync),
      frame: summary(times.frame),
    },
    stats: Object.fromEntries(Object.entries(statSums).map(([k, v]) => [k, v / frames])),
    glCalls: calls,
    glSummary,
  };
}

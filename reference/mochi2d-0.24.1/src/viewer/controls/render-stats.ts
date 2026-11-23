/** Text for the viewer's stats line from the renderer's frame statistics (pure logic). */
import type { FrameStats } from "../../render/model/model-renderer.js";

export interface RenderStatsInput {
  stats: FrameStats;
  /** Milliseconds of the last animation frame (3j steps 1–4). */
  animationMs?: number;
  /** Milliseconds of the last evaluation and of handing its output to the renderer. */
  evaluationMs: number;
  updateMs: number;
  /** The stage skipped the last frame because nothing changed. */
  idle: boolean;
}

const ms = (v: number) => (v < 10 ? v.toFixed(2) : v.toFixed(1));

/** Short form for the stats line. */
export function formatRenderStats(i: RenderStatsInput): string {
  const s = i.stats;
  const gpu = s.gpuMs ? ` · gpu ${ms(s.gpuMs.totalMs)} ms` : "";
  return (
    `${i.idle ? "idle · " : ""}${i.animationMs !== undefined ? `anim ${ms(i.animationMs)} ms · ` : ""}` +
    `eval ${ms(i.evaluationMs)} ms · draw ${ms(s.cpuMs.total)} ms${gpu} · ` +
    `${s.drawCalls} draws, ${s.maskBuilds} mask builds, ${s.stateChanges} state changes, ` +
    `${s.uploads} uploads`
  );
}

/** Long form, for the stats line's tooltip. */
export function describeRenderStats(i: RenderStatsInput): string {
  const s = i.stats;
  const lines = [
    `${s.pipeline} pipeline, ${s.masks} masks${i.idle ? " (idle: last frame not redrawn)" : ""}`,
    `CPU: evaluation ${ms(i.evaluationMs)} ms, vertex hand-off ${ms(i.updateMs)} ms, ` +
      `draw ${ms(s.cpuMs.total)} ms (uploads ${ms(s.cpuMs.upload)}, masks ${ms(s.cpuMs.masks)}, ` +
      `draws ${ms(s.cpuMs.draw)})`,
    s.gpuMs
      ? `GPU: ${ms(s.gpuMs.totalMs)} ms (` +
        Object.entries(s.gpuMs.phases)
          .map(([k, v]) => `${k} ${ms(v)}`)
          .join(", ") +
        ")"
      : "GPU: no timer queries in this browser",
    `drawables ${s.drawn} (${s.masked} masked), draw calls ${s.drawCalls}, mask builds ${s.maskBuilds}` +
      (s.masks === "atlas" ? ` (${s.masksReused} reused)` : "") +
      `, mask mesh draws ${s.maskMeshDraws}`,
    `GL state changes ${s.stateChanges} (${s.stateSkipped} redundant skipped), framebuffer binds ` +
      `${s.framebufferBinds}, uniforms ${s.uniforms} (${s.uniformsSkipped} skipped)`,
    `uploads ${s.uploads} (${(s.uploadBytes / 1024).toFixed(0)} KiB, ${s.meshesUploaded} meshes)`,
  ];
  if (s.pipeline === "layered") lines.push(`layers ${s.layers}, advanced draws ${s.advancedDraws}`);
  return lines.join("\n");
}

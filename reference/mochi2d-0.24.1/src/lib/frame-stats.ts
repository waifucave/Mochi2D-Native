/** Rolling frame statistics (pure logic): FPS, frame interval and CPU time per frame. */
export interface FrameStatsSnapshot {
  fps: number;
  /** Mean interval between frames (ms). */
  frameMs: number;
  /** Longest interval in the window (ms). */
  worstFrameMs: number;
  /** Mean CPU time spent in update + draw (ms). */
  cpuMs: number;
  frames: number;
}

export class FrameStats {
  private readonly intervals: number[] = [];
  private readonly cpu: number[] = [];

  constructor(readonly window = 120) {}

  record(intervalMs: number, cpuMs: number): void {
    if (!(intervalMs > 0)) return;
    this.intervals.push(intervalMs);
    this.cpu.push(cpuMs);
    if (this.intervals.length > this.window) {
      this.intervals.shift();
      this.cpu.shift();
    }
  }

  snapshot(): FrameStatsSnapshot {
    const n = this.intervals.length;
    if (n === 0) return { fps: 0, frameMs: 0, worstFrameMs: 0, cpuMs: 0, frames: 0 };
    const sum = this.intervals.reduce((a, b) => a + b, 0);
    return {
      fps: (1000 * n) / sum,
      frameMs: sum / n,
      worstFrameMs: Math.max(...this.intervals),
      cpuMs: this.cpu.reduce((a, b) => a + b, 0) / n,
      frames: n,
    };
  }
}

export function formatFrameStats(s: FrameStatsSnapshot): string {
  if (s.frames === 0) return "–";
  return `${s.fps.toFixed(1)} fps · ${s.frameMs.toFixed(1)} ms/frame (worst ${s.worstFrameMs.toFixed(0)}) · cpu ${s.cpuMs.toFixed(2)} ms`;
}

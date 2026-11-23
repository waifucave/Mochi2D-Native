/**
 * A pool of offscreen render targets. Targets are matched exactly by size,
 * stencil and filter, so acquiring the same spec every frame reuses the same
 * GPU objects. Targets left unused for `maxIdleFrames` frames are destroyed.
 */
import { RenderTarget } from "./render-target.js";
import type { GpuMemoryTracker } from "./gpu-memory.js";

export interface TargetSpec {
  width: number;
  height: number;
  stencil?: boolean;
  filter?: "linear" | "nearest";
}

export interface RenderTargetPoolStats {
  total: number;
  inUse: number;
  free: number;
  /** Nominal GPU bytes held by the pool (in use + free). */
  bytes: number;
  created: number;
  reused: number;
  destroyed: number;
}

interface Entry {
  target: RenderTarget;
  key: string;
  inUse: boolean;
  lastUsedFrame: number;
}

const keyOf = (s: TargetSpec) =>
  `${s.width}x${s.height}|${s.stencil ? "s" : "-"}|${s.filter ?? "linear"}`;

export class RenderTargetPool {
  private readonly entries: Entry[] = [];
  private readonly byTarget = new Map<RenderTarget, Entry>();
  private frame = 0;
  private created = 0;
  private reused = 0;
  private destroyed = 0;
  readonly maxIdleFrames: number;
  private readonly memory: GpuMemoryTracker | undefined;

  constructor(
    readonly gl: WebGL2RenderingContext,
    options: { maxIdleFrames?: number; memory?: GpuMemoryTracker } = {},
  ) {
    this.maxIdleFrames = options.maxIdleFrames ?? 60;
    this.memory = options.memory;
  }

  /** Returns a free target matching `spec`, creating one if needed. Contents are undefined. */
  acquire(spec: TargetSpec): RenderTarget {
    const key = keyOf(spec);
    const free = this.entries.find((e) => !e.inUse && e.key === key);
    if (free) {
      free.inUse = true;
      free.lastUsedFrame = this.frame;
      this.reused++;
      return free.target;
    }
    const target = new RenderTarget(this.gl, spec.width, spec.height, {
      stencil: spec.stencil ?? false,
      filter: spec.filter ?? "linear",
      ...(this.memory ? { memory: this.memory } : {}),
      label: "pooled target",
    });
    const entry: Entry = { target, key, inUse: true, lastUsedFrame: this.frame };
    this.entries.push(entry);
    this.byTarget.set(target, entry);
    this.created++;
    return target;
  }

  /** Returns a target to the pool. Releasing an unknown or free target throws. */
  release(target: RenderTarget): void {
    const e = this.byTarget.get(target);
    if (!e) throw new Error("RenderTargetPool.release: target does not belong to this pool");
    if (!e.inUse) throw new Error("RenderTargetPool.release: target released twice");
    e.inUse = false;
    e.lastUsedFrame = this.frame;
  }

  /** Advances the frame counter and destroys targets idle for too long. */
  endFrame(): void {
    this.frame++;
    this.evict((e) => this.frame - e.lastUsedFrame > this.maxIdleFrames);
  }

  /** Destroys all free targets. */
  trim(): void {
    this.evict(() => true);
  }

  private evict(pred: (e: Entry) => boolean): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (!e.inUse && pred(e)) {
        e.target.dispose();
        this.byTarget.delete(e.target);
        this.entries.splice(i, 1);
        this.destroyed++;
      }
    }
  }

  get stats(): RenderTargetPoolStats {
    let inUse = 0;
    let bytes = 0;
    for (const e of this.entries) {
      if (e.inUse) inUse++;
      bytes += e.target.bytes;
    }
    return {
      total: this.entries.length,
      inUse,
      free: this.entries.length - inUse,
      bytes,
      created: this.created,
      reused: this.reused,
      destroyed: this.destroyed,
    };
  }

  /** Destroys every target, including ones still in use. */
  dispose(): void {
    for (const e of this.entries) e.target.dispose();
    this.destroyed += this.entries.length;
    this.entries.length = 0;
    this.byTarget.clear();
  }
}

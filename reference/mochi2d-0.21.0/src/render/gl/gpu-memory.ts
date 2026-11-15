/**
 * Bookkeeping of GPU memory we allocate (textures, render targets, buffers).
 * WebGL cannot report real GPU usage, so this tracks what we requested, using
 * the nominal size of each allocation (e.g. width × height × 4 for RGBA8).
 */
export type GpuMemoryCategory = "texture" | "render-target" | "buffer";

export interface GpuAllocation {
  category: GpuMemoryCategory;
  label: string;
  bytes: number;
}

export class GpuMemoryTracker {
  private readonly allocations = new Map<object, GpuAllocation>();
  private _total = 0;
  private _peak = 0;

  /** Records (or updates) the allocation owned by `owner`. */
  set(owner: object, category: GpuMemoryCategory, label: string, bytes: number): void {
    const prev = this.allocations.get(owner);
    if (prev) this._total -= prev.bytes;
    this.allocations.set(owner, { category, label, bytes });
    this._total += bytes;
    if (this._total > this._peak) this._peak = this._total;
  }

  /** Forgets the allocation owned by `owner` (no-op if unknown). */
  delete(owner: object): void {
    const prev = this.allocations.get(owner);
    if (!prev) return;
    this._total -= prev.bytes;
    this.allocations.delete(owner);
  }

  get total(): number {
    return this._total;
  }

  /** Highest total seen since creation or the last {@link resetPeak}. */
  get peak(): number {
    return this._peak;
  }

  resetPeak(): void {
    this._peak = this._total;
  }

  /** Forgets every allocation (after a lost context, when all GPU objects are gone). */
  clear(): void {
    this.allocations.clear();
    this._total = 0;
  }

  byCategory(): Record<GpuMemoryCategory, number> {
    const out: Record<GpuMemoryCategory, number> = { texture: 0, "render-target": 0, buffer: 0 };
    for (const a of this.allocations.values()) out[a.category] += a.bytes;
    return out;
  }

  list(): GpuAllocation[] {
    return [...this.allocations.values()].sort((a, b) => b.bytes - a.bytes);
  }
}

/** Formats a byte count as e.g. "512 KiB" / "1.5 GiB". */
export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Nominal bytes of an RGBA8 texture, including the mip chain if requested. */
export function rgba8Bytes(width: number, height: number, mipmaps = false): number {
  if (!mipmaps) return width * height * 4;
  let total = 0;
  let w = width;
  let h = height;
  for (;;) {
    total += w * h * 4;
    if (w === 1 && h === 1) break;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return total;
}

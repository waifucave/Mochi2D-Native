/**
 * Render order (§1c.13): emit draw-order groups recursively,
 * stable-sorting each group's objects by key. The key is the evaluated draw
 * order (after interpolation and blend shapes; for parts after truncation),
 * or the group minimum for an inactive object. Keys outside the group's
 * range are sorted by their value, with no clamping (C25 and C12), so the
 * order is a valid one for every file that loads.
 *
 * Allocation-free per frame: each group sorts a preallocated array of
 * composite keys (key − lowest key)·M + file order, with M a power of two above
 * the group size. Distinct objects never share a composite key, so a plain
 * numeric sort gives exactly the stable order by (key, file order).
 */
import type { MocModel } from "../moc/model.js";

/** Largest integer a float64 holds exactly. */
const EXACT_LIMIT = 2 ** 53;

/** The parts of an instance the render order reads and writes. */
export interface RenderOrderState {
  readonly drawableActive: Uint8Array;
  readonly drawableDrawOrder: Int32Array;
  readonly drawableRenderOrder: Int32Array;
  readonly partActive: Uint8Array;
  readonly partDrawOrder: Int32Array;
  readonly offscreenRenderOrder: Int32Array;
}

interface GroupPlan {
  /** Per object: 0 = art mesh, 1 = part. */
  kind: Uint8Array;
  index: Int32Array;
  nested: Int32Array;
  /** Offscreen of each part object, or -1. */
  offscreen: Int32Array;
  /** The group's minimum draw order: the key of inactive objects. */
  min: number;
  /** Multiplier for the key in the composite (power of two ≥ object count). */
  scale: number;
  /** This frame's keys, in file order. */
  raw: Float64Array;
  /** Composite keys, sorted in place every frame. */
  keys: Float64Array;
}

export class RenderOrderer {
  private readonly groups: GroupPlan[];
  private position = 0;

  constructor(model: MocModel) {
    const g = model.groups;
    this.groups = g.objects.map((objects, gi) => {
      const n = objects.length;
      let scale = 1;
      while (scale < n) scale *= 2;
      return {
        kind: Uint8Array.from(objects, (o) => o.kind),
        index: Int32Array.from(objects, (o) => o.index),
        nested: Int32Array.from(objects, (o) => o.nestedGroup),
        offscreen: Int32Array.from(objects, (o) =>
          o.kind === 1 ? model.parts.offscreen[o.index]! : -1,
        ),
        min: g.minDrawOrder[gi]!,
        scale,
        raw: new Float64Array(n),
        keys: new Float64Array(n),
      };
    });
  }

  /** Assigns drawable and offscreen render orders from the current draw orders. */
  compute(s: RenderOrderState): void {
    this.position = 0;
    if (this.groups.length > 0) this.emit(s, 0);
  }

  private emit(s: RenderOrderState, gi: number): void {
    const g = this.groups[gi]!;
    const n = g.keys.length;
    const { kind, index, min, scale, raw, keys } = g;
    let lo = Infinity;
    let hi = -Infinity;
    for (let f = 0; f < n; f++) {
      const o = index[f]!;
      let key: number;
      if (kind[f] === 0) key = s.drawableActive[o] ? s.drawableDrawOrder[o]! : min;
      else key = s.partActive[o] ? s.partDrawOrder[o]! : min;
      raw[f] = key;
      if (key < lo) lo = key;
      if (key > hi) hi = key;
    }
    if ((hi - lo + 1) * scale > EXACT_LIMIT) {
      this.emitWide(s, g);
      return;
    }
    for (let f = 0; f < n; f++) keys[f] = (raw[f]! - lo) * scale + f;
    keys.sort();
    for (let j = 0; j < n; j++) {
      const f = keys[j]! % scale;
      this.place(s, g, f);
    }
  }

  /** Fallback for key spreads too wide for composite keys (not seen in practice). */
  private emitWide(s: RenderOrderState, g: GroupPlan): void {
    const order = Array.from({ length: g.keys.length }, (_, f) => f);
    order.sort((a, b) => g.raw[a]! - g.raw[b]! || a - b);
    for (const f of order) this.place(s, g, f);
  }

  private place(s: RenderOrderState, g: GroupPlan, f: number): void {
    if (g.kind[f] === 0) {
      s.drawableRenderOrder[g.index[f]!] = this.position++;
    } else {
      const off = g.offscreen[f]!;
      if (off >= 0) s.offscreenRenderOrder[off] = this.position++;
      this.emit(s, g.nested[f]!);
    }
  }
}

/** One-shot render order for a state (used by tests and tools). */
export function computeRenderOrder(s: RenderOrderState & { readonly model: MocModel }): void {
  new RenderOrderer(s.model).compute(s);
}

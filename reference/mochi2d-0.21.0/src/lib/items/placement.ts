/**
 * Where an item sits over the main model: an affine map from the item's
 * model units to the main model's (both y up), from a position, a scale and
 * a rotation about an anchor point of the item.
 */
import type { MocCanvas } from "../../core/moc/read.js";

/** A place in the main model's render order: just above or just below one of its art meshes (by ID). */
export type ItemMeshPlace = { above: string } | { below: string };

/**
 * Where (a part of) an item is drawn: in front of the whole main model,
 * behind it, or at a place in its render order.
 */
export type ItemDepth = "front" | "behind" | ItemMeshPlace;

/**
 * A split item: its drawables are drawn in two parts, each at its own place.
 * The front part is the item's art mesh `mesh` and every drawable after it in
 * the item's render order; it is drawn where the item's placement says. The
 * back part, the drawables before `mesh`, is drawn at `back`. The back part
 * is never drawn in front of the front part: a `back` in front of the front
 * part's place stands for that place (the back part then just below the
 * front part).
 */
export interface ItemSplit {
  /** The item's own art mesh (by ID) that starts the front part. */
  mesh: string;
  /** Where the back part is drawn. */
  back: ItemDepth;
}

export interface ItemPlacement {
  /** Where the item's anchor sits, in the main model's units (y up). */
  x: number;
  y: number;
  /** Size: main-model canvas pixels per item canvas pixel (1: the same pixel size). */
  scale: number;
  /** Degrees, counterclockwise. */
  rotation: number;
  /** The anchor in the item's canvas: (0, 0) its top-left corner, (1, 1) its bottom-right. */
  anchorX: number;
  anchorY: number;
  /**
   * Drawn in front of the main model (true) or behind it (false), when
   * `layer` names no art mesh of the main model.
   */
  front: boolean;
  /**
   * Flipped horizontally: the item's left and right swapped about its anchor,
   * before the rotation. Default false (absent in layouts before 0.7.0).
   */
  mirror?: boolean;
  /**
   * Drawn at a place in the main model's render order instead: just above or
   * below one of its art meshes. Null or absent (layouts before 0.10.0):
   * `front` decides. A place whose art mesh the main model does not have
   * (another main model was loaded) also leaves it to `front`.
   */
  layer?: ItemMeshPlace | null;
  /** Drawn in two parts (see {@link ItemSplit}); null or absent: as a whole. */
  split?: ItemSplit | null;
}

/** Whether `v` is an {@link ItemMeshPlace}. */
export function isMeshPlace(v: unknown): v is ItemMeshPlace {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1) return false;
  const k = keys[0]!;
  return (k === "above" || k === "below") && typeof (v as Record<string, unknown>)[k] === "string";
}

/** Whether `v` is an {@link ItemDepth}. */
export function isDepth(v: unknown): v is ItemDepth {
  return v === "front" || v === "behind" || isMeshPlace(v);
}

/** The art mesh ID of a mesh place, or null for "front" and "behind". */
export function placeMesh(d: ItemDepth): string | null {
  if (typeof d === "string") return null;
  return "above" in d ? d.above : d.below;
}

/** A copy of a depth (mesh places are objects). */
export function copyDepth<T extends ItemDepth>(d: T): T {
  return (typeof d === "string" ? d : { ...(d as ItemMeshPlace) }) as T;
}

/** A copy of a placement that shares no objects with it. */
export function copyPlacement(p: ItemPlacement): ItemPlacement {
  const out = { ...p };
  if (p.layer) out.layer = copyDepth(p.layer);
  if (p.split) out.split = { mesh: p.split.mesh, back: copyDepth(p.split.back) };
  return out;
}

/**
 * The layer and split of a placement checked and copied: TypeError when one
 * is malformed. Other fields are returned as given.
 */
export function checkedPlacement<P extends Partial<ItemPlacement>>(p: P): P {
  const out = { ...p };
  if (p.layer !== undefined && p.layer !== null) {
    if (!isMeshPlace(p.layer))
      throw new TypeError("an item's layer is { above: meshId } or { below: meshId }, or null");
    out.layer = copyDepth(p.layer);
  }
  if (p.split !== undefined && p.split !== null) {
    const s = p.split as unknown as Record<string, unknown>;
    if (typeof s !== "object" || typeof s.mesh !== "string" || !isDepth(s.back))
      throw new TypeError(
        'an item\'s split is { mesh: meshId, back: "front" | "behind" | { above } | { below } }, or null',
      );
    out.split = { mesh: p.split.mesh, back: copyDepth(p.split.back) };
  }
  return out;
}

/** A model's canvas rectangle in its own units (y up). */
export interface CanvasRect {
  left: number;
  right: number;
  bottom: number;
  top: number;
  /** Canvas pixels per unit. */
  pixelsPerUnit: number;
}

export function canvasRect(c: MocCanvas): CanvasRect {
  const ppu = c.pixelsPerUnit;
  return {
    left: -c.originX / ppu,
    right: (c.width - c.originX) / ppu,
    top: c.originY / ppu,
    bottom: (c.originY - c.height) / ppu,
    pixelsPerUnit: ppu,
  };
}

/** x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invertAffine(m: Affine): Affine {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0) return [1, 0, 0, 1, 0, 0];
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

/** The item's anchor in its own units. */
export function anchorPoint(item: CanvasRect, p: Pick<ItemPlacement, "anchorX" | "anchorY">) {
  return [
    item.left + p.anchorX * (item.right - item.left),
    item.top - p.anchorY * (item.top - item.bottom),
  ] as const;
}

/** Main-model units per item unit at a placement's scale. */
export function unitScale(item: CanvasRect, main: CanvasRect, scale: number): number {
  return (scale * item.pixelsPerUnit) / main.pixelsPerUnit;
}

/** The map from item units to main-model units. */
export function itemToMain(item: CanvasRect, main: CanvasRect, p: ItemPlacement): Affine {
  const s = unitScale(item, main, p.scale);
  const r = (p.rotation * Math.PI) / 180;
  const cos = Math.cos(r) * s;
  const sin = Math.sin(r) * s;
  const [ax, ay] = anchorPoint(item, p);
  // X' = P + R·s·F·(X − A), with F = diag(−1, 1) for a mirrored item (else the identity).
  const m = p.mirror ? -1 : 1;
  const a = m * cos;
  const b = m * sin;
  return [a, b, -sin, cos, p.x - (a * ax - sin * ay), p.y - (b * ax + cos * ay)];
}

/** The default placement: anchor at the item's canvas center, over the main canvas center, same pixel size. */
export function defaultPlacement(main: CanvasRect): ItemPlacement {
  return {
    x: (main.left + main.right) / 2,
    y: (main.bottom + main.top) / 2,
    scale: 1,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    front: true,
    mirror: false,
  };
}

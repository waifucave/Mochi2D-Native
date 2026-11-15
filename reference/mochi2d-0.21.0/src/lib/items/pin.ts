/**
 * Pinning an item to the main model: the point under
 * the item's anchor is recorded as a triangle of the topmost visible drawable
 * there and barycentric coordinates in it. Every frame, the item follows that
 * point and the triangle's rotation.
 */
import type { ModelInstance } from "../../core/eval/instance.js";
import type { MocModel } from "../../core/moc/model.js";

/**
 * The alpha (0–1) of texture `texture` at stored UV (u, v), v from the top;
 * undefined when it cannot be read.
 */
export type AlphaProbe = (texture: number, u: number, v: number) => number | undefined;

export interface PinTarget {
  /** Index and ID of the drawable. */
  drawable: number;
  drawableId: string;
  /** Index of the triangle in the drawable's triangle list. */
  triangle: number;
  /** The triangle's vertex indices. */
  vertices: readonly [number, number, number];
  /** Barycentric coordinates of the point (they sum to 1). */
  weights: readonly [number, number, number];
  /** The triangle's vertices relative to their centroid when pinned: its reference orientation. */
  reference: readonly number[];
}

const INVERTED_MASK = 8;
const EPS = 1e-6;

function barycentric(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): [number, number, number] | null {
  const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(det) < 1e-18) return null;
  const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
  const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
  const w2 = 1 - w0 - w1;
  return w0 >= -EPS && w1 >= -EPS && w2 >= -EPS ? [w0, w1, w2] : null;
}

interface TriangleHit {
  triangle: number;
  vertices: [number, number, number];
  weights: [number, number, number];
}

/** The first triangle of drawable `d` that contains (x, y), and the point's weights in it. */
export function triangleAt(
  model: MocModel,
  inst: ModelInstance,
  d: number,
  x: number,
  y: number,
): TriangleHit | null {
  const v = inst.drawableVertices[d]!;
  const tris = model.meshes.triangles[d]!;
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const i0 = tris[t]!;
    const i1 = tris[t + 1]!;
    const i2 = tris[t + 2]!;
    const w = barycentric(
      x,
      y,
      v[2 * i0]!,
      v[2 * i0 + 1]!,
      v[2 * i1]!,
      v[2 * i1 + 1]!,
      v[2 * i2]!,
      v[2 * i2 + 1]!,
    );
    if (w) return { triangle: t / 3, vertices: [i0, i1, i2], weights: w };
  }
  return null;
}

/** Texture alpha of drawable `d` at a point of one of its triangles, or undefined. */
function alphaOf(model: MocModel, d: number, hit: TriangleHit, probe: AlphaProbe | undefined) {
  if (!probe) return undefined;
  const uv = model.meshes.uvs[d]!;
  let u = 0;
  let v = 0;
  for (let k = 0; k < 3; k++) {
    u += hit.weights[k]! * uv[2 * hit.vertices[k]!]!;
    v += hit.weights[k]! * uv[2 * hit.vertices[k]! + 1]!;
  }
  return probe(model.meshes.texture[d]!, u, v);
}

/**
 * The pin target under (x, y) in model units: the topmost visible drawable
 * whose geometry covers the point, where its texture is not (nearly)
 * transparent and its clipping masks let it show, when `probe` can read
 * texture alpha. Null if nothing is there.
 */
export function findPinTarget(
  model: MocModel,
  inst: ModelInstance,
  x: number,
  y: number,
  probe?: AlphaProbe,
  minAlpha = 0.1,
): PinTarget | null {
  const n = model.meshes.ids.length;
  const order: number[] = [];
  for (let d = 0; d < n; d++)
    if (inst.drawableVisible[d] && inst.drawableOpacity[d]! > 0.01) order.push(d);
  order.sort((a, b) => inst.drawableRenderOrder[b]! - inst.drawableRenderOrder[a]!);
  const covers = (d: number) => {
    const hit = triangleAt(model, inst, d, x, y);
    if (!hit) return false;
    const a = alphaOf(model, d, hit, probe);
    return a === undefined || a >= minAlpha;
  };
  for (const d of order) {
    const hit = triangleAt(model, inst, d, x, y);
    if (!hit) continue;
    const a = alphaOf(model, d, hit, probe);
    if (a !== undefined && a * inst.drawableOpacity[d]! < minAlpha) continue;
    const masks = model.meshes.masks[d]!;
    if (masks.length) {
      const inside = Array.from(masks).some(covers);
      const inverted = (model.meshes.flags[d]! & INVERTED_MASK) !== 0;
      if (inside === inverted) continue;
    }
    const v = inst.drawableVertices[d]!;
    const pts = hit.vertices.map((i) => [v[2 * i]!, v[2 * i + 1]!] as const);
    const cx = (pts[0]![0] + pts[1]![0] + pts[2]![0]) / 3;
    const cy = (pts[0]![1] + pts[1]![1] + pts[2]![1]) / 3;
    return {
      drawable: d,
      drawableId: model.meshes.ids[d]!,
      triangle: hit.triangle,
      vertices: hit.vertices,
      weights: hit.weights,
      reference: pts.flatMap(([px, py]) => [px - cx, py - cy]),
    };
  }
  return null;
}

/**
 * Where a pin target is now: the point's position in model units, and the
 * triangle's rotation since it was pinned in radians (the best-fit rotation
 * of its centered vertices, counterclockwise).
 */
export function pinPose(
  inst: ModelInstance,
  pin: PinTarget,
): { x: number; y: number; angle: number } {
  const v = inst.drawableVertices[pin.drawable]!;
  const pts = pin.vertices.map((i) => [v[2 * i]!, v[2 * i + 1]!] as const);
  let x = 0;
  let y = 0;
  for (let k = 0; k < 3; k++) {
    x += pin.weights[k]! * pts[k]![0];
    y += pin.weights[k]! * pts[k]![1];
  }
  const cx = (pts[0]![0] + pts[1]![0] + pts[2]![0]) / 3;
  const cy = (pts[0]![1] + pts[1]![1] + pts[2]![1]) / 3;
  let dot = 0;
  let cross = 0;
  for (let k = 0; k < 3; k++) {
    const ax = pin.reference[2 * k]!;
    const ay = pin.reference[2 * k + 1]!;
    const bx = pts[k]![0] - cx;
    const by = pts[k]![1] - cy;
    dot += ax * bx + ay * by;
    cross += ax * by - ay * bx;
  }
  return { x, y, angle: Math.atan2(cross, dot) };
}

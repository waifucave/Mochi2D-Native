/**
 * Reference-render framing (§2i): which output-space point sits at
 * the image center, and how many image pixels one output unit spans.
 */
import type { MocCanvas } from "../moc/read.js";

/** An explicit view: image center (x, y) in output units and image pixels per model unit. */
export interface RenderView {
  x: number;
  y: number;
  pixelsPerUnit: number;
}

export interface Framing {
  width: number;
  height: number;
  /** Image pixels per output unit (k). */
  k: number;
  /** Output-space point at the image center. */
  centerX: number;
  centerY: number;
  /**
   * Turn of the picture about the image center, in degrees, counterclockwise
   * on the image (a view setting; reference renders have none). Default 0.
   */
  rotation?: number;
}

/**
 * The framing of a W × H image: `view` if given, otherwise the model canvas
 * fitted into the image with its aspect ratio kept, centered.
 */
export function frameImage(
  canvas: MocCanvas,
  width: number,
  height: number,
  view?: RenderView,
): Framing {
  if (view) return { width, height, k: view.pixelsPerUnit, centerX: view.x, centerY: view.y };
  const ppu = canvas.pixelsPerUnit;
  return {
    width,
    height,
    k: Math.min(width / canvas.width, height / canvas.height) * ppu,
    centerX: (canvas.width / 2 - canvas.originX) / ppu,
    centerY: (canvas.originY - canvas.height / 2) / ppu,
  };
}

/**
 * Cosine and sine of a turn in degrees, exact at multiples of 90° (so a
 * half turn has no stray sine).
 */
export function turnOf(degrees: number): [number, number] {
  const d = ((degrees % 360) + 360) % 360;
  if (d === 0) return [1, 0];
  if (d === 90) return [0, 1];
  if (d === 180) return [-1, 0];
  if (d === 270) return [0, -1];
  const r = (d * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

/** Image position (P, Q) of an output-space point, in pixels from the top-left corner. */
export function imagePosition(f: Framing, x: number, y: number): [number, number] {
  if (!f.rotation)
    return [f.width / 2 + f.k * (x - f.centerX), f.height / 2 - f.k * (y - f.centerY)];
  // Offsets from the center in pixels (y up), turned counterclockwise.
  const [c, s] = turnOf(f.rotation);
  const u = f.k * (x - f.centerX);
  const v = f.k * (y - f.centerY);
  return [f.width / 2 + (c * u - s * v), f.height / 2 - (s * u + c * v)];
}

/** Output-space point at image position (P, Q) (the inverse of {@link imagePosition}). */
export function outputPosition(f: Framing, P: number, Q: number): [number, number] {
  if (!f.rotation)
    return [f.centerX + (P - f.width / 2) / f.k, f.centerY - (Q - f.height / 2) / f.k];
  const [c, s] = turnOf(f.rotation);
  const u = P - f.width / 2;
  const v = f.height / 2 - Q;
  return [f.centerX + (c * u + s * v) / f.k, f.centerY + (c * v - s * u) / f.k];
}

/**
 * An image-pixel step (dx right, dy down) as an output-space step (y up),
 * under the framing's scale and rotation.
 */
export function outputStep(f: Framing, dx: number, dy: number): [number, number] {
  if (!f.rotation) return [dx / f.k, -dy / f.k];
  const [c, s] = turnOf(f.rotation);
  return [(c * dx - s * dy) / f.k, (-s * dx - c * dy) / f.k];
}

/**
 * The output-space box that holds every point of the image, plus `margin`
 * pixels on each side: the image's own box, or the box around the turned
 * image.
 */
export function visibleBox(
  f: Framing,
  margin = 0,
): { x0: number; y0: number; x1: number; y1: number } {
  let hw = (f.width / 2 + margin) / f.k;
  let hh = (f.height / 2 + margin) / f.k;
  if (f.rotation) {
    const [c, s] = turnOf(f.rotation);
    [hw, hh] = [Math.abs(c) * hw + Math.abs(s) * hh, Math.abs(s) * hw + Math.abs(c) * hh];
  }
  return { x0: f.centerX - hw, y0: f.centerY - hh, x1: f.centerX + hw, y1: f.centerY + hh };
}

/**
 * Output space → GL clip space (y up, bottom row first) as [sx, sy, tx, ty]:
 * clip = (x·sx + tx, y·sy + ty).
 */
export function clipTransform(f: Framing): [number, number, number, number] {
  const sx = (2 * f.k) / f.width;
  const sy = (2 * f.k) / f.height;
  return [sx, sy, -f.centerX * sx, -f.centerY * sy];
}

/**
 * The framing's rotation in clip space, applied after {@link clipTransform}:
 * [c, s·H/W, s·W/H], with clip′ = (c·x − s·(H/W)·y, s·(W/H)·x + c·y).
 * [1, 0, 0] for none.
 */
export function clipTurn(f: Framing): [number, number, number] {
  if (!f.rotation) return [1, 0, 0];
  const [c, s] = turnOf(f.rotation);
  return [c, (s * f.height) / f.width, (s * f.width) / f.height];
}

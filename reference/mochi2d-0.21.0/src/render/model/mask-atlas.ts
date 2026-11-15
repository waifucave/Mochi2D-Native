/**
 * Mask atlas layout for the viewer's "atlas" mask mode. It is a
 * viewer-only approximation, never used for reference renders.
 *
 * Every mask group needed in a frame gets its own region of one atlas
 * texture, so all masks can be built before the frame's draws and kept across
 * frames while nothing they depend on changes. Unlike the reference mapping
 * (§2g.3), which spends one mask texel per canvas pixel, the density here
 * follows the image: a few texels per image pixel.
 *
 * Within a region the mapping has the same form as §2g.3: if the box fits, the
 * region starts at the box edge with `density` texels per output unit;
 * otherwise the box plus a 5 % margin on each side fills the largest allowed
 * region. A gutter of cleared texels surrounds each region, so bilinear
 * samples from inside the box never reach a neighbour.
 */
import type { Box, MaskMapping } from "../../core/render/masks.js";

/** Cleared texels around each region. */
export const ATLAS_GUTTER = 2;
/** Region sizes are rounded up to this many texels, so small box changes keep the layout. */
const QUANTUM = 16;

export interface AtlasRegion {
  /** Region rectangle in atlas texels, gutter included. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Output space → atlas texture coordinates in [0, 1]. */
  map: MaskMapping;
}

/** Per axis: origin X₀, texels per output unit, and the texels the box needs. */
function axis(
  origin: number,
  extent: number,
  density: number,
  maxTexels: number,
): [number, number, number] {
  const e = extent > 0 && Number.isFinite(extent) ? extent : 0;
  if (e * density <= maxTexels) return [origin, density, Math.ceil(e * density)];
  return [origin - 0.05 * e, maxTexels / (1.1 * e), maxTexels];
}

/**
 * Shelf-packs one region per box (null boxes get none) into the first
 * `size` × `size` texels of an atlas texture of `textureSize` × `textureSize`,
 * in order. Returns null if they do not fit.
 */
export function packMaskAtlas(
  boxes: readonly (Box | null)[],
  density: number,
  size: number,
  maxRegion: number,
  textureSize = size,
): (AtlasRegion | null)[] | null {
  const T = textureSize;
  const g = ATLAS_GUTTER;
  const maxTexels = maxRegion - 2 * g;
  const out: (AtlasRegion | null)[] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const box of boxes) {
    if (!box) {
      out.push(null);
      continue;
    }
    const [X0, sx, nx] = axis(box.x0, box.w, density, maxTexels);
    const [Y0, sy, ny] = axis(box.y0, box.h, density, maxTexels);
    const w = Math.ceil((nx + 2 * g) / QUANTUM) * QUANTUM;
    const h = Math.ceil((ny + 2 * g) / QUANTUM) * QUANTUM;
    if (w > size || h > size) return null;
    if (x + w > size) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    if (y + h > size) return null;
    // t = (x' + g + (p − X₀)·s) / T, written as (p − X₀)·(s/T) + ℓ with ℓ = (x' + g)/T.
    out.push({
      x,
      y,
      w,
      h,
      map: { ox: X0, sx: sx / T, oy: Y0, sy: sy / T, lx: (x + g) / T, ly: (y + g) / T },
    });
    x += w;
    shelf = Math.max(shelf, h);
  }
  return out;
}

/** Atlas layouts tried in order, from the preferred one to the most compact. */
export const ATLAS_LAYOUTS: readonly { size: number; maxRegion: number; densityScale: number }[] = [
  { size: 2048, maxRegion: 2048, densityScale: 1 },
  { size: 4096, maxRegion: 4096, densityScale: 1 },
  { size: 4096, maxRegion: 2048, densityScale: 0.5 },
  { size: 4096, maxRegion: 1024, densityScale: 0.25 },
];

/**
 * The part of a box that the image can show: only on-screen pixels sample a
 * mask, so the rest of the box needs no texels. `view` is the visible output
 * rectangle, already widened by a margin. An empty intersection becomes an
 * empty box at the nearest visible point.
 */
export function clipBox(box: Box, view: { x0: number; y0: number; x1: number; y1: number }): Box {
  const x0 = Math.max(box.x0, view.x0);
  const y0 = Math.max(box.y0, view.y0);
  const x1 = Math.min(box.x0 + box.w, view.x1);
  const y1 = Math.min(box.y0 + box.h, view.y1);
  const cx = Math.min(Math.max(x0, view.x0), view.x1);
  const cy = Math.min(Math.max(y0, view.y0), view.y1);
  return {
    x0: x1 >= x0 ? x0 : cx,
    y0: y1 >= y0 ? y0 : cy,
    w: x1 >= x0 ? x1 - x0 : 0,
    h: y1 >= y0 ? y1 - y0 : 0,
  };
}

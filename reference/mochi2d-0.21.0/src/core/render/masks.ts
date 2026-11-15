/**
 * Clipping-mask bookkeeping (§2g and §2h.4): mask groups, group
 * boxes and the mapping from output space into a mask buffer.
 */

export interface MaskGroup {
  /** Mask meshes in drawing order: the mask list of the group's first member. */
  masks: Int32Array;
  /** Masked objects (drawables or offscreens) in file order. */
  members: Int32Array;
}

export interface MaskGrouping {
  groups: MaskGroup[];
  /** Group of each object, -1 if it has no masks. */
  groupOf: Int32Array;
}

/**
 * Groups objects with the same set of mask meshes (same members, any order).
 * Groups are numbered in the file order of their first member (§2g.2).
 */
export function maskGroups(lists: readonly ArrayLike<number>[]): MaskGrouping {
  const groupOf = new Int32Array(lists.length).fill(-1);
  const groups: { masks: Int32Array; members: number[] }[] = [];
  const byKey = new Map<string, number>();
  lists.forEach((list, i) => {
    if (list.length === 0) return;
    const key = [...new Set(Array.from(list))].sort((a, b) => a - b).join(",");
    let g = byKey.get(key);
    if (g === undefined) {
      g = groups.length;
      byKey.set(key, g);
      groups.push({ masks: Int32Array.from(list), members: [] });
    }
    groups[g]!.members.push(i);
    groupOf[i] = g;
  });
  return {
    groups: groups.map((g) => ({ masks: g.masks, members: Int32Array.from(g.members) })),
    groupOf,
  };
}

/** Axis-aligned box: origin (x0, y0), extent w × h. */
export interface Box {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/**
 * Bounds of the vertices of the given drawables. With `quirk` (drawable mask
 * groups, §2g.2) the running maximum starts at the smallest positive double
 * instead of −∞, so the box always reaches x = 0 and y = 0 from below.
 */
export function drawablesBox(
  drawables: ArrayLike<number>,
  vertices: readonly ArrayLike<number>[],
  quirk: boolean,
): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = quirk ? Number.MIN_VALUE : -Infinity;
  let maxY = maxX;
  for (let k = 0; k < drawables.length; k++) {
    const v = vertices[drawables[k]!]!;
    for (let i = 0; i + 1 < v.length; i += 2) {
      const x = v[i]!;
      const y = v[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { x0: minX, y0: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Output space → mask-texture coordinates per axis: t = (x − ox)·sx + lx and
 * t = (y − oy)·sy + ly, ℓ = (lx, ly) being the corner of the mask's region in
 * the texture (0 when the mask has the whole texture). The renderer applies
 * it as float32 matrices built from these numbers (`maskMatrices`, rule M).
 */
export interface MaskMapping {
  ox: number;
  sx: number;
  oy: number;
  sy: number;
  lx?: number;
  ly?: number;
}

/** The mapping of a point, in double (for CPU-side bounds; not the renderer's float32 order). */
export function mapToMask(map: MaskMapping, x: number, y: number): [number, number] {
  return [(x - map.ox) * map.sx + (map.lx ?? 0), (y - map.oy) * map.sy + (map.ly ?? 0)];
}

/**
 * The mapping of §2g.3 for a group box, canvas pixels per unit `ppu` and a
 * buffer of `size` × `size` pixels. Per axis: one buffer pixel per canvas
 * pixel from the box edge if the box fits, otherwise the box plus a 5 % margin
 * on each side stretched over the buffer.
 */
export function maskMapping(box: Box, ppu: number, size: number): MaskMapping {
  const axis = (origin: number, extent: number): [number, number] =>
    extent * ppu <= size ? [origin, ppu / size] : [origin - 0.05 * extent, 1 / (1.1 * extent)];
  const [ox, sx] = axis(box.x0, box.w);
  const [oy, sy] = axis(box.y0, box.h);
  return { ox, sx, oy, sy };
}

/** Ancestry of parts: whether `a` is `p` or one of its ancestors. */
export function isSelfOrAncestor(parents: ArrayLike<number>, a: number, p: number): boolean {
  for (let q = p; q >= 0; q = parents[q]!) if (q === a) return true;
  return false;
}

/** Drawables whose parent part is `owner` or lies anywhere under it. */
export function drawablesUnder(
  meshParts: ArrayLike<number>,
  partParents: ArrayLike<number>,
  owner: number,
): number[] {
  const out: number[] = [];
  for (let d = 0; d < meshParts.length; d++)
    if (isSelfOrAncestor(partParents, owner, meshParts[d]!)) out.push(d);
  return out;
}

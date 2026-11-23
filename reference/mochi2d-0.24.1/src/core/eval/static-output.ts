/**
 * Static drawable data in output form (§1a and §1c.11): UVs with
 * v replaced by 1 − v, and each triangle's indices reversed so the winding
 * survives the y flip. Both are skipped when canvas flag bit 0 is set.
 */
import type { MocModel } from "../moc/model.js";

export function outputFlipsY(model: MocModel): boolean {
  return (model.canvas.flags & 1) === 0;
}

/** Output UVs of drawable `i` (new array). */
export function outputUvs(model: MocModel, i: number): Float32Array {
  const uv = Float32Array.from(model.meshes.uvs[i]!);
  if (outputFlipsY(model)) for (let k = 1; k < uv.length; k += 2) uv[k] = Math.fround(1 - uv[k]!);
  return uv;
}

/** Output triangle indices of drawable `i` (new array). */
export function outputTriangles(model: MocModel, i: number): Uint16Array {
  const t = Uint16Array.from(model.meshes.triangles[i]!);
  if (outputFlipsY(model)) {
    for (let k = 0; k + 2 < t.length; k += 3) {
      const a = t[k]!;
      t[k] = t[k + 2]!;
      t[k + 2] = a;
    }
  }
  return t;
}

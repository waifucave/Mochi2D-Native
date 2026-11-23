/**
 * Texture coordinates as the renderer samples them (rule V). A file stores
 * each vertex's v with its origin at the image's top; Mochi2D flips it twice,
 * and both subtractions round to float32, so the sampled v is f32(1 − f32(1 − v)): for a
 * small v, low bits lost in the first subtraction don't come back (v = 0.1,
 * float32 0x3DCCCCCD, is sampled at 0x3DCCCCD0). u is used as stored.
 */

/** The v the renderer samples for a stored v. */
export function sampledV(v: number): number {
  return Math.fround(1 - Math.fround(1 - v));
}

/** A drawable's stored UVs (u, v pairs) as the renderer samples them. */
export function sampledUvs(uvs: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(uvs);
  for (let i = 1; i < out.length; i += 2) out[i] = sampledV(out[i]!);
  return out;
}

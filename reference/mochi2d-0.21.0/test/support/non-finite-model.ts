/**
 * A synthetic model whose keyform positions hold NaN, ±∞ and huge values, in
 * mesh keyforms (two of them, so interpolation meets ∞ − ∞), in a warp grid
 * (meshes inside and outside it), under a rotation, in a mask and in a glue;
 * from version 6 with an advanced blend code, so it is drawn in the layered
 * pipeline. Shared by the evaluator and renderer tests of non-finite positions.
 */
import { Synth } from "./synth.js";

/** A model whose position pool holds every kind of non-finite or huge value. */
export function nonFiniteModel(version = 5): Synth {
  const s = new Synth(version);
  s.part({ id: "P" });
  const p = s.param("P", 0, 1, 0);
  const band = s.band([s.binding(p, [0, 1])]);
  // A warp whose grid has a NaN point and an infinite one.
  const warp = s.warp({
    id: "W",
    rows: 1,
    cols: 1,
    keyforms: [{ points: [NaN, 0, 1, 0, 0, Infinity, 1, 1] }],
  });
  const rot = s.rotation({
    id: "R",
    keyforms: [{ angle: 30, x: 0, y: 0, scale: 1 }],
  });
  // Non-finite values in a mesh's own keyforms, on two keyforms (∞ − ∞ = NaN).
  const a = s.mesh({
    id: "A",
    band,
    keyforms: [
      { positions: [NaN, 0, Infinity, 1, -Infinity, 0, 3e38, 3e38] },
      { positions: [0, NaN, -Infinity, 1, Infinity, -3e38, 1, 1] },
    ],
    triangles: [0, 1, 2, 1, 3, 2],
  });
  // Finite meshes under the bad warp, inside and outside its grid.
  s.mesh({
    id: "B",
    deformer: warp,
    keyforms: [{ positions: [0.2, 0.2, 0.8, 0.2, 0.5, 0.8] }],
    masks: [a],
  });
  s.mesh({
    id: "C",
    deformer: warp,
    // From version 6, an advanced blend code (multiply), so it draws in the layered pipeline.
    ...(version >= 6 ? { blendMode: 6 } : {}),
    keyforms: [{ positions: [-3, -3, 5, 0.5, 0.5, 9] }],
  });
  // A rotation child with huge and infinite positions, glued to a finite mesh.
  const d = s.mesh({
    id: "D",
    deformer: rot,
    keyforms: [{ positions: [3e38, 0, -Infinity, 1, 0, NaN] }],
  });
  const e = s.mesh({ id: "E", keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
  s.glue({ id: "G", a: d, b: e, pairs: [[0, 0.5, 0, 0.5]] });
  return s;
}

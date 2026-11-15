/**
 * A mesh with blend shapes that becomes inactive through its part or its
 * deformer while its own inputs stay unchanged. While inactive, each
 * evaluation adds its blend-shape contribution to its reported vertices
 * (C29). When it becomes active again, the incremental evaluation must
 * recompute its vertices, as a full evaluation does: every mode agrees bit
 * for bit, and the vertices are those before it became inactive.
 */
import { describe, expect, it } from "vitest";
import { loadMoc } from "../src/core/moc/model.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import { Synth } from "./support/synth.js";
import { MODES, output, same } from "./support/evaluate.js";

/**
 * K (0–2) switches a part off at 2 (its keys are 0 and 1): the mesh's own
 * part, or the part of its deformer, a warp whose own inputs never change.
 * BS is the mesh's blend shape.
 */
function model(through: "part" | "deformer") {
  const s = new Synth(5);
  const K = s.param("K", 0, 2, 0);
  const BS = s.param("BS", 0, 1, 0, { type: 1 });
  const band = s.band([s.binding(K, [0, 1])]);
  const Root = s.part({ id: "Root" });
  const P = s.part({ id: "P", band, keyforms: [{ drawOrder: 500 }, { drawOrder: 500 }] });
  const W =
    through === "deformer"
      ? s.warp({
          id: "W",
          part: P,
          rows: 1,
          cols: 1,
          keyforms: [{ points: [0, 0, 1, 0, 0, 1, 1, 1] }],
        })
      : -1;
  const M = s.mesh({
    id: "M",
    part: through === "part" ? P : Root,
    ...(W >= 0 ? { deformer: W } : {}),
    keyforms: [{ positions: [0.1, 0.1, 0.9, 0.1, 0.1, 0.9] }],
  });
  s.blendShape("mesh", M, {
    param: BS,
    keys: [0, 1],
    base: 0,
    keyforms: [{ positions: [0, 0, 0, 0, 0, 0] }, { positions: [0.25, 0, 0, 0.25, 0, 0] }],
  });
  return { model: loadMoc(s.build()), K, BS };
}

describe("a blend-shape mesh switched off and on by its parent", () => {
  for (const through of ["part", "deformer"] as const)
    it(`through its ${through}: the modes agree, and the vertices come back`, () => {
      const { model: m, K, BS } = model(through);
      // K per evaluation: active, off for three evaluations, active again.
      const steps = [0, 2, 2, 2, 0, 0];
      const runs = MODES.map((mode) => {
        const inst = new ModelInstance(m, mode);
        inst.setParameter(BS, 1);
        return steps.map((k) => {
          inst.setParameter(K, k);
          inst.evaluate();
          return output(inst);
        });
      });
      for (const run of runs.slice(1)) expect(same(run, runs[0])).toBe(true);
      const run = runs[0]!;
      expect(run[0]!.active[0]).toBe(1);
      expect(run[1]!.active[0]).toBe(0);
      // While inactive, the contributions accumulate on the reported vertices.
      expect(same(run[3]!.vertices, run[1]!.vertices)).toBe(false);
      // Active again: the vertices are recomputed.
      expect(run[4]!.active[0]).toBe(1);
      expect(same(run[4]!.vertices, run[0]!.vertices)).toBe(true);
      expect(same(run[5]!.vertices, run[0]!.vertices)).toBe(true);
    });
});

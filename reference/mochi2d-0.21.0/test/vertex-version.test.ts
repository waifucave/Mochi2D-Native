/**
 * The evaluator's per-drawable vertex versions: renderers skip
 * re-uploading vertices whose version did not change, so an unchanged version
 * must mean unchanged vertices, through any history.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadMoc } from "../src/core/moc/model.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import { seededRandom } from "../src/core/testing/poses.js";
import { DEEPSEEK_MOC, craftDeepseek } from "./support/crafted.js";

const model = loadMoc(readFileSync(DEEPSEEK_MOC));
const snapshot = (inst: ModelInstance) => inst.drawableVertices.map((v) => Float32Array.from(v));

/** Checks that every drawable whose vertices changed also changed version; returns how many did. */
function check(inst: ModelInstance, before: Float32Array[], versions: Uint32Array, step: string) {
  let changed = 0;
  inst.drawableVertices.forEach((v, d) => {
    const same = v.every((x, k) => Object.is(x, before[d]![k]));
    if (!same) {
      changed++;
      expect(inst.drawableVertexVersion[d], `${step}: drawable ${d} moved, same version`).not.toBe(
        versions[d],
      );
    }
  });
  return changed;
}

describe("drawable vertex versions", () => {
  it("change whenever vertices change, through random edits, no-op evaluations and part opacities", () => {
    const inst = new ModelInstance(model);
    const rnd = seededRandom(42);
    const P = model.parameters.ids.length;
    let bumps = 0;
    for (let step = 0; step < 60; step++) {
      const before = snapshot(inst);
      const versions = Uint32Array.from(inst.drawableVertexVersion);
      const kind = step % 4;
      if (kind === 0 || kind === 1) {
        const i = Math.floor(rnd() * P);
        const lo = model.parameters.min[i]!;
        const hi = model.parameters.max[i]!;
        inst.setParameter(i, lo + rnd() * (hi - lo));
      } else if (kind === 2) {
        inst.setPartOpacity(Math.floor(rnd() * model.parts.ids.length), rnd());
      } // kind 3: evaluate with no change
      inst.evaluate();
      check(inst, before, versions, `step ${step}`);
      const changed = inst.drawableVertexVersion.filter((v, d) => v !== versions[d]).length;
      if (kind === 3) expect(changed, `step ${step}: a no-op evaluation bumped versions`).toBe(0);
      bumps += changed;
    }
    expect(bumps).toBeGreaterThan(0);
  });

  it("keep changing for glued meshes while glue pulls toward an inactive partner (C4)", () => {
    const a680 = model.meshes.ids.indexOf("ArtMesh680");
    const crafted = loadMoc(
      craftDeepseek((f) => {
        (f["mesh.enabled"] as number[])[a680] = 0;
      }),
    );
    const d661 = crafted.meshes.ids.indexOf("ArtMesh661");
    const inst = new ModelInstance(crafted);
    for (let k = 0; k < 3; k++) {
      const before = snapshot(inst);
      const versions = Uint32Array.from(inst.drawableVertexVersion);
      inst.evaluate(); // no input change, but the glue drifts
      expect(check(inst, before, versions, `evaluation ${k}`)).toBeGreaterThan(0);
      expect(inst.drawableVertexVersion[d661]).not.toBe(versions[d661]);
    }
  });
});

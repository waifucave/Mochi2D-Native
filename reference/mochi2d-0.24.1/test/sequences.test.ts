/**
 * Evaluation sequences (Q3, C11): a glued mesh that becomes
 * inactive keeps its stale output-space vertices, glue writes into them and
 * the writes accumulate; becoming active again restores everything. One
 * instance per sequence, one evaluation per step after creation. The crafts
 * are built at test time from DeepSeek-chan's file.
 */
import { describe, expect, it } from "vitest";
import { loadMoc } from "../src/core/moc/model.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import { bindingKeys, craftDeepseek, deepseekSections, setLastKey } from "./support/crafted.js";

type Point = [number, number];

/** Runs `values` of one parameter as steps, returning the instance after creation and after each step. */
function sequence(moc: Uint8Array, param: string, values: number[]) {
  const model = loadMoc(moc);
  const inst = new ModelInstance(model);
  const p = inst.parameterIndex(param);
  const mesh = (id: string) => model.meshes.ids.indexOf(id);
  const states: { vertex: (id: string, v: number) => Point; active: (id: string) => boolean }[] =
    [];
  const capture = () => {
    // Copy the values now: the arrays are persistent.
    const copy = inst.drawableVertices.map((a) => Float32Array.from(a));
    const act = Uint8Array.from(inst.drawableActive);
    states.push({
      vertex: (id, v) => [copy[mesh(id)]![2 * v]!, copy[mesh(id)]![2 * v + 1]!],
      active: (id) => act[mesh(id)] === 1,
    });
  };
  capture(); // after creation
  for (const x of values) {
    inst.setParameter(p, x);
    inst.evaluate();
    capture();
  }
  return states;
}

const near = (got: Point, want: Point, what: string, tol = 1e-6) => {
  expect(Math.abs(got[0] - want[0]), `${what} x: ${got[0]} vs ${want[0]}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(got[1] - want[1]), `${what} y: ${got[1]} vs ${want[1]}`).toBeLessThanOrEqual(tol);
};

describe("sequences (C11)", () => {
  it("q3a: ArtMesh198 goes inactive, its glue partner ArtMesh101 stays active", () => {
    expect(bindingKeys(46)).toEqual([0, 1]);
    const states = sequence(
      craftDeepseek((f) => setLastKey(f, 46, 0.5)),
      "ParamMouthOpenY",
      [0.2, 1, 1, 1, 0.2, 1],
    );
    // Expected reported vertices: step, active, ArtMesh198 v13, ArtMesh101 v13, ArtMesh101 v0.
    const table: [boolean, Point, Point, Point][] = [
      [true, [-0.01279123, 0.555346], [-0.01279123, 0.555346], [-0.00003548086, 0.555465]],
      [true, [-0.01326519, 0.5561851], [-0.01326519, 0.5561851], [-0.00003290155, 0.5566921]],
      [false, [-0.01289533, 0.4340729], [-0.01289534, -0.4340731], [-0.00003290155, -0.5566921]],
      [false, [-0.01256613, 0.3253829], [-0.01256613, -0.3253831], [-0.00003290155, -0.5566921]],
      [false, [-0.01227311, 0.2286396], [-0.01227311, -0.2286398], [-0.00003290155, -0.5566921]],
      [true, [-0.01326519, 0.5561851], [-0.01326519, 0.5561851], [-0.00003290155, 0.5566921]],
      [false, [-0.01289533, 0.4340729], [-0.01289534, -0.4340731], [-0.00003290155, -0.5566921]],
    ];
    table.forEach(([active, m198v13, m101v13, m101v0], k) => {
      const s = states[k]!;
      const step = k === 0 ? "after creation" : `step ${k}`;
      expect(s.active("ArtMesh198"), `${step} active`).toBe(active);
      expect(s.active("ArtMesh101"), `${step} partner active`).toBe(true);
      near(s.vertex("ArtMesh198", 13), m198v13, `${step} ArtMesh198 v13`);
      near(s.vertex("ArtMesh101", 13), m101v13, `${step} ArtMesh101 v13`);
      near(s.vertex("ArtMesh101", 0), m101v0, `${step} ArtMesh101 v0`);
    });
  });

  it("q3b: Glue__ArtMesh715__ArtMesh626 (weights 0.5) meets near y = 0, then accumulates", () => {
    expect(bindingKeys(104)).toEqual([-1, 0, 0.1, 0.3, 0.7, 1].map(Math.fround));
    const states = sequence(
      craftDeepseek((f) => setLastKey(f, 104, 0.85)),
      "Param41",
      [0.2, 1, 1, 1, 0.2, 1],
    );
    // The first inactive step (step 2) and the next two.
    const want: [number, number][] = [
      [0.0003913343, -0.0003913641],
      [-0.1269716, 0.1269716],
      [-0.1906531, 0.1906531],
    ];
    want.forEach(([y715, y626], i) => {
      const s = states[2 + i]!;
      expect(
        Math.abs(s.vertex("ArtMesh715", 0)[1] - y715),
        `step ${2 + i} ArtMesh715 v0 y`,
      ).toBeLessThanOrEqual(1e-6);
      expect(
        Math.abs(s.vertex("ArtMesh626", 17)[1] - y626),
        `step ${2 + i} ArtMesh626 v17 y`,
      ).toBeLessThanOrEqual(1e-6);
    });
    // Becoming active again restores the step-1 state.
    expect(states[5]!.vertex("ArtMesh715", 0)).toEqual(states[1]!.vertex("ArtMesh715", 0));
    expect(states[5]!.vertex("ArtMesh626", 17)).toEqual(states[1]!.vertex("ArtMesh626", 17));
  });
});

describe("sequences (C10)", () => {
  it("q4c: an inactive drawable reports the opacity, draw order and colors of its last active evaluation", () => {
    expect(bindingKeys(45)).toEqual([0, 0.3].map(Math.fround));
    const sec = deepseekSections();
    const meshIds = sec.fields.get("mesh.id" as never) as string[];
    const m197 = meshIds.indexOf("ArtMesh197");
    const first = (sec.fields.get("mesh.firstKeyform" as never) as Int32Array)[m197]!;
    const firstColor = (sec.fields.get("mesh.firstColor" as never) as Int32Array)[m197]!;
    expect(firstColor).toBe(6370);
    const model = loadMoc(
      craftDeepseek((f) => {
        const set = (k: string, i: number, v: number) => ((f[k as never] as number[])[i] = v);
        set("meshKeyform.opacity", first, 1);
        set("meshKeyform.opacity", first + 1, 0.2);
        set("meshKeyform.drawOrder", first, 300);
        set("meshKeyform.drawOrder", first + 1, 700);
        const mul = [
          [1, 1, 1],
          [0.2, 0.4, 0.6],
        ];
        const scr = [
          [0, 0, 0],
          [0.5, 0.3, 0.1],
        ];
        for (let k = 0; k < 2; k++)
          ["r", "g", "b"].forEach((ch, c) => {
            set(`multiplyColor.${ch}`, 6370 + k, mul[k]![c]!);
            set(`screenColor.${ch}`, 6370 + k, scr[k]![c]!);
          });
        set("group.maxDrawOrder", 0, 1000);
        set("group.minDrawOrder", 0, 0);
      }),
    );
    const inst = new ModelInstance(model);
    const d = model.meshes.ids.indexOf("ArtMesh197");
    const mouth = inst.parameterIndex("ParamMouthOpenY");
    const part14 = model.parts.ids.indexOf("Part14");
    const rgb = (a: Float32Array) => Array.from(a.subarray(3 * d, 3 * d + 3));
    const check = (
      step: string,
      active: boolean,
      opacity: number,
      drawOrder: number,
      multiply: number[],
      screen: number[],
      renderOrder: number,
    ) => {
      expect(inst.drawableActive[d] === 1, `${step} active`).toBe(active);
      expect(inst.drawableOpacity[d], `${step} opacity`).toBeCloseTo(opacity, 5);
      expect(inst.drawableDrawOrder[d], `${step} draw order`).toBe(drawOrder);
      rgb(inst.drawableMultiply).forEach((v, c) =>
        expect(v, `${step} multiply ${c}`).toBeCloseTo(multiply[c]!, 5),
      );
      rgb(inst.drawableScreen).forEach((v, c) =>
        expect(v, `${step} screen ${c}`).toBeCloseTo(screen[c]!, 5),
      );
      expect(inst.drawableRenderOrder[d], `${step} render order`).toBe(renderOrder);
    };
    const step = (mouthOpen: number, part?: number) => {
      inst.setParameter(mouth, mouthOpen);
      if (part !== undefined) inst.setPartOpacity(part14, part);
      inst.evaluate();
    };
    const c1 = [0.6, 0.7, 0.8];
    const s1 = [0.25, 0.15, 0.05];
    const c5 = [1 / 3, 0.5, 2 / 3];
    const s5 = [0.416667, 0.25, 0.083333];
    // The expected values.
    check("after creation", true, 1, 300, [1, 1, 1], [0, 0, 0], 4);
    step(0.15);
    check("s1", true, 0.6, 500, c1, s1, 419);
    step(1);
    check("s2", false, 0.6, 500, c1, s1, 4);
    step(1, 0.5);
    check("s3", false, 0.6, 500, c1, s1, 4);
    step(0.15);
    check("s4", true, 0.3, 500, c1, s1, 419);
    step(0.25, 1);
    check("s5", true, 1 / 3, 633, c5, s5, 714);
    step(0.5);
    check("s6", false, 1 / 3, 633, c5, s5, 4);
    step(0.5, 0.25);
    check("s7", false, 1 / 3, 633, c5, s5, 4);
    step(1);
    check("s8", false, 1 / 3, 633, c5, s5, 4);
  });

  it("a drawable that was never active reports zeros", () => {
    const sec = deepseekSections();
    const meshIds = sec.fields.get("mesh.id" as never) as string[];
    const d = meshIds.indexOf("ArtMesh197");
    const model = loadMoc(
      craftDeepseek((f) => {
        (f["mesh.enabled" as never] as number[])[d] = 0;
      }),
    );
    const inst = new ModelInstance(model);
    inst.evaluate();
    expect(inst.drawableActive[d]).toBe(0);
    expect(inst.drawableOpacity[d]).toBe(0);
    expect(inst.drawableDrawOrder[d]).toBe(0);
    expect(Array.from(inst.drawableMultiply.subarray(3 * d, 3 * d + 3))).toEqual([0, 0, 0]);
    expect(Array.from(inst.drawableScreen.subarray(3 * d, 3 * d + 3))).toEqual([0, 0, 0]);
  });
});

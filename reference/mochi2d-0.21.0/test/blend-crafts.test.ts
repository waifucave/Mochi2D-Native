/**
 * The C29 and C30 cases, on crafts of DeepSeek-chan built here in memory
 * from the committed model (nothing crafted is written to disk).
 *
 * - C29 refinements: an inactive mesh's blend-shape
 *   contribution is added before glue, so glue acts on the sum; a disabled
 *   mesh behaves like one made inactive by an out-of-range binding; the
 *   creation evaluation adds the contribution too.
 * - C30 for parts: the part-blend craft, probed through render order.
 *
 * Expected values are the test vectors of those cases, printed to six
 * decimals.
 */
import { describe, expect, it } from "vitest";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { ModelInstance, type InstanceOptions } from "../src/core/eval/instance.js";
import { wasmKernelsAvailable } from "../src/core/eval/kernels.js";
import { craftDeepseek, deepseekMocBytes, type Fields } from "../tools/lib/catalog/moc-crafts.js";

const MODES: InstanceOptions[] = [
  { kernels: "js" },
  ...(wasmKernelsAvailable() ? ([{ kernels: "wasm" }] as InstanceOptions[]) : []),
];

const base = loadMoc(deepseekMocBytes());
const M = base.meshes.ids;
const P = base.parameters.ids;
const nums = (f: Fields, key: string) => f[key as keyof Fields] as number[];
const param52 = P.indexOf("Param52");

/**
 * The C29 crafts ("New crafts"), value edits only:
 * - ArtMesh729…732 lose their Param52 contribution (the non-base keyforms of
 *   that binding get the base keyform's positions); ArtMesh733 keeps its own;
 * - `disabled`: ArtMesh733's enabled flag is 0;
 * - `outOfRange`: 100 is added to every key of Warp698's binding
 *   (Param_Angle_Rotation88, 13 keys), so the default 0 is out of range;
 * - `default52`: Param52's default; `glueOff`: Glue_3_4_4's intensity 0.
 */
function craft(o: {
  disabled?: boolean;
  outOfRange?: boolean;
  default52?: number;
  glueOff?: boolean;
}): MocModel {
  return loadMoc(
    craftDeepseek((f) => {
      const pos = nums(f, "positions");
      for (const id of ["ArtMesh729", "ArtMesh730", "ArtMesh731", "ArtMesh732"]) {
        const i = M.indexOf(id);
        const b = base.blendShapes.mesh[i]!.find((x) => x.parameter === param52)!;
        const n = 2 * base.meshes.vertexCount[i]!;
        const from = base.keyforms.meshFirstPosition[b.firstKeyform + b.baseKey]!;
        for (let k = 0; k < b.keys.length; k++) {
          if (k === b.baseKey) continue;
          const to = base.keyforms.meshFirstPosition[b.firstKeyform + k]!;
          for (let j = 0; j < n; j++) pos[to + j] = pos[from + j]!;
        }
      }
      if (o.disabled) nums(f, "mesh.enabled")[M.indexOf("ArtMesh733")] = 0;
      if (o.outOfRange) {
        const w = base.deformers.ids.indexOf("Warp698");
        const binding = base.bands[base.deformers.band[w]!]!.bindings[0]!;
        const first = nums(f, "binding.firstKey")[binding]!;
        const n = nums(f, "binding.keyCount")[binding]!;
        for (let k = 0; k < n; k++) nums(f, "keys")[first + k]! += 100;
      }
      if (o.default52 !== undefined) nums(f, "parameter.default")[param52] = o.default52;
      if (o.glueOff) {
        const g = base.glues.ids.indexOf("Glue_3_4_4");
        const first = nums(f, "glue.firstKeyform")[g]!;
        const n = nums(f, "glue.keyformCount")[g]!;
        for (let k = 0; k < n; k++) nums(f, "glueKeyform.intensity")[first + k] = 0;
      }
    }),
  );
}

const vertex = (inst: ModelInstance, id: string, k: number): [number, number] => {
  const v = inst.drawableVertices[M.indexOf(id)]!;
  return [v[2 * k]!, v[2 * k + 1]!];
};

function expectNear(actual: [number, number], expected: [number, number], tol: number): void {
  expect(Math.abs(actual[0] - expected[0]), `x ${actual[0]} vs ${expected[0]}`).toBeLessThanOrEqual(
    tol,
  );
  expect(Math.abs(actual[1] - expected[1]), `y ${actual[1]} vs ${expected[1]}`).toBeLessThanOrEqual(
    tol,
  );
}

/** A fresh instance (the creation evaluation), then one evaluation at Param52 = v. */
function once(model: MocModel, v: number, mode: InstanceOptions = {}): ModelInstance {
  const inst = new ModelInstance(model, mode);
  inst.setParameter(param52, v);
  inst.evaluate();
  return inst;
}

/** The vectors' six printed decimals, plus room for float32 rounding. */
const PRINTED = 6e-7;

describe("C29 and glue: the contribution is added before glue", () => {
  const variants = {
    "out of range": craft({ outOfRange: true }),
    disabled: craft({ disabled: true }),
  };

  it.each(Object.keys(variants))("%s: the test vector", (name) => {
    const model = variants[name as keyof typeof variants];
    for (const mode of MODES) {
      const i0 = once(model, 0, mode);
      const i1 = once(model, 1, mode);
      expect(i1.drawableActive[M.indexOf("ArtMesh733")]).toBe(0);
      expect(i1.drawableActive[M.indexOf("ArtMesh732")]).toBe(1);
      // ArtMesh733 vertex 84 (inactive: keyform space, not y-negated) and its
      // glue partner ArtMesh732 vertex 76 (active output).
      expectNear(vertex(i0, "ArtMesh733", 84), [0.05875, 0.189445], PRINTED);
      expectNear(vertex(i1, "ArtMesh733", 84), [0.057455, 0.189794], PRINTED);
      expectNear(vertex(i0, "ArtMesh732", 76), [0.05875, -0.189445], PRINTED);
      expectNear(vertex(i1, "ArtMesh732", 76), [0.057455, -0.189794], PRINTED);
    }
  });

  it("over all 32 glue pairs and three values, glue acts on the sum (both variants alike)", () => {
    // c(v): ArtMesh733's contribution in keyform space, read from the glue-off
    // craft: never active, so one evaluation at v leaves exactly c(v).
    const bare = craft({ outOfRange: true, glueOff: true });
    const g = base.glues.ids.indexOf("Glue_3_4_4");
    const va = base.glues.vertexA[g]!;
    const vb = base.glues.vertexB[g]!;
    const wa = base.glues.weightA[g]!;
    const wb = base.glues.weightB[g]!;
    expect(va.length).toBe(32);
    const c1 = vertex(once(bare, 1), "ArtMesh733", 84);
    expectNear(c1, [-0.001636, 0.000441], PRINTED);
    for (const model of Object.values(variants)) {
      const at0 = once(model, 0);
      for (const v of [1, 0.5, -0.7]) {
        const c = once(bare, v).drawableVertices[M.indexOf("ArtMesh733")]!;
        const at = once(model, v);
        for (let p = 0; p < va.length; p++) {
          const b = vb[p]!;
          const a = va[p]!;
          // Before glue: ArtMesh733 moves by c·(1 − w_B); its active partner by
          // (c_x·w_A, −c_y·w_A), as its output is y-negated.
          const d733 = vertex(at, "ArtMesh733", b).map(
            (x, k) => x - vertex(at0, "ArtMesh733", b)[k]!,
          );
          const d732 = vertex(at, "ArtMesh732", a).map(
            (x, k) => x - vertex(at0, "ArtMesh732", a)[k]!,
          );
          expectNear(
            d733 as [number, number],
            [c[2 * b]! * (1 - wb[p]!), c[2 * b + 1]! * (1 - wb[p]!)],
            5e-8,
          );
          expectNear(d732 as [number, number], [c[2 * b]! * wa[p]!, -c[2 * b + 1]! * wa[p]!], 5e-8);
        }
      }
    }
  });

  it("a disabled mesh gives the same arrays as an out-of-range one", () => {
    for (const v of [0, 1, 0.5, -0.7]) {
      const a = once(variants["out of range"], v);
      const b = once(variants.disabled, v);
      for (const id of ["ArtMesh732", "ArtMesh733"])
        expect(Array.from(b.drawableVertices[M.indexOf(id)]!)).toEqual(
          Array.from(a.drawableVertices[M.indexOf(id)]!),
        );
    }
  });
});

describe("C29 at creation: the creation evaluation adds the contribution", () => {
  it("with glue off, ArtMesh733 holds 1, 2, 3 and 4 times c(0.5)", () => {
    const model = craft({ outOfRange: true, default52: 0.5, glueOff: true });
    const vectors: [number, number][] = [
      [-0.011187, 0.003018],
      [-0.022375, 0.006036],
      [-0.033562, 0.009054],
      [-0.044749, 0.012072],
    ];
    for (const mode of MODES) {
      const inst = new ModelInstance(model, mode); // the creation evaluation, at the default 0.5
      const c = Array.from(inst.drawableVertices[M.indexOf("ArtMesh733")]!);
      expect(c).toHaveLength(2 * 141);
      let expected = c;
      expectNear(vertex(inst, "ArtMesh733", 123), vectors[0]!, PRINTED);
      for (let n = 1; n <= 3; n++) {
        inst.evaluate(); // at the defaults
        expected = expected.map((x, i) => Math.fround(x + c[i]!));
        expect(Array.from(inst.drawableVertices[M.indexOf("ArtMesh733")]!)).toEqual(expected);
        expectNear(vertex(inst, "ArtMesh733", 123), vectors[n]!, PRINTED);
      }
    }
  });

  it("with glue active, glue pulls the glued vertex at every evaluation, the creation one included", () => {
    const model = craft({ outOfRange: true, default52: 0.5 });
    // Vertex 0 of ArtMesh733 after creation and after three evaluations.
    // With six printed decimals and float32 rounding along the way, the
    // bound here is 2e-6.
    const vectors: [number, number][] = [
      [0.156858, 0.624095],
      [0.176465, 0.702107],
      [0.178916, 0.711858],
      [0.179222, 0.713077],
    ];
    for (const mode of MODES) {
      const inst = new ModelInstance(model, mode);
      expectNear(vertex(inst, "ArtMesh733", 0), vectors[0]!, 2e-6);
      for (let n = 1; n <= 3; n++) {
        inst.evaluate();
        expectNear(vertex(inst, "ArtMesh733", 0), vectors[n]!, 2e-6);
      }
    }
  });
});

/**
 * The part-blend craft of C30: three part keyforms (+1, 0, −1) and one
 * blend-shape keyform binding (parameter binding 9, Param33's keys −1, 0, 1)
 * appended, targeting Part18 (part 90), so B = −Param33. Part30's keyforms
 * all get the probe value `probe`. `blend: false` gives the control.
 */
function partCraft(probe: number, blend: boolean): MocModel {
  const p18 = base.parts.ids.indexOf("Part18");
  const p30 = base.parts.ids.indexOf("Part30");
  return loadMoc(
    craftDeepseek((f, { counts }) => {
      const order = nums(f, "partKeyform.drawOrder");
      const first30 = base.parts.firstKeyform[p30]!;
      for (let k = 0; k < 3; k++) order[first30 + k] = probe;
      if (!blend) return;
      const firstKeyform = order.length; // 151
      order.push(1, 0, -1);
      counts[6]! += 3;
      const binding = nums(f, "bsKeyformBinding.binding").length; // 1007
      nums(f, "bsKeyformBinding.binding").push(9);
      nums(f, "bsKeyformBinding.firstKeyform").push(firstKeyform);
      nums(f, "bsKeyformBinding.keyformCount").push(3);
      nums(f, "bsKeyformBinding.firstConstraintEntry").push(counts[29]!);
      nums(f, "bsKeyformBinding.constraintEntryCount").push(0);
      counts[26]! += 1;
      const target = (k: string) => (f[k as keyof Fields] ??= []) as number[];
      target("partTarget.part").push(p18);
      target("partTarget.firstBinding").push(binding);
      target("partTarget.bindingCount").push(1);
      counts[32] = 1;
    }),
  );
}

describe("C30 for parts: the part-blend craft", () => {
  const p18 = base.parts.ids.indexOf("Part18");
  const p30 = base.parts.ids.indexOf("Part30");
  const hip = P.indexOf("HipAngleX");
  const q33 = P.indexOf("Param33");

  /** Whether Part18's block is drawn before Part30's: their smallest render orders. */
  const part18First = (model: MocModel, inst: ModelInstance) => {
    const under = (d: number, part: number) => {
      for (let p = model.meshes.part[d]!; p >= 0; p = model.parts.parent[p]!)
        if (p === part) return true;
      return false;
    };
    let min18 = Infinity;
    let min30 = Infinity;
    for (let d = 0; d < model.meshes.ids.length; d++) {
      const r = inst.drawableRenderOrder[d]!;
      if (under(d, p18)) min18 = Math.min(min18, r);
      if (under(d, p30)) min30 = Math.min(min30, r);
    }
    return min18 < min30;
  };

  const run = (model: MocModel, h: number, b: number) => {
    const inst = new ModelInstance(model);
    inst.setParameter(hip, h);
    inst.setParameter(q33, b);
    inst.evaluate();
    return inst;
  };

  it("checks that the craft holds what C30 describes", () => {
    const m = partCraft(499, true);
    expect(m.keyforms.partDrawOrder.length).toBe(154);
    expect(m.blendShapes.part[p18]).toHaveLength(1);
    const b = m.blendShapes.part[p18]![0]!;
    expect(m.parameters.ids[b.parameter]).toBe("Param33");
    expect(Array.from(b.keys)).toEqual([-1, 0, 1]);
    expect(b.baseKey).toBe(1);
    expect(Array.from(m.keyforms.partDrawOrder.subarray(151, 154))).toEqual([1, 0, -1]);
  });

  // [HipAngleX, Param33, key by the new rule, measured class: -1 ≤ 499, 0 = 500, 1 ≥ 501]
  const vectors: [number, number, number, number][] = [
    [12, 0.2, 499, -1], // B < 0; the old rule gave 500
    [-18, -0.8, 499, -1], // B > 0; the old rule gave 500
    [27, -0.3, 500, 0], // B > 0; the old rule gave 501
    [12, -0.7, 500, 0], // B > 0; the old rule gave 501
    [12, 0.5, 499, -1],
    [30, 0, 501, 1],
    [0, 0, 500, 0],
  ];

  it.each(vectors)(
    "HipAngleX %f, Param33 %f: key %i, and the render orders put it in its measured class",
    (h, b, key, cls) => {
      for (const probe of [499, 500]) {
        const model = partCraft(probe, true);
        const inst = run(model, h, b);
        expect(inst.partDrawOrder[p18]).toBe(key);
        // Ties keep file order: Part18's block comes first exactly when its key ≤ the probe.
        expect(part18First(model, inst)).toBe(key <= probe);
        expect(Math.sign(key - 500)).toBe(cls);
      }
    },
  );

  it("the controls (probe, no part blend shape) give trunc(D) whatever Param33 is", () => {
    for (const [h, b, key] of [
      [12, 0.2, 500],
      [3, 0.05, 500],
      [-18, -0.8, 499],
      [27, -0.3, 500],
    ] as const) {
      for (const probe of [499, 500]) {
        const model = partCraft(probe, false);
        const inst = run(model, h, b);
        expect(inst.partDrawOrder[p18]).toBe(key);
        expect(part18First(model, inst)).toBe(key <= probe);
      }
    }
  });
});

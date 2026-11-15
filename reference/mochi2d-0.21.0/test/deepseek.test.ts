/**
 * Self-checks against DeepSeek-chan (§1b.8 per-model data,
 * §1d.6 summary vectors and §1d.7 selected reference values).
 * Output-space values; scenarios are read from test/scenarios/deepseek/.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { readMocSections } from "../src/core/moc/read.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import { applyRequest, formatResultJson, snapshotInstance } from "../src/core/model/snapshot.js";
import { craftDeepseek } from "./support/crafted.js";
import { outputTriangles, outputUvs } from "../src/core/eval/static-output.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
const mocPath = join(DEEPSEEK, "大肥鱼.moc3");
const scenarioDir = join(root, "test", "scenarios", "deepseek");

interface Scenario {
  id: string;
  parameters?: Record<string, number>;
  partOpacities?: Record<string, number>;
}
const scenarios = new Map<string, Scenario>(
  readdirSync(scenarioDir).map((f) => {
    const s = JSON.parse(readFileSync(join(scenarioDir, f), "utf8")) as Scenario;
    return [s.id, s];
  }),
);

let model: MocModel;
let inst: ModelInstance;
const run = (id: string): string[] => {
  const s = scenarios.get(id);
  if (!s) throw new Error(`missing scenario ${id}`);
  const warnings = applyRequest(inst, {
    parameters: s.parameters ?? {},
    partOpacities: s.partOpacities ?? {},
  });
  inst.evaluate();
  return warnings;
};
const idx = (id: string) => {
  const i = model.meshes.ids.indexOf(id);
  if (i < 0) throw new Error(`no drawable ${id}`);
  return i;
};

beforeAll(() => {
  model = loadMoc(readFileSync(mocPath));
  inst = new ModelInstance(model);
});

describe("DeepSeek-chan file facts (§1b.8)", () => {
  it("has the documented header, counts and canvas", () => {
    const bytes = readFileSync(mocPath);
    expect(bytes.length).toBe(16498560);
    const s = readMocSections(bytes);
    expect(s.version).toBe(5);
    expect(s.bigEndian).toBe(false);
    const expected: Record<number, number> = {
      0: 147,
      1: 822,
      2: 723,
      3: 99,
      4: 715,
      5: 509,
      6: 151,
      7: 8860,
      8: 535,
      9: 847,
      10: 3670832,
      11: 236,
      12: 155,
      13: 123,
      14: 1918,
      15: 117934,
      16: 266004,
      17: 299,
      18: 4,
      19: 718,
      20: 38,
      21: 4940,
      22: 38,
      23: 10242,
      24: 10242,
      25: 175,
      26: 1007,
      27: 349,
      28: 13,
      29: 46,
      30: 18,
      31: 40,
      32: 0,
      33: 22,
      34: 0,
    };
    for (const [i, v] of Object.entries(expected))
      expect(s.counts[Number(i)], `count ${i}`).toBe(v);
    for (let i = 35; i < 64; i++) expect(s.counts[i]).toBe(0);
    expect(model.canvas).toEqual({
      pixelsPerUnit: 3749,
      originX: 1874.5,
      originY: 3848.5,
      width: 3749,
      height: 7697,
      flags: 0,
    });
  });

  it("splits keyforms into normal and blend-shape keyforms", () => {
    const sum = (a: Int32Array, counts: (i: number) => number) =>
      a.reduce((acc, _, i) => acc + counts(i), 0);
    const normal = (first: Int32Array, band: Int32Array) =>
      sum(first, (i) => model.bands[band[i]!]!.keyformCount);
    expect(normal(model.warps.firstKeyform, model.warps.band)).toBe(5842);
    expect(normal(model.rotations.firstKeyform, model.rotations.band)).toBe(457);
    expect(normal(model.meshes.firstKeyform, model.meshes.band)).toBe(808);
    expect(normal(model.parts.firstKeyform, model.parts.band)).toBe(151);
    expect(normal(model.glues.firstKeyform, model.glues.band)).toBe(38);
  });

  it("matches the derived structural facts", () => {
    const sizes = [0, 0, 0, 0, 0];
    for (const b of model.bands) sizes[b.bindings.length]!++;
    expect(sizes).toEqual([1, 92, 44, 16, 2]);
    expect(model.bands[0]!.bindings.length).toBe(0);
    const pairs = { rw: 0, rr: 0, wr: 0, ww: 0, root: 0 };
    const d = model.deformers;
    for (let i = 0; i < d.ids.length; i++) {
      const p = d.parent[i]!;
      if (p < 0) pairs.root++;
      else if (d.kind[i] === 1 && d.kind[p] === 0) pairs.rw++;
      else if (d.kind[i] === 1 && d.kind[p] === 1) pairs.rr++;
      else if (d.kind[i] === 0 && d.kind[p] === 1) pairs.wr++;
      else pairs.ww++;
    }
    expect(pairs).toEqual({ rw: 59, rr: 40, wr: 94, ww: 628, root: 1 });
    expect(Array.from(model.rotations.baseAngle).filter((a) => a !== 0).length).toBe(5);
    expect(model.keyforms.rotationMirrorX.every((x) => x === 0)).toBe(true);
    expect(model.keyforms.rotationMirrorY.every((x) => x === 0)).toBe(true);
    expect(model.warps.bilinear.every((x) => x === 1)).toBe(true);
    expect(model.parameters.type.reduce((a, b) => a + b, 0)).toBe(200);
    expect(model.parameters.ids.filter((_, i) => model.parameters.repeat[i])).toEqual([
      "Sweat1",
      "Sweat2",
      "Param140",
      "AniEyerolling",
    ]);
    const constrained = Object.values(model.blendShapes)
      .flat(2)
      .filter((b) => b.constraints.length > 0);
    // §1b.8 says "21 blend-shape keyform bindings carry constraints". In the file, 39 keyform
    // bindings carry constraints; they belong to 21 distinct blend-shape parameters, some
    // with 2–3 constraints.
    expect(constrained.length).toBe(39);
    expect(new Set(constrained.map((b) => b.parameter)).size).toBe(21);
    const pid = (id: string) => model.parameters.ids.indexOf(id);
    const chest = constrained.find((b) => b.parameter === pid("ChestX1"))!;
    expect(Array.from(chest.keys)).toEqual([-1, 0, 1]);
    expect(chest.baseKey).toBe(1);
    expect(chest.constraints[0]!.parameter).toBe(pid("Clothes2"));
    expect(Array.from(chest.constraints[0]!.keys)).toEqual([0, 1]);
    expect(Array.from(chest.constraints[0]!.weights)).toEqual([1, Math.fround(0.05)]);
    const cheeks = constrained.find((b) => b.parameter === pid("CheeksWiggleXR"))!;
    expect(cheeks.constraints[0]!.parameter).toBe(pid("ParamAngleX"));
    expect(Array.from(cheeks.constraints[0]!.keys)).toEqual([-30, 0, 30]);
    expect(Array.from(cheeks.constraints[0]!.weights)).toEqual([1, 1, 0]);
    expect(Array.from(model.parameters.keyLists[pid("ParamAngleX")]!)).toEqual([
      -30, -20, -10, 0, 10, 20, 30,
    ]);
    expect(Array.from(model.parameters.keyLists[pid("ParamMouthOpenY")]!)).toEqual(
      [0, 0.3, 0.35, 1].map(Math.fround),
    );
  });

  it("has the documented draw-order groups and part objects", () => {
    const g = model.groups;
    expect(g.objects.map((o) => o.length)).toEqual([674, 2, 21, 21]);
    expect(Array.from(g.entryCount)).toEqual([715, 42, 21, 21]);
    expect(Array.from(g.minDrawOrder)).toEqual([500, 499, 500, 500]);
    expect(Array.from(g.maxDrawOrder)).toEqual([500, 501, 500, 500]);
    const partObjects = g.objects.flat().filter((o) => o.kind === 1);
    const byId = Object.fromEntries(
      partObjects.map((o) => [model.parts.ids[o.index], o.nestedGroup]),
    );
    expect(byId).toEqual({ Part114: 1, Part18: 2, Part30: 3 });
    const partKeyforms = (id: string) => {
      const p = model.parts.ids.indexOf(id);
      const f = model.parts.firstKeyform[p]!;
      return Array.from(
        model.keyforms.partDrawOrder.subarray(
          f,
          f + model.bands[model.parts.band[p]!]!.keyformCount,
        ),
      );
    };
    expect(partKeyforms("Part18")).toEqual([499, 500, 501]);
    expect(partKeyforms("Part30")).toEqual([500, 500, 500]);
  });

  it("has the documented drawable data", () => {
    const me = model.meshes;
    expect(me.masks.filter((m) => m.length > 0).length).toBe(181);
    expect(Math.max(...me.masks.map((m) => m.length))).toBe(16);
    expect(Array.from(me.flags).filter((f) => f & 8).length).toBe(51);
    const flagCounts: Record<number, number> = {};
    for (const f of me.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
    expect(flagCounts).toEqual({ 4: 587, 6: 68, 12: 44, 5: 9, 14: 7 });
    expect(me.masks[idx("ArtMesh671")]!.length).toBe(0);
    expect([...new Set(me.texture)].sort()).toEqual([0, 1, 2, 3, 4]);
    const blend: Record<number, number> = {};
    for (const b of me.blendMode) blend[b] = (blend[b] ?? 0) + 1;
    expect(blend).toEqual({ 0: 631, 1: 9, 2: 75 });
    expect(me.ids[0]).toBe("ArtMesh94");
    expect(me.vertexCount[0]).toBe(50);
    expect(me.texture[0]).toBe(0);
    expect(me.flags[0]).toBe(4);
    expect(Array.from(me.triangles[0]!.subarray(0, 3))).toEqual([14, 17, 16]);
    expect(Array.from(outputTriangles(model, 0).subarray(0, 3))).toEqual([16, 17, 14]);
    expect(me.uvs[0]![0]).toBeCloseTo(0.901204, 6);
    expect(me.uvs[0]![1]).toBeCloseTo(0.456629, 6);
    expect(outputUvs(model, 0)[1]).toBeCloseTo(0.543371, 6);
    expect(model.offscreens.part.length).toBe(0);
  });
});

// §1d.6: [visible, total, n, Σx, Σy, Σop]
const SUMMARY: Record<string, [number, number, number, number, number]> = {
  "ds-default": [460, 40891, 60.5252, 10550.4451, 455.6235],
  "ds-pose-a": [461, 40966, 53.3266, 10472.8056, 454.7835],
  "ds-pose-b": [460, 40891, 319.4319, 10498.4182, 455.1195],
  "ds-clamp": [460, 40891, 363.8215, 10350.5874, 455.6235],
  "ds-key-snap": [460, 40891, 152.6914, 10419.342, 455.6235],
  "ds-mouth-in-range": [460, 40891, 60.5252, 10549.1514, 455.6235],
  "ds-mouth-out-of-range": [459, 40841, 60.5129, 10521.2835, 454.6235],
  "ds-gem-reflection": [461, 40894, 60.5167, 10551.8299, 455.7535],
  "ds-hip-neg": [460, 40891, -44.0358, 10550.1369, 455.6235],
  "ds-hip-pos": [460, 40891, 161.448, 10551.1293, 455.6235],
  "ds-blendshapes": [460, 40891, 467.7947, 16270.4693, 454.3735],
  "ds-repeat": [460, 40891, 60.5252, 10550.4451, 455.6235],
  "ds-unknown-ids": [460, 40891, 12.8768, 10550.4177, 455.6235],
  "ds-part-opacity": [436, 40251, 44.8429, 10161.4092, 411.2235],
};

describe("DeepSeek-chan summary vectors (§1d.6)", () => {
  it("covers the 14 catalog scenarios (plus 4 more)", () => {
    for (const id of Object.keys(SUMMARY)) expect(scenarios.has(id), id).toBe(true);
    expect(scenarios.size).toBe(18);
  });
  for (const [id, [vis, n, sx, sy, sop]] of Object.entries(SUMMARY)) {
    it(id, () => {
      run(id);
      let count = 0;
      let verts = 0;
      let X = 0;
      let Y = 0;
      let op = 0;
      const visible: number[] = [];
      for (let d = 0; d < model.meshes.ids.length; d++) {
        if (!inst.drawableVisible[d]) continue;
        count++;
        visible.push(d);
        op += inst.drawableOpacity[d]!;
        const v = inst.drawableVertices[d]!;
        verts += v.length / 2;
        for (let k = 0; k < v.length; k += 2) {
          X += v[k]!;
          Y += v[k + 1]!;
        }
      }
      expect(count).toBe(vis);
      expect(verts).toBe(n);
      expect(Math.abs(X - sx)).toBeLessThanOrEqual(1e-6 * n);
      expect(Math.abs(Y - sy)).toBeLessThanOrEqual(1e-6 * n);
      expect(Math.abs(op - sop)).toBeLessThanOrEqual(1e-4);
      const order = visible
        .sort((a, b) => inst.drawableRenderOrder[a]! - inst.drawableRenderOrder[b]!)
        .map((d) => model.meshes.ids[d]);
      expect(order.slice(0, 4)).toEqual(["ArtMesh187", "ArtMesh186", "ArtMesh185", "ArtMesh183"]);
      expect(order.slice(-3)).toEqual(["ArtMesh44", "ArtMesh2", "ArtMesh"]);
      // Render order is a permutation of 0…N−1.
      expect([...inst.drawableRenderOrder].sort((a, b) => a - b)).toEqual([
        ...Array(model.meshes.ids.length).keys(),
      ]);
    });
  }
});

interface Selected {
  scenario: string;
  id: string;
  visible: boolean;
  opacity?: number;
  drawOrder?: number;
  renderOrder: number;
  n?: number;
  v0?: [number, number];
  k?: number;
  vk?: [number, number];
  sum?: [number, number];
}
// §1d.7
const SELECTED: Selected[] = [
  {
    scenario: "ds-default",
    id: "ArtMesh187",
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 0,
    n: 153,
    v0: [-0.105465, 0.571793],
    k: 76,
    vk: [0.123086, 0.693472],
    sum: [0, 102.00818],
  },
  {
    scenario: "ds-default",
    id: "ArtMesh492",
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 215,
    n: 206,
    v0: [-0.224427, 0.014809],
    k: 103,
    vk: [-0.127223, -0.035158],
    sum: [-38.47461, -12.4787],
  },
  {
    scenario: "ds-default",
    id: "ArtMesh197",
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 419,
    n: 50,
    v0: [-0.017658, 0.562007],
    k: 25,
    vk: [0.015559, 0.558336],
    sum: [0.0123, 27.97965],
  },
  {
    scenario: "ds-default",
    id: "ArtMesh671",
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 46,
    n: 31,
    v0: [0.202689, -0.195299],
    k: 15,
    vk: [0.429798, -0.384397],
    sum: [9.94256, -12.34563],
  },
  { scenario: "ds-default", id: "ArtMesh436", visible: false, renderOrder: 395 },
  {
    scenario: "ds-pose-a",
    id: "ArtMesh184",
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 4,
    n: 251,
    v0: [-0.098689, 0.704435],
    k: 125,
    vk: [-0.053556, 0.096917],
    sum: [-26.4645, 68.27269],
  },
  {
    scenario: "ds-pose-a",
    id: "ArtMesh460",
    visible: true,
    opacity: 0.333333,
    drawOrder: 500,
    renderOrder: 328,
    n: 75,
    v0: [0.010715, 0.386369],
    k: 37,
    vk: [0.019057, 0.335944],
    sum: [0.86387, 28.40153],
  },
  {
    scenario: "ds-pose-b",
    id: "ArtMesh186",
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 1,
    n: 292,
    v0: [-0.03162, 0.573067],
    k: 146,
    vk: [0.042137, 0.880775],
    sum: [19.59138, 211.17057],
  },
  {
    scenario: "ds-clamp",
    id: "ArtMesh184",
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 4,
    n: 251,
    v0: [-0.064656, 0.707968],
    k: 125,
    vk: [-0.058845, 0.209767],
    sum: [-25.07371, 87.89486],
  },
  {
    scenario: "ds-key-snap",
    id: "ArtMesh339",
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 12,
    n: 227,
    v0: [0.096095, 0.716543],
    k: 113,
    vk: [0.030836, 0.013461],
    sum: [24.16385, 47.44695],
  },
  {
    scenario: "ds-mouth-in-range",
    id: "ArtMesh197",
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 419,
    n: 50,
    v0: [-0.014973, 0.559069],
    k: 25,
    vk: [0.013262, 0.5554],
    sum: [0.0123, 27.83104],
  },
  { scenario: "ds-mouth-out-of-range", id: "ArtMesh197", visible: false, renderOrder: 419 },
  {
    scenario: "ds-mouth-out-of-range",
    id: "ArtMesh90",
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 435,
    n: 159,
    v0: [0.01211, 0.557381],
    k: 79,
    vk: [-0.00856, 0.553231],
    sum: [-0.00001, 87.99988],
  },
  {
    scenario: "ds-gem-reflection",
    id: "ArtMesh436",
    visible: true,
    opacity: 0.13,
    drawOrder: 500,
    renderOrder: 395,
    n: 3,
    v0: [-0.000521, 0.457098],
    k: 1,
    vk: [-0.007795, 0.457702],
    sum: [-0.00853, 1.38484],
  },
  {
    scenario: "ds-blendshapes",
    id: "ArtMesh582",
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 120,
    n: 231,
    v0: [-0.056715, -0.112955],
    k: 115,
    vk: [-0.057445, -0.121996],
    sum: [-8.54289, -35.3115],
  },
  {
    scenario: "ds-part-opacity",
    id: "ArtMesh280",
    visible: true,
    opacity: 0.5,
    drawOrder: 500,
    renderOrder: 521,
  },
  {
    scenario: "ds-part-opacity",
    id: "ArtMesh633",
    visible: true,
    opacity: Math.fround(0.8),
    drawOrder: 500,
    renderOrder: 116,
  },
  { scenario: "ds-part-opacity", id: "ArtMesh50", visible: false, renderOrder: 495 },
];

describe("DeepSeek-chan selected values (§1d.7)", () => {
  for (const s of SELECTED) {
    it(`${s.scenario}: ${s.id}`, () => {
      run(s.scenario);
      const d = idx(s.id);
      expect(inst.drawableVisible[d] === 1).toBe(s.visible);
      expect(inst.drawableRenderOrder[d]).toBe(s.renderOrder);
      if (!s.visible) return;
      expect(Math.abs(inst.drawableOpacity[d]! - s.opacity!)).toBeLessThanOrEqual(1e-5);
      expect(inst.drawableDrawOrder[d]).toBe(s.drawOrder);
      if (s.n === undefined) return;
      const v = inst.drawableVertices[d]!;
      expect(v.length / 2).toBe(s.n);
      const err = (x: number, y: number, e: [number, number]) =>
        Math.max(Math.abs(x - e[0]), Math.abs(y - e[1]));
      expect(err(v[0]!, v[1]!, s.v0!)).toBeLessThanOrEqual(2e-5);
      expect(err(v[2 * s.k!]!, v[2 * s.k! + 1]!, s.vk!)).toBeLessThanOrEqual(2e-5);
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < v.length; i += 2) {
        sx += v[i]!;
        sy += v[i + 1]!;
      }
      expect(err(sx, sy, s.sum!)).toBeLessThanOrEqual(s.n * 2e-5);
    });
  }

  it("hides all 24 drawables under Part37 in ds-part-opacity", () => {
    run("ds-part-opacity");
    const p37 = model.parts.ids.indexOf("Part37");
    const under = (part: number): boolean =>
      part >= 0 && (part === p37 || under(model.parts.parent[part]!));
    const ds = model.meshes.part.reduce<number[]>((a, p, d) => (under(p) ? [...a, d] : a), []);
    expect(ds.length).toBe(24);
    expect(ds.every((d) => inst.drawableVisible[d] === 0)).toBe(true);
  });

  it("has the documented colors at default", () => {
    run("ds-default");
    const color = (id: string) => {
      const d = idx(id);
      return [
        Array.from(inst.drawableMultiply.subarray(d * 3, d * 3 + 3)),
        Array.from(inst.drawableScreen.subarray(d * 3, d * 3 + 3)),
      ];
    };
    const near = (a: number[][], e: number[][]) =>
      a.flat().forEach((x, i) => expect(Math.abs(x - e.flat()[i]!)).toBeLessThanOrEqual(1e-4));
    near(color("ArtMesh197"), [
      [1, 1, 1],
      [1, 1, 1],
    ]);
    near(color("ArtMesh418"), [
      [0, 0, 0],
      [0.3922, 0.3922, 0.4549],
    ]);
    near(color("ArtMesh201"), [
      [0.6667, 0.6667, 0.6667],
      [0, 0, 0],
    ]);
    near(color("ArtMesh246"), [
      [0, 0, 0],
      [1, 0.9647, 0.9608],
    ]);
  });

  it("swaps the HipAngleX groups at +30 only", () => {
    const ro = (scenario: string) => {
      run(scenario);
      return [
        inst.drawableRenderOrder[idx("ArtMesh633")],
        inst.drawableRenderOrder[idx("ArtMesh655")],
      ];
    };
    expect(ro("ds-default")).toEqual([116, 137]);
    expect(ro("ds-hip-neg")).toEqual([116, 137]);
    expect(ro("ds-hip-pos")).toEqual([137, 116]);
  });

  it("reports applied parameter values", () => {
    const value = (id: string) => inst.parameterValues[model.parameters.ids.indexOf(id)];
    run("ds-clamp");
    expect([value("ParamAngleX"), value("ParamAngleY"), value("ParamEyeLOpen")]).toEqual([
      30, -30, 1.5,
    ]);
    run("ds-repeat");
    expect([value("Sweat1"), value("AniEyerolling"), value("Param140")]).toEqual([1.25, 45, -0.5]);
    run("ds-key-snap");
    expect([value("ParamAngleX"), value("ParamAngleY"), value("ParamAngleZ")]).toEqual([
      0.0008999999845400453, 29.999500274658203, 15.000499725341797,
    ]);
  });

  it("warns about unknown IDs", () => {
    expect(run("ds-unknown-ids")).toEqual([
      "unknown parameter NoSuchParam",
      "unknown part NoSuchPart",
    ]);
  });

  it("keeps glued vertex pairs (weights summing to 1) together when both meshes are visible", () => {
    const g = model.glues;
    // C3: a sum-1 pair whose two vertices no later pair moves again
    // (2329 of the 2411) coincides within 1.2e-7 whenever both meshes are visible.
    const key = (mesh: number, vertex: number) => `${mesh}:${vertex}`;
    const lastUse = new Map<string, number>();
    let order = 0;
    for (let i = 0; i < g.ids.length; i++)
      for (let p = 0; p < g.vertexA[i]!.length; p++, order++) {
        lastUse.set(key(g.meshA[i]!, g.vertexA[i]![p]!), order);
        lastUse.set(key(g.meshB[i]!, g.vertexB[i]![p]!), order);
      }
    const sumsToOne = (i: number, p: number) =>
      Math.abs(g.weightA[i]![p]! + g.weightB[i]![p]! - 1) < 1e-6;
    const stable: [number, number][] = [];
    let pairs = 0;
    order = 0;
    for (let i = 0; i < g.ids.length; i++)
      for (let p = 0; p < g.vertexA[i]!.length; p++, order++) {
        if (!sumsToOne(i, p)) continue;
        pairs++;
        if (
          lastUse.get(key(g.meshA[i]!, g.vertexA[i]![p]!)) === order &&
          lastUse.get(key(g.meshB[i]!, g.vertexB[i]![p]!)) === order
        )
          stable.push([i, p]);
      }
    expect(pairs).toBe(2411);
    expect(stable.length).toBe(2329);
    for (const id of scenarios.keys()) {
      run(id);
      let worst = 0;
      for (const [i, p] of stable) {
        if (!inst.drawableVisible[g.meshA[i]!] || !inst.drawableVisible[g.meshB[i]!]) continue;
        const A = inst.drawableVertices[g.meshA[i]!]!;
        const B = inst.drawableVertices[g.meshB[i]!]!;
        const a = 2 * g.vertexA[i]![p]!;
        const b = 2 * g.vertexB[i]![p]!;
        worst = Math.max(worst, Math.abs(A[a]! - B[b]!), Math.abs(A[a + 1]! - B[b + 1]!));
      }
      expect(worst, id).toBeLessThanOrEqual(1.2e-7);
    }
  });
});

describe("corrections C1–C7", () => {
  it("rebuilding the file in memory changes nothing (basis of the crafted variants)", () => {
    const copy = new ModelInstance(loadMoc(craftDeepseek()));
    const fresh = new ModelInstance(model);
    copy.evaluate();
    fresh.evaluate();
    expect(formatResultJson(snapshotInstance(copy))).toBe(
      formatResultJson(snapshotInstance(fresh)),
    );
  });

  it("C4: a never-active glue partner pulls ArtMesh661 toward its persistent array", () => {
    const a680 = idx("ArtMesh680");
    const crafted = loadMoc(
      craftDeepseek((f) => {
        (f["mesh.enabled"] as number[])[a680] = 0;
      }),
    );
    const d = crafted.meshes.ids.indexOf("ArtMesh661");
    const table: [string, [number, number][]][] = [
      [
        "after creation",
        [
          [0, 0],
          [-0.024287, 0.334102],
          [-0.028498, 0.439751],
          [-0.023686, 0.381629],
        ],
      ],
      [
        "after the first evaluation",
        [
          [0, 0],
          [-0.032462, 0.446561],
          [-0.032128, 0.495761],
          [-0.029887, 0.48154],
        ],
      ],
      [
        "after the second",
        [
          [0, 0],
          [-0.035214, 0.484414],
          [-0.03259, 0.502895],
          [-0.03151, 0.507696],
        ],
      ],
    ];
    const check = (inst: ModelInstance, mesh: number, stage: string, want: [number, number][]) =>
      [14, 22, 50, 69].forEach((v, k) => {
        const verts = inst.drawableVertices[mesh]!;
        expect(Math.abs(verts[2 * v]! - want[k]![0]), `${stage} v${v} x`).toBeLessThanOrEqual(2e-5);
        expect(Math.abs(verts[2 * v + 1]! - want[k]![1]), `${stage} v${v} y`).toBeLessThanOrEqual(
          2e-5,
        );
      });
    const i = new ModelInstance(crafted); // the creation-time evaluation
    check(i, d, table[0]![0], table[0]![1]);
    i.evaluate();
    check(i, d, table[1]![0], table[1]![1]);
    i.evaluate();
    check(i, d, table[2]![0], table[2]![1]);
    const unmodified = new ModelInstance(model);
    unmodified.evaluate();
    check(unmodified, idx("ArtMesh661"), "unmodified file", [
      [-0.034002, 0.516425],
      [-0.03661, 0.50362],
      [-0.032658, 0.503937],
      [-0.032086, 0.516973],
    ]);
  });

  it("C2: constraint counts", () => {
    const constrained = Object.values(model.blendShapes)
      .flat(2)
      .filter((b) => b.constraints.length > 0);
    const byCount = [0, 0, 0, 0];
    for (const b of constrained) byCount[b.constraints.length]!++;
    expect(byCount).toEqual([0, 35, 1, 3]);
    expect(new Set(constrained.map((b) => b.parameter)).size).toBe(21);
    const sec = readMocSections(readFileSync(mocPath));
    const len = (k: string) =>
      (sec.fields.get(k as never) as ArrayLike<number> | null)?.length ?? 0;
    expect(new Set(constrained.flatMap((b) => b.constraints)).size).toBe(18);
    expect(len("constraintIndex")).toBe(46);
    expect(len("constraintValue.key")).toBe(40);
  });

  it("C3: glue counts", () => {
    const g = model.glues;
    expect(g.ids.length).toBe(38);
    let pairs = 0;
    let sum1 = 0;
    let both = 0;
    let zeroA = 0;
    let zeroB = 0;
    for (let i = 0; i < g.ids.length; i++)
      for (let p = 0; p < g.vertexA[i]!.length; p++) {
        pairs++;
        const wa = g.weightA[i]![p]!;
        const wb = g.weightB[i]![p]!;
        if (Math.abs(wa + wb - 1) >= 1e-6) continue;
        sum1++;
        if (wa > 0 && wb > 0) both++;
        else if (wa === 0) zeroA++;
        else zeroB++;
      }
    expect([pairs, sum1, both, zeroA, zeroB]).toEqual([2470, 2411, 909, 732, 770]);
    expect(Array.from(model.keyforms.glueIntensity).every((x) => x === 1)).toBe(true);
  });

  it("C7: deformer and art meshes with parent part −1", () => {
    expect(model.deformers.part[model.deformers.ids.indexOf("Warp170")]).toBe(-1);
    const orphans = model.meshes.ids.filter((_, i) => model.meshes.part[i] === -1);
    expect(orphans).toEqual(["ArtMesh242", "ArtMesh243", "ArtMesh607"]);
    const fresh = new ModelInstance(model);
    for (const id of ["ArtMesh242", "ArtMesh243"]) {
      expect(fresh.drawableVisible[idx(id)], id).toBe(1);
      expect(fresh.drawableOpacity[idx(id)]).toBeCloseTo(0.2, 6);
    }
  });

  it("C5: normal keyforms take both colors from the object's first color entry", () => {
    const mesh = idx("ArtMesh436");
    const k = model.meshes.firstKeyform[mesh]!;
    // ArtMesh436 is inactive at the default pose and reports no colors then
    // (C10); GemReflection 1 makes it active.
    const run1 = (bytes: Uint8Array) => {
      const i = new ModelInstance(loadMoc(bytes));
      i.setParameter(i.parameterIndex("GemReflection"), 1);
      i.evaluate();
      expect(i.drawableActive[mesh]).toBe(1);
      return [
        ...i.drawableMultiply.subarray(3 * mesh, 3 * mesh + 3),
        ...i.drawableScreen.subarray(3 * mesh, 3 * mesh + 3),
      ];
    };
    const base = run1(craftDeepseek());
    // Per-keyform entries (slots 141/142) of normal keyforms are not read.
    const slot141 = run1(
      craftDeepseek((f) => {
        (f["meshKeyform.multiplyColor"] as number[])[k] = 0;
        (f["meshKeyform.screenColor"] as number[])[k] = 0;
      }),
    );
    expect(slot141).toEqual(base);
    // The first color entry (slot 107) moves both colors: give the mesh new entries,
    // one per normal keyform, all with the same colors.
    const n = model.bands[model.meshes.band[mesh]!]!.keyformCount;
    const moved = run1(
      craftDeepseek((f, x) => {
        const e = (f["multiplyColor.r"] as number[]).length;
        for (const [key, value] of [
          ["multiplyColor.r", 0.25],
          ["multiplyColor.g", 0.5],
          ["multiplyColor.b", 0.75],
          ["screenColor.r", 0.1],
          ["screenColor.g", 0.2],
          ["screenColor.b", 0.3],
        ] as const)
          for (let c = 0; c < n; c++) (f[key] as number[]).push(value);
        x.counts[23] = (f["multiplyColor.r"] as number[]).length; // multiply-color entries
        x.counts[24] = (f["screenColor.r"] as number[]).length; // screen-color entries
        (f["mesh.firstColor"] as number[])[mesh] = e;
      }),
    );
    expect(moved.map((v) => Math.fround(v))).toEqual(
      [0.25, 0.5, 0.75, 0.1, 0.2, 0.3].map(Math.fround),
    );
  });

  it("C6: rejects inconsistent draw-order group totals", () => {
    expect(() =>
      loadMoc(
        craftDeepseek((f) => {
          (f["group.entryCount"] as number[])[0]! += 1;
        }),
      ),
    ).toThrow(/draw-order group 0: total/);
  });

  it("C1: TongueOut 0.3009 shows the tongue meshes at opacity 0.09 (no blend-shape snapping)", () => {
    run("ds-bs-nosnap-tongue");
    const visible = inst.drawableVisible.reduce((a, v) => a + v, 0);
    expect(visible).toBe(462);
    for (const [id, order] of [
      ["ArtMesh263", 437],
      ["ArtMesh158", 416],
    ] as const) {
      const d = idx(id);
      expect(inst.drawableVisible[d], id).toBe(1);
      expect(inst.drawableOpacity[d]).toBeCloseTo(0.09000012, 5);
      expect(inst.drawableRenderOrder[d]).toBe(order);
    }
  });

  it("C1: LateHairX2 −0.9991 moves the hair as the official runtime does", () => {
    run("ds-bs-nosnap-hair");
    for (const [id, v, x, y] of [
      ["ArtMesh330", 103, 0.07789774, 0.21953586],
      ["ArtMesh165", 2, 0.10824753, 0.22625354],
      ["ArtMesh163", 1, 0.09536849, 0.24470161],
    ] as const) {
      const verts = inst.drawableVertices[idx(id)]!;
      expect(Math.abs(verts[2 * v]! - x), `${id} v${v} x`).toBeLessThanOrEqual(2e-5);
      expect(Math.abs(verts[2 * v + 1]! - y), `${id} v${v} y`).toBeLessThanOrEqual(2e-5);
    }
  });
});

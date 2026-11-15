/**
 * In-place value patches (`ModelInstance.patch`, `ModelRuntime.patch`): for
 * every kind of value, a patch then an evaluation equals a model rebuilt from
 * the patched data, with both kernels, with and without incremental
 * evaluation. Also: the persistent arrays of inactive meshes, another
 * instance of the same model, checks that refuse a patch, and DeepSeek-chan
 * where it is present (with the time a drag frame takes).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMoc } from "../src/core/moc/io.js";
import type { MocData } from "../src/core/moc/data.js";
import { mocModelFromData } from "../src/core/moc/from-data.js";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import type { ValuePatch } from "../src/core/eval/patch.js";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { ModelRuntime } from "../src/runtime/model-runtime.js";
import { MODES, output, same, type Output } from "./support/evaluate.js";
import { Synth, type RGB } from "./support/synth.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const gray = (x: number): RGB => [x, x, x];
const grid = (n: number, scale = 1, dx = 0) => {
  const out: number[] = [];
  for (let r = 0; r <= n; r++)
    for (let c = 0; c <= n; c++) out.push(dx + (scale * c) / n, (scale * r) / n + 0.01 * c * r);
  return out;
};
const tri = (x: number, y: number, s = 0.1) => [x, y, x + s, y, x, y + s, x + s, y + s];

/**
 * A version-5 or 6 model with every patchable kind of value: a warp and a
 * rotation inside it (both bound to P, with blend shapes), meshes under each
 * and at the root (bound to P and Q, with blend shapes of positions,
 * opacity, colors and draw order), a part with a draw-order blend shape and
 * nested group, a glue with intensity keyforms and a blend shape, color
 * entries, and (version 6) an offscreen of the part.
 */
function synthetic(version: 5 | 6): Uint8Array {
  const s = new Synth(version);
  const root = s.part({ id: "Root" });
  const P = s.param("P", 0, 1, 0.3);
  const Q = s.param("Q", -1, 1, 0);
  const BS = s.param("BS", 0, 1, 0.5, { type: 1 });
  const bP = s.band([s.binding(P, [0, 1])]);
  const bPQ = s.band([s.binding(P, [0, 1]), s.binding(Q, [-1, 0, 1])]);
  const child = s.part({
    id: "Child",
    parent: root,
    band: bP,
    keyforms: [{ drawOrder: 400 }, { drawOrder: 600 }],
  });
  s.blendShape("part", child, {
    param: BS,
    keys: [0, 1],
    base: 0,
    keyforms: [{ drawOrder: 0 }, { drawOrder: 30 }],
  });
  // Version 6: a part with an offscreen and its own mesh (M5, below).
  const layer =
    version === 6
      ? s.part({
          id: "Layer",
          parent: root,
          band: bP,
          keyforms: [{ drawOrder: 650 }, { drawOrder: 640 }],
        })
      : -1;
  if (version === 6)
    s.offscreen({
      part: layer,
      keyforms: [
        { opacity: 0.7, multiply: gray(0.9), screen: gray(0.1) },
        { opacity: 0.4, multiply: gray(0.6), screen: gray(0.2) },
      ],
    });
  const w = s.warp({
    id: "W",
    band: bP,
    rows: 2,
    cols: 2,
    keyforms: [
      { opacity: 0.9, points: grid(2), multiply: gray(0.8), screen: gray(0.1) },
      { opacity: 0.6, points: grid(2, 1.2, 0.1), multiply: gray(0.5), screen: gray(0.3) },
    ],
  });
  s.blendShape("warp", 0, {
    param: BS,
    keys: [0, 1],
    base: 0,
    keyforms: [
      { opacity: 0, points: grid(2).map(() => 0), multiply: gray(0), screen: gray(0) },
      {
        // An opacity step of zeros, which the plan drops (until a patch makes it non-zero).
        opacity: 0,
        points: grid(2).map((_, i) => 0.01 * (i % 5)),
        multiply: gray(0.1),
        screen: gray(0),
      },
    ],
  });
  const r = s.rotation({
    id: "R",
    parent: w,
    band: bP,
    keyforms: [
      {
        opacity: 0.8,
        angle: 10,
        x: 0.5,
        y: 0.5,
        scale: 0.01,
        multiply: gray(0.9),
        screen: gray(0.05),
      },
      {
        opacity: 1,
        angle: -20,
        x: 0.4,
        y: 0.6,
        scale: 0.02,
        multiply: gray(0.7),
        screen: gray(0.2),
      },
    ],
  });
  s.blendShape("rotation", 0, {
    param: BS,
    keys: [0, 1],
    base: 0,
    keyforms: [
      { opacity: 0, angle: 0, x: 0, y: 0, scale: 0, multiply: gray(0), screen: gray(0) },
      {
        opacity: -0.1,
        angle: 15,
        x: 0.05,
        y: 0,
        scale: 0.005,
        multiply: gray(0),
        screen: gray(0.1),
      },
    ],
  });
  const triangles = [0, 1, 2, 1, 3, 2];
  // M0 under the warp, on P × Q (6 keyforms).
  const m0 = s.mesh({
    id: "M0",
    band: bPQ,
    part: child,
    deformer: w,
    triangles,
    keyforms: [0, 1, 2, 3, 4, 5].map((k) => ({
      opacity: 0.5 + 0.08 * k,
      drawOrder: 450 + k,
      positions: tri(0.2 + 0.05 * k, 0.3, 0.2),
      multiply: gray(1 - 0.05 * k),
      screen: gray(0.02 * k),
    })),
  });
  // M1 under the rotation, M2 at the root with blend shapes of every value.
  s.mesh({
    id: "M1",
    band: bP,
    part: child,
    deformer: r,
    triangles,
    keyforms: [
      { positions: tri(-10, -10, 20), drawOrder: 500 },
      { positions: tri(-12, -8, 22), drawOrder: 520 }, // opacity 1 at both keys: folded
    ],
  });
  const m2 = s.mesh({
    id: "M2",
    band: bP,
    triangles,
    keyforms: [
      { positions: tri(0.5, 0.5), drawOrder: 300, opacity: 0.7, multiply: gray(0.9) },
      { positions: tri(0.6, 0.4), drawOrder: 310, opacity: 0.6, multiply: gray(0.8) },
    ],
  });
  s.blendShape("mesh", m2, {
    param: BS,
    keys: [0, 1],
    base: 0,
    keyforms: [
      { positions: tri(0, 0, 0), opacity: 0, drawOrder: 0, multiply: gray(0), screen: gray(0) },
      {
        positions: [0.05, 0, 0.05, 0.01, 0, 0.02, 0.01, 0.01],
        opacity: 0.1,
        drawOrder: 5,
        multiply: gray(0.05),
        screen: gray(0.1),
      },
    ],
  });
  // M3 and M4, glued.
  const m3 = s.mesh({ id: "M3", triangles, keyforms: [{ positions: tri(0.1, 0.1) }] });
  const m4 = s.mesh({ id: "M4", triangles, keyforms: [{ positions: tri(0.3, 0.1) }] });
  const g = s.glue({
    id: "G",
    a: m3,
    b: m4,
    band: bP,
    pairs: [
      [0, 0.5, 0, 0.5],
      [3, 0.3, 2, 0.7],
    ],
    intensities: [0.4, 0.9],
  });
  s.blendShape("glue", g, { param: BS, keys: [0, 1], base: 0, keyforms: [0, 0.2] });
  const m5 =
    version === 6
      ? s.mesh({ id: "M5", part: layer, triangles, keyforms: [{ positions: tri(0.4, 0.6) }] })
      : -1;
  s.groups = [
    {
      objects: [
        { kind: 1, index: child, nested: 1 },
        ...(version === 6 ? [{ kind: 1 as const, index: layer, nested: 2 }] : []),
        { kind: 0, index: m2 },
        { kind: 0, index: m3 },
        { kind: 0, index: m4 },
      ],
      min: 0,
      max: 1000,
    },
    {
      objects: [
        { kind: 0, index: m0 },
        { kind: 0, index: 1 },
      ],
      min: 0,
      max: 1000,
    },
    ...(version === 6 ? [{ objects: [{ kind: 0 as const, index: m5 }], min: 0, max: 1000 }] : []),
  ];
  return s.build();
}

/** The array of `data` a patch names. */
function dataArray(data: MocData, p: ValuePatch): Float32Array {
  const group = (data as unknown as Record<string, unknown>)[p.group];
  return (p.field ? (group as Record<string, Float32Array>)[p.field] : group) as Float32Array;
}

/** A copy of `data` with the patches written into it. */
function patchedData(data: MocData, patches: readonly ValuePatch[]): MocData {
  const copy = structuredClone(data);
  for (const p of patches) dataArray(copy, p).set(Array.from(p.values), p.start);
  return copy;
}

const POSES: Record<number, number>[] = [
  { 0: 0.3, 1: 0, 2: 0.5 },
  { 0: 0.8, 1: -0.4, 2: 0.25 },
];

/** The outputs that do not depend on history (every mesh here is active). */
function compare(a: Output, b: Output, what: string) {
  for (const k of Object.keys(a) as (keyof Output)[])
    expect(same(a[k], b[k]), `${what}: ${k}`).toBe(true);
}

/**
 * For each kernel mode: an instance of the original evaluates at pose 0,
 * takes the patches, and evaluates at pose 1; a model rebuilt from the
 * patched data evaluates at pose 1. Their outputs must be identical.
 */
function checkPatch(bytes: Uint8Array, patches: ValuePatch[], what: string): void {
  const { data, version } = readMoc(bytes);
  const rebuilt = mocModelFromData(patchedData(data, patches), version);
  for (const mode of MODES) {
    const live = new ModelInstance(loadMoc(bytes, { nonFiniteOpacity: "load" }), mode);
    for (const [p, v] of Object.entries(POSES[0]!)) live.setParameter(Number(p), v);
    live.evaluate();
    live.patch(patches);
    for (const [p, v] of Object.entries(POSES[1]!)) live.setParameter(Number(p), v);
    live.evaluate();
    const fresh = new ModelInstance(rebuilt, mode);
    for (const [p, v] of Object.entries(POSES[1]!)) fresh.setParameter(Number(p), v);
    fresh.evaluate();
    // The patch must show: the original model at the same pose differs.
    const original = new ModelInstance(loadMoc(bytes), mode);
    for (const [p, v] of Object.entries(POSES[1]!)) original.setParameter(Number(p), v);
    original.evaluate();
    expect(same(output(original), output(fresh)), `${what}: the patch changes the outputs`).toBe(
      false,
    );
    compare(
      output(live),
      output(fresh),
      `${what} (${mode.kernels}${mode.incremental === false ? ", full" : ""})`,
    );
  }
}

describe("a patch, then an evaluation, equals a rebuild", () => {
  for (const version of [5, 6] as const) {
    const bytes = synthetic(version);
    const { data } = readMoc(bytes);
    const meshPos = (mesh: number, keyform: number) =>
      data.artMeshKeyforms.firstPosition[data.artMeshes.firstKeyform[mesh]! + keyform]!;
    const blendKeyform = (
      kind: "artMeshBlendShapeTargets" | "warpBlendShapeTargets",
      key: number,
    ) => {
      const t = data[kind]!;
      const kb = data.blendShapeKeyformBindings!;
      return kb.firstKeyform[t.firstBinding[0]!]! + key;
    };
    const values = (n: number, f: (i: number) => number) =>
      Float32Array.from({ length: n }, (_, i) => f(i));
    const CASES: [string, ValuePatch[]][] = [
      [
        "positions of a mesh keyform (under the warp)",
        [
          {
            group: "keyformPositions",
            start: meshPos(0, 3),
            values: values(8, (i) => 0.1 + 0.07 * i),
          },
        ],
      ],
      [
        "positions of a mesh keyform, part of it (under the rotation)",
        [{ group: "keyformPositions", start: meshPos(1, 1) + 2, values: [3, -4, 5] }],
      ],
      [
        "positions of a blend-shape keyform",
        [
          {
            group: "keyformPositions",
            start: data.artMeshKeyforms.firstPosition[blendKeyform("artMeshBlendShapeTargets", 1)]!,
            values: values(8, (i) => 0.02 * (i - 3)),
          },
        ],
      ],
      [
        "a warp's grid, normal and blend-shape keyforms",
        [
          {
            group: "keyformPositions",
            start: data.warpKeyforms.firstPosition[1]!,
            values: values(18, (i) => (i % 2 ? 0.05 : -0.02) * i),
          },
          {
            group: "keyformPositions",
            start: data.warpKeyforms.firstPosition[blendKeyform("warpBlendShapeTargets", 1)]! + 4,
            values: [0.3, -0.2],
          },
        ],
      ],
      [
        "art-mesh opacities and draw orders, normal and blend-shape",
        [
          { group: "artMeshKeyforms", field: "opacity", start: 0, values: [0.2, 0.9, 1.4] },
          { group: "artMeshKeyforms", field: "drawOrder", start: 6, values: [700, 705] },
          {
            group: "artMeshKeyforms",
            field: "opacity",
            start: blendKeyform("artMeshBlendShapeTargets", 1),
            values: [-0.6],
          },
          {
            group: "artMeshKeyforms",
            field: "drawOrder",
            start: blendKeyform("artMeshBlendShapeTargets", 1),
            values: [800],
          },
        ],
      ],
      [
        "a constant opacity that stops being constant, and a zero blend step that stops being zero",
        [
          { group: "artMeshKeyforms", field: "opacity", start: 7, values: [0.25] },
          { group: "warpKeyforms", field: "opacity", start: 3, values: [0.5] },
        ],
      ],
      [
        "warp opacities",
        [{ group: "warpKeyforms", field: "opacity", start: 0, values: [0.3, 1.5] }],
      ],
      [
        "rotation values",
        [
          { group: "rotationKeyforms", field: "angle", start: 0, values: [45, -90] },
          { group: "rotationKeyforms", field: "originX", start: 1, values: [0.2] },
          { group: "rotationKeyforms", field: "originY", start: 0, values: [0.7] },
          { group: "rotationKeyforms", field: "scale", start: 0, values: [0.03, 0.001] },
          { group: "rotationKeyforms", field: "opacity", start: 0, values: [0.4] },
          { group: "rotationKeyforms", field: "angle", start: 3, values: [-40] },
        ],
      ],
      [
        "part draw orders, normal and blend-shape",
        [
          { group: "partKeyforms", field: "drawOrder", start: 1, values: [200, 900] },
          { group: "partKeyforms", field: "drawOrder", start: 4, values: [-50] },
        ],
      ],
      [
        "glue intensities and weights",
        [
          { group: "glueKeyforms", field: "intensity", start: 0, values: [1, 0.1] },
          { group: "glueKeyforms", field: "intensity", start: 3, values: [-0.4] },
          { group: "glueInfo", field: "weight", start: 1, values: [0.9, 0.2] },
        ],
      ],
      [
        "color entries of meshes, warps and rotations",
        [
          { group: "multiplyColors", field: "r", start: 0, values: [0.1, 0.2, 0.3, 0.4] },
          { group: "multiplyColors", field: "g", start: 5, values: [1.6] },
          { group: "screenColors", field: "b", start: 2, values: [0.7, 0.5] },
          { group: "screenColors", field: "r", start: 9, values: [0.9] },
        ],
      ],
      ...(version === 6
        ? ([
            [
              "offscreen opacities and colors",
              [
                { group: "offscreenKeyforms", field: "opacity", start: 0, values: [0.15, 0.95] },
                {
                  group: "multiplyColors",
                  field: "b",
                  start: data.offscreenKeyforms!.multiplyColor[1]!,
                  values: [0.3],
                },
              ],
            ],
          ] as [string, ValuePatch[]][])
        : []),
    ];
    for (const [what, patches] of CASES)
      it(`v${version}: ${what}`, () => {
        // The patched arrays must exist in the data: the case would test nothing otherwise.
        for (const p of patches) expect(dataArray(data, p).length).toBeGreaterThan(p.start);
        checkPatch(bytes, patches, what);
      });

    it(`v${version}: every kind at once, patched twice, with evaluations in between`, () => {
      const all = CASES.flatMap(([, p]) => p);
      const { data: d0, version: v } = readMoc(bytes);
      for (const mode of MODES) {
        const live = new ModelInstance(loadMoc(bytes), mode);
        live.evaluate();
        live.patch(all.slice(0, 7));
        live.evaluate();
        live.patch(all.slice(7));
        for (const [p, x] of Object.entries(POSES[1]!)) live.setParameter(Number(p), x);
        live.evaluate();
        const fresh = new ModelInstance(mocModelFromData(patchedData(d0, all), v), mode);
        for (const [p, x] of Object.entries(POSES[1]!)) fresh.setParameter(Number(p), x);
        fresh.evaluate();
        compare(output(live), output(fresh), `all (${mode.kernels})`);
      }
    });
  }
});

describe("patches and state", () => {
  const bytes = synthetic(5);

  it("an inactive mesh keeps its arrays, and takes the patch when it is active again", () => {
    // A mesh on G's keys 0 and 1, with G's range 0…2: inactive for G > 1.
    const s = new Synth(5);
    s.part({ id: "Root" });
    const G = s.param("G", 0, 2, 0);
    const gate = s.band([s.binding(G, [0, 1])]);
    s.mesh({ id: "M", band: gate, keyforms: [{ positions: tri(0, 0) }, { positions: tri(1, 1) }] });
    const model = loadMoc(s.build());
    for (const mode of MODES) {
      const inst = new ModelInstance(model, mode);
      inst.setParameter(0, 0.5);
      inst.evaluate();
      const before = Array.from(inst.drawableVertices[0]!);
      inst.setParameter(0, 2); // out of range: inactive
      inst.evaluate();
      expect(inst.drawableActive[0]).toBe(0);
      inst.patch({ group: "keyformPositions", start: 0, values: [5, 5] });
      inst.evaluate();
      // C4: the inactive mesh keeps the vertices of its last active evaluation.
      expect(Array.from(inst.drawableVertices[0]!)).toEqual(before);
      inst.setParameter(0, 0); // active again, on keyform 0: the patched value shows
      inst.evaluate();
      expect(inst.drawableVertices[0]![0]).toBe(5);
      expect(inst.drawableVertices[0]![1]).toBe(-5);
    }
  });

  it("another instance of the same model sees the patch at its next evaluation", () => {
    const model = loadMoc(bytes);
    const a = new ModelInstance(model);
    const b = new ModelInstance(model, { kernels: "js" });
    const patches: ValuePatch[] = [
      { group: "keyformPositions", start: 0, values: [0.9, 0.8] },
      { group: "rotationKeyforms", field: "angle", start: 0, values: [70] },
      { group: "artMeshKeyforms", field: "opacity", start: 0, values: [0.33] },
    ];
    a.patch(patches);
    a.evaluate();
    b.evaluate();
    compare(output(a), output(b), "two instances");
    // And a third one made afterwards.
    const c = new ModelInstance(model);
    compare(output(a), output(c), "a later instance");
  });

  it("refuses what cannot be patched, and then applies nothing", () => {
    const model = loadMoc(bytes);
    const inst = new ModelInstance(model);
    const before = output(inst);
    const bad: [ValuePatch, RegExp][] = [
      [
        { group: "artMeshKeyforms", field: "firstPosition", start: 0, values: [1] },
        /cannot be patched/,
      ],
      [{ group: "parameters" as never, field: "min", start: 0, values: [1] }, /cannot be patched/],
      [{ group: "keyformPositions", field: "x", start: 0, values: [1] }, /has no fields/],
      [{ group: "artMeshKeyforms", field: "opacity", start: -1, values: [1] }, /outside/],
      [
        { group: "artMeshKeyforms", field: "opacity", start: 0, values: new Array(999).fill(1) },
        /outside/,
      ],
      [{ group: "glueInfo", field: "weight", start: 4, values: [1] }, /outside/],
      [{ group: "multiplyColors", field: "a", start: 0, values: [1] }, /cannot be patched/],
      [
        { group: "artMeshKeyforms", field: "opacity", start: 0, values: ["x" as never] },
        /not a number/,
      ],
      // Not finite: loadMoc rejects such opacities by default.
      [{ group: "warpKeyforms", field: "opacity", start: 0, values: [NaN] }, /must be finite/],
      [{ group: "rotationKeyforms", field: "opacity", start: 1, values: [Infinity] }, /finite/],
    ];
    for (const [p, message] of bad) {
      // A valid patch first in the same call: it must not apply either.
      expect(() =>
        inst.patch([{ group: "artMeshKeyforms", field: "opacity", start: 1, values: [0.01] }, p]),
      ).toThrow(message);
    }
    inst.evaluate();
    compare(output(inst), before, "after refused patches");
  });

  it("marks the vertices of the meshes a patch moves changed, and only those", () => {
    const data = readMoc(bytes).data;
    for (const mode of MODES) {
      const inst = new ModelInstance(loadMoc(bytes), mode);
      inst.evaluate();
      const changed = (patch: ValuePatch) => {
        const before = Array.from(inst.drawableVertexVersion);
        inst.patch(patch);
        inst.evaluate();
        return Array.from(inst.drawableVertexVersion, (v, i) => v !== before[i]);
      };
      const all = mode.incremental === false;
      // A vertex of M2's first keyform (a mesh at the root).
      const m2 = data.artMeshKeyforms.firstPosition[data.artMeshes.firstKeyform[2]!]!;
      expect(changed({ group: "keyformPositions", start: m2, values: [0.55, 0.5] })).toEqual(
        all ? [true, true, true, true, true] : [false, false, true, false, false],
      );
      // A grid point of the warp: M0 under it, and M1 under the rotation inside it.
      const w = data.warpKeyforms.firstPosition[data.warpDeformers.firstKeyform[0]!]!;
      expect(changed({ group: "keyformPositions", start: w + 2, values: [0.45, 0.02] })).toEqual(
        all ? [true, true, true, true, true] : [true, true, false, false, false],
      );
      // An opacity changes no vertices (renderers read opacities every frame).
      const opacity = changed({
        group: "artMeshKeyforms",
        field: "opacity",
        start: 0,
        values: [0.3],
      });
      expect(opacity).toEqual(
        all ? [true, true, true, true, true] : [false, false, false, false, false],
      );
    }
  });

  it("ModelRuntime.patch shows at the next update; update(0) applies it at once", async () => {
    const source = MemoryFileSource.fromFiles({
      "m.model3.json": JSON.stringify({
        Version: 3,
        FileReferences: { Moc: "m.moc3", Textures: [] },
      }),
      "m.moc3": bytes,
    });
    const rt = await ModelRuntime.load(source, "m.model3.json");
    for (const e of ["eyeBlink", "breath", "idle"] as const)
      if (rt.effectAvailable(e)) rt.setEffect(e, false);
    rt.update(0);
    const before = Array.from(rt.instance.drawableOpacity);
    rt.patch({ group: "artMeshKeyforms", field: "opacity", start: 0, values: [0, 0, 0, 0, 0, 0] });
    expect(Array.from(rt.instance.drawableOpacity)).toEqual(before); // not yet
    rt.update(0);
    expect(rt.instance.drawableOpacity[0]).toBe(0);
    expect(rt.instance.drawableVisible[0]).toBe(0);
  });
});

describe.skipIf(!HAVE_DEEPSEEK)("on DeepSeek-chan", () => {
  // Read in the tests, not while they are collected: without the model the
  // suite is skipped, but its body still runs.
  let model: Uint8Array | null = null;
  const deepseek = () => (model ??= new Uint8Array(readFileSync(join(DEEPSEEK, "大肥鱼.moc3"))));

  /** Seeded patches of every kind, at random places. */
  function randomPatches(data: MocData, seed: number): ValuePatch[] {
    let s = seed >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const pick = (n: number) => Math.floor(rnd() * n);
    const out: ValuePatch[] = [];
    const kf = data.artMeshKeyforms;
    for (let i = 0; i < 6; i++) {
      const k = pick(kf.firstPosition.length);
      out.push({
        group: "keyformPositions",
        start: kf.firstPosition[k]!,
        values: Array.from({ length: 6 }, () => rnd() - 0.5),
      });
    }
    const wk = data.warpKeyforms;
    const w = pick(wk.firstPosition.length);
    out.push({
      group: "keyformPositions",
      start: wk.firstPosition[w]! + 2,
      values: [rnd(), rnd()],
    });
    out.push({
      group: "artMeshKeyforms",
      field: "opacity",
      start: pick(kf.opacity.length),
      values: [rnd()],
    });
    out.push({
      group: "artMeshKeyforms",
      field: "drawOrder",
      start: pick(kf.drawOrder.length),
      values: [pick(1000)],
    });
    out.push({
      group: "warpKeyforms",
      field: "opacity",
      start: pick(wk.opacity.length),
      values: [rnd()],
    });
    const rk = data.rotationKeyforms;
    for (const field of ["angle", "originX", "originY", "scale", "opacity"] as const)
      out.push({
        group: "rotationKeyforms",
        field,
        start: pick(rk.angle.length),
        values: [rnd() * 2],
      });
    out.push({
      group: "partKeyforms",
      field: "drawOrder",
      start: pick(data.partKeyforms.drawOrder.length),
      values: [pick(1000)],
    });
    out.push({
      group: "glueKeyforms",
      field: "intensity",
      start: pick(data.glueKeyforms.intensity.length),
      values: [rnd()],
    });
    out.push({
      group: "glueInfo",
      field: "weight",
      start: pick(data.glueInfo.weight.length),
      values: [rnd()],
    });
    out.push({
      group: "multiplyColors",
      field: "g",
      start: pick(data.multiplyColors!.g.length),
      values: [rnd()],
    });
    out.push({
      group: "screenColors",
      field: "r",
      start: pick(data.screenColors!.r.length),
      values: [rnd()],
    });
    return out;
  }

  it(
    "seeded patches of every kind equal a rebuild, with both kernels",
    { timeout: 120_000 },
    () => {
      const { data, version } = readMoc(deepseek());
      const pose = (inst: ModelInstance) => {
        inst.setParameter(inst.parameterIndex("ParamAngleX"), 18);
        inst.setParameter(inst.parameterIndex("ParamBodyAngleZ"), -6);
        inst.setParameter(inst.parameterIndex("ParamMouthOpenY"), 0.7);
      };
      for (const seed of [1, 2, 3]) {
        const patches = randomPatches(data, seed);
        const rebuilt = mocModelFromData(patchedData(data, patches), version);
        for (const mode of [MODES[0]!, MODES[MODES.length - 1]!]) {
          const live = new ModelInstance(loadMoc(deepseek()), mode);
          pose(live);
          live.evaluate();
          live.patch(patches);
          live.evaluate();
          const fresh = new ModelInstance(rebuilt, mode);
          pose(fresh);
          fresh.evaluate();
          const a = output(live);
          const b = output(fresh);
          // Meshes inactive at this pose keep history-dependent arrays (C4): compare the active ones.
          for (const k of Object.keys(a) as (keyof Output)[]) {
            if (k === "vertices") continue;
            expect(same(a[k], b[k]), `seed ${seed}, ${mode.kernels}: ${k}`).toBe(true);
          }
          a.vertices.forEach((v, d) => {
            if (a.active[d])
              expect(same(v, b.vertices[d]), `seed ${seed}: vertices of ${d}`).toBe(true);
          });
        }
      }
    },
  );

  it("a drag frame (patch one mesh keyform, evaluate) is fast", () => {
    const { data } = readMoc(deepseek());
    const inst = new ModelInstance(loadMoc(deepseek()));
    inst.evaluate();
    const k = data.artMeshKeyforms.firstPosition[300]!;
    const frames = 60;
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      inst.patch({ group: "keyformPositions", start: k, values: [0.01 * f, 0.02] });
      inst.evaluate();
    }
    const ms = (performance.now() - t0) / frames;
    // Informational bound, far above the measured value (see the round report).
    expect(ms).toBeLessThan(16);
  });
});

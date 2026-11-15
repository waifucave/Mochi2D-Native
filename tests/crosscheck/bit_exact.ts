/**
 * The float32 evaluation rules' vectors of Mochi2D 0.14.0
 * (test/bit-exact-vectors.test.ts) as model fixtures: each model of that
 * test, built with the same calls of Mochi2D's own test builder (Synth), and
 * a static scenario per evaluated pose. Before writing them, Mochi2D's own
 * evaluation is checked against the test's printed values (so these files
 * carry exactly those vectors); the reference's conformance tool then writes
 * the expected results (tests/fixtures/make.sh), and the `fixtures` test
 * requires Mochi2D Native's results to be the same bytes. The warp mapping's
 * own table is a unit test (warp_mapping_bit_exact_vectors).
 *
 * usage: node bit_exact.mjs <outDir>   (writes <outDir>/models and <outDir>/scenarios)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Synth, type RGB } from "../../reference/mochi2d-0.21.0/test/support/synth.js";
import { loadMoc } from "../../reference/mochi2d-0.21.0/src/core/moc/model.js";
import { ModelInstance } from "../../reference/mochi2d-0.21.0/src/core/eval/instance.js";

const f = Math.fround;
const out = process.argv[2];
if (!out) {
  console.error("usage: node bit_exact.mjs <outDir>");
  process.exit(2);
}
mkdirSync(join(out, "models"), { recursive: true });
mkdirSync(join(out, "scenarios"), { recursive: true });

interface Pose {
  parameters?: Record<string, number>;
  parts?: Record<string, number>;
}
/** What a pose must give, checked with Mochi2D before writing (index → expected). */
interface Expect {
  vertices?: Record<number, number[]>;
  opacity?: Record<number, number>;
  screen?: Record<number, number>;
}

let failures = 0;
let scenarios = 0;

function model(name: string, s: Synth, ids: { params: string[]; parts: string[] }, poses: [string, Pose, Expect][]) {
  const bytes = s.build();
  const dir = join(out, "models", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.moc3`), bytes);
  writeFileSync(
    join(dir, `${name}.model3.json`),
    JSON.stringify({ Version: 3, FileReferences: { Moc: `${name}.moc3`, Textures: [] } }, null, 2),
  );
  const m = loadMoc(bytes);
  for (const [tag, pose, want] of poses) {
    const inst = new ModelInstance(m);
    for (const [id, v] of Object.entries(pose.parameters ?? {})) inst.setParameter(ids.params.indexOf(id), v);
    for (const [id, v] of Object.entries(pose.parts ?? {})) inst.setPartOpacity(ids.parts.indexOf(id), v);
    inst.evaluate();
    const check = (what: string, got: number, expected: number) => {
      if (!Object.is(got, f(expected))) {
        console.error(`bit_exact: ${name} ${tag}: ${what} is ${got}, the test says ${f(expected)}`);
        failures++;
      }
    };
    for (const [i, xy] of Object.entries(want.vertices ?? {})) {
      // The test reads file coordinates: the instance reports y negated.
      const v = inst.drawableVertices[Number(i)]!;
      xy.forEach((e, k) => check(`vertex ${i}[${k}]`, k % 2 ? -v[k]! : v[k]!, e));
    }
    for (const [i, o] of Object.entries(want.opacity ?? {})) check(`opacity ${i}`, inst.drawableOpacity[Number(i)]!, o);
    for (const [i, g] of Object.entries(want.screen ?? {}))
      check(`screen green ${i}`, inst.drawableScreen[3 * Number(i) + 1]!, g);
    const id = `${name}-${tag}`;
    const sc: Record<string, unknown> = { format: "mochi2d-scenario/0", id, model: `${name}/${name}.model3.json` };
    if (pose.parameters) sc.parameters = pose.parameters;
    if (pose.parts) sc.partOpacities = pose.parts;
    writeFileSync(join(out, "scenarios", `${id}.json`), JSON.stringify(sc, null, 2));
    scenarios++;
  }
}

const pts = (xy: number[][]) => xy.flat().map(f);
const TRIANGLE = [0, 0, 1, 0, 0, 1];

// A warp inside a rotation: the grid points carried like vertices, then mapped through the carried grid.
{
  const s = new Synth(5);
  s.part({ id: "Root" });
  const r = s.rotation({ id: "R", keyforms: [{ angle: f(33.7), x: 12.5, y: -7.25, scale: f(1.3), mirrorX: true }] });
  const grid = [
    [-40, -30],
    [5, -35],
    [45, -25],
    [-38, 30],
    [0, 28],
    [42, 35],
  ];
  const w = s.warp({ id: "W", parent: r, rows: 1, cols: 2, bilinear: true, keyforms: [{ points: pts(grid) }] });
  s.mesh({ id: "Carried", deformer: r, keyforms: [{ positions: pts(grid) }] });
  s.mesh({
    id: "Mapped",
    deformer: w,
    keyforms: [
      {
        positions: pts([
          [0.25, 0.6],
          [0.9, 0.1],
          [-0.4, 0.5],
          [3.5, 0.5],
        ]),
      },
    ],
  });
  model("bitexact-rotation-warp", s, { params: [], parts: ["Root"] }, [
    [
      "default",
      {},
      {
        vertices: {
          0: pts([
            [77.40054321289062, -10.844297409057617],
            [32.33772277832031, -48.71039962768555],
            [-18.136869430541992, -66.74691009521484],
            [31.9596004486084, 52.605525970458984],
            [-7.696338653564453, 23.033130645751953],
            [-58.17012023925781, 0.3094043731689453],
          ]),
          1: pts([
            [29.226627349853516, 10.780658721923828],
            [-12.045289993286133, -56.34022903442383],
            [92.08387756347656, 42.700679779052734],
            [-270.2374267578125, -168.4671630859375],
          ]),
        },
      },
    ],
  ]);
}

// Ancestor opacities, combined top-down: a part tree.
{
  const s = new Synth(6);
  const root = s.part({ id: "Root" });
  const a = s.part({ id: "A", parent: root });
  const b = s.part({ id: "B", parent: a });
  const c = s.part({ id: "C", parent: b });
  s.mesh({ id: "M", part: c, keyforms: [{ positions: TRIANGLE, opacity: f(0.8137) }] });
  model("bitexact-part-tree", s, { params: [], parts: ["Root", "A", "B", "C"] }, [
    [
      "pose",
      { parts: { Root: f(0.9131), A: f(0.7279), B: f(0.5531), C: f(0.6617) } },
      { opacity: { 0: 0.19793343544006348 } },
    ],
  ]);
}

// Ancestor opacities: deformers, f32(f32(own·dacc)·acc), dacc from the outermost deformer down.
{
  const s = new Synth(5);
  s.part({ id: "Root" });
  const r1 = s.rotation({ id: "R1", keyforms: [{ angle: 0, x: 0, y: 0, scale: 1, opacity: f(0.83) }] });
  const w = s.warp({
    id: "W",
    parent: r1,
    rows: 1,
    cols: 1,
    keyforms: [{ points: [0, 0, 1, 0, 0, 1, 1, 1], opacity: f(0.61) }],
  });
  const r2 = s.rotation({ id: "R2", parent: w, keyforms: [{ angle: 0, x: 0.5, y: 0.5, scale: 1, opacity: f(0.47) }] });
  s.mesh({ id: "M", deformer: r2, keyforms: [{ positions: TRIANGLE, opacity: f(0.7713) }] });
  model("bitexact-deformers", s, { params: [], parts: ["Root"] }, [
    ["pose", { parts: { Root: f(0.6429) } }, { opacity: { 0: 0.1179974153637886 } }],
  ]);
}

// A repeating parameter is always wrapped: S repeats, T doesn't, both on keys −180, 0, 180.
{
  const s = new Synth(5);
  s.part({ id: "Root" });
  const S = s.param("S", -180, 180, 0, { repeat: true });
  const T = s.param("T", -180, 180, 0);
  const bS = s.band([s.binding(S, [-180, 0, 180])]);
  const bT = s.band([s.binding(T, [-180, 0, 180])]);
  const kf = (o: number[]) => o.map((opacity) => ({ positions: TRIANGLE, opacity }));
  s.mesh({ id: "S001", band: bS, keyforms: kf([0, 0, 1]) });
  s.mesh({ id: "S010", band: bS, keyforms: kf([0, 1, 0]) });
  s.mesh({ id: "T001", band: bT, keyforms: kf([0, 0, 1]) });
  const rows: [number, 0 | 1, number, number][] = [
    [37.29999923706055, 0, 0.20722223818302155, 0.20722222328186035],
    [123.45600128173828, 0, 0.68586665391922, 0.68586665391922],
    [179.99000549316406, 0, 0.9999443888664246, 0.9999444484710693],
    [180, 1, 0, 1],
    [200, 1, 0.11111119389533997, 1],
    [-200, 0, 0.8888888955116272, 0],
    [541.7000122070312, 1, 0.00944468192756176, 1],
    [-540.25, 0, 0.9986112713813782, 0],
  ];
  model(
    "bitexact-repeat",
    s,
    { params: ["S", "T"], parts: ["Root"] },
    [
      ...rows.map(([v, mesh, t, control], i): [string, Pose, Expect] => [
        `v${i}`,
        { parameters: { S: v, T: v } },
        { opacity: { [mesh]: t, 2: control } },
      ]),
      ["max", { parameters: { S: 180 } }, { opacity: { 0: 0 } }],
    ],
  );
}

// Glue: the pair's float32 order, glues one after another (a chain A–B–C).
{
  const s = new Synth(5);
  s.part({ id: "Root" });
  const P = s.param("P", 0, 1, 0);
  const band = s.band([s.binding(P, [0, 1])]);
  const A = s.mesh({ id: "A", keyforms: [{ positions: pts([[0.1, 0.2], [0.9, 0.15], [0.85, 0.8], [0.12, 0.75]]) }] });
  const B = s.mesh({ id: "B", keyforms: [{ positions: pts([[1.3, 0.1], [2.1, 0.3], [2.0, 0.9], [1.2, 0.85]]) }] });
  const C = s.mesh({ id: "C", keyforms: [{ positions: pts([[3.1, 0.05], [3.9, 0.2], [3.8, 1.0], [3.0, 0.9]]) }] });
  s.glue({
    id: "G1",
    band,
    a: A,
    b: B,
    pairs: [
      [1, f(0.37), 0, f(0.81)],
      [2, f(0.55), 3, f(0.23)],
    ],
    intensities: [f(0.33), f(0.91)],
  });
  s.glue({
    id: "G2",
    band,
    a: B,
    b: C,
    pairs: [
      [1, f(0.64), 0, f(0.29)],
      [0, f(0.18), 3, f(0.72)],
    ],
    intensities: [f(0.77), f(0.42)],
  });
  model("bitexact-glue", s, { params: ["P"], parts: ["Root"] }, [
    [
      "pose",
      { parameters: { P: f(0.6180339) } },
      {
        vertices: {
          [A]: pts([[0.1, 0.2], [1.0018919706344604, 0.13726350665092468], [0.9825285077095032, 0.8189326524734497], [0.12, 0.75]]),
          [B]: pts([[1.2685987949371338, 0.20483481884002686], [2.454360246658325, 0.21140989661216736], [2.0, 0.9], [1.1445790529251099, 0.8420827388763428]]),
          [C]: pts([[2.9394302368164062, 0.0901423916220665], [3.9, 0.2], [3.8, 1.0], [2.23336124420166, 0.5921911001205444]]),
        },
      },
    ],
  ]);
}

// A blend-shape target glue's intensity is clamped to [0, 1].
{
  const s = new Synth(5);
  s.part({ id: "Root" });
  const Q = s.param("Q", 0, 1, 0, { type: 1 });
  const GA = s.mesh({ id: "GA", keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
  const GB = s.mesh({ id: "GB", keyforms: [{ positions: [2, 0, 3, 0, 2, 1] }] });
  const g = s.glue({ id: "G", a: GA, b: GB, pairs: [[1, 0.5, 0, 0.5]], intensities: [0.5] });
  s.blendShape("glue", g, { param: Q, keys: [0, 1], base: 0, keyforms: [0, f(0.8)] });
  model(
    "bitexact-glue-target",
    s,
    { params: ["Q"], parts: ["Root"] },
    (
      [
        [0.25, 1.350000023841858, 1.649999976158142],
        [f(0.6), 1.4900000095367432, 1.5099999904632568],
        [1, 1.5, 1.5],
      ] as const
    ).map(([q], i): [string, Pose, Expect] => [`q${i}`, { parameters: { Q: q } }, {}]),
  );
  // GA's vertex 1 x and GB's vertex 0 x (x is reported as in the file), checked here.
  const m = loadMoc(s.build());
  for (const [q, ga, gb] of [
    [0.25, 1.350000023841858, 1.649999976158142],
    [f(0.6), 1.4900000095367432, 1.5099999904632568],
    [1, 1.5, 1.5],
  ]) {
    const inst = new ModelInstance(m);
    inst.setParameter(0, q!);
    inst.evaluate();
    if (!Object.is(inst.drawableVertices[GA]![2], f(ga!)) || !Object.is(inst.drawableVertices[GB]![0], f(gb!))) {
      console.error(`bit_exact: glue target Q = ${q}: ${inst.drawableVertices[GA]![2]}, ${inst.drawableVertices[GB]![0]}`);
      failures++;
    }
  }
}

// A blend shape's constraint weight between keys, in the weighted form.
{
  const s = new Synth(5);
  s.part({ id: "Root" });
  const B = s.param("B", 0, 1, 0, { type: 1 });
  const C = s.param("C", 0, 1, 0);
  const zero = {
    positions: [0, 0, 0, 0, 0, 0],
    opacity: 0,
    drawOrder: 0,
    multiply: [0, 0, 0] as RGB,
    screen: [0, 0, 0] as RGB,
  };
  const m = s.mesh({
    id: "M",
    keyforms: [{ positions: TRIANGLE, opacity: f(0.1), multiply: [1, 1, 1], screen: [0, 0, 0] }],
  });
  s.blendShape("mesh", m, {
    param: B,
    keys: [0, 1],
    base: 0,
    keyforms: [zero, { ...zero, opacity: f(0.6), screen: [0, f(0.45), 0] }],
    constraints: [{ param: C, keys: [0, 1], weights: [f(0.9), f(0.35)] }],
  });
  model(
    "bitexact-constraint",
    s,
    { params: ["B", "C"], parts: ["Root"] },
    (
      [
        [f(0.3), f(0.42), 0.2204200029373169, 0.09031500667333603],
        [f(0.123457), f(0.0731), 0.16368862986564636, 0.04776647314429283],
        [f(0.8), f(0.6), 0.37359997630119324, 0.2051999717950821],
      ] as const
    ).map(([b, c, opacity, green], i): [string, Pose, Expect] => [
      `b${i}`,
      { parameters: { B: b, C: c } },
      { opacity: { 0: opacity }, screen: { 0: green } },
    ]),
  );
}

if (failures) {
  console.error(`bit_exact: ${failures} values differ from 0.14.0's printed vectors`);
  process.exit(1);
}
console.log(`bit_exact: ${scenarios} scenarios on 7 models; Mochi2D gives every printed vector`);

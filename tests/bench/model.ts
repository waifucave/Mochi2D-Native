/**
 * A synthetic model of DeepSeek-chan's size for the evaluation benchmark,
 * made with the reference's own builder (Synth) from seeded random choices.
 * Nothing comes from the model itself: the sizes are the structural facts
 * that Mochi2D's tests state about it (test/deepseek.test.ts):
 *
 * - version 5, 509 parameters, 147 parts (151 part keyforms);
 * - 723 warps (5842 normal keyforms) and 99 rotations (457), one root warp,
 *   628 warps under warps, 94 under rotations, 59 rotations under warps and
 *   40 under rotations;
 * - 715 art meshes (808 normal keyforms), 58,967 vertices, 88,668
 *   triangles, 299 mask entries;
 * - 155 bands: 1 with no binding, 92 with one, 44 with two, 16 with three,
 *   2 with four; 123 parameter bindings;
 * - 38 glues; about 1007 blend-shape bindings on 349 warps, 13 meshes and
 *   22 rotations; 18 blend-shape constraints;
 * - about 3.67 million keyform position floats.
 *
 * With --render the art meshes are shaped as artwork is for the render
 * benchmark (tests/bench/render_bench.cpp): each a triangulated, jittered
 * grid over part of its deformer, its UVs one cell of a 27 × 27 texture
 * atlas. Everything else, the vertex counts and the random choices of the
 * rest of the model included, stays as without it.
 *
 * usage: node model.mjs <out.moc3> [seed] [--render]
 */
import { writeFileSync } from "node:fs";
import { Synth, type WarpKeyform, type RotationKeyform, type MeshKeyform } from "../../reference/mochi2d-0.21.0/test/support/synth.js";

const renderShapes = process.argv.includes("--render");
const args = process.argv.slice(2).filter((a) => a !== "--render");
const out = args[0];
if (!out) {
  console.error("usage: node model.mjs <out.moc3> [seed] [--render]");
  process.exit(2);
}
let seed = Number(args[1] ?? 2026) >>> 0 || 1;
const rnd = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
// The render shapes' own generator, so the rest of the model's choices stay the same.
let shapeSeed = (seed ^ 0x9e3779b9) >>> 0 || 1;
const shapeRnd = () => {
  shapeSeed = (Math.imul(shapeSeed, 1664525) + 1013904223) >>> 0;
  return shapeSeed / 4294967296;
};
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const f = Math.fround;

const s = new Synth(5);
s.canvas = { pixelsPerUnit: 3749, originX: 1874.5, originY: 3848.5, width: 3749, height: 7697, flags: 0 };

// Parameters: angles, unit ranges and signed ranges.
const kinds: [number, number, number][] = [
  [-30, 30, 0],
  [-10, 10, 0],
  [0, 1, 0],
  [0, 1, 1],
  [-1, 1, 0],
];
const params: { lo: number; hi: number; def: number }[] = [];
for (let p = 0; p < 509; p++) {
  const [lo, hi, def] = pick(kinds);
  s.param(`Param${String(p).padStart(3, "0")}`, lo, hi, def);
  params.push({ lo, hi, def });
}
const keys3 = (p: number) => {
  const { lo, hi } = params[p]!;
  return [lo, f((lo + hi) / 2), hi];
};
// 123 parameter bindings on the first 123 parameters, three keys each.
const bindings: number[] = [];
for (let p = 0; p < 123; p++) bindings.push(s.binding(p, keys3(p)));
// Bands: 92 with one binding, 44 with two, 16 with three, 2 with four (band 0 has none).
const bandsBySize: number[][] = [[0], [], [], [], []];
const distinct = (n: number) => {
  const set = new Set<number>();
  while (set.size < n) set.add(pick(bindings));
  return [...set];
};
for (const [size, count] of [
  [1, 92],
  [2, 44],
  [3, 16],
  [4, 2],
] as const)
  for (let k = 0; k < count; k++) bandsBySize[size]!.push(s.band(distinct(size)));
const keyformCount = (size: number) => 3 ** size;
/** A band whose keyform count follows the given weights by binding count. */
const bandOf = (weights: number[]) => {
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let size = 0; size < weights.length; size++) {
    r -= weights[size]!;
    if (r < 0) return { band: pick(bandsBySize[size]!), size };
  }
  return { band: 0, size: 0 };
};

// Parts: a root and a tree under it; two parts on one-binding bands.
const parts: number[] = [s.part({ id: "Part000" })];
for (let p = 1; p < 147; p++) {
  const banded = p === 40 || p === 90;
  const band = banded ? pick(bandsBySize[1]!) : 0;
  parts.push(
    s.part({
      id: `Part${String(p).padStart(3, "0")}`,
      parent: pick(parts),
      band,
      keyforms: Array.from({ length: banded ? 3 : 1 }, () => ({ drawOrder: int(100, 900) })),
    }),
  );
}

const rgb = (): [number, number, number] => [1, 1, 1];
/** A grid of (R+1)(C+1) points spanning [x0, x1] × [y0, y1], with some noise. */
const grid = (R: number, C: number, x0: number, x1: number, y0: number, y1: number, noise: number) => {
  const pts: number[] = [];
  for (let r = 0; r <= R; r++)
    for (let c = 0; c <= C; c++)
      pts.push(f(x0 + ((x1 - x0) * c) / C + noise * (rnd() - 0.5)), f(y0 + ((y1 - y0) * r) / R + noise * (rnd() - 0.5)));
  return pts;
};
const delta = (n: number, size: number) => Array.from({ length: n }, () => f(size * (rnd() - 0.5)));

// Deformers, parents first. Kinds of (child, parent) as in DeepSeek-chan.
type Def = { index: number; kind: 0 | 1; R: number; C: number; warp: number; rotation: number };
const defs: Def[] = [];
const warps: Def[] = [];
const rotations: Def[] = [];
const warpBands = [71, 310, 250, 90, 2];
const rotationBands = [30, 50, 15, 4, 0];
const addWarp = (parent: Def | null) => {
  const R = int(7, 19);
  const C = int(7, 19);
  const { band, size } = bandOf(warpBands);
  const n = keyformCount(size);
  const [x0, x1, y0, y1] =
    parent === null
      ? [-0.5, 0.5, -1.03, 1.03]
      : parent.kind === 0
        ? (() => {
            const a = 0.05 + 0.4 * rnd();
            const b = 0.05 + 0.4 * rnd();
            return [a, a + 0.5 * rnd() + 0.05, b, b + 0.5 * rnd() + 0.05];
          })()
        : [-0.1, 0.1, -0.1, 0.1];
  const span = Math.abs(x1 - x0);
  const keyforms: WarpKeyform[] = Array.from({ length: n }, () => ({
    points: grid(R, C, x0, x1, y0, y1, span * 0.02),
    opacity: 1,
    multiply: rgb(),
    screen: [0, 0, 0],
  }));
  const index = s.warp({
    id: `Warp${String(warps.length).padStart(3, "0")}`,
    band,
    part: pick(parts),
    parent: parent ? parent.index : -1,
    rows: R,
    cols: C,
    bilinear: rnd() < 0.2,
    keyforms,
  });
  const d: Def = { index, kind: 0, R, C, warp: warps.length, rotation: -1 };
  warps.push(d);
  defs.push(d);
  return d;
};
const addRotation = (parent: Def) => {
  const { band, size } = bandOf(rotationBands);
  const n = keyformCount(size);
  const inWarp = parent.kind === 0;
  const keyforms: RotationKeyform[] = Array.from({ length: n }, () => ({
    angle: f(-20 + 40 * rnd()),
    x: f(inWarp ? 0.2 + 0.6 * rnd() : -0.05 + 0.1 * rnd()),
    y: f(inWarp ? 0.2 + 0.6 * rnd() : -0.05 + 0.1 * rnd()),
    scale: f(inWarp ? 0.2 : 1),
    opacity: 1,
    multiply: rgb(),
    screen: [0, 0, 0],
  }));
  const index = s.rotation({
    id: `Rotation${String(rotations.length).padStart(2, "0")}`,
    band,
    part: pick(parts),
    parent: parent.index,
    baseAngle: f(-5 + 10 * rnd()),
    keyforms,
  });
  const d: Def = { index, kind: 1, R: 0, C: 0, warp: -1, rotation: rotations.length };
  rotations.push(d);
  defs.push(d);
  return d;
};
addWarp(null);
// The remaining pairs in a random order: 628 warps under warps, 94 under rotations, 59 rotations under warps, 40 under rotations.
const todo: string[] = [
  ...Array(628).fill("ww"),
  ...Array(94).fill("wr"),
  ...Array(59).fill("rw"),
  ...Array(40).fill("rr"),
];
for (let i = todo.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [todo[i], todo[j]] = [todo[j]!, todo[i]!];
}
// A pair whose parent kind does not exist yet waits until one does.
const waiting: string[] = [];
const place = (pair: string): boolean => {
  const parentPool = pair[1] === "w" ? warps : rotations;
  if (parentPool.length === 0) return false;
  const parent = pick(parentPool);
  if (pair[0] === "w") addWarp(parent);
  else addRotation(parent);
  return true;
};
for (const pair of todo) {
  if (!place(pair)) waiting.push(pair);
  for (let k = waiting.length - 1; k >= 0; k--) if (place(waiting[k]!)) waiting.splice(k, 1);
}

// Art meshes: 58,967 vertices in all, most on band 0; positions in the deformer's input space.
const meshes: { index: number; V: number }[] = [];
let vertexBudget = 58967;
for (let m = 0; m < 715; m++) {
  const left = 715 - m;
  const V = m === 714 ? vertexBudget : Math.max(4, Math.min(vertexBudget - 4 * (left - 1), int(10, 155)));
  vertexBudget -= V;
  const def = rnd() < 0.97 ? pick(defs) : null;
  const banded = m % 15 === 7 && meshes.filter((x) => x.V > 0).length < 715;
  const band = banded ? pick(bandsBySize[1]!) : 0;
  const n = banded ? 3 : 1;
  const [x0, x1, y0, y1] = def === null ? [-0.4, 0.4, -0.9, 0.9] : def.kind === 0 ? [0.1, 0.9, 0.1, 0.9] : [-0.05, 0.05, -0.05, 0.05];
  const keyforms: MeshKeyform[] = Array.from({ length: n }, () => ({
    positions: Array.from({ length: V }, () => [f(x0 + (x1 - x0) * rnd()), f(y0 + (y1 - y0) * rnd())]).flat(),
    opacity: 1,
    drawOrder: int(200, 800),
    multiply: rgb(),
    screen: [0, 0, 0],
  }));
  // About 1.5 triangles per vertex.
  const triangles: number[] = [];
  const T = Math.max(1, Math.round(1.5 * V));
  for (let t = 0; t < T; t++) {
    const a = t % (V - 2);
    triangles.push(a, a + 1, (a + 2 + int(0, V - 3)) % V);
  }
  const part = pick(parts);
  let uvs = Array.from({ length: 2 * V }, () => f(rnd()));
  if (renderShapes) {
    // A jittered c × r grid (row by row, the last row partial) over a part of the deformer's
    // range; two triangles per complete cell; UVs in the mesh's cell of the atlas.
    const c = Math.max(2, Math.round(Math.sqrt(V)));
    const r = Math.ceil(V / c);
    const w = (x1 - x0) * (0.15 + 0.35 * shapeRnd());
    const h = (y1 - y0) * (0.15 + 0.35 * shapeRnd());
    const left = x0 + (x1 - x0 - w) * shapeRnd();
    const bottom = y0 + (y1 - y0 - h) * shapeRnd();
    const base: number[] = [];
    for (let k = 0; k < V; k++) {
      const i = Math.floor(k / c);
      const j = k % c;
      base.push(left + (w * (j + 0.3 * (shapeRnd() - 0.5))) / (c - 1), bottom + (h * (i + 0.3 * (shapeRnd() - 0.5))) / (r - 1));
    }
    for (const kf of keyforms) kf.positions = base.map((v, q) => f(v + 0.02 * (q % 2 ? h : w) * (shapeRnd() - 0.5)));
    triangles.length = 0;
    for (let i = 0; i + 1 < r; i++)
      for (let j = 0; j + 1 < c; j++) {
        const a = i * c + j;
        const e = a + c + 1;
        if (e < V) triangles.push(a, a + 1, e, a, e, a + c);
      }
    if (triangles.length === 0) triangles.push(0, 1, 2);
    const cu = m % 27;
    const cv = Math.floor(m / 27);
    uvs = [];
    for (let k = 0; k < V; k++) {
      const i = Math.floor(k / c);
      const j = k % c;
      uvs.push(f((cu + 0.05 + (0.9 * j) / (c - 1)) / 27), f((cv + 0.05 + (0.9 * i) / (r - 1)) / 27));
    }
  }
  const index = s.mesh({
    id: `ArtMesh${String(m).padStart(3, "0")}`,
    band,
    part,
    deformer: def ? def.index : -1,
    uvs,
    triangles,
    keyforms,
  });
  meshes.push({ index, V });
}
// Masks: 299 entries on 100 meshes.
// (Synth takes masks at creation; mask lists are added through the raw fields below.)

// Glues: 38, about 65 pairs each, between meshes of similar size.
for (let g = 0; g < 38; g++) {
  const a = pick(meshes);
  let b = pick(meshes);
  while (b === a) b = pick(meshes);
  const pairs: [number, number, number, number][] = [];
  const n = Math.min(65, a.V, b.V);
  for (let k = 0; k < n; k++) pairs.push([k, f(rnd()), k, f(rnd())]);
  s.glue({ id: `Glue${String(g).padStart(2, "0")}`, a: a.index, b: b.index, pairs, intensities: [1] });
}

// Blend shapes: warps (349 targets, about 928 bindings), meshes (13), rotations (22, about 66 bindings).
const blendParams = Array.from({ length: 52 }, (_, k) => 123 + k);
const blendKeys = (p: number) => {
  const { lo, hi, def } = params[p]!;
  const keys = [lo, f((lo + hi) / 2), hi];
  const base = keys.indexOf(def) >= 0 ? keys.indexOf(def) : 0;
  return { keys, base };
};
const constraintsLeft = { n: 18 };
const constraints = () => {
  if (constraintsLeft.n <= 0 || rnd() > 0.03) return [];
  constraintsLeft.n--;
  const p = pick(blendParams);
  const { lo, hi } = params[p]!;
  return [{ param: p, keys: [lo, hi], weights: [0, 1] }];
};
const shuffled = <T>(a: T[]) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
};
for (const w of shuffled(warps).slice(0, 349)) {
  const count = rnd() < 0.66 ? 3 : 2;
  const used = new Set<number>();
  for (let k = 0; k < count; k++) {
    let p = pick(blendParams);
    while (used.has(p)) p = pick(blendParams);
    used.add(p);
    const { keys, base } = blendKeys(p);
    const span = 0.01;
    s.blendShape("warp", w.warp, {
      param: p,
      keys,
      base,
      keyforms: keys.map(() => ({
        points: delta(2 * (w.R + 1) * (w.C + 1), span),
        opacity: 0,
        multiply: [0, 0, 0],
        screen: [0, 0, 0],
      })),
      constraints: constraints(),
    });
  }
}
for (const m of shuffled(meshes.filter((x) => x.V > 0)).slice(0, 13)) {
  const p = pick(blendParams);
  const { keys, base } = blendKeys(p);
  s.blendShape("mesh", m.index, {
    param: p,
    keys,
    base,
    keyforms: keys.map(() => ({ positions: delta(2 * m.V, 0.01), opacity: 0, drawOrder: 0, multiply: [0, 0, 0], screen: [0, 0, 0] })),
    constraints: constraints(),
  });
}
for (const r of shuffled(rotations).slice(0, 22)) {
  const used = new Set<number>();
  for (let k = 0; k < 3; k++) {
    let p = pick(blendParams);
    while (used.has(p)) p = pick(blendParams);
    used.add(p);
    const { keys, base } = blendKeys(p);
    s.blendShape("rotation", r.rotation, {
      param: p,
      keys,
      base,
      keyforms: keys.map(() => ({ angle: f(-5 + 10 * rnd()), x: 0, y: 0, scale: 0, opacity: 0, multiply: [0, 0, 0], screen: [0, 0, 0] })),
      constraints: constraints(),
    });
  }
}

const bytes = s.build({
  tamper: (F) => {
    // 299 mask entries on 100 meshes: each lists one to five other meshes.
    const first = F["mesh.firstMask"] as number[];
    const count = F["mesh.maskCount"] as number[];
    const entries: number[] = [];
    let left = 299;
    for (let m = 0; m < first.length; m++) {
      first[m] = entries.length;
      const n = m % 7 === 3 && left > 0 ? Math.min(left, int(1, 5)) : 0;
      for (let k = 0; k < n; k++) entries.push((m + 1 + k) % first.length);
      count[m] = n;
      left -= n;
    }
    F.maskEntries = entries;
  },
});
writeFileSync(out, bytes);
console.log(`${out}: ${(bytes.length / 1048576).toFixed(1)} MiB`);

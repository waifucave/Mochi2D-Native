/**
 * Cross-check vectors from the reference (Mochi2D 0.14.0 in reference/), made
 * at test time and never committed:
 *
 * - models/: random synthetic models of versions 1–6 built with Mochi2D's
 *   own test builder (test/support/synth.ts), each with a settings file;
 * - scenarios/: static scenarios (mochi2d-scenario/0) on them, sequences
 *   (mochi2d-sequence/0) and animation scenarios (mochi2d-anim-scenario/0),
 *   whose motions, expressions, physics, poses and sounds anim.ts writes
 *   into the model folders, and malformed sequences and animations;
 * - validate/: single-value mutations of synthetic files and other broken
 *   bytes, with the reference's validateMoc verdicts at both levels, the
 *   loader's verdict and writeMoc's output for the read data
 *   (validate/expected.json).
 *
 * The reference's results for the scenarios come from its own conformance
 * tool (run by tests/crosscheck/run.sh). No model data of any third party is
 * involved.
 *
 * usage: node generate.mjs <outDir> [--models N] [--mutations N] [--anims N]
 *          [--sound-scale X] [--scenarios-only]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Synth } from "../../reference/mochi2d-0.24.1/test/support/synth.js";
import { sampleModel } from "../../reference/mochi2d-0.24.1/test/support/sample-model.js";
import { readMoc, writeMoc, writeMocUnchecked } from "../../reference/mochi2d-0.24.1/src/core/moc/io.js";
import { validateMoc } from "../../reference/mochi2d-0.24.1/src/core/moc/validate.js";
import { loadMoc } from "../../reference/mochi2d-0.24.1/src/core/moc/model.js";
import { ModelInstance } from "../../reference/mochi2d-0.24.1/src/core/eval/instance.js";
import { MOC_DATA_LAYOUT, type MocData, type MocDataGroup } from "../../reference/mochi2d-0.24.1/src/core/moc/data.js";
import { ELEMENT_SIZE, FIELDS } from "../../reference/mochi2d-0.24.1/src/core/moc/schema.js";
import { VALIDATION_CASES } from "../../reference/mochi2d-0.24.1/tools/lib/catalog/moc-crafts.js";
import { animationVectors, invalidScenarios } from "./anim.js";
import { idleVectors, type IdleCase } from "./idle.js";
import { evalVectors, modeDifferences, type EvalCase } from "./eval.js";
import { liveVectors } from "./live.js";

const args = process.argv.slice(2);
const out = args[0] ?? "crosscheck-out";
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const MODELS = opt("models", 60);
const MUTATIONS = opt("mutations", 400);
const ANIMS = opt("anims", 3);
/** Scales the length of the generated sounds (the committed fixtures use short ones). */
const SOUND_SCALE = opt("sound-scale", 1);
/** Only models and scenarios (for the committed fixtures): no validation or mapping vectors. */
const SCENARIOS_ONLY = args.includes("--scenarios-only");
const f = Math.fround;

/** A seeded sequence in [0, 1). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// ------------------------------------------------------------ random models

function randomModel(version: number, seed: number): {
  synth: Synth;
  params: { id: string; min: number; max: number; keys: number[] }[];
  parts: string[];
  tamper?: (f: Record<string, unknown>) => void;
} {
  const rnd = lcg(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const between = (a: number, b: number) => f(a + (b - a) * rnd());
  const chance = (p: number) => rnd() < p;
  const s = new Synth(version);
  let tamper: ((f: Record<string, unknown>) => void) | undefined;
  s.canvas = {
    pixelsPerUnit: f(pick([1, 100, 512.5])),
    originX: between(-1, 1),
    originY: between(-1, 1),
    width: between(1, 4),
    height: between(1, 4),
    flags: chance(0.2) ? 1 : 0,
  };
  // Parameters and their bindings.
  const params: { id: string; min: number; max: number; keys: number[]; index: number; binding: number }[] = [];
  const nParams = 2 + Math.floor(rnd() * 4);
  for (let p = 0; p < nParams; p++) {
    const [min, max] = pick([
      [-30, 30],
      [0, 1],
      [-1, 1],
      [-10, 10],
      [0, 360],
    ] as const);
    const repeat = chance(0.15);
    const def = f(chance(0.5) ? 0 : between(min, max));
    const id = `Param${p}`;
    const index = s.param(id, min, max, Math.min(max, Math.max(min, def)), { repeat });
    const n = 2 + Math.floor(rnd() * 3);
    const keys: number[] = [];
    for (let k = 0; k < n; k++) keys.push(f(min + ((max - min) * k) / (n - 1) + (k > 0 && k < n - 1 ? between(-0.1, 0.1) : 0)));
    if (chance(0.15)) keys[keys.length - 1] = f(keys[keys.length - 1]! - (max - min) / 4); // keys short of max
    const binding = s.binding(index, keys);
    params.push({ id, min, max, keys, index, binding });
  }
  // Bands: 0 is empty; then random combinations of 1–3 bindings.
  const bands: { id: number; count: number }[] = [{ id: 0, count: 1 }];
  const nBands = 1 + Math.floor(rnd() * 4);
  for (let b = 0; b < nBands; b++) {
    const k = 1 + Math.floor(rnd() * Math.min(3, params.length));
    const chosen = [...params].sort(() => rnd() - 0.5).slice(0, k);
    const id = s.band(chosen.map((p) => p.binding));
    bands.push({ id, count: chosen.reduce((a, p) => a * p.keys.length, 1) });
  }
  const anyBand = () => (chance(0.3) ? bands[0]! : pick(bands));
  const color = () =>
    version >= 4
      ? {
          ...(chance(0.6) ? { multiply: [between(0.3, 1.2), between(0.3, 1), between(0, 1)] as [number, number, number] } : {}),
          ...(chance(0.5) ? { screen: [between(-0.1, 0.6), between(0, 0.5), between(0, 0.5)] as [number, number, number] } : {}),
        }
      : {};
  // Parts.
  const partIds: string[] = [];
  const partBand: number[] = [];
  const nParts = 1 + Math.floor(rnd() * 4);
  for (let p = 0; p < nParts; p++) {
    const band = p === 0 ? bands[0]! : anyBand();
    const id = `Part${p}`;
    s.part({
      id,
      band: band.id,
      parent: p === 0 ? -1 : Math.floor(rnd() * p),
      initial: chance(0.9) ? 1 : 0,
      enabled: chance(0.95),
      keyforms: Array.from({ length: band.count }, () => ({ drawOrder: f(Math.round(between(300, 700)) + (chance(0.3) ? between(-0.5, 0.5) : 0)) })),
    });
    partIds.push(id);
    partBand.push(band.id);
  }
  // Deformers: warps and rotations, each parented to an earlier one or none.
  const deformers: { kind: 0 | 1; index: number; band: (typeof bands)[number]; rows?: number; cols?: number }[] = [];
  const nDef = Math.floor(rnd() * 5);
  for (let d = 0; d < nDef; d++) {
    const band = anyBand();
    const parent = d > 0 && chance(0.6) ? Math.floor(rnd() * d) : -1;
    const underWarp = parent >= 0 && deformers[parent]!.kind === 0;
    const span = underWarp ? 1 : 2;
    const off = underWarp ? 0 : -1;
    if (chance(0.55)) {
      const rows = 1 + Math.floor(rnd() * 3);
      const cols = 1 + Math.floor(rnd() * 3);
      const keyforms = Array.from({ length: band.count }, () => {
        const points: number[] = [];
        const jitter = between(0, 0.08);
        for (let r = 0; r <= rows; r++)
          for (let c = 0; c <= cols; c++) {
            points.push(f(off + (span * c) / cols + between(-jitter, jitter)));
            points.push(f(off + (span * r) / rows + between(-jitter, jitter)));
          }
        return { points, ...(chance(0.3) ? { opacity: between(0.2, 1) } : {}), ...color() };
      });
      const index = s.warp({
        id: `Warp${d}`,
        band: band.id,
        part: Math.floor(rnd() * nParts),
        parent,
        enabled: chance(0.95),
        rows,
        cols,
        ...(version >= 2 && chance(0.5) ? { bilinear: true } : {}),
        keyforms,
      });
      deformers.push({ kind: 0, index, band, rows, cols });
    } else {
      const keyforms = Array.from({ length: band.count }, () => ({
        angle: between(-45, 45),
        x: underWarp ? between(0.1, 0.9) : between(-0.5, 0.5),
        y: underWarp ? between(0.1, 0.9) : between(-0.5, 0.5),
        scale: between(0.5, 1.5),
        ...(chance(0.15) ? { mirrorX: true } : {}),
        ...(chance(0.15) ? { mirrorY: true } : {}),
        ...(chance(0.3) ? { opacity: between(0.2, 1) } : {}),
        ...color(),
      }));
      const index = s.rotation({
        id: `Rot${d}`,
        band: band.id,
        part: Math.floor(rnd() * nParts),
        parent,
        enabled: chance(0.95),
        baseAngle: chance(0.5) ? 0 : between(-30, 30),
        keyforms,
      });
      deformers.push({ kind: 1, index, band });
    }
  }
  // Art meshes.
  const meshes: { index: number; V: number; deformer: number; band: (typeof bands)[number] }[] = [];
  const nMeshes = 1 + Math.floor(rnd() * 5);
  for (let m = 0; m < nMeshes; m++) {
    const band = anyBand();
    const deformer = deformers.length && chance(0.8) ? Math.floor(rnd() * deformers.length) : -1;
    const underWarp = deformer >= 0 && deformers[deformer]!.kind === 0;
    const V = 3 + Math.floor(rnd() * 4);
    const base: number[] = [];
    for (let v = 0; v < 2 * V; v++) base.push(underWarp ? between(-0.4, 1.4) : between(-1, 1));
    if (underWarp && chance(0.2)) base[0] = f(pick([-2.5, 3.5, -1, 2]));
    const keyforms = Array.from({ length: band.count }, () => ({
      positions: base.map((x) => f(x + between(-0.05, 0.05))),
      drawOrder: f(Math.round(between(300, 700)) + (chance(0.3) ? between(-0.6, 0.6) : 0)),
      opacity: chance(0.7) ? 1 : between(0, 1),
      ...color(),
    }));
    const triangles: number[] = [];
    for (let t = 1; t + 1 < V; t++) triangles.push(0, t, t + 1);
    const index = s.mesh({
      id: `Mesh${m}`,
      band: band.id,
      part: Math.floor(rnd() * nParts),
      deformer,
      enabled: chance(0.95),
      texture: Math.floor(rnd() * 2),
      flags: pick([0, 1, 2, 4, 8, 12]),
      ...(version >= 6 ? { blendMode: pick([0, 1, 2, 3]) } : {}),
      uvs: Array.from({ length: 2 * V }, () => between(0, 1)),
      triangles,
      masks: m > 0 && chance(0.3) ? [Math.floor(rnd() * m), -1] : [],
      keyforms,
    });
    meshes.push({ index, V, deformer, band });
  }
  // Glue.
  if (meshes.length >= 2 && chance(0.4)) {
    const a = meshes[0]!;
    const b = meshes[1]!;
    const band = anyBand();
    s.glue({
      id: "Glue0",
      band: band.id,
      a: a.index,
      b: b.index,
      pairs: [
        [0, between(0, 1), 0, between(0, 1)],
        [1, between(0, 1), 2, between(0, 1)],
      ],
      intensities: Array.from({ length: band.count }, () => between(0, 1)),
    });
  }
  // Blend shapes (v4: warps and meshes; v5: parts, rotations, glues too; v6: offscreens, below).
  let blendParam = -1;
  if (version >= 4) {
    const bsParam = s.param("ParamBlend", -1, 1, 0, { type: 1 });
    blendParam = bsParam;
    params.push({ id: "ParamBlend", min: -1, max: 1, keys: [-1, 0, 1], index: bsParam, binding: -1 });
    const conParam = params[0]!;
    const constraints = () =>
      chance(0.3)
        ? [{ param: conParam.index, keys: [conParam.min, conParam.max].map(f), weights: [between(0, 1), between(0, 1)] }]
        : [];
    for (const m of meshes) {
      if (!chance(0.5)) continue;
      const keys = [-1, 0, 1];
      s.blendShape("mesh", m.index, {
        param: bsParam,
        keys,
        base: 1,
        constraints: constraints(),
        keyforms: keys.map(() => ({
          positions: Array.from({ length: 2 * m.V }, () => between(-0.1, 0.1)),
          drawOrder: f(between(-50, 50)),
          opacity: between(-0.5, 0.5),
          ...color(),
        })),
      });
    }
    for (const d of deformers) {
      if (d.kind === 0 && chance(0.4)) {
        const pts = 2 * (d.rows! + 1) * (d.cols! + 1);
        s.blendShape("warp", d.index - deformers.filter((x, i) => i < deformers.indexOf(d) && x.kind === 1).length, {
          param: bsParam,
          keys: [0, 1],
          base: 0,
          keyforms: [0, 1].map(() => ({ points: Array.from({ length: pts }, () => between(-0.05, 0.05)), opacity: between(-0.3, 0.3), ...color() })),
        });
      }
      if (version >= 5 && d.kind === 1 && chance(0.4)) {
        const rotIndex = deformers.filter((x, i) => i < deformers.indexOf(d) && x.kind === 1).length;
        s.blendShape("rotation", rotIndex, {
          param: bsParam,
          keys: [-1, 0, 1],
          base: 1,
          constraints: constraints(),
          keyforms: [-1, 0, 1].map(() => ({ angle: between(-20, 20), x: between(-0.1, 0.1), y: between(-0.1, 0.1), scale: between(-0.2, 0.2), opacity: between(-0.3, 0.3) })),
        });
      }
    }
    if (version >= 5)
      for (let p = 1; p < nParts; p++)
        if (chance(0.3))
          s.blendShape("part", p, {
            param: bsParam,
            keys: [-1, 0, 1],
            base: 1,
            keyforms: [-1, 0, 1].map(() => ({ drawOrder: f(between(-40, 40)) })),
          });
  }
  // Draw-order groups: sometimes a part object with a nested group (and, in v6, an offscreen).
  if (nParts >= 2 && meshes.length >= 2 && chance(version >= 6 ? 0.9 : 0.5)) {
    const P = 1;
    const inner = meshes.slice(1).map((m) => ({ kind: 0 as const, index: m.index }));
    s.groups = [
      { min: 0, max: 1000, objects: [{ kind: 0, index: meshes[0]!.index }, { kind: 1, index: P, nested: 1 }] },
      { min: chance(0.8) ? 0 : 450, max: chance(0.8) ? 1000 : 550, objects: inner },
    ];
    if (version >= 6 && chance(0.85)) {
      const count = bands.find((b) => b.id === partBand[P])!.count;
      const o = s.offscreen({
        part: P,
        blendMode: pick([0, 1, 2]),
        masks: chance(0.3) ? [meshes[0]!.index] : [],
        keyforms: Array.from({ length: count }, () => ({ opacity: between(0.2, 1), ...color() })),
      });
      // An offscreen target (count 37): offscreen keyforms that move its opacity
      // and colors, past [0, 1] too (the target clamp).
      if (blendParam >= 0 && chance(0.8))
        s.blendShape("offscreen", o, {
          param: blendParam,
          keys: [-1, 0, 1],
          base: 1,
          keyforms: [-1, 0, 1].map(() => ({ opacity: between(-0.6, 0.6), ...color() })),
        });
      // 0.10.0: an owner's normal keyform may name no offscreen keyform (−1); the
      // offscreen's opacity and colors are then 0 there (the first keyform's −1
      // also leaves the colors' indices as stored).
      if (chance(0.3)) {
        const k = Math.floor(rnd() * count);
        tamper = (fields) => {
          const first = (fields["part.firstKeyform"] as number[])[P]!;
          (fields["partKeyform.offscreenKeyform"] as number[])[first + k] = -1;
        };
      }
    }
  } else if (chance(0.2)) {
    s.groups = [{ min: 450, max: 550, objects: meshes.map((m) => ({ kind: 0 as const, index: m.index })) }];
  }
  return { synth: s, params: params.map(({ id, min, max, keys }) => ({ id, min, max, keys })), parts: partIds, tamper };
}

// ------------------------------------------------------------- scenarios

function scenarios(name: string, model: ReturnType<typeof randomModel>, seed: number) {
  const rnd = lcg(seed);
  const out: unknown[] = [];
  const path = `${name}/${name}.model3.json`;
  out.push({ format: "mochi2d-scenario/0", id: `${name}-default`, model: path });
  for (let k = 0; k < 7; k++) {
    const parameters: Record<string, number> = {};
    for (const p of model.params) {
      const r = rnd();
      if (r < 0.15) continue;
      if (r < 0.35) {
        // On or near a key (snapping and the key tolerance).
        const key = p.keys[Math.floor(rnd() * p.keys.length)]!;
        parameters[p.id] = key + (rnd() - 0.5) * 0.003;
      } else if (r < 0.45) {
        parameters[p.id] = p.min - 1 - rnd() * 100; // below range
      } else if (r < 0.5) {
        parameters[p.id] = p.max + rnd() * 400; // above range (wraps if repeating)
      } else {
        parameters[p.id] = p.min + (p.max - p.min) * rnd();
      }
    }
    if (rnd() < 0.2) parameters["NoSuchParam"] = 1;
    const partOpacities: Record<string, number> = {};
    for (const id of model.parts) if (rnd() < 0.3) partOpacities[id] = rnd() < 0.2 ? 1.5 : rnd();
    out.push({ format: "mochi2d-scenario/0", id: `${name}-s${k}`, model: path, parameters, partOpacities });
  }
  return out;
}

// --------------------------------------------------------------- validation

interface Verdict {
  valid: boolean;
  version: number | null;
  diagnostics: unknown[];
}

const verdict = (bytes: Uint8Array, level: "official" | "strict"): Verdict => validateMoc(bytes, { level });

function loads(bytes: Uint8Array): string | null {
  try {
    loadMoc(bytes);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function written(bytes: Uint8Array): { bytes?: Uint8Array; error?: string[] } {
  try {
    const r = readMoc(bytes);
    if (r.version === 6) return { error: ["version-unsupported"] };
    return { bytes: writeMoc(r.data, { version: r.version as 1 }) };
  } catch (e) {
    const d = (e as { diagnostics?: { code: string }[] }).diagnostics;
    return { error: d ? d.map((x) => x.code) : [(e as { code?: string }).code ?? "error"] };
  }
}

function mutations(data: MocData, version: number, iterations: number, seed: number): Uint8Array[] {
  const rnd = lcg(seed);
  const targets: { group: MocDataGroup; field?: string }[] = [];
  for (const [g, layout] of Object.entries(MOC_DATA_LAYOUT)) {
    const present = (data as unknown as Record<string, unknown>)[g];
    if (present === undefined) continue;
    if ("pool" in layout) targets.push({ group: g as MocDataGroup });
    else
      for (const k of Object.keys(layout.fields))
        if ((present as Record<string, unknown>)[k] !== undefined && k !== "ids") targets.push({ group: g as MocDataGroup, field: k });
  }
  const files: Uint8Array[] = [];
  for (let it = 0; it < iterations; it++) {
    const t = targets[Math.floor(rnd() * targets.length)]!;
    const group = (data as unknown as Record<string, Record<string, unknown>>)[t.group]!;
    const arr = (t.field ? group[t.field] : group) as Int32Array | Float32Array | Uint16Array | Uint8Array;
    if (arr.length === 0) continue;
    const i = Math.floor(rnd() * arr.length);
    const old = arr[i]!;
    const len = arr.length;
    const choices =
      arr instanceof Float32Array
        ? [NaN, -1, 0, 1e9, old + 1, 0.5, -0, Infinity]
        : arr instanceof Uint16Array
          ? [0, 1, 65535, old + 1]
          : arr instanceof Uint8Array
            ? [0, 1, 2, 255]
            : [-2, -1, 0, 1, 2, len, len + 1, 2147483647, -2147483648, old + 1, old - 1];
    arr[i] = choices[Math.floor(rnd() * choices.length)]!;
    if (!Object.is(arr[i], old)) {
      try {
        files.push(writeMocUnchecked(data, { version: version as 1 }));
      } catch {
        /* the shape does not fit; skip */
      }
    }
    arr[i] = old;
  }
  return files;
}

// --------------------------------------------------------------------- main

mkdirSync(join(out, "models"), { recursive: true });
mkdirSync(join(out, "scenarios"), { recursive: true });
mkdirSync(join(out, "validate"), { recursive: true });
mkdirSync(join(out, "map"), { recursive: true });
mkdirSync(join(out, "idle"), { recursive: true });
const idleCases: IdleCase[] = [];
mkdirSync(join(out, "eval"), { recursive: true });
mkdirSync(join(out, "live"), { recursive: true });
writeFileSync(join(out, "live", "expected.json"), JSON.stringify(liveVectors(1313, 48)));
const evalCases: EvalCase[] = [];

/** Forward-mapping vectors (0.5.0 mapPoints, mapJacobians) on a model at random parameters. */
const mapVectors: unknown[] = [];
function mapCases(name: string, bytes: Uint8Array, seed: number): void {
  let model;
  try {
    model = loadMoc(bytes);
  } catch {
    return;
  }
  const rnd = lcg(seed);
  const inst = new ModelInstance(model);
  const params: [number, number][] = [];
  for (let p = 0; p < model.parameters.ids.length; p++) {
    const v = model.parameters.min[p]! + (model.parameters.max[p]! - model.parameters.min[p]!) * rnd();
    params.push([p, v]);
    inst.setParameter(p, v);
  }
  inst.evaluate();
  for (let d = -1; d < model.deformers.ids.length; d++) {
    const points: number[] = [];
    for (let k = 0; k < 8; k++) points.push(f(-3.5 + 8 * rnd()), f(-3.5 + 8 * rnd()));
    for (let k = 0; k < 6; k++) points.push(f(rnd()), f(rnd()));
    const space = rnd() < 0.7 ? "model" : "keyform";
    mapVectors.push({
      model: `${name}/${name}.moc3`,
      params,
      deformer: d,
      space,
      points,
      out: Array.from(inst.mapPoints(d, points, space)),
      jacobians: Array.from(inst.mapJacobians(d, points, space)),
    });
  }
}

const validationFiles: { name: string; bytes: Uint8Array }[] = [];
let scenarioCount = 0;
for (let i = 0; i < MODELS; i++) {
  const version = 1 + (i % 6);
  const name = `synth${String(i).padStart(3, "0")}-v${version}`;
  let model: ReturnType<typeof randomModel>;
  let bytes: Uint8Array;
  try {
    model = randomModel(version, 1000 + i);
    bytes = model.synth.build(model.tamper ? { tamper: model.tamper } : {});
  } catch (e) {
    console.error(`${name}: ${(e as Error).message}`);
    continue;
  }
  const dir = join(out, "models", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.moc3`), bytes);
  writeFileSync(join(dir, `${name}.model3.json`), JSON.stringify({ Version: 3, FileReferences: { Moc: `${name}.moc3`, Textures: [] } }, null, 2));
  for (const sc of scenarios(name, model, 7 + i) as { id: string }[]) {
    writeFileSync(join(out, "scenarios", `${sc.id}.json`), JSON.stringify(sc, null, 2));
    scenarioCount++;
  }
  // Sequences and animation scenarios, with their motions, expressions,
  // physics, poses and sounds in the model's folder.
  try {
    const loaded = loadMoc(bytes);
    for (const sc of animationVectors(name, dir, loaded, 400 + i, ANIMS, SOUND_SCALE).scenarios as { id: string }[]) {
      writeFileSync(join(out, "scenarios", `${sc.id}.json`), JSON.stringify(sc, null, 2));
      scenarioCount++;
    }
    idleCases.push(...idleVectors(name, dir, loaded, 900 + i, 2));
    if (i === 0)
      for (const sc of invalidScenarios(`${name}/a0.model3.json`) as { id: string }[]) {
        const file = `${sc.id}.json`;
        if (sc.id === "bad-anim-badid") sc.id = "bad id";
        writeFileSync(join(out, "scenarios", file), JSON.stringify(sc, null, 2));
        scenarioCount++;
      }
  } catch (e) {
    console.error(`${name}: ${(e as Error).message}`);
  }
  validationFiles.push({ name: `${name}`, bytes });
  mapCases(name, bytes, 31 + i);
  try {
    evalCases.push(...evalVectors(`${name}/${name}.moc3`, loadMoc(bytes), 77 + i));
  } catch {
    // Models that do not load have no evaluation vectors.
  }
}
writeFileSync(join(out, "map", "expected.json"), JSON.stringify(mapVectors));
writeFileSync(join(out, "idle", "expected.json"), JSON.stringify(idleCases));
writeFileSync(join(out, "eval", "expected.json"), JSON.stringify(evalCases));
{
  // Mochi2D's own two modes, compared.
  let differ = 0;
  for (let k = 0; k + 1 < evalCases.length; k += 2) differ += modeDifferences(evalCases[k]!, evalCases[k + 1]!);
  const steps = evalCases.reduce((a, c) => a + (c.incremental ? c.steps.length : 0), 0);
  console.log(`evaluation vectors: ${evalCases.length / 2} models, ${steps} steps; Mochi2D's incremental and full evaluations differ in ${differ}`);
}
if (SCENARIOS_ONLY) {
  console.log(`${scenarioCount} scenarios → ${out}`);
  process.exit(0);
}

// Mutations of the sample model (versions 1–5) and of random models.
for (const version of [1, 2, 3, 4, 5]) {
  const data = readMoc(sampleModel(version)).data;
  validationFiles.push({ name: `sample-v${version}`, bytes: sampleModel(version) });
  mutations(data, version, MUTATIONS, 11 + version).forEach((b, k) => validationFiles.push({ name: `sample-v${version}-m${k}`, bytes: b }));
}
for (let i = 0; i < Math.min(MODELS, 12); i++) {
  const version = 1 + (i % 5);
  try {
    const bytes = randomModel(version, 5000 + i).synth.build();
    const data = readMoc(bytes).data;
    mutations(data, version, Math.floor(MUTATIONS / 4), 77 + i).forEach((b, k) => validationFiles.push({ name: `rand${i}-v${version}-m${k}`, bytes: b }));
  } catch {
    /* skip */
  }
}
// The 61 validation crafts of the conformance plan (P8), as
// the same byte edits applied to synthetic version-5 files instead of
// DeepSeek-chan's (RawMoc is the reference's byte-level editor, ported).
class RawMoc {
  readonly dv: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  slot(s: number): number {
    return this.dv.getUint32(64 + 4 * s, true);
  }
  setSlot(s: number, v: number): void {
    this.dv.setUint32(64 + 4 * s, v, true);
  }
  count(k: number): number {
    return this.dv.getInt32(this.slot(0) + 4 * k, true);
  }
  setCount(k: number, v: number): void {
    this.dv.setInt32(this.slot(0) + 4 * k, v, true);
  }
  private spec(s: number) {
    const fs = FIELDS.find((x) => x.slot === s);
    if (!fs) throw new Error(`no field in slot ${s}`);
    return fs;
  }
  get(s: number, i: number): number {
    const fs = this.spec(s);
    const o = this.slot(s) + i * ELEMENT_SIZE[fs.type];
    if (fs.type === "i32") return this.dv.getInt32(o, true);
    if (fs.type === "f32") return this.dv.getFloat32(o, true);
    if (fs.type === "u16") return this.dv.getUint16(o, true);
    if (fs.type === "u8") return this.dv.getUint8(o);
    throw new Error(`slot ${s} holds ${fs.type}`);
  }
  set(s: number, i: number, v: number): void {
    const fs = this.spec(s);
    const o = this.slot(s) + i * ELEMENT_SIZE[fs.type];
    if (fs.type === "i32") return this.dv.setInt32(o, v, true);
    if (fs.type === "f32") return this.dv.setFloat32(o, v, true);
    if (fs.type === "u16") return this.dv.setUint16(o, v, true);
    if (fs.type === "u8") return this.dv.setUint8(o, v);
    throw new Error(`slot ${s} holds ${fs.type}`);
  }
}
const craftBases: { name: string; bytes: Uint8Array }[] = [{ name: "sample5", bytes: sampleModel(5) }];
for (let i = 0, found = 0; i < 400 && found < 3; i++) {
  try {
    const bytes = randomModel(5, 9000 + i).synth.build();
    const d = readMoc(bytes).data;
    if (d.deformers.ids.length >= 2 && d.parts.ids.length >= 2 && d.artMeshes.ids.length >= 2 && d.glues.ids.length >= 1) {
      craftBases.push({ name: `rand5-${i}`, bytes });
      found++;
    }
  } catch {
    /* skip */
  }
}
const craftSummary: { case: string; base: string; required: string; reference: string }[] = [];
for (const base of craftBases)
  for (const c of VALIDATION_CASES) {
    let bytes: Uint8Array;
    try {
      const m = new RawMoc(Uint8Array.from(base.bytes));
      bytes = (c.edit(m as never) as Uint8Array | undefined) ?? m.bytes;
    } catch {
      continue;
    }
    validationFiles.push({ name: `p8-${base.name}-${c.name}`, bytes });
    craftSummary.push({
      case: c.name,
      base: base.name,
      required: c.required,
      reference: validateMoc(bytes, { level: "strict" }).valid ? "accept" : "reject",
    });
  }
writeFileSync(join(out, "validate", "p8-summary.json"), JSON.stringify(craftSummary, null, 1));

// Broken bytes.
const big = new Synth(4);
big.part({ id: "Root" });
big.mesh({ id: "M", keyforms: [{ positions: [0, 0, 1, 0, 0, 1], drawOrder: 500 }] });
validationFiles.push({ name: "big-endian", bytes: big.build({ bigEndian: true }) });
validationFiles.push({ name: "empty", bytes: new Uint8Array(0) });
validationFiles.push({ name: "zeros64", bytes: new Uint8Array(64) });
validationFiles.push({ name: "ff4096", bytes: new Uint8Array(4096).fill(0xff) });
const s4 = sampleModel(4);
validationFiles.push({ name: "truncated", bytes: s4.slice(0, s4.length - 100) });
validationFiles.push({ name: "odd-length", bytes: Uint8Array.from([...s4, 0, 0, 0]) });
const v7 = s4.slice();
v7[4] = 7;
validationFiles.push({ name: "version7", bytes: v7 });
const endian = s4.slice();
endian[5] = 1;
validationFiles.push({ name: "endianness-byte", bytes: endian });
const magic = s4.slice();
magic[0] = 0x6d;
validationFiles.push({ name: "magic", bytes: magic });

const expected: unknown[] = [];
for (const { name, bytes } of validationFiles) {
  writeFileSync(join(out, "validate", `${name}.moc3`), bytes);
  const w = written(bytes);
  if (w.bytes) writeFileSync(join(out, "validate", `${name}.written.moc3`), w.bytes);
  expected.push({
    file: `${name}.moc3`,
    official: verdict(bytes, "official"),
    strict: verdict(bytes, "strict"),
    loader: loads(bytes),
    write: w.bytes ? `${name}.written.moc3` : null,
    writeError: w.error ?? null,
  });
}
writeFileSync(join(out, "validate", "expected.json"), JSON.stringify(expected));
console.log(`${scenarioCount} scenarios, ${validationFiles.length} validation files → ${out}`);

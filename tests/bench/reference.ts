/**
 * The workloads of bench.cpp on Mochi2D itself (the reference's
 * ModelInstance, incremental and full, with its default kernels), for
 * comparison with Mochi2D Native on the same model.
 *
 * usage: node reference.mjs <model.moc3> [frames]
 */
import { readFileSync } from "node:fs";
import { loadMoc } from "../../reference/mochi2d-0.21.0/src/core/moc/model.js";
import { ModelInstance } from "../../reference/mochi2d-0.21.0/src/core/eval/instance.js";

const path = process.argv[2]!;
const frames = Math.max(1, Number(process.argv[3] ?? 300));
const model = loadMoc(readFileSync(path));
const p = model.parameters;
const P = p.ids.length;
const isBound = new Uint8Array(P);
for (const i of model.bindings.parameter) isBound[i] = 1;
const bs = model.blendShapes;
for (const lists of [bs.warp, bs.mesh, bs.rotation, bs.part, bs.glue])
  for (const list of lists) for (const b of list) isBound[b.parameter] = 1;
const bound = [...isBound.keys()].filter((i) => isBound[i]);
const idle = Array.from({ length: Math.min(16, bound.length) }, (_, k) => bound[Math.floor((k * bound.length) / 16)]!);
const all = [...Array(P).keys()];
const workloads: [string, number[], boolean][] = [
  ["still", [], false],
  ["one", bound, true],
  ["idle", idle, false],
  ["all", all, false],
];
const probe = new ModelInstance(model);
console.log(`Mochi2D 0.14.0 (${probe.backend} kernels), Node ${process.version}`);
console.log(`${"frame".padEnd(6)} ${"full ms".padStart(10)} ${"incr. ms".padStart(10)}`);
for (const [name, params, oneAtATime] of workloads) {
  const full = new ModelInstance(model, { incremental: false });
  const incremental = new ModelInstance(model);
  let fullMs = 0;
  let incrementalMs = 0;
  for (let f = 0; f < frames; f++) {
    const move = (i: number) => {
      const u = 0.5 + 0.5 * Math.sin(0.05 * f + 0.7 * i);
      const v = p.min[i]! + (p.max[i]! - p.min[i]!) * u;
      full.setParameter(i, v);
      incremental.setParameter(i, v);
    };
    if (oneAtATime) {
      if (params.length) move(params[f % params.length]!);
    } else for (const i of params) move(i);
    let t = performance.now();
    full.evaluate();
    fullMs += performance.now() - t;
    t = performance.now();
    incremental.evaluate();
    incrementalMs += performance.now() - t;
  }
  console.log(`${name.padEnd(6)} ${(fullMs / frames).toFixed(3).padStart(10)} ${(incrementalMs / frames).toFixed(3).padStart(10)}`);
}

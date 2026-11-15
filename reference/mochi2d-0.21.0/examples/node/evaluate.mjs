#!/usr/bin/env node
// Evaluates a model headlessly: loads it from disk, plays a motion with
// physics for a few seconds at 60 frames per second, and prints what moved.
//
//   npm run build:lib
//   node examples/node/evaluate.mjs [model3.json | folder | zip] [motion3.json] [--seconds N] [--out result.json]
//
// In your own project: import { loadModelFromDisk } from "mochi2d/node".
import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadModelFromDisk, snapshotInstance, vertexBounds } from "../../dist/lib/node.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { seconds: { type: "string", default: "3" }, out: { type: "string" } },
});
// By default DeepSeek-chan, from assets/models/DeepSeek/ (see the README for where to get it).
const DEFAULT = ["assets/models/DeepSeek/大肥鱼.model3.json", "DeepSeek/大肥鱼.model3.json"];
const path = positionals[0] ?? DEFAULT.find((p) => existsSync(p));
if (!path) {
  console.error(
    "Give a model (a *.model3.json, a folder or a zip), or put DeepSeek-chan in " +
      "assets/models/DeepSeek/ (see the README).",
  );
  process.exit(1);
}
const motion = positionals[1] ?? (positionals[0] ? undefined : "Animation/脱捕.motion3.json");

const model = await loadModelFromDisk(path, {
  // A fixed random sequence makes eye blinks (and idle motion choices) repeatable.
  animation: { random: mulberry32(1) },
});
console.log(
  `${model.settingsPath}: ${model.parameters.length} parameters, ${model.model.meshes.ids.length} drawables, ` +
    `physics ${model.effectAvailable("physics") ? "on" : "none"}`,
);
if (motion)
  console.log(`motion ${motion}: ${(await model.startMotionFile(motion)) ? "started" : "refused"}`);

const watch = ["AngleX", "ParamAngleX", "ParamAngleY", "ParamEyeLOpen", "ParamBodyAngleX"].filter(
  (id) => model.model.parameters.ids.includes(id),
);
const frames = Math.round(Number(values.seconds) * 60);
const events = [];
for (let i = 1; i <= frames; i++) {
  const r = model.update(1 / 60);
  if (r) events.push(...r.events);
  if (i % 60 === 0)
    console.log(
      `t=${(i / 60).toFixed(1)}s  ` +
        watch.map((id) => `${id}=${model.getParameter(id).toFixed(2)}`).join("  "),
    );
}
if (events.length) console.log(`motion events: ${events.join(", ")}`);

// Where the model is: the union of the visible drawables' boxes (model units).
const inst = model.instance;
const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
inst.drawableVertices.forEach((v, d) => {
  if (!inst.drawableVisible[d]) return;
  const b = vertexBounds(v);
  box.minX = Math.min(box.minX, b.minX);
  box.minY = Math.min(box.minY, b.minY);
  box.maxX = Math.max(box.maxX, b.maxX);
  box.maxY = Math.max(box.maxY, b.maxY);
});
console.log(
  `visible bounds: x ${box.minX.toFixed(3)}…${box.maxX.toFixed(3)}, y ${box.minY.toFixed(3)}…${box.maxY.toFixed(3)}`,
);

if (values.out) {
  writeFileSync(values.out, JSON.stringify(snapshotInstance(inst)));
  console.log(`wrote the evaluated drawables to ${values.out}`);
}

/** A small seeded random generator with values in [0, 1). */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

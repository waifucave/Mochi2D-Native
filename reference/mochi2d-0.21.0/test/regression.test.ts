/**
 * Bit-identity guard for the evaluator: the formatted results of the
 * DeepSeek-chan scenarios and 50 seeded random poses must hash exactly as
 * recorded in test/golden/deepseek-results.json (`npm run golden`). Each case
 * is evaluated as the conformance tool does: a fresh instance (with its
 * creation-time evaluation), the request, one evaluation.
 *
 * Since C4, results depend on history: inactive drawables keep
 * their arrays and glue acts on them. So the incremental evaluator is checked
 * against a reference instance that re-evaluates everything on every call
 * (`incremental: false`), both going through the same long shuffled history.
 * Both kernel implementations (WebAssembly and the JavaScript fallback) are
 * checked.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import { wasmKernelsAvailable } from "../src/core/eval/kernels.js";
import {
  applyRequest,
  formatResultJson,
  snapshotInstance,
  type EvaluationRequest,
} from "../src/core/model/snapshot.js";
import { drivingParameters, randomPoses, seededRandom } from "../src/core/testing/poses.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
const golden = JSON.parse(
  readFileSync(join(root, "test", "golden", "deepseek-results.json"), "utf8"),
) as {
  seed: number;
  randomPoses: number;
  hashes: Record<string, string>;
};

let model: MocModel;
const cases: { id: string; request: EvaluationRequest }[] = [];

beforeAll(() => {
  model = loadMoc(readFileSync(join(DEEPSEEK, "大肥鱼.moc3")));
  const dir = join(root, "test", "scenarios", "deepseek");
  for (const f of readdirSync(dir).sort()) {
    const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
      id: string;
      parameters?: Record<string, number>;
      partOpacities?: Record<string, number>;
    };
    cases.push({
      id: s.id,
      request: { parameters: s.parameters ?? {}, partOpacities: s.partOpacities ?? {} },
    });
  }
  randomPoses(model, golden.randomPoses, golden.seed).forEach((request, i) =>
    cases.push({ id: `random-${String(i).padStart(2, "0")}`, request }),
  );
});

const hashOf = (inst: ModelInstance, warnings: string[]) =>
  createHash("sha256")
    .update(formatResultJson({ ...snapshotInstance(inst), warnings }))
    .digest("hex");

const backends = ["wasm", "js"] as const;

it("has WebAssembly kernels in this environment", () => {
  expect(wasmKernelsAvailable()).toBe(true);
});

describe.each(backends)("evaluator bit-identity, %s kernels", (backend) => {
  const create = (incremental = true) => {
    const inst = new ModelInstance(model, { kernels: backend, incremental });
    expect(inst.backend).toBe(backend);
    return inst;
  };

  it("covers all golden cases", () => {
    expect(cases.map((c) => c.id).sort()).toEqual(Object.keys(golden.hashes).sort());
  });

  it("reproduces every golden result (fresh instance per case)", () => {
    const mismatches: string[] = [];
    for (const c of cases) {
      const inst = create();
      const warnings = applyRequest(inst, c.request);
      inst.evaluate();
      if (hashOf(inst, warnings) !== golden.hashes[c.id]) mismatches.push(c.id);
    }
    expect(mismatches).toEqual([]);
  }, 120000);

  it("matches the full re-evaluation reference through a long shuffled history", () => {
    const rnd = seededRandom(7);
    const order = cases.map((c) => ({ c, k: rnd() })).sort((a, b) => a.k - b.k);
    const live = create(true);
    const reference = create(false);
    const mismatches: string[] = [];
    for (const { c } of order) {
      for (const inst of [live, reference]) {
        applyRequest(inst, c.request);
        inst.evaluate();
      }
      if (
        formatResultJson(snapshotInstance(live)) !== formatResultJson(snapshotInstance(reference))
      )
        mismatches.push(c.id);
      // Evaluating again without changes: glue on inactive meshes keeps acting.
      live.evaluate();
      reference.evaluate();
      if (
        formatResultJson(snapshotInstance(live)) !== formatResultJson(snapshotInstance(reference))
      )
        mismatches.push(`${c.id} (again)`);
    }
    expect(mismatches).toEqual([]);
  }, 300000);

  it("matches the reference after each small change (incremental evaluation)", () => {
    const rnd = seededRandom(backend === "wasm" ? 11 : 12);
    const params = drivingParameters(model);
    const p = model.parameters;
    const live = create(true);
    const reference = create(false);
    const mismatches: string[] = [];
    for (let step = 0; step < 60; step++) {
      // One parameter (sometimes two, sometimes a part opacity), often back to a key or default.
      const changes = rnd() < 0.2 ? 2 : 1;
      for (let c = 0; c < changes; c++) {
        const i = params[Math.floor(rnd() * params.length)]!;
        const keys = p.keyLists[i]!;
        const r = rnd();
        const v =
          r < 0.25 && keys.length
            ? keys[Math.floor(rnd() * keys.length)]!
            : r < 0.35
              ? p.defaults[i]!
              : p.min[i]! - 0.1 + rnd() * (p.max[i]! - p.min[i]! + 0.2);
        live.setParameter(i, v);
        reference.setParameter(i, v);
      }
      if (rnd() < 0.15) {
        const part = Math.floor(rnd() * model.parts.ids.length);
        const o = rnd();
        live.setPartOpacity(part, o);
        reference.setPartOpacity(part, o);
      }
      live.evaluate();
      reference.evaluate();
      if (
        formatResultJson(snapshotInstance(live)) !== formatResultJson(snapshotInstance(reference))
      )
        mismatches.push(`step ${step}`);
    }
    expect(mismatches).toEqual([]);
  }, 120000);
});

/**
 * Files whose keyform positions hold NaN, ±∞ or huge values load, as in the
 * official runtime, with a strict warning (`position-value`). The evaluator
 * must neither crash nor hang on them, with either kernel: through warps
 * (inside and outside the grid), rotations, glue, masks and interpolation
 * (∞ − ∞ is NaN). The renderer side is in render-synthetic.test.ts.
 */
import { describe, expect, it } from "vitest";
import { loadMoc } from "../src/core/moc/model.js";
import { ModelInstance, type InstanceOptions } from "../src/core/eval/instance.js";
import { wasmKernelsAvailable } from "../src/core/eval/kernels.js";
import { validateMoc } from "../src/core/moc/validate.js";
import { Synth } from "./support/synth.js";
import { nonFiniteModel } from "./support/non-finite-model.js";

const MODES: InstanceOptions[] = [
  { kernels: "js" },
  { kernels: "js", incremental: false },
  ...(wasmKernelsAvailable()
    ? ([{ kernels: "wasm" }, { kernels: "wasm", incremental: false }] as InstanceOptions[])
    : []),
];

const BAD = [NaN, Infinity, -Infinity, 3e38, -3e38];

describe("non-finite keyform positions", () => {
  it("load with a strict warning only", () => {
    const bytes = nonFiniteModel().build();
    expect(validateMoc(bytes, { level: "official" }).diagnostics).toEqual([]);
    const strict = validateMoc(bytes);
    expect(strict.valid).toBe(true);
    expect(strict.diagnostics.map((x) => x.code)).toContain("position-value");
    expect(() => loadMoc(bytes)).not.toThrow();
  });

  for (const version of [3, 5])
    it(`evaluate without crashing or hanging (v${version}, every kernel mode)`, () => {
      const model = loadMoc(nonFiniteModel(version).build());
      for (const mode of MODES) {
        const inst = new ModelInstance(model, mode);
        for (const value of [0, 0.25, 0.5, 1, 0.5]) {
          inst.setParameter(0, value);
          inst.evaluate();
        }
        // The finite mesh outside every deformer keeps finite positions…
        const e = inst.drawableVertices[model.meshes.ids.indexOf("E")]!;
        // …except where glue pulls in a non-finite vertex of D.
        expect(Number.isFinite(e[2]!) && Number.isFinite(e[3]!)).toBe(true);
        // Bad values propagate as values, not as exceptions.
        const a = inst.drawableVertices[model.meshes.ids.indexOf("A")]!;
        expect(a.some((x) => !Number.isFinite(x))).toBe(true);
        expect(inst.drawableRenderOrder.length).toBe(model.meshes.ids.length);
      }
    });

  it("every bad value in every position of a warp grid, inside and outside", () => {
    for (const bad of BAD)
      for (let at = 0; at < 8; at++) {
        const s = new Synth(5);
        s.part({ id: "P" });
        const points = [0, 0, 1, 0, 0, 1, 1, 1];
        points[at] = bad;
        const w = s.warp({ id: "W", rows: 1, cols: 1, keyforms: [{ points }] });
        s.mesh({
          id: "M",
          deformer: w,
          keyforms: [{ positions: [0.5, 0.5, -2, 0.5, 0.5, 7, NaN, bad] }],
          triangles: [0, 1, 2],
        });
        const model = loadMoc(s.build());
        for (const mode of MODES) new ModelInstance(model, mode).evaluate();
      }
  });
});

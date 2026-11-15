/**
 * `mocModelFromData(data, version)`: a model straight from MocData, which
 * must be `loadMoc(writeMoc(data, { version }))`, the same model and the same
 * errors: synthetic files of every writable version, DeepSeek-chan, every
 * validation case of the catalog that readMoc reads, and version 6 data
 * (which writeMoc cannot write yet).
 */
import { describe, expect, it } from "vitest";
import { MocWriteError, WRITABLE_VERSIONS, readMoc, writeMoc } from "../src/core/moc/io.js";
import { mocModelFromData } from "../src/core/moc/from-data.js";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { MocFormatError } from "../src/core/moc/read.js";
import type { MocData, MocVersion } from "../src/core/moc/data.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import { sampleModel } from "./support/sample-model.js";
import { nonFiniteModel } from "./support/non-finite-model.js";
import {
  VALIDATION_CASES,
  craftValidation,
  deepseekMocBytes,
} from "../tools/lib/catalog/moc-crafts.js";
import { HAVE_DEEPSEEK } from "./support/deepseek.js";

/** What a load gives: the model, or the error's class, code and message. */
function outcome(load: () => MocModel): { model?: MocModel; error?: string } {
  try {
    return { model: load() };
  } catch (e) {
    if (e instanceof MocWriteError)
      return { error: `MocWriteError ${JSON.stringify(e.diagnostics)}` };
    if (e instanceof MocFormatError) return { error: `MocFormatError ${e.code} ${e.message}` };
    throw e;
  }
}

function expectSame(data: MocData, version: MocVersion): MocModel | undefined {
  const direct = outcome(() => mocModelFromData(data, version));
  const written = outcome(() => loadMoc(writeMoc(data, { version })));
  expect(direct.error).toBe(written.error);
  expect(direct.model).toEqual(written.model);
  return direct.model;
}

/** Drawable vertices after evaluating each pose, as one array. */
function vertices(model: MocModel, poses: number[][]): number[] {
  const inst = new ModelInstance(model);
  const out: number[] = [];
  for (const pose of poses) {
    pose.forEach((v, i) => i < model.parameters.ids.length && inst.setParameter(i, v));
    inst.evaluate();
    for (const v of inst.drawableVertices) out.push(...v);
  }
  return out;
}

describe("mocModelFromData", () => {
  it.each(WRITABLE_VERSIONS)(
    "is loadMoc(writeMoc(data)) for a synthetic version-%i file",
    (version) => {
      const { data } = readMoc(sampleModel(version));
      const model = expectSame(data, version)!;
      expect(model.version).toBe(version);
      // And it evaluates bit for bit like the written file.
      const poses = [[], [17, 0.3], [-30, 1, 0.6]];
      expect(vertices(model, poses)).toEqual(vertices(loadMoc(writeMoc(data, { version })), poses));
    },
  );

  it("refuses canvas values that are not float32, as writeMoc does", () => {
    const { data } = readMoc(sampleModel(5));
    const odd = { ...data, canvas: { ...data.canvas, pixelsPerUnit: 0.1 } };
    expect(() => mocModelFromData(odd, 5)).toThrow(/not a float32 value/);
    expectSame(odd, 5);
  });

  it("refuses what writeMoc refuses, and fails where loadMoc fails", () => {
    const { data } = readMoc(sampleModel(5));
    // Shape: a version-5 array in version-3 data.
    expect(() => mocModelFromData(data, 3)).toThrow(MocWriteError);
    expectSame(data, 3);
    // Non-finite positions load (with a strict warning only).
    const bad = readMoc(nonFiniteModel(5).build()).data;
    expect(expectSame(bad, 5)).toBeDefined();
  });

  it("takes version 6 data, which writeMoc cannot write yet", () => {
    const bytes = sampleModel(6);
    const { data, version } = readMoc(bytes);
    expect(version).toBe(6);
    expect(() => writeMoc(data, { version: 6 })).toThrow(MocWriteError);
    expect(mocModelFromData(data, 6)).toEqual(loadMoc(bytes));
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "is loadMoc of DeepSeek-chan's file, and of every validation case",
    () => {
      const bytes = deepseekMocBytes();
      const { data, version } = readMoc(bytes);
      expect(mocModelFromData(data, version)).toEqual(loadMoc(bytes));
      let compared = 0;
      for (const c of VALIDATION_CASES) {
        let read: ReturnType<typeof readMoc>;
        try {
          read = readMoc(craftValidation(c.name));
        } catch {
          continue; // not readable as data
        }
        if (!WRITABLE_VERSIONS.includes(read.version)) continue;
        expectSame(read.data, read.version);
        compared++;
      }
      expect(compared).toBeGreaterThan(30);
    },
    // About 30 s on its own; more beside other test files.
    180000,
  );
});

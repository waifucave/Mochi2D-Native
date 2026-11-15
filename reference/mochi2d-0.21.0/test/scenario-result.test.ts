/**
 * Result generation as a library call (src/conformance/results.ts): the
 * results of `scenarioResult` equal those of the conformance CLI's path,
 * a `.moc3` written by `writeMoc` gives the same results as the file it was
 * read from, and failures are recorded in the result as the contract says.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scenarioResult, resultModelFromSource } from "../src/conformance/results.js";
import { runStatic } from "../src/conformance/run.js";
import { parseScenario } from "../src/conformance/scenario.js";
import { parseAnimScenario, runAnimFile } from "../src/conformance/formats.js";
import { ModelCache } from "../tools/lib/model-cache.js";
import { searchResolver } from "../tools/lib/conformance-runner.js";
import { formatResultJson } from "../src/core/model/snapshot.js";
import { readMoc, writeMoc } from "../src/core/moc/io.js";
import { sourceFromFolder } from "../src/platform/node-sources.js";
import { sampleModel } from "./support/sample-model.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
const PRODUCER = "mochi2d@test";

const staticScenario = (parameters: Record<string, number>) => ({
  format: "mochi2d-scenario/0",
  id: "s",
  parameters,
});

describe("scenarioResult", () => {
  it("evaluates a static scenario on .moc3 bytes, and on the bytes writeMoc writes from them", () => {
    for (const version of [1, 2, 3, 4, 5] as const) {
      const original = sampleModel(version);
      const written = writeMoc(readMoc(original).data, { version });
      const poses: Record<string, number>[] = [{}, { ParamAngle: 20, ParamOpen: 0.25 }];
      for (const parameters of poses) {
        const a = scenarioResult({ moc: original }, staticScenario(parameters), {
          producer: PRODUCER,
        });
        const b = scenarioResult({ moc: written }, staticScenario(parameters), {
          producer: PRODUCER,
        });
        expect(a.error).toBeNull();
        expect(a).toMatchObject({ format: "mochi2d-result/0", scenario: "s", producer: PRODUCER });
        expect(formatResultJson(b)).toBe(formatResultJson(a));
      }
    }
  });

  it("records failures in the result", () => {
    const moc = sampleModel(4);
    expect(scenarioResult({ moc }, { format: "nope/1", id: "x" }).error).toMatchObject({
      kind: "InvalidScenario",
      message: 'unknown format "nope/1"',
    });
    expect(scenarioResult({ moc }, { ...staticScenario({}), id: "bad id" }).error?.kind).toBe(
      "InvalidScenario",
    );
    expect(
      scenarioResult({ moc }, { ...staticScenario({}), parameters: { ParamAngle: "x" } }).error
        ?.kind,
    ).toBe("InvalidScenario");
    const broken = moc.slice();
    broken[0] = 0;
    expect(scenarioResult({ moc: broken }, staticScenario({})).error).toMatchObject({
      kind: "ModelLoadError",
      message: expect.stringMatching(/bad magic/),
    });
    // Unknown parameters are warnings, as in the contract.
    const r = scenarioResult({ moc }, staticScenario({ Nope: 1 }));
    expect([r.error, r.warnings]).toEqual([null, ["unknown parameter Nope"]]);
    // The default producer names the version.
    expect(r.producer).toMatch(/^mochi2d@/);
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "gives the conformance CLI's results for DeepSeek-chan",
    async () => {
      const models = new ModelCache(searchResolver(root), 1);
      const model = await resultModelFromSource(
        await sourceFromFolder(DEEPSEEK),
        "大肥鱼.model3.json",
      );
      for (const file of ["ds-default.json", "ds-blendshapes.json"]) {
        const json = JSON.parse(
          readFileSync(join(root, "test", "scenarios", "deepseek", file), "utf8"),
        );
        const cli = runStatic(parseScenario(json), models, PRODUCER);
        const lib = scenarioResult(model, json, { producer: PRODUCER });
        expect(cli.error).toBeNull();
        expect(formatResultJson(lib)).toBe(formatResultJson(cli));
      }
      const anim = {
        format: "mochi2d-anim-scenario/0",
        id: "anim",
        model: "DeepSeek/大肥鱼.model3.json",
        dt: 1 / 30,
        frames: 20,
        effects: {
          idle: false,
          blink: true,
          expressions: true,
          look: true,
          breath: true,
          physics: true,
          lipsync: false,
          pose: true,
        },
        random: Array.from({ length: 50 }, (_, i) => ((i * 37) % 100) / 100),
        commands: [
          { frame: 1, do: "look", x: 1, y: 0.5 },
          { frame: 3, do: "motion", file: "Animation/脱捕.motion3.json", priority: 3 },
          { frame: 5, do: "expression", file: "Exp3/脸红.exp3.json" },
        ],
        record: {
          parameters: ["ParamAngleX", "ParamMouthOpenY", "ParamEyeLOpen"],
          parts: [],
          every: 4,
        },
      };
      const cli = runAnimFile(parseAnimScenario(anim), models, PRODUCER);
      const lib = scenarioResult(model, anim, { producer: PRODUCER });
      expect(cli.error).toBeNull();
      expect(formatResultJson(lib, "  ", "double")).toBe(formatResultJson(cli, "  ", "double"));
      // Written back by writeMoc, the model gives the same static result.
      const json = JSON.parse(
        readFileSync(join(root, "test", "scenarios", "deepseek", "ds-blendshapes.json"), "utf8"),
      );
      const rewritten = writeMoc(readMoc(model.moc as Uint8Array).data, { version: 5 });
      expect(
        formatResultJson(
          scenarioResult({ ...model, moc: rewritten }, json, { producer: PRODUCER }),
        ),
      ).toBe(formatResultJson(scenarioResult(model, json, { producer: PRODUCER })));
    },
    120_000,
  );
});

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownFormat, parseScenario, loadScenarios } from "../tools/lib/scenario.js";
import { currentFormatName } from "../src/core/format-names.js";
import { runConformance, runStatic, searchResolver } from "../tools/lib/conformance-runner.js";
import { ModelCache } from "../tools/lib/model-cache.js";
import { craftSettings } from "../tools/lib/catalog/write.js";
import { craftDeepseek, deepseekSections } from "./support/crafted.js";
import {
  DEEPSEEK_HOWTO,
  deepseekDir,
  findDeepseekDir,
  listModelFiles,
  modelSearchDirs,
  resolveModelFile,
} from "../tools/lib/model-roots.js";
import { parseArgs } from "../tools/lib/cli.js";
import { HAVE_DEEPSEEK } from "./support/deepseek.js";

const valid = {
  format: "mochi2d-scenario/0",
  id: "a-1",
  model: "M/M.model3.json",
  parameters: { P: 1 },
};

describe("scenario parsing", () => {
  it("accepts valid scenarios and fills defaults", () => {
    const s = parseScenario(valid);
    expect(s.partOpacities).toEqual({});
    expect(s.render).toBeUndefined();
  });
  it("rejects bad input with clear messages", () => {
    expect(() => parseScenario({ ...valid, format: "x" })).toThrow(/format/);
    expect(() => parseScenario({ ...valid, id: "../evil" })).toThrow(/id/);
    expect(() => parseScenario({ ...valid, parameters: { P: "1" } })).toThrow(/parameters\.P/);
    expect(() => parseScenario({ ...valid, render: { width: 0, height: 5 } })).toThrow(/render/);
    const { model: _m, ...noModel } = valid;
    expect(() => parseScenario(noModel)).toThrow(/model/);
  });
});

describe("format names from before the rename", () => {
  it("reads lively2d-* names as the current mochi2d-* names", () => {
    expect(currentFormatName("lively2d-result/0")).toBe("mochi2d-result/0");
    expect(currentFormatName("mochi2d-result/0")).toBe("mochi2d-result/0");
    expect(currentFormatName("other-result/0")).toBe("other-result/0");
    expect(currentFormatName(3)).toBe(3);
    expect(knownFormat("lively2d-scenario/0")).toBe("mochi2d-scenario/0");
    expect(knownFormat("lively2d-anim-scenario/0.2")).toBe("mochi2d-anim-scenario/0");
    expect(knownFormat("lively2d-scenario/1")).toBeNull();
    const s = parseScenario({ ...valid, format: "lively2d-scenario/0" });
    expect(s.format).toBe("mochi2d-scenario/0");
  });
});

describe("cli args", () => {
  it("parses positionals and options", () => {
    expect(parseArgs(["a", "--out", "o", "b", "--x=1", "--json"], ["json"])).toEqual({
      positional: ["a", "b"],
      options: { out: "o", x: "1", json: true },
    });
    expect(() => parseArgs(["--out"])).toThrow(/needs a value/);
  });
});

describe("runConformance", () => {
  it("writes one result per scenario, records errors and keeps going", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mochi2d-"));
    const scen = join(dir, "scenarios");
    const models = join(dir, "models");
    await mkdir(join(scen, "nested"), { recursive: true });
    await mkdir(join(models, "M"), { recursive: true });
    await writeFile(join(models, "M", "M.model3.json"), "{}");
    await writeFile(join(scen, "a.json"), JSON.stringify(valid));
    await writeFile(
      join(scen, "nested", "b.json"),
      JSON.stringify([
        { ...valid, id: "b" },
        { ...valid, id: "c", model: "Missing/x.model3.json" },
      ]),
    );
    await writeFile(join(scen, "broken.json"), "{ nope");
    const out = join(dir, "out");
    const summary = await runConformance([scen], out, searchResolver(dir, models), "mochi2d@test");
    expect(summary.total).toBe(4);
    expect(summary.failed).toBe(4); // the fixture settings file has no FileReferences
    const a = JSON.parse(await readFile(join(out, "a-1.result.json"), "utf8"));
    expect(a).toMatchObject({
      format: "mochi2d-result/0",
      scenario: "a-1",
      producer: "mochi2d@test",
      drawables: [],
    });
    expect(a.error.kind).toBe("ModelLoadError");
    const c = JSON.parse(await readFile(join(out, "c.result.json"), "utf8"));
    expect(c.error.kind).toBe("ModelLoadError");
    expect(c.error.message).toMatch(/model not found/);
    const broken = JSON.parse(await readFile(join(out, "broken.result.json"), "utf8"));
    expect(broken.error.kind).toBe("InvalidScenario");
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "loads files with out-of-range draw orders with a warning, or rejects them in strict mode (C12)",
    () => {
      const sec = deepseekSections();
      const p18 = (sec.fields.get("part.id" as never) as string[]).indexOf("Part18");
      const first = (sec.fields.get("part.firstKeyform" as never) as Int32Array)[p18]!;
      const moc = craftDeepseek((f) => {
        const o = f["partKeyform.drawOrder"] as number[];
        [300, 500, 700].forEach((v, k) => (o[first + k] = v));
      });
      const files = new Map<string, Uint8Array>([
        ["/virtual/c/m.model3.json", new TextEncoder().encode(craftSettings())],
        ["/virtual/c/m.moc3", moc],
      ]);
      const resolver = {
        resolve: (rel: string) => (files.has(`/virtual/${rel}`) ? `/virtual/${rel}` : undefined),
        candidates: (rel: string) => [`/virtual/${rel}`],
      };
      const io = {
        read: (p: string) => files.get(p),
        version: (p: string) => (files.has(p) ? "1" : undefined),
      };
      const sc = parseScenario({
        format: "mochi2d-scenario/0",
        id: "c12",
        model: "c/m.model3.json",
        parameters: { HipAngleX: 0.5 },
      });
      const loaded = runStatic(sc, new ModelCache(resolver, 1, io), "test");
      expect(loaded.error).toBeNull();
      expect(loaded.warnings).toEqual([
        "part Part18: keyform draw orders 300, 700 outside the range [499, 501] of draw-order group 1; drawn by the evaluated value",
      ]);
      const strict = runStatic(
        sc,
        new ModelCache(resolver, 1, io, { drawOrderRange: "reject" }),
        "test",
      );
      expect(strict.error?.kind).toBe("ModelLoadError");
      expect(strict.error?.message).toMatch(
        /Part18: keyform draw order 300 is outside the range \[499, 501\]/,
      );
    },
  );

  it.skipIf(!HAVE_DEEPSEEK)(
    "dispatches on format, skips a byte-order mark and rejects unknown formats (4b)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "mochi2d-"));
      const scen = join(dir, "scenarios");
      await mkdir(scen, { recursive: true });
      const model = "DeepSeek/大肥鱼.model3.json";
      await writeFile(
        join(scen, "bom.json"),
        "\ufeff" + JSON.stringify({ format: "mochi2d-scenario/0", id: "bom", model, extra: 1 }),
      );
      await writeFile(
        join(scen, "seq.json"),
        JSON.stringify({
          format: "mochi2d-sequence/0",
          id: "seq",
          model,
          steps: [{ label: "a", parameters: { ParamAngleX: 30 } }, { label: "b" }],
        }),
      );
      await writeFile(
        join(scen, "anim.json"),
        JSON.stringify({
          format: "mochi2d-anim-scenario/0",
          id: "anim",
          model,
          dt: 1 / 60,
          frames: 5,
          effects: {
            idle: false,
            blink: false,
            expressions: false,
            look: true,
            breath: false,
            physics: false,
            lipsync: false,
            pose: false,
          },
          commands: [{ frame: 1, do: "look", x: 1, y: 0 }],
          record: { parameters: ["ParamAngleX", "NoSuchParameter"], parts: [], every: 2 },
        }),
      );
      await writeFile(
        join(scen, "bad-order.json"),
        JSON.stringify({
          format: "mochi2d-anim-scenario/0",
          id: "bad-order",
          model,
          dt: 0.1,
          frames: 3,
          commands: [
            { frame: 2, do: "stopMotions" },
            { frame: 1, do: "stopMotions" },
          ],
        }),
      );
      await writeFile(
        join(scen, "future.json"),
        JSON.stringify({ format: "mochi2d-scenario/1", id: "future", model }),
      );
      await writeFile(
        join(scen, "index.json"),
        JSON.stringify({ format: "mochi2d-catalog/0", scenarios: [] }),
      );
      const out = join(dir, "out");
      const root = join(__dirname, "..");
      const summary = await runConformance([scen], out, searchResolver(root), "mochi2d@test");
      expect(
        summary.results.map((r) => [r.id, r.kind, r.error?.split(":")[0] ?? null]).sort(),
      ).toEqual([
        ["anim", "animation", null],
        ["bad-order", "animation", "InvalidScenario"],
        ["bom", "static", null],
        ["future", "invalid", "InvalidScenario"],
        ["seq", "sequence", null],
      ]);
      const read = async (id: string) =>
        JSON.parse(await readFile(join(out, `${id}.result.json`), "utf8"));
      const seq = await read("seq");
      expect(seq.format).toBe("mochi2d-sequence-result/0");
      expect(seq.steps.map((x: { label: string }) => x.label)).toEqual(["create", "a", "b"]);
      const angle = (step: number) =>
        seq.steps[step].parameters.find((p: { id: string }) => p.id === "ParamAngleX").value;
      expect([angle(0), angle(1), angle(2)]).toEqual([0, 30, 30]); // values persist (4e)
      const anim = await read("anim");
      expect(anim.format).toBe("mochi2d-anim-result/0");
      expect(anim.frames.map((f: { frame: number }) => f.frame)).toEqual([0, 2, 4]);
      expect(anim.frames[0].parameters[1]).toBeNull();
      expect(anim.warnings.join()).toMatch(/unknown parameter NoSuchParameter/);
      expect(anim.frames[0].time).toBe(1 / 60);
      expect(anim.frames[2].parameters[0]).toBeGreaterThan(0);
      const bad = await read("bad-order");
      expect(bad.format).toBe("mochi2d-anim-result/0");
      expect(bad.error.message).toMatch(/non-decreasing/);
    },
  );

  it("loads scenario arrays and reports duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mochi2d-"));
    const f = join(dir, "s.json");
    await writeFile(f, JSON.stringify([valid, valid]));
    const loaded = await loadScenarios([f, join(dir, "missing.json")]);
    expect(loaded.map((l) => l.ok)).toEqual([true, false, false]);
  });

  it("resolves model paths against assets/models first, then the repository root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mochi2d-root-"));
    const models = join(root, "assets", "models");
    await mkdir(join(models, "Both"), { recursive: true });
    await mkdir(join(root, "Both"), { recursive: true });
    await mkdir(join(root, "Local"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "node_modules", "x"), { recursive: true });
    await writeFile(join(models, "Both", "B.model3.json"), "{}");
    await writeFile(join(root, "Both", "B.model3.json"), "{}");
    await writeFile(join(root, "Local", "大肥鱼.model3.json"), "{}");
    await writeFile(join(root, ".git", "config"), "");
    await writeFile(join(root, "node_modules", "x", "a.json"), "");
    const dirs = modelSearchDirs(root);
    expect(resolveModelFile(dirs, "Both/B.model3.json")).toBe(
      join(models, "Both", "B.model3.json"),
    );
    expect(resolveModelFile(dirs, "Local/大肥鱼.model3.json")).toBe(
      join(root, "Local", "大肥鱼.model3.json"),
    );
    expect(resolveModelFile(dirs, ".git/config")).toBeUndefined();
    expect(resolveModelFile(dirs, "node_modules/x/a.json")).toBeUndefined();
    expect(resolveModelFile(dirs, "../etc/passwd")).toBeUndefined();
    expect(resolveModelFile(dirs, "Nope/x.model3.json")).toBeUndefined();
    expect(listModelFiles(root)).toEqual(["Both/B.model3.json"]);
    // Links to nothing are left out instead of failing the listing.
    await symlink(join(root, "gone"), join(models, "Both", "dangling"));
    expect(listModelFiles(root)).toEqual(["Both/B.model3.json"]);
  });

  it("finds DeepSeek-chan in assets/models/DeepSeek/, else at the repository root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mochi2d-ds-"));
    expect(findDeepseekDir(root)).toBeNull();
    expect(() => deepseekDir(root)).toThrow(DEEPSEEK_HOWTO);
    expect(DEEPSEEK_HOWTO).toMatch(/assets\/models\/DeepSeek\/.*README/);
    await mkdir(join(root, "DeepSeek"), { recursive: true });
    await writeFile(join(root, "DeepSeek", "大肥鱼.model3.json"), "{}");
    expect(findDeepseekDir(root)).toBe(join(root, "DeepSeek"));
    const local = join(root, "assets", "models", "DeepSeek");
    await mkdir(local, { recursive: true });
    expect(findDeepseekDir(root)).toBe(join(root, "DeepSeek")); // no settings file there yet
    await writeFile(join(local, "大肥鱼.model3.json"), "{}");
    expect(findDeepseekDir(root)).toBe(local);
    expect(deepseekDir(root)).toBe(local);
  });
});

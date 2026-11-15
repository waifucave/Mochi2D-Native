/**
 * The judge (4h, 4l, 4m): the comparator vector of
 * 4h, the hit-test margin of 4l.4, the order of checks and the tolerances of
 * 4l on small hand-made results, and pairing and group reports on result
 * directories.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureImages } from "../tools/lib/image-compare.js";
import {
  decidable,
  judgeAnimation,
  judgeRender,
  judgeSequence,
  judgeStatic,
  judgeValidation,
} from "../tools/lib/judge.js";
import { judgeDirectories } from "../tools/lib/judge-run.js";
import { encodePng } from "../tools/lib/png.js";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("image comparison (4h)", () => {
  it("gives the published values on the comparator test vector", () => {
    const a = { width: 2, height: 1, data: [10, 20, 30, 255, 0, 0, 0, 0] };
    const b = { width: 2, height: 1, data: [12, 20, 30, 255, 0, 0, 0, 20] };
    const m = measureImages(a, b);
    expect(m.rms).toBeCloseTo(Math.sqrt(50.5), 12);
    expect(m.rms).toBeCloseTo(7.1063, 4);
    expect(m.f4).toBe(0.5);
    expect(m.f8).toBe(0.5);
    expect(m.n16).toBe(1);
    expect(m.maxD).toBe(20);
    expect(m.maxAt).toEqual([1, 0]);
  });
});

describe("hit-test margin (4l.4)", () => {
  const box = [0, 1, 0, 2];
  it("decides points inside the shrunk box or outside the grown box", () => {
    expect(decidable(box, 0.5, 1)).toBe(true); // a sure hit
    expect(decidable(box, 0.0005, 1)).toBe(false); // within μ of an edge
    expect(decidable(box, 1.0011, 1)).toBe(true); // a sure miss
    expect(decidable(box, 1, 2)).toBe(false); // a corner
    expect(decidable(null, 0, 0)).toBe(true); // unknown drawable: a decidable miss
  });
});

const staticResult = () => ({
  format: "mochi2d-result/0",
  scenario: "s",
  producer: "ref",
  error: null,
  canvas: { width: 10, height: 20, originX: 5, originY: 10, pixelsPerUnit: 10 },
  parameters: [{ id: "P", value: 0.6000000238418579 }],
  parts: [{ id: "Part", opacity: 1 }],
  drawables: [
    {
      id: "A",
      visible: true,
      opacity: 1,
      drawOrder: 500,
      renderOrder: 0,
      multiplyColor: [1, 1, 1, 1],
      screenColor: [0, 0, 0, 1],
      vertices: [0, 0, 1, 1],
    },
    {
      id: "B",
      visible: false,
      opacity: 0,
      drawOrder: 500,
      renderOrder: 1,
      multiplyColor: [1, 1, 1, 1],
      screenColor: [0, 0, 0, 1],
      vertices: [0.5, 0.5],
    },
  ],
  warnings: [],
});

describe("static and sequence rules (4l.1)", () => {
  it("passes identical results and results within the tolerances", () => {
    const ref = staticResult();
    expect(judgeStatic("s", "g", ref, clone(ref)).pass).toBe(true);
    const cand = clone(ref);
    cand.drawables[0]!.vertices[3] = 1 + 1.9e-5;
    cand.drawables[0]!.opacity = 1 - 9e-6;
    const v = judgeStatic("s", "g", ref, cand);
    expect(v.pass).toBe(true);
    expect(v.advisories.some((a) => /vertex difference .* above 1e-5/.test(a))).toBe(true);
  });

  it("checks vertices of every drawable, inactive ones included", () => {
    const ref = staticResult();
    const cand = clone(ref);
    cand.drawables[1]!.vertices[0] = 0.5 + 2.1e-5;
    const v = judgeStatic("s", "g", ref, cand);
    expect(v.pass).toBe(false);
    expect(v.firstFailure).toMatch(
      /^toleranced values: vertices — 2.1\d*e-5 > 2.00e-5 at B vertex 0 x/,
    );
  });

  it("compares values of non-visible drawables only in the strict check (an advisory)", () => {
    const ref = staticResult();
    const cand = clone(ref);
    cand.drawables[1]!.opacity = 0.5;
    cand.drawables[1]!.drawOrder = 7;
    const v = judgeStatic("s", "g", ref, cand);
    expect(v.pass).toBe(true);
    expect(v.advisories.join()).toMatch(/strict check C10/);
  });

  it("reports the first failing check in the order of 4m", () => {
    const ref = staticResult();
    const cand = clone(ref);
    cand.drawables[0]!.vertices[0] = 1; // toleranced
    expect(
      judgeStatic("s", "g", ref, { ...clone(ref), parameters: [{ id: "P", value: 0.6 }] }).pass,
    ).toBe(true); // the same float32
    cand.drawables[0]!.visible = false; // exact value
    cand.parameters[0]!.value = 0.7; // exact value
    let v = judgeStatic("s", "g", ref, cand);
    expect(v.firstFailure).toMatch(/^exact values: parameter value/);
    expect(v.failures.map((f) => f.split(":")[0])).toEqual([
      "exact values",
      "exact values",
      "toleranced values",
    ]);
    cand.drawables.pop(); // structure
    v = judgeStatic("s", "g", ref, cand);
    expect(v.firstFailure).toMatch(/^structure: drawable IDs/);
    const failed = { ...clone(ref), error: { kind: "ModelLoadError", message: "x" } };
    v = judgeStatic("s", "g", ref, failed);
    expect(v.firstFailure).toMatch(/^error state/);
    // Two errors of any kinds: only the error state is compared.
    expect(
      judgeStatic("s", "g", failed, { ...failed, error: { kind: "Other", message: "y" } }).pass,
    ).toBe(true);
  });

  it("applies the static rules to every step of a sequence and compares the step count", () => {
    const step = (label: string) => ({ label, ...staticResult() });
    const ref = {
      format: "mochi2d-sequence-result/0",
      error: null,
      canvas: staticResult().canvas,
      steps: [step("create"), step("s1")],
    };
    const cand = clone(ref);
    cand.steps[1]!.label = "other"; // labels are informative
    expect(judgeSequence("q", "g", ref, cand).pass).toBe(true);
    cand.steps[1]!.drawables[0]!.drawOrder = 1;
    expect(judgeSequence("q", "g", ref, cand).firstFailure).toMatch(/step 1 .*A: 500 vs 1/);
    cand.steps.pop();
    expect(judgeSequence("q", "g", ref, cand).firstFailure).toMatch(/step count/);
  });
});

describe("render rules (4l.2)", () => {
  const status = (extra: Record<string, unknown> = {}) => ({
    format: "mochi2d-render/0",
    scenario: "r",
    error: null,
    png: "r.png",
    alpha: "premultiplied",
    ...extra,
  });
  const image = (w: number, h: number, f: (i: number) => number) => ({
    width: w,
    height: h,
    data: Uint8Array.from({ length: w * h * 4 }, (_, i) => f(i)),
  });

  it("passes small differences and fails above the limits", () => {
    const a = image(100, 100, () => 128);
    // "At most a few pixels with d > 8" means at most 4: 4 pass silently, 5 give an advisory.
    // (A large image, so that the RMS stays below its expected value of 0.1.)
    const big = image(400, 400, () => 128);
    for (const [n, advisory] of [
      [4, false],
      [5, true],
    ] as const) {
      const few = image(400, 400, (i) => (i < 4 * n ? 140 : 128));
      const r = judgeRender(
        "r",
        "g",
        { status: status(), image: big },
        { status: status(), image: few },
      );
      expect(r.pass).toBe(true);
      expect(r.advisories.length > 0, `${n} pixels`).toBe(advisory);
    }
    const near = image(100, 100, (i) => (i < 40 ? 140 : 128)); // 10 pixels with d = 12
    let v = judgeRender(
      "r",
      "g",
      { status: status(), image: a },
      { status: status(), image: near },
    );
    expect(v.pass).toBe(true);
    expect(v.advisories.join()).toMatch(/above the expected values/);
    const far = image(100, 100, (i) => (i < 4 * 300 ? 255 : 128)); // 300 pixels with d = 127
    v = judgeRender("r", "g", { status: status(), image: a }, { status: status(), image: far });
    expect(v.pass).toBe(false);
    expect(v.failures.join("\n")).toMatch(/N16/);
  });

  it("compares sizes, alpha and TextureTooLarge by kind", () => {
    const a = image(4, 4, () => 0);
    const b = image(4, 2, () => 0);
    expect(
      judgeRender("r", "g", { status: status(), image: a }, { status: status(), image: b })
        .firstFailure,
    ).toMatch(/size/);
    expect(
      judgeRender(
        "r",
        "g",
        { status: status(), image: a },
        { status: status({ alpha: "straight" }), image: a },
      ).firstFailure,
    ).toMatch(/alpha/);
    const tooLarge = {
      status: status({ error: { kind: "TextureTooLarge", message: "" }, png: null }),
      image: null,
    };
    const other = {
      status: status({ error: { kind: "ModelLoadError", message: "" }, png: null }),
      image: null,
    };
    expect(judgeRender("r", "g", tooLarge, tooLarge).pass).toBe(true);
    expect(judgeRender("r", "g", tooLarge, other).firstFailure).toMatch(/error kind/);
  });
});

describe("validation scoring (C27)", () => {
  const ok = { error: null };
  const rejected = { error: { kind: "ModelLoadError", message: "bad" } };
  it("compares the candidate with P8's Required column, not with the official-level verdict", () => {
    // A case the official runtime accepts but the format's rules require Mochi2D to reject.
    const v = { official: "accept", required: "reject" };
    expect(judgeValidation("val-x", "validation", rejected, v, ok).pass).toBe(true);
    expect(judgeValidation("val-x", "validation", ok, v, ok).firstFailure).toMatch(
      /^error state: validation — P8 requires "reject", the candidate accepts/,
    );
    const accept = { official: "accept", required: "accept" };
    expect(judgeValidation("val-y", "validation", ok, accept).pass).toBe(true);
    expect(judgeValidation("val-y", "validation", rejected, accept).pass).toBe(false);
    // A reference that disagrees with P8's Official column is noted.
    expect(judgeValidation("val-y", "validation", ok, accept, rejected).advisories[0]).toMatch(
      /reference rejects/,
    );
  });
});

describe("animation rules (4l.3, 4l.4)", () => {
  const frame = (k: number, extra: Record<string, unknown> = {}) => ({
    frame: k,
    time: (k + 1) / 60,
    parameters: [10, 0.5],
    parts: [1],
    free: [null, 2],
    modelOpacity: 1,
    motionAdvanced: true,
    queueEmpty: false,
    events: [],
    lipsync: null,
    ...extra,
  });
  const result = () => ({
    format: "mochi2d-anim-result/0",
    error: null,
    ids: { parameters: ["Wide", "Narrow"], parts: ["Part"], free: ["F1", "F2"] },
    frames: [frame(0), frame(1)],
    starts: [{ frame: 0, command: 0, started: true }],
    randomUsed: 0,
  });
  const range = (id: string) => (id === "Wide" ? 60 : 1);

  it("scales the parameter tolerance by max(1, R)", () => {
    const ref = result();
    const cand = clone(ref);
    cand.frames[0]!.parameters[0] = 10 + 5e-5; // R = 60: 8.3e-7 relative
    expect(judgeAnimation("a", "g", ref, cand, range).pass).toBe(true);
    cand.frames[0]!.parameters[1] = 0.5 + 2e-6; // R = 1
    expect(judgeAnimation("a", "g", ref, cand, range).firstFailure).toMatch(/parameters/);
  });

  it("compares null only with null, and discrete fields exactly", () => {
    const ref = result();
    let cand = clone(ref);
    cand.frames[1]!.free[0] = 0;
    expect(judgeAnimation("a", "g", ref, cand, range).firstFailure).toMatch(/free value null/);
    cand = clone(ref);
    cand.frames[1]!.events = ["ev"] as never[];
    expect(judgeAnimation("a", "g", ref, cand, range).firstFailure).toMatch(/events/);
    cand = clone(ref);
    cand.randomUsed = 1;
    expect(judgeAnimation("a", "g", ref, cand, range).firstFailure).toMatch(/randomUsed/);
    cand = clone(ref);
    cand.frames.pop();
    expect(judgeAnimation("a", "g", ref, cand, range).firstFailure).toMatch(/recorded frames/);
  });

  it("scores decidable hit tests only, and RandomExhausted by kind", () => {
    const hit = (h: boolean, x: number) => ({
      drawable: "M",
      x,
      y: 0.5,
      hit: h,
      box: [0, 1, 0, 1],
    });
    const ref = result();
    ref.frames[0] = frame(0, { hits: [hit(true, 0.5), hit(true, 1)] });
    const cand = clone(ref);
    (cand.frames[0] as unknown as { hits: { hit: boolean }[] }).hits[1]!.hit = false; // on the edge: undecidable
    let v = judgeAnimation("a", "g", ref, cand, range);
    expect(v.pass).toBe(true);
    expect(v.advisories.join()).toMatch(/1 undecidable/);
    (cand.frames[0] as unknown as { hits: { hit: boolean }[] }).hits[0]!.hit = false;
    v = judgeAnimation("a", "g", ref, cand, range);
    expect(v.firstFailure).toMatch(/hit/);
    const exhausted = { ...result(), error: { kind: "RandomExhausted", message: "" } };
    expect(judgeAnimation("a", "g", exhausted, exhausted, range).pass).toBe(true);
    expect(
      judgeAnimation(
        "a",
        "g",
        exhausted,
        { ...result(), error: { kind: "ModelLoadError", message: "" } },
        range,
      ).firstFailure,
    ).toMatch(/error kind/);
  });
});

describe("judging directories (4m)", () => {
  it("scores validation cases of a catalog against P8's Required column (C27)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mochi2d-judge-"));
    const ref = join(dir, "ref");
    const cand = join(dir, "cand");
    const cat = join(dir, "catalog");
    for (const d of [ref, cand, cat]) await mkdir(d, { recursive: true });
    const result = (id: string, error: unknown) =>
      JSON.stringify({ ...staticResult(), scenario: id, error, drawables: [] });
    const reject = { kind: "ModelLoadError", message: "x" };
    // val-a: the official runtime accepts, P8 requires a rejection; val-b: both accept.
    await writeFile(join(ref, "val-a.result.json"), result("val-a", null));
    await writeFile(join(cand, "val-a.result.json"), result("val-a", reject));
    await writeFile(join(ref, "val-b.result.json"), result("val-b", null));
    await writeFile(join(cand, "val-b.result.json"), result("val-b", reject));
    await writeFile(
      join(cat, "index.json"),
      JSON.stringify({
        format: "mochi2d-catalog/0",
        scenarios: [
          {
            id: "val-a",
            kind: "static",
            group: "validation",
            file: "a.json",
            official: "accept",
            required: "reject",
          },
          {
            id: "val-b",
            kind: "static",
            group: "validation",
            file: "b.json",
            official: "accept",
            required: "accept",
          },
        ],
      }),
    );
    const report = await judgeDirectories(ref, cand, { catalog: cat });
    expect(report.scenarios.map((v) => [v.id, v.pass])).toEqual([
      ["val-a", true],
      ["val-b", false],
    ]);
  });

  it("pairs by scenario ID, fails unpaired scenarios and reports groups", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mochi2d-judge-"));
    const ref = join(dir, "ref");
    const cand = join(dir, "cand");
    await mkdir(join(ref, "nested"), { recursive: true });
    await mkdir(cand, { recursive: true });
    const r = staticResult();
    await writeFile(join(ref, "nested", "s.result.json"), JSON.stringify({ ...r, scenario: "s" }));
    await writeFile(join(cand, "s.result.json"), JSON.stringify({ ...r, scenario: "s" }));
    await writeFile(join(ref, "t.result.json"), JSON.stringify({ ...r, scenario: "t" }));
    const png = encodePng({
      width: 2,
      height: 1,
      data: new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0]),
    });
    for (const side of [ref, cand]) {
      await writeFile(join(side, "r.png"), png);
      await writeFile(
        join(side, "r.render.json"),
        JSON.stringify({
          format: "mochi2d-render/0",
          scenario: "r",
          error: null,
          png: "r.png",
          alpha: "premultiplied",
        }),
      );
    }
    const report = await judgeDirectories(ref, cand);
    expect(report.scenarios.map((v) => [v.id, v.kind, v.pass])).toEqual([
      ["r", "render", true],
      ["s", "static", true],
      ["t", "static", false],
    ]);
    expect(report.scenarios[2]!.firstFailure).toMatch(/pairing: no candidate result/);
    expect(report.groups.map((g) => [g.group, g.passed, g.failed])).toEqual([
      ["render", 1, 0],
      ["static", 1, 1],
    ]);
  });
});

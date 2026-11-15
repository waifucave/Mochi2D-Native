import { describe, expect, it } from "vitest";
import {
  diffResults,
  formatReport,
  toJsonSafe,
  ResultFormatError,
} from "../tools/lib/result-diff.js";

type Drawable = {
  id: string;
  visible: boolean;
  opacity: number;
  drawOrder: number;
  renderOrder: number;
  multiplyColor: number[];
  screenColor: number[];
  vertices: number[];
};

function drawable(id: string, over: Partial<Drawable> = {}): Drawable {
  return {
    id,
    visible: true,
    opacity: 1,
    drawOrder: 500,
    renderOrder: 0,
    multiplyColor: [1, 1, 1, 1],
    screenColor: [0, 0, 0, 1],
    vertices: [0, 0, 1, 0, 1, 1],
    ...over,
  };
}

function result(drawables: Drawable[], extra: Record<string, unknown> = {}) {
  return {
    format: "mochi2d-result/0",
    scenario: "s",
    producer: "test",
    error: null,
    canvas: { width: 100, height: 50 },
    parameters: [
      { id: "P1", value: 0 },
      { id: "P2", value: 1 },
    ],
    parts: [{ id: "Part1", opacity: 1 }],
    drawables,
    ...extra,
  };
}

describe("diffResults", () => {
  it("compares results saved before the rename (lively2d-result/0) without a warning", () => {
    const a = result([drawable("A")]);
    const old = { ...structuredClone(a), format: "lively2d-result/0" };
    const r = diffResults(old, a);
    expect(r.pass).toBe(true);
    expect(r.warnings.filter((w) => w.startsWith("format"))).toEqual([]);
    expect(() => diffResults({ ...a, format: "other-result/0" }, a)).toThrow(ResultFormatError);
  });

  it("passes identical results", () => {
    const a = result([drawable("A"), drawable("B")]);
    const r = diffResults(a, structuredClone(a));
    expect(r.pass).toBe(true);
    expect(r.failedChecks).toEqual([]);
    expect(r.checks.vertices.compared).toBe(6);
    expect(r.checks.vertices.max?.value).toBe(0);
    expect(r.referenceExtent).toBeCloseTo(Math.SQRT2);
    expect(formatReport(r)).toContain("RESULT: PASS");
  });

  it("computes per-drawable max and RMS vertex error", () => {
    const a = result([drawable("A"), drawable("B")]);
    const b = result([drawable("A", { vertices: [0, 0, 1.003, 0.004, 1, 1] }), drawable("B")]);
    const r = diffResults(a, b, { tolerances: { vertex: 1e-3 } });
    expect(r.pass).toBe(false);
    expect(r.failedChecks).toEqual(["vertices"]);
    const d = r.drawables[0]!;
    expect(d.id).toBe("A");
    expect(d.maxVertexError).toBeCloseTo(0.005);
    expect(d.maxVertexIndex).toBe(1);
    expect(d.rmsVertexError).toBeCloseTo(Math.sqrt((0.005 * 0.005) / 3));
    expect(r.checks.vertices.max).toMatchObject({ id: "A", index: 1 });
    expect(r.checks.vertices.mismatched).toBe(1);
    // Within a looser tolerance it passes.
    expect(diffResults(a, b, { tolerances: { vertex: 0.01 } }).pass).toBe(true);
  });

  it("reports missing / extra ids, order and count mismatches", () => {
    const a = result([drawable("A"), drawable("B"), drawable("C")]);
    const b = result([drawable("B"), drawable("A"), drawable("D", { vertices: [0, 0] })], {
      parameters: [{ id: "P1", value: 0 }],
      parts: [
        { id: "Part1", opacity: 1 },
        { id: "Part2", opacity: 1 },
      ],
    });
    const r = diffResults(a, b);
    expect(r.drawableIds.onlyInA).toEqual(["C"]);
    expect(r.drawableIds.onlyInB).toEqual(["D"]);
    expect(r.parameterIds.onlyInA).toEqual(["P2"]);
    expect(r.partIds.onlyInB).toEqual(["Part2"]);
    expect(r.failedChecks).toEqual(
      expect.arrayContaining(["drawableIds", "drawableOrder", "parameterIds", "partIds"]),
    );
    expect(r.drawables.find((d) => d.id === "C")?.status).toBe("only-in-a");
  });

  it("checks opacity, orders, visibility and colors with tolerances", () => {
    const a = result([drawable("A")]);
    const b = result([
      drawable("A", {
        opacity: 0.9,
        drawOrder: 501,
        renderOrder: 1,
        visible: false,
        multiplyColor: [1, 0.5, 1, 1],
        screenColor: [0, 0, 0.00005, 1],
      }),
    ]);
    const r = diffResults(a, b);
    expect(r.failedChecks).toEqual([
      "visible",
      "opacity",
      "drawOrder",
      "renderOrder",
      "multiplyColor",
    ]);
    const d = r.drawables[0]!;
    expect(d.opacity).toEqual([1, 0.9]);
    expect(d.drawOrder).toEqual([500, 501]);
    expect(r.checks.multiplyColor.max).toMatchObject({ value: 0.5, id: "A", index: 1 });
    expect(r.checks.screenColor.pass).toBe(true);
    // Order tolerances and ignore lists.
    const r2 = diffResults(a, b, {
      tolerances: { drawOrder: 1, renderOrder: 1, opacity: 0.2, color: 0.5 },
      ignore: ["visible"],
    });
    expect(r2.pass).toBe(true);
    expect(r2.checks.visible.mismatched).toBe(1);
  });

  it("skips invisible drawables when asked", () => {
    const a = result([drawable("A", { visible: false })]);
    const b = result([drawable("A", { visible: false, vertices: [9, 9, 9, 9, 9, 9], opacity: 0 })]);
    expect(diffResults(a, b).pass).toBe(false);
    const r = diffResults(a, b, { skipInvisible: true });
    expect(r.pass).toBe(true);
    expect(r.drawables[0]!.skipped).toBe(true);
  });

  it("treats invalid numbers and vertex-count mismatches as failures", () => {
    const a = result([drawable("A"), drawable("B")]);
    const b = result([
      drawable("A", { vertices: [0, 0, null as unknown as number, 0, 1, 1] }),
      drawable("B", { vertices: [0, 0] }),
    ]);
    const r = diffResults(a, b);
    expect(r.checks.vertices.invalid).toBe(1);
    expect(r.failedChecks).toEqual(expect.arrayContaining(["vertices", "vertexCount"]));
    expect(r.drawables.find((d) => d.id === "B")?.vertexCount).toEqual([3, 1]);
    expect(JSON.stringify(toJsonSafe(r))).not.toContain("Infinity");
  });

  it("fails when either result carries an error and compares canvas deeply", () => {
    const a = result([]);
    const b = result([], {
      error: { kind: "X", message: "boom" },
      canvas: { width: 100, height: 51 },
    });
    const r = diffResults(a, b);
    expect(r.failedChecks).toEqual(expect.arrayContaining(["error", "canvas"]));
    expect(r.canvasMismatches).toEqual([{ path: "canvas.height", a: 50, b: 51 }]);
  });

  it("rejects non-result input", () => {
    expect(() => diffResults({ format: "other" }, result([]))).toThrow(ResultFormatError);
    expect(() => diffResults([], result([]))).toThrow(/not a JSON object/);
  });
});

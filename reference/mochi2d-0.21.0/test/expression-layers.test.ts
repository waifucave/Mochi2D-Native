/**
 * Several expressions at once (`addExpression`, `removeExpression`; not
 * reference behavior): each layer fades in and out with its file's times and
 * applies Add, Multiply and Overwrite in the order the layers were added,
 * after the replacing expression of `setExpression`. On a synthetic model.
 */
import { describe, expect, it } from "vitest";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { ModelRuntime } from "../src/runtime/model-runtime.js";
import { Synth } from "./support/synth.js";

const enc = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => enc(JSON.stringify(v));

function source(): MemoryFileSource {
  const s = new Synth(4);
  s.part({ id: "P" });
  s.param("A", -10, 10, 0);
  s.param("B", -10, 10, 1);
  s.mesh({ id: "M", keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
  return new MemoryFileSource("synthetic", [
    [
      "m.model3.json",
      json({
        Version: 3,
        FileReferences: {
          Moc: "m.moc3",
          Textures: [],
          Expressions: [
            { Name: "Up", File: "e/up.exp3.json" },
            { Name: "Big", File: "e/big.exp3.json" },
          ],
        },
      }),
    ],
    ["m.moc3", s.build()],
    [
      "e/up.exp3.json",
      json({
        Type: "Live2D Expression",
        FadeInTime: 0.5,
        FadeOutTime: 0.5,
        Parameters: [{ Id: "A", Value: 2, Blend: "Add" }],
      }),
    ],
    [
      "e/big.exp3.json",
      json({
        Type: "Live2D Expression",
        FadeInTime: 0,
        FadeOutTime: 0,
        Parameters: [
          { Id: "A", Value: 3, Blend: "Multiply" },
          { Id: "B", Value: 4, Blend: "Overwrite" },
        ],
      }),
    ],
  ]);
}

async function runtime() {
  const rt = await ModelRuntime.load(source(), "m.model3.json");
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) rt.update(1 / 60);
  };
  return { rt, run };
}

describe("added expressions", () => {
  it("fade in, stack in order, and fade out with their files' times", async () => {
    const { rt, run } = await runtime();
    expect(await rt.addExpression("Up")).toBe(true);
    expect(await rt.addExpression("e/up.exp3.json")).toBe(false); // already added
    run(0.25);
    const half = rt.getParameter("A");
    expect(half).toBeGreaterThan(0.5);
    expect(half).toBeLessThan(1.5);
    run(0.5);
    expect(rt.getParameter("A")).toBe(2);
    // Up, then Big: (0 + 2) · 3; B overwritten.
    expect(await rt.addExpression("Big")).toBe(true);
    run(1 / 60);
    expect(rt.getParameter("A")).toBe(6);
    expect(rt.getParameter("B")).toBe(4);
    expect(rt.addedExpressions).toEqual(["e/up.exp3.json", "e/big.exp3.json"]);
    // Removing Up fades it out over 0.5 s; Big stays.
    expect(rt.removeExpression("Up")).toBe(true);
    expect(rt.removeExpression("Up")).toBe(false);
    expect(rt.addedExpressions).toEqual(["e/big.exp3.json"]);
    run(0.25);
    expect(rt.getParameter("A")).toBeGreaterThan(0);
    expect(rt.getParameter("A")).toBeLessThan(6);
    run(0.3);
    expect(rt.getParameter("A")).toBe(0);
    expect(rt.getParameter("B")).toBe(4);
    // Without an argument, every added expression goes; the base values return.
    expect(rt.removeExpression()).toBe(true);
    run(2 / 60);
    expect(rt.addedExpressions).toEqual([]);
    expect(rt.animator.expressionLayers.empty).toBe(true);
    expect(rt.getParameter("B")).toBe(1);
  });

  it("apply after the replacing expression, and follow the expressions switch", async () => {
    const { rt, run } = await runtime();
    await rt.setExpression("Big"); // the queue: A · 3, B = 4
    await rt.addExpression("Up");
    run(1);
    expect(rt.playingExpressions).toEqual(["e/big.exp3.json"]);
    expect(rt.getParameter("A")).toBe(2); // (0 · 3) + 2
    expect(rt.getParameter("B")).toBe(4);
    rt.setEffect("expressions", false);
    run(1 / 60);
    expect(rt.getParameter("A")).toBe(0);
    expect(rt.getParameter("B")).toBe(1);
    rt.setEffect("expressions", true);
    // A layer removed before its first frame never shows.
    await rt.addExpression("Big");
    rt.removeExpression("Big");
    run(1 / 60);
    expect(rt.getParameter("A")).toBe(2);
  });
});

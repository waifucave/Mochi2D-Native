/**
 * Idle weights (`setIdleWeight`): how far motions at the idle priority move
 * each parameter. Weight 1 is today's behavior bit for bit, weight 0 leaves
 * the base value, a weight in between follows the documented rule, and
 * one-shot motions are not affected. Also `getParameterBase` beside
 * `getParameter`.
 */
import { describe, expect, it } from "vitest";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { ModelRuntime, type EffectName } from "../src/runtime/model-runtime.js";
import { constant, motionJson } from "./support/anim.js";
import { Synth } from "./support/synth.js";

const tri = (x: number, y: number) => [x, y, x + 0.1, y, x, y + 0.1];

/** Parameters P, Q and ParamBreath; mesh M0 follows P, M1 follows Q. */
function moc(): Uint8Array {
  const s = new Synth(5);
  s.part({ id: "Root" });
  const P = s.param("P", 0, 1, 0);
  const Q = s.param("Q", 0, 1, 0);
  s.param("ParamBreath", 0, 1, 0);
  for (const [i, p] of [P, Q].entries())
    s.mesh({
      id: `M${i}`,
      band: s.band([s.binding(p, [0, 1])]),
      keyforms: [{ positions: tri(0, 0) }, { positions: tri(0.5, 0.25 * (i + 1)) }],
    });
  return s.build();
}

// The idle motion: P and Q to 0.75 for 4 s, with 0.5 s fades. The one-shot: P to 1 for 1 s.
const IDLE = motionJson({
  duration: 4,
  fps: 30,
  fadeIn: 0.5,
  fadeOut: 0.5,
  curves: [constant("P", 0.75, 4), constant("Q", 0.75, 4)],
});
const TAP = motionJson({
  duration: 1,
  fps: 30,
  fadeIn: 0,
  fadeOut: 0,
  curves: [constant("P", 1, 1)],
});

async function load(): Promise<ModelRuntime> {
  const source = MemoryFileSource.fromFiles({
    "m.model3.json": JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: "m.moc3",
        Textures: [],
        Motions: { Idle: [{ File: "idle.motion3.json" }] },
      },
    }),
    "m.moc3": moc(),
    "idle.motion3.json": IDLE,
    "tap.motion3.json": TAP,
  });
  const rt = await ModelRuntime.load(source, "m.model3.json");
  // Only the idle animation runs (and breath where a test turns it on).
  for (const e of ["eyeBlink", "breath", "look", "physics", "lipSync", "pose"] as EffectName[])
    rt.setEffect(e, false);
  return rt;
}

const DT = 1 / 60;

describe("idle weights", () => {
  it("at 1 give today's results bit for bit, other parameters' weights notwithstanding", async () => {
    const today = await load();
    const weighted = await load();
    weighted.setIdleWeight("P", 0.25);
    weighted.setIdleWeight("P", 1); // back to 1
    weighted.setIdleWeight("Q", 0.5); // another parameter's weight
    expect([...weighted.idleWeights]).toEqual([["Q", 0.5]]);
    let moved = false;
    // 9 s: the idle motion's start, fades, end, and the next one.
    for (let f = 0; f < 540; f++) {
      today.update(DT);
      weighted.update(DT);
      const p = today.getParameter("P");
      expect(Object.is(weighted.getParameter("P"), p)).toBe(true);
      const v = Array.from(today.instance.drawableVertices[0]!);
      expect(Array.from(weighted.instance.drawableVertices[0]!)).toEqual(v);
      if (p > 0.7) moved = true;
    }
    expect(moved, "the idle motion played").toBe(true);
  });

  it("at 0 leave the base value, while the idle motion moves the other parameters", async () => {
    const rt = await load();
    rt.setParameter("P", 0.25);
    expect(rt.setIdleWeight("P", 0)).toBe(true);
    for (let f = 0; f < 300; f++) {
      rt.update(DT);
      expect(rt.getParameter("P")).toBe(0.25);
      expect(rt.getParameterBase("P")).toBe(0.25);
    }
    expect(rt.getParameter("Q")).toBe(0.75);
  });

  it("in between move a parameter by weight × the motion's weight of the way", async () => {
    // Tracking writes the base value every frame: each frame shows base + k·(idle − base).
    const tracked = await load();
    tracked.setIdleWeight("P", 0.5);
    for (let f = 1; f <= 180; f++) {
      tracked.setParameter("P", 0.25);
      tracked.update(DT);
      // Fully faded in from 0.5 s to 3.5 s: 0.25 + (0.75 − 0.25) · 1 · 0.5.
      if (f > 40 && f < 200) expect(tracked.getParameter("P")).toBe(0.5);
    }
    // Nothing writes it: the motion's result stays in the base value, so each frame
    // moves on from the last one, cur ← f32(cur + (0.75 − cur) · 0.5).
    const free = await load();
    free.setIdleWeight("P", 0.5);
    for (let f = 0; f < 40; f++) free.update(DT); // past the fade-in
    let cur = free.getParameter("P");
    for (let f = 0; f < 60; f++) {
      free.update(DT);
      cur = Math.fround(cur + (0.75 - cur) * (1 * 0.5));
      expect(free.getParameter("P")).toBe(cur);
    }
    expect(cur).toBeCloseTo(0.75, 6);
  });

  it("leave one-shot motions alone: they still win", async () => {
    const rt = await load();
    rt.setIdleWeight("P", 0);
    const frame = () => {
      rt.setParameter("P", 0.25); // tracking
      rt.update(DT);
    };
    for (let f = 0; f < 60; f++) frame();
    expect(rt.getParameter("P")).toBe(0.25);
    expect(await rt.startMotionFile("tap.motion3.json")).toBeTruthy();
    for (let f = 0; f < 30; f++) {
      frame();
      expect(rt.getParameter("P")).toBe(1);
    }
    for (let f = 0; f < 60; f++) frame(); // the one-shot has ended; idle again
    expect(rt.getParameter("P")).toBe(0.25);
  });

  it("apply to every motion at the idle priority, and only to those", async () => {
    const rt = await load();
    rt.setEffect("idle", false);
    rt.setIdleWeight("P", 0);
    await rt.startMotionFile("idle.motion3.json", { priority: 1, loop: true });
    for (let f = 0; f < 60; f++) rt.update(DT);
    expect([rt.getParameter("P"), rt.getParameter("Q")]).toEqual([0, 0.75]);
    rt.stopMotions();
    await rt.startMotionFile("idle.motion3.json", { priority: 2, loop: true });
    for (let f = 0; f < 60; f++) rt.update(DT);
    expect(rt.getParameter("P")).toBe(0.75);
  });

  it("are limited to [0, 1], refuse unknown IDs and NaN, reset, and carry over to other data", async () => {
    const rt = await load();
    expect(rt.setIdleWeight("Nope", 0)).toBe(false);
    expect(() => rt.setIdleWeight("P", NaN)).toThrow(RangeError);
    rt.setIdleWeight("P", 2);
    rt.setIdleWeight("Q", -1);
    expect([rt.getIdleWeight("P"), rt.getIdleWeight("Q"), rt.getIdleWeight("Nope")]).toEqual([
      1, 0, 1,
    ]);
    const next = await rt.withData(moc());
    expect(next.getIdleWeight("Q")).toBe(0);
    rt.resetIdleWeights();
    expect([...rt.idleWeights]).toEqual([]);
  });
});

describe("getParameterBase", () => {
  it("reads the base value, without the effects that getParameter includes", async () => {
    const rt = await load();
    rt.setEffect("breath", true);
    rt.setParameter("ParamBreath", 0.125);
    for (let f = 0; f < 30; f++) rt.update(DT);
    expect(rt.getParameterBase("ParamBreath")).toBe(0.125);
    expect(rt.getParameter("ParamBreath")).not.toBe(0.125);
    // A motion's result stays in the base value (the frame procedure keeps it).
    for (let f = 0; f < 60; f++) rt.update(DT);
    expect(rt.getParameterBase("Q")).toBe(0.75);
    // An ID the model lacks reads as getParameter does.
    expect(rt.getParameterBase("Nope")).toBe(rt.getParameter("Nope"));
  });
});

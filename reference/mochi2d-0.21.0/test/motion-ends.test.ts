/**
 * Holding a motion's last frame (`hold`, not reference behavior) and the end
 * of each motion: the playback's `ended` promise and the runtime's end
 * listeners, with the reasons finished, replaced and stopped, idle motions
 * included. On a small synthetic model, so no model files are needed.
 */
import { describe, expect, it } from "vitest";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { ModelRuntime, type MotionEnd } from "../src/runtime/model-runtime.js";
import { MotionQueue } from "../src/anim/motion-queue.js";
import { AnimationValues } from "../src/anim/values.js";
import { loadMoc } from "../src/core/moc/model.js";
import { parseMotion } from "../src/anim/motion.js";
import { sequenceRandom } from "../src/anim/scenario.js";
import { motionJson } from "./support/anim.js";
import { Synth } from "./support/synth.js";

const enc = (s: string) => new TextEncoder().encode(s);

function moc(): Uint8Array {
  const s = new Synth(4);
  s.part({ id: "P" });
  s.param("A", -10, 10, 0);
  s.param("B", -10, 10, 0);
  s.param("E", 0, 1, 1);
  s.mesh({ id: "M", keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
  return s.build();
}

/** A motion that ramps `id` from 0 to `value` over `duration` seconds. */
const ramp = (id: string, value: number, duration: number, fadeOut = 0) =>
  motionJson({
    duration,
    fps: 30,
    fadeIn: 0,
    fadeOut,
    curves: [{ id, first: [0, 0], segments: [["linear", duration, value]] }],
  });

function source(idle = false, blink = false): MemoryFileSource {
  return new MemoryFileSource("synthetic", [
    [
      "m.model3.json",
      enc(
        JSON.stringify({
          Version: 3,
          FileReferences: {
            Moc: "m.moc3",
            Textures: [],
            Motions: {
              Tap: [{ File: "a.motion3.json" }, { File: "b.motion3.json" }],
              ...(idle ? { Idle: [{ File: "idle.motion3.json" }] } : {}),
            },
          },
          ...(blink ? { Groups: [{ Target: "Parameter", Name: "EyeBlink", Ids: ["E"] }] } : {}),
        }),
      ),
    ],
    ["m.moc3", moc()],
    ["a.motion3.json", enc(ramp("A", 5, 0.5))],
    ["b.motion3.json", enc(ramp("B", 3, 1, 0.2))],
    ["idle.motion3.json", enc(ramp("B", 1, 0.25))],
  ]);
}

async function runtime(idle = false, blink = false) {
  const rt = await ModelRuntime.load(source(idle, blink), "m.model3.json", {
    animation: { random: sequenceRandom(Array.from({ length: 1000 }, () => 0.5)) },
  });
  const ends: MotionEnd[] = [];
  rt.onMotionEnd((e) => ends.push(e));
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) rt.update(1 / 60);
  };
  return { rt, ends, run };
}

describe("motion ends", () => {
  it("report finished, replaced and stopped, once per motion", async () => {
    const { rt, ends, run } = await runtime();
    const a = await rt.startMotion("Tap", 0);
    expect(a).toMatchObject({ motion: "a.motion3.json", group: "Tap", index: 0 });
    run(1);
    expect(ends).toEqual([
      { motion: "a.motion3.json", group: "Tap", index: 0, reason: "finished", queueEmpty: true },
    ]);
    await expect(a && a.ended).resolves.toEqual(ends[0]);
    expect(rt.playingMotions).toEqual([]);
    // b is replaced by a forced start; it fades out, then ends.
    const b = await rt.startMotion("Tap", 1);
    run(0.25);
    const a2 = await rt.startMotionFile("a.motion3.json", { priority: 3 });
    expect(a2).toMatchObject({ motion: "a.motion3.json", group: null, index: null });
    run(0.1);
    expect(ends).toHaveLength(1); // still fading out
    run(0.2);
    expect(ends[1]).toEqual({
      motion: "b.motion3.json",
      group: "Tap",
      index: 1,
      reason: "replaced",
      queueEmpty: false,
    });
    await expect(b && b.ended).resolves.toMatchObject({ reason: "replaced" });
    rt.stopMotions();
    expect(ends[2]).toEqual({
      motion: "a.motion3.json",
      group: null,
      index: null,
      reason: "stopped",
      queueEmpty: true,
    });
    await expect(a2 && a2.ended).resolves.toMatchObject({ reason: "stopped" });
    // A refused start has no playback.
    await rt.startMotion("Tap", 1);
    expect(await rt.startMotion("Tap", 0)).toBe(false);
  });

  it("include idle motions, with their group and index", async () => {
    const { rt, ends, run } = await runtime(true);
    run(0.5);
    expect(ends[0]).toEqual({
      motion: "idle.motion3.json",
      group: "Idle",
      index: 0,
      reason: "finished",
      queueEmpty: true,
    });
    expect(rt.playingMotions).toEqual(["idle.motion3.json"]); // the next idle draw
  });
});

describe("hold", () => {
  it("keeps the last frame, without the end's fade-out, until the next motion", async () => {
    const { rt, ends, run } = await runtime(true);
    run(0.1); // the idle motion plays
    const b = await rt.startMotion("Tap", 1, { hold: true });
    run(0.5);
    expect(rt.getParameter("B")).toBeGreaterThan(1);
    expect(rt.getParameter("B")).toBeLessThan(2);
    run(1);
    // Ended (finished) at its last frame, but still in the queue at full weight:
    // the exact last value, and no idle motion takes over.
    expect(ends.slice(-1)).toEqual([
      { motion: "b.motion3.json", group: "Tap", index: 1, reason: "finished", queueEmpty: false },
    ]);
    await expect(b && b.ended).resolves.toMatchObject({ reason: "finished" });
    expect(rt.getParameter("B")).toBe(3);
    run(2);
    expect(rt.playingMotions).toEqual(["b.motion3.json"]);
    expect(rt.getParameter("B")).toBe(3);
    expect(rt.animator.motions.currentPriority).toBe(0);
    // A normal start is accepted; the held motion leaves without a second end.
    const n = ends.length;
    const a = await rt.startMotion("Tap", 0);
    expect(a).not.toBe(false);
    run(0.1);
    expect(rt.playingMotions).toEqual(["a.motion3.json"]);
    expect(ends).toHaveLength(n);
  });

  it("without hold, the end's fade-out stops short of the last value and idle resumes", async () => {
    const { rt, run } = await runtime(true);
    run(0.1);
    await rt.startMotion("Tap", 1);
    run(1.05);
    expect(rt.getParameter("B")).toBeLessThan(3);
    expect(rt.playingMotions).toEqual(["idle.motion3.json"]);
  });

  it("ends at stopMotions, which leaves the values where they are", async () => {
    const { rt, ends, run } = await runtime();
    await rt.startMotion("Tap", 1, { hold: true });
    run(2);
    expect(rt.getParameter("B")).toBe(3);
    rt.stopMotions();
    run(0.1);
    expect(rt.playingMotions).toEqual([]);
    expect(rt.getParameter("B")).toBe(3); // the frame procedure saved them
    expect(ends.map((e) => e.reason)).toEqual(["finished"]);
  });

  it("lets eye blink run once the motion is at its end, unless blinkWhileHeld is false", async () => {
    // The lowest value of the blink parameter E over `seconds` (1 = open).
    const lowest = (rt: ModelRuntime, seconds: number) => {
      let min = 1;
      for (let i = 0; i < Math.round(seconds * 60); i++) {
        rt.update(1 / 60);
        min = Math.min(min, rt.getParameter("E"));
      }
      return min;
    };
    // Without a motion, eye blink closes the eyes within 12 s.
    const free = await runtime(false, true);
    expect(lowest(free.rt, 12)).toBeLessThan(0.5);
    // While the motion plays (1 s), no blink; once it holds, blinks resume.
    const held = await runtime(false, true);
    await held.rt.startMotion("Tap", 1, { hold: true });
    expect(lowest(held.rt, 0.95)).toBe(1);
    expect(lowest(held.rt, 12)).toBeLessThan(0.5);
    expect(held.rt.playingMotions).toEqual(["b.motion3.json"]);
    expect(held.rt.getParameter("B")).toBe(3);
    // With blinkWhileHeld false, the held motion keeps eye blink off.
    const off = await runtime(false, true);
    await off.rt.startMotion("Tap", 1, { hold: true, blinkWhileHeld: false });
    expect(lowest(off.rt, 13)).toBe(1);
    // A new motion stops the blinking again while it plays.
    await held.rt.startMotion("Tap", 0);
    expect(lowest(held.rt, 0.4)).toBe(1);
  });

  it("keeps eye blink off in the frame in which the last motion ends (3j)", () => {
    const values = new AnimationValues(loadMoc(moc()));
    const q = new MotionQueue({ eyeBlink: [], lipSync: [] });
    expect(q.blinkAllowed).toBe(false); // empty: the frame procedure lets it run anyway
    q.start(parseMotion(enc(ramp("A", 5, 0.1)), "a"));
    let ended = false;
    for (let i = 0; i < 30 && !ended; i++) {
      values.restore();
      q.advance(1 / 60, values);
      ended = q.empty;
      // Not held: never allowed, neither while it plays nor in the frame it ends.
      expect(q.blinkAllowed).toBe(false);
    }
    expect(ended).toBe(true);
  });

  it("is ignored with loop, and a replaced held motion ends replaced", async () => {
    const values = new AnimationValues(loadMoc(moc()));
    const q = new MotionQueue({ eyeBlink: [], lipSync: [] });
    const a = parseMotion(enc(ramp("A", 5, 0.5)), "a");
    q.start(a, { hold: true, loop: true });
    for (let i = 0; i < 90; i++) {
      values.restore();
      q.advance(1 / 60, values);
    }
    expect(q.takeEnds()).toEqual([]); // looping: no end
    expect(values.get("A")).toBeLessThan(5);
    q.stopAll();
    expect(q.takeEnds().map((e) => e.reason)).toEqual(["stopped"]);
    // Replaced before its end: it fades out and ends as replaced.
    q.currentPriority = 0; // stopAll keeps the priority (C19)
    expect(q.start(a, { hold: true })).toBe(true);
    q.advance(1 / 60, values);
    q.start(parseMotion(enc(ramp("B", 3, 1)), "b"), { priority: 3 });
    for (let i = 0; i < 10; i++) q.advance(1 / 60, values);
    expect(q.takeEnds().map((e) => [e.motion.label, e.reason])).toEqual([["a", "replaced"]]);
  });
});

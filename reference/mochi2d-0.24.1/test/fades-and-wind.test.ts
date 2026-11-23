/**
 * Expression fade times given per call (setExpression, addExpression,
 * removeExpression, clearExpression), and wind per physics setting, on
 * synthetic models. Without the new arguments, or with a multiplier of 1,
 * results are bit-identical to before.
 */
import { describe, expect, it } from "vitest";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { ModelRuntime, type EffectName } from "../src/runtime/model-runtime.js";
import { Synth } from "./support/synth.js";

const OFF: EffectName[] = ["eyeBlink", "breath", "look", "idle", "lipSync", "pose"];

// ------------------------------------------------------------- expressions

async function expressionModel(): Promise<ModelRuntime> {
  const s = new Synth(5);
  s.part({ id: "Root" });
  s.param("P", 0, 1, 0);
  const rt = await ModelRuntime.load(
    MemoryFileSource.fromFiles({
      "m.model3.json": JSON.stringify({
        Version: 3,
        FileReferences: {
          Moc: "m.moc3",
          Textures: [],
          Expressions: [{ Name: "e", File: "e.exp3.json" }],
        },
      }),
      "m.moc3": s.build(),
      // Fades of 1 s each in the file.
      "e.exp3.json": JSON.stringify({
        Type: "Live2D Expression",
        FadeInTime: 1,
        FadeOutTime: 1,
        Parameters: [{ Id: "P", Value: 1, Blend: "Add" }],
      }),
    }),
    "m.model3.json",
  );
  for (const e of [...OFF, "physics"] as EffectName[]) rt.setEffect(e, false);
  return rt;
}

/** P after each of `n` frames of 0.1 s. */
function run(rt: ModelRuntime, n: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    rt.update(0.1);
    out.push(rt.getParameter("P"));
  }
  return out;
}

describe("expression fade times per call", () => {
  it("setExpression: the file's times unless given; given ones as the file's would be", async () => {
    const file = await expressionModel();
    await file.setExpression("e");
    const same = await expressionModel();
    await same.setExpression("e", { fadeIn: 1, fadeOut: 1 });
    const a = run(file, 12);
    expect(run(same, 12)).toEqual(a);
    expect(a[2]).toBeGreaterThan(0);
    expect(a[2]).toBeLessThan(1);
    const quick = await expressionModel();
    await quick.setExpression("e", { fadeIn: 0 });
    expect(run(quick, 2)).toEqual([1, 1]);
    // A slower fade-in is still partway where the file's would be further.
    const slow = await expressionModel();
    await slow.setExpression("e", { fadeIn: 4 });
    expect(run(slow, 5)[4]).toBeLessThan(a[4]!);
  });

  it("clearExpression fades out over the given time", async () => {
    const rt = await expressionModel();
    await rt.setExpression("e", { fadeIn: 0 });
    run(rt, 2);
    rt.clearExpression({ fadeOut: 0 });
    expect(run(rt, 2)).toEqual([0, 0]);
    const slow = await expressionModel();
    await slow.setExpression("e", { fadeIn: 0 });
    run(slow, 2);
    slow.clearExpression();
    const fading = run(slow, 3);
    expect(fading[0]).toBeGreaterThan(0);
  });

  it("addExpression and removeExpression take fade times; the layer keeps the given fade-out", async () => {
    const rt = await expressionModel();
    expect(await rt.addExpression("e", { fadeIn: 0, fadeOut: 0 })).toBe(true);
    expect(run(rt, 2)).toEqual([1, 1]);
    // Removed with the fade-out addExpression gave: at once.
    expect(rt.removeExpression("e")).toBe(true);
    expect(run(rt, 1)).toEqual([0]);
    // Removed with a fade-out of its own: partway after 0.5 s of 2 s.
    await rt.addExpression("e", { fadeIn: 0 });
    run(rt, 1);
    rt.removeExpression(null, { fadeOut: 2 });
    const out = run(rt, 5);
    expect(out[4]).toBeGreaterThan(0);
    expect(out[4]).toBeLessThan(1);
    expect(rt.addedExpressions).toEqual([]);
  });

  it("refuses negative, NaN and infinite times", async () => {
    const rt = await expressionModel();
    await expect(rt.setExpression("e", { fadeIn: -1 })).rejects.toThrow(RangeError);
    await expect(rt.addExpression("e", { fadeOut: NaN })).rejects.toThrow(RangeError);
    expect(() => rt.removeExpression("e", { fadeOut: Infinity })).toThrow(RangeError);
    expect(() => rt.clearExpression({ fadeOut: -0.5 })).toThrow(RangeError);
  });
});

// -------------------------------------------------------------------- wind

/** A physics setting from parameter X to `out`. */
const setting = (id: string, out: string) => ({
  Id: id,
  Input: [{ Source: { Target: "Parameter", Id: "X" }, Weight: 100, Type: "X", Reflect: false }],
  Output: [
    {
      Destination: { Target: "Parameter", Id: out },
      VertexIndex: 1,
      Scale: 1,
      Weight: 100,
      Type: "Angle",
      Reflect: false,
    },
  ],
  Vertices: [
    { Position: { X: 0, Y: 0 }, Mobility: 1, Delay: 1, Acceleration: 1, Radius: 0 },
    { Position: { X: 0, Y: 10 }, Mobility: 0.9, Delay: 0.9, Acceleration: 1, Radius: 10 },
  ],
  Normalization: {
    Position: { Minimum: -10, Default: 0, Maximum: 10 },
    Angle: { Minimum: -10, Default: 0, Maximum: 10 },
  },
});

async function windModel(): Promise<ModelRuntime> {
  const s = new Synth(5);
  s.part({ id: "Root" });
  for (const id of ["X", "Y", "Z"]) s.param(id, -10, 10, 0);
  const rt = await ModelRuntime.load(
    MemoryFileSource.fromFiles({
      "m.model3.json": JSON.stringify({
        Version: 3,
        FileReferences: { Moc: "m.moc3", Textures: [], Physics: "m.physics3.json" },
      }),
      "m.moc3": s.build(),
      "m.physics3.json": JSON.stringify({
        Version: 3,
        Meta: {
          PhysicsSettingCount: 2,
          TotalInputCount: 2,
          TotalOutputCount: 2,
          VertexCount: 4,
          Fps: 30,
          EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
          PhysicsDictionary: [],
        },
        PhysicsSettings: [setting("A", "Y"), setting("B", "Z")],
      }),
    }),
    "m.model3.json",
  );
  for (const e of OFF) rt.setEffect(e, false);
  return rt;
}

/** Y and Z over 90 frames with X swinging. */
function swing(rt: ModelRuntime): [number[], number[]] {
  const y: number[] = [];
  const z: number[] = [];
  for (let f = 0; f < 90; f++) {
    rt.setParameter("X", 8 * Math.sin(f / 7));
    rt.update(1 / 60);
    y.push(rt.getParameter("Y"));
    z.push(rt.getParameter("Z"));
  }
  return [y, z];
}

describe("wind per physics setting", () => {
  it("1 is the reference bit for bit; 0 shields a setting; 2 doubles its wind; others unchanged", async () => {
    const plain = await windModel();
    plain.setPhysicsWind(1, 0);
    const [y, z] = swing(plain);
    const calm = await windModel();
    const [yCalm] = swing(calm);
    const twice = await windModel();
    twice.setPhysicsWind(2, 0);
    const [yTwice] = swing(twice);
    expect(y).not.toEqual(yCalm);

    const one = await windModel();
    one.setPhysicsWind(1, 0);
    expect(one.setPhysicsSettingWind("A", 1)).toBe(true);
    expect(swing(one)).toEqual([y, z]);

    const shielded = await windModel();
    shielded.setPhysicsWind(1, 0);
    shielded.setPhysicsSettingWind("A", 0);
    expect(shielded.getPhysicsSettingWind("A")).toBe(0);
    expect([...shielded.physicsSettingWinds]).toEqual([["A", 0]]);
    const [yS, zS] = swing(shielded);
    expect(yS).toEqual(yCalm);
    expect(zS).toEqual(z);

    const doubled = await windModel();
    doubled.setPhysicsWind(1, 0);
    doubled.setPhysicsSettingWind("A", 2);
    const [yD, zD] = swing(doubled);
    expect(yD).toEqual(yTwice);
    expect(zD).toEqual(z);
  });

  it("resets, refuses non-finite multipliers and unknown IDs, and carries over to withData", async () => {
    const rt = await windModel();
    rt.setPhysicsSettingWind("B", -1);
    expect(rt.setPhysicsSettingWind("Nope", 2)).toBe(false);
    expect(() => rt.setPhysicsSettingWind("A", NaN)).toThrow(RangeError);
    expect(() => rt.setPhysicsSettingWind("A", Infinity)).toThrow(RangeError);
    const next = await rt.withModel(rt.model);
    expect(next.getPhysicsSettingWind("B")).toBe(-1);
    rt.resetPhysicsSettingWinds();
    expect(rt.getPhysicsSettingWind("B")).toBe(1);
    expect(rt.physicsSettingWinds.size).toBe(0);
  });
});

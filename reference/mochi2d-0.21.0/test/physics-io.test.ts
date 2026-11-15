/**
 * Physics files and the physics simulation's state (not reference behavior):
 *
 * - `writePhysics` writes physics data back to `.physics3.json` text, which
 *   `parsePhysics` reads back as the same data. DeepSeek-chan's file comes
 *   back byte for byte.
 * - `savePhysicsState` and `restorePhysicsState`: a run continued from a
 *   restored state repeats the run after the save, bit for bit, on the same
 *   runtime or a fresh one, with frame lengths that do not match the rate.
 * - `setPhysicsRate`: the step rate instead of the file's `Fps`.
 *
 * Synthetic files throughout; DeepSeek-chan's physics where available.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePhysics, writePhysics, type PhysicsFile } from "../src/anim/physics.js";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { ModelRuntime, type RuntimeOptions } from "../src/runtime/model-runtime.js";
import { loadModelFromDisk } from "../src/lib/node.js";
import { Synth } from "./support/synth.js";
import { DEEPSEEK, DEEPSEEK_SETTINGS, HAVE_DEEPSEEK } from "./support/deepseek.js";

const enc = (s: string) => new TextEncoder().encode(s);

/** Two pendulums: In swings the first, which drives Out1; Out1 swings the second, which drives Out2. */
const PHYSICS: PhysicsFile = {
  label: "synthetic",
  fps: 60,
  names: [
    { id: "S1", name: "first" },
    { id: "S2", name: "second" },
  ],
  effectiveForces: { gravity: { x: 0, y: -1 }, wind: { x: 0, y: 0 } },
  settings: [
    {
      id: "S1",
      inputs: [{ source: "In", weight: 100, type: "X", reflect: false }],
      outputs: [
        {
          destination: "Out1",
          vertexIndex: 1,
          scale: 1.5,
          weight: 100,
          type: "Angle",
          reflect: false,
        },
      ],
      particles: [
        { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
        { x: 0, y: 3, mobility: 0.95, delay: 0.9, acceleration: 1.5, radius: 3 },
        { x: 0, y: 6, mobility: 0.9, delay: 0.8, acceleration: 1.2, radius: 3 },
      ],
      position: { minimum: -10, default: 0, maximum: 10 },
      angle: { minimum: -10, default: 0, maximum: 10 },
    },
    {
      id: "S2",
      inputs: [
        { source: "Out1", weight: 60, type: "Angle", reflect: true },
        { source: "In", weight: 40, type: "X", reflect: false },
      ],
      outputs: [
        {
          destination: "Out2",
          vertexIndex: 2,
          scale: 2,
          weight: 80,
          type: "Angle",
          reflect: false,
        },
        { destination: "Out1", vertexIndex: 1, scale: 0.5, weight: 30, type: "X", reflect: true },
      ],
      particles: [
        { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
        { x: 0, y: 2, mobility: 0.85, delay: 0.95, acceleration: 0.8, radius: 2 },
        { x: 0, y: 4, mobility: 0.8, delay: 0.7, acceleration: 1, radius: 2 },
      ],
      position: { minimum: -5, default: 0, maximum: 5 },
      angle: { minimum: -20, default: 0, maximum: 20 },
    },
  ],
};

/** A model with parameters In, Out1 and Out2 and the physics above. */
function source(physics: string = writePhysics(PHYSICS)): MemoryFileSource {
  const s = new Synth(5);
  s.param("In", -10, 10, 0);
  s.param("Out1", -30, 30, 0);
  s.param("Out2", -30, 30, 0);
  const root = s.part({ id: "Root" });
  s.mesh({ id: "M", part: root, keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
  return new MemoryFileSource("synthetic", [
    [
      "m.model3.json",
      enc(
        JSON.stringify({
          Version: 3,
          FileReferences: { Moc: "m.moc3", Textures: [], Physics: "m.physics3.json" },
        }),
      ),
    ],
    ["m.moc3", s.build()],
    ["m.physics3.json", enc(physics)],
  ]);
}

/** The random and time-only effects off, so runs repeat exactly. */
async function quiet(rt: Promise<ModelRuntime>): Promise<ModelRuntime> {
  const r = await rt;
  for (const e of ["eyeBlink", "idle", "look", "breath"] as const) r.setEffect(e, false);
  return r;
}
const synthetic = (options: RuntimeOptions = {}) =>
  quiet(ModelRuntime.load(source(), undefined, options));

/** Frame f's input and length: In swinging, frames of 1/45 to 1/30 s (not the rate's 1/60). */
const input = (f: number) => 8 * Math.sin(f / 7) + 3 * Math.sin(f / 3);
const length = (f: number) => (f % 3 === 0 ? 1 / 30 : 1 / 45);

/** Every parameter's value after each of frames [from, to). */
function run(
  rt: ModelRuntime,
  from: number,
  to: number,
  drive: (f: number) => void = (f) => void rt.setParameter("In", input(f)),
) {
  const ids = rt.parameters.map((p) => p.id);
  const out: Float32Array[] = [];
  for (let f = from; f < to; f++) {
    drive(f);
    rt.update(length(f));
    out.push(Float32Array.from(ids, (id) => rt.getParameter(id)));
  }
  return out;
}

/** Whether two runs agree bit for bit. */
const same = (a: Float32Array[], b: Float32Array[]) =>
  a.length === b.length && a.every((x, i) => x.every((v, k) => Object.is(v, b[i]![k])));

describe("writePhysics", () => {
  it("writes text that parsePhysics reads back as the same data", () => {
    const text = writePhysics(PHYSICS);
    const back = parsePhysics(text, "synthetic");
    expect(back).toEqual(PHYSICS);
    // The Meta totals are counted, and the layout is the usual one.
    const json = JSON.parse(text);
    expect(Object.keys(json)).toEqual(["Version", "Meta", "PhysicsSettings"]);
    expect(json.Meta).toMatchObject({
      PhysicsSettingCount: 2,
      TotalInputCount: 3,
      TotalOutputCount: 3,
      VertexCount: 6,
      Fps: 60,
    });
    expect(json.PhysicsSettings[0].Input[0].Source).toEqual({ Target: "Parameter", Id: "In" });
    expect(text.split("\n")[1]).toBe('\t"Version": 3,');
    expect(writePhysics(PHYSICS, { indent: 2 }).split("\n")[1]).toBe('  "Version": 3,');
  });

  it("writes the default forces when the data has none", () => {
    const { effectiveForces: _, ...rest } = PHYSICS;
    const json = JSON.parse(writePhysics(rest));
    expect(json.Meta.EffectiveForces).toEqual({ Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } });
  });

  it("refuses numbers JSON cannot hold and unknown types, saying where", () => {
    const bad = structuredClone(PHYSICS);
    bad.settings[1]!.outputs[0]!.weight = NaN;
    expect(() => writePhysics(bad)).toThrow(/settings\[1\]\.outputs\[0\]\.weight is NaN/);
    const bad2 = structuredClone(PHYSICS);
    (bad2.settings[0]!.inputs[0] as { type: string }).type = "Z";
    expect(() => writePhysics(bad2)).toThrow(RangeError);
    const bad3 = structuredClone(PHYSICS);
    bad3.fps = Infinity;
    expect(() => writePhysics(bad3)).toThrow(/fps is Infinity/);
  });

  it.skipIf(!HAVE_DEEPSEEK)("gives DeepSeek-chan's physics file back byte for byte", () => {
    const path = join(DEEPSEEK, "大肥鱼.physics3.json");
    const text = readFileSync(path, "utf8");
    const file = parsePhysics(text, "deepseek");
    expect(writePhysics(file)).toBe(text);
    expect(file.settings).toHaveLength(131);
  });
});

describe("physics state save and restore", () => {
  it("continues bit for bit from a restored state, on the same runtime or a fresh one", async () => {
    const a = await synthetic();
    run(a, 0, 50);
    const state = a.savePhysicsState()!;
    const after = run(a, 50, 200);
    // The pendulums moved: a run from the start would not give these values.
    expect(new Set(after.map((v) => v[1])).size).toBeGreaterThan(100);
    a.restorePhysicsState(state);
    expect(same(run(a, 50, 200), after)).toBe(true);
    const b = await synthetic();
    b.restorePhysicsState(state);
    expect(same(run(b, 50, 200), after)).toBe(true);
    // The state is a copy: running on did not change it.
    const c = await synthetic();
    c.restorePhysicsState(state);
    expect(same(run(c, 50, 200), after)).toBe(true);
  });

  it("shows the saved pose in a frame of 0 s when holding physics in zero steps", async () => {
    const rt = await synthetic({ holdPhysicsInZeroSteps: true });
    const before = run(rt, 0, 40);
    const state = rt.savePhysicsState()!;
    run(rt, 40, 90);
    rt.restorePhysicsState(state);
    rt.setParameter("In", input(39));
    rt.update(0);
    const ids = rt.parameters.map((p) => p.id);
    const now = Float32Array.from(ids, (id) => rt.getParameter(id));
    expect(same([now], [before[39]!])).toBe(true);
  });

  it("refuses a state of other physics, and a model without physics", async () => {
    const rt = await synthetic();
    const state = rt.savePhysicsState()!;
    expect(state.format).toBe("mochi2d-physics-state/1");
    expect(() => rt.restorePhysicsState({ ...state, shape: [1, 2, 1, 3] })).toThrow(RangeError);
    expect(() => rt.restorePhysicsState({ ...state, data: state.data.subarray(1) })).toThrow(
      RangeError,
    );
    const one = structuredClone(PHYSICS);
    one.settings.pop();
    one.names.pop();
    const other = await quiet(ModelRuntime.load(source(writePhysics(one))));
    expect(() => other.restorePhysicsState(state)).toThrow(/other physics settings/);
    const s = new Synth(5);
    s.param("In", -10, 10, 0);
    const bare = await ModelRuntime.load(
      new MemoryFileSource("bare", [
        [
          "b.model3.json",
          enc(JSON.stringify({ Version: 3, FileReferences: { Moc: "b.moc3", Textures: [] } })),
        ],
        ["b.moc3", s.build()],
      ]),
    );
    expect(bare.savePhysicsState()).toBeNull();
    expect(() => bare.restorePhysicsState(state)).toThrow(/no physics/);
    expect(bare.physicsRate).toBe(0);
  });

  it.skipIf(!HAVE_DEEPSEEK)("continues DeepSeek-chan's 131 settings bit for bit", async () => {
    const load = () => quiet(loadModelFromDisk(DEEPSEEK_SETTINGS));
    const a = await load();
    const drive = (f: number) => {
      a.setParameter("AngleX", 30 * Math.sin(f / 9));
      a.setParameter("AngleZ", 20 * Math.sin(f / 13));
    };
    run(a, 0, 60, drive);
    const state = a.savePhysicsState()!;
    const after = run(a, 60, 160, drive);
    const b = await load();
    b.restorePhysicsState(state);
    const again = run(b, 60, 160, (f) => {
      b.setParameter("AngleX", 30 * Math.sin(f / 9));
      b.setParameter("AngleZ", 20 * Math.sin(f / 13));
    });
    expect(same(again, after)).toBe(true);
  });
});

describe("physics rate", () => {
  it("steps at the rate set instead of the file's Fps", async () => {
    const at = async (rate: number | null | undefined, options: RuntimeOptions = {}) => {
      const rt = await synthetic(options);
      if (rate !== undefined) rt.setPhysicsRate(rate);
      const ids = rt.parameters.map((p) => p.id);
      const out: Float32Array[] = [];
      for (let f = 0; f < 120; f++) {
        rt.setParameter("In", input(f));
        rt.update(1 / 60);
        out.push(Float32Array.from(ids, (id) => rt.getParameter(id)));
      }
      return { rt, out };
    };
    const file = await at(null);
    expect(file.rt.physicsRate).toBe(60);
    // Frames of 1/60 s: one step per frame at 60 steps per second, as at 0 (once per frame).
    const perFrame = await at(0);
    expect(perFrame.rt.physicsRate).toBe(0);
    expect(same(perFrame.out, file.out)).toBe(true);
    const fast = await at(240);
    expect(fast.rt.physicsRate).toBe(240);
    expect(same(fast.out, file.out)).toBe(false);
    // The option sets the same rate at load.
    const option = await at(undefined, { physicsRate: 240 });
    expect(option.rt.physicsRate).toBe(240);
    expect(same(option.out, fast.out)).toBe(true);
    fast.rt.setPhysicsRate(null);
    expect(fast.rt.physicsRate).toBe(60);
  });

  it("refuses rates below 0, above 1000 or not finite", async () => {
    const rt = await synthetic();
    for (const r of [-1, 1001, NaN, Infinity])
      expect(() => rt.setPhysicsRate(r), String(r)).toThrow(RangeError);
    expect(rt.physicsRate).toBe(60);
  });
});

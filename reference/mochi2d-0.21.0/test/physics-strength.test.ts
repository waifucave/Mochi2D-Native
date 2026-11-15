/**
 * Physics strength and wind at runtime (not reference behavior), on
 * DeepSeek-chan's 131 physics settings. A strength k makes each physics output
 * move its parameter by k times the way: strength 1 is the reference bit for
 * bit (however it is reached), 0 leaves the parameters as with physics off,
 * values in between and above follow the documented rule, and a setting's
 * strength times the model's applies to that setting only. Wind changes take
 * effect from the next physics step. A synthetic file checks the settings'
 * names: the dictionary's, or the ID with `named` false.
 */
import { describe, expect, it } from "vitest";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { loadModelFromDisk } from "../src/lib/node.js";
import { ModelRuntime, type RuntimeOptions } from "../src/runtime/model-runtime.js";
import { DEEPSEEK_SETTINGS, HAVE_DEEPSEEK } from "./support/deepseek.js";
import { Synth } from "./support/synth.js";

const fr = Math.fround;
const FRAMES = 240;

/** DeepSeek-chan with the random and time-only effects off, so runs repeat exactly. */
async function load(options: RuntimeOptions = {}): Promise<ModelRuntime> {
  const rt = await loadModelFromDisk(DEEPSEEK_SETTINGS, options);
  for (const e of ["eyeBlink", "idle", "look"] as const) rt.setEffect(e, false);
  return rt;
}

/** The model parameters that drive physics and are not written by it. */
function drivers(rt: ModelRuntime): string[] {
  const written = new Set(rt.physicsInputs.keys());
  const out = new Set<string>();
  for (const list of rt.physicsInputs.values())
    for (const d of list) if (!written.has(d.id)) out.add(d.id);
  return [...out];
}

/** Frame f's inputs: every driver swinging over its range. */
function drive(rt: ModelRuntime, ids: string[], f: number): void {
  ids.forEach((id, i) => {
    const p = rt.parameters.find((q) => q.id === id)!;
    const mid = (p.min + p.max) / 2;
    rt.setParameter(id, mid + ((p.max - p.min) / 2) * Math.sin(f / (17 + 3 * i)));
  });
}

/** Runs the runtimes in lockstep; calls `each` with every parameter's value per runtime. */
async function lockstep(
  runtimes: ModelRuntime[],
  each: (values: Float32Array[], f: number) => void,
  before?: (f: number) => void,
): Promise<void> {
  const ids = drivers(runtimes[0]!);
  const names = runtimes[0]!.parameters.map((p) => p.id);
  for (let f = 0; f < FRAMES; f++) {
    before?.(f);
    for (const rt of runtimes) {
      drive(rt, ids, f);
      rt.update(1 / 60);
    }
    each(
      runtimes.map((rt) => Float32Array.from(names, (id) => rt.getParameter(id))),
      f,
    );
  }
}

/** Indices of differing values (bit for bit). */
const differing = (a: Float32Array, b: Float32Array) =>
  [...a.keys()].filter((i) => !Object.is(a[i], b[i]));

/**
 * A setting none of whose destinations is another setting's input or another
 * setting's destination: its strength changes only its own outputs.
 */
function leafSetting(rt: ModelRuntime): { id: string; destinations: string[] } {
  const settings = rt.animator.physics!.file.settings;
  const inputs = new Set(settings.flatMap((s) => s.inputs.map((i) => i.source)));
  const count = new Map<string, number>();
  for (const s of settings)
    for (const o of s.outputs) count.set(o.destination, (count.get(o.destination) ?? 0) + 1);
  const known = new Set(rt.parameters.map((p) => p.id));
  const leaf = settings.find((s) =>
    s.outputs.every(
      (o) =>
        known.has(o.destination) && !inputs.has(o.destination) && count.get(o.destination) === 1,
    ),
  )!;
  return { id: leaf.id, destinations: leaf.outputs.map((o) => o.destination) };
}

/** A physics setting from parameter X to parameter Y. */
const setting = (id: string) => ({
  Id: id,
  Input: [{ Source: { Target: "Parameter", Id: "X" }, Weight: 100, Type: "X", Reflect: false }],
  Output: [
    {
      Destination: { Target: "Parameter", Id: "Y" },
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

describe("physics settings' names", () => {
  it("say whether the file's dictionary names a setting", async () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    s.param("X", -10, 10, 0);
    s.param("Y", -10, 10, 0);
    const source = MemoryFileSource.fromFiles({
      "m.model3.json": JSON.stringify({
        Version: 3,
        FileReferences: { Moc: "m.moc3", Textures: [], Physics: "m.physics3.json" },
      }),
      "m.moc3": s.build(),
      "m.physics3.json": JSON.stringify({
        Version: 3,
        Meta: {
          PhysicsSettingCount: 3,
          TotalInputCount: 3,
          TotalOutputCount: 3,
          VertexCount: 6,
          Fps: 30,
          EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
          PhysicsDictionary: [
            { Id: "Hair", Name: "Front hair" },
            { Id: "Blank", Name: "" },
          ],
        },
        PhysicsSettings: [setting("Hair"), setting("Tail"), setting("Blank")],
      }),
    });
    const rt = await ModelRuntime.load(source, "m.model3.json");
    expect(rt.physicsSettings).toEqual([
      { id: "Hair", name: "Front hair", named: true },
      { id: "Tail", name: "Tail", named: false },
      { id: "Blank", name: "", named: true },
    ]);
  });
});

describe.skipIf(!HAVE_DEEPSEEK)("physics strength and wind (DeepSeek-chan)", () => {
  it("lists the settings and validates strengths and wind", async () => {
    const rt = await load();
    expect(rt.physicsSettings).toHaveLength(131);
    expect(rt.physicsSettings[0]).toEqual({ id: "PhysicsSetting1", name: "OX", named: true });
    expect([rt.physicsStrength, rt.getPhysicsSettingStrength("PhysicsSetting1")]).toEqual([1, 1]);
    rt.setPhysicsStrength(-2); // limited to 0
    expect(rt.physicsStrength).toBe(0);
    expect(() => rt.setPhysicsStrength(NaN)).toThrow(RangeError);
    expect(() => rt.setPhysicsStrength(Infinity)).toThrow(RangeError);
    expect(rt.setPhysicsSettingStrength("PhysicsSetting2", 2.5)).toBe(true);
    expect(rt.setPhysicsSettingStrength("Nope", 0.5)).toBe(false);
    expect(rt.getPhysicsSettingStrength("Nope")).toBe(1);
    expect([...rt.physicsSettingStrengths]).toEqual([["PhysicsSetting2", 2.5]]);
    expect(rt.physicsWind).toEqual([0, 0]);
    rt.setPhysicsWind(0.25, -0.5);
    expect(rt.physicsWind).toEqual([0.25, -0.5]);
    expect(rt.animator.physics!.wind).toEqual([0.25, -0.5]);
    expect(() => rt.setPhysicsWind(NaN, 0)).toThrow(RangeError);
    // Other data for the model keeps them, by setting ID.
    const moc = new Uint8Array(await rt.source.read(rt.settings.moc));
    const next = await rt.withData(moc);
    expect([next.physicsStrength, next.getPhysicsSettingStrength("PhysicsSetting2")]).toEqual([
      0, 2.5,
    ]);
    expect(next.physicsWind).toEqual([0.25, -0.5]);
    rt.resetPhysicsStrengths();
    expect([rt.physicsStrength, rt.physicsSettingStrengths.size]).toEqual([1, 0]);
    // The wind option is the starting value.
    expect((await load({ animation: { wind: [0.5, 0] } })).physicsWind).toEqual([0.5, 0]);
  });

  it("strength 1 is the reference, bit for bit, however it is reached", async () => {
    const plain = await load();
    const set = await load();
    set.setPhysicsStrength(0.3);
    set.setPhysicsStrength(1);
    for (const s of set.physicsSettings) set.setPhysicsSettingStrength(s.id, 1);
    // 0.5 · 2 is exactly 1 for every setting.
    const product = await load();
    product.setPhysicsStrength(0.5);
    for (const s of product.physicsSettings) product.setPhysicsSettingStrength(s.id, 2);
    let moving = 0;
    await lockstep([plain, set, product], ([a, b, c], f) => {
      expect(differing(a!, b!), `frame ${f}`).toEqual([]);
      expect(differing(a!, c!), `frame ${f}`).toEqual([]);
      moving += Number(f > 0);
    });
    expect(moving).toBe(FRAMES - 1);
  });

  it("strength 0 leaves every parameter as with physics off", async () => {
    const off = await load();
    off.setEffect("physics", false);
    const zero = await load();
    zero.setPhysicsStrength(0);
    const settings0 = await load();
    for (const s of settings0.physicsSettings) settings0.setPhysicsSettingStrength(s.id, 0);
    const full = await load();
    let physicsMoves = false;
    await lockstep([off, zero, settings0, full], ([a, b, c, d], f) => {
      expect(differing(a!, b!), `frame ${f}`).toEqual([]);
      expect(differing(a!, c!), `frame ${f}`).toEqual([]);
      if (differing(a!, d!).length) physicsMoves = true;
    });
    expect(physicsMoves).toBe(true); // the comparison means something
  });

  it("a setting's strength scales only its own outputs: 0, a half and 3", async () => {
    const full = await load();
    const { id, destinations } = leafSetting(full);
    const names = full.parameters.map((p) => p.id);
    const at = destinations.map((d) => names.indexOf(d));
    const others = names.map((_, i) => i).filter((i) => !at.includes(i));
    const runs = await Promise.all([0, 0.5, 3].map(() => load()));
    runs.forEach((rt, j) => rt.setPhysicsSettingStrength(id, [0, 0.5, 3][j]!));
    let moved = 0;
    await lockstep([full, ...runs], ([r, zero, half, triple], f) => {
      // The other parameters are those of the reference run.
      for (const v of [zero!, half!, triple!])
        expect(
          others.filter((i) => !Object.is(v[i], r![i])),
          `frame ${f}`,
        ).toEqual([]);
      at.forEach((i, k) => {
        const p = full.parameters[i]!;
        const c = zero![i]!; // the value without this setting's output
        expect(c, `${destinations[k]} at strength 0`).toBe(fr(full.getParameterBase(p.id)));
        const ref = r![i]!;
        if (ref !== c) moved++;
        // Half the way, up to the float32 rounding of the reference value.
        expect(Math.abs(half![i]! - (c + (ref - c) / 2))).toBeLessThan(1e-5);
        // Three times the way, limited to the range.
        const e = Math.min(Math.max(c + (ref - c) * 3, p.min), p.max);
        expect(Math.abs(triple![i]! - e)).toBeLessThan(1e-4);
        expect(triple![i]! >= p.min && triple![i]! <= p.max).toBe(true);
      });
    });
    expect(moved).toBeGreaterThan(50);
  });

  it("wind changes take effect from the next physics step", async () => {
    // At one step per frame the frame shows the previous step's outputs (3n.3),
    // so a change made before frame 120's step shows from frame 121.
    const [a, b] = await Promise.all([load(), load()]);
    let differed = 0;
    await lockstep(
      [a, b],
      ([x, y], f) => {
        const d = differing(x!, y!).length;
        if (f <= 120) expect(d, `frame ${f}`).toBe(0);
        else if (d > 0) differed++;
      },
      (f) => {
        if (f === 120) b.setPhysicsWind(3, 0);
      },
    );
    expect(differed).toBe(FRAMES - 121);
  });
});

describe.skipIf(!HAVE_DEEPSEEK)("physics in frames that take no time (DeepSeek-chan)", () => {
  /** 60 moving frames, then the physics-driven parameters and their base values. */
  const run = async (hold: boolean) => {
    const rt = await load({ holdPhysicsInZeroSteps: hold });
    rt.setEffect("breath", false); // breath writes some of the same parameters
    const ids = drivers(rt);
    for (let f = 0; f < 60; f++) {
      drive(rt, ids, f);
      rt.update(1 / 60);
    }
    const driven = [...rt.physicsInputs.keys()];
    const last = driven.map((id) => rt.getParameter(id));
    rt.setParameter(ids[0]!, 0); // something changes while paused
    rt.update(0);
    return {
      driven,
      last,
      now: driven.map((id) => rt.getParameter(id)),
      base: driven.map((id) => rt.getParameterBase(id)),
      rt,
    };
  };

  it("by default, as the reference: no outputs, so the base values show", async () => {
    const r = await run(false);
    expect(r.now).toEqual(r.base);
    expect(r.now).not.toEqual(r.last);
  });

  it("with holdPhysicsInZeroSteps, the last outputs stay", async () => {
    const r = await run(true);
    expect(r.now).toEqual(r.last);
    r.rt.update(0);
    expect(r.driven.map((id) => r.rt.getParameter(id))).toEqual(r.last);
  });

  it("the hold does not change the frames that take time", async () => {
    const [a, b] = await Promise.all([
      load({ holdPhysicsInZeroSteps: true }),
      load({ holdPhysicsInZeroSteps: true }),
    ]);
    const ids = drivers(a);
    const names = a.parameters.map((p) => p.id);
    for (let f = 0; f < 90; f++) {
      for (const rt of [a, b]) {
        drive(rt, ids, f);
        rt.update(1 / 60);
      }
      if (f % 10 === 0) b.update(0);
      if (f % 10 === 0) continue; // b shows the held frame now; compare after the next real one
      const va = Float32Array.from(names, (id) => a.getParameter(id));
      const vb = Float32Array.from(names, (id) => b.getParameter(id));
      expect(differing(va, vb), `frame ${f}`).toEqual([]);
    }
  });
});

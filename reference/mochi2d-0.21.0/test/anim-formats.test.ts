/**
 * Format rules, defaults and edge cases of 3b–3i, 3l.4, 3s.1, 3t,
 * and known facts about DeepSeek-chan's own files.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AnimationFormatError,
  AnimationValues,
  MotionQueue,
  decodeWav,
  displayLabels,
  hitTest,
  parseDisplayInfo,
  parseExpression,
  parseMotion,
  parsePhysics,
  parseUserData,
  runAnimationScenario,
  vertexBounds,
  wrapValue,
} from "../src/anim/index.js";
import { parameterGroupIds, parseModelSettings } from "../src/core/settings/model-settings.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import {
  constant,
  deepseekModel,
  motionJson,
  only,
  settings,
  settingsS0,
  wav16,
} from "./support/anim.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
const dir = DEEPSEEK;
const model = deepseekModel();
const P = (id: string) => model.parameters.ids.indexOf(id);
const enc = (s: string) => new TextEncoder().encode(s);

describe("motion files (3c)", () => {
  const base = { duration: 1, fps: 10, curves: [constant("AngleX", 1, 1)] };

  it("defaults: fade times 1 when missing or negative; Duration 0; Fps 0", () => {
    const m = parseMotion(motionJson(base));
    expect([m.fadeIn, m.fadeOut]).toEqual([1, 1]);
    const n = parseMotion(motionJson({ ...base, fadeIn: -2, fadeOut: 0 }));
    expect([n.fadeIn, n.fadeOut]).toEqual([1, 0]);
    const json = JSON.parse(motionJson(base));
    delete json.Meta.Duration;
    delete json.Meta.Fps;
    const z = parseMotion(JSON.stringify(json));
    expect([z.duration, z.fps]).toEqual([0, 0]);
  });

  it("rejects wrong counts and unknown segment codes (3c.4)", () => {
    const json = JSON.parse(motionJson(base));
    for (const [key, delta] of [
      ["CurveCount", 1],
      ["TotalPointCount", 2],
      ["TotalSegmentCount", -1],
    ] as const) {
      const bad = structuredClone(json);
      bad.Meta[key] += delta;
      expect(() => parseMotion(JSON.stringify(bad)), key).toThrow(AnimationFormatError);
    }
    const code = structuredClone(json);
    code.Curves[0].Segments[2] = 4;
    expect(() => parseMotion(JSON.stringify(code))).toThrow(/segment code 4/);
  });

  it("applies only curves in Model, Parameter, PartOpacity order (3c.2)", () => {
    const m = parseMotion(
      motionJson({
        duration: 1,
        fps: 10,
        curves: [
          constant("A", 1, 1),
          { ...constant("EyeBlink", 1, 1), target: "Model" },
          constant("B", 1, 1),
          { ...constant("Part1", 1, 1), target: "PartOpacity" },
          constant("C", 1, 1),
        ],
      }),
    );
    expect(m.curves.map((c) => c.id)).toEqual(["A"]);
    expect(m.ignoredCurves).toBe(4);
  });

  it("a motion without Duration ends at its first frame; settings fades override only when ≥ 0", () => {
    const json = JSON.parse(motionJson(base));
    delete json.Meta.Duration;
    const frames = runAnimationScenario({
      model,
      settings: settings({
        motions: [{ group: "G", entries: [{ file: "m.json", fadeInTime: -2 }] }],
      }),
      files: new Map([["m.json", JSON.stringify(json)]]),
      steps: [0.1, 0.1],
      commands: [{ frame: 0, command: { kind: "startMotion", group: "G", index: 0 } }],
      effects: only(),
    });
    expect(frames[0]!.queueEmpty).toBe(true);
    // FadeInTime −2 in the entry kept the file's 1 s: at τ = 0 the weight is 0.
    expect(frames[0]!.parameters[P("AngleX")]).toBe(model.parameters.defaults[P("AngleX")]);
  });

  it("fires events in (T_prev − s, T − s], in array order", () => {
    const m = motionJson({
      ...base,
      fadeIn: 0,
      fadeOut: 0,
      events: [
        { time: 0, value: "start" },
        { time: 0.2, value: "a" },
        { time: 0.2, value: "b" },
        { time: 0.25, value: "c" },
      ],
    });
    const frames = runAnimationScenario({
      model,
      settings: settings(),
      files: new Map([["m.json", m]]),
      steps: [0.1, 0.1, 0.1, 0.1],
      commands: [{ frame: 0, command: { kind: "startMotion", file: "m.json" } }],
      effects: only(),
    });
    expect(frames.map((f) => f.events)).toEqual([["start"], [], ["a", "b"], ["c"]]);
  });
});

describe("motion priorities (3l.4)", () => {
  const motion = parseMotion(
    motionJson({ duration: 5, fps: 10, curves: [constant("AngleX", 1, 5)] }),
  );

  it("accepts a start when p = 3 or p > the current priority", () => {
    const q = new MotionQueue({ eyeBlink: [], lipSync: [] });
    const accepted = [1, 1, 2, 2, 3, 1].map((p) => q.start(motion, { priority: p }));
    expect(accepted).toEqual([true, false, true, false, true, false]);
    expect(q.currentPriority).toBe(3);
    expect(q.size).toBe(3);
  });

  it("drops an accepted start of an invalid file without changing the priority", () => {
    const q = new MotionQueue({ eyeBlink: [], lipSync: [] });
    expect(q.start(null, { priority: 2 })).toBe(false);
    expect(q.currentPriority).toBe(0);
  });

  it("returns to priority 0 when an advance leaves the queue empty", () => {
    const short = parseMotion(
      motionJson({ duration: 0.1, fps: 10, curves: [constant("AngleX", 1, 0.1)] }),
    );
    const q = new MotionQueue({ eyeBlink: [], lipSync: [] });
    q.start(short, { priority: 2 });
    const v = new AnimationValues(model);
    q.advance(0.1, v);
    q.advance(0.1, v);
    expect(q.empty).toBe(true);
    expect(q.currentPriority).toBe(0);
  });
});

describe("values (3g)", () => {
  it("limits by default; wraps repeating parameters in wrap mode", () => {
    expect(wrapValue(47, 0, 30)).toBe(17);
    expect(wrapValue(-12, 0, 30)).toBe(18);
    const v = new AnimationValues(model);
    const i = P("AniEyerolling");
    expect(v.repeat[i]).toBe(1);
    v.setAt(i, 47);
    expect(v.values[i]).toBe(30);
    v.wrap = true;
    v.setAt(i, 47);
    expect(v.values[i]).toBe(17);
  });

  it("lets NaN through the limit, and keeps free values unlimited and persistent", () => {
    const v = new AnimationValues(model);
    v.setAt(P("ParamAngleX"), NaN);
    expect(v.values[P("ParamAngleX")]).toBeNaN();
    v.set("NotAParameter", 1e6);
    v.restore();
    expect(v.get("NotAParameter")).toBe(1e6);
  });

  it("blends after limiting, and stores float32", () => {
    const v = new AnimationValues(model);
    const i = P("ParamAngleX"); // range −30…30
    v.values[i] = 10;
    v.setAt(i, 100, 0.5); // limit to 30, then 10·0.5 + 30·0.5
    expect(v.values[i]).toBe(20);
    v.setAt(i, 0.1);
    expect(v.values[i]).toBe(Math.fround(0.1));
  });
});

describe("expressions (3d)", () => {
  it("defaults Value to 0 and unknown blends to Add; keeps negative fade-ins", () => {
    const e = parseExpression(
      JSON.stringify({
        FadeInTime: -1,
        Parameters: [{ Id: "A" }, { Id: "B", Value: 2, Blend: "Screen" }],
      }),
    );
    expect(e.fadeIn).toBe(-1);
    expect(e.fadeOut).toBe(1);
    expect(e.parameters).toEqual([
      { id: "A", value: 0, blend: "Add" },
      { id: "B", value: 2, blend: "Add" },
    ]);
  });

  it("an expression with a negative fade-in never gains weight", () => {
    const frames = runAnimationScenario({
      model,
      settings: settings(),
      files: new Map([
        ["e.json", JSON.stringify({ FadeInTime: -1, Parameters: [{ Id: "AngleX", Value: 10 }] })],
      ]),
      steps: new Array(20).fill(0.1),
      commands: [{ frame: 0, command: { kind: "startExpression", file: "e.json" } }],
      effects: only("expressions"),
    });
    for (const f of frames) expect(f.parameters[P("AngleX")]).toBe(0);
  });
});

describe("physics (3e, 3n)", () => {
  const physics = parsePhysics(readFileSync(join(dir, "大肥鱼.physics3.json")));

  it("matches DeepSeek-chan's physics facts (3e.2)", () => {
    expect(physics.fps).toBe(60);
    expect(physics.settings).toHaveLength(131);
    const inputs = physics.settings.flatMap((s) => s.inputs);
    const outputs = physics.settings.flatMap((s) => s.outputs);
    expect([inputs.length, outputs.length]).toEqual([299, 292]);
    expect(physics.settings.reduce((a, s) => a + s.particles.length, 0)).toBe(431);
    expect(new Set(inputs.map((i) => i.type))).toEqual(new Set(["X", "Angle"]));
    expect(new Set(outputs.map((o) => o.type))).toEqual(new Set(["Angle"]));
    for (const i of inputs) expect(P(i.source), i.source).toBeGreaterThanOrEqual(0);
    for (const o of outputs) expect(P(o.destination), o.destination).toBeGreaterThanOrEqual(0);
    for (const s of physics.settings)
      for (const o of s.outputs) {
        expect(o.vertexIndex).toBeGreaterThanOrEqual(1);
        expect(o.vertexIndex).toBeLessThan(s.particles.length);
      }
    const first = physics.settings[0]!;
    expect([
      first.inputs[0]!.source,
      first.outputs[0]!.destination,
      first.outputs[0]!.weight,
    ]).toEqual(["AngleX", "ParamAngleX", 100]);
  });

  it("rejects files whose Meta totals disagree with their arrays", () => {
    const json = JSON.parse(
      readFileSync(join(dir, "大肥鱼.physics3.json"), "utf8").replace(/^﻿/, ""),
    );
    json.Meta.TotalOutputCount += 1;
    expect(() => parsePhysics(JSON.stringify(json))).toThrow(AnimationFormatError);
  });

  it("writes nothing on zero steps; outputs at invalid vertex indices drive their parameter to 0", () => {
    const rig = (vertexIndex: number) =>
      JSON.stringify({
        Meta: {
          PhysicsSettingCount: 1,
          TotalInputCount: 1,
          TotalOutputCount: 1,
          VertexCount: 2,
          Fps: 0,
        },
        PhysicsSettings: [
          {
            Input: [{ Source: { Id: "AngleX" }, Weight: 100, Type: "X", Reflect: false }],
            Output: [
              {
                Destination: { Id: "ParamAngleZ" },
                VertexIndex: vertexIndex,
                Scale: 20,
                Weight: 100,
                Type: "Angle",
              },
            ],
            Vertices: [
              { Position: { X: 0, Y: 0 }, Mobility: 1, Delay: 1, Acceleration: 1, Radius: 0 },
              {
                Position: { X: 0, Y: 10 },
                Mobility: 0.95,
                Delay: 0.9,
                Acceleration: 1.5,
                Radius: 10,
              },
            ],
            Normalization: {
              Position: { Minimum: -10, Default: 0, Maximum: 10 },
              Angle: { Minimum: -10, Default: 0, Maximum: 10 },
            },
          },
        ],
      });
    const run = (vertexIndex: number, steps: number[]) =>
      runAnimationScenario({
        model,
        settings: settings({ physics: "p.json" }),
        files: new Map([
          ["p.json", rig(vertexIndex)],
          [
            "m.json",
            motionJson({
              duration: 5,
              fps: 10,
              fadeIn: 0,
              fadeOut: 0,
              curves: [constant("ParamAngleZ", 7, 5), constant("AngleX", 30, 5)],
            }),
          ],
        ]),
        steps,
        commands: [{ frame: 0, command: { kind: "startMotion", file: "m.json" } }],
        effects: only("physics"),
      });
    // Zero steps: the motion's value stays (physics writes nothing).
    expect(run(1, [0, 0])[1]!.parameters[P("ParamAngleZ")]).toBe(7);
    // Vertex index 0 or 9: the output is skipped but still writes its 0.
    for (const j of [0, 9])
      expect(run(j, [0.1, 0.1])[1]!.parameters[P("ParamAngleZ")], `index ${j}`).toBe(0);
  });
});

describe("pose and free values (3o, 3g.3)", () => {
  it("a PartOpacity curve writes the free value named after the part, which persists", () => {
    const frames = runAnimationScenario({
      model,
      settings: settings(),
      files: new Map([
        [
          "m.json",
          motionJson({
            duration: 0.2,
            fps: 10,
            fadeIn: 0,
            fadeOut: 0,
            curves: [
              {
                target: "PartOpacity",
                id: "Part99",
                first: [0, 0.25],
                segments: [["linear", 0.2, 0.25]],
              },
            ],
          }),
        ],
      ]),
      steps: new Array(6).fill(0.1),
      commands: [{ frame: 0, command: { kind: "startMotion", file: "m.json" } }],
      effects: only(),
      record: { freeValues: ["Part99"] },
    });
    for (const f of frames) expect(f.freeValues.Part99).toBe(0.25);
    // The part's opacity itself is untouched without a pose.
    for (const f of frames) expect(f.partOpacities[model.parts.ids.indexOf("Part99")]).toBe(1);
  });
});

describe("lip sync and WAV files (3s)", () => {
  const header = (format: number, bits: number, channels: number, extra: Uint8Array[] = []) => {
    const pcm = wav16([0.5, -0.5], 8000, 1);
    const b = new Uint8Array(pcm);
    const dv = new DataView(b.buffer);
    dv.setUint16(20, format, true);
    dv.setUint16(22, channels, true);
    dv.setUint16(34, bits, true);
    if (!extra.length) return b;
    const out = new Uint8Array(b.length + extra.reduce((a, e) => a + e.length, 0));
    out.set(b.subarray(0, 36));
    let o = 36;
    for (const e of extra) {
      out.set(e, o);
      o += e.length;
    }
    out.set(b.subarray(36), o);
    return out;
  };

  it("decodes 8-, 16- and 24-bit PCM with the 2³¹ − 1 scale; skips chunks before data", () => {
    const w16 = decodeWav(wav16([0.5, -0.25], 8000));
    // Stored as float32 (C15).
    expect(w16.samples[0]![0]).toBe(Math.fround((Math.round(0.5 * 32767) * 65536) / 2147483647));
    const list = new Uint8Array([...enc("LIST"), 4, 0, 0, 0, 1, 2, 3, 4]);
    expect(decodeWav(header(1, 16, 1, [list])).frames).toBe(2);
    // 8-bit: bytes 0x80 ± … around 128.
    const w8 = header(1, 8, 1);
    new DataView(w8.buffer).setUint8(44, 0xc0);
    expect(decodeWav(w8).samples[0]![0]).toBe(Math.fround((64 * 16777216) / 2147483647));
    // 24-bit, two bytes of data → no whole frame of 3 bytes.
    expect(decodeWav(header(1, 24, 1)).frames).toBe(1);
  });

  it("refuses non-PCM formats and reads 32-bit samples as silence", () => {
    expect(() => decodeWav(header(3, 16, 1))).toThrow(/format code 3/);
    const s32 = decodeWav(header(1, 32, 1));
    expect(Array.from(s32.samples[0]!)).toEqual([0]);
  });

  it("pools channels and skips the write when a frame covers no sample", () => {
    const stereo = wav16([0.5, 0.5, -0.5, -0.5, 0.5, 0.5], 8000, 2);
    const frames = runAnimationScenario({
      model,
      settings: settingsS0(),
      files: new Map([["s.wav", stereo]]),
      steps: [0, 1 / 8000, 1 / 8000],
      commands: [{ frame: 0, command: { kind: "startSound", file: "s.wav" } }],
      effects: only("lipSync"),
    });
    expect(frames[0]!.lipSync).toBeNaN();
    expect(frames[0]!.parameters[P("ParamMouthOpenY")]).toBe(0);
    expect(frames[1]!.lipSync).toBe(Math.fround((Math.round(0.5 * 32767) * 65536) / 2147483647));
  });
});

describe("hit testing (3t) on DeepSeek-chan at the default pose", () => {
  const inst = new ModelInstance(model);
  inst.evaluate();
  const ids = model.meshes.ids;
  const box = (id: string) => vertexBounds(inst.drawableVertices[ids.indexOf(id)]!);

  it("has the documented boxes", () => {
    const b94 = box("ArtMesh94");
    const b263 = box("ArtMesh263");
    for (const [got, want] of [
      [b94.minX, -0.01813485],
      [b94.maxX, 0.01862616],
      [b94.minY, 0.5563099],
      [b94.maxY, 0.5669889],
      [b263.minX, -0.008441252],
      [b263.maxX, 0.008175614],
      [b263.minY, 0.5472512],
      [b263.maxY, 0.5592177],
    ] as const)
      // Evaluation itself agrees with the official runtime within the static-evaluation tolerance.
      expect(Math.abs(got - want)).toBeLessThanOrEqual(2e-5);
  });

  it("hits inclusively on the exact corners, misses just outside, ignores visibility", () => {
    const hit = (id: string, x: number, y: number) => hitTest(ids, inst.drawableVertices, id, x, y);
    const a = box("ArtMesh94");
    const b = box("ArtMesh263");
    expect(hit("ArtMesh94", a.maxX, a.maxY)).toBe(true);
    expect(hit("ArtMesh94", a.minX, a.minY)).toBe(true);
    expect(hit("ArtMesh94", a.maxX + 1e-6, (a.minY + a.maxY) / 2)).toBe(false);
    expect(inst.drawableVisible[ids.indexOf("ArtMesh263")]).toBe(0);
    expect(hit("ArtMesh263", (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2)).toBe(true);
    expect(hit("ArtMesh263", (b.minX + b.maxX) / 2, b.minY - 1e-6)).toBe(false);
    expect(hit("NoSuchMesh", 0, 0)).toBe(false);
  });
});

describe("DeepSeek-chan's files (3b, 3c.1, 3d, 3i)", () => {
  const s = parseModelSettings(readFileSync(join(dir, "大肥鱼.model3.json")));

  it("settings: EyeBlink pair, empty LipSync, no hit areas, layout, motions or expressions", () => {
    expect(parameterGroupIds(s, "EyeBlink")).toEqual(["ParamEyeROpen", "ParamEyeLOpen"]);
    expect(parameterGroupIds(s, "LipSync")).toEqual([]);
    expect([s.hitAreas, s.layout, s.motions, s.expressions]).toEqual([[], {}, [], []]);
    expect(s.physics).toBeDefined();
    expect(s.displayInfo).toBeDefined();
  });

  it("8 motions: Fps 60, not restricted, no fade times; 23 expressions: Add, no fade times", () => {
    const motions = readdirSync(join(dir, "Animation")).filter((f) => f.endsWith(".motion3.json"));
    expect(motions).toHaveLength(8);
    for (const f of motions) {
      const raw = JSON.parse(readFileSync(join(dir, "Animation", f), "utf8").replace(/^﻿/, ""));
      expect(raw.Meta.Loop, f).toBe(true);
      const m = parseMotion(readFileSync(join(dir, "Animation", f)), f);
      expect([m.fps, m.restricted, m.fadeIn, m.fadeOut], f).toEqual([60, false, 1, 1]);
    }
    const exps = readdirSync(join(dir, "Exp3")).filter((f) => f.endsWith(".exp3.json"));
    expect(exps).toHaveLength(23);
    for (const f of exps) {
      const e = parseExpression(readFileSync(join(dir, "Exp3", f)), f);
      expect([e.fadeIn, e.fadeOut], f).toEqual([1, 1]);
      for (const p of e.parameters) expect(p.blend, f).toBe("Add");
    }
  });

  it("display info: 509 named parameters in model order, 40 repeated names, 21 flat groups, Part160", () => {
    const info = parseDisplayInfo(readFileSync(join(dir, s.displayInfo!)));
    expect(info.parameters.map((p) => p.id)).toEqual([...model.parameters.ids]);
    expect(info.parameters.every((p) => p.name !== "")).toBe(true);
    // "40 names appear more than once": 509 entries carry 469 distinct names.
    expect(new Set(info.parameters.map((p) => p.name)).size).toBe(509 - 40);
    expect(info.parameters.find((p) => p.id === "ParamBreath")!.groupId).toBe("");
    expect(info.parameterGroups).toHaveLength(21);
    expect(info.parameterGroups.every((g) => g.groupId === "")).toBe(true);
    expect(info.parts).toHaveLength(148);
    expect(model.parts.ids).not.toContain("Part160");
    expect(info.parts.find((p) => p.id === "Part160")!.name).toBe("组 1");
    expect(info.combinedParameters).toEqual([]);
    // B3: one label per model part (Part160 ignored), IDs as fallback.
    const parts = displayLabels(model.parts.ids, info, "parts");
    expect(parts).toHaveLength(147);
    const params = displayLabels(model.parameters.ids, info, "parameters");
    expect(params.find((p) => p.id === "ParamBreath")!.group).toBeUndefined();
  });
});

describe("user data (3h)", () => {
  it("takes UserDataCount entries, keeps all targets, lists art meshes separately", () => {
    const u = parseUserData(
      JSON.stringify({
        Meta: { UserDataCount: 2 },
        UserData: [
          { Target: "ArtMesh", Id: "ArtMesh1", Value: "a" },
          { Target: "Part", Id: "Part1", Value: "b" },
          { Target: "ArtMesh", Id: "ArtMesh2", Value: "c" },
        ],
      }),
    );
    expect(u.all.map((e) => e.value)).toEqual(["a", "b"]);
    expect(u.artMeshes.map((e) => e.id)).toEqual(["ArtMesh1"]);
    expect(() =>
      parseUserData(JSON.stringify({ Meta: { UserDataCount: 2 }, UserData: [] })),
    ).toThrow(AnimationFormatError);
  });
});

describe("model settings (3b)", () => {
  it("reads only lower-case layout keys, motion entry overrides and the first group of a name", () => {
    const s = parseModelSettings(
      enc(
        JSON.stringify({
          FileReferences: {
            Moc: "m.moc3",
            Motions: {
              Idle: [{ File: "a.json", FadeInTime: -2, FadeOutTime: 0.5, Sound: "a.wav" }],
            },
            Expressions: [{ Name: "smile", File: "s.exp3.json" }],
          },
          Groups: [
            { Target: "Parameter", Name: "EyeBlink", Ids: ["A"] },
            { Target: "Parameter", Name: "EyeBlink", Ids: ["B"] },
          ],
          Layout: { width: 3, center_x: 0.5, Y: 1 },
        }),
      ),
    );
    expect(s.layout).toEqual({ width: 3, center_x: 0.5 });
    expect(s.motions[0]!.entries[0]).toEqual({
      file: "a.json",
      fadeInTime: -2,
      fadeOutTime: 0.5,
      sound: "a.wav",
    });
    expect(parameterGroupIds(s, "EyeBlink")).toEqual(["A"]);
    expect(s.expressions).toEqual([{ name: "smile", file: "s.exp3.json" }]);
  });
});

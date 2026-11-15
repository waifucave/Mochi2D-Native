/**
 * The worked examples and test vectors of 3x (V1–V10 and D1), run
 * through the programmatic scenario API. Crafted inputs are generated here on
 * DeepSeek-chan's model file; D1 reads DeepSeek-chan's own files.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAnimationScenario, type AnimationScenario } from "../src/anim/scenario.js";
import { parseModelSettings } from "../src/core/settings/model-settings.js";
import {
  constant,
  deepseekModel,
  expect7,
  motionJson,
  only,
  settings,
  settingsS0,
  wav16,
} from "./support/anim.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const model = deepseekModel();
const P = (id: string) => {
  const i = model.parameters.ids.indexOf(id);
  if (i < 0) throw new Error(`no parameter ${id}`);
  return i;
};
const steps = (n: number, dt: number) => new Array<number>(n).fill(dt);
const start = (file: string, extra: Record<string, unknown> = {}) => ({
  frame: 0,
  command: { kind: "startMotion" as const, file, ...extra },
});

/** Runs a scenario and checks a table: frame → { parameter ID: value }. */
function checkTable(
  sc: AnimationScenario,
  table: Record<number, Record<string, number>>,
  label: string,
) {
  const frames = runAnimationScenario(sc);
  for (const [f, row] of Object.entries(table))
    for (const [id, want] of Object.entries(row))
      expect7(frames[Number(f)]!.parameters[P(id)]!, want, `${label} frame ${f} ${id}`);
  return frames;
}

const v1Motion = (restricted: boolean) =>
  motionJson({
    duration: 2,
    fps: 10,
    restricted,
    fadeIn: 0,
    fadeOut: 0,
    curves: [
      {
        id: "AngleX",
        first: [0, 0],
        segments: [
          ["linear", 1, 20],
          ["linear", 2, -10],
        ],
      },
      {
        id: "AngleY",
        first: [0, 0],
        segments: [
          ["bezier", 0.3, 10, 0.7, 10, 1, 0],
          ["bezier", 1.2, -20, 1.9, 30, 2, 0],
        ],
      },
      {
        id: "AngleZ",
        first: [0, -10],
        segments: [
          ["bezier", 1.4, 20, -0.4, -20, 1, 10],
          ["linear", 2, 0],
        ],
      },
      {
        id: "PositionX",
        first: [0, 0],
        segments: [
          ["stepped", 0.5, 5],
          ["stepped", 1.5, -5],
          ["linear", 2, 3],
        ],
      },
      {
        id: "PositionY",
        first: [0, 0],
        segments: [
          ["inverse", 0.5, 5],
          ["inverse", 1.5, -5],
          ["linear", 2, 3],
        ],
      },
    ],
  });

describe("animation vectors (3x)", () => {
  it("V1: curve evaluation, all segment kinds, solved Béziers", () => {
    const rows: [number, number, number, number, number][] = [
      [0, 0, -10, 0, 5],
      [2.5, 3.46986, -7.32574, 0, 5],
      [5, 5.761136, -4.663037, 0, 5],
      [7.5, 7.072513, -2.020309, 0, 5],
      [10, 7.5, -0.5740992, 5, -5],
      [12.5, 7.072513, 2.020309, 5, -5],
      [15, 5.761136, 4.663037, 5, -5],
      [17.5, 3.46986, 7.32574, 5, -5],
      [20, 0, 10, 5, -5],
      [16.25, -4.813671, 8.75, 5, -5],
      [12.5, -3.838139, 7.5, 5, -5],
      [8.75, -0.9582249, 6.25, 5, -5],
      [5, 2.640918, 5, -5, -5],
      [1.25, 6.232939, 3.75, -3, -3],
      [-2.5, 9.046979, 2.5, -1, -1],
      [-6.25, 9.62365, 1.25, 1, 1],
      [-10, 0, 0, 3, 3],
      [-10, 0, 0, 3, 3],
    ];
    const table: Record<number, Record<string, number>> = {};
    rows.forEach(([ax, ay, az, px, py], f) => {
      table[f] = { AngleX: ax, AngleY: ay, AngleZ: az, PositionX: px, PositionY: py };
    });
    const frames = checkTable(
      {
        model,
        settings: settingsS0(),
        files: new Map([["v1.motion3.json", v1Motion(false)]]),
        steps: steps(18, 0.125),
        commands: [start("v1.motion3.json")],
        effects: only(),
      },
      table,
      "V1",
    );
    // The motion finishes at frame 16; frame 17 keeps its values.
    expect(frames[16]!.motionUpdated).toBe(true);
    expect(frames[16]!.queueEmpty).toBe(true);
    expect(frames[17]!.motionUpdated).toBe(false);
  });

  it("V1r: the same file in restricted mode", () => {
    const ay = [0, 3.28125, 5.625, 7.03125, 7.5, 7.03125, 5.625, 3.28125, 0, -4.511719];
    const az = [-10, -1.757813, 1.5625, 1.601563, 0, -1.601563, -1.5625, 1.757813, 10, 8.75];
    const table: Record<number, Record<string, number>> = {};
    ay.forEach((y, f) => (table[f] = { AngleY: y, AngleZ: az[f]! }));
    checkTable(
      {
        model,
        settings: settingsS0(),
        files: new Map([["v1r.motion3.json", v1Motion(true)]]),
        steps: steps(10, 0.125),
        commands: [start("v1r.motion3.json")],
        effects: only(),
      },
      table,
      "V1r",
    );
  });

  it("V2: fades and a cross-fade", () => {
    const a = motionJson({
      duration: 3,
      fps: 10,
      fadeIn: 0.5,
      fadeOut: 1,
      curves: [constant("AngleX", 20, 3), { ...constant("AngleY", 20, 3), fadeIn: 0.25 }],
    });
    const b = motionJson({
      duration: 2,
      fps: 10,
      fadeIn: 0.5,
      fadeOut: 0.5,
      curves: [constant("AngleX", -10, 2)],
    });
    const sc = (priority: number): AnimationScenario => ({
      model,
      settings: settingsS0(),
      files: new Map([
        ["a.motion3.json", a],
        ["b.motion3.json", b],
      ]),
      steps: steps(18, 0.125),
      commands: [
        start("a.motion3.json"),
        { frame: 12, command: { kind: "startMotion", file: "b.motion3.json", priority } },
      ],
      effects: only(),
    });
    const rows: [number, number, number][] = [
      [0, 0, 0],
      [1, 2.928932, 10],
      [2, 11.46447, 20],
      [3, 18.75, 20],
      [4, 20, 20],
      [12, 20, 20],
      [13, 15.6066, 20],
      [14, 4.678301, 20],
      [15, -6.299172, 20],
      [16, -10, 20],
      [17, -10, 20],
    ];
    checkTable(
      sc(3),
      Object.fromEntries(rows.map(([f, x, y]) => [f, { AngleX: x, AngleY: y }])),
      "V2",
    );
    // With priority 2, B would have been refused.
    const refused = runAnimationScenario(sc(2));
    expect7(refused[16]!.parameters[P("AngleX")]!, 20, "V2 with priority 2, frame 16");
  });

  it("V3: looping and the end interval", () => {
    const m = motionJson({
      duration: 1,
      fps: 4,
      fadeIn: 0,
      fadeOut: 0,
      curves: [
        { id: "AngleX", first: [0, 0], segments: [["linear", 0.75, 30]] },
        { id: "AngleY", first: [0, -20], segments: [["stepped", 0.75, 20]] },
      ],
    });
    const ax = [25, 27.5, 30, 26.25, 22.5, 18.75, 15, 11.25, 7.5, 3.75, 30, 2.5, 5, 7.5];
    const ay = [-20, -20, 20, 20, 20, 20, 20, 20, 20, 20, 20, -20, -20, -20];
    const table: Record<number, Record<string, number>> = {};
    ax.forEach((x, k) => (table[10 + k] = { AngleX: x, AngleY: ay[k]! }));
    checkTable(
      {
        model,
        settings: settingsS0(),
        files: new Map([["loop.motion3.json", m]]),
        steps: steps(24, 0.0625),
        commands: [start("loop.motion3.json", { loop: true })],
        effects: only(),
      },
      table,
      "V3",
    );
  });

  it("V4: expressions over a base motion", () => {
    const base = motionJson({
      duration: 10,
      fps: 10,
      fadeIn: 0,
      fadeOut: 0,
      curves: [constant("AngleX", 6, 10), constant("AngleY", -6, 10)],
    });
    const e1 = JSON.stringify({
      Type: "Live2D Expression",
      FadeInTime: 0.5,
      FadeOutTime: 0.5,
      Parameters: [
        { Id: "AngleX", Value: 10, Blend: "Add" },
        { Id: "AngleY", Value: 15, Blend: "Overwrite" },
      ],
    });
    const e2 = JSON.stringify({
      Type: "Live2D Expression",
      FadeInTime: 0.5,
      FadeOutTime: 0.5,
      Parameters: [{ Id: "AngleX", Value: 0.5, Blend: "Multiply" }],
    });
    const rows: [number, number, number][] = [
      [0, 6, -6],
      [1, 7.464466, -2.924621],
      [2, 11, 4.5],
      [3, 14.53553, 11.92462],
      [4, 16, 15],
      [8, 16, -6],
      [9, 13.47119, -6],
      [10, 8.25, -6],
      [11, 4.278806, -6],
      [12, 3, -6],
      [13, 3, -6],
    ];
    checkTable(
      {
        model,
        settings: settingsS0(),
        files: new Map([
          ["base.motion3.json", base],
          ["e1.exp3.json", e1],
          ["e2.exp3.json", e2],
        ]),
        steps: steps(14, 0.125),
        commands: [
          start("base.motion3.json"),
          { frame: 0, command: { kind: "startExpression", file: "e1.exp3.json" } },
          { frame: 8, command: { kind: "startExpression", file: "e2.exp3.json" } },
        ],
        effects: only("expressions"),
      },
      Object.fromEntries(rows.map(([f, x, y]) => [f, { AngleX: x, AngleY: y }])),
      "V4",
    );
  });

  it("V5: physics, with its one-step lag and output interpolation", () => {
    const physics = JSON.stringify({
      Version: 3,
      Meta: {
        PhysicsSettingCount: 1,
        TotalInputCount: 1,
        TotalOutputCount: 1,
        VertexCount: 2,
        Fps: 30,
        EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
        PhysicsDictionary: [{ Id: "PhysicsSetting1", Name: "V5" }],
      },
      PhysicsSettings: [
        {
          Id: "PhysicsSetting1",
          Input: [
            {
              Source: { Target: "Parameter", Id: "AngleX" },
              Weight: 100,
              Type: "X",
              Reflect: false,
            },
          ],
          Output: [
            {
              Destination: { Target: "Parameter", Id: "AngleZ" },
              VertexIndex: 1,
              Scale: 20,
              Weight: 100,
              Type: "Angle",
              Reflect: false,
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
    const hold = motionJson({
      duration: 4,
      fps: 10,
      fadeIn: 0,
      fadeOut: 0,
      curves: [constant("AngleX", 30, 4)],
    });
    const az = [
      0, 0, -7.281898, -14.5638, -12.34633, -10.12886, -7.800293, -5.471725, -3.300618, -1.129511,
      0.6992074, 2.527926, 6.15521, 7.763712, 7.076476, 5.057158, 2.277563, -0.39957,
    ];
    checkTable(
      {
        model,
        settings: settings({ physics: "v5.physics3.json" }),
        files: new Map([
          ["v5.physics3.json", physics],
          ["hold.motion3.json", hold],
        ]),
        steps: [...steps(12, 1 / 60), ...steps(6, 0.05)],
        commands: [start("hold.motion3.json")],
        effects: only("physics"),
      },
      Object.fromEntries(az.map((z, f) => [f, { AngleZ: z }])),
      "V5",
    );
  });

  it("V6: pose, with link parts and the 0.15 cap", () => {
    const pose = JSON.stringify({
      Type: "Live2D Pose",
      FadeInTime: 0.5,
      Groups: [
        [
          { Id: "Part99", Link: ["Part64"] },
          { Id: "Part116", Link: [] },
        ],
      ],
    });
    const m = motionJson({
      duration: 3,
      fps: 10,
      fadeIn: 0,
      fadeOut: 0,
      curves: [
        {
          target: "PartOpacity",
          id: "Part116",
          first: [0, 0],
          segments: [
            ["stepped", 1, 1],
            ["linear", 3, 1],
          ],
        },
        {
          target: "PartOpacity",
          id: "Part99",
          first: [0, 1],
          segments: [
            ["stepped", 1, 0],
            ["linear", 3, 0],
          ],
        },
      ],
    });
    const frames = runAnimationScenario({
      model,
      settings: settings({ pose: "v6.pose3.json" }),
      files: new Map([
        ["v6.pose3.json", pose],
        ["v6.motion3.json", m],
      ]),
      steps: steps(17, 0.1),
      commands: [start("v6.motion3.json")],
      effects: only("pose"),
    });
    const part = (id: string) => model.parts.ids.indexOf(id);
    const p99 = [1, 1, 0.8125, 0.75, 0.625, 0.2499999, 0, 0];
    const p116 = [0, 0, 0.2, 0.4, 0.6, 0.8, 1, 1];
    p99.forEach((want, k) => {
      const f = frames[9 + k]!;
      expect7(f.partOpacities[part("Part99")]!, want, `V6 frame ${9 + k} Part99`);
      expect7(f.partOpacities[part("Part64")]!, want, `V6 frame ${9 + k} Part64`);
      expect7(f.partOpacities[part("Part116")]!, p116[k]!, `V6 frame ${9 + k} Part116`);
    });
  });

  it("V7: eye blink with the random sequence (0.25, 0.75)", () => {
    const want = [1, 1, 1, 0.5, 0, 0, 0.3333333, 0.6666667, 1, 1];
    checkTable(
      {
        model,
        settings: settingsS0(),
        files: new Map(),
        steps: steps(43, 0.05),
        random: [0.25, 0.75],
        effects: only("eyeBlink"),
      },
      Object.fromEntries(want.map((v, k) => [33 + k, { ParamEyeLOpen: v }])),
      "V7",
    );
  });

  it("V8: look toward (1, 0)", () => {
    const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15, 16];
    const ax = [
      0, 0.4444444, 1.333333, 2.666667, 4.444445, 6.666667, 9.333333, 12.44444, 16, 19.31244,
      29.20797, 29.85374, 29.85374,
    ];
    const ex = [
      0, 0.01481481, 0.04444445, 0.08888889, 0.1481481, 0.2222222, 0.3111111, 0.4148148, 0.5333334,
      0.6437479, 0.9735988, 0.9951246, 0.9951246,
    ];
    checkTable(
      {
        model,
        settings: settingsS0(),
        files: new Map(),
        steps: steps(17, 1 / 60),
        commands: [{ frame: 0, command: { kind: "setLookTarget", x: 1, y: 0 } }],
        effects: only("look"),
      },
      Object.fromEntries(frames.map((f, k) => [f, { ParamAngleX: ax[k]!, ParamEyeBallX: ex[k]! }])),
      "V8",
    );
  });

  it("V9: breath", () => {
    const rows = [
      [1.785575, 1.719731, 1.40012, 0.2018888, 0.7333864],
      [3.468466, 3.105356, 2.68821, 0.4017152, 0.9128032],
      [4.951896, 3.887678, 3.761206, 0.5974376, 0.9967612],
      [6.150555, 3.914709, 4.533253, 0.7870568, 0.9658455],
    ];
    const ids = ["ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamBreath"];
    checkTable(
      {
        model,
        settings: settingsS0(),
        files: new Map(),
        steps: steps(4, 0.25),
        effects: only("breath"),
      },
      Object.fromEntries(
        rows.map((r, f) => [f, Object.fromEntries(ids.map((id, k) => [id, r[k]!]))]),
      ),
      "V9",
    );
  });

  it("V10: lip sync from a 16-bit WAV", () => {
    const samples: number[] = [];
    for (let i = 0; i < 8000; i++) {
      if (i < 4000) samples.push(0.5 * Math.sin((2 * Math.PI * 200 * i) / 8000));
      else if (i < 6000) samples.push(0);
      else samples.push(Math.floor(i / 20) % 2 === 0 ? -0.25 : 0.25);
    }
    const frames = [0, 1, 2, 14, 15, 16, 21, 22, 23, 29, 30, 31];
    const want = [
      0.3511096, 0.3571166, 0.3523809, 0.3530101, 0.004786775, 0, 0, 0.1764453, 0.25, 0.25, 0.25, 0,
    ];
    checkTable(
      {
        model,
        settings: settingsS0(),
        files: new Map([["v10.wav", wav16(samples, 8000)]]),
        steps: steps(32, 1 / 30),
        commands: [{ frame: 0, command: { kind: "startSound", file: "v10.wav" } }],
        effects: only("lipSync"),
      },
      Object.fromEntries(frames.map((f, k) => [f, { ParamMouthOpenY: want[k]! }])),
      "V10",
    );
  });

  it("D1: DeepSeek-chan with its own settings, physics and motion", () => {
    const dir = DEEPSEEK;
    const settingsFile = parseModelSettings(readFileSync(join(dir, "大肥鱼.model3.json")));
    const motion = "Animation/脱捕.motion3.json";
    const table: Record<number, number[]> = {
      0: [0, 0, 0, 0, 1, 0],
      1: [0, 0, 0, 0, 1, 0.0003024913],
      2: [0, 0, 0, 0, 1, 0.001514752],
      59: [1.754864, 1.642222, 4.68726, 1.756127, 1, 0.5251493],
      119: [4.293337, 3.835836, 11.80725, 4.25246, 1, 0.6117437],
      299: [12.34221, 11.59309, 20.38335, 11.57531, 1, 0.8715242],
      599: [-7.486434, -9.572824, 3.339946, -7.698914, 0, 0.2589017],
    };
    const ids = [
      "AngleX",
      "ParamAngleX",
      "ParamAngleZ",
      "ParamBodyAngleX",
      "ParamEyeLOpen",
      "Param56",
    ];
    checkTable(
      {
        model,
        settings: settingsFile,
        files: new Map([
          [settingsFile.physics!, readFileSync(join(dir, settingsFile.physics!))],
          [motion, readFileSync(join(dir, motion))],
        ]),
        steps: steps(600, 1 / 60),
        commands: [start(motion)],
        effects: only("physics"),
      },
      Object.fromEntries(
        Object.entries(table).map(([f, r]) => [
          f,
          Object.fromEntries(ids.map((id, k) => [id, r[k]!])),
        ]),
      ),
      "D1",
    );
  });
});

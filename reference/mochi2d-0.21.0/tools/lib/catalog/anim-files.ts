/**
 * The crafted animation files of the test catalog (4t and A7): settings,
 * motions, expressions, poses, physics files and WAV sounds for
 * `crafts/anim/` and `crafts/anim-q/`, plus the animation vector files (3x).
 * Everything is written from fixed tables; only DeepSeek-chan's `.moc3`,
 * physics file, motions and expressions are linked in (4o).
 */

export type FileContent = string | Uint8Array;

// --- Motions ---

/** A segment in the curve notation of 3x.1 (points after the first). */
export type Segment =
  | ["linear" | "stepped" | "inverse", number, number]
  | ["bezier", number, number, number, number, number, number];

const SEGMENT_CODE = { linear: 0, bezier: 1, stepped: 2, inverse: 3 } as const;

export interface CurveSpec {
  target?: "Model" | "Parameter" | "PartOpacity";
  id: string;
  first: [number, number];
  segments: Segment[];
  fadeIn?: number;
  fadeOut?: number;
}

export interface MotionSpec {
  duration: number;
  fps: number;
  restricted?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  curves: CurveSpec[];
  events?: { time: number; value: string }[];
  /** Meta count keys to leave out (A7 q5 files). */
  omit?: ("CurveCount" | "TotalSegmentCount" | "TotalPointCount")[];
  /** Meta values that replace the computed ones (m-badcount, m-badpoints). */
  override?: Partial<Record<"CurveCount" | "TotalSegmentCount" | "TotalPointCount", number>>;
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** A `.motion3.json` file whose counts match its curves (3c.1). */
export function motionJson(spec: MotionSpec): string {
  let segments = 0;
  let points = 0;
  const curves = spec.curves.map((c) => {
    const data: number[] = [...c.first];
    points++;
    for (const s of c.segments) {
      data.push(SEGMENT_CODE[s[0]], ...(s.slice(1) as number[]));
      segments++;
      points += s[0] === "bezier" ? 3 : 1;
    }
    return {
      Target: c.target ?? "Parameter",
      Id: c.id,
      ...(c.fadeIn !== undefined ? { FadeInTime: c.fadeIn } : {}),
      ...(c.fadeOut !== undefined ? { FadeOutTime: c.fadeOut } : {}),
      Segments: data,
    };
  });
  const counts: Record<string, number> = {
    CurveCount: curves.length,
    TotalSegmentCount: segments,
    TotalPointCount: points,
    ...spec.override,
  };
  for (const k of spec.omit ?? []) delete counts[k];
  const events = spec.events ?? [];
  return JSON.stringify(
    {
      Version: 3,
      Meta: {
        Duration: spec.duration,
        Fps: spec.fps,
        ...(spec.fadeIn !== undefined ? { FadeInTime: spec.fadeIn } : {}),
        ...(spec.fadeOut !== undefined ? { FadeOutTime: spec.fadeOut } : {}),
        Loop: false,
        AreBeziersRestricted: spec.restricted ?? false,
        ...counts,
        UserDataCount: events.length,
        TotalUserDataSize: events.reduce((n, e) => n + utf8Length(e.value), 0),
      },
      Curves: curves,
      ...(events.length ? { UserData: events.map((e) => ({ Time: e.time, Value: e.value })) } : {}),
    },
    null,
    2,
  );
}

const lin = (t: number, v: number): Segment => ["linear", t, v];
const step = (t: number, v: number): Segment => ["stepped", t, v];
const inv = (t: number, v: number): Segment => ["inverse", t, v];
const bez = (a: number, b: number, c: number, d: number, e: number, f: number): Segment => [
  "bezier",
  a,
  b,
  c,
  d,
  e,
  f,
];
const curve = (id: string, first: [number, number], ...segments: Segment[]): CurveSpec => ({
  id,
  first,
  segments,
});
const constant = (id: string, value: number, duration: number) =>
  curve(id, [0, value], lin(duration, value));

const SEGS_CURVES: CurveSpec[] = [
  curve("ParamEyeBallX", [0, -1], lin(0.5, 1), lin(1.2, -0.25), lin(3, 0.75)),
  curve("ParamEyeBallY", [0.2, 0], bez(0.6, 1, 0.9, 1, 1.3, 0.4), bez(1.6, -0.6, 2.2, -1, 2.7, 0)),
  curve("ParamBrowLY", [0, 0], step(0.75, 1), step(1.5, -0.5), lin(3, 0)),
  curve("ParamBrowRY", [0, 0], inv(0.75, 1), inv(1.5, -0.5), lin(3, 0)),
  curve(
    "ParamMouthForm",
    [0, -1],
    bez(1.4, 1, -0.6, -1, 1, 1),
    bez(0.4, 0, 2.6, 0, 2, -0.5),
    bez(3.1, 1, 1.9, 1, 3, 0),
  ),
  curve("Sweat1", [0, 0], lin(1, 2.3), lin(2, -0.7), lin(3, 1)),
  curve("AniEyerolling", [0, 0], lin(1.5, 47), lin(3, -12)),
  curve("ParamMouthOpenY", [0, 0], lin(1, 1.6), lin(2, -0.3), lin(3, 0.5)),
  curve("NoSuchParameter", [0, 0], lin(3, 5)),
];
const SEGS_EVENTS = [
  { time: 0, value: "ev-start" },
  { time: 0.5, value: "ev-half" },
  { time: 1.5, value: "ev-mid" },
  { time: 3, value: "ev-end" },
];

const M_SHORT: MotionSpec = {
  duration: 0.5,
  fps: 7,
  curves: [
    curve("ParamEyeBallX", [0, -1], lin(0.3, 1)),
    curve("ParamEyeBallY", [0, -1], bez(0.1, 1, 0.2, 1, 0.4, 0.5)),
    curve("ParamBrowLY", [0, -1], step(0.45, 1)),
    curve("ParamBrowRY", [0, -1], inv(0.45, 1)),
  ],
};

/** The motions of 4t, by file name without `.motion3.json`. */
export const ANIM_MOTIONS: Record<string, MotionSpec> = {
  "m-segs-unres": {
    duration: 3,
    fps: 30,
    restricted: false,
    fadeIn: 0.4,
    fadeOut: 0.6,
    curves: SEGS_CURVES,
    events: SEGS_EVENTS,
  },
  "m-segs-res": {
    duration: 3,
    fps: 30,
    restricted: true,
    fadeIn: 0.4,
    fadeOut: 0.6,
    curves: SEGS_CURVES,
    events: SEGS_EVENTS,
  },
  "m-model": {
    duration: 2.5,
    fps: 30,
    fadeIn: 0.2,
    fadeOut: 0.3,
    curves: [
      {
        ...curve("EyeBlink", [0, 1], lin(0.5, 0), lin(1, 1), bez(1.3, 1, 1.6, 0.2, 2, 0.5)),
        target: "Model",
      },
      { ...curve("LipSync", [0, 0], lin(1, 0.8), lin(2.5, 0.1)), target: "Model" },
      { ...curve("Opacity", [0, 1], lin(1, 0.3), lin(2, 1)), target: "Model" },
      curve("ParamEyeLOpen", [0, 1.2], lin(2.5, 0.6)),
      curve("ParamMouthOpenY", [0, 0.1], lin(2.5, 0.4)),
      curve("ParamBrowLY", [0, 0.5], lin(2.5, -0.5)),
      { ...curve("Part116", [0, 0], step(1.2, 1), lin(2.5, 1)), target: "PartOpacity" },
      { ...curve("Part99", [0, 1], step(1.2, 0), lin(2.5, 0)), target: "PartOpacity" },
    ],
  },
  "m-curvefade": {
    duration: 4,
    fps: 60,
    fadeIn: 1.5,
    fadeOut: 1,
    curves: [
      { ...curve("ParamEyeBallX", [0, 1], lin(4, 1)), fadeIn: 0.3, fadeOut: 2 },
      { ...curve("ParamEyeBallY", [0, 1], lin(4, 1)), fadeIn: 0 },
      { ...curve("ParamBrowLY", [0, 1], lin(4, 1)), fadeOut: 0.25 },
      curve("ParamBrowRY", [0, 1], lin(4, 1)),
    ],
  },
  "m-order": {
    duration: 2,
    fps: 30,
    curves: [
      curve("ParamEyeBallX", [0, 0.5], lin(2, 0.5)),
      { ...curve("Opacity", [0, 0.4], lin(2, 0.4)), target: "Model" },
      curve("ParamEyeBallY", [0, 0.5], lin(2, 0.5)),
      { ...curve("Part116", [0, 1], lin(2, 1)), target: "PartOpacity" },
      curve("ParamBrowLY", [0, 0.5], lin(2, 0.5)),
    ],
  },
  "m-short": M_SHORT,
  "m-nofade": {
    duration: 1.5,
    fps: 30,
    fadeIn: -1,
    curves: [curve("ParamEyeBallX", [0, 1], lin(1.5, -1))],
  },
  "m-zerodur": { duration: 0, fps: 30, curves: [curve("ParamEyeBallX", [0, 0.7], lin(1, -0.7))] },
  "m-zerofade": {
    duration: 1,
    fps: 30,
    fadeIn: 0,
    fadeOut: 0,
    curves: [
      curve("ParamEyeBallX", [0, 0.9], lin(1, 0.2)),
      curve("ParamEyeBallY", [0, -0.9], lin(1, -0.2)),
    ],
  },
  "m-angles": {
    duration: 6,
    fps: 30,
    fadeIn: 0.5,
    fadeOut: 0.5,
    curves: [
      curve(
        "AngleX",
        [0, 0],
        bez(0.5, 30, 1, 30, 1.5, 0),
        bez(2, -30, 2.5, -30, 3, 0),
        lin(3.2, 25),
        lin(4, -25),
        lin(6, 0),
      ),
      curve("AngleZ", [0, 0], lin(1, 30), lin(2, -30), step(3, 20), lin(6, 0)),
      curve("ParamEyeBallX", [0, 0], lin(1, 1), lin(2, -1), lin(3, 0.5), lin(6, 0)),
      curve("ParamEyeBallY", [0, 0], lin(1.5, -1), lin(3, 1), lin(6, 0)),
      curve("ParamMouthOpenY", [0, 0], lin(1, 1), lin(2, 0), lin(3, 1), lin(6, 0)),
    ],
  },
  "m-badcount": { ...M_SHORT, override: { CurveCount: 5 } },
  "m-badpoints": { ...M_SHORT, override: { TotalPointCount: 12 } },
};

/** The vector motions of 3x (V1–V6). */
export const VECTOR_MOTIONS: Record<string, MotionSpec> = (() => {
  const v1 = (restricted: boolean): MotionSpec => ({
    duration: 2,
    fps: 10,
    restricted,
    fadeIn: 0,
    fadeOut: 0,
    curves: [
      curve("AngleX", [0, 0], lin(1, 20), lin(2, -10)),
      curve("AngleY", [0, 0], bez(0.3, 10, 0.7, 10, 1, 0), bez(1.2, -20, 1.9, 30, 2, 0)),
      curve("AngleZ", [0, -10], bez(1.4, 20, -0.4, -20, 1, 10), lin(2, 0)),
      curve("PositionX", [0, 0], step(0.5, 5), step(1.5, -5), lin(2, 3)),
      curve("PositionY", [0, 0], inv(0.5, 5), inv(1.5, -5), lin(2, 3)),
    ],
  });
  return {
    "vec-curves": v1(false),
    "vec-curves-r": v1(true),
    "vec-fadeA": {
      duration: 3,
      fps: 10,
      fadeIn: 0.5,
      fadeOut: 1,
      curves: [constant("AngleX", 20, 3), { ...constant("AngleY", 20, 3), fadeIn: 0.25 }],
    },
    "vec-fadeB": {
      duration: 2,
      fps: 10,
      fadeIn: 0.5,
      fadeOut: 0.5,
      curves: [constant("AngleX", -10, 2)],
    },
    "vec-loop": {
      duration: 1,
      fps: 4,
      fadeIn: 0,
      fadeOut: 0,
      curves: [curve("AngleX", [0, 0], lin(0.75, 30)), curve("AngleY", [0, -20], step(0.75, 20))],
    },
    "vec-base": {
      duration: 10,
      fps: 10,
      fadeIn: 0,
      fadeOut: 0,
      curves: [constant("AngleX", 6, 10), constant("AngleY", -6, 10)],
    },
    "vec-step": {
      duration: 4,
      fps: 10,
      fadeIn: 0,
      fadeOut: 0,
      curves: [constant("AngleX", 30, 4)],
    },
    "vec-pose": {
      duration: 3,
      fps: 10,
      fadeIn: 0,
      fadeOut: 0,
      curves: [
        { ...curve("Part116", [0, 0], step(1, 1), lin(3, 1)), target: "PartOpacity" },
        { ...curve("Part99", [0, 1], step(1, 0), lin(3, 0)), target: "PartOpacity" },
      ],
    },
  };
})();

/** The motions of `crafts/anim-q/` (A7). None has fade keys. */
export const QUESTION_MOTIONS: Record<string, MotionSpec> = (() => {
  const two = [
    curve("ParamEyeBallX", [0, 0], lin(0.5, 1)),
    curve("ParamEyeBallY", [0, 0], lin(0.5, 1)),
  ];
  return {
    "m-long": { duration: 2, fps: 30, curves: [curve("ParamEyeBallX", [0, 0], lin(2, 1))] },
    "m-short": { duration: 0.5, fps: 30, curves: [curve("ParamEyeBallY", [0, 0], lin(0.5, 1))] },
    "m-base": { duration: 10, fps: 30, curves: [constant("ParamEyeBallX", 0.6, 10)] },
    "m-ev-loop": {
      duration: 1,
      fps: 10,
      curves: [curve("ParamEyeBallX", [0, 0], lin(1, 1))],
      events: [
        { time: 0.05, value: "e005" },
        { time: 0.5, value: "e050" },
        { time: 0.95, value: "e095" },
        { time: 1.0, value: "e100" },
        { time: 1.05, value: "e105" },
      ],
    },
    "m-nocc": { duration: 0.5, fps: 30, curves: two, omit: ["CurveCount"] },
    "m-nosc": { duration: 0.5, fps: 30, curves: two, omit: ["TotalSegmentCount"] },
    "m-nopc": { duration: 0.5, fps: 30, curves: two, omit: ["TotalPointCount"] },
    "m-empty-nocounts": {
      duration: 0.5,
      fps: 30,
      curves: [],
      omit: ["CurveCount", "TotalSegmentCount", "TotalPointCount"],
    },
    "m-empty-zero": { duration: 0.5, fps: 30, curves: [] },
  };
})();

// --- Expressions ---

type ExprParam = [id: string, value: number, blend?: string];

function expressionJson(
  fadeIn: number | undefined,
  fadeOut: number | undefined,
  params: ExprParam[],
) {
  return JSON.stringify(
    {
      Type: "Live2D Expression",
      ...(fadeIn !== undefined ? { FadeInTime: fadeIn } : {}),
      ...(fadeOut !== undefined ? { FadeOutTime: fadeOut } : {}),
      Parameters: params.map(([Id, Value, Blend]) => ({
        Id,
        Value,
        ...(Blend !== undefined ? { Blend } : {}),
      })),
    },
    null,
    2,
  );
}

/** The expressions of 4t (`crafts/anim/`) and the vector expressions of V4. */
export const ANIM_EXPRESSIONS: Record<string, string> = {
  "e-mul": expressionJson(0.3, 0.3, [
    ["ParamMouthOpenY", 0.25, "Multiply"],
    ["ParamEyeBallX", -1, "Multiply"],
  ]),
  "e-over": expressionJson(0.5, 0.25, [
    ["ParamEyeBallX", 0.8, "Overwrite"],
    ["ParamBrowLY", -1, "Overwrite"],
  ]),
  "e-over2": expressionJson(0.4, 0.4, [
    ["ParamEyeBallX", -0.6, "Overwrite"],
    ["ParamBrowLY", 0.3, "Add"],
  ]),
  "e-add": expressionJson(0, 0.2, [
    ["ParamEyeBallX", 0.3, "Add"],
    ["ParamMouthOpenY", 0.5, "Multiply"],
    ["ParamBrowRY", 0.7],
  ]),
  "e-neg": expressionJson(-1, 1, [["ParamBrowRY", 1, "Overwrite"]]),
  "e-unknown": expressionJson(undefined, undefined, [
    ["ParamBrowRY", 0.4, "Screen"],
    ["NoSuchParameter", 2, "Add"],
  ]),
  "vec-e1": expressionJson(0.5, 0.5, [
    ["AngleX", 10, "Add"],
    ["AngleY", 15, "Overwrite"],
  ]),
  "vec-e2": expressionJson(0.5, 0.5, [["AngleX", 0.5, "Multiply"]]),
};

/** The expressions of `crafts/anim-q/` (A7): fade times 0, two entries for ParamEyeBallX. */
export const QUESTION_EXPRESSIONS: Record<string, string> = Object.fromEntries(
  (
    [
      ["e-add2", [0.3, "Add"], [0.5, "Add"]],
      ["e-over2", [0.2, "Overwrite"], [0.8, "Overwrite"]],
      ["e-mul2", [0.5, "Multiply"], [0.2, "Multiply"]],
      ["e-add-over", [0.3, "Add"], [0.8, "Overwrite"]],
      ["e-over-add", [0.8, "Overwrite"], [0.3, "Add"]],
    ] as [string, [number, string], [number, string]][]
  ).map(([name, a, b]) => [
    name,
    expressionJson(0, 0, [
      ["ParamEyeBallX", ...a],
      ["ParamEyeBallX", ...b],
    ]),
  ]),
);

// --- Poses ---

type PosePart = [id: string, link?: string[]];

function poseJson(fadeIn: number | undefined, groups: PosePart[][]): string {
  return JSON.stringify(
    {
      Type: "Live2D Pose",
      ...(fadeIn !== undefined ? { FadeInTime: fadeIn } : {}),
      Groups: groups.map((g) => g.map(([Id, Link]) => ({ Id, ...(Link ? { Link } : {}) }))),
    },
    null,
    2,
  );
}

const DS_POSE = poseJson(0.3, [
  [
    ["Part99", ["Part64"]],
    ["Part116", []],
  ],
  [["Part66", []], ["Part10", ["Part8", "Part47"]], ["Part81"]],
]);

export const ANIM_POSES: Record<string, string> = {
  "ds.pose3.json": DS_POSE,
  "ds-fade0.pose3.json": poseJson(0, [
    [
      ["Part99", ["Part64"]],
      ["Part116", []],
    ],
  ]),
  "ds-nofade.pose3.json": poseJson(undefined, [
    [["Part99"], ["Part116"]],
    [["NoSuchPart"], ["Part66"]],
  ]),
  "vec.pose3.json": poseJson(0.5, [
    [
      ["Part99", ["Part64"]],
      ["Part116", []],
    ],
  ]),
};

// --- Physics ---

type Kind = "X" | "Y" | "Angle";
interface Rig {
  id: string;
  inputs: [id: string, weight: number, type: Kind, reflect: boolean][];
  outputs: [
    id: string,
    vertex: number,
    scale: number,
    weight: number,
    type: Kind,
    reflect: boolean,
  ][];
  vertices: [
    x: number,
    y: number,
    mobility: number,
    delay: number,
    acceleration: number,
    radius: number,
  ][];
  position: [min: number, def: number, max: number];
  angle: [min: number, def: number, max: number];
}

function physicsJson(
  rigs: Rig[],
  meta: { fps?: number; gravity: [number, number]; wind: [number, number] },
) {
  const norm = ([Minimum, Default, Maximum]: [number, number, number]) => ({
    Minimum,
    Default,
    Maximum,
  });
  return JSON.stringify(
    {
      Version: 3,
      Meta: {
        PhysicsSettingCount: rigs.length,
        TotalInputCount: rigs.reduce((n, r) => n + r.inputs.length, 0),
        TotalOutputCount: rigs.reduce((n, r) => n + r.outputs.length, 0),
        VertexCount: rigs.reduce((n, r) => n + r.vertices.length, 0),
        ...(meta.fps !== undefined ? { Fps: meta.fps } : {}),
        EffectiveForces: {
          Gravity: { X: meta.gravity[0], Y: meta.gravity[1] },
          Wind: { X: meta.wind[0], Y: meta.wind[1] },
        },
        PhysicsDictionary: rigs.map((r) => ({ Id: r.id, Name: r.id })),
      },
      PhysicsSettings: rigs.map((r) => ({
        Id: r.id,
        Input: r.inputs.map(([Id, Weight, Type, Reflect]) => ({
          Source: { Target: "Parameter", Id },
          Weight,
          Type,
          Reflect,
        })),
        Output: r.outputs.map(([Id, VertexIndex, Scale, Weight, Type, Reflect]) => ({
          Destination: { Target: "Parameter", Id },
          VertexIndex,
          Scale,
          Weight,
          Type,
          Reflect,
        })),
        Vertices: r.vertices.map(([X, Y, Mobility, Delay, Acceleration, Radius]) => ({
          Position: { X, Y },
          Mobility,
          Delay,
          Acceleration,
          Radius,
        })),
        Normalization: { Position: norm(r.position), Angle: norm(r.angle) },
      })),
    },
    null,
    2,
  );
}

const CRAFT_RIGS: Rig[] = [
  {
    id: "S1",
    inputs: [
      ["ParamEyeBallX", 60, "X", false],
      ["ParamEyeBallY", 40, "Y", true],
      ["AngleZ", 70, "Angle", false],
    ],
    outputs: [
      ["ParamBrowLY", 1, 3, 100, "X", false],
      ["ParamBrowRY", 1, 3, 100, "Y", false],
      ["ParamMouthForm", 1, 10, 50, "Angle", false],
      ["Sweat2", 1, 4, 100, "Angle", true],
    ],
    vertices: [
      [0, 0, 1, 1, 1, 0],
      [0, 10, 0.9, 0.8, 1.5, 10],
    ],
    position: [-10, 2, 10],
    angle: [-30, 5, 45],
  },
  {
    id: "S2",
    inputs: [
      ["AngleX", 100, "Angle", true],
      ["NoSuchParameter", 50, "X", false],
    ],
    outputs: [
      ["Param140", 3, 2, 100, "Angle", false],
      ["Param2", 2, 5, 100, "Angle", false],
      ["Divider4", 0, 1, 100, "Angle", false],
      ["Divider5", 9, 1, 60, "Angle", false],
      ["NoSuchParameter", 1, 1, 100, "Angle", false],
    ],
    vertices: [
      [0, 0, 1, 1, 1, 0],
      [0, 3, 0.95, 0.9, 1, 3],
      [0, 8, 0.8, 0.6, 2, 5],
      [0, 15, 0.7, 1.2, 0.5, 7],
    ],
    position: [-10, 0, 10],
    angle: [-10, 0, 10],
  },
  {
    id: "S3",
    inputs: [["ParamMouthOpenY", 100, "Y", false]],
    outputs: [["ParamBrowLAngle", 1, 20, 30, "Angle", false]],
    vertices: [
      [0, 0, 1, 1, 1, 0],
      [0, 5, 1, 0.3, 3, 5],
    ],
    position: [-1, 0, 1],
    angle: [-10, 0, 10],
  },
];

export const ANIM_PHYSICS: Record<string, string> = {
  "craft-nofps.physics3.json": physicsJson(CRAFT_RIGS, { gravity: [0.5, -1], wind: [2, 0] }),
  "craft-fps30.physics3.json": physicsJson(CRAFT_RIGS, {
    fps: 30,
    gravity: [0.5, -1],
    wind: [2, 0],
  }),
  "vec.physics3.json": physicsJson(
    [
      {
        id: "PhysicsSetting1",
        inputs: [["AngleX", 100, "X", false]],
        outputs: [["AngleZ", 1, 20, 100, "Angle", false]],
        vertices: [
          [0, 0, 1, 1, 1, 0],
          [0, 10, 0.95, 0.9, 1.5, 10],
        ],
        position: [-10, 0, 10],
        angle: [-10, 0, 10],
      },
    ],
    { fps: 30, gravity: [0, -1], wind: [0, 0] },
  ),
};

// --- Sounds ---

export interface WavSpec {
  rate: number;
  channels: number;
  bits: 8 | 16 | 24 | 32;
  /** 1 (PCM) or 3 (float; written as 32-bit PCM, never decoded). */
  format?: number;
  frames: number;
  /** Signal value of channel `c` at time t = i / rate. */
  signal: (t: number, c: number) => number;
  /** A LIST chunk between `fmt ` and `data` (C20). */
  list?: { body: Uint8Array; pad: boolean };
}

const roundHalfUp = (x: number) => Math.floor(x + 0.5);

/** A WAV file as described in 4t (Sounds). */
export function wavFile(spec: WavSpec): Uint8Array {
  const bytesPerSample = spec.bits / 8;
  const blockAlign = spec.channels * bytesPerSample;
  const dataSize = spec.frames * blockAlign;
  const listSize = spec.list ? 8 + spec.list.body.length + (spec.list.pad ? 1 : 0) : 0;
  const total = 12 + 24 + listSize + 8 + dataSize;
  const b = new Uint8Array(total);
  const dv = new DataView(b.buffer);
  const text = (o: number, s: string) => [...s].forEach((ch, i) => (b[o + i] = ch.charCodeAt(0)));
  text(0, "RIFF");
  dv.setUint32(4, total - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, spec.format ?? 1, true);
  dv.setUint16(22, spec.channels, true);
  dv.setUint32(24, spec.rate, true);
  dv.setUint32(28, spec.rate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, spec.bits, true);
  let o = 36;
  if (spec.list) {
    text(o, "LIST");
    dv.setUint32(o + 4, spec.list.body.length, true);
    b.set(spec.list.body, o + 8);
    o += listSize;
  }
  text(o, "data");
  dv.setUint32(o + 4, dataSize, true);
  o += 8;
  for (let i = 0; i < spec.frames; i++) {
    const t = i / spec.rate;
    for (let c = 0; c < spec.channels; c++) {
      const v = Math.min(1, Math.max(-1, spec.signal(t, c)));
      switch (spec.bits) {
        case 8:
          b[o] = roundHalfUp(127 * v) + 128;
          break;
        case 16:
          dv.setInt16(o, roundHalfUp(32767 * v), true);
          break;
        case 24: {
          const n = roundHalfUp(8388607 * v);
          b[o] = n & 0xff;
          b[o + 1] = (n >> 8) & 0xff;
          b[o + 2] = (n >> 16) & 0xff;
          break;
        }
        case 32:
          dv.setInt32(o, roundHalfUp(2147483647 * v), true);
          break;
      }
      o += bytesPerSample;
    }
  }
  return b;
}

function listBody(value: string, length: number): Uint8Array {
  const body = new Uint8Array(12 + value.length + 1);
  const dv = new DataView(body.buffer);
  [..."INFOISFT"].forEach((ch, i) => (body[i] = ch.charCodeAt(0)));
  dv.setUint32(8, length, true);
  [...value].forEach((ch, i) => (body[12 + i] = ch.charCodeAt(0)));
  return body; // ends with a NUL
}

const TAU = 2 * Math.PI;
const listSignal = (t: number, c: number) => (c === 0 ? 0.6 : 0.25) * Math.sin(TAU * 200 * t);

export const ANIM_SOUNDS: Record<string, WavSpec> = {
  "w16m44.wav": {
    rate: 44100,
    channels: 1,
    bits: 16,
    frames: 88200,
    signal: (t) =>
      t < 1 ? 0.5 * Math.sin(TAU * 220 * t) : t < 1.5 ? 0 : Math.floor(400 * t) % 2 ? 0.9 : -0.9,
  },
  // The factor 0.2 from t = 0.7 applies to channel 1 only (4t).
  "w8s22.wav": {
    rate: 22050,
    channels: 2,
    bits: 8,
    frames: 33075,
    signal: (t, c) =>
      c === 0
        ? 0.8 * Math.sin(TAU * 330 * t)
        : 0.3 * Math.sin(TAU * 1000 * t) * (t >= 0.7 ? 0.2 : 1),
  },
  "w24m48.wav": {
    rate: 48000,
    channels: 1,
    bits: 24,
    frames: 72000,
    signal: (t) => Math.min(1, t) * Math.sin(TAU * 150 * t),
  },
  "w32m16.wav": {
    rate: 16000,
    channels: 1,
    bits: 32,
    frames: 16000,
    signal: (t) => 0.7 * Math.sin(TAU * 100 * t),
  },
  "w16list.wav": {
    rate: 8000,
    channels: 2,
    bits: 16,
    frames: 12000,
    signal: listSignal,
    list: { body: listBody("test", 5), pad: true },
  },
  "w16list-even.wav": {
    rate: 8000,
    channels: 2,
    bits: 16,
    frames: 12000,
    signal: listSignal,
    list: { body: listBody("tst", 4), pad: false },
  },
  "wfloat.wav": { rate: 8000, channels: 1, bits: 32, format: 3, frames: 8000, signal: () => 0.5 },
  "vec.wav": {
    rate: 8000,
    channels: 1,
    bits: 16,
    frames: 8000,
    signal: (t) => {
      const i = Math.round(t * 8000);
      if (i < 4000) return 0.5 * Math.sin((TAU * 200 * i) / 8000);
      if (i < 6000) return 0;
      return Math.floor(i / 20) % 2 === 0 ? -0.25 : 0.25;
    },
  },
};

// --- Settings ---

interface SettingsSpec {
  physics?: string;
  pose?: string;
  motions?: Record<
    string,
    { File: string; FadeInTime?: number; FadeOutTime?: number; Sound?: string }[]
  >;
  eyeBlink?: string[];
  lipSync?: string[];
  hitAreas?: { Id: string; Name: string }[];
}

function settingsJson(s: SettingsSpec): string {
  const groups: { Target: string; Name: string; Ids: string[] }[] = [];
  if (s.eyeBlink) groups.push({ Target: "Parameter", Name: "EyeBlink", Ids: s.eyeBlink });
  if (s.lipSync) groups.push({ Target: "Parameter", Name: "LipSync", Ids: s.lipSync });
  return JSON.stringify(
    {
      Version: 3,
      FileReferences: {
        Moc: "大肥鱼.moc3",
        Textures: [],
        ...(s.physics ? { Physics: s.physics } : {}),
        ...(s.pose ? { Pose: s.pose } : {}),
        ...(s.motions ? { Motions: s.motions } : {}),
      },
      Groups: groups,
      ...(s.hitAreas ? { HitAreas: s.hitAreas } : {}),
    },
    null,
    2,
  );
}

const S0 = { eyeBlink: ["ParamEyeROpen", "ParamEyeLOpen"], lipSync: ["ParamMouthOpenY"] };

export const ANIM_SETTINGS: Record<string, string> = {
  "ds-plain.model3.json": settingsJson(S0),
  "ds-lip.model3.json": settingsJson({
    physics: "大肥鱼.physics3.json",
    pose: "ds.pose3.json",
    motions: {
      Idle: [{ File: "Animation/IDLE.motion3.json" }],
      TapBody: [
        { File: "m-model.motion3.json", FadeInTime: 0.05, FadeOutTime: 0.7, Sound: "w16m44.wav" },
        { File: "Animation/脱捕.motion3.json", FadeInTime: -2 },
      ],
    },
    eyeBlink: S0.eyeBlink,
    lipSync: ["ParamMouthOpenY", "JawOpen"],
    hitAreas: [{ Id: "ArtMesh94", Name: "Body" }],
  }),
  "ds-craftphys.model3.json": settingsJson({ physics: "craft-nofps.physics3.json" }),
  "ds-craftphys30.model3.json": settingsJson({ physics: "craft-fps30.physics3.json" }),
  "ds-pose0.model3.json": settingsJson({ pose: "ds-fade0.pose3.json" }),
  "ds-posenf.model3.json": settingsJson({ pose: "ds-nofade.pose3.json" }),
  "vec-phys.model3.json": settingsJson({ physics: "vec.physics3.json" }),
  "vec-pose.model3.json": settingsJson({ pose: "vec.pose3.json" }),
};

/** DeepSeek-chan's files linked into `crafts/anim/` (4o): link name → path in `DeepSeek/`. */
export const ANIM_LINKS: Record<string, string> = {
  "大肥鱼.moc3": "大肥鱼.moc3",
  "大肥鱼.physics3.json": "大肥鱼.physics3.json",
  "大肥鱼.cdi3.json": "大肥鱼.cdi3.json",
  Animation: "Animation",
  Exp3: "Exp3",
};

/** Every crafted file of `crafts/anim/`, by name. */
export function animFolderFiles(): Map<string, FileContent> {
  const out = new Map<string, FileContent>();
  for (const [name, text] of Object.entries(ANIM_SETTINGS)) out.set(name, text);
  for (const [name, spec] of Object.entries({ ...ANIM_MOTIONS, ...VECTOR_MOTIONS }))
    out.set(`${name}.motion3.json`, motionJson(spec));
  for (const [name, text] of Object.entries(ANIM_EXPRESSIONS)) out.set(`${name}.exp3.json`, text);
  for (const [name, text] of Object.entries(ANIM_POSES)) out.set(name, text);
  for (const [name, text] of Object.entries(ANIM_PHYSICS)) out.set(name, text);
  for (const [name, spec] of Object.entries(ANIM_SOUNDS)) out.set(name, wavFile(spec));
  return out;
}

/** Every crafted file of `crafts/anim-q/` (A7), by name. */
export function questionFolderFiles(): Map<string, FileContent> {
  const out = new Map<string, FileContent>();
  out.set("q-plain.model3.json", settingsJson(S0));
  out.set("q-pose.model3.json", settingsJson({ pose: "q.pose3.json" }));
  out.set("q.pose3.json", DS_POSE);
  for (const [name, spec] of Object.entries(QUESTION_MOTIONS))
    out.set(`${name}.motion3.json`, motionJson(spec));
  for (const [name, text] of Object.entries(QUESTION_EXPRESSIONS))
    out.set(`${name}.exp3.json`, text);
  for (const name of ["w16m44.wav", "wfloat.wav"]) out.set(name, wavFile(ANIM_SOUNDS[name]!));
  return out;
}

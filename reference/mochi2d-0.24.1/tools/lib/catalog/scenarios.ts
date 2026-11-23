/**
 * The scenario catalog (4q–4v): 645 static scenarios,
 * 4 sequences, 54 renders and 104 animation scenarios, generated from the
 * fixed tables, the committed static and render scenario files and DeepSeek-chan's
 * model file (for the dsrand generator).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadMoc } from "../../../src/core/moc/model.js";
import { repoRoot } from "../cli.js";
import { deepseekMocBytes, VALIDATION_CASES } from "./moc-crafts.js";
import { dsrandInputs, jitteredSteps, randomList, type StaticInputs } from "./rng.js";

export const STATIC_FORMAT = "mochi2d-scenario/0";
export const SEQUENCE_FORMAT = "mochi2d-sequence/0";
export const ANIM_FORMAT = "mochi2d-anim-scenario/0";

export type Kind = "static" | "sequence" | "render" | "animation";

export interface CatalogEntry {
  id: string;
  kind: Kind;
  /** The group of 4q–4v (used by per-group reports, 4m). */
  group: string;
  /** The scenario object, as written to `<id>.json`. */
  scenario: Record<string, unknown>;
  /**
   * Validation cases only: P8's verdicts. The judge scores a validation case
   * against `required`, not against the official-level verdict (C27).
   */
  verdicts?: { official: "accept" | "reject"; required: "accept" | "reject" };
}

const DEEPSEEK = "DeepSeek/大肥鱼.model3.json";
const craft = (name: string) => `crafts/${name}/m.model3.json`;
const anim = (settings: string) => `crafts/anim/${settings}.model3.json`;
const animQ = (settings: string) => `crafts/anim-q/${settings}.model3.json`;

type Rgba = [number, number, number, number];
const GRAY: Rgba = [0.5, 0.5, 0.5, 1];
const WHITE: Rgba = [1, 1, 1, 1];
const CLEAR: Rgba = [0, 0, 0, 0];

interface StaticScenario {
  format: string;
  id: string;
  model: string;
  parameters?: Record<string, number>;
  partOpacities?: Record<string, number>;
  render?: Record<string, unknown>;
}

function readScenarioDir(dir: string): StaticScenario[] {
  const full = join(repoRoot(), dir);
  return readdirSync(full)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(full, f), "utf8")) as StaticScenario);
}

/**
 * The extras of 4q's table (D2). The committed test files of the two
 * multi-constraint scenarios, from the first evaluation, hold other values;
 * they stay for the golden tests, but the catalog follows 4q.
 */
const EXTRAS: Record<string, Record<string, number>> = {
  "ds-bs-nosnap-hair": { LateHairX2: -0.9991 },
  "ds-bs-nosnap-tongue": { TongueOut: 0.3009 },
  "ds-multi-constraint-p50": {
    Param50: 1,
    Movement1: 0.4,
    Movement3: 0.7,
    Param37: 0.3,
    Movement2: 0.5,
  },
  "ds-multi-constraint-shock": {
    ShockL: 1,
    ParamEyeROpen: 1.45,
    ParamEyeLOpen: 1.42,
    ParamBrowLY: 0.97,
  },
};

/** The static inputs of a scenario, without the render block. */
function staticOf(s: StaticScenario, id: string, model: string): StaticScenario {
  return {
    format: STATIC_FORMAT,
    id,
    model,
    ...(s.parameters && Object.keys(s.parameters).length ? { parameters: s.parameters } : {}),
    ...(s.partOpacities && Object.keys(s.partOpacities).length
      ? { partOpacities: s.partOpacities }
      : {}),
  };
}

let dsrandCache: StaticInputs[] | null = null;
/** The 300 dsrand inputs (4q). */
export function dsrand(): StaticInputs[] {
  dsrandCache ??= dsrandInputs(loadMoc(deepseekMocBytes()), 300);
  return dsrandCache;
}

const dsrandId = (s: number) => `dsrand-${String(s).padStart(3, "0")}`;

function dsrandScenario(s: number, model = DEEPSEEK, id = dsrandId(s)): StaticScenario {
  const d = dsrand()[s]!;
  const parameters: Record<string, number> = {};
  for (const pid of d.order) parameters[pid] = d.parameters[pid]!;
  return {
    format: STATIC_FORMAT,
    id,
    model,
    parameters,
    ...(Object.keys(d.partOpacities).length ? { partOpacities: d.partOpacities } : {}),
  };
}

/** 4q: the static scenarios. */
export function staticCatalog(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const add = (group: string, sc: StaticScenario) =>
    out.push({
      id: sc.id,
      kind: "static",
      group,
      scenario: sc as unknown as Record<string, unknown>,
    });
  const ds = readScenarioDir("test/scenarios/deepseek").filter((s) => !(s.id in EXTRAS));
  if (ds.length !== 14) throw new Error(`catalog: expected 14 ds-* scenarios, found ${ds.length}`);
  for (const s of ds) add("ds", staticOf(s, s.id, DEEPSEEK));
  for (const [id, parameters] of Object.entries(EXTRAS))
    add("extras", { format: STATIC_FORMAT, id, model: DEEPSEEK, parameters });
  for (let s = 0; s < 300; s++) add("dsrand", dsrandScenario(s));
  for (const v of ["ds-v1", "ds-v2", "ds-v3", "ds-v4", "ds-canvasflag", "ds-bigendian"]) {
    for (const s of ds) add("variants", staticOf(s, `${v}_${s.id}`, craft(v)));
    for (let s = 0; s < 24; s++)
      add("variants", dsrandScenario(s, craft(v), `${v}_${dsrandId(s)}`));
  }
  for (const s of ds) add("v6", staticOf(s, `ds-v6_${s.id}`, craft("ds-v6")));
  for (let s = 0; s < 40; s++) add("v6", dsrandScenario(s, craft("ds-v6"), `ds-v6_${dsrandId(s)}`));
  const hip = (id: string, value: number, partOpacities?: Record<string, number>) =>
    add("v6", {
      format: STATIC_FORMAT,
      id: `ds-v6_${id}`,
      model: craft("ds-v6"),
      parameters: { HipAngleX: value },
      ...(partOpacities ? { partOpacities } : {}),
    });
  hip("hip-m12", -12);
  hip("hip-m30", -30);
  hip("hip-p17", 17);
  hip("hip-p30-parts", 30, { Part114: 0.5, Part18: 0.4, Part30: 0.8 });
  for (const c of VALIDATION_CASES) {
    add("validation", {
      format: STATIC_FORMAT,
      id: `val-${c.name}`,
      model: craft(`val-${c.name}`),
    });
    out[out.length - 1]!.verdicts = { official: c.official, required: c.required };
  }
  return out;
}

/** 4r: the four sequences. */
export function sequenceCatalog(): CatalogEntry[] {
  type Step = {
    label: string;
    parameters?: Record<string, number>;
    partOpacities?: Record<string, number>;
  };
  const seq = (id: string, model: string, steps: Step[]): CatalogEntry => ({
    id,
    kind: "sequence",
    group: "sequence",
    scenario: { format: SEQUENCE_FORMAT, id, model, steps },
  });
  const one = (param: string, values: number[]): Step[] =>
    values.map((v, i) => ({ label: `s${i + 1}`, parameters: { [param]: v } }));
  return [
    seq("seq-ds-history", DEEPSEEK, [
      { label: "s1", parameters: { GemReflection: 0.8 } },
      { label: "s2", parameters: { GemReflection: 0 } },
      { label: "s3", parameters: { ParamMouthOpenY: 0.25 } },
      { label: "s4", parameters: { ParamMouthOpenY: 0.302 } },
      { label: "s5", parameters: { ParamAngleX: 30, ParamAngleY: -20 } },
      { label: "s6", partOpacities: { Part48: 0.5, Part37: 0 } },
      { label: "s7", parameters: { ParamMouthOpenY: 0.2 } },
      {
        label: "s8",
        parameters: { GemReflection: 0, ParamMouthOpenY: 0, ParamAngleX: 0, ParamAngleY: 0 },
        partOpacities: { Part48: 1, Part37: 1 },
      },
    ]),
    seq("seq-q3a", craft("q3a"), one("ParamMouthOpenY", [0.2, 1, 1, 1, 0.2, 1])),
    seq("seq-q3b", craft("q3b"), one("Param41", [0.2, 1, 1, 1, 0.2, 1])),
    seq("seq-q4c", craft("q4c"), [
      { label: "s1", parameters: { ParamMouthOpenY: 0.15 } },
      { label: "s2", parameters: { ParamMouthOpenY: 1 } },
      { label: "s3", parameters: { ParamMouthOpenY: 1 }, partOpacities: { Part14: 0.5 } },
      { label: "s4", parameters: { ParamMouthOpenY: 0.15 } },
      { label: "s5", parameters: { ParamMouthOpenY: 0.25 }, partOpacities: { Part14: 1 } },
      { label: "s6", parameters: { ParamMouthOpenY: 0.5 } },
      { label: "s7", parameters: { ParamMouthOpenY: 0.5 }, partOpacities: { Part14: 0.25 } },
      { label: "s8", parameters: { ParamMouthOpenY: 1 } },
    ]),
  ];
}

/** 4s: the render scenarios. */
export function renderCatalog(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const add = (
    group: string,
    id: string,
    model: string,
    size: [number, number],
    background: Rgba,
    view?: [number, number, number],
    inputs: { parameters?: Record<string, number>; partOpacities?: Record<string, number> } = {},
  ) =>
    out.push({
      id,
      kind: "render",
      group,
      scenario: {
        format: STATIC_FORMAT,
        id,
        model,
        ...(inputs.parameters ? { parameters: inputs.parameters } : {}),
        ...(inputs.partOpacities ? { partOpacities: inputs.partOpacities } : {}),
        render: {
          width: size[0],
          height: size[1],
          background,
          ...(view ? { view: { x: view[0], y: view[1], pixelsPerUnit: view[2] } } : {}),
        },
      },
    });
  for (const s of readScenarioDir("test/scenarios/deepseek-render"))
    out.push({ id: s.id, kind: "render", group: "dsr", scenario: { ...s, model: DEEPSEEK } });
  if (out.length !== 9) throw new Error(`catalog: expected 9 dsr-* scenarios, found ${out.length}`);
  // rx-dsrand-*
  const backgrounds = [GRAY, WHITE, CLEAR];
  [3, 41, 77, 112, 158, 199, 236, 288].forEach((s, i) => {
    const d = dsrandScenario(s);
    add("rx", `rx-${dsrandId(s)}`, DEEPSEEK, [384, 768], backgrounds[i % 3]!, undefined, {
      ...(d.parameters ? { parameters: d.parameters } : {}),
      ...(d.partOpacities ? { partOpacities: d.partOpacities } : {}),
    });
  });
  // rx views
  const views: [string, number, number, number, Rgba][] = [
    ["rx-eyes", -0.01, 0.62, 4000, WHITE],
    ["rx-mouth", -0.005, 0.55, 6000, CLEAR],
    ["rx-hair-l", -0.25, 0.45, 1500, GRAY],
    ["rx-hair-r", 0.25, 0.45, 1500, CLEAR],
    ["rx-torso", 0, 0.2, 1200, [0.9, 0.8, 0.7, 1]],
    ["rx-legs", 0, -0.4, 900, CLEAR],
    ["rx-left", -0.35, 0, 800, GRAY],
    ["rx-right", 0.35, 0, 800, WHITE],
  ];
  for (const [id, x, y, k, bg] of views) add("rx", id, DEEPSEEK, [256, 256], bg, [x, y, k]);
  add("rx", "rx-eyes-pose", DEEPSEEK, [256, 256], CLEAR, [-0.01, 0.62, 3000], {
    parameters: {
      ParamAngleX: 28,
      ParamAngleY: -20,
      ParamEyeLOpen: 0.3,
      ParamEyeROpen: 1.2,
      ParamEyeBallX: 0.8,
      ParamMouthOpenY: 1,
      ParamMouthForm: -1,
    },
  });
  // rx sizes and parts
  add("rx", "rx-tiny", DEEPSEEK, [96, 192], GRAY);
  add("rx", "rx-small", DEEPSEEK, [160, 160], CLEAR);
  add("rx", "rx-large", DEEPSEEK, [768, 1536], WHITE);
  add("rx", "rx-partop", DEEPSEEK, [384, 768], GRAY, undefined, {
    partOpacities: { Part67: 0.5, Part137: 0.25, Part116: 0.75, Part99: 0.4, Part64: 0.6 },
  });
  add("rx", "rx-extreme", DEEPSEEK, [384, 768], CLEAR, undefined, {
    parameters: {
      ParamAngleX: 60,
      ParamAngleY: -60,
      ParamBodyAngleX: 40,
      HipAngleX: 30,
      LeanInput: 1,
      Clothes1: 1,
      Clothes2: 1,
      Clothes3: 1,
      Movement1: 1,
      Movement2: 1,
    },
  });
  // v6-*
  const v6 = craft("ds-v6");
  const poses: [string, Record<string, number> | undefined][] = [
    ["def", undefined],
    ["m12", { HipAngleX: -12 }],
    ["p30", { HipAngleX: 30 }],
  ];
  for (const [tag, parameters] of poses) {
    const inputs = parameters ? { parameters } : {};
    add("v6", `v6-full-${tag}`, v6, [384, 768], GRAY, undefined, inputs);
    add("v6", `v6-full-t-${tag}`, v6, [384, 768], CLEAR, undefined, inputs);
    add("v6", `v6-face-${tag}`, v6, [256, 256], WHITE, [-0.01, 0.6, 2500], inputs);
  }
  add("v6", "v6-torso-m12", v6, [256, 256], CLEAR, [0, 0.2, 1200], {
    parameters: { HipAngleX: -12, ParamAngleX: 15 },
  });
  add("v6", "v6-legs-p30", v6, [256, 256], GRAY, [0, -0.4, 900], { parameters: { HipAngleX: 30 } });
  // q2c-*, q2d-*
  for (const q of ["q2c", "q2d"]) {
    add("q2", `${q}-full`, craft(q), [384, 768], GRAY);
    add("q2", `${q}-leg`, craft(q), [512, 512], WHITE, [0.086, -0.4, 1500]);
    add("q2", `${q}-leg-pose`, craft(q), [512, 512], CLEAR, [0.08, -0.5, 1500], {
      parameters: { HipAngleX: 20 },
    });
  }
  // qm-*
  const eye: [number, number, number] = [0.0458, 0.6085, 2500];
  const mouth: [number, number, number] = [0, 0.55, 4500];
  add("qm", "qm-eye-control", craft("qm-eye"), [256, 256], WHITE, eye, {
    parameters: { ParamEyeLOpen: 1.2 },
  });
  add("qm", "qm-eye-inactive", craft("qm-eye"), [256, 256], WHITE, eye, {
    parameters: { ParamEyeLOpen: 1.5 },
  });
  add("qm", "qm-mouth-control", craft("q3a"), [256, 256], GRAY, mouth, {
    parameters: { ParamMouthOpenY: 0.4 },
  });
  add("qm", "qm-mouth-inactive", craft("q3a"), [256, 256], GRAY, mouth, {
    parameters: { ParamMouthOpenY: 1 },
  });
  add("qm", "qm-full-inactive", craft("q3a"), [384, 768], GRAY, undefined, {
    parameters: { ParamMouthOpenY: 1 },
  });
  // texture limit
  add("texture-limit", "rx-texture-too-large", craft("texbig"), [384, 768], GRAY);
  return out;
}

// --- Animation (4v) ---

export const EFFECT_KEYS = [
  "idle",
  "blink",
  "expressions",
  "look",
  "breath",
  "physics",
  "lipsync",
  "pose",
] as const;
export type EffectKey = (typeof EFFECT_KEYS)[number];

const effects = (...on: EffectKey[]) =>
  Object.fromEntries(EFFECT_KEYS.map((k) => [k, on.includes(k)])) as Record<EffectKey, boolean>;

type Command = Record<string, unknown> & { frame: number; do: string };
type Steps = { dt: number; frames: number } | { dts: number[] };

interface AnimSpec {
  id: string;
  model: string;
  steps: Steps;
  random: number[];
  on: EffectKey[];
  commands?: Command[];
  idleMotions?: string[];
  options?: Record<string, unknown>;
  record?: Record<string, unknown>;
}

function animScenario(s: AnimSpec): Record<string, unknown> {
  return {
    format: ANIM_FORMAT,
    id: s.id,
    model: s.model,
    ...s.steps,
    random: s.random,
    effects: effects(...s.on),
    ...(s.idleMotions ? { idleMotions: s.idleMotions } : {}),
    ...(s.options ? { options: s.options } : {}),
    commands: s.commands ?? [],
    record: { parameters: "all", parts: "all", ...s.record },
  };
}

const each = (dt: number, frames: number): Steps => ({ dt, frames });
const listOf = (dts: number[]): Steps => ({ dts });
const repeat = (n: number, v: number) => new Array<number>(n).fill(v);

/** A motion command: `file`, or `[group, index]`. */
const motion = (
  frame: number,
  what: string | [string, number],
  extra: Record<string, unknown> = {},
): Command => ({
  frame,
  do: "motion",
  ...(typeof what === "string" ? { file: what } : { group: what[0], index: what[1] }),
  priority: 2,
  ...extra,
});
const expr = (frame: number, file: string): Command => ({ frame, do: "expression", file });
const look = (frame: number, x: number, y: number): Command => ({ frame, do: "look", x, y });
const sound = (frame: number, file: string): Command => ({ frame, do: "sound", file });

const dsMotion = (name: string) => `Animation/${name}.motion3.json`;
const dsExpr = (name: string) => `Exp3/${name}.exp3.json`;
const m = (name: string) => `${name}.motion3.json`;
const e = (name: string) => `${name}.exp3.json`;

/** The free values F of A2. */
export const FREE_F = [
  "NoSuchParameter",
  "Part116",
  "Part99",
  "Part64",
  "Part66",
  "Part10",
  "Part8",
  "Part47",
  "Part81",
];

/** The expected boxes of cra-hit-margin (A5), [x0, x1, y0, y1], rounded to 8 digits. */
export const HIT_MARGIN_BOXES: Record<string, { rest: number[]; f60: number[] }> = {
  ArtMesh94: {
    rest: [-0.018134853, 0.018626161, 0.55630994, 0.56698895],
    f60: [-0.018134931, 0.018626191, 0.56039739, 0.57107818],
  },
  ArtMesh263: {
    rest: [-0.0084412517, 0.0081756143, 0.54725116, 0.55921769],
    f60: [-0.011047778, 0.010781987, 0.529917, 0.55395007],
  },
  ArtMesh197: {
    rest: [-0.01813389, 0.018626343, 0.55586356, 0.56303686],
    f60: [-0.015474474, 0.015966905, 0.55297047, 0.56019956],
  },
};

const sig7 = (x: number) => Number(x.toPrecision(7));

function a1(): AnimSpec[] {
  const ds = (
    id: string,
    steps: Steps,
    on: EffectKey[],
    commands: Command[] = [],
    idleMotions?: string[],
  ): Omit<AnimSpec, "random"> => ({
    id,
    model: DEEPSEEK,
    steps,
    on,
    commands,
    ...(idleMotions ? { idleMotions: idleMotions.map(dsMotion) } : {}),
  });
  const take = (frame: number, extra: Record<string, unknown> = {}) =>
    motion(frame, dsMotion("脱捕"), extra);
  const rows: Omit<AnimSpec, "random">[] = [
    ds("dsa-idle-once", each(1 / 60, 480), ["physics"], [motion(0, dsMotion("IDLE"))]),
    ds(
      "dsa-idle-loop-v2",
      each(1 / 60, 900),
      ["physics"],
      [motion(0, dsMotion("IDLE"), { loop: true })],
    ),
    ds(
      "dsa-idle-loop-v1",
      each(1 / 60, 900),
      [],
      [motion(0, dsMotion("IDLE"), { loop: true, legacyLoop: true })],
    ),
    ds(
      "dsa-idle-loop-nofadein",
      each(1 / 45, 600),
      [],
      [motion(0, dsMotion("IDLE"), { loop: true, loopFade: false })],
    ),
    ds("dsa-take-30fps", each(1 / 30, 420), ["physics"], [take(0)]),
    ds("dsa-take-60fps", each(1 / 60, 840), ["physics"], [take(0)]),
    ds("dsa-take-144fps", each(1 / 144, 1200), ["physics"], [take(0)]),
    ds("dsa-take-jitter", listOf(jitteredSteps(400, 11)), ["physics"], [take(0)]),
    ds(
      "dsa-take-all",
      each(1 / 60, 840),
      ["blink", "expressions", "look", "breath", "physics", "lipsync", "pose"],
      [take(0), look(100, 0.6, -0.4), look(300, -0.8, 0.9), look(500, 0, 0)],
    ),
    ds(
      "dsa-crossfade",
      each(1 / 60, 420),
      ["physics"],
      [
        motion(0, dsMotion("默认手切举手")),
        motion(30, dsMotion("举手切默认手"), { priority: 3 }),
        motion(50, dsMotion("竖手指切出来动画"), {
          priority: 3,
          FadeInTime: 0.25,
          FadeOutTime: 0.75,
        }),
        motion(140, dsMotion("竖手指切回默认"), { priority: 3, FadeInTime: 0 }),
      ],
    ),
    ds(
      "dsa-priority",
      each(1 / 60, 300),
      [],
      [
        motion(0, dsMotion("默认手切举手"), { priority: 1 }),
        motion(10, dsMotion("举手切默认手"), { priority: 1 }),
        motion(20, dsMotion("举手切默认手")),
        motion(30, dsMotion("狗尾草切换出来")),
        motion(40, dsMotion("竖手指切出来动画"), { priority: 3 }),
        motion(200, dsMotion("默认手切举手"), { priority: 1 }),
      ],
    ),
    ds(
      "dsa-weight-offset",
      each(1 / 60, 200),
      [],
      [take(0, { weight: 0.4, offset: 2.5, FadeInTime: 0.3, FadeOutTime: 0.2 })],
    ),
    ds(
      "dsa-idle-auto",
      each(1 / 60, 1500),
      ["idle", "blink", "breath"],
      [],
      ["默认手切举手", "举手切默认手", "IDLE"],
    ),
    ds("dsa-blink-only", each(1 / 60, 1200), ["blink"]),
    ds("dsa-blink-jitter", listOf(jitteredSteps(900, 5)), ["blink"]),
    ds(
      "dsa-blink-vs-motion",
      each(1 / 60, 900),
      ["blink"],
      [motion(120, dsMotion("默认手切举手")), motion(500, dsMotion("举手切默认手"))],
    ),
    ds("dsa-breath", each(1 / 60, 600), ["breath"]),
    ds(
      "dsa-drag",
      each(1 / 60, 400),
      ["look"],
      [look(5, 1, 0), look(80, -0.3, 0.7), look(200, 0, 0)],
    ),
    ds(
      "dsa-drag-jitter",
      listOf(jitteredSteps(300, 3)),
      ["look"],
      [look(0, 0.9, -0.9), look(150, 0, 0)],
    ),
    ds(
      "dsa-expr-seq",
      each(1 / 60, 600),
      ["expressions"],
      [
        expr(0, dsExpr("圈圈眼")),
        expr(30, dsExpr("脸红")),
        expr(200, dsExpr("＞＜")),
        expr(230, dsExpr("屑屑眼")),
        expr(240, dsExpr("圈圈眼")),
        expr(450, dsExpr("默认体型")),
      ],
    ),
    ds(
      "dsa-expr-motion",
      each(1 / 60, 500),
      ["expressions", "physics"],
      [take(0), expr(60, dsExpr("流泪")), expr(260, dsExpr("黑脸"))],
    ),
    ds(
      "dsa-physics-dt0",
      listOf([
        1 / 60,
        1 / 60,
        0,
        1 / 60,
        0,
        0,
        1 / 30,
        1 / 120,
        1 / 120,
        ...repeat(200, 1 / 60),
        6,
        ...repeat(60, 1 / 60),
        1 / 7,
        1 / 3,
        ...repeat(60, 1 / 60),
      ]),
      ["physics", "breath"],
      [take(0)],
    ),
    ds(
      "dsa-everything",
      listOf(jitteredSteps(900, 21)),
      ["idle", "blink", "expressions", "look", "breath", "physics"],
      [
        look(10, 0.4, 0.2),
        expr(100, dsExpr("爱心眼")),
        take(300, { priority: 3 }),
        look(600, -1, -1),
      ],
      ["IDLE", "默认手切举手", "举手切默认手"],
    ),
  ];
  return rows.map((r, i) => ({ ...r, random: randomList(7 + i) }));
}

function a2(): AnimSpec[] {
  const cra = (
    id: string,
    settings: string,
    steps: Steps,
    on: EffectKey[],
    commands: Command[] = [],
    extra: Partial<AnimSpec> = {},
  ): Omit<AnimSpec, "random"> => ({ id, model: anim(settings), steps, on, commands, ...extra });
  const hitPoints: [string, number, number][] = [
    ["ArtMesh94", 0, 0],
    ["ArtMesh94", 0.05, 0.3],
    ["ArtMesh94", -0.2, -0.4],
    ["ArtMesh263", 0, 0.3],
    ["ArtMesh197", 0.01, 0.42],
    ["NoSuchMesh", 0, 0],
  ];
  const rows: Omit<AnimSpec, "random">[] = [
    cra("cra-segs-unres", "ds-plain", each(1 / 60, 260), [], [motion(0, m("m-segs-unres"))]),
    cra("cra-segs-res", "ds-plain", each(1 / 60, 260), [], [motion(0, m("m-segs-res"))]),
    cra(
      "cra-segs-30",
      "ds-plain",
      listOf(jitteredSteps(150, 4)),
      [],
      [motion(0, m("m-segs-unres")), motion(70, m("m-segs-res"))],
    ),
    cra(
      "cra-segs-loop",
      "ds-plain",
      each(1 / 50, 500),
      [],
      [motion(0, m("m-segs-unres"), { loop: true })],
    ),
    cra("cra-model-curves", "ds-plain", each(1 / 60, 220), ["blink"], [motion(0, m("m-model"))]),
    cra(
      "cra-model-lip",
      "ds-lip",
      each(1 / 60, 260),
      ["lipsync", "pose"],
      [motion(0, ["TapBody", 0])],
    ),
    cra(
      "cra-curvefade",
      "ds-plain",
      each(1 / 60, 300),
      [],
      [motion(0, m("m-curvefade")), motion(150, m("m-nofade"))],
    ),
    cra(
      "cra-curvefade-out",
      "ds-plain",
      each(1 / 60, 360),
      [],
      [motion(0, m("m-curvefade"), { FadeOutTime: 0.5 })],
    ),
    cra("cra-order", "ds-plain", each(1 / 30, 70), [], [motion(0, m("m-order"))]),
    cra(
      "cra-short-loop-v2",
      "ds-plain",
      each(1 / 60, 200),
      [],
      [motion(0, m("m-short"), { loop: true })],
    ),
    cra(
      "cra-short-loop-v1",
      "ds-plain",
      each(1 / 60, 200),
      [],
      [motion(0, m("m-short"), { loop: true, legacyLoop: true })],
    ),
    cra(
      "cra-short-loop-jit",
      "ds-plain",
      listOf(jitteredSteps(200, 9, 1 / 90, 1 / 15)),
      [],
      [motion(0, m("m-short"), { loop: true, loopFade: false })],
    ),
    cra(
      "cra-zero",
      "ds-plain",
      each(1 / 60, 120),
      [],
      [motion(0, m("m-zerodur")), motion(10, m("m-zerofade")), motion(50, m("m-zerofade"))],
    ),
    cra(
      "cra-expr-blends",
      "ds-plain",
      each(1 / 60, 420),
      ["expressions"],
      [
        motion(0, m("m-angles")),
        expr(0, e("e-over")),
        expr(60, e("e-over2")),
        expr(75, e("e-mul")),
        expr(160, e("e-add")),
        expr(240, e("e-unknown")),
        expr(300, e("e-neg")),
      ],
    ),
    cra(
      "cra-expr-overwrite-switch",
      "ds-plain",
      each(1 / 60, 200),
      ["expressions"],
      [expr(0, e("e-over")), expr(80, e("e-mul")), expr(140, e("e-over"))],
    ),
    cra(
      "cra-pose",
      "ds-lip",
      each(1 / 60, 300),
      ["pose"],
      [motion(20, m("m-model")), { frame: 200, do: "partOpacity", id: "Part81", value: 0.9 }],
    ),
    cra(
      "cra-pose-jitter",
      "ds-lip",
      listOf(jitteredSteps(240, 17)),
      ["pose"],
      [motion(0, m("m-model")), motion(120, m("m-model"))],
    ),
    cra("cra-pose-fade0", "ds-pose0", each(1 / 60, 200), ["pose"], [motion(10, m("m-model"))]),
    cra("cra-pose-nofade", "ds-posenf", each(1 / 60, 200), ["pose"], [motion(10, m("m-model"))]),
    cra(
      "cra-phys-nofps",
      "ds-craftphys",
      each(1 / 60, 400),
      ["physics"],
      [motion(0, m("m-angles"))],
    ),
    cra(
      "cra-phys-nofps-jit",
      "ds-craftphys",
      listOf(jitteredSteps(300, 23)),
      ["physics"],
      [motion(0, m("m-angles"))],
    ),
    cra(
      "cra-phys-fps30",
      "ds-craftphys30",
      listOf(jitteredSteps(300, 29, 1 / 100, 1 / 20)),
      ["physics"],
      [motion(0, m("m-angles"))],
    ),
    cra(
      "cra-phys-options",
      "ds-craftphys30",
      each(1 / 60, 300),
      ["physics"],
      [motion(0, m("m-angles"))],
      {
        options: { gravity: [0.5, -1], wind: [2, 0] },
      },
    ),
    cra(
      "cra-ds-phys-options",
      "ds-lip",
      each(1 / 60, 300),
      ["physics"],
      [motion(0, dsMotion("脱捕"))],
      {
        options: { gravity: [0.3, -0.8], wind: [1, 0.5] },
      },
    ),
    cra("cra-lip-w16m44", "ds-plain", each(1 / 60, 150), ["lipsync"], [sound(3, "w16m44.wav")]),
    cra("cra-lip-w8s22", "ds-plain", each(1 / 60, 120), ["lipsync"], [sound(3, "w8s22.wav")]),
    cra("cra-lip-w24m48", "ds-plain", each(1 / 60, 120), ["lipsync"], [sound(3, "w24m48.wav")]),
    cra("cra-lip-w32m16", "ds-plain", each(1 / 60, 70), ["lipsync"], [sound(3, "w32m16.wav")]),
    cra("cra-lip-w16list", "ds-plain", each(1 / 60, 110), ["lipsync"], [sound(3, "w16list.wav")]),
    cra("cra-lip-wfloat", "ds-plain", each(1 / 60, 30), ["lipsync"], [sound(3, "wfloat.wav")]),
    cra(
      "cra-lip-jitter",
      "ds-plain",
      listOf(jitteredSteps(120, 31, 1 / 200, 1 / 25)),
      ["lipsync"],
      [sound(0, "w16m44.wav")],
    ),
    cra(
      "cra-lip-motion",
      "ds-lip",
      each(1 / 60, 180),
      ["blink", "lipsync"],
      [motion(0, ["TapBody", 0]), motion(60, ["TapBody", 1], { priority: 3 })],
    ),
    cra("cra-hit", "ds-plain", each(1 / 60, 61), [], [motion(0, m("m-angles"))], {
      record: {
        every: 30,
        hits: [0, 30, 60].flatMap((frame) =>
          hitPoints.map(([drawable, x, y]) => ({ frame, drawable, x, y })),
        ),
      },
    }),
    cra(
      "cra-everything",
      "ds-lip",
      listOf(jitteredSteps(600, 41)),
      [...EFFECT_KEYS],
      [
        look(5, -0.5, 0.5),
        expr(40, e("e-over")),
        motion(100, ["TapBody", 0]),
        expr(220, e("e-mul")),
        motion(300, ["TapBody", 1], { priority: 3 }),
        look(450, 0, 0),
      ],
      { idleMotions: ["Animation/IDLE.motion3.json", "m-short.motion3.json"] },
    ),
    cra(
      "cra-lip-w16list-even",
      "ds-plain",
      each(1 / 60, 110),
      ["lipsync"],
      [sound(3, "w16list-even.wav")],
    ),
  ];
  return rows.map((r, i) => ({
    ...r,
    random: randomList(101 + i),
    record: { free: FREE_F, ...r.record },
  }));
}

function a5(): AnimSpec[] {
  const center = (b: number[]) => [(b[0]! + b[1]!) / 2, (b[2]! + b[3]!) / 2] as const;
  const hit2: { frame: number; drawable: string; x: number; y: number }[] = [];
  for (const [drawable, { rest: b }] of Object.entries(HIT_MARGIN_BOXES)) {
    const [cx, cy] = center(b);
    for (const [x, y] of [
      [cx, cy],
      [b[1]!, b[3]!],
      [b[0]!, b[2]!],
      [b[1]! + 1e-6, cy],
      [cx, b[2]! - 1e-6],
    ] as [number, number][])
      hit2.push({ frame: 0, drawable, x, y });
  }
  const mm = 2e-3;
  const margin: { frame: number; drawable: string; x: number; y: number }[] = [];
  for (const frame of [0, 60, 120]) {
    for (const [drawable, boxes] of Object.entries(HIT_MARGIN_BOXES)) {
      const b = frame === 60 ? boxes.f60 : boxes.rest;
      const [cx, cy] = center(b);
      const [x0, x1, y0, y1] = b as [number, number, number, number];
      for (const [x, y] of [
        [cx, cy],
        [x0 + mm, y0 + mm],
        [x1 - mm, y1 - mm],
        [x1 + mm, cy],
        [cx, y0 - mm],
        [x0 - mm, y1 + mm],
      ] as [number, number][])
        margin.push({ frame, drawable, x: sig7(x), y: sig7(y) });
    }
    margin.push({ frame, drawable: "NoSuchMesh", x: 0, y: 0.55 });
  }
  const plain = anim("ds-plain");
  return [
    {
      id: "cra-hit2",
      model: plain,
      steps: each(1 / 60, 1),
      random: [0.5],
      on: [],
      record: { hits: hit2 },
    },
    {
      id: "cra-validate",
      model: plain,
      steps: each(1 / 60, 60),
      random: [0.5],
      on: [],
      commands: [
        motion(0, m("m-badcount")),
        motion(1, m("m-short")),
        motion(5, m("m-badpoints"), { priority: 3 }),
        motion(6, m("m-short"), { priority: 1 }),
      ],
    },
    {
      id: "cra-hit-margin",
      model: plain,
      steps: each(1 / 60, 121),
      random: randomList(136),
      on: [],
      commands: [motion(0, m("m-angles"))],
      record: { every: 60, free: FREE_F, hits: margin },
    },
  ];
}

function a6(): AnimSpec[] {
  const v = (
    id: string,
    settings: string,
    steps: Steps,
    on: EffectKey[],
    commands: Command[],
    parameters: string[],
    extra: Partial<AnimSpec> = {},
  ): AnimSpec => ({
    id,
    model: anim(settings),
    steps,
    random: [],
    on,
    commands,
    ...extra,
    record: { parameters, parts: [], ...extra.record },
  });
  const XY = ["AngleX", "AngleY"];
  return [
    v(
      "v-curves",
      "ds-plain",
      each(0.125, 18),
      [],
      [motion(0, m("vec-curves"))],
      ["AngleX", "AngleY", "AngleZ", "PositionX", "PositionY"],
    ),
    v(
      "v-curves-r",
      "ds-plain",
      each(0.125, 18),
      [],
      [motion(0, m("vec-curves-r"))],
      ["AngleY", "AngleZ"],
    ),
    v(
      "v-fades",
      "ds-plain",
      each(0.125, 40),
      [],
      [motion(0, m("vec-fadeA")), motion(12, m("vec-fadeB"), { priority: 3 })],
      XY,
    ),
    v("v-loop", "ds-plain", each(0.0625, 40), [], [motion(0, m("vec-loop"), { loop: true })], XY),
    v(
      "v-expr",
      "ds-plain",
      each(0.125, 24),
      ["expressions"],
      [motion(0, m("vec-base")), expr(0, e("vec-e1")), expr(8, e("vec-e2"))],
      XY,
    ),
    v(
      "v-physics",
      "vec-phys",
      listOf([...repeat(12, 1 / 60), ...repeat(6, 0.05)]),
      ["physics"],
      [motion(0, m("vec-step"))],
      ["AngleX", "AngleZ"],
    ),
    v("v-pose", "vec-pose", each(0.1, 30), ["pose"], [motion(0, m("vec-pose"))], [], {
      record: { parts: ["Part99", "Part64", "Part116"], free: ["Part99", "Part116", "Part64"] },
    }),
    v("v-blink", "ds-plain", each(0.05, 60), ["blink"], [], ["ParamEyeLOpen"], {
      random: [0.25, 0.75, 0.5],
    }),
    v(
      "v-drag",
      "ds-plain",
      each(1 / 60, 40),
      ["look"],
      [look(0, 1, 0)],
      ["ParamAngleX", "ParamAngleZ", "ParamBodyAngleX", "ParamEyeBallX"],
    ),
    v(
      "v-breath",
      "ds-plain",
      each(0.25, 12),
      ["breath"],
      [],
      ["ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamBreath"],
    ),
    v(
      "v-lip",
      "ds-plain",
      each(1 / 30, 32),
      ["lipsync"],
      [sound(0, "vec.wav")],
      ["ParamMouthOpenY"],
    ),
  ];
}

function a7(): AnimSpec[] {
  const q = (
    id: string,
    commands: Command[],
    extra: Partial<AnimSpec> & { frames?: number } = {},
  ): AnimSpec => {
    const { frames, ...rest } = extra;
    return {
      id,
      model: animQ("q-plain"),
      steps: each(1 / 30, frames ?? 40),
      random: [],
      on: [],
      commands,
      ...rest,
      record: {
        parameters: ["ParamEyeBallX", "ParamEyeBallY", "ParamMouthOpenY"],
        parts: [],
        ...rest.record,
      },
    };
  };
  const poseRecord = {
    parameters: [],
    parts: ["Part99", "Part64", "Part116", "Part66", "Part10", "Part8", "Part47", "Part81"],
    free: ["Part99", "Part116", "Part66", "Part10", "Part81"],
  };
  const stop = (frame: number): Command => ({ frame, do: "stopMotions" });
  return [
    q("q1-stop-same", [
      motion(0, m("m-long")),
      stop(10),
      motion(11, m("m-short")),
      motion(20, m("m-short"), { priority: 3 }),
    ]),
    q("q1-stop-low", [
      motion(0, m("m-long")),
      stop(10),
      motion(11, m("m-short"), { priority: 1 }),
      motion(12, m("m-short")),
    ]),
    q("q1-stop-idle", [motion(0, m("m-long")), stop(10)], {
      random: repeat(40, 0.5),
      on: ["idle"],
      idleMotions: [m("m-short")],
    }),
    q("q1-natural", [motion(0, m("m-short")), motion(30, m("m-short"))]),
    q("q2-loop-025", [motion(0, m("m-ev-loop"), { loop: true })], { steps: each(0.25, 20) }),
    q("q2-loop-030", [motion(0, m("m-ev-loop"), { loop: true })], { steps: each(0.3, 20) }),
    q("q2-once-025", [motion(0, m("m-ev-loop"))], { steps: each(0.25, 8) }),
    ...["m-nocc", "m-nosc", "m-nopc", "m-empty-nocounts", "m-empty-zero"].map((name) =>
      q(`q5-${name}`, [motion(0, m(name))], { frames: 5 }),
    ),
    q("q6-float-during", [sound(0, "w16m44.wav"), sound(10, "wfloat.wav")], {
      frames: 30,
      on: ["lipsync"],
    }),
    q("q6-pcm-during", [sound(0, "w16m44.wav"), sound(10, "w16m44.wav")], {
      frames: 30,
      on: ["lipsync"],
    }),
    q("q7-pose-first", [], {
      model: animQ("q-pose"),
      steps: each(0.1, 6),
      on: ["pose"],
      record: poseRecord,
    }),
    q("q7-pose-late", [{ frame: 10, do: "enable", effect: "pose" }], {
      model: animQ("q-pose"),
      steps: each(0.1, 16),
      on: [],
      record: poseRecord,
    }),
    ...["e-add2", "e-over2", "e-mul2", "e-add-over", "e-over-add"].map((name) =>
      q(`q8-${name}`, [motion(0, m("m-base")), expr(0, e(name))], {
        frames: 6,
        on: ["expressions"],
      }),
    ),
  ];
}

/** 4v: the 104 animation scenarios. */
export function animationCatalog(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const add = (group: string, s: AnimSpec) =>
    out.push({ id: s.id, kind: "animation", group, scenario: animScenario(s) });
  const rows1 = a1();
  const rows2 = a2();
  rows1.forEach((s) => add("A1", s));
  rows2.forEach((s) => add("A2", s));
  for (const s of rows2.filter((r) => r.id.startsWith("cra-segs-")))
    add("A3", { ...s, id: `${s.id}-repeat`, options: { ...s.options, wrap: true } });
  const settle = [
    "dsa-take-60fps",
    "dsa-take-jitter",
    "dsa-everything",
    "cra-phys-nofps",
    "cra-phys-fps30",
    "cra-phys-options",
    "cra-ds-phys-options",
  ];
  for (const id of settle) {
    const s = [...rows1, ...rows2].find((r) => r.id === id)!;
    add("A4", { ...s, id: `${id}-stab`, options: { ...s.options, settle: true } });
  }
  a5().forEach((s) => add("A5", s));
  a6().forEach((s) => add("A6", s));
  a7().forEach((s) => add("A7", s));
  return out;
}

/** All 827 scenarios. */
export function fullCatalog(): CatalogEntry[] {
  const all = [...staticCatalog(), ...sequenceCatalog(), ...renderCatalog(), ...animationCatalog()];
  const seen = new Set<string>();
  for (const e of all) {
    if (seen.has(e.id)) throw new Error(`catalog: duplicate id ${e.id}`);
    seen.add(e.id);
  }
  return all;
}

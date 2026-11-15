/**
 * The sequence and animation file formats of the conformance tools (4e and
 * 4i–4k): parsing with the `InvalidScenario` rules, the run protocols, and
 * the result objects `mochi2d-sequence-result/0` and `mochi2d-anim-result/0`.
 */
import { ModelInstance } from "../core/eval/instance.js";
import { snapshotInstance, type ModelSnapshot } from "../core/model/snapshot.js";
import type { MocModel } from "../core/moc/model.js";
import {
  runAnimationScenarioReport,
  type AnimationScenario,
  type ScenarioCommand,
} from "../anim/scenario.js";
import type { EffectSwitches } from "../anim/animator.js";
import { ID_RE, ScenarioError, knownFormat } from "./scenario.js";
import { errorInfo, type ScenarioModels } from "./models.js";
import { AnimationFormatError } from "../anim/json.js";

export const SEQUENCE_FORMAT = "mochi2d-sequence/0";
export const SEQUENCE_RESULT_FORMAT = "mochi2d-sequence-result/0";
export const ANIM_FORMAT = "mochi2d-anim-scenario/0";
export const ANIM_RESULT_FORMAT = "mochi2d-anim-result/0";

type Json = Record<string, unknown>;
type ErrorInfo = null | { kind: string; message: string };

const fail = (message: string): never => {
  throw new ScenarioError(message);
};
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function numberRecord(v: unknown, field: string): Record<string, number> {
  if (v === undefined) return {};
  if (!isObject(v)) fail(`"${field}" must be an object`);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Json)) {
    if (!finite(n)) fail(`"${field}.${k}" must be a finite number`);
    out[k] = n as number;
  }
  return out;
}

function header(json: unknown, format: string): { o: Json; id: string; model: string } {
  if (!isObject(json)) fail("scenario must be a JSON object");
  const o = json as Json;
  if (knownFormat(o.format) !== format)
    fail(`"format" must be "${format}" (got ${JSON.stringify(o.format)})`);
  if (typeof o.id !== "string" || !ID_RE.test(o.id))
    fail(`"id" must match ${ID_RE} (it is used as a file name)`);
  if (typeof o.model !== "string" || o.model === "") fail(`"model" is required`);
  return { o, id: o.id as string, model: o.model as string };
}

// --- Sequences (4e) ---

export interface SequenceStep {
  label: string;
  parameters: Record<string, number>;
  partOpacities: Record<string, number>;
}

export interface Sequence {
  id: string;
  model: string;
  steps: SequenceStep[];
}

export function parseSequence(json: unknown): Sequence {
  const { o, id, model } = header(json, SEQUENCE_FORMAT);
  if (!Array.isArray(o.steps)) fail(`"steps" must be an array`);
  const steps = (o.steps as unknown[]).map((s, i) => {
    if (!isObject(s)) fail(`steps[${i}] must be an object`);
    const st = s as Json;
    if (st.label !== undefined && typeof st.label !== "string")
      fail(`steps[${i}].label must be a string`);
    return {
      label: (st.label as string | undefined) ?? `s${i + 1}`,
      parameters: numberRecord(st.parameters, `steps[${i}].parameters`),
      partOpacities: numberRecord(st.partOpacities, `steps[${i}].partOpacities`),
    };
  });
  return { id, model, steps };
}

export interface SequenceResult {
  format: typeof SEQUENCE_RESULT_FORMAT;
  producer: string;
  error: ErrorInfo;
  warnings: string[];
  sequence: string;
  canvas: ModelSnapshot["canvas"];
  steps: ({ label: string } & Omit<ModelSnapshot, "canvas">)[];
}

/** Writes a step's values into the instance (values persist, 4e); returns warnings. */
function writeInputs(inst: ModelInstance, step: SequenceStep): string[] {
  const warnings: string[] = [];
  for (const [pid, value] of Object.entries(step.parameters)) {
    const i = inst.parameterIndex(pid);
    if (i < 0) warnings.push(`${step.label}: unknown parameter ${pid}`);
    else inst.setParameter(i, value);
  }
  for (const [pid, value] of Object.entries(step.partOpacities)) {
    const i = inst.partIndex(pid);
    if (i < 0) warnings.push(`${step.label}: unknown part ${pid}`);
    else inst.setPartOpacity(i, value);
  }
  return warnings;
}

const record = (label: string, s: ModelSnapshot) => ({
  label,
  parameters: s.parameters,
  parts: s.parts,
  drawables: s.drawables,
  ...(s.offscreens ? { offscreens: s.offscreens } : {}),
});

/** The run protocol of 4e: one fresh instance, `create`, then one evaluation per step. */
export function runSequence(
  seq: Sequence,
  models: ScenarioModels,
  producer: string,
): SequenceResult {
  const result: SequenceResult = {
    format: SEQUENCE_RESULT_FORMAT,
    producer,
    error: null,
    warnings: [],
    sequence: seq.id,
    canvas: {},
    steps: [],
  };
  try {
    const { model } = models.load(seq.model);
    result.warnings.push(...model.loadWarnings);
    const inst = new ModelInstance(model); // the creation evaluation
    const first = snapshotInstance(inst);
    result.canvas = first.canvas;
    result.steps.push(record("create", first));
    for (const step of seq.steps) {
      result.warnings.push(...writeInputs(inst, step));
      inst.evaluate();
      result.steps.push(record(step.label, snapshotInstance(inst)));
    }
  } catch (e) {
    result.error = errorInfo(e);
    result.canvas = {};
    result.steps = [];
  }
  return result;
}

// --- Animation scenarios (4i–4k) ---

const EFFECTS: Record<string, keyof EffectSwitches> = {
  idle: "idle",
  blink: "eyeBlink",
  expressions: "expressions",
  look: "look",
  breath: "breath",
  physics: "physics",
  lipsync: "lipSync",
  pose: "pose",
};

export interface AnimFile {
  id: string;
  model: string;
  steps: number[];
  random: number[];
  effects: Partial<EffectSwitches>;
  idleMotions?: string[];
  options: NonNullable<AnimationScenario["options"]>;
  commands: { frame: number; command: ScenarioCommand }[];
  record: {
    parameters: "all" | string[];
    parts: "all" | string[];
    free: string[];
    every: number;
    hits: { frame: number; drawable: string; x: number; y: number }[];
    drawables: number[];
  };
}

const bool = (v: unknown, what: string, fallback: boolean): boolean => {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") fail(`${what} must be true or false`);
  return v as boolean;
};
const num = (v: unknown, what: string): number => {
  if (!finite(v)) fail(`${what} must be a finite number`);
  return v as number;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v === "") fail(`${what} must be a non-empty string`);
  return v as string;
};
const pair = (v: unknown, what: string): [number, number] => {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(finite)) fail(`${what} must be [x, y]`);
  return v as [number, number];
};
const idList = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
    fail(`${what} must be a list of IDs`);
  return v as string[];
};

export function parseAnimScenario(json: unknown): AnimFile {
  const { o, id, model } = header(json, ANIM_FORMAT);
  // Steps: dt and frames, or dts.
  let steps: number[];
  if (o.dts !== undefined) {
    if (o.dt !== undefined || o.frames !== undefined)
      fail(`give either "dt" and "frames" or "dts"`);
    if (!Array.isArray(o.dts) || !o.dts.every((d) => finite(d) && d >= 0))
      fail(`"dts" must be a list of steps ≥ 0`);
    steps = o.dts as number[];
  } else {
    const dt = num(o.dt, `"dt"`);
    if (dt < 0) fail(`"dt" must be ≥ 0`);
    if (typeof o.frames !== "number" || !Number.isInteger(o.frames) || o.frames < 0)
      fail(`"frames" must be an integer ≥ 0`);
    steps = new Array<number>(o.frames as number).fill(dt);
  }
  const N = steps.length;
  const random = o.random ?? [];
  if (!Array.isArray(random) || !random.every((r) => finite(r) && r >= 0 && r < 1))
    fail(`"random" must be a list of numbers in [0, 1)`);
  const effects: Partial<EffectSwitches> = {};
  if (o.effects !== undefined) {
    if (!isObject(o.effects)) fail(`"effects" must be an object`);
    for (const [k, v] of Object.entries(o.effects as Json))
      if (k in EFFECTS) effects[EFFECTS[k]!] = bool(v, `"effects.${k}"`, true);
  }
  let idleMotions: string[] | undefined;
  if (o.idleMotions !== undefined) {
    if (!Array.isArray(o.idleMotions) || !o.idleMotions.every((x) => typeof x === "string" && x))
      fail(`"idleMotions" must be a list of motion files`);
    idleMotions = o.idleMotions as string[];
  }
  const options: AnimFile["options"] = {};
  if (o.options !== undefined) {
    if (!isObject(o.options)) fail(`"options" must be an object`);
    const op = o.options as Json;
    if (op.wrap !== undefined) options.wrap = bool(op.wrap, `"options.wrap"`, false);
    if (op.gravity !== undefined) options.gravity = pair(op.gravity, `"options.gravity"`);
    if (op.wind !== undefined) options.wind = pair(op.wind, `"options.wind"`);
    if (op.settle !== undefined) options.settle = bool(op.settle, `"options.settle"`, false);
    if (op.blinkTiming !== undefined) {
      const t = op.blinkTiming;
      if (!Array.isArray(t) || t.length !== 4 || !t.every((x) => finite(x) && x >= 0))
        fail(`"options.blinkTiming" must be [interval, closing, closed, opening]`);
      const [interval, closing, closed, opening] = t as number[];
      options.eyeBlink = {
        interval: interval!,
        closing: closing!,
        closed: closed!,
        opening: opening!,
      };
    }
  }
  const commands: AnimFile["commands"] = [];
  if (o.commands !== undefined) {
    if (!Array.isArray(o.commands)) fail(`"commands" must be an array`);
    let last = 0;
    (o.commands as unknown[]).forEach((c, i) => {
      const what = `commands[${i}]`;
      if (!isObject(c)) fail(`${what} must be an object`);
      const cmd = c as Json;
      const frame = cmd.frame;
      if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 0 || frame >= N)
        fail(`${what}.frame must be an integer in [0, ${N})`);
      if ((frame as number) < last) fail(`${what}: commands must be in non-decreasing frame order`);
      last = frame as number;
      commands.push({ frame: frame as number, command: parseCommand(cmd, what) });
    });
  }
  const rec = o.record === undefined ? {} : o.record;
  if (!isObject(rec)) fail(`"record" must be an object`);
  const r = rec as Json;
  const allOr = (v: unknown, what: string): "all" | string[] =>
    v === undefined || v === "all" ? "all" : idList(v, what);
  let every = 1;
  if (r.every !== undefined) {
    if (typeof r.every !== "number" || !Number.isInteger(r.every) || r.every < 1)
      fail(`"record.every" must be an integer ≥ 1`);
    every = r.every as number;
  }
  const frameIn = (f: unknown, what: string) => {
    if (typeof f !== "number" || !Number.isInteger(f) || f < 0 || f >= N)
      fail(`${what} must be a frame number in [0, ${N})`);
    return f as number;
  };
  const hits = (r.hits === undefined ? [] : r.hits) as unknown;
  if (!Array.isArray(hits)) fail(`"record.hits" must be an array`);
  const drawables = (r.drawables === undefined ? [] : r.drawables) as unknown;
  if (!Array.isArray(drawables)) fail(`"record.drawables" must be a list of frames`);
  return {
    id,
    model,
    steps,
    random: random as number[],
    effects,
    ...(idleMotions ? { idleMotions } : {}),
    options,
    commands,
    record: {
      parameters: allOr(r.parameters, `"record.parameters"`),
      parts: allOr(r.parts, `"record.parts"`),
      free: r.free === undefined ? [] : idList(r.free, `"record.free"`),
      every,
      hits: (hits as unknown[]).map((h, i) => {
        const what = `record.hits[${i}]`;
        if (!isObject(h)) fail(`${what} must be an object`);
        const hh = h as Json;
        return {
          frame: frameIn(hh.frame, `${what}.frame`),
          drawable: str(hh.drawable, `${what}.drawable`),
          x: num(hh.x, `${what}.x`),
          y: num(hh.y, `${what}.y`),
        };
      }),
      drawables: (drawables as unknown[]).map((f, i) => frameIn(f, `record.drawables[${i}]`)),
    },
  };
}

function parseCommand(c: Json, what: string): ScenarioCommand {
  switch (c.do) {
    case "motion": {
      const hasFile = c.file !== undefined;
      const hasGroup = c.group !== undefined || c.index !== undefined;
      if (hasFile === hasGroup) fail(`${what}: a motion needs "file", or "group" and "index"`);
      const cmd: ScenarioCommand & { kind: "startMotion" } = { kind: "startMotion" };
      if (hasFile) cmd.file = str(c.file, `${what}.file`);
      else {
        cmd.group = str(c.group, `${what}.group`);
        if (typeof c.index !== "number" || !Number.isInteger(c.index) || c.index < 0)
          fail(`${what}.index must be an integer ≥ 0`);
        cmd.index = c.index as number;
        if (c.FadeInTime !== undefined || c.FadeOutTime !== undefined)
          fail(`${what}: FadeInTime and FadeOutTime are allowed only with "file"`);
      }
      cmd.priority = c.priority === undefined ? 2 : num(c.priority, `${what}.priority`);
      if (c.FadeInTime !== undefined) cmd.fadeIn = num(c.FadeInTime, `${what}.FadeInTime`);
      if (c.FadeOutTime !== undefined) cmd.fadeOut = num(c.FadeOutTime, `${what}.FadeOutTime`);
      cmd.loop = bool(c.loop, `${what}.loop`, false);
      cmd.loopFadeIn = bool(c.loopFade, `${what}.loopFade`, true);
      cmd.weight = c.weight === undefined ? 1 : num(c.weight, `${what}.weight`);
      cmd.offset = c.offset === undefined ? 0 : num(c.offset, `${what}.offset`);
      cmd.legacyLoop = bool(c.legacyLoop, `${what}.legacyLoop`, false);
      return cmd;
    }
    case "expression":
      if ((c.file === undefined) === (c.name === undefined))
        fail(`${what}: an expression needs "file" or "name"`);
      return c.file !== undefined
        ? { kind: "startExpression", file: str(c.file, `${what}.file`) }
        : { kind: "startExpression", name: str(c.name, `${what}.name`) };
    case "look":
      return { kind: "setLookTarget", x: num(c.x, `${what}.x`), y: num(c.y, `${what}.y`) };
    case "sound":
      return { kind: "startSound", file: str(c.file, `${what}.file`) };
    case "partOpacity":
      return {
        kind: "setPartOpacity",
        id: str(c.id, `${what}.id`),
        value: num(c.value, `${what}.value`),
      };
    case "stopMotions":
      return { kind: "stopMotions" };
    case "enable": {
      const effect = EFFECTS[str(c.effect, `${what}.effect`)];
      if (!effect) fail(`${what}.effect must be one of ${Object.keys(EFFECTS).join(", ")}`);
      return { kind: "enable", effect: effect! };
    }
    default:
      return fail(`${what}: unknown command ${JSON.stringify(c.do)}`);
  }
}

export interface AnimFrameRecord {
  frame: number;
  time: number;
  parameters: (number | null)[];
  parts: (number | null)[];
  free: (number | null)[];
  modelOpacity: number;
  motionAdvanced: boolean;
  queueEmpty: boolean;
  events: string[];
  lipsync: number | null;
  hits?: { drawable: string; x: number; y: number; hit: boolean; box: number[] | null }[];
  drawables?: unknown[];
}

export interface AnimResult {
  format: typeof ANIM_RESULT_FORMAT;
  producer: string;
  error: ErrorInfo;
  warnings: string[];
  scenario: string;
  ids: { parameters: string[]; parts: string[]; free: string[] };
  frames: AnimFrameRecord[];
  starts: { frame: number; command?: number; idle?: number; started: boolean }[];
  randomUsed: number;
}

/** Index of each ID in `ids` (−1 when the model does not have it). */
function indexer(all: readonly string[]): (id: string) => number {
  const map = new Map<string, number>();
  all.forEach((id, i) => map.has(id) || map.set(id, i));
  return (id) => map.get(id) ?? -1;
}

/** The run protocol of 4j and the result of 4k. */
export function runAnimFile(sc: AnimFile, models: ScenarioModels, producer: string): AnimResult {
  const result: AnimResult = {
    format: ANIM_RESULT_FORMAT,
    producer,
    error: null,
    warnings: [],
    scenario: sc.id,
    ids: { parameters: [], parts: [], free: sc.record.free },
    frames: [],
    starts: [],
    randomUsed: 0,
  };
  let model: MocModel;
  let loaded;
  try {
    loaded = models.load(sc.model);
    model = loaded.model;
  } catch (e) {
    result.error = errorInfo(e);
    return result;
  }
  result.warnings.push(...model.loadWarnings);
  const paramIds =
    sc.record.parameters === "all" ? [...model.parameters.ids] : sc.record.parameters;
  const partIds = sc.record.parts === "all" ? [...model.parts.ids] : sc.record.parts;
  result.ids = { parameters: paramIds, parts: partIds, free: sc.record.free };
  const pIndex = indexer(model.parameters.ids);
  const partIndex = indexer(model.parts.ids);
  const pIdx = paramIds.map(pIndex);
  const partIdx = partIds.map(partIndex);
  pIdx.forEach(
    (i, k) =>
      i < 0 && result.warnings.push(`unknown parameter ${paramIds[k]} in record.parameters`),
  );
  partIdx.forEach(
    (i, k) => i < 0 && result.warnings.push(`unknown part ${partIds[k]} in record.parts`),
  );
  let report;
  try {
    report = runAnimationScenarioReport({
      model,
      settings: loaded.settings,
      files: (path) => loaded.read(path),
      steps: sc.steps,
      commands: sc.commands,
      random: sc.random,
      effects: sc.effects,
      ...(sc.idleMotions ? { idleMotions: sc.idleMotions } : {}),
      options: sc.options,
      record: {
        freeValues: sc.record.free,
        hits: sc.record.hits,
        drawables: sc.record.drawables,
      },
    });
  } catch (e) {
    // The settings name a physics or pose file that is missing or invalid (4j).
    const info = errorInfo(e);
    result.error =
      e instanceof AnimationFormatError ? { kind: "ModelLoadError", message: info.message } : info;
    return result;
  }
  result.warnings.push(...report.warnings);
  const N = sc.steps.length;
  const forced = new Set<number>([...sc.record.hits.map((h) => h.frame), ...sc.record.drawables]);
  for (const f of report.frames) {
    const k = f.frame;
    if (!(k % sc.record.every === 0 || k === N - 1 || forced.has(k))) continue;
    const out: AnimFrameRecord = {
      frame: k,
      time: f.time,
      parameters: pIdx.map((i) => (i < 0 ? null : f.parameters[i]!)),
      parts: partIdx.map((i) => (i < 0 ? null : f.partOpacities[i]!)),
      free: sc.record.free.map((id) => f.freeValues[id] ?? null),
      modelOpacity: f.modelOpacity,
      motionAdvanced: f.motionUpdated,
      queueEmpty: f.queueEmpty,
      events: f.events,
      lipsync: f.lipSync,
    };
    if (f.hitRecords)
      out.hits = f.hitRecords.map((h) => ({ ...h, box: h.box ? [...h.box] : null }));
    if (f.drawables) out.drawables = f.drawables;
    result.frames.push(out);
  }
  result.starts = report.starts.map((s) => ({
    frame: s.frame,
    ...(s.command !== undefined ? { command: s.command } : {}),
    ...(s.idle !== undefined ? { idle: s.idle } : {}),
    started: s.started,
  }));
  result.randomUsed = report.randomUsed;
  if (report.randomExhausted)
    result.error = {
      kind: "RandomExhausted",
      message: `the random list (${sc.random.length} numbers) ran out in frame ${report.frames.length}`,
    };
  return result;
}

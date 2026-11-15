/** Static scenarios (mochi2d-scenario/0, 4b–4d): the format and its parser. */
import { currentFormatName } from "../core/format-names.js";

export const SCENARIO_FORMAT = "mochi2d-scenario/0";

export interface Scenario {
  format: typeof SCENARIO_FORMAT;
  id: string;
  /** Settings file relative to assets/models/. Required unless `x-builtinScene` is set. */
  model?: string;
  parameters: Record<string, number>;
  partOpacities: Record<string, number>;
  render?: ScenarioRender;
  /** Non-standard extension: render a built-in test scene instead of a model (render tool only). */
  "x-builtinScene"?: string;
}

/** The render block (§2i). */
export interface ScenarioRender {
  width: number;
  height: number;
  /** Straight-alpha RGBA in [0, 1]; default transparent. */
  background?: [number, number, number, number];
  /** Image center (output units) and image pixels per model unit; default: fit the canvas. */
  view?: { x: number; y: number; pixelsPerUnit: number };
}

/** A malformed scenario (error kind `InvalidScenario`, 4b). */
export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScenario";
  }
}

/** Format names and major versions this reader knows (4b). */
export const KNOWN_FORMATS = [
  "mochi2d-scenario/0",
  "mochi2d-sequence/0",
  "mochi2d-anim-scenario/0",
] as const;

/**
 * The known format a `format` value names, or null. A minor part after the
 * major version ("/0.1") is accepted; any other name or major is unknown.
 * Names from before the rename (`lively2d-…`) are read as the current ones.
 */
export function knownFormat(format: unknown): (typeof KNOWN_FORMATS)[number] | null {
  const name = currentFormatName(format);
  if (typeof name !== "string") return null;
  const m = /^([A-Za-z0-9._-]+)\/(\d+)(?:\.\d+)*$/.exec(name);
  if (!m) return null;
  const key = `${m[1]}/${Number(m[2])}`;
  return (KNOWN_FORMATS as readonly string[]).includes(key)
    ? (key as (typeof KNOWN_FORMATS)[number])
    : null;
}

/** Parses JSON text, skipping a leading byte-order mark (4b). */
export function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_RENDER_SIZE = 8192;

function numberRecord(v: unknown, field: string): Record<string, number> {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ScenarioError(`"${field}" must be an object`);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (typeof n !== "number" || !Number.isFinite(n))
      throw new ScenarioError(`"${field}.${k}" must be a finite number`);
    out[k] = n;
  }
  return out;
}

/** Validates a parsed JSON value as a scenario. */
export function parseScenario(json: unknown): Scenario {
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new ScenarioError("scenario must be a JSON object");
  const o = json as Record<string, unknown>;
  if (knownFormat(o.format) !== SCENARIO_FORMAT)
    throw new ScenarioError(
      `"format" must be "${SCENARIO_FORMAT}" (got ${JSON.stringify(o.format)})`,
    );
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) {
    throw new ScenarioError(`"id" must match ${ID_RE} (it is used as a file name)`);
  }
  const builtin = o["x-builtinScene"];
  if (builtin !== undefined && typeof builtin !== "string")
    throw new ScenarioError(`"x-builtinScene" must be a string`);
  if (o.model !== undefined && typeof o.model !== "string")
    throw new ScenarioError(`"model" must be a string`);
  if (o.model === undefined && builtin === undefined)
    throw new ScenarioError(`"model" is required`);
  const sc: Scenario = {
    format: SCENARIO_FORMAT,
    id: o.id,
    parameters: numberRecord(o.parameters, "parameters"),
    partOpacities: numberRecord(o.partOpacities, "partOpacities"),
  };
  if (typeof o.model === "string") sc.model = o.model;
  if (builtin !== undefined) sc["x-builtinScene"] = builtin;
  if (o.render !== undefined) {
    const r = o.render as Record<string, unknown>;
    if (typeof r !== "object" || r === null) throw new ScenarioError(`"render" must be an object`);
    const ok = (n: unknown) =>
      typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_RENDER_SIZE;
    if (!ok(r.width) || !ok(r.height))
      throw new ScenarioError(
        `"render.width" and "render.height" must be integers in [1, ${MAX_RENDER_SIZE}]`,
      );
    sc.render = { width: r.width as number, height: r.height as number };
    if (r.background !== undefined) {
      const bg = r.background;
      if (
        !Array.isArray(bg) ||
        bg.length !== 4 ||
        !bg.every((v) => typeof v === "number" && v >= 0 && v <= 1)
      )
        throw new ScenarioError(`"render.background" must be 4 numbers in [0, 1] (straight RGBA)`);
      sc.render.background = bg as [number, number, number, number];
    }
    if (r.view !== undefined) {
      const v = r.view as Record<string, unknown>;
      const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
      if (
        typeof v !== "object" ||
        v === null ||
        !finite(v.x) ||
        !finite(v.y) ||
        !finite(v.pixelsPerUnit) ||
        !((v.pixelsPerUnit as number) > 0)
      )
        throw new ScenarioError(
          `"render.view" must be { x, y, pixelsPerUnit } with finite numbers and pixelsPerUnit > 0`,
        );
      sc.render.view = {
        x: v.x as number,
        y: v.y as number,
        pixelsPerUnit: v.pixelsPerUnit as number,
      };
    }
  }
  return sc;
}

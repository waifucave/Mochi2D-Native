/**
 * Result generation as a library call (docs/api.md, "Conformance results"):
 * the result object of a static, sequence or animation scenario for a given
 * model, exactly as `npm run conformance` writes it (the result contract,
 * 1d; 4d, 4e, 4k).
 */
import { loadMoc, type MocModel } from "../core/moc/model.js";
import { MocFormatError } from "../core/moc/read.js";
import {
  parseModelSettings,
  settingsFromJson,
  type ModelSettings,
} from "../core/settings/model-settings.js";
import { dirnameOf, joinPath, normalizePath, type FileSource } from "../core/io/file-source.js";
import { classifyModelFile } from "../core/io/model-files.js";
import { resolveSettingsPath } from "../runtime/bundle.js";
import { MOCHI2D_VERSION } from "../lib/version.js";
import { ModelLoadError, type ScenarioModel, type ScenarioModels } from "./models.js";
import {
  RESULT_FORMAT,
  invalidResult,
  runScenarioJson,
  scenarioKind,
  type AnyScenarioResult,
} from "./run.js";
import { ID_RE } from "./scenario.js";

/** The model a scenario runs on. */
export interface ResultModel {
  /** The `.moc3`: its bytes, or a model from `loadMoc`. */
  moc: ArrayBuffer | ArrayBufferView | MocModel;
  /**
   * The settings (`model3.json`): its bytes or text, or parsed. Needed by
   * animation scenarios that use the settings (motions, physics, pose…);
   * without it, the model has empty settings.
   */
  settings?: ModelSettings | Uint8Array | string;
  /** Reads another file of the model (motions, expressions, physics, sounds), relative to the settings file's folder; undefined when missing. */
  read?: (path: string) => Uint8Array | undefined;
}

export interface ScenarioResultOptions {
  /** The result's `producer` (default "mochi2d@<version>"). */
  producer?: string;
  /** Reject keyform draw orders outside their group's range (C12's strict mode); default false. */
  strictDrawOrders?: boolean;
}

/** Settings with no files but the `.moc3` (for models given without settings). */
const emptySettings = (): ModelSettings =>
  settingsFromJson({ Version: 3, FileReferences: { Moc: "model.moc3", Textures: [] } }, "(none)");

const bytesOf = (b: ArrayBuffer | ArrayBufferView): Uint8Array =>
  ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);

const isBytes = (x: unknown): x is ArrayBuffer | ArrayBufferView =>
  x instanceof ArrayBuffer || ArrayBuffer.isView(x);

/**
 * Runs `scenario` (a parsed JSON object of format `mochi2d-scenario/0`,
 * `mochi2d-sequence/0` or `mochi2d-anim-scenario/0`) on `model` and returns
 * its result object. The scenario's `model` member is not needed: the model
 * is given. Never throws for bad input: a scenario that does not parse gives
 * an `InvalidScenario` error, a `.moc3` that does not load a
 * `ModelLoadError`, as in `npm run conformance`. Serialize with
 * `formatResultJson` (animation results with `"double"`).
 */
export function scenarioResult(
  model: ResultModel,
  scenario: unknown,
  options: ScenarioResultOptions = {},
): AnyScenarioResult {
  const producer = options.producer ?? `mochi2d@${MOCHI2D_VERSION}`;
  const o =
    typeof scenario === "object" && scenario !== null && !Array.isArray(scenario)
      ? (scenario as Record<string, unknown>)
      : null;
  const id = typeof o?.id === "string" && ID_RE.test(o.id) ? o.id : "scenario";
  const kind = scenarioKind(o);
  if (!o || !kind)
    return invalidResult(
      id,
      RESULT_FORMAT,
      producer,
      o ? `unknown format ${JSON.stringify(o.format)}` : "scenario must be a JSON object",
    );
  let loaded: ScenarioModel | undefined;
  const models: ScenarioModels = {
    load(): ScenarioModel {
      loaded ??= loadResultModel(model, options);
      return loaded;
    },
  };
  const json = typeof o.model === "string" ? o : { ...o, model: "(given)" };
  return runScenarioJson(kind, json, id, models, producer);
}

function loadResultModel(model: ResultModel, options: ScenarioResultOptions): ScenarioModel {
  let settings: ModelSettings;
  try {
    const s = model.settings;
    settings =
      s === undefined
        ? emptySettings()
        : typeof s === "string"
          ? settingsFromJson(JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s), "model3.json")
          : isBytes(s)
            ? parseModelSettings(bytesOf(s), "model3.json")
            : s;
  } catch (e) {
    throw new ModelLoadError(`settings file: ${(e as Error).message}`);
  }
  let moc: MocModel;
  if (isBytes(model.moc)) {
    try {
      moc = loadMoc(model.moc, options.strictDrawOrders ? { drawOrderRange: "reject" } : {});
    } catch (e) {
      if (!(e instanceof MocFormatError)) throw e;
      throw new ModelLoadError(`${settings.moc}: ${e.message}`);
    }
  } else moc = model.moc;
  const read = model.read ?? (() => undefined);
  return { settings, model: moc, read };
}

/**
 * A {@link ResultModel} from a file source: the settings file (the given one,
 * else the only or shallowest `*.model3.json`), its `.moc3`, and the files
 * scenarios can use (motions, expressions, physics, pose, user data,
 * display info, sounds), read ahead so `scenarioResult` runs synchronously.
 */
export async function resultModelFromSource(
  source: FileSource,
  settingsPath?: string,
): Promise<ResultModel> {
  const path = resolveSettingsPath(source, settingsPath);
  const settingsBytes = await source.read(path);
  const settings = parseModelSettings(settingsBytes, path);
  const dir = dirnameOf(path);
  const moc = await source.read(joinPath(dir, settings.moc));
  const wanted = new Set<string>();
  for (const f of [settings.physics, settings.pose, settings.userData, settings.displayInfo])
    if (f) wanted.add(normalizePath(joinPath(dir, f)));
  for (const e of settings.expressions) wanted.add(normalizePath(joinPath(dir, e.file)));
  for (const g of settings.motions)
    for (const m of g.entries) {
      wanted.add(normalizePath(joinPath(dir, m.file)));
      if (m.sound) wanted.add(normalizePath(joinPath(dir, m.sound)));
    }
  const prefix = dir ? `${dir}/` : "";
  for (const f of source.list() ?? []) {
    const kind = classifyModelFile(f);
    if (
      f.startsWith(prefix) &&
      (kind === "motion" ||
        kind === "expression" ||
        kind === "physics" ||
        kind === "pose" ||
        kind === "userdata" ||
        kind === "displayinfo" ||
        kind === "sound")
    )
      wanted.add(normalizePath(f));
  }
  const files = new Map<string, Uint8Array>();
  for (const f of wanted) {
    try {
      files.set(f, await source.read(f));
    } catch {
      // A missing file is reported by the scenario that needs it.
    }
  }
  return {
    moc,
    settings,
    read: (p) => {
      try {
        return files.get(normalizePath(joinPath(dir, p)));
      } catch {
        return undefined;
      }
    },
  };
}

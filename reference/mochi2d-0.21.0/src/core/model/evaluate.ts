import { dirnameOf, joinPath, type FileSource } from "../io/file-source.js";
import { parseModelSettings, type ModelSettings } from "../settings/model-settings.js";
import { loadMoc, type LoadMocOptions, type MocModel } from "../moc/model.js";
import { ModelInstance } from "../eval/instance.js";
import {
  applyRequest,
  snapshotInstance,
  type EvaluationRequest,
  type ModelSnapshot,
} from "./snapshot.js";

export interface LoadedModel {
  settings: ModelSettings;
  /** Path of the settings file inside the source. */
  settingsPath: string;
  model: MocModel;
}

/** Reads a settings file and the `.moc3` it references. */
export async function loadModelFromSource(
  source: FileSource,
  settingsPath: string,
  options: LoadMocOptions = {},
): Promise<LoadedModel> {
  const settings = parseModelSettings(await source.read(settingsPath), settingsPath);
  const mocPath = joinPath(dirnameOf(settingsPath), settings.moc);
  const model = loadMoc(await source.read(mocPath), options);
  return { settings, settingsPath, model };
}

export interface EvaluationOutcome {
  snapshot: ModelSnapshot;
  warnings: string[];
}

/**
 * Loads the model whose settings file is `settingsPath` from `source`,
 * applies the requested parameter values and part opacities, and evaluates it.
 */
export async function evaluateModelFile(
  source: FileSource,
  settingsPath: string,
  request: EvaluationRequest,
): Promise<EvaluationOutcome> {
  const { model } = await loadModelFromSource(source, settingsPath);
  const inst = new ModelInstance(model);
  const warnings = applyRequest(inst, request);
  inst.evaluate();
  return { snapshot: snapshotInstance(inst), warnings };
}

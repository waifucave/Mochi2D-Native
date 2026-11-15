/**
 * How the scenario runners get their models: by the scenario's `model`
 * path, from whatever holds them (files on disk for `npm run conformance`,
 * or one given model for the library's `scenarioResult`).
 */
import type { MocModel } from "../core/moc/model.js";
import type { ModelSettings } from "../core/settings/model-settings.js";

/** A loaded model: its settings, its parsed `.moc3`, and its other files. */
export interface ScenarioModel {
  settings: ModelSettings;
  model: MocModel;
  /** Reads a file relative to the settings file's folder; undefined when missing. */
  read(path: string): Uint8Array | undefined;
}

/** Loads the model a scenario names. Throws {@link ModelLoadError}. */
export interface ScenarioModels {
  load(modelPath: string): ScenarioModel;
}

/** The settings file or the `.moc3` cannot be read or fails validation (4b). */
export class ModelLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelLoadError";
  }
}

/** The `error` member of a result (4b). */
export function errorInfo(e: unknown): { kind: string; message: string } {
  if (e instanceof Error) return { kind: e.name, message: e.message };
  return { kind: "Error", message: String(e) };
}

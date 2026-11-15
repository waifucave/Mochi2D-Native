/**
 * Model loading for the conformance tools: resolves a scenario's `model` path
 * (assets/models/ first, then the repository root), reads the settings file
 * and the `.moc3`, and keeps a few parsed models (static data may be cached
 * across scenarios, 4c). Failures are `ModelLoadError`s.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { normalizePath } from "../../src/core/io/file-source.js";
import { parseModelSettings, type ModelSettings } from "../../src/core/settings/model-settings.js";
import { loadMoc, type LoadMocOptions, type MocModel } from "../../src/core/moc/model.js";
import type { ModelResolver } from "./conformance-runner.js";

import {
  ModelLoadError,
  type ScenarioModel,
  type ScenarioModels,
} from "../../src/conformance/models.js";

export { ModelLoadError };

export interface LoadedModelFiles extends ScenarioModel {
  /** Absolute path of the settings file. */
  settingsFile: string;
}

/** File access by absolute path (the disk by default; tests serve crafts from memory). */
export interface ModelIo {
  read(path: string): Uint8Array | undefined;
  /** A token that changes when the file changes (undefined: missing). */
  version(path: string): string | undefined;
}

export const DISK_IO: ModelIo = {
  read(path) {
    try {
      const buf = readFileSync(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return undefined;
    }
  },
  version(path) {
    try {
      const st = statSync(path);
      return st.isFile() ? `${st.mtimeMs}:${st.size}` : undefined;
    } catch {
      return undefined;
    }
  },
};

export class ModelCache implements ScenarioModels {
  private readonly mocs = new Map<string, { version: string; model: MocModel }>();

  constructor(
    private readonly resolver: ModelResolver,
    /** Parsed models kept at once (each can take tens of megabytes). */
    private readonly capacity = 3,
    private readonly io: ModelIo = DISK_IO,
    /** Loader options, e.g. the strict draw-order mode. */
    private readonly loadOptions: LoadMocOptions = {},
  ) {}

  load(modelPath: string): LoadedModelFiles {
    const rel = normalizePath(modelPath);
    const settingsFile = this.resolver.resolve(rel);
    if (!settingsFile) {
      const tried = this.resolver.candidates(rel);
      throw new ModelLoadError(
        tried.length
          ? `model not found: "${modelPath}" (tried ${tried.join(", ")})`
          : `model path "${modelPath}" is not allowed`,
      );
    }
    const dir = dirname(settingsFile);
    const read = (path: string): Uint8Array | undefined => {
      let full: string;
      try {
        full = resolve(dir, normalizePath(path));
      } catch {
        return undefined;
      }
      if (full !== dir && !full.startsWith(dir + sep)) return undefined;
      return this.io.read(full);
    };
    let settings: ModelSettings;
    try {
      const bytes = this.io.read(settingsFile);
      if (!bytes) throw new Error("cannot read the file");
      settings = parseModelSettings(bytes, modelPath);
    } catch (e) {
      throw new ModelLoadError(`settings file ${modelPath}: ${(e as Error).message}`);
    }
    const mocFile = resolve(dir, normalizePath(settings.moc));
    const version = this.io.version(mocFile);
    if (version === undefined)
      throw new ModelLoadError(`the .moc3 file ${settings.moc} of ${modelPath} is missing`);
    const cached = this.mocs.get(mocFile);
    let model: MocModel;
    if (cached && cached.version === version) {
      model = cached.model;
      this.mocs.delete(mocFile); // most recently used last
      this.mocs.set(mocFile, cached);
    } else {
      try {
        const bytes = this.io.read(mocFile);
        if (!bytes) throw new Error("cannot read the file");
        model = loadMoc(bytes, this.loadOptions);
      } catch (e) {
        throw new ModelLoadError(`${settings.moc}: ${(e as Error).message}`);
      }
      this.mocs.set(mocFile, { version, model });
      while (this.mocs.size > this.capacity) this.mocs.delete(this.mocs.keys().next().value!);
    }
    return { settingsFile, settings, model, read };
  }
}

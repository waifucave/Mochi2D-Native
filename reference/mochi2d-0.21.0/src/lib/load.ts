/** Loading a model for drawing: runtime, textures and renderer. */
import type { FileSource } from "../core/io/file-source.js";
import type { GpuMemoryTracker } from "../render/gl/gpu-memory.js";
import { loadModelTextures } from "../render/model/load-textures.js";
import { ModelRuntime, type RuntimeOptions } from "../runtime/model-runtime.js";
import { LiveModel, type LiveModelOptions, type MaskSetting } from "./live-model.js";

export interface LoadLiveModelOptions {
  /**
   * Nominal GPU bytes for the textures with their mip chains; larger sets are
   * scaled down together (visibly, see {@link LiveModel.textureNotice}).
   * Unlimited when undefined.
   */
  textureBudget?: number | undefined;
  /** Number of image decode workers (fewer bound peak memory). Default min(2, cores). */
  decodeWorkers?: number;
  masks?: MaskSetting;
  /** Mask-mesh rule: "active" (default) or "all" (reference renders). See {@link LiveModelOptions}. */
  maskMeshes?: "active" | "all";
  fit?: number;
  memory?: GpuMemoryTracker;
  runtime?: RuntimeOptions;
  /** A runtime already loaded from the source (its textures are loaded again, e.g. after a lost context). */
  reuse?: ModelRuntime;
}

/**
 * Loads a model's files, decodes and prepares its textures (exact
 * premultiplication and mip chains, as in reference renders, but downscaled
 * to the budget), and builds its renderer.
 */
export async function loadLiveModel(
  gl: WebGL2RenderingContext,
  source: FileSource,
  settingsPath: string | undefined,
  options: LoadLiveModelOptions = {},
): Promise<LiveModel> {
  const runtime = options.reuse ?? (await ModelRuntime.load(source, settingsPath, options.runtime));
  const { loader, textures } = await loadModelTextures(
    gl,
    runtime.source,
    runtime.settingsPath,
    runtime.settings,
    {
      exact: true,
      mipmaps: true,
      oversize: "downscale",
      ...(options.textureBudget !== undefined ? { budgetBytes: options.textureBudget } : {}),
      ...(options.decodeWorkers !== undefined ? { workers: options.decodeWorkers } : {}),
      ...(options.memory ? { memory: options.memory } : {}),
    },
  );
  try {
    return new LiveModel(gl, runtime, textures, loader, {
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.masks ? { masks: options.masks } : {}),
      ...(options.maskMeshes ? { maskMeshes: options.maskMeshes } : {}),
      ...(options.fit !== undefined ? { fit: options.fit } : {}),
    });
  } catch (e) {
    loader.release(textures);
    loader.dispose();
    throw e;
  }
}

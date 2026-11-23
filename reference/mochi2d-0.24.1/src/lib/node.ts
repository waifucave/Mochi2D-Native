/**
 * Mochi2D for Node: everything in "mochi2d/headless", plus model files on
 * disk, and rendering to PNG in headless Chromium (`NodeRenderer`, with the
 * optional peer dependency Playwright).
 *
 * ```ts
 * import { loadModelFromDisk } from "mochi2d/node";
 *
 * const model = await loadModelFromDisk("models/my-model/my-model.model3.json");
 * await model.startMotion("Idle", 0);
 * for (let i = 0; i < 60; i++) model.update(1 / 60);
 * ```
 */
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { ModelRuntime, type RuntimeOptions } from "../runtime/model-runtime.js";
import { sourceFromFolder, sourceFromZipFile } from "../platform/node-sources.js";
import { rejectUnsupportedArchive, type ArchiveLimits } from "../runtime/zip-source.js";
import type { FileLimits } from "../core/io/file-limits.js";
import { resultModelFromSource, type ResultModel } from "../conformance/results.js";

export * from "./headless.js";
export { NodeFileSource, sourceFromFolder, sourceFromZipFile } from "../platform/node-sources.js";
export { NodeRenderer, renderToPng } from "./node-render.js";
export type {
  NodeRendererOptions,
  RenderImageOptions,
  RenderInput,
  RenderedImage,
} from "./node-render.js";
export { encodePngRgba } from "../platform/node-png.js";

/**
 * Loads a model from disk: a `*.model3.json` file (with its folder), a model
 * folder (its shallowest `*.model3.json`), or a `.zip` archive, read within
 * the caps `archive` (default `DEFAULT_ARCHIVE_LIMITS`), its files (the zip
 * included) within the caps `files` (default `DEFAULT_FILE_LIMITS`). RAR and
 * 7z archives are rejected with {@link UnsupportedArchiveError}.
 */
export async function loadModelFromDisk(
  path: string,
  options: RuntimeOptions & {
    settings?: string;
    archive?: ArchiveLimits;
    files?: FileLimits;
  } = {},
): Promise<ModelRuntime> {
  const { settings, archive, files, ...runtime } = options;
  rejectUnsupportedArchive(basename(path));
  if (path.toLowerCase().endsWith(".zip"))
    return ModelRuntime.load(await sourceFromZipFile(path, archive, files), settings, runtime);
  if ((await stat(path)).isDirectory())
    return ModelRuntime.load(await sourceFromFolder(path, files), settings, runtime);
  return ModelRuntime.load(
    await sourceFromFolder(dirname(path), files),
    settings ?? basename(path),
    runtime,
  );
}

/**
 * The model of `scenarioResult` from disk: a `*.model3.json` file, a model
 * folder or a `.zip` (as {@link loadModelFromDisk}).
 */
export async function resultModelFromDisk(path: string, settings?: string): Promise<ResultModel> {
  rejectUnsupportedArchive(basename(path));
  if (path.toLowerCase().endsWith(".zip"))
    return resultModelFromSource(await sourceFromZipFile(path), settings);
  if ((await stat(path)).isDirectory())
    return resultModelFromSource(await sourceFromFolder(path), settings);
  return resultModelFromSource(await sourceFromFolder(dirname(path)), settings ?? basename(path));
}

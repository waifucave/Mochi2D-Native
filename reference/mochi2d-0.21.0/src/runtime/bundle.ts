/**
 * Loading a model's files from a {@link FileSource}: the settings file, the
 * `.moc3`, and the optional animation files the settings reference (physics,
 * pose, display info, user data). Pure TypeScript: runs in browsers, workers
 * and Node.
 *
 * Problems with optional files become warnings, and the model loads without
 * them. A broken settings file or `.moc3` is an error.
 */
import { dirnameOf, joinPath, type FileSource } from "../core/io/file-source.js";
import { classifyModelFile } from "../core/io/model-files.js";
import { loadMoc, type LoadMocOptions, type MocModel } from "../core/moc/model.js";
import { parseModelSettings, type ModelSettings } from "../core/settings/model-settings.js";
import { parsePhysics, type PhysicsFile } from "../anim/physics.js";
import { parsePose, type PoseFile } from "../anim/pose.js";
import { parseMotionSync, type MotionSyncFile } from "../anim/motion-sync/file.js";
import {
  parseDisplayInfo,
  parseUserData,
  type DisplayInfo,
  type UserData,
} from "../anim/model-data.js";
import { archiveKind } from "./zip-source.js";

/** Everything read from a model folder before any GPU work. */
export interface ModelBundle {
  source: FileSource;
  /** Path of the settings file inside the source. */
  settingsPath: string;
  settings: ModelSettings;
  model: MocModel;
  physics: PhysicsFile | null;
  pose: PoseFile | null;
  displayInfo: DisplayInfo | null;
  userData: UserData | null;
  /** The motion-sync file, read leniently (its warnings are in `warnings`). */
  motionSync: MotionSyncFile | null;
  /** Problems with optional files, one line each. */
  warnings: string[];
}

/** The optional files of a bundle, for code that has already read the settings and `.moc3`. */
export type AnimationAssets = Pick<
  ModelBundle,
  "physics" | "pose" | "displayInfo" | "userData" | "motionSync" | "warnings"
>;

/** Settings files (`*.model3.json`) of a source that can list its files, shortest path first. */
export function findSettingsFiles(source: FileSource): string[] {
  const files = source.list() ?? [];
  return files
    .filter((p) => classifyModelFile(p) === "settings")
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/**
 * Resolves which settings file to load: the given path, or the only (or
 * shallowest) `*.model3.json` of a listable source.
 */
export function resolveSettingsPath(source: FileSource, settingsPath?: string): string {
  if (settingsPath) return settingsPath;
  const found = findSettingsFiles(source);
  if (found.length === 0) {
    const listed = source.list();
    if (!listed)
      throw new Error(
        `${source.label}: name the *.model3.json file to load (this source cannot list its files)`,
      );
    // A folder that holds only the model's archive.
    const archive = listed.find((p) => archiveKind(p) !== undefined);
    const kind = archive && archiveKind(archive);
    throw new Error(
      kind === "zip"
        ? `${source.label}: no *.model3.json file found; open the zip archive "${archive}" itself`
        : kind
          ? `${source.label}: no *.model3.json file found; "${archive}" is a ${kind === "rar" ? "RAR" : "7z"} archive: extract it first, then open the extracted folder`
          : `${source.label}: no *.model3.json file found`,
    );
  }
  return found[0]!;
}

/** Reads the optional files of a model's settings. */
export async function loadAnimationAssets(
  source: FileSource,
  settingsPath: string,
  settings: ModelSettings,
): Promise<AnimationAssets> {
  const dir = dirnameOf(settingsPath);
  // Read in parallel; warnings keep the order of the files.
  const load = async <T>(
    path: string | undefined,
    parse: (b: Uint8Array, label: string) => T,
  ): Promise<{ value: T | null; warning?: string }> => {
    if (!path) return { value: null };
    try {
      return { value: parse(await source.read(joinPath(dir, path)), path) };
    } catch (e) {
      return { value: null, warning: `${path}: ${e instanceof Error ? e.message : String(e)}` };
    }
  };
  const [physics, pose, displayInfo, userData, motionSync] = await Promise.all([
    load(settings.physics, parsePhysics),
    load(settings.pose, parsePose),
    load(settings.displayInfo, parseDisplayInfo),
    load(settings.userData, parseUserData),
    load(settings.motionSync, (b, label) => parseMotionSync(b, label)),
  ]);
  const warnings = [physics, pose, displayInfo, userData, motionSync].flatMap((r) =>
    r.warning ? [r.warning] : [],
  );
  if (motionSync.value) warnings.push(...motionSync.value.warnings);
  return {
    physics: physics.value,
    pose: pose.value,
    displayInfo: displayInfo.value,
    userData: userData.value,
    motionSync: motionSync.value,
    warnings,
  };
}

/** Reads a model's settings, `.moc3` and optional animation files. */
export async function loadModelBundle(
  source: FileSource,
  settingsPath?: string,
  options: LoadMocOptions = {},
): Promise<ModelBundle> {
  const path = resolveSettingsPath(source, settingsPath);
  const settings = parseModelSettings(await source.read(path), path);
  const model = loadMoc(await source.read(joinPath(dirnameOf(path), settings.moc)), options);
  const assets = await loadAnimationAssets(source, path, settings);
  const warnings = [...model.loadWarnings.map((w) => `${settings.moc}: ${w}`), ...assets.warnings];
  return { source, settingsPath: path, settings, model, ...assets, warnings };
}

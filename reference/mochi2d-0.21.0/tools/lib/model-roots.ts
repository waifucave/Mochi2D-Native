/**
 * Where model files are looked up (contract v0.1):
 * a scenario's `model` path — and every file the dev server, the viewer server
 * and the render harness serve under `/models/` — is resolved against
 * `assets/models/` first, then against the repository root.
 *
 * The repository-root fallback never serves hidden paths (any segment starting
 * with ".") or `node_modules`.
 */
import { readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Model folders at the repository root whose terms allow them there. They
 * are listed in the viewer's sample menu when a checkout still has them;
 * DeepSeek-chan's home is `assets/models/DeepSeek/`. Add a folder here only
 * for a model whose license allows it in the repository.
 */
export const VETTED_REPO_MODEL_FOLDERS: readonly string[] = ["DeepSeek"];

/** DeepSeek-chan's folder name in model paths (`DeepSeek/大肥鱼.model3.json`). */
export const DEEPSEEK_FOLDER = "DeepSeek";
/** DeepSeek-chan's settings file in that folder. */
export const DEEPSEEK_SETTINGS_FILE = "大肥鱼.model3.json";

/** What to do when DeepSeek-chan is missing (for messages). */
export const DEEPSEEK_HOWTO =
  "DeepSeek-chan is not in assets/models/DeepSeek/. Download it from its creator " +
  '(README.md, "Test models"), and put its folder there as assets/models/DeepSeek/.';

/**
 * DeepSeek-chan's folder: `assets/models/DeepSeek/` (gitignored), else a
 * `DeepSeek/` folder at the repository root; null when neither holds its
 * settings file.
 */
export function findDeepseekDir(repoRoot: string, modelsDir?: string): string | null {
  for (const dir of modelSearchDirs(repoRoot, modelsDir)) {
    const folder = join(dir, DEEPSEEK_FOLDER);
    if (isFile(join(folder, DEEPSEEK_SETTINGS_FILE))) return folder;
  }
  return null;
}

/** {@link findDeepseekDir}, or an error that says how to get the model. */
export function deepseekDir(repoRoot: string, modelsDir?: string): string {
  const dir = findDeepseekDir(repoRoot, modelsDir);
  if (!dir) throw new Error(DEEPSEEK_HOWTO);
  return dir;
}

/** Ordered search directories for model paths. */
export function modelSearchDirs(repoRoot: string, modelsDir?: string): string[] {
  return [resolve(modelsDir ?? join(repoRoot, "assets", "models")), resolve(repoRoot)];
}

function isForbidden(rel: string): boolean {
  const segs = rel.split(/[\\/]/).filter((s) => s !== "");
  return segs.some((s) => s.startsWith(".")) || segs[0] === "node_modules";
}

/** Absolute candidate paths for `rel`, in search order (traversal-safe). */
export function modelPathCandidates(dirs: readonly string[], rel: string): string[] {
  const out: string[] = [];
  if (isForbidden(rel)) return out;
  for (const dir of dirs) {
    const base = resolve(dir);
    const full = resolve(base, rel);
    if (full !== base && full.startsWith(base + sep)) out.push(full);
  }
  return out;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** First existing file for `rel` in the search directories, else `undefined`. */
export function resolveModelFile(dirs: readonly string[], rel: string): string | undefined {
  return modelPathCandidates(dirs, rel).find(isFile);
}

/**
 * Every file below `assets/models/` plus the vetted repository model folders,
 * as `/models/`-relative paths.
 */
export function listModelFiles(repoRoot: string, modelsDir?: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const rel = prefix + name;
      let directory: boolean;
      try {
        directory = statSync(full).isDirectory();
      } catch {
        // A link to nothing (for example, crafts made before a model moved).
        continue;
      }
      if (directory) walk(full, rel + "/");
      else out.push(rel);
    }
  };
  const [models] = modelSearchDirs(repoRoot, modelsDir);
  walk(models!, "");
  for (const folder of VETTED_REPO_MODEL_FOLDERS) walk(join(repoRoot, folder), folder + "/");
  return [...new Set(out)].sort();
}

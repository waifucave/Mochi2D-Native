/**
 * The file boundary of the agent interface (the MCP server and the `mochi2d`
 * CLI): model files and `.moc3` files are read only under the allowed roots,
 * which the user passes or configures. Symbolic links are resolved before
 * every check, so a link inside a root cannot reach outside it. Nothing is
 * written, and nothing is read from the network.
 */
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  FileNotFoundError,
  normalizePath,
  type FileSource,
} from "../../../src/core/io/file-source.js";
import { rejectUnsupportedArchive, sourceFromZip } from "../../../src/runtime/zip-source.js";

/** A path outside the allowed roots. */
export class PathNotAllowedError extends Error {
  constructor(path: string, roots: readonly string[]) {
    super(
      roots.length
        ? `${path} is outside the allowed folders (${roots.join(", ")}). Mochi2D's agent ` +
            "interface reads files only under the folders it was given (--root, " +
            "MOCHI2D_ROOTS or the client's roots)."
        : `${path} cannot be read: no folders are allowed. Start mochi2d-mcp with --root ` +
            "<folder> (or set MOCHI2D_ROOTS), or use an MCP client that shares its roots.",
    );
    this.name = "PathNotAllowed";
  }
}

/** The largest model folder walked (files), the deepest level, and the largest file read. */
export const LIMITS = { files: 20000, depth: 12, fileBytes: 1 << 30 };

/** The folders the agent interface may read from (real paths). */
export class AllowedRoots {
  private constructor(readonly real: readonly string[]) {}

  /**
   * Roots from paths (relative ones from `base`). Missing folders are an
   * error, or left out with `missing: "skip"`.
   */
  static async create(
    paths: readonly string[],
    base = process.cwd(),
    options: { missing?: "error" | "skip" } = {},
  ): Promise<AllowedRoots> {
    const real: string[] = [];
    for (const p of paths) {
      const full = resolve(base, p);
      let r: string;
      try {
        r = await realpath(full);
      } catch {
        if (options.missing === "skip") continue;
        throw new Error(`The allowed folder ${full} does not exist.`);
      }
      if (!(await stat(r)).isDirectory() && !(await stat(r)).isFile())
        throw new Error(`The allowed path ${full} is neither a folder nor a file.`);
      if (!real.includes(r)) real.push(r);
    }
    return new AllowedRoots(real);
  }

  /** Whether a real path lies in one of the roots. */
  contains(real: string): boolean {
    return this.real.some(
      (root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep),
    );
  }

  /**
   * The real path of a path given by the agent, after checking that it lies in
   * a root. Relative paths are taken from the first root.
   */
  async resolve(path: string): Promise<string> {
    if (typeof path !== "string" || path === "") throw new Error("A path is required.");
    if (this.real.length === 0) throw new PathNotAllowedError(path, this.real);
    const full = isAbsolute(path) ? path : resolve(this.real[0]!, path);
    let real: string;
    try {
      real = await realpath(full);
    } catch {
      // Say "not allowed" rather than "not found" for paths outside the roots.
      if (!this.contains(resolve(full))) throw new PathNotAllowedError(full, this.real);
      throw new Error(`${full} does not exist.`);
    }
    if (!this.contains(real)) throw new PathNotAllowedError(full, this.real);
    return real;
  }
}

/** A model folder on disk that reads nothing outside the allowed roots. */
export class GuardedFolderSource implements FileSource {
  private constructor(
    readonly root: string,
    private readonly roots: AllowedRoots,
    private readonly files: string[],
  ) {}

  get label(): string {
    return this.root;
  }

  /** Lists a folder (a real path inside the roots); links that leave the roots are skipped. */
  static async open(dir: string, roots: AllowedRoots): Promise<GuardedFolderSource> {
    const files: string[] = [];
    const walking = new Set<string>();
    const walk = async (d: string, prefix: string, depth: number) => {
      if (depth > LIMITS.depth) return;
      const real = await realpath(d);
      if (walking.has(real) || !roots.contains(real)) return;
      walking.add(real);
      for (const ent of await readdir(d, { withFileTypes: true })) {
        if (ent.name.startsWith(".")) continue;
        const full = join(d, ent.name);
        let isDir = ent.isDirectory();
        let isFile = ent.isFile();
        if (ent.isSymbolicLink()) {
          const target = await realpath(full).catch(() => null);
          if (!target || !roots.contains(target)) continue;
          const st = await stat(target).catch(() => null);
          isDir = st?.isDirectory() ?? false;
          isFile = st?.isFile() ?? false;
        }
        if (isDir) await walk(full, `${prefix}${ent.name}/`, depth + 1);
        else if (isFile) {
          files.push(prefix + ent.name);
          if (files.length > LIMITS.files)
            throw new Error(
              `${dir} holds more than ${LIMITS.files} files: give the model's own folder.`,
            );
        }
      }
      walking.delete(real);
    };
    await walk(dir, "", 0);
    return new GuardedFolderSource(dir, roots, files.sort());
  }

  list(): readonly string[] {
    return this.files;
  }

  async read(path: string): Promise<Uint8Array> {
    const full = resolve(this.root, normalizePath(path));
    if (full !== this.root && !full.startsWith(this.root + sep))
      throw new FileNotFoundError(path, this.label);
    let real: string;
    try {
      real = await realpath(full);
    } catch {
      throw new FileNotFoundError(path, this.label);
    }
    if (!this.roots.contains(real)) throw new FileNotFoundError(path, this.label);
    const st = await stat(real);
    if (st.size > LIMITS.fileBytes) throw new Error(`${path} is larger than 1 GiB.`);
    const buf = await readFile(real);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
}

/** A model found by {@link findModels}. */
export interface FoundModel {
  path: string;
  kind: "settings" | "zip";
}

/**
 * Finds `*.model3.json` files and `.zip` archives under a real path inside
 * the roots (a folder, or a root that is a single file). The walk skips
 * dotfiles, `node_modules` and links that leave the roots, and stops after
 * {@link LIMITS} files or `max` results.
 */
export async function findModels(
  roots: AllowedRoots,
  start: string,
  max = 200,
): Promise<{ models: FoundModel[]; truncated: boolean }> {
  const models: FoundModel[] = [];
  let seen = 0;
  let truncated = false;
  const kindOf = (name: string): FoundModel["kind"] | null =>
    /\.model3\.json$/i.test(name) ? "settings" : /\.zip$/i.test(name) ? "zip" : null;
  const walking = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (depth > LIMITS.depth) return;
    const real = await realpath(dir).catch(() => null);
    if (!real || walking.has(real) || !roots.contains(real)) return;
    walking.add(real);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (truncated) break;
      if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
      const full = join(dir, ent.name);
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        const target = await realpath(full).catch(() => null);
        if (!target || !roots.contains(target)) continue;
        const st = await stat(target).catch(() => null);
        isDir = st?.isDirectory() ?? false;
        isFile = st?.isFile() ?? false;
      }
      if (isDir) await walk(full, depth + 1);
      else if (isFile) {
        if (++seen > LIMITS.files) truncated = true;
        const kind = kindOf(ent.name);
        if (kind && !truncated) {
          models.push({ path: full, kind });
          if (models.length >= max) truncated = true;
        }
      }
    }
    walking.delete(real);
  };
  const st = await stat(start);
  if (st.isDirectory()) await walk(start, 0);
  else {
    const kind = kindOf(basename(start));
    if (kind) models.push({ path: start, kind });
  }
  return { models, truncated };
}

/** A model to load: its files, and its settings file when the path named one. */
export interface ModelLocation {
  source: FileSource;
  settingsPath?: string;
  /** The real path that was given. */
  path: string;
  kind: "folder" | "settings" | "zip";
}

/**
 * Opens a model given as a folder, a `*.model3.json` file or a `.zip` archive,
 * inside the allowed roots. RAR and 7z archives are refused with a message.
 */
export async function openModelLocation(roots: AllowedRoots, path: string): Promise<ModelLocation> {
  const real = await roots.resolve(path);
  rejectUnsupportedArchive(basename(real));
  const st = await stat(real);
  if (st.isDirectory())
    return { source: await GuardedFolderSource.open(real, roots), path: real, kind: "folder" };
  const name = basename(real).toLowerCase();
  if (name.endsWith(".zip")) {
    if (st.size > LIMITS.fileBytes) throw new Error(`${real} is larger than 1 GiB.`);
    const buf = await readFile(real);
    const source = sourceFromZip(
      basename(real),
      new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    );
    return { source, path: real, kind: "zip" };
  }
  if (name.endsWith(".model3.json"))
    return {
      source: await GuardedFolderSource.open(dirname(real), roots),
      settingsPath: basename(real),
      path: real,
      kind: "settings",
    };
  throw new Error(
    `${real} is not a model: give its folder, its *.model3.json file or a .zip of the folder.`,
  );
}

/** Reads one file (a `.moc3`) inside the allowed roots. */
export async function readAllowedFile(
  roots: AllowedRoots,
  path: string,
): Promise<{ path: string; bytes: Uint8Array }> {
  const real = await roots.resolve(path);
  const st = await stat(real);
  if (!st.isFile()) throw new Error(`${real} is not a file.`);
  if (st.size > LIMITS.fileBytes) throw new Error(`${real} is larger than 1 GiB.`);
  const buf = await readFile(real);
  return { path: real, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
}

/** Model files on disk for Node: a folder, or a zip archive. */
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { FileNotFoundError, normalizePath, type FileSource } from "../core/io/file-source.js";
import { FileBudget, type FileLimits } from "../core/io/file-limits.js";
import { sourceFromZip, type ArchiveLimits } from "../runtime/zip-source.js";

/**
 * A folder on disk. `list()` is populated by {@link NodeFileSource.open}.
 * Files are read within the caps `limits` (by default `DEFAULT_FILE_LIMITS`):
 * a file's size is checked before it is read.
 */
export class NodeFileSource implements FileSource {
  private readonly budget: FileBudget;
  private constructor(
    readonly root: string,
    private readonly files: string[],
    limits?: FileLimits,
  ) {
    this.budget = new FileBudget(limits);
  }

  get label(): string {
    return this.root;
  }

  static async open(dir: string, limits?: FileLimits): Promise<NodeFileSource> {
    const root = resolve(dir);
    const files: string[] = [];
    // Symbolic links are followed (crafted model folders link to shared files);
    // a folder already being walked is not entered again.
    const walking = new Set<string>();
    const walk = async (d: string, prefix: string) => {
      const real = await realpath(d);
      if (walking.has(real)) return;
      walking.add(real);
      for (const ent of await readdir(d, { withFileTypes: true })) {
        const full = join(d, ent.name);
        let isDir = ent.isDirectory();
        let isFile = ent.isFile();
        if (ent.isSymbolicLink()) {
          const st = await stat(full).catch(() => null);
          isDir = st?.isDirectory() ?? false;
          isFile = st?.isFile() ?? false;
        }
        if (isDir) await walk(full, `${prefix}${ent.name}/`);
        else if (isFile) files.push(prefix + ent.name);
      }
      walking.delete(real);
    };
    await walk(root, "");
    return new NodeFileSource(root, files.sort(), limits);
  }

  list(): readonly string[] {
    return this.files;
  }

  async read(path: string): Promise<Uint8Array> {
    const full = resolve(this.root, normalizePath(path));
    if (full !== this.root && !full.startsWith(this.root + sep))
      throw new FileNotFoundError(path, this.label);
    const key = normalizePath(path);
    try {
      this.budget.check(key, (await stat(full)).size);
      const buf = await readFile(full);
      this.budget.add(key, buf.byteLength);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new FileNotFoundError(path, this.label);
      throw e;
    }
  }
}

/** A folder on disk as a file source (its file list is read once), read within `limits`. */
export function sourceFromFolder(dir: string, limits?: FileLimits): Promise<NodeFileSource> {
  return NodeFileSource.open(dir, limits);
}

/**
 * A zip archive on disk, held in memory; entries inflate when read, within the
 * caps `archive` (by default `DEFAULT_ARCHIVE_LIMITS`).
 */
export async function sourceFromZipFile(
  path: string,
  archive?: ArchiveLimits,
  files?: FileLimits,
): Promise<FileSource> {
  // The archive itself is a file: its size is checked before it is read.
  new FileBudget(files).check(basename(path), (await stat(path)).size);
  const buf = await readFile(path);
  return sourceFromZip(
    basename(path),
    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    archive,
  );
}

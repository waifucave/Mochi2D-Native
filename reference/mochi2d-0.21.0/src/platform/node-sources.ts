/** Model files on disk for Node: a folder, or a zip archive. */
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { FileNotFoundError, normalizePath, type FileSource } from "../core/io/file-source.js";
import { sourceFromZip } from "../runtime/zip-source.js";

/** A folder on disk. `list()` is populated by {@link NodeFileSource.open}. */
export class NodeFileSource implements FileSource {
  private constructor(
    readonly root: string,
    private readonly files: string[],
  ) {}

  get label(): string {
    return this.root;
  }

  static async open(dir: string): Promise<NodeFileSource> {
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
    return new NodeFileSource(root, files.sort());
  }

  list(): readonly string[] {
    return this.files;
  }

  async read(path: string): Promise<Uint8Array> {
    const full = resolve(this.root, normalizePath(path));
    if (full !== this.root && !full.startsWith(this.root + sep))
      throw new FileNotFoundError(path, this.label);
    try {
      const buf = await readFile(full);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new FileNotFoundError(path, this.label);
      throw e;
    }
  }
}

/** A folder on disk as a file source (its file list is read once). */
export function sourceFromFolder(dir: string): Promise<NodeFileSource> {
  return NodeFileSource.open(dir);
}

/** A zip archive on disk, unpacked into memory. */
export async function sourceFromZipFile(path: string): Promise<FileSource> {
  const buf = await readFile(path);
  return sourceFromZip(basename(path), new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

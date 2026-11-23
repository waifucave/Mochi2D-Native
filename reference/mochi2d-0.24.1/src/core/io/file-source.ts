import { decodeUtf8, encodeUtf8 } from "../binary/utf8.js";

/**
 * A read-only, path-addressed set of files (a model folder, a zip archive, a
 * remote directory, ...). Paths use forward slashes and are relative to the
 * source root. Implementations exist for Node (filesystem), the browser
 * (folder picker / drag-and-drop / zip) and HTTP.
 */
export interface FileSource {
  /** Human-readable description, e.g. a folder name or URL. */
  readonly label: string;
  /**
   * All known file paths, if the source can enumerate them. HTTP sources cannot,
   * and return `undefined`.
   */
  list(): readonly string[] | undefined;
  /** Reads a file; rejects with {@link FileNotFoundError} if it does not exist. */
  read(path: string): Promise<Uint8Array>;
}

export class FileNotFoundError extends Error {
  constructor(
    readonly path: string,
    readonly source: string,
  ) {
    super(`File not found: "${path}" in ${source}`);
    this.name = "FileNotFoundError";
  }
}

/**
 * Normalizes a relative path: backslashes to slashes, removes "." segments and
 * resolves ".." (never escaping the root). Throws on paths that would escape.
 */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) throw new Error(`Path escapes the source root: "${path}"`);
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

/** Directory part of a normalized path ("" for top-level files). */
export function dirnameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Joins a base directory and a relative reference, then normalizes. */
export function joinPath(base: string, ref: string): string {
  return normalizePath(base ? `${base}/${ref}` : ref);
}

/**
 * In-memory files by path: a model package built in memory (an export to
 * preview), a zip archive's contents, tests. Paths may hold any Unicode
 * characters; a path that is not found as given is looked up in Unicode
 * normalization form C, so a reference written precomposed (NFC, as JSON
 * files usually are) finds a file whose name is decomposed (NFD, as macOS
 * gives file names), and the other way round.
 */
export class MemoryFileSource implements FileSource {
  private readonly files = new Map<string, Uint8Array>();
  /** NFC form of each path → the path as stored. */
  private readonly composed = new Map<string, string>();

  constructor(
    readonly label: string,
    entries: Iterable<[string, Uint8Array]> = [],
  ) {
    for (const [p, data] of entries) this.set(p, data);
  }

  /**
   * In-memory files by path, as a record or a map: bytes, an ArrayBuffer, or
   * text (stored as UTF-8).
   */
  static fromFiles(
    files:
      | Record<string, Uint8Array | ArrayBuffer | string>
      | ReadonlyMap<string, Uint8Array | ArrayBuffer | string>,
    label = "files",
  ): MemoryFileSource {
    const src = new MemoryFileSource(label);
    const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
    for (const [path, data] of entries)
      src.set(
        path,
        typeof data === "string"
          ? encodeUtf8(data)
          : data instanceof Uint8Array
            ? data
            : new Uint8Array(data as ArrayBuffer),
      );
    return src;
  }

  set(path: string, data: Uint8Array): void {
    const p = normalizePath(path);
    this.files.set(p, data);
    this.composed.set(p.normalize("NFC"), p);
  }

  list(): readonly string[] {
    return [...this.files.keys()].sort();
  }

  async read(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    const data = this.files.get(p) ?? this.files.get(this.composed.get(p.normalize("NFC")) ?? "");
    if (!data) throw new FileNotFoundError(path, this.label);
    return data;
  }
}

/** Restricts a source to a sub-directory, re-rooting paths. */
export class SubdirFileSource implements FileSource {
  readonly label: string;
  constructor(
    private readonly inner: FileSource,
    private readonly dir: string,
  ) {
    this.dir = normalizePath(dir);
    this.label = this.dir ? `${inner.label}/${this.dir}` : inner.label;
  }
  list(): readonly string[] | undefined {
    const all = this.inner.list();
    if (!all) return undefined;
    if (!this.dir) return all;
    const prefix = this.dir + "/";
    return all.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  }
  read(path: string): Promise<Uint8Array> {
    return this.inner.read(joinPath(this.dir, path));
  }
}

/** Decodes a file as UTF-8 text (BOM stripped). */
export async function readText(source: FileSource, path: string): Promise<string> {
  const bytes = await source.read(path);
  const text = decodeUtf8(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Tries each source in order; lists the union of their files. */
export class OverlayFileSource implements FileSource {
  constructor(
    readonly label: string,
    private readonly layers: FileSource[],
  ) {}
  list(): readonly string[] | undefined {
    const lists = this.layers.map((l) => l.list());
    if (lists.every((l) => l === undefined)) return undefined;
    return [...new Set(lists.flatMap((l) => l ?? []))].sort();
  }
  async read(path: string): Promise<Uint8Array> {
    for (const layer of this.layers) {
      try {
        return await layer.read(path);
      } catch (e) {
        if (!(e instanceof FileNotFoundError)) throw e;
      }
    }
    throw new FileNotFoundError(path, this.label);
  }
}

/** Browser implementations of {@link FileSource}: picked folders, dropped files, zips and URLs. */
import { FileNotFoundError, normalizePath, type FileSource } from "../core/io/file-source.js";
import { FileBudget, readResponse, type FileLimits } from "../core/io/file-limits.js";
import {
  archiveKind,
  rejectUnsupportedArchive,
  sourceFromZip,
  type ArchiveLimits,
} from "../runtime/zip-source.js";

export { sourceFromZip };

/**
 * Files with their relative paths, e.g. from `<input webkitdirectory>` or a
 * drop, read within the caps `limits` (by default `DEFAULT_FILE_LIMITS`): a
 * file's known size is checked before it is read.
 */
export class BrowserFileSource implements FileSource {
  private readonly files = new Map<string, File>();
  private readonly budget: FileBudget;
  constructor(
    readonly label: string,
    entries: Iterable<[string, File]>,
    limits?: FileLimits,
  ) {
    this.budget = new FileBudget(limits);
    for (const [p, f] of entries) this.files.set(normalizePath(p), f);
  }
  list(): readonly string[] {
    return [...this.files.keys()].sort();
  }
  async read(path: string): Promise<Uint8Array> {
    const key = normalizePath(path);
    const f = this.files.get(key);
    if (!f) throw new FileNotFoundError(path, this.label);
    this.budget.check(key, f.size);
    const bytes = new Uint8Array(await f.arrayBuffer());
    this.budget.add(key, bytes.length);
    return bytes;
  }
}

/** A single `File` or `Blob` read whole, within `limits` (its size is checked first). */
export async function readFileCapped(
  file: Blob,
  name: string,
  limits?: FileLimits,
): Promise<Uint8Array> {
  new FileBudget(limits).check(name, file.size);
  return new Uint8Array(await file.arrayBuffer());
}

/** Builds a source from an `<input type=file webkitdirectory>` FileList, read within `limits`. */
export function sourceFromFileList(list: FileList | File[], limits?: FileLimits): FileSource {
  const files = [...list];
  if (files.length === 1) rejectUnsupportedArchive(files[0]!.name);
  const entries: [string, File][] = files.map((f) => [f.webkitRelativePath || f.name, f]);
  const label = commonRoot(entries.map(([p]) => p)) || "selected files";
  return new BrowserFileSource(label, entries, limits);
}

function commonRoot(paths: string[]): string {
  const first = paths[0]?.split("/")[0];
  if (!first || paths.some((p) => !p.startsWith(first + "/"))) return "";
  return first;
}

/**
 * Reads a dropped DataTransfer, walking directories recursively. A single
 * dropped zip is read with the caps `archive` (by default
 * `DEFAULT_ARCHIVE_LIMITS`).
 */
export async function sourceFromDataTransfer(
  dt: DataTransfer,
  archive?: ArchiveLimits,
  files?: FileLimits,
): Promise<FileSource> {
  const entries: [string, File][] = [];
  const roots = [...dt.items]
    .filter((it) => it.kind === "file")
    .map((it) => it.webkitGetAsEntry?.() ?? null);
  if (roots.some((r) => r)) {
    for (const root of roots) if (root) await walkEntry(root, "", entries);
  } else {
    for (const f of dt.files) entries.push([f.name, f]);
  }
  // A single dropped zip becomes a zip source; RAR and 7z archives get a clear error.
  if (entries.length === 1) {
    const file = entries[0]![1];
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    rejectUnsupportedArchive(file.name, head);
    if (archiveKind(file.name, head) === "zip")
      return sourceFromZip(file.name, await readFileCapped(file, file.name, files), archive);
  }
  const label = commonRoot(entries.map(([p]) => p)) || "dropped files";
  return new BrowserFileSource(label, entries, files);
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: [string, File][],
): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) =>
      (entry as FileSystemFileEntry).file(res, rej),
    );
    out.push([path, file]);
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, path, out);
    }
  }
}

/**
 * Files fetched relative to a base URL, within the caps `limits` (by default
 * `DEFAULT_FILE_LIMITS`): each download is streamed and stopped at the cap.
 * Cannot enumerate its contents.
 */
export class HttpFileSource implements FileSource {
  readonly baseUrl: string;
  private readonly budget: FileBudget;
  constructor(
    baseUrl: string,
    readonly label = baseUrl,
    limits?: FileLimits,
  ) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    this.budget = new FileBudget(limits);
  }
  list(): undefined {
    return undefined;
  }
  async read(path: string): Promise<Uint8Array> {
    const url = new URL(
      normalizePath(path).split("/").map(encodeURIComponent).join("/"),
      this.baseUrl,
    );
    const res = await fetch(url);
    if (res.status === 404) throw new FileNotFoundError(path, this.label);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return readResponse(res, normalizePath(path), this.budget);
  }
}

/**
 * Splits a URL to a settings file (or a zip) into a source plus the settings
 * path inside it. A zip is read with the caps `archive` (by default
 * `DEFAULT_ARCHIVE_LIMITS`).
 */
export async function sourceFromUrl(
  url: string,
  archive?: ArchiveLimits,
  files?: FileLimits,
): Promise<{ source: FileSource; entry?: string }> {
  const u = new URL(url, location.href);
  rejectUnsupportedArchive(decodeURIComponent(u.pathname.split("/").pop() ?? ""));
  if (u.pathname.toLowerCase().endsWith(".zip")) {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${u}`);
    const name = decodeURIComponent(u.pathname.split("/").pop()!);
    // The archive's download is streamed and stopped at the file cap.
    return {
      source: sourceFromZip(name, await readResponse(res, name, new FileBudget(files)), archive),
    };
  }
  const slash = u.href.lastIndexOf("/");
  const base = u.href.slice(0, slash + 1);
  const entry = decodeURIComponent(u.href.slice(slash + 1).split(/[?#]/)[0]!);
  return { source: new HttpFileSource(base, base, files), entry: entry || undefined };
}

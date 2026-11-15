/** Browser implementations of {@link FileSource}: picked folders, dropped files, zips and URLs. */
import { FileNotFoundError, normalizePath, type FileSource } from "../core/io/file-source.js";
import { archiveKind, rejectUnsupportedArchive, sourceFromZip } from "../runtime/zip-source.js";

export { sourceFromZip };

/** Files with their relative paths, e.g. from `<input webkitdirectory>` or a drop. */
export class BrowserFileSource implements FileSource {
  private readonly files = new Map<string, File>();
  constructor(
    readonly label: string,
    entries: Iterable<[string, File]>,
  ) {
    for (const [p, f] of entries) this.files.set(normalizePath(p), f);
  }
  list(): readonly string[] {
    return [...this.files.keys()].sort();
  }
  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(normalizePath(path));
    if (!f) throw new FileNotFoundError(path, this.label);
    return new Uint8Array(await f.arrayBuffer());
  }
}

/** Builds a source from an `<input type=file webkitdirectory>` FileList. */
export function sourceFromFileList(list: FileList | File[]): FileSource {
  const files = [...list];
  if (files.length === 1) rejectUnsupportedArchive(files[0]!.name);
  const entries: [string, File][] = files.map((f) => [f.webkitRelativePath || f.name, f]);
  const label = commonRoot(entries.map(([p]) => p)) || "selected files";
  return new BrowserFileSource(label, entries);
}

function commonRoot(paths: string[]): string {
  const first = paths[0]?.split("/")[0];
  if (!first || paths.some((p) => !p.startsWith(first + "/"))) return "";
  return first;
}

/** Reads a dropped DataTransfer, walking directories recursively. */
export async function sourceFromDataTransfer(dt: DataTransfer): Promise<FileSource> {
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
      return sourceFromZip(file.name, new Uint8Array(await file.arrayBuffer()));
  }
  const label = commonRoot(entries.map(([p]) => p)) || "dropped files";
  return new BrowserFileSource(label, entries);
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

/** Files fetched relative to a base URL. Cannot enumerate its contents. */
export class HttpFileSource implements FileSource {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    readonly label = baseUrl,
  ) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
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
    return new Uint8Array(await res.arrayBuffer());
  }
}

/**
 * Splits a URL to a settings file (or a zip) into a source plus the settings
 * path inside it.
 */
export async function sourceFromUrl(url: string): Promise<{ source: FileSource; entry?: string }> {
  const u = new URL(url, location.href);
  rejectUnsupportedArchive(decodeURIComponent(u.pathname.split("/").pop() ?? ""));
  if (u.pathname.toLowerCase().endsWith(".zip")) {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${u}`);
    return {
      source: sourceFromZip(
        decodeURIComponent(u.pathname.split("/").pop()!),
        new Uint8Array(await res.arrayBuffer()),
      ),
    };
  }
  const slash = u.href.lastIndexOf("/");
  const base = u.href.slice(0, slash + 1);
  const entry = decodeURIComponent(u.href.slice(slash + 1).split(/[?#]/)[0]!);
  return { source: new HttpFileSource(base), entry: entry || undefined };
}

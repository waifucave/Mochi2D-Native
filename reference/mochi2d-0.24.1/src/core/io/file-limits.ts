/**
 * Caps on what a source may read from a folder, a URL or dropped files: one
 * file's size, and all of them together. A zip's entries have their own caps
 * (`ArchiveLimits`); these bound the files themselves, the zip included.
 *
 * A size known before reading (a `File`, a file on disk, a `Content-Length`)
 * is refused before anything is read; a download is streamed and stopped the
 * moment it passes the cap, never read whole first.
 */

/** Caps on the files a source reads. A cap not given keeps its default. */
export interface FileLimits {
  /** The most bytes one file may hold. */
  maxFileBytes?: number;
  /** The most bytes a source may read in all, each file counted once. */
  maxTotalBytes?: number;
}

/** The caps used when none are given: 1 GiB a file, 2 GiB in all. */
export const DEFAULT_FILE_LIMITS: Readonly<Required<FileLimits>> = Object.freeze({
  maxFileBytes: 2 ** 30,
  maxTotalBytes: 2 ** 31,
});

/** Which cap a read passed. */
export type FileLimitKind = "file" | "total";

/** A file, or a source's files together, would pass a {@link FileLimits} cap. */
export class FileLimitError extends Error {
  constructor(
    /** The file, as the source names it. */
    readonly path: string,
    readonly kind: FileLimitKind,
    /** The cap. */
    readonly limit: number,
    /** The file's size (or the bytes read before stopping), or the source's running total. */
    readonly size: number,
  ) {
    super(
      kind === "file"
        ? `"${path}" holds ${size} bytes or more, more than the ${limit} allowed for one file`
        : `"${path}": reading it takes the files read to ${size} bytes, more than the ${limit} allowed in total`,
    );
    this.name = "FileLimitError";
  }
}

/** The caps of a source: the given ones over {@link DEFAULT_FILE_LIMITS}, checked. */
export function resolveFileLimits(limits: FileLimits = {}): Required<FileLimits> {
  const out = { ...DEFAULT_FILE_LIMITS };
  for (const key of ["maxFileBytes", "maxTotalBytes"] as const) {
    const v = limits[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || Number.isNaN(v) || v < 0)
      throw new RangeError(`${key} must be a number ≥ 0 (Infinity for no cap)`);
    out[key] = v;
  }
  return out;
}

/** What a source has read, each file counted once, against its caps. */
export class FileBudget {
  readonly limits: Readonly<Required<FileLimits>>;
  private readonly counted = new Map<string, number>();
  private total = 0;

  constructor(limits: FileLimits = {}) {
    this.limits = Object.freeze(resolveFileLimits(limits));
  }

  /** Bytes read so far, each file once. */
  get readBytes(): number {
    return this.total;
  }

  /** Throws if a file of `size` bytes (known before reading) may not be read. */
  check(path: string, size: number): void {
    const { maxFileBytes, maxTotalBytes } = this.limits;
    if (size > maxFileBytes) throw new FileLimitError(path, "file", maxFileBytes, size);
    if (!this.counted.has(path) && this.total + size > maxTotalBytes)
      throw new FileLimitError(path, "total", maxTotalBytes, this.total + size);
  }

  /** Counts a file read in full (once per path). */
  add(path: string, size: number): void {
    if (this.counted.has(path)) return;
    this.counted.set(path, size);
    this.total += size;
  }

  /** The most bytes `path` may still hold: under the file cap, and what is left of the total. */
  allowance(path: string): number {
    const { maxFileBytes, maxTotalBytes } = this.limits;
    return this.counted.has(path)
      ? maxFileBytes
      : Math.min(maxFileBytes, maxTotalBytes - this.total);
  }
}

/** What {@link readResponse} uses of a fetch `Response` (core code has no DOM types). */
export interface StreamedResponse {
  headers: { get(name: string): string | null };
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * A response's body, within the budget: refused on its `Content-Length`
 * when it sends one, else streamed and cancelled the moment it passes the
 * cap. Counted in the budget.
 */
export async function readResponse(
  res: StreamedResponse,
  path: string,
  budget: FileBudget,
): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 0 && res.headers.get("content-encoding") === null)
    budget.check(path, declared);
  const allowed = budget.allowance(path);
  const fail = (got: number) => {
    const { maxFileBytes, maxTotalBytes } = budget.limits;
    return got > maxFileBytes
      ? new FileLimitError(path, "file", maxFileBytes, got)
      : new FileLimitError(path, "total", maxTotalBytes, budget.readBytes + got);
  };
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.length > allowed) throw fail(all.length);
    budget.add(path, all.length);
    return all;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    n += value.length;
    if (n > allowed) {
      await reader.cancel().catch(() => {});
      throw fail(n);
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  budget.add(path, n);
  return out;
}

/**
 * A zip archive as a {@link FileSource} (pure TypeScript; works in browsers and
 * Node), and clear errors for archive formats Mochi2D does not open.
 */
import {
  dirnameOf,
  FileNotFoundError,
  joinPath,
  normalizePath,
  type FileSource,
} from "../core/io/file-source.js";
import { classifyModelFile } from "../core/io/model-files.js";
import { parseModelSettings, type ModelSettings } from "../core/settings/model-settings.js";
import {
  ArchiveLimitError,
  DEFAULT_ARCHIVE_LIMITS,
  declaredSize,
  localExtraField,
  looksLikeZip,
  readZipDirectory,
  zipEntryData,
  ZipFormatError,
  type ArchiveLimitKind,
  type ArchiveLimits,
  type ZipRecord,
} from "./zip-archive.js";
import { decodeZipNames, type ZipNameEncoding, type ZipNameSource } from "./zip-names.js";

export { ArchiveLimitError, DEFAULT_ARCHIVE_LIMITS, ZipFormatError };
export type { ArchiveLimitKind, ArchiveLimits, ZipNameEncoding, ZipNameSource };

/** The caps of a source: the given ones over {@link DEFAULT_ARCHIVE_LIMITS}, checked. */
export function resolveArchiveLimits(limits: ArchiveLimits = {}): Required<ArchiveLimits> {
  const out = { ...DEFAULT_ARCHIVE_LIMITS };
  for (const key of ["maxEntryBytes", "maxTotalBytes", "maxEntries"] as const) {
    const v = limits[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || Number.isNaN(v) || v < 0)
      throw new RangeError(`${key} must be a number ≥ 0 (Infinity for no cap)`);
    out[key] = v;
  }
  return out;
}

/** Archive formats recognized by name or signature. */
export type ArchiveKind = "zip" | "rar" | "7z";

const RAR_SIG = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]; // "Rar!\x1A\x07"
const SEVEN_ZIP_SIG = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]; // "7z\xBC\xAF\x27\x1C"
const startsWith = (b: Uint8Array, sig: number[]) =>
  b.length >= sig.length && sig.every((x, i) => b[i] === x);

/**
 * The archive format of a file, from its first bytes when given, else from its
 * name; undefined for anything else.
 */
export function archiveKind(name: string, head?: Uint8Array): ArchiveKind | undefined {
  if (head && head.length >= 6) {
    if (startsWith(head, RAR_SIG)) return "rar";
    if (startsWith(head, SEVEN_ZIP_SIG)) return "7z";
    if (looksLikeZip(head)) return "zip";
  }
  const lower = name.toLowerCase().split(/[?#]/)[0]!;
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".rar")) return "rar";
  if (lower.endsWith(".7z")) return "7z";
  return undefined;
}

/** Opening an archive format other than zip. */
export class UnsupportedArchiveError extends Error {
  constructor(
    readonly fileName: string,
    readonly kind: Exclude<ArchiveKind, "zip">,
  ) {
    super(
      `"${fileName}" is a ${kind === "rar" ? "RAR" : "7z"} archive. Mochi2D opens only zip ` +
        `archives and folders: extract the archive first, then open the extracted folder ` +
        `(or a zip of it).`,
    );
    this.name = "UnsupportedArchiveError";
  }
}

/** Throws {@link UnsupportedArchiveError} for a RAR or 7z file (by name, or by its first bytes). */
export function rejectUnsupportedArchive(name: string, head?: Uint8Array): void {
  const kind = archiveKind(name, head);
  if (kind === "rar" || kind === "7z") throw new UnsupportedArchiveError(name, kind);
}

const pathKey = (path: string) => normalizePath(path).normalize("NFC");

/** Paths a settings file refers to, relative to its folder. */
function settingsReferences(s: ModelSettings): string[] {
  const refs = [s.moc, ...s.textures];
  for (const f of [s.physics, s.pose, s.userData, s.displayInfo]) if (f) refs.push(f);
  for (const e of s.expressions) refs.push(e.file);
  for (const g of s.motions)
    for (const m of g.entries) {
      refs.push(m.file);
      if (m.sound) refs.push(m.sound);
    }
  return refs;
}

/**
 * A zip archive held in memory. Entries are decompressed when read. Names
 * are decoded as described in zip-names.ts; folders and macOS metadata
 * (`__MACOSX/`) are skipped. Lookups ignore the difference between composed
 * and decomposed Unicode forms (NFC and NFD).
 *
 * Every read, the name decoding's own reads of settings files included, is
 * capped by the source's {@link ArchiveLimits} (by default
 * {@link DEFAULT_ARCHIVE_LIMITS}) and checked against the entry's CRC-32:
 * see {@link zipEntryData}. An entry counts toward `maxTotalBytes` once, the
 * first time it is read in full.
 */
export class ZipFileSource implements FileSource {
  /** The encoding chosen for names that carry no UTF-8 information. */
  readonly nameEncoding: ZipNameEncoding;
  /** The caps this source reads with. */
  readonly limits: Readonly<Required<ArchiveLimits>>;
  private readonly entries = new Map<string, { record: ZipRecord; name: string }>();
  /** Entries already counted toward `maxTotalBytes`, and their total. */
  private readonly counted = new Set<ZipRecord>();
  private total = 0;

  constructor(
    readonly label: string,
    private readonly bytes: Uint8Array,
    limits: ArchiveLimits = {},
  ) {
    this.limits = Object.freeze(resolveArchiveLimits(limits));
    if (!looksLikeZip(bytes)) rejectUnsupportedArchive(label, bytes);
    let records: ZipRecord[];
    try {
      records = readZipDirectory(bytes, this.limits.maxEntries, label);
    } catch (e) {
      if (e instanceof ZipFormatError) throw new ZipFormatError(`${label}: ${e.message}`);
      throw e;
    }
    // Settings files are found by suffix, which every encoding decodes alike.
    const settings = new Map<number, string[]>();
    const settingsRefs = (i: number): string[] => {
      let refs = settings.get(i);
      if (!refs) {
        try {
          refs = settingsReferences(parseModelSettings(this.readRecord(records[i]!, "settings")));
        } catch {
          refs = [];
        }
        settings.set(i, refs);
      }
      return refs;
    };
    const decoded = decodeZipNames(records, {
      localExtra: (i) => localExtraField(bytes, records[i]!),
      score: (names) => {
        const keys = new Set(names.map((n) => n.normalize("NFC")));
        let resolved = 0;
        names.forEach((n, i) => {
          if (classifyModelFile(n) !== "settings") return;
          const dir = dirnameOf(n);
          for (const ref of settingsRefs(i)) {
            try {
              if (keys.has(joinPath(dir, ref).normalize("NFC"))) resolved++;
            } catch {
              // A reference that escapes the archive resolves under no encoding.
            }
          }
        });
        return resolved;
      },
    });
    this.nameEncoding = decoded.encoding;
    decoded.names.forEach((name, i) => {
      if (name.endsWith("/") || name.startsWith("__MACOSX/")) return;
      let key: string;
      try {
        key = pathKey(name);
      } catch {
        return; // a name that escapes the archive root
      }
      if (key) this.entries.set(key, { record: records[i]!, name: key });
    });
  }

  list(): readonly string[] {
    return [...this.entries.keys()].sort();
  }

  async read(path: string): Promise<Uint8Array> {
    let entry;
    try {
      entry = this.entries.get(pathKey(path));
    } catch {
      entry = undefined;
    }
    if (!entry) throw new FileNotFoundError(path, this.label);
    return this.readRecord(entry.record, entry.name);
  }

  /** Bytes inflated so far, each entry counted once (for `maxTotalBytes`). */
  get inflatedBytes(): number {
    return this.total;
  }

  /** An entry's data within the caps (module comment). */
  private readRecord(record: ZipRecord, name: string): Uint8Array {
    const first = !this.counted.has(record);
    const { maxEntryBytes, maxTotalBytes } = this.limits;
    if (first && this.total + declaredSize(record) > maxTotalBytes)
      throw new ArchiveLimitError(name, "total", maxTotalBytes, this.total + declaredSize(record));
    const data = zipEntryData(this.bytes, record, name, maxEntryBytes);
    if (first) {
      this.counted.add(record);
      this.total += data.length;
    }
    return data;
  }
}

/**
 * Opens a zip archive held in memory, with caps on what it may inflate to
 * (by default {@link DEFAULT_ARCHIVE_LIMITS}). Throws
 * {@link UnsupportedArchiveError} for RAR and 7z archives,
 * {@link ZipFormatError} for other non-zip data, and
 * {@link ArchiveLimitError} for a directory with more than `maxEntries`.
 */
export function sourceFromZip(
  label: string,
  bytes: Uint8Array,
  limits: ArchiveLimits = {},
): ZipFileSource {
  return new ZipFileSource(label, bytes, limits);
}

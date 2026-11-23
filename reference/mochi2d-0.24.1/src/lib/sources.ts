/**
 * Turning what an application has (a URL, a zip file, a folder's files, a
 * drop, in-memory files) into a {@link FileSource} and the path of the
 * settings file to load from it.
 */
import { MemoryFileSource, type FileSource } from "../core/io/file-source.js";
import {
  readFileCapped,
  sourceFromDataTransfer,
  sourceFromFileList,
  sourceFromUrl,
  sourceFromZip,
} from "../platform/browser-sources.js";
import type { FileLimits } from "../core/io/file-limits.js";
import { resolveSettingsPath } from "../runtime/bundle.js";
import { rejectUnsupportedArchive, type ArchiveLimits } from "../runtime/zip-source.js";

/** File contents an application can hand over directly. */
export type FileData = Uint8Array | ArrayBuffer | Blob | string;

/**
 * Where a model comes from:
 * - a URL (string or URL) of a `*.model3.json` file or of a `.zip` archive;
 * - a `.zip` archive as a Blob or File (RAR and 7z archives are rejected with
 *   an error that asks for the archive to be extracted first);
 * - a folder's files (a FileList from `<input webkitdirectory>`, or File[]
 *   with `webkitRelativePath`), or files dropped on the page (DataTransfer);
 * - in-memory files by path: `{ files: { "model.model3.json": …, … } }`;
 * - any {@link FileSource}.
 */
export type ModelInput =
  | string
  | URL
  | Blob
  | FileList
  | readonly File[]
  | DataTransfer
  | { files: Record<string, FileData> | Map<string, FileData> }
  | FileSource;

export interface OpenedInput {
  source: FileSource;
  /** Path of the settings file inside the source. */
  settingsPath: string;
}

const isFileSource = (x: unknown): x is FileSource =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as FileSource).read === "function" &&
  typeof (x as FileSource).list === "function";

async function bytesOf(data: FileData): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array(await data.arrayBuffer());
}

const isZipName = (name: string) => name.toLowerCase().endsWith(".zip");

/**
 * Resolves a {@link ModelInput}. `settings` picks the settings file when the
 * input holds several (a path inside the source); otherwise the shallowest
 * `*.model3.json` is used. A zip is read with the caps `archive` (by default
 * `DEFAULT_ARCHIVE_LIMITS`); files from a folder, a drop or a URL, a zip
 * included, with the caps `files` (by default `DEFAULT_FILE_LIMITS`).
 */
export async function openModelInput(
  input: ModelInput,
  settings?: string,
  archive?: ArchiveLimits,
  files?: FileLimits,
): Promise<OpenedInput> {
  let source: FileSource;
  let entry: string | undefined;
  if (typeof input === "string" || input instanceof URL) {
    const r = await sourceFromUrl(String(input), archive, files);
    source = r.source;
    entry = r.entry;
    if (entry && !entry.toLowerCase().endsWith(".model3.json"))
      throw new Error(`${String(input)}: expected a URL of a *.model3.json file or a .zip archive`);
  } else if (typeof DataTransfer !== "undefined" && input instanceof DataTransfer) {
    source = await sourceFromDataTransfer(input, archive, files);
  } else if (typeof Blob !== "undefined" && input instanceof Blob) {
    const name = typeof File !== "undefined" && input instanceof File ? input.name : "model.zip";
    rejectUnsupportedArchive(name, new Uint8Array(await input.slice(0, 8).arrayBuffer()));
    if (!isZipName(name) && !/zip/.test(input.type))
      throw new Error(
        `${name}: a single file must be a .zip archive (pass a folder's files or a URL instead)`,
      );
    source = sourceFromZip(name, await readFileCapped(input, name, files), archive);
  } else if (
    (typeof FileList !== "undefined" && input instanceof FileList) ||
    Array.isArray(input)
  ) {
    const list = Array.from(input as ArrayLike<File>);
    if (list.length === 1) rejectUnsupportedArchive(list[0]!.name);
    if (list.length === 1 && isZipName(list[0]!.name))
      source = sourceFromZip(
        list[0]!.name,
        await readFileCapped(list[0]!, list[0]!.name, files),
        archive,
      );
    else source = sourceFromFileList(list, files);
  } else if (isFileSource(input)) {
    source = input;
  } else if (typeof input === "object" && input !== null && "files" in input) {
    const mem = new MemoryFileSource("files");
    const entries =
      input.files instanceof Map ? [...input.files.entries()] : Object.entries(input.files);
    for (const [path, data] of entries) mem.set(path, await bytesOf(data));
    source = mem;
  } else {
    throw new TypeError("unsupported model input");
  }
  return { source, settingsPath: resolveSettingsPath(source, settings ?? entry) };
}

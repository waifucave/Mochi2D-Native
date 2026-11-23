/**
 * Model data in place of a model's `.moc3` file: `.moc3` bytes, or
 * {@link MocData} with its version. A source is wrapped so that reading the
 * settings' `Moc` path gives these bytes; the settings, textures and every
 * other file still come from the source. Everything that reads a source (the
 * runtime, the views, `NodeRenderer`) then shows that model, and a preview
 * needs no stand-in `.moc3`.
 */
import {
  MemoryFileSource,
  OverlayFileSource,
  dirnameOf,
  joinPath,
  type FileSource,
} from "../core/io/file-source.js";
import { parseModelSettings } from "../core/settings/model-settings.js";
import { writeMoc } from "../core/moc/io.js";
import type { MocData, MocVersion } from "../core/moc/data.js";

/** A model's `.moc3` as bytes, or as {@link MocData} of a version (written with `writeMoc`). */
export type MocInput = Uint8Array | ArrayBuffer | { data: MocData; version: MocVersion };

/**
 * The `.moc3` bytes of an input: bytes as given, data written with
 * `writeMoc` (which throws `MocWriteError` for data it refuses).
 */
export function mocInputBytes(moc: MocInput): Uint8Array {
  if (moc instanceof Uint8Array) return moc;
  if (moc instanceof ArrayBuffer) return new Uint8Array(moc);
  return writeMoc(moc.data, { version: moc.version });
}

/** The path of the settings' `.moc3` inside the source. */
export async function mocPathOf(source: FileSource, settingsPath: string): Promise<string> {
  const settings = parseModelSettings(await source.read(settingsPath));
  return joinPath(dirnameOf(settingsPath), settings.moc);
}

/**
 * `source` with the settings' `.moc3` replaced by `bytes` (the file need not
 * exist in the source).
 */
export async function sourceWithMoc(
  source: FileSource,
  settingsPath: string,
  bytes: Uint8Array,
): Promise<FileSource> {
  return sourceWithMocAt(source, await mocPathOf(source, settingsPath), bytes);
}

/** `source` with the file at `mocPath` replaced by `bytes` (when the path is already known). */
export function sourceWithMocAt(
  source: FileSource,
  mocPath: string,
  bytes: Uint8Array,
): FileSource {
  return new OverlayFileSource(source.label, [
    MemoryFileSource.fromFiles({ [mocPath]: bytes }),
    source,
  ]);
}

/**
 * Our error classes, by name, for rebuilding an error that crossed from a
 * page to Node or from a local file server to its page (`core/io/error-wire`).
 * Any other name comes back as an `Error` of that name, with its fields.
 */
import {
  errorFromHeader as fromHeader,
  errorFromMessage as fromMessage,
  type WireErrorClass,
} from "../core/io/error-wire.js";
import { FileNotFoundError } from "../core/io/file-source.js";
import { FileLimitError } from "../core/io/file-limits.js";
import { TextureFormatError, TextureLimitError } from "../core/image/texture-limits.js";
import { MocFormatError } from "../core/moc/read.js";
import { MocWriteError } from "../core/moc/io.js";
import { SettingsFormatError } from "../core/settings/model-settings.js";
import { BinaryReadError } from "../core/binary/byte-reader.js";
import { ArchiveLimitError, ZipFormatError } from "../runtime/zip-archive.js";
import { UnsupportedArchiveError } from "../runtime/zip-source.js";
import { AnimationFormatError } from "../anim/json.js";
import { WavFormatError } from "../anim/lip-sync.js";
import { MotionSyncAudioError } from "../anim/motion-sync/wav.js";

export {
  errorForWire,
  errorToHeader,
  withoutWireLine,
  ERROR_HEADER,
} from "../core/io/error-wire.js";

// By the name each sets (`this.name`), not the class's own name, which a
// minifier may change.
const CLASSES: ReadonlyMap<string, WireErrorClass> = new Map<string, WireErrorClass>([
  ["FileNotFoundError", FileNotFoundError],
  ["FileLimitError", FileLimitError],
  ["TextureFormatError", TextureFormatError],
  ["TextureLimitError", TextureLimitError],
  ["MocFormatError", MocFormatError],
  ["MocWriteError", MocWriteError],
  ["SettingsFormatError", SettingsFormatError],
  ["BinaryReadError", BinaryReadError],
  ["ArchiveLimitError", ArchiveLimitError],
  ["ZipFormatError", ZipFormatError],
  ["UnsupportedArchiveError", UnsupportedArchiveError],
  ["AnimationFormatError", AnimationFormatError],
  ["WavFormatError", WavFormatError],
  ["MotionSyncAudioError", MotionSyncAudioError],
  ["TypeError", TypeError],
  ["RangeError", RangeError],
  ["SyntaxError", SyntaxError],
]);

/** Classes a caller adds (its own errors), as [name, class]. */
export type ExtraWireErrors = readonly (readonly [string, WireErrorClass])[];

function withExtra(extra: ExtraWireErrors): ReadonlyMap<string, WireErrorClass> {
  return extra.length ? new Map([...CLASSES, ...extra]) : CLASSES;
}

/** The error a rejection's message carries (`errorForWire`), rebuilt as its class; or null. */
export function wireErrorFromMessage(message: string, extra: ExtraWireErrors = []): Error | null {
  return fromMessage(message, withExtra(extra));
}

/** The error a local file server sent in {@link ERROR_HEADER}, rebuilt as its class; or null. */
export function wireErrorFromHeader(
  value: string | null,
  extra: ExtraWireErrors = [],
): Error | null {
  return fromHeader(value, withExtra(extra));
}

/** The HTTP status a local file server answers a refused read with. */
export function statusForReadError(e: unknown): number {
  if (e instanceof FileNotFoundError) return 404;
  if (e instanceof FileLimitError || e instanceof ArchiveLimitError) return 413;
  return 500;
}

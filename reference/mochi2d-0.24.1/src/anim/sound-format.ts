/**
 * Which of a model's motion sounds a view plays, and the diagnostics for the
 * ones it doesn't. The browser decodes compressed formats (FLAC, Ogg, MP3,
 * AAC) to many times their size, so by default a model's own motion sounds
 * play only as WAV files, whose samples follow their size.
 */
import type { ModelSettings } from "../core/settings/model-settings.js";

/** How a view treats a model's own motion sounds. */
export interface SoundOptions {
  /**
   * Let the browser decode compressed motion sounds (MP3, Ogg, FLAC, AAC,
   * WebM…), for models you trust. Default false: only WAV files play.
   */
  compressed?: boolean;
}

export type SoundFormat = "wav" | "mp3" | "ogg" | "flac" | "aac" | "webm" | "unknown";

const at = (b: Uint8Array, o: number, s: string) =>
  o + s.length <= b.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0));

/** A sound file's format, from its first bytes. */
export function soundFormat(b: Uint8Array): SoundFormat {
  if (at(b, 0, "RIFF") && at(b, 8, "WAVE")) return "wav";
  if (at(b, 0, "OggS")) return "ogg";
  if (at(b, 0, "fLaC")) return "flac";
  if (at(b, 0, "ID3") || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0))
    return "mp3";
  if (at(b, 4, "ftyp") || (b[0] === 0xff && (b[1]! & 0xf6) === 0xf0)) return "aac";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  return "unknown";
}

/** Each format's name, with its article. */
const NAMES: Record<SoundFormat, string> = {
  wav: "a WAV",
  mp3: "an MP3",
  ogg: "an Ogg",
  flac: "a FLAC",
  aac: "an AAC/MP4",
  webm: "a WebM",
  unknown: "an unrecognized",
};

/** Why a view skips a motion sound of these bytes under `options`, or null if it plays it. */
export function skippedSoundReason(bytes: Uint8Array, options: SoundOptions = {}): string | null {
  const f = soundFormat(bytes);
  if (f === "wav" || options.compressed) return null;
  return f === "unknown"
    ? "not a WAV file"
    : `${NAMES[f]} file: a model's motion sounds play only as WAV files unless the view is ` +
        "given sounds: { compressed: true }";
}

/** The diagnostic for a motion sound skipped when it was to play. */
export function skippedSoundWarning(path: string, reason: string): string {
  return `${path}: motion sound not played: ${reason}`;
}

/** The motion sounds a model's settings name, with their paths relative to the settings. */
export function motionSounds(settings: ModelSettings): string[] {
  const out: string[] = [];
  for (const g of settings.motions)
    for (const e of g.entries) if (e.sound && !out.includes(e.sound)) out.push(e.sound);
  return out;
}

/**
 * Diagnostics, from the sounds' names alone (nothing is read), for the
 * motion sounds a view would not play: those not named `.wav` under the
 * default options, or all of them when the view plays none (`played`
 * false: a view's items). A file named `.wav` that is not one is reported
 * when it is to play.
 */
export function motionSoundWarnings(
  settings: ModelSettings,
  options: SoundOptions & { played?: boolean } = {},
): string[] {
  const out: string[] = [];
  for (const s of motionSounds(settings)) {
    if (options.played === false)
      out.push(`${s}: motion sound not played: a view's items play no motion sounds`);
    else if (!options.compressed && !/\.wave?$/i.test(s))
      out.push(
        `${s}: motion sound not played: not named .wav, and a model's motion sounds play only ` +
          "as WAV files unless the view is given sounds: { compressed: true }",
      );
  }
  return out;
}

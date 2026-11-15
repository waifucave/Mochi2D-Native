/**
 * The `ItemSettings` object of a model folder's `*.vtube.json` file: a
 * model packaged as an item that is placed over a main
 * model. Only this object is read; nothing else in the file is used.
 */
import { dirnameOf, joinPath, readText, type FileSource } from "../../core/io/file-source.js";

/** Per-axis values for the head angles X, Y and Z. */
export interface HeadAngleTriple {
  x: number;
  y: number;
  z: number;
}

export interface ItemSettings {
  /** `Multiplier_HeadAngleX/Y/Z` (default 1). */
  multiplier: HeadAngleTriple;
  /** `Shift_HeadAngleX/Y/Z` (default 0). */
  shift: HeadAngleTriple;
  /** `Smoothing_HeadAngleX/Y/Z` (default 0): see {@link HeadAngleSmoother}. */
  smoothing: HeadAngleTriple;
  /** `OnlyMoveWhenPinned`, read and reported; Mochi2D gives it no effect. */
  onlyMoveWhenPinned: boolean | null;
  /** `AllowNormalHotkeyTriggers`, read and reported; Mochi2D gives it no effect. */
  allowNormalHotkeyTriggers: boolean | null;
  /** The path of the file it came from, relative to the settings file. */
  file: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);

/** Reads `ItemSettings` from a parsed `.vtube.json`; null if it has none. */
export function parseItemSettings(json: unknown, file: string): ItemSettings | null {
  if (!isObject(json) || !isObject(json.ItemSettings)) return null;
  const s = json.ItemSettings;
  const triple = (prefix: string, fallback: number): HeadAngleTriple => ({
    x: num(s[`${prefix}_HeadAngleX`], fallback),
    y: num(s[`${prefix}_HeadAngleY`], fallback),
    z: num(s[`${prefix}_HeadAngleZ`], fallback),
  });
  return {
    multiplier: triple("Multiplier", 1),
    shift: triple("Shift", 0),
    smoothing: triple("Smoothing", 0),
    onlyMoveWhenPinned: bool(s.OnlyMoveWhenPinned),
    allowNormalHotkeyTriggers: bool(s.AllowNormalHotkeyTriggers),
    file,
  };
}

/**
 * Finds and reads the item settings next to a settings file: the
 * `*.vtube.json` with the settings file's base name, else the only one in
 * its folder. Null when there is none, or it holds no `ItemSettings`.
 */
export async function readItemSettings(
  source: FileSource,
  settingsPath: string,
): Promise<ItemSettings | null> {
  const dir = dirnameOf(settingsPath);
  const base = settingsPath.slice(dir ? dir.length + 1 : 0).replace(/\.model3\.json$/i, "");
  const listed = source.list();
  let candidates: string[];
  if (listed) {
    const prefix = dir ? `${dir}/` : "";
    const inFolder = listed.filter(
      (p) =>
        p.startsWith(prefix) &&
        !p.slice(prefix.length).includes("/") &&
        p.toLowerCase().endsWith(".vtube.json"),
    );
    const named = inFolder.filter(
      (p) => p.slice(prefix.length).toLowerCase() === `${base}.vtube.json`.toLowerCase(),
    );
    candidates = named.length ? named : inFolder.length === 1 ? inFolder : [];
  } else {
    candidates = [joinPath(dir, `${base}.vtube.json`)];
  }
  for (const path of candidates) {
    try {
      const json: unknown = JSON.parse(await readText(source, path));
      return parseItemSettings(json, path.slice(dir ? dir.length + 1 : 0));
    } catch {
      // A missing or broken file means no item settings.
    }
  }
  return null;
}

/**
 * Smooths a forwarded head angle with a first-order low-pass filter whose
 * time constant is the smoothing value in hundredths of a second (Mochi2D's
 * choice: 15 → 0.15 s). The value moves toward its target by
 * 1 − exp(−dt / τ) of the remaining distance each frame, so the result does
 * not depend on the frame rate. Zero or less means no smoothing.
 */
export class HeadAngleSmoother {
  private value: number | null = null;

  constructor(public strength: number) {}

  /** The smoothed value after a frame of `dt` seconds toward `target`. */
  step(target: number, dt: number): number {
    const tau = this.strength / 100;
    if (this.value === null || tau <= 0) this.value = target;
    else if (dt > 0) this.value += (target - this.value) * (1 - Math.exp(-dt / tau));
    return this.value;
  }

  reset(): void {
    this.value = null;
  }
}

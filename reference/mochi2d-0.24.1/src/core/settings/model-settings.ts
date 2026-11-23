/**
 * The model settings file `*.model3.json` (3b): which files belong
 * to the model, parameter groups, hit areas and layout. Keys are
 * case-sensitive and unknown keys are ignored. Paths are relative to the
 * directory of the settings file.
 */
import { decodeUtf8 } from "../binary/utf8.js";

export class SettingsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsFormatError";
  }
}

/** One entry of a motion group (3b.2). */
export interface MotionEntry {
  file: string;
  /** Overrides the motion file's fade times, but only when ≥ 0 (3b.2). */
  fadeInTime?: number;
  fadeOutTime?: number;
  /** A WAV file started together with the motion, if the start is accepted. */
  sound?: string;
  /**
   * The motion-sync setting that drives the mouth with the sound: a
   * dictionary name of the model's motion-sync file (or a setting ID).
   */
  motionSync?: string;
}

export interface ParameterGroup {
  target: string;
  name: string;
  ids: string[];
}

export interface ModelSettings {
  /** Path of the `.moc3` file, relative to the settings file. */
  moc: string;
  /** Texture paths relative to the settings file, in index order. */
  textures: string[];
  physics?: string;
  pose?: string;
  userData?: string;
  displayInfo?: string;
  /** The motion-sync file (`*.motionsync3.json`), if any. */
  motionSync?: string;
  /** Named expressions, in file order. */
  expressions: { name: string; file: string }[];
  /** Motion groups, in file order. */
  motions: { group: string; entries: MotionEntry[] }[];
  groups: ParameterGroup[];
  /** Named hit areas: `id` is an art-mesh ID (3t). */
  hitAreas: { id: string; name: string }[];
  /** Placement in a viewer; only the lower-case keys of 3b.4 are read. */
  layout: Record<string, number>;
  /** The parsed JSON. */
  raw: Record<string, unknown>;
}

const LAYOUT_KEYS = [
  "width",
  "height",
  "x",
  "y",
  "center_x",
  "center_y",
  "top",
  "bottom",
  "left",
  "right",
];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export function parseModelSettings(bytes: Uint8Array, label = "model settings"): ModelSettings {
  let text = decodeUtf8(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new SettingsFormatError(`${label}: invalid JSON (${(e as Error).message})`);
  }
  return settingsFromJson(json, label);
}

/** Settings from already parsed JSON. */
export function settingsFromJson(json: unknown, label = "model settings"): ModelSettings {
  if (!isObject(json)) throw new SettingsFormatError(`${label}: not a JSON object`);
  const raw = json;
  const r = raw.FileReferences;
  if (!isObject(r)) throw new SettingsFormatError(`${label}: no FileReferences object`);
  if (typeof r.Moc !== "string" || r.Moc === "")
    throw new SettingsFormatError(`${label}: FileReferences.Moc is missing`);
  const textures = r.Textures;
  if (
    textures !== undefined &&
    !(Array.isArray(textures) && textures.every((t) => typeof t === "string"))
  ) {
    throw new SettingsFormatError(`${label}: FileReferences.Textures must be a list of strings`);
  }
  const expressions: ModelSettings["expressions"] = [];
  if (Array.isArray(r.Expressions))
    for (const e of r.Expressions)
      if (isObject(e) && typeof e.File === "string")
        expressions.push({ name: str(e.Name) ?? e.File, file: e.File });
  const motions: ModelSettings["motions"] = [];
  if (isObject(r.Motions))
    for (const [group, list] of Object.entries(r.Motions)) {
      const entries: MotionEntry[] = [];
      if (Array.isArray(list))
        for (const m of list) {
          if (!isObject(m) || typeof m.File !== "string") continue;
          const entry: MotionEntry = { file: m.File };
          const fi = num(m.FadeInTime);
          const fo = num(m.FadeOutTime);
          const sound = str(m.Sound);
          const sync = str(m.MotionSync);
          if (fi !== undefined) entry.fadeInTime = fi;
          if (fo !== undefined) entry.fadeOutTime = fo;
          if (sound) entry.sound = sound;
          if (sync) entry.motionSync = sync;
          entries.push(entry);
        }
      motions.push({ group, entries });
    }
  const groups: ParameterGroup[] = [];
  if (Array.isArray(raw.Groups))
    for (const g of raw.Groups)
      if (isObject(g))
        groups.push({
          target: str(g.Target) ?? "",
          name: str(g.Name) ?? "",
          ids: Array.isArray(g.Ids) ? g.Ids.filter((x): x is string => typeof x === "string") : [],
        });
  const hitAreas: ModelSettings["hitAreas"] = [];
  if (Array.isArray(raw.HitAreas))
    for (const h of raw.HitAreas)
      if (isObject(h) && typeof h.Id === "string")
        hitAreas.push({ id: h.Id, name: str(h.Name) ?? "" });
  const layout: Record<string, number> = {};
  if (isObject(raw.Layout))
    for (const k of LAYOUT_KEYS) {
      const v = num(raw.Layout[k]);
      if (v !== undefined) layout[k] = v;
    }
  const optional = (k: string): string | undefined => {
    const v = r[k];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const settings: ModelSettings = {
    moc: r.Moc,
    textures: (textures as string[] | undefined) ?? [],
    expressions,
    motions,
    groups,
    hitAreas,
    layout,
    raw,
  };
  const physics = optional("Physics");
  const pose = optional("Pose");
  const userData = optional("UserData");
  const displayInfo = optional("DisplayInfo");
  const motionSync = optional("MotionSync");
  if (motionSync) settings.motionSync = motionSync;
  if (physics) settings.physics = physics;
  if (pose) settings.pose = pose;
  if (userData) settings.userData = userData;
  if (displayInfo) settings.displayInfo = displayInfo;
  return settings;
}

/** IDs of the first parameter group with this name (3b.3); empty if there is none. */
export function parameterGroupIds(settings: ModelSettings, name: string): string[] {
  return settings.groups.find((g) => g.name === name)?.ids ?? [];
}

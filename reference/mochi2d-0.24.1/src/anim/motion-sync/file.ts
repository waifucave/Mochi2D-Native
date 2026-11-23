/**
 * Motion-sync settings files (`*.motionsync3.json`): for each setting, the
 * model parameters it drives, the audio elements an analysis reports
 * (Silence and the vowels A, I, U, E, O), the shape each element gives the
 * driven parameters, and the post-processing values.
 *
 * The reader is lenient: a missing or ill-typed field never fails the load,
 * it yields a default (0, an empty string or list, false), with a warning.
 * Mochi2D then limits values to their documented ranges, with a warning:
 *
 * - `Scale` to [0.1, 10], `BlendRatio` to [0, 1], `Smooth` to [0, 100];
 * - `Smoothing`, read as an integer (its fraction dropped), to [1, 100];
 * - `SampleRate` to [1, 120], 60 when it is not positive.
 *
 * Settings are read by position, `Meta.Dictionary[i]` with `Settings[i]`,
 * for the smaller of `SettingCount` and the length of `Settings`. A setting
 * whose analysis type is not recognized is kept, unusable. Mappings are
 * matched to elements and targets to driven parameters by their IDs, so a
 * file lists them in any order.
 */
import { AnimationFormatError, isObject, parseJson, type Json } from "../json.js";

/** The audio elements of a mouth setting, in their usual order. */
export const MOTION_SYNC_ELEMENTS = ["Silence", "A", "I", "U", "E", "O"] as const;
export type MotionSyncElementId = (typeof MOTION_SYNC_ELEMENTS)[number];

/** The analysis type every editor-made file names; Mochi2D runs its own analysis for it. */
export const MOTION_SYNC_ANALYSIS_TYPE = "CRI";

/** A model parameter a setting drives. */
export interface MotionSyncParameter {
  id: string;
  name: string;
  /** The range the author saw; not used to drive the parameter. */
  min: number;
  max: number;
  /** The dead band: the written value follows only once it moved this far (≥ 0). */
  damper: number;
  /** The weight of the per-parameter smoothing, in percent, [0, 100]. */
  smooth: number;
}

/** An audio element of a setting. */
export interface MotionSyncElement {
  id: string;
  name: string;
  min: number;
  max: number;
  /** Multiplier of the element's weight, [0.1, 10]. */
  scale: number;
  enabled: boolean;
  /** One of {@link MOTION_SYNC_ELEMENTS}; other elements get weight 0. */
  known: boolean;
}

export interface MotionSyncSetting {
  /** Position in the file. */
  index: number;
  id: string;
  /** The dictionary name, which motion entries use to refer to the setting. */
  name: string;
  analysisType: string;
  useCase: string;
  /** False when the analysis type is not recognized: the setting never runs. */
  usable: boolean;
  parameters: MotionSyncParameter[];
  elements: MotionSyncElement[];
  /** shapes[e][k]: element e's value for driven parameter k. */
  shapes: number[][];
  /** 0: the most likely element's shape; 1: the elements' shapes blended by weight. */
  blendRatio: number;
  /** How smooth the analysis results are, 1 (intense) to 100 (smooth). */
  smoothing: number;
  /** Analysis ticks per second, [1, 120]. */
  sampleRate: number;
}

export interface MotionSyncFile {
  label: string;
  version: number;
  settings: MotionSyncSetting[];
  /** What was missing, ill-typed, out of range or not recognized. */
  warnings: string[];
}

export interface MotionSyncReadOptions {
  /** Also warn about keys the format does not define. Default false. */
  lint?: boolean;
}

const KEYS = {
  root: ["Version", "Meta", "Settings"],
  meta: ["SettingCount", "Dictionary"],
  dictionary: ["Id", "Name"],
  setting: [
    "Id",
    "AnalysisType",
    "UseCase",
    "CubismParameters",
    "AudioParameters",
    "Mappings",
    "PostProcessing",
  ],
  parameter: ["Name", "Id", "Min", "Max", "Damper", "Smooth"],
  element: ["Name", "Id", "Min", "Max", "Scale", "Enabled"],
  mapping: ["Type", "Id", "Targets"],
  target: ["Id", "Value"],
  post: ["BlendRatio", "Smoothing", "SampleRate"],
} as const;

/** Reads a `.motionsync3.json` file (bytes, text or parsed JSON). Throws only for invalid JSON. */
export function parseMotionSync(
  input: Uint8Array | string | unknown,
  label = "motion sync",
  options: MotionSyncReadOptions = {},
): MotionSyncFile {
  const json =
    typeof input === "string" || input instanceof Uint8Array ? parseJson(input, label) : input;
  const warnings: string[] = [];
  const warn = (path: string, what: string) => warnings.push(`${label}: ${path} ${what}`);
  const lint = (o: Json, path: string, keys: readonly string[]) => {
    if (!options.lint) return;
    for (const k of Object.keys(o))
      if (!keys.includes(k)) warn(path ? `${path}.${k}` : k, "is not part of the format; ignored");
  };
  // Lenient readers: the default, with a warning, for a missing or ill-typed value.
  const object = (v: unknown, path: string): Json => {
    if (isObject(v)) return v;
    warn(path, v === undefined ? "is missing" : "is not an object");
    return {};
  };
  const list = (v: unknown, path: string): unknown[] => {
    if (Array.isArray(v)) return v;
    warn(path, v === undefined ? "is missing; empty is used" : "is not a list; empty is used");
    return [];
  };
  const number = (v: unknown, path: string, fallback = 0): number => {
    if (typeof v === "number") return v;
    warn(path, `${v === undefined ? "is missing" : "is not a number"}; ${fallback} is used`);
    return fallback;
  };
  // An integer field: its decimal text read as an integer, so the fraction is dropped.
  const integer = (v: unknown, path: string): number => {
    const n = number(v, path);
    const i = Number.parseInt(String(n), 10);
    return Number.isFinite(i) ? i + 0 : 0;
  };
  const text = (v: unknown, path: string): string => {
    if (typeof v === "string") return v;
    warn(path, v === undefined ? "is missing" : "is not a string");
    return "";
  };
  const flag = (v: unknown, path: string): boolean => {
    if (typeof v === "boolean") return v;
    warn(path, `${v === undefined ? "is missing" : "is not true or false"}; read as false`);
    return false;
  };
  const limited = (x: number, lo: number, hi: number, path: string): number => {
    if (x >= lo && x <= hi) return x;
    const y = Math.min(hi, Math.max(lo, x));
    warn(path, `${x} is outside [${lo}, ${hi}]; ${y} is used`);
    return y;
  };

  if (!isObject(json)) throw new AnimationFormatError(`${label}: not a JSON object`);
  lint(json, "", KEYS.root);
  const version = integer(json.Version, "Version");
  if (version !== 1) warn("Version", `is ${version}, not 1; read as version 1`);
  const meta = object(json.Meta, "Meta");
  lint(meta, "Meta", KEYS.meta);
  const count = integer(meta.SettingCount, "Meta.SettingCount");
  const dictionary = list(meta.Dictionary, "Meta.Dictionary");
  const settingList = list(json.Settings, "Settings");
  if (count !== settingList.length)
    warn(
      "Meta.SettingCount",
      `is ${count}, but Settings has ${settingList.length}; ${Math.max(0, Math.min(count, settingList.length))} read`,
    );
  const n = Math.max(0, Math.min(count, settingList.length));
  const settings: MotionSyncSetting[] = [];
  for (let i = 0; i < n; i++) {
    const at = `Settings[${i}]`;
    const s = object(settingList[i], at);
    lint(s, at, KEYS.setting);
    const entry = object(dictionary[i], `Meta.Dictionary[${i}]`);
    lint(entry, `Meta.Dictionary[${i}]`, KEYS.dictionary);
    const id = text(s.Id, `${at}.Id`);
    const name = text(entry.Name, `Meta.Dictionary[${i}].Name`);
    const dictId = text(entry.Id, `Meta.Dictionary[${i}].Id`);
    if (dictId !== id) warn(`Meta.Dictionary[${i}].Id`, `is "${dictId}", not "${id}"`);
    const analysisType = text(s.AnalysisType, `${at}.AnalysisType`);
    const usable = analysisType === MOTION_SYNC_ANALYSIS_TYPE;
    if (!usable)
      warn(`${at}.AnalysisType`, `"${analysisType}" is not supported; the setting is ignored`);
    const useCase = text(s.UseCase, `${at}.UseCase`);
    if (useCase !== "Mouth") warn(`${at}.UseCase`, `is "${useCase}", not "Mouth"; used anyway`);

    const parameters = list(s.CubismParameters, `${at}.CubismParameters`).map((p, k) => {
      const pa = `${at}.CubismParameters[${k}]`;
      const o = object(p, pa);
      lint(o, pa, KEYS.parameter);
      const damper = number(o.Damper, `${pa}.Damper`);
      return {
        id: text(o.Id, `${pa}.Id`),
        name: typeof o.Name === "string" ? o.Name : "",
        min: number(o.Min, `${pa}.Min`),
        max: number(o.Max, `${pa}.Max`),
        // A negative dead band acts as none.
        damper: damper > 0 ? damper : 0,
        smooth: limited(number(o.Smooth, `${pa}.Smooth`), 0, 100, `${pa}.Smooth`),
      };
    });

    const elements = list(s.AudioParameters, `${at}.AudioParameters`).map((e, k) => {
      const pa = `${at}.AudioParameters[${k}]`;
      const o = object(e, pa);
      lint(o, pa, KEYS.element);
      const eid = text(o.Id, `${pa}.Id`);
      const known = (MOTION_SYNC_ELEMENTS as readonly string[]).includes(eid);
      if (!known)
        warn(
          `${pa}.Id`,
          `"${eid}" is not one of ${MOTION_SYNC_ELEMENTS.join(", ")}; its weight is 0`,
        );
      return {
        id: eid,
        name: typeof o.Name === "string" ? o.Name : "",
        min: number(o.Min, `${pa}.Min`),
        max: number(o.Max, `${pa}.Max`),
        scale: limited(number(o.Scale, `${pa}.Scale`), 0.1, 10, `${pa}.Scale`),
        enabled: flag(o.Enabled, `${pa}.Enabled`),
        known,
      };
    });

    // As many mappings as elements, by position; each element takes the first
    // of those whose Id is its own, and each driven parameter the target with its Id.
    const mappings = list(s.Mappings, `${at}.Mappings`)
      .slice(0, elements.length)
      .map((m, k) => {
        const pa = `${at}.Mappings[${k}]`;
        const o = object(m, pa);
        lint(o, pa, KEYS.mapping);
        const type = text(o.Type, `${pa}.Type`);
        if (type !== "Shape") warn(`${pa}.Type`, `is "${type}", not "Shape"; used anyway`);
        const targets = list(o.Targets, `${pa}.Targets`).map((t, j) => {
          const ta = `${pa}.Targets[${j}]`;
          const to = object(t, ta);
          lint(to, ta, KEYS.target);
          return { id: text(to.Id, `${ta}.Id`), value: number(to.Value, `${ta}.Value`) };
        });
        return { id: text(o.Id, `${pa}.Id`), targets };
      });
    const shapes = elements.map((e) => {
      const m = mappings.find((x) => x.id === e.id);
      if (!m) {
        warn(`${at}.Mappings`, `have no shape for element "${e.id}"; 0 is used`);
        return parameters.map(() => 0);
      }
      return parameters.map((p) => {
        const t = m.targets.find((x) => x.id === p.id);
        if (t) return t.value;
        warn(`${at}.Mappings`, `"${e.id}" has no target for "${p.id}"; 0 is used`);
        return 0;
      });
    });

    const pp = `${at}.PostProcessing`;
    const post = object(s.PostProcessing, pp);
    lint(post, pp, KEYS.post);
    const blendRatio = limited(
      number(post.BlendRatio, `${pp}.BlendRatio`),
      0,
      1,
      `${pp}.BlendRatio`,
    );
    const smoothing = limited(
      integer(post.Smoothing, `${pp}.Smoothing`),
      1,
      100,
      `${pp}.Smoothing`,
    );
    let sampleRate = number(post.SampleRate, `${pp}.SampleRate`);
    if (!(sampleRate > 0)) {
      warn(`${pp}.SampleRate`, `is ${sampleRate}; 60 is used`);
      sampleRate = 60;
    } else sampleRate = limited(sampleRate, 1, 120, `${pp}.SampleRate`);

    settings.push({
      index: i,
      id,
      name,
      analysisType,
      useCase,
      usable,
      parameters,
      elements,
      shapes,
      blendRatio,
      smoothing,
      sampleRate,
    });
  }
  return { label, version, settings, warnings };
}

/**
 * The setting a motion entry names: the first whose dictionary name is
 * `ref`, else the first whose ID is `ref`; null when none matches.
 */
export function findMotionSyncSetting(file: MotionSyncFile, ref: string): MotionSyncSetting | null {
  return (
    file.settings.find((s) => s.name === ref) ?? file.settings.find((s) => s.id === ref) ?? null
  );
}

/** A motion-sync setting as {@link writeMotionSync} takes it: what the reader gives, less what it derives. */
export type MotionSyncSettingData = Omit<MotionSyncSetting, "index" | "usable" | "elements"> & {
  elements: Omit<MotionSyncElement, "known">[];
};

/** Options of {@link writeMotionSync}. */
export interface WriteMotionSyncOptions {
  /** Indentation, as JSON.stringify's `space`. Default a tab. */
  indent?: string | number;
}

/**
 * The text of a `.motionsync3.json` file holding `file`'s settings: the
 * inverse of {@link parseMotionSync}, which reads the text back as the same
 * settings. `Meta` (the count and the dictionary of IDs and names) comes
 * from the settings, each element's shape is written as its mapping (in
 * element order, its targets in the driven parameters' order), and keys come
 * in the format's order, indented with tabs. `version` defaults to 1. Values
 * outside the documented ranges are written as given (the reader limits
 * them, with a warning). Throws a RangeError for what would not read back as
 * written: a number JSON cannot hold (NaN, ±∞), a shape whose size does not
 * match the elements and driven parameters, or two elements or two driven
 * parameters of one setting with the same ID; the message says where.
 */
export function writeMotionSync(
  file: { version?: number; settings: readonly MotionSyncSettingData[] },
  options: WriteMotionSyncOptions = {},
): string {
  const n = (v: number, where: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new RangeError(`writeMotionSync: ${where} is ${v}, not a finite number`);
    return v;
  };
  const unique = (ids: readonly string[], where: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id))
        throw new RangeError(`writeMotionSync: ${where} has "${id}" twice; it would not read back`);
      seen.add(id);
    }
  };
  const json = {
    Version: n(file.version ?? 1, "version"),
    Meta: {
      SettingCount: file.settings.length,
      Dictionary: file.settings.map((s) => ({ Id: s.id, Name: s.name })),
    },
    Settings: file.settings.map((s, i) => {
      const at = `settings[${i}]`;
      unique(
        s.parameters.map((p) => p.id),
        `${at}.parameters`,
      );
      unique(
        s.elements.map((e) => e.id),
        `${at}.elements`,
      );
      if (s.shapes.length !== s.elements.length)
        throw new RangeError(
          `writeMotionSync: ${at}.shapes has ${s.shapes.length} shapes for ${s.elements.length} elements`,
        );
      return {
        Id: s.id,
        AnalysisType: s.analysisType,
        UseCase: s.useCase,
        CubismParameters: s.parameters.map((p, k) => ({
          Name: p.name,
          Id: p.id,
          Min: n(p.min, `${at}.parameters[${k}].min`),
          Max: n(p.max, `${at}.parameters[${k}].max`),
          Damper: n(p.damper, `${at}.parameters[${k}].damper`),
          Smooth: n(p.smooth, `${at}.parameters[${k}].smooth`),
        })),
        AudioParameters: s.elements.map((e, k) => ({
          Name: e.name,
          Id: e.id,
          Min: n(e.min, `${at}.elements[${k}].min`),
          Max: n(e.max, `${at}.elements[${k}].max`),
          Scale: n(e.scale, `${at}.elements[${k}].scale`),
          Enabled: e.enabled === true,
        })),
        Mappings: s.elements.map((e, k) => {
          const shape = s.shapes[k]!;
          if (shape.length !== s.parameters.length)
            throw new RangeError(
              `writeMotionSync: ${at}.shapes[${k}] has ${shape.length} values for ${s.parameters.length} driven parameters`,
            );
          return {
            Type: "Shape",
            Id: e.id,
            Targets: s.parameters.map((p, j) => ({
              Id: p.id,
              Value: n(shape[j]!, `${at}.shapes[${k}][${j}]`),
            })),
          };
        }),
        PostProcessing: {
          BlendRatio: n(s.blendRatio, `${at}.blendRatio`),
          Smoothing: n(s.smoothing, `${at}.smoothing`),
          SampleRate: n(s.sampleRate, `${at}.sampleRate`),
        },
      };
    }),
  };
  return JSON.stringify(json, null, options.indent ?? "\t");
}

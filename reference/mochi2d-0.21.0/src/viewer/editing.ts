/**
 * The viewer's edits to an open model: the model settings' motion entries,
 * expression files and the pose file. Edits take effect at once (motions
 * play with their new settings, expressions and the pose show the change)
 * and are kept until exported: one file on its own, or several as a `.zip`
 * with the model settings and every changed file at its path in the model's
 * folder.
 */
import { dirnameOf, joinPath, type FileSource } from "../core/io/file-source.js";
import { classifyModelFile } from "../core/io/model-files.js";
import { settingsFromJson, type ModelSettings } from "../core/settings/model-settings.js";
import type { Expression } from "../anim/expression.js";
import { parsePose } from "../anim/pose.js";
import type { LiveModel } from "../lib/live-model.js";
import {
  addMotionEntry,
  draftExpression,
  draftPose,
  editMotionEntry,
  expressionDraft,
  moveMotionEntry,
  poseDraft,
  removeMotionEntry,
  writeExpressionFile,
  writePoseFile,
  zipFiles,
  type ExpressionDraft,
  type MotionEntryChanges,
  type MotionPlace,
  type PoseDraft,
} from "./edit-files.js";
import { exportModelSettings } from "./export.js";

type Json = Record<string, unknown>;

const short = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The shortest decimal that reads back as the same float32 (−0.2 for f32(−0.2)). */
export function shortestFloat32(x: number): number {
  if (!Number.isFinite(x)) return x;
  for (let p = 1; p <= 9; p++) {
    const d = Number(x.toPrecision(p));
    if (Math.fround(d) === Math.fround(x)) return d;
  }
  return x;
}

/** What an export downloads. */
export interface EditExport {
  name: string;
  data: Uint8Array;
  type: string;
  /** The files it holds, by path in the model's folder. */
  files: string[];
  /** Expression files the model settings got because the folder has them unlisted. */
  added: number;
}

export class EditSession {
  private draft: Json | null = null;
  /** Edited and new files by path in the source: their text. */
  private readonly texts = new Map<string, string>();
  /** Paths changed since the last export; the settings path when the settings changed. */
  readonly unsaved = new Set<string>();
  /** Motion files whose settings entries changed since the last export. */
  readonly editedMotions = new Set<string>();
  /** The folder with the edits applied. */
  readonly source: FileSource;
  private parsed: ModelSettings;

  constructor(
    readonly settingsPath: string,
    private readonly loaded: Json,
    private readonly folder: FileSource,
    private readonly files: () => readonly string[],
    private live: LiveModel,
  ) {
    this.parsed = live.loaded.settings;
    const texts = this.texts;
    const enc = new TextEncoder();
    this.source = {
      label: folder.label,
      list: () => folder.list(),
      read: async (path) => {
        const t = texts.get(path);
        return t !== undefined ? enc.encode(t) : folder.read(path);
      },
    };
  }

  /** Whether this session edits that model (same source and settings file). */
  isFor(source: FileSource, settingsPath: string): boolean {
    return source === this.folder && settingsPath === this.settingsPath;
  }

  /** After the same model was loaded again (new textures, a lost GPU context): the edits on it. */
  attach(live: LiveModel): void {
    this.live = live;
    const motions = live.runtime.settings.motions;
    motions.splice(0, motions.length, ...this.parsed.motions);
    const path = this.posePath;
    const text = path ? this.texts.get(path) : undefined;
    if (path && text !== undefined) {
      const rt = live.runtime;
      const had = rt.effectAvailable("pose");
      rt.animator.setPose(parsePose(text, short(path)));
      if (!had) rt.setEffect("pose", true);
    }
  }

  /** The model's folder, as a prefix of paths ("" at the source's root). */
  get dir(): string {
    return dirnameOf(this.settingsPath);
  }

  /** A path relative to the settings file, in the source. */
  resolve(rel: string): string {
    return joinPath(this.dir, rel);
  }

  /** A path in the source, relative to the settings file. */
  relative(path: string): string {
    const d = this.dir;
    return d && path.startsWith(`${d}/`) ? path.slice(d.length + 1) : path;
  }

  /** The model settings JSON as edited. */
  get settingsJson(): Json {
    return this.draft ?? this.loaded;
  }

  /** The model settings as edited. */
  get settings(): ModelSettings {
    return this.parsed;
  }

  /** Whether anything changed since the last export. */
  get dirty(): boolean {
    return this.unsaved.size > 0;
  }

  /** Whether a file has edits (exported or not). */
  edited(path: string): boolean {
    return this.texts.has(path);
  }

  // ------------------------------------------------------------- settings

  private editSettings(fn: (draft: Json) => void): void {
    const draft = (this.draft ??= structuredClone(this.loaded));
    fn(draft);
    this.parsed = settingsFromJson(draft, short(this.settingsPath));
    // The runtime plays groups (and idle) from its settings' motion list.
    const motions = this.live.runtime.settings.motions;
    motions.splice(0, motions.length, ...this.parsed.motions);
    this.unsaved.add(this.settingsPath);
  }

  /** Changes a motion entry's fades, sound or motion-sync setting. */
  editMotion(at: MotionPlace, changes: MotionEntryChanges, file: string): void {
    this.editSettings((d) => editMotionEntry(d, at, changes));
    this.editedMotions.add(file);
  }

  /**
   * Puts a motion in another group (made when new) or, with `group` null,
   * takes it out of the settings. Returns its new place (null: out).
   */
  moveMotion(at: MotionPlace, group: string | null, file: string): MotionPlace | null {
    let place: MotionPlace | null = null;
    this.editSettings((d) => {
      if (group === null) removeMotionEntry(d, at);
      else place = moveMotionEntry(d, at, group);
    });
    this.editedMotions.add(file);
    return place;
  }

  /** Lists a motion file of the folder in a group. Returns its place. */
  addMotion(file: string, group: string): MotionPlace {
    let place: MotionPlace = { group, index: 0 };
    this.editSettings((d) => (place = addMotionEntry(d, this.relative(file), group)));
    this.editedMotions.add(file);
    return place;
  }

  // ----------------------------------------------------------- expressions

  /** A parameter's default as typed in the editor that made the model (the shortest decimal of the float32). */
  private defaultOf = (id: string): number => {
    const p = this.live.loaded.model.parameters;
    const i = p.ids.indexOf(id);
    return i < 0 ? 0 : shortestFloat32(p.defaults[i]!);
  };

  private async json(path: string): Promise<unknown> {
    const bytes = await this.source.read(path);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }

  /** An expression file as the editor shows it (edited or as in the folder). */
  async expression(path: string): Promise<ExpressionDraft> {
    return expressionDraft(await this.json(path), this.defaultOf);
  }

  /** The value a parameter has by default (an Add row's starting value). */
  parameterDefault(id: string): number {
    return this.defaultOf(id);
  }

  /** Keeps an expression's edits; returns what it plays (for a preview). */
  async setExpression(
    path: string,
    draft: ExpressionDraft,
    defaultFade: number,
  ): Promise<Expression> {
    const original = await this.originalJson(path);
    this.texts.set(path, writeExpressionFile(draft, this.defaultOf, original));
    this.unsaved.add(path);
    return draftExpression(draft, this.defaultOf, short(path), defaultFade);
  }

  /** The file as it was before any edit (null for a file the viewer made). */
  private async originalJson(path: string): Promise<unknown> {
    try {
      const bytes = await this.folder.read(path);
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------- pose

  /** The pose file's path in the source, or null. */
  get posePath(): string | null {
    return this.parsed.pose ? this.resolve(this.parsed.pose) : null;
  }

  /** The pose as the editor shows it: every part of the model, then the file's others. */
  async pose(): Promise<PoseDraft> {
    const path = this.posePath;
    return poseDraft(path ? await this.json(path) : null, this.live.loaded.model.parts.ids);
  }

  /**
   * Makes a new pose file next to the settings, listing every part without
   * a group, and refers to it in the settings. Returns its path.
   */
  createPose(): string {
    const base = short(this.settingsPath).replace(/\.model3\.json$/i, "");
    const taken = new Set(this.files());
    let name = `${base}.pose3.json`;
    for (let n = 2; taken.has(this.resolve(name)) || this.texts.has(this.resolve(name)); n++)
      name = `${base}-${n}.pose3.json`;
    const path = this.resolve(name);
    const draft = poseDraft(null, this.live.loaded.model.parts.ids);
    this.texts.set(path, writePoseFile(draft));
    this.unsaved.add(path);
    this.editSettings((d) => {
      const refs = d.FileReferences as Json;
      refs.Pose = name;
    });
    this.applyPose(draft, path);
    return path;
  }

  /**
   * Makes a new expression file with no parameters, named `name`, and lists
   * it in the settings under that name. It goes beside the settings'
   * expressions (the first one's folder), else next to the settings; the
   * file is named after the expression (made unique). Returns its path, or
   * throws a RangeError for an empty name or one the settings already use.
   */
  createExpression(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new RangeError("the expression needs a name");
    if (this.parsed.expressions.some((e) => e.name === trimmed))
      throw new RangeError(`the settings already have an expression named "${trimmed}"`);
    const first = this.parsed.expressions[0]?.file;
    const folder = first && first.includes("/") ? first.slice(0, first.lastIndexOf("/") + 1) : "";
    const stem = trimmed.replace(/[\\/:*?"<>|]+/g, "_");
    const taken = new Set(this.files());
    let rel = `${folder}${stem}.exp3.json`;
    for (let n = 2; taken.has(this.resolve(rel)) || this.texts.has(this.resolve(rel)); n++)
      rel = `${folder}${stem}-${n}.exp3.json`;
    const path = this.resolve(rel);
    this.texts.set(
      path,
      writeExpressionFile({ fadeIn: null, fadeOut: null, rows: [] }, this.defaultOf),
    );
    this.unsaved.add(path);
    this.editSettings((d) => {
      const refs = d.FileReferences as Json;
      const list = Array.isArray(refs.Expressions) ? (refs.Expressions as unknown[]) : [];
      list.push({ Name: trimmed, File: rel });
      refs.Expressions = list;
    });
    return path;
  }

  /** Keeps the pose's edits and shows them. */
  async setPose(draft: PoseDraft): Promise<void> {
    const path = this.posePath;
    if (!path) throw new Error("the model has no pose file");
    this.texts.set(path, writePoseFile(draft, await this.originalJson(path)));
    this.unsaved.add(path);
    this.applyPose(draft, path);
  }

  private applyPose(draft: PoseDraft, path: string): void {
    const rt = this.live.runtime;
    const had = rt.effectAvailable("pose");
    rt.animator.setPose(draftPose(draft, short(path)));
    if (!had) rt.setEffect("pose", true);
    rt.touch();
  }

  // ------------------------------------------------------------------ export

  /** The model settings file's text as exported. */
  settingsText(): { name: string; text: string; added: number } {
    const files = [...this.files(), ...this.texts.keys()].filter(
      (p, i, all) => all.indexOf(p) === i && classifyModelFile(p) !== "other",
    );
    return exportModelSettings({ settingsPath: this.settingsPath, raw: this.settingsJson, files });
  }

  /** The changed files other than the model settings, unsaved. */
  private changedFiles(): string[] {
    return [...this.unsaved].filter((p) => p !== this.settingsPath && this.texts.has(p));
  }

  /** What {@link export} downloads now: the file's name, and whether it is a `.zip`. */
  exportPlan(): { name: string; zip: boolean } {
    const changed = this.changedFiles();
    if (changed.length > 1 || (changed.length === 1 && this.unsaved.has(this.settingsPath)))
      return { name: `${short(this.settingsPath).replace(/\.model3\.json$/i, "")}.zip`, zip: true };
    return { name: short(changed[0] ?? this.settingsPath), zip: false };
  }

  /**
   * What to download: with nothing or only one file changed, that file (the
   * model settings by default); with several, a `.zip` of the model settings
   * and every changed file at its path in the model's folder.
   */
  export(): EditExport {
    const enc = new TextEncoder();
    const changed = this.changedFiles();
    const settings = this.settingsText();
    const plan = this.exportPlan();
    if (!plan.zip) {
      const p = changed[0];
      if (p !== undefined && !this.unsaved.has(this.settingsPath))
        return {
          name: short(p),
          data: enc.encode(this.texts.get(p)!),
          type: "application/json",
          files: [this.relative(p)],
          added: 0,
        };
      return {
        name: settings.name,
        data: enc.encode(settings.text),
        type: "application/json",
        files: [this.relative(this.settingsPath)],
        added: settings.added,
      };
    }
    const entries = [
      { path: this.relative(this.settingsPath), data: settings.text },
      ...changed.map((p) => ({ path: this.relative(p), data: this.texts.get(p)! })),
    ];
    return {
      name: plan.name,
      data: zipFiles(entries),
      type: "application/zip",
      files: entries.map((e) => e.path),
      added: settings.added,
    };
  }

  /** One file as edited, to download on its own; it is no longer unsaved. */
  async exportFile(path: string): Promise<EditExport> {
    const data = await this.source.read(path);
    this.unsaved.delete(path);
    return {
      name: short(path),
      data,
      type: "application/json",
      files: [this.relative(path)],
      added: 0,
    };
  }

  /** After an export: nothing is unsaved (the edits stay in effect). */
  saved(): void {
    this.unsaved.clear();
    this.editedMotions.clear();
  }
}

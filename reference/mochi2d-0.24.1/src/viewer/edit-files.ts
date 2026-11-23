/**
 * What the viewer's editing writes: motion entries in the model settings,
 * expression files (`.exp3.json`) and pose files (`.pose3.json`), as JSON
 * indented with tabs, and several files as one `.zip`. Plain functions on
 * plain JSON, so they work (and are tested) without a page.
 *
 * Edited files keep their other keys and the order of their keys; a key the
 * file did not have goes after the key it follows in the format's order.
 */
import { zipSync } from "fflate";
import type { Expression, ExpressionBlend } from "../anim/expression.js";
import type { PoseFile } from "../anim/pose.js";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Numbers as typed, without float noise from the subtraction (0.1 + 0.2 → 0.3). */
const tidy = (x: number) => (Number.isFinite(x) ? Number(x.toPrecision(12)) : x);

/**
 * `original`'s keys in their order with the new values of `fields` (a
 * `undefined` value removes the key); keys the original lacks go after the
 * nearest key before them in `fields`' order that is present, or before the
 * first one after them.
 */
export function withFields(original: Json | null, fields: [string, unknown][]): Json {
  const order = fields.map(([k]) => k);
  const value = new Map(fields);
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(original ?? {})) {
    if (!value.has(k)) out.push([k, v]);
    else if (value.get(k) !== undefined) out.push([k, value.get(k)]);
  }
  order.forEach((k, i) => {
    const v = value.get(k);
    if (v === undefined || out.some(([o]) => o === k)) return;
    const before = order
      .slice(0, i)
      .reverse()
      .find((b) => out.some(([o]) => o === b));
    if (before !== undefined) {
      out.splice(out.findIndex(([o]) => o === before) + 1, 0, [k, v]);
      return;
    }
    const after = order.slice(i + 1).find((a) => out.some(([o]) => o === a));
    if (after !== undefined)
      out.splice(
        out.findIndex(([o]) => o === after),
        0,
        [k, v],
      );
    else out.push([k, v]);
  });
  return Object.fromEntries(out);
}

const text = (json: unknown) => JSON.stringify(json, null, "\t");

// ------------------------------------------------------------------ motions

/** A motion entry in the model settings: its group and its index among the group's motions. */
export interface MotionPlace {
  group: string;
  index: number;
}

/** What a motion entry can change; null removes the setting. Times in seconds. */
export interface MotionEntryChanges {
  fadeIn?: number | null;
  fadeOut?: number | null;
  sound?: string | null;
  motionSync?: string | null;
}

const isEntry = (m: unknown): m is Json => isObject(m) && typeof m.File === "string";

/** The settings' `Motions` object, made when missing. */
function motionGroups(settings: Json): Record<string, unknown> {
  const refs = isObject(settings.FileReferences)
    ? settings.FileReferences
    : (settings.FileReferences = {});
  if (!isObject(refs.Motions)) refs.Motions = {};
  return refs.Motions as Record<string, unknown>;
}

/** The array index of the group's `index`-th motion (entries without a file don't count, as when reading). */
function entryAt(settings: Json, at: MotionPlace): { list: unknown[]; i: number } {
  const list = motionGroups(settings)[at.group];
  if (Array.isArray(list)) {
    let k = -1;
    for (let i = 0; i < list.length; i++)
      if (isEntry(list[i]) && ++k === at.index) return { list, i };
  }
  throw new RangeError(`no motion ${at.group}[${at.index}] in the settings`);
}

/** Changes a motion entry of the model settings JSON (in place). */
export function editMotionEntry(
  settings: Json,
  at: MotionPlace,
  changes: MotionEntryChanges,
): void {
  const { list, i } = entryAt(settings, at);
  const entry = list[i] as Json;
  // undefined: as it is; null: removed.
  const field = (key: string, v: unknown): [string, unknown] => [
    key,
    v === undefined ? entry[key] : v === null ? undefined : v,
  ];
  list[i] = withFields(entry, [
    ["File", entry.File],
    field("FadeInTime", changes.fadeIn),
    field("FadeOutTime", changes.fadeOut),
    field("Sound", changes.sound),
    field("MotionSync", changes.motionSync),
  ]);
}

/** The number of motions a group lists. */
function countIn(groups: Record<string, unknown>, group: string): number {
  const list = groups[group];
  return Array.isArray(list) ? list.filter(isEntry).length : 0;
}

/**
 * Moves a motion entry to the end of another group (made when new), with its
 * settings; a group left empty is removed. Returns the entry's new place.
 */
export function moveMotionEntry(settings: Json, at: MotionPlace, group: string): MotionPlace {
  if (group === at.group) return at;
  const { list, i } = entryAt(settings, at);
  const [entry] = list.splice(i, 1);
  const groups = motionGroups(settings);
  if (!list.some(isEntry)) delete groups[at.group];
  if (!Array.isArray(groups[group])) groups[group] = [];
  (groups[group] as unknown[]).push(entry);
  return { group, index: countIn(groups, group) - 1 };
}

/** Lists a motion file in a group (at its end). Returns its place. */
export function addMotionEntry(settings: Json, file: string, group: string): MotionPlace {
  const groups = motionGroups(settings);
  if (!Array.isArray(groups[group])) groups[group] = [];
  (groups[group] as unknown[]).push({ File: file });
  return { group, index: countIn(groups, group) - 1 };
}

/** Takes a motion entry out of the settings (the file stays); an empty group is removed. */
export function removeMotionEntry(settings: Json, at: MotionPlace): void {
  const { list, i } = entryAt(settings, at);
  list.splice(i, 1);
  if (!list.some(isEntry)) delete motionGroups(settings)[at.group];
}

// -------------------------------------------------------------- expressions

/**
 * A parameter of an expression as the editor shows it: for `Add`, the
 * parameter's value (its default plus the file's value); for `Multiply`, the
 * factor; for `Overwrite`, the value.
 */
export interface ExpressionRow {
  id: string;
  blend: ExpressionBlend;
  value: number;
}

export interface ExpressionDraft {
  /** Seconds, as the file has them; null: not set. */
  fadeIn: number | null;
  fadeOut: number | null;
  /** The parameters in the expression, in file order. */
  rows: ExpressionRow[];
}

const blendOf = (b: unknown): ExpressionBlend =>
  b === "Multiply" || b === "Overwrite" ? b : "Add";

/**
 * An expression file's JSON as the editor shows it. A parameter listed twice
 * keeps its first entry, the one that takes effect.
 */
export function expressionDraft(json: unknown, defaultOf: (id: string) => number): ExpressionDraft {
  const j = isObject(json) ? json : {};
  const rows: ExpressionRow[] = [];
  for (const p of Array.isArray(j.Parameters) ? j.Parameters : []) {
    if (!isObject(p)) continue;
    const id = typeof p.Id === "string" ? p.Id : "";
    if (rows.some((r) => r.id === id)) continue;
    const blend = blendOf(p.Blend);
    const v = typeof p.Value === "number" ? p.Value : 0;
    rows.push({ id, blend, value: blend === "Add" ? tidy(defaultOf(id) + v) : v });
  }
  const fade = (v: unknown) => (typeof v === "number" ? v : null);
  return { fadeIn: fade(j.FadeInTime), fadeOut: fade(j.FadeOutTime), rows };
}

/** The value a row stores in the file: for `Add`, the value less the parameter's default. */
export function storedValue(row: ExpressionRow, defaultOf: (id: string) => number): number {
  return row.blend === "Add" ? tidy(row.value - defaultOf(row.id)) : row.value;
}

/** The value a row starts with when switched to `blend`: a factor of 1, or the default. */
export function switchedValue(
  id: string,
  blend: ExpressionBlend,
  defaultOf: (id: string) => number,
) {
  return blend === "Multiply" ? 1 : defaultOf(id);
}

/**
 * An expression file's text: `Type`, `FadeInTime` and `FadeOutTime` when
 * set, and `Parameters` with `Id`, `Value` and `Blend`. With the file it
 * edits, its other keys stay, in their order, and so do a parameter entry's.
 */
export function writeExpressionFile(
  draft: ExpressionDraft,
  defaultOf: (id: string) => number,
  original: unknown = null,
): string {
  const o = isObject(original) ? original : null;
  const before = new Map<string, Json>();
  for (const p of Array.isArray(o?.Parameters) ? o.Parameters : [])
    if (isObject(p) && typeof p.Id === "string" && !before.has(p.Id)) before.set(p.Id, p);
  const parameters = draft.rows.map((r) =>
    withFields(before.get(r.id) ?? null, [
      ["Id", r.id],
      ["Value", storedValue(r, defaultOf)],
      ["Blend", r.blend],
    ]),
  );
  return text(
    withFields(o, [
      ["Type", o?.Type ?? "Live2D Expression"],
      ["FadeInTime", draft.fadeIn ?? undefined],
      ["FadeOutTime", draft.fadeOut ?? undefined],
      ["Parameters", parameters],
    ]),
  );
}

/** The expression a draft plays: unset fades take `defaultFade` seconds. */
export function draftExpression(
  draft: ExpressionDraft,
  defaultOf: (id: string) => number,
  label: string,
  defaultFade: number,
): Expression {
  return {
    label,
    fadeIn: draft.fadeIn ?? defaultFade,
    fadeOut: draft.fadeOut ?? defaultFade,
    parameters: draft.rows.map((r) => ({
      id: r.id,
      value: storedValue(r, defaultOf),
      blend: r.blend,
    })),
  };
}

// --------------------------------------------------------------------- pose

/** A part in the pose editor: its group number (null: none) and the part it follows (null: none). */
export interface PoseRow {
  id: string;
  group: number | null;
  parent: string | null;
}

export interface PoseDraft {
  /** Seconds, as the file has it; null: not set. */
  fade: number | null;
  /** Every part of the model, then the file's other IDs. */
  rows: PoseRow[];
}

/**
 * A pose file's JSON (or none, for a new pose) as the editor shows it: each
 * group gets its position's number, from 1, and each part a link names gets
 * that entry's part as its parent.
 */
export function poseDraft(json: unknown, partIds: readonly string[]): PoseDraft {
  const j = isObject(json) ? json : {};
  const rows = new Map<string, PoseRow>(
    partIds.map((id) => [id, { id, group: null, parent: null }]),
  );
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { id, group: null, parent: null }));
    return r;
  };
  (Array.isArray(j.Groups) ? j.Groups : []).forEach((g, k) => {
    for (const e of Array.isArray(g) ? g : []) {
      if (!isObject(e) || typeof e.Id !== "string") continue;
      const r = row(e.Id);
      r.group ??= k + 1;
      for (const l of Array.isArray(e.Link) ? e.Link : [])
        if (typeof l === "string" && l !== e.Id) row(l).parent ??= e.Id;
    }
  });
  const fade = typeof j.FadeInTime === "number" ? j.FadeInTime : null;
  return { fade, rows: [...rows.values()] };
}

/** The groups of a draft, by ascending number: entries with their links. */
function poseGroups(draft: PoseDraft): { id: string; links: string[] }[][] {
  const numbers = [...new Set(draft.rows.flatMap((r) => (r.group === null ? [] : [r.group])))];
  numbers.sort((a, b) => a - b);
  return numbers.map((n) =>
    draft.rows
      .filter((r) => r.group === n)
      .map((r) => ({
        id: r.id,
        links: draft.rows.filter((c) => c.parent === r.id && c.id !== r.id).map((c) => c.id),
      })),
  );
}

/**
 * A pose file's text: `Type`, `FadeInTime` when set, and `Groups` in
 * ascending group number, each entry with `Id` and `Link` (empty when no part
 * follows it). Parts without a group are left out. With the file it edits,
 * its other keys stay, in their order.
 */
export function writePoseFile(draft: PoseDraft, original: unknown = null): string {
  const o = isObject(original) ? original : null;
  return text(
    withFields(o, [
      ["Type", o?.Type ?? "Live2D Pose"],
      ["FadeInTime", draft.fade ?? undefined],
      ["Groups", poseGroups(draft).map((g) => g.map((e) => ({ Id: e.id, Link: e.links })))],
    ]),
  );
}

/** The pose a draft gives (as `parsePose` reads its file). */
export function draftPose(draft: PoseDraft, label: string): PoseFile {
  const f = draft.fade;
  return { label, fade: f === null || f < 0 ? 0.5 : f, groups: poseGroups(draft) };
}

/** What the editor warns about: links that the groups override, or that have no effect. */
export function poseWarnings(draft: PoseDraft): string[] {
  const out: string[] = [];
  const byId = new Map(draft.rows.map((r) => [r.id, r]));
  for (const r of draft.rows) {
    if (r.parent === null) continue;
    const parent = byId.get(r.parent);
    if (!parent || parent.group === null)
      out.push(`${r.id} follows ${r.parent}, which is in no group: the link has no effect.`);
    else if (r.group !== null)
      out.push(
        `${r.id} is in group ${r.group} and follows ${r.parent}: links apply after the groups, so the link wins.`,
      );
  }
  return out;
}

// ---------------------------------------------------------------------- zip

/** Files as one `.zip` (deflated; UTF-8 names), at the given paths. */
export function zipFiles(files: { path: string; data: Uint8Array | string }[]): Uint8Array {
  const enc = new TextEncoder();
  return zipSync(
    Object.fromEntries(
      files.map((f) => [f.path, typeof f.data === "string" ? enc.encode(f.data) : f.data]),
    ),
  );
}

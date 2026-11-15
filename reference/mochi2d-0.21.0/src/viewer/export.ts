/**
 * Exporting the model settings (File › Export model settings, Ctrl+S): the
 * loaded `.model3.json`, with the expressions of the model's folder that it
 * does not list added under their file names, as JSON indented with tabs.
 * Everything else is written as the file had it, unknown keys included.
 */
import { dirnameOf } from "../core/io/file-source.js";
import { classifyModelFile } from "../core/io/model-files.js";

export interface ExportedSettings {
  /** The settings file's name. */
  name: string;
  text: string;
  /** How many expression files were added to `Expressions`. */
  added: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The expression name a file gets: its file name without `.exp3.json`. */
export const expressionName = (file: string) =>
  file.slice(file.lastIndexOf("/") + 1).replace(/\.exp3\.json$/i, "");

export function exportModelSettings(o: {
  settingsPath: string;
  raw: Record<string, unknown>;
  /** The folder's files, by path in the source. */
  files: readonly string[];
}): ExportedSettings {
  const json = structuredClone(o.raw) as Record<string, unknown>;
  const refs = isObject(json.FileReferences) ? json.FileReferences : {};
  json.FileReferences = refs;
  const dir = dirnameOf(o.settingsPath);
  const prefix = dir ? `${dir}/` : "";
  const listed = Array.isArray(refs.Expressions) ? (refs.Expressions as unknown[]) : [];
  const known = new Set(
    listed.flatMap((e) => (isObject(e) && typeof e.File === "string" ? [e.File] : [])),
  );
  let added = 0;
  for (const p of o.files) {
    // Expressions in the model's folder (or below it) that the settings do not list.
    if (classifyModelFile(p) !== "expression" || !p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (known.has(rel)) continue;
    listed.push({ Name: expressionName(rel), File: rel });
    known.add(rel);
    added++;
  }
  if (listed.length || Array.isArray(refs.Expressions)) refs.Expressions = listed;
  return {
    name: o.settingsPath.slice(o.settingsPath.lastIndexOf("/") + 1),
    text: JSON.stringify(json, null, "\t"),
    added,
  };
}

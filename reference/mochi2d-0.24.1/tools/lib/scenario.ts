/** Scenario files (mochi2d-scenario/0) on disk; the format itself is in src/conformance/scenario.ts. */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { FORMAT_PREFIX, currentFormatName } from "../../src/core/format-names.js";
import {
  ID_RE,
  ScenarioError,
  parseJsonText,
  parseScenario,
  type Scenario,
} from "../../src/conformance/scenario.js";

export * from "../../src/conformance/scenario.js";

/** A scenario that could be loaded, or the error that prevented it. */
export type LoadedScenario =
  | { ok: true; file: string; scenario: Scenario }
  | { ok: false; file: string; id: string; error: string };

async function collectJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await collectJsonFiles(full)));
    else if (ent.isFile() && ent.name.toLowerCase().endsWith(".json")) out.push(full);
  }
  return out.sort();
}

/**
 * Loads scenarios from files and/or directories (searched recursively for
 * *.json). A file may hold one scenario object or an array of them. Files
 * that fail to load yield `{ ok: false }` entries instead of throwing.
 */
export async function loadScenarios(inputs: string[]): Promise<LoadedScenario[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const p = resolve(input);
    const st = await stat(p).catch(() => null);
    if (!st) {
      files.push(p); // reported as an error below
    } else if (st.isDirectory()) {
      files.push(...(await collectJsonFiles(p)));
    } else {
      files.push(p);
    }
  }
  const out: LoadedScenario[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const fallbackId =
      basename(file)
        .replace(/\.json$/i, "")
        .replace(/[^A-Za-z0-9._-]/g, "_") || "scenario";
    let json: unknown;
    try {
      json = parseJsonText(await readFile(file, "utf8"));
    } catch (e) {
      out.push({
        ok: false,
        file,
        id: fallbackId,
        error: `Cannot read scenario file: ${(e as Error).message}`,
      });
      continue;
    }
    // A catalog index (mochi2d-catalog/0) lists scenarios; it is not one.
    const fmt = currentFormatName((json as { format?: unknown } | null)?.format);
    if (typeof fmt === "string" && fmt.startsWith(`${FORMAT_PREFIX}catalog/`)) continue;
    const items = Array.isArray(json) ? json : [json];
    items.forEach((item, i) => {
      const guessId =
        typeof (item as { id?: unknown })?.id === "string" &&
        ID_RE.test((item as { id: string }).id)
          ? (item as { id: string }).id
          : items.length > 1
            ? `${fallbackId}.${i}`
            : fallbackId;
      try {
        const scenario = parseScenario(item);
        if (seen.has(scenario.id))
          throw new ScenarioError(`duplicate scenario id "${scenario.id}"`);
        seen.add(scenario.id);
        out.push({ ok: true, file, scenario });
      } catch (e) {
        out.push({ ok: false, file, id: guessId, error: (e as Error).message });
      }
    });
  }
  return out;
}

/**
 * The conformance run (4b–4e, 4i–4k): reads scenario files,
 * dispatches on `format` (static, sequence, animation), runs each under its
 * protocol and writes `<out>/<id>.result.json` in the matching result format.
 * Static and render scenarios share a format; a render block is ignored here.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { formatResultJson } from "../../src/core/model/snapshot.js";
import { FORMAT_PREFIX, currentFormatName } from "../../src/core/format-names.js";
import { modelPathCandidates, modelSearchDirs, resolveModelFile } from "./model-roots.js";
import { ID_RE, knownFormat, parseJsonText, type Scenario } from "./scenario.js";
import { ModelCache } from "./model-cache.js";
import {
  RESULT_FORMAT,
  emptyResult,
  invalidResult,
  runScenarioJson,
  runStatic,
  type ScenarioResult,
} from "../../src/conformance/run.js";

// The static runner lives in the library (src/conformance/run.ts).
export { RESULT_FORMAT, emptyResult, runStatic, type ScenarioResult };

/** Maps a scenario `model` path to an absolute settings-file path. */
export interface ModelResolver {
  /** The settings file, or `undefined` if no candidate exists. */
  resolve(rel: string): string | undefined;
  /** Candidate paths in search order (for error messages). */
  candidates(rel: string): string[];
}

/**
 * Contract v0.1 resolver: `modelsDir` (default `assets/models/`) first, then the
 * repository root.
 */
export function searchResolver(repoRoot: string, modelsDir?: string): ModelResolver {
  const dirs = modelSearchDirs(repoRoot, modelsDir);
  return {
    resolve: (rel) => resolveModelFile(dirs, rel),
    candidates: (rel) => modelPathCandidates(dirs, rel),
  };
}

/** Kept for callers of the first API: one static scenario with a fresh cache. */
export async function runScenario(
  sc: Scenario,
  resolveModel: ModelResolver,
  producer: string,
): Promise<ScenarioResult> {
  return runStatic(sc, new ModelCache(resolveModel, 1), producer);
}

/** One entry of a scenario file, parsed far enough to dispatch. */
export type ScenarioItem =
  | {
      file: string;
      id: string;
      kind: "static" | "sequence" | "animation";
      json: unknown;
      model: string;
    }
  | { file: string; id: string; kind: "invalid"; error: string; resultFormat: string };

async function collectJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await collectJsonFiles(full)));
    else if (ent.isFile() && ent.name.toLowerCase().endsWith(".json")) out.push(full);
  }
  return out.sort();
}

const KIND_OF = {
  "mochi2d-scenario/0": "static",
  "mochi2d-sequence/0": "sequence",
  "mochi2d-anim-scenario/0": "animation",
} as const;

/** Catalog index files (`mochi2d-catalog/0`) are not scenarios and are skipped. */
const isCatalogIndex = (json: unknown) => {
  if (typeof json !== "object" || json === null) return false;
  const format = currentFormatName((json as { format?: unknown }).format);
  return typeof format === "string" && format.startsWith(`${FORMAT_PREFIX}catalog/`);
};

/**
 * Reads scenario files and directories (searched recursively for *.json). A
 * file may hold one scenario or an array of them. Unreadable files and
 * unknown formats become `invalid` items (error kind InvalidScenario).
 */
export async function readScenarioItems(inputs: string[]): Promise<ScenarioItem[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const p = resolve(input);
    const st = await stat(p).catch(() => null);
    if (st?.isDirectory()) files.push(...(await collectJsonFiles(p)));
    else files.push(p);
  }
  const items: ScenarioItem[] = [];
  for (const file of files) {
    const fallback =
      basename(file)
        .replace(/\.json$/i, "")
        .replace(/[^A-Za-z0-9._-]/g, "_") || "scenario";
    let json: unknown;
    try {
      json = parseJsonText(await readFile(file, "utf8"));
    } catch (e) {
      items.push({
        file,
        id: fallback,
        kind: "invalid",
        error: `cannot read scenario file: ${(e as Error).message}`,
        resultFormat: RESULT_FORMAT,
      });
      continue;
    }
    if (isCatalogIndex(json)) continue;
    const list = Array.isArray(json) ? json : [json];
    list.forEach((item, i) => {
      const o = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      const id =
        typeof o.id === "string" && ID_RE.test(o.id)
          ? o.id
          : list.length > 1
            ? `${fallback}.${i}`
            : fallback;
      const format = knownFormat(o.format);
      if (!format) {
        items.push({
          file,
          id,
          kind: "invalid",
          error: `unknown format ${JSON.stringify(o.format)}`,
          resultFormat: RESULT_FORMAT,
        });
        return;
      }
      items.push({ file, id, kind: KIND_OF[format], json: item, model: String(o.model ?? "") });
    });
  }
  return items;
}

export interface RunSummary {
  total: number;
  failed: number;
  results: { id: string; file: string; kind: string; error: string | null }[];
}

/** Runs every scenario of `inputs` and writes one result file per scenario. */
export interface ConformanceOptions {
  /** Reject files whose keyform draw orders lie outside their group's range (C12 strict mode). */
  strictDrawOrders?: boolean;
}

export async function runConformance(
  inputs: string[],
  outDir: string,
  resolveModel: ModelResolver,
  producer: string,
  log: (line: string) => void = () => {},
  options: ConformanceOptions = {},
): Promise<RunSummary> {
  await mkdir(outDir, { recursive: true });
  const items = await readScenarioItems(inputs);
  // Scenarios on the same model run together, so the parsed model is reused.
  const order = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ma = a.item.kind === "invalid" ? "" : a.item.model;
      const mb = b.item.kind === "invalid" ? "" : b.item.model;
      return ma < mb ? -1 : ma > mb ? 1 : a.i - b.i;
    });
  const models = new ModelCache(
    resolveModel,
    3,
    undefined,
    options.strictDrawOrders ? { drawOrderRange: "reject" } : {},
  );
  const summary: RunSummary = { total: items.length, failed: 0, results: [] };
  const seen = new Set<string>();
  for (const { item } of order) {
    let result: { error: null | { kind: string; message: string } };
    let text: string;
    if (seen.has(item.id)) {
      const r = invalidResult(
        item.id,
        RESULT_FORMAT,
        producer,
        `duplicate scenario id "${item.id}"`,
      );
      result = r;
      text = formatResultJson(r);
    } else if (item.kind === "invalid") {
      const r = invalidResult(item.id, item.resultFormat, producer, item.error);
      result = r;
      text = formatResultJson(r);
    } else {
      const r = runScenarioJson(item.kind, item.json, item.id, models, producer);
      result = r;
      // Animation results mix float32 and double quantities: the float32
      // ones are already rounded, so every number prints as a double.
      text = item.kind === "animation" ? formatResultJson(r, "  ", "double") : formatResultJson(r);
    }
    seen.add(item.id);
    const outFile = resolve(outDir, `${item.id}.result.json`);
    await writeFile(outFile, text);
    const err = result.error ? `${result.error.kind}: ${result.error.message}` : null;
    if (err) summary.failed++;
    summary.results.push({ id: item.id, file: outFile, kind: item.kind, error: err });
    log(`${err ? "FAIL" : "ok  "} ${item.id}${err ? ` — ${err}` : ""}`);
  }
  return summary;
}

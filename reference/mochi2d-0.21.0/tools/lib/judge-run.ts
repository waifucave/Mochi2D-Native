/**
 * Judging a round (4m): pairs the reference and candidate result
 * files of two directories by scenario ID, judges every scenario with the
 * rules of 4l, and summarizes per group. With a catalog index (from
 * `npm run catalog`), the scenario list, kinds and groups come from the
 * catalog, and parameter ranges for the animation rules come from each
 * scenario's model file.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { decodePng } from "./png.js";
import { parseJsonText } from "./scenario.js";
import { currentFormatName } from "../../src/core/format-names.js";
import { ModelCache } from "./model-cache.js";
import type { ModelResolver } from "./conformance-runner.js";
import {
  judgeAnimation,
  judgeRender,
  judgeSequence,
  judgeStatic,
  judgeValidation,
  missingVerdict,
  summarize,
  type JudgeReport,
  type Kind,
  type ScenarioVerdict,
} from "./judge.js";

type Obj = Record<string, unknown>;

interface ResultFile {
  id: string;
  kind: Kind;
  file: string;
  json: Obj;
}

const KIND_OF_FORMAT: Record<string, Kind> = {
  "mochi2d-result/0": "static",
  "mochi2d-sequence-result/0": "sequence",
  "mochi2d-anim-result/0": "animation",
  "mochi2d-render/0": "render",
};

async function walk(dir: string, depth = 0): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    const isDir =
      ent.isDirectory() ||
      (ent.isSymbolicLink() && (await stat(full).catch(() => null))?.isDirectory());
    if (isDir) {
      if (depth < 8) out.push(...(await walk(full, depth + 1)));
    } else if (/\.(result|render)\.json$/i.test(ent.name)) out.push(full);
  }
  return out.sort();
}

/** Result files of a directory, keyed by `<kind>:<scenario id>`. */
export async function readResultDir(dir: string): Promise<Map<string, ResultFile>> {
  const out = new Map<string, ResultFile>();
  for (const file of await walk(resolve(dir))) {
    let json: Obj;
    try {
      json = parseJsonText(await readFile(file, "utf8")) as Obj;
    } catch {
      continue;
    }
    const kind = KIND_OF_FORMAT[String(currentFormatName(json.format))];
    if (!kind) continue;
    const id = String(kind === "sequence" ? json.sequence : json.scenario);
    out.set(`${kind}:${id}`, { id, kind, file, json });
  }
  return out;
}

async function readPng(
  status: ResultFile,
): Promise<{ width: number; height: number; data: Uint8Array } | null> {
  const png = status.json.png;
  if (typeof png !== "string") return null;
  const path = isAbsolute(png) ? png : join(dirname(status.file), png);
  try {
    return decodePng(new Uint8Array(await readFile(path)));
  } catch {
    return null;
  }
}

export interface CatalogEntryRef {
  id: string;
  kind: Kind;
  group: string;
  file: string;
  /** Validation cases: P8's verdicts (C27). */
  official?: "accept" | "reject";
  required?: "accept" | "reject";
}

export async function readCatalogIndex(dir: string): Promise<CatalogEntryRef[]> {
  const index = parseJsonText(await readFile(join(dir, "index.json"), "utf8")) as {
    scenarios: CatalogEntryRef[];
  };
  return index.scenarios.map((s) => ({ ...s, file: join(dir, s.file) }));
}

export async function judgeDirectories(
  referenceDir: string,
  candidateDir: string,
  opts: { catalog?: string; resolver?: ModelResolver; notes?: string[] } = {},
): Promise<JudgeReport> {
  const ref = await readResultDir(referenceDir);
  const cand = await readResultDir(candidateDir);
  const catalog = opts.catalog ? await readCatalogIndex(opts.catalog) : null;
  const list: {
    id: string;
    kind: Kind;
    group: string;
    file?: string;
    official?: string;
    required?: string;
  }[] = catalog
    ? catalog
    : [...new Set([...ref.keys(), ...cand.keys()])].sort().map((key) => {
        const r = (ref.get(key) ?? cand.get(key))!;
        return { id: r.id, kind: r.kind, group: r.kind };
      });
  const models = opts.resolver ? new ModelCache(opts.resolver, 2) : null;
  const rangesOf = async (scenarioFile?: string): Promise<(id: string) => number> => {
    if (!scenarioFile || !models) return () => 1;
    try {
      const sc = parseJsonText(await readFile(scenarioFile, "utf8")) as Obj;
      const { model } = models.load(String(sc.model));
      const map = new Map<string, number>();
      model.parameters.ids.forEach((pid, i) => {
        if (!map.has(pid)) map.set(pid, model.parameters.max[i]! - model.parameters.min[i]!);
      });
      return (pid) => map.get(pid) ?? 1;
    } catch {
      return () => 1;
    }
  };
  const verdicts: ScenarioVerdict[] = [];
  for (const s of list) {
    const key = `${s.kind}:${s.id}`;
    const a = ref.get(key);
    const b = cand.get(key);
    if (b && s.required !== undefined) {
      // A validation case: scored against P8's Required column (C27).
      verdicts.push(
        judgeValidation(
          s.id,
          s.group,
          b.json,
          { required: s.required, ...(s.official ? { official: s.official } : {}) },
          a?.json,
        ),
      );
      continue;
    }
    if (!a || !b) {
      verdicts.push(
        missingVerdict(
          s.id,
          s.kind,
          s.group,
          !a && !b ? "reference or candidate" : !a ? "reference" : "candidate",
        ),
      );
      continue;
    }
    switch (s.kind) {
      case "static":
        verdicts.push(judgeStatic(s.id, s.group, a.json, b.json));
        break;
      case "sequence":
        verdicts.push(judgeSequence(s.id, s.group, a.json, b.json));
        break;
      case "render":
        verdicts.push(
          judgeRender(
            s.id,
            s.group,
            { status: a.json, image: await readPng(a) },
            { status: b.json, image: await readPng(b) },
          ),
        );
        break;
      case "animation":
        verdicts.push(judgeAnimation(s.id, s.group, a.json, b.json, await rangesOf(s.file)));
        break;
    }
  }
  return summarize(resolve(referenceDir), resolve(candidateDir), verdicts);
}

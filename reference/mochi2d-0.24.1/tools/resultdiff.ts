/**
 * npm run resultdiff -- <a.result.json> <b.result.json> [options]
 * npm run resultdiff -- <dirA> <dirB> [options]      (pairs *.result.json by relative path)
 * npm run judge -- <referenceDir> <candidateDir> [--catalog <dir>] [--out <file>] [--all]
 *
 * The judge (`--judge`, alias `npm run judge`) applies the judge's rules
 * (4h, 4l and 4m) to every kind of result: static,
 * sequence, animation and render (status file and premultiplied PNG). It pairs
 * results by scenario ID, reports per scenario and per group, and lists
 * advisories. With `--catalog` (the folder written by `npm run catalog`) the
 * scenario list and groups come from the catalog index.
 *
 * Compares conformance result files (a = reference, b = candidate) and prints a
 * summary table; writes a JSON report (default ./resultdiff-report.json).
 * Exit code: 0 = within tolerance, 1 = differences / errors, 2 = usage or unreadable input.
 *
 * Uses only Node built-ins. Full documentation: docs/resultdiff.md
 */
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs, repoRoot } from "./lib/cli.js";
import { judgeDirectories } from "./lib/judge-run.js";
import { formatJudgeReport } from "./lib/judge.js";
import { searchResolver } from "./lib/conformance-runner.js";
import {
  CHECKS,
  DEFAULT_TOLERANCES,
  diffResults,
  fmt,
  formatReport,
  table,
  toJsonSafe,
  ResultFormatError,
  type CheckName,
  type DiffOptions,
  type DiffTolerances,
  type ResultDiffReport,
} from "./lib/result-diff.js";

const USAGE = `usage: npm run resultdiff -- <a.result.json | dirA> <b.result.json | dirB> [options]

options:
  --out <file>             JSON report path (default: resultdiff-report.json)
  --json                   print the JSON report to stdout instead of the table
  --quiet                  print only the final verdict line(s)
  --top <n>                number of worst drawables to list (default 10)
  --tol <x>                set every numeric tolerance except draw/render order
  --tol-vertex <x>         vertex distance          (default ${DEFAULT_TOLERANCES.vertex})
  --tol-opacity <x>        drawable opacity         (default ${DEFAULT_TOLERANCES.opacity})
  --tol-color <x>          color channels           (default ${DEFAULT_TOLERANCES.color})
  --tol-parameter <x>      parameter values         (default ${DEFAULT_TOLERANCES.parameter})
  --tol-part <x>           part opacities           (default ${DEFAULT_TOLERANCES.partOpacity})
  --tol-draw-order <x>     draw order               (default ${DEFAULT_TOLERANCES.drawOrder})
  --tol-render-order <x>   render order             (default ${DEFAULT_TOLERANCES.renderOrder})
  --tol-canvas <x>         numbers inside "canvas"  (default ${DEFAULT_TOLERANCES.canvas})
  --skip-invisible         skip vertex/opacity/color checks for drawables invisible in both
  --ignore <c1,c2,...>     report but do not fail these checks:
                           ${CHECKS.join(", ")}`;

const JUDGE_USAGE = `usage: npm run judge -- <referenceDir> <candidateDir> [options]

options:
  --catalog <dir>   catalog folder with index.json (scenario list, groups, model ranges)
  --out <file>      JSON report path (default: judge-report.json)
  --json            print the JSON report instead of the summary
  --all             list every advisory`;

class UsageError extends Error {}

async function judgeMain(args: { positional: string[]; options: Record<string, string | true> }) {
  if (args.positional.length !== 2)
    throw new UsageError(`expected two result directories\n\n${JUDGE_USAGE}`);
  const root = repoRoot();
  const catalog =
    typeof args.options.catalog === "string" ? resolve(args.options.catalog) : undefined;
  const report = await judgeDirectories(args.positional[0]!, args.positional[1]!, {
    ...(catalog ? { catalog } : {}),
    resolver: searchResolver(root),
  });
  const outFile = typeof args.options.out === "string" ? args.options.out : "judge-report.json";
  await writeFile(outFile, JSON.stringify(toJsonSafe(report), null, 2) + "\n");
  if (args.options.json === true) console.log(JSON.stringify(toJsonSafe(report), null, 2));
  else
    console.log(
      `${formatJudgeReport(report, { all: args.options.all === true })}\nreport: ${outFile}`,
    );
  return report.failed === 0 && report.scenarios.length > 0 ? 0 : 1;
}

function num(v: string | true | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === true || !Number.isFinite(n) || n < 0)
    throw new UsageError(`--${name} needs a non-negative number`);
  return n;
}

const TOLERANCE_FLAGS: [string, keyof DiffTolerances][] = [
  ["tol-vertex", "vertex"],
  ["tol-opacity", "opacity"],
  ["tol-color", "color"],
  ["tol-parameter", "parameter"],
  ["tol-part", "partOpacity"],
  ["tol-draw-order", "drawOrder"],
  ["tol-render-order", "renderOrder"],
  ["tol-canvas", "canvas"],
];

function buildOptions(o: Record<string, string | true>): DiffOptions {
  const all = num(o.tol, "tol");
  const t: Partial<DiffTolerances> = {};
  if (all !== undefined) {
    t.vertex = t.opacity = t.color = t.parameter = t.partOpacity = t.canvas = all;
  }
  for (const [flag, key] of TOLERANCE_FLAGS) {
    const v = num(o[flag], flag);
    if (v !== undefined) t[key] = v;
  }
  const ignore: CheckName[] = [];
  if (o.ignore !== undefined) {
    if (o.ignore === true) throw new UsageError("--ignore needs a list of checks");
    for (const name of o.ignore
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!(CHECKS as readonly string[]).includes(name)) {
        throw new UsageError(`Unknown check "${name}". Known: ${CHECKS.join(", ")}`);
      }
      ignore.push(name as CheckName);
    }
  }
  return { tolerances: t, skipInvisible: o["skip-invisible"] === true, ignore };
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new ResultFormatError(`${path}: cannot read (${(e as Error).message})`);
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new ResultFormatError(`${path}: invalid JSON (${(e as Error).message})`);
  }
}

async function listResults(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && ent.name.endsWith(".result.json")) out.push(relative(dir, full));
    }
  };
  await walk(dir);
  return out.sort();
}

interface SetEntry {
  file: string;
  pass: boolean;
  error?: string;
  failedChecks?: CheckName[];
  report?: ResultDiffReport;
}

async function main(): Promise<number> {
  const flags = ["json", "quiet", "skip-invisible", "help", "judge", "all"];
  const valued = [
    "out",
    "top",
    "tol",
    "ignore",
    "catalog",
    ...TOLERANCE_FLAGS.map(([flag]) => flag),
  ];
  let args;
  try {
    args = parseArgs(process.argv.slice(2), flags);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (args.options.judge === true) {
    if (args.options.help) {
      console.log(JUDGE_USAGE);
      return 0;
    }
    return judgeMain(args);
  }
  for (const name of Object.keys(args.options)) {
    if (!flags.includes(name) && !valued.includes(name))
      throw new UsageError(`Unknown option --${name}`);
  }
  if (args.options.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.positional.length !== 2) throw new UsageError("expected exactly two inputs");
  const opts = buildOptions(args.options);
  const top = num(args.options.top, "top") ?? 10;
  const outFile =
    typeof args.options.out === "string" ? args.options.out : "resultdiff-report.json";
  const json = args.options.json === true;
  const quiet = args.options.quiet === true;
  const [pa, pb] = args.positional.map((p) => resolve(p)) as [string, string];
  const [sa, sb] = await Promise.all([stat(pa).catch(() => null), stat(pb).catch(() => null)]);
  if (!sa) throw new ResultFormatError(`${pa}: not found`);
  if (!sb) throw new ResultFormatError(`${pb}: not found`);

  if (sa.isFile() && sb.isFile()) {
    const report = diffResults(await readJson(pa), await readJson(pb), opts, [
      args.positional[0]!,
      args.positional[1]!,
    ]);
    const safe = toJsonSafe(report);
    await writeFile(outFile, JSON.stringify(safe, null, 2) + "\n");
    if (json) console.log(JSON.stringify(safe, null, 2));
    else if (quiet) console.log(report.pass ? "PASS" : `FAIL (${report.failedChecks.join(", ")})`);
    else console.log(`${formatReport(report, top)}\nreport: ${outFile}`);
    return report.pass ? 0 : 1;
  }
  if (!(sa.isDirectory() && sb.isDirectory()))
    throw new UsageError("inputs must be two files or two directories");

  const [la, lb] = await Promise.all([listResults(pa), listResults(pb)]);
  const setB = new Set(lb);
  const setA = new Set(la);
  const onlyInA = la.filter((f) => !setB.has(f));
  const onlyInB = lb.filter((f) => !setA.has(f));
  const entries: SetEntry[] = [];
  for (const file of la.filter((f) => setB.has(f))) {
    try {
      const report = diffResults(
        await readJson(join(pa, file)),
        await readJson(join(pb, file)),
        opts,
        [join(args.positional[0]!, file), join(args.positional[1]!, file)],
      );
      entries.push({ file, pass: report.pass, failedChecks: report.failedChecks, report });
    } catch (e) {
      entries.push({ file, pass: false, error: (e as Error).message });
    }
  }
  const pass =
    onlyInA.length === 0 &&
    onlyInB.length === 0 &&
    entries.length > 0 &&
    entries.every((e) => e.pass);
  const setReport = {
    format: "mochi2d-resultdiff-set/0",
    a: args.positional[0],
    b: args.positional[1],
    pass,
    compared: entries.length,
    failed: entries.filter((e) => !e.pass).length,
    onlyInA,
    onlyInB,
    scenarios: entries,
  };
  const safe = toJsonSafe(setReport);
  await writeFile(outFile, JSON.stringify(safe, null, 2) + "\n");
  if (json) {
    console.log(JSON.stringify(safe, null, 2));
  } else {
    if (!quiet) {
      const rows: string[][] = [
        ["result file", "status", "max vertex err", "drawables failed", "failed checks / error"],
      ];
      for (const e of entries) {
        const r = e.report;
        rows.push([
          e.file,
          e.pass ? "ok" : "FAIL",
          r ? fmt(r.checks.vertices.max?.value) : "",
          r ? String(r.drawables.filter((d) => d.status !== "ok").length) : "",
          e.error ?? (e.failedChecks ?? []).join(","),
        ]);
      }
      console.log(table(rows, [false, false, true, true, false]));
      if (onlyInA.length) console.log(`only in a (${onlyInA.length}): ${onlyInA.join(", ")}`);
      if (onlyInB.length) console.log(`only in b (${onlyInB.length}): ${onlyInB.join(", ")}`);
    }
    console.log(
      `${pass ? "RESULT: PASS" : "RESULT: FAIL"} — ${entries.length - setReport.failed}/${entries.length} within tolerance` +
        (onlyInA.length || onlyInB.length ? `, ${onlyInA.length + onlyInB.length} unpaired` : "") +
        `\nreport: ${outFile}`,
    );
  }
  return pass ? 0 : 1;
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    if (e instanceof UsageError) console.error(`${e.message}\n\n${USAGE}`);
    else console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  },
);

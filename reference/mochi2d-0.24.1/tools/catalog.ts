/**
 * npm run catalog -- [--crafts <dir>] [--out <dir>]
 *
 * Generates the full test catalog (4o–4w) from
 * DeepSeek-chan's files in `assets/models/DeepSeek/`: the crafted model files (moc crafts
 * P1–P8, texbig, the animation crafts with their WAV files) under the
 * gitignored `assets/models/crafts/`, and the 827 scenario files with an
 * index under `out/catalog/`. The dsrand scenarios are checked against the
 * published check values first.
 */
import { join, resolve } from "node:path";
import { loadMoc } from "../src/core/moc/model.js";
import { parseArgs, repoRoot } from "./lib/cli.js";
import { deepseekMocBytes } from "./lib/catalog/moc-crafts.js";
import { checkDsrand } from "./lib/catalog/checks.js";
import { defaultPaths, writeCatalog } from "./lib/catalog/write.js";

const USAGE = "usage: npm run catalog -- [--crafts <dir>] [--out <dir>]";

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), ["help"]);
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.options.help) {
    console.log(USAGE);
    return 0;
  }
  const root = repoRoot();
  const paths = defaultPaths(root);
  if (typeof args.options.crafts === "string") paths.crafts = resolve(args.options.crafts);
  if (typeof args.options.out === "string") paths.scenarios = resolve(args.options.out);
  if (!paths.crafts.startsWith(join(root, "assets", "models")))
    console.warn(
      `note: crafted files go to ${paths.crafts}; scenarios find them only under assets/models/crafts/`,
    );

  const problems = checkDsrand(loadMoc(deepseekMocBytes()));
  if (problems.length) {
    console.error("dsrand check values do not match:\n  " + problems.join("\n  "));
    return 1;
  }
  console.log("dsrand: all check values of 4q match");
  const t0 = Date.now();
  const report = await writeCatalog(paths, (l) => console.log(l));
  const byKind = new Map<string, number>();
  for (const e of report.scenarios) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  console.log(
    `\n${report.crafts.length} craft folders → ${paths.crafts}\n` +
      `${report.scenarios.length} scenarios (${[...byKind].map(([k, n]) => `${k} ${n}`).join(", ")}) → ${paths.scenarios}\n` +
      `${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  return 0;
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  },
);

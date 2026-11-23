/**
 * npm run conformance -- <scenario.json | directory>... --out <dir> [--models <dir>]
 *                        [--strict-draw-orders]
 *
 * Runs static, sequence and animation scenarios in Node (no GPU) and writes
 * <out>/<id>.result.json (docs/conformance.md). `--strict-draw-orders`
 * rejects files whose keyform draw orders lie outside their group's range,
 * which load with a warning by default. Exits 1 if any scenario failed, 2 on
 * usage errors.
 */
import { parseArgs, repoRoot } from "./lib/cli.js";
import { producerId } from "./lib/producer.js";
import { runConformance, searchResolver } from "./lib/conformance-runner.js";

const USAGE =
  "usage: npm run conformance -- <scenario.json | directory>... --out <dir> [--models <dir>] [--strict-draw-orders]";

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), ["help", "strict-draw-orders"]);
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.options.help) {
    console.log(USAGE);
    return 0;
  }
  const out = args.options.out;
  if (typeof out !== "string" || args.positional.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const root = repoRoot();
  const models = searchResolver(
    root,
    typeof args.options.models === "string" ? args.options.models : undefined,
  );
  const summary = await runConformance(
    args.positional,
    out,
    models,
    producerId(root),
    (l) => console.log(l),
    { strictDrawOrders: args.options["strict-draw-orders"] === true },
  );
  console.log(
    `\n${summary.total - summary.failed}/${summary.total} scenario(s) succeeded → ${out}`,
  );
  if (summary.total === 0) {
    console.error("No scenarios found.");
    return 1;
  }
  return summary.failed > 0 ? 1 : 0;
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  },
);

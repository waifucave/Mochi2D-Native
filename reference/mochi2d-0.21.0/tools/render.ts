/**
 * npm run render -- <scenario.json | directory>... --out <dir> [--alpha straight|premultiplied]
 *                   [--mask-size N]
 *
 * Renders each scenario in headless Chromium (pre-installed Playwright) in
 * the reference configuration (4f) and writes <out>/<id>.png on
 * success plus the status file <out>/<id>.render.json always (4g). A failed
 * scenario writes no PNG. Conformance PNGs are premultiplied (the default);
 * `--alpha straight` writes PNGs for viewing, never for conformance. Exits 1
 * if any scenario failed, 2 on usage errors. Requires `npm run build`.
 */
import { parseArgs, repoRoot } from "./lib/cli.js";
import { producerId } from "./lib/producer.js";
import { runRender } from "./lib/render-runner.js";
import { isAlphaMode } from "../src/core/image/alpha.js";

const USAGE =
  "usage: npm run render -- <scenario.json | directory>... --out <dir> [--alpha straight|premultiplied] [--mask-size N]";

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
  const out = args.options.out;
  if (typeof out !== "string" || args.positional.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const alpha = args.options.alpha ?? "premultiplied";
  if (!isAlphaMode(alpha)) {
    console.error(`--alpha must be "straight" or "premultiplied"\n${USAGE}`);
    return 2;
  }
  const maskSize = args.options["mask-size"];
  if (maskSize !== undefined && !(typeof maskSize === "string" && /^[1-9][0-9]*$/.test(maskSize))) {
    console.error(`--mask-size must be a positive integer\n${USAGE}`);
    return 2;
  }
  const root = repoRoot();
  const { total, failed } = await runRender(
    args.positional,
    out,
    root,
    producerId(root),
    (l) => console.log(l),
    { alpha, ...(maskSize ? { maskSize: Number(maskSize) } : {}) },
  );
  console.log(`\n${total - failed}/${total} scenario(s) rendered → ${out}`);
  if (total === 0) {
    console.error("No scenarios found.");
    return 1;
  }
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  },
);

/**
 * npm run imgdiff -- <expected.png> <actual.png> [--diff <out.png>] [--threshold N] [--no-alpha] [--json]
 *
 * Prints error statistics (max / mean / RMSE / PSNR / differing pixels).
 * Exits 1 if any pixel differs by more than the threshold (default 0).
 */
import { parseArgs } from "./lib/cli.js";
import { readPng, writePng } from "./lib/png.js";
import { diffImages } from "./lib/image-diff.js";

const USAGE =
  "usage: npm run imgdiff -- <expected.png> <actual.png> [--diff out.png] [--threshold N] [--no-alpha] [--json]";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["no-alpha", "json", "help"]);
  if (args.options.help || args.positional.length !== 2) {
    console.error(USAGE);
    return args.options.help ? 0 : 2;
  }
  const [a, b] = args.positional as [string, string];
  const threshold = Number(args.options.threshold ?? 0);
  if (!Number.isFinite(threshold) || threshold < 0) {
    console.error("--threshold must be a non-negative number");
    return 2;
  }
  const { stats, diffImage } = diffImages(await readPng(a), await readPng(b), {
    threshold,
    includeAlpha: !args.options["no-alpha"],
  });
  if (typeof args.options.diff === "string") await writePng(args.options.diff, diffImage);
  if (args.options.json) {
    console.log(
      JSON.stringify({ ...stats, psnr: Number.isFinite(stats.psnr) ? stats.psnr : null }, null, 2),
    );
  } else {
    console.log(
      `size ${stats.width}x${stats.height}  max ${stats.maxError}  mean ${stats.meanAbsError.toFixed(4)}  ` +
        `rmse ${stats.rmse.toFixed(4)}  psnr ${Number.isFinite(stats.psnr) ? stats.psnr.toFixed(2) + " dB" : "inf"}  ` +
        `differing ${stats.differingPixels} (${(stats.differingFraction * 100).toFixed(3)}%)`,
    );
  }
  return stats.differingPixels > 0 ? 1 : 0;
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  },
);

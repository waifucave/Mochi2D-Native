/**
 * npm run golden -- [--check] [--out-dir <dir>]
 * npm run golden -- --renders [--check]
 *
 * Evaluates the DeepSeek-chan scenarios plus seeded random poses, each on a
 * fresh model instance, and writes the SHA-256 of every formatted result to
 * test/golden/deepseek-results.json (or, with --check, compares against it).
 * Full results go to out/golden/ for diffing with resultdiff.
 *
 * With --renders: renders the dsr-* scenarios in headless Chromium as
 * `npm run render` does, in both alpha conventions, and writes (or checks)
 * the SHA-256 of each PNG in test/golden/deepseek-render-hashes.json.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, repoRoot } from "./lib/cli.js";
import { deepseekDir } from "./lib/model-roots.js";
import { loadMoc } from "../src/core/moc/model.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import {
  applyRequest,
  formatResultJson,
  snapshotInstance,
  type EvaluationRequest,
} from "../src/core/model/snapshot.js";
import { randomPoses } from "../src/core/testing/poses.js";
import { openRenderSession } from "./lib/render-runner.js";
import {
  RENDER_HASH_FILE,
  computeRenderHashes,
  renderHashScenarios,
  type RenderHashes,
} from "./lib/render-hashes.js";

export const GOLDEN_SEED = 20261102;
export const GOLDEN_RANDOM_POSES = 50;

async function renders(root: string, check: boolean): Promise<number> {
  const scenarios = await renderHashScenarios(root);
  const session = await openRenderSession(root);
  let got: RenderHashes;
  try {
    got = await computeRenderHashes(session, scenarios);
  } finally {
    await session.close();
  }
  const file = join(root, RENDER_HASH_FILE);
  if (check) {
    const want = JSON.parse(await readFile(file, "utf8")) as RenderHashes;
    if (want.renderer !== got.renderer)
      console.log(`note: captured on "${want.renderer}", running on "${got.renderer}"`);
    const bad: string[] = [];
    for (const [id, h] of Object.entries(want.hashes))
      for (const [alpha, hash] of Object.entries(h))
        if (got.hashes[id]?.[alpha as keyof typeof h] !== hash) bad.push(`${id} (${alpha})`);
    console.log(
      bad.length
        ? `MISMATCH: ${bad.join(", ")}`
        : `all ${Object.keys(want.hashes).length * 2} render PNGs identical`,
    );
    return bad.length ? 1 : 0;
  }
  await writeFile(file, JSON.stringify(got, null, 2) + "\n");
  console.log(`wrote ${scenarios.length * 2} PNG hashes to ${file}`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["check", "renders"]);
  const root = repoRoot();
  if (args.options.renders) return renders(root, args.options.check === true);
  const model = loadMoc(await readFile(join(deepseekDir(root), "大肥鱼.moc3")));
  const cases: { id: string; request: EvaluationRequest }[] = [];
  const scenarioDir = join(root, "test", "scenarios", "deepseek");
  for (const f of (await readdir(scenarioDir)).sort()) {
    const s = JSON.parse(await readFile(join(scenarioDir, f), "utf8")) as {
      id: string;
      parameters?: Record<string, number>;
      partOpacities?: Record<string, number>;
    };
    cases.push({
      id: s.id,
      request: { parameters: s.parameters ?? {}, partOpacities: s.partOpacities ?? {} },
    });
  }
  randomPoses(model, GOLDEN_RANDOM_POSES, GOLDEN_SEED).forEach((request, i) =>
    cases.push({ id: `random-${String(i).padStart(2, "0")}`, request }),
  );
  const outDir =
    typeof args.options["out-dir"] === "string"
      ? args.options["out-dir"]
      : join(root, "out", "golden");
  await mkdir(outDir, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const c of cases) {
    const inst = new ModelInstance(model);
    const warnings = applyRequest(inst, c.request);
    inst.evaluate();
    const text = formatResultJson({ ...snapshotInstance(inst), warnings });
    hashes[c.id] = createHash("sha256").update(text).digest("hex");
    await writeFile(join(outDir, `${c.id}.result.json`), text);
  }
  const goldenFile = join(root, "test", "golden", "deepseek-results.json");
  if (args.options.check) {
    const expected = JSON.parse(await readFile(goldenFile, "utf8")) as {
      hashes: Record<string, string>;
    };
    const bad = Object.keys(expected.hashes).filter((id) => expected.hashes[id] !== hashes[id]);
    console.log(
      bad.length ? `MISMATCH: ${bad.join(", ")}` : `all ${cases.length} results identical`,
    );
    return bad.length ? 1 : 0;
  }
  await writeFile(
    goldenFile,
    JSON.stringify(
      {
        model: "DeepSeek/大肥鱼.moc3",
        seed: GOLDEN_SEED,
        randomPoses: GOLDEN_RANDOM_POSES,
        hashes,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${cases.length} hashes to ${goldenFile}; full results in ${outDir}`);
  return 0;
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  },
);

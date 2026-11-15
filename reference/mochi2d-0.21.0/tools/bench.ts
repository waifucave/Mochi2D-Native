/**
 * npm run bench -- [--poses N] [--warmup N] [--mode random-all|random-mixed|typical|all]
 *                  [--kernels auto|wasm|wasm-scalar|js|both|all] [--stages] [--chromium] [--json file]
 * npm run bench -- --render [--render-modes static,animated,random] [--configs a,b,…]
 *                  [--frames N] [--width W] [--height H] [--json file]
 *
 * Times ModelInstance.evaluate() on DeepSeek-chan over seeded random poses,
 * in Node and (with --chromium) in headless Chromium through the harness page.
 *
 * With --render: times the interactive render path of DeepSeek-chan in headless
 * Chromium (evaluate, update, draw, GPU sync) for each mode and renderer
 * configuration, and counts the WebGL calls of a frame. Configurations:
 * "reference" (per-drawable masks, S = 4096), "mask-2048" (per-drawable,
 * S = 2048), "atlas" and "atlas-x4" (the viewer's mask atlas at 2 and 4 texels
 * per image pixel).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, repoRoot } from "./lib/cli.js";
import { deepseekDir } from "./lib/model-roots.js";
import { loadMoc } from "../src/core/moc/model.js";
import {
  benchmarkEvaluation,
  type BenchMode,
  type BenchResult,
} from "../src/core/testing/bench.js";
import { openRenderSession } from "./lib/render-runner.js";
import type { KernelChoice } from "../src/core/eval/kernels.js";
import type { RenderBenchMode, RenderBenchResult, Summary } from "../src/harness/render-bench.js";

const MODES: BenchMode[] = ["random-all", "random-mixed", "typical"];

/** Renderer configurations of the render benchmark. */
const RENDER_CONFIGS: Record<string, Record<string, unknown>> = {
  reference: { maskSize: 4096 },
  "mask-2048": { maskSize: 2048 },
  atlas: { masks: "atlas", maskSize: 2048 },
  "atlas-x4": { masks: "atlas", maskSize: 2048, maskOversample: 4 },
};

function renderRow(config: string, r: RenderBenchResult): string {
  const m = (s: Summary) => s.mean.toFixed(2).padStart(7);
  const n = (k: string) => Math.round(r.stats[k] ?? 0);
  const g = (k: string) => Math.round(r.glSummary[k] ?? 0);
  return [
    `${r.mode.padEnd(8)} ${config.padEnd(10)} frame ${m(r.ms.frame)} ms (p95 ${r.ms.frame.p95.toFixed(1)})`,
    `  cpu: evaluate ${m(r.ms.evaluate)}  update ${m(r.ms.update)}  draw ${m(r.ms.draw)}   gpu wait ${m(r.ms.sync)}`,
    `  per frame: ${n("drawn")} drawn, ${n("masked")} masked, ${n("maskBuilds")} mask builds, ` +
      `${n("framebufferBinds")} framebuffer binds, ${(r.stats["uploadBytes"] ?? 0) / 1024 >= 1 ? Math.round((r.stats["uploadBytes"] ?? 0) / 1024) : 0} KiB uploaded; ` +
      `GL calls: ${g("draws")} draws, ${g("state")} state, ${g("uniforms")} uniforms, ` +
      `${g("uploads")} uploads, ${g("clears")} clears, ${g("other")} other`,
  ].join("\n");
}

async function renderBench(root: string, args: ReturnType<typeof parseArgs>): Promise<number> {
  const list = (k: string, d: string) =>
    (typeof args.options[k] === "string" ? (args.options[k] as string) : d).split(",");
  const modes = list("render-modes", "static,animated,random") as RenderBenchMode[];
  const configs = list("configs", Object.keys(RENDER_CONFIGS).join(","));
  const num = (k: string, d: number) => Number(args.options[k] ?? d);
  const session = await openRenderSession(root);
  const results: { config: string; result: RenderBenchResult }[] = [];
  try {
    const info = await session.call<{ renderer: string }>("info");
    console.log(`renderer: ${info.renderer}`);
    for (const mode of modes) {
      for (const config of configs) {
        const opts = RENDER_CONFIGS[config];
        if (!opts) throw new Error(`unknown --configs entry "${config}"`);
        const r = await session.call<RenderBenchResult>("renderBenchmark", {
          model: "DeepSeek/大肥鱼.model3.json",
          mode,
          frames: num("frames", 60),
          warmup: num("warmup", 10),
          width: num("width", 1280),
          height: num("height", 720),
          renderer: opts,
        });
        results.push({ config, result: r });
        console.log(renderRow(config, r));
      }
    }
  } finally {
    await session.close();
  }
  if (typeof args.options.json === "string")
    await writeFile(args.options.json, JSON.stringify(results, null, 2) + "\n");
  return 0;
}

function stageLine(stages: Record<string, number>): string {
  return (
    "                " +
    Object.entries(stages)
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join(" · ")
  );
}

function row(where: string, r: BenchResult): string {
  const f = (x: number) => x.toFixed(2).padStart(7);
  return `${where.padEnd(9)} ${r.backend.padEnd(11)} ${r.mode.padEnd(13)} mean ${f(r.meanMs)}  median ${f(r.medianMs)}  p95 ${f(r.p95Ms)}  min ${f(r.minMs)}  max ${f(r.maxMs)} ms`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["stages", "chromium", "render"]);
  const root = repoRoot();
  if (args.options.render) return renderBench(root, args);
  const poses = Number(args.options.poses ?? 300);
  const warmup = Number(args.options.warmup ?? 50);
  const modeArg = typeof args.options.mode === "string" ? args.options.mode : "all";
  const modes = modeArg === "all" ? MODES : [modeArg as BenchMode];
  const stages = args.options.stages === true;
  const kernelArg = typeof args.options.kernels === "string" ? args.options.kernels : "auto";
  const kernelList: KernelChoice[] =
    kernelArg === "both"
      ? ["wasm", "js"]
      : kernelArg === "all"
        ? ["wasm", "wasm-scalar", "js"]
        : (kernelArg.split(",") as KernelChoice[]);
  const model = loadMoc(await readFile(join(deepseekDir(root), "大肥鱼.moc3")));
  const results: { where: string; result: BenchResult }[] = [];
  for (const kernels of kernelList) {
    for (const mode of modes) {
      const r = benchmarkEvaluation(model, mode, () => performance.now(), {
        poses,
        warmup,
        stages,
        kernels,
      });
      results.push({ where: "node", result: r });
      console.log(row("node", r));
      if (r.stages) console.log(stageLine(r.stages));
    }
  }
  if (args.options.chromium) {
    const session = await openRenderSession(root);
    try {
      for (const kernels of kernelList) {
        for (const mode of modes) {
          const r = await session.call<BenchResult>("benchmark", {
            model: "DeepSeek/大肥鱼.model3.json",
            mode,
            poses,
            warmup,
            stages,
            kernels,
          });
          results.push({ where: "chromium", result: r });
          console.log(row("chromium", r));
          if (r.stages) console.log(stageLine(r.stages));
        }
      }
    } finally {
      await session.close();
    }
  }
  if (typeof args.options.json === "string")
    await writeFile(args.options.json, JSON.stringify(results, null, 2) + "\n");
  return 0;
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  },
);

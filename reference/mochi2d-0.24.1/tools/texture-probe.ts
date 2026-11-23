/**
 * npm run texture-probe -- <image file | directory>... [options]
 *
 * Loads images through the texture pipeline (decode workers, size planning,
 * upload) in headless Chromium and reports WebGL limits, per-texture timings,
 * nominal GPU bytes and the browser processes' resident memory.
 * Each configuration runs in a fresh browser so memory readings don't mix.
 *
 * options:
 *   --budget-mib <n>     texture budget for the set (MiB)
 *   --max-size <n>       size limit below the GPU maximum
 *   --mipmaps            generate mipmaps
 *   --alpha <mode>       straight | premultiplied (default premultiplied)
 *   --main-thread        decode on the main thread instead of workers
 *   --workers <n>        decode workers (default 2)
 *   --strip-rows <n>     rows per strip for textures above 4096² (default 512, 0 = one upload)
 *   --matrix             run a standard set of configurations instead of one
 *   --out <file>         JSON report (default out/texture-probe.json)
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs, repoRoot } from "./lib/cli.js";
import { openRenderSession } from "./lib/render-runner.js";
import { MemorySampler, descendantMemory, memoryByType } from "./lib/proc-memory.js";
import { formatBytes } from "../src/render/gl/gpu-memory.js";
import { isAlphaMode } from "../src/core/image/alpha.js";
import type { TextureProbeRequest, TextureProbeResult } from "../src/harness/texture-probe.js";

const USAGE =
  "usage: npm run texture-probe -- <image | dir>... [--budget-mib N] [--max-size N] [--mipmaps] [--alpha straight|premultiplied] [--main-thread] [--workers N] [--strip-rows N] [--matrix] [--out file]";

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

async function collectImages(inputs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const input of inputs) {
    const p = resolve(input);
    const st = await stat(p);
    if (st.isDirectory()) {
      for (const name of (await readdir(p)).sort())
        if (IMAGE_RE.test(name)) out.push(join(p, name));
    } else out.push(p);
  }
  return out;
}

/** URL path under /models/ for a file (resolution order: assets/models, then repo root). */
function modelsUrl(root: string, file: string): string {
  const models = join(root, "assets", "models");
  const base = file.startsWith(models + sep) ? models : root;
  const rel = relative(base, file);
  if (rel.startsWith("..") || rel.split(sep).some((s) => s.startsWith("."))) {
    throw new Error(`${file} is not inside the repository (or is hidden)`);
  }
  return "/models/" + rel.split(sep).map(encodeURIComponent).join("/");
}

interface ConfigResult {
  name: string;
  request: Omit<TextureProbeRequest, "urls">;
  probe: TextureProbeResult;
  wallMs: number;
  memory: {
    baselineBytes: number;
    peakBytes: number;
    residentBytes: number;
    afterReleaseBytes: number;
    peakByType: Record<string, number>;
    residentByType: Record<string, number>;
  };
}

async function runConfig(
  root: string,
  name: string,
  urls: string[],
  request: Omit<TextureProbeRequest, "urls">,
): Promise<ConfigResult> {
  const session = await openRenderSession(root);
  try {
    await new Promise((r) => setTimeout(r, 300));
    const baseline = memoryByType(descendantMemory());
    const sampler = new MemorySampler().start(25);
    const t0 = performance.now();
    const probe = await session.call<TextureProbeResult>("probeTextures", {
      ...request,
      urls,
      keep: true,
    });
    const wallMs = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 300));
    sampler.stop();
    const resident = memoryByType(descendantMemory());
    await session.call("probeTextures", { urls: [] }); // releases the kept textures
    await new Promise((r) => setTimeout(r, 500));
    const after = memoryByType(descendantMemory());
    const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
    return {
      name,
      request,
      probe,
      wallMs: Math.round(wallMs),
      memory: {
        baselineBytes: sum(baseline),
        peakBytes: sampler.peakTotal,
        residentBytes: sum(resident),
        afterReleaseBytes: sum(after),
        peakByType: sampler.peakByType,
        residentByType: resident,
      },
    };
  } finally {
    await session.close();
  }
}

function printConfig(r: ConfigResult): void {
  const p = r.probe;
  console.log(`\n== ${r.name}`);
  console.log(
    `decoder: ${p.decoder.usesWorkers ? "workers" : `main thread${p.decoder.fallbackReason ? ` (${p.decoder.fallbackReason})` : ""}`}` +
      `   wall ${r.wallMs} ms   longest main-thread stall ${p.maxMainThreadStallMs} ms   GPU (nominal) ${formatBytes(p.gpuBytes)}` +
      `${p.error ? `   ERROR: ${p.error}` : ""}${p.glError ? `   GL error ${p.glError}` : ""}${p.contextLost ? "   CONTEXT LOST" : ""}`,
  );
  for (const t of p.textures) {
    const name = decodeURIComponent(t.url.split("/").pop() ?? t.url);
    console.log(
      `  ${name.padEnd(16)} ${`${t.original[0]}x${t.original[1]}`.padStart(9)} → ${`${t.uploaded[0]}x${t.uploaded[1]}`.padEnd(9)}` +
        ` file ${formatBytes(t.fileBytes).padStart(9)}  gpu ${formatBytes(t.gpuBytes).padStart(9)}` +
        `  decode ${String(t.decodeMs).padStart(5)} ms (${t.decodedOn})  upload ${String(t.uploadMs).padStart(4)} ms  coverage ${(t.coverage * 100).toFixed(0)}%`,
    );
  }
  const m = r.memory;
  console.log(
    `  browser RSS: baseline ${formatBytes(m.baselineBytes)}, peak ${formatBytes(m.peakBytes)}, ` +
      `with textures ${formatBytes(m.residentBytes)}, after release ${formatBytes(m.afterReleaseBytes)}`,
  );
  console.log(
    `  peak by process: ${Object.entries(m.peakByType)
      .map(([k, v]) => `${k} ${formatBytes(v)}`)
      .join(", ")}`,
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["mipmaps", "main-thread", "matrix", "help"]);
  if (args.options.help || args.positional.length === 0) {
    console.log(USAGE);
    return args.options.help ? 0 : 2;
  }
  const root = repoRoot();
  const files = await collectImages(args.positional);
  if (files.length === 0) {
    console.error("No image files found.");
    return 2;
  }
  const urls = files.map((f) => modelsUrl(root, f));
  const alpha = args.options.alpha ?? "premultiplied";
  if (!isAlphaMode(alpha)) {
    console.error(`--alpha must be "straight" or "premultiplied"`);
    return 2;
  }
  const num = (k: string) =>
    typeof args.options[k] === "string" ? Number(args.options[k]) : undefined;
  const base: Omit<TextureProbeRequest, "urls"> = {
    alpha,
    ...(num("budget-mib") !== undefined ? { budgetBytes: num("budget-mib")! * 1024 * 1024 } : {}),
    ...(num("max-size") !== undefined ? { maxSize: num("max-size")! } : {}),
    ...(num("workers") !== undefined ? { workers: num("workers")! } : {}),
    ...(num("strip-rows") !== undefined ? { uploadStripRows: num("strip-rows")! } : {}),
    ...(args.options.mipmaps ? { mipmaps: true } : {}),
    ...(args.options["main-thread"] ? { useWorkers: false } : {}),
  };
  const configs: [string, Omit<TextureProbeRequest, "urls">][] = args.options.matrix
    ? [
        ["workers, full size (strip uploads)", { alpha }],
        ["main-thread decode, full size", { alpha, useWorkers: false }],
        ["workers, full size, mipmaps", { alpha, mipmaps: true }],
        ["workers, budget 256 MiB", { alpha, budgetBytes: 256 * 1024 * 1024 }],
        ["workers, max size 4096", { alpha, maxSize: 4096 }],
        ["workers, full size, single-call uploads", { alpha, uploadStripRows: 0 }],
      ]
    : [["configuration", base]];

  const info = await (async () => {
    const s = await openRenderSession(root);
    try {
      return await s.call<Record<string, unknown>>("info");
    } finally {
      await s.close();
    }
  })();
  console.log(
    `WebGL: ${String(info.renderer)}\nMAX_TEXTURE_SIZE ${String(info.maxTextureSize)}, MAX_RENDERBUFFER_SIZE ${String(info.maxRenderbufferSize)}`,
  );
  console.log(`files: ${files.map((f) => relative(root, f)).join(", ")}`);

  const results: ConfigResult[] = [];
  for (const [name, req] of configs) {
    const r = await runConfig(root, name, urls, req);
    printConfig(r);
    results.push(r);
  }
  const out =
    typeof args.options.out === "string"
      ? args.options.out
      : join(root, "out", "texture-probe.json");
  await mkdir(dirname(out), { recursive: true });
  const { extensions: _ext, ...infoShort } = info;
  await writeFile(
    out,
    JSON.stringify(
      { format: "mochi2d-texture-probe/0", info: infoShort, files: urls, results },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nreport: ${out}`);
  return results.some((r) => r.probe.error || r.probe.glError || r.probe.contextLost) ? 1 : 0;
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  },
);

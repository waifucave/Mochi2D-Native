#!/usr/bin/env node
// npm run size
//
// The size of each library entry point, minified and gzipped, as the build
// bundles it (scripts/build-lib.mjs's settings, minified, without source
// maps or license comments), and the modules each one pulls in. The test
// test/package-size.test.ts checks what they pull in; docs/architecture.md
// ("Package size") has the numbers.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The entry points as scripts/build-lib.mjs bundles them. */
export const SIZE_ENTRIES = [
  { name: "mochi2d", file: "src/lib/index.ts", platform: "browser" },
  { name: "mochi2d/headless", file: "src/lib/headless.ts", platform: "neutral" },
  { name: "mochi2d/node", file: "src/lib/node.ts", platform: "node", target: "node20" },
  { name: "mochi2d/pixi", file: "src/lib/pixi.ts", platform: "browser", external: ["pixi.js"] },
];

/** What an app that imports only the main class of an entry point bundles. */
export const SIZE_IMPORTS = [
  { ...SIZE_ENTRIES[0], only: ["MochiView"] },
  { ...SIZE_ENTRIES[1], only: ["ModelRuntime"] },
  { ...SIZE_ENTRIES[3], only: ["MochiSprite"] },
];

/**
 * Bundles one entry point minified, in memory: its bytes, gzipped bytes
 * (level 9) and input modules (paths relative to the repository).
 */
export async function measureEntry(entry) {
  const result = await build({
    absWorkingDir: root,
    ...(entry.only
      ? {
          stdin: {
            contents: `export { ${entry.only.join(", ")} } from "./${entry.file}";`,
            resolveDir: root,
            loader: "ts",
          },
        }
      : { entryPoints: [entry.file] }),
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    metafile: true,
    outdir: "out/size",
    target: entry.target ?? "es2022",
    platform: entry.platform,
    external: entry.external ?? [],
    legalComments: "none",
    define: { __MOCHI2D_VERSION__: '"0.0.0"' },
    logLevel: "warning",
  });
  const js = result.outputFiles.find((f) => f.path.endsWith(".js"));
  const output = Object.values(result.metafile.outputs).find((o) => o.entryPoint);
  // The bundle's own modules (not esbuild's <stdin>).
  return {
    name: entry.only ? `${entry.name}: { ${entry.only.join(", ")} }` : entry.name,
    bytes: js.contents.length,
    gzip: gzipSync(js.contents, { level: 9 }).length,
    inputs: Object.keys(output.inputs)
      .filter((i) => i !== "<stdin>")
      .sort(),
    code: js.text,
  };
}

export async function measureAll() {
  return Promise.all([...SIZE_ENTRIES, ...SIZE_IMPORTS].map(measureEntry));
}

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const all = await measureAll();
  console.log("| Entry point | Minified | Gzipped | Modules |");
  console.log("| --- | --: | --: | --: |");
  for (const m of all)
    console.log(`| \`${m.name}\` | ${kb(m.bytes)} | ${kb(m.gzip)} | ${m.inputs.length} |`);
  if (process.argv.includes("--inputs"))
    for (const m of all) console.log(`\n${m.name}:\n  ${m.inputs.join("\n  ")}`);
}

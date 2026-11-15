#!/usr/bin/env node
// Builds the library: ES module bundles in dist/lib/ and type declarations in
// dist/lib/types/ (see the "exports" of package.json and docs/api.md).
//
//   mochi2d.js      browser: MochiView, MochiModel, sources (+ .min.js)
//   headless.js      no DOM, no Node APIs: ModelRuntime, parsers, evaluation
//   node.js          Node: headless + files on disk
//   pixi.js          browser: MochiSprite for PixiJS v8 (pixi.js stays external) + mochi2d.js's API
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { licenseBanner } from "./license-banner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const out = resolve(root, "dist", "lib");
rmSync(out, { recursive: true, force: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  format: "esm",
  sourcemap: true,
  target: "es2022",
  legalComments: "eof",
  // Mochi2D's license, that of fflate, which every bundle includes (zip
  // reading), and that of the float32 math functions ported from musl (the
  // evaluator's rotations).
  banner: { js: licenseBanner(["fflate", "musl"]) },
  define: { __MOCHI2D_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "warning",
};

await Promise.all([
  build({
    ...common,
    entryPoints: { mochi2d: "src/lib/index.ts" },
    outdir: out,
    platform: "browser",
  }),
  build({
    ...common,
    entryPoints: { "mochi2d.min": "src/lib/index.ts" },
    outdir: out,
    platform: "browser",
    minify: true,
  }),
  build({
    ...common,
    entryPoints: { headless: "src/lib/headless.ts" },
    outdir: out,
    platform: "neutral",
  }),
  build({
    ...common,
    entryPoints: { pixi: "src/lib/pixi.ts" },
    outdir: out,
    platform: "browser",
    // A peer dependency: the app's own PixiJS.
    external: ["pixi.js"],
  }),
  build({
    ...common,
    entryPoints: { node: "src/lib/node.ts" },
    outdir: out,
    platform: "node",
    target: "node20",
  }),
]);

// Declarations: one .d.ts per source module under dist/lib/types/.
execFileSync(
  process.execPath,
  [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.lib.json"],
  {
    cwd: root,
    stdio: "inherit",
  },
);
console.log(`mochi2d ${pkg.version}: dist/lib/{mochi2d,mochi2d.min,headless,node,pixi}.js + types`);

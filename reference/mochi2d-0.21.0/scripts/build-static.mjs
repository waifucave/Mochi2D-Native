#!/usr/bin/env node
// npm run build:static [-- --out dist/viewer] [--models <folder> ...]
//
// Builds the viewer as a self-contained static site: index.html and assets/
// with relative URLs, so any static file server can host it, in any
// directory. Model folders given with --models are copied into models/ with
// a models/index.json listing, which fills the viewer's Models menu (and
// lets ?model=<folder>/<name>.model3.json open one at start).
//
// Copied model files are published by whoever hosts the folder: respect each
// model's terms. DeepSeek-chan's terms forbid re-uploading its files for
// others to download, so keep a build that includes it private.
import { build } from "vite";
import { cpSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { licenseBanner } from "./license-banner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    out: { type: "string", default: join(root, "dist", "viewer") },
    models: { type: "string", multiple: true, default: [] },
  },
});
const out = resolve(values.out);
const show = (p) => (p.startsWith(root) ? relative(root, p) || "." : p);

await build({
  configFile: false,
  root: join(root, "web"),
  base: "./",
  publicDir: false,
  logLevel: "warn",
  build: {
    outDir: out,
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: { index: join(root, "web", "index.html") },
      // Mochi2D's license, that of fflate (zip reading, PNG compression) and
      // that of the math functions ported from musl (the evaluator's rotations).
      output: { postBanner: licenseBanner(["fflate", "musl"]) },
    },
  },
});
// The license texts travel with the site.
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) cpSync(join(root, name), join(out, name));

const files = [];
for (const folder of values.models.flatMap((m) => m.split(","))) {
  const src = resolve(folder);
  const name = basename(src);
  const dest = join(out, "models", name);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, filter: (p) => !basename(p).startsWith(".") });
  const walk = (dir) => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(relative(join(out, "models"), p).split("\\").join("/"));
    }
  };
  walk(dest);
  console.log(`copied ${show(src)} → ${show(dest)}`);
}
if (files.length) {
  writeFileSync(join(out, "models", "index.json"), JSON.stringify({ files }, null, 1));
  console.log(
    "Model files are copied as they are: respect each model's terms before you publish this folder.",
  );
}
console.log(`static viewer: ${show(out)}/index.html (serve the folder with any static server)`);

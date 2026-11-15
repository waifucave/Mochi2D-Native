#!/usr/bin/env node
// npm run api-list [-- --check] [--src]
//
// Writes the export lists of docs/api-stability.md from the build's type
// declarations (dist/lib/types/, npm run build:lib), keeping each export's
// stability mark. A new export gets "?", which test/api-stability.test.ts
// refuses until it is marked; one marked @deprecated in its doc comment gets
// "deprecated". With --check, writes nothing and exits 1 if the lists
// differ; with --src, reads the sources instead of the build.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { entryExports, parseStabilityDoc, renderLists, withLists } from "./api-exports.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const fromSrc = args.includes("--src");
const types = resolve(root, "dist", "lib", "types");
if (!fromSrc && !existsSync(resolve(types, "lib", "index.d.ts"))) {
  console.error("No declarations in dist/lib/types: run npm run build:lib first (or pass --src).");
  process.exit(2);
}
const exports = fromSrc ? entryExports(resolve(root, "src")) : entryExports(types, ".d.ts");
const path = resolve(root, "docs", "api-stability.md");
const doc = readFileSync(path, "utf8");
const next = await prettier.format(withLists(doc, renderLists(exports, parseStabilityDoc(doc))), {
  ...(await prettier.resolveConfig(path)),
  filepath: path,
});
const unmarked = [...parseStabilityDoc(next)].filter(([, r]) => r.mark === "?").map(([n]) => n);
for (const [entry, list] of Object.entries(exports))
  console.log(`${entry}: ${Object.keys(list).length} exports`);
if (unmarked.length) console.log(`unmarked (give each a mark): ${unmarked.join(", ")}`);
if (args.includes("--check")) {
  if (next !== doc) {
    console.error("docs/api-stability.md is out of date: run npm run api-list.");
    process.exit(1);
  }
} else if (next !== doc) {
  writeFileSync(path, next);
  console.log("docs/api-stability.md updated");
}

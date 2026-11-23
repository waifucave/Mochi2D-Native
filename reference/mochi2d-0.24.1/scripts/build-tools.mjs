#!/usr/bin/env node
// Bundles the Node CLIs in tools/ into dist/tools/*.js with esbuild.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { licenseBanner, packageOf, portedOf } from "./license-banner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
let sha = "unknown";
try {
  sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {}

const result = await build({
  absWorkingDir: root,
  metafile: true,
  entryPoints: [
    "tools/conformance.ts",
    "tools/render.ts",
    "tools/imgdiff.ts",
    "tools/resultdiff.ts",
    "tools/texture-probe.ts",
    "tools/golden.ts",
    "tools/bench.ts",
    "tools/serve.ts",
    "tools/catalog.ts",
    "tools/fuzz.ts",
    // The agent interface: the MCP server and the headless CLI (docs/agent-api.md).
    "tools/mochi2d-mcp.ts",
    "tools/mochi2d.ts",
  ],
  outdir: "dist/tools",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  // Playwright comes from the environment (pre-installed), never bundled.
  external: ["playwright", "playwright-core"],
  define: {
    __MOCHI2D_BUILD_SHA__: JSON.stringify(sha),
    __MOCHI2D_VERSION__: JSON.stringify(pkg.version),
  },
  // Docs bundled into the MCP server as resources.
  loader: { ".md": "text", ".txt": "text" },
  banner: {
    js: 'import { createRequire as __mochi2dCreateRequire } from "node:module"; const require = __mochi2dCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});

// License comments: Mochi2D's, plus one per third-party package and per
// project with ported code (PORTED) each bundle includes (from the
// metafile). They go first, after a #! line if there is one, and the source
// map moves down by those lines. Both are listed in
// dist/tools/third-party.json (test/lib-package.test.ts checks that
// THIRD_PARTY_NOTICES.md covers them).
const bundled = {};
for (const [file, info] of Object.entries(result.metafile.outputs)) {
  if (!file.endsWith(".js")) continue;
  const inputs = Object.keys(info.inputs);
  const used = [
    ...[...new Set(inputs.map(packageOf).filter(Boolean))].sort(),
    ...[...new Set(inputs.map(portedOf).filter(Boolean))].sort(),
  ];
  bundled[file] = used;
  const banner = licenseBanner(used) + "\n";
  const path = resolve(root, file);
  let code = readFileSync(path, "utf8");
  let head = "";
  let headLines = 0;
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n") + 1;
    [head, code] = [code.slice(0, nl), code.slice(nl)];
    headLines = 1;
    chmodSync(path, 0o755); // the bins (package.json "bin")
  }
  writeFileSync(path, head + banner + code);
  const mapPath = `${path}.map`;
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const lines = map.mappings.split(";");
  lines.splice(headLines, 0, ...new Array(banner.split("\n").length - 1).fill(""));
  map.mappings = lines.join(";");
  writeFileSync(mapPath, JSON.stringify(map));
}
writeFileSync(resolve(root, "dist", "tools", "third-party.json"), JSON.stringify(bundled, null, 2));

import { defineConfig } from "vite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelsHandler } from "./tools/lib/static-server.js";
import { licenseBanner } from "./scripts/license-banner.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * The pages live in web/ (the Vite root) and load their entry modules from
 * ../src/, outside the root. The build resolves those paths from the HTML
 * files, but in the dev server the browser asks for /src/…, which would get
 * the HTML fallback. Resolve such requests to the repository's src/ folder.
 */
function resolveSrcRequests(id: string): string | null {
  if (!id.startsWith("/src/")) return null;
  const q = id.indexOf("?");
  const path = q < 0 ? id : id.slice(0, q);
  if (existsSync(path)) return null; // already an existing absolute path
  const file = resolve(root, path.slice(1));
  return existsSync(file) ? file + (q < 0 ? "" : id.slice(q)) : null;
}

export default defineConfig({
  root: resolve(root, "web"),
  base: "./",
  publicDir: false,
  build: {
    outDir: resolve(root, "dist/web"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        viewer: resolve(root, "web/index.html"),
        harness: resolve(root, "web/harness.html"),
      },
      // Mochi2D's license, that of fflate (zip reading, PNG compression) and
      // that of the math functions ported from musl (the evaluator's rotations).
      output: { postBanner: licenseBanner(["fflate", "musl"]) },
    },
  },
  server: { fs: { allow: [root] } },
  plugins: [
    {
      name: "mochi2d-src-outside-root",
      apply: "serve",
      resolveId: (id) => resolveSrcRequests(id),
    },
    {
      name: "mochi2d-models",
      configureServer(server) {
        const handler = createModelsHandler(root);
        server.middlewares.use((req, res, next) => void handler(req, res, next));
      },
      configurePreviewServer(server) {
        const handler = createModelsHandler(root);
        server.middlewares.use((req, res, next) => void handler(req, res, next));
      },
    },
  ],
});

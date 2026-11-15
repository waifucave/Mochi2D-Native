// Bundles tests/crosscheck/render.ts for Node (render.sh). With a second
// argument, the bundle launches Chromium with ANGLE over that backend
// instead of SwiftShader (for example "gl-egl": the system's OpenGL ES, Mesa
// where present), so Mochi2D's renders can be made on the same driver as the
// GL backend's. The reference's files are read, never changed: the flag is
// swapped in the bundle only.
//
// usage: node bundle.mjs <reference folder> <render.ts> <out.mjs> [angle backend]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

// Relative paths are taken from the working directory (createRequire needs an absolute one).
const [ref, entry, outfile] = process.argv.slice(2, 5).map((p) => resolve(p));
const angle = process.argv[5];
if (!ref || !entry || !outfile) {
  console.error("usage: node bundle.mjs <reference folder> <render.ts> <out.mjs> [angle backend]");
  process.exit(2);
}
const esbuild = createRequire(join(ref, "package.json"))("esbuild");
const plugins = angle
  ? [{
      name: "angle-backend",
      setup(build) {
        build.onLoad({ filter: /node-chromium\.ts$/ }, (a) => {
          const text = readFileSync(a.path, "utf8");
          const from = '"--use-angle=swiftshader",';
          if (!text.includes(from)) throw new Error(`${a.path}: no ${from}`);
          return { contents: text.replace(from, `"--use-angle=${angle}",`), loader: "ts" };
        });
      },
    }]
  : [];
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "warning",
  external: ["playwright"],
  // pngjs is CommonJS and Playwright stays external: give the bundle a require.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins,
});

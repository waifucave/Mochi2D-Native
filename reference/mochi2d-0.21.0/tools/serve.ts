/**
 * npm run viewer [-- --port N] [--host H] [--dir D] [--path P]
 * Serves the built viewer (dist/web), or the directory D, with model files
 * under /models/ (assets/models/ and the vetted repository folders). --path
 * only changes the printed URL (e.g. examples/embed/ with --dir .).
 */
import { join, resolve } from "node:path";
import { parseArgs, repoRoot } from "./lib/cli.js";
import { startStaticServer } from "./lib/static-server.js";
import { DEEPSEEK_HOWTO, findDeepseekDir } from "./lib/model-roots.js";

const args = parseArgs(process.argv.slice(2));
const root = repoRoot();
const port = Number(args.options.port ?? 5174);
const host = typeof args.options.host === "string" ? args.options.host : "127.0.0.1";
const dir =
  typeof args.options.dir === "string" ? resolve(args.options.dir) : join(root, "dist", "web");
const path = typeof args.options.path === "string" ? args.options.path.replace(/^\//, "") : "";
const s = await startStaticServer(dir, root, port, host);
console.log(
  `Mochi2D: ${s.url}${path}  (serving ${dir}; models from assets/models/ under /models/)`,
);
if (!findDeepseekDir(root)) console.log(`Note: ${DEEPSEEK_HOWTO}`);
if (host === "0.0.0.0" || host === "::")
  console.log(
    "Listening on all interfaces: open the page from another device with this computer's address.",
  );

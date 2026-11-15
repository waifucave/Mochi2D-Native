/** Runs once before the tests: says when tests are skipped for lack of DeepSeek-chan. */
import { resolve } from "node:path";
import { DEEPSEEK_HOWTO, findDeepseekDir } from "../../tools/lib/model-roots.js";
import { NEEDS_DEEPSEEK } from "./needs-deepseek.js";

export default function setup(): void {
  if (findDeepseekDir(resolve(__dirname, "../..")) !== null) return;
  console.warn(
    `\n${DEEPSEEK_HOWTO}\nWithout it, ${NEEDS_DEEPSEEK.length} test files are left out ` +
      `(${NEEDS_DEEPSEEK.map((f) => f.replace(/^test\//, "")).join(", ")}) ` +
      "and the other tests that need it are skipped.\n",
  );
}

/**
 * Where the tests find DeepSeek-chan: `assets/models/DeepSeek/` (gitignored;
 * README.md, "Test models", says where to download it), else a `DeepSeek/`
 * folder at the repository root. Tests that need it are skipped when it is
 * missing; test/support/global-setup.ts says so once per run.
 */
import { join, resolve } from "node:path";
import { DEEPSEEK_HOWTO, findDeepseekDir } from "../../tools/lib/model-roots.js";

const root = resolve(__dirname, "../..");
const found = findDeepseekDir(root);

/** DeepSeek-chan's folder (where it is expected when missing). */
export const DEEPSEEK = found ?? join(root, "assets", "models", "DeepSeek");
/** The model is there: tests that need it run. */
export const HAVE_DEEPSEEK = found !== null;
export const DEEPSEEK_SETTINGS = join(DEEPSEEK, "大肥鱼.model3.json");
/** Why tests that need the model are skipped. */
export const DEEPSEEK_MISSING = DEEPSEEK_HOWTO;

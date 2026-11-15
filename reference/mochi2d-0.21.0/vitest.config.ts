import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { findDeepseekDir } from "./tools/lib/model-roots.js";
import { NEEDS_DEEPSEEK } from "./test/support/needs-deepseek.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const missing = findDeepseekDir(root) === null;

/**
 * Browser tests that follow the audio clock (playback and live audio in
 * headless Chromium). On a loaded machine the clock can fall behind, so they
 * run on their own: after every other test, one file at a time.
 */
const AUDIO_CLOCK = ["test/live-lip-sync-browser.test.ts", "test/motion-sync-browser.test.ts"];

/**
 * The fuzzing pass gives each input a time limit, and keeps all four cores
 * of a small machine busy: it runs last, on its own.
 */
const FUZZ = ["test/fuzz.test.ts"];

// Without DeepSeek-chan (assets/models/DeepSeek/), the files that need it
// throughout are left out; test/support/global-setup.ts says so once.
const exclude = [...configDefaults.exclude, ...(missing ? NEEDS_DEEPSEEK : [])];

export default defineConfig({
  test: {
    testTimeout: 60_000,
    globalSetup: ["test/support/global-setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "main",
          include: ["test/**/*.test.ts"],
          exclude: [...exclude, ...AUDIO_CLOCK, ...FUZZ],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "audio-clock",
          include: AUDIO_CLOCK,
          exclude,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "fuzz",
          include: FUZZ,
          exclude,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});

/**
 * Test files that read DeepSeek-chan throughout, many of them when the file
 * is loaded. vitest.config.ts leaves them out when the model is missing, and
 * test/support/global-setup.ts says so. Other tests that need the model skip
 * themselves (test/support/deepseek.ts).
 */
export const NEEDS_DEEPSEEK: readonly string[] = [
  "test/anim-formats.test.ts",
  "test/anim-vectors.test.ts",
  "test/blend-crafts.test.ts",
  "test/catalog.test.ts",
  "test/crafted-variants.test.ts",
  "test/deepseek.test.ts",
  "test/regression.test.ts",
  "test/runtime.test.ts",
  "test/sequences.test.ts",
  "test/vertex-version.test.ts",
];

/**
 * End-to-end check of the headless render path. Needs `npm run build` (dist/web)
 * and the pre-installed Playwright/Chromium; skipped otherwise.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRenderSession } from "../tools/lib/render-runner.js";
import { loadPlaywright } from "../tools/lib/browser.js";
import { readPng } from "../tools/lib/png.js";
import { convertAlpha } from "../src/core/image/alpha.js";
import { diffImages } from "../tools/lib/image-diff.js";

const root = resolve(__dirname, "..");
let available = existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

describe.skipIf(!available)("render harness", () => {
  it("renders the built-in textured-triangles scene like the golden image", async () => {
    const session = await openRenderSession(root);
    try {
      const r = await session.render({
        format: "mochi2d-scenario/0",
        id: "t",
        "x-builtinScene": "textured-triangles",
        parameters: {},
        partOpacities: {},
        render: { width: 256, height: 256 },
      });
      expect(r.width).toBe(256);
      expect(r.alpha).toBe("straight");
      const actual = { width: r.width, height: r.height, data: r.rgba };
      // Corner is transparent background.
      expect(Array.from(actual.data.subarray(0, 4))).toEqual([0, 0, 0, 0]);
      const golden = await readPng(join(root, "test", "golden", "builtin-textured-triangles.png"));
      const { stats } = diffImages(golden, actual, { threshold: 2 });
      expect(stats.differingPixels).toBe(0);
      // The same scene read back premultiplied converts to the same straight pixels.
      const pm = await session.render(
        {
          format: "mochi2d-scenario/0",
          id: "t",
          "x-builtinScene": "textured-triangles",
          parameters: {},
          partOpacities: {},
          render: { width: 256, height: 256 },
        },
        { alpha: "premultiplied" },
      );
      expect(pm.alpha).toBe("premultiplied");
      expect(
        Buffer.from(convertAlpha(pm.rgba, "premultiplied", "straight")).equals(Buffer.from(r.rgba)),
      ).toBe(true);
      await expect(
        session.render({
          format: "mochi2d-scenario/0",
          id: "x",
          "x-builtinScene": "nope",
          parameters: {},
          partOpacities: {},
        }),
      ).rejects.toThrow(/Unknown builtin scene/);
    } finally {
      await session.close();
    }
  });
});

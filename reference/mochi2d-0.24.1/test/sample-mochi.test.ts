/**
 * The sample model «Mochi» (samples/mochi/): it loads without warnings, holds
 * what samples/README.md says, evaluates with physics and its idle motion, and
 * renders. The reference render at the default pose is locked in
 * test/golden/mochi-render.json: its non-background pixel count everywhere,
 * and the PNG's SHA-256 on the rasterizer that captured it. Run with
 * MOCHI2D_UPDATE_IMAGES=1 to capture it again.
 *
 * The render needs `npm run build` and the pre-installed Playwright; it is
 * skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { loadModelFromDisk } from "../src/lib/node.js";
import { NodeRenderer } from "../src/lib/node-render.js";
import { decodePng } from "../tools/lib/png.js";
import { loadPlaywright } from "../tools/lib/browser.js";
import { listModelFiles } from "../tools/lib/model-roots.js";

const root = resolve(__dirname, "..");
const SETTINGS = join(root, "samples", "mochi", "mochi.model3.json");
const GOLDEN = join(root, "test", "golden", "mochi-render.json");
const UPDATE = process.env.MOCHI2D_UPDATE_IMAGES === "1";

let canRender = existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  canRender = false;
}

interface MochiGolden {
  renderer: string;
  width: number;
  height: number;
  nonBackground: number;
  sha256: string;
}

describe("the sample model «Mochi»", () => {
  it("loads without warnings and holds what samples/README.md says", async () => {
    const rt = await loadModelFromDisk(SETTINGS);
    const m = rt.model;
    expect(rt.warnings).toEqual([]);
    expect(m.version).toBe(5);
    expect(m.parameters.ids).toEqual([
      "ParamAngleZ",
      "ParamEyeLOpen",
      "ParamEyeROpen",
      "ParamMouthOpenY",
      "ParamHairFront",
    ]);
    expect(m.glues.ids).toEqual([]);
    for (const list of Object.values(m.blendShapes)) expect(list.flat()).toEqual([]);
    expect(rt.motionGroups).toEqual([{ name: "Idle", count: 1 }]);
    for (const e of ["physics", "eyeBlink", "lipSync", "idle"] as const)
      expect(rt.effectAvailable(e), e).toBe(true);
  });

  it("evaluates: every drawable visible inside the canvas, physics and the idle motion move it", async () => {
    const rt = await loadModelFromDisk(SETTINGS);
    rt.update(0);
    const inst = rt.instance;
    const n = rt.model.meshes.ids.length;
    expect(n).toBeGreaterThan(0);
    expect(Array.from(inst.drawableVisible)).toEqual(new Array(n).fill(1));
    const { width, height, pixelsPerUnit: ppu } = rt.model.canvas;
    for (const v of inst.drawableVertices)
      for (let i = 0; i < v.length; i += 2) {
        expect(Math.abs(v[i]!)).toBeLessThanOrEqual(width / ppu);
        expect(Math.abs(v[i + 1]!)).toBeLessThanOrEqual(height / ppu);
      }
    // The idle motion tilts the head, and physics swings the front hair after it.
    const hair = rt.getParameter("ParamHairFront");
    const angles = new Set<number>();
    for (let f = 0; f < 90; f++) {
      rt.update(1 / 60);
      angles.add(rt.getParameter("ParamAngleZ"));
    }
    expect(angles.size).toBeGreaterThan(10);
    expect(rt.getParameter("ParamHairFront")).not.toBe(hair);
  });

  it("is listed for the viewer's Models menu and its one-click offer", () => {
    expect(listModelFiles(root)).toContain("samples/mochi/mochi.model3.json");
  });

  describe.skipIf(!canRender)("its reference render (headless Chromium)", () => {
    let renderer: NodeRenderer;
    beforeAll(async () => {
      renderer = await NodeRenderer.open();
    }, 120000);
    afterAll(async () => {
      await renderer?.close();
    });

    it("draws the model and matches test/golden/mochi-render.json", async () => {
      const width = 384;
      const height = 512;
      const r = await renderer.render(SETTINGS, { width, height });
      const img = decodePng(r.png);
      let nonBackground = 0;
      for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) nonBackground++;
      const sha256 = createHash("sha256").update(r.png).digest("hex");
      if (UPDATE) {
        const golden: MochiGolden = { renderer: r.renderer, width, height, nonBackground, sha256 };
        writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + "\n");
      }
      const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as MochiGolden;
      expect([img.width, img.height]).toEqual([golden.width, golden.height]);
      // A real picture: a good part of the image, about as much as captured.
      expect(nonBackground).toBeGreaterThan(0.1 * width * height);
      expect(Math.abs(nonBackground - golden.nonBackground)).toBeLessThanOrEqual(
        0.005 * width * height,
      );
      if (r.renderer === golden.renderer) expect(sha256).toBe(golden.sha256);
    }, 120000);
  });
});

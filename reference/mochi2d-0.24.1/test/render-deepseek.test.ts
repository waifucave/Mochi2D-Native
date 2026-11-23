/**
 * DeepSeek-chan render scenarios of §2k: our premultiplied
 * renders against the reference vectors of §2k (mean RGBA, number of
 * non-background pixels, sample pixels) with its tolerances.
 *
 * The same renders are also locked byte for byte: the SHA-256 of
 * each PNG `npm run render` writes, straight and premultiplied, must match
 * test/golden/deepseek-render-hashes.json (`npm run golden -- --renders`).
 * Those hashes only apply on the rasterizer that captured them.
 *
 * Needs `npm run build` and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRenderSession, type RenderSession } from "../tools/lib/render-runner.js";
import { loadPlaywright } from "../tools/lib/browser.js";
import { loadScenarios, type Scenario } from "../tools/lib/scenario.js";
import { encodePng } from "../tools/lib/png.js";
import {
  RENDER_HASH_FILE,
  hashRender,
  sha256,
  type RenderHashes,
} from "../tools/lib/render-hashes.js";
import { HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
// DeepSeek-chan (assets/models/DeepSeek/) is needed too.
let available = HAVE_DEEPSEEK && existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

interface Vectors {
  tolerance: { mean: number; nonBackgroundFraction: number; pixel: number };
  scenarios: Record<
    string,
    { mean: number[]; nonBackground: number; pixels: [number, number, number[]][] }
  >;
}
const vectors = JSON.parse(
  readFileSync(join(root, "test", "golden", "deepseek-render-vectors.json"), "utf8"),
) as Vectors;
const golden = JSON.parse(readFileSync(join(root, RENDER_HASH_FILE), "utf8")) as RenderHashes;

describe.skipIf(!available)("DeepSeek-chan render vectors (§2k, headless Chromium)", () => {
  let session: RenderSession;
  const scenarios = new Map<string, Scenario>();
  beforeAll(async () => {
    for (const s of await loadScenarios([join(root, "test", "scenarios", "deepseek-render")]))
      if (s.ok) scenarios.set(s.scenario.id, s.scenario);
    session = await openRenderSession(root);
  }, 120000);
  afterAll(async () => {
    await session?.close();
  });

  it("has all nine scenarios", () => {
    expect([...scenarios.keys()].sort()).toEqual(Object.keys(vectors.scenarios).sort());
  });

  for (const [id, want] of Object.entries(vectors.scenarios)) {
    it(`${id}: means, non-background pixels and sample pixels; PNG hashes`, async (ctx) => {
      const sc = scenarios.get(id)!;
      const r = await session.render(sc, { alpha: "premultiplied" });
      const d = r.rgba;
      // Byte-identical reference output, on the rasterizer that captured the hashes.
      const sameRasterizer = r.renderer === golden.renderer;
      if (sameRasterizer) {
        const png = encodePng({ width: r.width, height: r.height, data: d });
        expect(sha256(png), `${id} premultiplied PNG`).toBe(golden.hashes[id]!.premultiplied);
        expect((await hashRender(session, sc, "straight")).hash, `${id} straight PNG`).toBe(
          golden.hashes[id]!.straight,
        );
      }
      const bg = sc.render?.background ?? [0, 0, 0, 0];
      const bgBytes = [bg[0] * bg[3], bg[1] * bg[3], bg[2] * bg[3], bg[3]].map((v) =>
        Math.round(255 * v),
      );
      const sum = [0, 0, 0, 0];
      let nonBackground = 0;
      for (let i = 0; i < d.length; i += 4) {
        for (let c = 0; c < 4; c++) sum[c]! += d[i + c]!;
        if (bgBytes.some((b, c) => d[i + c] !== b)) nonBackground++;
      }
      const n = d.length / 4;
      const t = vectors.tolerance;
      sum.forEach((s, c) =>
        expect(Math.abs(s / n - want.mean[c]!), `mean channel ${c}`).toBeLessThanOrEqual(t.mean),
      );
      expect(
        Math.abs(nonBackground - want.nonBackground) / want.nonBackground,
        `non-background ${nonBackground} vs ${want.nonBackground}`,
      ).toBeLessThanOrEqual(t.nonBackgroundFraction);
      for (const [x, y, rgba] of want.pixels) {
        const k = (y * r.width + x) * 4;
        const got = Array.from(d.subarray(k, k + 4));
        got.forEach((g, c) =>
          expect(
            Math.abs(g - rgba[c]!),
            `pixel (${x}, ${y}) = ${got}, want ${rgba}`,
          ).toBeLessThanOrEqual(t.pixel),
        );
      }
      if (!sameRasterizer)
        ctx.annotate(
          `PNG hashes not checked: captured on "${golden.renderer}", not "${r.renderer}"`,
        );
    }, 120000);
  }

  it("viewer mask atlas: close to the reference masks (an approximation npm run render never uses)", async () => {
    // Loose bounds that a broken mapping or a stale atlas region would exceed by far.
    const limits: Record<number, { rms: number; over16: number }> = {
      2: { rms: 2, over16: 0.004 },
      4: { rms: 1, over16: 0.002 },
    };
    const lines: string[] = [];
    const failures: string[] = [];
    for (const [id] of Object.entries(vectors.scenarios)) {
      const sc = scenarios.get(id)!;
      const results = await session.call<
        {
          oversample: number;
          rms: number;
          over4: number;
          over8: number;
          over16: number;
          maxD: number;
        }[]
      >("compareMaskModes", {
        model: sc.model,
        width: sc.render!.width,
        height: sc.render!.height,
        ...(sc.render!.background ? { background: sc.render!.background } : {}),
        ...(sc.render!.view ? { view: sc.render!.view } : {}),
        parameters: sc.parameters,
        partOpacities: sc.partOpacities,
        oversamples: [2, 4],
      });
      for (const r of results) {
        const line =
          `×${r.oversample} ${id}: RMS ${r.rms.toFixed(3)}, d>4 ${(100 * r.over4).toFixed(3)} %, ` +
          `d>8 ${(100 * r.over8).toFixed(3)} %, d>16 ${(100 * r.over16).toFixed(3)} %, max ${r.maxD}`;
        lines.push(line);
        const lim = limits[r.oversample]!;
        if (!(r.rms < lim.rms && r.over16 < lim.over16)) failures.push(line);
      }
    }
    console.log(lines.join("\n"));
    expect(failures).toEqual([]);
  }, 240000);

  it("has PNG hashes for exactly these scenarios", () => {
    expect(Object.keys(golden.hashes).sort()).toEqual(Object.keys(vectors.scenarios).sort());
  });
});

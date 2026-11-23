/**
 * The README's screenshot (docs/images/viewer-mochi.png): the viewer in
 * headless Chromium, opened on its empty state, where one click opens the
 * sample model «Mochi» (samples/mochi/). The test checks that path every run:
 * the offer, the click, the model drawn. With MOCHI2D_UPDATE_IMAGES=1 it also
 * writes the screenshot, so the picture can follow the viewer.
 *
 * Needs `npm run build` and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { decodePng } from "../tools/lib/png.js";

const root = resolve(__dirname, "..");
const SHOT = join(root, "docs", "images", "viewer-mochi.png");
const UPDATE = process.env.MOCHI2D_UPDATE_IMAGES === "1";
const VIEWPORT = { width: 1200, height: 720 };
const SCALE = 2;

let available = existsSync(join(root, "dist", "web", "index.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

describe.skipIf(!available)("the README's viewer screenshot (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    server = await startStaticServer(join(root, "dist", "web"), root, 0, "127.0.0.1");
    browser = await launchChromium();
    page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("index.html", server.url).href, { waitUntil: "load" });
  }, 90000);

  afterAll(async () => {
    await page
      ?.evaluate("window.mochi2dViewer && window.mochi2dViewer.stage.stop()")
      .catch(() => {});
    await browser?.close();
    await server?.close();
  }, 60000);

  it("offers the sample on the empty viewer, opens it in one click, and draws it", async () => {
    await page.waitForSelector("#sample-offer:not([hidden])", { timeout: 30000 });
    await page.click("#open-sample");
    await page.waitForFunction(
      "/mochi\\.model3\\.json: moc3 v5|failed/.test(document.getElementById('status').textContent)",
      undefined,
      { timeout: 60000 },
    );
    expect(await page.evaluate("document.getElementById('status').textContent")).toMatch(
      /mochi\.model3\.json: moc3 v5/,
    );
    expect(await page.evaluate("document.getElementById('sample-offer').hidden")).toBe(true);
    // A still picture: no idle motion, blinks or breath; the eyes open.
    await page.evaluate(`(() => {
      const rt = window.mochi2dViewer.model.runtime;
      for (const e of ["idle", "eyeBlink", "breath", "look"]) rt.setEffect(e, false);
      rt.stopMotions();
    })()`);
    await page.waitForTimeout(1500);

    const shot = await page.screenshot({ type: "png" });
    const img = decodePng(new Uint8Array(shot));
    expect([img.width, img.height]).toEqual([VIEWPORT.width * SCALE, VIEWPORT.height * SCALE]);
    if (UPDATE) {
      mkdirSync(dirname(SHOT), { recursive: true });
      writeFileSync(SHOT, shot);
    }
    const committed = decodePng(new Uint8Array(readFileSync(SHOT)));
    expect([committed.width, committed.height]).toEqual([img.width, img.height]);

    // The stage shows the model: its canvas holds many pixels unlike its corner.
    const stage = (await page.evaluate(`(() => {
      const r = document.getElementById("canvas").getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    })()`)) as number[];
    const [sx, sy, sw, sh] = stage.map((v) => Math.round(v * SCALE));
    const px = (x: number, y: number) => {
      const i = (y * img.width + x) * 4;
      return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
    };
    const bg = px(sx! + 4, sy! + 4);
    let differing = 0;
    let total = 0;
    for (let y = sy!; y < sy! + sh!; y += 4)
      for (let x = sx!; x < sx! + sw!; x += 4) {
        total++;
        const p = px(x, y);
        if (Math.abs(p[0]! - bg[0]!) + Math.abs(p[1]! - bg[1]!) + Math.abs(p[2]! - bg[2]!) > 30)
          differing++;
      }
    expect(differing / total).toBeGreaterThan(0.05);
    expect(errors).toEqual([]);
  }, 120000);
});

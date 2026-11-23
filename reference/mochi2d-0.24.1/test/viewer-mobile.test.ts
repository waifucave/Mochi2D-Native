/**
 * The viewer on a phone, emulated in headless Chromium (iPhone-sized
 * viewport, touch, an iPhone user agent): the responsive layout (full-screen
 * stage, the areas as a bottom sheet with tabs, the open menu), the
 * automatic phone texture budget with its visible notice, and touch gestures
 * (tap to hit-test, two-finger pinch to zoom, double tap to reset). Needs
 * `npm run build` and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
// DeepSeek-chan (assets/models/DeepSeek/) is needed too.
let available = HAVE_DEEPSEEK && existsSync(join(root, "dist", "web", "index.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe.skipIf(!available)("viewer on a phone (emulated)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const rect = (sel: string) =>
    page.evaluate((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom };
    }, sel);

  beforeAll(async () => {
    server = await startStaticServer(join(root, "dist", "web"), root);
    browser = await launchChromium();
    page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: IPHONE_UA,
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("index.html", server.url).href, { waitUntil: "load" });
    await page.waitForFunction("window.mochi2dViewer && window.mochi2dViewer.stage", undefined, {
      timeout: 15000,
    });
  });
  afterAll(async () => {
    await page
      ?.evaluate(
        () =>
          (
            window as unknown as { mochi2dViewer: { stage: { stop(): void } } }
          ).mochi2dViewer.stage.stop(),
        undefined,
      )
      .catch(() => {});
    await browser?.close();
    await server?.close();
  }, 60000);

  it("gives the stage the screen, with panels and the open controls behind buttons", async () => {
    const stage = await rect("#stage");
    expect(stage.w).toBe(390);
    expect(stage.h).toBeGreaterThan(844 * 0.8);
    // The sheet is off screen until opened.
    expect((await rect("#sidebar")).y).toBeGreaterThanOrEqual(844);
    // The sheet slides in and out with a CSS transition: wait for its end
    // position (under load, the transition can take longer than it should).
    const sheetAt = (cond: string) =>
      page.waitForFunction(
        `(() => { const r = document.getElementById("sidebar").getBoundingClientRect(); return ${cond}; })()`,
        undefined,
        { timeout: 10000 },
      );
    await page.click("#toggle-panels");
    await sheetAt("r.y < 844 * 0.6 && r.bottom <= 845");
    const sheet = await rect("#sidebar");
    expect(sheet.y).toBeLessThan(844 * 0.6);
    expect(sheet.bottom).toBeLessThanOrEqual(845);
    await page.click(".sheet-close");
    await sheetAt("r.y >= 844");
    expect((await rect("#sidebar")).y).toBeGreaterThanOrEqual(844);
    // The open controls are a menu.
    expect(
      await page.evaluate(
        () => getComputedStyle(document.getElementById("open-controls")!).display,
        undefined,
      ),
    ).toBe("none");
    await page.click("#toggle-open");
    expect(
      await page.evaluate(
        () => getComputedStyle(document.getElementById("open-controls")!).display,
        undefined,
      ),
    ).toBe("flex");
    expect(
      await page.evaluate(() => document.getElementById("open-hint")!.textContent, undefined),
    ).toMatch(/\.zip/);
    // Nothing is wider than the screen; the drawing buffer is capped at 2× (the screen is 3×).
    const widths = await page.evaluate(() => {
      const c = document.getElementById("canvas") as HTMLCanvasElement;
      return { scroll: document.documentElement.scrollWidth, canvas: c.width, css: c.clientWidth };
    }, undefined);
    expect(widths.scroll).toBeLessThanOrEqual(390);
    expect(widths.canvas).toBe(widths.css * 2);
  });

  it("loads DeepSeek-chan within the phone budget and says so", async () => {
    // The File menu (opened by the previous test) holds the Models list.
    const fileOpen = await page.evaluate(
      () => document.getElementById("toggle-open")!.getAttribute("aria-expanded"),
      undefined,
    );
    if (fileOpen !== "true") await page.click("#toggle-open");
    await page.selectOption("#model-select", "DeepSeek/大肥鱼.model3.json");
    await page.waitForFunction(
      "/715 drawables|failed/.test(document.getElementById('status').textContent)",
      undefined,
      { timeout: 120000 },
    );
    const s = await page.evaluate(() => {
      const v = (window as unknown as { mochi2dViewer: { stage: { memory: { total: number } } } })
        .mochi2dViewer;
      const notice = document.getElementById("stage-notice")!;
      return {
        status: document.getElementById("status")!.textContent!,
        budget: (document.getElementById("texture-budget") as HTMLSelectElement).selectedOptions[0]!
          .textContent,
        textures: v.stage.memory.total,
        notice: notice.hidden ? null : notice.textContent,
        menuOpen: document.body.classList.contains("open-menu"),
      };
    }, undefined);
    expect(s.status).toMatch(/5 textures \(\d downscaled to 256 MiB \(auto: iPhone\)\)/);
    expect(s.budget).toMatch(/auto \(256 MiB, iPhone\)/);
    expect(s.notice).toMatch(/downscaled to fit this device/);
    expect(s.menuOpen).toBe(false);
    // Textures within the budget (render targets and buffers come on top).
    expect(s.textures).toBeLessThan(400 * 2 ** 20);
  }, 180000);

  it("keeps the sheet closed after loading, and shows one area at a time in it", async () => {
    expect((await rect("#sidebar")).y).toBeGreaterThanOrEqual(844);
    const shown = () =>
      page.evaluate(
        () =>
          ["menu-area", "resources", "settings-area"].filter(
            (id) => getComputedStyle(document.getElementById(id)!).display !== "none",
          ),
        undefined,
      );
    await page.click("#toggle-panels");
    expect(await shown()).toEqual(["menu-area"]);
    await page.click('.sheet-tabs [data-sheet="resources"]');
    expect(await shown()).toEqual(["resources"]);
    // Picking a file shows its settings.
    await page.click("#resource-tree .tree-row.kind-motion >> nth=0");
    expect(await shown()).toEqual(["settings-area"]);
    await page.waitForFunction(
      "document.getElementById('settings-body').textContent.includes('Duration')",
      undefined,
      { timeout: 10000 },
    );
    expect(
      await page.evaluate(
        () =>
          [...document.querySelectorAll(".sheet-tabs [aria-selected=true]")].map(
            (t) => (t as HTMLElement).dataset.sheet,
          ),
        undefined,
      ),
    ).toEqual(["settings"]);
    await page.click('.sheet-tabs [data-sheet="menu"]');
    await page.click(".sheet-close");
  }, 30000);

  it("hit-tests on tap, pinch-zooms with two fingers, resets on double tap", async () => {
    const box = (await page.locator("#canvas").boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.3);
    await page.waitForFunction(
      "/Topmost drawable here|Nothing here/.test(document.getElementById('status').textContent)",
      undefined,
      { timeout: 30000 },
    );
    // Two fingers moving apart: synthetic pointer events, as a touch screen sends them.
    const zoom = await page.evaluate(
      ([cx, cy]) => {
        const c = document.getElementById("canvas")!;
        const send = (type: string, id: number, x: number, y: number) =>
          c.dispatchEvent(
            new PointerEvent(type, {
              pointerId: id,
              pointerType: "touch",
              clientX: x,
              clientY: y,
              bubbles: true,
              isPrimary: id === 1,
            }),
          );
        send("pointerdown", 1, cx - 30, cy);
        send("pointerdown", 2, cx + 30, cy);
        for (let i = 1; i <= 5; i++) {
          send("pointermove", 1, cx - 30 - 12 * i, cy);
          send("pointermove", 2, cx + 30 + 12 * i, cy);
        }
        send("pointerup", 1, cx - 90, cy);
        send("pointerup", 2, cx + 90, cy);
        return (window as unknown as { mochi2dViewer: { model: { view: { zoom: number } } } })
          .mochi2dViewer.model.view.zoom;
      },
      [box.x + box.width / 2, box.y + box.height / 2] as const,
    );
    expect(zoom).toBeCloseTo(3, 1); // 60 → 180 px apart
    // A double tap, sent at once: under load, two separate taps can arrive
    // further apart than a double tap allows.
    const zoomAfter = await page.evaluate(
      ([cx, cy]) => {
        const c = document.getElementById("canvas")!;
        const send = (type: string) =>
          c.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 7,
              pointerType: "touch",
              clientX: cx,
              clientY: cy,
              bubbles: true,
              isPrimary: true,
            }),
          );
        for (let i = 0; i < 2; i++) {
          send("pointerdown");
          send("pointerup");
        }
        return (window as unknown as { mochi2dViewer: { model: { view: { zoom: number } } } })
          .mochi2dViewer.model.view.zoom;
      },
      [box.x + box.width / 2, box.y + box.height / 2] as const,
    );
    expect(zoomAfter).toBe(1);
  }, 60000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});

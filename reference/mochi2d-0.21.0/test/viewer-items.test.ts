/**
 * The viewer's Items panel in headless Chromium: DeepSeek-chan as
 * the model and, from the Models list, again as an item (her folder's
 * `.vtube.json` has ItemSettings). Adding, the panel's
 * fields, pinning, the parameter panel's choice of model or item, and
 * removing. Needs `npm run build` and the pre-installed Playwright; skipped
 * otherwise.
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

const DEEPSEEK = "DeepSeek/大肥鱼.model3.json";

describe.skipIf(!available)("viewer items (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const status = () =>
    page.evaluate(() => document.getElementById("status")!.textContent ?? "", undefined);
  const waitStatus = (re: RegExp) =>
    page.waitForFunction(
      `${re.toString()}.test(document.getElementById("status").textContent) && !document.getElementById("status").textContent.endsWith("…")`,
      undefined,
      { timeout: 180000 },
    );

  beforeAll(async () => {
    server = await startStaticServer(join(root, "dist", "web"), root);
    browser = await launchChromium();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("index.html", server.url).href, { waitUntil: "load" });
    await page.waitForFunction("window.mochi2dViewer && window.mochi2dViewer.stage", undefined, {
      timeout: 30000,
    });
    await page.waitForFunction(
      `[...document.getElementById("item-select").options].some((o) => o.value === ${JSON.stringify(DEEPSEEK)})`,
      undefined,
      { timeout: 30000 },
    );
    await page.click("#toggle-open");
    await page.selectOption("#model-select", DEEPSEEK);
    await waitStatus(/715 drawables|failed/);
  }, 240000);

  afterAll(async () => {
    await page
      ?.evaluate("window.mochi2dViewer && window.mochi2dViewer.stage.stop()")
      .catch(() => {});
    await browser?.close();
    await server?.close();
  }, 60000);

  it("adds an item from the Models list and shows it in the Items panel", async () => {
    expect(await status()).toMatch(/715 drawables/);
    // The Items panel of the menu area.
    await page.selectOption("#menu-panel", "items");
    await page.selectOption("#item-select", DEEPSEEK);
    await waitStatus(/^Item |failed/);
    // DeepSeek-chan's folder has a .vtube.json with ItemSettings, as items do.
    expect(await status()).toMatch(
      /^Item 大肥鱼: 715 drawables, item settings from 大肥鱼\.vtube\.json \(head angles forwarded\)/,
    );
    const rows = await page.evaluate(
      () => [...document.querySelectorAll(".item-row")].map((r) => r.textContent ?? ""),
      undefined,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Head angles fed (×1/1/1, +0/0/0, smoothing 15/15/15)");
    expect(rows[0]).toContain("Not pinned.");
  }, 240000);

  it("pins the item at its anchor and moves it with the numeric fields", async () => {
    await page.click(".item-row button:has-text('Pin to model')");
    await page.waitForFunction(
      `document.querySelector(".item-row").textContent.includes("Pinned to ArtMesh")`,
      undefined,
      { timeout: 30000 },
    );
    // Setting x unpins the item and moves it there.
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>(
        ".item-row .fields label:first-child input",
      )!;
      input.value = "0.25";
      input.dispatchEvent(new Event("change"));
    }, undefined);
    const p = await page.evaluate(() => {
      const ui = (
        window as unknown as {
          mochi2dViewer: {
            itemsUi: {
              items: { entry: { pin: unknown; placement: { x: number } } }[];
            };
          };
        }
      ).mochi2dViewer.itemsUi;
      const e = ui.items[0]!.entry;
      return { x: e.placement.x, pinned: e.pin !== null };
    }, undefined);
    expect(p).toEqual({ x: 0.25, pinned: false });
  }, 120000);

  it("shows the item's parameters on request, and removes the item", async () => {
    const options = await page.evaluate(
      () =>
        [...document.querySelectorAll("#panel-parameters select option")].map((o) => o.textContent),
      undefined,
    );
    expect(options).toEqual(["Main model", "Item: 大肥鱼"]);
    await page.selectOption("#menu-panel", "parameters");
    await page.selectOption("#panel-parameters select", "0");
    expect(
      await page.evaluate(
        () => document.querySelector("#panel-parameters select")!.parentElement!.textContent,
        undefined,
      ),
    ).toContain("509 parameters");
    await page.selectOption("#menu-panel", "items");
    await page.click(".item-row button:has-text('Remove')");
    expect(
      await page.evaluate(() => document.querySelectorAll(".item-row").length, undefined),
    ).toBe(0);
    expect(
      await page.evaluate(
        () => document.querySelectorAll("#panel-parameters select").length,
        undefined,
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
  }, 120000);
});

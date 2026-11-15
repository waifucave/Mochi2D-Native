/**
 * `npm run dev` from a fresh clone: Vite's root is web/, while the
 * viewer and harness pages load their entry modules from ../src/. The dev
 * server must serve those modules as JavaScript (not its HTML fallback), keep
 * the /models/ route, and, in headless Chromium, the dev viewer must load
 * DeepSeek-chan from its Models… menu.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import { HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
let playwright = true;
try {
  loadPlaywright();
} catch {
  playwright = false;
}

describe("the Vite dev server (npm run dev)", () => {
  let server: ViteDevServer;
  let base: string;

  beforeAll(async () => {
    server = await createServer({
      configFile: join(root, "vite.config.ts"),
      server: { port: 0, host: "127.0.0.1", strictPort: false },
      logLevel: "silent",
    });
    await server.listen();
    base = server.resolvedUrls!.local[0]!;
  }, 60000);
  afterAll(async () => {
    await server?.close();
  });

  it.each(["index.html", "harness.html"])(
    "serves the entry module of %s as JavaScript",
    async (page) => {
      const pageUrl = new URL(page, base);
      const html = await (await fetch(pageUrl)).text();
      const scripts = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)]
        .map((m) => m[1]!)
        .filter((src) => !src.startsWith("/@vite/"));
      expect(scripts.length, "module scripts").toBeGreaterThan(0);
      for (const src of scripts) {
        const res = await fetch(new URL(src, pageUrl));
        const body = await res.text();
        expect(res.status, src).toBe(200);
        expect(res.headers.get("content-type"), src).toMatch(/javascript/);
        expect(body.trimStart().toLowerCase().startsWith("<!doctype"), src).toBe(false);
      }
    },
  );

  it.skipIf(!HAVE_DEEPSEEK)(
    "keeps the models route: DeepSeek-chan is listed and served",
    async () => {
      const index = (await (await fetch(new URL("models/index.json", base))).json()) as {
        files: string[];
      };
      expect(index.files).toContain("DeepSeek/大肥鱼.model3.json");
      const settings = await fetch(new URL("models/DeepSeek/大肥鱼.model3.json", base));
      expect(settings.status).toBe(200);
    },
  );

  it.skipIf(!playwright || !HAVE_DEEPSEEK)(
    "loads DeepSeek-chan in the dev viewer and starts the harness page (headless Chromium)",
    async () => {
      const browser = await launchChromium();
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(new URL("index.html", base).href, { waitUntil: "load" });
        await page.waitForFunction(
          "window.mochi2dViewer && window.mochi2dViewer.stage",
          undefined,
          {
            timeout: 60000,
          },
        );
        await page.click("#toggle-open");
        await page.selectOption("#model-select", "DeepSeek/大肥鱼.model3.json");
        await page.waitForFunction(
          "/715 drawables|failed/.test(document.getElementById('status').textContent)",
          undefined,
          { timeout: 180000 },
        );
        expect(
          await page.evaluate(() => document.getElementById("status")!.textContent, undefined),
        ).toMatch(/715 drawables/);
        const harness = await browser.newPage();
        await harness.goto(new URL("harness.html", base).href, { waitUntil: "load" });
        await harness.waitForFunction(
          "window.mochi2dHarness && window.mochi2dHarness.ready === true",
          undefined,
          { timeout: 60000 },
        );
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    300000,
  );
});

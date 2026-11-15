/**
 * `npm run build:static`: the viewer as a self-contained static site, hosted
 * by a plain static server (no /models/ endpoint) in a subdirectory, with
 * DeepSeek-chan copied in through --models (into a temporary folder that is
 * deleted afterwards). Needs Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
// The build copies DeepSeek-chan (assets/models/DeepSeek/) in with --models.
let available = HAVE_DEEPSEEK;
try {
  loadPlaywright();
} catch {
  available = false;
}

describe.skipIf(!available)("static viewer build", () => {
  let dir: string;
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mochi2d-static-"));
    execFileSync(
      process.execPath,
      [
        join(root, "scripts", "build-static.mjs"),
        "--out",
        join(dir, "viewer"),
        "--models",
        DEEPSEEK,
      ],
      { cwd: root, encoding: "utf8" },
    );
    // A plain static host: no /models/ endpoint, the site in a subdirectory.
    server = await startStaticServer(dir, root, 0, "127.0.0.1", { models: false });
    browser = await launchChromium();
    page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.on("pageerror", (e) => errors.push(e.message));
  }, 120000);
  afterAll(async () => {
    await page?.evaluate("window.mochi2dViewer?.stage?.stop()").catch(() => {});
    await browser?.close();
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("writes a self-contained site with relative URLs and a model index", () => {
    const out = join(dir, "viewer");
    expect(readdirSync(out).sort()).toEqual([
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "assets",
      "index.html",
      "models",
    ]);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toMatch(/src="\.\/assets\/[^"]+\.js"/);
    expect(html).not.toMatch(/(src|href)="\/(?!\/)/); // no root-absolute URLs
    const index = JSON.parse(readFileSync(join(out, "models", "index.json"), "utf8")) as {
      files: string[];
    };
    expect(index.files).toContain("DeepSeek/大肥鱼.model3.json");
    expect(index.files).toContain("DeepSeek/Animation/脱捕.motion3.json");
    expect(existsSync(join(out, "models", "DeepSeek", "大肥鱼.moc3"))).toBe(true);
  });

  it("opens a listed model from ?model= with its folder's files", async () => {
    await page.goto(
      new URL(`viewer/?model=${encodeURIComponent("DeepSeek/大肥鱼.model3.json")}`, server.url)
        .href,
      { waitUntil: "load" },
    );
    await page.waitForFunction(
      "/715 drawables|failed/.test(document.getElementById('status').textContent)",
      undefined,
      { timeout: 120000 },
    );
    expect(
      await page.evaluate(() => document.getElementById("status")!.textContent, undefined),
    ).toMatch(/moc3 v5, 715 drawables/);
    // The index lists the folder, so unlisted motions and expressions show up.
    const count = (sub: string, suffix: string) =>
      readdirSync(join(DEEPSEEK, sub)).filter((n) => n.endsWith(suffix)).length;
    expect(await page.locator("#panel-motions .anim-item").count()).toBe(
      count("Animation", ".motion3.json"),
    );
    expect(await page.locator("#panel-expressions .anim-item").count()).toBe(
      count("Exp3", ".exp3.json"),
    );
    expect(
      await page.evaluate(
        () => (document.getElementById("model-select") as HTMLSelectElement).value,
        undefined,
      ),
    ).toBe("DeepSeek/大肥鱼.model3.json");
  }, 150000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});

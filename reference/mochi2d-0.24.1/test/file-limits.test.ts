/**
 * Caps on a file's own size, and on all a source reads, for folders, URLs
 * and dropped or picked files (`FileLimits`): sizes known before reading
 * are refused before anything is read; a download is streamed and stopped
 * at the cap. Through the library, the command line and a page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  closeSync,
  ftruncateSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_FILE_LIMITS,
  FileBudget,
  FileLimitError,
  resolveFileLimits,
} from "../src/core/io/file-limits.js";
import { sourceFromFolder, sourceFromZipFile } from "../src/platform/node-sources.js";
import { HttpFileSource } from "../src/platform/browser-sources.js";
import { loadModelFromDisk } from "../src/lib/node.js";
import { loadPlaywright, launchChromium } from "../tools/lib/browser.js";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";

const root = resolve(__dirname, "..");
const MiB = 2 ** 20;
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mochi2d-files-"));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A sparse file of `bytes` (it takes no disk space). */
function sparse(path: string, bytes: number): void {
  const fd = openSync(path, "w");
  ftruncateSync(fd, bytes);
  closeSync(fd);
}

const errorOf = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe("the budget", () => {
  it("refuses a file over the cap, and a total over the cap, counting each file once", () => {
    const b = new FileBudget({ maxFileBytes: 100, maxTotalBytes: 150 });
    expect(() => b.check("big", 101)).toThrow(FileLimitError);
    b.check("a", 100);
    b.add("a", 100);
    b.add("a", 100); // read again: counted once
    expect(b.readBytes).toBe(100);
    expect(() => b.check("b", 60)).toThrow(/reading it takes the files read to 160 bytes/);
    b.check("a", 100); // a file already read reads again
  });

  it("caps are numbers ≥ 0; Infinity turns one off", () => {
    expect(resolveFileLimits()).toEqual(DEFAULT_FILE_LIMITS);
    expect(() => resolveFileLimits({ maxFileBytes: -1 })).toThrow(RangeError);
    expect(DEFAULT_FILE_LIMITS).toEqual({ maxFileBytes: 2 ** 30, maxTotalBytes: 2 ** 31 });
  });
});

describe("folders and zips on disk", () => {
  it("a file past the default cap is refused before it is read", async () => {
    const folder = join(dir, "huge-file");
    cpSync(join(root, "samples/mochi"), folder, { recursive: true });
    // A 1.5 GiB texture, sparse: reading it would take 1.5 GiB of memory.
    sparse(join(folder, "mochi.4096/texture_00.png"), 1.5 * 2 ** 30);
    const source = await sourceFromFolder(folder);
    const before = process.memoryUsage().rss;
    const e = await errorOf(source.read("mochi.4096/texture_00.png"));
    expect(e).toBeInstanceOf(FileLimitError);
    expect(e).toMatchObject({
      kind: "file",
      limit: 2 ** 30,
      size: 1.5 * 2 ** 30,
      path: "mochi.4096/texture_00.png",
    });
    expect(process.memoryUsage().rss - before).toBeLessThan(64 * MiB);
  });

  it("the total, each file counted once", async () => {
    const source = await sourceFromFolder(join(root, "samples/mochi"), { maxTotalBytes: 70_000 });
    await source.read("mochi.moc3"); // 67 KB
    await source.read("mochi.moc3"); // again: not counted twice
    const e = await errorOf(source.read("mochi.4096/texture_00.png"));
    expect(e).toMatchObject({ name: "FileLimitError", kind: "total", limit: 70_000 });
  });

  it("a zip on disk is a file too; loadModelFromDisk passes the caps", async () => {
    const zip = join(dir, "big.zip");
    sparse(zip, 3 * MiB);
    expect(await errorOf(sourceFromZipFile(zip, undefined, { maxFileBytes: MiB }))).toMatchObject({
      name: "FileLimitError",
      kind: "file",
      path: "big.zip",
    });
    const e = await errorOf(
      loadModelFromDisk(join(root, "samples/mochi"), { files: { maxFileBytes: 1000 } }),
    );
    expect(e).toBeInstanceOf(FileLimitError);
    // With the defaults it loads.
    expect((await loadModelFromDisk(join(root, "samples/mochi"))).parameters.length).toBe(5);
  });
});

describe("URLs: streamed and stopped at the cap", () => {
  let server: Server;
  let base = "";
  let sent = 0;
  let closed = false;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/declared") {
        // Declares 10 GiB, then sends nothing more.
        res.writeHead(200, { "content-length": String(10 * 2 ** 30) });
        res.write(new Uint8Array(16));
        return;
      }
      // An endless download with no declared length.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const chunk = new Uint8Array(MiB);
      const more = () => {
        while (!closed && res.write(chunk)) {
          sent += chunk.length;
          if (sent > 2 ** 30) return res.end();
        }
        if (!closed) res.once("drain", more);
      };
      res.on("close", () => (closed = true));
      more();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  });

  it("an endless download stops at the file cap", async () => {
    const source = new HttpFileSource(base, "url", { maxFileBytes: 8 * MiB });
    const before = process.memoryUsage().rss;
    const e = await errorOf(source.read("endless"));
    expect(e).toBeInstanceOf(FileLimitError);
    expect(e).toMatchObject({ kind: "file", limit: 8 * MiB, path: "endless" });
    // The connection is closed: the server stops well short of its 1 GiB.
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(true);
    expect(sent).toBeLessThan(128 * MiB);
    expect(process.memoryUsage().rss - before).toBeLessThan(128 * MiB);
  });

  it("a declared length over the cap is refused before the body is read", async () => {
    const t0 = performance.now();
    const e = await errorOf(new HttpFileSource(base, "url").read("declared"));
    expect(e).toMatchObject({ name: "FileLimitError", kind: "file", size: 10 * 2 ** 30 });
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

const CLI = join(root, "dist", "tools", "mochi2d.js");
describe.skipIf(!existsSync(CLI))("the command line", () => {
  it("a .moc3 past the cap fails with its typed error; an optional file, with a warning", () => {
    const folder = join(dir, "cli-huge");
    cpSync(join(root, "samples/mochi"), folder, { recursive: true });
    sparse(join(folder, "mochi.moc3"), 1.5 * 2 ** 30);
    const r = spawnSync(process.execPath, [CLI, "describe", folder, "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^mochi2d: FileLimitError: "mochi\.moc3" holds \d+ bytes or more/);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      name: "FileLimitError",
      kind: "file",
      limit: 2 ** 30,
    });
    // An optional file past the cap is not read: the model loads without it, with a warning.
    cpSync(join(root, "samples/mochi/mochi.moc3"), join(folder, "mochi.moc3"));
    sparse(join(folder, "mochi.physics3.json"), 1.5 * 2 ** 30);
    const w = spawnSync(process.execPath, [CLI, "describe", folder, "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(w.status).toBe(0);
    expect(JSON.parse(w.stdout).warnings.join("\n")).toMatch(
      /mochi\.physics3\.json.* holds \d+ bytes or more/,
    );
  }, 60_000);
});

let hasBrowser = existsSync(join(root, "dist/web/harness.html"));
try {
  loadPlaywright();
} catch {
  hasBrowser = false;
}
describe.skipIf(!hasBrowser)("in a page: MochiView.load (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    server = await startStaticServer(root, root, 0, "127.0.0.1", { models: false });
    browser = await launchChromium();
    page = await browser.newPage({ viewport: { width: 320, height: 320 } });
    await page.goto(new URL("dist/web/harness.html", server.url).href, { waitUntil: "load" });
  }, 90000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  }, 60000);

  it("a URL and a picked zip within the caps, refused past them", async () => {
    const result = (await page.evaluate(`(async () => {
      const base = ${JSON.stringify(server.url)};
      const lib = await import(base + "dist/lib/mochi2d.js");
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      const view = new lib.MochiView(canvas);
      const url = base + "samples/mochi/mochi.model3.json";
      const fields = (e) => ({ name: e.name, kind: e.kind, limit: e.limit, isFileLimit: e instanceof lib.FileLimitError });
      const ok = (await view.load(url)).parameters.length;
      let fromUrl = null;
      try { await view.load(url, { files: { maxFileBytes: 1000 } }); } catch (e) { fromUrl = fields(e); }
      const blob = new File([new Uint8Array(5000)], "model.zip");
      let picked = null;
      try { await view.load(blob, { files: { maxFileBytes: 1000 } }); } catch (e) { picked = fields(e); }
      view.dispose();
      return { ok, fromUrl, picked };
    })()`)) as Record<string, unknown>;
    expect(result.ok).toBe(5);
    expect(result.fromUrl).toEqual({
      name: "FileLimitError",
      kind: "file",
      limit: 1000,
      isFileLimit: true,
    });
    expect(result.picked).toEqual({
      name: "FileLimitError",
      kind: "file",
      limit: 1000,
      isFileLimit: true,
    });
  }, 120000);
});

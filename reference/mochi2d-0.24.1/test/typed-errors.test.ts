/**
 * Our errors keep their type where only text gets through: from the render
 * harness's page to Node, and from a local file server to the page it
 * serves. A file past its cap read through a render (`NodeRenderer`, the
 * render session of `npm run render`) is the `FileLimitError` it is, with
 * its fields, never "not found"; a motion sound past its cap is a warning
 * that names it, in Node and in a page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { zipSync } from "fflate";
import { join, resolve } from "node:path";
import {
  errorForWire,
  errorFromHeader,
  errorFromMessage,
  errorToHeader,
  withoutWireLine,
} from "../src/core/io/error-wire.js";
import { FileLimitError } from "../src/core/io/file-limits.js";
import { FileNotFoundError } from "../src/core/io/file-source.js";
import { TextureLimitError } from "../src/core/image/texture-limits.js";
import { ArchiveLimitError } from "../src/runtime/zip-archive.js";
import { wireErrorFromHeader, wireErrorFromMessage } from "../src/platform/wire-errors.js";
import { loadModelFromDisk } from "../src/lib/node.js";
import { NodeRenderer } from "../src/lib/node-render.js";
import { openRenderSession } from "../tools/lib/render-runner.js";
import {
  createModelsHandler,
  startStaticServer,
  type RunningServer,
} from "../tools/lib/static-server.js";
import { loadPlaywright, launchChromium } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";

const root = resolve(__dirname, "..");
const GiB = 2 ** 30;
let hasBrowser = existsSync(join(root, "dist/web/harness.html"));
try {
  loadPlaywright();
} catch {
  hasBrowser = false;
}

describe("the wire format", () => {
  it("an error crosses as its message and comes back as its class, with its fields", () => {
    const e = new FileLimitError("a/b.png", "file", GiB, 1.5 * GiB);
    const wired = errorForWire(e);
    // What a page's rejection keeps: the name and the message, with the marked line.
    expect(wired.name).toBe("FileLimitError");
    expect(withoutWireLine(wired.message)).toBe(e.message);
    const back = wireErrorFromMessage(`page.evaluate: ${wired.name}: ${wired.message}`);
    expect(back).toBeInstanceOf(FileLimitError);
    expect(back).toBeInstanceOf(Error);
    expect({ ...back }).toEqual({ ...e });
    expect(back!.message).toBe(e.message);
    expect(String(back)).toBe(`FileLimitError: ${e.message}`);
    // Wired twice, still one marked line.
    expect(errorForWire(wired)).toBe(wired);
  });

  it("keeps non-finite numbers, and every class by the name it sets", () => {
    const t = new TextureLimitError("t.png", "total", Infinity, 5, 1, 1);
    const back = wireErrorFromMessage(errorForWire(t).message);
    expect(back).toBeInstanceOf(TextureLimitError);
    expect((back as TextureLimitError).limit).toBe(Infinity);
    for (const e of [
      new FileNotFoundError("x", "here"),
      new ArchiveLimitError("z.zip", "entries", 10, 11),
      new RangeError("out of range"),
      new TypeError("not a function"),
    ]) {
      const b = wireErrorFromMessage(errorForWire(e).message)!;
      expect(b.constructor).toBe(e.constructor);
      expect(b.name).toBe(e.name);
      expect(b.message).toBe(e.message);
    }
  });

  it("an error of a name no class has comes back with its name and fields", () => {
    const e = Object.assign(new Error("not allowed"), { path: "/x" });
    e.name = "PathNotAllowed";
    const back = errorFromMessage(errorForWire(e).message, new Map());
    expect(back).toBeInstanceOf(Error);
    expect(back).toMatchObject({ name: "PathNotAllowed", message: "not allowed", path: "/x" });
    // Nothing marked: nothing rebuilt.
    expect(wireErrorFromMessage("page.evaluate: Error: boom")).toBeNull();
  });

  it("a response header carries it in ASCII, any path included", () => {
    const e = new FileLimitError("模型/纹理.png", "total", 100, 200);
    const h = errorToHeader(e);
    expect(/^[\x20-\x7e]*$/.test(h)).toBe(true);
    expect(wireErrorFromHeader(h)).toBeInstanceOf(FileLimitError);
    expect(wireErrorFromHeader(h)).toMatchObject({ path: "模型/纹理.png", kind: "total" });
    expect(errorFromHeader("%E0%A4%A", new Map())).toBeNull();
    expect(wireErrorFromHeader(null)).toBeNull();
  });
});

let dir = "";
/** The sample «Mochi» with its texture a sparse file of 1.5 GiB, and a Talk motion with a 1.5 GiB sound. */
let sparse = "";
let sounds = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mochi2d-typed-"));
  // Under <dir>/assets/models: the models folder of a render session rooted at <dir>.
  const models = join(dir, "assets", "models");
  mkdirSync(models, { recursive: true });
  sparse = join(models, "sparse");
  cpSync(join(root, "samples/mochi"), sparse, { recursive: true });
  truncateSync(join(sparse, "mochi.4096/texture_00.png"), 1.5 * GiB);
  sounds = join(models, "sounds");
  cpSync(join(root, "samples/mochi"), sounds, { recursive: true });
  writeFileSync(join(sounds, "big.wav"), "");
  truncateSync(join(sounds, "big.wav"), 1.5 * GiB);
  writeFileSync(join(sounds, "big.motion3.json"), "");
  truncateSync(join(sounds, "big.motion3.json"), 1.5 * GiB);
  const s = JSON.parse(readFileSync(join(sounds, "mochi.model3.json"), "utf8"));
  s.FileReferences.Motions.Talk = [
    { File: "motions/idle.motion3.json", Sound: "big.wav" },
    { File: "big.motion3.json" },
  ];
  writeFileSync(join(sounds, "mochi.model3.json"), JSON.stringify(s));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("in Node: a runtime's motions and sounds past the cap", () => {
  it("a motion rejects with its FileLimitError; a sound is a warning that names it", async () => {
    const rt = await loadModelFromDisk(sounds);
    const e = await rt.startMotion("Talk", 1).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(FileLimitError);
    expect(e).toMatchObject({ path: "big.motion3.json", kind: "file" });
    await rt.startMotion("Talk", 0);
    expect(rt.warnings).toContainEqual(
      expect.stringMatching(
        /^big\.wav: motion sound not played: FileLimitError: "big\.wav" holds 1610612736 bytes/,
      ),
    );
  });
});

describe.skipIf(!hasBrowser)("renders: a texture file past the cap is its FileLimitError", () => {
  it("NodeRenderer, from a folder and from loadModelFromDisk; the total too", async () => {
    const r = await NodeRenderer.open();
    try {
      const fails = (p: Promise<unknown>) =>
        p.then(
          () => null,
          (x: unknown) => x,
        );
      for (const input of [sparse, await loadModelFromDisk(sparse)]) {
        const e = await fails(r.render(input, { width: 64, height: 64 }));
        expect(e).toBeInstanceOf(FileLimitError);
        expect(e).toMatchObject({
          name: "FileLimitError",
          path: "mochi.4096/texture_00.png",
          kind: "file",
          limit: GiB,
          size: 1.5 * GiB,
        });
      }
      const total = await fails(
        r.render(join(root, "samples/mochi"), {
          width: 64,
          height: 64,
          files: { maxTotalBytes: 70_000 },
        }),
      );
      expect(total).toBeInstanceOf(FileLimitError);
      expect(total).toMatchObject({
        kind: "total",
        limit: 70_000,
        path: "mochi.4096/texture_00.png",
      });
      // A zip entry past the archive's total cap, first read by the render.
      const zip = join(dir, "sample.zip");
      const files: Record<string, Uint8Array> = {};
      for (const f of ["mochi.model3.json", "mochi.moc3", "mochi.4096/texture_00.png"])
        files[`mochi/${f}`] = readFileSync(join(root, "samples/mochi", f));
      writeFileSync(zip, zipSync(files));
      const capped = await loadModelFromDisk(zip, { archive: { maxTotalBytes: 80_000 } });
      const entry = await fails(r.render(capped, { width: 64, height: 64 }));
      expect(entry).toBeInstanceOf(ArchiveLimitError);
      expect(entry).toMatchObject({ kind: "total", limit: 80_000 });
      // Within the caps it renders.
      expect((await r.render(join(root, "samples/mochi"), { width: 64, height: 64 })).width).toBe(
        64,
      );
    } finally {
      await r.close();
    }
  }, 180_000);

  it("the render session of npm run render: refused on its length, never read whole", async () => {
    const session = await openRenderSession(dir, join(root, "dist", "web"));
    try {
      const before = process.memoryUsage().rss;
      const e = await session
        .render({
          format: "mochi2d-scenario/0",
          id: "sparse",
          model: "sparse/mochi.model3.json",
          parameters: {},
          partOpacities: {},
          render: { width: 64, height: 64 },
        })
        .then(
          () => null,
          (x: unknown) => x,
        );
      expect(e).toBeInstanceOf(FileLimitError);
      expect(e).toMatchObject({
        path: "sparse/mochi.4096/texture_00.png",
        kind: "file",
        limit: GiB,
      });
      expect(process.memoryUsage().rss - before).toBeLessThan(256 * 2 ** 20);
    } finally {
      await session.close();
    }
  }, 180_000);
});

describe.skipIf(!hasBrowser)("in a page: MochiView.load from a URL (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    // The server of npm run viewer, with its /models/ from <dir>/assets/models.
    server = await startStaticServer(root, root, 0, "127.0.0.1", {
      modelsHandler: createModelsHandler(dir),
    });
    browser = await launchChromium();
    page = await browser.newPage({ viewport: { width: 320, height: 320 } });
    await page.goto(new URL("dist/web/harness.html", server.url).href, { waitUntil: "load" });
  }, 90_000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  }, 60_000);

  it("a texture and a motion past the cap are FileLimitErrors; a sound, a warning", async () => {
    const before = process.memoryUsage().rss;
    const result = (await page.evaluate(`(async () => {
      const lib = await import(${JSON.stringify(new URL("dist/lib/mochi2d.js", server.url).href)});
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      const view = new lib.MochiView(canvas);
      const fields = (e) => ({ name: e.name, path: e.path, kind: e.kind, typed: e instanceof lib.FileLimitError });
      const out = {};
      try { await view.load("/models/sparse/mochi.model3.json"); } catch (e) { out.texture = fields(e); }
      const model = await view.load("/models/sounds/mochi.model3.json");
      try { await model.startMotion("Talk", 1); } catch (e) { out.motion = fields(e); }
      await model.startMotion("Talk", 0);
      out.warnings = model.warnings.filter((w) => w.startsWith("big."));
      view.dispose();
      return out;
    })()`)) as Record<string, unknown>;
    expect(result.texture).toEqual({
      name: "FileLimitError",
      path: "mochi.4096/texture_00.png",
      kind: "file",
      typed: true,
    });
    expect(result.motion).toEqual({
      name: "FileLimitError",
      path: "big.motion3.json",
      kind: "file",
      typed: true,
    });
    expect(result.warnings).toEqual([
      expect.stringMatching(/^big\.wav: motion sound not played: FileLimitError: /),
    ]);
    // The server streams with the file's length: it never reads 1.5 GiB.
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 2 ** 20);
  }, 120_000);
});

/**
 * Model data in place of a `.moc3` (the `moc` option of ModelRuntime.load and
 * the view's load; ModelRuntime.withData and withModel; NodeRenderer drawing a
 * runtime's own data), on the sample model «Mochi» (samples/mochi/).
 *
 * The renders need `npm run build` and the pre-installed Playwright; they are
 * skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { MemoryFileSource, type FileSource } from "../src/core/io/file-source.js";
import { readMoc, writeMoc, MocWriteError } from "../src/core/moc/io.js";
import type { MocData } from "../src/core/moc/data.js";
import { loadMoc } from "../src/core/moc/model.js";
import { ModelRuntime } from "../src/runtime/model-runtime.js";
import { NodeRenderer } from "../src/lib/node-render.js";
import { loadPlaywright } from "../tools/lib/browser.js";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { launchChromium } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";

const root = resolve(__dirname, "..");
const DIR = join(root, "samples", "mochi");
const read = (p: string) => new Uint8Array(readFileSync(join(DIR, p)));
const MOC = read("mochi.moc3");
const FILES = [
  "mochi.model3.json",
  "mochi.4096/texture_00.png",
  "mochi.physics3.json",
  "mochi.cdi3.json",
  "motions/idle.motion3.json",
];
/** The sample's files without its `.moc3` (or with it). */
const source = (withMoc = false): FileSource =>
  MemoryFileSource.fromFiles(
    Object.fromEntries([
      ...FILES.map((p) => [p, read(p)] as const),
      ...(withMoc ? [["mochi.moc3", MOC] as const] : []),
    ]),
    "mochi",
  );
const SETTINGS = "mochi.model3.json";

/** The sample's data with art mesh `mesh` made invisible (every keyform's opacity 0). */
function hidden(mesh: number): MocData {
  const d = readMoc(MOC).data;
  const first = d.artMeshes.firstKeyform[mesh]!;
  const count = d.artMeshes.keyformCount[mesh]!;
  for (let k = first; k < first + count; k++) d.artMeshKeyforms.opacity[k] = 0;
  return d;
}

const vertices = (rt: ModelRuntime) => {
  rt.update(0);
  return rt.instance.drawableVertices.map((v) => Array.from(v));
};

describe("model data in place of a .moc3", () => {
  it("ModelRuntime.load takes MocData or bytes, with the other files from a source", async () => {
    const fromFile = await ModelRuntime.load(source(true), SETTINGS);
    const { data, version } = readMoc(MOC);
    const fromData = await ModelRuntime.load(source(), SETTINGS, { moc: { data, version } });
    const fromBytes = await ModelRuntime.load(source(), SETTINGS, { moc: MOC });
    expect([fromFile.modelSource, fromData.modelSource, fromBytes.modelSource]).toEqual([
      "file",
      "data",
      "data",
    ]);
    expect(fromData.model).toEqual(fromFile.model);
    expect(vertices(fromData)).toEqual(vertices(fromFile));
    expect(vertices(fromBytes)).toEqual(vertices(fromFile));
    // The runtime's source serves the data as the settings' .moc3; the rest is the source's.
    expect(await fromData.source.read("mochi.moc3")).toEqual(writeMoc(data, { version }));
    expect(await fromData.source.read("mochi.physics3.json")).toEqual(read("mochi.physics3.json"));
    // Physics, motions and the rest still come from the source.
    expect(fromData.effectAvailable("physics")).toBe(true);
    expect(fromData.motionGroups).toEqual([{ name: "Idle", count: 1 }]);
  });

  it("refuses data writeMoc refuses, with its MocWriteError", async () => {
    const { data, version } = readMoc(MOC);
    data.parts.parent = Int32Array.of(5); // a parent out of range
    await expect(
      ModelRuntime.load(source(), SETTINGS, { moc: { data, version } }),
    ).rejects.toBeInstanceOf(MocWriteError);
  });

  it("withData serves its own data; repeated edits don't stack; withModel has none", async () => {
    const base = await ModelRuntime.load(source(true), SETTINGS);
    const a = await base.withData(hidden(0), 5);
    const b = await a.withData(hidden(1), 5);
    expect([base.modelSource, a.modelSource, b.modelSource]).toEqual(["file", "data", "data"]);
    expect(await b.source.read("mochi.moc3")).toEqual(writeMoc(hidden(1), { version: 5 }));
    expect(b.instance.drawableVisible[0]).toBe(1); // b holds only its own edit
    b.update(0);
    expect(b.instance.drawableVisible[1]).toBe(0);
    expect(await base.source.read("mochi.moc3")).toEqual(MOC); // the base is unchanged
    const m = await base.withModel(loadMoc(writeMoc(hidden(2), { version: 5 })));
    expect(m.modelSource).toBe("model");
  });
});

let canRender = existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  canRender = false;
}

describe.skipIf(!canRender)("NodeRenderer and a runtime's own data (headless Chromium)", () => {
  let renderer: NodeRenderer;
  beforeAll(async () => {
    renderer = await NodeRenderer.open();
  }, 120000);
  afterAll(async () => {
    await renderer?.close();
  });
  const hash = (png: Uint8Array) => createHash("sha256").update(png).digest("hex");
  const size = { width: 96, height: 128 };

  it("draws a withData runtime's model, the same as loading that data", async () => {
    const base = await ModelRuntime.load(source(true), SETTINGS);
    const edited = await base.withData(hidden(3), 5);
    const loaded = await ModelRuntime.load(source(), SETTINGS, {
      moc: { data: hidden(3), version: 5 },
    });
    const [b, e, l] = [
      await renderer.render(base, size),
      await renderer.render(edited, size),
      await renderer.render(loaded, size),
    ];
    expect(hash(e.png)).not.toBe(hash(b.png));
    expect(hash(e.png)).toBe(hash(l.png));
    // The base still draws its file afterwards.
    expect(hash((await renderer.render(base, size)).png)).toBe(hash(b.png));
  }, 120000);

  it("refuses a withModel runtime, naming withData", async () => {
    const base = await ModelRuntime.load(source(true), SETTINGS);
    const m = await base.withModel(loadMoc(MOC));
    await expect(renderer.render(m, size)).rejects.toThrow(/withModel.*withData/);
  }, 60000);
});

let hasBrowser = existsSync(join(root, "dist", "lib", "mochi2d.js"));
try {
  loadPlaywright();
} catch {
  hasBrowser = false;
}

describe.skipIf(!hasBrowser)("MochiView.load with model data (headless Chromium)", () => {
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

  it("shows the data given, with the other files from the URL's folder", async () => {
    const { data } = readMoc(MOC);
    // The view gets bytes here (MocData does not cross into the page as is).
    const bytes = Array.from(writeMoc(data, { version: 5 }));
    // A string, so that the test runner leaves the page's import() alone.
    const result = (await page.evaluate(`(async () => {
      const base = ${JSON.stringify(server.url)};
      const lib = await import(base + "dist/lib/mochi2d.js");
      const canvas = document.createElement("canvas");
      canvas.style.width = "200px";
      canvas.style.height = "200px";
      document.body.append(canvas);
      const view = new lib.MochiView(canvas);
      const url = base + "samples/mochi/mochi.model3.json";
      const model = await view.load(url, { moc: new Uint8Array(${JSON.stringify(bytes)}) });
      const ok = model.parameters.length;
      let refused = "";
      try {
        await view.load(url, { moc: new Uint8Array([1, 2, 3]) });
      } catch (e) {
        refused = e.name;
      }
      view.dispose();
      return { ok, refused };
    })()`)) as { ok: number; refused: string };
    expect(result.ok).toBe(5);
    expect(result.refused).toBe("MocFormatError");
  }, 90000);
});

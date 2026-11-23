/**
 * Caps on what a model's textures declare (`TextureLimits`), read from each
 * file's header before anything is decoded; and what bounds the other file
 * kinds a model folder holds. Crafted files are built here; the cases that
 * decode or load run in a fresh process each, with peak memory measured:
 * Chromium's for textures, the process's own for the rest.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildSync } from "esbuild";
import {
  checkTextures,
  DEFAULT_TEXTURE_LIMITS,
  readTextureHeader,
  resolveTextureLimits,
  TextureFormatError,
  TextureLimitError,
} from "../src/core/image/texture-limits.js";
import { craftHeader, craftPng, pngWithData } from "./support/texture-bombs.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";
import { loadPlaywright, launchChromium } from "../tools/lib/browser.js";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";

const root = resolve(__dirname, "..");
const MiB = 2 ** 20;
let hasBrowser = existsSync(join(root, "dist/web/harness.html"));
try {
  loadPlaywright();
} catch {
  hasBrowser = false;
}

const errorOf = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
};

describe("texture headers, read without decoding", () => {
  it("reads what a PNG declares", () => {
    const h = readTextureHeader("t.png", craftPng({ width: 300, height: 200 }));
    expect(h).toEqual({ width: 300, height: 200, format: "png" });
  });

  it("reads what JPEG, WebP, GIF, BMP and ICO files declare", () => {
    const cases = [
      [craftHeader("jpeg", 300, 200, 300), "jpeg"],
      [craftHeader("jpeg-progressive", 300, 200), "jpeg"],
      [craftHeader("webp", 300, 200), "webp"],
      [craftHeader("webp-lossless", 300, 200), "webp"],
      [craftHeader("gif", 300, 200), "gif"],
      [craftHeader("bmp", 300, 200, 900 * 200), "bmp"],
      [craftHeader("ico", 300, 200), "ico"],
    ] as const;
    for (const [bytes, format] of cases)
      expect(readTextureHeader("t", bytes), format).toEqual({ width: 300, height: 200, format });
  });

  it("each format past the caps is refused before decoding", () => {
    for (const f of ["jpeg-progressive", "webp", "gif", "ico"] as const) {
      const e = errorOf(() => checkTextures([{ path: f, bytes: craftHeader(f, 30000, 30000) }]));
      expect(e, f).toBeInstanceOf(TextureLimitError);
      expect(e).toMatchObject({ kind: "side", width: 30000, height: 30000 });
    }
  });

  it("a file too short for what it declares, where the format makes that a bound", () => {
    // Sequential JPEG: two bits for each 8 × 8 block. 30,000² in 300 bytes is far too few.
    expect(() => readTextureHeader("t", craftHeader("jpeg", 30000, 30000, 300))).toThrow(
      /declares 30000×30000 pixels but is \d+ bytes, too few for a JPEG file/,
    );
    // Uncompressed BMP: every pixel.
    expect(() => readTextureHeader("t", craftHeader("bmp", 2000, 2000, 100))).toThrow(
      /too few for a BMP file/,
    );
    // Progressive JPEG and WebP can code a large image in a few bytes: only the caps bound them.
    expect(readTextureHeader("t", craftHeader("jpeg-progressive", 8000, 8000))).toMatchObject({
      width: 8000,
    });
  });

  it("refuses formats whose declared size it does not read, naming them", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    for (const [bytes, name] of [
      [enc("\0\0\0\x1cftypavif" + "\0".repeat(40)), "AVIF or HEIF"],
      [enc("II*\0" + "\0".repeat(40)), "TIFF"],
      [enc('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="8"/>'), "SVG"],
    ] as const) {
      const e = errorOf(() => readTextureHeader("t", bytes));
      expect(e).toBeInstanceOf(TextureFormatError);
      expect((e as Error).message).toContain(
        `a ${name} image, whose declared size Mochi2D does not read`,
      );
    }
    expect(() => readTextureHeader("t", new Uint8Array(64))).toThrow(
      /not an image file Mochi2D reads/,
    );
  });

  it("refuses a header PNG doesn't allow", () => {
    const bad = craftPng({ width: 4, height: 4, colorType: 2, bitDepth: 4 });
    expect(() => readTextureHeader("t", bad)).toThrow(/damaged PNG header/);
  });

  it("refuses a header whose data is too short to hold what it declares", () => {
    const e = errorOf(() => readTextureHeader("t.png", pngWithData(30000, 30000, 1024)));
    expect(e).toBeInstanceOf(TextureFormatError);
    expect((e as Error).message).toMatch(
      /declares 30000×30000 pixels but is \d+ bytes, too few for a PNG file/,
    );
    // Honest files of extreme ratios pass: 8192² of zeros is about 70 KB.
    expect(() => readTextureHeader("t", craftPng({ width: 8192, height: 8192 }))).not.toThrow();
  });
});

describe("the caps", () => {
  const tiny30k = craftPng({ width: 30000, height: 30000 });

  it("a tiny PNG declaring 30,000²: over the side cap, by default", () => {
    expect(tiny30k.length).toBeLessThan(2 * MiB);
    const e = errorOf(() => checkTextures([{ path: "big.png", bytes: tiny30k }]));
    expect(e).toBeInstanceOf(TextureLimitError);
    expect(e).toMatchObject({
      name: "TextureLimitError",
      path: "big.png",
      kind: "side",
      limit: DEFAULT_TEXTURE_LIMITS.maxSide,
      size: 30000,
      width: 30000,
      height: 30000,
    });
  });

  it("the pixel cap, and the model's total", () => {
    const t = craftPng({ width: 4096, height: 2048 });
    expect(
      errorOf(() => checkTextures([{ path: "a", bytes: t }], { maxPixels: 2 ** 22 })),
    ).toMatchObject({
      kind: "pixels",
      size: 2 ** 23,
    });
    const set = [0, 1, 2].map((i) => ({ path: `t${i}.png`, bytes: t }));
    expect(checkTextures(set.slice(0, 2), { maxTotalPixels: 2 ** 24 })).toHaveLength(2);
    expect(errorOf(() => checkTextures(set, { maxTotalPixels: 2 ** 24 }))).toMatchObject({
      kind: "total",
      path: "t2.png",
      limit: 2 ** 24,
      size: 3 * 2 ** 23,
    });
  });

  it("caps are numbers ≥ 0; Infinity turns one off", () => {
    for (const bad of [-1, Number.NaN, "5" as unknown as number])
      expect(() => resolveTextureLimits({ maxSide: bad })).toThrow(RangeError);
    expect(resolveTextureLimits({})).toEqual(DEFAULT_TEXTURE_LIMITS);
    expect(Object.isFrozen(DEFAULT_TEXTURE_LIMITS)).toBe(true);
    expect(() =>
      checkTextures([{ path: "big.png", bytes: tiny30k }], {
        maxSide: Infinity,
        maxPixels: Infinity,
        maxTotalPixels: Infinity,
      }),
    ).not.toThrow();
  });
});

describe("genuine models pass the defaults", () => {
  /** Every model's listed textures under `dir`, by settings file. */
  const modelsUnder = (dir: string) => {
    const out: { name: string; files: { path: string; bytes: Uint8Array }[] }[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".model3.json")) {
          const s = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
          const files = (s.FileReferences?.Textures ?? []).map((t: string) => ({
            path: t,
            bytes: readFileSync(join(dirname(p), t)),
          }));
          out.push({ name: p, files });
        }
      }
    };
    walk(dir);
    return out;
  };

  it("the sample «Mochi»", () => {
    for (const m of modelsUnder(join(root, "samples/mochi")))
      expect(checkTextures(m.files)).toHaveLength(1);
  });

  it.runIf(HAVE_DEEPSEEK)("DeepSeek-chan", () => {
    for (const m of modelsUnder(DEEPSEEK)) expect(checkTextures(m.files).length).toBeGreaterThan(0);
  });

  // Downloaded models (gitignored), when present.
  const extracted = join(root, "assets/models/incoming/extracted");
  it.runIf(existsSync(extracted))(
    "the downloaded models, also under the caps for strangers",
    () => {
      const models = modelsUnder(extracted);
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        checkTextures(m.files);
        checkTextures(m.files, { maxSide: 8192, maxPixels: 2 ** 26, maxTotalPixels: 2 ** 28 });
      }
    },
  );
});

describe.skipIf(!hasBrowser)(
  "crafted files, each in a fresh process (peak memory measured)",
  () => {
    let dir: string;
    let child: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "mochi2d-texture-"));
      child = join(dir, "child.mjs");
      buildSync({
        entryPoints: [join(root, "test/support/texture-limits-child.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: child,
        logLevel: "error",
        external: ["playwright", "playwright-core"],
      });
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    interface Outcome {
      error?: Record<string, unknown> & { name: string; message: string };
      rendered?: string;
      result?: string;
      ms: number;
      browserRise?: number;
      ownRise?: number;
    }
    const run = (name: string): Outcome => {
      const r = spawnSync(process.execPath, ["--expose-gc", child, name, root], {
        encoding: "utf8",
        timeout: 170_000,
        env: { ...process.env, NODE_PATH: join(root, "node_modules") },
      });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Outcome;
    };

    for (const via of ["folder", "zip", "url"])
      it(`a small PNG declaring 20,000², from a ${via}: refused before decoding`, () => {
        const o = run(`huge:${via}`);
        expect(o.error).toMatchObject({
          name: "TextureLimitError",
          kind: "side",
          limit: 16384,
          width: 20000,
          height: 20000,
          path: "crafted_0.png",
        });
        expect(o.browserRise).toBeLessThan(32 * MiB);
      }, 180_000);

    it("textures each under the caps, together over the total", () => {
      const o = run("total");
      expect(o.error).toMatchObject({
        name: "TextureLimitError",
        kind: "total",
        path: "crafted_2.png",
      });
      expect(o.browserRise).toBeLessThan(32 * MiB);
    }, 180_000);

    it("a header that declares more than its data holds: refused before decoding", () => {
      const o = run("lie-big-tiny");
      expect(o.error).toMatchObject({ name: "TextureFormatError", path: "crafted_0.png" });
      expect(o.error!.message).toMatch(/too few for a PNG file of that size/);
      expect(o.browserRise).toBeLessThan(32 * MiB);
    }, 180_000);

    it("one whose data passes that check but lacks rows: the decode fails, bounded by the declared size", () => {
      const o = run("lie-big-rows");
      expect(o.error).toMatchObject({ name: "TextureFormatError", path: "crafted_0.png" });
      expect(o.error!.message).toMatch(/could not be decoded/);
      // Chromium allocates the declared 8192² (256 MiB as RGBA), and no more.
      expect(o.browserRise).toBeLessThan(400 * MiB);
    }, 180_000);

    it("a header that declares less than its data holds: decoded at the declared size", () => {
      const o = run("lie-small");
      expect(o.error).toBeUndefined();
      expect(o.rendered).toBe("64x64");
      expect(o.browserRise).toBeLessThan(32 * MiB);
    }, 180_000);

    it("without caps, a texture costs its declared size even when drawn small", () => {
      // 8000² decodes at full size (244 MiB as RGBA) before it is scaled down to 1024².
      const o = run("uncapped");
      expect(o.rendered).toBe("64x64");
      expect(o.browserRise).toBeGreaterThan(200 * MiB);
      // The caps recommended for strangers' models refuse it, for almost nothing.
      const s = run("stranger");
      expect(s.error).toMatchObject({ name: "TextureLimitError", kind: "side", limit: 4096 });
      expect(s.browserRise).toBeLessThan(32 * MiB);
    }, 360_000);

    it("a WAV whose data chunk declares 4 GiB: read to the end of the file", () => {
      const o = run("wav-length");
      expect(o.error).toBeUndefined();
      expect(o.result).toBe("500 and 500 frames");
      expect(o.ownRise).toBeLessThan(16 * MiB);
    }, 60_000);

    it("motion and physics files whose Meta declares billions: refused at once", () => {
      for (const name of ["motion-counts", "physics-counts"]) {
        const o = run(name);
        expect(o.error?.name).toBe("AnimationFormatError");
        expect(o.error!.message).toMatch(/is 2000000000, but the file has/);
        expect(o.ownRise).toBeLessThan(16 * MiB);
      }
    }, 60_000);

    it("a .moc3 whose counts reach far past the file: refused at once", () => {
      const o = run("moc-count");
      expect(o.error?.name).toBe("MocFormatError");
      expect(o.error!.message).toMatch(/extends past end of file/);
      expect(o.ownRise).toBeLessThan(16 * MiB);
    }, 60_000);
  },
);

describe.skipIf(!hasBrowser)(
  "the caps in a page: MochiView.load and addItem (headless Chromium)",
  () => {
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

    it("refuses with the typed error, and loads with the defaults", async () => {
      const big = Array.from(craftPng({ width: 20000, height: 20000 }));
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
      const fields = (e) => ({ name: e.name, kind: e.kind, limit: e.limit, width: e.width, path: e.path, isLimit: e instanceof lib.TextureLimitError });
      const model = await view.load(url);
      const ok = model.parameters.length;
      let capped = null;
      try { await view.load(url, { textures: { maxSide: 1024 } }); } catch (e) { capped = fields(e); }
      let item = null;
      try { await view.addItem(url, { textures: { maxPixels: 1000 } }); } catch (e) { item = fields(e); }
      // A model held in memory whose texture declares 20,000²: refused before decoding.
      const files = {};
      for (const f of ["mochi.model3.json", "mochi.moc3", "mochi.physics3.json", "mochi.cdi3.json", "motions/idle.motion3.json"])
        files[f] = new Uint8Array(await (await fetch(base + "samples/mochi/" + f)).arrayBuffer());
      files["mochi.4096/texture_00.png"] = new Uint8Array(${JSON.stringify(big)});
      let crafted = null;
      try { await view.load({ files }); } catch (e) { crafted = fields(e); }
      const still = view.model === model;
      view.dispose();
      return { ok, capped, item, crafted, still };
    })()`)) as Record<string, unknown>;
      expect(result.ok).toBe(5);
      expect(result.capped).toEqual({
        name: "TextureLimitError",
        kind: "side",
        limit: 1024,
        width: 2048,
        path: "mochi.4096/texture_00.png",
        isLimit: true,
      });
      expect(result.item).toMatchObject({ name: "TextureLimitError", kind: "pixels", limit: 1000 });
      expect(result.crafted).toMatchObject({
        name: "TextureLimitError",
        kind: "side",
        width: 20000,
      });
      // A refused load leaves the model shown before.
      expect(result.still).toBe(true);
    }, 120000);

    it("loads textures in each format the browser decodes, and refuses each past the caps", async () => {
      const crafted = Object.fromEntries(
        (["jpeg-progressive", "webp", "gif", "bmp", "ico"] as const).map((f) => [
          f,
          Array.from(craftHeader(f, 30000, 30000, f === "bmp" ? 0 : 64)),
        ]),
      );
      const result = (await page.evaluate(`(async () => {
        const base = ${JSON.stringify(server.url)};
        const lib = await import(base + "dist/lib/mochi2d.js");
        const canvas = document.createElement("canvas");
        canvas.style.width = "200px";
        canvas.style.height = "200px";
        document.body.append(canvas);
        const view = new lib.MochiView(canvas);
        const files = {};
        for (const f of ["mochi.model3.json", "mochi.moc3", "mochi.physics3.json", "mochi.cdi3.json", "motions/idle.motion3.json"])
          files[f] = new Uint8Array(await (await fetch(base + "samples/mochi/" + f)).arrayBuffer());
        const c = new OffscreenCanvas(256, 64);
        const g = c.getContext("2d");
        g.fillStyle = "#c08040";
        g.fillRect(0, 0, 256, 64);
        const encoded = async (type) => new Uint8Array(await (await c.convertToBlob({ type })).arrayBuffer());
        // Small genuine files of the other formats, built by hand.
        const bmp = (() => { const w = 3, h = 2, stride = 12, size = 54 + stride * h; const b = new Uint8Array(size); const d = new DataView(b.buffer); b[0] = 66; b[1] = 77; d.setUint32(2, size, true); d.setUint32(10, 54, true); d.setUint32(14, 40, true); d.setInt32(18, w, true); d.setInt32(22, h, true); d.setUint16(26, 1, true); d.setUint16(28, 24, true); return b; })();
        const ico = (() => { const w = 4, h = 4; const dib = new Uint8Array(40 + w * h * 4 + 4 * h); const dv = new DataView(dib.buffer); dv.setUint32(0, 40, true); dv.setInt32(4, w, true); dv.setInt32(8, h * 2, true); dv.setUint16(12, 1, true); dv.setUint16(14, 32, true); const all = new Uint8Array(22 + dib.length); const hv = new DataView(all.buffer); hv.setUint16(2, 1, true); hv.setUint16(4, 1, true); all[6] = w; all[7] = h; hv.setUint16(10, 1, true); hv.setUint16(12, 32, true); hv.setUint32(14, dib.length, true); hv.setUint32(18, 22, true); all.set(dib, 22); return all; })();
        const gif = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (x) => x.charCodeAt(0));
        const genuine = { jpeg: await encoded("image/jpeg"), webp: await encoded("image/webp"), gif, bmp, ico };
        const loaded = {};
        for (const [name, bytes] of Object.entries(genuine)) {
          try {
            const m = await view.load({ files: { ...files, "mochi.4096/texture_00.png": bytes } });
            loaded[name] = m.parameters.length;
          } catch (e) { loaded[name] = e.name + ": " + e.message; }
        }
        const refused = {};
        const crafted = ${JSON.stringify(crafted)};
        for (const [name, bytes] of Object.entries(crafted)) {
          try { await view.load({ files: { ...files, "mochi.4096/texture_00.png": new Uint8Array(bytes) } }); refused[name] = "loaded"; }
          catch (e) { refused[name] = e.name + " " + e.kind; }
        }
        view.dispose();
        return { loaded, refused };
      })()`)) as { loaded: Record<string, unknown>; refused: Record<string, string> };
      expect(result.loaded).toEqual({ jpeg: 5, webp: 5, gif: 5, bmp: 5, ico: 5 });
      expect(result.refused).toEqual({
        "jpeg-progressive": "TextureLimitError side",
        webp: "TextureLimitError side",
        gif: "TextureLimitError side",
        // An uncompressed BMP must hold every pixel: refused as too short before the caps.
        bmp: "TextureFormatError undefined",
        ico: "TextureLimitError side",
      });
    }, 120000);
  },
);

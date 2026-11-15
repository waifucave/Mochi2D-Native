/**
 * Textures updated in place (`updateTexture`, not reference behavior), in
 * headless Chromium: a texture replaced wholly or in a region equals, texel
 * for texel at every mip level, the texture of the same model loaded from a
 * file with the new pixels, for the main model and for an item; the change
 * shows in the next frame, and regions that don't fit are refused. Needs
 * `npm run build:lib` and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { encodePng } from "../tools/lib/png.js";
import { Synth } from "./support/synth.js";

const root = resolve(__dirname, "..");
let available = existsSync(join(root, "dist", "lib", "mochi2d.js"));
try {
  loadPlaywright();
} catch {
  available = false;
}

const W = 8;
const H = 8;

/** Straight RGBA8 noise with every kind of alpha (0, 255 and in between). */
function noise(seed: number, w = W, h = H): Uint8Array {
  let s = seed >>> 0;
  const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24;
  const out = new Uint8Array(4 * w * h);
  for (let i = 0; i < out.length; i++) out[i] = next();
  for (let i = 3; i < out.length; i += 16) out[i] = 0;
  for (let i = 7; i < out.length; i += 16) out[i] = 255;
  return out;
}

/** `base` with `patch` (pw × ph) written at (x, y). */
function compose(
  base: Uint8Array,
  patch: Uint8Array,
  pw: number,
  ph: number,
  x: number,
  y: number,
) {
  const out = base.slice();
  for (let r = 0; r < ph; r++)
    out.set(patch.subarray(4 * pw * r, 4 * pw * (r + 1)), 4 * (W * (y + r) + x));
  return out;
}

/** A one-mesh model showing an 8 × 8 texture over its canvas: its files, by path. */
function model(tex: Uint8Array): Record<string, number[] | string> {
  const s = new Synth(5);
  s.canvas = { pixelsPerUnit: 100, originX: 100, originY: 100, width: 200, height: 200, flags: 0 };
  s.part({ id: "Root" });
  s.mesh({
    id: "Q",
    uvs: [0, 1, 1, 1, 0, 0, 1, 0],
    triangles: [0, 1, 2, 1, 3, 2],
    keyforms: [{ positions: [-0.9, -0.9, 0.9, -0.9, -0.9, 0.9, 0.9, 0.9] }],
  });
  return {
    "m.model3.json": JSON.stringify({
      Version: 3,
      FileReferences: { Moc: "m.moc3", Textures: ["t.png"] },
    }),
    "m.moc3": Array.from(s.build()),
    "t.png": Array.from(encodePng({ width: W, height: H, data: tex })),
  };
}

describe.skipIf(!available)("textures updated in place (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const run = <R>(src: string, arg?: unknown): Promise<R> =>
    page.evaluate(([s, a]) => new Function("arg", `return (${s})(arg)`)(a) as Promise<R>, [
      src,
      arg,
    ] as const);

  beforeAll(async () => {
    server = await startStaticServer(root, root);
    browser = await launchChromium();
    page = await browser.newPage({ viewport: { width: 200, height: 200 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("test/support/blank.html", server.url).href, { waitUntil: "load" });
    await run(`async () => {
      const lib = await import(new URL("/dist/lib/mochi2d.js", location.href).href);
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "width: 200px; height: 200px; display: block";
      document.body.append(canvas);
      const view = new lib.MochiView(canvas, {
        look: "off", autoStart: false, maxPixelRatio: 1, background: "#000000",
      });
      const files = (f) => ({ files: Object.fromEntries(Object.entries(f).map(([k, v]) =>
        [k, typeof v === "string" ? v : Uint8Array.from(v)])) });
      /** Every mip level of a live model's texture 0, as arrays of RGBA bytes. */
      const levels = (live) => {
        const gl = view.stage.gl;
        const t = live.textures[0].texture;
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        const out = [];
        for (let level = 0, w = t.width, h = t.height; ; level++) {
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.texture, level);
          const px = new Uint8Array(4 * w * h);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          out.push([...px]);
          if (w === 1 && h === 1) break;
          w = Math.max(1, w >> 1);
          h = Math.max(1, h >> 1);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        return out;
      };
      window.t = { lib, view, files, levels };
    }`);
  }, 180000);

  afterAll(async () => {
    expect(errors).toEqual([]);
    await browser?.close();
    await server?.close();
  }, 60000);

  const A = noise(1);
  const B = noise(2);
  const P = noise(3, 3, 2);
  const AP = compose(A, P, 3, 2, 4, 5);
  const BP = compose(B, P, 3, 2, 4, 5);

  it("equals a fresh load of the new pixels at every mip level, wholly and in a region", async () => {
    const r = await run<Record<string, unknown>>(
      `async ({ a, b, rawB, p, ap, bp }) => {
        const { view, files, levels } = window.t;
        const main = await view.load(files(a));
        const item = await view.addItem(files(a));
        const textures = main.textures;
        // A region of the main model's texture; the whole item texture, then a region of it.
        main.updateTexture(0, { width: 3, height: 2, data: Uint8Array.from(p) }, { x: 4, y: 5 });
        item.updateTexture(0, { width: 8, height: 8, data: Uint8Array.from(rawB) });
        const itemWhole = levels(item.entry.live);
        item.updateTexture(0, { width: 3, height: 2, data: Uint8Array.from(p) }, { x: 4, y: 5 });
        const got = { main: levels(main.live), itemWhole, itemRegion: levels(item.entry.live) };
        // The same pixels loaded from files.
        const want = {};
        for (const [k, f] of [["ap", ap], ["b", b], ["bp", bp]]) {
          const x = await view.addItem(files(f));
          want[k] = levels(x.entry.live);
          x.dispose();
        }
        return { textures, got, want };
      }`,
      {
        a: model(A),
        b: model(B),
        rawB: Array.from(B),
        p: Array.from(P),
        ap: model(AP),
        bp: model(BP),
      },
    );
    expect(r.textures).toEqual([
      { label: "t.png", width: 8, height: 8, originalWidth: 8, originalHeight: 8 },
    ]);
    const got = r.got as Record<string, number[][]>;
    const want = r.want as Record<string, number[][]>;
    expect(got.main!.length).toBe(4); // 8, 4, 2, 1
    expect(got.main).toEqual(want.ap);
    expect(got.itemWhole).toEqual(want.b);
    expect(got.itemRegion).toEqual(want.bp);
  }, 120000);

  it("shows from the next frame, and refuses what doesn't fit", async () => {
    const r = await run<Record<string, unknown>>(
      `async ({ a, rawB }) => {
        const { view, files } = window.t;
        for (const i of [...view.items]) i.dispose();
        const main = await view.load(files(a));
        const pixel = async () => {
          const p = view.screenshot();
          view.advance(0);
          const img = await createImageBitmap(await p);
          const c = new OffscreenCanvas(img.width, img.height).getContext("2d");
          c.drawImage(img, 0, 0);
          return [...c.getImageData(100, 100, 1, 1).data];
        };
        view.advance(0);
        const before = await pixel();
        main.updateTexture(0, { width: 8, height: 8, data: Uint8Array.from(rawB) });
        const after = await pixel();
        const refused = [];
        for (const [img, at] of [
          [{ width: 9, height: 8, data: new Uint8Array(4 * 72) }, undefined],
          [{ width: 2, height: 2, data: new Uint8Array(16) }, { x: 7, y: 0 }],
          [{ width: 2, height: 2, data: new Uint8Array(16) }, { x: -1, y: 0 }],
          [{ width: 2, height: 2, data: new Uint8Array(16) }, { x: 0.5, y: 0 }],
        ])
          try { main.updateTexture(0, img, at); refused.push(false); }
          catch (e) { refused.push(e instanceof RangeError); }
        let badIndex = false;
        try { main.updateTexture(1, { width: 1, height: 1, data: new Uint8Array(4) }); }
        catch (e) { badIndex = e instanceof RangeError; }
        return { before, after, refused, badIndex };
      }`,
      { a: model(A), rawB: Array.from(B) },
    );
    expect(r.after).not.toEqual(r.before);
    expect(r.refused).toEqual([true, true, true, true]);
    expect(r.badIndex).toBe(true);
  }, 120000);
});

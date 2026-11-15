/**
 * `mochi2d/pixi` in headless Chromium with PixiJS v8 and DeepSeek-chan: a
 * MochiSprite in a Pixi scene against Mochi2D's own view at the same
 * framing, under a container's transform, alpha and mask, with Pixi's
 * pointer events and ticker. Needs `npm run build:lib`, pixi.js (a dev
 * dependency) and the pre-installed Playwright; skipped otherwise.
 *
 * The scenes place the sprite so that its texture's pixels fall on the
 * canvas's pixels (DeepSeek-chan's canvas is 3749 × 7697, so at 1/16 the
 * texture is 235 × 482 and sits at a fraction of a pixel): Pixi then copies
 * the texture's values, and the pictures can be compared value for value.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { DEEPSEEK_SETTINGS, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
let available =
  HAVE_DEEPSEEK &&
  existsSync(join(root, "dist", "lib", "pixi.js")) &&
  existsSync(join(root, "node_modules", "pixi.js", "dist", "pixi.mjs"));
try {
  loadPlaywright();
} catch {
  available = false;
}

/** How two pictures differ: the largest difference of a value, and how many values differ. */
interface Diff {
  max: number;
  count: number;
  /** Pixels with any alpha in the reference (the model is there). */
  covered: number;
}

describe.skipIf(!available)("mochi2d/pixi (headless Chromium, PixiJS v8)", () => {
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
    page = await browser.newPage({ viewport: { width: 600, height: 600 } });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(new URL("test/support/pixi.html", server.url).href, { waitUntil: "load" });
    const url = "/" + relative(root, DEEPSEEK_SETTINGS).split("\\").join("/");
    await run(
      `async (url) => {
        const PIXI = await import("pixi.js");
        const lib = await import(new URL("/dist/lib/pixi.js", location.href).href);
        const t = (window.t = { PIXI, lib, url: new URL(url, location.href).href });
        /** The default framebuffer's pixels, top row first. */
        t.read = (gl, w, h) => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          const b = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
          const out = new Uint8Array(w * h * 4);
          for (let y = 0; y < h; y++) out.set(b.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
          return out;
        };
        /** A Pixi application of w × h pixels on a transparent background, rendered by hand. */
        t.app = async (w, h) => {
          const app = new PIXI.Application();
          await app.init({
            width: w, height: h, backgroundAlpha: 0, antialias: false, resolution: 1,
            preference: "webgl", autoStart: false, preserveDrawingBuffer: true,
          });
          app.canvas.style.cssText = "position: fixed; left: 0; top: 0";
          document.body.append(app.canvas);
          return app;
        };
        /** Mochi2D's own view of the model, w × h pixels at k image pixels per model unit. */
        t.reference = async (w, h, k) => {
          const canvas = document.createElement("canvas");
          canvas.style.cssText = "position: fixed; left: 0; top: 0; width: " + w + "px; height: " + h + "px; visibility: hidden";
          document.body.append(canvas);
          const view = new lib.MochiView(canvas, {
            look: "off", autoStart: false, maxPixelRatio: 1, antialias: false, fit: 1,
          });
          await view.load(t.url);
          view.resize();
          view.setView({ zoom: k / view.viewTransform.pixelsPerUnit });
          view.advance(0);
          const px = t.read(view.stage.gl, canvas.width, canvas.height);
          const size = [canvas.width, canvas.height];
          view.dispose();
          canvas.remove();
          return { px, size };
        };
        t.diff = (a, b) => {
          let max = 0, count = 0, covered = 0;
          for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d) count++;
            if (d > max) max = d;
            if (i % 4 === 3 && b[i]) covered++;
          }
          return { max, count, covered };
        };
        t.sprite = (options = {}) => lib.MochiSprite.from(t.url, {
          renderer: t.current.renderer, ticker: null, look: "off", ...options,
        });
      }`,
      url,
    );
  }, 180000);

  afterAll(async () => {
    expect(errors).toEqual([]);
    await browser?.close();
    await server?.close();
  }, 60000);

  it("draws the same pixels as Mochi2D's own view at the same framing", async () => {
    const r = await run<{ diff: Diff; size: number[]; own: Diff; local: number[] }>(`async () => {
      const t = window.t;
      const cw = 3749, ch = 7697, s = 1 / 16;
      const W = Math.ceil(cw * s), H = Math.ceil(ch * s);
      const ref = await t.reference(W, H, 3749 * s);
      const app = (t.current = await t.app(W, H));
      const place = (sprite) => {
        sprite.scale.set(s);
        sprite.position.set(W / 2 - (cw * s) / 2, H / 2 - (ch * s) / 2);
        app.stage.addChild(sprite);
      };
      const sprite = await t.sprite();
      place(sprite);
      app.render();
      const diff = t.diff(t.read(app.renderer.gl, W, H), ref.px);
      const local = [sprite.canvasWidth, sprite.canvasHeight];
      sprite.destroy();
      // A WebGL context of the sprite's own (as with a WebGPU renderer).
      const own = await t.sprite({ context: "own" });
      place(own);
      app.render();
      const ownDiff = t.diff(t.read(app.renderer.gl, W, H), ref.px);
      own.destroy();
      return { diff, size: ref.size, own: ownDiff, local };
    }`);
    expect(r.size).toEqual([235, 482]);
    expect(r.local).toEqual([3749, 7697]);
    expect(r.diff.covered).toBeGreaterThan(20000);
    expect(r.diff).toMatchObject({ max: 0, count: 0 });
    // The canvas upload un- and re-premultiplies: within a level.
    expect(r.own.max).toBeLessThanOrEqual(1);
  }, 120000);

  it("takes its transform, alpha and mask from Pixi", async () => {
    const r = await run<{
      turned: Diff;
      alpha: Diff;
      masked: Diff;
      square: number[];
    }>(`async () => {
      const t = window.t;
      const { Container, Graphics } = t.PIXI;
      const cw = 3749, ch = 7697;
      // Turned: a container scaled by 1/2 and turned a quarter clockwise; the sprite at 1/16 in it.
      const W2 = Math.ceil(cw / 32), H2 = Math.ceil(ch / 32);
      const ref2 = await t.reference(W2, H2, 3749 / 32);
      const app2 = (t.current = await t.app(H2, W2));
      const box = new Container({ scale: 0.5, rotation: Math.PI / 2, position: { x: H2, y: 0 } });
      const turnedSprite = await t.sprite();
      turnedSprite.scale.set(1 / 16);
      turnedSprite.position.set(W2 - cw / 32, H2 - ch / 32);
      box.addChild(turnedSprite);
      app2.stage.addChild(box);
      app2.render();
      const got = t.read(app2.renderer.gl, H2, W2);
      // Reference pixel (x, y) lands on (H2 − 1 − y, x).
      const want = new Uint8Array(got.length);
      for (let y = 0; y < H2; y++)
        for (let x = 0; x < W2; x++)
          want.set(ref2.px.subarray((y * W2 + x) * 4, (y * W2 + x) * 4 + 4), (x * H2 + (H2 - 1 - y)) * 4);
      const turned = t.diff(got, want);
      app2.destroy(true);
      document.querySelectorAll("canvas").forEach((c) => c.remove());

      // Alpha and mask at 1/16, with a Pixi square drawn next to the model.
      const s = 1 / 16, W = Math.ceil(cw * s), H = Math.ceil(ch * s);
      const ref = await t.reference(W, H, 3749 * s);
      const app = (t.current = await t.app(W, H));
      const faded = new Container({ alpha: 0.5 });
      const sprite = await t.sprite();
      sprite.scale.set(s);
      sprite.position.set(W / 2 - (cw * s) / 2, H / 2 - (ch * s) / 2);
      faded.addChild(sprite);
      app.stage.addChild(faded);
      const square = new Graphics().rect(0, 0, 4, 4).fill(0xff0000);
      app.stage.addChild(square);
      app.render();
      const half = ref.px.map((v) => Math.round(v * 0.5));
      const fadedPx = t.read(app.renderer.gl, W, H);
      const squarePx = [...fadedPx.subarray(4 * (W + 1), 4 * (W + 1) + 4)];
      // Outside the square, the faded model; the square's own pixels are left out.
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        fadedPx.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 4);
        half.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 4);
      }
      const alpha = t.diff(fadedPx, half);
      // A mask over the left half.
      faded.alpha = 1;
      square.visible = false;
      const cut = Math.floor(W / 2);
      const mask = new Graphics().rect(0, 0, cut, H).fill(0xffffff);
      app.stage.addChild(mask);
      sprite.mask = mask;
      app.render();
      const left = ref.px.slice();
      for (let y = 0; y < H; y++) left.fill(0, (y * W + cut) * 4, (y + 1) * W * 4);
      const masked = t.diff(t.read(app.renderer.gl, W, H), left);
      return { turned, alpha, masked, square: squarePx };
    }`);
    expect(r.turned.covered).toBeGreaterThan(5000);
    expect(r.turned).toMatchObject({ max: 0, count: 0 });
    // Pixi multiplies the premultiplied texture by the alpha: within a level of half.
    expect(r.alpha.max).toBeLessThanOrEqual(1);
    expect(r.square).toEqual([255, 0, 0, 255]);
    expect(r.masked).toMatchObject({ max: 0, count: 0 });
  }, 120000);

  it("hit tests through Pixi's pointer events, follows the ticker and is destroyed cleanly", async () => {
    const r = await run<{
      mesh: string | null;
      empty: string | null;
      hits: string[][];
      taps: number;
      ticked: boolean;
      manual: boolean;
      after: number;
    }>(`async () => {
      const t = window.t;
      const app = t.current;
      app.stage.removeChildren().forEach((c) => c.destroy());
      const cw = 3749, ch = 7697, s = 1 / 16;
      // DeepSeek-chan's settings with a hit area on the art mesh at the picture's middle.
      const probe = await t.sprite();
      probe.scale.set(s);
      app.stage.addChild(probe);
      app.render();
      const at = { x: (cw * s) / 2, y: (ch * s) / 2 };
      const mesh = probe.meshAtPoint(at);
      const empty = probe.meshAtPoint({ x: 1, y: 1 });
      const folder = t.url.slice(0, t.url.lastIndexOf("/") + 1);
      const settings = await (await fetch(t.url)).json();
      settings.HitAreas = [{ Id: mesh, Name: "Middle" }];
      const files = { [t.url.slice(folder.length)]: JSON.stringify(settings) };
      const refs = settings.FileReferences;
      for (const p of [refs.Moc, ...refs.Textures, refs.Physics, refs.DisplayInfo].filter(Boolean))
        files[p] = new Uint8Array(await (await fetch(new URL(p, folder))).arrayBuffer());
      probe.destroy();
      const ticker = new t.PIXI.Ticker();
      ticker.autoStart = false;
      const sprite = await t.lib.MochiSprite.from({ files }, {
        renderer: app.renderer, ticker, look: "off",
      });
      sprite.scale.set(s);
      app.stage.addChild(sprite);
      app.render();
      const hits = [];
      let taps = 0;
      sprite.on("hit", (e) => hits.push(e.areas));
      sprite.on("pointertap", () => taps++);
      window.t.sprite2 = sprite;
      // The ticker advances the animation; without it, update() does.
      const before = sprite.model.runtime.lastFrame;
      ticker.update(performance.now() + 1000 / 60);
      const ticked = sprite.model.runtime.lastFrame !== before;
      sprite.setTicker(null);
      const mid = sprite.model.runtime.lastFrame;
      ticker.update(performance.now() + 2000 / 60);
      sprite.update(1 / 60);
      const manual = sprite.model.runtime.lastFrame !== mid;
      window.t.result = { mesh, empty, hits, ticked, manual, get taps() { return taps; } };
      return { mesh, empty, hits, taps, ticked, manual, after: 0 };
    }`);
    expect(r.mesh).not.toBeNull();
    expect(r.empty).toBeNull();
    expect(r.ticked).toBe(true);
    expect(r.manual).toBe(true);
    // A click on the middle, then one on an empty corner.
    await page.mouse.click(Math.round((3749 / 16) * 0.5), Math.round((7697 / 16) * 0.5));
    await page.mouse.click(1, 1);
    const after = await run<{ hits: string[][]; taps: number; errors: number }>(`async () => {
      const t = window.t;
      const { hits, taps } = t.result;
      t.sprite2.destroy();
      t.current.render();
      t.current.destroy(true);
      return { hits, taps, errors: 0 };
    }`);
    expect(after.hits).toEqual([["Middle"]]);
    expect(after.taps).toBe(1);
  }, 120000);

  it("loads its textures again after Pixi's WebGL context is lost and restored", async () => {
    const r = await run<{ diff: Diff; events: string[] }>(`async () => {
      const t = window.t;
      const cw = 3749, ch = 7697, s = 1 / 16;
      const W = Math.ceil(cw * s), H = Math.ceil(ch * s);
      document.querySelectorAll("canvas").forEach((c) => c.remove());
      const app = (t.current = await t.app(W, H));
      const sprite = await t.sprite();
      sprite.scale.set(s);
      sprite.position.set(W / 2 - (cw * s) / 2, H / 2 - (ch * s) / 2);
      app.stage.addChild(sprite);
      app.render();
      const before = t.read(app.renderer.gl, W, H);
      const events = [];
      const restored = new Promise((resolve) => sprite.once("contextrestored", () => { events.push("restored"); resolve(); }));
      sprite.on("error", (e) => events.push("error: " + e.error));
      const gl = app.renderer.gl;
      const ext = gl.getExtension("WEBGL_lose_context");
      const lost = new Promise((resolve) => app.canvas.addEventListener("webglcontextlost", resolve, { once: true }));
      ext.loseContext();
      await lost;
      app.render(); // nothing to draw on a lost context: no errors
      // Restoring right inside the lost event's turn is ignored: wait a little.
      await new Promise((r) => setTimeout(r, 100));
      ext.restoreContext();
      await restored;
      app.render();
      const diff = t.diff(t.read(app.renderer.gl, W, H), before);
      sprite.destroy();
      app.destroy(true);
      return { diff, events };
    }`);
    expect(r.events).toEqual(["restored"]);
    expect(r.diff).toMatchObject({ max: 0, count: 0 });
    expect(r.diff.covered).toBeGreaterThan(20000);
  }, 120000);

  it("runs the example (examples/pixi)", async () => {
    const example = await browser.newPage({ viewport: { width: 800, height: 900 } });
    const pageErrors: string[] = [];
    example.on("pageerror", (e) => pageErrors.push(e.message));
    await example.goto(new URL("examples/pixi/index.html", server.url).href, { waitUntil: "load" });
    await example.waitForFunction("window.mochi2dExample !== undefined", undefined, {
      timeout: 120000,
    });
    // The ticker runs the animation and Pixi draws the model in its container.
    const r = await example.evaluate(`(async () => {
      const { chan, holder } = window.mochi2dExample;
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
      const before = chan.model.runtime.lastFrame;
      for (let i = 0; i < 5; i++) await frame();
      const b = chan.getBounds();
      return {
        animated: chan.model.runtime.lastFrame !== before,
        inHolder: chan.parent === holder,
        bounds: [Math.round(b.width), Math.round(b.height)],
        log: document.getElementById("log").textContent,
      };
    })()`);
    await example.close();
    expect(pageErrors).toEqual([]);
    expect(r).toMatchObject({ animated: true, inHolder: true });
    expect((r as { bounds: number[] }).bounds[1]).toBeGreaterThan(400);
    expect((r as { log: string }).log).toMatch(/509 parameters/);
  }, 150000);
});

/**
 * Items between the main model's art meshes, and split items, in headless
 * Chromium, on small synthetic models of opaque solid colors, so that every
 * place gives known colors:
 *
 * - the main model: A (red) over the whole square, then B (green) over its
 *   left half. In the layered variant (version 6) B is inside part P, which
 *   owns an offscreen of opacity 0.5.
 * - the item: D (cyan) over the whole square, then E (magenta) over its
 *   second quarter. In the layered variant E is inside part Q, which owns an
 *   offscreen of opacity 0.5.
 *
 * Colors are read in the square's four quarters, left to right. Needs
 * `npm run build:lib` and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { decodePng, encodePng } from "../tools/lib/png.js";
import { Synth } from "./support/synth.js";

const root = resolve(__dirname, "..");
let available = existsSync(join(root, "dist", "lib", "mochi2d.js"));
try {
  loadPlaywright();
} catch {
  available = false;
}

type Rgb = [number, number, number];
const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const CYAN: Rgb = [0, 255, 255];
const MAGENTA: Rgb = [255, 0, 255];
/** a·x + (1 − a)·y, as 8-bit values. */
const mix = (x: Rgb, y: Rgb, a = 0.5): Rgb =>
  [0, 1, 2].map((i) => a * x[i]! + (1 - a) * y[i]!) as Rgb;

const quad = (x0: number, x1: number) => ({
  positions: [x0, -0.5, x1, -0.5, x0, 0.5, x1, 0.5],
  triangles: [0, 1, 2, 1, 3, 2],
  uvs: new Array(8).fill(0.5),
});

/** A 4 × 4 PNG of one opaque color. */
const solid = (c: Rgb) =>
  Array.from(
    encodePng({
      width: 4,
      height: 4,
      data: Uint8Array.from({ length: 64 }, (_, i) => [...c, 255][i % 4]!),
    }),
  );

/**
 * A model of two meshes: `first` over the whole square, then `second` over
 * [x0, x1]. With `offscreen`, the second is inside a part with an offscreen
 * of opacity 0.5 (version 6). Parameter Order at 1 draws the first mesh
 * after the second; Hide at 1 makes the second invisible (opacity 0). Its
 * files, by path.
 */
function model(o: {
  names: [string, string];
  colors: [Rgb, Rgb];
  second: [number, number];
  offscreen: boolean;
}): Record<string, number[] | string> {
  const s = new Synth(o.offscreen ? 6 : 5);
  s.canvas = { pixelsPerUnit: 100, originX: 100, originY: 100, width: 200, height: 200, flags: 0 };
  const rootPart = s.part({ id: "Root" });
  const inner = o.offscreen ? s.part({ id: "Inner", parent: rootPart }) : rootPart;
  const a = quad(-0.8, 0.8);
  const b = quad(o.second[0], o.second[1]);
  const order = s.band([s.binding(s.param("Order", 0, 1, 0), [0, 1])]);
  const hide = s.band([s.binding(s.param("Hide", 0, 1, 0), [0, 1])]);
  const first = s.mesh({
    id: o.names[0],
    part: rootPart,
    band: order,
    texture: 0,
    ...a,
    keyforms: [
      { positions: a.positions, drawOrder: 100 },
      { positions: a.positions, drawOrder: 300 },
    ],
  });
  const second = s.mesh({
    id: o.names[1],
    part: inner,
    band: hide,
    texture: 1,
    ...b,
    keyforms: [
      { positions: b.positions, drawOrder: 200 },
      { positions: b.positions, drawOrder: 200, opacity: 0 },
    ],
  });
  if (o.offscreen) {
    s.offscreen({ part: inner, keyforms: [{ opacity: 0.5 }] });
    s.groups = [
      {
        objects: [
          { kind: 0, index: first },
          { kind: 1, index: inner, nested: 1 },
        ],
        min: 0,
        max: 1000,
      },
      { objects: [{ kind: 0, index: second }], min: 0, max: 1000 },
    ];
  }
  return {
    "m.model3.json": JSON.stringify({
      Version: 3,
      FileReferences: { Moc: "m.moc3", Textures: ["t0.png", "t1.png"] },
    }),
    "m.moc3": Array.from(s.build()),
    "t0.png": solid(o.colors[0]),
    "t1.png": solid(o.colors[1]),
  };
}

const mainFiles = (offscreen: boolean) =>
  model({ names: ["A", "B"], colors: [RED, GREEN], second: [-0.8, 0], offscreen });
const itemFiles = (offscreen: boolean) =>
  model({ names: ["D", "E"], colors: [CYAN, MAGENTA], second: [-0.4, 0], offscreen });

describe.skipIf(!available)("items between the main model's art meshes (headless Chromium)", () => {
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
    // A blank page of its own: nothing else loads models into it or writes to it.
    await page.goto(new URL("test/support/blank.html", server.url).href, { waitUntil: "load" });
    await run(`async () => {
      window.t = { lib: await import(new URL("/dist/lib/mochi2d.js", location.href).href) };
    }`);
  }, 180000);

  afterAll(async () => {
    expect(errors).toEqual([]);
    await browser?.close();
    await server?.close();
  }, 60000);

  /** A fresh view with the main model and one or two items (unplaced). */
  const setUp = (main: boolean, item: boolean, items = 1) =>
    run(
      `async ({ main, item, items }) => {
        window.t.view?.dispose();
        document.body.innerHTML = "";
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "width: 200px; height: 200px; display: block";
        document.body.append(canvas);
        const files = (f) => ({ files: Object.fromEntries(Object.entries(f).map(([k, v]) =>
          [k, typeof v === "string" ? v : Uint8Array.from(v)])) });
        const view = new window.t.lib.MochiView(canvas, {
          look: "off", background: "#ffffff", autoStart: false, maxPixelRatio: 1,
        });
        window.t.view = view;
        window.t.main = await view.load(files(main));
        window.t.items = [];
        for (let i = 0; i < items; i++) window.t.items.push(await view.addItem(files(item)));
        window.t.item = window.t.items[0];
        view.advance(1 / 60);
      }`,
      { main: mainFiles(main), item: itemFiles(item), items },
    );

  /** The colors at the centers of the square's four quarters in the next frame. */
  const quarters = async (): Promise<Rgb[]> => {
    const r = await run<{ png: number[]; at: { x: number; y: number }[] }>(`async () => {
      const { view } = window.t;
      const p = view.screenshot();
      view.advance(0);
      const png = [...new Uint8Array(await (await p).arrayBuffer())];
      return { png, at: [-0.6, -0.2, 0.2, 0.6].map((x) => view.toPage(x, 0)) };
    }`);
    const img = decodePng(Uint8Array.from(r.png));
    return r.at.map(({ x, y }) => {
      const i = (Math.floor(y) * img.width + Math.floor(x)) * 4;
      return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
    });
  };

  const expectColors = (got: Rgb[], want: Rgb[]) => {
    const off = got.map((c, k) => Math.max(...c.map((v, i) => Math.abs(v - want[k]![i]!))));
    expect(
      Math.max(...off),
      `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
    ).toBeLessThanOrEqual(2);
  };

  /** Places the first item: `place` is a placement fragment (JSON). */
  const place = (p: unknown) => run(`async (p) => window.t.item.place(p)`, p);

  describe("direct pipeline (version 5 models)", () => {
    beforeAll(() => setUp(false, false), 120000);

    it("draws the item behind, between and in front of the art meshes", async () => {
      await place({ front: false });
      expectColors(await quarters(), [GREEN, GREEN, RED, RED]);
      await place({ layer: { below: "A" } });
      expectColors(await quarters(), [GREEN, GREEN, RED, RED]);
      await place({ layer: { above: "A" } });
      expectColors(await quarters(), [GREEN, GREEN, CYAN, CYAN]);
      await place({ layer: { below: "B" } });
      expectColors(await quarters(), [GREEN, GREEN, CYAN, CYAN]);
      await place({ layer: { above: "B" } });
      expectColors(await quarters(), [CYAN, MAGENTA, CYAN, CYAN]);
      await place({ front: true });
      expectColors(await quarters(), [CYAN, MAGENTA, CYAN, CYAN]);
    }, 120000);

    /** Sets a main model parameter and evaluates. */
    const setMain = (id: string, v: number) =>
      run(`async ([id, v]) => { window.t.main.setParameter(id, v); window.t.view.advance(0); }`, [
        id,
        v,
      ]);

    it("follows the main model's render order and draws at invisible art meshes", async () => {
      await place({ layer: { above: "A" } });
      // A drawn after B: the main model is all red, and the item above A is on top.
      await setMain("Order", 1);
      expectColors(await quarters(), [CYAN, MAGENTA, CYAN, CYAN]);
      await place({ layer: { below: "A" } });
      expectColors(await quarters(), [RED, RED, RED, RED]);
      await setMain("Order", 0);
      // B invisible: an item below it is still drawn there, over A.
      await place({ layer: { below: "B" } });
      await setMain("Hide", 1);
      expectColors(await quarters(), [CYAN, MAGENTA, CYAN, CYAN]);
      await place({ layer: { below: "A" } });
      expectColors(await quarters(), [RED, RED, RED, RED]);
      await setMain("Hide", 0);
    }, 120000);

    it("splits an item in two parts, the back part never in front of the front part", async () => {
      await place({ front: true, split: { mesh: "E", back: "behind" } });
      expectColors(await quarters(), [GREEN, MAGENTA, RED, RED]);
      await place({ front: true, split: { mesh: "E", back: { above: "A" } } });
      expectColors(await quarters(), [GREEN, MAGENTA, CYAN, CYAN]);
      // A back part in front of the front part is drawn at the front part's place.
      await place({ layer: { above: "A" }, split: { mesh: "E", back: "front" } });
      expectColors(await quarters(), [GREEN, GREEN, CYAN, CYAN]);
      // Nothing before the split mesh: the item is drawn whole.
      await place({ front: true, split: { mesh: "D", back: "behind" } });
      expectColors(await quarters(), [CYAN, MAGENTA, CYAN, CYAN]);
      await place({ split: null });
    }, 120000);

    it("checks art mesh IDs when set through layer and split, and keeps them in layouts", async () => {
      const r = await run<Record<string, unknown>>(`async () => {
        const { view, item } = window.t;
        const err = (f) => { try { f(); return "none"; } catch (e) { return e.name; } };
        const out = {
          unknownMain: err(() => { item.layer = { above: "nope" }; }),
          unknownItem: err(() => { item.split = { mesh: "nope", back: "behind" }; }),
          unknownBack: err(() => { item.split = { mesh: "E", back: { below: "nope" } }; }),
          malformed: err(() => item.place({ layer: { left: "A" } })),
          malformedSplit: err(() => item.place({ split: { mesh: "E", back: "under" } })),
        };
        item.layer = { below: "B" };
        item.split = { mesh: "E", back: "behind" };
        out.layer = item.layer;
        out.split = item.split;
        const layout = view.exportItemLayout();
        out.saved = layout.items[0].placement;
        item.front = true;
        out.afterFront = [item.layer, item.split];
        view.applyItemLayout(layout);
        out.restored = [item.layer, item.split];
        // A layout naming an art mesh the main model lacks: drawn per front, no error.
        const other = JSON.parse(JSON.stringify(layout));
        other.items[0].placement.layer = { above: "Missing" };
        other.items[0].placement.split = null;
        view.applyItemLayout(other);
        out.missing = item.layer;
        const bad = JSON.parse(JSON.stringify(layout));
        bad.items[0].placement.layer = { over: "A" };
        out.badLayout = err(() => view.applyItemLayout(bad));
        out.afterBad = item.layer;
        return out;
      }`);
      expect(r).toMatchObject({
        unknownMain: "RangeError",
        unknownItem: "RangeError",
        unknownBack: "RangeError",
        malformed: "TypeError",
        malformedSplit: "TypeError",
        layer: { below: "B" },
        split: { mesh: "E", back: "behind" },
        saved: { layer: { below: "B" }, split: { mesh: "E", back: "behind" }, front: true },
        afterFront: ["front", { mesh: "E", back: "behind" }],
        restored: [{ below: "B" }, { mesh: "E", back: "behind" }],
        missing: { above: "Missing" },
        badLayout: "TypeError",
        afterBad: { above: "Missing" },
      });
      // The missing art mesh leaves the item in front (its `front`).
      expectColors(await quarters(), [CYAN, MAGENTA, CYAN, CYAN]);
    }, 120000);

    it("hit-tests items in drawing order", async () => {
      await setUp(false, false, 2);
      const r = await run<string[]>(`async () => {
        const { view, items } = window.t;
        const at = view.toPage(0.6, 0);
        const order = [];
        items[0].layer = { above: "A" };
        items[1].front = false;
        order.push(view.itemAt(at.x, at.y)?.id);
        items[1].layer = { above: "B" };
        order.push(view.itemAt(at.x, at.y)?.id);
        items[0].front = true;
        order.push(view.itemAt(at.x, at.y)?.id);
        return [...order, items[0].id, items[1].id];
      }`);
      const [a, b, c, first, second] = r;
      expect([a, b, c]).toEqual([first, second, first]);
    }, 120000);
  });

  describe("layered pipeline (version 6 models with offscreens)", () => {
    it("draws an item at an art mesh into the layer that art mesh is drawn into", async () => {
      await setUp(true, false);
      const olive = mix(GREEN, RED);
      await place({ front: false });
      expectColors(await quarters(), [olive, olive, RED, RED]);
      // Above A: before P's offscreen opens, so P's half-transparent B covers it.
      await place({ layer: { above: "A" } });
      expectColors(await quarters(), [mix(GREEN, CYAN), mix(GREEN, MAGENTA), CYAN, CYAN]);
      // Below or above B: inside P's offscreen, composited with it at 0.5.
      await place({ layer: { below: "B" } });
      expectColors(await quarters(), [olive, olive, mix(CYAN, RED), mix(CYAN, RED)]);
      await place({ layer: { above: "B" } });
      expectColors(await quarters(), [
        mix(CYAN, RED),
        mix(MAGENTA, RED),
        mix(CYAN, RED),
        mix(CYAN, RED),
      ]);
      await place({ front: true });
      expectColors(await quarters(), [CYAN, MAGENTA, CYAN, CYAN]);
    }, 120000);

    it("draws an item at an invisible art mesh into that art mesh's offscreen", async () => {
      await run(`async () => { window.t.main.setParameter("Hide", 1); window.t.view.advance(0); }`);
      // P's offscreen holds only the item now.
      await place({ layer: { below: "B" } });
      expectColors(await quarters(), [
        mix(CYAN, RED),
        mix(MAGENTA, RED),
        mix(CYAN, RED),
        mix(CYAN, RED),
      ]);
      await place({ layer: { above: "A" } });
      expectColors(await quarters(), [CYAN, MAGENTA, CYAN, CYAN]);
    }, 120000);

    it("keeps a split item's front part in its offscreen", async () => {
      await setUp(false, true);
      // Whole: E through Q's offscreen at 0.5 over D.
      await place({ front: true });
      expectColors(await quarters(), [CYAN, mix(MAGENTA, CYAN), CYAN, CYAN]);
      // Split at E, D behind the main model: E still at 0.5, now over B.
      await place({ front: true, split: { mesh: "E", back: "behind" } });
      expectColors(await quarters(), [GREEN, mix(MAGENTA, GREEN), RED, RED]);
    }, 120000);
  });
});

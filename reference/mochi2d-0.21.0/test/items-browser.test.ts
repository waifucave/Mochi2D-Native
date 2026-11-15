/**
 * Items in a MochiView, in headless Chromium: DeepSeek-chan as the main model and, again, as an item with a crafted
 * `.vtube.json`. Loading, drawing in front and behind, forwarded head angles,
 * pinning, dragging, the layout file, and removal. Needs `npm run build:lib`
 * and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { decodePng } from "../tools/lib/png.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
// DeepSeek-chan (assets/models/DeepSeek/) is needed too.
let available = HAVE_DEEPSEEK && existsSync(join(root, "dist", "lib", "mochi2d.js"));
try {
  loadPlaywright();
} catch {
  available = false;
}

describe.skipIf(!available)("items in a MochiView (headless Chromium)", () => {
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
    // Any page of the repository will do: the test builds its own view.
    await page.goto(new URL("examples/embed/index.html", server.url).href, { waitUntil: "load" });
    await page.waitForFunction("window.mochi2dExample !== undefined", undefined, {
      timeout: 120000,
    });
    await run(`async () => {
      window.mochi2dExample.view.dispose();
      document.body.innerHTML = "";
      document.body.style.margin = "0";
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "width: 600px; height: 600px; display: block";
      document.body.append(canvas);
      const lib = await import(new URL("/dist/lib/mochi2d.js", location.href).href);
      const view = new lib.MochiView(canvas, {
        look: "off", background: "#ffffff", dragItems: true, autoStart: false, maxPixelRatio: 1,
      });
      const main = await view.load(new URL("/models/DeepSeek/大肥鱼.model3.json", location.href).href);
      // The item: DeepSeek-chan's files, plus a crafted .vtube.json with ItemSettings.
      const base = new URL("/models/DeepSeek/", location.href);
      const settings = await (await fetch(new URL("大肥鱼.model3.json", base))).json();
      const refs = settings.FileReferences;
      const files = ["大肥鱼.model3.json", refs.Moc, refs.Physics, refs.DisplayInfo, ...refs.Textures];
      const vtube = JSON.stringify({ ItemSettings: {
        Multiplier_HeadAngleX: 0.5, Multiplier_HeadAngleY: 1, Multiplier_HeadAngleZ: 1,
        Shift_HeadAngleX: 2, Shift_HeadAngleY: 0,
        Smoothing_HeadAngleX: 0, Smoothing_HeadAngleY: 0, Smoothing_HeadAngleZ: 0 } });
      const source = {
        label: "item",
        list: () => [...files, "大肥鱼.vtube.json"],
        read: async (p) => p === "大肥鱼.vtube.json"
          ? new TextEncoder().encode(vtube)
          : new Uint8Array(await (await fetch(new URL(p.split("/").map(encodeURIComponent).join("/"), base))).arrayBuffer()),
      };
      window.t = { lib, view, main, source };
    }`);
  }, 180000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  }, 60000);

  /** Counts non-white pixels of the next frame inside a rectangle of the canvas. */
  const inked = async (x0: number, y0: number, x1: number, y1: number): Promise<number> => {
    const png = await run<number[]>(`async () => {
      const p = window.t.view.screenshot();
      window.t.view.advance(0);
      return [...new Uint8Array(await (await p).arrayBuffer())];
    }`);
    const img = decodePng(Uint8Array.from(png));
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i]! < 240 || img.data[i + 1]! < 240 || img.data[i + 2]! < 240) n++;
      }
    return n;
  };

  it("adds an item with its ItemSettings, placed beside the main model", async () => {
    const r = await run<{ n: number; settings: unknown; memory: [number, number] }>(`async () => {
      const { view, main, source } = window.t;
      const before = view.stage.memory.total;
      const c = main.runtime.model.canvas;
      // Right of the main model's canvas (which spans ±right), at 0.3 of its pixel size.
      const right = (c.width - c.originX) / c.pixelsPerUnit;
      const item = await view.addItem(source, { placement: { x: right * 1.6, y: 0, scale: 0.3 } });
      view.advance(1 / 60);
      window.t.item = item;
      return { n: view.items.length, settings: item.settings, memory: [before, view.stage.memory.total] };
    }`);
    expect(r.n).toBe(1);
    expect(r.settings).toMatchObject({
      multiplier: { x: 0.5, y: 1, z: 1 },
      shift: { x: 2, y: 0, z: 0 },
    });
    expect(r.memory[1]).toBeGreaterThan(r.memory[0]);
    // The item is drawn on the right; hiding it leaves the page white there.
    expect(await inked(480, 0, 600, 600)).toBeGreaterThan(500);
    await run(`async () => { window.t.item.visible = false; }`);
    expect(await inked(480, 0, 600, 600)).toBe(0);
    await run(`async () => { window.t.item.visible = true; }`);
  }, 120000);

  it("tints an item's art meshes, and draws it again when they change", async () => {
    const before = await inked(480, 0, 600, 600);
    await run(`async () => {
      const { item } = window.t;
      for (const id of item.runtime.model.meshes.ids) item.setTint(id, [1, 1, 1, 0]);
    }`);
    expect(await inked(480, 0, 600, 600)).toBe(0);
    await run(`async () => { window.t.item.clearTints(); }`);
    expect(await inked(480, 0, 600, 600)).toBe(before);
  }, 120000);

  it("draws the item in front of or behind the main model", async () => {
    // Over the main model's center, full size: in front it changes the pixels, behind it does not.
    const center = async (front: boolean) =>
      run<number[]>(
        `async (front) => {
          const { view, item } = window.t;
          item.place({ x: 0, y: 0, scale: 1, front });
          const p = view.screenshot();
          view.advance(0);
          return [...new Uint8Array(await (await p).arrayBuffer())];
        }`,
        front,
      );
    const none = await run<number[]>(`async () => {
      const { view, item } = window.t;
      item.visible = false;
      const p = view.screenshot();
      view.advance(0);
      const png = [...new Uint8Array(await (await p).arrayBuffer())];
      item.visible = true;
      return png;
    }`);
    const differs = (a: number[], b: number[]) => {
      const A = decodePng(Uint8Array.from(a));
      const B = decodePng(Uint8Array.from(b));
      let n = 0;
      for (let i = 0; i < A.data.length; i += 4) if (A.data[i] !== B.data[i]) n++;
      return n;
    };
    const front = await center(true);
    const behind = await center(false);
    expect(differs(front, none)).toBeGreaterThan(1000);
    // Behind, the item shows only around the main model, not over it.
    expect(differs(behind, none)).toBeLessThan(differs(front, none));
  }, 120000);

  it("feeds the main model's head angles with the multipliers and shifts", async () => {
    const r = await run<{ main: number[]; fed: (number | null)[] }>(`async () => {
      const { view, main, item } = window.t;
      main.lookAt(1, -1);
      for (let i = 0; i < 30; i++) view.advance(1 / 60);
      return {
        main: ["ParamAngleX", "ParamAngleY", "ParamAngleZ"].map((id) => main.getParameter(id)),
        fed: [...item.headAngles],
      };
    }`);
    expect(Math.abs(r.main[0]!)).toBeGreaterThan(1);
    expect(r.fed[0]).toBeCloseTo(0.5 * r.main[0]! + 2, 4);
    expect(r.fed[1]).toBeCloseTo(r.main[1]!, 4);
    expect(r.fed[2]).toBeCloseTo(r.main[2]!, 4);
  }, 120000);

  it("negates ParamAngleX and ParamAngleZ for a mirrored item, with the multipliers on top", async () => {
    const r = await run<{ main: number[]; fed: (number | null)[] }>(`async () => {
      const { view, main, item } = window.t;
      item.mirror = true;
      main.lookAt(1, -1);
      main.setParameter("AngleZ", 20); // physics turns ParamAngleZ from it
      for (let i = 0; i < 30; i++) view.advance(1 / 60);
      const out = {
        main: ["ParamAngleX", "ParamAngleY", "ParamAngleZ"].map((id) => main.getParameter(id)),
        fed: [...item.headAngles],
      };
      item.mirror = false;
      main.setParameter("AngleZ", 0);
      return out;
    }`);
    expect(Math.abs(r.main[0]!)).toBeGreaterThan(1);
    expect(Math.abs(r.main[2]!)).toBeGreaterThan(1);
    // Multiplier 0.5 and shift 2 on X; 1 and 0 on Y and Z.
    expect(r.fed[0]).toBeCloseTo(0.5 * -r.main[0]! + 2, 4);
    expect(r.fed[1]).toBeCloseTo(r.main[1]!, 4);
    expect(r.fed[2]).toBeCloseTo(-r.main[2]!, 4);
  }, 120000);

  it("pins the item to the main model, follows it, and keeps the placement when unpinned", async () => {
    const r = await run<{
      pinned: boolean;
      pin: { drawable: string } | null;
      moved: number;
      turned: number;
      kept: boolean;
    }>(`async () => {
      const { view, main, item } = window.t;
      main.lookAt(0, 0);
      for (let i = 0; i < 60; i++) view.advance(1 / 60);
      item.place({ x: 0, y: 0.25, scale: 0.3, rotation: 0, front: true });
      const pinned = item.pinToModel();
      const a = item.placement;
      main.setParameter("ParamBodyAngleZ", 10);
      main.setEffect("physics", false);
      for (let i = 0; i < 60; i++) view.advance(1 / 60);
      const b = item.placement;
      item.unpin();
      const c = item.placement;
      return {
        pinned,
        pin: item.pin,
        moved: Math.hypot(b.x - a.x, b.y - a.y),
        turned: b.rotation - a.rotation,
        kept: c.x === b.x && c.y === b.y && c.rotation === b.rotation,
      };
    }`);
    expect(r.pinned).toBe(true);
    expect(r.pin).toBeNull(); // unpinned at the end
    expect(r.moved).toBeGreaterThan(1e-3);
    expect(Math.abs(r.turned)).toBeGreaterThan(0.1);
    expect(r.kept).toBe(true);
  }, 120000);

  it("keeps a pin through MochiModel.replace while its triangle remains, else releases it in place", async () => {
    const r = await run<{
      pinned: boolean;
      kept: unknown;
      before: unknown;
      after: unknown;
      released: unknown;
      placed: [unknown, unknown];
      sameTextures: boolean;
    }>(`async () => {
      const { view, main, item, lib } = window.t;
      // Without time-driven effects, a new runtime with the same data poses the same.
      const effects = ["physics", "breath", "eyeBlink", "look"];
      for (const e of effects) main.setEffect(e, false);
      for (let i = 0; i < 10; i++) view.advance(1 / 60);
      item.place({ x: 0, y: 0.25, scale: 0.3, rotation: 0, front: true });
      const pinned = item.pinToModel();
      const before = item.pin;
      const textures = [...main.live.textures];
      const bytes = new Uint8Array(await (await fetch(new URL("/models/DeepSeek/大肥鱼.moc3", location.href))).arrayBuffer());
      const read = lib.readMoc(bytes);
      // The same data: the pin stays, at the same place.
      const placed0 = item.placement;
      await main.replace(read.data, read.version);
      view.advance(0);
      const kept = item.pin;
      const placed1 = item.placement;
      // The pinned triangle's vertices in another order: the pin is released where the item is.
      const edited = lib.readMoc(bytes).data;
      const d = edited.artMeshes.ids.indexOf(before.drawable);
      const t = edited.artMeshes.firstTriangleIndex[d] + 3 * before.triangle;
      const tri = edited.triangleIndices;
      [tri[t], tri[t + 1], tri[t + 2]] = [tri[t + 1], tri[t + 2], tri[t]];
      const atRelease = item.placement;
      await main.replace(edited, read.version);
      view.advance(0);
      const released = item.pin;
      const after = item.placement;
      for (const e of effects) main.setEffect(e, true);
      item.unpin();
      return { pinned, kept, before, released, placed: [placed0, placed1],
        after: [atRelease, after], sameTextures: main.live.textures.every((x, i) => x === textures[i]) };
    }`);
    expect(r.pinned).toBe(true);
    expect(r.kept).toEqual(r.before);
    expect(r.placed[1]).toEqual(r.placed[0]);
    expect(r.released).toBeNull();
    const [atRelease, after] = r.after as [unknown, unknown];
    expect(after).toEqual(atRelease);
    expect(r.sameTextures).toBe(true);
  }, 120000);

  it("mirrors a pinned item about its anchor: drawing, hit tests and the pin follow", async () => {
    const r = await run<{
      pinned: boolean;
      pins: unknown[];
      placements: { x: number; y: number; rotation: number; mirror?: boolean }[];
      hits: boolean[][];
      anchorPx: number;
      shots: number[][];
    }>(`async () => {
      const { view, main, item } = window.t;
      const shot = async () => {
        const p = view.screenshot();
        view.advance(0);
        return [...new Uint8Array(await (await p).arrayBuffer())];
      };
      const effects = ["physics", "breath", "eyeBlink", "look"];
      // Physics writes no outputs in zero steps (3n.3), and forwarded head angles make
      // the item take one every frame: without these effects its pose holds still.
      for (const e of effects) {
        main.setEffect(e, false);
        item.setEffect(e, false);
      }
      item.place({ x: 0, y: 0.25, scale: 0.3, rotation: 0, front: true, mirror: false });
      for (let i = 0; i < 5; i++) view.advance(1 / 60);
      const pinned = item.pinToModel();
      // The main model hidden by tints, so the pictures show the item alone.
      for (const id of main.runtime.model.meshes.ids) main.setTint(id, [1, 1, 1, 0]);
      // Hit tests on a grid about the anchor, from page coordinates (toPage, then itemAt).
      const hits = () => {
        const p = item.placement;
        const out = [];
        for (let i = -8; i <= 8; i++)
          for (let j = -8; j <= 8; j++) {
            const q = view.toPage(p.x + 0.04 * i, p.y + 0.04 * j);
            out.push(view.itemAt(q.x, q.y) === item);
          }
        return out;
      };
      const placements = [item.placement];
      const pins = [item.pin];
      const before = hits();
      const anchorPx = view.toPage(item.placement.x, 0).x - view.canvas.getBoundingClientRect().left;
      const shots = [await shot()];
      item.mirror = true;
      view.advance(0);
      placements.push(item.placement);
      pins.push(item.pin);
      const after = hits();
      shots.push(await shot());
      // Pinned and mirrored, it follows the main model.
      const bodyZ = main.getParameterBase("ParamBodyAngleZ");
      main.setParameter("ParamBodyAngleZ", bodyZ > 0 ? -10 : 10);
      for (let i = 0; i < 30; i++) view.advance(1 / 60);
      placements.push(item.placement);
      pins.push(item.pin);
      item.mirror = false;
      item.unpin();
      main.clearTints();
      main.setParameter("ParamBodyAngleZ", bodyZ);
      for (const e of effects) {
        main.setEffect(e, true);
        item.setEffect(e, true);
      }
      return { pinned, pins, placements, hits: [before, after], anchorPx, shots };
    }`);
    expect(r.pinned).toBe(true);
    const [p0, p1, p2] = r.placements;
    expect([p0!.mirror, p1!.mirror, p2!.mirror]).toEqual([false, true, true]);
    // Mirroring keeps the anchor and the pin; the pinned item then follows the main model.
    expect([p1!.x, p1!.y, p1!.rotation]).toEqual([p0!.x, p0!.y, p0!.rotation]);
    expect(r.pins[1]).toEqual(r.pins[0]);
    expect(r.pins[2]).toEqual(r.pins[0]);
    expect(Math.hypot(p2!.x - p1!.x, p2!.y - p1!.y)).toBeGreaterThan(1e-3);
    // Hit tests: the point (i, j) of the grid hits after mirroring as (−i, j) did before.
    const [before, after] = r.hits as [boolean[], boolean[]];
    const at = (h: boolean[], i: number, j: number) => h[(i + 8) * 17 + (j + 8)]!;
    let asymmetric = 0;
    for (let i = -8; i <= 8; i++)
      for (let j = -8; j <= 8; j++) {
        expect(at(after, i, j), `grid point ${i}, ${j}`).toBe(at(before, -i, j));
        if (at(before, i, j) !== at(before, -i, j)) asymmetric++;
      }
    expect(before.filter(Boolean).length).toBeGreaterThan(20);
    expect(asymmetric, "the item is not symmetric, so the check means something").toBeGreaterThan(
      0,
    );
    // The picture: pixel (x, y) after shows what pixel (2·anchor − x, y) showed before.
    const [A, B] = r.shots.map((png) => decodePng(Uint8Array.from(png)));
    let inked = 0;
    let differ = 0;
    for (let y = 0; y < 600; y++)
      for (let x = 0; x < 600; x++) {
        const x2 = Math.round(2 * r.anchorPx - (x + 0.5) - 0.5);
        if (x2 < 0 || x2 >= 600) continue;
        const b = B!.data[4 * (600 * y + x) + 1]!;
        const a = A!.data[4 * (600 * y + x2) + 1]!;
        if (a < 240 || b < 240) inked++;
        if (Math.abs(a - b) > 64) differ++;
      }
    expect(inked).toBeGreaterThan(1000);
    expect(differ / inked).toBeLessThan(0.03);
  }, 120000);

  it("drags an item with the pointer and re-pins a pinned one where it is dropped", async () => {
    const start = await run<{
      x: number;
      y: number;
      px: number;
      py: number;
      k: number;
    }>(`async () => {
      const { view, main, item } = window.t;
      item.place({ x: 0, y: 0.25, scale: 0.5, rotation: 0 });
      item.pinToModel();
      view.advance(1 / 60);
      const p = item.placement;
      const live = main.live;
      const [px, py] = live.toImage(p.x, p.y, view.canvas.width, view.canvas.height);
      return { x: p.x, y: p.y, px, py, k: live.framing(view.canvas.width, view.canvas.height).k };
    }`);
    // Press on the item (it is in front, at its anchor) and drag 40 px right, 20 px down.
    await page.mouse.move(start.px, start.py);
    await page.mouse.down();
    await page.mouse.move(start.px + 20, start.py + 10, { steps: 2 });
    await page.mouse.move(start.px + 40, start.py + 20, { steps: 2 });
    await page.mouse.up();
    const end = await run<{ x: number; y: number; pinned: boolean }>(`async () => {
      const { view, item } = window.t;
      view.advance(1 / 60);
      const p = item.placement;
      return { x: p.x, y: p.y, pinned: item.pin !== null };
    }`);
    expect(end.x - start.x).toBeCloseTo(40 / start.k, 2);
    expect(end.y - start.y).toBeCloseTo(-20 / start.k, 2);
    expect(end.pinned).toBe(true);
  }, 120000);

  it("exports and applies an item layout", async () => {
    const r = await run<{
      layout: { format: string; items: unknown[] };
      restored: boolean;
      pinned: boolean;
    }>(`async () => {
      const { view, item } = window.t;
      item.unpin();
      item.place({ x: 0.1, y: 0.2, scale: 0.4, rotation: 15, front: false });
      item.pinToModel();
      const layout = JSON.parse(JSON.stringify(view.exportItemLayout()));
      item.unpin();
      item.place({ x: -1, y: -1, scale: 2, rotation: 0, front: true });
      const placed = view.applyItemLayout(layout);
      const p = item.placement;
      const s = layout.items[0].placement;
      return {
        layout,
        restored: placed === 1 && Math.abs(p.x - s.x) < 1e-9 && p.scale === s.scale && p.front === s.front,
        pinned: item.pin !== null && item.pin.drawable === layout.items[0].pin.drawable,
      };
    }`);
    expect(r.layout.format).toBe("mochi2d-item-layout/1");
    expect(r.layout.items).toHaveLength(1);
    expect(r.restored).toBe(true);
    expect(r.pinned).toBe(true);
  }, 120000);

  it("tells duplicate items apart by id in layouts, and exports and applies one item", async () => {
    const r = await run<Record<string, unknown>>(`async () => {
      const { view, item, source } = window.t;
      const twin = await view.addItem(source, { placement: { x: 0.3, y: 0.1, scale: 0.5 } });
      const named = await view.addItem(source, { id: "left" });
      let duplicate = null;
      await view.addItem(source, { id: "left" }).catch((e) => (duplicate = e.message));
      const ids = view.items.map((i) => i.id);
      // view.items follows the drawing order: raise() moves an item to its end.
      const order = () => view.items.map((i) => i.id);
      const layerOrder = () =>
        view.itemLayer.entries.map((e) => view.items.find((i) => i.entry === e).id);
      item.raise();
      const raised = [order(), layerOrder()];
      twin.raise();
      named.raise();
      const reraised = order();
      item.unpin();
      item.place({ x: -0.2, y: 0, scale: 0.3, rotation: 0 });
      twin.place({ x: 0.4, y: 0.2, scale: 0.6, rotation: 10 });
      const layout = JSON.parse(JSON.stringify(view.exportItemLayout()));
      // Swap the two copies; by id, each gets its own placement back, and the
      // reversed entries reverse the drawing order.
      item.place({ x: 0.4, y: 0.2, scale: 0.6 });
      twin.place({ x: -0.2, y: 0, scale: 0.3 });
      const placed = view.applyItemLayout({ ...layout, items: [...layout.items].reverse() });
      const back = [item.placement.x, twin.placement.x, twin.placement.rotation];
      const reversed = [order(), layerOrder()];
      // An entry for one item only: it goes on top, the others keep their order.
      view.applyItemLayout({ ...layout, items: [layout.items[1]] });
      const partial = order();
      view.applyItemLayout(layout);
      const restored = order();
      // One item: its own entry, applied to another copy.
      const one = twin.exportLayout();
      const pinOk = named.applyLayout(one);
      const copied = [named.placement.x, named.placement.scale, named.opacity];
      // A layout from before ids: matched by settings path, in order.
      const old = { ...layout, items: layout.items.map(({ id, ...rest }) => rest) };
      item.place({ x: 1 }); twin.place({ x: 1 });
      const placedOld = view.applyItemLayout(old);
      const byOrder = [item.placement.x, twin.placement.x];
      const found = view.item("left") === named && view.item("nope") === null;
      twin.dispose();
      named.dispose();
      return { ids, duplicate, entryIds: layout.items.map((e) => e.id), placed, back, one, pinOk, copied,
        placedOld, byOrder, found, raised, reraised, reversed, partial, restored };
    }`);
    const [a, b, c] = ["大肥鱼.model3.json#1", "大肥鱼.model3.json#2", "left"];
    expect(r.ids).toEqual([a, b, c]);
    expect(r.raised).toEqual([
      [b, c, a],
      [b, c, a],
    ]);
    expect(r.reraised).toEqual([a, b, c]);
    expect(r.reversed).toEqual([
      [c, b, a],
      [c, b, a],
    ]);
    expect(r.partial).toEqual([c, a, b]);
    expect(r.restored).toEqual([a, b, c]);
    expect(r.duplicate).toMatch(/already has an item with id "left"/);
    expect(r.entryIds).toEqual(r.ids);
    expect(r.placed).toBe(3);
    expect(r.back).toEqual([-0.2, 0.4, 10]);
    expect(r.one).toMatchObject({
      id: "大肥鱼.model3.json#2",
      name: "大肥鱼.model3.json",
      pin: null,
    });
    expect(r.pinOk).toBe(true);
    expect(r.copied).toEqual([0.4, 0.6, 1]);
    expect(r.placedOld).toBe(3);
    expect(r.byOrder).toEqual([-0.2, 0.4]);
    expect(r.found).toBe(true);
  }, 120000);

  it("removes an item and frees its GPU memory; the single-model API is unchanged", async () => {
    const r = await run<{ n: number; freed: boolean; main: string }>(`async () => {
      const { view, item, main } = window.t;
      const before = view.stage.memory.total;
      item.dispose();
      view.advance(1 / 60);
      return { n: view.items.length, freed: view.stage.memory.total < before, main: view.model.name };
    }`);
    expect(r).toEqual({ n: 0, freed: true, main: "大肥鱼.model3.json" });
    expect(errors).toEqual([]);
  }, 120000);
});

/**
 * The browser library in headless Chromium, through the embed example
 * (examples/embed/index.html, which imports dist/lib/mochi2d.js): loading,
 * look on hover, taps, motions, expressions, lip sync, view changes,
 * screenshots, a lost and restored GPU context, zip names in legacy
 * encodings, a zip by URL, and dispose.
 * Needs `npm run build:lib` and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { CHROMIUM_MEDIA_ARGS, launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { decodePng } from "../tools/lib/png.js";
import { wav16 } from "./support/anim.js";
import { buildZip } from "./support/zip-writer.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";
import { Synth } from "./support/synth.js";

const root = resolve(__dirname, "..");
// DeepSeek-chan (assets/models/DeepSeek/) is needed too.
let available = HAVE_DEEPSEEK && existsSync(join(root, "dist", "lib", "mochi2d.js"));
try {
  loadPlaywright();
} catch {
  available = false;
}

describe.skipIf(!available)("library in the browser (embed example)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  /** Runs `fn(view, model)` in the page (as source text, so no bundler helpers leak in). */
  const run = <R>(fn: string, arg?: unknown): Promise<R> =>
    page.evaluate(
      ([src, a]) => {
        const ex = (window as unknown as { mochi2dExample: { view: unknown; model: unknown } })
          .mochi2dExample;
        return new Function("view", "model", "arg", `return (${src})(view, model, arg)`)(
          ex.view,
          ex.model,
          a,
        ) as R;
      },
      [fn, arg] as const,
    );

  beforeAll(async () => {
    server = await startStaticServer(root, root);
    browser = await launchChromium(CHROMIUM_MEDIA_ARGS);
    page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("examples/embed/index.html", server.url).href, { waitUntil: "load" });
    await page.waitForFunction("window.mochi2dExample !== undefined", undefined, {
      timeout: 120000,
    });
  }, 150000);
  afterAll(async () => {
    await page?.evaluate("window.mochi2dExample?.view.stop()").catch(() => {});
    await browser?.close();
    await server?.close();
  }, 60000);

  it("loads the model and draws it over the page (transparent canvas)", async () => {
    const info = await run<{
      params: number;
      running: boolean;
      w: number;
      h: number;
      name: string;
    }>(`(view, model) => ({
      params: model.parameters.length,
      running: view.running,
      w: view.canvas.width,
      h: view.canvas.height,
      name: model.name,
    })`);
    expect(info.params).toBe(509);
    expect(info.running).toBe(true);
    expect(info.name).toBe("大肥鱼.model3.json");
    expect(info.w).toBeGreaterThan(100);
    const png = await run<number[]>(`async (view) => {
      const blob = await view.screenshot();
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }`);
    const img = decodePng(new Uint8Array(png));
    expect([img.width, img.height]).toEqual([info.w, info.h]);
    expect(img.data[3], "corner is transparent").toBe(0);
    let opaque = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 200) opaque++;
    expect(opaque / (img.width * img.height), "model pixels").toBeGreaterThan(0.05);
  }, 60000);

  it("looks at the hovering pointer and reports taps", async () => {
    const box = (await page.locator("#model").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5);
    expect(
      await run<number>("(view, model) => model.runtime.animator.look.targetX"),
    ).toBeGreaterThan(0.3);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 2 });
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
    await page.waitForFunction(
      "/Tapped ArtMesh\\d+/.test(document.getElementById('log').textContent)",
    );
    const hit = await run<{ areas: string[]; drawable: string | null; x: number }>(
      "(view, model, p) => view.hitTest(p[0], p[1])",
      [box.x + box.width * 0.5, box.y + box.height * 0.3],
    );
    expect(hit.areas).toEqual([]);
    expect(hit.drawable).toMatch(/^ArtMesh\d+$/);
    expect(Math.abs(hit.x)).toBeLessThan(0.2);
    // Leaving the canvas returns the look target to the center.
    await page.mouse.move(box.x + box.width + 50, box.y + 10);
    await page.waitForFunction(
      "window.mochi2dExample.model.runtime.animator.look.targetX === 0",
      undefined,
      { timeout: 5000 },
    );
  });

  it("plays motions and expressions from buttons, and lip-syncs", async () => {
    await page.click("#motion");
    await page.waitForFunction(
      "/Playing Animation/.test(document.getElementById('log').textContent)",
    );
    expect(await run<string[]>("(view, model) => model.motions")).toEqual([
      "Animation/脱捕.motion3.json",
    ]);
    await page.click("#expression");
    await page.waitForFunction(
      "/Expression Exp3/.test(document.getElementById('log').textContent)",
    );
    expect(await run<string[]>("(view, model) => model.runtime.playingExpressions")).toEqual([
      "Exp3/脸红.exp3.json",
    ]);
    await run("(view, model) => model.stopMotions()");
    expect(await run<string[]>("(view, model) => model.motions")).toEqual([]);
    // Lip sync without playback; resolves when the analysis reaches the end.
    const tone = Array.from(
      wav16(
        Array.from({ length: 4000 }, (_, i) => 0.6 * Math.sin(i / 2)),
        8000,
      ),
    );
    const r = await run<{ max: number; playing: boolean }>(
      `async (view, model, bytes) => {
        let max = 0;
        const off = view.on("frame", () => { max = Math.max(max, model.getParameter("ParamMouthOpenY")); });
        await model.speak(new Uint8Array(bytes), { play: false });
        off();
        return { max, playing: model.runtime.animator.lipSync.playing };
      }`,
      tone,
    );
    expect(r.max).toBeGreaterThan(0.3);
    expect(r.playing).toBe(false);
  }, 60000);

  it("holds a motion's last frame and reports each motion's end", async () => {
    const motion = "Animation/举手切默认手.motion3.json";
    const r = await run<{
      end: unknown;
      held: string[];
      ends: unknown[];
      after: string[];
      second: unknown;
    }>(
      `async (view, model, motion) => {
        const ends = [];
        const off = view.on("motionend", (e) =>
          ends.push({ motion: e.motion, reason: e.reason, queueEmpty: e.queueEmpty, same: e.model === model }));
        const first = await model.startMotionFile(motion, { hold: true });
        const end = await first.ended;
        await new Promise((r) => setTimeout(r, 200));
        const held = model.motions.slice();
        // The held motion keeps no priority: a normal start replaces it.
        const next = await model.startMotionFile(motion);
        model.stopMotions();
        const second = await next.ended;
        off();
        return { end, held, ends, after: model.motions.slice(), second };
      }`,
      motion,
    );
    expect(r.end).toEqual({
      motion,
      group: null,
      index: null,
      reason: "finished",
      queueEmpty: false,
    });
    expect(r.held).toEqual([motion]);
    expect(r.second).toEqual({
      motion,
      group: null,
      index: null,
      reason: "stopped",
      queueEmpty: true,
    });
    // The held one left with the stop without a second end.
    expect(r.ends).toEqual([
      { motion, reason: "finished", queueEmpty: false, same: true },
      { motion, reason: "stopped", queueEmpty: true, same: true },
    ]);
    expect(r.after).toEqual([]);
  }, 60000);

  it("moves, zooms and resizes the view", async () => {
    const t = await run<{ zoom: number; x: number; pixelsPerUnit: number }>(`(view) => {
      view.setView({ zoom: 2, x: 0.1 });
      return view.viewTransform;
    }`);
    expect(t).toMatchObject({ zoom: 2, x: 0.1, y: 0, rotation: 0 });
    expect(t.pixelsPerUnit).toBeGreaterThan(0);
    // panBy moves the model by CSS pixels: the model point under p goes to p + (30, -20).
    const pan = await run<{ before: number[]; after: number[]; ppu: number; x: number }>(
      `(view) => {
        const r = view.canvas.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const before = view.toModel(cx, cy);
        view.panBy(30, -20);
        const after = view.toModel(cx + 30, cy - 20);
        return { before: [before.x, before.y], after: [after.x, after.y],
          ppu: view.viewTransform.pixelsPerUnit, x: view.viewTransform.x };
      }`,
    );
    expect(pan.after[0]).toBeCloseTo(pan.before[0]!, 6);
    expect(pan.after[1]).toBeCloseTo(pan.before[1]!, 6);
    expect(pan.x).toBeCloseTo(0.1 - 30 / pan.ppu, 6);
    await run("(view) => view.resetView()");
    const size = await run<{ before: number[]; after: number[] }>(`async (view) => {
      const before = [view.canvas.width, view.canvas.height];
      view.canvas.style.height = "200px";
      view.resize();
      const after = [view.canvas.width, view.canvas.height];
      view.canvas.style.height = "";
      view.resize();
      return { before, after };
    }`);
    expect(size.after[1]).toBe(200);
    expect(size.after[0]).toBe(size.before[0]);
  });

  it("rotates the view about the canvas center: drawing, toModel and panBy agree", async () => {
    // Paused, the pose holds, so the two pictures differ only by the turn.
    const shot = `async (view) => {
      const blob = await view.screenshot();
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }`;
    await run("(view, model) => { view.paused = true; model.setEffect('look', false); }");
    try {
      const flat = decodePng(new Uint8Array(await run<number[]>(shot)));
      const turned = decodePng(
        new Uint8Array(
          await run<number[]>(
            `async (view) => { view.setView({ rotation: 90 }); return (${shot})(view); }`,
          ),
        ),
      );
      const { width: W, height: H } = flat;
      // Pixel (P, Q) of the turned picture shows what pixel (P', Q') of the flat one shows.
      let model = 0;
      let differ = 0;
      for (let Q = 0; Q < H; Q++)
        for (let P = 0; P < W; P++) {
          const u = P + 0.5 - W / 2;
          const v = H / 2 - (Q + 0.5);
          const P2 = Math.round(W / 2 + v - 0.5);
          const Q2 = Math.round(H / 2 + u - 0.5);
          if (P2 < 0 || P2 >= W || Q2 < 0 || Q2 >= H) continue;
          const a = turned.data[4 * (Q * W + P) + 3]!;
          const b = flat.data[4 * (Q2 * W + P2) + 3]!;
          if (a > 0 || b > 0) model++;
          if (Math.abs(a - b) > 64) differ++;
        }
      expect(model, "model pixels compared").toBeGreaterThan(1000);
      expect(differ / model, "pixels that differ").toBeLessThan(0.02);
      // A quarter turn counterclockwise: model up points left on screen, model right points up.
      const m = await run<{ c: number[]; right: number[]; up: number[]; ppu: number; rot: number }>(
        `(view) => {
          const r = view.canvas.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const p = (x, y) => { const q = view.toModel(x, y); return [q.x, q.y]; };
          const t = view.viewTransform;
          return { c: p(cx, cy), right: p(cx + 40, cy), up: p(cx, cy - 40),
            ppu: t.pixelsPerUnit, rot: t.rotation };
        }`,
      );
      expect(m.rot).toBe(90);
      const d = 40 / m.ppu;
      expect(m.right[0]! - m.c[0]!).toBeCloseTo(0, 6);
      expect(m.right[1]! - m.c[1]!).toBeCloseTo(-d, 6);
      expect(m.up[0]! - m.c[0]!).toBeCloseTo(d, 6);
      expect(m.up[1]! - m.c[1]!).toBeCloseTo(0, 6);
      // panBy stays in screen directions under the turn.
      const pan = await run<{ before: number[]; after: number[] }>(
        `(view) => {
          const r = view.canvas.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const before = view.toModel(cx, cy);
          view.panBy(25, 10);
          const after = view.toModel(cx + 25, cy + 10);
          return { before: [before.x, before.y], after: [after.x, after.y] };
        }`,
      );
      expect(pan.after[0]).toBeCloseTo(pan.before[0]!, 6);
      expect(pan.after[1]).toBeCloseTo(pan.before[1]!, 6);
      // A full turn draws exactly the flat picture.
      const full = decodePng(
        new Uint8Array(
          await run<number[]>(
            `async (view) => { view.resetView(); view.setView({ rotation: 360 }); return (${shot})(view); }`,
          ),
        ),
      );
      expect(Buffer.from(full.data).equals(Buffer.from(flat.data))).toBe(true);
    } finally {
      await run(
        "(view, model) => { view.resetView(); view.paused = false; model.setEffect('look', true); }",
      );
    }
  }, 60000);

  it("reloads the textures after a lost GPU context, keeping the animation state", async () => {
    const r = await run<{ events: string[]; angle: number; drawn: boolean }>(
      `async (view, model) => {
        const events = [];
        view.on("contextlost", () => events.push("lost"));
        view.on("contextrestored", () => events.push("restored"));
        // Look writes AngleX through physics (a convenience); off, AngleX is its base value.
        model.setEffect("look", false);
        model.setParameter("AngleX", 12);
        const ext = view.stage.gl.getExtension("WEBGL_lose_context");
        ext.loseContext();
        await new Promise((r) => setTimeout(r, 100));
        ext.restoreContext();
        for (let i = 0; i < 600 && !events.includes("restored"); i++) await new Promise((r) => setTimeout(r, 100));
        const blob = await view.screenshot();
        return { events, angle: model.getParameter("AngleX"), drawn: blob.size > 1000 };
      }`,
    );
    expect(r.events).toEqual(["lost", "restored"]);
    expect(r.angle).toBe(12);
    expect(r.drawn).toBe(true);
  }, 120000);

  it("decodes zip names in legacy encodings with the browser's decoders, and rejects RAR", async () => {
    const hex = (h: string) => Uint8Array.from(h.split(" ").map((x) => parseInt(x, 16)));
    const ascii = (t: string) => new TextEncoder().encode(t);
    const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
    const settings = (moc: string, exp: string[] = []) =>
      JSON.stringify({
        Version: 3,
        FileReferences: { Moc: moc, Expressions: exp.map((f) => ({ Name: f, File: f })) },
      });
    const archives: [string, number[]][] = [
      // 测/测.moc3 in GBK
      ["gbk.zip", [...buildZip([{ name: cat(hex("b2 e2 2f b2 e2"), ascii(".moc3")), data: "m" }])]],
      // 日本.* in Shift_JIS, which also decodes (wrongly) as GB18030
      [
        "sjis.zip",
        [
          ...buildZip([
            { name: cat(hex("93 fa 96 7b"), ascii(".model3.json")), data: settings("日本.moc3") },
            { name: cat(hex("93 fa 96 7b"), ascii(".moc3")), data: "m" },
          ]),
        ],
      ],
      // 똠: a CP949 extension syllable, which browsers' EUC-KR decodes
      [
        "cp949.zip",
        [
          ...buildZip([
            { name: "k.model3.json", data: settings("k.moc3", ["똠.exp3.json"]) },
            { name: "k.moc3", data: "m" },
            { name: cat(hex("8c 63"), ascii(".exp3.json")), data: "{}" },
          ]),
        ],
      ],
    ];
    const r = await run<{ results: { enc: string; names: string[] }[]; rar: string }>(
      `async (view, model, archives) => {
        const lib = await import(new URL("/dist/lib/mochi2d.js", location.href).href);
        const results = archives.map(([label, bytes]) => {
          const s = lib.sourceFromZip(label, new Uint8Array(bytes));
          return { enc: s.nameEncoding, names: [...s.list()] };
        });
        const rarBytes = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, 0, 0]);
        const rar = await lib.openModelInput(new File([rarBytes], "model.rar")).then(
          () => "opened",
          (e) => e.name + ": " + e.message,
        );
        return { results, rar };
      }`,
      archives,
    );
    expect(r.results).toEqual([
      { enc: "gb18030", names: ["测/测.moc3"] },
      { enc: "shift_jis", names: ["日本.moc3", "日本.model3.json"] },
      { enc: "euc-kr", names: ["k.moc3", "k.model3.json", "똠.exp3.json"] },
    ]);
    expect(r.rar).toMatch(/^UnsupportedArchiveError: "model\.rar" is a RAR archive/);
  }, 120000);

  /** Decoded screenshots of the next frames, one per call of `shot()` in `fn`. */
  const SHOT = `async () => Array.from(new Uint8Array(await (await view.screenshot()).arrayBuffer()))`;
  const rgba = (png: number[]) => Buffer.from(decodePng(Uint8Array.from(png)).data);
  const opaque = (png: number[]) => {
    const d = rgba(png);
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
    return n;
  };

  it("shows patches and parameter changes at the next frame; runtime.update(0) applies them at once", async () => {
    // Paused, with look off, the pose holds between screenshots.
    const r = await run<{
      shots: number[][];
      notYet: boolean;
      atOnce: boolean;
    }>(`async (view, model) => {
      const shot = ${SHOT};
      view.paused = true;
      model.setEffect("look", false);
      // ParamAngleX moves vertices itself; physics would overwrite it every frame.
      model.setEffect("physics", false);
      model.setParameter("ParamAngleX", 0);
      const shots = [await shot()];
      const inst = () => model.runtime.instance;
      const opacities = Array.from(model.runtime.model.keyforms.meshOpacity);
      model.patch({ group: "artMeshKeyforms", field: "opacity", start: 0,
        values: opacities.map(() => 0) });
      const notYet = inst().drawableOpacity.some((o) => o !== 0);
      shots.push(await shot());
      model.patch({ group: "artMeshKeyforms", field: "opacity", start: 0, values: opacities });
      shots.push(await shot());
      // setParameter shows at the next frame; runtime.update(0) applies it at once,
      // and the view draws that evaluation.
      const sum = () => inst().drawableVertices.reduce((t, v) => v.reduce((a, x) => a + x, t), 0);
      const before = sum();
      model.setParameter("ParamAngleX", 20);
      const notYetParameter = sum() === before;
      model.runtime.update(0);
      const atOnce = sum() !== before;
      shots.push(await shot());
      // (getParameter reads the latest frame's value, breath included: set the base again.)
      model.setParameter("ParamAngleX", 0);
      shots.push(await shot());
      model.setEffect("physics", true);
      return { shots, notYet: notYet && notYetParameter, atOnce };
    }`);
    const [s0, hidden, restored, turned, back] = r.shots;
    expect(r.notYet, "a patch waits for the next frame").toBe(true);
    expect(opaque(s0!)).toBeGreaterThan(10000);
    expect(opaque(hidden!), "every mesh at opacity 0").toBe(0);
    expect(rgba(restored!).equals(rgba(s0!))).toBe(true);
    expect(r.atOnce).toBe(true);
    expect(rgba(turned!).equals(rgba(s0!)), "the view drew the evaluation").toBe(false);
    expect(rgba(back!).equals(rgba(s0!))).toBe(true);
  }, 120000);

  it("advances without drawing, then draws the same picture as drawing every frame", async () => {
    // Two views of the same model and item, each driving its own loop.
    const r = await run<{
      every: number[];
      later: number[];
      draws: number;
      frames: number;
      ended: number;
      loopDraws: number;
      loopFrames: number;
    }>(`async (view) => {
      const make = async () => {
        const canvas = document.createElement("canvas");
        canvas.style.width = "200px";
        canvas.style.height = "300px";
        document.body.append(canvas);
        // Small textures load fast; both views use the same.
        const v = new view.constructor(canvas, { autoStart: false, look: "off", textureBudget: 256 });
        const url = "../../models/DeepSeek/大肥鱼.model3.json";
        const m = await v.load(url);
        for (const e of ["eyeBlink", "idle"]) m.setEffect(e, false);
        const item = await v.addItem(url, { id: "twin" });
        item.setEffect("eyeBlink", false);
        item.setEffect("idle", false);
        const gl = canvas.getContext("webgl2");
        const counter = { draws: 0 };
        const draw = gl.drawElements.bind(gl);
        gl.drawElements = (...a) => { counter.draws++; return draw(...a); };
        let frames = 0;
        v.on("frame", () => frames++);
        let ended = 0;
        v.on("motionend", () => ended++);
        await m.startMotionFile("Animation/举手切默认手.motion3.json");
        m.setParameter("ParamAngleX", 25);
        return { v, m, canvas, counter, frames: () => frames, ended: () => ended };
      };
      const shot = async (v) =>
        Array.from(new Uint8Array(await (await v.screenshot()).arrayBuffer()));
      const a = await make();
      const b = await make();
      for (let i = 0; i < 90; i++) a.v.advance(1 / 30);
      b.counter.draws = 0;
      for (let i = 0; i < 90; i++) b.v.advance(1 / 30, { draw: false });
      const draws = b.counter.draws;
      const frames = b.frames();
      b.v.draw();
      const every = await shot(a.v);
      const later = await shot(b.v);
      // The loop's switch: with drawing off, frames advance and draw nothing.
      b.v.drawing = false;
      b.counter.draws = 0;
      const before = b.frames();
      b.v.start();
      await new Promise((done) => setTimeout(done, 300));
      b.v.stop();
      const loopDraws = b.counter.draws;
      const loopFrames = b.frames() - before;
      b.v.drawing = true;
      const ended = b.ended();
      for (const x of [a, b]) { x.v.dispose(); x.canvas.remove(); }
      return { every, later, draws, frames, ended, loopDraws, loopFrames };
    }`);
    expect(r.draws, "no draw while advancing without drawing").toBe(0);
    expect(r.frames, '"frame" fires for every advance').toBe(90);
    expect(r.loopDraws).toBe(0);
    expect(r.loopFrames).toBeGreaterThan(0);
    expect(opaque(r.every)).toBeGreaterThan(1000);
    expect(rgba(r.later).equals(rgba(r.every)), "the same picture").toBe(true);
    expect(r.ended, "the motion ended while nothing was drawn").toBe(1);
  }, 120000);

  it("holds the physics pose while paused (holdPhysicsWhenPaused, on by default)", async () => {
    const r = await run<{ hold: boolean; before: number[]; after: number[]; base: number[] }>(
      `(view, model) => {
        const effects = ["eyeBlink", "breath", "look", "idle"];
        for (const e of effects) model.setEffect(e, false);
        model.setParameter("AngleX", 30);
        for (let i = 0; i < 40; i++) view.advance(1 / 60);
        const ids = [...model.runtime.physicsInputs.keys()];
        view.paused = true;
        const before = ids.map((id) => model.getParameter(id));
        model.setParameter("AngleY", 5); // a change while paused: a frame that takes no time
        view.advance(0);
        const out = {
          hold: model.runtime.animator.physics.holdOnZeroSteps,
          before,
          after: ids.map((id) => model.getParameter(id)),
          base: ids.map((id) => model.getParameterBase(id)),
        };
        view.paused = false;
        model.setParameter("AngleX", 0);
        model.setParameter("AngleY", 0);
        for (const e of effects) model.setEffect(e, true);
        return out;
      }`,
    );
    expect(r.hold).toBe(true);
    expect(r.after).toEqual(r.before);
    // The reference rule would have shown the base values.
    expect(r.after).not.toEqual(r.base);
  }, 60000);

  it("tints art meshes until cleared: white changes nothing, RGB darkens, A fades", async () => {
    const r = await run<{ shots: number[][]; count: number }>(`async (view, model) => {
      const shot = ${SHOT};
      view.paused = true;
      model.setEffect("look", false);
      const shots = [await shot()];
      const ids = model.runtime.model.meshes.ids;
      for (const id of ids) model.setTint(id, [1, 1, 1]);
      shots.push(await shot());
      for (const id of ids) model.setTint(id, [0.5, 0.5, 0.5]);
      shots.push(await shot());
      const count = model.tints.size;
      for (const id of ids) model.setTint(id, [1, 1, 1, 0]);
      shots.push(await shot());
      model.clearTints();
      shots.push(await shot());
      return { shots, count };
    }`);
    const [plain, white, dark, , cleared] = r.shots.map(rgba);
    expect(r.count).toBe(715);
    expect(white!.equals(plain!)).toBe(true);
    expect(cleared!.equals(plain!)).toBe(true);
    expect(opaque(r.shots[3]!), "every mesh at alpha 0").toBe(0);
    // Half the color everywhere: the same coverage (alpha), half the light.
    let sumPlain = 0;
    let sumDark = 0;
    for (let i = 0; i < plain!.length; i += 4) {
      expect(dark![i + 3]).toBe(plain![i + 3]);
      const a = plain![i + 3]! / 255;
      for (let c = 0; c < 3; c++) {
        sumPlain += plain![i + c]! * a;
        sumDark += dark![i + c]! * a;
      }
    }
    expect(sumDark / sumPlain).toBeGreaterThan(0.45);
    expect(sumDark / sumPlain).toBeLessThan(0.55);
  }, 120000);

  it("replaces the model's data, keeping its textures, view and parameter values", async () => {
    // A structural edit: other data with other meshes and parameters (3 meshes, P, Q, R).
    const s = new Synth(5);
    s.part({ id: "Root" });
    const P = s.param("P", 0, 1, 0.5);
    s.param("Q", -1, 1, 0);
    s.param("R", 0, 1, 0);
    const bP = s.band([s.binding(P, [0, 1])]);
    const quad = (x: number, y: number) => [x, y, x + 0.2, y, x, y + 0.2, x + 0.2, y + 0.2];
    for (const [i, x] of [-0.5, 0, 0.5].entries())
      s.mesh({
        id: `S${i}`,
        band: bP,
        triangles: [0, 1, 2, 1, 3, 2],
        uvs: [0.2, 0.2, 0.4, 0.2, 0.2, 0.4, 0.4, 0.4],
        keyforms: [{ positions: quad(x, 0) }, { positions: quad(x, 0.2) }],
      });
    const synthetic = Array.from(s.build());
    const r = await run<{
      shots: number[][];
      sameTextures: boolean[];
      liveTextures: boolean[];
      newRuntime: boolean;
      view: [unknown, unknown];
      angle: number[];
      ends: string[];
      edited: { meshes: number; params: string[] };
      rejected: string;
      afterReject: boolean;
      memory: number[];
      raced: string[];
    }>(
      `async (view, model, synthetic) => {
        const lib = await import(new URL("/dist/lib/mochi2d.js", location.href).href);
        const shot = ${SHOT};
        view.paused = true;
        model.setEffect("look", false);
        const url = new URL("../../models/DeepSeek/大肥鱼.moc3", location.href);
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const read = lib.readMoc(bytes);
        view.setView({ zoom: 1.4, x: 0.05, y: -0.02, rotation: 12 });
        // Base values left by earlier tests' motions would not survive the other data below.
        model.resetParameters();
        for (const p of model.parts) model.setPartOpacity(p.id, p.defaultOpacity);
        model.clearExpression();
        model.setParameter("AngleX", 18);
        const textures = [...model.live.textures];
        const runtime = model.runtime;
        const ends = [];
        const stop = view.on("motionend", (e) => ends.push(e.reason));
        const started = await model.startMotionFile("Animation/举手切默认手.motion3.json");
        if (!started) throw new Error("the motion did not start");
        const view0 = view.viewTransform;

        // The same data, as MocData: a new runtime, with the textures, view and values.
        await model.replace(read.data, read.version);
        const newRuntime = model.runtime !== runtime;
        const shots = [await shot()];
        // (The first renderer sized its mask atlas at zoom 1; compare renderers made at this zoom.)
        const memory = [view.stage.memory.total];
        const view1 = view.viewTransform;
        const angle = [model.getParameter("AngleX")];
        const sameTextures = model.live.textures.map((x, i) => x === textures[i]);

        // Values that patches cannot change: every other mesh disabled.
        const edited = lib.readMoc(bytes).data;
        edited.artMeshes.enabled.forEach((_, i) => i % 2 && (edited.artMeshes.enabled[i] = 0));
        await model.replace(edited, read.version);
        shots.push(await shot());

        // Other structure, then the file again.
        await model.replace(new Uint8Array(synthetic));
        const structure = { meshes: model.runtime.model.meshes.ids.length,
          params: model.parameters.map((p) => p.id) };
        shots.push(await shot());
        await model.replace(bytes);
        angle.push(model.getParameter("AngleX")); // not in the other data: back to its default
        model.setParameter("AngleX", 18);
        shots.push(await shot());
        memory.push(view.stage.memory.total);
        const gl = view.stage.gl;
        const liveTextures = model.live.textures.map((x, i) => x === textures[i] && gl.isTexture(x.texture.texture));

        // Data that does not load leaves the model as it was.
        const current = model.runtime;
        const rejected = await model.replace(new Uint8Array([1, 2, 3])).then(() => "loaded", (e) => e.name);
        const afterReject = model.runtime === current;
        shots.push(await shot());
        // Two at once: the later one is shown, the earlier one rejects.
        const first = model.replace(edited, read.version).then(() => "shown", (e) => e.name);
        const second = model.replace(bytes).then(() => "shown", (e) => e.name);
        const raced = [await first, await second];
        shots.push(await shot());
        stop();
        view.resetView();
        model.setParameter("AngleX", 0);
        return { shots, sameTextures, liveTextures, newRuntime, view: [view0, view1], angle, ends,
          edited: structure, rejected, afterReject, memory, raced };
      }`,
      synthetic,
    );
    const [s0, disabled, other, again, afterReject, raced] = r.shots; // s0: the same data, replaced
    expect(r.newRuntime).toBe(true);
    expect(r.sameTextures.length).toBeGreaterThan(0);
    expect(r.sameTextures.every(Boolean), "the same texture objects").toBe(true);
    expect(r.liveTextures.every(Boolean), "still alive after three replacements").toBe(true);
    expect(r.view[1]).toEqual(r.view[0]);
    expect(r.angle).toEqual([18, 0]);
    expect(r.ends).toEqual(["stopped"]);
    expect(opaque(disabled!)).toBeGreaterThan(0);
    expect(opaque(disabled!)).toBeLessThan(opaque(s0!));
    expect(r.edited).toEqual({ meshes: 3, params: ["P", "Q", "R"] });
    expect(rgba(other!).equals(rgba(s0!))).toBe(false);
    expect(rgba(again!).equals(rgba(s0!)), "the file again draws the same picture").toBe(true);
    expect(r.memory[1], "no GPU memory left behind").toBe(r.memory[0]);
    expect(r.rejected).toBe("MocFormatError");
    expect(r.afterReject).toBe(true);
    expect(rgba(afterReject!).equals(rgba(s0!))).toBe(true);
    expect(r.raced).toEqual(["AbortError", "shown"]);
    expect(rgba(raced!).equals(rgba(s0!)), "the later data is shown").toBe(true);
  }, 180000);

  it("maps model points to page coordinates (toPage), the inverse of toModel", async () => {
    const r = await run<{ rounds: number[][]; scaled: number[][] }>(`(view) => {
      view.setView({ zoom: 1.7, x: 0.04, y: -0.03, rotation: 33 });
      const trip = () => {
        const b = view.canvas.getBoundingClientRect();
        return [[b.left + 10, b.top + 20], [b.left + b.width / 2, b.top + b.height / 2],
          [b.right - 5, b.bottom - 7]].map(([x, y]) => {
          const m = view.toModel(x, y);
          const p = view.toPage(m.x, m.y);
          const q = view.toModel(p.x, p.y);
          return [x, y, p.x, p.y, m.x, m.y, q.x, q.y];
        });
      };
      const rounds = trip();
      // A canvas shown at half its size (CSS) maps the same way.
      view.canvas.style.transform = "scale(0.5)";
      const scaled = trip();
      view.canvas.style.transform = "";
      view.resetView();
      return { rounds, scaled };
    }`);
    for (const [x, y, px, py, mx, my, qx, qy] of [...r.rounds, ...r.scaled]) {
      expect(px).toBeCloseTo(x!, 6);
      expect(py).toBeCloseTo(y!, 6);
      expect(qx).toBeCloseTo(mx!, 9);
      expect(qy).toBeCloseTo(my!, 9);
    }
  });

  it("keeps the view through a load with keepView", async () => {
    const r = await run<{ before: unknown; kept: unknown; reset: unknown }>(
      `async (view) => {
        const url = new URL("../../models/DeepSeek/大肥鱼.model3.json", location.href).href;
        view.setView({ zoom: 1.6, x: 0.03, y: 0.01, rotation: 30 });
        const before = view.viewTransform;
        await view.load(url, { keepView: true });
        const kept = view.viewTransform;
        const model = await view.load(url);
        const reset = view.viewTransform;
        window.mochi2dExample.model = model;
        return { before, kept, reset };
      }`,
    );
    expect(r.kept).toEqual(r.before);
    expect(r.reset).toMatchObject({ zoom: 1, x: 0, y: 0, rotation: 0 });
  }, 180000);

  it("loads a zip by URL, replacing the model, and frees everything on dispose", async () => {
    // A zip of a crafted settings file (no textures) and DeepSeek-chan's model file, served at test time.
    const settings = JSON.stringify({
      Version: 3,
      FileReferences: { Moc: "大肥鱼.moc3", Textures: [], Expressions: [] },
      HitAreas: [{ Id: "ArtMesh1", Name: "Somewhere" }],
    });
    const zip = zipSync(
      {
        "m/crafted.model3.json": new TextEncoder().encode(settings),
        "m/大肥鱼.moc3": new Uint8Array(readFileSync(join(DEEPSEEK, "大肥鱼.moc3"))),
      },
      { level: 0 },
    );
    await page.route("**/crafted-test.zip", (route) =>
      route.fulfill({ status: 200, contentType: "application/zip", body: Buffer.from(zip) }),
    );
    const r = await run<{ name: string; hit: string[]; memoryBefore: number; memoryAfter: number }>(
      `async (view) => {
        const memoryBefore = view.stage.memory.total;
        const model = await view.load(new URL("/crafted-test.zip", location.href).href);
        const hit = model.hitAreas.map((h) => h.name);
        const name = model.name;
        view.dispose();
        return { name, hit, memoryBefore, memoryAfter: view.stage.memory.total };
      }`,
    );
    expect(r.name).toBe("m/crafted.model3.json");
    expect(r.hit).toEqual(["Somewhere"]);
    expect(r.memoryBefore).toBeGreaterThan(100 * 2 ** 20);
    expect(r.memoryAfter).toBe(0);
  }, 120000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});

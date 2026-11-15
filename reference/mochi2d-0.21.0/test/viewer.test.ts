/**
 * End-to-end checks of the viewer page in headless Chromium: data-driven
 * controls with the mock model, playback, stats, screenshot, model-folder
 * listing and audio loudness. Needs `npm run build` and the pre-installed
 * Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { CHROMIUM_MEDIA_ARGS, launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { decodePng } from "../tools/lib/png.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";
import { GENERATED_MICROPHONE } from "./support/generated-microphone.js";

const root = resolve(__dirname, "..");
let available = existsSync(join(root, "dist", "web", "index.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

type V = {
  mochi2dViewer: {
    stage: {
      clock: { playing: boolean; time: number };
      screenshot(): Promise<Uint8Array>;
      stop(): void;
      canvas: HTMLCanvasElement;
    };
    model: { getParameter(id: string): number; getPartOpacity(id: string): number };
    audio: {
      input: {
        context(): Promise<AudioContext>;
        playBuffer(b: AudioBuffer, label: string, o: { loop?: boolean; volume?: number }): void;
        startMicrophone(): Promise<void>;
        stop(): void;
        kind: string;
      };
      last: { rms: number; envelope: number; kind: string } | null;
    };
  };
};

describe.skipIf(!available)("viewer (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    server = await startStaticServer(join(root, "dist", "web"), root);
    browser = await launchChromium([
      ...CHROMIUM_MEDIA_ARGS,
      // A name for 127.0.0.1 that is not localhost: plain HTTP there is not a secure context.
      "--host-resolver-rules=MAP mochi2d.lan 127.0.0.1",
    ]);
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    // The microphone is a generated tone (deterministic levels, see the support file).
    await page.addInitScript(GENERATED_MICROPHONE);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("index.html", server.url).href, { waitUntil: "load" });
    await page.waitForFunction("window.mochi2dViewer && window.mochi2dViewer.stage", undefined, {
      timeout: 15000,
    });
  });
  afterAll(async () => {
    // Stop drawing the loaded model (slow in software GL) before closing.
    await page
      ?.evaluate(() => (window as unknown as V).mochi2dViewer.stage.stop(), undefined)
      .catch(() => {});
    await browser?.close();
    await server?.close();
  }, 60000);

  it("builds slider lists from the model's data, with search and reset", async () => {
    expect(await page.locator("#panel-parameters .slider-row").count()).toBe(40);
    expect(await page.locator("#panel-parts .slider-row").count()).toBe(6);
    await page.fill("#panel-parameters input[type=search]", "wave");
    expect(await page.locator("#panel-parameters .slider-row:not([hidden])").count()).toBe(2);
    await page.fill("#panel-parameters input[type=search]", "");
    const value = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>(
        '#panel-parameters input[aria-label^="Rotation"]',
      )!;
      input.value = "90";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return (window as unknown as V).mochi2dViewer.model.getParameter("mock.rotation");
    }, undefined);
    expect(value).toBe(90);
    await page.click("#panel-parameters .slider-tools button");
    expect(
      await page.evaluate(
        () => (window as unknown as V).mochi2dViewer.model.getParameter("mock.rotation"),
        undefined,
      ),
    ).toBe(0);
    const opacity = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#panel-parts input[type=range]")!;
      input.value = "0.25";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return (window as unknown as V).mochi2dViewer.model.getPartOpacity("mock.part.0");
    }, undefined);
    expect(opacity).toBe(0.25);
  });

  it("pauses, steps and shows frame statistics", async () => {
    // Every check waits for the state it reads: frames come late on a busy machine.
    const time = () =>
      page.evaluate(() => (window as unknown as V).mochi2dViewer.stage.clock.time, undefined);
    await page.click("#play-toggle");
    await page.waitForFunction("window.mochi2dViewer.stage.clock.playing === false", undefined, {
      timeout: 30000,
    });
    const t0 = await time();
    // Paused: frames still run (the stage keeps drawing), but the clock stands.
    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r));
    }, undefined);
    const t1 = await time();
    expect(t1).toBe(t0);
    await page.click("#step");
    // (A number's String is exact, so the page compares with t1 itself.)
    await page.waitForFunction(`window.mochi2dViewer.stage.clock.time !== ${t1}`, undefined, {
      timeout: 30000,
    });
    const t2 = await time();
    expect(t2 - t1).toBeCloseTo(1 / 60, 6);
    // One step only: the clock stands again.
    await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    }, undefined);
    expect(await time()).toBe(t2);
    await page.click("#play-toggle");
    await page.waitForFunction(
      "/fps/.test(document.getElementById('frame-stats').textContent)",
      undefined,
      { timeout: 30000 },
    );
  });

  it("takes a screenshot of the canvas as PNG", async () => {
    const r = await page.evaluate(async () => {
      const v = (window as unknown as V).mochi2dViewer;
      const png = await v.stage.screenshot();
      return { bytes: Array.from(png), w: v.stage.canvas.width, h: v.stage.canvas.height };
    }, undefined);
    const img = decodePng(new Uint8Array(r.bytes));
    expect([img.width, img.height]).toEqual([r.w, r.h]);
    // Opaque background by default.
    expect(img.data[3]).toBe(255);
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "lists every motion and expression file of the DeepSeek folder, referenced or not",
    async () => {
      // Models are opened from the File menu.
      await page.click("#toggle-open");
      await page.selectOption("#model-select", "DeepSeek/大肥鱼.model3.json");
      await page.waitForFunction(
        "document.querySelectorAll('#panel-expressions .anim-item').length > 0",
        undefined,
        { timeout: 10000 },
      );
      const count = (dir: string, suffix: string) =>
        readdirSync(join(DEEPSEEK, dir)).filter((n) => n.endsWith(suffix)).length;
      expect(await page.locator("#panel-motions .anim-item").count()).toBe(
        count("Animation", ".motion3.json"),
      );
      expect(await page.locator("#panel-expressions .anim-item").count()).toBe(
        count("Exp3", ".exp3.json"),
      );
    },
  );

  it.skipIf(!HAVE_DEEPSEEK)(
    "loads, evaluates and draws the DeepSeek model with data-driven controls",
    async () => {
      await page.waitForFunction(
        "/715 drawables/.test(document.getElementById('status').textContent) || /failed/.test(document.getElementById('status').textContent)",
        undefined,
        { timeout: 120000 },
      );
      expect(
        await page.evaluate(() => document.getElementById("status")!.textContent, undefined),
      ).toMatch(/moc3 v5, 715 drawables, 509 parameters, 5 textures/);
      expect(await page.locator("#panel-parameters .slider-row").count()).toBe(509);
      expect(await page.locator("#panel-parts .slider-row").count()).toBe(147);
      // Moving a slider re-evaluates the model. AngleX is a physics input that
      // drives ParamAngleX (3e.2), so with physics on the head turns.
      const moved = await page.evaluate(async () => {
        type Live = {
          instance: { drawableVertices: Float32Array[] };
          setParameter(id: string, v: number): void;
          getParameter(id: string): number;
        };
        const v = (
          window as unknown as {
            mochi2dViewer: { model: Live; stage: { clock: { time: number } } };
          }
        ).mochi2dViewer;
        const m = v.model;
        const snap = () => m.instance.drawableVertices.map((v) => Array.from(v));
        const before = snap();
        m.setParameter("AngleX", 30);
        // Wait for 0.5 s of model time: the first frames after loading can take
        // a second in software GL.
        const t0 = v.stage.clock.time;
        for (let i = 0; i < 300 && v.stage.clock.time - t0 < 0.5; i++)
          await new Promise((r) => setTimeout(r, 100));
        const after = snap();
        return {
          changed: before.some((v, d) => v.some((x, i) => x !== after[d]![i])),
          angle: m.getParameter("ParamAngleX"),
        };
      }, undefined);
      expect(moved.changed).toBe(true);
      expect(Math.abs(moved.angle)).toBeGreaterThan(1);
    },
    180000,
  );

  it.skipIf(!HAVE_DEEPSEEK)(
    "draws DeepSeek with the model renderer: masks, notice, movable view, mask settings, idle frames",
    async () => {
      type Live = {
        renderer: {
          stats: {
            pipeline: string;
            masks: string;
            drawn: number;
            masked: number;
            maskBuilds: number;
            masksReused: number;
            framebufferBinds: number;
          };
          maskSize: number;
          masks: string;
        };
        view: { zoom: number; dx: number; dy: number };
        zoomAt(f: number, px: number, py: number, w: number, h: number): void;
        panBy(dx: number, dy: number, w: number, h: number): void;
        resetView(): void;
        textureNotice: string | null;
      };
      type W = {
        mochi2dViewer: {
          model: Live;
          stage: { screenshot(): Promise<Uint8Array>; canvas: HTMLCanvasElement; idle: boolean };
        };
      };
      const shot = async () => {
        const r = await page.evaluate(async () => {
          const png = await (window as unknown as W).mochi2dViewer.stage.screenshot();
          return Array.from(png);
        }, undefined);
        return decodePng(new Uint8Array(r));
      };
      // Pixels that differ from the opaque background in the top-left corner.
      const drawn = (img: { data: Uint8Array }) => {
        const d = img.data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4)
          if (
            Math.abs(d[i]! - d[0]!) + Math.abs(d[i + 1]! - d[1]!) + Math.abs(d[i + 2]! - d[2]!) >
            6
          )
            n++;
        return n / (d.length / 4);
      };
      // Frames of DeepSeek-chan take up to a few hundred ms in software GL (more
      // when other test files run in parallel): wait until the stage skips one.
      const settle = () =>
        page.waitForFunction("window.mochi2dViewer.stage.idle === true", undefined, {
          timeout: 30000,
        });

      // A still model: no effects, the pose back at rest.
      await page.evaluate(() => {
        const m = (window as unknown as W).mochi2dViewer.model as unknown as {
          setEffect(name: string, on: boolean): void;
          setParameter(id: string, v: number): void;
        };
        for (const e of ["physics", "eyeBlink", "breath", "look"]) m.setEffect(e, false);
        m.setParameter("AngleX", 0);
      }, undefined);
      await settle();
      const info = await page.evaluate(() => {
        const v = (window as unknown as W).mochi2dViewer;
        const m = v.model;
        const notice = document.getElementById("stage-notice")!;
        return {
          stats: { ...m.renderer.stats },
          masks: m.renderer.masks,
          idle: v.stage.idle,
          notice: m.textureNotice,
          noticeHidden: notice.hidden,
          noticeText: notice.textContent,
          statsTitle: document.getElementById("frame-stats")!.title,
        };
      }, undefined);
      expect(info.stats.pipeline).toBe("direct");
      expect(info.masks).toBe("atlas");
      expect(info.stats.drawn).toBeGreaterThan(400);
      expect(info.stats.masked).toBeGreaterThan(100);
      // Every needed group is built or reused; all masks come from one atlas pass.
      expect(info.stats.maskBuilds + info.stats.masksReused).toBeGreaterThan(20);
      expect(info.stats.framebufferBinds).toBeLessThanOrEqual(2);
      // Nothing changes: the stage stops redrawing.
      expect(info.idle).toBe(true);
      expect(info.statsTitle).toMatch(/draw calls \d+, mask builds/);
      // The notice is visible exactly when a texture was downscaled.
      expect(info.noticeHidden).toBe(info.notice === null);
      if (info.notice) expect(info.noticeText).toBe(info.notice);

      const atlasShot = await shot();
      const base = drawn(atlasShot);
      expect(base, "model pixels on screen").toBeGreaterThan(0.05);
      // Zooming in about the center covers more of the canvas; reset restores it.
      await page.evaluate(() => {
        const v = (window as unknown as W).mochi2dViewer;
        const c = v.stage.canvas;
        v.model.zoomAt(3, c.width / 2, c.height / 2, c.width, c.height);
      }, undefined);
      expect(drawn(await shot())).toBeGreaterThan(base * 1.5);
      await page.evaluate(
        () => (window as unknown as W).mochi2dViewer.model.resetView(),
        undefined,
      );
      expect(Math.abs(drawn(await shot()) - base)).toBeLessThan(0.002);

      // The reference masks look the same on screen as the atlas.
      // The mask setting is in the Display menu.
      await page.click("#menu-display");
      await page.selectOption("#mask-size", "4096");
      await page.keyboard.press("Escape");
      const ref = await page.evaluate(() => {
        const r = (window as unknown as W).mochi2dViewer.model.renderer;
        return { masks: r.masks, size: r.maskSize };
      }, undefined);
      expect(ref).toEqual({ masks: "per-drawable", size: 4096 });
      const refShot = await shot();
      let big = 0;
      for (let i = 0; i < refShot.data.length; i += 4) {
        let d = 0;
        for (let c = 0; c < 4; c++)
          d = Math.max(d, Math.abs(refShot.data[i + c]! - atlasShot.data[i + c]!));
        if (d > 16) big++;
      }
      expect(big / (refShot.data.length / 4), "pixels differing by more than 16").toBeLessThan(
        0.002,
      );
      await page.click("#menu-display");
      await page.selectOption("#mask-size", "atlas");
      await page.keyboard.press("Escape");
    },
    120000,
  );

  it.skipIf(!HAVE_DEEPSEEK)(
    "animates DeepSeek: names, effects, physics-driven sliders, motions, expressions, look, lip sync, hits",
    async () => {
      type Live = {
        getParameter(id: string): number;
        setEffect(name: string, on: boolean): void;
        animator: {
          motions: { size: number; time: number };
          expressions: { expressions: unknown[] };
          look: { targetX: number; x: number };
          lipSync: { value: number } | null;
        };
      };
      type W = {
        mochi2dViewer: {
          model: Live;
          audio: { playBytes(label: string, bytes: Uint8Array): Promise<void> };
        };
      };
      const live = <R>(fn: (m: Live) => R) =>
        page.evaluate((src) => {
          const m = (window as unknown as W).mochi2dViewer.model;
          return new Function("m", `return (${src})(m)`)(m) as R;
        }, fn.toString());

      // Display names from the display-info file (B3), with the ID as tooltip.
      const cdi = JSON.parse(
        readFileSync(join(DEEPSEEK, "大肥鱼.cdi3.json"), "utf8").replace(/^﻿/, ""),
      ) as { Parameters: { Id: string; Name: string }[] };
      const name = cdi.Parameters.find((p) => p.Id === "ParamAngleX")!.Name;
      const row = await page.evaluate(() => {
        const r = [...document.querySelectorAll("#panel-parameters .slider-row")].find((x) =>
          x.querySelector("label")!.title.startsWith("ParamAngleX"),
        )!;
        return { label: r.querySelector("label")!.firstChild!.textContent };
      }, undefined);
      expect(row.label).toBe(name);

      // Effects back on through the Animation menu; ParamAngleX is then driven by physics from AngleX.
      await page.click("#menu-animation");
      for (const e of ["physics", "eyeBlink", "breath", "look"])
        await page.check(`#panel-animation input[data-effect="${e}"]`);
      await page.keyboard.press("Escape");
      const note = await page.evaluate(() => {
        const r = [...document.querySelectorAll("#panel-parameters .slider-row")].find((x) =>
          x.querySelector("label")!.title.startsWith("ParamAngleX"),
        )!;
        return {
          text: r.querySelector(".slider-note")!.textContent,
          disabled: r.querySelector<HTMLInputElement>("input")!.disabled,
        };
      }, undefined);
      expect(note).toEqual({ text: "physics ← AngleX", disabled: true });

      // A motion from the resource tree (double-click plays it): its AngleX curve turns the
      // head through physics (D1).
      await page.dblclick('#panel-motions .anim-item[title$="脱捕.motion3.json"]');
      await page.waitForFunction(
        "window.mochi2dViewer.model.animator.motions.time > 2.2",
        undefined,
        { timeout: 60000 },
      );
      const motion = await live((m) => ({
        size: m.animator.motions.size,
        angleX: m.getParameter("AngleX"),
        paramAngleX: m.getParameter("ParamAngleX"),
      }));
      expect(motion.size).toBe(1);
      expect(motion.angleX).toBeGreaterThan(1);
      expect(motion.paramAngleX).toBeGreaterThan(1);

      // An expression from the resource tree.
      await page.dblclick("#panel-expressions .anim-item >> nth=0");
      await page.waitForFunction(
        "window.mochi2dViewer.model.animator.expressions.expressions.length === 1",
        undefined,
        { timeout: 10000 },
      );

      // Look: dragging on the canvas sets the target; releasing returns it to (0, 0).
      const box = (await page.locator("#canvas").boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 4 });
      await page.waitForFunction("window.mochi2dViewer.model.animator.look.x > 0.05", undefined, {
        timeout: 30000,
      });
      expect(await live((m) => m.animator.look.targetX)).toBeGreaterThan(0.3);
      await page.mouse.up();
      expect(await live((m) => m.animator.look.targetX)).toBe(0);

      // A click without dragging hit-tests (DeepSeek-chan's settings have no hit areas).
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
      await page.waitForFunction(
        "/Topmost drawable here: ArtMesh\\d+|Nothing here/.test(document.getElementById('status').textContent)",
        undefined,
        { timeout: 30000 },
      );

      // Lip sync from a WAV file played in the audio panel: ParamMouthOpenY opens.
      await page.evaluate(async () => {
        const rate = 8000;
        const n = rate * 2;
        const b = new Uint8Array(44 + 2 * n);
        const dv = new DataView(b.buffer);
        const text = (o: number, s: string) =>
          [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
        text(0, "RIFF");
        dv.setUint32(4, 36 + 2 * n, true);
        text(8, "WAVE");
        text(12, "fmt ");
        dv.setUint32(16, 16, true);
        dv.setUint16(20, 1, true);
        dv.setUint16(22, 1, true);
        dv.setUint32(24, rate, true);
        dv.setUint32(28, rate * 2, true);
        dv.setUint16(32, 2, true);
        dv.setUint16(34, 16, true);
        text(36, "data");
        dv.setUint32(40, 2 * n, true);
        for (let i = 0; i < n; i++)
          dv.setInt16(
            44 + 2 * i,
            Math.round(16000 * Math.sin((2 * Math.PI * 300 * i) / rate)),
            true,
          );
        await (window as unknown as W).mochi2dViewer.audio.playBytes("tone.wav", b);
      }, undefined);
      await page.waitForFunction(
        "(window.mochi2dViewer.model.animator.lipSync?.value ?? 0) > 0.2",
        undefined,
        { timeout: 30000 },
      );
      expect(await live((m) => m.getParameter("ParamMouthOpenY"))).toBeGreaterThan(0.2);
      // The audio panel may be collapsed: press its Stop button directly.
      await page.evaluate(
        () => document.querySelector<HTMLButtonElement>('#panel-audio [data-act="stop"]')!.click(),
        undefined,
      );
      await page.waitForFunction(
        "window.mochi2dViewer.model.animator.lipSync.value === 0",
        undefined,
        { timeout: 30000 },
      );

      // Stop motions (Edit menu).
      await page.click("#menu-edit");
      await page.click("#edit-stop");
      expect(await live((m) => m.animator.motions.size)).toBe(0);
    },
    180000,
  );

  it("measures the loudness of played audio", async () => {
    const r = await page.evaluate(async () => {
      const a = (window as unknown as V).mochi2dViewer.audio;
      const ctx = await a.input.context();
      const rate = ctx.sampleRate;
      const buf = ctx.createBuffer(1, rate, rate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
      a.input.playBuffer(buf, "sine", { loop: true, volume: 0 });
      const t0 = ctx.currentTime;
      // Wait for the audio clock and the analysis, however slow the page is
      // (a fixed wait failed under load).
      const deadline = performance.now() + 20000;
      while (
        performance.now() < deadline &&
        !(ctx.currentTime - t0 > 0.3 && (a.last?.rms ?? 0) > 0.3 && (a.last?.envelope ?? 0) > 0.2)
      )
        await new Promise((r) => setTimeout(r, 25));
      const out = {
        advanced: ctx.currentTime - t0,
        rms: a.last?.rms ?? -1,
        envelope: a.last?.envelope ?? -1,
      };
      a.input.stop();
      return out;
    }, undefined);
    expect(r.advanced, "AudioContext clock did not run").toBeGreaterThan(0.3);
    expect(r.rms).toBeCloseTo(0.5 / Math.SQRT2, 1);
    expect(r.envelope).toBeGreaterThan(0.2);
  });

  it("measures the microphone", async () => {
    const r = await page.evaluate(async () => {
      const a = (window as unknown as V).mochi2dViewer.audio;
      try {
        await a.input.startMicrophone();
      } catch (e) {
        return { error: String(e), max: 0 };
      }
      // The generated tone has an RMS of 0.354: wait until the analysis sees it.
      let max = 0;
      const deadline = performance.now() + 20000;
      while (performance.now() < deadline && max <= 0.3) {
        await new Promise((r) => setTimeout(r, 25));
        max = Math.max(max, a.last?.rms ?? 0);
      }
      a.input.stop();
      return { error: null, max };
    }, undefined);
    expect(r.error).toBeNull();
    expect(r.max).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "moves the model's mouth with the microphone while the Lip sync effect is on",
    async () => {
      type M = {
        mochi2dViewer: {
          model: { getParameter(id: string): number; runtime: { liveLipSync: unknown } };
          audio: {
            input: { kind: string; live: { state: string; currentStream: MediaStream } | null };
            lip: { settings: { gain: number } };
            liveLipSync: unknown;
          };
        };
      };
      const click = (sel: string) =>
        page.evaluate((s) => document.querySelector<HTMLElement>(s)!.click(), sel);
      /** Max and min of ParamMouthOpenY over up to `ms` (stops early above `stop`). */
      const sample = (ms: number, stop = Infinity) =>
        page.evaluate(
          async ([ms, stop]) => {
            const v = (window as unknown as M).mochi2dViewer;
            let max = -Infinity;
            let min = Infinity;
            const t0 = performance.now();
            while (performance.now() - t0 < ms && max <= stop) {
              await new Promise((r) => requestAnimationFrame(r));
              const m = v.model.getParameter("ParamMouthOpenY");
              max = Math.max(max, m);
              min = Math.min(min, m);
            }
            return { max, min };
          },
          [ms, stop] as const,
        );
      // The sliders show the defaults, and change the settings.
      const outputs = () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll("#panel-audio .mic-sliders output")].map(
              (o) => o.textContent,
            ),
          undefined,
        );
      expect(await outputs()).toEqual(["×12", "-45 dB", "30 ms", "120 ms"]);
      const gain = await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>(
          '#panel-audio input[data-mic="gain"]',
        )!;
        input.value = "20";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return (window as unknown as M).mochi2dViewer.audio.lip.settings.gain;
      }, undefined);
      expect(gain).toBeCloseTo(10, 9);
      expect((await outputs())[0]).toBe("×10");
      await click('#panel-audio input[data-mic="gain"] ~ .reset');
      expect((await outputs())[0]).toBe("×12");

      // The microphone drives the mouth. An earlier test left an expression
      // on, so the mouth's base value is measured with the Lip sync effect off.
      const setLipSync = (on: boolean) =>
        page.evaluate((on) => {
          const box = document.querySelector<HTMLInputElement>(
            '#panel-animation input[data-effect="lipSync"]',
          )!;
          if (box.checked !== on) box.click();
        }, on);
      await click('#panel-audio [data-act="mic"]');
      await page.waitForFunction(
        "window.mochi2dViewer.audio.input.live?.state === 'running'",
        undefined,
        { timeout: 15000 },
      );
      expect(
        await page.evaluate(() => {
          const v = (window as unknown as M).mochi2dViewer;
          return (
            v.model.runtime.liveLipSync === v.audio.liveLipSync && v.audio.liveLipSync !== null
          );
        }, undefined),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.querySelector("#panel-audio .now-playing")!.textContent,
          undefined,
        ),
      ).toMatch(/^Listening: /);
      // With the Lip sync effect off, the mouth stays put while the microphone runs.
      // Wait until the switch is off and two frames have run with it.
      await setLipSync(false);
      await page.waitForFunction(
        "window.mochi2dViewer.model.runtime.animator.enabled.lipSync === false",
        undefined,
        { timeout: 30000 },
      );
      await page.evaluate(async () => {
        for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
      }, undefined);
      const off = await sample(1500);
      expect(off.max - off.min).toBeLessThan(1e-6);
      await setLipSync(true);
      const on = await sample(20000, off.max + 0.2);
      expect(on.max).toBeGreaterThan(off.max + 0.2);

      // Pressing Microphone again releases it, and the mouth closes.
      await page.evaluate(() => {
        const v = (window as unknown as M).mochi2dViewer;
        (window as unknown as { micStream: MediaStream }).micStream =
          v.audio.input.live!.currentStream;
      }, undefined);
      await click('#panel-audio [data-act="mic"]');
      const stopped = await page.evaluate(async (closed) => {
        const v = (window as unknown as M).mochi2dViewer;
        // Until the microphone is released and the mouth has closed (or 20 s).
        const deadline = performance.now() + 20000;
        do await new Promise((r) => requestAnimationFrame(r));
        while (
          performance.now() < deadline &&
          (v.audio.input.kind !== "none" ||
            v.model.runtime.liveLipSync !== null ||
            v.model.getParameter("ParamMouthOpenY") !== closed)
        );
        return {
          kind: v.audio.input.kind,
          live: v.audio.liveLipSync,
          source: v.model.runtime.liveLipSync,
          track: (window as unknown as { micStream: MediaStream }).micStream.getAudioTracks()[0]!
            .readyState,
          mouth: v.model.getParameter("ParamMouthOpenY"),
        };
      }, off.max);
      expect(stopped).toEqual({
        kind: "none",
        live: null,
        source: null,
        track: "ended",
        mouth: off.max,
      });
    },
    120000,
  );

  it("says what to do when the page is not secure (plain HTTP, not localhost)", async () => {
    const insecure = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    try {
      const port = new URL(server.url).port;
      await insecure.goto(`http://mochi2d.lan:${port}/index.html`, { waitUntil: "load" });
      await insecure.waitForFunction(
        "window.mochi2dViewer && window.mochi2dViewer.stage",
        undefined,
        {
          timeout: 15000,
        },
      );
      const before = await insecure.evaluate(
        () => document.querySelector("#panel-audio .mic-note")!.textContent,
        undefined,
      );
      expect(before).toContain(`http://mochi2d.lan:${port}`);
      expect(before).toContain("HTTPS");
      expect(before).toContain("npm run build:static");
      expect(before).toContain(`http://localhost:${port}/index.html`);
      await insecure.evaluate(
        () => document.querySelector<HTMLElement>('#panel-audio [data-act="mic"]')!.click(),
        undefined,
      );
      expect(
        await insecure.evaluate(() => document.getElementById("status")!.textContent, undefined),
      ).toBe(`Microphone: ${before}`);
    } finally {
      await insecure.close();
    }
  }, 60000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});

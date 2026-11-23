/**
 * Motion sync in the library, in headless Chromium: DeepSeek-chan with the
 * crafted ds-motionsync settings, loaded in the page from DeepSeek-chan's
 * files plus the crafted files in memory. A page's MediaStream of a
 * synthetic vowel drives an item's mouth through a setting (the worklet tap,
 * which now hands over samples, and the analyser tap); `speak` plays a sound
 * through motion sync, following the audio clock; a motion's linked sound
 * drives the mouth; `recordAudio` returns a clip for calibration. Needs
 * `npm run build:lib`, DeepSeek-chan and the pre-installed Playwright;
 * skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { CHROMIUM_MEDIA_ARGS, launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";
import { GENERATED_MICROPHONE } from "./support/generated-microphone.js";
import {
  MALE,
  TALK_SOUNDS,
  dsMotionSyncSettings,
  dsTwo,
  silence,
  vowelClip,
  wavFile,
  whiteNoise,
} from "./support/motion-sync.js";
import { VOWEL_FORMANTS, synthesizeVowel } from "../src/anim/motion-sync/voice-synth.js";

const root = resolve(__dirname, "..");
let available = HAVE_DEEPSEEK && existsSync(join(root, "dist", "lib", "mochi2d.js"));
try {
  loadPlaywright();
} catch {
  available = false;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

describe.skipIf(!available)("motion sync in the library (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const run = <R>(src: string, arg?: unknown): Promise<R> =>
    page.evaluate(
      ([s, a]) => new Function("arg", `return (${s})(window.t, arg)`)(a) as Promise<R>,
      [src, arg] as const,
    );

  beforeAll(async () => {
    server = await startStaticServer(root, root);
    browser = await launchChromium([...CHROMIUM_MEDIA_ARGS]);
    page = await browser.newPage({ viewport: { width: 600, height: 600 } });
    await page.addInitScript(GENERATED_MICROPHONE);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("examples/embed/index.html", server.url).href, { waitUntil: "load" });
    await page.waitForFunction("window.mochi2dExample !== undefined", undefined, {
      timeout: 120000,
    });
    const own = JSON.parse(
      readFileSync(join(DEEPSEEK, "大肥鱼.model3.json"), "utf8").replace(/^﻿/, ""),
    );
    const crafted: Record<string, string> = {
      "ds-motionsync.model3.json": b64(
        new TextEncoder().encode(JSON.stringify(dsMotionSyncSettings(own))),
      ),
      "ds-two.motionsync3.json": b64(new TextEncoder().encode(JSON.stringify(dsTwo()))),
      [TALK_SOUNDS.male]: b64(wavFile([vowelClip(MALE, 16000).samples], 16000)),
      [TALK_SOUNDS.female]: b64(
        wavFile([vowelClip(MALE, 16000, { vowels: ["O"] }).samples], 16000),
      ),
      [TALK_SOUNDS.noise]: b64(wavFile([whiteNoise(1, 44100, -20)], 44100)),
      [TALK_SOUNDS.silence]: b64(wavFile([silence(1, 44100)], 44100)),
    };
    const vowelA = b64(
      wavFile([synthesizeVowel(VOWEL_FORMANTS.A, 1, 48000, { f0: 120, fade: 0.001 })], 48000),
    );
    await page.evaluate(
      `(async ([crafted, vowelA]) => {
        const { view, model } = window.mochi2dExample;
        const lib = await import(new URL("/dist/lib/mochi2d.js", location.href).href);
        const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        const base = new URL("/models/DeepSeek/", location.href);
        const settings = JSON.parse(new TextDecoder().decode(bytes(crafted["ds-motionsync.model3.json"])));
        const refs = settings.FileReferences;
        const own = [refs.Moc, refs.Physics, refs.DisplayInfo, ...refs.Textures, "Animation/IDLE.motion3.json", "Animation/脱捕.motion3.json", "Animation/举手切默认手.motion3.json"];
        const source = {
          label: "ds-motionsync",
          list: () => [...Object.keys(crafted), ...own],
          read: async (p) => crafted[p] !== undefined ? bytes(crafted[p])
            : new Uint8Array(await (await fetch(new URL(p.split("/").map(encodeURIComponent).join("/"), base))).arrayBuffer()),
        };
        window.t = { lib, view, model, source, frames: (n) => new Promise((resolve) => {
          const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
          requestAnimationFrame(step);
        }) };
        window.t.until = async (cond, ms) => {
          const t0 = performance.now();
          while (!cond()) {
            if (performance.now() - t0 > ms) return false;
            await new Promise((r) => setTimeout(r, 20));
          }
          return true;
        };
        /** The vowel A, looping, as a MediaStream from its own audio context. */
        window.t.vowelStream = async () => {
          const ctx = new AudioContext();
          const buffer = await ctx.decodeAudioData(bytes(vowelA).buffer);
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.loop = true;
          const dest = ctx.createMediaStreamDestination();
          src.connect(dest);
          src.start();
          return { stream: dest.stream, close: () => ctx.close() };
        };
        window.t.item = await view.addItem(source, { settings: "ds-motionsync.model3.json", placement: { scale: 0.5 } });
        for (const e of ["physics", "eyeBlink", "breath", "look", "idle"]) window.t.item.setEffect(e, false);
      })(${JSON.stringify([crafted, vowelA])})`,
    );
  }, 180000);

  afterAll(async () => {
    await page?.evaluate("window.mochi2dExample?.view.stop()").catch(() => {});
    await browser?.close();
    await server?.close();
  }, 60000);

  for (const tap of ["worklet", "analyser"] as const)
    it(`a page's stream drives an item's mouth through a setting (${tap} tap)`, async () => {
      const r = await run<Record<string, unknown>>(
        `async (t, tap) => {
          const v = await t.vowelStream();
          const c = await t.item.startLiveMotionSync({ stream: v.stream, setting: "Mouth basic", tap });
          const arrived = await t.until(() => (c.tick?.weights.A ?? 0) > 0.5, 15000);
          let open = 0;
          for (let i = 0; i < 30; i++) {
            await t.frames(1);
            open = Math.max(open, t.item.getParameter("ParamMouthOpenY"));
          }
          const tick = c.tick;
          const out = { arrived, tap: c.tap, state: c.state, open, setting: tick?.setting.name, source: tick?.source,
            mainTick: t.model.motionSync, same: t.item.liveMotionSync === c };
          c.stop();
          const settled = await t.until(() => t.item.motionSync === null, 5000);
          await v.close();
          return { ...out, settled, after: t.item.liveMotionSync, stateAfter: c.state };
        }`,
        tap,
      );
      expect(r).toMatchObject({
        arrived: true,
        tap,
        state: "running",
        setting: "Mouth basic",
        source: "live",
        mainTick: null,
        same: true,
        settled: true,
        after: null,
        stateAfter: "stopped",
      });
      expect(r.open as number).toBeGreaterThan(0.5);
    }, 60000);

  it("refuses a model without motion sync, and an unknown setting", async () => {
    const r = await run<string[]>(`async (t) => {
      const out = [];
      await t.model.startLiveMotionSync().catch((e) => out.push(e.code ?? e.name));
      await t.item.startLiveMotionSync({ setting: "Nope" }).catch((e) => out.push(e.name));
      return out;
    }`);
    expect(r).toEqual(["no-motion-sync", "RangeError"]);
  }, 30000);

  it("opens the microphone without voice processing for motion sync, unless asked", async () => {
    const r = await run<Record<string, boolean | undefined>[]>(`async (t) => {
      const md = navigator.mediaDevices;
      const original = md.getUserMedia.bind(md);
      const asked = [];
      md.getUserMedia = (c) => (asked.push(c.audio), original(c));
      try {
        const steps = [
          () => t.item.startLiveMotionSync({ setting: "Mouth basic" }),
          () => t.item.startLiveMotionSync({ setting: "Mouth basic", voiceProcessing: true }),
          () => t.item.startLiveLipSync(),
        ];
        for (const start of steps) {
          const c = await start();
          c.stop();
          await t.until(() => c.state === "stopped", 5000);
        }
        await t.view.recordAudio(0.1);
      } finally {
        md.getUserMedia = original;
      }
      return asked.map((a) => ({ echo: a.echoCancellation, noise: a.noiseSuppression, gain: a.autoGainControl }));
    }`);
    const off = { echo: false, noise: false, gain: false };
    const on = { echo: true, noise: true, gain: true };
    // Motion sync, motion sync asked for processing, lip sync, a recording.
    expect(r).toEqual([off, on, on, off]);
  }, 60000);

  it("records a clip of the microphone for calibration", async () => {
    const r = await run<{ rate: number; length: number; rms: number }>(`async (t) => {
      const clip = await t.view.recordAudio(0.5);
      const x = clip.channels[0];
      let s = 0;
      for (let i = 0; i < x.length; i++) s += x[i] * x[i];
      return { rate: clip.sampleRate, length: x.length, rms: Math.sqrt(s / x.length) };
    }`);
    expect(r.length).toBe(Math.round(0.5 * r.rate));
    // The generated microphone: a 440 Hz sine of amplitude 0.5 (RMS 0.354).
    expect(r.rms).toBeGreaterThan(0.25);
    expect(r.rms).toBeLessThan(0.4);
  }, 30000);

  it("speak() plays a sound through motion sync, following the audio clock", async () => {
    const r = await run<Record<string, unknown>>(`async (t) => {
      const m = await t.view.load(t.source, { settings: "ds-motionsync.model3.json" });
      t.main = m;
      for (const e of ["physics", "eyeBlink", "breath", "look", "idle"]) m.setEffect(e, false);
      // The first frames of a new model can be slow (textures, shaders).
      await t.frames(30);
      const wav = await t.source.read("${TALK_SOUNDS.male}");
      const seen = new Set();
      const strongest = { A: [], I: [] };
      const off = m.onMotionSyncTick((tick) => {
        seen.add(tick.setting.id);
        const best = ["Silence", "A", "I", "U", "E", "O"].reduce((a, b) => (tick.weights[b] > tick.weights[a] ? b : a));
        // The male clip: A from 0.3 to 1.3 s, I from 1.6 to 2.6 s.
        if (tick.time > 0.45 && tick.time < 1.15) strongest.A.push(best);
        if (tick.time > 1.75 && tick.time < 2.45) strongest.I.push(best);
      });
      // Wait for the state checked: analyses past the I window, then the end of the
      // playback; generous limits, since a loaded machine's audio clock can lag.
      const t0 = performance.now();
      let ended = false;
      const done = m.speak(wav, { motionSync: "MS_Rich" }).then(() => (ended = true));
      let lastTime = 0;
      const offTime = m.onMotionSyncTick((tick) => (lastTime = tick.time));
      const pastI = await t.until(() => lastTime > 2.6, 90000);
      const finished = await t.until(() => ended, 90000);
      await done;
      const seconds = (performance.now() - t0) / 1000;
      off();
      offTime();
      return { seen: [...seen], strongest, seconds, pastI, finished };
    }`);
    expect(r.pastI).toBe(true);
    expect(r.finished).toBe(true);
    expect(r.seen).toEqual(["MS_Rich"]);
    const strongest = r.strongest as { A: string[]; I: string[] };
    // At most one analysis a frame, and headless frames can be slow: judge those there are.
    expect(strongest.A.length).toBeGreaterThan(0);
    expect(strongest.I.length).toBeGreaterThan(0);
    expect(new Set(strongest.A)).toEqual(new Set(["A"]));
    expect(new Set(strongest.I)).toEqual(new Set(["I"]));
    // The male clip lasts 6.8 s; speak() resolves when it has played.
    expect(r.seconds as number).toBeGreaterThan(6.5);
  }, 240000);

  it("a motion's linked sound drives the mouth", async () => {
    const r = await run<Record<string, unknown>>(`async (t) => {
      const m = t.main;
      await m.startMotion("Talk", 1);
      const ok = await t.until(() => (m.motionSync?.weights.O ?? 0) > 0.5, 10000);
      return { ok, setting: m.motionSync?.setting.name };
    }`);
    expect(r).toEqual({ ok: true, setting: "Mouth rich" });
  }, 30000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});

describe.skipIf(!available)("the motion-sync rating page (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    server = await startStaticServer(root, root);
    browser = await launchChromium([...CHROMIUM_MEDIA_ARGS]);
    page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("examples/motion-sync-rating/index.html", server.url).href, {
      waitUntil: "load",
    });
    await page.waitForFunction("window.motionSyncRating !== undefined", undefined, {
      timeout: 180000,
    });
  }, 240000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  }, 60000);

  it("plays a clip with the four conditions in a blind order and records the ratings", async () => {
    const clip = wavFile(
      [vowelClip(MALE, 16000, { vowels: ["A", "O"], hold: 0.6 }).samples],
      16000,
    );
    await page.fill("#rater", "tester");
    await page.setInputFiles("#clips", [
      { name: "vowels.wav", mimeType: "audio/wav", buffer: Buffer.from(clip) },
    ]);
    // Count each panel's analyses and its widest mouth until the clip has played (frames
    // can be slow with four models drawn at once, so analyses, not frames, are counted).
    await page.evaluate(`(() => {
      const r = window.motionSyncRating;
      const seen = (window.__seen = {});
      for (const p of r.panels) {
        const s = (seen[p.condition] = { ticks: 0, open: 0 });
        p.model.onMotionSyncTick(() => s.ticks++);
      }
      const watch = () => {
        for (const p of r.panels) {
          const s = seen[p.condition];
          s.open = Math.max(s.open, p.model.getParameter("ParamMouthOpenY"));
        }
        if (!window.__stop) requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    })()`);
    await page.click("#play");
    await page.waitForSelector("#next:not([disabled])", { timeout: 60000 });
    // V's lip sync advances with the frames, which can be few while the clip plays under
    // load: wait for its mouth to open (and for the analyses) rather than reading it once.
    await page.waitForFunction(
      "window.__seen.V.open > 0.1 && window.__seen.M.ticks > 0 && window.__seen.M0.ticks > 0",
      undefined,
      { timeout: 60000, polling: 100 },
    );
    const seen = (await page.evaluate("(window.__stop = true, window.__seen)")) as Record<
      string,
      { ticks: number; open: number }
    >;
    // While it played, the motion-sync panels analysed it, the volume panel moved, and the
    // still one did not.
    expect(seen.M!.ticks).toBeGreaterThan(0);
    expect(seen.M0!.ticks).toBeGreaterThan(0);
    expect(seen.V!.ticks).toBe(0);
    expect(seen.V!.open).toBeGreaterThan(0.1);
    expect(seen.S!.ticks).toBe(0);
    expect(seen.S!.open).toBe(0);
    for (let i = 0; i < 4; i++) {
      await page.check(`input[name=nat${i}][value="${i + 2}"]`);
      await page.check(`input[name=sync${i}][value="ok"]`);
    }
    await page.click("#next");
    const results = (await page.evaluate("window.motionSyncRating.results()")) as Record<
      string,
      unknown
    >[];
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.condition).sort()).toEqual(["M", "M0", "S", "V"]);
    expect(results.map((r) => r.naturalness)).toEqual([2, 3, 4, 5]);
    expect(
      results.every((r) => r.rater === "tester" && r.clip === "vowels.wav" && r.sync === "ok"),
    ).toBe(true);
    const csv = (await page.evaluate("window.motionSyncRating.csv()")) as string;
    expect(csv.split("\n")).toHaveLength(5);
    expect(errors).toEqual([]);
  }, 120000);
});

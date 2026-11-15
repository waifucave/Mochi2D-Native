/**
 * Lip sync from live audio in the library, in headless Chromium.
 * The microphone is a generated tone (test/support/generated-microphone.ts):
 * `getUserMedia` returns a continuous 440 Hz sine, so levels never depend on
 * the fake capture device's short beeps, and the tests wait for audio to
 * arrive instead of for a number of frames. One test uses the browser's own
 * fake capture device (`--use-fake-device-for-media-stream`), and checks only
 * what does not depend on timing. `--use-fake-ui-for-media-stream` grants the
 * permission.
 *
 * The mouth parameter moves; the microphone is released on stop and while the
 * page is hidden; a page's own MediaStream drives only the item it targets;
 * one microphone is shared; suspended audio waits for a gesture; an insecure
 * page gets a clear error. Uses the embed example's view of DeepSeek-chan
 * (lip sync drives the `ParamMouthOpenY` fallback). Needs
 * `npm run build:lib` and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startStaticServer, type RunningServer } from "../tools/lib/static-server.js";
import { CHROMIUM_MEDIA_ARGS, launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";
import { GENERATED_MICROPHONE } from "./support/generated-microphone.js";

const root = resolve(__dirname, "..");
// DeepSeek-chan (assets/models/DeepSeek/) is needed too.
let available = HAVE_DEEPSEEK && existsSync(join(root, "dist", "lib", "mochi2d.js"));
try {
  loadPlaywright();
} catch {
  available = false;
}

/** Page-side helpers, as source text (no bundler helpers leak in). */
const HELPERS = `
  window.t.frames = (n) => new Promise((resolve) => {
    const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  /** Samples read() every frame for up to ms milliseconds, or until done(value). */
  window.t.watch = async (read, ms, done = () => false) => {
    const values = [];
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      await window.t.frames(1);
      const v = read();
      values.push(v);
      if (done(v)) break;
    }
    return { max: Math.max(...values), min: Math.min(...values), last: values[values.length - 1], n: values.length };
  };
  window.t.until = async (cond, ms) => {
    const t0 = performance.now();
    while (!cond()) {
      if (performance.now() - t0 > ms) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
    return true;
  };
  window.t.setHidden = (hidden) => {
    if (hidden) Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    else delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  /** A 440 Hz sine of amplitude 0.5 from its own audio context, as a MediaStream. */
  window.t.sineStream = () => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    return { stream: dest.stream, close: () => ctx.close() };
  };
`;

describe.skipIf(!available)("live lip sync in the library (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  let base = 0;
  const errors: string[] = [];
  /** Runs `fn(t)` in the page, with t = { lib, view, model, item, ... }. */
  const run = <R>(src: string, arg?: unknown): Promise<R> =>
    page.evaluate(
      ([s, a]) => new Function("arg", `return (${s})(window.t, arg)`)(a) as Promise<R>,
      [src, arg] as const,
    );

  beforeAll(async () => {
    server = await startStaticServer(root, root);
    browser = await launchChromium([
      ...CHROMIUM_MEDIA_ARGS,
      // A name for 127.0.0.1 that is not localhost: plain HTTP there is not a secure context.
      "--host-resolver-rules=MAP mochi2d.lan 127.0.0.1",
    ]);
    page = await browser.newPage({ viewport: { width: 600, height: 600 } });
    await page.addInitScript(GENERATED_MICROPHONE);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("examples/embed/index.html", server.url).href, { waitUntil: "load" });
    await page.waitForFunction("window.mochi2dExample !== undefined", undefined, {
      timeout: 120000,
    });
    base = await page.evaluate(`(async () => {
      const { view, model } = window.mochi2dExample;
      const lib = await import(new URL("/dist/lib/mochi2d.js", location.href).href);
      window.t = { lib, view, model };
      ${HELPERS}
      for (const e of ["physics", "eyeBlink", "breath", "look", "idle"]) model.setEffect(e, false);
      await window.t.frames(2);
      return model.getParameter("ParamMouthOpenY");
    })()`);
  }, 180000);

  afterAll(async () => {
    await page?.evaluate("window.mochi2dExample?.view.stop()").catch(() => {});
    await browser?.close();
    await server?.close();
  }, 60000);

  it("moves the model's mouth with the microphone, and releases it on stop", async () => {
    const r = await run<Record<string, unknown>>(`async (t) => {
      const states = [];
      const c = await t.model.startLiveLipSync({ voiceProcessing: false });
      c.onstatechange = (s) => states.push(s);
      const out = { same: t.model.liveLipSync === c, state: c.state, tap: c.tap, label: c.label };
      const stream = c.stream;
      let level = 0;
      const w = await t.watch(() => { level = Math.max(level, c.level); return t.model.getParameter("ParamMouthOpenY"); }, 15000, (v) => v > 0.3 && level > 0.05);
      c.stop();
      await t.frames(3);
      return { ...out, max: w.max, level, states,
        track: stream.getAudioTracks()[0].readyState,
        after: t.model.liveLipSync, stateAfter: c.state, streamAfter: c.stream,
        mouth: t.model.getParameter("ParamMouthOpenY") };
    }`);
    expect(r).toMatchObject({
      same: true,
      state: "running",
      tap: "worklet",
      track: "ended",
      after: null,
      stateAfter: "stopped",
      streamAfter: null,
      states: ["stopped"],
      mouth: base,
    });
    expect(r.max as number).toBeGreaterThan(0.3);
    // The tone's RMS is 0.354; the first frames can hold some silence before it.
    expect(r.level as number).toBeGreaterThan(0.05);
  }, 60000);

  it("uses the browser's own microphone (the fake capture device)", async () => {
    // Only what does not depend on the device's beeps: its name, the tap, the states.
    const r = await run<Record<string, unknown>>(`async (t) => {
      window.__mic.real = true;
      try {
        const c = await t.model.startLiveLipSync({ voiceProcessing: false });
        const stream = c.stream;
        const out = { state: c.state, tap: c.tap, label: c.label, live: stream.getAudioTracks()[0].readyState };
        c.stop();
        await t.frames(2);
        return { ...out, track: stream.getAudioTracks()[0].readyState, stateAfter: c.state };
      } finally {
        window.__mic.real = false;
      }
    }`);
    expect(r).toEqual({
      state: "running",
      tap: "worklet",
      label: "Fake Default Audio Input",
      live: "live",
      track: "ended",
      stateAfter: "stopped",
    });
  }, 60000);

  it("works with the default voice processing and with the analyser tap", async () => {
    for (const options of [{}, { tap: "analyser" }]) {
      const r = await run<{ tap: string; max: number; track: string }>(
        `async (t, options) => {
          const c = await t.model.startLiveLipSync(options);
          const stream = c.stream;
          const tap = c.tap;
          const w = await t.watch(() => t.model.getParameter("ParamMouthOpenY"), 15000, (v) => v > 0.3);
          t.model.stopLiveLipSync();
          return { tap, max: w.max, track: stream.getAudioTracks()[0].readyState };
        }`,
        options,
      );
      expect(r.tap).toBe(options.tap ?? "worklet");
      expect(r.max, JSON.stringify(options)).toBeGreaterThan(0.3);
      expect(r.track).toBe("ended");
    }
  }, 60000);

  it("asks for a microphone by deviceId, and mixes the value by a mode or a function", async () => {
    const r = await run<Record<string, unknown>>(
      `async (t) => {
      const calls = window.__mic.calls.length;
      t.model.setParameter("ParamMouthOpenY", 0.6);
      const c = await t.model.startLiveLipSync({
        deviceId: "mic-2", mix: "replace", gain: 1, gate: -Infinity, attack: 0, release: 0,
      });
      const asked = window.__mic.calls.slice(calls);
      const arrived = await t.until(() => c.level > 0.3, 30000);
      const mouth = () => t.model.getParameter("ParamMouthOpenY");
      // 30 frames per mode. Under load the tone can drop out for a moment (an
      // underrun gives silence), which only lowers the live value: take the
      // extreme the whole tone gives.
      const sample = async (read = mouth) => {
        await t.frames(3);
        await t.until(() => c.level > 0.3, 30000);
        const values = [];
        for (let i = 0; i < 30; i++) { await t.frames(1); values.push(read()); }
        return { min: Math.min(...values), max: Math.max(...values) };
      };
      const out = { asked, arrived, mix: c.mix };
      out.replace = (await sample()).max;
      c.mix = "max";
      out.max = await sample();
      c.mix = "add";
      out.add = (await sample()).max;
      c.mix = (live, current) => current - live;
      out.fn = (await sample()).min;
      out.value = (await sample(() => c.value)).max;
      c.stop();
      t.model.setParameter("ParamMouthOpenY", arg);
      await t.frames(2);
      return out;
    }`,
      base,
    );
    expect(r.asked).toEqual([
      {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          deviceId: { exact: "mic-2" },
        },
      },
    ]);
    expect(r.arrived).toBe(true);
    expect(r.mix).toBe("replace");
    const tone = 0.5 / Math.SQRT2;
    expect(Math.abs((r.replace as number) - tone)).toBeLessThan(0.05);
    // max(0.6, live) is 0.6 in every frame.
    expect(r.max).toEqual({ min: Math.fround(0.6), max: Math.fround(0.6) });
    expect(r.add as number).toBeGreaterThan(0.9);
    expect(Math.abs((r.fn as number) - (0.6 - tone))).toBeLessThan(0.05);
    expect(Math.abs((r.value as number) - tone)).toBeLessThan(0.05);
  }, 180000);

  it("takes a MediaStream from the page and moves only the item it targets", async () => {
    await run(`async (t) => {
      // The item: DeepSeek-chan's files again.
      const base = new URL("/models/DeepSeek/", location.href);
      const settings = await (await fetch(new URL("大肥鱼.model3.json", base))).json();
      const refs = settings.FileReferences;
      const files = ["大肥鱼.model3.json", refs.Moc, refs.Physics, refs.DisplayInfo, ...refs.Textures];
      const source = {
        label: "item",
        list: () => files,
        read: async (p) => new Uint8Array(await (await fetch(new URL(p.split("/").map(encodeURIComponent).join("/"), base))).arrayBuffer()),
      };
      t.item = await t.view.addItem(source, { placement: { scale: 0.5 } });
      for (const e of ["physics", "eyeBlink", "breath", "look", "idle"]) t.item.setEffect(e, false);
    }`);
    const r = await run<Record<string, number | string | null>>(`async (t) => {
      const sine = t.sineStream();
      const c = await t.item.startLiveLipSync({ stream: sine.stream, gain: 1, gate: -Infinity, attack: 0, release: 0 });
      // Wait for the tone to arrive, however slow the page is.
      const arrived = await t.until(() => c.level > 0.3, 15000);
      let mainMax = 0;
      let level = 0;
      const values = [];
      await t.watch(() => {
        mainMax = Math.max(mainMax, t.model.getParameter("ParamMouthOpenY"));
        level = Math.max(level, c.level);
        const v = t.item.getParameter("ParamMouthOpenY");
        values.push(v);
        return v;
      }, 1000);
      // Under load the audio can pause for more than 0.1 s, and such frames count as
      // silence (0): judge the frames that had samples. A source that underruns for
      // a moment gives silence too, which only lowers a frame's value: the median
      // and the largest value are what the tone gives.
      const heard = values.filter((v) => v > 0).sort((a, b) => a - b);
      const w = { median: heard[Math.floor(heard.length / 2)], max: heard[heard.length - 1], heard: heard.length };
      // Hiding the page does not touch a stream passed in.
      t.setHidden(true);
      const hiddenState = c.state;
      t.setHidden(false);
      c.stop();
      await t.frames(3);
      const out = { arrived, heard: w.heard, median: w.median, max: w.max, mainMax, level, hiddenState,
        track: sine.stream.getAudioTracks()[0].readyState,
        itemAfter: t.item.getParameter("ParamMouthOpenY"), live: t.item.liveLipSync };
      await sine.close();
      return out;
    }`);
    // A 0.5 sine has an RMS of 0.5/√2 ≈ 0.354; frame windows hold no whole
    // number of periods (and under load a frame may take only its latest
    // blocks), so a frame with the whole tone lies within 0.33–0.38 of it.
    const tone = 0.5 / Math.SQRT2;
    expect(r.arrived).toBe(true);
    expect(r.heard as number).toBeGreaterThan(0);
    expect(Math.abs((r.median as number) - tone)).toBeLessThan(0.035);
    expect(r.max as number).toBeGreaterThan(0.32);
    expect(r.max as number).toBeLessThan(0.39);
    expect(r.level as number).toBeGreaterThan(0.32);
    expect(r.level as number).toBeLessThan(0.39);
    expect(r.mainMax).toBe(base);
    expect(r.hiddenState).toBe("running");
    expect(r.track).toBe("live");
    expect(r.itemAfter).toBe(base);
    expect(r.live).toBeNull();
  }, 120000);

  it("shares one microphone between the model and an item", async () => {
    const r = await run<Record<string, unknown>>(`async (t) => {
      const a = await t.model.startLiveLipSync();
      const b = await t.item.startLiveLipSync();
      const same = a.stream === b.stream;
      const stream = b.stream;
      a.stop();
      const afterA = stream.getAudioTracks()[0].readyState;
      const w = await t.watch(() => t.item.getParameter("ParamMouthOpenY"), 15000, (v) => v > 0.3);
      const mainAfterA = t.model.getParameter("ParamMouthOpenY");
      b.stop();
      return { same, afterA, itemMax: w.max, mainAfterA, afterB: stream.getAudioTracks()[0].readyState };
    }`);
    expect(r).toMatchObject({ same: true, afterA: "live", afterB: "ended", mainAfterA: base });
    expect(r.itemMax as number).toBeGreaterThan(0.3);
  }, 60000);

  it("releases the microphone while the page is hidden, and opens it again when visible", async () => {
    const r = await run<Record<string, unknown>>(`async (t) => {
      const c = await t.model.startLiveLipSync();
      const states = [];
      c.onstatechange = (s) => states.push(s);
      const first = c.stream;
      t.setHidden(true);
      const hidden = { state: c.state, stream: c.stream, track: first.getAudioTracks()[0].readyState };
      await t.frames(10);
      const mouthHidden = t.model.getParameter("ParamMouthOpenY");
      t.setHidden(false);
      const reopened = await t.until(() => c.state === "running", 10000);
      const second = c.stream;
      const w = await t.watch(() => t.model.getParameter("ParamMouthOpenY"), 15000, (v) => v > 0.3);
      c.stop();
      return { hidden, mouthHidden, reopened, states, other: second !== first,
        secondTrack: second.getAudioTracks()[0].readyState, max: w.max };
    }`);
    expect(r).toMatchObject({
      hidden: { state: "paused", stream: null, track: "ended" },
      reopened: true,
      other: true,
      secondTrack: "ended",
      states: ["paused", "starting", "running", "stopped"],
    });
    expect(r.max as number).toBeGreaterThan(0.3);
  }, 60000);

  it("waits for a gesture when the audio context is suspended, then resumes", async () => {
    // Chromium here runs audio without a gesture (and Playwright's evaluate
    // counts as one), so resume() is made to work only inside a trusted
    // pointer or key event, as on iOS Safari.
    await run(`async (t) => {
      const ctx = t.view.speech.context();
      const resume = ctx.resume.bind(ctx);
      let gesture = false;
      for (const type of ["pointerdown", "pointerup", "click", "keydown", "touchend"])
        window.addEventListener(type, (e) => {
          if (!e.isTrusted) return;
          gesture = true;
          setTimeout(() => (gesture = false), 0);
        }, { capture: true });
      ctx.resume = () => (gesture ? resume() : Promise.resolve());
      t.c = await t.model.startLiveLipSync();
      t.states = [];
      t.c.onstatechange = (s) => t.states.push(s);
      await t.watch(() => t.model.getParameter("ParamMouthOpenY"), 15000, (v) => v > 0.3);
      await ctx.suspend();
      await t.until(() => t.c.state === "suspended", 5000);
    }`);
    // No samples arrive: after 0.1 s the frames count as silence, and the
    // mouth closes with the release time (0.12 s of animation time; under
    // load the page draws few frames, so this waits for it).
    const waiting = await run<{ state: string; closed: boolean }>(
      `async (t, base) => {
        const closed = await t.until(() => t.model.getParameter("ParamMouthOpenY") - base < 0.01, 10000);
        return { state: t.c.state, closed };
      }`,
      base,
    );
    expect(waiting).toEqual({ state: "suspended", closed: true });
    await page.mouse.click(5, 5);
    const r = await run<{ resumed: boolean; states: string[]; max: number }>(`async (t) => {
      const resumed = await t.until(() => t.c.state === "running", 5000);
      const w = await t.watch(() => t.model.getParameter("ParamMouthOpenY"), 15000, (v) => v > 0.3);
      t.c.stop();
      delete t.view.speech.context().resume;
      return { resumed, states: t.states, max: w.max };
    }`);
    expect(r.resumed).toBe(true);
    expect(r.states).toEqual(["suspended", "running", "stopped"]);
    expect(r.max).toBeGreaterThan(0.3);
  }, 60000);

  it("says why the microphone is unavailable on an insecure page", async () => {
    const insecure = await browser.newPage({ viewport: { width: 400, height: 400 } });
    try {
      const port = new URL(server.url).port;
      await insecure.goto(`http://mochi2d.lan:${port}/examples/embed/index.html`, {
        waitUntil: "load",
      });
      await insecure.waitForFunction("window.mochi2dExample !== undefined", undefined, {
        timeout: 120000,
      });
      const r = await insecure.evaluate(`(async () => {
        const lib = await import(new URL("/dist/lib/mochi2d.js", location.href).href);
        const problem = lib.liveAudioProblem();
        let error = null;
        try { await window.mochi2dExample.model.startLiveLipSync(); } catch (e) { error = { name: e.name, code: e.code, message: e.message }; }
        return { secure: isSecureContext, problem: problem && problem.code, error };
      })()`);
      expect(r).toMatchObject({
        secure: false,
        problem: "insecure-context",
        error: { name: "LiveAudioError", code: "insecure-context" },
      });
      const message = (r as { error: { message: string } }).error.message;
      expect(message).toContain("HTTPS");
      expect(message).toContain(`http://mochi2d.lan:${port}`);
    } finally {
      await insecure.close();
    }
  }, 180000);

  it("runs from the embed example's Microphone button", async () => {
    await page.click("#mic");
    await page.waitForFunction("document.getElementById('mic').textContent === 'Stop microphone'");
    expect(await page.evaluate("document.getElementById('log').textContent")).toBe(
      "Microphone: running",
    );
    const max = await run<number>(`async (t) =>
      (await t.watch(() => t.model.getParameter("ParamMouthOpenY"), 15000, (v) => v > 0.3)).max`);
    expect(max).toBeGreaterThan(0.3);
    await page.click("#mic");
    await page.waitForFunction("document.getElementById('mic').textContent === 'Microphone'");
    expect(await run<unknown>("async (t) => t.model.liveLipSync")).toBeNull();
  }, 60000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});

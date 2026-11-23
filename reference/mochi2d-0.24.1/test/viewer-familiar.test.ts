/**
 * The viewer's layout and tools, in headless Chromium: the menu bar, the four
 * areas (menu area, resource tree, settings area, model view), opening by URL
 * with recent files, motion and expression settings with the default fades,
 * the curve graph, the motion-sync preview with which lip sync is active,
 * Ctrl+S export and the unsaved marks, the two-file comparison, the mouse,
 * the frame-rate and event displays, the Animation and Display menus. A small
 * crafted model (served as a zip) covers most of it; DeepSeek-chan covers the
 * model-file inspector and the physics summary. Needs `npm run build` and
 * the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createModelsHandler,
  startStaticServer,
  type RunningServer,
} from "../tools/lib/static-server.js";
import { CHROMIUM_MEDIA_ARGS, launchChromium, loadPlaywright } from "../tools/lib/browser.js";
import type { Browser, Page } from "../tools/lib/playwright-types.js";
import { encodePng } from "../tools/lib/png.js";
import { Synth } from "./support/synth.js";
import { buildZip } from "./support/zip-writer.js";
import { BASIC, MALE, motionSyncJson, vowelClip, wavFile } from "./support/motion-sync.js";
import { HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
let available = existsSync(join(root, "dist", "web", "index.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

/** A tiny model with a mouth, two motions (one with an event), an expression and motion sync. */
function moc(max = 1): Uint8Array {
  const s = new Synth(5);
  s.canvas = { pixelsPerUnit: 100, originX: 100, originY: 100, width: 200, height: 200, flags: 0 };
  s.param("ParamMouthOpenY", 0, 1, 0);
  s.param("ParamMouthForm", -1, max, 0);
  const rootPart = s.part({ id: "Root" });
  s.mesh({
    id: "Mouth",
    part: rootPart,
    uvs: new Array(8).fill(0.5),
    triangles: [0, 1, 2, 1, 3, 2],
    keyforms: [{ positions: [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5] }],
  });
  return s.build();
}
const motion = (loop: boolean, fadeIn?: number) =>
  JSON.stringify({
    Version: 3,
    Meta: {
      Duration: 1,
      Fps: 30,
      Loop: loop,
      AreBeziersRestricted: true,
      CurveCount: 1,
      TotalSegmentCount: 1,
      TotalPointCount: 2,
      UserDataCount: 1,
      TotalUserDataSize: 4,
      ...(fadeIn !== undefined ? { FadeInTime: fadeIn } : {}),
    },
    Curves: [{ Target: "Parameter", Id: "ParamMouthForm", Segments: [0, -1, 0, 1, 1] }],
    UserData: [{ Time: 0.5, Value: "beep" }],
  });
const settings = {
  Version: 3,
  FileReferences: {
    Moc: "ms.moc3",
    Textures: ["tex.png"],
    MotionSync: "ms.motionsync3.json",
    Expressions: [{ Name: "smile", File: "smile.exp3.json" }],
    Motions: {
      Idle: [{ File: "idle.motion3.json" }],
      Tap: [{ File: "tap.motion3.json", FadeInTime: 0.25 }],
    },
  },
  Groups: [{ Target: "Parameter", Name: "LipSync", Ids: ["ParamMouthOpenY"] }],
};
const ZIP = buildZip([
  { name: "ms/ms.model3.json", data: JSON.stringify(settings) },
  { name: "ms/ms.moc3", data: moc() },
  {
    name: "ms/tex.png",
    data: encodePng({ width: 4, height: 4, data: new Uint8Array(64).fill(200) }),
  },
  { name: "ms/ms.motionsync3.json", data: JSON.stringify(motionSyncJson(BASIC)) },
  {
    name: "ms/smile.exp3.json",
    data: JSON.stringify({
      Type: "Live2D Expression",
      Parameters: [{ Id: "ParamMouthForm", Value: 1, Blend: "Add" }],
    }),
  },
  { name: "ms/idle.motion3.json", data: motion(true) },
  { name: "ms/tap.motion3.json", data: motion(false) },
]);
const WAV = wavFile([vowelClip(MALE, 16000, { vowels: ["A", "O"], hold: 0.5 }).samples], 16000);

describe.skipIf(!available)("the viewer's layout and tools (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  let zipUrl = "";
  const errors: string[] = [];
  const text = (sel: string) =>
    page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);
  const viewer = <R>(src: string) =>
    page.evaluate<R>(`(() => { const v = window.mochi2dViewer; return ${src}; })()`);
  const waitFor = (cond: string, timeout = 30000) =>
    page.waitForFunction(
      `(() => { const v = window.mochi2dViewer; return ${cond}; })()`,
      undefined,
      {
        timeout,
      },
    );

  beforeAll(async () => {
    const models = createModelsHandler(root);
    server = await startStaticServer(join(root, "dist", "web"), root, 0, "127.0.0.1", {
      modelsHandler: async (req, res, next) => {
        if (req.url === "/crafted/ms.zip") {
          res.setHeader("Content-Type", "application/zip");
          res.end(Buffer.from(ZIP));
          return;
        }
        await models(req, res, next);
      },
    });
    zipUrl = new URL("crafted/ms.zip", server.url).href;
    browser = await launchChromium([...CHROMIUM_MEDIA_ARGS]);
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("index.html", server.url).href, { waitUntil: "load" });
    await waitFor("v && v.stage");
  }, 60000);

  afterAll(async () => {
    await page
      ?.evaluate("window.mochi2dViewer && window.mochi2dViewer.stage.stop()")
      .catch(() => {});
    await browser?.close();
    await server?.close();
  }, 60000);

  it("lays out the menu area, the model view, the resources and the settings area", async () => {
    const boxes = await page.evaluate(
      () =>
        ["menu-area", "stage", "resources", "settings-area"].map((id) => {
          const r = document.getElementById(id)!.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }),
      undefined,
    );
    const [menu, stage, resources, settingsArea] = boxes as {
      x: number;
      y: number;
      w: number;
      h: number;
    }[];
    for (const b of boxes as { w: number; h: number }[]) expect(b.w * b.h).toBeGreaterThan(0);
    expect(menu!.x).toBeLessThan(stage!.x);
    expect(resources!.x).toBeGreaterThan(stage!.x);
    expect(settingsArea!.y).toBeGreaterThan(resources!.y);
    // The menu area shows one panel at a time, chosen from its drop-down.
    const shown = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>("#menu-area [data-panel]")]
            .filter((p) => !p.hidden)
            .map((p) => p.dataset.panel),
        undefined,
      );
    expect(await shown()).toEqual(["parameters"]);
    await page.selectOption("#menu-panel", "parts");
    expect(await shown()).toEqual(["parts"]);
    await page.selectOption("#menu-panel", "parameters");
    // Four menus; a click opens one, Escape closes it.
    expect(
      await page.evaluate(
        () => [...document.querySelectorAll(".menu-button")].map((b) => b.textContent!.trim()),
        undefined,
      ),
    ).toEqual(["File", "Edit", "Display", "Animation"]);
    await page.click("#menu-display");
    expect(await viewer<string | null>("v.menus.openId")).toBe("menu-display");
    await page.keyboard.press("Escape");
    expect(await viewer<string | null>("v.menus.openId")).toBeNull();
  });

  it("opens a model by URL, lists its resources and remembers it", async () => {
    await page.click("#toggle-open");
    await page.fill("#url-input", zipUrl);
    await page.click("#url-form button[type=submit]");
    await page.waitForFunction(
      "/ms\\.model3\\.json: moc3 v5|failed/.test(document.getElementById('status').textContent)",
      undefined,
      { timeout: 60000 },
    );
    expect(await text("#status")).toMatch(/ms\.model3\.json: moc3 v5, 1 drawables/);
    const rows = await page.evaluate(
      () => [...document.querySelectorAll("#resource-tree .tree-row")].map((r) => r.textContent),
      undefined,
    );
    expect(rows).toEqual([
      "ms.model3.json",
      "ms.moc3",
      "Textures1",
      "0: tex.png",
      "Motions2",
      "Idle1",
      "idle.motion3.json",
      "Tap1",
      "tap.motion3.json",
      "Expressions1",
      "smile",
      "ms.motionsync3.json",
    ]);
    // The model settings are selected first.
    expect(await text("#settings-title")).toBe("ms.model3.json");
    expect(await text("#recent-list")).toContain(zipUrl);
  }, 90000);

  it("shows a motion's settings, plays it on double-click and draws its curves on right-click", async () => {
    const tap = '#resource-tree .tree-row[title^="Tap[0]"]';
    await page.click(tap);
    await waitFor(`document.getElementById("settings-body").textContent.includes("Fade-in")`);
    const body = await text("#settings-body");
    expect(body).toContain("Fade-in250 ms (settings)");
    expect(body).toContain("Fade-out1000 ms (default: the file has none)");
    expect(body).toContain("Frame rate30 fps");
    expect(body).toContain("0.500 sbeep");
    await page.dblclick(tap);
    await waitFor("v.model.animator.motions.size === 1");
    await page.click(tap, { button: "right" });
    await waitFor(`document.querySelector("#settings-body .curve-canvas") !== null`);
    expect(await text("#settings-title")).toBe("tap.motion3.json — curves");
    expect(await text("#settings-body .curve-legend")).toContain("ParamMouthForm");
  });

  it("shows an expression's fades, 500 ms by default, and plays it", async () => {
    const row = "#panel-expressions .anim-item";
    await page.click(row);
    await waitFor(`document.getElementById("settings-body").textContent.includes("Fade-in")`);
    expect(await text("#settings-body")).toContain("Fade-in500 ms (default: the file has none)");
    await page.dblclick(row);
    await waitFor("v.model.animator.expressions.expressions.length === 1");
  });

  it("previews motion sync with a WAV file and says which lip sync is active", async () => {
    await page.click("#resource-tree .tree-row.kind-motionSync");
    await waitFor(`document.querySelector("#settings-body [data-act=motion-sync-play]") !== null`);
    expect(await text("#settings-body")).toContain("Mouth basic");
    expect(await text("#settings-body .active-lipsync")).toBe("Active: none.");
    await page.setInputFiles("#settings-body input[type=file]", [
      { name: "vowels.wav", mimeType: "audio/wav", buffer: Buffer.from(WAV) },
    ]);
    await waitFor(`document.getElementById("settings-body").textContent.includes("vowels.wav")`);
    await page.click("#settings-body [data-act=motion-sync-play]");
    await waitFor("v.model.runtime.motionSync !== null");
    await waitFor(
      `document.querySelector("#settings-body .active-lipsync").textContent.startsWith("Active: motion sync")`,
    );
    expect(await text("#settings-body .active-lipsync")).toBe(
      'Active: motion sync, setting "Mouth basic" (a sound).',
    );
    await waitFor(
      `/Active: motion sync/.test(document.querySelector("#panel-audio .active-lipsync").textContent)`,
    );
  }, 60000);

  it("exports the model settings with Ctrl+S, which clears the unsaved marks", async () => {
    // Nothing in the viewer edits model data yet: mark an item directly.
    const tap = '#resource-tree .tree-row[title^="Tap[0]"]';
    await page.evaluate("window.mochi2dViewer.tree.markUnsaved('motion:Tap:0', true)");
    const mark = () =>
      page.evaluate((sel) => {
        const label = document.querySelector(`${sel} .tree-label`)!;
        return getComputedStyle(label, "::after").content;
      }, tap);
    expect(await mark()).toBe('" *"');
    expect(await viewer<boolean>("v.tree.anyUnsaved")).toBe(true);
    await page.click("#stage");
    await page.keyboard.press("Control+s");
    await waitFor("v.lastExport !== null");
    expect(await viewer<boolean>("v.tree.anyUnsaved")).toBe(false);
    expect(await mark()).toBe("none");
    const out = await viewer<{ name: string; text: string }>("v.lastExport");
    expect(out.name).toBe("ms.model3.json");
    const json = JSON.parse(out.text) as typeof settings;
    expect(json.FileReferences.MotionSync).toBe("ms.motionsync3.json");
    expect(json.FileReferences.Motions.Tap[0]).toEqual({
      File: "tap.motion3.json",
      FadeInTime: 0.25,
    });
    expect(json.FileReferences.Expressions).toEqual(settings.FileReferences.Expressions);
    expect(out.text.split("\n")[1]).toBe('\t"Version": 3,');
  });

  it("compares two .moc3 files object by object", async () => {
    await page.setInputFiles("#pick-compare", [
      { name: "a.moc3", mimeType: "application/octet-stream", buffer: Buffer.from(moc(1)) },
      { name: "b.moc3", mimeType: "application/octet-stream", buffer: Buffer.from(moc(2)) },
    ]);
    await waitFor(`document.getElementById("settings-title").textContent.startsWith("Compare")`);
    expect(await text("#settings-title")).toBe("Compare: a.moc3 and b.moc3");
    expect(await text("#settings-body")).toContain("parameterParamMouthFormmaximum12");
  });

  it("moves the model with Ctrl+drag and zooms with the wheel and Alt+wheel", async () => {
    const view = () => viewer<{ zoom: number; dx: number; dy: number }>("({ ...v.model.view })");
    const box = (await page.locator("#canvas").boundingBox())!;
    const before = await view();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    const moved = await view();
    expect(moved.dx).not.toBe(before.dx);
    expect(moved.zoom).toBe(before.zoom);
    await page.mouse.wheel(0, -200);
    await waitFor(`v.model.view.zoom > ${moved.zoom}`);
    const zoomed = (await view()).zoom;
    await page.keyboard.down("Alt");
    await page.mouse.wheel(0, 200);
    await page.keyboard.up("Alt");
    await waitFor(`v.model.view.zoom < ${zoomed}`);
  });

  it("shows the frame rate and the motions' events on the view", async () => {
    await waitFor(`/fps/.test(document.getElementById("fps-display").textContent)`);
    await page.dblclick('#resource-tree .tree-row[title^="Idle[0]"]');
    await waitFor(`document.getElementById("event-display").textContent.includes("beep")`, 20000);
    // The Display menu hides them.
    await page.click("#menu-display");
    await page.click("#show-events");
    await page.click("#show-fps");
    expect(
      await page.evaluate(
        () => [
          document.getElementById("event-display")!.hidden,
          document.getElementById("fps-display")!.hidden,
        ],
        undefined,
      ),
    ).toEqual([true, true]);
    await page.click("#show-events");
    await page.click("#show-fps");
    await page.keyboard.press("Escape");
  });

  it("toggles every feature from the Animation menu, and mipmapping from the Display menu", async () => {
    await page.click("#menu-animation");
    expect(
      await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLInputElement>("#panel-animation input")].map(
            (i) => i.dataset.effect,
          ),
        undefined,
      ),
    ).toEqual([
      "expressions",
      "eyeBlink",
      "physics",
      "pose",
      "motionSync",
      "idle",
      "look",
      "breath",
      "wrap",
      "lipSync",
    ]);
    await page.click('#panel-animation input[data-effect="breath"]');
    expect(await viewer<boolean>("v.model.runtime.animator.enabled.breath")).toBe(false);
    await page.click('#panel-animation input[data-effect="wrap"]');
    expect(await viewer<boolean>("v.model.runtime.animator.values.wrap")).toBe(true);
    await page.keyboard.press("Escape");
    const filter = () =>
      viewer<number>(
        "(() => { const gl = v.stage.gl; gl.bindTexture(gl.TEXTURE_2D, v.model.textures[0].texture.texture); const f = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER); gl.bindTexture(gl.TEXTURE_2D, null); return f; })()",
      );
    expect(await filter()).toBe(0x2703); // LINEAR_MIPMAP_LINEAR
    await page.click("#menu-display");
    await page.click("#show-mipmaps");
    expect(await filter()).toBe(0x2601); // LINEAR
    await page.click("#show-mipmaps");
    expect(await filter()).toBe(0x2703);
    await page.keyboard.press("Escape");
  });

  it("resets the parameters from the Edit menu", async () => {
    await page.evaluate(
      "window.mochi2dViewer.model.runtime.stopMotions(), window.mochi2dViewer.model.setParameter('ParamMouthOpenY', 0.8)",
    );
    await page.click("#menu-edit");
    await page.click("#edit-reset");
    await waitFor("v.model.runtime.getParameterBase('ParamMouthOpenY') === 0");
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "inspects DeepSeek-chan's model file, flashes an art mesh, and summarizes its physics",
    async () => {
      await page.click("#toggle-open");
      await page.selectOption("#model-select", "DeepSeek/大肥鱼.model3.json");
      await page.waitForFunction(
        "/715 drawables|failed/.test(document.getElementById('status').textContent)",
        undefined,
        { timeout: 180000 },
      );
      await page.click("#resource-tree .tree-row.kind-moc");
      await waitFor(
        `document.getElementById("settings-body").textContent.includes("Art meshes715")`,
        // Long waits: with other browser tests drawing DeepSeek-chan at once, frames are slow.
        90000,
      );
      expect(await text("#settings-body")).toContain("File version5");
      await page.click("#settings-body summary >> text=/^Art meshes/");
      // The list is built on the section's toggle event, which comes a moment later.
      await page.waitForSelector("#settings-body .mesh-item", { timeout: 30000 });
      const id = await page.evaluate(
        () => document.querySelector<HTMLElement>("#settings-body .mesh-item")!.dataset.mesh!,
        undefined,
      );
      await page.click("#settings-body .mesh-item >> nth=0");
      // The tint blinks every 160 ms: poll by time, since frames can be slower.
      const tint = (cond: string) =>
        page.waitForFunction(
          `window.mochi2dViewer.model.runtime.getTint(${JSON.stringify(id)}) ${cond}`,
          undefined,
          { timeout: 30000, polling: 20 },
        );
      await tint("!== null");
      await tint("=== null");
      await page.click("#resource-tree .tree-row.kind-physics");
      await waitFor(
        `document.getElementById("settings-body").textContent.includes("Rate in use")`,
        90000,
      );
      const body = await text("#settings-body");
      expect(body).toContain("Rate in use: 60 steps per second (the file's Fps)");
      expect(body).toContain("Groups131");
      expect(errors).toEqual([]);
    },
    240000,
  );

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});

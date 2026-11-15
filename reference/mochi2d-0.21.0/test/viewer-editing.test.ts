/**
 * Editing in the viewer, in headless Chromium, on a crafted model served as a
 * zip: a motion's settings entry (fade, motion-sync setting, sound, group)
 * saved in the model settings and used by the runtime at once; an
 * expression's values (an Add value as the parameter's value, Multiply from
 * right-click, Overwrite) shown live and written as `.exp3.json`; a new pose
 * with groups and a link, applied live; the unsaved marks; and the export:
 * one changed file on its own, several as one `.zip`. Needs `npm run build`
 * and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
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
import { BASIC, motionSyncJson, wavFile } from "./support/motion-sync.js";

const root = resolve(__dirname, "..");
let available = existsSync(join(root, "dist", "web", "index.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

/** Two arm variants and a sleeve, each with a mesh; a mouth parameter. */
function moc(): Uint8Array {
  const s = new Synth(5);
  s.canvas = { pixelsPerUnit: 100, originX: 100, originY: 100, width: 200, height: 200, flags: 0 };
  s.param("ParamMouthOpenY", 0, 1, 0);
  s.param("ParamMouthForm", -1, 1, -0.2);
  const rootPart = s.part({ id: "Root" });
  for (const [k, id] of ["ArmA", "ArmB", "Sleeve"].entries()) {
    const part = s.part({ id, parent: rootPart });
    const x = -0.6 + 0.5 * k;
    s.mesh({
      id: `${id}Mesh`,
      part,
      uvs: new Array(8).fill(0.5),
      triangles: [0, 1, 2, 1, 3, 2],
      keyforms: [{ positions: [x, -0.2, x + 0.3, -0.2, x, 0.2, x + 0.3, 0.2] }],
    });
  }
  return s.build();
}
const motion = (curveId: string) =>
  JSON.stringify({
    Version: 3,
    Meta: {
      Duration: 1,
      Fps: 30,
      Loop: false,
      AreBeziersRestricted: true,
      CurveCount: 1,
      TotalSegmentCount: 1,
      TotalPointCount: 2,
      UserDataCount: 0,
      TotalUserDataSize: 0,
    },
    Curves: [{ Target: "Parameter", Id: curveId, Segments: [0, 0, 0, 1, 0] }],
  });
const settings = {
  Version: 3,
  FileReferences: {
    Moc: "ed.moc3",
    Textures: ["tex.png"],
    MotionSync: "ed.motionsync3.json",
    Expressions: [{ Name: "smile", File: "smile.exp3.json" }],
    Motions: {
      Idle: [{ File: "idle.motion3.json" }],
      Tap: [{ File: "tap.motion3.json", Note: "kept" }],
    },
  },
  Groups: [{ Target: "Parameter", Name: "LipSync", Ids: ["ParamMouthOpenY"] }],
};
const ZIP = buildZip([
  { name: "ed/ed.model3.json", data: JSON.stringify(settings) },
  { name: "ed/ed.moc3", data: moc() },
  {
    name: "ed/tex.png",
    data: encodePng({ width: 4, height: 4, data: new Uint8Array(64).fill(200) }),
  },
  { name: "ed/ed.motionsync3.json", data: JSON.stringify(motionSyncJson(BASIC)) },
  {
    name: "ed/smile.exp3.json",
    data: JSON.stringify({
      Type: "Live2D Expression",
      Custom: "kept",
      Parameters: [{ Id: "ParamMouthForm", Value: 0.6, Blend: "Add" }],
    }),
  },
  { name: "ed/idle.motion3.json", data: motion("ParamMouthOpenY") },
  { name: "ed/tap.motion3.json", data: motion("ParamMouthOpenY") },
  { name: "ed/sounds/voice.wav", data: wavFile([new Float32Array(1600)], 16000) },
]);

describe.skipIf(!available)("editing in the viewer (headless Chromium)", () => {
  let server: RunningServer;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const viewer = <R>(src: string) =>
    page.evaluate<R>(`(() => { const v = window.mochi2dViewer; return ${src}; })()`);
  const waitFor = (cond: string, timeout = 30000) =>
    page.waitForFunction(
      `(() => { const v = window.mochi2dViewer; return ${cond}; })()`,
      undefined,
      { timeout },
    );
  /** The unsaved items' labels in the tree. */
  const unsaved = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll("#resource-tree .tree-row.unsaved")].map(
          (r) => r.textContent,
        ),
      undefined,
    );
  /** Sets an input of the settings area and fires its change event. */
  const set = (selector: string, value: string) =>
    page.evaluate(
      ([sel, v]) => {
        const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(
          `#settings-body ${sel}`,
        )!;
        input.value = v;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      [selector, value] as const,
    );

  beforeAll(async () => {
    const models = createModelsHandler(root);
    server = await startStaticServer(join(root, "dist", "web"), root, 0, "127.0.0.1", {
      modelsHandler: async (req, res, next) => {
        if (req.url === "/crafted/ed.zip") {
          res.setHeader("Content-Type", "application/zip");
          res.end(Buffer.from(ZIP));
          return;
        }
        await models(req, res, next);
      },
    });
    browser = await launchChromium([...CHROMIUM_MEDIA_ARGS]);
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("index.html", server.url).href, { waitUntil: "load" });
    await waitFor("v && v.stage");
    await page.click("#toggle-open");
    await page.fill("#url-input", new URL("crafted/ed.zip", server.url).href);
    await page.click("#url-form button[type=submit]");
    await page.waitForFunction(
      "/ed\\.model3\\.json: moc3 v5|failed/.test(document.getElementById('status').textContent)",
      undefined,
      { timeout: 60000 },
    );
    // Only what the tests drive moves the model.
    await page.evaluate(`(() => {
      const rt = window.mochi2dViewer.model.runtime;
      for (const e of ["idle", "eyeBlink", "breath", "look"]) rt.setEffect(e, false);
      rt.stopMotions();
    })()`);
  }, 90000);

  afterAll(async () => {
    await page
      ?.evaluate("window.mochi2dViewer && window.mochi2dViewer.stage.stop()")
      .catch(() => {});
    await browser?.close();
    await server?.close();
  }, 60000);

  it("edits a motion's settings entry and moves it to another group", async () => {
    await page.click('#resource-tree .tree-row[title^="Tap[0]"]');
    await waitFor(`document.querySelector("#settings-body [data-field=fadeIn]") !== null`);
    expect(await unsaved()).toEqual([]);
    await set("[data-field=fadeIn]", "300");
    await waitFor(
      `document.querySelector("#settings-body").textContent.includes("300 ms (settings)")`,
    );
    await set("[data-field=motionSync]", "Mouth basic");
    await set("[data-field=sound]", "sounds/voice.wav");
    expect(await unsaved()).toEqual(["ed.model3.json", "tap.motion3.json"]);
    const tap = await viewer<unknown>("v.edits.settingsJson.FileReferences.Motions.Tap[0]");
    expect(tap).toEqual({
      File: "tap.motion3.json",
      Note: "kept",
      FadeInTime: 0.3,
      MotionSync: "Mouth basic",
      Sound: "sounds/voice.wav",
    });
    // The runtime plays groups from the edited settings.
    expect(
      await viewer<unknown>(
        "v.model.runtime.settings.motions.find((g) => g.group === 'Tap').entries[0]",
      ),
    ).toEqual({
      file: "tap.motion3.json",
      fadeInTime: 0.3,
      sound: "sounds/voice.wav",
      motionSync: "Mouth basic",
    });
    // Into Idle: the Tap group goes, Idle has two motions, idle playback picks from both.
    await set("[data-field=group]", "Idle");
    await waitFor(`v.tree.selection && v.tree.selection.group === "Idle"`);
    const rows = await page.evaluate(
      () => [...document.querySelectorAll("#resource-tree .tree-row")].map((r) => r.textContent),
      undefined,
    );
    expect(rows).toContain("Idle2");
    expect(rows.some((r) => r?.startsWith("Tap"))).toBe(false);
    expect(await viewer<number>("v.model.runtime.animator.idleCount")).toBe(2);
    expect(
      await viewer<unknown>("Object.keys(v.edits.settingsJson.FileReferences.Motions)"),
    ).toEqual(["Idle"]);
  });

  it("edits an expression: Add values as the parameter's value, Multiply on right-click, Overwrite", async () => {
    await page.click("#panel-expressions .anim-item");
    await waitFor(
      `document.querySelector("#settings-body tr[data-param=ParamMouthForm]") !== null`,
    );
    // The file's Add 0.6 on a default of −0.2 shows as 0.4.
    const shown = () =>
      page.evaluate(() => {
        const tr = document.querySelector("#settings-body tr[data-param=ParamMouthForm]")!;
        return [
          (tr.querySelector("input[type=number]") as HTMLInputElement).value,
          (tr.querySelector("select") as HTMLSelectElement).value,
          tr.classList.contains("multiply"),
        ];
      }, undefined);
    expect(await shown()).toEqual(["0.4", "Add", false]);
    await set("tr[data-param=ParamMouthForm] input[type=number]", "0.5");
    const file = () =>
      viewer<string>(
        "v.edits.source.read('ed/smile.exp3.json').then((b) => new TextDecoder().decode(b))",
      );
    expect(JSON.parse(await file())).toEqual({
      Type: "Live2D Expression",
      Custom: "kept",
      Parameters: [{ Id: "ParamMouthForm", Value: 0.7, Blend: "Add" }],
    });
    await page.click("#settings-body tr[data-param=ParamMouthForm]", { button: "right" });
    expect(await shown()).toEqual(["1", "Multiply", true]);
    await set("tr[data-param=ParamMouthForm] select", "Overwrite");
    await set("tr[data-param=ParamMouthForm] input[type=number]", "0.3");
    await set("[data-field=fadeIn]", "200");
    expect(JSON.parse(await file())).toEqual({
      Type: "Live2D Expression",
      FadeInTime: 0.2,
      Custom: "kept",
      Parameters: [{ Id: "ParamMouthForm", Value: 0.3, Blend: "Overwrite" }],
    });
    // The preview shows it at once.
    await waitFor(`Math.abs(v.model.getParameter("ParamMouthForm") - 0.3) < 1e-6`);
    expect(await unsaved()).toContain("smile");
    // Another parameter, checked from the full list.
    await page.click("#settings-body [data-field=all-parameters]");
    await page.click("#settings-body tr[data-param=ParamMouthOpenY] input[type=checkbox]");
    expect(JSON.parse(await file()).Parameters).toEqual([
      { Id: "ParamMouthForm", Value: 0.3, Blend: "Overwrite" },
      { Id: "ParamMouthOpenY", Value: 0, Blend: "Add" },
    ]);
  });

  it("makes a pose, groups the arms and links the sleeve, and shows it live", async () => {
    await page.click("#resource-tree .tree-row.kind-settings");
    await waitFor(`document.querySelector("#settings-body [data-act=new-pose]") !== null`);
    await page.click("#settings-body [data-act=new-pose]");
    await waitFor(`document.querySelector("#settings-body tr[data-part=ArmA]") !== null`);
    expect(await viewer<string>("v.tree.selection.label")).toBe("ed.pose3.json");
    await set("[data-field=fade]", "0");
    await set("tr[data-part=ArmA] [data-field=group]", "1");
    await set("tr[data-part=ArmB] [data-field=group]", "1");
    await set("tr[data-part=Sleeve] [data-field=follows]", "ArmB");
    await waitFor(
      `v.model.runtime.getPartOpacity("ArmB") === 0 && v.model.runtime.getPartOpacity("ArmA") === 1`,
    );
    expect(await viewer<number>("v.model.runtime.getPartOpacity('Sleeve')")).toBe(0);
    const pose = JSON.parse(
      await viewer<string>(
        "v.edits.source.read('ed/ed.pose3.json').then((b) => new TextDecoder().decode(b))",
      ),
    );
    expect(pose).toEqual({
      Type: "Live2D Pose",
      FadeInTime: 0,
      Groups: [
        [
          { Id: "ArmA", Link: [] },
          { Id: "ArmB", Link: ["Sleeve"] },
        ],
      ],
    });
    // A linked part also in a group: allowed, with a warning.
    await set("tr[data-part=Sleeve] [data-field=group]", "2");
    expect(
      await page.evaluate(
        () => document.querySelector("#settings-body .warnings")!.textContent,
        undefined,
      ),
    ).toContain("Sleeve is in group 2 and follows ArmB");
    await set("tr[data-part=Sleeve] [data-field=group]", "");
    expect(await viewer<string>("v.edits.settingsJson.FileReferences.Pose")).toBe("ed.pose3.json");
    expect(await unsaved()).toEqual(
      expect.arrayContaining(["ed.model3.json", "smile", "ed.pose3.json"]),
    );
  });

  it("exports several changed files as one zip, and one changed file on its own", async () => {
    expect(
      await page.evaluate(
        () => document.querySelector("#export-settings .label")!.textContent,
        undefined,
      ),
    ).toBe("Export changes (ed.zip)");
    await page.click("#stage");
    await page.keyboard.press("Control+s");
    await waitFor("v.lastExport !== null && v.lastExport.name === 'ed.zip'");
    const out = await viewer<{ files: string[]; data: number[] }>(
      "({ files: v.lastExport.files, data: Array.from(v.lastExport.data) })",
    );
    expect(out.files).toEqual(["ed.model3.json", "smile.exp3.json", "ed.pose3.json"]);
    const zip = unzipSync(Uint8Array.from(out.data));
    expect(Object.keys(zip)).toEqual(out.files);
    const s = JSON.parse(strFromU8(zip["ed.model3.json"]!)) as typeof settings & {
      FileReferences: { Pose?: string };
    };
    expect(s.FileReferences.Pose).toBe("ed.pose3.json");
    expect(s.FileReferences.Motions).toEqual({
      Idle: [
        { File: "idle.motion3.json" },
        {
          File: "tap.motion3.json",
          Note: "kept",
          FadeInTime: 0.3,
          MotionSync: "Mouth basic",
          Sound: "sounds/voice.wav",
        },
      ],
    });
    expect(JSON.parse(strFromU8(zip["smile.exp3.json"]!)).Parameters).toHaveLength(2);
    expect(JSON.parse(strFromU8(zip["ed.pose3.json"]!)).Groups).toHaveLength(1);
    expect(await unsaved()).toEqual([]);
    expect(await viewer<boolean>("v.edits.dirty")).toBe(false);
    // One more change: that file alone.
    await page.click("#panel-expressions .anim-item");
    await waitFor(`document.querySelector("#settings-body [data-field=fadeOut]") !== null`);
    await set("[data-field=fadeOut]", "100");
    expect(await unsaved()).toEqual(["smile"]);
    await page.click("#stage");
    await page.keyboard.press("Control+s");
    await waitFor("v.lastExport.name === 'smile.exp3.json'");
    expect(JSON.parse(await viewer<string>("v.lastExport.text")).FadeOutTime).toBe(0.1);
    expect(await unsaved()).toEqual([]);
  });

  it("copies a part ID, makes a new expression, and asks before opening another model with changes", async () => {
    // Ctrl+C on a selected part of the pose.
    await page.click("#resource-tree .tree-row.kind-pose");
    await waitFor(`document.querySelector("#settings-body tr[data-part=ArmA]") !== null`);
    await page.click("#settings-body tr[data-part=ArmA] td >> nth=0");
    await page.keyboard.press("Control+c");
    await waitFor(`document.getElementById("status").textContent === "Copied ArmA"`);
    // A new expression, named here, listed in the settings and editable.
    await page.click("#menu-file, #toggle-open");
    await page.click("#new-expression");
    await waitFor(
      `document.querySelector("#settings-body [data-field=new-expression-name]") !== null`,
    );
    await page.fill("#settings-body [data-field=new-expression-name]", "smile");
    await page.click("#settings-body [data-act=new-expression]");
    await waitFor(
      `/already have an expression named "smile"/.test(document.getElementById("status").textContent)`,
    );
    await page.fill("#settings-body [data-field=new-expression-name]", "wink");
    await page.click("#settings-body [data-act=new-expression]");
    await waitFor(`v.tree.selection && v.tree.selection.label === "wink"`);
    await waitFor(
      `document.querySelector("#settings-body tr[data-param=ParamMouthOpenY]") !== null`,
    );
    await page.click("#settings-body tr[data-param=ParamMouthOpenY] input[type=checkbox]");
    expect(await viewer<unknown>("v.edits.settingsJson.FileReferences.Expressions")).toEqual([
      { Name: "smile", File: "smile.exp3.json" },
      { Name: "wink", File: "wink.exp3.json" },
    ]);
    expect(
      JSON.parse(
        await viewer<string>(
          "v.edits.source.read('ed/wink.exp3.json').then((b) => new TextDecoder().decode(b))",
        ),
      ),
    ).toEqual({
      Type: "Live2D Expression",
      Parameters: [{ Id: "ParamMouthOpenY", Value: 0, Blend: "Add" }],
    });
    expect(await unsaved()).toEqual(expect.arrayContaining(["ed.model3.json", "wink"]));
    // Opening another model asks first; declining keeps this one and its changes.
    const asked: string[] = [];
    page.on("dialog", (d) => {
      asked.push(d.message());
      void d.dismiss();
    });
    await page.click("#toggle-open");
    await page.fill("#url-input", new URL("crafted/ed.zip", server.url).href);
    await page.click("#url-form button[type=submit]");
    await waitFor(
      `document.getElementById("status").textContent === "Kept the open model and its changes"`,
    );
    expect(asked).toEqual([
      "The open model has changes that are not exported. Open another model and lose them?",
    ]);
    expect(await viewer<boolean>("v.edits.dirty")).toBe(true);
    expect(await viewer<string>("v.tree.selection.label")).toBe("wink");
  });

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});

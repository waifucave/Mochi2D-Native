/**
 * The headless model runtime (src/runtime) and the Node entry: loading from
 * a folder, a settings path and a zip; display names; the physics routing of
 * look and the lip-sync fallback; motions by group (with settings fades and
 * sounds), by file, and idle playback; expressions by name and path; change
 * tracking; hit tests in model units. Crafted settings and motions are built
 * at test time on DeepSeek-chan's model file (nothing is written to disk).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import {
  MemoryFileSource,
  OverlayFileSource,
  type FileSource,
} from "../src/core/io/file-source.js";
import { ModelRuntime } from "../src/runtime/model-runtime.js";
import { findSettingsFiles } from "../src/runtime/bundle.js";
import { sourceFromZip } from "../src/runtime/zip-source.js";
import { sourceFromFolder, loadModelFromDisk } from "../src/lib/node.js";
import { sequenceRandom } from "../src/anim/scenario.js";
import { constant, motionJson, wav16 } from "./support/anim.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
const deepseek = DEEPSEEK;
const SETTINGS = "大肥鱼.model3.json";

/** Pins the effects that vary over time off, so frames repeat. */
function still(rt: ModelRuntime): void {
  for (const e of ["physics", "eyeBlink", "breath", "look", "idle"] as const)
    rt.setEffect(e, false);
}

describe("ModelRuntime on DeepSeek-chan", () => {
  let rt: ModelRuntime;
  beforeAll(async () => {
    rt = await loadModelFromDisk(join(deepseek, SETTINGS));
  });

  it("loads names, groups, the physics routing of look and the lip-sync fallback", () => {
    const cdi = JSON.parse(
      readFileSync(join(deepseek, "大肥鱼.cdi3.json"), "utf8").replace(/^﻿/, ""),
    ) as { Parameters: { Id: string; Name: string }[] };
    expect(rt.settingsPath).toBe(SETTINGS);
    expect(rt.parameters).toHaveLength(rt.model.parameters.ids.length);
    expect(rt.parts).toHaveLength(rt.model.parts.ids.length);
    const angle = rt.parameters.find((p) => p.id === "ParamAngleX")!;
    expect(angle.name).toBe(cdi.Parameters.find((p) => p.Id === "ParamAngleX")!.Name);
    expect(angle.blendShape).toBe(false);
    expect(rt.physicsDriven.get("ParamAngleX")).toBe("AngleX");
    expect(rt.physicsInputs.get("ParamAngleX")).toEqual([
      { id: "AngleX", weight: 100, type: "Angle", reflect: false },
    ]);
    expect(rt.physicsInputs.get("ParamBodyAngleRX")!.map((i) => [i.id, i.weight])).toEqual([
      ["PositionX", 47],
      ["PositionZ", 24],
    ]);
    // Exactly the parameters physics overwrites; physicsDriven names the first input of each.
    expect([...rt.physicsDriven.keys()]).toEqual([...rt.physicsInputs.keys()]);
    for (const [id, inputs] of rt.physicsInputs)
      expect(rt.physicsDriven.get(id)).toBe(inputs[0]!.id);
    expect(rt.lipSyncFallback).toBe("ParamMouthOpenY");
    expect(rt.lookRouting().find((r) => r.target === "ParamAngleX")!.writes).toBe("AngleX");
    rt.lookThroughPhysics = false;
    rt.updateLookTargets();
    expect(rt.lookRouting().find((r) => r.target === "ParamAngleX")!.writes).toBe("ParamAngleX");
    rt.lookThroughPhysics = true;
    rt.updateLookTargets();
    expect(rt.motionGroups).toEqual([]);
    expect(rt.expressionNames).toEqual([]);
    expect(rt.hitAreas).toEqual([]);
    expect(rt.files).toContain("Animation/脱捕.motion3.json");
    expect(rt.warnings).toEqual([]);
  });

  it("evaluates only when a value changed", () => {
    still(rt);
    expect(rt.update(1 / 60)?.changed).toBeDefined();
    expect(rt.update(1 / 60)!.changed).toBe(false);
    expect(rt.update(0)).toBeNull(); // nothing to do
    expect(rt.setParameter("AngleX", 30)).toBe(true);
    expect(rt.setParameter("NoSuchParameter", 1)).toBe(false);
    const before = Array.from(rt.instance.drawableVertices[0]!);
    const r = rt.update(0)!;
    expect(r.changed).toBe(true);
    expect(rt.getParameter("AngleX")).toBe(30);
    // Physics is off: ParamAngleX stays; with physics on it follows AngleX.
    expect(rt.getParameter("ParamAngleX")).toBe(0);
    rt.setEffect("physics", true);
    for (let i = 0; i < 60; i++) rt.update(1 / 60);
    expect(rt.getParameter("ParamAngleX")).toBeGreaterThan(10);
    const after = rt.instance.drawableVertices;
    expect(after.some((v, d) => d >= 0 && v.length > 0) && before.length > 0).toBe(true);
    rt.resetParameters();
    rt.setEffect("physics", false);
    rt.update(1 / 60);
    expect(rt.getParameter("AngleX")).toBe(0);
  });

  it("plays motion files and expressions by path", async () => {
    still(rt);
    expect(await rt.startMotionFile("Animation/脱捕.motion3.json")).not.toBe(false);
    expect(rt.playingMotions).toEqual(["Animation/脱捕.motion3.json"]);
    // Priority 2 is refused while the first plays; 3 forces.
    expect(await rt.startMotionFile("Animation/IDLE.motion3.json")).toBe(false);
    expect(await rt.startMotionFile("Animation/IDLE.motion3.json", { priority: 3 })).not.toBe(
      false,
    );
    for (let i = 0; i < 30; i++) rt.update(1 / 60);
    rt.stopMotions();
    expect(rt.playingMotions).toEqual([]);
    expect(await rt.startMotionFile("Animation/脱捕.motion3.json")).not.toBe(false);
    rt.stopMotions();
    await rt.setExpression("Exp3/脸红.exp3.json");
    expect(rt.playingExpressions).toEqual(["Exp3/脸红.exp3.json"]);
    for (let i = 0; i < 90; i++) rt.update(1 / 60);
    rt.clearExpression();
    for (let i = 0; i < 90; i++) rt.update(1 / 60);
    expect(rt.playingExpressions).toEqual(["(none)"]);
    await expect(rt.startMotionFile("Animation/missing.motion3.json")).rejects.toThrow(/not found/);
    await expect(rt.startMotion("NoGroup")).rejects.toThrow(/no motion group/);
  });

  it("stopClearsPriority: false keeps the priority after stopMotions (C19)", async () => {
    const strict = await ModelRuntime.load(rt.source, rt.settingsPath, {
      stopClearsPriority: false,
    });
    expect(await strict.startMotionFile("Animation/脱捕.motion3.json")).not.toBe(false);
    strict.stopMotions();
    expect(strict.playingMotions).toEqual([]);
    // The kept priority 2 refuses another priority-2 start; priority 3 forces.
    expect(await strict.startMotionFile("Animation/脱捕.motion3.json")).toBe(false);
    expect(await strict.startMotionFile("Animation/脱捕.motion3.json", { priority: 3 })).not.toBe(
      false,
    );
  });

  it("hit-tests drawables in model units", () => {
    rt.update(0);
    const id = rt.drawableAt(0, 0);
    expect(id).not.toBeNull();
    const b = rt.drawableBounds(id!)!;
    expect(b.minX).toBeLessThanOrEqual(0);
    expect(b.maxX).toBeGreaterThanOrEqual(0);
    expect(rt.drawableAt(1e6, 1e6)).toBeNull();
    expect(rt.hitAreasAt(0, 0)).toEqual([]);
  });
});

describe("ModelRuntime with crafted settings", () => {
  /** DeepSeek-chan's folder plus crafted files on top (settings, motions, expression, sound). */
  let source: FileSource;
  let hitId: string;
  const sound = wav16(
    Array.from({ length: 8000 }, (_, i) => 0.5 * Math.sin(i / 3)),
    8000,
  );

  beforeAll(async () => {
    const base = await sourceFromFolder(deepseek);
    const probe = await ModelRuntime.load(base, SETTINGS);
    probe.update(0);
    hitId = probe.drawableAt(0, 0)!;
    const crafted = new MemoryFileSource("crafted", [
      [
        "crafted.model3.json",
        new TextEncoder().encode(
          JSON.stringify({
            Version: 3,
            FileReferences: {
              Moc: "大肥鱼.moc3",
              Textures: [],
              Motions: {
                Idle: [{ File: "m/idle.motion3.json" }],
                Tap: [
                  { File: "m/tap.motion3.json", FadeInTime: 0.25, Sound: "s/hello.wav" },
                  { File: "m/broken.motion3.json" },
                ],
              },
              Expressions: [{ Name: "Smile", File: "Exp3/脸红.exp3.json" }],
            },
            Groups: [{ Target: "Parameter", Name: "LipSync", Ids: ["ParamMouthOpenY"] }],
            HitAreas: [{ Id: hitId, Name: "Body" }],
          }),
        ),
      ],
      [
        "m/idle.motion3.json",
        new TextEncoder().encode(
          motionJson({ duration: 1, fps: 30, curves: [constant("AngleY", 5, 1)] }),
        ),
      ],
      [
        "m/tap.motion3.json",
        new TextEncoder().encode(
          motionJson({
            duration: 0.5,
            fps: 30,
            curves: [constant("AngleZ", 10, 0.5)],
            events: [{ time: 0.1, value: "wave" }],
          }),
        ),
      ],
      ["m/broken.motion3.json", new TextEncoder().encode("{")],
      ["s/hello.wav", sound],
    ]);
    source = new OverlayFileSource("crafted + DeepSeek", [crafted, base]);
  });

  it("plays the Idle group on its own, starts groups with settings fades and sounds", async () => {
    const sounds: string[] = [];
    const rt = await ModelRuntime.load(source, "crafted.model3.json", {
      onSound: (path) => sounds.push(path),
      animation: { random: sequenceRandom(Array.from({ length: 100 }, () => 0.5)) },
    });
    expect(rt.motionGroups).toEqual([
      { name: "Idle", count: 1 },
      { name: "Tap", count: 2 },
    ]);
    expect(rt.lipSyncFallback).toBeNull();
    rt.setEffect("eyeBlink", false);
    rt.update(1 / 60); // the idle draw starts m/idle at priority 1
    expect(rt.playingMotions).toEqual(["m/idle.motion3.json"]);
    // The first processing sets the fade-in start; the weight then grows.
    for (let i = 0; i < 5; i++) rt.update(1 / 60);
    expect(rt.getParameter("AngleY")).toBeGreaterThan(0);
    // A tap motion (priority 2) replaces it, with the settings' fade-in and its sound.
    expect(await rt.startMotion("Tap", 0)).not.toBe(false);
    expect(sounds).toEqual(["s/hello.wav"]);
    let events: string[] = [];
    let lip = 0;
    for (let i = 0; i < 20; i++) {
      const r = rt.update(1 / 60)!;
      events = events.concat(r.events);
      lip = Math.max(lip, r.lipSync ?? 0);
    }
    expect(events).toEqual(["wave"]);
    expect(lip).toBeGreaterThan(0.3);
    expect(rt.getParameter("ParamMouthOpenY")).toBeGreaterThan(0.3);
    await expect(rt.startMotion("Tap", 1)).rejects.toThrow();
    await expect(rt.startMotion("Tap", 5)).rejects.toThrow(RangeError);
  });

  it("starts expressions by name and reports hit areas by name", async () => {
    const rt = await ModelRuntime.load(source, "crafted.model3.json");
    expect(rt.expressionNames).toEqual(["Smile"]);
    await rt.setExpression("Smile");
    expect(rt.playingExpressions).toEqual(["Exp3/脸红.exp3.json"]);
    rt.update(0);
    const b = rt.hitAreaBounds();
    expect(b).toHaveLength(1);
    expect(b[0]!.name).toBe("Body");
    const cx = (b[0]!.bounds.minX + b[0]!.bounds.maxX) / 2;
    const cy = (b[0]!.bounds.minY + b[0]!.bounds.maxY) / 2;
    expect(rt.hitAreasAt(cx, cy)).toEqual(["Body"]);
    expect(rt.hitAreasAt(1e6, 0)).toEqual([]);
  });

  it("finds the settings file of a folder and of a zip", async () => {
    expect(findSettingsFiles(source)).toEqual(["crafted.model3.json", SETTINGS]);
    const files: Record<string, Uint8Array> = {};
    for (const p of [
      "大肥鱼.model3.json",
      "大肥鱼.moc3",
      "大肥鱼.physics3.json",
      "大肥鱼.cdi3.json",
    ])
      files[`DeepSeek/${p}`] = new Uint8Array(readFileSync(join(deepseek, p)));
    const zip = sourceFromZip("deepseek.zip", zipSync(files, { level: 0 }));
    const rt = await ModelRuntime.load(zip);
    expect(rt.settingsPath).toBe("DeepSeek/大肥鱼.model3.json");
    expect(rt.files).toEqual([
      "大肥鱼.cdi3.json",
      "大肥鱼.moc3",
      "大肥鱼.model3.json",
      "大肥鱼.physics3.json",
    ]);
    // Missing textures do not matter headlessly.
    rt.update(1 / 60);
    const fromFolder = await loadModelFromDisk(deepseek);
    expect(fromFolder.settingsPath).toBe(SETTINGS);
  });
});

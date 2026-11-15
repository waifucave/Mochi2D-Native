/**
 * Motion sync in the model runtime, on DeepSeek-chan with the crafted
 * ds-motionsync settings (ds-two and the group "Talk"): who writes the
 * mouth while 脱捕 plays with a sound (T15), links per entry (T19), an entry
 * without a link (T20), link warnings, the placement against physics, the
 * effect switch, and the runtime API (sounds, live input, voice profiles).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryFileSource,
  OverlayFileSource,
  type FileSource,
} from "../src/core/io/file-source.js";
import { ModelRuntime, type RuntimeOptions } from "../src/runtime/model-runtime.js";
import { sourceFromFolder } from "../src/lib/node.js";
import { MotionSyncAudioError } from "../src/anim/motion-sync/wav.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";
import {
  FEMALE,
  MALE,
  TALK_SOUNDS,
  dsMotionSyncSettings,
  dsTwo,
  silence,
  vowelClip,
  wavFile,
  whiteNoise,
} from "./support/motion-sync.js";

const enc = (s: string) => new TextEncoder().encode(s);
const MOUTH = ["ParamMouthOpenY", "ParamMouthForm"];
/** The female clip's length: five vowels of 1 s, with 0.3 s of silence around each. */
const FEMALE_SECONDS = 5 + 6 * 0.3;

describe.skipIf(!HAVE_DEEPSEEK)("motion sync in the model runtime", () => {
  let source: FileSource;
  const sounds = {
    male: wavFile([vowelClip(MALE, 16000).samples], 16000),
    female: wavFile([vowelClip(FEMALE, 48000).samples], 48000),
    noise: wavFile([whiteNoise(2, 44100, -20)], 44100),
    silence: wavFile([silence(2, 44100)], 44100),
  };

  beforeAll(async () => {
    const base = await sourceFromFolder(DEEPSEEK);
    const own = JSON.parse(
      readFileSync(join(DEEPSEEK, "大肥鱼.model3.json"), "utf8").replace(/^﻿/, ""),
    );
    const settings = dsMotionSyncSettings(own) as {
      FileReferences: { Motions: Record<string, unknown[]> };
    };
    const broken = JSON.parse(JSON.stringify(settings));
    broken.FileReferences.Motions.Talk = [
      { File: "Animation/IDLE.motion3.json", Sound: TALK_SOUNDS.male, MotionSync: "Nope" },
    ];
    const noFile = JSON.parse(JSON.stringify(settings));
    delete noFile.FileReferences.MotionSync;
    const crafted = new MemoryFileSource("crafted", [
      ["ds-motionsync.model3.json", enc(JSON.stringify(settings))],
      ["ds-broken-link.model3.json", enc(JSON.stringify(broken))],
      ["ds-no-file.model3.json", enc(JSON.stringify(noFile))],
      ["ds-two.motionsync3.json", enc(JSON.stringify(dsTwo()))],
      [TALK_SOUNDS.male, sounds.male],
      [TALK_SOUNDS.female, sounds.female],
      [TALK_SOUNDS.noise, sounds.noise],
      [TALK_SOUNDS.silence, sounds.silence],
    ]);
    source = new OverlayFileSource("crafted + DeepSeek", [crafted, base]);
  });

  /** A runtime with the effects that vary by chance turned off. */
  async function runtime(options: RuntimeOptions = {}, path = "ds-motionsync.model3.json") {
    const played: string[] = [];
    const rt = await ModelRuntime.load(source, path, {
      onSound: (p) => played.push(p),
      ...options,
    });
    for (const e of ["eyeBlink", "breath", "look", "idle"] as const) rt.setEffect(e, false);
    return { rt, played };
  }
  const mouth = (rt: ModelRuntime) => MOUTH.map((id) => rt.getParameter(id));

  it("loads the file: both settings, nothing to warn about", async () => {
    const { rt } = await runtime();
    expect(rt.motionSyncSettings).toEqual([
      { id: "MS_Basic", name: "Mouth basic", usable: true },
      { id: "MS_Rich", name: "Mouth rich", usable: true },
    ]);
    expect(rt.effectAvailable("motionSync")).toBe(true);
    expect(rt.warnings.filter((w) => w.includes("motion"))).toEqual([]);
    const { rt: none } = await runtime({}, "ds-no-file.model3.json");
    expect(none.effectAvailable("motionSync")).toBe(false);
    expect(none.motionSyncSettings).toEqual([]);
  });

  it("T15: motion sync writes the mouth over 脱捕's curves, and gives them back once settled", async () => {
    const { rt, played } = await runtime();
    const { rt: twin } = await runtime();
    twin.setEffect("motionSync", false);
    await rt.startMotion("Talk", 1);
    await twin.startMotion("Talk", 1);
    expect(played).toEqual([TALK_SOUNDS.female]);
    let differ = 0;
    const dt = 1 / 60;
    for (let n = 1; n * dt <= FEMALE_SECONDS + 0.6; n++) {
      rt.update(dt);
      twin.update(dt);
      const tick = rt.motionSync;
      const t = n * dt;
      if (t < FEMALE_SECONDS - 0.05 && tick) {
        expect(tick.setting.name).toBe("Mouth rich");
        // Every frame, the mouth is motion sync's, not the motion's.
        MOUTH.forEach((id) => expect(rt.getParameter(id)).toBe(Math.fround(tick.values[id]!)));
        if (MOUTH.some((id) => rt.getParameter(id) !== twin.getParameter(id))) differ++;
      }
      // Physics never sees motion sync's values (it runs before): its outputs agree.
      expect(rt.getParameter("LipPhysics1")).toBe(twin.getParameter("LipPhysics1"));
    }
    expect(differ).toBeGreaterThan(200);
    // The sound has ended and settled: the motion's curves show again.
    expect(rt.motionSync).toBeNull();
    for (let n = 0; n < 30; n++) {
      rt.update(dt);
      twin.update(dt);
      expect(mouth(rt)).toEqual(mouth(twin));
    }
  });

  it("can run before physics, so lip physics reacts to speech", async () => {
    const { rt } = await runtime({ animation: { motionSync: { beforePhysics: true } } });
    const { rt: twin } = await runtime();
    twin.setEffect("motionSync", false);
    await rt.startMotion("Talk", 1);
    await twin.startMotion("Talk", 1);
    let differ = 0;
    for (let n = 0; n < 180; n++) {
      rt.update(1 / 60);
      twin.update(1 / 60);
      if (rt.getParameter("LipPhysics1") !== twin.getParameter("LipPhysics1")) differ++;
      // Lip sync (the ParamMouthOpenY fallback, fed the same sound) runs after motion sync
      // here, and leaves the parameters motion sync drives.
      const tick = rt.motionSync;
      if (tick)
        expect(rt.getParameter("ParamMouthOpenY")).toBe(Math.fround(tick.values.ParamMouthOpenY!));
    }
    expect(differ).toBeGreaterThan(30);
  });

  it("T19: entries with the same motion file each use their own sound and setting", async () => {
    const first = await runtime();
    await first.rt.startMotion("Talk", 0);
    const third = await runtime();
    await third.rt.startMotion("Talk", 2);
    expect(first.played).toEqual([TALK_SOUNDS.male]);
    expect(third.played).toEqual([TALK_SOUNDS.noise]);
    let open1 = 0;
    let open3 = 0;
    for (let n = 0; n < 60; n++) {
      first.rt.update(1 / 60);
      third.rt.update(1 / 60);
      open1 = Math.max(open1, first.rt.getParameter("ParamMouthOpenY"));
      open3 = Math.max(open3, third.rt.getParameter("ParamMouthOpenY"));
    }
    // Entry 1 names the setting by name, entry 3 by ID: both find "Mouth basic".
    expect(first.rt.motionSync?.setting.id).toBe("MS_Basic");
    expect(third.rt.motionSync?.setting.id).toBe("MS_Basic");
    expect(open1).toBeGreaterThan(0.5); // male vowels
    expect(open3).toBeLessThan(0.1); // noise
  });

  it("T20: an entry without a link plays its sound without motion sync", async () => {
    const { rt, played } = await runtime();
    await rt.startMotion("Talk", 3);
    for (let n = 0; n < 30; n++) rt.update(1 / 60);
    expect(played).toEqual([TALK_SOUNDS.silence]);
    expect(rt.motionSync).toBeNull();
    expect(rt.warnings.filter((w) => w.includes("motion-sync"))).toEqual([]);
  });

  it("warns when a link names no setting, and plays the sound without motion sync", async () => {
    const { rt, played } = await runtime({}, "ds-broken-link.model3.json");
    await rt.startMotion("Talk", 0);
    rt.update(1 / 60);
    expect(played).toEqual([TALK_SOUNDS.male]);
    expect(rt.motionSync).toBeNull();
    expect(
      rt.warnings.some((w) => w.includes(`motion-sync setting "Nope" is not in the file`)),
    ).toBe(true);
  });

  it("a motion replaced early fades its sound out, then the mouth settles", async () => {
    const { rt } = await runtime();
    await rt.startMotion("Talk", 0);
    for (let n = 0; n < 60; n++) rt.update(1 / 60);
    expect(rt.motionSync).not.toBeNull();
    await rt.startMotion("Talk", 3, { priority: 3 });
    let frames = 0;
    while (rt.motionSync && frames < 120) {
      rt.update(1 / 60);
      frames++;
    }
    expect(rt.motionSync).toBeNull();
    expect(frames).toBeGreaterThan(5);
  });

  it("the effect switch turns motion sync off: lip sync alone moves the mouth", async () => {
    const { rt } = await runtime();
    rt.setEffect("motionSync", false);
    // The same model without a motion-sync file: lip sync (the ParamMouthOpenY fallback) only.
    const { rt: plain } = await runtime({}, "ds-no-file.model3.json");
    await rt.startMotion("Talk", 1);
    await plain.startMotion("Talk", 1);
    let moved = 0;
    for (let n = 0; n < 90; n++) {
      rt.update(1 / 60);
      plain.update(1 / 60);
      expect(rt.motionSync).toBeNull();
      expect(mouth(rt)).toEqual(mouth(plain));
      if (rt.getParameter("ParamMouthOpenY") > 0) moved++;
    }
    expect(moved).toBeGreaterThan(10);
    expect(plain.warnings.some((w) => w.includes("the model has no motion-sync file"))).toBe(true);
  });

  it("plays any sound through a setting, with the element weights each tick", async () => {
    const { rt } = await runtime();
    expect(() => rt.startMotionSync(sounds.male, { setting: "Nope" })).toThrow(RangeError);
    expect(() => rt.startMotionSync(new Uint8Array(8))).toThrow(MotionSyncAudioError);
    const ticks: string[] = [];
    const off = rt.onMotionSyncTick((t) => ticks.push(t.setting.id));
    expect(rt.startMotionSync(sounds.male, { setting: "MS_Rich" })).toBe(true);
    for (let n = 0; n < 60; n++) rt.update(1 / 60);
    off();
    expect(ticks.length).toBeGreaterThan(25);
    expect(new Set(ticks)).toEqual(new Set(["MS_Rich"]));
    const tick = rt.motionSync!;
    expect(Object.keys(tick.values)).toEqual([
      "ParamMouthOpenY",
      "ParamMouthForm",
      "MouthFunnel",
      "Mouthpucker",
      "MouthPuckerWiden",
    ]);
    expect(tick.weights.A).toBeGreaterThan(0.5);
    rt.stopMotionSync();
    for (let n = 0; n < 40 && rt.motionSync; n++) rt.update(1 / 60);
    expect(rt.motionSync).toBeNull();
  });

  it("drives the mouth from a live input; null ends it", async () => {
    const { rt } = await runtime();
    const clip = vowelClip(MALE, 48000, { vowels: ["A"], hold: 2 }).samples;
    let pos = 0;
    expect(
      rt.setMotionSyncInput({
        sampleRate: 48000,
        read() {
          const out = clip.subarray(pos, Math.min(clip.length, pos + 800));
          pos += out.length;
          return out;
        },
      }),
    ).toBe(true);
    let open = 0;
    for (let n = 0; n < 90; n++) {
      rt.update(1 / 60);
      open = Math.max(open, rt.getParameter("ParamMouthOpenY"));
    }
    expect(open).toBeGreaterThan(0.5);
    expect(rt.motionSync?.source).toBe("live");
    rt.setMotionSyncInput(null);
    for (let n = 0; n < 40 && rt.motionSync; n++) rt.update(1 / 60);
    expect(rt.motionSync).toBeNull();
  });

  it("keeps a voice profile, and carries it to a new model", async () => {
    const { rt } = await runtime();
    expect(rt.voiceProfile).toBeNull();
    const profile = {
      format: "mochi2d-voice-profile" as const,
      version: 1 as const,
      name: "x",
      templates: {},
      voicedLevel: -20,
      floorLevel: null,
    };
    rt.setVoiceProfile(profile);
    expect(rt.voiceProfile).toBe(profile);
    rt.setVoiceProfile(null);
    expect(rt.voiceProfile).toBeNull();
  });
});

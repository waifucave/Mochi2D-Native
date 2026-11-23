/**
 * Motion-sync settings files: reading the crafted files (ds-basic, ds-rich,
 * ds-two), the lenient conversions with their warnings, the ignore and
 * clamp rules (T4–T14, T16, T17 at the reader), lint mode, setting lookup by
 * name then ID, the links in model settings files, and writing files back
 * (`writeMotionSync`). No model is needed.
 */
import { describe, expect, it } from "vitest";
import {
  findMotionSyncSetting,
  parseMotionSync,
  writeMotionSync,
  type MotionSyncFile,
} from "../src/anim/motion-sync/file.js";
import { AnimationFormatError } from "../src/anim/json.js";
import { settingsFromJson } from "../src/core/settings/model-settings.js";
import {
  BASIC,
  ELEMENTS,
  RICH,
  dsBasic,
  dsRich,
  dsTwo,
  edited,
  motionSyncJson,
} from "./support/motion-sync.js";

const read = (json: unknown, lint = false): MotionSyncFile =>
  parseMotionSync(JSON.stringify(json), "ms", { lint });
const basic = (edit: (j: any) => void) => read(edited(dsBasic(), edit));
/** Warnings that mention `what`. */
const warned = (f: MotionSyncFile, what: string) => f.warnings.filter((w) => w.includes(what));

describe("the crafted files", () => {
  it("reads ds-basic exactly, without warnings", () => {
    const f = read(dsBasic(), true);
    expect(f.warnings).toEqual([]);
    expect(f.version).toBe(1);
    expect(f.settings).toHaveLength(1);
    const s = f.settings[0]!;
    expect(s).toMatchObject({
      index: 0,
      id: "MS_Basic",
      name: "Mouth basic",
      analysisType: "CRI",
      useCase: "Mouth",
      usable: true,
      blendRatio: 0.5,
      smoothing: 60,
      sampleRate: 60,
    });
    expect(s.parameters).toEqual([
      { id: "ParamMouthOpenY", name: "ParamMouthOpenY", min: 0, max: 1, damper: 0, smooth: 25 },
      { id: "ParamMouthForm", name: "ParamMouthForm", min: -1, max: 1, damper: 0, smooth: 25 },
    ]);
    expect(s.elements.map((e) => [e.id, e.scale, e.enabled, e.known])).toEqual(
      ELEMENTS.map((e) => [e, 1, true, true]),
    );
    expect(s.shapes).toEqual(ELEMENTS.map((e) => BASIC.shapes[e]));
  });

  it("reads ds-rich and ds-two, settings in file order", () => {
    const rich = read(dsRich(), true);
    expect(rich.warnings).toEqual([]);
    expect(rich.settings[0]!.parameters.map((p) => p.id)).toEqual(RICH.params.map((p) => p.id));
    expect(rich.settings[0]).toMatchObject({ blendRatio: 0.3, smoothing: 40, sampleRate: 30 });
    const two = read(dsTwo(), true);
    expect(two.warnings).toEqual([]);
    expect(two.settings.map((s) => [s.index, s.id, s.name])).toEqual([
      [0, "MS_Basic", "Mouth basic"],
      [1, "MS_Rich", "Mouth rich"],
    ]);
    expect(two.settings[1]!.shapes).toEqual(ELEMENTS.map((e) => RICH.shapes[e]));
  });

  it("reads bytes and text alike; invalid JSON and non-objects throw", () => {
    const text = JSON.stringify(dsBasic());
    expect(parseMotionSync(new TextEncoder().encode(text), "ms")).toEqual(
      parseMotionSync(text, "ms"),
    );
    expect(() => parseMotionSync("{", "ms")).toThrow(AnimationFormatError);
    expect(() => parseMotionSync("[]", "ms")).toThrow(AnimationFormatError);
  });
});

describe("settings looked up by name, then by ID", () => {
  it("prefers a dictionary name over a setting ID", () => {
    const f = read(dsTwo());
    expect(findMotionSyncSetting(f, "Mouth rich")?.index).toBe(1);
    expect(findMotionSyncSetting(f, "MS_Basic")?.index).toBe(0);
    expect(findMotionSyncSetting(f, "Mouth")).toBeNull();
    // Setting 0's ID is setting 1's name: the name wins.
    const tricky = read(
      edited(dsTwo(), (j) => {
        j.Settings[0].Id = "Mouth rich";
        j.Meta.Dictionary[0].Id = "Mouth rich";
      }),
    );
    expect(findMotionSyncSetting(tricky, "Mouth rich")?.index).toBe(1);
  });
});

describe("ignore and clamp rules", () => {
  it("T4: an unknown analysis type leaves that setting unusable, with a warning", () => {
    const f = read(
      edited(dsTwo(), (j) => {
        j.Settings[0].AnalysisType = "XYZ";
      }),
    );
    expect(f.settings.map((s) => s.usable)).toEqual([false, true]);
    expect(warned(f, "Settings[0].AnalysisType")).toHaveLength(1);
  });

  it("T5, T6: another use case or mapping type is used anyway, with a warning", () => {
    const f = basic((j) => {
      j.Settings[0].UseCase = "Eyes";
      j.Settings[0].Mappings[1].Type = "Curve";
    });
    expect(f.settings[0]!.usable).toBe(true);
    expect(f.settings[0]!.shapes).toEqual(read(dsBasic()).settings[0]!.shapes);
    expect(warned(f, "UseCase")).toHaveLength(1);
    expect(warned(f, "Mappings[1].Type")).toHaveLength(1);
  });

  it("T7: SettingCount reads the smaller count, with a warning", () => {
    const two = basic((j) => (j.Meta.SettingCount = 2));
    expect(two.settings).toHaveLength(1);
    expect(warned(two, "Meta.SettingCount")).toHaveLength(1);
    const none = basic((j) => (j.Meta.SettingCount = 0));
    expect(none.settings).toHaveLength(0);
    expect(warned(none, "Meta.SettingCount")).toHaveLength(1);
  });

  it("T8, T9: mappings and targets in any order give the same shapes", () => {
    const want = read(dsBasic()).settings[0]!.shapes;
    const mappings = basic((j) => j.Settings[0].Mappings.reverse());
    expect(mappings.warnings).toEqual([]);
    expect(mappings.settings[0]!.shapes).toEqual(want);
    const targets = basic((j) => j.Settings[0].Mappings.forEach((m: any) => m.Targets.reverse()));
    expect(targets.warnings).toEqual([]);
    expect(targets.settings[0]!.shapes).toEqual(want);
  });

  it("T10: Enabled false disables an element; the number 1 reads as false, with a warning", () => {
    const off = basic((j) => (j.Settings[0].AudioParameters[4].Enabled = false));
    expect(off.warnings).toEqual([]);
    expect(off.settings[0]!.elements[4]).toMatchObject({ id: "E", enabled: false });
    const one = basic((j) => (j.Settings[0].AudioParameters[4].Enabled = 1));
    expect(one.settings[0]!.elements[4]!.enabled).toBe(false);
    expect(warned(one, "AudioParameters[4].Enabled")).toHaveLength(1);
  });

  it("T11: Scale is clamped to [0.1, 10]", () => {
    for (const [given, used] of [
      [0.05, 0.1],
      [20, 10],
    ]) {
      const f = basic((j) => (j.Settings[0].AudioParameters[1].Scale = given));
      expect(f.settings[0]!.elements[1]!.scale).toBe(used);
      expect(warned(f, "AudioParameters[1].Scale")).toHaveLength(1);
    }
  });

  it("T12: BlendRatio is clamped to [0, 1]", () => {
    for (const [given, used] of [
      [-0.1, 0],
      [1.5, 1],
    ]) {
      const f = basic((j) => (j.Settings[0].PostProcessing.BlendRatio = given));
      expect(f.settings[0]!.blendRatio).toBe(used);
      expect(warned(f, "BlendRatio")).toHaveLength(1);
    }
  });

  it("T13: Smoothing is read as an integer, then clamped to [1, 100]", () => {
    for (const [given, used, warns] of [
      [0, 1, 1],
      [101, 100, 1],
      [60.7, 60, 0],
      [-0.5, 1, 1],
      [1.9, 1, 0],
    ]) {
      const f = basic((j) => (j.Settings[0].PostProcessing.Smoothing = given));
      expect(f.settings[0]!.smoothing, `Smoothing ${given}`).toBe(used);
      expect(warned(f, "Smoothing"), `Smoothing ${given}`).toHaveLength(warns!);
    }
  });

  it("T14: SampleRate ≤ 0 or missing is 60; others are clamped to [1, 120]", () => {
    for (const [given, used, warns] of [
      [0, 60, 1],
      [-30, 60, 1],
      [0.5, 1, 1],
      [120, 120, 0],
      [240, 120, 1],
      [undefined, 60, 2],
    ]) {
      const f = basic((j) => (j.Settings[0].PostProcessing.SampleRate = given));
      expect(f.settings[0]!.sampleRate, `SampleRate ${given}`).toBe(used);
      expect(warned(f, "SampleRate"), `SampleRate ${given}`).toHaveLength(warns!);
    }
  });

  it("T16: Smooth is clamped to [0, 100]; a negative Damper acts as 0", () => {
    for (const [given, used, warns] of [
      [0, 0, 0],
      [100, 100, 0],
      [150, 100, 1],
      [-5, 0, 1],
    ]) {
      const f = basic((j) => (j.Settings[0].CubismParameters[0].Smooth = given));
      expect(f.settings[0]!.parameters[0]!.smooth).toBe(used);
      expect(warned(f, "Smooth")).toHaveLength(warns!);
    }
    for (const [given, used] of [
      [0.05, 0.05],
      [1, 1],
      [-1, 0],
    ]) {
      const f = basic((j) => (j.Settings[0].CubismParameters[1].Damper = given));
      expect(f.settings[0]!.parameters[1]!.damper).toBe(used);
      expect(f.warnings).toEqual([]);
    }
  });

  it("T17: another Version is accepted, with a warning", () => {
    const f = basic((j) => (j.Version = 2));
    expect(f.version).toBe(2);
    expect(f.settings[0]!.usable).toBe(true);
    expect(warned(f, "Version")).toHaveLength(1);
  });
});

describe("lenient conversions", () => {
  it("gives missing or ill-typed values their defaults, with a warning each", () => {
    const f = basic((j) => {
      const s = j.Settings[0];
      s.CubismParameters[0].Smooth = "25"; // a string is not a number: 0
      delete s.CubismParameters[1].Damper; // missing: 0
      s.AudioParameters[2].Scale = null; // 0, then clamped to 0.1
      delete s.AudioParameters[3].Enabled; // missing: false
      s.PostProcessing.BlendRatio = true; // 0
      j.Meta.Dictionary[0].Name = 7; // not a string: ""
    });
    const s = f.settings[0]!;
    expect(s.parameters[0]!.smooth).toBe(0);
    expect(s.parameters[1]!.damper).toBe(0);
    expect(s.elements[2]!.scale).toBe(0.1);
    expect(s.elements[3]!.enabled).toBe(false);
    expect(s.blendRatio).toBe(0);
    expect(s.name).toBe("");
    expect(warned(f, "CubismParameters[0].Smooth")).toHaveLength(1);
    expect(warned(f, "CubismParameters[1].Damper")).toHaveLength(1);
    expect(warned(f, "AudioParameters[2].Scale")).toHaveLength(2);
    expect(warned(f, "AudioParameters[3].Enabled")).toHaveLength(1);
    expect(warned(f, "BlendRatio")).toHaveLength(1);
    expect(warned(f, "Dictionary[0].Name")).toHaveLength(1);
  });

  it("reads integer fields from their decimal text", () => {
    expect(basic((j) => (j.Version = 1.9)).version).toBe(1);
    expect(basic((j) => (j.Meta.SettingCount = 1.5)).settings).toHaveLength(1);
    expect(basic((j) => (j.Meta.SettingCount = "1")).settings).toHaveLength(0);
  });

  it("matches targets by ID: a missing target or mapping is 0, with a warning", () => {
    const target = basic((j) => j.Settings[0].Mappings[1].Targets.pop());
    expect(target.settings[0]!.shapes[1]).toEqual([1, 0]);
    expect(warned(target, `"A" has no target for "ParamMouthForm"`)).toHaveLength(1);
    const mapping = basic((j) => j.Settings[0].Mappings.splice(2, 1));
    expect(mapping.settings[0]!.shapes[2]).toEqual([0, 0]);
    expect(warned(mapping, `no shape for element "I"`)).toHaveLength(1);
    // Mappings beyond the number of elements are ignored.
    const extra = basic((j) => {
      j.Settings[0].AudioParameters.pop();
      j.Settings[0].Mappings.unshift(j.Settings[0].Mappings.pop());
    });
    expect(extra.settings[0]!.elements.map((e) => e.id)).toEqual(["Silence", "A", "I", "U", "E"]);
    expect(warned(extra, `no shape for element "E"`)).toHaveLength(1);
  });

  it("keeps an unknown element, with weight 0 later and a warning now", () => {
    const f = basic((j) => {
      j.Settings[0].AudioParameters[5].Id = "Ah";
      j.Settings[0].Mappings[5].Id = "Ah";
    });
    expect(f.settings[0]!.elements[5]).toMatchObject({ id: "Ah", known: false });
    expect(warned(f, `"Ah" is not one of`)).toHaveLength(1);
  });

  it("warns when a dictionary ID differs from its setting's", () => {
    const f = basic((j) => (j.Meta.Dictionary[0].Id = "Other"));
    expect(f.settings[0]!.id).toBe("MS_Basic");
    expect(warned(f, "Meta.Dictionary[0].Id")).toHaveLength(1);
  });

  it("lint mode also warns about keys outside the format", () => {
    const json = edited(motionSyncJson(BASIC), (j) => {
      j.Extra = 1;
      j.Settings[0].PostProcessing.VolumeRatio = 0;
      j.Settings[0].Mappings[0].Targets[0].Weight = 1;
    });
    expect(read(json).warnings).toEqual([]);
    expect(read(json, true).warnings).toEqual([
      "ms: Extra is not part of the format; ignored",
      "ms: Settings[0].Mappings[0].Targets[0].Weight is not part of the format; ignored",
      "ms: Settings[0].PostProcessing.VolumeRatio is not part of the format; ignored",
    ]);
  });
});

describe("links in model settings", () => {
  it("reads FileReferences.MotionSync and each motion entry's MotionSync", () => {
    const s = settingsFromJson({
      Version: 3,
      FileReferences: {
        Moc: "m.moc3",
        Textures: [],
        MotionSync: "m.motionsync3.json",
        Motions: {
          Talk: [
            { File: "a.motion3.json", Sound: "a.wav", MotionSync: "Mouth basic" },
            { File: "a.motion3.json", Sound: "b.wav" },
            { File: "b.motion3.json", MotionSync: 3 },
          ],
        },
      },
    });
    expect(s.motionSync).toBe("m.motionsync3.json");
    expect(s.motions[0]!.entries).toEqual([
      { file: "a.motion3.json", sound: "a.wav", motionSync: "Mouth basic" },
      { file: "a.motion3.json", sound: "b.wav" },
      { file: "b.motion3.json" },
    ]);
  });
});

describe("writeMotionSync", () => {
  it("writes the crafted files back byte for byte, and they read back as the same settings", () => {
    for (const json of [dsBasic(), dsRich(), dsTwo()]) {
      const text = JSON.stringify(json, null, "\t");
      const file = parseMotionSync(text, "ms");
      expect(file.warnings).toEqual([]);
      const out = writeMotionSync(file);
      expect(out).toBe(text);
      const back = parseMotionSync(out, "ms");
      expect(back.settings).toEqual(file.settings);
      expect(back.version).toBe(1);
    }
  });

  it("writes mappings in element order with targets in parameter order, whatever the source order", () => {
    // T8, T9: the source lists mappings and targets in reverse order.
    const reversed = basic((j) => {
      const s = j.Settings[0];
      s.Mappings.reverse();
      for (const m of s.Mappings) m.Targets.reverse();
    });
    const out = JSON.parse(writeMotionSync(reversed));
    expect(out.Settings[0].Mappings.map((m: { Id: string }) => m.Id)).toEqual([...ELEMENTS]);
    expect(out.Settings[0].Mappings[1].Targets.map((t: { Id: string }) => t.Id)).toEqual(
      BASIC.params.map((p) => p.id),
    );
    expect(JSON.stringify(out, null, "\t")).toBe(JSON.stringify(dsBasic(), null, "\t"));
  });

  it("writes data made from scratch, with version 1 and the dictionary from the settings", () => {
    const setting = {
      id: "MS_New",
      name: "New",
      analysisType: "CRI",
      useCase: "Mouth",
      parameters: [{ id: "ParamMouthOpenY", name: "Open", min: 0, max: 1, damper: 0, smooth: 25 }],
      elements: ELEMENTS.map((e) => ({ id: e, name: e, min: 0, max: 1, scale: 1, enabled: true })),
      shapes: ELEMENTS.map((e) => [e === "Silence" ? 0 : 1]),
      blendRatio: 0.5,
      smoothing: 50,
      sampleRate: 60,
    };
    const text = writeMotionSync({ settings: [setting] }, { indent: 2 });
    const json = JSON.parse(text);
    expect(json.Version).toBe(1);
    expect(json.Meta).toEqual({ SettingCount: 1, Dictionary: [{ Id: "MS_New", Name: "New" }] });
    expect(text.split("\n")[1]).toBe('  "Version": 1,');
    const back = parseMotionSync(text, "ms");
    expect(back.warnings).toEqual([]);
    expect(back.settings[0]).toMatchObject({ ...setting, index: 0, usable: true });
  });

  it("refuses what would not read back as written, saying where", () => {
    const file = read(dsTwo());
    const bad = structuredClone(file);
    bad.settings[1]!.shapes[2]![1] = NaN;
    expect(() => writeMotionSync(bad)).toThrow(/settings\[1\]\.shapes\[2\]\[1\] is NaN/);
    const short = structuredClone(file);
    short.settings[0]!.shapes.pop();
    expect(() => writeMotionSync(short)).toThrow(/5 shapes for 6 elements/);
    const narrow = structuredClone(file);
    narrow.settings[0]!.shapes[3]!.pop();
    expect(() => writeMotionSync(narrow)).toThrow(/shapes\[3\] has 1 values for 2 driven/);
    const twice = structuredClone(file);
    twice.settings[0]!.elements[2]!.id = "A";
    expect(() => writeMotionSync(twice)).toThrow(/elements has "A" twice/);
    const rate = structuredClone(file);
    rate.settings[0]!.sampleRate = Infinity;
    expect(() => writeMotionSync(rate)).toThrow(RangeError);
  });

  it("writes values outside the documented ranges as given; the reader then limits them", () => {
    const file = read(dsBasic());
    file.settings[0]!.elements[1]!.scale = 20;
    const back = parseMotionSync(writeMotionSync(file), "ms");
    expect(back.settings[0]!.elements[1]!.scale).toBe(10);
    expect(back.warnings.some((w) => w.includes("Scale"))).toBe(true);
  });
});

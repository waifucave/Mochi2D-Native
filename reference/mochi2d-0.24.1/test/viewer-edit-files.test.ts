/**
 * What the viewer's editing writes: motion entries in the model settings,
 * expression and pose files (with the files' other keys and key order kept),
 * and several files as one zip.
 */
import { describe, expect, it } from "vitest";
import { parseExpression } from "../src/anim/expression.js";
import { parsePose } from "../src/anim/pose.js";
import { settingsFromJson } from "../src/core/settings/model-settings.js";
import { readZipDirectory, zipEntryData, ZIP_FLAG_UTF8 } from "../src/runtime/zip-archive.js";
import {
  addMotionEntry,
  draftExpression,
  draftPose,
  editMotionEntry,
  expressionDraft,
  moveMotionEntry,
  poseDraft,
  poseWarnings,
  removeMotionEntry,
  storedValue,
  switchedValue,
  withFields,
  writeExpressionFile,
  writePoseFile,
  zipFiles,
} from "../src/viewer/edit-files.js";

describe("withFields", () => {
  it("keeps the original's keys and order, and puts new keys after their predecessors", () => {
    const out = withFields({ Type: "T", Custom: 1, Parameters: [] }, [
      ["Type", "T"],
      ["FadeInTime", 0.3],
      ["FadeOutTime", undefined],
      ["Parameters", [1]],
    ]);
    expect(Object.keys(out)).toEqual(["Type", "FadeInTime", "Custom", "Parameters"]);
    expect(out).toEqual({ Type: "T", FadeInTime: 0.3, Custom: 1, Parameters: [1] });
    // Without a predecessor, a new key goes before its successor; removed keys go.
    const b = withFields({ X: 1, Parameters: [], FadeOutTime: 2 }, [
      ["Type", "T"],
      ["FadeOutTime", undefined],
      ["Parameters", []],
    ]);
    expect(Object.keys(b)).toEqual(["X", "Type", "Parameters"]);
    expect(
      Object.keys(
        withFields(null, [
          ["A", 1],
          ["B", undefined],
          ["C", 3],
        ]),
      ),
    ).toEqual(["A", "C"]);
  });
});

describe("motion entries in the model settings", () => {
  const settings = () => ({
    Version: 3,
    FileReferences: {
      Moc: "m.moc3",
      Textures: [],
      Motions: {
        Idle: [
          { File: "a.motion3.json", Sound: "a.wav", Note: "kept" },
          { File: "b.motion3.json" },
        ],
        // An entry without a file doesn't count, as when reading.
        Tap: ["broken", { File: "c.motion3.json", FadeInTime: 0.2 }],
      },
    },
  });

  it("changes an entry's fades, sound and motion-sync setting, keeping its other keys", () => {
    const s = settings();
    editMotionEntry(s, { group: "Idle", index: 0 }, { fadeIn: 0.25, sound: null, motionSync: "A" });
    expect(s.FileReferences.Motions.Idle[0]).toEqual({
      File: "a.motion3.json",
      Note: "kept",
      FadeInTime: 0.25,
      MotionSync: "A",
    });
    editMotionEntry(s, { group: "Tap", index: 0 }, { fadeIn: null, fadeOut: 0.5 });
    expect(s.FileReferences.Motions.Tap[1]).toEqual({ File: "c.motion3.json", FadeOutTime: 0.5 });
    expect(() => editMotionEntry(s, { group: "Tap", index: 1 }, {})).toThrow(RangeError);
    const read = settingsFromJson(s);
    expect(read.motions.find((g) => g.group === "Idle")!.entries[0]).toEqual({
      file: "a.motion3.json",
      fadeInTime: 0.25,
      motionSync: "A",
    });
  });

  it("moves entries between groups, adds and removes them", () => {
    const s = settings();
    expect(moveMotionEntry(s, { group: "Tap", index: 0 }, "Idle")).toEqual({
      group: "Idle",
      index: 2,
    });
    // Tap had only the broken entry left: the group goes.
    expect(Object.keys(s.FileReferences.Motions)).toEqual(["Idle"]);
    expect(s.FileReferences.Motions.Idle[2]).toEqual({ File: "c.motion3.json", FadeInTime: 0.2 });
    expect(moveMotionEntry(s, { group: "Idle", index: 1 }, "Wave")).toEqual({
      group: "Wave",
      index: 0,
    });
    expect(addMotionEntry(s, "d.motion3.json", "Wave")).toEqual({ group: "Wave", index: 1 });
    removeMotionEntry(s, { group: "Wave", index: 0 });
    expect(s.FileReferences.Motions).toEqual({
      Idle: [
        { File: "a.motion3.json", Sound: "a.wav", Note: "kept" },
        { File: "c.motion3.json", FadeInTime: 0.2 },
      ],
      Wave: [{ File: "d.motion3.json" }],
    });
    const bare: Record<string, unknown> = { FileReferences: { Moc: "m.moc3" } };
    expect(addMotionEntry(bare, "x.motion3.json", "Idle")).toEqual({ group: "Idle", index: 0 });
    expect(bare).toEqual({
      FileReferences: { Moc: "m.moc3", Motions: { Idle: [{ File: "x.motion3.json" }] } },
    });
  });
});

describe("expression files", () => {
  const defaults: Record<string, number> = { EyeL: 1, Mouth: 0, Brow: -0.5 };
  const defaultOf = (id: string) => defaults[id] ?? 0;
  // As DeepSeek-chan's files are laid out, with an extra key.
  const file = {
    Type: "Live2D Expression",
    IsModelCustomizationExpression: false,
    Parameters: [
      { Id: "EyeL", Value: -0.25, Blend: "Add" },
      { Id: "Mouth", Value: 0.5, Blend: "Multiply" },
      { Id: "Brow", Value: 0.3, Blend: "Overwrite" },
      { Id: "EyeL", Value: 9, Blend: "Add" },
      { Id: "Odd", Value: 1, Blend: "Screen" },
    ],
  };

  it("shows Add values as the parameter's value, Multiply as the factor, Overwrite as is", () => {
    const d = expressionDraft(file, defaultOf);
    expect(d).toEqual({
      fadeIn: null,
      fadeOut: null,
      rows: [
        { id: "EyeL", blend: "Add", value: 0.75 },
        { id: "Mouth", blend: "Multiply", value: 0.5 },
        { id: "Brow", blend: "Overwrite", value: 0.3 },
        { id: "Odd", blend: "Add", value: 1 },
      ],
    });
    expect(storedValue({ id: "Brow", blend: "Add", value: -0.2 }, defaultOf)).toBe(0.3);
    expect(switchedValue("Mouth", "Multiply", defaultOf)).toBe(1);
    expect(switchedValue("Brow", "Add", defaultOf)).toBe(-0.5);
  });

  it("writes an edited file with its other keys and order, and new fades after Type", () => {
    const d = expressionDraft(file, defaultOf);
    d.fadeIn = 0.4;
    d.rows = d.rows.filter((r) => r.id !== "Odd"); // unchecked: left out
    d.rows[0]!.value = 0.5; // EyeL: 0.5 − 1
    const text = writeExpressionFile(d, defaultOf, file);
    expect(text.split("\n")[1]).toBe('\t"Type": "Live2D Expression",');
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      "Type",
      "FadeInTime",
      "IsModelCustomizationExpression",
      "Parameters",
    ]);
    expect(json.Parameters).toEqual([
      { Id: "EyeL", Value: -0.5, Blend: "Add" },
      { Id: "Mouth", Value: 0.5, Blend: "Multiply" },
      { Id: "Brow", Value: 0.3, Blend: "Overwrite" },
    ]);
    // Read back, the file plays what the editor showed.
    const exp = parseExpression(text);
    expect(exp.fadeIn).toBe(0.4);
    expect(exp.parameters).toEqual(draftExpression(d, defaultOf, "x", 0.5).parameters);
    expect(expressionDraft(JSON.parse(text), defaultOf).rows).toEqual(d.rows);
  });

  it("writes a new file as Type, fades when set, then Parameters", () => {
    const text = writeExpressionFile(
      { fadeIn: null, fadeOut: 0.2, rows: [{ id: "Mouth", blend: "Add", value: 0.1 }] },
      defaultOf,
    );
    expect(JSON.parse(text)).toEqual({
      Type: "Live2D Expression",
      FadeOutTime: 0.2,
      Parameters: [{ Id: "Mouth", Value: 0.1, Blend: "Add" }],
    });
    expect(Object.keys(JSON.parse(text))).toEqual(["Type", "FadeOutTime", "Parameters"]);
    const exp = draftExpression({ fadeIn: null, fadeOut: null, rows: [] }, defaultOf, "e", 0.5);
    expect([exp.fadeIn, exp.fadeOut]).toEqual([0.5, 0.5]);
  });
});

describe("pose files", () => {
  const parts = ["ArmA", "ArmB", "SleeveA", "SleeveB", "Hat"];
  const file = {
    Type: "Live2D Pose",
    FadeInTime: 0.3,
    Note: "kept",
    Groups: [
      [
        { Id: "ArmA", Link: ["SleeveA"] },
        { Id: "ArmB", Link: ["SleeveB"] },
      ],
    ],
  };

  it("numbers the groups from 1 and turns links into parents", () => {
    const d = poseDraft(file, parts);
    expect(d.fade).toBe(0.3);
    expect(d.rows).toEqual([
      { id: "ArmA", group: 1, parent: null },
      { id: "ArmB", group: 1, parent: null },
      { id: "SleeveA", group: null, parent: "ArmA" },
      { id: "SleeveB", group: null, parent: "ArmB" },
      { id: "Hat", group: null, parent: null },
    ]);
    expect(poseDraft(null, parts).rows.every((r) => r.group === null)).toBe(true);
  });

  it("writes groups by ascending number with Link always present, and reads back the same", () => {
    const d = poseDraft(file, parts);
    d.rows[4]!.group = 5; // Hat in a later group
    d.rows[0]!.group = 7; // ArmA after it
    const text = writePoseFile(d, file);
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(["Type", "FadeInTime", "Note", "Groups"]);
    expect(json.Groups).toEqual([
      [{ Id: "ArmB", Link: ["SleeveB"] }],
      [{ Id: "Hat", Link: [] }],
      [{ Id: "ArmA", Link: ["SleeveA"] }],
    ]);
    const read = parsePose(text);
    expect(read.groups).toEqual(draftPose(d, "p").groups);
    expect(read.fade).toBe(0.3);
    d.fade = null;
    expect(Object.keys(JSON.parse(writePoseFile(d)))).toEqual(["Type", "Groups"]);
    expect(draftPose(d, "p").fade).toBe(0.5);
  });

  it("warns about links the groups override and links without effect", () => {
    const d = poseDraft(file, parts);
    d.rows[2]!.group = 2; // SleeveA is also in a group
    d.rows[4]!.parent = "SleeveB"; // SleeveB is in no group
    expect(poseWarnings(d)).toEqual([
      "SleeveA is in group 2 and follows ArmA: links apply after the groups, so the link wins.",
      "Hat follows SleeveB, which is in no group: the link has no effect.",
    ]);
  });
});

describe("zipFiles", () => {
  it("writes the files at their paths, with UTF-8 names", () => {
    const zip = zipFiles([
      { path: "大肥鱼.model3.json", data: "{}" },
      { path: "Exp3/smile.exp3.json", data: new Uint8Array([1, 2, 3]) },
    ]);
    const recs = readZipDirectory(zip);
    const names = recs.map((r) => new TextDecoder().decode(r.rawName));
    expect(names).toEqual(["大肥鱼.model3.json", "Exp3/smile.exp3.json"]);
    expect(recs[0]!.flags & ZIP_FLAG_UTF8).toBe(ZIP_FLAG_UTF8);
    expect(new TextDecoder().decode(zipEntryData(zip, recs[0]!, names[0]!))).toBe("{}");
    expect(Array.from(zipEntryData(zip, recs[1]!, names[1]!))).toEqual([1, 2, 3]);
  });
});

describe("shortestFloat32", () => {
  it("gives the decimal a float32 was typed as", async () => {
    const { shortestFloat32 } = await import("../src/viewer/editing.js");
    expect(shortestFloat32(Math.fround(-0.2))).toBe(-0.2);
    expect(shortestFloat32(Math.fround(0.1234567))).toBe(0.1234567);
    expect(shortestFloat32(30)).toBe(30);
    expect(shortestFloat32(Math.fround(1 / 3))).toBe(0.33333334);
    expect(shortestFloat32(NaN)).toBeNaN();
  });
});

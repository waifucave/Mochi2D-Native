/**
 * The viewer's model-settings export: the settings as loaded, unknown keys
 * included, plus the expression files of the model's folder that they don't
 * list, as JSON indented with tabs.
 */
import { describe, expect, it } from "vitest";
import { exportModelSettings, expressionName } from "../src/viewer/export.js";

const raw = {
  Version: 3,
  FileReferences: {
    Moc: "m.moc3",
    Textures: ["m.2048/texture_00.png"],
    Expressions: [{ Name: "smile", File: "exp/smile.exp3.json" }],
    Custom: { Kept: true },
  },
  Extra: [1, 2],
};

describe("exportModelSettings", () => {
  it("keeps every key and adds the folder's unlisted expressions", () => {
    const out = exportModelSettings({
      settingsPath: "Model/m.model3.json",
      raw,
      files: [
        "Model/m.model3.json",
        "Model/m.moc3",
        "Model/exp/smile.exp3.json",
        "Model/exp/Angry Face.exp3.json",
        "Model/top.EXP3.JSON",
        "Model/idle.motion3.json",
        "Other/elsewhere.exp3.json",
      ],
    });
    expect(out.name).toBe("m.model3.json");
    expect(out.added).toBe(2);
    const json = JSON.parse(out.text) as typeof raw;
    expect(json.Extra).toEqual([1, 2]);
    expect(json.FileReferences.Custom).toEqual({ Kept: true });
    expect(json.FileReferences.Expressions).toEqual([
      { Name: "smile", File: "exp/smile.exp3.json" },
      { Name: "Angry Face", File: "exp/Angry Face.exp3.json" },
      { Name: "top", File: "top.EXP3.JSON" },
    ]);
    expect(out.text.split("\n").slice(0, 3)).toEqual([
      "{",
      '\t"Version": 3,',
      '\t"FileReferences": {',
    ]);
    // The loaded settings are not changed.
    expect(raw.FileReferences.Expressions).toHaveLength(1);
  });

  it("adds no Expressions key when there are none, and handles settings at the root", () => {
    const bare = { Version: 3, FileReferences: { Moc: "m.moc3", Textures: [] } };
    const none = exportModelSettings({
      settingsPath: "m.model3.json",
      raw: bare,
      files: ["m.moc3"],
    });
    expect(none.added).toBe(0);
    expect(JSON.parse(none.text)).toEqual(bare);
    const root = exportModelSettings({
      settingsPath: "m.model3.json",
      raw: bare,
      files: ["m.moc3", "a.exp3.json"],
    });
    expect(JSON.parse(root.text).FileReferences.Expressions).toEqual([
      { Name: "a", File: "a.exp3.json" },
    ]);
  });

  it("names an expression after its file", () => {
    expect(expressionName("exp/Happy.exp3.json")).toBe("Happy");
    expect(expressionName("Sad.EXP3.json")).toBe("Sad");
  });
});

/**
 * A model package from an in-memory file map (path → bytes or text), with
 * non-ASCII paths: Japanese folder and file names, spaces, a literal percent
 * sign, an emoji, and a name whose settings reference is precomposed (NFC)
 * while the map key is decomposed (NFD, as macOS gives file names). Nothing
 * touches the disk. On a synthetic model.
 */
import { describe, expect, it } from "vitest";
import { MemoryFileSource, FileNotFoundError } from "../src/core/io/file-source.js";
import { encodeUtf8, decodeUtf8 } from "../src/core/binary/utf8.js";
import { ModelRuntime } from "../src/runtime/model-runtime.js";
import { motionJson } from "./support/anim.js";
import { Synth } from "./support/synth.js";

const GA_NFC = "が"; // が
const GA_NFD = "が"; // か + combining voiced mark

function exportedFiles(): Record<string, Uint8Array | string> {
  const s = new Synth(4);
  s.part({ id: "P" });
  s.param("A", -10, 10, 0);
  s.param("B", -10, 10, 0);
  s.mesh({ id: "M", keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
  const dir = "モデル/キャラ 1/";
  return {
    [`${dir}キャラ.model3.json`]: JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: "キャラ.moc3",
        Textures: [],
        Motions: { 待機: [{ File: "モーション/待機 %41.motion3.json" }] },
        Expressions: [
          { Name: "笑顔", File: "表情/笑顔😀.exp3.json" },
          { Name: "驚き", File: `表情/${GA_NFC}.exp3.json` },
        ],
      },
    }),
    [`${dir}キャラ.moc3`]: s.build(),
    [`${dir}モーション/待機 %41.motion3.json`]: motionJson({
      duration: 0.5,
      fps: 30,
      fadeIn: 0,
      fadeOut: 0,
      curves: [{ id: "A", first: [0, 4], segments: [["linear", 0.5, 4]] }],
    }),
    [`${dir}表情/笑顔😀.exp3.json`]: JSON.stringify({
      FadeInTime: 0,
      FadeOutTime: 0,
      Parameters: [{ Id: "B", Value: 2, Blend: "Add" }],
    }),
    [`${dir}表情/${GA_NFD}.exp3.json`]: JSON.stringify({
      FadeInTime: 0,
      FadeOutTime: 0,
      Parameters: [{ Id: "B", Value: 3, Blend: "Add" }],
    }),
  };
}

describe("a model package from an in-memory file map", () => {
  it("loads with non-ASCII paths, and plays its motions and expressions", async () => {
    const files = exportedFiles();
    const source = MemoryFileSource.fromFiles(files, "export");
    const rt = await ModelRuntime.load(source); // the shallowest *.model3.json
    expect(rt.settingsPath).toBe("モデル/キャラ 1/キャラ.model3.json");
    expect(rt.files).toContain("モーション/待機 %41.motion3.json");
    expect(rt.motionGroups).toEqual([{ name: "待機", count: 1 }]);
    expect(await rt.startMotion("待機", 0)).not.toBe(false);
    await rt.setExpression("笑顔");
    for (let i = 0; i < 10; i++) rt.update(1 / 60);
    expect(rt.getParameter("A")).toBe(4);
    expect(rt.getParameter("B")).toBe(2);
    // The NFC reference finds the NFD file.
    expect(await rt.addExpression("驚き")).toBe(true);
    rt.update(1 / 60);
    expect(rt.getParameter("B")).toBe(5);
  });

  it("takes a Map, bytes, ArrayBuffers and text, and stores text as UTF-8", async () => {
    const text = '{"名前": "🐟 fish"}';
    const src = MemoryFileSource.fromFiles(
      new Map<string, Uint8Array | ArrayBuffer | string>([
        ["a/b.json", text],
        ["c.bin", new Uint8Array([1, 2, 3])],
        ["d.bin", new Uint8Array([4, 5]).buffer],
      ]),
    );
    expect(src.list()).toEqual(["a/b.json", "c.bin", "d.bin"]);
    expect(await src.read("a/b.json")).toEqual(new TextEncoder().encode(text));
    expect(decodeUtf8(await src.read("./a/../a/b.json"))).toBe(text);
    expect([...(await src.read("d.bin"))]).toEqual([4, 5]);
    await expect(src.read("missing.json")).rejects.toThrow(FileNotFoundError);
  });

  it("encodes UTF-8 like TextEncoder, lone surrogates included", () => {
    for (const s of ["", "abc", "é", "大肥鱼", "😀🐟", GA_NFD, "a\ud800b", "\udc00", "x\ud83d"])
      expect(encodeUtf8(s)).toEqual(new TextEncoder().encode(s));
  });
});

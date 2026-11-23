import { describe, expect, it } from "vitest";
import {
  FileNotFoundError,
  MemoryFileSource,
  OverlayFileSource,
  SubdirFileSource,
  joinPath,
  normalizePath,
  readText,
} from "../src/core/io/file-source.js";
import { classifyModelFile } from "../src/core/io/model-files.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("paths", () => {
  it("normalizes", () => {
    expect(normalizePath("a\\b/./c/../d")).toBe("a/b/d");
    expect(joinPath("Model/sub", "../tex.png")).toBe("Model/tex.png");
    expect(() => normalizePath("../x")).toThrow(/escapes/);
  });
});

describe("file sources", () => {
  it("memory, subdir and overlay sources", async () => {
    const mem = new MemoryFileSource("mem", [
      ["M/a.model3.json", enc("﻿{}")],
      ["M/m/x.motion3.json", enc("1")],
    ]);
    const sub = new SubdirFileSource(mem, "M");
    expect(sub.list()).toEqual(["a.model3.json", "m/x.motion3.json"]);
    expect(await readText(sub, "a.model3.json")).toBe("{}");
    await expect(sub.read("nope")).rejects.toBeInstanceOf(FileNotFoundError);
    const extra = new MemoryFileSource("extra", [["e.exp3.json", enc("2")]]);
    const ov = new OverlayFileSource("ov", [sub, extra]);
    expect(ov.list()).toEqual(["a.model3.json", "e.exp3.json", "m/x.motion3.json"]);
    expect(await readText(ov, "e.exp3.json")).toBe("2");
    await expect(ov.read("zzz")).rejects.toBeInstanceOf(FileNotFoundError);
  });
  it("classifies by suffix", () => {
    expect(classifyModelFile("X/大肥鱼.model3.json")).toBe("settings");
    expect(classifyModelFile("a.MOC3")).toBe("moc");
    expect(classifyModelFile("Exp3/脸红.exp3.json")).toBe("expression");
    expect(classifyModelFile("a.vtube.json")).toBe("other");
  });
});

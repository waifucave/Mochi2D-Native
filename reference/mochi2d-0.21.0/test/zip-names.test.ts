/**
 * Zip archives whose names are not flagged as UTF-8: the Unicode Path extra field, the UTF-8 flag, and one encoding
 * for the rest of the archive, chosen so that the settings file's references
 * resolve. All archives are synthetic, built here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import {
  archiveKind,
  rejectUnsupportedArchive,
  sourceFromZip,
  UnsupportedArchiveError,
  ZipFormatError,
} from "../src/runtime/zip-source.js";
import { crc32, readZipDirectory } from "../src/runtime/zip-archive.js";
import {
  decodeCp437,
  decodeUtf8Strict,
  decodeZipNames,
  legacyCharShape,
} from "../src/runtime/zip-names.js";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { resolveSettingsPath } from "../src/runtime/bundle.js";
import { ModelRuntime } from "../src/runtime/model-runtime.js";
import { openModelInput } from "../src/lib/sources.js";
import { loadModelFromDisk } from "../src/lib/node.js";
import { buildZip, unicodePathField, type TestZipEntry } from "./support/zip-writer.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const hex = (s: string) => Uint8Array.from(s.split(" ").map((h) => parseInt(h, 16)));
const ascii = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const text = async (src: { read(p: string): Promise<Uint8Array> }, p: string) =>
  new TextDecoder().decode(await src.read(p));

/** A settings file referring to the given files (UTF-8 JSON, as always). */
const settingsJson = (moc: string, textures: string[] = [], expressions: string[] = []) =>
  JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: moc,
      Textures: textures,
      Expressions: expressions.map((f, i) => ({ Name: `e${i}`, File: f })),
    },
  });

// Legacy encodings of the test names.
const GBK_CE = hex("b2 e2"); // 测 (not valid UTF-8)
const GBK_BIAOQING = hex("b1 ed c7 e9"); // 表情
const SJIS_NIHON = hex("93 fa 96 7b"); // 日本 (also decodes as GB18030: 擔杮)
const CP949_PYOJEONG = hex("c7 a5 c1 a4"); // 표정
const CP949_NUNMUL = hex("b4 ab b9 b0"); // 눈물
const CP949_TTOM = hex("8c 63"); // 똠, outside EUC-KR proper (a CP949 extension)

describe("zip names", () => {
  it("CRC-32 has the standard check value", () => {
    expect(crc32(ascii("123456789"))).toBe(0xcbf43926);
  });

  it("decodes GBK names without the UTF-8 flag (a Chinese archive)", async () => {
    const slash = ascii("/");
    const dir = cat(GBK_CE, slash);
    const zip = buildZip([
      {
        name: cat(dir, GBK_CE, ascii(".model3.json")),
        data: settingsJson("测.moc3", ["测.4096/texture_00.png"], ["EXP3/表情.exp3.json"]),
      },
      { name: cat(dir, GBK_CE, ascii(".moc3")), data: "moc", deflate: true },
      { name: cat(dir, GBK_CE, ascii(".4096/texture_00.png")), data: "png" },
      { name: cat(dir, ascii("EXP3/"), GBK_BIAOQING, ascii(".exp3.json")), data: "{}" },
    ]);
    const src = sourceFromZip("测试.zip", zip);
    expect(src.nameEncoding).toBe("gb18030");
    expect(src.list()).toEqual([
      "测/EXP3/表情.exp3.json",
      "测/测.4096/texture_00.png",
      "测/测.moc3",
      "测/测.model3.json",
    ]);
    expect(await text(src, "测/测.moc3")).toBe("moc");
    expect(resolveSettingsPath(src)).toBe("测/测.model3.json");
  });

  it("uses the Unicode Path field (0x7075) for CP949 names (a Korean archive)", async () => {
    const raw = cat(CP949_NUNMUL, ascii(".exp3.json"));
    const zip = buildZip([
      { name: "hangul.model3.json", data: settingsJson("hangul.moc3", [], ["눈물.exp3.json"]) },
      { name: "hangul.moc3", data: "moc" },
      { name: raw, data: "{}", extra: unicodePathField(raw, "눈물.exp3.json") },
    ]);
    const src = sourceFromZip("hangul.zip", zip);
    expect(src.list()).toContain("눈물.exp3.json");
    expect(await text(src, "눈물.exp3.json")).toBe("{}");
    const decoded = decodeZipNames(readZipDirectory(zip));
    expect(decoded.sources).toEqual(["archive-encoding", "archive-encoding", "unicode-path"]);
  });

  it("uses a Unicode Path field found only in the local header", async () => {
    const raw = cat(GBK_CE, ascii(".moc3"));
    const zip = buildZip([
      { name: raw, data: "moc", localExtra: unicodePathField(raw, "测.moc3") },
    ]);
    expect(sourceFromZip("a.zip", zip).list()).toEqual(["测.moc3"]);
  });

  it("ignores a Unicode Path field whose CRC does not match the stored name", () => {
    const raw = cat(GBK_CE, ascii(".moc3"));
    const zip = buildZip([
      { name: raw, data: "moc", extra: unicodePathField(raw, "wrong.moc3", crc32(raw) ^ 1) },
    ]);
    const src = sourceFromZip("a.zip", zip);
    expect(src.list()).toEqual(["测.moc3"]); // decoded as GBK instead
    expect(src.nameEncoding).toBe("gb18030");
  });

  it("decodes CP949 names without 0x7075 as EUC-KR when the settings references resolve", async () => {
    const zip = buildZip([
      { name: "m.model3.json", data: settingsJson("m.moc3", [], ["표정/눈물.exp3.json"]) },
      { name: "m.moc3", data: "moc" },
      { name: cat(CP949_PYOJEONG, ascii("/"), CP949_NUNMUL, ascii(".exp3.json")), data: "{}" },
    ]);
    const src = sourceFromZip("k.zip", zip);
    // GB18030, Shift_JIS and Big5 decode these bytes too, but only EUC-KR makes
    // the references resolve.
    expect(src.nameEncoding).toBe("euc-kr");
    expect(src.list()).toEqual(["m.moc3", "m.model3.json", "표정/눈물.exp3.json"]);
  });

  it("decodes CP949 extension syllables where the host can, and never drops bytes", () => {
    const zip = buildZip([
      { name: "m.model3.json", data: settingsJson("m.moc3", [], ["똠.exp3.json"]) },
      { name: "m.moc3", data: "moc" },
      { name: cat(CP949_TTOM, ascii(".exp3.json")), data: "{}" },
    ]);
    const src = sourceFromZip("k.zip", zip);
    let hostHasCp949 = false;
    try {
      hostHasCp949 = new TextDecoder("euc-kr", { fatal: true }).decode(CP949_TTOM) === "똠";
    } catch {
      // the host's EUC-KR lacks the CP949 extensions (Node)
    }
    if (hostHasCp949) expect(src.list()).toContain("똠.exp3.json");
    // Node's decoder drops the lead byte 0x8C and keeps "c": the shape check
    // refuses that, so another encoding is chosen.
    else expect(src.list()).not.toContain("c.exp3.json");
    expect(src.list()).toHaveLength(3);
  });

  it("prefers Shift_JIS over GB18030 when only it resolves the references", () => {
    const entries: TestZipEntry[] = [
      { name: cat(SJIS_NIHON, ascii(".model3.json")), data: settingsJson("日本.moc3") },
      { name: cat(SJIS_NIHON, ascii(".moc3")), data: "moc" },
    ];
    const src = sourceFromZip("j.zip", buildZip(entries));
    expect(src.nameEncoding).toBe("shift_jis");
    expect(src.list()).toEqual(["日本.moc3", "日本.model3.json"]);
    // Without a settings file to check, the first encoding that decodes every name wins.
    const bare = sourceFromZip("j2.zip", buildZip([entries[1]!]));
    expect(bare.nameEncoding).toBe("gb18030");
    expect(bare.list()).toEqual(["擔杮.moc3"]);
  });

  it("reads UTF-8 names without the flag as UTF-8", async () => {
    const zip = buildZip([
      { name: "测试/测试.model3.json", data: settingsJson("测试.moc3") },
      { name: "测试/测试.moc3", data: "moc" },
    ]);
    const src = sourceFromZip("u.zip", zip);
    expect(src.nameEncoding).toBe("utf-8");
    expect(await text(src, "测试/测试.moc3")).toBe("moc");
  });

  it("honours the UTF-8 flag", () => {
    const zip = buildZip([{ name: "눈물.exp3.json", data: "{}", flags: 0x800 }]);
    expect(decodeZipNames(readZipDirectory(zip)).sources).toEqual(["utf-8-flag"]);
  });

  it("falls back to code page 437 when no encoding decodes every name", () => {
    expect(decodeCp437(Uint8Array.from([0x80, 0x9b, 0xb0, 0xe1, 0xff]))).toBe("Ç¢░ß ");
    const src = sourceFromZip("x.zip", buildZip([{ name: hex("41 ff 2e 74 78 74"), data: "" }]));
    expect(src.nameEncoding).toBe("cp437");
    expect(src.list()).toEqual(["A .txt"]);
  });

  it("checks the byte structure of legacy names (hosts may drop bytes silently)", () => {
    expect(legacyCharShape(hex("41 b4 bb"), "gb18030")).toEqual([0x41, -1]);
    expect(legacyCharShape(hex("81 30 81 30"), "gb18030")).toEqual([-1]);
    expect(legacyCharShape(hex("ff"), "gb18030")).toBeUndefined();
    expect(legacyCharShape(hex("b4 bb"), "shift_jis")).toEqual([-1, -1]); // half-width katakana
    expect(legacyCharShape(hex("80"), "euc-kr")).toBeUndefined();
    expect(legacyCharShape(hex("ff"), "big5")).toBeUndefined();
    expect(legacyCharShape(hex("a4"), "big5")).toBeUndefined(); // a lead byte without its trail
  });

  it("strict UTF-8 rejects malformed, overlong and surrogate sequences", () => {
    expect(decodeUtf8Strict(ascii("测"))).toBe("测");
    expect(decodeUtf8Strict(hex("b4 bb"))).toBeUndefined();
    expect(decodeUtf8Strict(hex("c0 af"))).toBeUndefined();
    expect(decodeUtf8Strict(hex("ed a0 80"))).toBeUndefined();
    expect(decodeUtf8Strict(hex("e6 a4"))).toBeUndefined();
  });

  it("matches composed and decomposed names, and skips folders and __MACOSX", async () => {
    const zip = buildZip([
      { name: "모델/", data: "", flags: 0x800 },
      { name: "모델/가.moc3".normalize("NFD"), data: "moc", flags: 0x800 },
      { name: "__MACOSX/모델/._가.moc3", data: "x", flags: 0x800 },
    ]);
    const src = sourceFromZip("n.zip", zip);
    expect(src.list()).toEqual(["모델/가.moc3"]);
    expect(await text(src, "모델/가.moc3")).toBe("moc");
  });

  it("reads ZIP64 records and archives with data in front", async () => {
    const entries: TestZipEntry[] = [
      { name: "a.txt", data: "alpha", deflate: true },
      { name: "b.txt", data: "beta" },
    ];
    const z64 = sourceFromZip("z64.zip", buildZip(entries, { zip64: true }));
    expect(await text(z64, "a.txt")).toBe("alpha");
    expect(await text(z64, "b.txt")).toBe("beta");
    const stub = cat(ascii("#!/bin/sh\nexit 0\n".repeat(4)), buildZip(entries));
    expect(await text(sourceFromZip("sfx.zip", stub), "b.txt")).toBe("beta");
  });

  it("still reads archives written with the UTF-8 flag by fflate", async () => {
    const zip = zipSync({ "大肥鱼/a.txt": ascii("x") }, { level: 6 });
    expect(await text(sourceFromZip("f.zip", zip), "大肥鱼/a.txt")).toBe("x");
  });

  it("rejects data that is not a zip archive", () => {
    expect(() => sourceFromZip("x.zip", ascii("hello, this is not an archive"))).toThrow(
      ZipFormatError,
    );
  });
});

describe("RAR and 7z archives", () => {
  const rar = cat(hex("52 61 72 21 1a 07 01 00"), new Uint8Array(32));
  const sevenZip = cat(hex("37 7a bc af 27 1c 00 04"), new Uint8Array(32));

  it("are recognized by signature or by name", () => {
    expect(archiveKind("model.rar")).toBe("rar");
    expect(archiveKind("model.7z")).toBe("7z");
    expect(archiveKind("model.bin", rar)).toBe("rar");
    expect(archiveKind("model.zip", sevenZip)).toBe("7z");
    expect(archiveKind("model.zip", buildZip([]))).toBe("zip");
    expect(archiveKind("model.model3.json")).toBeUndefined();
  });

  it("give a clear error wherever an archive is opened", async () => {
    const message = /only zip archives and folders: extract the archive first/;
    expect(() => sourceFromZip("model.rar", rar)).toThrow(UnsupportedArchiveError);
    expect(() => sourceFromZip("renamed.zip", sevenZip)).toThrow(message);
    expect(() => rejectUnsupportedArchive("x.7z")).toThrow(/"x\.7z" is a 7z archive/);
    await expect(openModelInput(new File([rar], "model.rar"))).rejects.toThrow(message);
    await expect(openModelInput([new File([rar], "model.rar")])).rejects.toThrow(message);
    await expect(loadModelFromDisk("assets/models/model.rar")).rejects.toThrow(
      UnsupportedArchiveError,
    );
  });

  it("are named when a folder holds only an archive", () => {
    const folder = new MemoryFileSource("model", [["model.rar", rar]]);
    expect(() => resolveSettingsPath(folder)).toThrow(
      /"model\.rar" is a RAR archive: extract it first/,
    );
    const zipped = new MemoryFileSource("m", [["model.zip", buildZip([])]]);
    expect(() => resolveSettingsPath(zipped)).toThrow(/open the zip archive "model\.zip" itself/);
  });
});

describe.skipIf(!HAVE_DEEPSEEK)("a model in a GBK-named zip loads", () => {
  it("DeepSeek-chan with its folder and files stored under GBK names", async () => {
    const deepseek = DEEPSEEK;
    const gbkDir = cat(GBK_CE, ascii("/")); // a folder named 测
    const entries: TestZipEntry[] = [];
    for (const f of [
      "大肥鱼.model3.json",
      "大肥鱼.moc3",
      "大肥鱼.physics3.json",
      "大肥鱼.cdi3.json",
    ]) {
      // 大肥鱼 in GBK: B4 F3 B7 CA D3 E3
      const name = cat(gbkDir, hex("b4 f3 b7 ca d3 e3"), ascii(f.slice(3)));
      entries.push({ name, data: new Uint8Array(readFileSync(join(deepseek, f))), deflate: true });
    }
    const rt = await ModelRuntime.load(sourceFromZip("gbk.zip", buildZip(entries)));
    expect(rt.settingsPath).toBe("测/大肥鱼.model3.json");
    rt.update(1 / 60);
  });
});

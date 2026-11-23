/**
 * The file boundary of the agent interface (tools/lib/agent/paths.ts), the
 * text values the CLI takes (tools/lib/agent/values.ts) and the parts of
 * the shared session that need no model.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AllowedRoots,
  GuardedFolderSource,
  PathNotAllowedError,
  findModels,
  openModelLocation,
  readAllowedFile,
} from "../tools/lib/agent/paths.js";
import { AgentSession, seededRandom } from "../tools/lib/agent/session.js";
import {
  parseAssignments,
  parseBackground,
  parseMotion,
  parsePoint,
  parseSize,
  parseView,
} from "../tools/lib/agent/values.js";

const repo = resolve(__dirname, "..");
let tmp: string;
let inside: string;
let outside: string;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "mochi2d-paths-")));
  inside = join(tmp, "allowed");
  outside = join(tmp, "outside");
  mkdirSync(join(inside, "model", "sub"), { recursive: true });
  mkdirSync(join(tmp, "allowed-twin"));
  mkdirSync(outside);
  writeFileSync(join(inside, "model", "a.txt"), "a");
  writeFileSync(join(inside, "model", "sub", "b.txt"), "b");
  writeFileSync(join(inside, "model", ".hidden"), "h");
  writeFileSync(join(inside, "junk.moc3"), "not a moc3 file");
  writeFileSync(join(inside, "model.rar"), "Rar!");
  writeFileSync(join(tmp, "allowed-twin", "secret.txt"), "s");
  writeFileSync(join(outside, "secret.txt"), "s");
  // Links: one to a file outside, one to a folder outside, one inside, one cycle.
  symlinkSync(join(outside, "secret.txt"), join(inside, "model", "leak.txt"));
  symlinkSync(outside, join(inside, "model", "leak-dir"));
  symlinkSync(join(inside, "model", "a.txt"), join(inside, "model", "alias.txt"));
  symlinkSync(join(inside, "model"), join(inside, "model", "sub", "loop"));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("allowed roots", () => {
  it("must exist", async () => {
    await expect(AllowedRoots.create([join(tmp, "missing")])).rejects.toThrow(/does not exist/);
  });

  it("resolve paths inside and refuse paths outside, after following links", async () => {
    const roots = await AllowedRoots.create([inside]);
    expect(await roots.resolve("model/a.txt")).toBe(join(inside, "model", "a.txt"));
    expect(await roots.resolve(join(inside, "model"))).toBe(join(inside, "model"));
    // A link inside that stays inside is fine.
    expect(await roots.resolve("model/alias.txt")).toBe(join(inside, "model", "a.txt"));
    for (const p of [
      join(outside, "secret.txt"),
      "../outside/secret.txt",
      "model/../../outside/secret.txt",
      // A folder whose name starts like the root's is not inside it.
      join(tmp, "allowed-twin", "secret.txt"),
      "model/leak.txt",
      "model/leak-dir/secret.txt",
      "/etc/passwd",
      // Missing paths outside are refused, not reported missing.
      join(outside, "nothing"),
    ])
      await expect(roots.resolve(p), p).rejects.toBeInstanceOf(PathNotAllowedError);
    await expect(roots.resolve("model/nothing")).rejects.toThrow(/does not exist/);
    await expect(roots.resolve("")).rejects.toThrow(/path is required/);
    const none = await AllowedRoots.create([]);
    await expect(none.resolve(join(inside, "junk.moc3"))).rejects.toThrow(
      /no folders are allowed\. Start mochi2d-mcp with --root/,
    );
    // The client's roots: missing folders are left out.
    const some = await AllowedRoots.create([join(tmp, "missing"), inside], tmp, {
      missing: "skip",
    });
    expect(some.real).toEqual([inside]);
  });

  it("can be single files", async () => {
    const roots = await AllowedRoots.create([join(inside, "junk.moc3")]);
    expect(await roots.resolve(join(inside, "junk.moc3"))).toBe(join(inside, "junk.moc3"));
    await expect(roots.resolve(join(inside, "model", "a.txt"))).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });
});

describe("guarded folder sources", () => {
  it("list and read only files inside the roots", async () => {
    const roots = await AllowedRoots.create([inside]);
    const src = await GuardedFolderSource.open(join(inside, "model"), roots);
    // Dotfiles and links that leave the roots are left out; the cycle is walked once.
    expect(src.list()).toEqual(["a.txt", "alias.txt", "sub/b.txt"]);
    expect(new TextDecoder().decode(await src.read("sub/b.txt"))).toBe("b");
    expect(new TextDecoder().decode(await src.read("alias.txt"))).toBe("a");
    for (const p of ["leak.txt", "leak-dir/secret.txt", "../junk.moc3", "sub/../../junk.moc3"])
      await expect(src.read(p), p).rejects.toThrow();
  });
});

describe("finding models", () => {
  it("lists settings files and zips inside the roots only", async () => {
    mkdirSync(join(inside, "found", "deep", "er"), { recursive: true });
    mkdirSync(join(inside, "found", "node_modules", "x"), { recursive: true });
    mkdirSync(join(inside, "found", ".git"), { recursive: true });
    writeFileSync(join(inside, "found", "deep", "er", "a.model3.json"), "{}");
    writeFileSync(join(inside, "found", "b.ZIP"), "");
    writeFileSync(join(inside, "found", "node_modules", "x", "c.model3.json"), "{}");
    writeFileSync(join(inside, "found", ".git", "d.model3.json"), "{}");
    writeFileSync(join(outside, "e.model3.json"), "{}");
    symlinkSync(outside, join(inside, "found", "away"));
    const roots = await AllowedRoots.create([inside]);
    expect(await findModels(roots, join(inside, "found"))).toEqual({
      models: [
        { path: join(inside, "found", "b.ZIP"), kind: "zip" },
        { path: join(inside, "found", "deep", "er", "a.model3.json"), kind: "settings" },
      ],
      truncated: false,
    });
    expect((await findModels(roots, join(inside, "found"), 1)).truncated).toBe(true);
    const single = await AllowedRoots.create([join(inside, "found", "b.ZIP")]);
    expect((await findModels(single, single.real[0]!)).models).toHaveLength(1);
  });
});

describe("model locations", () => {
  it("refuse archives other than zip, and files that are not models", async () => {
    const roots = await AllowedRoots.create([inside]);
    await expect(openModelLocation(roots, "model.rar")).rejects.toThrow(/zip/i);
    await expect(openModelLocation(roots, "junk.moc3")).rejects.toThrow(/is not a model/);
    await expect(openModelLocation(roots, join(outside, "secret.txt"))).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
    await expect(readAllowedFile(roots, "model")).rejects.toThrow(/is not a file/);
    expect((await readAllowedFile(roots, "model/a.txt")).bytes).toEqual(new Uint8Array([97]));
  });
});

describe("the session without a model", () => {
  it("validates .moc3 files under the roots and asks for a model first", async () => {
    const session = new AgentSession(await AllowedRoots.create([inside]), repo);
    try {
      expect(session.hasModel).toBe(false);
      expect(() => session.describe()).toThrow(/load_model/);
      const r = await session.validateMoc3("junk.moc3");
      expect(r).toMatchObject({ path: join(inside, "junk.moc3"), valid: false });
      expect((r.reasons as string[])[0]).toMatch(/^MocFormatError: .*header/);
      await expect(session.validateMoc3(join(outside, "secret.txt"))).rejects.toBeInstanceOf(
        PathNotAllowedError,
      );
    } finally {
      await session.close();
    }
  });

  it("repeats random sequences for a seed", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
    expect(seededRandom(8)()).not.toBe(xs[0]);
  });
});

describe("option values", () => {
  it("parse assignments, sizes, views, points and motions", () => {
    expect(parseAssignments("ParamA=1.5, ParamB=-2,", "--params")).toEqual({
      ParamA: 1.5,
      ParamB: -2,
    });
    for (const bad of ["ParamA", "=1", "ParamA=x", "ParamA="])
      expect(() => parseAssignments(bad, "--params"), bad).toThrow(/--params/);
    expect(parseSize("640x480")).toEqual([640, 480]);
    expect(parseSize("64×32")).toEqual([64, 32]);
    expect(() => parseSize("640")).toThrow(/WIDTHxHEIGHT/);
    expect(parseView("0,0.5,300")).toEqual({ x: 0, y: 0.5, pixelsPerUnit: 300 });
    for (const bad of ["0,0,0", ",,300"])
      expect(() => parseView(bad), bad).toThrow(/pixelsPerUnit/);
    expect(parsePoint("1.5,-2")).toEqual([1.5, -2]);
    for (const bad of ["1", ",", "1,"]) expect(() => parsePoint(bad), bad).toThrow();
    expect(parseMotion("Idle:2")).toEqual({ group: "Idle", index: 2 });
    expect(parseMotion("Tap")).toEqual({ group: "Tap" });
    expect(parseMotion("motions/a.motion3.json")).toEqual({ file: "motions/a.motion3.json" });
  });

  it("parse backgrounds", () => {
    expect(parseBackground("transparent")).toEqual([0, 0, 0, 0]);
    expect(parseBackground("#fff")).toEqual([1, 1, 1, 1]);
    expect(parseBackground("#ff000080")).toEqual([1, 0, 0, 128 / 255]);
    expect(parseBackground("0,0.5,1,1")).toEqual([0, 0.5, 1, 1]);
    for (const bad of ["red", "#12345", "1,1,1", "2,0,0,1", ",,,"])
      expect(() => parseBackground(bad), bad).toThrow(/background/);
  });
});

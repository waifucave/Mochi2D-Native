/**
 * The `mochi2d` CLI (dist/tools/mochi2d.js, built by `npm run build:tools`):
 * describe, params, render, hit-test and validate, their state options, exit
 * codes and messages. Skipped until the tools are built; the model parts need
 * DeepSeek-chan, and the renders need dist/web and Playwright's Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPlaywright } from "../tools/lib/browser.js";
import { decodePng } from "../tools/lib/png.js";
import { DEEPSEEK, DEEPSEEK_SETTINGS, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
const CLI = join(root, "dist", "tools", "mochi2d.js");
const built = existsSync(CLI);
const haveHarness = existsSync(join(root, "dist", "web", "harness.html"));
let canRender = built && haveHarness;
try {
  loadPlaywright();
} catch {
  canRender = false;
}

function run(args: string[], cli = CLI) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 170_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const json = (args: string[], code = 0) => {
  const r = run([...args, "--json"]);
  expect(r.code, r.err).toBe(code);
  return JSON.parse(r.out) as Record<string, unknown>;
};

describe.skipIf(!built)("the mochi2d CLI", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "mochi2d-cli-")));
    writeFileSync(join(tmp, "junk.moc3"), "not a moc3 file");
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("prints its usage and version", () => {
    const help = run(["--help"]);
    expect(help.code).toBe(0);
    for (const c of ["list", "describe", "params", "render", "hit-test", "validate"])
      expect(help.out).toContain(`mochi2d ${c}`);
    expect(run([]).code).toBe(2);
    const version = (
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    expect(run(["--version"]).out.trim()).toBe(version);
    const unknown = run(["explode", "x"]);
    expect([unknown.code, unknown.err]).toEqual([2, expect.stringMatching(/Unknown command/)]);
    expect(run(["describe"]).code).toBe(2);
  });

  it("validates .moc3 files", () => {
    const bad = run(["validate", join(tmp, "junk.moc3")]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/^invalid:\n {2}MocFormatError: .*64-byte header/);
    expect(json(["validate", join(tmp, "junk.moc3")], 1)).toMatchObject({ valid: false });
    const missing = run(["validate", join(tmp, "nothing.moc3")]);
    expect([missing.code, missing.err]).toEqual([1, expect.stringMatching(/does not exist/)]);
  });

  it("lists the models in a folder", () => {
    mkdirSync(join(tmp, "models", "m"), { recursive: true });
    writeFileSync(join(tmp, "models", "m", "m.model3.json"), "{}");
    writeFileSync(join(tmp, "models", "n.zip"), "");
    const r = run(["list", join(tmp, "models")]);
    expect([r.code, r.out]).toEqual([
      0,
      `settings\t${join(tmp, "models", "m", "m.model3.json")}\nzip\t${join(tmp, "models", "n.zip")}\n`,
    ]);
    expect(json(["list", join(tmp, "models")]).allowedFolders).toEqual([join(tmp, "models")]);
  });

  describe.skipIf(!HAVE_DEEPSEEK)("with DeepSeek-chan", () => {
    it("validates its moc3", () => {
      const r = run(["validate", join(DEEPSEEK, "大肥鱼.moc3"), "--strict"]);
      expect([r.code, r.out]).toEqual([0, "valid: moc3 version 5\n"]);
    });

    it("describes the model", () => {
      const text = run(["describe", DEEPSEEK]);
      expect(text.code, text.err).toBe(0);
      expect(text.out.split("\n")[0]).toBe(
        "大肥鱼.model3.json (moc3 v5): 509 parameters, 147 parts, 715 drawables",
      );
      expect(text.out).toMatch(/^ {2}ParamMouthOpenY\t0\t\[0, 1\]\t0\t嘴　张开和闭合$/m);
      const d = json(["describe", DEEPSEEK_SETTINGS]);
      expect(d.parameters).toHaveLength(509);
      expect(d.physics).toMatchObject({ present: true, settings: 131, overwrites: 279 });
    });

    it("applies state options in order", () => {
      expect(
        json(["params", DEEPSEEK, "--params", "ParamMouthOpenY=0.7", "--ids", "ParamMouthOpenY"]),
      ).toEqual({
        parameters: [
          {
            id: "ParamMouthOpenY",
            name: "嘴　张开和闭合",
            value: 0.7,
            base: 0.7,
            min: 0,
            max: 1,
            default: 0,
          },
        ],
        unknown: [],
      });
      // Unknown IDs: exit code 1.
      expect(json(["params", DEEPSEEK, "--ids", "Nope"], 1)).toEqual({
        parameters: [],
        unknown: ["Nope"],
      });
      // A motion and an expression played for a second open the mouth.
      const after = json([
        "params",
        DEEPSEEK,
        "--effects",
        "physics=off,eyeBlink=off,breath=off",
        "--expression",
        "Exp3/脸红.exp3.json",
        "--motion",
        "Animation/脱捕.motion3.json",
        "--time",
        "1",
        "--ids",
        "ParamMouthOpenY",
      ]);
      const value = (after.parameters as { value: number }[])[0]!.value;
      expect(value).toBeGreaterThan(0);
      // The same options give the same values (seeded randomness).
      const again = json([
        "params",
        DEEPSEEK,
        "--effects",
        "physics=off,eyeBlink=off,breath=off",
        "--expression",
        "Exp3/脸红.exp3.json",
        "--motion",
        "Animation/脱捕.motion3.json",
        "--time",
        "1",
        "--ids",
        "ParamMouthOpenY",
      ]);
      expect(again).toEqual(after);
      const parts = json(["describe", DEEPSEEK, "--parts", "Part67=0.25"]).parts as {
        id: string;
        opacity: number;
      }[];
      expect(parts.find((p) => p.id === "Part67")!.opacity).toBe(0.25);
    });

    it("says what is wrong with an option", () => {
      for (const [args, code, message] of [
        [["--params", "ParamMouthOpenY"], 1, /--params: "ParamMouthOpenY" is not ID=number/],
        [["--time", "soon"], 2, /--time needs a number/],
        [["--effects", "physics=maybe"], 1, /--effects/],
        [["--effects", "blush=on"], 1, /Unknown effects: blush \(the effects are physics, /],
        [["--motion", "../../x.motion3.json"], 1, /escapes/],
        [["--motion", "Idle"], 1, /no motion group "Idle"/],
      ] as const) {
        const r = run(["params", DEEPSEEK, ...args]);
        expect([r.code, r.err], args.join(" ")).toEqual([code, expect.stringMatching(message)]);
      }
      const missing = run(["describe", join(tmp, "no-model")]);
      expect([missing.code, missing.err]).toEqual([1, expect.stringMatching(/does not exist/)]);
    });

    it("hit-tests", () => {
      const at = json(["hit-test", DEEPSEEK, "--at", "0,0"]);
      expect(at).toEqual({ model: [0, 0], hitAreas: [], drawable: "ArtMesh479" });
      expect(json(["hit-test", DEEPSEEK, "--at", "256,256", "--pixels"])).toEqual(at);
      expect(run(["hit-test", DEEPSEEK, "--at", "0,0"]).out).toBe(
        "at (0, 0): hit areas none; topmost drawable ArtMesh479\n",
      );
    });

    it.skipIf(!canRender)(
      "renders PNG files",
      () => {
        const out = join(tmp, "open.png");
        const info = json([
          "render",
          DEEPSEEK,
          "--params",
          "ParamMouthOpenY=1",
          "--size",
          "96x192",
          "--out",
          out,
        ]);
        expect(info).toMatchObject({ out, width: 96, height: 192, center: [0, 0], notes: [] });
        const img = decodePng(readFileSync(out));
        expect([img.width, img.height]).toEqual([96, 192]);
        expect(Array.from(img.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
        const clear = join(tmp, "clear.png");
        const r = run([
          "render",
          DEEPSEEK,
          "--background",
          "transparent",
          "--size",
          "32x32",
          "--out",
          clear,
        ]);
        expect([r.code, r.out]).toEqual([0, `${clear}: 32×32\n`]);
        expect(Array.from(decodePng(readFileSync(clear)).data.subarray(0, 4))).toEqual([
          0, 0, 0, 0,
        ]);
        // --fast and --fast=MAX: previews with downscaled textures.
        for (const [flag, size] of [
          ["--fast", 1024],
          ["--fast=300", 300],
        ] as const) {
          const file = join(tmp, `fast-${size}.png`);
          const fast = json(["render", DEEPSEEK, flag, "--size", "48x96", "--out", file]);
          expect((fast.notes as string[]).join(" ")).toMatch(
            new RegExp(`fast render, not the reference: textures at most ${size} pixels`),
          );
          expect(decodePng(readFileSync(file)).width).toBe(48);
        }
      },
      180_000,
    );

    it("says when rendering is not possible, with exit code 3", () => {
      // A copy of the CLI in a package folder without the render harness (dist/web).
      const pkg = join(tmp, "pkg");
      mkdirSync(join(pkg, "dist", "tools"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), '{ "type": "module" }\n');
      copyFileSync(CLI, join(pkg, "dist", "tools", "mochi2d.js"));
      const r = run(
        ["render", DEEPSEEK, "--out", join(tmp, "never.png")],
        join(pkg, "dist", "tools", "mochi2d.js"),
      );
      expect(r.code).toBe(3);
      expect(r.err).toMatch(
        /^mochi2d: RenderUnavailable: Rendering needs the render harness .* "npm run build"/,
      );
      expect(existsSync(join(tmp, "never.png"))).toBe(false);
      // Commands other than render work there.
      expect(
        run(["hit-test", DEEPSEEK, "--at", "0,0"], join(pkg, "dist", "tools", "mochi2d.js")).code,
      ).toBe(0);
      expect(run(["render", DEEPSEEK]).code).toBe(2);
    });
  });
});

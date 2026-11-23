/**
 * The built package (npm run build:lib): the "exports" of package.json point
 * at files that exist, the headless bundle runs in Node, the Node example
 * runs, and a TypeScript consumer type-checks against the declarations.
 * Skipped until the library is built.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";
import { loadPlaywright } from "../tools/lib/browser.js";
import { PORTED } from "../scripts/license-banner.mjs";

const root = resolve(__dirname, "..");
const built = existsSync(join(root, "dist", "lib", "node.js"));
let HAVE_PLAYWRIGHT = existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  HAVE_PLAYWRIGHT = false;
}

describe.skipIf(!built)("the built package", () => {
  it("exports files that exist", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports: Record<string, string | Record<string, string>>;
      main: string;
      types: string;
    };
    const targets = [pkg.main, pkg.types];
    for (const v of Object.values(pkg.exports))
      targets.push(...(typeof v === "string" ? [v] : Object.values(v)));
    for (const t of targets) expect(existsSync(join(root, t)), t).toBe(true);
  });

  it("is MIT-licensed and keeps the license comments in every bundle", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name: string;
      license: string;
      private: boolean;
      files: string[];
    };
    expect([pkg.name, pkg.license, pkg.private]).toEqual(["mochi2d", "MIT", true]);
    expect(pkg.files).toEqual(expect.arrayContaining(["LICENSE", "THIRD_PARTY_NOTICES.md"]));
    expect(readFileSync(join(root, "LICENSE"), "utf8")).toMatch(
      /^MIT License\n\nCopyright \(c\) 2026 Mochi2D contributors\n/,
    );
    const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
    for (const name of ["fflate", "pngjs"])
      expect(notices).toContain(
        readFileSync(join(root, "node_modules", name, "LICENSE"), "utf8").trimEnd(),
      );
    // The float32 math functions ported from musl (the evaluator's rotations).
    expect(notices).toContain("| [musl](https://musl.libc.org/) | 1.2.6 |");
    expect(notices).toContain("Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.");
    for (const file of ["mochi2d.js", "mochi2d.min.js", "headless.js", "node.js", "pixi.js"]) {
      const head = readFileSync(join(root, "dist", "lib", file), "utf8").slice(0, 800);
      expect(head, file).toMatch(/^\/\*! Mochi2D \d+\.\d+\.\d+ \| MIT License \| Copyright/);
      expect(head, file).toMatch(
        /\/\*! fflate [\d.]+ \| MIT License \| Copyright \(c\) \d+ Arjun Barrett \*\//,
      );
      expect(head, file).toContain(PORTED.musl.comment);
    }
    // PixiJS is the app's (a peer dependency): imported, not bundled.
    const pixi = readFileSync(join(root, "dist", "lib", "pixi.js"), "utf8");
    expect(pixi).toMatch(/from "pixi\.js"/);
    expect(pixi).not.toMatch(/class Container\b/);
  });

  it.skipIf(!HAVE_DEEPSEEK)("runs the headless bundle in Node", async () => {
    const lib = (await import(
      pathToFileURL(join(root, "dist", "lib", "node.js")).href
    )) as typeof import("../src/lib/node.js");
    expect(lib.MOCHI2D_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const model = await lib.loadModelFromDisk(DEEPSEEK);
    // Physics turns DeepSeek-chan's head (ParamAngleX) from AngleX.
    model.setParameter("AngleX", 30);
    for (let i = 0; i < 30; i++) model.update(1 / 60);
    expect(model.getParameter("ParamAngleX")).toBeGreaterThan(5);
    const headless = (await import(
      pathToFileURL(join(root, "dist", "lib", "headless.js")).href
    )) as typeof import("../src/lib/headless.js");
    expect(typeof headless.ModelRuntime.load).toBe("function");
    // The model data round-trips through the built bundle, byte for byte.
    const moc = new Uint8Array(readFileSync(join(DEEPSEEK, "大肥鱼.moc3")));
    const read = headless.readMoc(moc);
    expect(read.version).toBe(5);
    expect(Buffer.from(headless.writeMoc(read.data, { version: 5 })).equals(Buffer.from(moc))).toBe(
      true,
    );
    expect(headless.validateMoc(moc).valid).toBe(true);
    // A model straight from its data (M5).
    expect(headless.mocModelFromData(read.data, 5)).toEqual(headless.loadMoc(moc));
    const r = headless.scenarioResult(await lib.resultModelFromDisk(DEEPSEEK), {
      format: "mochi2d-scenario/0",
      id: "pose",
      parameters: { ParamAngleX: 10 },
    });
    expect([r.error, r.producer]).toEqual([null, `mochi2d@${lib.MOCHI2D_VERSION}`]);
  });

  it.skipIf(!HAVE_DEEPSEEK || !HAVE_PLAYWRIGHT)(
    "renders from the built Node bundle (the harness in dist/web)",
    async () => {
      const lib = (await import(
        pathToFileURL(join(root, "dist", "lib", "node.js")).href
      )) as typeof import("../src/lib/node.js");
      const r = await lib.renderToPng(DEEPSEEK, { width: 64, height: 96, fast: true });
      expect([r.width, r.height, r.reference]).toEqual([64, 96, false]);
      expect(Buffer.from(r.png.subarray(1, 4)).toString()).toBe("PNG");
    },
    120000,
  );

  it("runs the Node example on the sample model", () => {
    const out = execFileSync(
      process.execPath,
      [
        join(root, "examples", "node", "evaluate.mjs"),
        "samples/mochi/mochi.model3.json",
        "motions/idle.motion3.json",
        "--seconds",
        "1",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(out).toMatch(/5 parameters, 7 drawables, physics on/);
    expect(out).toMatch(/motion motions\/idle\.motion3\.json: started/);
  }, 60000);

  it.skipIf(!HAVE_DEEPSEEK)(
    "runs the Node example",
    () => {
      const out = execFileSync(
        process.execPath,
        [join(root, "examples", "node", "evaluate.mjs"), "--seconds", "1"],
        { cwd: root, encoding: "utf8" },
      );
      expect(out).toMatch(/509 parameters, 715 drawables, physics on/);
      expect(out).toMatch(/motion Animation\/脱捕\.motion3\.json: started/);
      expect(out).toMatch(/visible bounds: x -?\d/);
    },
    60000,
  );

  it("type-checks a consumer against the declarations", () => {
    const dir = mkdtempSync(join(tmpdir(), "mochi2d-consumer-"));
    try {
      const types = join(root, "dist", "lib", "types", "lib");
      writeFileSync(
        join(dir, "app.ts"),
        `import { MochiView, type TapEvent, type ModelInput } from "mochi2d";
import {
  ModelRuntime,
  MemoryFileSource,
  readMoc,
  writeMoc,
  validateMoc,
  scenarioResult,
  MocWriteError,
  type MocData,
  type MocDiagnostic,
  type MocVersion,
} from "mochi2d/headless";
import {
  loadModelFromDisk,
  resultModelFromDisk,
  NodeRenderer,
  mocModelFromData,
  type RenderedImage,
} from "mochi2d/node";

export async function main(canvas: HTMLCanvasElement, input: ModelInput): Promise<void> {
  const view = new MochiView(canvas, { look: "follow", zoom: true, textureBudget: 256 });
  const model = await view.load(input);
  view.on("hit", (e: TapEvent) => void model.startMotion("Tap", undefined, { priority: 3 }));
  model.setParameter("ParamAngleX", 10);
  await model.setExpression("smile");
  await model.speak("hello.wav", { volume: 0.5 });
  const headless = await ModelRuntime.load(new MemoryFileSource("m"), "m.model3.json");
  headless.update(1 / 60);
  const fromDisk = await loadModelFromDisk("model.model3.json");
  const n: number = fromDisk.instance.drawableVertices.length;
  void n;
  // Model data (M1–M4) and results (M13).
  const { data, version, diagnostics }: { data: MocData; version: MocVersion; diagnostics: MocDiagnostic[] } =
    readMoc(new Uint8Array(64));
  const parents: Int32Array = data.parts.parent;
  const colors: Int32Array | undefined = data.warpKeyforms.multiplyColor;
  void [parents, colors, diagnostics];
  try {
    const bytes: Uint8Array = writeMoc(data, { version: 5 });
    const check = validateMoc(bytes, { level: "official" });
    const first: string | undefined = check.diagnostics[0]?.code;
    void first;
  } catch (e) {
    if (e instanceof MocWriteError) void e.diagnostics.map((d) => d.kind);
  }
  validateMoc(data, { version, level: "strict" });
  const fromData = mocModelFromData(data, version);
  void fromData.parameters.ids;
  const renderer = await NodeRenderer.open();
  const image: RenderedImage = await renderer.render(fromDisk, { width: 256, fast: { maxTextureSize: 512 } });
  void image.png.length;
  await renderer.close();
  // Motions end with a reason; held motions; added expressions; the view.
  const playback = await model.startMotion("Tap", 0, { hold: true });
  if (playback) void playback.ended.then((end) => end.reason === "finished");
  await model.addExpression("smile");
  model.removeExpression();
  view.setView({ rotation: 90, x: 0.1 });
  view.panBy(10, -5);
  const ppu: number = view.viewTransform.pixelsPerUnit;
  void ppu;
  view.on("motionend", (e) => void [e.motion, e.reason, e.queueEmpty]);
  const live = await model.startLiveLipSync({ deviceId: "mic", mix: (l, c) => Math.max(l, c) });
  live.mix = "replace";
  const inputs = model.physicsInputs.get("ParamAngleX")?.[0]?.id;
  void inputs;
  const item = await view.addItem("hat.model3.json", { id: "hat" });
  item.applyLayout(item.exportLayout());
  const result = scenarioResult(await resultModelFromDisk("model.model3.json"), {
    format: "mochi2d-scenario/0",
    id: "pose",
    parameters: { ParamAngleX: 10 },
  });
  void result.error;
}
`,
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            types: ["node"],
            typeRoots: [join(root, "node_modules", "@types")],
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            paths: {
              mochi2d: [join(types, "index.d.ts")],
              "mochi2d/headless": [join(types, "headless.d.ts")],
              "mochi2d/node": [join(types, "node.d.ts")],
            },
          },
          files: ["app.ts"],
        }),
      );
      execFileSync(
        process.execPath,
        [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", dir],
        {
          encoding: "utf8",
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

const toolsBuilt = existsSync(join(root, "dist", "tools", "third-party.json"));

describe.skipIf(!toolsBuilt)("the built tools", () => {
  it("name every bundled package in THIRD_PARTY_NOTICES.md and in license comments", () => {
    const bundled = JSON.parse(
      readFileSync(join(root, "dist", "tools", "third-party.json"), "utf8"),
    ) as Record<string, string[]>;
    expect(bundled["dist/tools/mochi2d-mcp.js"]).toEqual(
      expect.arrayContaining(["@modelcontextprotocol/sdk", "zod"]),
    );
    // The tools that evaluate models hold the ported math code.
    for (const tool of ["conformance", "golden", "mochi2d", "mochi2d-mcp"])
      expect(bundled[`dist/tools/${tool}.js`], tool).toContain("musl");
    const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
    for (const [file, packages] of Object.entries(bundled)) {
      const head = readFileSync(join(root, file), "utf8").slice(0, 4000);
      expect(head, file).toMatch(/^(#!.*\n)?\/\*! Mochi2D \d+\.\d+\.\d+ \| MIT License/);
      for (const name of packages) {
        if (Object.hasOwn(PORTED, name)) {
          expect(head, `${file}: ${name}`).toContain(PORTED[name as keyof typeof PORTED].comment);
          expect(notices, name).toContain(`\n## ${name}\n`);
          continue;
        }
        const version = (
          JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as {
            version: string;
          }
        ).version;
        expect(head, `${file}: ${name}`).toContain(`/*! ${name} ${version} | `);
        expect(notices, name).toContain(`| [${name}](`);
        const section = notices.split(`\n## ${name}\n`)[1]?.split("\n## ")[0] ?? "";
        expect(section, name).toContain(
          readFileSync(join(root, "node_modules", name, "LICENSE"), "utf8").trimEnd(),
        );
      }
    }
  });

  it("are the package's commands", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin).toEqual({
      mochi2d: "dist/tools/mochi2d.js",
      "mochi2d-mcp": "dist/tools/mochi2d-mcp.js",
    });
    for (const file of Object.values(pkg.bin)) {
      expect(readFileSync(join(root, file), "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
      if (process.platform !== "win32")
        expect(statSync(join(root, file)).mode & 0o111, file).not.toBe(0);
    }
    // A packed copy holds the commands and the render page they need.
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = JSON.parse(
      execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        shell: process.platform === "win32",
      }),
    ) as { files: { path: string }[] }[];
    const paths = packed[0]!.files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([...Object.values(pkg.bin), "dist/web/harness.html", "LICENSE"]),
    );
    expect(paths.filter((p) => p.startsWith("dist/tools/"))).toEqual(Object.values(pkg.bin).sort());
    // The sample model and the README's images stay in the repository.
    expect(paths.filter((p) => p.startsWith("samples/") || p.startsWith("docs/images/"))).toEqual(
      [],
    );
  }, 60000);
});

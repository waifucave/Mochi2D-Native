/**
 * Mochi2D's MCP server (dist/tools/mochi2d-mcp.js, built by `npm run
 * build:tools`) spawned over stdio and driven with the official MCP SDK's
 * client: the tool list, every tool, the resources, the file boundary, and a
 * render that comes back as a PNG image. Skipped until the tools are built;
 * the model parts need DeepSeek-chan, and the renders need dist/web
 * (`npm run build`) and Playwright's Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/lib/browser.js";
import { decodePng, type RgbaImage } from "../tools/lib/png.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";
import { Synth } from "./support/synth.js";
import { MALE, dsBasic, vowelClip, wavFile } from "./support/motion-sync.js";

const root = resolve(__dirname, "..");
const deepseek = HAVE_DEEPSEEK ? realpathSync(DEEPSEEK) : DEEPSEEK;
const SERVER = join(root, "dist", "tools", "mochi2d-mcp.js");
const built = existsSync(SERVER);
const haveHarness = existsSync(join(root, "dist", "web", "harness.html"));
let havePlaywright = true;
try {
  loadPlaywright();
} catch {
  havePlaywright = false;
}
const canRender = built && haveHarness && havePlaywright;

const TOOLS = [
  "advance_time",
  "describe_model",
  "get_parameters",
  "get_part_opacities",
  "hit_test",
  "list_models",
  "load_model",
  "map_points",
  "play_expression",
  "play_motion",
  "play_sound",
  "render",
  "reset",
  "set_parameters",
  "set_part_opacities",
  "validate_moc3",
];

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult {
  content: Content[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * The test's environment for the server. MCP clients pass only a few
 * variables by default; the test passes all, so Playwright is found the
 * same way as in the other browser tests.
 */
function fullEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, ...extra };
}

async function connect(
  args: string[],
  options: { server?: string; env?: Record<string, string>; roots?: () => string[] } = {},
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.server ?? SERVER, ...args],
    env: options.env ?? fullEnv(),
    cwd: root,
    stderr: "pipe",
  });
  let log = "";
  transport.stderr?.on("data", (d: Buffer) => (log += String(d)));
  const client = new Client(
    { name: "mochi2d-test", version: "0.0.0" },
    options.roots ? { capabilities: { roots: { listChanged: true } } } : {},
  );
  const roots = options.roots;
  if (roots)
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: roots().map((p) => ({ uri: pathToFileURL(p).href })),
    }));
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args }, undefined, {
      timeout: 120_000,
    })) as ToolResult;
  return { client, call, log: () => log };
}

const text = (r: ToolResult) =>
  r.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

/** The structured result of a call that must succeed. */
function data(r: ToolResult): Record<string, unknown> {
  expect(r.isError, text(r)).toBeFalsy();
  // The text content holds the same value, for clients without structured results.
  expect(JSON.parse(text(r))).toEqual(r.structuredContent);
  return r.structuredContent!;
}

function image(r: ToolResult): RgbaImage {
  expect(r.isError, text(r)).toBeFalsy();
  const images = r.content.filter((c) => c.type === "image");
  expect(images).toHaveLength(1);
  expect(images[0]!.mimeType).toBe("image/png");
  return decodePng(Buffer.from(images[0]!.data, "base64"));
}

const pixel = (img: RgbaImage, x: number, y: number) =>
  Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

/** How many pixels differ from a color. */
function countOther(img: RgbaImage, rgba: number[]): number {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (rgba.some((v, c) => img.data[i + c] !== v)) n++;
  return n;
}

describe.skipIf(!built)("the MCP server", () => {
  let tmp: string;
  let s: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "mochi2d-mcp-")));
    writeFileSync(join(tmp, "junk.moc3"), "not a moc3 file");
    symlinkSync(join(root, "package.json"), join(tmp, "link.moc3"));
    s = await connect(["--root", tmp, ...(HAVE_DEEPSEEK ? ["--root", DEEPSEEK] : [])]);
  });

  afterAll(async () => {
    await s?.client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists its tools with schemas, and its resources", async () => {
    expect(s.client.getServerVersion()?.name).toBe("mochi2d");
    expect(s.client.getInstructions()).toMatch(/load_model/);
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.annotations?.openWorldHint, t.name).toBe(false);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
    }
    expect(
      tools
        .filter((t) => t.annotations?.readOnlyHint)
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      "describe_model",
      "get_parameters",
      "get_part_opacities",
      "hit_test",
      "list_models",
      "map_points",
      "render",
      "validate_moc3",
    ]);
    const load = tools.find((t) => t.name === "load_model")!;
    expect(load.inputSchema.required).toEqual(["path"]);
    const { resources } = await s.client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "mochi2d://docs/agent-api",
      "mochi2d://docs/api",
      "mochi2d://docs/llms.txt",
      "mochi2d://model",
    ]);
  });

  it("serves the docs as resources", async () => {
    const read = async (uri: string) => {
      const r = await s.client.readResource({ uri });
      expect(r.contents).toHaveLength(1);
      return (r.contents[0] as { text: string; mimeType: string }).text;
    };
    const agent = await read("mochi2d://docs/agent-api");
    expect(agent).toMatch(/^# Mochi2D agent API/);
    for (const t of TOOLS) expect(agent, t).toContain(`\`${t}\``);
    expect(await read("mochi2d://docs/api")).toMatch(/^# /);
    expect(await read("mochi2d://docs/llms.txt")).toMatch(/^# Mochi2D\n/);
    const model = JSON.parse(await read("mochi2d://model")) as Record<string, unknown>;
    expect(model.loaded).toBe(false);
  });

  it("asks for a model before the tools that need one", async () => {
    for (const name of ["describe_model", "get_parameters", "render", "hit_test", "reset"]) {
      const r = await s.call(name, name === "hit_test" ? { x: 0, y: 0 } : {});
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toMatch(/No model is loaded: call load_model first/);
    }
  });

  it("reads nothing outside the allowed folders", async () => {
    for (const [name, args] of [
      ["load_model", { path: "/etc" }],
      ["load_model", { path: "../../../../../../../../etc" }],
      ["load_model", { path: root }],
      ["validate_moc3", { path: "/etc/passwd" }],
      ["validate_moc3", { path: join(root, "package.json") }],
      // A link inside an allowed folder that points outside it.
      ["validate_moc3", { path: join(tmp, "link.moc3") }],
    ] as const) {
      const r = await s.call(name, args);
      expect(r.isError, `${name} ${args.path}`).toBe(true);
      expect(text(r), `${name} ${args.path}`).toMatch(/is outside the allowed folders/);
    }
  });

  it("rejects arguments that do not fit the schemas", async () => {
    for (const [name, args] of [
      ["load_model", {}],
      ["advance_time", { seconds: 1000 }],
      ["render", { width: 5 }],
      ["play_motion", { priority: 7 }],
    ] as const) {
      const r = await s.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toMatch(/Input validation error/);
    }
  });

  it("lists the allowed folders and the models in them", async () => {
    const r = data(await s.call("list_models"));
    expect(r.allowedFolders).toEqual([tmp, ...(HAVE_DEEPSEEK ? [deepseek] : [])]);
    expect(r.models).toEqual(
      HAVE_DEEPSEEK ? [{ path: join(deepseek, "大肥鱼.model3.json"), kind: "settings" }] : [],
    );
    expect(data(await s.call("list_models", { folder: tmp }))).toMatchObject({ models: [] });
    const outside = await s.call("list_models", { folder: root });
    expect(text(outside)).toMatch(/is outside the allowed folders/);
  });

  it("validates .moc3 files", async () => {
    // Relative paths start at the first allowed folder.
    const r = data(await s.call("validate_moc3", { path: "junk.moc3" }));
    expect(r).toMatchObject({ path: join(tmp, "junk.moc3"), valid: false });
    expect(r.reasons).toEqual([expect.stringMatching(/^MocFormatError: .*64-byte header/)]);
  });

  describe.skipIf(!HAVE_DEEPSEEK)("with DeepSeek-chan", () => {
    const moc = join(deepseek, "大肥鱼.moc3");

    it("validates its moc3, and a cut copy", async () => {
      expect(data(await s.call("validate_moc3", { path: moc, strict: true }))).toEqual({
        path: moc,
        valid: true,
        version: 5,
        counts: { parameters: 509, parts: 147, drawables: 715 },
        warnings: [],
      });
      writeFileSync(join(tmp, "cut.moc3"), readFileSync(moc).subarray(0, 64 * 1000));
      const cut = data(await s.call("validate_moc3", { path: join(tmp, "cut.moc3") }));
      expect(cut.valid).toBe(false);
      expect((cut.reasons as string[]).length).toBeGreaterThan(0);
    });

    it("loads and describes the model", async () => {
      expect(data(await s.call("load_model", { path: DEEPSEEK })).loaded).toEqual({
        path: deepseek,
        settings: "大肥鱼.model3.json",
        mocVersion: 5,
        parameters: 509,
        parts: 147,
        drawables: 715,
        expressions: 0,
        motionGroups: [],
        physics: true,
        time: 0,
        // What each texture declares, read from its header.
        textures: expect.arrayContaining([
          expect.objectContaining({ width: 8192, height: 8192, format: "png" }),
        ]),
        warnings: [],
      });
      const d = data(await s.call("describe_model"));
      const params = d.parameters as Record<string, unknown>[];
      expect(params).toHaveLength(509);
      // Display names and groups come from the display-info file.
      expect(params.find((p) => p.id === "ParamMouthOpenY")).toEqual({
        id: "ParamMouthOpenY",
        name: "嘴　张开和闭合",
        group: "嘴",
        min: 0,
        max: 1,
        default: 0,
        value: 0,
      });
      expect(params.find((p) => p.id === "ParamAngleX")).toMatchObject({
        min: -30,
        max: 30,
        drivenByPhysicsFrom: "AngleX",
        physicsInputs: [{ id: "AngleX", weight: 100 }],
      });
      // Every input of a parameter that physics overwrites, largest weight first.
      expect(params.find((p) => p.id === "ParamBodyAngleRX")).toMatchObject({
        drivenByPhysicsFrom: "PositionX",
        physicsInputs: [
          { id: "PositionX", weight: 47 },
          { id: "PositionZ", weight: 24 },
        ],
      });
      expect(d.physics).toMatchObject({ present: true, settings: 131, overwrites: 279, rate: 60 });
      expect((d.physics as { look: unknown[] }).look).toContainEqual({
        target: "ParamAngleX",
        writes: "AngleX",
      });
      expect(d.parameterGroups).toContain("嘴");
      expect(d.parts).toHaveLength(147);
      expect(d.drawables).toEqual({ count: 715, masked: 181 });
      expect(d.canvas).toEqual({
        widthPixels: 3749,
        heightPixels: 7697,
        pixelsPerUnit: 3749,
        widthUnits: 1,
        heightUnits: 2.053081,
      });
      expect(d).toMatchObject({ pose: false, eyeBlink: true, lipSync: true, hitAreas: [] });
      expect((d.expressions as { files: string[] }).files).toContain("Exp3/脸红.exp3.json");
      expect((d.motions as { files: string[] }).files).toContain("Animation/脱捕.motion3.json");
      expect(d.effects).toEqual({
        physics: true,
        eyeBlink: true,
        breath: true,
        look: true,
        lipSync: true,
        expressions: true,
      });
      // The model resource holds the same description.
      const res = await s.client.readResource({ uri: "mochi2d://model" });
      expect(JSON.parse((res.contents[0] as { text: string }).text)).toEqual(d);
    });

    it("gets and sets parameters", async () => {
      expect(
        data(await s.call("get_parameters", { ids: ["ParamMouthOpenY", "NoSuchParameter"] })),
      ).toEqual({
        parameters: [
          {
            id: "ParamMouthOpenY",
            name: "嘴　张开和闭合",
            value: 0,
            base: 0,
            min: 0,
            max: 1,
            default: 0,
          },
        ],
        unknown: ["NoSuchParameter"],
      });
      const set = data(await s.call("set_parameters", { values: { ParamMouthOpenY: 0.25 } }));
      expect(set).toMatchObject({ parameters: [{ id: "ParamMouthOpenY", value: 0.25 }] });
      // Values are limited to the parameter's range.
      const big = data(await s.call("set_parameters", { values: { ParamMouthOpenY: 5, Nope: 1 } }));
      expect(big).toMatchObject({ parameters: [{ value: 1 }], unknown: ["Nope"] });
      expect((data(await s.call("get_parameters")).parameters as unknown[]).length).toBe(509);
      // Setting what physics overwrites says which inputs to set instead.
      expect(data(await s.call("set_parameters", { values: { ParamAngleX: 10 } }))).toMatchObject({
        physicsOverwrites: [{ id: "ParamAngleX", setInstead: ["AngleX"] }],
      });
      // Physics turns the head (ParamAngleX) from AngleX as time advances.
      expect(
        data(await s.call("set_parameters", { values: { AngleX: 30 } })).physicsOverwrites,
      ).toBeUndefined();
      data(await s.call("advance_time", { seconds: 0.5 }));
      const angle = data(await s.call("get_parameters", { ids: ["ParamAngleX"] }));
      const head = (angle.parameters as { value: number; base: number }[])[0]!;
      expect(head.value).toBeGreaterThan(5);
      // The base value is what was set; physics writes the value on top of it.
      expect(head.base).toBe(10);
    });

    it("gets and sets part opacities", async () => {
      const parts = data(await s.call("get_part_opacities")).parts as { id: string }[];
      expect(parts).toHaveLength(147);
      const id = parts[0]!.id;
      expect(data(await s.call("set_part_opacities", { values: { [id]: 0.5, Nope: 1 } }))).toEqual({
        parts: [{ id, name: expect.any(String), opacity: 0.5, default: 1 }],
        unknown: ["Nope"],
      });
      expect(data(await s.call("get_part_opacities", { ids: [id] }))).toMatchObject({
        parts: [{ id, opacity: 0.5 }],
      });
    });

    it("plays expressions and motions as time advances, and resets", async () => {
      // Without physics, eye blink and breath, only the motion and the expression move it.
      data(
        await s.call("load_model", {
          path: join(DEEPSEEK, "大肥鱼.model3.json"),
          seed: 3,
          effects: { physics: false, eyeBlink: false, breath: false },
        }),
      );
      expect(data(await s.call("describe_model")).effects).toMatchObject({
        physics: false,
        eyeBlink: false,
        breath: false,
      });
      expect(data(await s.call("play_expression", { expression: "Exp3/脸红.exp3.json" }))).toEqual({
        playing: ["Exp3/脸红.exp3.json"],
        added: [],
      });
      // Several at once: add one on top, then remove it again.
      expect(
        data(await s.call("play_expression", { expression: "Exp3/流泪.exp3.json", mode: "add" })),
      ).toEqual({
        playing: ["Exp3/脸红.exp3.json"],
        added: ["Exp3/流泪.exp3.json"],
        changed: true,
      });
      expect(
        data(await s.call("play_expression", { expression: "Exp3/流泪.exp3.json", mode: "add" })),
      ).toMatchObject({ changed: false });
      expect(
        data(await s.call("play_motion", { file: "Animation/脱捕.motion3.json", priority: 3 })),
      ).toEqual({ started: true, playing: ["Animation/脱捕.motion3.json"] });
      const step = data(await s.call("advance_time", { seconds: 1, fps: 30 }));
      expect(step).toMatchObject({
        frames: 30,
        time: 1,
        ends: [],
        playing: {
          motions: ["Animation/脱捕.motion3.json"],
          expressions: ["Exp3/脸红.exp3.json"],
          added: ["Exp3/流泪.exp3.json"],
        },
      });
      expect(
        data(await s.call("play_expression", { expression: null, mode: "remove" })),
      ).toMatchObject({ added: [], changed: true });
      // A held motion: it ends (finished) at its last frame and keeps it; the next one replaces it.
      const short = "Animation/举手切默认手.motion3.json";
      expect(data(await s.call("play_motion", { file: short, priority: 3, hold: true }))).toEqual({
        started: true,
        playing: ["Animation/脱捕.motion3.json", short],
      });
      const held = data(await s.call("advance_time", { seconds: 1.5 }));
      expect(held.ends).toEqual([
        { time: expect.any(Number), motion: "Animation/脱捕.motion3.json", reason: "replaced" },
        { time: expect.any(Number), motion: short, reason: "finished" },
      ]);
      expect(held).toMatchObject({ playing: { motions: [short] } });
      const moved = (data(await s.call("get_parameters")).parameters as Record<string, number>[])
        .filter((p) => p.value !== p.default)
        .map((p) => p.id);
      expect(moved).toEqual(expect.arrayContaining(["ParamMouthOpenY", "AngleX"]));
      // null fades the expression out.
      data(await s.call("play_expression", { expression: null }));
      expect(data(await s.call("advance_time", { seconds: 3 }))).toMatchObject({
        time: 5.5,
        playing: { expressions: [] },
      });
      // Errors say what is wrong.
      for (const [name, args, message] of [
        ["play_motion", { group: "Idle" }, /no motion group "Idle"/],
        ["play_motion", {}, /Give a motion group/],
        ["play_motion", { file: "Animation/none.motion3.json" }, /not found/i],
        ["play_expression", { expression: "../../../x.exp3.json" }, /escapes/],
      ] as const) {
        const r = await s.call(name, args);
        expect(r.isError, name).toBe(true);
        expect(text(r), name).toMatch(message);
      }
      // reset: the state right after loading, with the same options.
      expect(data(await s.call("reset")).reset).toMatchObject({ time: 0, parameters: 509 });
      const after = data(await s.call("describe_model"));
      expect(after).toMatchObject({
        time: 0,
        playing: { motions: [], expressions: [] },
        effects: { physics: false, eyeBlink: false, breath: false },
      });
      for (const p of after.parameters as Record<string, number>[])
        expect(p.value, p.id as unknown as string).toBe(p.default);
    });

    it("hit-tests in model units and in render pixels", async () => {
      const center = { model: [0, 0], hitAreas: [], drawable: "ArtMesh479" };
      expect(data(await s.call("hit_test", { x: 0, y: 0 }))).toEqual(center);
      // The center of a 512×512 render with the default view.
      expect(data(await s.call("hit_test", { x: 256, y: 256, space: "pixels" }))).toEqual(center);
      expect(
        data(
          await s.call("hit_test", {
            x: 50,
            y: 50,
            space: "pixels",
            width: 100,
            height: 100,
            view: { x: 0, y: 0, pixelsPerUnit: 100 },
          }),
        ),
      ).toEqual(center);
      // A corner of the render is outside the model.
      expect(data(await s.call("hit_test", { x: 1, y: 1, space: "pixels" }))).toMatchObject({
        drawable: null,
      });
    });

    it("maps points through a deformer, or a drawable's parent deformer", async () => {
      const points = [
        [0.25, 0.5],
        [3, -4],
      ];
      const r = data(
        await s.call("map_points", { drawable: "ArtMesh479", points, jacobian: true }),
      ) as {
        deformer: string;
        chain: { id: string; kind: string }[];
        space: string;
        points: number[][];
        jacobians: number[][];
      };
      expect(typeof r.deformer).toBe("string");
      expect(r.chain[0]!.id).toBe(r.deformer);
      expect(r.space).toBe("model");
      expect(r.points).toHaveLength(2);
      expect(r.jacobians.map((j) => j.length)).toEqual([4, 4]);
      // The same through the deformer's ID; "keyform" space has y the other way.
      const byId = data(await s.call("map_points", { deformer: r.deformer, points }));
      expect(byId.points).toEqual(r.points);
      const keyform = data(
        await s.call("map_points", { deformer: r.deformer, points, space: "keyform" }),
      ) as { points: number[][] };
      expect(keyform.points.map(([x, y]) => [x, -y!])).toEqual(r.points);
      for (const [args, message] of [
        [{ points }, /either deformer or drawable/],
        [{ deformer: "Nope", points }, /No deformer "Nope"/],
        [{ drawable: "Nope", points }, /No drawable "Nope"/],
      ] as const) {
        const e = await s.call("map_points", args);
        expect(e.isError).toBe(true);
        expect(text(e)).toMatch(message);
      }
    });

    it.skipIf(!canRender)(
      "renders the current pose as a PNG image",
      async () => {
        data(await s.call("reset"));
        const r = await s.call("render", { width: 160, height: 320 });
        const closed = image(r);
        expect([closed.width, closed.height]).toEqual([160, 320]);
        expect(data(r)).toMatchObject({
          width: 160,
          height: 320,
          center: [0, 0],
          renderer: expect.any(String),
          notes: [],
        });
        // White by default; the model fills much of the image.
        expect(pixel(closed, 0, 0)).toEqual([255, 255, 255, 255]);
        expect(countOther(closed, [255, 255, 255, 255])).toBeGreaterThan(160 * 320 * 0.2);
        // The pose shows: an open mouth changes the image.
        data(await s.call("set_parameters", { values: { ParamMouthOpenY: 1 } }));
        const open = image(await s.call("render", { width: 160, height: 320 }));
        expect(Buffer.from(open.data).equals(Buffer.from(closed.data))).toBe(false);
        // Other backgrounds and views.
        const clear = image(
          await s.call("render", { width: 64, height: 64, background: "transparent" }),
        );
        expect(pixel(clear, 0, 0)).toEqual([0, 0, 0, 0]);
        const red = image(
          await s.call("render", {
            width: 32,
            height: 32,
            background: [1, 0, 0, 1],
            view: { x: 5, y: 5, pixelsPerUnit: 10 },
          }),
        );
        // A view far from the model shows only the background.
        expect(countOther(red, [255, 0, 0, 255])).toBe(0);
        // The fast preview: downscaled textures, said so in the notes.
        const fast = await s.call("render", { width: 160, height: 320, maxTextureSize: 256 });
        expect((data(fast).notes as string[]).join(" ")).toMatch(/fast render, not the reference/);
        expect(image(fast).width).toBe(160);
      },
      180_000,
    );
  });

  it("plays a sound through motion sync, and reports the element weights", async () => {
    // A small synthetic model with a mouth, a motion-sync file and a WAV file of the vowel A.
    const dir = join(tmp, "talker");
    mkdirSync(dir);
    const moc = new Synth(4);
    moc.part({ id: "P" });
    moc.param("ParamMouthOpenY", 0, 1, 0);
    moc.param("ParamMouthForm", -1, 1, 0);
    moc.mesh({ id: "M", keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
    writeFileSync(join(dir, "talker.moc3"), moc.build());
    writeFileSync(
      join(dir, "talker.model3.json"),
      JSON.stringify({
        Version: 3,
        FileReferences: { Moc: "talker.moc3", Textures: [], MotionSync: "talker.motionsync3.json" },
      }),
    );
    writeFileSync(join(dir, "talker.motionsync3.json"), JSON.stringify(dsBasic()));
    writeFileSync(
      join(dir, "a.wav"),
      wavFile([vowelClip(MALE, 16000, { vowels: ["A"] }).samples], 16000),
    );
    data(await s.call("load_model", { path: dir }));
    expect(data(await s.call("describe_model")).motionSync).toEqual({
      settings: [{ id: "MS_Basic", name: "Mouth basic", usable: true }],
      playing: null,
    });
    const played = data(await s.call("play_sound", { file: "a.wav" }));
    expect(played).toMatchObject({
      started: true,
      seconds: 1.6,
      motionSync: { setting: { id: "MS_Basic", name: "Mouth basic" }, source: "sound" },
    });
    const step = data(await s.call("advance_time", { seconds: 1 }));
    const sync = step.motionSync as {
      ticks: number;
      strongest: Record<string, number>;
      now: { weights: Record<string, number>; values: Record<string, number> };
    };
    expect(sync.ticks).toBe(60);
    expect(sync.strongest.A).toBeGreaterThan(30);
    expect(sync.now.weights.A).toBeGreaterThan(0.5);
    expect(sync.now.values.ParamMouthOpenY).toBeGreaterThan(0.5);
    // The sound ends and the mouth settles: motion sync stops.
    const after = data(await s.call("advance_time", { seconds: 1.5 }));
    expect((after.motionSync as { now: unknown }).now).toBeNull();
    const bad = await s.call("play_sound", { file: "a.wav", setting: "Nope" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('no motion-sync setting "Nope"');
    const outside = await s.call("play_sound", { file: "../../etc/passwd" });
    expect(outside.isError).toBe(true);
  });
});

describe.skipIf(!built)("the MCP server's allowed folders", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "mochi2d-mcp-roots-")));
    mkdirSync(join(tmp, "a"));
    mkdirSync(join(tmp, "b"));
    writeFileSync(join(tmp, "a", "x.model3.json"), "{}");
    writeFileSync(join(tmp, "b", "y.zip"), "");
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("are none without --root, MOCHI2D_ROOTS or the client's roots", async () => {
    const env = fullEnv();
    delete env.MOCHI2D_ROOTS;
    const c = await connect([], { env });
    try {
      expect(data(await c.call("list_models"))).toEqual({
        allowedFolders: [],
        models: [],
        truncated: false,
      });
      for (const path of [join(tmp, "a"), "a", "/"]) {
        const r = await c.call("load_model", { path });
        expect(r.isError, path).toBe(true);
        expect(text(r), path).toMatch(/no folders are allowed\. Start mochi2d-mcp with --root/);
      }
      expect(c.log()).toMatch(/none yet: pass --root or set MOCHI2D_ROOTS/);
    } finally {
      await c.client.close();
    }
  });

  it("come from MOCHI2D_ROOTS", async () => {
    const env = fullEnv({ MOCHI2D_ROOTS: [join(tmp, "a"), join(tmp, "b")].join(delimiter) });
    const c = await connect([], { env });
    try {
      expect(data(await c.call("list_models"))).toEqual({
        allowedFolders: [join(tmp, "a"), join(tmp, "b")],
        models: [
          { path: join(tmp, "a", "x.model3.json"), kind: "settings" },
          { path: join(tmp, "b", "y.zip"), kind: "zip" },
        ],
        truncated: false,
      });
    } finally {
      await c.client.close();
    }
  });

  it("follow the client's roots as they change", async () => {
    let roots = [join(tmp, "a"), join(tmp, "missing")];
    const env = fullEnv();
    delete env.MOCHI2D_ROOTS;
    const c = await connect([], { env, roots: () => roots });
    try {
      // A root that does not exist is left out.
      expect(data(await c.call("list_models")).allowedFolders).toEqual([join(tmp, "a")]);
      const outside = await c.call("validate_moc3", { path: join(tmp, "b", "y.zip") });
      expect(text(outside)).toMatch(/is outside the allowed folders/);
      roots = [join(tmp, "b")];
      await c.client.sendRootsListChanged();
      await expect
        .poll(async () => data(await c.call("list_models")).allowedFolders)
        .toEqual([join(tmp, "b")]);
    } finally {
      await c.client.close();
    }
  });
});

describe.skipIf(!built || !HAVE_DEEPSEEK)("the MCP server where rendering is not possible", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "mochi2d-mcp-norender-")));
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  async function renderError(server: string, env: Record<string, string>): Promise<string> {
    const c = await connect(["--root", DEEPSEEK], { server, env });
    try {
      data(await c.call("load_model", { path: DEEPSEEK }));
      const r = await c.call("render", { width: 64, height: 64 });
      expect(r.isError).toBe(true);
      // Everything else still works.
      expect(data(await c.call("hit_test", { x: 0, y: 0 })).drawable).toBe("ArtMesh479");
      return text(r);
    } finally {
      await c.client.close();
    }
  }

  it("says that the render harness is not built", async () => {
    // A copy of the server in a package folder without dist/web.
    const pkg = join(tmp, "pkg");
    mkdirSync(join(pkg, "dist", "tools"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{ "type": "module" }\n');
    copyFileSync(SERVER, join(pkg, "dist", "tools", "mochi2d-mcp.js"));
    const message = await renderError(join(pkg, "dist", "tools", "mochi2d-mcp.js"), fullEnv());
    expect(message).toMatch(/Rendering needs the render harness .* not built: run "npm run build"/);
  });

  it.skipIf(!haveHarness)("says that headless Chromium is not available", async () => {
    const message = await renderError(
      SERVER,
      fullEnv({
        PLAYWRIGHT_BROWSERS_PATH: join(tmp, "no-browsers"),
        MOCHI2D_CHROMIUM: join(tmp, "no-chromium"),
      }),
    );
    expect(message).toMatch(
      /^RenderUnavailable: Rendering needs headless Chromium through Playwright/,
    );
    expect(message).toMatch(/npx playwright install chromium/);
    expect(message).toMatch(/Everything else works without it\.$/);
  });
});

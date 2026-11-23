#!/usr/bin/env node
/**
 * mochi2d-mcp: Mochi2D as an MCP server over stdio, for AI agents
 * (docs/agent-api.md).
 *
 *   mochi2d-mcp [--root <folder>]...
 *
 * Models and `.moc3` files are read only under the allowed folders: the
 * --root options, else MOCHI2D_ROOTS (folders separated like PATH), else the
 * client's MCP roots; with none of them, nothing is read. Nothing is written
 * and nothing goes to the network; renders use headless Chromium on a local
 * page.
 */
import { errorFields, errorLine } from "./lib/agent/errors.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib/cli.js";
import { AllowedRoots } from "./lib/agent/paths.js";
import { AgentSession, FPS_RANGE, MAX_ADVANCE_SECONDS } from "./lib/agent/session.js";
import { parseBackground } from "./lib/agent/values.js";
import agentDoc from "../docs/agent-api.md";
import apiDoc from "../docs/api.md";
import llmsTxt from "../llms.txt";

declare const __MOCHI2D_VERSION__: string | undefined;
const VERSION = typeof __MOCHI2D_VERSION__ === "string" ? __MOCHI2D_VERSION__ : "dev";

const USAGE = `mochi2d-mcp ${VERSION}: Mochi2D's MCP server (stdio), for AI agents.

Usage: mochi2d-mcp [--root <folder>]...

Models and .moc3 files are read only under the allowed folders: the --root
options, else MOCHI2D_ROOTS (separated like PATH), else the client's roots.
Without any of them, nothing can be read. See docs/agent-api.md.`;

const INSTRUCTIONS =
  "Mochi2D runs Live2D Cubism models. list_models shows the allowed folders and the models in " +
  "them. Call load_model with a model folder, a *.model3.json file or a .zip under the allowed " +
  "folders, then describe_model for its parameters, parts, " +
  "expressions and motions. Change the pose with set_parameters, set_part_opacities, " +
  "play_expression and play_motion followed by advance_time, and look at it with render, " +
  "which returns a PNG. play_sound moves the mouth with a WAV file through the model's " +
  "motion-sync settings (Mochi2D's own analysis, approximate); advance_time then reports the " +
  "element weights. hit_test finds what lies at a point; validate_moc3 checks a .moc3 " +
  "file. Files are read only under the allowed folders; nothing is written; no network.";

// ----------------------------------------------------------------- roots

function explicitRoots(argv: string[]): string[] {
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--root") {
      const v = argv[++i];
      if (!v) throw new Error("--root needs a folder");
      roots.push(v);
    } else if (a.startsWith("--root=")) roots.push(a.slice("--root=".length));
    else throw new Error(`Unknown argument ${a}\n\n${USAGE}`);
  }
  if (roots.length === 0 && process.env.MOCHI2D_ROOTS)
    roots.push(...process.env.MOCHI2D_ROOTS.split(delimiter).filter(Boolean));
  return roots;
}

// --------------------------------------------------------------- results

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const ok = (value: Record<string, unknown>, extra: Content[] = []) => ({
  content: [...extra, { type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

/** An error result: its name and message, and its typed fields (errors.ts) as structured content. */
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: errorLine(e) }],
  structuredContent: { error: errorFields(e) },
  isError: true,
});

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(USAGE + "\n");
    return;
  }
  if (argv.includes("--version")) {
    process.stderr.write(VERSION + "\n");
    return;
  }
  const fixed = explicitRoots(argv);
  // Without --root or MOCHI2D_ROOTS, nothing is allowed until the client shares its roots.
  const session = new AgentSession(await AllowedRoots.create(fixed), repoRoot());
  const server = new McpServer(
    { name: "mochi2d", title: "Mochi2D", version: VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );

  // Without --root or MOCHI2D_ROOTS, the client's roots (if it has any) decide.
  let rootsReady: Promise<void> = Promise.resolve();
  const refreshRoots = () => {
    rootsReady = (async () => {
      try {
        const { roots } = await server.server.listRoots();
        const paths = roots
          .filter((r) => r.uri.startsWith("file:"))
          .map((r) => fileURLToPath(r.uri));
        // The client's current list replaces the previous one; folders that do not exist are left out.
        session.roots = await AllowedRoots.create(paths, process.cwd(), { missing: "skip" });
      } catch (e) {
        process.stderr.write(`mochi2d-mcp: could not read the client's roots: ${String(e)}\n`);
      }
    })();
  };
  if (fixed.length === 0) {
    server.server.oninitialized = () => {
      if (server.server.getClientCapabilities()?.roots) refreshRoots();
    };
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () =>
      refreshRoots(),
    );
  }

  const tool = <A>(
    name: string,
    config: { title: string; description: string; inputSchema?: z.ZodRawShape },
    run: (args: A) => Promise<Record<string, unknown> | ReturnType<typeof ok>>,
    readOnly = false,
  ) =>
    server.registerTool(
      name,
      {
        ...config,
        annotations: { readOnlyHint: readOnly, openWorldHint: false, destructiveHint: false },
      },
      (async (args: A) => {
        try {
          await rootsReady;
          const r = await run(args);
          return "content" in r ? r : ok(r);
        } catch (e) {
          return fail(e);
        }
      }) as never,
    );

  const view = z
    .object({
      x: z.number().describe("Model-space x at the image center (model units)"),
      y: z.number().describe("Model-space y at the image center (model units, y up)"),
      pixelsPerUnit: z.number().positive().describe("Image pixels per model unit"),
    })
    .describe("The view; default: the model's canvas fitted into the image");

  tool<{ folder?: string }>(
    "list_models",
    {
      title: "List models",
      description:
        "The allowed folders, and the models in them: *.model3.json files and .zip archives " +
        "(at most 200; dotfiles and node_modules are skipped). Give a folder to look only there.",
      inputSchema: {
        folder: z.string().optional().describe("A folder inside the allowed folders; default all"),
      },
    },
    async (a) => session.listModels(a.folder),
    true,
  );

  tool<{
    path: string;
    seed?: number;
    effects?: Record<string, boolean>;
    fileSmoothing?: boolean;
  }>(
    "load_model",
    {
      title: "Load a model",
      description:
        "Loads a Live2D Cubism model: its folder, its *.model3.json file or a .zip of the " +
        "folder (under the allowed folders; relative paths start at the first one). It " +
        "replaces the loaded model. Returns a summary; describe_model gives the details.",
      inputSchema: {
        path: z.string().describe("A model folder, a *.model3.json file or a .zip"),
        seed: z
          .number()
          .int()
          .optional()
          .describe("Seed of eye blinks and idle motions (default 1)"),
        effects: z
          .record(z.string(), z.boolean())
          .optional()
          .describe(
            "Switch components on or off: physics, eyeBlink, breath, look, idle, lipSync, pose, expressions, motionSync",
          ),
        fileSmoothing: z
          .boolean()
          .optional()
          .describe(
            "Motion sync: also apply the motion-sync file's per-parameter Smooth (default false)",
          ),
      },
    },
    async (a) => ({
      loaded: await session.load(a.path, {
        seed: a.seed,
        effects: a.effects,
        ...(a.fileSmoothing !== undefined ? { fileSmoothing: a.fileSmoothing } : {}),
      }),
    }),
  );

  tool(
    "describe_model",
    {
      title: "Describe the model",
      description:
        "The loaded model: parameters (IDs, display names, groups, ranges, defaults, current " +
        "values, and for parameters physics overwrites, the physicsInputs to set instead), " +
        "parts and their opacities, drawable counts, expressions, motions, physics (what it " +
        "overwrites, and which parameters look writes), pose, hit areas and the components " +
        "that run.",
    },
    async () => session.describe(),
    true,
  );

  tool<{ ids?: string[] }>(
    "get_parameters",
    {
      title: "Get parameters",
      description:
        "Parameter values with their ranges (all, or the given IDs): `value` is the latest " +
        "frame's, with motions, expressions, physics and other effects applied; `base` is " +
        "the base value that set_parameters sets (motions also leave their results in it).",
      inputSchema: { ids: z.array(z.string()).optional().describe("Parameter IDs; default all") },
    },
    async (a) => session.getParameters(a.ids),
    true,
  );

  tool<{ values: Record<string, number> }>(
    "set_parameters",
    {
      title: "Set parameters",
      description:
        "Sets parameters' base values (limited to their ranges). Motions, expressions, " +
        "physics and other components still apply on top. While physics runs, a parameter " +
        "it overwrites follows its physics inputs instead (physicsInputs in describe_model): " +
        "the result's physicsOverwrites lists such parameters and the inputs to set instead.",
      inputSchema: {
        values: z.record(z.string(), z.number()).describe("Parameter ID → value"),
      },
    },
    async (a) => session.setParameters(a.values),
  );

  tool<{ ids?: string[] }>(
    "get_part_opacities",
    {
      title: "Get part opacities",
      description: "Current part opacities, 0–1 (all, or the given part IDs).",
      inputSchema: { ids: z.array(z.string()).optional().describe("Part IDs; default all") },
    },
    async (a) => session.getPartOpacities(a.ids),
    true,
  );

  tool<{ values: Record<string, number> }>(
    "set_part_opacities",
    {
      title: "Set part opacities",
      description: "Sets part opacities (0–1). A pose file may override parts it controls.",
      inputSchema: { values: z.record(z.string(), z.number()).describe("Part ID → opacity") },
    },
    async (a) => session.setPartOpacities(a.values),
  );

  tool<{ expression: string | null; mode?: "replace" | "add" | "remove" }>(
    "play_expression",
    {
      title: "Play an expression",
      description:
        "Starts an expression by its name in the settings or by its file path (relative to " +
        "the settings file); null fades the current one out. Mode add shows it on top of the " +
        "others (several at once), and remove fades an added one out (null: all added ones). " +
        "Expressions fade in and out over time: call advance_time.",
      inputSchema: {
        expression: z.string().nullable().describe("A settings name, a *.exp3.json path, or null"),
        mode: z
          .enum(["replace", "add", "remove"])
          .optional()
          .describe(
            "replace (default) the current expression, add one on top, or remove an added one",
          ),
      },
    },
    async (a) => session.playExpression(a.expression, a.mode ?? "replace"),
  );

  tool<{
    group?: string;
    index?: number;
    file?: string;
    priority?: number;
    loop?: boolean;
    hold?: boolean;
    blinkWhileHeld?: boolean;
  }>(
    "play_motion",
    {
      title: "Play a motion",
      description:
        "Starts a motion: a group of the settings (with an index, else a random one) or a " +
        "motion file (relative to the settings file). It plays as time advances: call " +
        "advance_time. A motion of higher priority can refuse it (started: false).",
      inputSchema: {
        group: z.string().optional().describe("A motion group of the settings"),
        index: z.number().int().min(0).optional().describe("The motion's index in its group"),
        file: z.string().optional().describe("A *.motion3.json path instead of a group"),
        priority: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe("1 idle, 2 normal (default), 3 force"),
        loop: z.boolean().optional().describe("Loop the motion (default false)"),
        hold: z
          .boolean()
          .optional()
          .describe(
            "Keep the last frame until the next motion or reset (default false; not with loop)",
          ),
        blinkWhileHeld: z
          .boolean()
          .optional()
          .describe("With hold: eye blink runs once the motion is at its end (default true)"),
      },
    },
    async (a) =>
      session.playMotion({
        ...(a.group !== undefined ? { group: a.group } : {}),
        ...(a.index !== undefined ? { index: a.index } : {}),
        ...(a.file !== undefined ? { file: a.file } : {}),
        ...(a.priority !== undefined ? { priority: a.priority as 1 | 2 | 3 } : {}),
        ...(a.loop !== undefined ? { loop: a.loop } : {}),
        ...(a.hold !== undefined ? { hold: a.hold } : {}),
        ...(a.blinkWhileHeld !== undefined ? { blinkWhileHeld: a.blinkWhileHeld } : {}),
      }),
  );

  tool<{ file: string; setting?: string }>(
    "play_sound",
    {
      title: "Play a sound through motion sync",
      description:
        "Moves the mouth with a WAV file (relative to the settings file) through a setting of " +
        "the model's motion-sync file (its .motionsync3.json): Mochi2D's own analysis, " +
        "approximate. Nothing is played aloud. The mouth moves as time advances: call " +
        "advance_time, which reports how often each element (Silence, A, I, U, E, O) was the " +
        "strongest. A motion whose settings entry links a sound and a setting does the same.",
      inputSchema: {
        file: z.string().describe("A WAV file, relative to the settings file"),
        setting: z
          .string()
          .optional()
          .describe("The setting's name or ID (default: the first that can run)"),
      },
    },
    async (a) =>
      session.playSound({
        file: a.file,
        ...(a.setting !== undefined ? { setting: a.setting } : {}),
      }),
  );

  tool<{ seconds: number; fps?: number }>(
    "advance_time",
    {
      title: "Advance time",
      description:
        "Runs the animation (motions, expressions, physics, eye blink, breath…) for some " +
        "seconds at a frame rate. Returns the motion events, the motions that ended and why " +
        "(finished, replaced, stopped), what still plays, and with motion sync, how often " +
        "each element was the strongest and the latest weights.",
      inputSchema: {
        seconds: z.number().min(0).max(MAX_ADVANCE_SECONDS).describe("Seconds to advance"),
        fps: z
          .number()
          .min(FPS_RANGE[0])
          .max(FPS_RANGE[1])
          .optional()
          .describe("Frames per second (default 60)"),
      },
    },
    async (a) => session.advance(a.seconds, a.fps ?? 60),
  );

  tool(
    "reset",
    {
      title: "Reset",
      description: "Back to the state right after load_model: default pose, nothing playing.",
    },
    async () => ({ reset: await session.reset() }),
  );

  tool<{
    width?: number;
    height?: number;
    view?: { x: number; y: number; pixelsPerUnit: number };
    background?: string | number[];
    alpha?: "straight" | "premultiplied";
    maxTextureSize?: number;
  }>(
    "render",
    {
      title: "Render",
      description:
        "Renders the current pose to a PNG image (returned as an image, so you can see it), " +
        "with headless Chromium. Default 512×512 on white, the canvas fitted in. Needs " +
        "Playwright's Chromium; if it is missing the error says how to install it.",
      inputSchema: {
        width: z.number().int().min(16).max(4096).optional().describe("Pixels (default 512)"),
        height: z.number().int().min(16).max(4096).optional().describe("Pixels (default 512)"),
        view: view.optional(),
        background: z
          .union([z.string(), z.array(z.number().min(0).max(1)).length(4)])
          .optional()
          .describe('"transparent", a #hex color, or [r, g, b, a] in 0–1 (default white)'),
        alpha: z
          .enum(["straight", "premultiplied"])
          .optional()
          .describe("Alpha convention of the PNG (default straight)"),
        maxTextureSize: z
          .number()
          .int()
          .min(64)
          .max(8192)
          .optional()
          .describe(
            "A faster preview, not the reference render: textures downscaled to at most this " +
              "many pixels (for example 1024), and the viewer's mask atlas",
          ),
      },
    },
    async (a) => {
      const background = Array.isArray(a.background)
        ? (a.background as [number, number, number, number])
        : a.background !== undefined
          ? parseBackground(a.background)
          : undefined;
      const r = await session.render({
        ...(a.width !== undefined ? { width: a.width } : {}),
        ...(a.height !== undefined ? { height: a.height } : {}),
        ...(a.view ? { view: a.view } : {}),
        ...(background ? { background } : {}),
        ...(a.alpha ? { alpha: a.alpha } : {}),
        ...(a.maxTextureSize !== undefined ? { maxTextureSize: a.maxTextureSize } : {}),
      });
      return ok(
        {
          width: r.width,
          height: r.height,
          ...(r.pixelsPerUnit !== undefined ? { pixelsPerUnit: r.pixelsPerUnit } : {}),
          ...(r.center ? { center: r.center } : {}),
          renderer: r.renderer,
          notes: r.notes,
        },
        [{ type: "image", data: Buffer.from(r.png).toString("base64"), mimeType: "image/png" }],
      );
    },
    true,
  );

  tool<{
    x: number;
    y: number;
    space?: "model" | "pixels";
    width?: number;
    height?: number;
    view?: { x: number; y: number; pixelsPerUnit: number };
  }>(
    "hit_test",
    {
      title: "Hit test",
      description:
        "What lies at a point: the settings' hit areas whose drawable's bounding box contains " +
        "it, and the topmost visible drawable whose bounding box contains it. The point is in " +
        'model units (y up), or with space "pixels" in image pixels (from the top-left corner) ' +
        "of a render of that size and view.",
      inputSchema: {
        x: z.number(),
        y: z.number(),
        space: z.enum(["model", "pixels"]).optional().describe('Default "model"'),
        width: z.number().int().min(16).max(4096).optional(),
        height: z.number().int().min(16).max(4096).optional(),
        view: view.optional(),
      },
    },
    async (a) => session.hitTest(a),
    true,
  );

  tool<{
    deformer?: string;
    drawable?: string;
    points: [number, number][];
    space?: "model" | "keyform";
    jacobian?: boolean;
  }>(
    "map_points",
    {
      title: "Map points through a deformer",
      description:
        "The forward mapping at the current pose: points from a deformer's input space (a " +
        "warp's normalized grid, 0 to 1 inside; a rotation's local space) to model units, " +
        "exactly as the evaluator maps vertices, outside a warp's grid too. Give a deformer " +
        "ID, or a drawable ID to map from that drawable's keyform space through its parent " +
        "deformer. Returns the points, the deformer chain to the root, and with jacobian the " +
        "2×2 Jacobian [dx/dpx, dx/dpy, dy/dpx, dy/dpy] at each point.",
      inputSchema: {
        deformer: z.string().optional().describe("A deformer ID"),
        drawable: z.string().optional().describe("Or a drawable ID: its parent deformer"),
        points: z
          .array(z.tuple([z.number(), z.number()]))
          .max(10_000)
          .describe("Points [x, y] in the deformer's input space"),
        space: z
          .enum(["model", "keyform"])
          .optional()
          .describe(
            '"model" (default): model units, y up; "keyform": y down, as keyform positions',
          ),
        jacobian: z.boolean().optional().describe("Also return the Jacobian (default false)"),
      },
    },
    async (a) => session.mapPoints(a),
    true,
  );

  tool<{ path: string; strict?: boolean }>(
    "validate_moc3",
    {
      title: "Validate a .moc3 file",
      description:
        "Checks a .moc3 file the way Mochi2D loads it (under the allowed folders): valid or " +
        "not, the reasons, and load warnings. With strict, draw orders outside their group's " +
        "range are errors too.",
      inputSchema: {
        path: z.string().describe("A .moc3 file"),
        strict: z.boolean().optional(),
      },
    },
    async (a) => session.validateMoc3(a.path, a.strict ?? false),
    true,
  );

  // ------------------------------------------------------------ resources

  server.registerResource(
    "model",
    "mochi2d://model",
    {
      title: "The loaded model",
      description: "describe_model of the loaded model, as JSON",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            session.hasModel
              ? session.describe()
              : {
                  loaded: false,
                  allowedFolders: session.roots.real,
                  hint: "Call list_models, then load_model with a model folder, model3.json or zip.",
                },
            null,
            2,
          ),
        },
      ],
    }),
  );
  for (const [name, uri, title, text, mimeType] of [
    ["agent-api", "mochi2d://docs/agent-api", "Mochi2D agent API", agentDoc, "text/markdown"],
    ["api", "mochi2d://docs/api", "Mochi2D library API", apiDoc, "text/markdown"],
    ["llms", "mochi2d://docs/llms.txt", "Mochi2D for language models", llmsTxt, "text/plain"],
  ] as const)
    server.registerResource(name, uri, { title, mimeType }, async (u) => ({
      contents: [{ uri: u.href, mimeType, text }],
    }));

  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await session.close().catch(() => {});
    process.exit(0);
  };
  transport.onclose = () => void shutdown();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("end", () => void shutdown());
  await server.connect(transport);
  process.stderr.write(
    `mochi2d-mcp ${VERSION}: ready; ` +
      (fixed.length
        ? `reading models under ${session.roots.real.join(", ")}`
        : "reading models under the client's roots (none yet: pass --root or set MOCHI2D_ROOTS " +
          "if the client has none)") +
      "\n",
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`mochi2d-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

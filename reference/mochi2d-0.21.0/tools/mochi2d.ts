#!/usr/bin/env node
/**
 * mochi2d: Mochi2D's headless command line, with the operations of the MCP
 * server (docs/agent-api.md) for scripts.
 *
 *   mochi2d list     <folder> [--json]
 *   mochi2d describe <model> [--json]
 *   mochi2d params   <model> [state options] [--ids a,b] [--json]
 *   mochi2d render   <model> [state options] --out <file.png> [--size WxH] [--view x,y,ppu]
 *                            [--background color] [--alpha straight|premultiplied]
 *   mochi2d hit-test <model> --at <x,y> [--pixels] [--size WxH] [--view x,y,ppu] [state options] [--json]
 *   mochi2d validate <file.moc3> [--strict] [--json]
 *
 * It reads only the model (or file) it is given and writes only --out.
 */
import { stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs, repoRoot } from "./lib/cli.js";
import { AllowedRoots } from "./lib/agent/paths.js";
import { AgentSession } from "./lib/agent/session.js";
import { RenderUnavailableError } from "./lib/agent/render.js";
import {
  parseAssignments,
  parseBackground,
  parseMotion,
  parsePoint,
  parseSize,
  parseView,
} from "./lib/agent/values.js";

declare const __MOCHI2D_VERSION__: string | undefined;
const VERSION = typeof __MOCHI2D_VERSION__ === "string" ? __MOCHI2D_VERSION__ : "dev";

const USAGE = `mochi2d ${VERSION}: Mochi2D's headless command line (docs/agent-api.md).

Usage:
  mochi2d list     <folder> [--json]
  mochi2d describe <model> [--json]
  mochi2d params   <model> [state options] [--ids ID,ID] [--json]
  mochi2d render   <model> [state options] --out <file.png> [--size WxH] [--view x,y,ppu]
                           [--background transparent|#rrggbb|r,g,b,a] [--alpha straight|premultiplied]
                           [--fast | --fast=MAX]
  mochi2d hit-test <model> --at x,y [--pixels] [--size WxH] [--view x,y,ppu] [state options] [--json]
  mochi2d validate <file.moc3> [--strict] [--json]

list finds models (*.model3.json files and .zip archives) in a folder.
<model> is a model folder, a *.model3.json file or a .zip of the folder.

State options, applied in this order:
  --seed N               random seed of eye blinks and idle motions (default 1)
  --effects a=on,b=off   physics, eyeBlink, breath, look, idle, lipSync, pose, expressions, motionSync
  --file-smoothing       motion sync: also apply the motion-sync file's per-parameter Smooth
  --params ID=V,...      parameter base values
  --parts ID=V,...       part opacities (0-1)
  --expression NAME      an expression by settings name or file path
  --motion GROUP[:I]|F   a motion of a settings group, or a *.motion3.json file
  --time SECONDS         advance the animation (with --fps N, default 60)

render needs headless Chromium through Playwright; everything else works without it.
render --fast is a quicker preview, not the reference render: textures downscaled
to at most MAX pixels (default 1024) and the viewer's mask atlas.`;

const FLAGS = ["json", "strict", "pixels", "help", "version", "fast", "file-smoothing"];
const COMMANDS = ["list", "describe", "params", "render", "hit-test", "validate"];

function out(json: boolean, value: unknown, text: () => string): void {
  process.stdout.write((json ? JSON.stringify(value, null, 2) : text()) + "\n");
}

/** Roots for one model given on the command line: its folder (or the zip, or the file). */
async function rootsFor(path: string): Promise<AllowedRoots> {
  const full = resolve(path);
  const st = await stat(full).catch(() => null);
  if (!st) throw new Error(`${full} does not exist.`);
  const root = st.isFile() && /\.model3\.json$/i.test(full) ? dirname(full) : full;
  return AllowedRoots.create([root]);
}

async function applyState(session: AgentSession, o: Record<string, string | true>): Promise<void> {
  if (typeof o.params === "string") {
    const r = session.setParameters(parseAssignments(o.params, "--params"));
    if (r.unknown.length) process.stderr.write(`Unknown parameters: ${r.unknown.join(", ")}\n`);
  }
  if (typeof o.parts === "string") {
    const r = session.setPartOpacities(parseAssignments(o.parts, "--parts"));
    if (r.unknown.length) process.stderr.write(`Unknown parts: ${r.unknown.join(", ")}\n`);
  }
  if (typeof o.expression === "string") await session.playExpression(o.expression);
  if (typeof o.motion === "string") {
    const r = await session.playMotion(parseMotion(o.motion));
    if (!r.started) process.stderr.write(`The motion ${o.motion} did not start.\n`);
  }
  const seconds = numberOption(o, "time");
  if (seconds !== undefined) session.advance(seconds, numberOption(o, "fps") ?? 60);
}

/** A numeric option, or undefined when it is not given. */
function numberOption(o: Record<string, string | true>, name: string): number | undefined {
  const v = o[name];
  if (v === undefined) return undefined;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n))
    throw Object.assign(new Error(`--${name} needs a number.`), { usage: true });
  return n;
}

function effectsOption(text: string | true | undefined): Record<string, boolean> | undefined {
  if (typeof text !== "string") return undefined;
  const out: Record<string, boolean> = {};
  for (const item of text.split(",")) {
    const [name, value] = item.split("=").map((s) => s.trim());
    if (!name || !/^(on|off|true|false|1|0)$/i.test(value ?? ""))
      throw new Error(`--effects: "${item}" is not name=on|off.`);
    out[name] = /^(on|true|1)$/i.test(value!);
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), FLAGS);
  const [command, target] = args.positional;
  const o = args.options;
  if (o.version) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (!command || o.help || command === "help") {
    process.stdout.write(USAGE + "\n");
    return command || o.help ? 0 : 2;
  }
  if (!COMMANDS.includes(command))
    throw Object.assign(new Error(`Unknown command "${command}".\n\n${USAGE}`), { usage: true });
  if (!target)
    throw Object.assign(new Error(`${command} needs a path.\n\n${USAGE}`), { usage: true });
  const json = o.json === true;
  const session = new AgentSession(await rootsFor(target), repoRoot());
  try {
    switch (command) {
      case "list": {
        const r = await session.listModels();
        out(json, r, () =>
          [
            ...r.models.map((m) => `${m.kind}\t${m.path}`),
            ...(r.truncated ? ["(more not listed)"] : []),
          ].join("\n"),
        );
        return 0;
      }
      case "validate": {
        const r = await session.validateMoc3(resolve(target), o.strict === true);
        out(json, r, () =>
          r.valid
            ? `valid: moc3 version ${r.version as number}` +
              ((r.warnings as string[]).length
                ? `\nwarnings:\n  ${(r.warnings as string[]).join("\n  ")}`
                : "")
            : `invalid:\n  ${(r.reasons as string[]).join("\n  ")}`,
        );
        return r.valid ? 0 : 1;
      }
      case "describe": {
        await load(session, target, o);
        const d = session.describe();
        out(json, d, () => describeText(d));
        return 0;
      }
      case "params": {
        await load(session, target, o);
        const ids = typeof o.ids === "string" ? o.ids.split(",").map((s) => s.trim()) : undefined;
        const r = session.getParameters(ids);
        out(json, r, () =>
          [
            // The base value too where effects or physics change what is drawn.
            ...r.parameters.map(
              (p) =>
                `${p.id}\t${p.value}\t[${p.min}, ${p.max}]\t${p.name}` +
                (p.base !== p.value ? `\tbase ${p.base}` : ""),
            ),
            ...(r.unknown.length ? [`unknown: ${r.unknown.join(", ")}`] : []),
          ].join("\n"),
        );
        return r.unknown.length ? 1 : 0;
      }
      case "render": {
        if (typeof o.out !== "string")
          throw Object.assign(new Error("render needs --out <file.png>"), { usage: true });
        await load(session, target, o);
        const [width, height] = typeof o.size === "string" ? parseSize(o.size) : [512, 512];
        const r = await session.render({
          width,
          height,
          ...(typeof o.view === "string" ? { view: parseView(o.view) } : {}),
          ...(typeof o.background === "string"
            ? { background: parseBackground(o.background) }
            : {}),
          ...(o.alpha === "premultiplied" || o.alpha === "straight" ? { alpha: o.alpha } : {}),
          ...(o.fast !== undefined
            ? { maxTextureSize: typeof o.fast === "string" ? Number(o.fast) : 1024 }
            : {}),
        });
        const file = resolve(o.out);
        await writeFile(file, r.png);
        const info = {
          out: file,
          width: r.width,
          height: r.height,
          pixelsPerUnit: r.pixelsPerUnit,
          center: r.center,
          notes: r.notes,
        };
        out(json, info, () => `${file}: ${r.width}×${r.height}`);
        return 0;
      }
      case "hit-test": {
        if (typeof o.at !== "string")
          throw Object.assign(new Error("hit-test needs --at x,y"), { usage: true });
        await load(session, target, o);
        const [x, y] = parsePoint(o.at);
        const [width, height] = typeof o.size === "string" ? parseSize(o.size) : [512, 512];
        const r = session.hitTest({
          x,
          y,
          space: o.pixels === true ? "pixels" : "model",
          width,
          height,
          ...(typeof o.view === "string" ? { view: parseView(o.view) } : {}),
        });
        out(json, r, () => {
          const areas = r.hitAreas as string[];
          return `at (${(r.model as number[]).join(", ")}): hit areas ${areas.length ? areas.join(", ") : "none"}; topmost drawable ${(r.drawable as string | null) ?? "none"}`;
        });
        return 0;
      }
      default:
        throw Object.assign(new Error(`Unknown command "${command}".\n\n${USAGE}`), {
          usage: true,
        });
    }
  } finally {
    await session.close();
  }
}

/** Loads the model and applies the state options. */
async function load(
  session: AgentSession,
  target: string,
  o: Record<string, string | true>,
): Promise<void> {
  const seed = numberOption(o, "seed");
  const effects = effectsOption(o.effects);
  await session.load(resolve(target), {
    ...(seed !== undefined ? { seed } : {}),
    ...(effects ? { effects } : {}),
    ...(o["file-smoothing"] === true ? { fileSmoothing: true } : {}),
  });
  await applyState(session, o);
}

function describeText(d: Record<string, unknown>): string {
  const params = d.parameters as {
    id: string;
    name: string;
    min: number;
    max: number;
    default: number;
    value: number;
  }[];
  const parts = d.parts as { id: string; name: string; opacity: number }[];
  const ex = d.expressions as { named: string[]; files: string[] };
  const mo = d.motions as { groups: { name: string; motions: string[] }[]; files: string[] };
  const phys = d.physics as { present: boolean; settings?: number };
  const lines = [
    `${d.settings as string} (moc3 v${d.mocVersion as number}): ${params.length} parameters, ` +
      `${parts.length} parts, ${(d.drawables as { count: number }).count} drawables`,
    `physics: ${phys.present ? `${phys.settings} settings` : "none"}; pose: ${d.pose ? "yes" : "no"}; ` +
      `eye blink: ${d.eyeBlink ? "yes" : "no"}; lip sync: ${d.lipSync ? "yes" : "no"}`,
    `expressions: ${ex.named.length ? ex.named.join(", ") : "(none named)"}` +
      (ex.files.length ? `; files: ${ex.files.join(", ")}` : ""),
    `motions: ${mo.groups.length ? mo.groups.map((g) => `${g.name} (${g.motions.length})`).join(", ") : "(no groups)"}` +
      (mo.files.length ? `; files: ${mo.files.join(", ")}` : ""),
    `hit areas: ${(d.hitAreas as { name: string }[]).map((h) => h.name).join(", ") || "none"}`,
    "parameters (ID, value, range, default, name):",
    ...params.map((p) => `  ${p.id}\t${p.value}\t[${p.min}, ${p.max}]\t${p.default}\t${p.name}`),
    "parts (ID, opacity, name):",
    ...parts.map((p) => `  ${p.id}\t${p.opacity}\t${p.name}`),
  ];
  const warnings = d.warnings as string[];
  if (warnings.length) lines.push("warnings:", ...warnings.map((w) => `  ${w}`));
  return lines.join("\n");
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    const usage = (e as { usage?: boolean }).usage === true;
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`mochi2d: ${message}\n`);
    process.exitCode = e instanceof RenderUnavailableError ? 3 : usage ? 2 : 1;
  },
);

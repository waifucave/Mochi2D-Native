/**
 * One crafted-file case in a fresh process, so that its peak memory can be
 * measured (test/texture-limits.test.ts bundles and runs this file).
 *
 * Texture cases render the sample «Mochi» with a crafted texture through a
 * NodeRenderer (its own headless Chromium), from a folder, a zip or a URL.
 * The peak resident memory (VmHWM) of every Chromium process is read just
 * before the case's render and after it; their rises are summed. The other
 * cases run a loader in this process and report its own peak's rise.
 *
 * Prints one line of JSON. Usage: node child.mjs <case> <repo root>
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { NodeRenderer } from "../../src/lib/node-render.js";
import { HttpFileSource } from "../../src/platform/browser-sources.js";
import type { TextureLimits } from "../../src/core/image/texture-limits.js";
import { decodeWav } from "../../src/anim/lip-sync.js";
import { decodeMotionSyncWav } from "../../src/anim/motion-sync/wav.js";
import { parseMotion } from "../../src/anim/motion.js";
import { parsePhysics } from "../../src/anim/physics.js";
import { loadMoc } from "../../src/core/moc/model.js";
import { craftPng, pngWithData } from "./texture-bombs.js";

const [name = "", root = ""] = process.argv.slice(2);
const MiB = 2 ** 20;

/** Peak resident memory of each descendant process of this one, by pid (bytes). */
function descendantPeaks(): Map<number, number> {
  const parent = new Map<number, number>();
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const stat = readFileSync(`/proc/${p}/stat`, "latin1");
      parent.set(Number(p), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      // gone
    }
  }
  const mine = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, pp] of parent)
      if (!mine.has(pid) && mine.has(pp)) {
        mine.add(pid);
        grew = true;
      }
  }
  mine.delete(process.pid);
  const out = new Map<number, number>();
  for (const pid of mine) {
    try {
      const m = /VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "latin1"));
      if (m) out.set(pid, Number(m[1]) * 1024);
    } catch {
      // gone
    }
  }
  return out;
}

const ownPeak = () => process.resourceUsage().maxRSS * 1024;

function describe(e: unknown): Record<string, unknown> {
  const err = e as Error & Record<string, unknown>;
  return {
    name: err.name,
    message: String(err.message).split("\n")[0],
    kind: err.kind,
    limit: err.limit,
    size: err.size,
    path: err.path,
    width: err.width,
    height: err.height,
  };
}

/** A copy of the sample model whose texture list is `textures` (written beside the settings). */
function modelDir(textures: Uint8Array[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mochi2d-tex-"));
  cpSync(join(root, "samples/mochi"), dir, { recursive: true });
  const settingsPath = join(dir, "mochi.model3.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.FileReferences.Textures = textures.map((_, i) => `crafted_${i}.png`);
  writeFileSync(settingsPath, JSON.stringify(settings));
  textures.forEach((t, i) => writeFileSync(join(dir, `crafted_${i}.png`), t));
  return dir;
}

function zipOf(dir: string): string {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string, prefix: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`);
      else files[`mochi/${prefix}${e.name}`] = readFileSync(join(d, e.name));
    }
  };
  walk(dir, "");
  const path = join(dir, "..", `${dir.split("/").pop()}.zip`);
  writeFileSync(path, zipSync(files, { level: 0 }));
  return path;
}

interface TextureCase {
  textures: Uint8Array[];
  limits?: TextureLimits;
  fast?: boolean;
  via?: "folder" | "zip" | "url";
}

function textureCase(): TextureCase | null {
  const [kind, via] = name.split(":") as [string, TextureCase["via"]];
  const huge = () => craftPng({ width: 20000, height: 20000 });
  switch (kind) {
    // 20,000 × 20,000 declared, honestly, in a file of about 400 KB: over the side cap.
    case "huge":
      return { textures: [huge()], via: via ?? "folder" };
    // Each texture is 8192² (2²⁶ pixels), under the caps; three pass a total of 2²⁷.
    case "total": {
      const t = craftPng({ width: 8192, height: 8192 });
      return { textures: [t, t, t], limits: { maxTotalPixels: 2 ** 27 } };
    }
    // A header declaring 20,000² with 1 KB of image data: too little to hold it.
    case "lie-big-tiny":
      return { textures: [pngWithData(20000, 20000, 1024)] };
    // A header declaring 8192² whose data holds 120 rows of noise (enough bytes
    // to pass the header check, not enough rows): the decode fails.
    case "lie-big-rows":
      return {
        textures: [craftPng({ width: 8192, height: 8192, rows: 120, fill: "noise" })],
        fast: true,
      };
    // A header declaring 64 × 16 whose data holds 64 × 4096: decoded at 64 × 16.
    case "lie-small":
      return { textures: [craftPng({ width: 64, height: 16, rows: 4096, fill: "noise" })] };
    // 8000² honest, no caps, a fast render (downscaled): what decoding costs.
    case "uncapped":
      return {
        textures: [craftPng({ width: 8000, height: 8000 })],
        limits: { maxSide: Infinity, maxPixels: Infinity, maxTotalPixels: Infinity },
        fast: true,
      };
    // The same file under the caps recommended for strangers' models: refused.
    case "stranger":
      return {
        textures: [craftPng({ width: 8000, height: 8000 })],
        limits: { maxSide: 4096 },
        fast: true,
      };
    default:
      return null;
  }
}

async function runTexture(c: TextureCase): Promise<Record<string, unknown>> {
  const dir = modelDir(c.textures);
  const renderer = await NodeRenderer.open({ webDir: join(root, "dist/web") });
  const server = createServer((req, res) => {
    try {
      res.end(readFileSync(join(dir, decodeURIComponent(new URL(req.url!, "http://x").pathname))));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  try {
    // Warm up on the genuine sample, so the case's rise is the case's own.
    await renderer.render(join(root, "samples/mochi/mochi.model3.json"), { width: 64, height: 64 });
    const before = descendantPeaks();
    const t0 = performance.now();
    let error: Record<string, unknown> | undefined;
    let rendered: string | undefined;
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const input =
      c.via === "zip"
        ? zipOf(dir)
        : c.via === "url"
          ? {
              source: new HttpFileSource(`http://127.0.0.1:${port}/`, "url"),
              settings: "mochi.model3.json",
            }
          : join(dir, "mochi.model3.json");
    try {
      const r = await renderer.render(input, {
        width: 64,
        height: 64,
        ...(c.limits ? { textures: c.limits } : {}),
        ...(c.fast ? { fast: true } : {}),
      });
      rendered = `${r.width}x${r.height}`;
    } catch (e) {
      error = describe(e);
    }
    const ms = performance.now() - t0;
    const after = descendantPeaks();
    let browserRise = 0;
    for (const [pid, peak] of after) browserRise += Math.max(0, peak - (before.get(pid) ?? 0));
    return { error, rendered, ms, browserRise };
  } finally {
    server.close();
    await renderer.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function riff(chunks: [string, Uint8Array][]): Uint8Array {
  const body = chunks.reduce((n, [, d]) => n + 8 + d.length, 4);
  const out = new Uint8Array(8 + body);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  dv.setUint32(4, body, true);
  out.set(new TextEncoder().encode("WAVE"), 8);
  let o = 12;
  for (const [id, d] of chunks) {
    out.set(new TextEncoder().encode(id), o);
    dv.setUint32(o + 4, d.length, true);
    out.set(d, o + 8);
    o += 8 + d.length;
  }
  return out;
}

/** The other file kinds: a loader on a crafted file in this process. */
function otherCase(): (() => unknown) | null {
  switch (name) {
    // A WAV whose data chunk declares 4 GiB, in a 1 KB file.
    case "wav-length": {
      const fmt = new Uint8Array(16);
      const dv = new DataView(fmt.buffer);
      dv.setUint16(0, 1, true);
      dv.setUint16(2, 1, true);
      dv.setUint32(4, 16000, true);
      dv.setUint16(14, 16, true);
      const wav = riff([
        ["fmt ", fmt],
        ["data", new Uint8Array(1000)],
      ]);
      // The data chunk's declared length: 0xFFFFFFFF.
      new DataView(wav.buffer).setUint32(12 + 8 + 16 + 4, 0xffffffff, true);
      return () => {
        const a = decodeWav(wav);
        const b = decodeMotionSyncWav(wav);
        return `${a.frames} and ${b.channels[0]!.length} frames`;
      };
    }
    // A motion whose Meta declares billions of curves, segments and points.
    case "motion-counts": {
      const text = JSON.stringify({
        Version: 3,
        Meta: {
          Duration: 1,
          Fps: 30,
          Loop: true,
          CurveCount: 2e9,
          TotalSegmentCount: 2e9,
          TotalPointCount: 2e9,
        },
        Curves: [{ Target: "Parameter", Id: "P", Segments: [0, 0, 0, 1, 1] }],
      });
      return () => parseMotion(new TextEncoder().encode(text));
    }
    // Physics whose Meta declares billions of settings, inputs, outputs and vertices.
    case "physics-counts": {
      const text = JSON.stringify({
        Version: 3,
        Meta: {
          PhysicsSettingCount: 2e9,
          TotalInputCount: 2e9,
          TotalOutputCount: 2e9,
          VertexCount: 2e9,
          Fps: 60,
          EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
          PhysicsDictionary: [],
        },
        PhysicsSettings: [],
      });
      return () => parsePhysics(new TextEncoder().encode(text));
    }
    // The sample's .moc3 with one count of its count table set to 2³⁰.
    case "moc-count": {
      const moc = readFileSync(join(root, "samples/mochi/mochi.moc3"));
      const bytes = new Uint8Array(moc);
      const dv = new DataView(bytes.buffer);
      // The count table's offset is the offset table's first slot (after the 64-byte header).
      const countTable = dv.getUint32(64, true);
      for (let i = 0; i < 8; i++) dv.setUint32(countTable + 4 * i, 2 ** 30, true);
      return () => loadMoc(bytes);
    }
    default:
      return null;
  }
}

const tex = textureCase();
let out: Record<string, unknown>;
if (tex) out = await runTexture(tex);
else {
  const run = otherCase();
  if (!run) throw new Error(`unknown case ${name}`);
  globalThis.gc?.();
  const before = ownPeak();
  const t0 = performance.now();
  let error: Record<string, unknown> | undefined;
  let result: unknown;
  try {
    result = run();
  } catch (e) {
    error = describe(e);
  }
  out = {
    error,
    result: typeof result === "string" ? result : result === undefined ? undefined : "loaded",
    ms: performance.now() - t0,
    ownRise: Math.max(0, ownPeak() - before),
  };
}
console.log(JSON.stringify(out));
void MiB;

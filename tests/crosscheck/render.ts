/**
 * Render cross-check: synthetic textured models (the reference's own builder,
 * Synth, and generated PNG textures of power-of-two and other sizes, with
 * alpha edges and fine detail), render scenarios on them (framings, views,
 * backgrounds, parameters, culling, legacy blends, masks and inverted masks;
 * in version 6, blend codes with every color and alpha part, and nested
 * parts owning offscreens with their own codes, colors, opacity and masks),
 * and Mochi2D's own renders of them: its render harness in headless Chromium
 * (WebGL2), in the reference configuration, served these models.
 *
 * usage: node render.mjs <outDir> [--models N] [--seed S] [--ref <reference folder>] [--no-reference]
 *        [--reference-out <name>]
 * (--no-reference: the models and scenarios only, as tests/fixtures/make.sh takes them)
 * Writes <outDir>/models, <outDir>/scenarios and <outDir>/reference (or
 * <outDir>/<name>: the PNGs and status files of Mochi2D's render runner).
 * Nothing is committed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Synth } from "../../reference/mochi2d-0.24.1/test/support/synth.js";
import { encodePng } from "../../reference/mochi2d-0.24.1/tools/lib/png.js";
import { openRenderSession } from "../../reference/mochi2d-0.24.1/tools/lib/render-runner.js";
import { createModelsHandler } from "../../reference/mochi2d-0.24.1/tools/lib/static-server.js";
import { loadMoc } from "../../reference/mochi2d-0.24.1/src/core/moc/model.js";

const args = process.argv.slice(2);
const out = args[0];
if (!out) {
  console.error("usage: node render.mjs <outDir> [--models N] [--seed S]");
  process.exit(2);
}
const opt = (name: string, def: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const MODELS = opt("--models", 8);
let seed = opt("--seed", 7) >>> 0 || 1;
const rnd = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const f = Math.fround;

/** Straight RGBA8 textures with gradients, a soft-edged alpha shape, checkers and noise. */
function texture(kind: number, w: number, h: number): Uint8Array {
  const data = new Uint8Array(4 * w * h);
  let s = 12345 + kind;
  const noise = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 16) & 255;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x);
      const u = (x + 0.5) / w;
      const v = (y + 0.5) / h;
      if (kind === 0) {
        // Gradient with a soft-edged ellipse of alpha.
        const d = Math.hypot((u - 0.5) / 0.45, (v - 0.5) / 0.4);
        data[i] = Math.round(255 * u);
        data[i + 1] = Math.round(255 * v);
        data[i + 2] = ((x >> 3) + (y >> 3)) & 1 ? 200 : 60;
        data[i + 3] = d < 0.8 ? 255 : d < 1 ? Math.round(255 * (1 - (d - 0.8) / 0.2)) : 0;
      } else if (kind === 1) {
        // Noise, partly transparent.
        data[i] = noise();
        data[i + 1] = noise();
        data[i + 2] = noise();
        data[i + 3] = x < w / 4 ? 255 : 128 + (noise() >> 1);
      } else {
        // A one-pixel checkerboard (minification), opaque, with colored bands.
        const c = (x + y) & 1 ? 255 : 0;
        data[i] = c;
        data[i + 1] = y < h / 2 ? c : 255 - c;
        data[i + 2] = x < w / 2 ? 128 : c;
        data[i + 3] = 255;
      }
    }
  return data;
}

const TEXTURES: [number, number, number][] = [
  [0, 128, 128],
  [1, 100, 60],
  [2, 256, 256],
  [0, 96, 160],
];

interface ModelOut {
  name: string;
  params: string[];
}

/** Blend codes (version 6): a color part 0–17 and an alpha part 0–4. */
const blendCode = (): number => {
  const color = rnd() < 0.15 ? Math.floor(rnd() * 3) : 3 + Math.floor(rnd() * 15);
  const alpha = rnd() < 0.5 ? 0 : 1 + Math.floor(rnd() * 4);
  return color | (alpha << 8);
};

const VERSIONS = [1, 2, 3, 4, 5, 6, 6, 6];

function buildModel(i: number): ModelOut | null {
  const version = VERSIONS[i % VERSIONS.length]!;
  const name = `render${String(i).padStart(2, "0")}-v${version}`;
  const s = new Synth(version);
  s.canvas = { pixelsPerUnit: 1000, originX: 500, originY: 500, width: 1000, height: 1000, flags: 0 };
  const p0 = s.param("P0", -1, 1, 0);
  const b0 = s.binding(p0, [-1, 1]);
  const band = s.band([b0]);
  // Parts: Root, and in version 6 A and B under it and C under A, each drawn as a
  // unit at its own draw order (its draw-order group), some owning offscreens.
  const parts = [s.part({ id: "Root" })];
  if (version >= 6) {
    const order = () => [{ drawOrder: 100 + Math.floor(800 * rnd()) }];
    const a = s.part({ id: "A", parent: parts[0], keyforms: order() });
    const b = s.part({ id: "B", parent: parts[0], keyforms: order() });
    parts.push(a, b, s.part({ id: "C", parent: a, keyforms: order() }));
  }
  const partOf: number[] = [];
  const tex = [0, 1, 2, 3].map((k) => k % TEXTURES.length);
  const meshCount = 6 + Math.floor(rnd() * 6);
  const meshes: number[] = [];
  for (let m = 0; m < meshCount; m++) {
    const cols = 2 + Math.floor(rnd() * 5);
    const rows = 2 + Math.floor(rnd() * 5);
    const cx = -0.3 + 0.6 * rnd();
    const cy = -0.3 + 0.6 * rnd();
    const hw = 0.08 + 0.2 * rnd();
    const hh = 0.08 + 0.2 * rnd();
    const angle = (rnd() - 0.5) * 1.2;
    const u0 = rnd() < 0.2 ? -0.5 : rnd() * 0.3;
    const v0 = rnd() < 0.2 ? -0.3 : rnd() * 0.3;
    const us = rnd() < 0.2 ? 2.5 : 0.4 + 0.6 * rnd();
    const vs = rnd() < 0.2 ? 2 : 0.4 + 0.6 * rnd();
    const keyform = (shift: number) => {
      const positions: number[] = [];
      for (let r = 0; r <= rows; r++)
        for (let c = 0; c <= cols; c++) {
          const x = -hw + (2 * hw * c) / cols + 0.01 * (rnd() - 0.5);
          const y = -hh + (2 * hh * r) / rows + 0.01 * (rnd() - 0.5);
          const ca = Math.cos(angle + shift), sa = Math.sin(angle + shift);
          positions.push(f(cx + shift * 0.2 + ca * x - sa * y), f(cy + sa * x + ca * y));
        }
      return positions;
    };
    const uvs: number[] = [];
    for (let r = 0; r <= rows; r++)
      for (let c = 0; c <= cols; c++) uvs.push(f(u0 + (us * c) / cols), f(v0 + (vs * r) / rows));
    const reversed = rnd() < 0.3;
    const triangles: number[] = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        const b = a + 1;
        const d = a + cols + 1;
        const e = d + 1;
        if (reversed) triangles.push(d, b, a, d, e, b);
        else triangles.push(a, b, d, b, e, d);
      }
    // Flags: bit 2 double-sided (most), bits 0/1 additive or multiplicative, bit 3 inverted mask.
    let flags = rnd() < 0.75 ? 4 : 0;
    const blend = rnd();
    if (blend < 0.12) flags |= 1;
    else if (blend < 0.24) flags |= 2;
    const colors = version >= 4 && rnd() < 0.6;
    const part = pick(parts);
    const blendMode = version >= 6 && rnd() < 0.5 ? blendCode() : 0;
    const key = (shift: number) => ({
      positions: keyform(shift),
      // Version 6 also gets opacities below 0 and above 1, which 0.8.0 draws.
      opacity: f(version >= 6 && rnd() < 0.15 ? (rnd() < 0.5 ? -0.8 : 1.2) + 0.6 * rnd() : rnd() < 0.7 ? 1 : 0.3 + 0.6 * rnd()),
      drawOrder: 100 + Math.floor(800 * rnd()),
      ...(colors
        ? {
            multiply: [f(0.5 + 0.5 * rnd()), f(0.5 + 0.5 * rnd()), f(0.5 + 0.5 * rnd())] as [number, number, number],
            screen: [f(0.3 * rnd()), f(0.3 * rnd()), f(0.3 * rnd())] as [number, number, number],
          }
        : {}),
    });
    const two = rnd() < 0.5;
    const masks: number[] = [];
    if (meshes.length > 0 && rnd() < 0.3) {
      masks.push(pick(meshes));
      if (rnd() < 0.3) flags |= 8;
    }
    partOf.push(part);
    meshes.push(
      s.mesh({
        id: `Mesh${m}`,
        ...(two ? { band } : {}),
        part,
        texture: pick(tex),
        flags,
        ...(blendMode ? { blendMode } : {}),
        uvs,
        triangles,
        masks,
        keyforms: two ? [key(-0.15), key(0.15)] : [key(0)],
      }),
    );
  }
  if (version >= 6) {
    for (const part of parts.slice(1)) {
      if (rnd() < 0.35) continue;
      const masks = rnd() < 0.35 ? [pick(meshes)] : [];
      s.offscreen({
        part,
        blendMode: rnd() < 0.35 ? 0 : blendCode(),
        flags: 4 | (masks.length && rnd() < 0.4 ? 8 : 0),
        masks,
        keyforms: [
          {
            opacity: f(rnd() < 0.3 ? 1 : 0.4 + 0.6 * rnd()),
            ...(rnd() < 0.6
              ? {
                  multiply: [f(0.5 + 0.5 * rnd()), f(0.5 + 0.5 * rnd()), f(0.5 + 0.5 * rnd())] as [number, number, number],
                  screen: [f(0.3 * rnd()), f(0.3 * rnd()), f(0.3 * rnd())] as [number, number, number],
                }
              : {}),
          },
        ],
      });
    }
    // One draw-order group per part: its meshes, and its child parts as nested groups.
    const [root, a, b, c] = parts as [number, number, number, number];
    const own = (p: number) => meshes.filter((_, k) => partOf[k] === p).map((index) => ({ kind: 0 as const, index }));
    s.groups = [
      { objects: [...own(root), { kind: 1, index: a, nested: 1 }, { kind: 1, index: b, nested: 2 }], min: 0, max: 1000 },
      { objects: [...own(a), { kind: 1, index: c, nested: 3 }], min: 0, max: 1000 },
      { objects: own(b), min: 0, max: 1000 },
      { objects: own(c), min: 0, max: 1000 },
    ];
  }
  const bytes = s.build();
  try {
    loadMoc(bytes);
  } catch (e) {
    console.error(`${name}: ${(e as Error).message}`);
    return null;
  }
  const dir = join(out, "models", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.moc3`), bytes);
  const textures = TEXTURES.map(([kind, w, h], k) => {
    const file = `tex${k}.png`;
    writeFileSync(join(dir, file), encodePng({ width: w, height: h, data: texture(kind, w, h) }));
    return file;
  });
  writeFileSync(
    join(dir, `${name}.model3.json`),
    JSON.stringify({ Version: 3, FileReferences: { Moc: `${name}.moc3`, Textures: textures } }, null, 2),
  );
  return { name, params: ["P0"] };
}

const GRAY = [0.5, 0.5, 0.5, 1];
const WHITE = [1, 1, 1, 1];
const CLEAR = [0, 0, 0, 0];

mkdirSync(join(out, "scenarios"), { recursive: true });
const scenarios: Record<string, unknown>[] = [];
for (let i = 0; i < MODELS; i++) {
  const m = buildModel(i);
  if (!m) continue;
  const model = `${m.name}/${m.name}.model3.json`;
  const add = (
    tag: string,
    render: Record<string, unknown>,
    parameters?: Record<string, number>,
    tints?: Record<string, number[]>,
  ) => {
    const sc = {
      format: "mochi2d-scenario/0",
      id: `${m.name}-${tag}`,
      model,
      ...(parameters ? { parameters } : {}),
      ...(tints ? { "x-tints": tints } : {}),
      render,
    };
    scenarios.push(sc);
    writeFileSync(join(out, "scenarios", `${sc.id}.json`), JSON.stringify(sc, null, 2));
  };
  add("full", { width: 256, height: 256, background: pick([GRAY, WHITE, CLEAR]) });
  add("pose", { width: 200, height: 320, background: pick([GRAY, CLEAR]) }, { P0: f(-1 + 2 * rnd()) });
  add("zoom", { width: 192, height: 192, background: WHITE, view: { x: -0.1 + 0.2 * rnd(), y: 0, pixelsPerUnit: 2500 } });
  add("tiny", { width: 48, height: 64, background: GRAY }, { P0: 1 });
  // Application tints (0.14.0: r, g, b up to 2, above 1 brightening up to white), chosen
  // without the random stream so the other scenarios stay as they were.
  const k = i % 3;
  add(
    "tint",
    { width: 160, height: 160, background: GRAY },
    undefined,
    {
      Mesh0: [[1.8, 0.6, 1.3, 1], [2, 2, 2, 0.75], [0.4, 1.6, 1, 1]][k]!,
      Mesh1: [[0.5, 2, 1, 0.8], [1.25, 1, 0.5, 1], [2, 0.2, 1.7, 0.6]][k]!,
      Mesh2: [[1, 1, 1.9, 1], [0.7, 1.4, 1.1, 0.9], [1.5, 1.5, 0, 1]][k]!,
    },
  );
}

// Mochi2D's renders of them, as its render runner writes them.
if (args.includes("--no-reference")) {
  console.log(`${scenarios.length} render scenarios → ${out} (no reference renders)`);
  process.exit(0);
}
const refOutIndex = args.indexOf("--reference-out");
const ref = join(out, refOutIndex >= 0 ? args[refOutIndex + 1]! : "reference");
mkdirSync(ref, { recursive: true });
const refIndex = args.indexOf("--ref");
const root = refIndex >= 0 ? args[refIndex + 1]! : join(process.cwd(), "reference", "mochi2d-0.24.1");
const session = await openRenderSession(root, undefined, {
  modelsHandler: createModelsHandler(join(out, "models")),
  offline: true,
});
try {
  for (const sc of scenarios) {
    const id = sc.id as string;
    const status: Record<string, unknown> = { format: "mochi2d-render/0", scenario: id, producer: "mochi2d-0.24.1", error: null, png: null };
    try {
      // A scenario's x-tints go to the harness's render request as its tints (the render runner
      // passes none); otherwise the request is the one the runner builds.
      const tints = sc["x-tints"] as Record<string, number[]> | undefined;
      const r = tints
        ? await (async () => {
            const size = sc.render as { width: number; height: number; background?: number[] };
            const h = await session.call<{ width: number; height: number; rgbaBase64: string; alpha: string; renderer: string }>(
              "render",
              {
                width: size.width,
                height: size.height,
                ...(size.background ? { background: size.background } : {}),
                alpha: "premultiplied",
                model: sc.model,
                parameters: sc.parameters,
                tints,
              },
            );
            return { ...h, rgba: new Uint8Array(Buffer.from(h.rgbaBase64, "base64")) };
          })()
        : await session.render(sc as never, { alpha: "premultiplied" });
      writeFileSync(join(ref, `${id}.png`), encodePng({ width: r.width, height: r.height, data: r.rgba }));
      Object.assign(status, { png: `${id}.png`, alpha: r.alpha, width: r.width, height: r.height, renderer: r.renderer });
    } catch (e) {
      status.error = { kind: (e as Error).name, message: (e as Error).message.split("\n")[0] };
    }
    writeFileSync(join(ref, `${id}.render.json`), JSON.stringify(status, null, 2) + "\n");
  }
} finally {
  await session.close();
}
console.log(`${scenarios.length} render scenarios → ${out}`);

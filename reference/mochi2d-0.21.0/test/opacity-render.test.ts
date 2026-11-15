/**
 * Negative, NaN and infinite opacities in renders: every drawable whose
 * opacity is not 0 is drawn, and the result follows from the renderer's
 * clamping points. The compatible path clamps the
 * source color and alpha (NaN → 0) before blending, without clamping the
 * opacity first; advanced codes keep the source alpha unclamped through
 * their formulas and clamp the stored result; an advanced offscreen
 * composite covers its whole parent layer.
 *
 * The scene, rendered with `NodeRenderer` (the WebGL renderer in headless
 * Chromium): a gray quad over the left half of a clear image, and orange test
 * quads across its edge, read over the gray and over the clear part. Every
 * value of the two tables below (drawables, offscreens) is checked exactly
 * (premultiplied RGBA8). The renders need `npm run build:web` and
 * Playwright.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { NodeRenderer } from "../src/lib/node-render.js";
import { encodePngRgba } from "../src/platform/node-png.js";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { ModelRuntime } from "../src/runtime/model-runtime.js";
import { decodePng } from "../tools/lib/png.js";
import { loadPlaywright } from "../tools/lib/browser.js";
import { Synth } from "./support/synth.js";

const root = resolve(__dirname, "..");
let available = existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

type RGBA = [number, number, number, number];
const OPACITIES = [1, 0.5, 0, -0.5, -1, NaN, Infinity, -Infinity] as const;
const label = (o: number) =>
  Number.isNaN(o) ? "NaN" : o === Infinity ? "+∞" : o === -Infinity ? "−∞" : String(o);
const GRAY: RGBA = [128, 128, 128, 255];
const CLEAR: RGBA = [0, 0, 0, 0];
/** "=": the destination unchanged. */
const SAME = null;

/** Image 200 × 160 px at 100 px per unit: output x in [−1, 1], y in [−0.8, 0.8], 8 bands of 20 px. */
const W = 200;
const H = 160;
const quad = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x0, y1, x1, y1];
const TRIANGLES = [0, 1, 2, 1, 3, 2];
/** The texture's left half is gray, its right half orange: constant UVs pick one. */
const GRAY_UV = new Array<number>(8).fill(0).map((_, i) => (i % 2 ? 0.5 : 0.25));
const ORANGE_UV = new Array<number>(8).fill(0).map((_, i) => (i % 2 ? 0.5 : 0.75));
/** Band k's quad, in model space (y down): 10 px tall, centered in its band. */
const bandQuad = (k: number) => quad(-0.5, -0.75 + 0.2 * k, 0.5, -0.65 + 0.2 * k);
/** Pixels of band k over the gray and over the clear part. */
const over = (k: number) => ({
  gray: [75, 10 + 20 * k] as const,
  clear: [125, 10 + 20 * k] as const,
});

function source(s: Synth): MemoryFileSource {
  s.canvas = { pixelsPerUnit: 100, originX: 100, originY: 80, width: W, height: H, flags: 0 };
  const tex = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++)
    tex.set(i % 4 < 2 ? [128, 128, 128, 255] : [255, 128, 0, 255], 4 * i);
  return MemoryFileSource.fromFiles({
    "t.model3.json": JSON.stringify({
      Version: 3,
      FileReferences: { Moc: "t.moc3", Textures: ["t.png"] },
    }),
    "t.moc3": s.build(),
    "t.png": encodePngRgba(4, 4, tex),
  });
}

/** A model: the gray quad first, then one orange quad per opacity (bands 0–7). */
function drawablesModel(version: 5 | 6, how: { flags?: number; code?: number; layered?: boolean }) {
  const s = new Synth(version);
  s.part({ id: "Root" });
  s.mesh({
    id: "Gray",
    uvs: GRAY_UV,
    triangles: TRIANGLES,
    keyforms: [{ positions: quad(-1, -0.8, 0, 0.8), drawOrder: 100 }],
  });
  OPACITIES.forEach((o, k) =>
    s.mesh({
      id: `Q${k}`,
      uvs: ORANGE_UV,
      triangles: TRIANGLES,
      ...(how.flags !== undefined ? { flags: how.flags } : {}),
      ...(how.code !== undefined ? { blendMode: how.code } : {}),
      keyforms: [{ positions: bandQuad(k), opacity: o, drawOrder: 200 }],
    }),
  );
  // A drawable with an advanced code, out of the way, makes the pipeline layered.
  if (how.layered)
    s.mesh({
      id: "Advanced",
      uvs: ORANGE_UV,
      triangles: TRIANGLES,
      blendMode: 0x006,
      keyforms: [{ positions: quad(0.9, 0.7, 0.95, 0.75), drawOrder: 300 }],
    });
  return source(s);
}

/** A model whose part Q owns an offscreen (opacity o, blend code `code`) holding one orange quad. */
function offscreenModel(o: number, code: number) {
  const s = new Synth(6);
  s.part({ id: "Root" });
  const Q = s.part({ id: "Q", parent: 0, keyforms: [{ drawOrder: 200 }] });
  s.offscreen({ part: Q, blendMode: code, keyforms: [{ opacity: o }] });
  const gray = s.mesh({
    id: "Gray",
    uvs: GRAY_UV,
    triangles: TRIANGLES,
    keyforms: [{ positions: quad(-1, -0.8, 0, 0.8), drawOrder: 100 }],
  });
  const orange = s.mesh({
    id: "Orange",
    part: Q,
    uvs: ORANGE_UV,
    triangles: TRIANGLES,
    keyforms: [{ positions: bandQuad(3), drawOrder: 500 }],
  });
  s.groups = [
    {
      min: 0,
      max: 1000,
      objects: [
        { kind: 0, index: gray },
        { kind: 1, index: Q, nested: 1 },
      ],
    },
    { min: 0, max: 1000, objects: [{ kind: 0, index: orange }] },
  ];
  return source(s);
}

/** Drawables over gray, per path: the pixel at each opacity of OPACITIES. */
const ZERO: RGBA = [0, 0, 0, 0];
const OVER_GRAY: Record<string, (RGBA | null)[]> = {
  normal: [
    [255, 128, 0, 255],
    [192, 128, 64, 255],
    SAME,
    SAME,
    SAME,
    SAME,
    [255, 255, 0, 255],
    SAME,
  ],
  additive: [
    [255, 255, 128, 255],
    [255, 192, 128, 255],
    SAME,
    SAME,
    SAME,
    SAME,
    [255, 255, 128, 255],
    SAME,
  ],
  multiplicative: [
    [128, 64, 0, 255],
    [128, 96, 64, 255],
    SAME,
    SAME,
    SAME,
    SAME,
    [128, 128, 0, 255],
    SAME,
  ],
  add: [[255, 255, 128, 255], [192, 192, 128, 255], SAME, SAME, SAME, ZERO, ZERO, ZERO],
  multiply: [
    [128, 64, 0, 255],
    [128, 96, 64, 255],
    SAME,
    [192, 192, 192, 255],
    [255, 255, 255, 255],
    ZERO,
    ZERO,
    ZERO,
  ],
  screen: [[255, 192, 128, 255], [192, 160, 128, 255], SAME, SAME, SAME, ZERO, ZERO, ZERO],
  overlay: [
    [255, 128, 1, 255],
    [192, 128, 65, 255],
    SAME,
    [192, 192, 192, 255],
    [255, 255, 255, 255],
    ZERO,
    ZERO,
    ZERO,
  ],
  darken: [
    [128, 128, 0, 255],
    [128, 128, 64, 255],
    SAME,
    [192, 192, 192, 255],
    [255, 255, 255, 255],
    ZERO,
    ZERO,
    ZERO,
  ],
  lighten: [[255, 128, 128, 255], [192, 128, 128, 255], SAME, SAME, SAME, ZERO, ZERO, ZERO],
  atop: [
    [255, 128, 0, 255],
    [192, 128, 64, 255],
    SAME,
    [192, 192, 192, 255],
    [255, 255, 255, 255],
    ZERO,
    ZERO,
    ZERO,
  ],
};
/** Drawables over the clear part: opacity 1, 0.5 and +∞; everything else leaves it clear. */
const OVER_CLEAR: Record<string, [RGBA, RGBA, RGBA]> = {
  normal: [
    [255, 128, 0, 255],
    [128, 64, 0, 128],
    [255, 255, 0, 255],
  ],
  additive: [
    [255, 128, 0, 0],
    [128, 64, 0, 0],
    [255, 255, 0, 0],
  ],
  multiplicative: [CLEAR, CLEAR, CLEAR],
  advanced: [[255, 128, 0, 255], [128, 64, 0, 128], CLEAR],
  atop: [CLEAR, CLEAR, CLEAR],
};

const PATHS: [string, () => MemoryFileSource, string, string][] = [
  ["v5 normal", () => drawablesModel(5, {}), "normal", "normal"],
  ["v5 legacy additive", () => drawablesModel(5, { flags: 5 }), "additive", "additive"],
  [
    "v5 legacy multiplicative",
    () => drawablesModel(5, { flags: 6 }),
    "multiplicative",
    "multiplicative",
  ],
  ["v6 code 0x000, direct", () => drawablesModel(6, { code: 0 }), "normal", "normal"],
  [
    "v6 code 0x000, layered",
    () => drawablesModel(6, { code: 0, layered: true }),
    "normal",
    "normal",
  ],
  ["v6 0x003 add", () => drawablesModel(6, { code: 0x003 }), "add", "advanced"],
  ["v6 0x006 multiply", () => drawablesModel(6, { code: 0x006 }), "multiply", "advanced"],
  ["v6 0x00A screen", () => drawablesModel(6, { code: 0x00a }), "screen", "advanced"],
  ["v6 0x00C overlay", () => drawablesModel(6, { code: 0x00c }), "overlay", "advanced"],
  ["v6 0x005 darken", () => drawablesModel(6, { code: 0x005 }), "darken", "advanced"],
  ["v6 0x009 lighten", () => drawablesModel(6, { code: 0x009 }), "lighten", "advanced"],
  ["v6 0x100 atop-normal", () => drawablesModel(6, { code: 0x100 }), "atop", "atop"],
];

/** Offscreens over gray; "erased" = the whole image is (0, 0, 0, 0). */
const ERASED = "erased" as const;
const OFFSCREENS: Record<string, [number, (RGBA | null | typeof ERASED)[]]> = {
  normal: [
    0,
    [[255, 128, 0, 255], [192, 128, 64, 255], SAME, SAME, SAME, SAME, [255, 255, 0, 255], SAME],
  ],
  multiply: [
    0x006,
    [
      [128, 64, 0, 255],
      [128, 96, 64, 255],
      SAME,
      [192, 192, 192, 255],
      [255, 255, 255, 255],
      ERASED,
      ERASED,
      ERASED,
    ],
  ],
  overlay: [
    0x00c,
    [
      [255, 128, 1, 255],
      [192, 128, 65, 255],
      SAME,
      [192, 192, 192, 255],
      [255, 255, 255, 255],
      ERASED,
      ERASED,
      ERASED,
    ],
  ],
  add: [
    0x003,
    [[255, 255, 128, 255], [192, 192, 128, 255], SAME, SAME, SAME, ERASED, ERASED, ERASED],
  ],
  screen: [
    0x00a,
    [[255, 192, 128, 255], [192, 160, 128, 255], SAME, SAME, SAME, ERASED, ERASED, ERASED],
  ],
};

describe.skipIf(!available)("negative, NaN and infinite opacities in renders", () => {
  let renderer: NodeRenderer;
  beforeAll(async () => {
    renderer = await NodeRenderer.open();
  }, 120000);
  afterAll(async () => {
    await renderer?.close();
  }, 60000);

  /** Premultiplied RGBA of a render of `src` at its default pose. */
  const render = async (src: MemoryFileSource) => {
    const rt = await ModelRuntime.load(src, "t.model3.json", { nonFiniteOpacity: "load" });
    rt.update(0);
    const r = await renderer.render(rt, { width: W, height: H, alpha: "premultiplied" });
    const img = decodePng(r.png).data;
    return (x: number, y: number): RGBA =>
      [...img.subarray(4 * (W * y + x), 4 * (W * y + x) + 4)] as RGBA;
  };

  it.each(PATHS)("drawables, %s", async (_, model, grayColumn, clearColumn) => {
    const at = await render(model());
    const got: string[] = [];
    const want: string[] = [];
    OPACITIES.forEach((o, k) => {
      const { gray, clear } = over(k);
      got.push(`${label(o)} over gray ${at(...gray)}, over clear ${at(...clear)}`);
      const g = OVER_GRAY[grayColumn]![k] ?? GRAY;
      const i = [1, 0.5, Infinity].indexOf(o);
      const c = i >= 0 ? (OVER_CLEAR[clearColumn]![i] as RGBA) : CLEAR;
      want.push(`${label(o)} over gray ${g}, over clear ${c}`);
    });
    expect(got).toEqual(want);
    // The background away from the quads is untouched.
    expect([at(10, 5), at(190, 5)]).toEqual([GRAY, CLEAR]);
  });

  it.each(Object.entries(OFFSCREENS))("offscreen composites, %s", async (_, [code, column]) => {
    for (const [k, o] of OPACITIES.entries()) {
      const at = await render(offscreenModel(o, code));
      const { gray, clear } = over(3);
      const far = [at(10, 150), at(190, 150)];
      const expected = column[k]!;
      if (expected === ERASED) {
        // The composite covers the whole parent layer: everything is erased.
        expect([at(...gray), at(...clear), ...far], label(o)).toEqual([ZERO, ZERO, ZERO, ZERO]);
        continue;
      }
      expect(at(...gray), label(o)).toEqual(expected ?? GRAY);
      // The brightening is local: away from the content nothing changes.
      expect(far, label(o)).toEqual([GRAY, CLEAR]);
    }
  });
});

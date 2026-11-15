/**
 * The model renderer on synthetic `.moc3` files, compared pixel
 * by pixel with the CPU reference formulas of src/core/render/compositing.ts:
 * fragment colors and legacy blends (§2c, §2d), culling (§2e), masks (§2g),
 * the layered pipeline of v6 files (§2h) and TextureTooLarge (§2i, B4).
 * Needs `npm run build` and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRenderSession, type RenderSession } from "../tools/lib/render-runner.js";
import { loadPlaywright } from "../tools/lib/browser.js";
import { encodePng } from "../tools/lib/png.js";
import { Synth } from "./support/synth.js";
import { nonFiniteModel } from "./support/non-finite-model.js";
import {
  advancedBlend,
  advancedSource,
  fragmentColor,
  legacyBlend,
  premultiplyByte,
  toByte,
  type LegacyBlend,
  type Rgb,
  type Rgba,
} from "../src/core/render/compositing.js";

const root = resolve(__dirname, "..");
let available = existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

const SIZE = 64;
/** Canvas: 200 × 200 px at 100 px/unit, origin centered: output space [−1, 1]², 32 image px/unit. */
const CANVAS = {
  pixelsPerUnit: 100,
  originX: 100,
  originY: 100,
  width: 200,
  height: 200,
  flags: 0,
};

/** A uniform 4×4 PNG (straight RGBA bytes). */
const solidPng = (rgba: [number, number, number, number]) =>
  Buffer.from(
    encodePng({
      width: 4,
      height: 4,
      data: Uint8Array.from({ length: 64 }, (_, i) => rgba[i % 4]!),
    }),
  ).toString("base64");

/** Premultiplied real texel of a uniform straight texture, as uploaded (§2b.1). */
const texel = (rgba: [number, number, number, number]): Rgba => {
  const a = rgba[3];
  return [
    premultiplyByte(rgba[0], a),
    premultiplyByte(rgba[1], a),
    premultiplyByte(rgba[2], a),
    a,
  ].map((b) => b / 255) as Rgba;
};

/** Quad in model space (y down) from (x0, y0) to (x1, y1), front-facing (§2e). */
const quad = (x0: number, y0: number, x1: number, y1: number) => ({
  positions: [x0, y0, x1, y0, x0, y1, x1, y1],
  triangles: [0, 1, 2, 1, 3, 2],
});
/** The same quad with the triangle winding reversed (back-facing). */
const backQuad = (x0: number, y0: number, x1: number, y1: number) => ({
  positions: [x0, y0, x1, y0, x0, y1, x1, y1],
  triangles: [0, 2, 1, 1, 2, 3],
});

/** Image pixel of an output-space point (x, y up). */
const pixelAt = (x: number, y: number): [number, number] => [
  Math.floor(SIZE / 2 + 32 * x),
  Math.floor(SIZE / 2 - 32 * y),
];

const TEX_A: [number, number, number, number] = [204, 102, 51, 128];
const TEX_B: [number, number, number, number] = [153, 77, 230, 255];
const TEX_MASK: [number, number, number, number] = [255, 255, 255, 64];
const M: Rgb = [0.5, 1, 1];
const S: Rgb = [0.2, 0.2, 0.2];
const O = 0.8;
const GRAY: Rgba = [0.5, 0.5, 0.5, 1];

describe.skipIf(!available)("model renderer on synthetic models (headless Chromium)", () => {
  let session: RenderSession;
  beforeAll(async () => {
    session = await openRenderSession(root);
  });
  afterAll(async () => {
    await session?.close();
  });

  const render = async (
    s: Synth,
    textures: [number, number, number, number][],
    background: Rgba = [0, 0, 0, 0],
  ) => {
    s.canvas = { ...CANVAS };
    const r = await session.call<{ rgbaBase64: string; stats: { pipeline: string } }>("render", {
      width: SIZE,
      height: SIZE,
      mocBase64: Buffer.from(s.build()).toString("base64"),
      texturesBase64: textures.map(solidPng),
      background,
      alpha: "premultiplied",
    });
    const px = new Uint8Array(Buffer.from(r.rgbaBase64, "base64"));
    return {
      pipeline: r.stats.pipeline,
      at: (x: number, y: number) => {
        const [i, j] = pixelAt(x, y);
        const k = (j * SIZE + i) * 4;
        return Array.from(px.subarray(k, k + 4));
      },
    };
  };

  const expectBytes = (got: number[], want: Rgba, what: string) => {
    const bytes = want.map(toByte);
    for (let c = 0; c < 4; c++)
      expect(
        Math.abs(got[c]! - bytes[c]!),
        `${what}: got ${got} want ${bytes}`,
      ).toBeLessThanOrEqual(1);
  };
  const bg = (b: Rgba): Rgba => [b[0] * b[3], b[1] * b[3], b[2] * b[3], b[3]];
  const stored = (v: Rgba): Rgba => v.map((x) => toByte(x) / 255) as Rgba;

  /** One full-image mesh with texture A, the §2j colors and opacity, and `flags`. */
  const single = (version: number, flags: number, blendMode = 0) => {
    const s = new Synth(version);
    s.part({ id: "P" });
    s.mesh({
      id: "A",
      flags,
      blendMode,
      ...quad(-1, -1, 1, 1),
      uvs: [0, 0, 1, 0, 0, 1, 1, 1],
      keyforms: [{ positions: quad(-1, -1, 1, 1).positions, opacity: O, multiply: M, screen: S }],
    });
    return s;
  };

  it("fragment color and the three legacy blends (§2c, §2d)", async () => {
    const T = texel(TEX_A);
    const src = fragmentColor(T, M, S, O);
    const cases: [number, LegacyBlend][] = [
      [4, "normal"],
      [4 | 1, "additive"],
      [4 | 2, "multiplicative"],
    ];
    for (const [flags, mode] of cases) {
      const r = await render(single(5, flags), [TEX_A], GRAY);
      expect(r.pipeline).toBe("direct");
      expectBytes(r.at(0, 0), legacyBlend(mode, src, stored(bg(GRAY))), mode);
    }
  });

  it("culls back-facing triangles of single-sided drawables only (§2e)", async () => {
    const s = new Synth(5);
    s.part({ id: "P" });
    const mesh = (id: string, flags: number, g: ReturnType<typeof quad>) =>
      s.mesh({
        id,
        flags,
        ...g,
        uvs: new Array(8).fill(0.5),
        keyforms: [{ positions: g.positions }],
      });
    mesh("front-single", 0, quad(-1, -1, 0, 0));
    mesh("back-single", 0, backQuad(0, -1, 1, 0));
    mesh("back-double", 4, backQuad(-1, 0, 0, 1));
    const r = await render(s, [TEX_B]);
    const T = texel(TEX_B);
    // Model y down → output y up: model (−0.5, −0.5) is output (−0.5, 0.5).
    expectBytes(r.at(-0.5, 0.5), T, "front-facing, single-sided: drawn");
    expectBytes(r.at(0.5, 0.5), [0, 0, 0, 0], "back-facing, single-sided: culled");
    expectBytes(r.at(-0.5, -0.5), T, "back-facing, double-sided: drawn");
  });

  /** Mask mesh K over the left half (texture alpha 64, opacity 0); A masked by K. */
  const masked = (flags: number, maskEnabled = true) => {
    const s = new Synth(5);
    s.part({ id: "P" });
    const k = s.mesh({
      id: "K",
      texture: 1,
      enabled: maskEnabled,
      ...quad(-1, -1, 0, 1),
      uvs: new Array(8).fill(0.5),
      keyforms: [{ positions: quad(-1, -1, 0, 1).positions, opacity: 0 }],
    });
    s.mesh({
      id: "A",
      flags,
      masks: [k],
      ...quad(-1, -1, 1, 1),
      uvs: new Array(8).fill(0.5),
      keyforms: [{ positions: quad(-1, -1, 1, 1).positions, opacity: O, multiply: M, screen: S }],
    });
    return s;
  };

  it("masks with active mask meshes, inverted masks, and inactive mask meshes (§2g)", async () => {
    const T = texel(TEX_A);
    const m = 64 / 255; // 1 − (1 − α) through the 8-bit buffer
    const dst = stored(bg(GRAY));
    const over = (mask?: { coverage: number; inverted: boolean }) =>
      legacyBlend("normal", fragmentColor(T, M, S, O, mask), dst);

    let r = await render(masked(4), [TEX_A, TEX_MASK], GRAY);
    expectBytes(r.at(-0.5, 0), over({ coverage: m, inverted: false }), "inside the mask");
    expectBytes(r.at(0.5, 0), dst, "outside the mask");

    r = await render(masked(4 | 8), [TEX_A, TEX_MASK], GRAY);
    expectBytes(r.at(-0.5, 0), over({ coverage: m, inverted: true }), "inverted, inside");
    expectBytes(r.at(0.5, 0), over(), "inverted, outside");

    r = await render(masked(4, false), [TEX_A, TEX_MASK], GRAY);
    expectBytes(r.at(-0.5, 0), dst, "inactive mask mesh: normal mask hides everything");
    r = await render(masked(4 | 8, false), [TEX_A, TEX_MASK], GRAY);
    expectBytes(r.at(-0.5, 0), over(), "inactive mask mesh: inverted mask draws unclipped");
  });

  describe("layered pipeline (v6, §2h)", () => {
    /** B (opaque, normal) below; A above with blend code `code`. */
    const twoMeshes = (code: number) => {
      const s = new Synth(6);
      s.part({ id: "P" });
      s.mesh({
        id: "B",
        texture: 1,
        ...quad(-1, -1, 1, 1),
        uvs: new Array(8).fill(0.5),
        keyforms: [{ positions: quad(-1, -1, 1, 1).positions }],
      });
      s.mesh({
        id: "A",
        blendMode: code,
        ...quad(-1, -1, 0, 1),
        uvs: new Array(8).fill(0.5),
        keyforms: [{ positions: quad(-1, -1, 0, 1).positions, opacity: O, multiply: M, screen: S }],
      });
      return s;
    };

    it("advanced blend codes on drawables, for every color function and alpha mode", async () => {
      const TA = texel(TEX_A);
      const TB = texel(TEX_B);
      const bgColor: Rgba = [0.2, 0.6, 0.3, 1];
      for (const color of [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]) {
        // Code 0x000 is the compatible normal mode; color function 0 is tested with atop.
        for (const alpha of color === 6 ? [0, 1, 2, 3, 4] : color === 0 ? [1] : [0]) {
          const code = color | (alpha << 8);
          const r = await render(twoMeshes(code), [TEX_A, TEX_B], bgColor);
          expect(r.pipeline).toBe("layered");
          // L₀ = B over transparent, then A replaces the pixel, then L₀ over the background.
          const l0 = stored(legacyBlend("normal", TB, [0, 0, 0, 0]));
          const blended = stored(advancedBlend(code, advancedSource(TA, M, S, O), l0));
          const want = legacyBlend("normal", blended, stored(bg(bgColor)));
          expectBytes(r.at(-0.5, 0), want, `code 0x${code.toString(16)}`);
          // Where only B is, the image is B over the background.
          expectBytes(r.at(0.5, 0), legacyBlend("normal", l0, stored(bg(bgColor))), "B only");
        }
      }
    });

    it("multiplicative drawables darken the model, never the background (§2h.2)", async () => {
      const s = new Synth(6);
      s.part({ id: "P" });
      s.mesh({
        id: "A",
        blendMode: 2,
        flags: 4 | 2,
        ...quad(-1, -1, 1, 1),
        uvs: new Array(8).fill(0.5),
        keyforms: [{ positions: quad(-1, -1, 1, 1).positions }],
      });
      // A blend code the direct pipeline cannot draw forces the layered pipeline.
      s.mesh({
        id: "X",
        blendMode: 5,
        ...quad(0.9, 0.9, 1, 1),
        uvs: new Array(8).fill(0.5),
        keyforms: [{ positions: quad(0.9, 0.9, 1, 1).positions, opacity: 0 }],
      });
      const r = await render(s, [TEX_A], GRAY);
      expect(r.pipeline).toBe("layered");
      expectBytes(r.at(0, 0), stored(bg(GRAY)), "background unchanged");
    });

    /** Part Q owns an offscreen; A is drawn inside it, B outside below it. */
    const withOffscreen = (o: {
      code: number;
      opacity: number;
      multiply?: Rgb;
      screen?: Rgb;
      masks?: number[];
      flags?: number;
    }) => {
      const s = new Synth(6);
      const root = s.part({ id: "Root" });
      const q = s.part({ id: "Q", parent: root });
      s.mesh({
        id: "B",
        part: root,
        texture: 1,
        ...quad(-1, -1, 1, 1),
        uvs: new Array(8).fill(0.5),
        keyforms: [{ positions: quad(-1, -1, 1, 1).positions }],
      });
      s.mesh({
        id: "A",
        part: q,
        ...quad(-1, -1, 1, 1),
        uvs: new Array(8).fill(0.5),
        keyforms: [{ positions: quad(-1, -1, 1, 1).positions, opacity: O }],
      });
      // Mask mesh over the left half (inactive drawables still mask; this one is active).
      s.mesh({
        id: "K",
        part: root,
        texture: 2,
        ...quad(-1, -1, 0, 1),
        uvs: new Array(8).fill(0.5),
        keyforms: [{ positions: quad(-1, -1, 0, 1).positions, opacity: 0 }],
      });
      s.offscreen({
        part: q,
        blendMode: o.code,
        flags: o.flags ?? 4,
        masks: o.masks ?? [],
        keyforms: [
          { opacity: o.opacity, multiply: o.multiply ?? [1, 1, 1], screen: o.screen ?? [0, 0, 0] },
        ],
      });
      // Group 0: B, then part Q (nested group 1 with A), then K.
      s.groups = [
        {
          objects: [
            { kind: 0, index: 0 },
            { kind: 1, index: q, nested: 1 },
            { kind: 0, index: 2 },
          ],
          min: 0,
          max: 1000,
        },
        { objects: [{ kind: 0, index: 1 }], min: 0, max: 1000 },
      ];
      return s;
    };

    it("offscreens composite with their colors, opacity and blend code (§2h.4)", async () => {
      const TA = texel(TEX_A);
      const TB = texel(TEX_B);
      const bgColor: Rgba = [0.5, 0.5, 0.5, 1];
      const layerA = stored(
        legacyBlend("normal", fragmentColor(TA, [1, 1, 1], [0, 0, 0], O), [0, 0, 0, 0]),
      );
      const l0B = stored(legacyBlend("normal", TB, [0, 0, 0, 0]));
      const Mo: Rgb = [0.9, 0.5, 0.7];
      const So: Rgb = [0.1, 0.3, 0.0];
      for (const code of [0, 1, 2, 10, 6 | (3 << 8)]) {
        const r = await render(
          withOffscreen({ code, opacity: 0.6, multiply: Mo, screen: So }),
          [TEX_A, TEX_B, TEX_MASK],
          bgColor,
        );
        const composited =
          code === 0 || code === 1 || code === 2
            ? legacyBlend(
                code === 1 ? "additive" : code === 2 ? "multiplicative" : "normal",
                fragmentColor(layerA, Mo, So, 0.6),
                l0B,
              )
            : advancedBlend(code, advancedSource(layerA, Mo, So, 0.6), l0B);
        const want = legacyBlend("normal", stored(composited), stored(bg(bgColor)));
        expectBytes(r.at(0.5, 0), want, `offscreen code 0x${code.toString(16)}`);
      }
    });

    it("offscreen masks, normal and inverted (§2h.4)", async () => {
      const TA = texel(TEX_A);
      const TB = texel(TEX_B);
      const bgColor: Rgba = [0.5, 0.5, 0.5, 1];
      const layerA = stored(
        legacyBlend("normal", fragmentColor(TA, [1, 1, 1], [0, 0, 0], O), [0, 0, 0, 0]),
      );
      const l0B = stored(legacyBlend("normal", TB, [0, 0, 0, 0]));
      const m = 64 / 255;
      for (const inverted of [false, true]) {
        const r = await render(
          withOffscreen({ code: 0, opacity: 1, masks: [2], flags: inverted ? 4 | 8 : 4 }),
          [TEX_A, TEX_B, TEX_MASK],
          bgColor,
        );
        const at = (coverage: number) =>
          legacyBlend(
            "normal",
            stored(
              legacyBlend(
                "normal",
                fragmentColor(layerA, [1, 1, 1], [0, 0, 0], 1, { coverage, inverted }),
                l0B,
              ),
            ),
            stored(bg(bgColor)),
          );
        expectBytes(r.at(-0.5, 0), at(m), `inside the mask (inverted ${inverted})`);
        expectBytes(r.at(0.5, 0), at(0), `outside the mask (inverted ${inverted})`);
      }
    });
  });

  it("nested offscreens close in the right order; masks work inside layers (§2h.2, §2h.5)", async () => {
    // Parts Root ⊃ Q (offscreen, opacity 0.7) ⊃ R (offscreen, opacity 0.5).
    // A (in R) covers everything, masked by K (left half); C (in Q) covers the
    // top-right quadrant and must be drawn into Q's layer after R's layer closes.
    const s = new Synth(6);
    const rootPart = s.part({ id: "Root" });
    const q = s.part({ id: "Q", parent: rootPart });
    const rp = s.part({ id: "R", parent: q });
    const full = quad(-1, -1, 1, 1);
    const left = quad(-1, -1, 0, 1);
    const topRight = quad(0, -1, 1, 0); // model y down: output y in [0, 1]
    const uv = new Array(8).fill(0.5);
    s.mesh({
      id: "B",
      part: rootPart,
      texture: 1,
      ...full,
      uvs: uv,
      keyforms: [{ positions: full.positions }],
    });
    const k = s.mesh({
      id: "K",
      part: rootPart,
      texture: 2,
      ...left,
      uvs: uv,
      keyforms: [{ positions: left.positions, opacity: 0 }],
    });
    s.mesh({
      id: "A",
      part: rp,
      masks: [k],
      ...full,
      uvs: uv,
      keyforms: [{ positions: full.positions, opacity: O }],
    });
    s.mesh({
      id: "C",
      part: q,
      ...topRight,
      uvs: uv,
      keyforms: [{ positions: topRight.positions, opacity: O }],
    });
    s.offscreen({ part: q, keyforms: [{ opacity: 0.7 }] });
    s.offscreen({ part: rp, keyforms: [{ opacity: 0.5 }] });
    s.groups = [
      {
        objects: [
          { kind: 0, index: 0 },
          { kind: 0, index: 1 },
          { kind: 1, index: q, nested: 1 },
        ],
        min: 0,
        max: 1000,
      },
      {
        objects: [
          { kind: 1, index: rp, nested: 2 },
          { kind: 0, index: 3 },
        ],
        min: 0,
        max: 1000,
      },
      { objects: [{ kind: 0, index: 2 }], min: 0, max: 1000 },
    ];
    const bgColor: Rgba = [0.5, 0.5, 0.5, 1];
    const r = await render(s, [TEX_A, TEX_B, TEX_MASK], bgColor);
    expect(r.pipeline).toBe("layered");
    const TA = texel(TEX_A);
    const TB = stored(texel(TEX_B));
    const none: Rgba = [0, 0, 0, 0];
    const layerOf = (src: Rgba) => stored(legacyBlend("normal", src, none));
    const composite = (layer: Rgba, opacity: number, below: Rgba) =>
      stored(legacyBlend("normal", fragmentColor(layer, [1, 1, 1], [0, 0, 0], opacity), below));
    const final = (l0: Rgba) => legacyBlend("normal", l0, stored(bg(bgColor)));
    const m = 64 / 255;
    // Bottom-left: A masked, through R (0.5) and Q (0.7).
    const l2 = layerOf(
      fragmentColor(TA, [1, 1, 1], [0, 0, 0], O, { coverage: m, inverted: false }),
    );
    const l1 = composite(l2, 0.5, none);
    expectBytes(r.at(-0.5, -0.5), final(composite(l1, 0.7, TB)), "A masked, two layers deep");
    // Bottom-right: A's mask coverage is 0, C is absent: only B.
    expectBytes(r.at(0.5, -0.5), final(TB), "nothing above B");
    // Top-right: C in Q's layer only (0.7), not in R's.
    const c1 = layerOf(fragmentColor(TA, [1, 1, 1], [0, 0, 0], O));
    expectBytes(r.at(0.5, 0.5), final(composite(c1, 0.7, TB)), "C in Q's layer");
  });

  it("draws a model whose keyform positions are NaN, infinite or huge, without failing", async () => {
    // Such files load, as in the official runtime (strict warns). Every
    // drawable is drawn, masks included, in every pipeline; the finite mesh E
    // is drawn as usual.
    for (const version of [5, 6]) {
      const s = nonFiniteModel(version);
      s.canvas = { ...CANVAS };
      const r = await session.call<{
        rgbaBase64: string;
        width: number;
        height: number;
        stats: { pipeline: string };
      }>("render", {
        width: SIZE,
        height: SIZE,
        mocBase64: Buffer.from(s.build()).toString("base64"),
        texturesBase64: [solidPng(TEX_B)],
        background: GRAY,
        alpha: "premultiplied",
      });
      expect([r.width, r.height], `v${version}`).toEqual([SIZE, SIZE]);
      expect(Buffer.from(r.rgbaBase64, "base64").length).toBe(SIZE * SIZE * 4);
      // Version 5 in the direct pipeline, version 6 (an advanced blend) in the layered one.
      expect(r.stats.pipeline, `v${version}`).toBe(version === 6 ? "layered" : "direct");
    }
  });

  it("fails with TextureTooLarge instead of downscaling (§2i, B4)", async () => {
    const s = single(5, 4);
    s.canvas = { ...CANVAS };
    const big = Buffer.from(
      encodePng({ width: 16384, height: 4, data: new Uint8Array(16384 * 4 * 4).fill(255) }),
    ).toString("base64");
    await expect(
      session.call("render", {
        width: SIZE,
        height: SIZE,
        mocBase64: Buffer.from(s.build()).toString("base64"),
        texturesBase64: [big],
        alpha: "premultiplied",
      }),
    ).rejects.toThrow(/TextureTooLarge/);
  });
});

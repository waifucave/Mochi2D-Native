/**
 * Art-mesh tints (`setTint`; not reference behavior): the runtime API, and
 * renders from Node (`NodeRenderer`, the WebGL renderer in headless
 * Chromium). White changes no pixel, a tint darkens exactly the chosen
 * meshes, above 1 it brightens up to white, its alpha scales their opacity,
 * and a tinted masking mesh still masks as before. The renders need `npm run build:web` and Playwright.
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

const quad = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x0, y1, x1, y1];

/**
 * A canvas from −1 to 1 (100 pixels per unit in a 200 × 200 render), one
 * solid texture: A on the left, B on the right, and M across both, masked
 * by A, drawn on top, with a multiply color that darkens it.
 */
function source(): MemoryFileSource {
  const s = new Synth(5);
  s.canvas = { pixelsPerUnit: 100, originX: 100, originY: 100, width: 200, height: 200, flags: 0 };
  s.part({ id: "Root" });
  const common = { uvs: [0, 1, 1, 1, 0, 0, 1, 0], triangles: [0, 1, 2, 1, 3, 2] };
  const a = s.mesh({ id: "A", ...common, keyforms: [{ positions: quad(-0.9, -0.4, -0.1, 0.4) }] });
  s.mesh({ id: "B", ...common, keyforms: [{ positions: quad(0.1, -0.4, 0.9, 0.4) }] });
  s.mesh({
    id: "M",
    ...common,
    masks: [a],
    keyforms: [
      { positions: quad(-0.6, -0.2, 0.6, 0.2), drawOrder: 600, multiply: [0.5, 0.5, 0.5] },
    ],
  });
  const tex = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) tex.set([200, 160, 120, 255], 4 * i);
  return MemoryFileSource.fromFiles({
    "t.model3.json": JSON.stringify({
      Version: 3,
      FileReferences: { Moc: "t.moc3", Textures: ["t.png"] },
    }),
    "t.moc3": s.build(),
    "t.png": encodePngRgba(4, 4, tex),
  });
}

const load = () => ModelRuntime.load(source(), "t.model3.json");

describe("tints in the runtime", () => {
  it("are set, read, cleared and validated by art-mesh ID", async () => {
    const rt = await load();
    expect(rt.activeTints).toBeNull();
    const v0 = rt.tintVersion;
    expect(rt.setTint("A", [0.5, 0.25, 1])).toBe(true);
    expect(rt.getTint("A")).toEqual([0.5, 0.25, 1, 1]);
    expect(rt.setTint("B", [3, -1, 0.5, 0.5])).toBe(true); // r, g, b limited to [0, 2]
    expect(rt.getTint("B")).toEqual([2, 0, 0.5, 0.5]);
    expect(rt.setTint("B", [1.8, 1, 0.5, 2])).toBe(true); // a limited to [0, 1]
    expect(rt.getTint("B")).toEqual([Math.fround(1.8), 1, 0.5, 1]);
    rt.setTint("B", [2, 0, 0.5, 0.5]);
    expect([...rt.tints.keys()]).toEqual(["A", "B"]);
    expect(rt.tintVersion).toBeGreaterThan(v0);
    expect(Array.from(rt.activeTints!.subarray(8, 12))).toEqual([1, 1, 1, 1]); // M: none
    expect(rt.setTint("Nope", [1, 1, 1])).toBe(false);
    expect(() => rt.setTint("A", [1, 1])).toThrow(RangeError);
    expect(() => rt.setTint("A", [1, NaN, 1])).toThrow(RangeError);
    expect(rt.clearTint("A")).toBe(true);
    expect(rt.clearTint("A")).toBe(false);
    expect(rt.getTint("A")).toBeNull();
    // Other data for the model keeps them, by ID.
    const next = await rt.withData((await source().read("t.moc3")) as Uint8Array);
    expect(next.getTint("B")).toEqual([2, 0, 0.5, 0.5]);
    rt.clearTints();
    expect([rt.tints.size, rt.activeTints]).toEqual([0, null]);
  });
});

describe.skipIf(!available)("tints in renders (NodeRenderer)", () => {
  let renderer: NodeRenderer;
  beforeAll(async () => {
    renderer = await NodeRenderer.open();
  }, 120000);
  afterAll(async () => {
    await renderer?.close();
  }, 60000);

  /** Straight RGBA of a 200 × 200 render. */
  const render = async (rt: ModelRuntime, tints?: Record<string, number[]>) => {
    rt.update(0);
    const r = await renderer.render(rt, { width: 200, height: 200, ...(tints ? { tints } : {}) });
    return { data: decodePng(r.png).data, notes: r.notes };
  };
  const at = (img: Uint8Array, x: number, y: number) => [
    ...img.subarray(4 * (200 * y + x), 4 * (200 * y + x) + 4),
  ];
  /** Pixels that differ, as [x, y]. */
  const changed = (a: Uint8Array, b: Uint8Array) => {
    const out: [number, number][] = [];
    for (let i = 0; i < a.length; i += 4)
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3])
        out.push([(i / 4) % 200, Math.floor(i / 4 / 200)]);
    return out;
  };
  // Pixel centers: A alone, M over A, the gap (M masked away), M over B (masked away: B shows).
  const ONLY_A = [20, 100] as const;
  const M_OVER_A = [60, 100] as const;
  const GAP = [100, 100] as const;
  const B = [150, 100] as const;
  const inA = ([x, y]: [number, number]) => x >= 10 && x < 90 && y >= 60 && y < 140;

  it("white changes no pixel", async () => {
    const rt = await load();
    const plain = (await render(rt)).data;
    expect(at(plain, ...ONLY_A)).toEqual([200, 160, 120, 255]);
    expect(at(plain, ...M_OVER_A)).toEqual([100, 80, 60, 255]);
    expect(at(plain, ...GAP)).toEqual([0, 0, 0, 0]);
    expect(at(plain, ...B)).toEqual([200, 160, 120, 255]);
    for (const id of ["A", "B", "M"]) rt.setTint(id, [1, 1, 1, 1]);
    expect(changed((await render(rt)).data, plain)).toEqual([]);
    expect(changed((await render(await load(), { A: [1, 1, 1] })).data, plain)).toEqual([]);
  });

  it("darkens exactly the chosen meshes", async () => {
    const plain = (await render(await load())).data;
    const rt = await load();
    rt.setTint("A", [0.5, 0.25, 1]);
    const tinted = (await render(rt)).data;
    expect(at(tinted, ...ONLY_A)).toEqual([100, 40, 120, 255]);
    // M lies over A, opaque, untinted: unchanged; so is B.
    expect(at(tinted, ...M_OVER_A)).toEqual(at(plain, ...M_OVER_A));
    expect(at(tinted, ...B)).toEqual(at(plain, ...B));
    const moved = changed(tinted, plain);
    expect(moved.length).toBeGreaterThan(1000);
    for (const p of moved) {
      expect(inA(p), `pixel ${p} outside A`).toBe(true);
      const [t, q] = [at(tinted, ...p), at(plain, ...p)];
      for (let c = 0; c < 3; c++) expect(t[c]!).toBeLessThanOrEqual(q[c]!);
    }
  });

  it("brightens above 1, up to white, without changing the opacity", async () => {
    const plain = (await render(await load())).data;
    const rt = await load();
    // A (200, 160, 120) at 2: red and green reach white, blue doubles.
    rt.setTint("A", [2, 2, 2]);
    // M over A (100, 80, 60) at 1.8.
    rt.setTint("M", [1.8, 1.8, 1.8]);
    // B at 2 with half opacity: the color still stops at white.
    rt.setTint("B", [2, 2, 2, 0.5]);
    const bright = (await render(rt)).data;
    const near = (got: number[], want: number[]) =>
      expect(
        got.every((x, c) => Math.abs(x - want[c]!) <= 1),
        `${got} vs ${want}`,
      ).toBe(true);
    near(at(bright, ...ONLY_A), [255, 255, 240, 255]);
    near(at(bright, ...M_OVER_A), [180, 144, 108, 255]);
    near(at(bright, ...B), [255, 255, 240, 128]);
    // The gap stays empty, and nothing outside the three meshes changes.
    expect(at(bright, ...GAP)).toEqual([0, 0, 0, 0]);
    for (const [x, y] of changed(bright, plain))
      expect(at(plain, x, y)[3], `pixel ${x}, ${y}`).toBeGreaterThan(0);
  });

  it("scales the opacity with its alpha", async () => {
    const plain = (await render(await load())).data;
    const rt = await load();
    rt.setTint("B", [1, 1, 1, 0.5]);
    const half = (await render(rt)).data;
    const [r, g, b, a] = at(half, ...B);
    expect(Math.abs(a! - 128)).toBeLessThanOrEqual(1);
    expect([r, g, b].every((x, c) => Math.abs(x! - [200, 160, 120][c]!) <= 1)).toBe(true);
    expect(changed(half, plain).every(([x, y]) => x >= 110 && x < 190 && y >= 60 && y < 140)).toBe(
      true,
    );
  });

  it("keeps masks: a tinted masking mesh masks the same pixels", async () => {
    const plain = (await render(await load())).data;
    const rt = await load();
    rt.setTint("A", [0.2, 0.2, 0.2, 0.25]); // the mask of M
    const tinted = (await render(rt)).data;
    // M still shows over A, unchanged, and stays masked away outside A.
    expect(at(tinted, ...M_OVER_A)).toEqual(at(plain, ...M_OVER_A));
    expect(at(tinted, ...GAP)).toEqual([0, 0, 0, 0]);
    expect(at(tinted, ...B)).toEqual(at(plain, ...B));
    // Only A's own pixels change, where M does not cover it.
    const mOverA = ([x, y]: [number, number]) => x >= 40 && x < 90 && y >= 80 && y < 120;
    for (const p of changed(tinted, plain)) expect(inA(p) && !mOverA(p), `pixel ${p}`).toBe(true);
    expect(at(tinted, ...ONLY_A)[3]).toBeLessThan(80);
  });

  it("takes tints as a render option over the runtime's, and notes unknown IDs", async () => {
    const rt = await load();
    rt.setTint("A", [0.5, 0.5, 0.5]);
    const r = await render(rt, { A: [1, 1, 1], Nope: [0, 0, 0] });
    expect(at(r.data, ...ONLY_A)).toEqual([200, 160, 120, 255]);
    expect(r.notes).toContain("tint of Nope ignored: no art mesh has that ID");
    await expect(renderer.render(rt, { tints: { A: [1, 1] } })).rejects.toThrow(RangeError);
  });
});

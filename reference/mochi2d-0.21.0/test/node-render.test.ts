/**
 * Rendering from Node as a library call (`NodeRenderer`, "mochi2d/node"):
 * a runtime at its pose, a model on disk and a source in memory; the same
 * pixels as the render session of `npm run render`; the fast mode with
 * downscaled textures; queued calls; refusals. A synthetic model with a
 * generated texture runs everywhere Playwright does; DeepSeek-chan's checks
 * run where it is present. Needs `npm run build:web`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { NodeRenderer, renderToPng } from "../src/lib/node-render.js";
import { encodePngRgba } from "../src/platform/node-png.js";
import { loadModelFromDisk } from "../src/lib/node.js";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { ModelRuntime } from "../src/runtime/model-runtime.js";
import { decodePng } from "../tools/lib/png.js";
import { loadPlaywright } from "../tools/lib/browser.js";
import { openRenderSession } from "../tools/lib/render-runner.js";
import { SCENARIO_FORMAT } from "../tools/lib/scenario.js";
import { Synth } from "./support/synth.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
let available = existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

/** A square mesh over the canvas center with a solid color texture, and a parameter that moves it. */
function syntheticSource(color: [number, number, number, number]): MemoryFileSource {
  const s = new Synth(4);
  s.canvas = { pixelsPerUnit: 100, originX: 100, originY: 100, width: 200, height: 200, flags: 0 };
  s.part({ id: "P" });
  const x = s.param("X", -1, 1, 0);
  const band = s.band([s.binding(x, [-1, 1])]);
  const square = (dx: number) => [-0.5 + dx, -0.5, 0.5 + dx, -0.5, -0.5 + dx, 0.5, 0.5 + dx, 0.5];
  s.mesh({
    id: "M",
    band,
    uvs: [0, 1, 1, 1, 0, 0, 1, 0],
    triangles: [0, 1, 2, 1, 3, 2],
    keyforms: [{ positions: square(-0.5) }, { positions: square(0.5) }],
  });
  const tex = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) tex.set(color, 4 * i);
  return MemoryFileSource.fromFiles({
    "sq.model3.json": JSON.stringify({
      Version: 3,
      FileReferences: { Moc: "sq.moc3", Textures: ["sq.png"] },
    }),
    "sq.moc3": s.build(),
    "sq.png": encodePngRgba(4, 4, tex),
  });
}

const pixel = (png: Uint8Array, x: number, y: number) => {
  const img = decodePng(png);
  return [...img.data.subarray(4 * (y * img.width + x), 4 * (y * img.width + x) + 4)];
};

describe("PNG encoding", () => {
  it("round-trips through a PNG decoder", () => {
    const rgba = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) % 256);
    const img = decodePng(encodePngRgba(3, 2, rgba));
    expect([img.width, img.height]).toEqual([3, 2]);
    expect([...img.data]).toEqual([...rgba]);
    expect(() => encodePngRgba(3, 2, new Uint8Array(5))).toThrow(RangeError);
  });
});

describe.skipIf(!available)("NodeRenderer (headless Chromium)", () => {
  let renderer: NodeRenderer;
  beforeAll(async () => {
    renderer = await NodeRenderer.open();
  }, 120000);
  afterAll(async () => {
    await renderer?.close();
  }, 60000);

  it("renders a source in memory and a runtime at its pose", async () => {
    const source = syntheticSource([255, 0, 0, 255]);
    // The default pose: X = 0, the square over the center.
    const a = await renderer.render({ source }, { width: 64, height: 64 });
    expect([a.width, a.height, a.reference]).toEqual([64, 64, true]);
    expect(a.pixelsPerUnit).toBeCloseTo(32, 6);
    expect(pixel(a.png, 32, 32)).toEqual([255, 0, 0, 255]);
    expect(pixel(a.png, 2, 32)[3]).toBe(0);
    // A runtime's own values: X = 1 moves the square right.
    const rt = await ModelRuntime.load(source, "sq.model3.json");
    rt.setParameter("X", 1);
    rt.update(0);
    const b = await renderer.render(rt, { width: 64, height: 64 });
    expect(pixel(b.png, 50, 32)).toEqual([255, 0, 0, 255]);
    expect(pixel(b.png, 14, 32)[3]).toBe(0);
    // Options override the runtime's values; a background fills the rest.
    const c = await renderer.render(rt, {
      width: 64,
      height: 64,
      parameters: { X: -1 },
      background: [0, 0, 1, 1],
    });
    expect(pixel(c.png, 14, 32)).toEqual([255, 0, 0, 255]);
    expect(pixel(c.png, 50, 32)).toEqual([0, 0, 255, 255]);
  }, 60000);

  it("queues concurrent renders, and refuses bad sizes and models", async () => {
    const source = syntheticSource([0, 255, 0, 255]);
    const shots = await Promise.all(
      [-1, 0, 1].map((x) =>
        renderer.render({ source }, { width: 32, height: 32, parameters: { X: x } }),
      ),
    );
    // At x = 8 px (model −0.47): inside the square for X = −1 and 0, not for X = 1.
    expect(shots.map((s) => pixel(s.png, 8, 16)[1])).toEqual([255, 255, 0]);
    await expect(renderer.render({ source }, { width: 0 })).rejects.toThrow(RangeError);
    const broken = MemoryFileSource.fromFiles({ "b.model3.json": "{" });
    await expect(renderer.render({ source: broken })).rejects.toThrow();
    // The renderer still works after a failure.
    const ok = await renderer.render({ source }, { width: 16, height: 16 });
    expect(pixel(ok.png, 8, 8)).toEqual([0, 255, 0, 255]);
  }, 60000);

  it.skipIf(!HAVE_DEEPSEEK)(
    "gives the pixels of the render session, from a runtime and from disk",
    async () => {
      const rt = await loadModelFromDisk(DEEPSEEK);
      for (const e of ["physics", "eyeBlink", "breath", "look", "idle"] as const)
        rt.setEffect(e, false);
      rt.setParameter("ParamAngleX", 20);
      rt.update(0);
      const mine = await renderer.render(rt, { width: 256, height: 384 });
      const session = await openRenderSession(root);
      try {
        const parameters: Record<string, number> = {};
        for (const p of rt.parameters) parameters[p.id] = rt.getParameter(p.id);
        const partOpacities: Record<string, number> = {};
        for (const p of rt.parts) partOpacities[p.id] = rt.getPartOpacity(p.id);
        const ref = await session.render({
          format: SCENARIO_FORMAT,
          id: "node-render",
          model: "DeepSeek/大肥鱼.model3.json",
          parameters,
          partOpacities,
          render: { width: 256, height: 384 },
        });
        expect(Buffer.from(decodePng(mine.png).data).equals(Buffer.from(ref.rgba))).toBe(true);
      } finally {
        await session.close();
      }
      // From disk, at the default pose; and the one-shot helper.
      const disk = await renderer.render(join(DEEPSEEK, "大肥鱼.model3.json"), {
        width: 128,
        height: 128,
      });
      const once = await renderToPng(DEEPSEEK, { width: 128, height: 128 });
      expect(Buffer.from(once.png).equals(Buffer.from(disk.png))).toBe(true);
      expect(disk.renderer).toMatch(/SwiftShader/i);
    },
    180000,
  );

  it.skipIf(!HAVE_DEEPSEEK)(
    "has a fast mode with downscaled textures, close to the reference",
    async () => {
      const path = join(DEEPSEEK, "大肥鱼.model3.json");
      const t0 = performance.now();
      const ref = await renderer.render(path, { width: 256, height: 256 });
      const t1 = performance.now();
      const fast = await renderer.render(path, {
        width: 256,
        height: 256,
        fast: { maxTextureSize: 512 },
      });
      const t2 = performance.now();
      const again = await renderer.render(path, { width: 256, height: 256, fast: true });
      expect(fast.reference).toBe(false);
      expect(fast.notes.join(" ")).toMatch(/fast render, not the reference: textures at most 512/);
      expect(again.notes.join(" ")).toMatch(/at most 1024/);
      const a = decodePng(ref.png).data;
      const b = decodePng(fast.png).data;
      let sum = 0;
      for (let i = 3; i < a.length; i += 4) sum += Math.abs(a[i]! - b[i]!);
      // Mostly the same coverage, slightly softer textures.
      expect(sum / (a.length / 4) / 255).toBeLessThan(0.02);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
      // Informational: the first reference render includes loading its textures.
      void [t1 - t0, t2 - t1];
    },
    180000,
  );
});

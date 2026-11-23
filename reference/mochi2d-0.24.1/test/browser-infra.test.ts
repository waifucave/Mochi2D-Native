/**
 * WebGL2 infrastructure checks in headless Chromium (blend states, geometry
 * streaming, render target pool, readback, texture alpha). Needs
 * `npm run build` and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRenderSession, type RenderSession } from "../tools/lib/render-runner.js";
import { loadPlaywright } from "../tools/lib/browser.js";

const root = resolve(__dirname, "..");
let available = existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

describe.skipIf(!available)("WebGL2 infrastructure (headless Chromium)", () => {
  let session: RenderSession;
  beforeAll(async () => {
    session = await openRenderSession(root);
  });
  afterAll(async () => {
    await session?.close();
  });

  it("prepares textures exactly: premultiplication and the mip chains (§2b)", async () => {
    const r = await session.call<{
      premultiplyMismatches: number;
      mipMismatches: number;
      levels: number;
      npotMismatches: number;
      npotLevels: number;
      first: string | null;
    }>("selfTest", "texture-exact");
    expect(r.premultiplyMismatches, r.first ?? "").toBe(0);
    expect(r.mipMismatches, r.first ?? "").toBe(0);
    expect(r.levels).toBe(7); // 64×32 … 1×1
    // 37×21 … 18×10, 9×5, 4×2, 2×1, 1×1: the same rule, not the driver's generator.
    expect(r.npotMismatches, r.first ?? "").toBe(0);
    expect(r.npotLevels).toBe(6);
  });

  it("reports WebGL limits", async () => {
    const info = await session.call<{ maxTextureSize: number; renderer: string }>("info");
    expect(info.maxTextureSize).toBeGreaterThanOrEqual(4096);
    expect(info.renderer).toMatch(/\w/);
  });

  it("blend states match the CPU reference within 1 step", async () => {
    const r = await session.call<{ states: number; maxErrorLsb: number; worst?: unknown }>(
      "selfTest",
      "blend",
    );
    expect(r.states).toBeGreaterThan(200);
    expect(r.maxErrorLsb, JSON.stringify(r.worst)).toBeLessThanOrEqual(1);
  });

  it("streams hundreds of meshes through shared buffers", async () => {
    const r = await session.call<{
      wrongFrame1: number;
      wrongFrame2: number;
      msPerFrame: number;
      uploadCallsPerFrame: number;
    }>("selfTest", "geometry-stream", { meshes: 500, side: 8, frames: 30 });
    expect(r.wrongFrame1).toBe(0);
    expect(r.wrongFrame2).toBe(0);
    // All 500 meshes change each frame, yet ranges merge into very few uploads.
    expect(r.uploadCallsPerFrame).toBeLessThanOrEqual(2);
  });

  it("pools render targets by spec, evicts idle ones and supports stencil", async () => {
    const r = await session.call<{
      sameObjectReused: boolean;
      differentSpecsDistinct: boolean;
      statsAfterAcquire: { total: number; inUse: number; created: number; reused: number };
      statsAfterEvict: { total: number; inUse: number };
      stencilInside: number[];
      stencilOutside: number[];
      trackedBytes: number;
      doubleReleaseThrows: boolean;
    }>("selfTest", "render-target-pool");
    expect(r.sameObjectReused).toBe(true);
    expect(r.differentSpecsDistinct).toBe(true);
    expect(r.statsAfterAcquire).toMatchObject({ total: 3, inUse: 3, created: 3, reused: 1 });
    expect(r.trackedBytes).toBe(64 * 32 * 4 + 64 * 32 * 5 + 17 * 300 * 4);
    expect(r.stencilInside).toEqual([0, 255, 0, 255]);
    expect(r.stencilOutside).toEqual([0, 0, 0, 0]);
    expect(r.doubleReleaseThrows).toBe(true);
    // a and b were idle for more than 2 frames and got destroyed; c is still in use.
    expect(r.statsAfterEvict).toMatchObject({ total: 1, inUse: 1 });
  });

  it("reads back premultiplied or straight alpha, top row first", async () => {
    const r = await session.call<{
      premultiplied: number[];
      straight: number[];
      topRowIsTop: boolean;
    }>("selfTest", "readback");
    expect(r.premultiplied).toEqual([60, 30, 0, 120]);
    expect(r.straight).toEqual([128, 64, 0, 120]);
    expect(r.topRowIsTop).toBe(true);
  });

  it("uploads decoded textures exactly, in one call or in strips, from main thread or worker", async () => {
    const r = await session.call<{
      straightExact: boolean;
      premultipliedMaxError: number;
      stripMatchesSingle: boolean;
      workerMatchesMain: boolean | null;
    }>("selfTest", "texture-upload");
    expect(r.straightExact).toBe(true);
    expect(r.premultipliedMaxError).toBeLessThanOrEqual(1);
    expect(r.stripMatchesSingle).toBe(true);
    expect(r.workerMatchesMain).toBe(true);
  });
});

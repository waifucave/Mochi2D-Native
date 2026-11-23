/**
 * What each library entry point pulls in, bundled as the build bundles it
 * (scripts/package-size.mjs, `npm run size`): `mochi2d/headless` no WebGL,
 * DOM or Node code, `mochi2d/pixi` neither the viewer nor PixiJS itself (and
 * `MochiSprite` alone not `MochiView`), and each within a size ceiling
 * (docs/architecture.md, "Package size").
 */
import { beforeAll, describe, expect, it } from "vitest";
import { measureAll } from "../scripts/package-size.mjs";

type Measured = Awaited<ReturnType<typeof measureAll>>[number];
let all: Measured[] = [];
const get = (name: string) => all.find((m) => m.name === name)!;

/** Gzipped ceilings, about 15 % above 0.16.0's sizes. */
const CEILING_KIB: Record<string, number> = {
  mochi2d: 140,
  "mochi2d/headless": 98,
  "mochi2d/node": 102,
  "mochi2d/pixi": 143,
};

// Browser and GPU globals, as identifiers (not inside other words).
const DOM =
  /\b(document|navigator|window\.|WebGL2?RenderingContext|HTMLCanvasElement|HTMLImageElement|OffscreenCanvas|getContext|requestAnimationFrame|AudioContext|createImageBitmap|localStorage|matchMedia)\b/;

beforeAll(async () => {
  all = await measureAll();
}, 60000);

describe("the library's entry points", () => {
  it("headless pulls in no WebGL, DOM or Node code", () => {
    for (const name of ["mochi2d/headless", "mochi2d/headless: { ModelRuntime }"]) {
      const m = get(name);
      const outside = m.inputs.filter(
        (i) =>
          !/^src\/(core|anim|runtime|conformance)\//.test(i) &&
          !["src/lib/headless.ts", "src/lib/version.ts"].includes(i) &&
          !i.startsWith("node_modules/fflate/"),
      );
      expect(outside, name).toEqual([]);
      expect(
        m.inputs.filter((i) => i.startsWith("src/core/render/")),
        name,
      ).toEqual([
        // Pure arithmetic: where a model goes in an image.
        ...(name === "mochi2d/headless" ? ["src/core/render/framing.ts"] : []),
      ]);
      expect(m.code.match(DOM)?.[0] ?? null, name).toBe(null);
      expect(m.code.match(/["']node:|\brequire\(|\bprocess\./)?.[0] ?? null, name).toBe(null);
    }
  });

  it("node adds only Node code to headless", () => {
    const headless = new Set(get("mochi2d/headless").inputs);
    const added = get("mochi2d/node").inputs.filter((i) => !headless.has(i));
    for (const i of added)
      // fflate's Node build in place of its browser one; and the renderer's
      // rebuild of typed errors from its page (pure code, no Node APIs).
      expect(i).toMatch(
        /^src\/(lib\/node(-render)?|platform\/(node-|png-encode|playwright|wire-errors)|core\/io\/error-wire)|^node_modules\/fflate\//,
      );
  });

  it("pixi pulls in neither the viewer nor PixiJS, and MochiSprite alone not MochiView", () => {
    for (const name of ["mochi2d", "mochi2d/pixi", "mochi2d/pixi: { MochiSprite }"]) {
      const m = get(name);
      expect(
        m.inputs.filter((i) => /^src\/(viewer|harness)\/|^node_modules\/pixi\.js\//.test(i)),
        name,
      ).toEqual([]);
    }
    const pixi = get("mochi2d/pixi");
    expect(pixi.code).toMatch(/from"pixi\.js"/);
    const sprite = get("mochi2d/pixi: { MochiSprite }");
    expect(
      sprite.inputs.filter((i) =>
        /^src\/lib\/(view|item|stage|gestures|stage-model)\.ts$|^src\/lib\/items\//.test(i),
      ),
    ).toEqual([]);
  });

  it("stays within its size ceiling", () => {
    for (const [name, ceiling] of Object.entries(CEILING_KIB))
      expect(get(name).gzip / 1024, name).toBeLessThan(ceiling);
  });
});

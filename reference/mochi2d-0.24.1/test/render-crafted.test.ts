/**
 * Renders of crafted variants of DeepSeek-chan's file, built at test time
 * from DeepSeek-chan's model file and drawn with its textures:
 *
 * - q2c, q2d: masked offscreens. Offscreen masks use their own 256 × 256
 *   buffer (C8). Checked against the official alpha ramp along one row.
 * - qm-eye (ParamEyeLOpen's last key at 1.25) and q3a (ParamMouthOpenY's at
 *   0.5): a mask mesh is inactive while the drawables it masks are visible.
 *   Under the reference contract it is rasterized at its stale vertices
 *   (C13); the viewer's active-only rule gives a different image, and both
 *   agree on the controls where the mask is active.
 *
 * The PNG hashes of all eleven scenarios are locked in a snapshot (on the
 * rasterizer of the DeepSeek-chan render hashes only). Needs `npm run build`
 * and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  openRenderSession,
  type RenderOptions,
  type RenderSession,
} from "../tools/lib/render-runner.js";
import { loadPlaywright } from "../tools/lib/browser.js";
import type { Scenario } from "../tools/lib/scenario.js";
import { encodePng } from "../tools/lib/png.js";
import { RENDER_HASH_FILE, sha256, type RenderHashes } from "../tools/lib/render-hashes.js";
import { loadMoc } from "../src/core/moc/model.js";
import { bindingKeys, craftDeepseek, craftQ2, setLastKey } from "./support/crafted.js";
import { HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
// DeepSeek-chan (assets/models/DeepSeek/) is needed too.
let available = HAVE_DEEPSEEK && existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}
const golden = JSON.parse(readFileSync(join(root, RENDER_HASH_FILE), "utf8")) as RenderHashes;

type Bg = [number, number, number, number];
const GRAY: Bg = [0.5, 0.5, 0.5, 1];
const WHITE: Bg = [1, 1, 1, 1];
const CLEAR: Bg = [0, 0, 0, 0];

function scenario(
  id: string,
  size: [number, number],
  background: Bg,
  view: [number, number, number] | null,
  parameters: Record<string, number> = {},
): Scenario {
  return {
    format: "mochi2d-scenario/0",
    id,
    model: "DeepSeek/大肥鱼.model3.json",
    parameters,
    partOpacities: {},
    render: {
      width: size[0],
      height: size[1],
      background,
      ...(view ? { view: { x: view[0], y: view[1], pixelsPerUnit: view[2] } } : {}),
    },
  };
}

/** The crafts, built once each. */
const crafts = {
  q2c: () => craftQ2("q2c"),
  q2d: () => craftQ2("q2d"),
  /** qm-eye: ParamEyeLOpen (binding 42) keys 0, 0.2, 1, 1.5 → last key 1.25. */
  qmEye: () => craftDeepseek((f) => setLastKey(f, 42, 1.25)),
  /** q3a: ParamMouthOpenY (binding 46) keys 0, 1 → last key 0.5. */
  q3a: () => craftDeepseek((f) => setLastKey(f, 46, 0.5)),
};
type Craft = keyof typeof crafts;
const built = new Map<Craft, Uint8Array>();
const craft = (c: Craft) => {
  if (!built.has(c)) built.set(c, crafts[c]());
  return built.get(c)!;
};

const SCENARIOS: { craft: Craft; sc: Scenario }[] = [
  ...(["q2c", "q2d"] as const).flatMap((c) => [
    { craft: c, sc: scenario(`${c}-full`, [384, 768], GRAY, null) },
    { craft: c, sc: scenario(`${c}-leg`, [512, 512], WHITE, [0.086, -0.4, 1500]) },
    {
      craft: c,
      sc: scenario(`${c}-leg-pose`, [512, 512], CLEAR, [0.08, -0.5, 1500], { HipAngleX: 20 }),
    },
  ]),
  {
    craft: "qmEye",
    sc: scenario("qm-eye-inactive", [256, 256], WHITE, [0.0458, 0.6085, 2500], {
      ParamEyeLOpen: 1.5,
    }),
  },
  {
    craft: "qmEye",
    sc: scenario("qm-eye-control", [256, 256], WHITE, [0.0458, 0.6085, 2500], {
      ParamEyeLOpen: 1.2,
    }),
  },
  {
    craft: "q3a",
    sc: scenario("qm-mouth-inactive", [256, 256], GRAY, [0, 0.55, 4500], { ParamMouthOpenY: 1 }),
  },
  {
    craft: "q3a",
    sc: scenario("qm-mouth-control", [256, 256], GRAY, [0, 0.55, 4500], {
      ParamMouthOpenY: 0.4,
    }),
  },
  {
    craft: "q3a",
    sc: scenario("qm-full-inactive", [384, 768], GRAY, null, { ParamMouthOpenY: 1 }),
  },
];

/** Pixels differing by more than `t` in any channel, and the largest difference. */
function compare(a: Uint8Array, b: Uint8Array, t = 0): { over: number; max: number } {
  let over = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c]! - b[i + c]!));
    if (d > t) over++;
    max = Math.max(max, d);
  }
  return { over, max };
}

describe.skipIf(!available)("crafted render scenarios (headless Chromium)", () => {
  let session: RenderSession;
  const images = new Map<string, Uint8Array>();
  const render = async (c: Craft, sc: Scenario, opts: RenderOptions = {}) =>
    session.render(sc, { alpha: "premultiplied", moc: craft(c), ...opts });

  beforeAll(async () => {
    session = await openRenderSession(root);
  }, 120000);
  afterAll(async () => {
    await session?.close();
  });

  it("crafts the files of section 6", () => {
    expect(bindingKeys(42)).toEqual([0, 0.2, 1, 1.5].map(Math.fround));
    expect(bindingKeys(46)).toEqual([0, 1]);
    const q2c = loadMoc(craft("q2c"));
    const q2d = loadMoc(craft("q2d"));
    expect(q2c.version).toBe(6);
    expect(q2c.offscreens.part).toHaveLength(2);
    const masks = (m: typeof q2c) => Array.from(m.offscreens.masks, (l) => l.length);
    expect(masks(q2c)).toEqual([2, 2]);
    expect(masks(q2d)).toEqual([0, 2]);
    const ids = q2c.meshes.ids;
    expect(Array.from(q2c.offscreens.masks[0]!, (d) => ids[d])).toEqual([
      "ArtMesh584",
      "ArtMesh653",
    ]);
  });

  for (const { craft: c, sc } of SCENARIOS)
    it(`${sc.id}: renders, locked by hash`, async (ctx) => {
      const r = await render(c, sc);
      images.set(sc.id, r.rgba);
      expect(r.masks).toEqual({
        mode: "per-drawable",
        size: 4096,
        offscreenSize: 256,
        meshes: "all",
      });
      if (c === "q2c" || c === "q2d") expect(r.stats?.pipeline).toBe("layered");
      const hash = sha256(encodePng({ width: r.width, height: r.height, data: r.rgba }));
      if (r.renderer === golden.renderer) expect(hash).toMatchSnapshot();
      else ctx.annotate(`hash not checked: rasterizer "${r.renderer}" is not "${golden.renderer}"`);
    }, 120000);

  it("C8: offscreen masks are soft like the official 256 buffer, not sharp like 4096", async () => {
    const sc = SCENARIOS.find((s) => s.sc.id === "q2d-leg-pose")!.sc;
    const now = images.get("q2d-leg-pose") ?? (await render("q2d", sc)).rgba;
    const old = (await render("q2d", sc, { offscreenMaskSize: 4096 })).rgba;
    // The official alpha along row y = 200 from x = 190 (D1).
    const official = [5, 43, 131, 165, 181, 196, 212, 227, 242, 247, 251];
    const row = (img: Uint8Array) => official.map((_, i) => img[(200 * 512 + 190 + i) * 4 + 3]!);
    const ours = row(now);
    console.log(
      `q2d-leg-pose alpha, y = 200, x = 190…200: ${ours.join(", ")} (official ${official.join(", ")}; 4096 buffer ${row(old).join(", ")})`,
    );
    ours.forEach((a, i) =>
      expect(
        Math.abs(a - official[i]!),
        `x = ${190 + i}: ${ours} vs ${official}`,
      ).toBeLessThanOrEqual(3),
    );
    // With a 4096 offscreen buffer the edge is sharp, far from the official ramp.
    expect(Math.max(...row(old).map((a, i) => Math.abs(a - official[i]!)))).toBeGreaterThan(50);
    expect(compare(now, old, 16).over).toBeGreaterThan(1000);
  }, 120000);

  it("C13: inactive mask meshes draw at their stale vertices; controls agree with the active-only rule", async () => {
    const lines: string[] = [];
    for (const id of [
      "qm-eye-inactive",
      "qm-mouth-inactive",
      "qm-full-inactive",
      "qm-eye-control",
      "qm-mouth-control",
    ]) {
      const { craft: c, sc } = SCENARIOS.find((s) => s.sc.id === id)!;
      const all = images.get(id) ?? (await render(c, sc)).rgba;
      const active = (await render(c, sc, { maskMeshes: "active" })).rgba;
      const d = compare(all, active);
      lines.push(`${id}: ${d.over} pixels differ, max ${d.max}`);
      if (id.endsWith("control")) expect(d.over, id).toBe(0);
      else {
        expect(d.max, id).toBeGreaterThan(40);
        expect(d.over, id).toBeGreaterThan(50);
      }
    }
    console.log(lines.join("\n"));
  }, 300000);
});

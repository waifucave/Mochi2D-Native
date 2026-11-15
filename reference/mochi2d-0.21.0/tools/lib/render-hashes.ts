/**
 * SHA-256 of the PNGs `npm run render` writes for the DeepSeek-chan render
 * scenarios: the straight default and `--alpha premultiplied`.
 * The hashes lock the reference output byte for byte while the renderer is
 * optimized. They are only comparable on the rasterizer that captured them.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { encodePng } from "./png.js";
import { loadScenarios, type Scenario } from "./scenario.js";
import type { RenderSession } from "./render-runner.js";
import type { AlphaMode } from "../../src/core/image/alpha.js";

export const RENDER_HASH_FILE = join("test", "golden", "deepseek-render-hashes.json");
export const RENDER_HASH_SCENARIOS = join("test", "scenarios", "deepseek-render");
export const RENDER_HASH_ALPHAS: readonly AlphaMode[] = ["straight", "premultiplied"];

export interface RenderHashes {
  /** WebGL renderer string of the capture; hashes from another rasterizer may differ. */
  renderer: string;
  hashes: Record<string, Record<AlphaMode, string>>;
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The DeepSeek-chan render scenarios, sorted by id. */
export async function renderHashScenarios(root: string): Promise<Scenario[]> {
  const loaded = await loadScenarios([join(root, RENDER_HASH_SCENARIOS)]);
  const out: Scenario[] = [];
  for (const s of loaded) {
    if (!s.ok) throw new Error(`${s.file}: ${s.error}`);
    out.push(s.scenario);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Renders one scenario as `npm run render` does and hashes the PNG bytes. */
export async function hashRender(
  session: RenderSession,
  scenario: Scenario,
  alpha: AlphaMode,
): Promise<{ hash: string; renderer: string }> {
  const r = await session.render(scenario, { alpha });
  const png = encodePng({ width: r.width, height: r.height, data: r.rgba });
  return { hash: sha256(png), renderer: r.renderer };
}

/** Hashes of every scenario in both alpha conventions. */
export async function computeRenderHashes(
  session: RenderSession,
  scenarios: readonly Scenario[],
): Promise<RenderHashes> {
  const hashes: RenderHashes["hashes"] = {};
  let renderer = "";
  for (const s of scenarios) {
    const entry = {} as Record<AlphaMode, string>;
    for (const alpha of RENDER_HASH_ALPHAS) {
      const r = await hashRender(session, s, alpha);
      entry[alpha] = r.hash;
      renderer = r.renderer;
    }
    hashes[s.id] = entry;
  }
  return { renderer, hashes };
}

/**
 * The render contract (4f–4g) through
 * `npm run render`'s runner: premultiplied PNGs, the status file with the
 * recommended keys and the PNG's file name, and `rx-texture-too-large`
 * (the texbig craft, written for the test under the gitignored
 * assets/models/ and removed afterwards): error TextureTooLarge, no PNG.
 * Needs `npm run build` and the pre-installed Playwright; skipped otherwise.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runRender } from "../tools/lib/render-runner.js";
import { loadPlaywright } from "../tools/lib/browser.js";
import { encodePng, decodePng } from "../tools/lib/png.js";
import { craftSettings } from "../tools/lib/catalog/write.js";
import { renderCatalog } from "../tools/lib/catalog/scenarios.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
// DeepSeek-chan (assets/models/DeepSeek/) is needed too.
let available = HAVE_DEEPSEEK && existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  available = false;
}

const folder = `test-render-contract-${process.pid}`;
const modelDir = join(root, "assets", "models", folder);

describe.skipIf(!available)("render contract (4f–4g)", () => {
  afterAll(async () => {
    await rm(modelDir, { recursive: true, force: true });
  });

  it("writes premultiplied PNGs with full status files, and TextureTooLarge without a PNG", async () => {
    // The texbig craft (4s): DeepSeek-chan's moc, texture_00 replaced by 16384 × 4 white.
    const deepseek = DEEPSEEK;
    await mkdir(join(modelDir, "大肥鱼.4096"), { recursive: true });
    await writeFile(join(modelDir, "m.model3.json"), craftSettings());
    await symlink(relative(modelDir, join(deepseek, "大肥鱼.moc3")), join(modelDir, "m.moc3"));
    await writeFile(
      join(modelDir, "大肥鱼.4096", "texture_00.png"),
      encodePng({ width: 16384, height: 4, data: new Uint8Array(16384 * 4 * 4).fill(255) }),
    );
    for (let i = 1; i < 5; i++) {
      const name = `texture_0${i}.png`;
      await symlink(
        relative(join(modelDir, "大肥鱼.4096"), join(deepseek, "大肥鱼.4096", name)),
        join(modelDir, "大肥鱼.4096", name),
      );
    }
    const catalog = renderCatalog();
    const texbig = catalog.find((e) => e.id === "rx-texture-too-large")!.scenario;
    const tiny = catalog.find((e) => e.id === "rx-tiny")!.scenario;
    const dir = await mkdtemp(join(tmpdir(), "mochi2d-render-"));
    await writeFile(
      join(dir, "texbig.json"),
      JSON.stringify({ ...texbig, model: `${folder}/m.model3.json` }),
    );
    await writeFile(join(dir, "tiny.json"), JSON.stringify(tiny));
    const out = join(dir, "out");
    const { total, failed } = await runRender([dir], out, root, "mochi2d@test");
    expect([total, failed]).toEqual([2, 1]);

    const status = async (id: string) =>
      JSON.parse(await readFile(join(out, `${id}.render.json`), "utf8")) as Record<string, unknown>;
    const ok = await status("rx-tiny");
    expect(ok).toMatchObject({
      format: "mochi2d-render/0",
      scenario: "rx-tiny",
      producer: "mochi2d@test",
      error: null,
      png: "rx-tiny.png",
      alpha: "premultiplied",
      width: 96,
      height: 192,
      masks: { mode: "per-drawable", size: 4096, offscreenSize: 256 },
    });
    expect(typeof ok.pixelsPerUnit).toBe("number");
    expect(ok.center).toHaveLength(2);
    const png = decodePng(new Uint8Array(await readFile(join(out, "rx-tiny.png"))));
    expect([png.width, png.height]).toEqual([96, 192]);
    // Premultiplied over the opaque gray background: every pixel is opaque.
    for (let i = 3; i < png.data.length; i += 4) expect(png.data[i]).toBe(255);

    const big = await status("rx-texture-too-large");
    expect(big.error).toMatchObject({ kind: "TextureTooLarge" });
    expect(big.png).toBeNull();
    expect(existsSync(join(out, "rx-texture-too-large.png"))).toBe(false);
  }, 300000);
});

/**
 * Headless rendering: serves dist/web, opens harness.html in Chromium, renders
 * scenarios offscreen and writes PNGs.
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startStaticServer, type RequestHandler } from "./static-server.js";
import { CHROMIUM_OFFLINE_ARGS, launchChromium } from "./browser.js";
import { encodePng } from "./png.js";
import { loadScenarios, type Scenario } from "./scenario.js";
import type { Page } from "./playwright-types.js";
import type { AlphaMode } from "../../src/core/image/alpha.js";

export const DEFAULT_RENDER_SIZE = { width: 1024, height: 1024 };

interface HarnessResult {
  width: number;
  height: number;
  rgbaBase64: string;
  alpha: AlphaMode;
  renderer: string;
  notes?: string[];
  pixelsPerUnit?: number;
  center?: [number, number];
  masks?: { mode: string; size: number; offscreenSize?: number; meshes?: string };
  stats?: Record<string, unknown>;
}

export interface RenderOptions {
  /**
   * Alpha convention of the image. Default "straight" for a session's
   * `render`; `runRender` writes conformance PNGs, premultiplied by default
   * (4g).
   */
  alpha?: AlphaMode;
  /** Mask buffer size; default the reference 4096 (§2g.3). */
  maskSize?: number;
  /**
   * A crafted `.moc3` drawn in place of the scenario model's own, with that
   * model's textures (crafts built at test time; never written to disk).
   */
  moc?: Uint8Array;
  /** Tests only, with `moc`: offscreen mask buffer size (default 256) and mask-mesh rule (default "all"). */
  offscreenMaskSize?: number;
  maskMeshes?: "all" | "active";
  /** A faster render that is not the reference: downscaled textures and the mask atlas. */
  fast?: { maxTextureSize?: number };
}

export interface RenderOutcome {
  format: "mochi2d-render/0";
  scenario: string;
  producer: string;
  error: null | { kind: string; message: string };
  png: string | null;
  /** Alpha convention of the PNG. */
  alpha?: AlphaMode;
  width?: number;
  height?: number;
  renderer?: string;
  /** Image pixels per output unit k and the output-space image center (§2i). */
  pixelsPerUnit?: number;
  center?: [number, number];
  /** Mask configuration (§2g.3). */
  masks?: { mode: string; size: number; offscreenSize?: number; meshes?: string };
  /** Renderer statistics (pipeline, draws, masked draws, layers). */
  stats?: Record<string, unknown>;
  /** Caveats about the rendering. */
  notes?: string[];
  milliseconds?: number;
}

export interface RenderSession {
  render(
    sc: Scenario,
    opts?: RenderOptions,
  ): Promise<{
    width: number;
    height: number;
    rgba: Uint8Array;
    alpha: AlphaMode;
    renderer: string;
    notes: string[];
    pixelsPerUnit?: number;
    center?: [number, number];
    masks?: { mode: string; size: number; offscreenSize?: number; meshes?: string };
    stats?: Record<string, unknown>;
  }>;
  /** Calls another `window.mochi2dHarness` method (info, selfTest, probeTextures). */
  call<R = unknown>(method: string, ...args: unknown[]): Promise<R>;
  /** Base URL of the local server (models are under `models/`). */
  readonly baseUrl: string;
  close(): Promise<void>;
}

export interface RenderSessionOptions {
  /** Serves /models/ instead of the repository's models (for example, one model in memory). */
  modelsHandler?: RequestHandler;
  /**
   * Keeps Chromium off the network: offline flags, and every request that is
   * not for the local server is aborted.
   */
  offline?: boolean;
}

/** Starts the server + browser once; render many scenarios through it. */
export async function openRenderSession(
  repoRoot: string,
  webDir = join(repoRoot, "dist", "web"),
  options: RenderSessionOptions = {},
): Promise<RenderSession> {
  await access(join(webDir, "harness.html")).catch(() => {
    throw new Error(`${join(webDir, "harness.html")} not found. Run "npm run build" first.`);
  });
  const server = await startStaticServer(
    webDir,
    repoRoot,
    0,
    "127.0.0.1",
    options.modelsHandler ? { modelsHandler: options.modelsHandler } : {},
  );
  let browser;
  try {
    browser = await launchChromium(options.offline ? CHROMIUM_OFFLINE_ARGS : []);
  } catch (e) {
    await server.close();
    throw e;
  }
  const page: Page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  if (options.offline) {
    const local = new URL(server.url).origin;
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const ok = url.origin === local || url.protocol === "data:" || url.protocol === "blob:";
      return ok ? route.continue() : route.abort();
    });
  }
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });
  await page.goto(new URL("harness.html", server.url).href, { waitUntil: "load" });
  try {
    await page.waitForFunction(
      "window.mochi2dHarness && window.mochi2dHarness.ready === true",
      undefined,
      { timeout: 15000 },
    );
  } catch {
    const msg = `Render harness did not initialize${pageErrors.length ? ": " + pageErrors.join("; ") : ""}`;
    await browser.close();
    await server.close();
    throw new Error(msg);
  }
  const call = async <R>(method: string, ...args: unknown[]): Promise<R> => {
    try {
      return await page.evaluate<R, { method: string; args: unknown[] }>(
        (q) =>
          (
            window as unknown as {
              mochi2dHarness: Record<string, (...a: unknown[]) => unknown>;
            }
          ).mochi2dHarness[q.method]!(...q.args) as R,
        { method, args },
      );
    } catch (e) {
      if (pageErrors.length) (e as Error).message += ` (page errors: ${pageErrors.join("; ")})`;
      throw e;
    }
  };
  return {
    baseUrl: server.url,
    call,
    async render(sc, opts = {}) {
      const size = sc.render ?? DEFAULT_RENDER_SIZE;
      const req = {
        width: size.width,
        height: size.height,
        ...(sc.render?.background ? { background: sc.render.background } : {}),
        ...(sc.render?.view ? { view: sc.render.view } : {}),
        ...(opts.maskSize ? { maskSize: opts.maskSize } : {}),
        alpha: opts.alpha ?? "straight",
        ...(sc["x-builtinScene"] ? { builtinScene: sc["x-builtinScene"] } : {}),
        ...(sc.model ? { model: sc.model } : {}),
        ...(opts.moc ? { mocBase64: Buffer.from(opts.moc).toString("base64") } : {}),
        ...(opts.offscreenMaskSize ? { offscreenMaskSize: opts.offscreenMaskSize } : {}),
        ...(opts.maskMeshes ? { maskMeshes: opts.maskMeshes } : {}),
        ...(opts.fast ? { fast: opts.fast } : {}),
        parameters: sc.parameters,
        partOpacities: sc.partOpacities,
      };
      const r = await call<HarnessResult>("render", req);
      return {
        width: r.width,
        height: r.height,
        rgba: new Uint8Array(Buffer.from(r.rgbaBase64, "base64")),
        alpha: r.alpha,
        renderer: r.renderer,
        notes: r.notes ?? [],
        ...(r.pixelsPerUnit !== undefined ? { pixelsPerUnit: r.pixelsPerUnit } : {}),
        ...(r.center ? { center: r.center } : {}),
        ...(r.masks ? { masks: r.masks } : {}),
        ...(r.stats ? { stats: r.stats } : {}),
      };
    },
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

/**
 * The error kinds of 4b: a model that cannot be read or fails
 * validation is a ModelLoadError; TextureTooLarge and InvalidScenario stay.
 */
function errorKind(kind: string): string {
  if (
    /^(MocFormatError|SettingsFormatError|ModelSettingsError|FileNotFoundError|ModelLoadError)$/.test(
      kind,
    )
  )
    return "ModelLoadError";
  return kind;
}

export async function runRender(
  inputs: string[],
  outDir: string,
  repoRoot: string,
  producer: string,
  log: (line: string) => void = () => {},
  opts: RenderOptions = {},
): Promise<{ total: number; failed: number }> {
  await mkdir(outDir, { recursive: true });
  opts = { ...opts, alpha: opts.alpha ?? "premultiplied" };
  // Scenarios on the same model render together, so its textures are decoded once.
  const loaded = (await loadScenarios(inputs))
    .map((item, i) => ({ item, i, model: item.ok ? (item.scenario.model ?? "") : "" }))
    .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : a.i - b.i))
    .map((x) => x.item);
  let failed = 0;
  let session: RenderSession | null = null;
  let sessionError: Error | null = null;
  for (const item of loaded) {
    const id = item.ok ? item.scenario.id : item.id;
    const outcome: RenderOutcome = {
      format: "mochi2d-render/0",
      scenario: id,
      producer,
      error: null,
      png: null,
    };
    const t0 = performance.now();
    try {
      if (!item.ok) throw Object.assign(new Error(item.error), { name: "InvalidScenario" });
      if (!session && !sessionError) {
        try {
          session = await openRenderSession(repoRoot);
        } catch (e) {
          sessionError = e as Error;
        }
      }
      if (!session) throw sessionError!;
      const r = await session.render(item.scenario, opts);
      const png = `${id}.png`;
      await writeFile(
        resolve(outDir, png),
        encodePng({ width: r.width, height: r.height, data: r.rgba }),
      );
      Object.assign(outcome, {
        png,
        alpha: r.alpha,
        width: r.width,
        height: r.height,
        renderer: r.renderer,
        ...(r.pixelsPerUnit !== undefined ? { pixelsPerUnit: r.pixelsPerUnit } : {}),
        ...(r.center ? { center: r.center } : {}),
        ...(r.masks ? { masks: r.masks } : {}),
        ...(r.stats ? { stats: r.stats } : {}),
        ...(r.notes.length ? { notes: r.notes } : {}),
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // Playwright wraps in-page errors; keep the useful first line.
      let message = err.message.replace(/^page\.evaluate: /, "").split("\n")[0]!;
      let kind = err.name;
      // Error kinds are error names, e.g. "MocFormatError" or "TextureTooLarge".
      const m = /^([A-Z][A-Za-z0-9]*): (.*)$/.exec(message);
      if (m) [kind, message] = [m[1]!, m[2]!];
      outcome.error = { kind: errorKind(kind), message };
      failed++;
    }
    outcome.milliseconds = Math.round(performance.now() - t0);
    await writeFile(resolve(outDir, `${id}.render.json`), JSON.stringify(outcome, null, 2) + "\n");
    log(
      `${outcome.error ? "FAIL" : "ok  "} ${id}${outcome.error ? ` — ${outcome.error.kind}: ${outcome.error.message}` : ` → ${outcome.png}`}`,
    );
  }
  await (session as RenderSession | null)?.close();
  return { total: loaded.length, failed };
}

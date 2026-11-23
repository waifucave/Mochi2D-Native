/**
 * Rendering models to PNG from Node: the reference renderer of
 * `npm run render` (the built render harness, dist/web/harness.html, in
 * headless Chromium with software WebGL), as a library call that keeps the
 * browser open between renders. Playwright is an optional peer dependency:
 * install it (`npm install playwright`, and `npx playwright install chromium`)
 * to render; everything else in "mochi2d/node" works without it.
 *
 * ```ts
 * import { NodeRenderer, loadModelFromDisk } from "mochi2d/node";
 *
 * const renderer = await NodeRenderer.open();
 * const model = await loadModelFromDisk("models/my-model/my-model.model3.json");
 * model.setParameter("ParamAngleX", 20);
 * model.update(1 / 60);
 * const { png } = await renderer.render(model, { width: 512, height: 512 });
 * await renderer.close();
 * ```
 *
 * The browser only loads the harness and the model's files from a local
 * server, offline: other requests are refused.
 */
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileSource } from "../core/io/file-source.js";
import type { FileLimits } from "../core/io/file-limits.js";
import { resolveTextureLimits, type TextureLimits } from "../core/image/texture-limits.js";
import { resolveSettingsPath } from "../runtime/bundle.js";
import { rejectUnsupportedArchive } from "../runtime/zip-source.js";
import type { ModelRuntime } from "../runtime/model-runtime.js";
import { sourceFromFolder, sourceFromZipFile } from "../platform/node-sources.js";
import {
  ERROR_HEADER,
  errorToHeader,
  statusForReadError,
  wireErrorFromMessage,
} from "../platform/wire-errors.js";
import {
  CHROMIUM_OFFLINE_ARGS,
  launchChromium,
  type LaunchOptions,
} from "../platform/node-chromium.js";
import { encodePngRgba } from "../platform/node-png.js";
import type { Browser, Page } from "../platform/playwright-types.js";

export interface NodeRendererOptions extends LaunchOptions {
  /**
   * The built web folder holding `harness.html` (`npm run build`). Default:
   * the package's `dist/web`.
   */
  webDir?: string;
}

/** What to render: a model's current pose, or a model on disk or in a source at its default pose. */
export type RenderInput = ModelRuntime | string | { source: FileSource; settings?: string };

export interface RenderImageOptions {
  /**
   * Caps on the files read for a model given as a path (default
   * `DEFAULT_FILE_LIMITS`): `{ maxFileBytes, maxTotalBytes }`.
   */
  files?: FileLimits;
  /**
   * Caps on what the model's textures may declare (default
   * `DEFAULT_TEXTURE_LIMITS`), checked from their headers before anything is
   * decoded. A texture past one rejects with `TextureLimitError`.
   */
  textures?: TextureLimits;
  /** Image size in pixels. Default 1024 × 1024. */
  width?: number;
  height?: number;
  /**
   * Parameter values by ID, over the model's current values (a runtime) or
   * its defaults (a path or source).
   */
  parameters?: Record<string, number>;
  /** Part opacities by ID, likewise. */
  partOpacities?: Record<string, number>;
  /**
   * Art-mesh tints by ID, `[r, g, b]` (0–2) or `[r, g, b, a]` (a 0–1), over a
   * runtime's own (`setTint`; not reference behavior).
   */
  tints?: Record<string, readonly number[]>;
  /** Straight-alpha RGBA background, 0–1. Default transparent. */
  background?: [number, number, number, number];
  /**
   * For a path or source: load a file whose keyform opacities are NaN or ±∞
   * ("load"), as the official runtime does. Default "reject". A runtime is
   * drawn with its own `nonFiniteOpacity` option.
   */
  nonFiniteOpacity?: "reject" | "load";
  /**
   * The model-space point at the image center and the image pixels per
   * model unit. Default: the model's canvas fitted into the image.
   */
  view?: { x: number; y: number; pixelsPerUnit: number };
  /** Alpha convention of the PNG. Default "straight". */
  alpha?: "straight" | "premultiplied";
  /**
   * A faster render that is not the reference (previews): textures
   * downscaled so no side exceeds `maxTextureSize` (default 1024), and the
   * viewer's mask atlas. `true` takes the defaults.
   */
  fast?: boolean | { maxTextureSize?: number };
}

export interface RenderedImage {
  png: Uint8Array;
  width: number;
  height: number;
  /** Image pixels per model unit, and the model-space point at the image center. */
  pixelsPerUnit: number;
  center: [number, number];
  /** A reference render (false for `fast`). */
  reference: boolean;
  /** The WebGL renderer string (SwiftShader for reference renders). */
  renderer: string;
  /** Load warnings and caveats. */
  notes: string[];
}

interface HarnessResult {
  width: number;
  height: number;
  rgbaBase64: string;
  renderer: string;
  notes?: string[];
  pixelsPerUnit?: number;
  center?: [number, number];
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
  ".wasm": "application/wasm",
};

/** The package's dist/web, from dist/lib (the bundle) or src/lib (the sources). */
function defaultWebDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "..", "web"), resolve(here, "..", "..", "dist", "web")];
  return candidates.find((d) => existsSync(join(d, "harness.html"))) ?? candidates[0]!;
}

async function sourceFor(
  input: RenderInput,
  files?: FileLimits,
): Promise<{ source: FileSource; settings: string }> {
  if (typeof input === "string") {
    rejectUnsupportedArchive(basename(input));
    if (input.toLowerCase().endsWith(".zip")) {
      const source = await sourceFromZipFile(input, undefined, files);
      return { source, settings: resolveSettingsPath(source) };
    }
    if ((await stat(input)).isDirectory()) {
      const source = await sourceFromFolder(input, files);
      return { source, settings: resolveSettingsPath(source) };
    }
    return { source: await sourceFromFolder(dirname(input), files), settings: basename(input) };
  }
  if ("animator" in input) return { source: input.source, settings: input.settingsPath };
  return { source: input.source, settings: resolveSettingsPath(input.source, input.settings) };
}

/** Renders models to PNG in headless Chromium; see the module comment. */
export class NodeRenderer {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Sources by generation, so a source's files stay cached while it is reused. */
  private readonly generations = new Map<FileSource, number>();
  private readonly sources = new Map<number, FileSource>();
  private nextGeneration = 1;

  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly server: Server,
    private readonly errors: string[],
  ) {}

  /**
   * Starts headless Chromium with the render harness. Rejects when the
   * harness is not built or Playwright or Chromium is missing, with a
   * message that says what to install.
   */
  static async open(options: NodeRendererOptions = {}): Promise<NodeRenderer> {
    const webDir = resolve(options.webDir ?? defaultWebDir());
    if (!existsSync(join(webDir, "harness.html")))
      throw new Error(
        `The render harness (${join(webDir, "harness.html")}) is missing: ` +
          'run "npm run build" in the Mochi2D folder, or pass webDir.',
      );
    let renderer: NodeRenderer | null = null;
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://x");
        let path: string;
        try {
          path = decodeURIComponent(url.pathname);
        } catch {
          path = "";
        }
        let data: Uint8Array | null = null;
        const models = /^\/models\/(\d+)\/(.+)$/.exec(path);
        if (models) {
          const source = renderer?.sources.get(Number(models[1]));
          try {
            data = source ? await source.read(models[2]!) : null;
          } catch (e) {
            // The source's own error (a file past a cap, a damaged zip entry),
            // typed, to the page, which rejects with it.
            res.statusCode = statusForReadError(e);
            res.setHeader(ERROR_HEADER, errorToHeader(e));
            res.end();
            return;
          }
        } else {
          const full = resolve(join(webDir, path));
          if (full.startsWith(webDir + sep) && (await stat(full).catch(() => null))?.isFile())
            data = await readFile(full);
        }
        if (!data) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        res.setHeader(
          "Content-Type",
          MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
        );
        res.setHeader("Cache-Control", "no-cache");
        res.end(data);
      })().catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => ok());
    });
    const addr = server.address();
    const origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    let browser: Browser;
    try {
      browser = await launchChromium(CHROMIUM_OFFLINE_ARGS, options);
    } catch (e) {
      server.close();
      const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
      throw new Error(
        `Rendering needs headless Chromium through Playwright (${detail}). Install them with ` +
          '"npm install playwright && npx playwright install chromium", or pass executablePath.',
      );
    }
    const errors: string[] = [];
    try {
      const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
      await page.route("**/*", (route) => {
        const u = new URL(route.request().url());
        const ok = u.origin === origin || u.protocol === "data:" || u.protocol === "blob:";
        return ok ? route.continue() : route.abort();
      });
      page.on("pageerror", (err) => errors.push(err.message));
      await page.goto(`${origin}/harness.html`, { waitUntil: "load" });
      await page.waitForFunction(
        "window.mochi2dHarness && window.mochi2dHarness.ready === true",
        undefined,
        {
          timeout: 30000,
        },
      );
      renderer = new NodeRenderer(browser, page, server, errors);
      return renderer;
    } catch (e) {
      await browser.close();
      server.close();
      throw new Error(
        `The render harness did not start${errors.length ? `: ${errors.join("; ")}` : ""} (${(e as Error).message})`,
      );
    }
  }

  /**
   * Renders a model to PNG: a runtime at its current pose (its parameter
   * values and part opacities), or a `*.model3.json` file, folder or `.zip`
   * on disk, or a source with its settings path, at the default pose. One
   * render runs at a time; calls wait their turn.
   */
  render(input: RenderInput, options: RenderImageOptions = {}): Promise<RenderedImage> {
    const run = this.queue.then(() => this.renderNow(input, options));
    this.queue = run.catch(() => {});
    return run;
  }

  private async renderNow(input: RenderInput, o: RenderImageOptions): Promise<RenderedImage> {
    if (this.closed) throw new Error("the renderer is closed");
    const runtime = typeof input === "object" && "animator" in input ? input : null;
    if (runtime?.modelSource === "model")
      throw new Error(
        `${runtime.settingsPath}: this runtime's model was given as a built model (withModel), ` +
          "which no file holds; make it with withData(bytes) or withData(data, version) to render it",
      );
    const { source, settings } = await sourceFor(input, o.files);
    try {
      return await this.renderSource(input, o, source, settings);
    } finally {
      // A runtime's own model data is served for this render only.
      if (runtime?.modelSource === "data") this.forget(source);
    }
  }

  private async renderSource(
    input: RenderInput,
    o: RenderImageOptions,
    source: FileSource,
    settings: string,
  ): Promise<RenderedImage> {
    let gen = this.generations.get(source);
    if (gen === undefined) {
      gen = this.nextGeneration++;
      this.generations.set(source, gen);
      this.sources.set(gen, source);
    }
    const size = (v: number | undefined, what: string) => {
      const n = v ?? 1024;
      if (!Number.isInteger(n) || n < 1 || n > 8192)
        throw new RangeError(`${what} must be a whole number of pixels from 1 to 8192`);
      return n;
    };
    const parameters: Record<string, number> = {};
    const partOpacities: Record<string, number> = {};
    const tints: Record<string, readonly number[]> = {};
    let nonFinite = o.nonFiniteOpacity ?? "reject";
    if (typeof input === "object" && "animator" in input) {
      nonFinite = input.loadOptions.nonFiniteOpacity ?? "reject";
      for (const p of input.parameters) parameters[p.id] = input.getParameter(p.id);
      for (const p of input.parts) partOpacities[p.id] = input.getPartOpacity(p.id);
      for (const [id, rgba] of input.tints) tints[id] = rgba;
    }
    Object.assign(parameters, o.parameters);
    Object.assign(partOpacities, o.partOpacities);
    for (const [id, rgba] of Object.entries(o.tints ?? {})) {
      if (
        (rgba.length !== 3 && rgba.length !== 4) ||
        !rgba.every((x) => typeof x === "number" && Number.isFinite(x))
      )
        throw new RangeError(`tint of ${id}: [r, g, b] or [r, g, b, a] of finite numbers`);
      tints[id] = rgba;
    }
    const fast = o.fast === true ? {} : o.fast || null;
    const request = {
      width: size(o.width, "width"),
      height: size(o.height, "height"),
      model: `${gen}/${settings}`,
      parameters,
      partOpacities,
      ...(Object.keys(tints).length ? { tints } : {}),
      ...(nonFinite === "load" ? { nonFiniteOpacity: "load" as const } : {}),
      alpha: o.alpha ?? "straight",
      ...(o.background ? { background: o.background } : {}),
      ...(o.view ? { view: o.view } : {}),
      ...(fast ? { fast } : {}),
      // JSON has no Infinity: null turns a cap off.
      textureLimits: Object.fromEntries(
        Object.entries(resolveTextureLimits(o.textures)).map(([k, v]) => [
          k,
          v === Infinity ? null : v,
        ]),
      ),
    };
    this.errors.length = 0;
    let r: HarnessResult;
    try {
      r = await this.page.evaluate<HarnessResult, typeof request>(
        (req) =>
          (
            window as unknown as {
              mochi2dHarness: { render(q: unknown): Promise<HarnessResult> };
            }
          ).mochi2dHarness.render(req),
        request,
      );
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).replace(/^page\.evaluate: /, "");
      // One of our errors (a texture or file past its cap, a damaged file):
      // the same typed error, with its fields, that a page gets.
      const typed = wireErrorFromMessage(msg);
      if (typed && typed.name !== "Error") throw typed;
      throw new Error(
        `${settings}: ${msg.split("\n")[0]}${this.errors.length ? ` (${this.errors.join("; ")})` : ""}`,
      );
    }
    const rgba = new Uint8Array(Buffer.from(r.rgbaBase64, "base64"));
    return {
      png: encodePngRgba(r.width, r.height, rgba),
      width: r.width,
      height: r.height,
      pixelsPerUnit: r.pixelsPerUnit ?? 0,
      center: r.center ?? [0, 0],
      reference: !fast,
      renderer: r.renderer,
      notes: r.notes ?? [],
    };
  }

  /** Forgets a source's cached files (the next render of it reads them again). */
  forget(source: FileSource): void {
    const gen = this.generations.get(source);
    if (gen === undefined) return;
    this.generations.delete(source);
    this.sources.delete(gen);
  }

  /** Closes the browser and the local server. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.browser.close().catch(() => {});
    await new Promise<void>((ok) => this.server.close(() => ok()));
  }
}

/** Renders once (opens and closes a {@link NodeRenderer}). */
export async function renderToPng(
  input: RenderInput,
  options: RenderImageOptions & NodeRendererOptions = {},
): Promise<RenderedImage> {
  const renderer = await NodeRenderer.open(options);
  try {
    return await renderer.render(input, options);
  } finally {
    await renderer.close();
  }
}

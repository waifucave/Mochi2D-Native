/**
 * Renders for the agent interface: the headless render path of
 * `npm run render` (dist/web/harness.html in Chromium through Playwright),
 * opened once and kept, offline, and serving only the loaded model's files.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileSource } from "../../../src/core/io/file-source.js";
import { openRenderSession, type RenderSession } from "../render-runner.js";
import { sendBytes, sendReadError } from "../static-server.js";
import { SCENARIO_FORMAT, type ScenarioRender } from "../scenario.js";
import { encodePng } from "../png.js";

/** Why rendering is not possible here. */
export class RenderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderUnavailable";
  }
}

/** What to render: the model's settings path in its source, and its inputs. */
export interface AgentRenderInput {
  generation: number;
  source: FileSource;
  settingsPath: string;
  parameters: Record<string, number>;
  partOpacities: Record<string, number>;
  width: number;
  height: number;
  background?: [number, number, number, number];
  view?: ScenarioRender["view"];
  alpha?: "straight" | "premultiplied";
  /** A faster render that is not the reference: textures downscaled to this size, mask atlas. */
  fast?: { maxTextureSize?: number };
}

export interface AgentRenderOutput {
  png: Uint8Array;
  width: number;
  height: number;
  /** Image pixels per model unit, and the model-space point at the image center. */
  pixelsPerUnit?: number;
  center?: [number, number];
  renderer: string;
  notes: string[];
}

export class AgentRenderer {
  private session: Promise<RenderSession> | null = null;
  private current: { prefix: string; source: FileSource } | null = null;

  /** `packageRoot` holds dist/web (built by `npm run build`). */
  constructor(private readonly packageRoot: string) {}

  /** Serves the current model's files under /models/<generation>/ and nothing else. */
  private readonly handler = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/models/")) return next();
    const cur = this.current;
    let rel = "";
    try {
      rel = decodeURIComponent(url.pathname.slice("/models/".length));
    } catch {
      rel = "";
    }
    if (!cur || !rel.startsWith(cur.prefix)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    try {
      const path = rel.slice(cur.prefix.length);
      sendBytes(res, path, await cur.source.read(path));
    } catch (e) {
      // The source's own error (a file past a cap, a path not allowed), typed, to the page.
      sendReadError(res, e);
    }
  };

  private open(): Promise<RenderSession> {
    if (!this.session) {
      const webDir = join(this.packageRoot, "dist", "web");
      this.session = (async () => {
        if (!existsSync(join(webDir, "harness.html")))
          throw new RenderUnavailableError(
            `Rendering needs the render harness (${join(webDir, "harness.html")}), which is ` +
              `not built: run "npm run build" in ${this.packageRoot}.`,
          );
        try {
          return await openRenderSession(this.packageRoot, webDir, {
            modelsHandler: this.handler,
            offline: true,
          });
        } catch (e) {
          const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
          throw new RenderUnavailableError(
            "Rendering needs headless Chromium through Playwright, which is not available " +
              `here (${detail}). Install both in the Mochi2D folder (${this.packageRoot}) with ` +
              '"npm install --no-save playwright && npx playwright install chromium", or ' +
              'install Playwright globally ("npm install -g playwright"), or set ' +
              "MOCHI2D_PLAYWRIGHT to the playwright package's folder and, if needed, " +
              "MOCHI2D_CHROMIUM to a Chromium executable (for an MCP server, in the " +
              'client\'s "env" settings). Everything else works without it.',
          );
        }
      })();
      // A failed start is retried on the next render.
      this.session.catch(() => (this.session = null));
    }
    return this.session;
  }

  async render(input: AgentRenderInput): Promise<AgentRenderOutput> {
    const session = await this.open();
    this.current = { prefix: `${input.generation}/`, source: input.source };
    const r = await session.render(
      {
        format: SCENARIO_FORMAT,
        id: "agent",
        model: `${input.generation}/${input.settingsPath}`,
        parameters: input.parameters,
        partOpacities: input.partOpacities,
        render: {
          width: input.width,
          height: input.height,
          ...(input.background ? { background: input.background } : {}),
          ...(input.view ? { view: input.view } : {}),
        },
      },
      { alpha: input.alpha ?? "straight", ...(input.fast ? { fast: input.fast } : {}) },
    );
    return {
      png: encodePng({ width: r.width, height: r.height, data: r.rgba }),
      width: r.width,
      height: r.height,
      ...(r.pixelsPerUnit !== undefined ? { pixelsPerUnit: r.pixelsPerUnit } : {}),
      ...(r.center ? { center: r.center } : {}),
      renderer: r.renderer,
      notes: r.notes,
    };
  }

  async close(): Promise<void> {
    const s = this.session;
    this.session = null;
    if (s) await (await s.catch(() => null))?.close();
  }
}

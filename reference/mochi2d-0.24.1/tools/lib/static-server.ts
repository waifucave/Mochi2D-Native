/**
 * Minimal static HTTP server: serves a built web directory and model files
 * under /models/ (with /models/index.json listing them). Used by the render
 * harness and `npm run viewer`.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { ERROR_HEADER, errorToHeader, statusForReadError } from "../../src/platform/wire-errors.js";
import { extname, join, resolve, sep } from "node:path";
import { listModelFiles, modelSearchDirs, resolveModelFile } from "./model-roots.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".zip": "application/zip",
};

export function contentType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** A Connect-style request handler: answers, or calls `next`. */
export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => Promise<void>;

/** Connect-style handler for /models/*; calls `next` for other URLs. */
export function createModelsHandler(repoRoot: string): RequestHandler {
  const dirs = modelSearchDirs(repoRoot);
  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/models/")) return next();
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname.slice("/models/".length));
    } catch {
      res.statusCode = 400;
      res.end("bad path");
      return;
    }
    if (rel === "index.json") {
      res.setHeader("Content-Type", MIME[".json"]!);
      res.end(JSON.stringify({ files: listModelFiles(repoRoot) }));
      return;
    }
    const file = resolveModelFile(dirs, rel);
    await sendFile(res, file);
  };
}

/** Sends bytes with the content type of `path`'s extension (no caching). */
export function sendBytes(res: ServerResponse, path: string, data: Uint8Array): void {
  res.setHeader("Content-Type", contentType(path));
  res.setHeader("Cache-Control", "no-cache");
  res.end(data);
}

/**
 * Answers a read the source refused with its error, typed, in a header the
 * render harness reads (`ServedFileSource`): "not found" stays a 404.
 */
export function sendReadError(res: ServerResponse, e: unknown): void {
  res.statusCode = statusForReadError(e);
  res.setHeader(ERROR_HEADER, errorToHeader(e));
  res.setHeader("Cache-Control", "no-cache");
  res.end();
}

/**
 * Sends a file streamed, with its length: a page refuses one past its cap
 * on the length alone (`FileLimits`), and nothing here reads it whole.
 */
async function sendFile(res: ServerResponse, file: string | undefined): Promise<void> {
  let size: number;
  try {
    const st = await stat(file ?? "");
    if (!file || !st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  res.setHeader("Content-Type", contentType(file));
  res.setHeader("Content-Length", String(size));
  res.setHeader("Cache-Control", "no-cache");
  const stream = createReadStream(file);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

export interface RunningServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startStaticServer(
  webDir: string,
  repoRoot: string,
  port = 0,
  host = "127.0.0.1",
  options: {
    /** Serve /models/ from the repository (default true); false acts like a plain static host. */ models?: boolean;
    /** Answers /models/ (and any other URL it takes) instead of the repository's models. */
    modelsHandler?: RequestHandler;
  } = {},
): Promise<RunningServer> {
  const models: RequestHandler =
    options.modelsHandler ??
    (options.models === false
      ? async (_req: IncomingMessage, _res: ServerResponse, next: () => void) => next()
      : createModelsHandler(repoRoot));
  const base = resolve(webDir);
  const server = createServer((req, res) => {
    void models(req, res, () => {
      const url = new URL(req.url ?? "/", "http://x");
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith("/")) p += "index.html";
      const full = resolve(join(base, p));
      void sendFile(res, full === base || full.startsWith(base + sep) ? full : undefined);
    }).catch((e: unknown) => {
      res.statusCode = 500;
      res.end(String(e));
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => ok());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    server,
    url: `http://${host}:${actualPort}/`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

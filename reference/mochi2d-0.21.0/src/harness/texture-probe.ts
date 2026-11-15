/**
 * Texture pipeline measurements in the browser: fetch → plan → decode (worker
 * or main thread) → upload, then a draw check that samples every texture.
 */
import { TextureLoader, type LoadedTexture } from "../render/texture/loader.js";
import { GpuMemoryTracker } from "../render/gl/gpu-memory.js";
import { RenderTarget } from "../render/gl/render-target.js";
import { ShaderProgram } from "../render/gl/shader.js";
import { readbackRgba } from "../render/gl/readback.js";
import type { AlphaMode } from "../core/image/alpha.js";

export interface TextureProbeRequest {
  /** URLs of the image files (same origin). */
  urls: string[];
  budgetBytes?: number;
  maxSize?: number;
  mipmaps?: boolean;
  alpha?: AlphaMode;
  workers?: number;
  useWorkers?: boolean;
  /** Upload in strips of this many rows (see TextureLoaderOptions.uploadStripRows). */
  uploadStripRows?: number;
  /** Keep the textures alive afterwards (released by the next probe). Default false. */
  keep?: boolean;
}

export interface TextureProbeResult {
  maxTextureSize: number;
  decoder: { usesWorkers: boolean; fallbackReason: string | null };
  textures: {
    url: string;
    fileBytes: number;
    original: [number, number];
    uploaded: [number, number];
    scale: number;
    fetchMs: number;
    decodeMs: number;
    uploadMs: number;
    decodedOn: string;
    gpuBytes: number;
    /** Fraction of sampled texels (64×64 grid) with alpha > 0. */
    coverage: number;
  }[];
  totalMs: number;
  /** Longest gap between 4 ms timer ticks on the main thread while loading. */
  maxMainThreadStallMs: number;
  gpuBytes: number;
  gpuBytesPeak: number;
  jsHeapUsedBytes: number | null;
  glError: string | null;
  contextLost: boolean;
  error: string | null;
}

const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }`;

let kept: { loader: TextureLoader; textures: LoadedTexture[] } | null = null;

function release(): void {
  if (!kept) return;
  kept.loader.release(kept.textures);
  kept.loader.dispose();
  kept = null;
}

export async function probeTextures(
  gl: WebGL2RenderingContext,
  req: TextureProbeRequest,
): Promise<TextureProbeResult> {
  release();
  const memory = new GpuMemoryTracker();
  const loader = new TextureLoader(gl, {
    memory,
    ...(req.budgetBytes !== undefined ? { budgetBytes: req.budgetBytes } : {}),
    ...(req.maxSize !== undefined ? { maxSize: req.maxSize } : {}),
    ...(req.mipmaps !== undefined ? { mipmaps: req.mipmaps } : {}),
    ...(req.alpha !== undefined ? { alpha: req.alpha } : {}),
    ...(req.workers !== undefined ? { workers: req.workers } : {}),
    ...(req.useWorkers !== undefined ? { useWorkers: req.useWorkers } : {}),
    ...(req.uploadStripRows !== undefined ? { uploadStripRows: req.uploadStripRows } : {}),
  });
  const result: TextureProbeResult = {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    decoder: {
      usesWorkers: loader.decoder.usesWorkers,
      fallbackReason: loader.decoder.fallbackReason ?? null,
    },
    textures: [],
    totalMs: 0,
    maxMainThreadStallMs: 0,
    gpuBytes: 0,
    gpuBytesPeak: 0,
    jsHeapUsedBytes: null,
    glError: null,
    contextLost: false,
    error: null,
  };
  const t0 = performance.now();
  let textures: LoadedTexture[] = [];
  // Main-thread responsiveness: a 4 ms heartbeat; long gaps mean the thread was blocked.
  let last = performance.now();
  let maxGap = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    if (now - last > maxGap) maxGap = now - last;
    last = now;
  }, 4);
  try {
    const fetched = await Promise.all(
      req.urls.map(async (url) => {
        const f0 = performance.now();
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { url, bytes, fetchMs: performance.now() - f0 };
      }),
    );
    textures = await loader.loadSet(fetched.map((f) => ({ label: f.url, bytes: f.bytes })));
    result.totalMs = performance.now() - t0;
    clearInterval(heartbeat);
    result.maxMainThreadStallMs = Math.round(Math.max(maxGap, performance.now() - last));

    // Draw check: sample each texture into a 64×64 target.
    const program = new ShaderProgram(gl, VS, FS, "texture probe");
    const target = new RenderTarget(gl, 64, 64);
    target.bind();
    program.use();
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(program.uniform("uTex"), 0);
    textures.forEach((t, i) => {
      gl.bindTexture(gl.TEXTURE_2D, t.texture.texture);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = readbackRgba(gl, target, { source: "straight", output: "straight" }).data;
      let covered = 0;
      for (let k = 3; k < px.length; k += 4) if (px[k]! > 0) covered++;
      const f = fetched[i]!;
      result.textures.push({
        url: f.url,
        fileBytes: f.bytes.length,
        original: [t.originalWidth, t.originalHeight],
        uploaded: [t.texture.width, t.texture.height],
        scale: t.scale,
        fetchMs: Math.round(f.fetchMs),
        decodeMs: Math.round(t.decodeMs),
        uploadMs: Math.round(t.uploadMs),
        decodedOn: t.decodedOn,
        gpuBytes: t.texture.bytes,
        coverage: covered / (64 * 64),
      });
    });
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    target.dispose();
    program.dispose();
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    clearInterval(heartbeat);
  }
  const err = gl.getError();
  result.glError = err === gl.NO_ERROR ? null : `0x${err.toString(16)}`;
  result.contextLost = gl.isContextLost();
  result.gpuBytes = memory.total;
  result.gpuBytesPeak = memory.peak;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  result.jsHeapUsedBytes = mem ? mem.usedJSHeapSize : null;
  if (req.keep) {
    kept = { loader, textures };
  } else {
    loader.release(textures);
    loader.dispose();
  }
  return result;
}

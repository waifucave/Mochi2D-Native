/**
 * Page loaded by the headless tools (tools/render.ts, tools/texture-probe.ts)
 * and the browser tests. It exposes `window.mochi2dHarness`:
 *
 * - `render(request)`: renders a scenario offscreen and returns RGBA8 pixels
 *   (top row first, base64) in the requested alpha convention. The Node side
 *   writes the PNG, so no browser color management is involved.
 * - `info()`: WebGL limits and renderer strings.
 * - `selfTest(name, options)`: infrastructure checks (see self-tests.ts).
 * - `probeTextures(request)`: texture pipeline measurements (see texture-probe.ts).
 */
import { createGl2Context } from "../render/gl/context.js";
import { MAX_TINT } from "../core/tint.js";
import { RenderTarget } from "../render/gl/render-target.js";
import { readbackRgba } from "../render/gl/readback.js";
import { createTexturedTrianglesScene } from "../render/demo/textured-triangles.js";
import { loadModelFromSource } from "../core/model/evaluate.js";
import { loadMoc, type MocModel } from "../core/moc/model.js";
import { TextureLoader } from "../render/texture/loader.js";
import { benchmarkEvaluation, type BenchMode, type BenchResult } from "../core/testing/bench.js";
import type { KernelChoice } from "../core/eval/kernels.js";
import { applyRequest } from "../core/model/snapshot.js";
import { ModelInstance } from "../core/eval/instance.js";
import {
  ModelRenderer,
  OFFSCREEN_MASK_SIZE,
  REFERENCE_MASK_SIZE,
} from "../render/model/model-renderer.js";
import { loadModelTextures } from "../render/model/load-textures.js";
import { frameImage, type RenderView } from "../core/render/framing.js";
import type { AlphaMode } from "../core/image/alpha.js";
import {
  blendTest,
  geometryStreamTest,
  readbackTest,
  renderTargetPoolTest,
  textureExactTest,
  textureUploadTest,
} from "./self-tests.js";
import { probeTextures, type TextureProbeRequest } from "./texture-probe.js";
import {
  runRenderBenchmark,
  type RenderBenchRequest,
  type RenderBenchResult,
} from "./render-bench.js";
import type { Texture2D } from "../render/gl/texture.js";
import type { TextureLimits } from "../core/image/texture-limits.js";
import { errorForWire } from "../platform/wire-errors.js";
import { ServedFileSource } from "./served-source.js";

export interface HarnessRequest {
  width: number;
  height: number;
  /** Built-in test scene name (non-standard scenario extension). */
  builtinScene?: string;
  /** Model settings path relative to the server's /models/ root. */
  model?: string;
  /**
   * Test models: a `.moc3` file (base64) instead of `model`, with its textures
   * as PNG files (base64) in texture-index order. With `model` as well, the
   * crafted file is drawn with that model's (cached) textures: crafts built
   * from a served model at test time.
   */
  mocBase64?: string;
  texturesBase64?: string[];
  parameters?: Record<string, number>;
  partOpacities?: Record<string, number>;
  /**
   * Art-mesh tints by ID (not reference behavior): `[r, g, b, a]`, r, g, b
   * in [0, 2] and a in [0, 1] (see `ModelRuntime.setTint`). Unknown IDs are ignored, with a note.
   */
  tints?: Record<string, readonly number[]>;
  /**
   * Load files whose keyform opacities are NaN or ±∞ ("load"), as a runtime
   * with that option does. Default "reject".
   */
  nonFiniteOpacity?: "reject" | "load";
  /** Straight-alpha RGBA background (§2i). Default transparent. */
  background?: [number, number, number, number];
  /** Image center and scale; default: fit the canvas (§2i). */
  view?: RenderView;
  /** Mask buffer size. Default 4096 (the reference configuration, §2g.3). */
  maskSize?: number;
  /** Tests only: the offscreen mask buffer size (default 256, C8) and the mask-mesh rule (default "all", C13). */
  offscreenMaskSize?: number;
  maskMeshes?: "all" | "active";
  /** Alpha convention of the returned pixels. Default "straight". */
  alpha?: AlphaMode;
  /**
   * A faster render that is not the reference (previews): textures
   * downscaled so that no side exceeds `maxTextureSize` (default 1024), and
   * the viewer's mask atlas instead of per-drawable masks.
   */
  fast?: { maxTextureSize?: number };
  /**
   * Caps on what the model's textures may declare (default
   * `DEFAULT_TEXTURE_LIMITS`); null turns a cap off (JSON has no Infinity).
   */
  textureLimits?: WireTextureLimits;
}

/** {@link TextureLimits} as JSON: null for a cap turned off. */
export type WireTextureLimits = { [K in keyof TextureLimits]?: number | null };

const fromWire = (w: WireTextureLimits | undefined): TextureLimits => {
  const out: TextureLimits = {};
  for (const k of ["maxSide", "maxPixels", "maxTotalPixels"] as const) {
    const v = w?.[k];
    if (v !== undefined) out[k] = v === null ? Infinity : v;
  }
  return out;
};

export interface HarnessResult {
  width: number;
  height: number;
  rgbaBase64: string;
  alpha: AlphaMode;
  renderer: string;
  notes: string[];
  /** Model renders: image pixels per output unit and the output-space image center (§2i). */
  pixelsPerUnit?: number;
  center?: [number, number];
  /** Model renders: mask configuration. */
  masks?: {
    mode: "per-drawable" | "atlas";
    size: number;
    offscreenSize: number;
    meshes: "all" | "active";
  };
  /** Fast renders: the largest texture side used. */
  maxTextureSize?: number;
  /** Model renders: what the renderer did. */
  stats?: ModelRenderer["stats"];
}

export interface HarnessInfo {
  renderer: string;
  vendor: string;
  version: string;
  shadingLanguage: string;
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxViewportDims: number[];
  maxSamples: number;
  extensions: string[];
}

const canvas = document.getElementById("c") as HTMLCanvasElement;
const gl = createGl2Context(canvas, { premultipliedAlpha: true, antialias: false });

/** A request's tints as the renderer takes them (RGBA per drawable), or null for none. */
function tintArray(
  model: MocModel,
  tints: Record<string, readonly number[]> | undefined,
  notes: string[],
): Float32Array | null {
  const entries = Object.entries(tints ?? {});
  if (entries.length === 0) return null;
  const ids = model.meshes.ids;
  const out = new Float32Array(4 * ids.length).fill(1);
  for (const [id, rgba] of entries) {
    const d = ids.indexOf(id);
    if (d < 0) {
      notes.push(`tint of ${id} ignored: no art mesh has that ID`);
      continue;
    }
    for (let k = 0; k < 4; k++)
      out[4 * d + k] = Math.min(k < 3 ? MAX_TINT : 1, Math.max(0, rgba[k] ?? 1));
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** The `loadMoc` options of a request. */
function loadOptions(req: HarnessRequest): { nonFiniteOpacity?: "load" } {
  return req.nonFiniteOpacity === "load" ? { nonFiniteOpacity: "load" } : {};
}

function rendererString(): string {
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}

function info(): HarnessInfo {
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    renderer: rendererString(),
    vendor: String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
    version: String(gl.getParameter(gl.VERSION)),
    shadingLanguage: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES) as number,
    extensions: gl.getSupportedExtensions() ?? [],
  };
}

interface LoadedForRender {
  path: string;
  model: MocModel;
  textures: Texture2D[];
  release: () => void;
}
let loadedCache:
  (LoadedForRender & { maxTextureSize: number; nonFinite: boolean; limitsKey: string }) | null =
  null;
/** The texture caps of the request being served. */
let requestLimits: TextureLimits = {};
let rendererCache: {
  path: string;
  maskSize: number;
  maxTextureSize: number;
  renderer: ModelRenderer;
} | null = null;

/**
 * Loads (or reuses) a model served under /models/, with reference texture
 * preparation: full resolution, exact premultiplication and mip chain, and a
 * TextureTooLarge failure instead of downscaling (§2b and B4).
 * A fast render (`maxTextureSize` > 0) downscales instead, to that size.
 */
async function loadedFor(
  path: string,
  maxTextureSize = 0,
  nonFinite = false,
): Promise<LoadedForRender> {
  const limitsKey = JSON.stringify(requestLimits, (_k, v) => (v === Infinity ? "inf" : v));
  if (
    loadedCache?.path === path &&
    loadedCache.maxTextureSize === maxTextureSize &&
    loadedCache.nonFinite === nonFinite &&
    loadedCache.limitsKey === limitsKey
  )
    return loadedCache;
  rendererCache?.renderer.dispose();
  rendererCache = null;
  loadedCache?.release();
  loadedCache = null;
  const source = new ServedFileSource(new URL("/models/", location.href).href, "models");
  const loaded = await loadModelFromSource(
    source,
    path,
    nonFinite ? { nonFiniteOpacity: "load" } : {},
  );
  const { loader, textures } = await loadModelTextures(
    gl,
    source,
    path,
    loaded.settings,
    maxTextureSize > 0
      ? {
          exact: true,
          mipmaps: true,
          oversize: "downscale",
          maxSize: maxTextureSize,
          limits: requestLimits,
        }
      : { exact: true, mipmaps: true, oversize: "fail", limits: requestLimits },
  );
  loadedCache = {
    path,
    maxTextureSize,
    nonFinite,
    limitsKey,
    model: loaded.model,
    textures: textures.map((t) => t.texture),
    release: () => {
      loader.release(textures);
      loader.dispose();
    },
  };
  return loadedCache;
}

/**
 * The reference renderer for a model and mask size (reused across requests),
 * or with `maxTextureSize` > 0, a fast one: downscaled textures and the mask
 * atlas.
 */
async function rendererFor(
  path: string,
  maskSize: number,
  maxTextureSize = 0,
  nonFinite = false,
): Promise<{ model: MocModel; renderer: ModelRenderer }> {
  const loaded = await loadedFor(path, maxTextureSize, nonFinite);
  if (
    rendererCache?.path !== path ||
    rendererCache.maskSize !== maskSize ||
    rendererCache.maxTextureSize !== maxTextureSize
  ) {
    rendererCache?.renderer.dispose();
    rendererCache = {
      path,
      maskSize,
      maxTextureSize,
      renderer: new ModelRenderer(
        gl,
        loaded.model,
        loaded.textures,
        maxTextureSize > 0 ? { masks: "atlas", maskOversample: 2, maskSize } : { maskSize },
      ),
    };
  }
  return { model: loaded.model, renderer: rendererCache.renderer };
}

/**
 * {@link renderImage} with the request's texture caps. No caller can take a
 * refusal for an image: it rejects (and every method of the harness rejects
 * with its error's name and fields on a marked line, `errorForWire`, so a
 * caller in Node can rethrow the same typed error).
 */
async function render(req: HarnessRequest): Promise<HarnessResult> {
  requestLimits = fromWire(req.textureLimits);
  try {
    return await renderImage(req);
  } finally {
    requestLimits = {};
  }
}

/** A harness method as the page exposes it: asynchronous, its errors marked. */
type Wired<F extends (...args: never[]) => unknown> = (
  ...args: Parameters<F>
) => Promise<Awaited<ReturnType<F>>>;

/** `fn`, rejecting with its error's name and fields on a marked line. */
function wired<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => Promise<Awaited<R>> {
  return async (...args: A): Promise<Awaited<R>> => {
    try {
      return (await fn(...args)) as Awaited<R>;
    } catch (e) {
      throw errorForWire(e);
    }
  };
}

async function renderImage(req: HarnessRequest): Promise<HarnessResult> {
  const alpha = req.alpha ?? "straight";
  const notes: string[] = [];
  const extra: Partial<HarnessResult> = {};
  const target = new RenderTarget(gl, req.width, req.height, { stencil: true });
  try {
    target.bind();
    if (req.builtinScene) {
      if (req.builtinScene !== "textured-triangles") {
        throw new Error(`Unknown builtin scene "${req.builtinScene}"`);
      }
      const scene = createTexturedTrianglesScene(gl);
      scene.draw(0);
      scene.dispose();
    } else if (req.mocBase64 && !req.model) {
      // A test model given as bytes: loaded, drawn and released within this call.
      const maskSize = req.maskSize ?? REFERENCE_MASK_SIZE;
      const model = loadMoc(fromBase64(req.mocBase64), loadOptions(req));
      const loader = new TextureLoader(gl, {
        exact: true,
        mipmaps: true,
        oversize: "fail",
        limits: requestLimits,
      });
      try {
        const textures = await loader.loadSet(
          (req.texturesBase64 ?? []).map((b, i) => ({
            label: `texture ${i}`,
            bytes: fromBase64(b),
          })),
        );
        const instance = new ModelInstance(model);
        applyRequest(instance, {
          parameters: req.parameters ?? {},
          partOpacities: req.partOpacities ?? {},
        });
        instance.evaluate();
        const renderer = new ModelRenderer(
          gl,
          model,
          textures.map((t) => t.texture),
          { maskSize },
        );
        renderer.update(instance);
        const framing = frameImage(model.canvas, req.width, req.height, req.view);
        renderer.draw({
          framing,
          ...(req.background ? { background: req.background } : {}),
          target: target.framebuffer,
          tints: tintArray(model, req.tints, notes),
        });
        extra.pixelsPerUnit = framing.k;
        extra.center = [framing.centerX, framing.centerY];
        extra.masks = {
          mode: "per-drawable",
          size: maskSize,
          offscreenSize: OFFSCREEN_MASK_SIZE,
          meshes: "all",
        };
        extra.stats = renderer.stats;
        renderer.dispose();
        loader.release(textures);
      } finally {
        loader.dispose();
      }
    } else if (req.model) {
      const fastSize = req.fast
        ? Math.max(16, Math.min(8192, Math.floor(req.fast.maxTextureSize ?? 1024)))
        : 0;
      const maskSize = req.maskSize ?? (fastSize ? 2048 : REFERENCE_MASK_SIZE);
      // A crafted file drawn with the served model's textures gets its own renderer.
      const nonFinite = req.nonFiniteOpacity === "load";
      const crafted = req.mocBase64 ? loadMoc(fromBase64(req.mocBase64), loadOptions(req)) : null;
      const model = crafted
        ? {
            model: crafted,
            renderer: new ModelRenderer(gl, crafted, (await loadedFor(req.model)).textures, {
              maskSize,
              ...(req.offscreenMaskSize ? { offscreenMaskSize: req.offscreenMaskSize } : {}),
              ...(req.maskMeshes ? { maskMeshes: req.maskMeshes } : {}),
            }),
          }
        : await rendererFor(req.model, maskSize, fastSize, nonFinite);
      // A fresh instance per scenario: its history (creation-time evaluation,
      // then one evaluation with the scenario's inputs) must not depend on
      // earlier requests, since inactive meshes keep stale vertices (C4).
      // Load warnings (draw orders outside their group's range, C12) go into the status notes.
      notes.push(...model.model.loadWarnings);
      const instance = new ModelInstance(model.model);
      applyRequest(instance, {
        parameters: req.parameters ?? {},
        partOpacities: req.partOpacities ?? {},
      });
      instance.evaluate();
      model.renderer.update(instance);
      const framing = frameImage(model.model.canvas, req.width, req.height, req.view);
      model.renderer.draw({
        framing,
        ...(req.background ? { background: req.background } : {}),
        target: target.framebuffer,
        tints: tintArray(model.model, req.tints, notes),
      });
      extra.pixelsPerUnit = framing.k;
      extra.center = [framing.centerX, framing.centerY];
      extra.masks = {
        mode: fastSize && !crafted ? "atlas" : "per-drawable",
        size: maskSize,
        offscreenSize: model.renderer.offscreenMaskSize,
        meshes: model.renderer.maskMeshes,
      };
      extra.stats = model.renderer.stats;
      if (fastSize && !crafted) {
        extra.maxTextureSize = fastSize;
        notes.push(
          `fast render, not the reference: textures at most ${fastSize} pixels, mask atlas`,
        );
      }
      if (crafted) model.renderer.dispose();
    } else {
      throw new Error("Request has neither a model nor a builtin scene");
    }
    // Everything we draw is premultiplied.
    const px = readbackRgba(gl, target, { source: "premultiplied", output: alpha });
    return {
      width: px.width,
      height: px.height,
      rgbaBase64: toBase64(px.data),
      alpha,
      renderer: rendererString(),
      notes,
      ...extra,
    };
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    target.dispose();
  }
}

/** Full-image differences between two premultiplied RGBA8 images. */
export interface ImageDifference {
  /** RMS over all channels of all pixels. */
  rms: number;
  /** Fractions of pixels whose largest channel difference d exceeds 4, 8 and 16. */
  over4: number;
  over8: number;
  over16: number;
  maxD: number;
}

/**
 * Renders a model scenario with the reference masks and with the viewer's
 * mask atlas (a viewer-only approximation) and measures how far
 * apart the two images are.
 */
async function compareMaskModes(
  req: HarnessRequest & { oversamples?: number[] },
): Promise<(ImageDifference & { oversample: number; atlasStats: ModelRenderer["stats"] })[]> {
  if (!req.model) throw new Error("compareMaskModes needs a model");
  const loaded = await loadedFor(req.model);
  const framing = frameImage(loaded.model.canvas, req.width, req.height, req.view);
  const renderWith = (opts: ConstructorParameters<typeof ModelRenderer>[3]) => {
    const instance = new ModelInstance(loaded.model);
    applyRequest(instance, {
      parameters: req.parameters ?? {},
      partOpacities: req.partOpacities ?? {},
    });
    instance.evaluate();
    const renderer = new ModelRenderer(gl, loaded.model, loaded.textures, opts);
    const target = new RenderTarget(gl, req.width, req.height);
    try {
      renderer.update(instance);
      renderer.draw({
        framing,
        ...(req.background ? { background: req.background } : {}),
        target: target.framebuffer,
      });
      return { pixels: target.readPixels(), stats: renderer.stats };
    } finally {
      target.dispose();
      renderer.dispose();
    }
  };
  const a = renderWith({ maskSize: REFERENCE_MASK_SIZE });
  return (req.oversamples ?? [2]).map((oversample) => {
    const b = renderWith({ masks: "atlas", maskOversample: oversample });
    return { oversample, ...imageDifference(a.pixels, b.pixels), atlasStats: b.stats };
  });
}

function imageDifference(p: Uint8Array, q: Uint8Array): ImageDifference {
  let sq = 0;
  let over4 = 0;
  let over8 = 0;
  let over16 = 0;
  let maxD = 0;
  for (let i = 0; i < p.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) {
      const e = Math.abs(p[i + c]! - q[i + c]!);
      sq += e * e;
      if (e > d) d = e;
    }
    if (d > 4) over4++;
    if (d > 8) over8++;
    if (d > 16) over16++;
    if (d > maxD) maxD = d;
  }
  const n = p.length / 4;
  return {
    rms: Math.sqrt(sq / p.length),
    over4: over4 / n,
    over8: over8 / n,
    over16: over16 / n,
    maxD,
  };
}

/** Times the interactive render path (evaluate, update, draw, GPU sync) of a model. */
async function renderBenchmark(req: RenderBenchRequest): Promise<RenderBenchResult> {
  const loaded = await loadedFor(req.model);
  return runRenderBenchmark(gl, loaded.model, loaded.textures, req);
}

/** Times model evaluation in this page (no textures, no drawing). */
async function benchmark(req: {
  model: string;
  mode: BenchMode;
  poses?: number;
  warmup?: number;
  stages?: boolean;
  kernels?: KernelChoice;
}): Promise<BenchResult> {
  const source = new ServedFileSource(new URL("/models/", location.href).href, "models");
  const { model } = await loadModelFromSource(source, req.model);
  return benchmarkEvaluation(model, req.mode, () => performance.now(), {
    ...(req.poses !== undefined ? { poses: req.poses } : {}),
    ...(req.warmup !== undefined ? { warmup: req.warmup } : {}),
    ...(req.stages !== undefined ? { stages: req.stages } : {}),
    ...(req.kernels !== undefined ? { kernels: req.kernels } : {}),
  });
}

const SELF_TESTS = {
  blend: () => blendTest(gl),
  "geometry-stream": (opts?: {
    meshes?: number;
    side?: number;
    frames?: number;
    batched?: boolean;
  }) => geometryStreamTest(gl, opts),
  "render-target-pool": () => renderTargetPoolTest(gl),
  readback: () => readbackTest(gl),
  "texture-upload": () => textureUploadTest(gl),
  "texture-exact": () => textureExactTest(gl),
} as const;

function selfTest(name: string, options?: unknown): unknown {
  const fn = (SELF_TESTS as Record<string, (o?: unknown) => unknown>)[name];
  if (!fn)
    throw new Error(`Unknown self test "${name}". Known: ${Object.keys(SELF_TESTS).join(", ")}`);
  return fn(options);
}

declare global {
  interface Window {
    mochi2dHarness: {
      ready: true;
      render: Wired<typeof render>;
      info: typeof info;
      selfTest: Wired<typeof selfTest>;
      probeTextures: (req: TextureProbeRequest) => Promise<unknown>;
      benchmark: Wired<typeof benchmark>;
      renderBenchmark: Wired<typeof renderBenchmark>;
      compareMaskModes: Wired<typeof compareMaskModes>;
    };
  }
}
window.mochi2dHarness = {
  ready: true,
  render: wired(render),
  info,
  selfTest: wired(selfTest),
  probeTextures: wired((req: TextureProbeRequest) => probeTextures(gl, req)),
  benchmark: wired(benchmark),
  renderBenchmark: wired(renderBenchmark),
  compareMaskModes: wired(compareMaskModes),
};

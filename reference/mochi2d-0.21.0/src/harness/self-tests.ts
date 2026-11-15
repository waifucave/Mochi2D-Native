/**
 * In-browser checks of the WebGL2 infrastructure, run by the headless test
 * suite through the render harness. Each test returns plain JSON.
 */
import { ShaderProgram } from "../render/gl/shader.js";
import { RenderTarget } from "../render/gl/render-target.js";
import { RenderTargetPool } from "../render/gl/render-target-pool.js";
import { GeometryStream, type MeshSlot } from "../render/gl/geometry-stream.js";
import {
  BLEND_FACTORS,
  BLEND_OPS,
  BlendStateCache,
  blendReference,
  validateBlendState,
  type BlendState,
  type Rgba,
} from "../render/gl/blend-state.js";
import { readbackRgba } from "../render/gl/readback.js";
import { assertNoGlError } from "../render/gl/context.js";
import { GpuMemoryTracker } from "../render/gl/gpu-memory.js";
import {
  createTexture2D,
  createTexture2DIncremental,
  premultiplyRgba8,
  type Texture2D,
} from "../render/gl/texture.js";
import { decodeImageHere, ImageDecoder } from "../render/texture/decoder.js";
import { encodePngRgba8 } from "../platform/png-encode.js";

const SOLID_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
out vec4 vColor;
void main() { vColor = aColor; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const SOLID_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const UNIFORM_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

function fullscreenProgram(gl: WebGL2RenderingContext): ShaderProgram {
  return new ShaderProgram(gl, FULLSCREEN_VS, UNIFORM_FS, "self-test fullscreen");
}

// ---------------------------------------------------------------------------

export interface BlendTestResult {
  states: number;
  /** Largest channel difference between GPU and CPU reference, in 8-bit steps. */
  maxErrorLsb: number;
  worst?: { key: string; gpu: number[]; expected: number[] };
  /** GL state calls issued by the blend cache (redundant ones are skipped). */
  glCalls: number;
}

/** Draws src over dst for many blend states and compares with {@link blendReference}. */
export function blendTest(gl: WebGL2RenderingContext): BlendTestResult {
  const q = (v: number[]) => v.map((x) => x / 255) as Rgba;
  // Inputs are exact 8-bit values so quantization does not blur the comparison.
  const src = q([204, 102, 51, 153]);
  const dst = q([77, 128, 230, 179]);
  const constant = q([64, 128, 191, 102]);
  const states: BlendState[] = [];
  for (const s of BLEND_FACTORS) {
    for (const d of BLEND_FACTORS) {
      states.push({
        enabled: true,
        color: { src: s, dst: d, op: "add" },
        alpha: { src: d, dst: s, op: "add" },
        constant,
      });
    }
  }
  for (const op of BLEND_OPS) {
    for (const [s, d] of [
      ["one", "one"],
      ["src-alpha", "one-minus-src-alpha"],
      ["dst-color", "zero"],
    ] as const) {
      states.push({
        enabled: true,
        color: { src: s, dst: d, op },
        alpha: { src: "one", dst: "one", op },
        constant,
      });
    }
  }
  states.push({
    enabled: false,
    color: { src: "one", dst: "zero", op: "add" },
    alpha: { src: "one", dst: "zero", op: "add" },
  });
  states.push({
    enabled: true,
    color: { src: "one", dst: "one", op: "add" },
    alpha: { src: "one", dst: "zero", op: "add" },
    writeMask: [true, false, true, false],
  });
  const valid = states.filter((s) => {
    try {
      validateBlendState(s);
      return true;
    } catch {
      return false;
    }
  });

  const target = new RenderTarget(gl, 1, 1);
  const program = fullscreenProgram(gl);
  const cache = new BlendStateCache(gl);
  let maxErr = 0;
  let worst: BlendTestResult["worst"];
  target.bind();
  program.use();
  for (const s of valid) {
    cache.apply({ ...s, enabled: false, writeMask: [true, true, true, true] });
    gl.clearColor(dst[0], dst[1], dst[2], dst[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    cache.apply(s);
    gl.uniform4fv(program.uniform("uColor"), src);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = readbackRgba(gl, target, { source: "straight", output: "straight" }).data;
    const exp = blendReference(s, src, dst).map((v) => v * 255);
    for (let c = 0; c < 4; c++) {
      const e = Math.abs(px[c]! - exp[c]!);
      if (e > maxErr) {
        maxErr = e;
        worst = { key: JSON.stringify(s), gpu: Array.from(px), expected: exp };
      }
    }
  }
  const glCalls = cache.calls;
  cache.apply({ ...valid[0]!, enabled: false, writeMask: [true, true, true, true] });
  assertNoGlError(gl, "blend test");
  program.dispose();
  target.dispose();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { states: valid.length, maxErrorLsb: maxErr, ...(worst ? { worst } : {}), glCalls };
}

// ---------------------------------------------------------------------------

export interface GeometryStreamTestResult {
  meshes: number;
  verticesPerMesh: number;
  /** One draw call for all meshes instead of one per mesh. */
  batched: boolean;
  /** Mesh centers whose pixel color was wrong, per frame. */
  wrongFrame1: number;
  wrongFrame2: number;
  /** Average milliseconds for update + upload + draw + 1-pixel sync, over the timed frames. */
  msPerFrame: number;
  /** Where the frame time goes: JS vertex writes, upload + draw submission, waiting for the GPU. */
  breakdownMs: { writeVertices: number; uploadAndSubmit: number; gpuWait: number };
  timedFrames: number;
  uploadCallsPerFrame: number;
  uploadedBytesPerFrame: number;
  gpuBytes: number;
}

/**
 * Streams `meshes` grid-shaped meshes (each a `side × side` vertex grid) into
 * one {@link GeometryStream}, checks pixel colors after moving them, then times
 * full per-frame updates.
 */
export function geometryStreamTest(
  gl: WebGL2RenderingContext,
  opts: { meshes?: number; side?: number; frames?: number; batched?: boolean } = {},
): GeometryStreamTestResult {
  const meshes = opts.meshes ?? 500;
  const side = opts.side ?? 8;
  const frames = opts.frames ?? 60;
  const cols = Math.ceil(Math.sqrt(meshes));
  const rows = Math.ceil(meshes / cols);
  const size = 512;
  const target = new RenderTarget(gl, size, size);
  const program = new ShaderProgram(gl, SOLID_VS, SOLID_FS, "self-test solid");
  const memory = new GpuMemoryTracker();
  const stream = new GeometryStream(
    gl,
    [
      { name: "position", location: 0, components: 2, usage: "stream" },
      { name: "color", location: 1, components: 4, usage: "static" },
    ],
    { initialVertices: 256, initialIndices: 256, memory },
  );
  const vpm = side * side;
  const indices: number[] = [];
  for (let y = 0; y < side - 1; y++) {
    for (let x = 0; x < side - 1; x++) {
      const i = y * side + x;
      indices.push(i, i + 1, i + side, i + 1, i + side + 1, i + side);
    }
  }
  const colorOf = (m: number): Rgba => [
    ((m * 37) % 251) / 255,
    ((m * 91) % 241) / 255,
    ((m * 17) % 239) / 255,
    1,
  ];
  const slots: MeshSlot[] = [];
  for (let m = 0; m < meshes; m++) {
    const slot = stream.addMesh(vpm, indices);
    const c = colorOf(m);
    const col = new Float32Array(vpm * 4);
    for (let v = 0; v < vpm; v++) col.set(c, v * 4);
    stream.setAttribute(slot, "color", col);
    slots.push(slot);
  }
  const cellW = 2 / cols;
  const cellH = 2 / rows;
  const pos = new Float32Array(vpm * 2);
  /** Writes mesh `m` as a grid filling 80% of cell `cell`, with a little wobble. */
  const place = (m: number, cell: number, wobble: number) => {
    const cx = -1 + ((cell % cols) + 0.5) * cellW;
    const cy = -1 + (Math.floor(cell / cols) + 0.5) * cellH;
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const u = x / (side - 1) - 0.5;
        const v = y / (side - 1) - 0.5;
        const w = wobble * Math.sin((x + y + m) * 0.7) * 0.02;
        pos[(y * side + x) * 2] = cx + u * cellW * 0.8 + w * cellW;
        pos[(y * side + x) * 2 + 1] = cy + v * cellH * 0.8;
      }
    }
    stream.setAttribute(slots[m]!, "position", pos);
  };
  const draw = () => {
    stream.upload();
    target.bind();
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    program.use();
    stream.bind();
    if (opts.batched) stream.drawRange(slots[0]!, slots[slots.length - 1]!);
    else for (const s of slots) stream.draw(s);
    stream.unbind();
  };
  const check = (cellOf: (m: number) => number) => {
    const px = readbackRgba(gl, target, { source: "straight", output: "straight" }).data;
    let wrong = 0;
    for (let m = 0; m < meshes; m++) {
      const cell = cellOf(m);
      const x = Math.floor(((cell % cols) + 0.5) * (size / cols));
      const y = size - 1 - Math.floor((Math.floor(cell / cols) + 0.5) * (size / rows));
      const i = (y * size + x) * 4;
      const c = colorOf(m).map((v) => Math.round(v * 255));
      if (c.some((v, k) => Math.abs(v - px[i + k]!) > 1)) wrong++;
    }
    return wrong;
  };

  for (let m = 0; m < meshes; m++) place(m, m, 0);
  draw();
  const wrongFrame1 = check((m) => m);
  // Swap neighbouring pairs of meshes.
  const swapped = (m: number) => (m % 2 === 0 ? (m + 1 < meshes ? m + 1 : m) : m - 1);
  for (let m = 0; m < meshes; m++) place(m, swapped(m), 0);
  draw();
  const wrongFrame2 = check(swapped);

  // Timed frames: every mesh's positions change every frame.
  const sync = new Uint8Array(4);
  const t0 = performance.now();
  let calls = 0;
  let bytes = 0;
  let cpuMs = 0;
  let submitMs = 0;
  for (let f = 0; f < frames; f++) {
    const a = performance.now();
    for (let m = 0; m < meshes; m++) place(m, m, Math.sin(f * 0.1));
    const b = performance.now();
    draw();
    const c = performance.now();
    calls += stream.stats.uploadCalls;
    bytes += stream.stats.uploadedBytes;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sync);
    cpuMs += b - a;
    submitMs += c - b;
  }
  const ms = (performance.now() - t0) / frames;
  assertNoGlError(gl, "geometry stream test");
  const gpuBytes = stream.stats.gpuBytes;
  stream.dispose();
  program.dispose();
  target.dispose();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    meshes,
    verticesPerMesh: vpm,
    batched: opts.batched === true,
    wrongFrame1,
    wrongFrame2,
    msPerFrame: Math.round(ms * 100) / 100,
    breakdownMs: {
      writeVertices: Math.round((cpuMs / frames) * 100) / 100,
      uploadAndSubmit: Math.round((submitMs / frames) * 100) / 100,
      gpuWait: Math.round((ms - (cpuMs + submitMs) / frames) * 100) / 100,
    },
    timedFrames: frames,
    uploadCallsPerFrame: calls / frames,
    uploadedBytesPerFrame: bytes / frames,
    gpuBytes,
  };
}

// ---------------------------------------------------------------------------

export interface PoolTestResult {
  sameObjectReused: boolean;
  differentSpecsDistinct: boolean;
  statsAfterAcquire: unknown;
  statsAfterEvict: unknown;
  stencilInside: number[];
  stencilOutside: number[];
  trackedBytes: number;
  doubleReleaseThrows: boolean;
}

export function renderTargetPoolTest(gl: WebGL2RenderingContext): PoolTestResult {
  const memory = new GpuMemoryTracker();
  const pool = new RenderTargetPool(gl, { maxIdleFrames: 2, memory });
  const a = pool.acquire({ width: 64, height: 32 });
  const b = pool.acquire({ width: 64, height: 32, stencil: true });
  const c = pool.acquire({ width: 17, height: 300, filter: "nearest" });
  const differentSpecsDistinct = a !== b && b !== c && a !== c;
  pool.release(a);
  const a2 = pool.acquire({ width: 64, height: 32 });
  const sameObjectReused = a2 === a;
  const statsAfterAcquire = pool.stats;
  const trackedBytes = memory.total;

  // Stencil: mark the left half, then fill where stencil == 1.
  const program = fullscreenProgram(gl);
  b.bind();
  gl.clearColor(0, 0, 0, 0);
  gl.clearStencil(0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  gl.enable(gl.STENCIL_TEST);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, 32, 32);
  gl.colorMask(false, false, false, false);
  gl.stencilFunc(gl.ALWAYS, 1, 0xff);
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
  program.use();
  gl.uniform4fv(program.uniform("uColor"), [1, 1, 1, 1]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  gl.stencilFunc(gl.EQUAL, 1, 0xff);
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  gl.uniform4fv(program.uniform("uColor"), [0, 1, 0, 1]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.STENCIL_TEST);
  const px = readbackRgba(gl, b, { source: "straight", output: "straight" }).data;
  const at = (x: number, y: number) =>
    Array.from(px.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  const stencilInside = at(10, 16);
  const stencilOutside = at(50, 16);

  pool.release(a2);
  pool.release(b);
  let doubleReleaseThrows = false;
  try {
    pool.release(b);
  } catch {
    doubleReleaseThrows = true;
  }
  for (let i = 0; i < 4; i++) pool.endFrame();
  const statsAfterEvict = pool.stats;
  pool.release(c);
  pool.dispose();
  program.dispose();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  assertNoGlError(gl, "pool test");
  return {
    sameObjectReused,
    differentSpecsDistinct,
    statsAfterAcquire,
    statsAfterEvict,
    stencilInside,
    stencilOutside,
    trackedBytes,
    doubleReleaseThrows,
  };
}

// ---------------------------------------------------------------------------

export interface ReadbackTestResult {
  premultiplied: number[];
  straight: number[];
  topRowIsTop: boolean;
}

/** Clears a target to a known premultiplied color and reads it back both ways. */
export function readbackTest(gl: WebGL2RenderingContext): ReadbackTestResult {
  const t = new RenderTarget(gl, 4, 2);
  t.bind();
  gl.clearColor(60 / 255, 30 / 255, 0, 120 / 255);
  gl.clear(gl.COLOR_BUFFER_BIT);
  // Paint the top row (GL y = 1) opaque blue to check row order.
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, 1, 4, 1);
  gl.clearColor(0, 0, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.SCISSOR_TEST);
  const pm = readbackRgba(gl, t, { source: "premultiplied", output: "premultiplied" }).data;
  const st = readbackRgba(gl, t, { source: "premultiplied", output: "straight" }).data;
  t.dispose();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    premultiplied: Array.from(pm.subarray(16, 20)),
    straight: Array.from(st.subarray(16, 20)),
    topRowIsTop: pm[2] === 255 && pm[3] === 255 && pm[18] === 0,
  };
}

// ---------------------------------------------------------------------------

export interface TextureUploadTestResult {
  width: number;
  height: number;
  /** Straight decode + upload reproduces the source exactly (texels with alpha > 0). */
  straightExact: boolean;
  /** Largest difference between premultiplied decode and CPU premultiplication. */
  premultipliedMaxError: number;
  /** Strip upload gives the same texels as a single upload. */
  stripMatchesSingle: boolean;
  /** Worker decode gives the same texels as main-thread decode. */
  workerMatchesMain: boolean | null;
}

const COPY_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }`;

/** Reads a texture back texel-for-texel (nearest sampling into a same-size target). */
function readTexture(
  gl: WebGL2RenderingContext,
  program: ShaderProgram,
  tex: Texture2D,
): Uint8Array {
  const target = new RenderTarget(gl, tex.width, tex.height);
  target.bind();
  gl.disable(gl.BLEND);
  program.use();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex.texture);
  gl.uniform1i(program.uniform("uTex"), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = readbackRgba(gl, target, { source: "straight", output: "straight" }).data;
  gl.bindTexture(gl.TEXTURE_2D, null);
  target.dispose();
  return px;
}

/**
 * Encodes a synthetic RGBA image as PNG, decodes it with createImageBitmap
 * (straight and premultiplied, main thread and worker) and uploads it in one
 * call and in strips; compares texels against CPU references.
 */
export async function textureUploadTest(
  gl: WebGL2RenderingContext,
): Promise<TextureUploadTestResult> {
  const width = 67;
  const height = 45;
  const src = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      src[i] = (x * 7 + y * 3) % 256;
      src[i + 1] = (x * 13) % 256;
      src[i + 2] = (y * 29 + 11) % 256;
      src[i + 3] = (x * 5 + y * 11) % 256;
    }
  }
  const png = encodePngRgba8(width, height, src);
  const program = new ShaderProgram(gl, COPY_VS, COPY_FS, "texture copy");
  const nearest = { filter: "nearest" as const };

  const straightBmp = (await decodeImageHere(png, { alpha: "straight" })).bitmap;
  const straightTex = createTexture2D(gl, straightBmp, {
    ...nearest,
    alpha: "straight",
    sourceAlpha: "straight",
  });
  const straight = readTexture(gl, program, straightTex);
  let straightExact = true;
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3] === 0) continue;
    for (let c = 0; c < 4; c++) if (straight[i + c] !== src[i + c]) straightExact = false;
  }

  const pmBmp = (await decodeImageHere(png, { alpha: "premultiplied" })).bitmap;
  const single = createTexture2D(gl, pmBmp, {
    ...nearest,
    alpha: "premultiplied",
    sourceAlpha: "premultiplied",
  });
  const strip = await createTexture2DIncremental(gl, pmBmp, {
    ...nearest,
    alpha: "premultiplied",
    sourceAlpha: "premultiplied",
    stripRows: 7,
  });
  const a = readTexture(gl, program, single);
  const b = readTexture(gl, program, strip);
  const cpu = premultiplyRgba8(src);
  let premultipliedMaxError = 0;
  for (let i = 0; i < a.length; i++)
    premultipliedMaxError = Math.max(premultipliedMaxError, Math.abs(a[i]! - cpu[i]!));
  const stripMatchesSingle = a.every((v, i) => v === b[i]);

  let workerMatchesMain: boolean | null = null;
  const decoder = new ImageDecoder({ workers: 1 });
  if (decoder.usesWorkers) {
    const wb = (await decoder.decode(png, { alpha: "premultiplied" })).bitmap;
    const wt = createTexture2D(gl, wb, {
      ...nearest,
      alpha: "premultiplied",
      sourceAlpha: "premultiplied",
    });
    const w = readTexture(gl, program, wt);
    workerMatchesMain = w.every((v, i) => v === a[i]);
    gl.deleteTexture(wt.texture);
    wb.close();
  }
  decoder.dispose();

  for (const t of [straightTex, single, strip]) gl.deleteTexture(t.texture);
  straightBmp.close();
  pmBmp.close();
  program.dispose();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  assertNoGlError(gl, "texture upload test");
  return {
    width,
    height,
    straightExact,
    premultipliedMaxError,
    stripMatchesSingle,
    workerMatchesMain,
  };
}

export interface TextureExactTestResult {
  /** Texels of the 256×256 (c, a) table whose premultiplied value differs from ⌊c·a/255 + ½⌋. */
  premultiplyMismatches: number;
  /** Texels of any mip level that differ from the 2×2 ties-to-even rule. */
  mipMismatches: number;
  /** Levels checked in the non-square texture. */
  levels: number;
  /** Texels of any mip level of the non-power-of-two texture that differ from the same rule. */
  npotMismatches: number;
  /** Levels checked in the non-power-of-two texture. */
  npotLevels: number;
  first: string | null;
}

/** Reads one level of a texture (rows in texture order: the image's top row first). */
function readLevel(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  level: number,
  width: number,
  height: number,
): Uint8Array {
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, level);
  const out = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  return out;
}

/**
 * Exact texture preparation (§2b) through the whole loading path:
 * PNG → straight decode → upload → GPU premultiply and mip chain → readback,
 * compared with the integer rules computed on the CPU.
 */
export async function textureExactTest(
  gl: WebGL2RenderingContext,
): Promise<TextureExactTestResult> {
  const { premultiplyByte, mipAverage } = await import("../core/render/compositing.js");
  const { TextureLoader } = await import("../render/texture/loader.js");
  const loader = new TextureLoader(gl, { exact: true, mipmaps: true, oversize: "fail" });
  let first: string | null = null;
  const note = (s: string) => (first ??= s);
  try {
    // 1. Every (c, a) pair: texel (x = c, y = a).
    const table = new Uint8Array(256 * 256 * 4);
    for (let a = 0; a < 256; a++)
      for (let c = 0; c < 256; c++) {
        const i = (a * 256 + c) * 4;
        table.set([c, 255 - c, (c * 37) & 255, a], i);
      }
    // 2. A non-square power-of-two texture of seeded noise; 3. a non-power-of-two one.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
    const noise = (w: number, h: number) => Uint8Array.from({ length: w * h * 4 }, rnd);
    const pot = { w: 64, h: 32, data: noise(64, 32) };
    const npot = { w: 37, h: 21, data: noise(37, 21) };
    const files = [
      { label: "table", bytes: encodePngRgba8(256, 256, table) },
      { label: "pot", bytes: encodePngRgba8(pot.w, pot.h, pot.data) },
      { label: "npot", bytes: encodePngRgba8(npot.w, npot.h, npot.data) },
    ];
    const loaded = await loader.loadSet(files);
    const premultiplied = (src: Uint8Array) => {
      const out = new Uint8Array(src.length);
      for (let i = 0; i < src.length; i += 4) {
        const a = src[i + 3]!;
        out[i] = premultiplyByte(src[i]!, a);
        out[i + 1] = premultiplyByte(src[i + 1]!, a);
        out[i + 2] = premultiplyByte(src[i + 2]!, a);
        out[i + 3] = a;
      }
      return out;
    };

    let premultiplyMismatches = 0;
    const got = readLevel(gl, loaded[0]!.texture.texture, 0, 256, 256);
    const want = premultiplied(table);
    for (let i = 0; i < want.length; i++)
      if (got[i] !== want[i]) {
        premultiplyMismatches++;
        note(`table byte ${i}: ${got[i]} ≠ ${want[i]}`);
      }

    /** Mismatches of a texture's whole mip chain with the 2×2 rule on clamped blocks. */
    const checkChain = (
      tex: WebGLTexture,
      src: { w: number; h: number; data: Uint8Array },
      name: string,
    ) => {
      let mismatches = 0;
      let level = premultiplied(src.data);
      let w = src.w;
      let h = src.h;
      let levels = 0;
      for (let L = 0; ; L++) {
        levels++;
        const g = readLevel(gl, tex, L, w, h);
        for (let i = 0; i < level.length; i++)
          if (g[i] !== level[i]) {
            mismatches++;
            note(`${name} mip ${L} byte ${i}: ${g[i]} ≠ ${level[i]}`);
          }
        if (w === 1 && h === 1) break;
        const nw = Math.max(1, w >> 1);
        const nh = Math.max(1, h >> 1);
        const next = new Uint8Array(nw * nh * 4);
        const at = (x: number, y: number, c: number) =>
          level[(Math.min(y, h - 1) * w + Math.min(x, w - 1)) * 4 + c]!;
        for (let y = 0; y < nh; y++)
          for (let x = 0; x < nw; x++)
            for (let c = 0; c < 4; c++)
              next[(y * nw + x) * 4 + c] = mipAverage(
                at(2 * x, 2 * y, c),
                at(2 * x + 1, 2 * y, c),
                at(2 * x, 2 * y + 1, c),
                at(2 * x + 1, 2 * y + 1, c),
              );
        level = next;
        w = nw;
        h = nh;
      }
      return { mismatches, levels };
    };
    const potChain = checkChain(loaded[1]!.texture.texture, pot, "pot");
    const mipMismatches = potChain.mismatches;
    const levels = potChain.levels;
    // Non-power-of-two sizes follow the same rule (not left to the driver).
    const npotChain = checkChain(loaded[2]!.texture.texture, npot, "npot");
    const npotMismatches = npotChain.mismatches;
    const npotLevels = npotChain.levels;

    loader.release(loaded);
    assertNoGlError(gl, "texture exact test");
    return { premultiplyMismatches, mipMismatches, levels, npotMismatches, npotLevels, first };
  } finally {
    loader.dispose();
  }
}

/**
 * The model renderer: draws an evaluated model
 * instance in render order.
 *
 * - Fragment colors (§2c), legacy blend modes on 8-bit targets (§2d) and
 *   culling of single-sided drawables (§2e).
 * - Clipping masks. The reference configuration is per-drawable (§2g.3):
 *   before each masked drawable, its group's mask meshes are rasterized into
 *   the red channel of an S × S buffer (S = 4096) through the group-box
 *   mapping, and the drawable samples that buffer bilinearly. Offscreen masks
 *   use their own 256 × 256 buffer (correction C8). Under the
 *   reference contract every mask mesh is rasterized, inactive ones at their
 *   stale vertices (C13); the viewer rasterizes only active ones. The viewer
 *   may also use a mask atlas ("atlas", see mask-atlas.ts) for drawable masks:
 *   an approximation for interactive use that reference renders never use.
 * - The layered pipeline of file version 6 (§2h): a stack of image-sized
 *   layers for offscreens, advanced blend codes computed in the shader from a
 *   copy of the destination, offscreen compositing with masks.
 *
 * Shortcuts that cannot change the image:
 * - Mask buffers are cleared and drawn only inside the scissor rectangle that
 *   the masked drawable can sample (its group box plus 2 pixels); pixels
 *   outside it are never read, so this is equivalent to regenerating the
 *   whole buffer.
 * - When consecutive masked draws use the same group, the buffer already holds
 *   exactly what regenerating it would produce, so it is kept.
 * - GL state and uniform values already in effect are not set again.
 * - Vertex arrays whose evaluator version did not change are not re-uploaded.
 */
import type { MocModel } from "../../core/moc/model.js";
import type { ModelInstance } from "../../core/eval/instance.js";
import { outputTriangles } from "../../core/eval/static-output.js";
import { clipTransform, clipTurn, visibleBox, type Framing } from "../../core/render/framing.js";
import {
  columnMajor,
  layerMaskMatrix,
  maskMatrices,
  viewMatrix,
} from "../../core/render/mask-matrix.js";
import { sampledUvs } from "../../core/render/sampling.js";
import {
  alphaPart,
  colorPart,
  compatibleBlendMode,
  isCompatibleBlend,
  legacyBlendOf,
  type LegacyBlend,
} from "../../core/render/compositing.js";
import {
  drawablesBox,
  drawablesUnder,
  isSelfOrAncestor,
  maskGroups,
  mapToMask,
  maskMapping,
  type Box,
  type MaskGrouping,
  type MaskMapping,
} from "../../core/render/masks.js";
import { GeometryStream, type MeshSlot } from "../gl/geometry-stream.js";
import { ShaderProgram } from "../gl/shader.js";
import { RenderTarget } from "../gl/render-target.js";
import { GlError } from "../gl/context.js";
import { CachedUniform, GlStateCache } from "../gl/state-cache.js";
import { GpuTimer, type GpuFrameTime } from "../gl/gpu-timer.js";
import type { Texture2D } from "../gl/texture.js";
import type { GpuMemoryTracker } from "../gl/gpu-memory.js";
import { ATLAS_LAYOUTS, clipBox, packMaskAtlas, type AtlasRegion } from "./mask-atlas.js";
import { LAYER_VS, MASK_FS, MASK_VS, MESH_VS, fragmentSource } from "./shaders.js";

/** The reference mask buffer size for drawable masks (§2g.3). */
export const REFERENCE_MASK_SIZE = 4096;

/** The mask buffer size for offscreen masks, in every configuration (C8). */
export const OFFSCREEN_MASK_SIZE = 256;

/**
 * Which mask meshes are rasterized (C13): "all" under the
 * reference contract (a fresh instance evaluated once has every "vertices
 * recomputed" flag set, so inactive mask meshes draw at their stale vertices);
 * "active" in a viewer, which after its first frame matches the flags of the
 * latest evaluation.
 */
export type MaskMeshes = "all" | "active";

/**
 * "per-drawable": the reference configuration (§2g.3).
 * "atlas": viewer-only approximation, never used for reference renders. Every
 * mask group needed in a frame is built once into its own atlas region, at a
 * density that follows the image (a few texels per image pixel), before the
 * frame's draws, and kept across frames while nothing it depends on changes.
 */
export type MaskMode = "per-drawable" | "atlas";

export interface ModelRendererOptions {
  /** Per-drawable mask buffer size S. Default {@link REFERENCE_MASK_SIZE}. */
  maskSize?: number;
  /** Offscreen mask buffer size. Default {@link OFFSCREEN_MASK_SIZE}. */
  offscreenMaskSize?: number;
  /** Default "all" (the reference contract). */
  maskMeshes?: MaskMeshes;
  /** Default "per-drawable". */
  masks?: MaskMode;
  /** Atlas mode: mask texels per image pixel. Default 2. */
  maskOversample?: number;
  /** Time frames on the GPU with timer queries, where available. Default false. */
  gpuTiming?: boolean;
  memory?: GpuMemoryTracker;
}

export interface FrameOptions {
  framing: Framing;
  /** Straight-alpha RGBA background; default transparent (§2i). */
  background?: readonly [number, number, number, number];
  /**
   * Clear the target to `background` first (default true). The viewer clears
   * the canvas itself and draws over it.
   */
  clear?: boolean;
  /** Framebuffer to draw into (null: the default framebuffer), framing.width × framing.height. */
  target: WebGLFramebuffer | null;
  /**
   * Application tints of the art meshes (not reference behavior): RGBA per
   * drawable, 4 floats each. RGB multiplies a drawable's color after its
   * multiply and screen colors, A its opacity. Masks are drawn without them.
   * Null or omitted: none.
   */
  tints?: Float32Array | null;
  /**
   * Only the render-order positions in [from, to) are drawn (not reference
   * behavior; default all). In the layered pipeline the offscreens open at
   * `from` are opened first, so the drawables in range are composited
   * through them as in a whole frame.
   */
  range?: { from: number; to: number } | null;
  /**
   * Other drawing at places in the render order (not reference behavior),
   * keyed by drawable index: `below` runs just before the drawable is drawn,
   * `above` just after, whether or not it is visible, in list order. Each
   * runs with the framebuffer the drawable is drawn into bound (the target,
   * or in the layered pipeline the layer of its offscreen) and the viewport
   * at the frame size; it may change any GL state. Drawables outside `range`
   * run none.
   */
  inserts?: ReadonlyMap<number, FrameInsert> | null;
}

/** Drawing just below and just above one drawable ({@link FrameOptions.inserts}). */
export interface FrameInsert {
  below?: readonly InsertHook[];
  above?: readonly InsertHook[];
}

/** Draws into `target`, which is bound; any GL state may change. */
export type InsertHook = (target: WebGLFramebuffer | null) => void;

/** What the renderer did in the last frame. */
export interface FrameStats {
  pipeline: "direct" | "layered";
  masks: MaskMode;
  drawn: number;
  masked: number;
  /** Mask buffer (per-drawable) or atlas region (atlas) builds. */
  maskBuilds: number;
  /** Atlas mode: mask groups whose atlas region was still valid. */
  masksReused: number;
  maskMeshDraws: number;
  layers: number;
  advancedDraws: number;
  /** GL draw calls: drawables, mask meshes and layer composites. */
  drawCalls: number;
  /** Meshes whose vertices were staged for upload since the previous frame. */
  meshesUploaded: number;
  /** Buffer upload calls and bytes. */
  uploads: number;
  uploadBytes: number;
  /** State-setting GL calls issued, and redundant ones skipped. */
  stateChanges: number;
  stateSkipped: number;
  /** Framebuffer binds (each can end a render pass on tiled GPUs). */
  framebufferBinds: number;
  uniforms: number;
  uniformsSkipped: number;
  /** CPU milliseconds in draw(): uploads, mask builds, everything else, total. */
  cpuMs: { upload: number; masks: number; draw: number; total: number };
  /** GPU milliseconds of the latest frame whose timer queries completed; null if not timed. */
  gpuMs: GpuFrameTime | null;
}

const DOUBLE_SIDED = 4;
const INVERTED_MASK = 8;

/** A program with cached uniform values. */
class Program {
  private readonly uniforms = new Map<string, CachedUniform>();

  constructor(
    readonly shader: ShaderProgram,
    private readonly counter: { sent: number; skipped: number },
  ) {}

  u(name: string): CachedUniform {
    let u = this.uniforms.get(name);
    if (!u) {
      u = new CachedUniform(this.shader.gl, this.shader.uniform(name), this.counter);
      this.uniforms.set(name, u);
    }
    return u;
  }
}

interface GroupMask {
  box: Box;
  map: MaskMapping;
}

/** A mask ready to sample: mapping into a texture. */
interface MaskSource {
  map: MaskMapping;
  texture: WebGLTexture;
}

/** A built atlas region and what it was built from. */
interface AtlasEntry {
  region: AtlasRegion;
  generation: number;
  inst: ModelInstance;
  versions: Uint32Array;
  active: Uint8Array;
}

interface Layer {
  target: RenderTarget;
  /** Offscreen owning the layer, -1 for the model layer L₀. */
  offscreen: number;
}

/** No group's masks are in the mask buffer. */
const NO_MASK = 0x7fffffff;

const emptyStats = (pipeline: FrameStats["pipeline"], masks: MaskMode): FrameStats => ({
  pipeline,
  masks,
  drawn: 0,
  masked: 0,
  maskBuilds: 0,
  masksReused: 0,
  maskMeshDraws: 0,
  layers: 0,
  advancedDraws: 0,
  drawCalls: 0,
  meshesUploaded: 0,
  uploads: 0,
  uploadBytes: 0,
  stateChanges: 0,
  stateSkipped: 0,
  framebufferBinds: 0,
  uniforms: 0,
  uniformsSkipped: 0,
  cpuMs: { upload: 0, masks: 0, draw: 0, total: 0 },
  gpuMs: null,
});

const sameMap = (a: MaskMapping, b: MaskMapping) =>
  a.ox === b.ox &&
  a.sx === b.sx &&
  a.oy === b.oy &&
  a.sy === b.sy &&
  (a.lx ?? 0) === (b.lx ?? 0) &&
  (a.ly ?? 0) === (b.ly ?? 0);

/** The texture and clip matrices of a mapping (rule M), column-major for WebGL, once per mapping. */
const matricesOf = new WeakMap<MaskMapping, { texture: Float32Array; clip: Float32Array }>();
function glMatrices(map: MaskMapping): { texture: Float32Array; clip: Float32Array } {
  let m = matricesOf.get(map);
  if (!m) {
    const { texture, clip } = maskMatrices(map);
    m = { texture: columnMajor(texture), clip: columnMajor(clip) };
    matricesOf.set(map, m);
  }
  return m;
}

/** The texture matrix of a draw without a mask (its coordinate is never sampled). */
const NO_MASK_MATRIX = new Float32Array(16);

export class ModelRenderer {
  private size: number;
  private readonly offscreenSize: number;
  /** Which mask meshes are rasterized (C13). */
  maskMeshes: MaskMeshes;
  private maskMode: MaskMode;
  private oversample: number;
  /** True if the file needs the layered pipeline (§2h.1). */
  readonly layered: boolean;
  private readonly stream: GeometryStream;
  private readonly slots: MeshSlot[] = [];
  private readonly uniformCounter = { sent: 0, skipped: 0 };
  private readonly meshCompatible: Program;
  private readonly meshAdvanced: Program;
  private readonly layerCompatible: Program;
  private readonly layerAdvanced: Program;
  private readonly maskProgram: Program;
  private readonly fullscreenVao: WebGLVertexArrayObject;
  private readonly state: GlStateCache;
  private readonly timer: GpuTimer | null;
  private maskTarget: RenderTarget | null = null;
  private offscreenMaskTarget: RenderTarget | null = null;
  private atlas: RenderTarget | null = null;
  private atlasGeneration = 0;
  /** Atlas entries: drawable groups first, then offscreen groups. */
  private atlasEntries: (AtlasEntry | null)[];
  /** This frame's atlas regions, or null when the frame uses per-drawable masks. */
  private atlasRegions: (AtlasRegion | null)[] | null = null;
  private readonly drawableGroups: MaskGrouping;
  private readonly offscreenGroups: MaskGrouping;
  /** Drawables under each offscreen group's owners (box members, §2h.4). */
  private readonly offscreenBoxMembers: Int32Array[];
  private readonly blendOf: LegacyBlend[];
  private readonly layerPool: RenderTarget[] = [];
  private dstCopy: RenderTarget | null = null;
  private inst: ModelInstance | null = null;
  /** Per drawable: the instance's vertex version last staged for upload. */
  private readonly staged: Uint32Array;
  private meshesStaged = 0;
  /** Entries in render order: drawable d as d, offscreen o as −1 − o. */
  private order: Int32Array;
  /** Per-drawable mode, per frame: box and mapping of each mask group, computed on first use. */
  private groupMap: (GroupMask | null)[] = [];
  private offscreenMap: (GroupMask | null)[] = [];
  private framing: Framing | null = null;
  /** This frame's tints (FrameOptions.tints), or null. */
  private tints: Float32Array | null = null;
  private view: [number, number, number, number] = [0, 0, 0, 0];
  /** The view rotation in clip space (see clipTurn). */
  private turn: [number, number, number] = [1, 0, 0];
  /** Drawable mask group held by the drawable mask buffer, and offscreen group by the offscreen one. */
  private maskHolds = NO_MASK;
  private offscreenMaskHolds = NO_MASK;
  private readonly memory: GpuMemoryTracker | undefined;
  stats: FrameStats;

  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly model: MocModel,
    private readonly textures: readonly (Texture2D | null | undefined)[],
    options: ModelRendererOptions = {},
  ) {
    const m = model;
    this.size = options.maskSize ?? REFERENCE_MASK_SIZE;
    this.offscreenSize = options.offscreenMaskSize ?? OFFSCREEN_MASK_SIZE;
    this.maskMeshes = options.maskMeshes ?? "all";
    this.maskMode = options.masks ?? "per-drawable";
    this.oversample = options.maskOversample ?? 2;
    this.memory = options.memory;
    this.state = new GlStateCache(gl);
    this.timer = options.gpuTiming ? GpuTimer.create(gl) : null;
    const c = this.uniformCounter;
    const vs = MESH_VS;
    this.meshCompatible = new Program(new ShaderProgram(gl, vs, fragmentSource(false), "mesh"), c);
    this.meshAdvanced = new Program(
      new ShaderProgram(gl, vs, fragmentSource(true), "mesh advanced"),
      c,
    );
    this.layerCompatible = new Program(
      new ShaderProgram(gl, LAYER_VS, fragmentSource(false), "layer"),
      c,
    );
    this.layerAdvanced = new Program(
      new ShaderProgram(gl, LAYER_VS, fragmentSource(true), "layer advanced"),
      c,
    );
    this.maskProgram = new Program(new ShaderProgram(gl, MASK_VS, MASK_FS, "mask"), c);
    const vao = gl.createVertexArray();
    if (!vao) throw new GlError("createVertexArray returned null (context lost?)");
    this.fullscreenVao = vao;

    const N = m.meshes.ids.length;
    this.stream = new GeometryStream(
      gl,
      [
        { name: "position", location: 0, components: 2, usage: "dynamic" },
        { name: "uv", location: 1, components: 2, usage: "static" },
      ],
      {
        initialVertices: Math.max(
          16,
          m.meshes.vertexCount.reduce((a, b) => a + b, 0),
        ),
        initialIndices: Math.max(
          16,
          m.meshes.triangles.reduce((a, t) => a + t.length, 0),
        ),
        ...(options.memory ? { memory: options.memory } : {}),
        label: "model geometry",
      },
    );
    for (let i = 0; i < N; i++) {
      const slot = this.stream.addMesh(m.meshes.vertexCount[i]!, outputTriangles(m, i));
      // Rule V: v as the renderer samples it, flipped twice in float32.
      this.stream.setAttribute(slot, "uv", sampledUvs(m.meshes.uvs[i]!));
      this.slots.push(slot);
    }
    this.staged = new Uint32Array(N);

    // §2h.1: offscreens, or any drawable blend code the direct pipeline cannot draw.
    this.layered =
      m.offscreens.part.length > 0 ||
      Array.from(m.meshes.blendMode).some((c) => !isCompatibleBlend(c));
    this.blendOf = Array.from(m.meshes.flags, (f, i) =>
      this.layered ? compatibleBlendMode(m.meshes.blendMode[i]!) : legacyBlendOf(f),
    );
    this.drawableGroups = maskGroups(m.meshes.masks);
    this.offscreenGroups = maskGroups(m.offscreens.masks);
    this.offscreenBoxMembers = this.offscreenGroups.groups.map((g) => {
      const set = new Set<number>();
      for (const o of g.members)
        for (const d of drawablesUnder(m.meshes.part, m.parts.parent, m.offscreens.part[o]!))
          set.add(d);
      return Int32Array.from([...set].sort((a, b) => a - b));
    });
    this.atlasEntries = new Array<AtlasEntry | null>(
      this.drawableGroups.groups.length + this.offscreenGroups.groups.length,
    ).fill(null);
    this.order = new Int32Array(N + m.offscreens.part.length);
    this.stats = emptyStats(this.layered ? "layered" : "direct", this.maskMode);
  }

  /** Per-drawable mask buffer size S. */
  get maskSize(): number {
    return this.size;
  }

  /** Offscreen mask buffer size (C8). */
  get offscreenMaskSize(): number {
    return this.offscreenSize;
  }

  get masks(): MaskMode {
    return this.maskMode;
  }

  /** True if GPU frame times are being measured. */
  get gpuTimed(): boolean {
    return this.timer !== null;
  }

  /** Changes the per-drawable mask buffer size S (the reference is 4096). */
  setMaskSize(size: number): void {
    if (size === this.size) return;
    this.size = size;
    this.maskTarget?.dispose();
    this.maskTarget = null;
    this.maskHolds = this.offscreenMaskHolds = NO_MASK;
    this.groupMap.fill(null);
    this.offscreenMap.fill(null);
  }

  /** Switches mask modes; `oversample` sets the atlas's texels per image pixel. */
  setMaskMode(mode: MaskMode, oversample = this.oversample): void {
    this.maskMode = mode;
    this.oversample = oversample;
    this.maskHolds = this.offscreenMaskHolds = NO_MASK;
  }

  /** Takes the instance's current outputs (call after evaluate()). */
  update(inst: ModelInstance): void {
    const fresh = inst !== this.inst;
    this.inst = inst;
    const version = inst.drawableVertexVersion;
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) {
      if (!fresh && this.staged[i] === version[i]) continue;
      this.stream.setAttribute(this.slots[i]!, "position", inst.drawableVertices[i]!);
      this.staged[i] = version[i]!;
      n++;
    }
    this.meshesStaged += n;
    // Render order positions are a permutation of drawables and offscreens.
    const order = this.order;
    order.fill(0x7fffffff);
    inst.drawableRenderOrder.forEach((pos, d) => (order[pos] = d));
    inst.offscreenRenderOrder.forEach((pos, o) => (order[pos] = -1 - o));
    // Group boxes depend on this frame's positions; computed lazily per frame.
    this.groupMap = new Array<GroupMask | null>(this.drawableGroups.groups.length).fill(null);
    this.offscreenMap = new Array<GroupMask | null>(this.offscreenGroups.groups.length).fill(null);
  }

  /** Draws the last updated state. */
  draw(frame: FrameOptions): void {
    const inst = this.inst;
    if (!inst) throw new GlError("ModelRenderer.draw() before update()");
    const gl = this.gl;
    const t0 = performance.now();
    const f = frame.framing;
    this.framing = f;
    this.tints = frame.tints ?? null;
    this.view = clipTransform(f);
    this.turn = clipTurn(f);
    const s = (this.stats = emptyStats(this.layered ? "layered" : "direct", this.maskMode));
    this.timer?.beginFrame();
    this.timer?.phase("draws");
    this.maskHolds = this.offscreenMaskHolds = NO_MASK;
    this.stream.upload();
    const up = this.stream.stats;
    s.uploads = up.uploadCalls;
    s.uploadBytes = up.uploadedBytes;
    s.meshesUploaded = this.meshesStaged;
    this.meshesStaged = 0;
    const t1 = performance.now();
    s.cpuMs.upload = t1 - t0;
    const st = this.state;
    st.reset();
    st.issued = st.skipped = st.framebufferBinds = 0;
    this.uniformCounter.sent = this.uniformCounter.skipped = 0;

    this.atlasRegions = this.maskMode === "atlas" ? this.prepareAtlas() : null;

    const [r, g, b, a] = frame.background ?? [0, 0, 0, 0];
    st.bindFramebuffer(frame.target);
    st.viewport(0, 0, f.width, f.height);
    this.baseState();
    if (frame.clear ?? true) {
      st.clearColor(r * a, g * a, b * a, a);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    const n = this.order.length;
    const from = Math.max(0, Math.min(n, frame.range?.from ?? 0));
    const to = Math.max(from, Math.min(n, frame.range?.to ?? n));
    const inserts = frame.inserts ?? null;
    if (this.layered) this.drawLayered(frame, from, to, inserts);
    else this.drawDirect(frame.target, from, to, inserts);
    // Leave a predictable state for other code.
    st.set(gl.BLEND, false);
    st.set(gl.CULL_FACE, false);
    st.bindVertexArray(null);
    st.bindTexture(2, null);
    st.bindTexture(1, null);
    st.bindTexture(0, null);
    this.timer?.endFrame();
    s.stateChanges = st.issued;
    s.stateSkipped = st.skipped;
    s.framebufferBinds = st.framebufferBinds;
    s.uniforms = this.uniformCounter.sent;
    s.uniformsSkipped = this.uniformCounter.skipped;
    s.gpuMs = this.timer?.latest ?? null;
    s.cpuMs.total = performance.now() - t0;
    s.cpuMs.draw = s.cpuMs.total - s.cpuMs.upload - s.cpuMs.masks;
  }

  // ------------------------------------------------------------ pipelines

  /** The fixed state that every draw of a frame relies on. */
  private baseState(): void {
    const gl = this.gl;
    const st = this.state;
    st.set(gl.SCISSOR_TEST, false);
    st.set(gl.DEPTH_TEST, false);
    st.set(gl.STENCIL_TEST, false);
    st.colorMask(true, true, true, true);
    gl.frontFace(gl.CCW);
    gl.cullFace(gl.BACK);
    st.issued += 2;
  }

  /** Runs inserted drawing into `fb`, then takes up the frame's state again. */
  private runInserts(hooks: readonly InsertHook[], fb: WebGLFramebuffer | null): void {
    const st = this.state;
    const f = this.framing!;
    for (const hook of hooks) {
      st.bindFramebuffer(fb);
      st.viewport(0, 0, f.width, f.height);
      hook(fb);
      // The hook set state behind the cache's back.
      st.reset();
      this.baseState();
    }
  }

  /** §2d: every visible drawable straight into the destination, in render order. */
  private drawDirect(
    target: WebGLFramebuffer | null,
    from: number,
    to: number,
    inserts: ReadonlyMap<number, FrameInsert> | null,
  ): void {
    const inst = this.inst!;
    for (let k = from; k < to; k++) {
      const d = this.order[k]!;
      if (d < 0 || d === 0x7fffffff) continue;
      const ins = inserts?.get(d);
      if (ins?.below) this.runInserts(ins.below, target);
      if (inst.drawableVisible[d]) this.drawMesh(d, target, null);
      if (ins?.above) this.runInserts(ins.above, target);
    }
  }

  /**
   * Whether render-order element e (a drawable, or offscreen o as −1 − o)
   * closes the layer of offscreen `o`: an offscreen element closes the layers
   * whose owner is not a proper ancestor of its owner; a drawable those whose
   * owner is not its part or an ancestor of it.
   */
  private closesLayer(o: number, e: number): boolean {
    const m = this.model;
    const parents = m.parts.parent;
    const owner = m.offscreens.part[o]!;
    if (e < 0) {
      const next = m.offscreens.part[-1 - e]!;
      return owner === next || !isSelfOrAncestor(parents, owner, next);
    }
    return !isSelfOrAncestor(parents, owner, m.meshes.part[e]!);
  }

  /** §2h.2: layers for offscreens; L₀ composited over the destination at the end. */
  private drawLayered(
    frame: FrameOptions,
    from: number,
    to: number,
    inserts: ReadonlyMap<number, FrameInsert> | null,
  ): void {
    const inst = this.inst!;
    const stack: Layer[] = [{ target: this.acquireLayer(), offscreen: -1 }];
    const top = () => stack[stack.length - 1]!;
    const closeTop = () => {
      const layer = stack.pop()!;
      this.compositeOffscreen(layer, top());
      this.releaseLayer(layer.target);
    };
    // Invisible drawables change no layer, unless something is inserted at
    // them: that is drawn into their offscreen's layer.
    const skips = (e: number) => e >= 0 && !inst.drawableVisible[e] && !inserts?.has(e);
    // Before a range: the offscreens a whole frame has open at `from`, each
    // opened with an empty layer (what was drawn into them before is not).
    const open: number[] = [];
    for (let k = 0; k < from; k++) {
      const e = this.order[k]!;
      if (e === 0x7fffffff || skips(e)) continue;
      while (open.length && this.closesLayer(open[open.length - 1]!, e)) open.pop();
      if (e < 0) open.push(-1 - e);
    }
    for (const o of open) {
      stack.push({ target: this.acquireLayer(), offscreen: o });
      this.stats.layers++;
    }
    for (let k = from; k < to; k++) {
      const e = this.order[k]!;
      if (e === 0x7fffffff || skips(e)) continue;
      while (top().offscreen >= 0 && this.closesLayer(top().offscreen, e)) closeTop();
      if (e < 0) {
        stack.push({ target: this.acquireLayer(), offscreen: -1 - e });
        this.stats.layers++;
        continue;
      }
      const layer = top().target;
      const ins = inserts?.get(e);
      if (ins?.below) this.runInserts(ins.below, layer.framebuffer);
      if (inst.drawableVisible[e]) this.drawMesh(e, layer.framebuffer, layer);
      if (ins?.above) this.runInserts(ins.above, layer.framebuffer);
    }
    while (stack.length > 1) closeTop();
    // L₀ over the destination: dst ← L₀ + (1 − L₀.a)·dst.
    const l0 = stack.pop()!;
    this.state.bindFramebuffer(frame.target);
    this.state.viewport(0, 0, frame.framing.width, frame.framing.height);
    this.compositeLayer(l0.target, {
      multiply: [1, 1, 1],
      screen: [0, 0, 0],
      opacity: 1,
      code: 0,
      mask: null,
      inverted: false,
    });
    this.releaseLayer(l0.target);
  }

  // -------------------------------------------------------------- drawing

  /**
   * Draws drawable d into `fb`. `layer` is the layer behind `fb` (needed for
   * advanced blend codes, which read a copy of it); null in the direct pipeline.
   */
  private drawMesh(d: number, fb: WebGLFramebuffer | null, layer: RenderTarget | null): void {
    const gl = this.gl;
    const st = this.state;
    const inst = this.inst!;
    const m = this.model;
    const tex = this.textures[m.meshes.texture[d]!];
    if (!tex) return;
    // Every visible drawable (opacity ≠ 0) is drawn, with negative, NaN and
    // infinite opacities too: the shaders clamp the compatible source and the
    // advanced result, so a compatible blend changes nothing for a negative or NaN opacity, while
    // an advanced one brightens or erases the destination.
    // A tint's alpha multiplies the opacity (exactly so at 1); a tint alpha of 0
    // hides the mesh whatever its opacity.
    const tints = this.tints;
    const opacity = tints ? inst.drawableOpacity[d]! * tints[4 * d + 3]! : inst.drawableOpacity[d]!;
    if (opacity === 0 || (tints && tints[4 * d + 3] === 0)) return;
    const f = this.framing!;
    const code = m.meshes.blendMode[d]!;
    const advanced = this.layered && !isCompatibleBlend(code);
    const group = this.drawableGroups.groupOf[d]!;
    let mask: MaskSource | null = null;
    if (group >= 0) {
      mask = this.drawableMask(group);
      this.stats.masked++;
    }
    if (advanced && layer) this.copyDestination(layer);
    st.bindFramebuffer(fb);
    st.viewport(0, 0, f.width, f.height);
    const p = advanced ? this.meshAdvanced : this.meshCompatible;
    st.useProgram(p.shader.program);
    const v = this.view;
    p.u("uView").set4f(v[0], v[1], v[2], v[3]);
    p.u("uTurn").set3f(this.turn[0], this.turn[1], this.turn[2]);
    this.setColors(p, inst.drawableMultiply, inst.drawableScreen, d, opacity);
    if (tints) p.u("uTint").set3f(tints[4 * d]!, tints[4 * d + 1]!, tints[4 * d + 2]!);
    else p.u("uTint").set3f(1, 1, 1);
    this.setMask(p, mask, (m.meshes.flags[d]! & INVERTED_MASK) !== 0);
    st.bindTexture(0, tex.texture);
    p.u("uTex").set1i(0);
    if (advanced) {
      p.u("uColorFn").set1i(colorPart(code));
      p.u("uAlphaMode").set1i(alphaPart(code));
      st.bindTexture(2, this.dstCopy!.texture);
      p.u("uDst").set1i(2);
      st.set(gl.BLEND, false);
      this.stats.advancedDraws++;
    } else {
      this.applyBlend(this.blendOf[d]!);
    }
    st.set(gl.CULL_FACE, (m.meshes.flags[d]! & DOUBLE_SIDED) === 0);
    st.bindVertexArray(this.stream.vao);
    this.drawSlot(d);
    this.stats.drawn++;
  }

  private drawSlot(d: number): void {
    const slot = this.slots[d]!;
    if (slot.indexCount === 0) return;
    this.stream.draw(slot);
    this.stats.drawCalls++;
  }

  private setColors(
    p: Program,
    multiply: Float32Array,
    screen: Float32Array,
    i: number,
    opacity: number,
  ): void {
    p.u("uMultiply").set3f(multiply[3 * i]!, multiply[3 * i + 1]!, multiply[3 * i + 2]!);
    p.u("uScreen").set3f(screen[3 * i]!, screen[3 * i + 1]!, screen[3 * i + 2]!);
    p.u("uOpacity").set1f(opacity);
  }

  /**
   * The mask of a draw: a mesh looks it up through the mask's texture matrix
   * from output space (rule M), a whole layer through D = A · V⁻¹ from clip
   * space (rule I).
   */
  private setMask(p: Program, mask: MaskSource | null, inverted: boolean, layer = false): void {
    if (!mask) {
      p.u("uMaskMode").set1i(0);
      p.u("uMaskTex").setMatrix4(NO_MASK_MATRIX);
      return;
    }
    p.u("uMaskMode").set1i(inverted ? 2 : 1);
    p.u("uMaskTex").setMatrix4(
      layer
        ? columnMajor(layerMaskMatrix(mask.map, viewMatrix(this.view, this.turn)))
        : glMatrices(mask.map).texture,
    );
    this.state.bindTexture(1, mask.texture);
    p.u("uMask").set1i(1);
  }

  private applyBlend(mode: LegacyBlend): void {
    const gl = this.gl;
    const st = this.state;
    st.set(gl.BLEND, true);
    st.blendEquation(gl.FUNC_ADD);
    if (mode === "additive") st.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
    else if (mode === "multiplicative")
      st.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    else st.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  // ---------------------------------------------------------------- masks

  private drawableMask(g: number): MaskSource {
    const regions = this.atlasRegions;
    const r = regions?.[g];
    if (r) return { map: r.map, texture: this.atlas!.texture };
    return this.buildDrawableMask(g);
  }

  private offscreenMask(g: number): MaskSource {
    const regions = this.atlasRegions;
    const r = regions?.[this.drawableGroups.groups.length + g];
    if (r) return { map: r.map, texture: this.atlas!.texture };
    return this.buildOffscreenMask(g);
  }

  private ensureMaskTarget(offscreen: boolean): RenderTarget {
    const existing = offscreen ? this.offscreenMaskTarget : this.maskTarget;
    if (existing) return existing;
    const size = offscreen ? this.offscreenSize : this.size;
    const t = new RenderTarget(this.gl, size, size, {
      filter: "linear",
      label: offscreen ? "offscreen mask buffer" : "mask buffer",
      ...(this.memory ? { memory: this.memory } : {}),
    });
    this.state.reset(); // creating a target binds behind the cache's back
    if (offscreen) this.offscreenMaskTarget = t;
    else this.maskTarget = t;
    return t;
  }

  /** Regenerates the mask buffer for drawable group g (§2g.3; box with the quirk of §2g.2). */
  private buildDrawableMask(g: number): MaskSource {
    let gm = this.groupMap[g];
    if (!gm) {
      const box = drawablesBox(
        this.drawableGroups.groups[g]!.members,
        this.inst!.drawableVertices,
        true,
      );
      gm = { box, map: maskMapping(box, this.model.canvas.pixelsPerUnit, this.size) };
      this.groupMap[g] = gm;
    }
    if (this.maskHolds !== g) {
      this.rasterizeMasks(this.drawableGroups.groups[g]!.masks, gm.map, gm.box, false);
      this.maskHolds = g;
    }
    return { map: gm.map, texture: this.maskTarget!.texture };
  }

  /**
   * Mask buffer for an offscreen's group: §2h.4 (box over all drawables under
   * the owners, no quirk; the union over several owners, C9), in the
   * offscreen buffer of 256 × 256 (C8) with the mapping of §2g.3.
   *
   * When the layer is composited, the mask is looked up through
   * D = A · V⁻¹ from the quad's clip-space corners (rule I).
   */
  private buildOffscreenMask(g: number): MaskSource {
    let gm = this.offscreenMap[g];
    if (!gm) {
      const box = drawablesBox(this.offscreenBoxMembers[g]!, this.inst!.drawableVertices, false);
      gm = { box, map: maskMapping(box, this.model.canvas.pixelsPerUnit, this.offscreenSize) };
      this.offscreenMap[g] = gm;
    }
    if (this.offscreenMaskHolds !== g) {
      this.rasterizeMasks(this.offscreenGroups.groups[g]!.masks, gm.map, gm.box, true);
      this.offscreenMaskHolds = g;
    }
    return { map: gm.map, texture: this.offscreenMaskTarget!.texture };
  }

  /**
   * Clears a mask buffer (the drawable or the offscreen one) to (1, 1, 1, 1)
   * and multiplies red by (1 − α) for its group's mask meshes, within the
   * scissor rectangle the box maps to.
   */
  private rasterizeMasks(masks: Int32Array, map: MaskMapping, box: Box, offscreen: boolean): void {
    const t0 = performance.now();
    const gl = this.gl;
    const st = this.state;
    this.timer?.phase("masks");
    const S = offscreen ? this.offscreenSize : this.size;
    const target = this.ensureMaskTarget(offscreen);
    st.bindFramebuffer(target.framebuffer);
    st.viewport(0, 0, S, S);
    this.stats.maskBuilds++;
    const [a0, b0] = mapToMask(map, box.x0, box.y0);
    const [a1, b1] = mapToMask(map, box.x0 + box.w, box.y0 + box.h);
    const x0 = Math.max(0, Math.floor(a0 * S) - 2);
    const y0 = Math.max(0, Math.floor(b0 * S) - 2);
    const x1 = Math.min(S, Math.ceil(a1 * S) + 2);
    const y1 = Math.min(S, Math.ceil(b1 * S) + 2);
    const full = !(x1 > x0 && y1 > y0 && Number.isFinite(x0 + x1 + y0 + y1));
    st.set(gl.SCISSOR_TEST, true);
    if (full) st.scissor(0, 0, S, S);
    else st.scissor(x0, y0, x1 - x0, y1 - y0);
    st.colorMask(true, true, true, true);
    st.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawMaskMeshes(masks, map);
    st.colorMask(true, true, true, true);
    st.set(gl.SCISSOR_TEST, false);
    this.timer?.phase("draws");
    this.stats.cpuMs.masks += performance.now() - t0;
  }

  /**
   * Multiplies red by (1 − α) for the mask meshes (the target is bound): all
   * of them, inactive ones at their stale vertices, or only the active ones
   * (see {@link MaskMeshes}).
   */
  private drawMaskMeshes(masks: Int32Array, map: MaskMapping): void {
    const gl = this.gl;
    const st = this.state;
    const inst = this.inst!;
    const m = this.model;
    st.colorMask(true, false, false, false);
    st.set(gl.BLEND, true);
    st.blendEquation(gl.FUNC_ADD);
    st.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.maskProgram;
    st.useProgram(p.shader.program);
    p.u("uMaskClip").setMatrix4(glMatrices(map).clip);
    p.u("uTex").set1i(0);
    st.bindVertexArray(this.stream.vao);
    const activeOnly = this.maskMeshes === "active";
    for (let k = 0; k < masks.length; k++) {
      const mm = masks[k]!;
      if (activeOnly && !inst.drawableActive[mm]) continue;
      const tex = this.textures[m.meshes.texture[mm]!];
      if (!tex) continue;
      st.bindTexture(0, tex.texture);
      st.set(gl.CULL_FACE, (m.meshes.flags[mm]! & DOUBLE_SIDED) === 0);
      this.drawSlot(mm);
      this.stats.maskMeshDraws++;
    }
  }

  /**
   * Atlas mode: lays out a region for every mask group this frame needs and
   * builds the regions whose inputs changed. Returns the regions, or null if
   * they do not fit (the frame then uses per-drawable masks).
   */
  private prepareAtlas(): (AtlasRegion | null)[] | null {
    const t0 = performance.now();
    const gl = this.gl;
    const st = this.state;
    const inst = this.inst!;
    const m = this.model;
    const f = this.framing!;
    const G = this.drawableGroups.groups.length;
    // Only on-screen pixels sample masks: clip boxes to the image, plus 2 pixels.
    const view = visibleBox(f, 2);
    const boxes: (Box | null)[] = new Array<Box | null>(this.atlasEntries.length).fill(null);
    const groupOf = this.drawableGroups.groupOf;
    for (let d = 0; d < groupOf.length; d++) {
      const g = groupOf[d]!;
      if (g < 0 || boxes[g] || !inst.drawableVisible[d] || !this.textures[m.meshes.texture[d]!])
        continue;
      const members = this.drawableGroups.groups[g]!.members;
      boxes[g] = clipBox(drawablesBox(members, inst.drawableVertices, true), view);
    }
    // Offscreen masks keep their 256 × 256 buffer (C8), outside the atlas.
    const density = Math.min(m.canvas.pixelsPerUnit, this.oversample * f.k);
    // The first layout that fits; mappings are normalized to the texture, which only grows.
    let regions: (AtlasRegion | null)[] | null = null;
    let size = 0;
    for (const layout of ATLAS_LAYOUTS) {
      const texture = Math.max(layout.size, this.atlas?.width ?? 0);
      const d = density * layout.densityScale;
      regions = packMaskAtlas(boxes, d, layout.size, layout.maxRegion, texture);
      if (regions) {
        size = texture;
        break;
      }
    }
    if (!regions) return null;
    if (!this.atlas || this.atlas.width < size) {
      this.atlas?.dispose();
      this.atlas = new RenderTarget(gl, size, size, {
        filter: "linear",
        label: "mask atlas",
        ...(this.memory ? { memory: this.memory } : {}),
      });
      this.atlasGeneration++;
      st.reset();
    }
    const atlas = this.atlas;
    // Regions not needed this frame may be overwritten: forget them.
    let bound = false;
    for (let k = 0; k < regions.length; k++) {
      const r = regions[k];
      const e = this.atlasEntries[k];
      if (!r) {
        this.atlasEntries[k] = null;
        continue;
      }
      const masks =
        k < G ? this.drawableGroups.groups[k]!.masks : this.offscreenGroups.groups[k - G]!.masks;
      if (
        e &&
        e.generation === this.atlasGeneration &&
        e.inst === inst &&
        e.region.x === r.x &&
        e.region.y === r.y &&
        e.region.w === r.w &&
        e.region.h === r.h &&
        sameMap(e.region.map, r.map) &&
        this.masksUnchanged(e, masks)
      ) {
        this.stats.masksReused++;
        continue;
      }
      if (!bound) {
        this.timer?.phase("masks");
        st.bindFramebuffer(atlas.framebuffer);
        st.viewport(0, 0, atlas.width, atlas.height);
        st.set(gl.SCISSOR_TEST, true);
        bound = true;
      }
      // Mask meshes can reach beyond the box: the scissor keeps them in the region.
      st.scissor(r.x, r.y, r.w, r.h);
      st.colorMask(true, true, true, true);
      st.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawMaskMeshes(masks, r.map);
      this.stats.maskBuilds++;
      this.atlasEntries[k] = {
        region: r,
        generation: this.atlasGeneration,
        inst,
        versions: Uint32Array.from(masks, (mm) => inst.drawableVertexVersion[mm]!),
        active: Uint8Array.from(masks, (mm) => inst.drawableActive[mm]!),
      };
    }
    if (bound) {
      st.colorMask(true, true, true, true);
      st.set(gl.SCISSOR_TEST, false);
      this.timer?.phase("draws");
    }
    this.stats.cpuMs.masks += performance.now() - t0;
    return regions;
  }

  private masksUnchanged(e: AtlasEntry, masks: Int32Array): boolean {
    const inst = this.inst!;
    for (let k = 0; k < masks.length; k++) {
      const mm = masks[k]!;
      if (e.versions[k] !== inst.drawableVertexVersion[mm]) return false;
      if (e.active[k] !== inst.drawableActive[mm]) return false;
    }
    return true;
  }

  // --------------------------------------------------------------- layers

  private acquireLayer(): RenderTarget {
    const gl = this.gl;
    const st = this.state;
    const f = this.framing!;
    let t = this.layerPool.pop();
    if (t) {
      if (t.width !== f.width || t.height !== f.height) {
        t.resize(f.width, f.height);
        st.reset();
      }
    } else {
      t = new RenderTarget(gl, f.width, f.height, {
        // Rule L: layers are read through a linearly filtered quad.
        filter: "linear",
        label: "layer",
        ...(this.memory ? { memory: this.memory } : {}),
      });
      st.reset();
    }
    st.bindFramebuffer(t.framebuffer);
    st.viewport(0, 0, f.width, f.height);
    st.set(gl.SCISSOR_TEST, false);
    st.colorMask(true, true, true, true);
    st.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return t;
  }

  private releaseLayer(t: RenderTarget): void {
    this.layerPool.push(t);
  }

  /** Copies a layer into the destination copy read by advanced blends. */
  private copyDestination(layer: RenderTarget): void {
    const gl = this.gl;
    const st = this.state;
    const f = this.framing!;
    if (!this.dstCopy) {
      this.dstCopy = new RenderTarget(gl, f.width, f.height, {
        filter: "nearest",
        label: "destination copy",
        ...(this.memory ? { memory: this.memory } : {}),
      });
      st.reset();
    } else if (this.dstCopy.width !== f.width || this.dstCopy.height !== f.height) {
      this.dstCopy.resize(f.width, f.height);
      st.reset();
    }
    st.set(gl.SCISSOR_TEST, false);
    st.bindReadFramebuffer(layer.framebuffer);
    st.bindDrawFramebuffer(this.dstCopy.framebuffer);
    gl.blitFramebuffer(
      0,
      0,
      f.width,
      f.height,
      0,
      0,
      f.width,
      f.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
  }

  /** §2h.4: the offscreen's layer composited into the layer below it. */
  private compositeOffscreen(layer: Layer, below: Layer): void {
    const inst = this.inst!;
    const m = this.model;
    const f = this.framing!;
    const o = layer.offscreen;
    const g = this.offscreenGroups.groupOf[o]!;
    const mask = g >= 0 ? this.offscreenMask(g) : null;
    const code = m.offscreens.blendMode[o]!;
    if (!isCompatibleBlend(code)) this.copyDestination(below.target);
    this.state.bindFramebuffer(below.target.framebuffer);
    this.state.viewport(0, 0, f.width, f.height);
    this.compositeLayer(layer.target, {
      multiply: [
        inst.offscreenMultiply[3 * o]!,
        inst.offscreenMultiply[3 * o + 1]!,
        inst.offscreenMultiply[3 * o + 2]!,
      ],
      screen: [
        inst.offscreenScreen[3 * o]!,
        inst.offscreenScreen[3 * o + 1]!,
        inst.offscreenScreen[3 * o + 2]!,
      ],
      opacity: inst.offscreenOpacity[o]!,
      code,
      mask,
      inverted: (m.offscreens.flags[o]! & INVERTED_MASK) !== 0,
    });
  }

  /** Draws a whole layer as a drawable covering the image into the bound framebuffer. */
  private compositeLayer(
    layer: RenderTarget,
    s: {
      multiply: [number, number, number];
      screen: [number, number, number];
      opacity: number;
      code: number;
      mask: MaskSource | null;
      inverted: boolean;
    },
  ): void {
    const gl = this.gl;
    const st = this.state;
    const f = this.framing!;
    const advanced = !isCompatibleBlend(s.code);
    const p = advanced ? this.layerAdvanced : this.layerCompatible;
    st.useProgram(p.shader.program);
    p.u("uMultiply").set3f(...s.multiply);
    p.u("uScreen").set3f(...s.screen);
    p.u("uTint").set3f(1, 1, 1);
    p.u("uOpacity").set1f(s.opacity);
    this.setMask(p, s.mask, s.inverted, true);
    st.bindTexture(0, layer.texture);
    p.u("uTex").set1i(0);
    if (advanced) {
      p.u("uColorFn").set1i(colorPart(s.code));
      p.u("uAlphaMode").set1i(alphaPart(s.code));
      st.bindTexture(2, this.dstCopy!.texture);
      p.u("uDst").set1i(2);
      st.set(gl.BLEND, false);
      this.stats.advancedDraws++;
    } else {
      this.applyBlend(compatibleBlendMode(s.code));
    }
    st.set(gl.CULL_FACE, false);
    st.bindVertexArray(this.fullscreenVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.stats.drawCalls++;
  }

  dispose(): void {
    const gl = this.gl;
    this.stream.dispose();
    for (const p of [
      this.meshCompatible,
      this.meshAdvanced,
      this.layerCompatible,
      this.layerAdvanced,
      this.maskProgram,
    ])
      p.shader.dispose();
    gl.deleteVertexArray(this.fullscreenVao);
    this.maskTarget?.dispose();
    this.offscreenMaskTarget?.dispose();
    this.atlas?.dispose();
    this.dstCopy?.dispose();
    for (const t of this.layerPool) t.dispose();
    this.timer?.dispose();
  }
}

/**
 * The operations of Mochi2D's agent interface, shared by the MCP server
 * (tools/mochi2d-mcp.ts) and the `mochi2d` CLI (tools/mochi2d.ts): load a
 * model, describe it, read and set parameters and part opacities, play
 * expressions and motions, advance time, reset, render a PNG, hit-test, and
 * validate `.moc3` files.
 *
 * Files are read only under the allowed roots (./paths.ts); nothing is
 * written, and nothing goes to the network. One model is loaded at a time.
 */
import { ModelRuntime } from "../../../src/runtime/model-runtime.js";
import type { EffectName } from "../../../src/runtime/model-runtime.js";
import type { FileSource } from "../../../src/core/io/file-source.js";
import { classifyModelFile } from "../../../src/core/io/model-files.js";
import { loadMoc } from "../../../src/core/moc/model.js";
import { frameImage, outputPosition, type RenderView } from "../../../src/core/render/framing.js";
import {
  AllowedRoots,
  findModels,
  openModelLocation,
  readAllowedFile,
  type FoundModel,
  type ModelLocation,
} from "./paths.js";
import { AgentRenderer, type AgentRenderOutput } from "./render.js";

/** A deterministic random sequence in [0, 1) (mulberry32), so runs repeat. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EFFECTS: EffectName[] = [
  "physics",
  "eyeBlink",
  "breath",
  "look",
  "idle",
  "lipSync",
  "pose",
  "expressions",
  "motionSync",
];

/** The most time one call may advance, in seconds, and the frame rates allowed. */
export const MAX_ADVANCE_SECONDS = 600;
export const FPS_RANGE: readonly [number, number] = [1, 240];
/** Render size limits, in pixels. */
export const RENDER_SIZE_RANGE: readonly [number, number] = [16, 4096];
export const DEFAULT_RENDER_SIZE = 512;
/** The most models listModels returns. */
export const MAX_LISTED_MODELS = 200;

export interface LoadOptions {
  /** Seed of the random sequence (eye blinks, idle motions). Default 1. */
  seed?: number;
  /** Components to switch on or off after loading (physics, eyeBlink, breath, look, idle, lipSync, pose, expressions, motionSync). */
  effects?: Partial<Record<EffectName, boolean>>;
  /** Apply the motion-sync file's per-parameter `Smooth` too. Default false. */
  fileSmoothing?: boolean;
}

interface Loaded {
  runtime: ModelRuntime;
  location: ModelLocation;
  options: LoadOptions;
  generation: number;
  time: number;
}

export interface ParameterValue {
  id: string;
  name: string;
  /** The latest frame's value: the base value with motions, expressions and effects applied. */
  value: number;
  /** The base value (what set_parameters sets, or what motions left). */
  base: number;
  min: number;
  max: number;
  default: number;
}

export interface RenderRequest {
  width?: number;
  height?: number;
  /** The model-space point at the image center and image pixels per model unit; default: fit. */
  view?: RenderView;
  /** Straight-alpha RGBA in [0, 1]. Default opaque white, so the image is easy to see. */
  background?: [number, number, number, number];
  alpha?: "straight" | "premultiplied";
  /**
   * A faster preview that is not the reference render: textures downscaled
   * so no side exceeds this size, and the mask atlas.
   */
  maxTextureSize?: number;
}

export interface HitTestRequest {
  x: number;
  y: number;
  /** "model" (default): model units, y up. "pixels": image pixels of a render with this size and view. */
  space?: "model" | "pixels";
  width?: number;
  height?: number;
  view?: RenderView;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** At most this many points per map_points call. */
export const MAP_POINTS_LIMIT = 10_000;

export interface MapPointsRequest {
  /** A deformer ID; or give `drawable` to use that drawable's parent deformer. */
  deformer?: string;
  drawable?: string;
  /** Points in the deformer's input space (a drawable's keyform space with `drawable`). */
  points: [number, number][];
  /** "model" (default): model units, y up. "keyform": the y-down space of keyform positions. */
  space?: "model" | "keyform";
  jacobian?: boolean;
}

/**
 * The expressions in the queue, oldest first, without the empty expression
 * that ModelRuntime.clearExpression starts to fade the others out.
 */
function expressionsPlaying(rt: ModelRuntime): string[] {
  return rt.animator.expressions.expressions
    .filter((e) => !(e.label === "(none)" && e.parameters.length === 0))
    .map((e) => e.label);
}

function textureSize(n: number): number {
  if (!Number.isInteger(n) || n < 64 || n > 8192)
    throw new Error("maxTextureSize must be a whole number of pixels from 64 to 8192.");
  return n;
}

export class AgentSession {
  private loaded: Loaded | null = null;
  private generation = 0;
  private readonly renderer: AgentRenderer;

  constructor(
    /** Where models may be read from; replaceable (an MCP client's roots can change). */
    public roots: AllowedRoots,
    /** The folder that holds dist/web, for renders. */
    packageRoot: string,
  ) {
    this.renderer = new AgentRenderer(packageRoot);
  }

  private get model(): Loaded {
    if (!this.loaded) throw new Error("No model is loaded: call load_model first.");
    return this.loaded;
  }

  /** Whether a model is loaded. */
  get hasModel(): boolean {
    return this.loaded !== null;
  }

  // -------------------------------------------------------------- loading

  /**
   * The allowed folders, and the models (`*.model3.json` files and `.zip`
   * archives) under them, or under one folder inside them.
   */
  async listModels(folder?: string): Promise<{
    allowedFolders: string[];
    models: FoundModel[];
    truncated: boolean;
  }> {
    const starts = folder !== undefined ? [await this.roots.resolve(folder)] : this.roots.real;
    const models: FoundModel[] = [];
    let truncated = false;
    for (const start of starts) {
      const r = await findModels(this.roots, start, MAX_LISTED_MODELS - models.length);
      models.push(...r.models.filter((m) => !models.some((o) => o.path === m.path)));
      truncated ||= r.truncated;
      if (models.length >= MAX_LISTED_MODELS) break;
    }
    return { allowedFolders: [...this.roots.real], models, truncated };
  }

  /** Loads a model folder, `*.model3.json` file or `.zip` (it replaces the current one). */
  async load(path: string, options: LoadOptions = {}): Promise<Record<string, unknown>> {
    const unknown = Object.keys(options.effects ?? {}).filter(
      (name) => !EFFECTS.includes(name as EffectName),
    );
    if (unknown.length)
      throw new Error(
        `Unknown effects: ${unknown.join(", ")} (the effects are ${EFFECTS.join(", ")}).`,
      );
    const location = await openModelLocation(this.roots, path);
    const runtime = await this.open(location, options);
    this.loaded = { runtime, location, options, generation: ++this.generation, time: 0 };
    return this.summary();
  }

  private async open(location: ModelLocation, options: LoadOptions): Promise<ModelRuntime> {
    const runtime = await ModelRuntime.load(location.source, location.settingsPath, {
      animation: {
        random: seededRandom(options.seed ?? 1),
        ...(options.fileSmoothing !== undefined
          ? { motionSync: { fileSmoothing: options.fileSmoothing } }
          : {}),
      },
    });
    for (const [name, on] of Object.entries(options.effects ?? {}))
      runtime.setEffect(name as EffectName, !!on);
    runtime.update(0);
    return runtime;
  }

  /** Back to the state right after loading (a fresh runtime from the same files). */
  async reset(): Promise<Record<string, unknown>> {
    const m = this.model;
    const runtime = await this.open(m.location, m.options);
    this.loaded = { ...m, runtime, generation: ++this.generation, time: 0 };
    return this.summary();
  }

  /** A short summary of the loaded model. */
  summary(): Record<string, unknown> {
    const { runtime: rt, location, time } = this.model;
    return {
      path: location.path,
      settings: rt.settingsPath,
      mocVersion: rt.model.version,
      parameters: rt.parameters.length,
      parts: rt.parts.length,
      drawables: rt.model.meshes.ids.length,
      expressions: rt.expressionNames.length,
      motionGroups: rt.motionGroups,
      physics: rt.animator.physics !== null,
      time,
      warnings: rt.warnings,
    };
  }

  /** Everything an agent needs to drive the model. */
  describe(): Record<string, unknown> {
    const { runtime: rt, location, time } = this.model;
    const m = rt.model;
    const files = rt.files ?? [];
    const filesOf = (kind: string) => files.filter((f) => classifyModelFile(f) === kind);
    const groups: string[] = [];
    for (const p of rt.parameters) if (p.group && !groups.includes(p.group)) groups.push(p.group);
    const masked = m.meshes.ids.filter((_, i) => (m.meshes.masks?.[i]?.length ?? 0) > 0).length;
    return {
      path: location.path,
      settings: rt.settingsPath,
      mocVersion: m.version,
      canvas: {
        widthPixels: m.canvas.width,
        heightPixels: m.canvas.height,
        pixelsPerUnit: m.canvas.pixelsPerUnit,
        widthUnits: round(m.canvas.width / m.canvas.pixelsPerUnit),
        heightUnits: round(m.canvas.height / m.canvas.pixelsPerUnit),
      },
      time,
      parameterGroups: groups,
      parameters: rt.parameters.map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.group ? { group: p.group } : {}),
        min: p.min,
        max: p.max,
        default: p.default,
        value: round(rt.getParameter(p.id)),
        ...(p.blendShape ? { blendShape: true } : {}),
        ...(rt.physicsDriven.has(p.id) ? { drivenByPhysicsFrom: rt.physicsDriven.get(p.id) } : {}),
        ...(rt.physicsInputs.has(p.id)
          ? {
              physicsInputs: rt.physicsInputs
                .get(p.id)!
                .map((i) => ({ id: i.id, weight: round(i.weight) })),
            }
          : {}),
      })),
      parts: rt.parts.map((p) => ({
        id: p.id,
        name: p.name,
        opacity: round(rt.getPartOpacity(p.id)),
        default: p.defaultOpacity,
      })),
      drawables: { count: m.meshes.ids.length, masked },
      deformers: {
        warps: rt.deformers.filter((d) => d.kind === "warp").length,
        rotations: rt.deformers.filter((d) => d.kind === "rotation").length,
      },
      expressions: {
        named: rt.expressionNames,
        files: filesOf("expression"),
      },
      motions: {
        groups: rt.settings.motions.map((g) => ({
          name: g.group,
          motions: g.entries.map((e) => e.file),
        })),
        files: filesOf("motion"),
      },
      physics: rt.animator.physics
        ? {
            present: true,
            settings: rt.animator.physics.file.settings.length,
            // Parameters physics overwrites: set one of their physicsInputs instead.
            overwrites: rt.physicsInputs.size,
            // Simulation steps per second (0: one per frame).
            rate: rt.physicsRate,
            look: rt.lookRouting(),
          }
        : { present: false },
      pose: rt.animator.pose !== null,
      eyeBlink: rt.animator.eyeBlink !== null,
      lipSync: rt.animator.lipSync !== null,
      // Motion sync: the mouth from a sound through a setting (Mochi2D's own, approximate analysis).
      motionSync: { settings: rt.motionSyncSettings, playing: motionSyncState(rt) },
      hitAreas: rt.hitAreas,
      effects: Object.fromEntries(
        EFFECTS.filter((e) => rt.effectAvailable(e)).map((e) => [e, rt.effect(e)]),
      ),
      playing: { motions: rt.playingMotions, expressions: expressionsPlaying(rt) },
      warnings: rt.warnings,
    };
  }

  // ----------------------------------------------------------- parameters

  /** Current parameter values (all, or the given IDs). */
  getParameters(ids?: readonly string[]): { parameters: ParameterValue[]; unknown: string[] } {
    const rt = this.model.runtime;
    const known = new Map(rt.parameters.map((p) => [p.id, p]));
    const wanted = ids?.length ? ids : rt.parameters.map((p) => p.id);
    const out: ParameterValue[] = [];
    const unknown: string[] = [];
    for (const id of wanted) {
      const p = known.get(id);
      if (!p) unknown.push(id);
      else
        out.push({
          id,
          name: p.name,
          value: round(rt.getParameter(id)),
          base: round(rt.getParameterBase(id)),
          min: p.min,
          max: p.max,
          default: p.default,
        });
    }
    return { parameters: out, unknown };
  }

  /**
   * Sets parameters' base values (limited to their ranges); motions, physics
   * and other effects still apply on top. Evaluates the model.
   */
  setParameters(values: Record<string, number>): {
    parameters: ParameterValue[];
    unknown: string[];
    physicsOverwrites?: { id: string; setInstead: string[] }[];
  } {
    const rt = this.model.runtime;
    const unknown: string[] = [];
    for (const [id, v] of Object.entries(values)) {
      if (typeof v !== "number" || !Number.isFinite(v))
        throw new Error(`The value of ${id} must be a finite number.`);
      if (!rt.setParameter(id, v)) unknown.push(id);
    }
    rt.update(0);
    const set = Object.keys(values).filter((id) => !unknown.includes(id));
    // While physics runs, it overwrites these: say which inputs to set instead.
    const overwritten = rt.effect("physics")
      ? set
          .filter((id) => rt.physicsInputs.has(id))
          .map((id) => ({ id, setInstead: rt.physicsInputs.get(id)!.map((i) => i.id) }))
      : [];
    return {
      parameters: this.getParameters(set).parameters,
      unknown,
      ...(overwritten.length ? { physicsOverwrites: overwritten } : {}),
    };
  }

  /** Current part opacities (all, or the given IDs). */
  getPartOpacities(ids?: readonly string[]): {
    parts: { id: string; name: string; opacity: number; default: number }[];
    unknown: string[];
  } {
    const rt = this.model.runtime;
    const known = new Map(rt.parts.map((p) => [p.id, p]));
    const wanted = ids?.length ? ids : rt.parts.map((p) => p.id);
    const parts: { id: string; name: string; opacity: number; default: number }[] = [];
    const unknown: string[] = [];
    for (const id of wanted) {
      const p = known.get(id);
      if (!p) unknown.push(id);
      else
        parts.push({
          id,
          name: p.name,
          opacity: round(rt.getPartOpacity(id)),
          default: p.defaultOpacity,
        });
    }
    return { parts, unknown };
  }

  /** Sets part opacities (0–1). Evaluates the model. */
  setPartOpacities(values: Record<string, number>): ReturnType<AgentSession["getPartOpacities"]> {
    const rt = this.model.runtime;
    const known = new Set(rt.parts.map((p) => p.id));
    const unknown: string[] = [];
    for (const [id, v] of Object.entries(values)) {
      if (typeof v !== "number" || !Number.isFinite(v))
        throw new Error(`The opacity of ${id} must be a finite number.`);
      if (!known.has(id)) unknown.push(id);
      else rt.setPartOpacity(id, Math.min(1, Math.max(0, v)));
    }
    rt.update(0);
    const set = Object.keys(values).filter((id) => !unknown.includes(id));
    return { parts: this.getPartOpacities(set).parts, unknown };
  }

  // ------------------------------------------------- expressions, motions

  /** Starts an expression by its settings name or its file path; null fades the current one out. */
  /**
   * Starts an expression (`replace`, the default: it replaces the current
   * one), adds one on top of the others (`add`), or fades an added one out
   * (`remove`; null removes all). null with `replace` fades the current one out.
   */
  async playExpression(
    expression: string | null,
    mode: "replace" | "add" | "remove" = "replace",
  ): Promise<Record<string, unknown>> {
    const rt = this.model.runtime;
    let changed = true;
    if (mode === "add") {
      if (expression === null) throw new Error('Give the expression to add (mode "add").');
      changed = await rt.addExpression(expression);
    } else if (mode === "remove") changed = rt.removeExpression(expression ?? undefined);
    else if (expression === null) rt.clearExpression();
    else await rt.setExpression(expression);
    rt.update(0);
    return {
      playing: expressionsPlaying(rt),
      added: rt.addedExpressions,
      ...(mode !== "replace" ? { changed } : {}),
    };
  }

  /**
   * Starts a motion: `group` with `index` (random when omitted) from the
   * settings, or `file` by path. Returns whether it started (a motion of
   * higher priority can refuse it).
   */
  async playMotion(req: {
    group?: string;
    index?: number;
    file?: string;
    priority?: 1 | 2 | 3;
    loop?: boolean;
    hold?: boolean;
    blinkWhileHeld?: boolean;
  }): Promise<Record<string, unknown>> {
    const rt = this.model.runtime;
    const options = {
      ...(req.priority !== undefined ? { priority: req.priority } : {}),
      ...(req.loop !== undefined ? { loop: req.loop } : {}),
      ...(req.hold ? { hold: true } : {}),
      ...(req.blinkWhileHeld === false ? { blinkWhileHeld: false } : {}),
    };
    let started: boolean;
    if (req.file) started = (await rt.startMotionFile(req.file, options)) !== false;
    else if (req.group !== undefined) {
      if (!rt.motionGroups.some((g) => g.name === req.group))
        throw new Error(
          `The settings have no motion group "${req.group}"` +
            (rt.motionGroups.length
              ? ` (they have ${rt.motionGroups.map((g) => g.name).join(", ")}).`
              : "; play a motion file instead."),
        );
      started = (await rt.startMotion(req.group, req.index, options)) !== false;
    } else throw new Error("Give a motion group (and index) or a motion file.");
    rt.update(0);
    const sync = motionSyncState(rt);
    return { started, playing: rt.playingMotions, ...(sync ? { motionSync: sync } : {}) };
  }

  /**
   * Plays a WAV file (relative to the settings file) through motion sync:
   * the mouth follows it as time advances. Nothing is played aloud.
   */
  async playSound(req: { file: string; setting?: string }): Promise<Record<string, unknown>> {
    const rt = this.model.runtime;
    if (!rt.motionSyncSettings.some((s) => s.usable))
      throw new Error(
        "The model has no motion-sync setting to run: its settings name no .motionsync3.json " +
          "file (FileReferences.MotionSync), or none of the file's settings can run.",
      );
    const path = rt.resolve(req.file);
    const bytes = await rt.source.read(path);
    const started = rt.startMotionSync(
      bytes,
      req.setting !== undefined ? { setting: req.setting } : {},
    );
    rt.update(0);
    const sound = rt.motionSyncSource as {
      sampleRate: number;
      channels: ArrayLike<number>[];
    } | null;
    return {
      started,
      file: path,
      seconds: sound?.channels[0] ? round(sound.channels[0].length / sound.sampleRate) : 0,
      motionSync: motionSyncState(rt),
    };
  }

  /** Runs the animation for `seconds` at `fps` frames per second. */
  advance(seconds: number, fps = 60): Record<string, unknown> {
    const m = this.model;
    if (!(seconds >= 0) || seconds > MAX_ADVANCE_SECONDS)
      throw new Error(`seconds must be between 0 and ${MAX_ADVANCE_SECONDS}.`);
    if (!(fps >= FPS_RANGE[0] && fps <= FPS_RANGE[1]))
      throw new Error(`fps must be between ${FPS_RANGE[0]} and ${FPS_RANGE[1]}.`);
    const frames = Math.round(seconds * fps);
    const events: { time: number; value: string }[] = [];
    let ended = 0;
    let wasEmpty = m.runtime.animator.motions.empty;
    const ends: { time: number; motion: string; reason: string }[] = [];
    const stop = m.runtime.onMotionEnd((e) =>
      ends.push({ time: round(m.time), motion: e.motion, reason: e.reason }),
    );
    // Motion sync's analyses in these frames: how often each element was the strongest.
    let ticks = 0;
    const strongest: Record<string, number> = {};
    const stopTicks = m.runtime.onMotionSyncTick((t) => {
      ticks++;
      const best = (Object.keys(t.weights) as (keyof typeof t.weights)[]).reduce((a, b) =>
        t.weights[b] > t.weights[a] ? b : a,
      );
      strongest[best] = (strongest[best] ?? 0) + 1;
    });
    try {
      for (let f = 0; f < frames; f++) {
        m.time += 1 / fps;
        const r = m.runtime.update(1 / fps);
        for (const value of r?.events ?? []) events.push({ time: round(m.time), value });
        const empty = r?.queueEmpty ?? m.runtime.animator.motions.empty;
        if (empty && !wasEmpty) ended++;
        wasEmpty = empty;
      }
    } finally {
      stop();
      stopTicks();
    }
    return {
      frames,
      time: round(m.time),
      events,
      motionsEnded: ended,
      ends,
      ...(ticks > 0 || m.runtime.motionSync
        ? { motionSync: { ticks, strongest, now: motionSyncState(m.runtime) } }
        : {}),
      playing: {
        motions: m.runtime.playingMotions,
        expressions: expressionsPlaying(m.runtime),
        added: m.runtime.addedExpressions,
      },
    };
  }

  // --------------------------------------------------------------- render

  /** Renders the current pose to a PNG (headless Chromium). */
  async render(req: RenderRequest = {}): Promise<AgentRenderOutput> {
    const m = this.model;
    const rt = m.runtime;
    const size = (v: number | undefined, what: string) => {
      const n = v ?? DEFAULT_RENDER_SIZE;
      if (!Number.isInteger(n) || n < RENDER_SIZE_RANGE[0] || n > RENDER_SIZE_RANGE[1])
        throw new Error(
          `${what} must be a whole number from ${RENDER_SIZE_RANGE[0]} to ${RENDER_SIZE_RANGE[1]}.`,
        );
      return n;
    };
    const parameters: Record<string, number> = {};
    for (const p of rt.parameters) parameters[p.id] = rt.getParameter(p.id);
    const partOpacities: Record<string, number> = {};
    for (const p of rt.parts) partOpacities[p.id] = rt.getPartOpacity(p.id);
    return this.renderer.render({
      generation: m.generation,
      source: m.location.source as FileSource,
      settingsPath: rt.settingsPath,
      parameters,
      partOpacities,
      width: size(req.width, "width"),
      height: size(req.height, "height"),
      background: req.background ?? [1, 1, 1, 1],
      ...(req.view ? { view: req.view } : {}),
      ...(req.alpha ? { alpha: req.alpha } : {}),
      ...(req.maxTextureSize !== undefined
        ? { fast: { maxTextureSize: textureSize(req.maxTextureSize) } }
        : {}),
    });
  }

  // ------------------------------------------------------------- hit test

  /** The settings' hit areas and the topmost visible drawable at a point (bounding boxes). */
  hitTest(req: HitTestRequest): Record<string, unknown> {
    const rt = this.model.runtime;
    let [x, y] = [req.x, req.y];
    if (req.space === "pixels") {
      const f = frameImage(
        rt.model.canvas,
        req.width ?? DEFAULT_RENDER_SIZE,
        req.height ?? DEFAULT_RENDER_SIZE,
        req.view,
      );
      [x, y] = outputPosition(f, req.x, req.y);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be numbers.");
    return {
      model: [round(x), round(y)],
      hitAreas: rt.hitAreasAt(x, y),
      drawable: rt.drawableAt(x, y),
    };
  }

  /**
   * The forward mapping: points from a deformer's input space (or a
   * drawable's keyform space) to model units at the current pose, as the
   * evaluator maps vertices, optionally with the 2×2 Jacobian at each point.
   */
  mapPoints(req: MapPointsRequest): Record<string, unknown> {
    const rt = this.model.runtime;
    const m = rt.model;
    if ((req.deformer === undefined) === (req.drawable === undefined))
      throw new Error("Give either deformer or drawable.");
    let deformer: string | null;
    if (req.drawable !== undefined) {
      const d = m.meshes.ids.indexOf(req.drawable);
      if (d < 0) throw new Error(`No drawable "${req.drawable}".`);
      const def = m.meshes.deformer[d]!;
      deformer = def >= 0 ? m.deformers.ids[def]! : null;
    } else {
      deformer = req.deformer!;
      if (!m.deformers.ids.includes(deformer)) throw new Error(`No deformer "${deformer}".`);
    }
    if (req.points.length > MAP_POINTS_LIMIT)
      throw new Error(`At most ${MAP_POINTS_LIMIT} points per call.`);
    const flat = req.points.flat();
    if (!flat.every(Number.isFinite)) throw new Error("Points must be finite numbers.");
    const r = rt.mapPoints(deformer, flat, {
      space: req.space ?? "model",
      jacobian: req.jacobian ?? false,
    });
    // The chain from the deformer to the root.
    const chain: { id: string; kind: string }[] = [];
    for (let id = deformer; id !== null;) {
      const info = rt.deformers.find((d) => d.id === id)!;
      chain.push({ id: info.id, kind: info.kind });
      id = info.parent;
    }
    const points = req.points.map((_, i) => [round(r.points[2 * i]!), round(r.points[2 * i + 1]!)]);
    return {
      deformer,
      chain,
      space: req.space ?? "model",
      points,
      ...(r.jacobians
        ? {
            jacobians: req.points.map((_, i) =>
              Array.from(r.jacobians!.subarray(4 * i, 4 * i + 4), (v) => round(v)),
            ),
          }
        : {}),
    };
  }

  // ------------------------------------------------------------- validate

  /**
   * Validates a `.moc3` file: whether Mochi2D loads it, and why not. With
   * `strict`, draw orders outside their group's range are an error too.
   */
  async validateMoc3(path: string, strict = false): Promise<Record<string, unknown>> {
    const { path: real, bytes } = await readAllowedFile(this.roots, path);
    try {
      const model = loadMoc(bytes, { drawOrderRange: strict ? "reject" : "warn" });
      return {
        path: real,
        valid: true,
        version: model.version,
        counts: {
          parameters: model.parameters.ids.length,
          parts: model.parts.ids.length,
          drawables: model.meshes.ids.length,
        },
        warnings: model.loadWarnings,
      };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      return { path: real, valid: false, reasons: [`${err.name}: ${err.message}`] };
    }
  }

  async close(): Promise<void> {
    await this.renderer.close();
  }
}

/**
 * What motion sync plays now: the setting, and from its latest analysis the
 * level (dBFS), the element weights (Silence, A, I, U, E, O, summing to 1)
 * and the values written; null while nothing plays.
 */
function motionSyncState(rt: ModelRuntime): Record<string, unknown> | null {
  const setting = rt.animator.motionSync?.setting;
  if (!setting) return null;
  const tick = rt.motionSync;
  return {
    setting: { id: setting.id, name: setting.name },
    source: tick?.source ?? ("read" in (rt.motionSyncSource ?? {}) ? "live" : "sound"),
    ...(tick
      ? {
          time: round(tick.time),
          level: Number.isFinite(tick.level) ? round(tick.level) : null,
          silent: tick.silent,
          weights: Object.fromEntries(Object.entries(tick.weights).map(([k, v]) => [k, round(v)])),
          values: Object.fromEntries(Object.entries(tick.values).map(([k, v]) => [k, round(v)])),
        }
      : {}),
  };
}

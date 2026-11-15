/**
 * Evaluation results in the shape of the conformance result contract.
 * Every number is a float32 value; serialize with {@link formatResultJson}.
 */
import type { ModelInstance } from "../eval/instance.js";

export type Rgba = [number, number, number, number];

export interface CanvasSnapshot {
  width: number;
  height: number;
  originX: number;
  originY: number;
  pixelsPerUnit: number;
}

export interface DrawableSnapshot {
  id: string;
  visible: boolean;
  opacity: number;
  drawOrder: number;
  renderOrder: number;
  multiplyColor: Rgba;
  screenColor: Rgba;
  /** Output space, flat `[x0, y0, x1, y1, ...]`. */
  vertices: number[];
}

export interface OffscreenSnapshot {
  index: number;
  /** Owner part ID. */
  ownerPart: string;
  opacity: number;
  renderOrder: number;
  multiplyColor: Rgba;
  screenColor: Rgba;
}

export interface ModelSnapshot {
  canvas: CanvasSnapshot | Record<string, never>;
  parameters: { id: string; value: number }[];
  parts: { id: string; opacity: number }[];
  drawables: DrawableSnapshot[];
  /** v6 files only. */
  offscreens?: OffscreenSnapshot[];
}

export interface EvaluationRequest {
  parameters: Readonly<Record<string, number>>;
  partOpacities: Readonly<Record<string, number>>;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented yet: ${what}`);
    this.name = "NotImplementedError";
  }
}

const f32 = Math.fround;

/**
 * Applies a request to an instance (unknown IDs produce warnings, §Q4) and
 * resets everything else to the loaded state first.
 */
export function applyRequest(inst: ModelInstance, request: EvaluationRequest): string[] {
  const m = inst.model;
  const warnings: string[] = [];
  for (let i = 0; i < m.parameters.ids.length; i++) inst.setParameter(i, m.parameters.defaults[i]!);
  for (let i = 0; i < m.parts.ids.length; i++) inst.setPartOpacity(i, m.parts.initialOpacity[i]!);
  for (const [id, value] of Object.entries(request.parameters)) {
    const i = inst.parameterIndex(id);
    if (i < 0) warnings.push(`unknown parameter ${id}`);
    else inst.setParameter(i, value);
  }
  for (const [id, value] of Object.entries(request.partOpacities)) {
    const i = inst.partIndex(id);
    if (i < 0) warnings.push(`unknown part ${id}`);
    else inst.setPartOpacity(i, value);
  }
  return warnings;
}

/** Captures the instance's current outputs (call after `evaluate()`). */
export function snapshotInstance(inst: ModelInstance): ModelSnapshot {
  const m = inst.model;
  const rgb = (a: Float32Array, i: number): Rgba => [
    f32(a[i * 3]!),
    f32(a[i * 3 + 1]!),
    f32(a[i * 3 + 2]!),
    1,
  ];
  const snap: ModelSnapshot = {
    canvas: {
      width: f32(m.canvas.width),
      height: f32(m.canvas.height),
      originX: f32(m.canvas.originX),
      originY: f32(m.canvas.originY),
      pixelsPerUnit: f32(m.canvas.pixelsPerUnit),
    },
    parameters: m.parameters.ids.map((id, i) => ({ id, value: inst.parameterValues[i]! })),
    parts: m.parts.ids.map((id, i) => ({ id, opacity: inst.partOpacities[i]! })),
    drawables: m.meshes.ids.map((id, i) => ({
      id,
      visible: inst.drawableVisible[i] === 1,
      opacity: inst.drawableOpacity[i]!,
      drawOrder: inst.drawableDrawOrder[i]!,
      renderOrder: inst.drawableRenderOrder[i]!,
      multiplyColor: rgb(inst.drawableMultiply, i),
      screenColor: rgb(inst.drawableScreen, i),
      vertices: Array.from(inst.drawableVertices[i]!),
    })),
  };
  if (m.version >= 6) {
    snap.offscreens = Array.from(m.offscreens.part, (owner, o) => ({
      index: o,
      ownerPart: m.parts.ids[owner]!,
      opacity: inst.offscreenOpacity[o]!,
      renderOrder: inst.offscreenRenderOrder[o]!,
      multiplyColor: rgb(inst.offscreenMultiply, o),
      screenColor: rgb(inst.offscreenScreen, o),
    }));
  }
  return snap;
}

/**
 * Serializes a result: every number rounded to float32 and printed as the
 * shortest decimal that round-trips the float32-as-double (e.g. 0.6 becomes
 * 0.6000000238418579). With `numbers: "double"`, numbers are printed as the
 * shortest decimal of the double as given (for results that mix float32 and
 * double quantities, which round float32 values themselves). Non-finite
 * values become null. Objects are indented; arrays of plain values stay on one
 * line so vertex lists remain compact.
 */
export function formatResultJson(
  value: unknown,
  indent = "  ",
  numbers: "float32" | "double" = "float32",
): string {
  const write = (v: unknown, depth: number): string => {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return "null";
      const x = numbers === "float32" ? f32(v) : v;
      return Object.is(x, -0) ? "0" : JSON.stringify(x);
    }
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    const pad = indent.repeat(depth + 1);
    const end = indent.repeat(depth);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if (v.every((x) => x === null || typeof x !== "object"))
        return `[${v.map((x) => write(x, depth + 1)).join(", ")}]`;
      return `[\n${v.map((x) => pad + write(x, depth + 1)).join(",\n")}\n${end}]`;
    }
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${write(x, depth + 1)}`).join(",\n")}\n${end}}`;
  };
  return write(value, 0) + "\n";
}

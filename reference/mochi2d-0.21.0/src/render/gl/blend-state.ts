/**
 * Blend state as plain data. Factors and equations are named strings, so blend
 * configurations can be written in JSON, compared, hashed and validated, and a
 * CPU reference ({@link blendReference}) can predict what the GPU will produce.
 */
import { GlError } from "./context.js";

export const BLEND_FACTORS = [
  "zero",
  "one",
  "src-color",
  "one-minus-src-color",
  "dst-color",
  "one-minus-dst-color",
  "src-alpha",
  "one-minus-src-alpha",
  "dst-alpha",
  "one-minus-dst-alpha",
  "constant-color",
  "one-minus-constant-color",
  "constant-alpha",
  "one-minus-constant-alpha",
  "src-alpha-saturate",
] as const;
export type BlendFactor = (typeof BLEND_FACTORS)[number];

export const BLEND_OPS = ["add", "subtract", "reverse-subtract", "min", "max"] as const;
export type BlendOp = (typeof BLEND_OPS)[number];

/** result = op(src × srcFactor, dst × dstFactor); `min`/`max` ignore the factors. */
export interface BlendEquation {
  src: BlendFactor;
  dst: BlendFactor;
  op: BlendOp;
}

export type Rgba = [number, number, number, number];

export interface BlendState {
  enabled: boolean;
  color: BlendEquation;
  alpha: BlendEquation;
  /** Blend constant used by the constant-* factors. Default [0, 0, 0, 0]. */
  constant?: Rgba;
  /** Which channels are written. Default all. */
  writeMask?: [boolean, boolean, boolean, boolean];
}

const REPLACE: BlendEquation = { src: "one", dst: "zero", op: "add" };

/** Blending off: the fragment replaces the destination. */
export const BLEND_DISABLED: Readonly<BlendState> = {
  enabled: false,
  color: REPLACE,
  alpha: REPLACE,
};

/** Porter-Duff "source over" for premultiplied colors. */
export const BLEND_PREMULTIPLIED_OVER: Readonly<BlendState> = {
  enabled: true,
  color: { src: "one", dst: "one-minus-src-alpha", op: "add" },
  alpha: { src: "one", dst: "one-minus-src-alpha", op: "add" },
};

function glFactor(gl: WebGL2RenderingContext, f: BlendFactor): number {
  switch (f) {
    case "zero":
      return gl.ZERO;
    case "one":
      return gl.ONE;
    case "src-color":
      return gl.SRC_COLOR;
    case "one-minus-src-color":
      return gl.ONE_MINUS_SRC_COLOR;
    case "dst-color":
      return gl.DST_COLOR;
    case "one-minus-dst-color":
      return gl.ONE_MINUS_DST_COLOR;
    case "src-alpha":
      return gl.SRC_ALPHA;
    case "one-minus-src-alpha":
      return gl.ONE_MINUS_SRC_ALPHA;
    case "dst-alpha":
      return gl.DST_ALPHA;
    case "one-minus-dst-alpha":
      return gl.ONE_MINUS_DST_ALPHA;
    case "constant-color":
      return gl.CONSTANT_COLOR;
    case "one-minus-constant-color":
      return gl.ONE_MINUS_CONSTANT_COLOR;
    case "constant-alpha":
      return gl.CONSTANT_ALPHA;
    case "one-minus-constant-alpha":
      return gl.ONE_MINUS_CONSTANT_ALPHA;
    case "src-alpha-saturate":
      return gl.SRC_ALPHA_SATURATE;
  }
}

function glOp(gl: WebGL2RenderingContext, op: BlendOp): number {
  switch (op) {
    case "add":
      return gl.FUNC_ADD;
    case "subtract":
      return gl.FUNC_SUBTRACT;
    case "reverse-subtract":
      return gl.FUNC_REVERSE_SUBTRACT;
    case "min":
      return gl.MIN;
    case "max":
      return gl.MAX;
  }
}

function parseEquation(v: unknown, where: string): BlendEquation {
  if (typeof v !== "object" || v === null) throw new GlError(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  const factor = (k: "src" | "dst"): BlendFactor => {
    if (!(BLEND_FACTORS as readonly unknown[]).includes(o[k])) {
      throw new GlError(
        `${where}.${k}: unknown blend factor ${JSON.stringify(o[k])}; expected one of ${BLEND_FACTORS.join(", ")}`,
      );
    }
    return o[k] as BlendFactor;
  };
  const op = o.op ?? "add";
  if (!(BLEND_OPS as readonly unknown[]).includes(op)) {
    throw new GlError(
      `${where}.op: unknown blend operation ${JSON.stringify(op)}; expected one of ${BLEND_OPS.join(", ")}`,
    );
  }
  return { src: factor("src"), dst: factor("dst"), op: op as BlendOp };
}

function parseTuple<T>(v: unknown, where: string, check: (x: unknown) => x is T): [T, T, T, T] {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(check))
    throw new GlError(`${where} must be an array of 4 values`);
  return v as [T, T, T, T];
}

/**
 * Validates a JSON value as a blend state. `alpha` defaults to `color`;
 * `enabled` defaults to true. Throws {@link GlError} with the offending path.
 */
export function parseBlendState(v: unknown, where = "blend"): BlendState {
  if (typeof v !== "object" || v === null) throw new GlError(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  if (o.enabled === false) return { ...BLEND_DISABLED };
  const color = parseEquation(o.color, `${where}.color`);
  const alpha = o.alpha === undefined ? color : parseEquation(o.alpha, `${where}.alpha`);
  const s: BlendState = { enabled: true, color, alpha };
  if (o.constant !== undefined) {
    s.constant = parseTuple(
      o.constant,
      `${where}.constant`,
      (x): x is number => typeof x === "number" && Number.isFinite(x),
    );
  }
  if (o.writeMask !== undefined) {
    s.writeMask = parseTuple(
      o.writeMask,
      `${where}.writeMask`,
      (x): x is boolean => typeof x === "boolean",
    );
  }
  validateBlendState(s, where);
  return s;
}

const CONSTANT_COLOR_FACTORS: readonly BlendFactor[] = [
  "constant-color",
  "one-minus-constant-color",
];
const CONSTANT_ALPHA_FACTORS: readonly BlendFactor[] = [
  "constant-alpha",
  "one-minus-constant-alpha",
];

/**
 * Throws if WebGL would reject the state: an equation may not combine a
 * constant-color factor with a constant-alpha factor.
 */
export function validateBlendState(s: BlendState, where = "blend"): void {
  if (!s.enabled) return;
  for (const [name, e] of [
    ["color", s.color],
    ["alpha", s.alpha],
  ] as const) {
    const pair = [e.src, e.dst];
    if (
      pair.some((f) => CONSTANT_COLOR_FACTORS.includes(f)) &&
      pair.some((f) => CONSTANT_ALPHA_FACTORS.includes(f))
    ) {
      throw new GlError(
        `${where}.${name}: WebGL does not allow mixing constant-color and constant-alpha factors`,
      );
    }
  }
}

/** Stable string key (equal states have equal keys). */
export function blendStateKey(s: BlendState): string {
  const m = s.writeMask ?? [true, true, true, true];
  const mask = m.map((b) => (b ? "1" : "0")).join("");
  if (!s.enabled) return `off|${mask}`;
  const eq = (e: BlendEquation) => `${e.op}(${e.src},${e.dst})`;
  return `${eq(s.color)}|${eq(s.alpha)}|${(s.constant ?? [0, 0, 0, 0]).join(",")}|${mask}`;
}

/**
 * Applies blend states, skipping GL calls whose state is already current.
 * Call {@link invalidate} after other code changed blend state behind its back.
 */
export class BlendStateCache {
  private enabled: boolean | undefined;
  private funcKey = "";
  private eqKey = "";
  private constKey = "";
  private maskKey = "";
  calls = 0;

  constructor(readonly gl: WebGL2RenderingContext) {}

  invalidate(): void {
    this.enabled = undefined;
    this.funcKey = this.eqKey = this.constKey = this.maskKey = "";
  }

  apply(s: BlendState): void {
    const gl = this.gl;
    const mask = s.writeMask ?? [true, true, true, true];
    const maskKey = mask.join();
    if (maskKey !== this.maskKey) {
      gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
      this.maskKey = maskKey;
      this.calls++;
    }
    if (s.enabled !== this.enabled) {
      if (s.enabled) gl.enable(gl.BLEND);
      else gl.disable(gl.BLEND);
      this.enabled = s.enabled;
      this.calls++;
    }
    if (!s.enabled) return;
    const funcKey = `${s.color.src},${s.color.dst},${s.alpha.src},${s.alpha.dst}`;
    if (funcKey !== this.funcKey) {
      validateBlendState(s);
      gl.blendFuncSeparate(
        glFactor(gl, s.color.src),
        glFactor(gl, s.color.dst),
        glFactor(gl, s.alpha.src),
        glFactor(gl, s.alpha.dst),
      );
      this.funcKey = funcKey;
      this.calls++;
    }
    const eqKey = `${s.color.op},${s.alpha.op}`;
    if (eqKey !== this.eqKey) {
      gl.blendEquationSeparate(glOp(gl, s.color.op), glOp(gl, s.alpha.op));
      this.eqKey = eqKey;
      this.calls++;
    }
    const c = s.constant ?? [0, 0, 0, 0];
    const constKey = c.join();
    if (constKey !== this.constKey) {
      gl.blendColor(c[0], c[1], c[2], c[3]);
      this.constKey = constKey;
      this.calls++;
    }
  }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function factorValue(f: BlendFactor, channel: number, src: Rgba, dst: Rgba, k: Rgba): number {
  switch (f) {
    case "zero":
      return 0;
    case "one":
      return 1;
    case "src-color":
      return src[channel]!;
    case "one-minus-src-color":
      return 1 - src[channel]!;
    case "dst-color":
      return dst[channel]!;
    case "one-minus-dst-color":
      return 1 - dst[channel]!;
    case "src-alpha":
      return src[3];
    case "one-minus-src-alpha":
      return 1 - src[3];
    case "dst-alpha":
      return dst[3];
    case "one-minus-dst-alpha":
      return 1 - dst[3];
    case "constant-color":
      return k[channel]!;
    case "one-minus-constant-color":
      return 1 - k[channel]!;
    case "constant-alpha":
      return k[3];
    case "one-minus-constant-alpha":
      return 1 - k[3];
    case "src-alpha-saturate":
      return channel === 3 ? 1 : Math.min(src[3], 1 - dst[3]);
  }
}

/**
 * CPU reference of fixed-function blending for one pixel, with inputs and
 * output in [0, 1] (as for a normalized RGBA8 target). Masked channels keep the
 * destination value.
 */
export function blendReference(s: BlendState, src: Rgba, dst: Rgba): Rgba {
  const mask = s.writeMask ?? [true, true, true, true];
  const k = (s.constant ?? [0, 0, 0, 0]).map(clamp01) as Rgba;
  const out: Rgba = [0, 0, 0, 0];
  for (let ch = 0; ch < 4; ch++) {
    let v: number;
    if (!s.enabled) {
      v = src[ch]!;
    } else {
      const e = ch === 3 ? s.alpha : s.color;
      const S = src[ch]!;
      const D = dst[ch]!;
      switch (e.op) {
        case "min":
          v = Math.min(S, D);
          break;
        case "max":
          v = Math.max(S, D);
          break;
        default: {
          const a = S * factorValue(e.src, ch, src, dst, k);
          const b = D * factorValue(e.dst, ch, src, dst, k);
          v = e.op === "add" ? a + b : e.op === "subtract" ? a - b : b - a;
        }
      }
    }
    out[ch] = mask[ch] ? clamp01(v) : dst[ch]!;
  }
  return out;
}

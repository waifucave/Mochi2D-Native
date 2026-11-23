/**
 * Motion files `*.motion3.json` (3c) and curve evaluation (3k).
 */
import {
  AnimationFormatError,
  arr,
  bool,
  isObject,
  num,
  obj,
  optNum,
  parseJson,
  str,
} from "./json.js";

export type CurveTarget = "Model" | "Parameter" | "PartOpacity";

/** Segment kinds (3c.3). */
export const LINEAR = 0;
export const BEZIER = 1;
export const STEPPED = 2;
export const INVERSE_STEPPED = 3;

export interface MotionCurve {
  target: CurveTarget;
  id: string;
  /** The curve's own fade times, undefined when not set (3l.3 step e). */
  fadeIn: number | undefined;
  fadeOut: number | undefined;
  /** Points as t₀, v₀, t₁, v₁, … */
  points: Float64Array;
  /** Per segment: its kind and the index of its first point. */
  kinds: Uint8Array;
  starts: Uint32Array;
}

/**
 * A motion file's values as written (experimental): what an importer needs
 * besides the resolved values of {@link Motion}, which fill in defaults.
 */
export interface MotionAsWritten {
  /** A copy of the file's `Meta` object: the keys it has, with their values as written. */
  meta: Readonly<Record<string, unknown>>;
  /**
   * Per curve, in file order (curves left out by the order rule too), its
   * `FadeInTime` and `FadeOutTime` as written; a key is absent when the curve
   * has none.
   */
  curves: readonly { fadeIn?: unknown; fadeOut?: unknown }[];
}

export interface Motion {
  label: string;
  duration: number;
  fps: number;
  restricted: boolean;
  /**
   * `Meta.Loop` (missing: false). Playback does not read it: whether a
   * motion loops is chosen when it starts (`loop` of the start options).
   */
  loop: boolean;
  /** Fade times from `Meta` (missing or negative: 1; {@link written} tells which were written). */
  fadeIn: number;
  fadeOut: number;
  /** The file's values as written (experimental). */
  written: MotionAsWritten;
  /** The curves that take effect (3c.2), in file order. */
  curves: MotionCurve[];
  /** Curves left out by the order rule of 3c.2. */
  ignoredCurves: number;
  events: { time: number; value: string }[];
}

const RANK: Record<string, number> = { Model: 0, Parameter: 1, PartOpacity: 2 };

/** Reads and validates a motion file (3c.4); throws {@link AnimationFormatError} if it is unusable. */
export function parseMotion(input: Uint8Array | string | unknown, label = "motion"): Motion {
  const json =
    typeof input === "string" || input instanceof Uint8Array ? parseJson(input, label) : input;
  if (!isObject(json)) throw new AnimationFormatError(`${label}: not a JSON object`);
  const meta = obj(json.Meta);
  const fade = (v: unknown) => {
    const x = optNum(v);
    return x === undefined || x < 0 ? 1 : x;
  };
  const rawCurves = arr(json.Curves);
  const writtenCurves: { fadeIn?: unknown; fadeOut?: unknown }[] = rawCurves.map((c) => {
    const cc = obj(c);
    return {
      ...("FadeInTime" in cc ? { fadeIn: cc.FadeInTime } : {}),
      ...("FadeOutTime" in cc ? { fadeOut: cc.FadeOutTime } : {}),
    };
  });
  let segments = 0;
  let pointCount = 0;
  const parsed: MotionCurve[] = [];
  rawCurves.forEach((c, k) => {
    const cc = obj(c);
    const s = arr(cc.Segments);
    const values: number[] = [];
    const kinds: number[] = [];
    const starts: number[] = [];
    for (const v of s) {
      if (typeof v !== "number")
        throw new AnimationFormatError(`${label}: curve ${k}: non-numeric segment data`);
    }
    const n = s as number[];
    if (n.length < 2) throw new AnimationFormatError(`${label}: curve ${k}: no first point`);
    values.push(n[0]!, n[1]!);
    let i = 2;
    while (i < n.length) {
      const code = n[i]!;
      const first = values.length / 2 - 1;
      const need = code === BEZIER ? 6 : 2;
      if (code !== LINEAR && code !== BEZIER && code !== STEPPED && code !== INVERSE_STEPPED)
        throw new AnimationFormatError(`${label}: curve ${k}: unknown segment code ${code}`);
      if (i + need > n.length - 1)
        throw new AnimationFormatError(`${label}: curve ${k}: truncated segment`);
      for (let j = 1; j <= need; j++) values.push(n[i + j]!);
      kinds.push(code);
      starts.push(first);
      i += need + 1;
    }
    segments += kinds.length;
    pointCount += values.length / 2;
    const fadeIn = optNum(cc.FadeInTime);
    const fadeOut = optNum(cc.FadeOutTime);
    parsed.push({
      target: str(cc.Target) as CurveTarget,
      id: str(cc.Id),
      fadeIn,
      fadeOut,
      points: Float64Array.from(values),
      kinds: Uint8Array.from(kinds),
      starts: Uint32Array.from(starts),
    });
  });
  const check = (key: string, actual: number) => {
    const declared = num(meta[key], 0);
    if (declared !== actual)
      throw new AnimationFormatError(
        `${label}: Meta.${key} is ${declared}, but the file has ${actual}`,
      );
  };
  check("CurveCount", rawCurves.length);
  check("TotalSegmentCount", segments);
  check("TotalPointCount", pointCount);
  // 3c.2: leading Model curves, then Parameter curves, then PartOpacity curves.
  const curves: MotionCurve[] = [];
  let rank = 0;
  for (const c of parsed) {
    const r = RANK[c.target];
    if (r === undefined || r < rank) break;
    rank = r;
    curves.push(c);
  }
  const events = arr(json.UserData).map((e) => {
    const ee = obj(e);
    return { time: num(ee.Time, 0), value: str(ee.Value) };
  });
  return {
    label,
    duration: num(meta.Duration, 0),
    fps: num(meta.Fps, 0),
    restricted: bool(meta.AreBeziersRestricted),
    loop: bool(meta.Loop),
    fadeIn: fade(meta.FadeInTime),
    fadeOut: fade(meta.FadeOutTime),
    written: {
      meta: JSON.parse(JSON.stringify(meta)) as Record<string, unknown>,
      curves: writtenCurves,
    },
    curves,
    ignoredCurves: parsed.length - curves.length,
    events,
  };
}

const EPS = 1e-5;

/** The Bézier parameter s at time τ in solved mode (3k.3). */
export function solveBezierParameter(
  t0: number,
  t1: number,
  t2: number,
  t3: number,
  tau: number,
): number {
  const a3 = t3 - 3 * t2 + 3 * t1 - t0;
  const a2 = 3 * t2 - 6 * t1 + 3 * t0;
  const a1 = 3 * t1 - 3 * t0;
  const a0 = t0 - tau;
  let s: number;
  if (Math.abs(a3) < EPS) {
    if (Math.abs(a2) < EPS) s = Math.abs(a1) < EPS ? -a0 : -a0 / a1;
    else s = -(a1 + Math.sqrt(a1 * a1 - 4 * a2 * a0)) / (2 * a2);
  } else {
    const b = a2 / a3;
    const c = a1 / a3;
    const d = a0 / a3;
    const p = (3 * c - b * b) / 3;
    const q = (2 * b * b * b - 9 * b * c + 27 * d) / 27;
    const D = (q / 2) * (q / 2) + (p / 3) * (p / 3) * (p / 3);
    const near = (x: number) => Math.abs(x - 0.5) < 0.51;
    if (D < 0) {
      const m = -p / 3;
      const r = Math.sqrt(m * m * m);
      const phi = Math.acos(Math.min(Math.max(-q / (2 * r), -1), 1));
      const k = 2 * Math.cbrt(r);
      const cand = (j: number) => k * Math.cos((phi + 2 * Math.PI * j) / 3) - b / 3;
      const s0 = cand(0);
      if (near(s0)) s = s0;
      else {
        const s1 = cand(1);
        s = near(s1) ? s1 : cand(2);
      }
    } else if (D === 0) {
      const u = Math.cbrt(-q / 2);
      const first = 2 * u - b / 3;
      s = near(first) ? first : -u - b / 3;
    } else {
      const root = Math.sqrt(D);
      s = Math.cbrt(root - q / 2) - Math.cbrt(root + q / 2) - b / 3;
    }
  }
  return Math.min(Math.max(s, 0), 1);
}

/**
 * The value of a curve at local time τ (3k). `loopLength` is the loop length L
 * of a looping motion: between the last point and L the value runs back to
 * the first point (the end interval of 3k.2).
 */
export function evaluateCurve(
  curve: MotionCurve,
  tau: number,
  restricted: boolean,
  loopLength?: number,
): number {
  const p = curve.points;
  const kinds = curve.kinds;
  const starts = curve.starts;
  for (let k = 0; k < kinds.length; k++) {
    const kind = kinds[k]!;
    const i = starts[k]!;
    const end = kind === BEZIER ? i + 3 : i + 1;
    if (!(p[2 * end]! > tau)) continue;
    const t0 = p[2 * i]!;
    const v0 = p[2 * i + 1]!;
    switch (kind) {
      case LINEAR: {
        const t1 = p[2 * end]!;
        const v1 = p[2 * end + 1]!;
        const s = Math.max(0, (tau - t0) / (t1 - t0));
        return v0 + (v1 - v0) * s;
      }
      case STEPPED:
        return v0;
      case INVERSE_STEPPED:
        return p[2 * end + 1]!;
      default: {
        const t1 = p[2 * i + 2]!;
        const v1 = p[2 * i + 3]!;
        const t2 = p[2 * i + 4]!;
        const v2 = p[2 * i + 5]!;
        const t3 = p[2 * i + 6]!;
        const v3 = p[2 * i + 7]!;
        const s = restricted
          ? Math.max(0, (tau - t0) / (t3 - t0))
          : solveBezierParameter(t0, t1, t2, t3, tau);
        const lerp = (a: number, b: number) => a + (b - a) * s;
        const q1 = lerp(v0, v1);
        const q2 = lerp(v1, v2);
        const q3 = lerp(v2, v3);
        const r1 = lerp(q1, q2);
        const r2 = lerp(q2, q3);
        return lerp(r1, r2);
      }
    }
  }
  // No segment qualifies: τ at or after the last point (3k.2).
  const last = p.length / 2 - 1;
  const tLast = p[2 * last]!;
  const vLast = p[2 * last + 1]!;
  if (loopLength !== undefined && kinds.length > 0 && tau < loopLength) {
    const vFirst = p[1]!;
    const kind = kinds[kinds.length - 1]!;
    if (kind === STEPPED) return vLast;
    if (kind === INVERSE_STEPPED) return vFirst;
    const s = Math.max(0, (tau - tLast) / (loopLength - tLast));
    return vLast + (vFirst - vLast) * s;
  }
  return vLast;
}

/**
 * Expression files `*.exp3.json` (3d) and the expression queue
 * (3m).
 */
import { AnimationFormatError, arr, isObject, num, obj, optNum, parseJson, str } from "./json.js";
import { ease } from "./motion-queue.js";
import type { AnimationValues } from "./values.js";

export type ExpressionBlend = "Add" | "Multiply" | "Overwrite";

export interface Expression {
  label: string;
  fadeIn: number;
  fadeOut: number;
  parameters: { id: string; value: number; blend: ExpressionBlend }[];
}

export function parseExpression(
  input: Uint8Array | string | unknown,
  label = "expression",
): Expression {
  const json =
    typeof input === "string" || input instanceof Uint8Array ? parseJson(input, label) : input;
  if (!isObject(json)) throw new AnimationFormatError(`${label}: not a JSON object`);
  return {
    label,
    // Any number is accepted, a negative fade-in included (3d).
    fadeIn: optNum(json.FadeInTime) ?? 1,
    fadeOut: optNum(json.FadeOutTime) ?? 1,
    parameters: arr(json.Parameters).map((p) => {
      const pp = obj(p);
      const blend = str(pp.Blend);
      return {
        id: str(pp.Id),
        value: num(pp.Value, 0),
        blend: blend === "Multiply" || blend === "Overwrite" ? blend : "Add",
      };
    }),
  };
}

interface Entry {
  expression: Expression;
  /** Contribution per tracked ID, by blend. */
  byId: Map<string, { value: number; blend: ExpressionBlend }>;
  started: boolean;
  f: number;
  e: number | null;
  fadeOutRequested: boolean;
}

interface Tracked {
  id: string;
  A: number;
  M: number;
  O: number;
}

export class ExpressionQueue {
  /** The queue clock T_x. */
  time = 0;
  private entries: Entry[] = [];
  private readonly tracked: Tracked[] = [];
  private readonly trackedIds = new Set<string>();

  get empty(): boolean {
    return this.entries.length === 0;
  }

  /** Expressions in the queue, oldest first. */
  get expressions(): Expression[] {
    return this.entries.map((e) => e.expression);
  }

  /** 3m.1: older entries are asked to fade out; the new one is appended. */
  start(expression: Expression): void {
    for (const e of this.entries) e.fadeOutRequested = true;
    const byId = new Map<string, { value: number; blend: ExpressionBlend }>();
    for (const p of expression.parameters)
      if (!byId.has(p.id)) byId.set(p.id, { value: p.value, blend: p.blend });
    this.entries.push({ expression, byId, started: false, f: 0, e: null, fadeOutRequested: false });
  }

  /** 3m.3: advances the queue by Δ and writes the tracked values. */
  advance(dt: number, values: AnimationValues): void {
    this.time += dt;
    const T = this.time;
    let S = 0;
    let newestWeight = 0;
    this.entries.forEach((en, k) => {
      // a. Track the entry's IDs.
      for (const id of en.byId.keys())
        if (!this.trackedIds.has(id)) {
          this.trackedIds.add(id);
          this.tracked.push({ id, A: 0, M: 1, O: 0 });
        }
      // b. First processing.
      if (!en.started) {
        en.started = true;
        en.f = T;
        en.e = null;
      }
      // c. Weight.
      const ex = en.expression;
      const aIn = ex.fadeIn === 0 ? 1 : ease((T - en.f) / ex.fadeIn);
      const aOut = en.e === null || ex.fadeOut === 0 ? 1 : ease((en.e - T) / ex.fadeOut);
      const w = aIn * aOut;
      newestWeight = w;
      // d. Contributions.
      for (const t of this.tracked) {
        const c = values.get(t.id);
        t.O = c;
        const p = en.byId.get(t.id);
        let a = 0;
        let m = 1;
        let o = c;
        if (p?.blend === "Add") a = p.value;
        else if (p?.blend === "Multiply") m = p.value;
        else if (p?.blend === "Overwrite") o = p.value;
        if (k === 0) {
          t.A = a;
          t.M = m;
          t.O = o;
        } else {
          t.A = t.A * (1 - w) + a * w;
          t.M = t.M * (1 - w) + m * w;
          t.O = t.O * (1 - w) + o * w;
        }
      }
      // e. Sum of fade-ins.
      S += aIn;
      // f. Fade-out request.
      if (en.fadeOutRequested) {
        const end = T + ex.fadeOut;
        if (!(en.e !== null && en.e <= end)) en.e = end;
      }
    });
    // g. A fully faded-in newest entry replaces the older ones.
    if (this.entries.length >= 2 && newestWeight >= 1)
      this.entries = this.entries.slice(this.entries.length - 1);
    // h. Write.
    S = Math.min(S, 1);
    for (const t of this.tracked) {
      values.set(t.id, (t.O + t.A) * t.M, S);
      t.A = 0;
      t.M = 1;
    }
  }
}

interface Layer {
  expression: Expression;
  byId: Map<string, { value: number; blend: ExpressionBlend }>;
  /** Start of the fade-in (layer clock), or null before the first processing. */
  f: number | null;
  /** End of the fade-out once removal was asked, or null. */
  e: number | null;
  /** The fade-out time removal uses: the expression's, or the one removal gave. */
  out: number;
}

/**
 * Expressions added on top of the expression queue, several at once (not
 * reference behavior). Each layer fades in and, when removed, out with its
 * expression's times (or the removal's), and applies the one-expression formula of 3m blended by its
 * weight w, in the order the layers were added: Add v + w·a, Multiply
 * v·(1 + w·(m − 1)), Overwrite v + w·(o − v). Nothing happens without layers.
 */
export class ExpressionLayers {
  /** The layer clock. */
  time = 0;
  private layers: Layer[] = [];

  get empty(): boolean {
    return this.layers.length === 0;
  }

  /** The layers that are not fading out, oldest first. */
  get active(): Expression[] {
    return this.layers.filter((l) => l.e === null).map((l) => l.expression);
  }

  /** Every layer, fading out ones included, oldest first. */
  get all(): Expression[] {
    return this.layers.map((l) => l.expression);
  }

  /**
   * Adds an expression (its label identifies it). Returns false, changing
   * nothing, when an active layer has the same label; one that is fading out
   * keeps fading out, and the new layer fades in.
   */
  add(expression: Expression): boolean {
    if (this.layers.some((l) => l.e === null && l.expression.label === expression.label))
      return false;
    const byId = new Map<string, { value: number; blend: ExpressionBlend }>();
    for (const p of expression.parameters)
      if (!byId.has(p.id)) byId.set(p.id, { value: p.value, blend: p.blend });
    this.layers.push({ expression, byId, f: null, e: null, out: expression.fadeOut });
    return true;
  }

  /**
   * Fades out the active layers with this label (all of them for null), over
   * `fadeOut` seconds or each expression's own; returns how many.
   */
  remove(label: string | null, fadeOut?: number): number {
    let n = 0;
    for (const l of this.layers)
      if (l.e === null && (label === null || l.expression.label === label)) {
        l.out = fadeOut ?? l.expression.fadeOut;
        // Before its first processing it has no weight to fade from.
        l.e = l.f === null ? -Infinity : this.time + l.out;
        n++;
      }
    return n;
  }

  /** Removes every layer at once. */
  clear(): void {
    this.layers = [];
  }

  /** Advances the layer clock by Δ and applies the layers. */
  advance(dt: number, values: AnimationValues): void {
    if (this.layers.length === 0) return;
    this.time += dt;
    const T = this.time;
    const kept: Layer[] = [];
    for (const l of this.layers) {
      const ex = l.expression;
      if (l.f === null) l.f = T;
      if (l.e !== null && l.e <= T) continue;
      const aIn = ex.fadeIn === 0 ? 1 : ease((T - l.f) / ex.fadeIn);
      const aOut = l.e === null || l.out === 0 ? 1 : ease((l.e - T) / l.out);
      const w = aIn * aOut;
      for (const [id, p] of l.byId) {
        const v = values.get(id);
        if (p.blend === "Add") values.set(id, v + w * p.value);
        else if (p.blend === "Multiply") values.set(id, v * (1 + w * (p.value - 1)));
        else values.set(id, v + w * (p.value - v));
      }
      kept.push(l);
    }
    this.layers = kept;
  }
}

/**
 * The judge (4l and 4m): compares a reference
 * (official) result with a candidate result for each scenario kind, in the
 * order of checks of 4m (error state, exact structural checks, exact values,
 * toleranced values), reports the first failing check and the largest
 * difference of every toleranced quantity with its location, and collects
 * advisories, which never fail a scenario.
 */
import { measureImages, RENDER_EXPECTED, RENDER_LIMITS, type Rgba8 } from "./image-compare.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => (typeof v === "number" ? v : NaN);

/** Tolerances of 4l (single level). */
export const LIMITS = {
  vertex: 2e-5,
  vertexAdvisory: 1e-5,
  value: 1e-5,
  time: 1e-9,
  anim: 1e-6,
  animAdvisory: 1e-7,
  hitMargin: 1e-3,
} as const;

export type Kind = "static" | "sequence" | "render" | "animation";

/** Stages of 4m, step 2. */
const STAGES = ["error state", "structure", "exact values", "toleranced values"] as const;
type Stage = 0 | 1 | 2 | 3;

export interface Largest {
  /** The toleranced quantity, e.g. "vertices" or "RMS". */
  quantity: string;
  value: number;
  limit: number;
  /** Where the largest difference occurs. */
  where: string;
}

export interface ScenarioVerdict {
  id: string;
  kind: Kind;
  group: string;
  pass: boolean;
  /** The first failing check (by stage, then in check order), or null. */
  firstFailure: string | null;
  /** Every failing check, in order. */
  failures: string[];
  /** Largest difference of every toleranced quantity. */
  largest: Largest[];
  advisories: string[];
}

class Ctx {
  readonly failures: { stage: Stage; text: string }[] = [];
  readonly largest = new Map<string, Largest>();
  readonly advisories: string[] = [];
  fail(stage: Stage, check: string, detail: string): void {
    this.failures.push({ stage, text: `${STAGES[stage]}: ${check} — ${detail}` });
  }
  /** Records a toleranced difference; fails when it is above the limit. */
  diff(quantity: string, value: number, limit: number, where: string): void {
    const v = Number.isNaN(value) ? Infinity : value;
    const cur = this.largest.get(quantity);
    if (!cur || v > cur.value) this.largest.set(quantity, { quantity, value: v, limit, where });
  }
  finish(id: string, kind: Kind, group: string): ScenarioVerdict {
    for (const l of this.largest.values())
      if (!(l.value <= l.limit))
        this.fail(3, l.quantity, `${fmt(l.value)} > ${fmt(l.limit)} at ${l.where}`);
    const ordered = [...this.failures].sort((a, b) => a.stage - b.stage);
    return {
      id,
      kind,
      group,
      pass: ordered.length === 0,
      firstFailure: ordered[0]?.text ?? null,
      failures: ordered.map((f) => f.text),
      largest: [...this.largest.values()],
      advisories: this.advisories,
    };
  }
}

export function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return "0";
  const a = Math.abs(x);
  return a >= 1e-3 && a < 1e5 ? String(Number(x.toPrecision(4))) : x.toExponential(2);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function errorState(ctx: Ctx, ref: Obj, cand: Obj, byKind: string[]): "continue" | "stop" {
  const re = ref.error ?? null;
  const ce = cand.error ?? null;
  if ((re === null) !== (ce === null)) {
    ctx.fail(
      0,
      "error",
      `reference ${re === null ? "succeeded" : "failed"}, candidate ${ce === null ? "succeeded" : `failed (${(ce as Obj).kind}: ${(ce as Obj).message})`}`,
    );
    return "stop";
  }
  if (re === null) return "continue";
  const rk = String((re as Obj).kind);
  const ck = String((ce as Obj).kind);
  if ((byKind.includes(rk) || byKind.includes(ck)) && rk !== ck) {
    ctx.fail(0, "error kind", `reference ${rk}, candidate ${ck}`);
    return "stop";
  }
  return byKind.includes(rk) ? "continue" : "stop";
}

// --- Static results and sequences (4l.1) ---

const ids = (list: unknown[]) => list.map((x) => (isObj(x) ? String(x.id ?? x.index) : "?"));

function listsEqual(ctx: Ctx, what: string, a: string[], b: string[], where: string): boolean {
  if (a.length === b.length && a.every((x, i) => x === b[i])) return true;
  const i = a.findIndex((x, k) => x !== b[k]);
  ctx.fail(
    1,
    `${what} IDs`,
    `${where}${a.length} vs ${b.length} entries${i >= 0 ? `, first difference at ${i} (${a[i]} vs ${b[i]})` : ""}`,
  );
  return false;
}

/** The static rules of 4l.1 on one state (a static result, a sequence step or an animation frame's drawables). */
function compareState(ctx: Ctx, ref: Obj, cand: Obj, where: string, strict: { c10: number }): void {
  const at = where ? `${where}, ` : "";
  // Structure.
  let ok = true;
  const rp = arr(ref.parameters);
  const cp = arr(cand.parameters);
  const rparts = arr(ref.parts);
  const cparts = arr(cand.parts);
  const rd = arr(ref.drawables);
  const cd = arr(cand.drawables);
  const ro = arr(ref.offscreens);
  const co = arr(cand.offscreens);
  if (ref.parameters !== undefined || cand.parameters !== undefined)
    ok = listsEqual(ctx, "parameter", ids(rp), ids(cp), at) && ok;
  if (ref.parts !== undefined || cand.parts !== undefined)
    ok = listsEqual(ctx, "part", ids(rparts), ids(cparts), at) && ok;
  ok = listsEqual(ctx, "drawable", ids(rd), ids(cd), at) && ok;
  if (
    ro.length !== co.length ||
    (ref.offscreens === undefined) !== (cand.offscreens === undefined)
  ) {
    ctx.fail(1, "offscreen list", `${at}${ro.length} vs ${co.length} offscreens`);
    ok = false;
  }
  for (let i = 0; ok && i < rd.length; i++) {
    const a = arr((rd[i] as Obj).vertices);
    const b = arr((cd[i] as Obj).vertices);
    if (a.length !== b.length) {
      ctx.fail(1, "vertex count", `${at}${(rd[i] as Obj).id}: ${a.length / 2} vs ${b.length / 2}`);
      ok = false;
    }
  }
  if (!ok) return;
  // Exact values.
  rp.forEach((p, i) => {
    const a = num((p as Obj).value);
    const b = num((cp[i] as Obj).value);
    if (Math.fround(a) !== Math.fround(b))
      ctx.fail(2, "parameter value", `${at}${(p as Obj).id}: ${a} vs ${b}`);
  });
  rparts.forEach((p, i) => {
    const a = num((p as Obj).opacity);
    const b = num((cparts[i] as Obj).opacity);
    if (Math.fround(a) !== Math.fround(b))
      ctx.fail(2, "part opacity", `${at}${(p as Obj).id}: ${a} vs ${b}`);
  });
  ro.forEach((o, i) => {
    const a = o as Obj;
    const b = co[i] as Obj;
    if (a.ownerPart !== b.ownerPart)
      ctx.fail(2, "offscreen ownerPart", `${at}offscreen ${i}: ${a.ownerPart} vs ${b.ownerPart}`);
    if (num(a.renderOrder) !== num(b.renderOrder))
      ctx.fail(
        2,
        "offscreen renderOrder",
        `${at}offscreen ${i}: ${a.renderOrder} vs ${b.renderOrder}`,
      );
  });
  for (let i = 0; i < rd.length; i++) {
    const a = rd[i] as Obj;
    const b = cd[i] as Obj;
    if (a.visible !== b.visible)
      ctx.fail(2, "visible", `${at}${a.id}: ${a.visible} vs ${b.visible}`);
    if (num(a.renderOrder) !== num(b.renderOrder))
      ctx.fail(2, "renderOrder", `${at}${a.id}: ${a.renderOrder} vs ${b.renderOrder}`);
    if (a.visible === true && num(a.drawOrder) !== num(b.drawOrder))
      ctx.fail(2, "drawOrder", `${at}${a.id}: ${a.drawOrder} vs ${b.drawOrder}`);
  }
  // Toleranced values.
  let vMax = -1;
  let vWhere = "";
  for (let i = 0; i < rd.length; i++) {
    const a = rd[i] as Obj;
    const b = cd[i] as Obj;
    const va = arr(a.vertices);
    const vb = arr(b.vertices);
    for (let k = 0; k < va.length; k++) {
      const d = Math.abs(num(va[k]) - num(vb[k]));
      const dd = Number.isNaN(d) ? Infinity : d;
      if (dd > vMax) {
        vMax = dd;
        vWhere = `${at}${a.id} vertex ${k >> 1} ${k & 1 ? "y" : "x"}`;
      }
    }
    const visible = a.visible === true;
    const valueDiffs: [string, number][] = [["opacity", Math.abs(num(a.opacity) - num(b.opacity))]];
    for (const key of ["multiplyColor", "screenColor"])
      arr(a[key]).forEach((x, c) =>
        valueDiffs.push([`${key}[${c}]`, Math.abs(num(x) - num(arr(b[key])[c]))]),
      );
    if (visible) {
      for (const [what, d] of valueDiffs)
        ctx.diff(
          what.startsWith("opacity") ? "opacity" : "colors",
          d,
          LIMITS.value,
          `${at}${a.id} ${what}`,
        );
    } else {
      // The optional strict check of C10 (an advisory).
      const bad =
        num(a.drawOrder) !== num(b.drawOrder) || valueDiffs.some(([, d]) => !(d <= LIMITS.value));
      if (bad) strict.c10++;
    }
  }
  if (vMax >= 0) {
    ctx.diff("vertices", vMax, LIMITS.vertex, vWhere);
    if (vMax > LIMITS.vertexAdvisory && vMax <= LIMITS.vertex)
      ctx.advisories.push(`vertex difference ${fmt(vMax)} above 1e-5 at ${vWhere}`);
  }
  ro.forEach((o, i) => {
    const a = o as Obj;
    const b = co[i] as Obj;
    ctx.diff(
      "offscreen values",
      Math.abs(num(a.opacity) - num(b.opacity)),
      LIMITS.value,
      `${at}offscreen ${i} opacity`,
    );
    for (const key of ["multiplyColor", "screenColor"])
      arr(a[key]).forEach((x, c) =>
        ctx.diff(
          "offscreen values",
          Math.abs(num(x) - num(arr(b[key])[c])),
          LIMITS.value,
          `${at}offscreen ${i} ${key}[${c}]`,
        ),
      );
  });
}

export function judgeStatic(id: string, group: string, ref: Obj, cand: Obj): ScenarioVerdict {
  const ctx = new Ctx();
  if (errorState(ctx, ref, cand, []) === "continue") {
    if (!sameJson(ref.canvas, cand.canvas))
      ctx.fail(1, "canvas", `${JSON.stringify(ref.canvas)} vs ${JSON.stringify(cand.canvas)}`);
    const strict = { c10: 0 };
    compareState(ctx, ref, cand, "", strict);
    if (strict.c10)
      ctx.advisories.push(`strict check C10: ${strict.c10} non-visible drawable(s) differ`);
  }
  return ctx.finish(id, "static", group);
}

/**
 * A validation case (P8), scored against P8's Required column (C27):
 * the candidate must reject exactly when a rejection is required. The
 * official-level verdict is not compared (only noted when it is known).
 */
export function judgeValidation(
  id: string,
  group: string,
  cand: Obj,
  verdicts: { official?: string; required: string },
  ref?: Obj,
): ScenarioVerdict {
  const ctx = new Ctx();
  const rejected = (cand.error ?? null) !== null;
  if (rejected !== (verdicts.required === "reject"))
    ctx.fail(
      0,
      "validation",
      `P8 requires "${verdicts.required}", the candidate ${rejected ? `rejects (${String((cand.error as Obj).kind)}: ${String((cand.error as Obj).message)})` : "accepts"}`,
    );
  const official = ref ? ((ref.error ?? null) !== null ? "reject" : "accept") : undefined;
  if (official !== undefined && verdicts.official !== undefined && official !== verdicts.official)
    ctx.advisories.push(
      `the reference ${official}s this case, where P8's Official column says "${verdicts.official}"`,
    );
  return ctx.finish(id, "static", group);
}

export function judgeSequence(id: string, group: string, ref: Obj, cand: Obj): ScenarioVerdict {
  const ctx = new Ctx();
  if (errorState(ctx, ref, cand, []) === "continue") {
    if (!sameJson(ref.canvas, cand.canvas))
      ctx.fail(1, "canvas", `${JSON.stringify(ref.canvas)} vs ${JSON.stringify(cand.canvas)}`);
    const rs = arr(ref.steps);
    const cs = arr(cand.steps);
    if (rs.length !== cs.length) ctx.fail(1, "step count", `${rs.length} vs ${cs.length}`);
    else {
      const strict = { c10: 0 };
      rs.forEach((s, k) =>
        compareState(
          ctx,
          s as Obj,
          cs[k] as Obj,
          `step ${k} (${String((s as Obj).label)})`,
          strict,
        ),
      );
      if (strict.c10)
        ctx.advisories.push(`strict check C10: ${strict.c10} non-visible drawable state(s) differ`);
    }
  }
  return ctx.finish(id, "sequence", group);
}

// --- Renders (4h, 4l.2) ---

export interface RenderSide {
  status: Obj;
  /** The decoded PNG, or null when there is none. */
  image: Rgba8 | null;
}

export function judgeRender(
  id: string,
  group: string,
  ref: RenderSide,
  cand: RenderSide,
): ScenarioVerdict {
  const ctx = new Ctx();
  if (
    errorState(ctx, ref.status, cand.status, ["TextureTooLarge"]) === "continue" &&
    ref.status.error == null
  ) {
    if (cand.status.alpha !== undefined && cand.status.alpha !== "premultiplied")
      ctx.fail(
        1,
        "alpha",
        `candidate PNG is ${String(cand.status.alpha)}, conformance PNGs are premultiplied`,
      );
    if (!ref.image || !cand.image)
      ctx.fail(1, "PNG", `${ref.image ? "candidate" : "reference"} PNG is missing`);
    else if (ref.image.width !== cand.image.width || ref.image.height !== cand.image.height)
      ctx.fail(
        1,
        "size",
        `${ref.image.width}×${ref.image.height} vs ${cand.image.width}×${cand.image.height}`,
      );
    else {
      const m = measureImages(ref.image, cand.image);
      const where = `max d ${m.maxD} at pixel (${m.maxAt[0]}, ${m.maxAt[1]})`;
      ctx.diff("RMS", m.rms, RENDER_LIMITS.rms, where);
      ctx.diff("F4", m.f4, RENDER_LIMITS.f4, where);
      ctx.diff("F8", m.f8, RENDER_LIMITS.f8, where);
      ctx.diff("N16", m.n16, RENDER_LIMITS.n16(m.width, m.height), where);
      if (m.rms >= RENDER_EXPECTED.rms || m.n8 > RENDER_EXPECTED.n8)
        ctx.advisories.push(
          `above the expected values: RMS ${fmt(m.rms)}, ${m.n8} pixel(s) with d > 8`,
        );
    }
  }
  return ctx.finish(id, "render", group);
}

// --- Animation results (4l.3, 4l.4) ---

/** Decides whether a hit-test point is decidable against the reference box (4l.4). */
export function decidable(
  box: unknown,
  x: number,
  y: number,
  mu: number = LIMITS.hitMargin,
): boolean {
  if (!Array.isArray(box)) return true; // an unknown drawable: always a decidable miss
  const [x0, x1, y0, y1] = box as number[];
  const inside = x0! + mu <= x && x <= x1! - mu && y0! + mu <= y && y <= y1! - mu;
  const outside = x < x0! - mu || x > x1! + mu || y < y0! - mu || y > y1! + mu;
  return inside || outside;
}

export function judgeAnimation(
  id: string,
  group: string,
  ref: Obj,
  cand: Obj,
  /** Range R (maximum − minimum) of each parameter ID in the model file. */
  range: (parameterId: string) => number,
): ScenarioVerdict {
  const ctx = new Ctx();
  if (errorState(ctx, ref, cand, ["RandomExhausted"]) === "stop")
    return ctx.finish(id, "animation", group);
  const rIds = isObj(ref.ids) ? ref.ids : {};
  const cIds = isObj(cand.ids) ? cand.ids : {};
  for (const key of ["parameters", "parts", "free"])
    if (!sameJson(rIds[key], cIds[key]))
      ctx.fail(
        1,
        `ids.${key}`,
        `${JSON.stringify(rIds[key])} vs ${JSON.stringify(cIds[key])}`.slice(0, 300),
      );
  const rf = arr(ref.frames) as Obj[];
  const cf = arr(cand.frames) as Obj[];
  const rNums = rf.map((f) => f.frame);
  const cNums = cf.map((f) => f.frame);
  if (!sameJson(rNums, cNums))
    ctx.fail(1, "recorded frames", `${rNums.length} vs ${cNums.length} frames`);
  if (ctx.failures.length) return ctx.finish(id, "animation", group);
  // Exact values.
  if (!sameJson(ref.starts, cand.starts))
    ctx.fail(
      2,
      "starts",
      `${JSON.stringify(ref.starts)} vs ${JSON.stringify(cand.starts)}`.slice(0, 400),
    );
  if (ref.randomUsed !== cand.randomUsed)
    ctx.fail(2, "randomUsed", `${ref.randomUsed} vs ${cand.randomUsed}`);
  const paramIds = arr(rIds.parameters).map(String);
  const partIds = arr(rIds.parts).map(String);
  const freeIds = arr(rIds.free).map(String);
  const R = paramIds.map((p) => Math.max(1, range(p)));
  let undecidable = 0;
  let paramAdvisory = { value: 0, where: "" };
  const strict = { c10: 0 };
  rf.forEach((a, k) => {
    const b = cf[k]!;
    const at = `frame ${a.frame}`;
    for (const key of ["motionAdvanced", "queueEmpty"])
      if (a[key] !== b[key]) ctx.fail(2, key, `${at}: ${a[key]} vs ${b[key]}`);
    if (!sameJson(a.events, b.events))
      ctx.fail(2, "events", `${at}: ${JSON.stringify(a.events)} vs ${JSON.stringify(b.events)}`);
    // Hits: exact where decidable.
    const rh = arr(a.hits) as Obj[];
    const ch = arr(b.hits) as Obj[];
    if (rh.length !== ch.length) ctx.fail(1, "hits", `${at}: ${rh.length} vs ${ch.length} tests`);
    else
      rh.forEach((h, i) => {
        const c = ch[i]!;
        if (h.drawable !== c.drawable || h.x !== c.x || h.y !== c.y) {
          ctx.fail(
            1,
            "hits",
            `${at}: test ${i} is ${h.drawable} (${h.x}, ${h.y}) vs ${c.drawable} (${c.x}, ${c.y})`,
          );
          return;
        }
        if (!decidable(h.box, num(h.x), num(h.y))) {
          undecidable++;
          return;
        }
        if (h.hit !== c.hit)
          ctx.fail(2, "hit", `${at}: ${h.drawable} at (${h.x}, ${h.y}): ${h.hit} vs ${c.hit}`);
      });
    // Toleranced values.
    ctx.diff("time", Math.abs(num(a.time) - num(b.time)), LIMITS.time, at);
    const rp = arr(a.parameters);
    const cp = arr(b.parameters);
    rp.forEach((x, i) => {
      const y = cp[i];
      if ((x === null) !== (y === null)) {
        ctx.fail(2, "parameter null", `${at} ${paramIds[i]}: ${x} vs ${y}`);
        return;
      }
      if (x === null) return;
      const d = Math.abs(num(x) - num(y)) / R[i]!;
      ctx.diff("parameters (relative to max(1, R))", d, LIMITS.anim, `${at} ${paramIds[i]}`);
      if (d > paramAdvisory.value) paramAdvisory = { value: d, where: `${at} ${paramIds[i]}` };
    });
    arr(a.parts).forEach((x, i) => {
      const y = arr(b.parts)[i];
      if ((x === null) !== (y === null))
        ctx.fail(2, "part null", `${at} ${partIds[i]}: ${x} vs ${y}`);
      else if (x !== null)
        ctx.diff("parts", Math.abs(num(x) - num(y)), LIMITS.anim, `${at} ${partIds[i]}`);
    });
    ctx.diff("modelOpacity", Math.abs(num(a.modelOpacity) - num(b.modelOpacity)), LIMITS.anim, at);
    arr(a.free).forEach((x, i) => {
      const y = arr(b.free)[i];
      if ((x === null) !== (y === null))
        ctx.fail(2, "free value null", `${at} ${freeIds[i]}: ${x} vs ${y}`);
      else if (x !== null)
        ctx.diff(
          "free values (relative to max(1, |ref|))",
          Math.abs(num(x) - num(y)) / Math.max(1, Math.abs(num(x))),
          LIMITS.anim,
          `${at} ${freeIds[i]}`,
        );
    });
    if ((a.lipsync === null) !== (b.lipsync === null))
      ctx.fail(2, "lipsync null", `${at}: ${a.lipsync} vs ${b.lipsync}`);
    else if (a.lipsync !== null && a.lipsync !== undefined)
      ctx.diff("lipsync", Math.abs(num(a.lipsync) - num(b.lipsync)), LIMITS.anim, at);
    if (a.drawables !== undefined || b.drawables !== undefined)
      compareState(ctx, { drawables: a.drawables }, { drawables: b.drawables }, at, strict);
  });
  if (paramAdvisory.value > LIMITS.animAdvisory && paramAdvisory.value <= LIMITS.anim)
    ctx.advisories.push(
      `parameter difference ${fmt(paramAdvisory.value)}·max(1, R) above 1e-7 at ${paramAdvisory.where}`,
    );
  if (undecidable) ctx.advisories.push(`${undecidable} undecidable hit test(s) not scored (4l.4)`);
  if (strict.c10)
    ctx.advisories.push(`strict check C10: ${strict.c10} non-visible drawable record(s) differ`);
  return ctx.finish(id, "animation", group);
}

// --- Rounds (4m) ---

export interface GroupVerdict {
  kind: Kind | "unknown";
  group: string;
  scenarios: number;
  passed: number;
  failed: number;
  advisories: number;
  largest: Largest[];
}

export interface JudgeReport {
  format: "mochi2d-judge/0";
  reference: string;
  candidate: string;
  passed: number;
  failed: number;
  scenarios: ScenarioVerdict[];
  groups: GroupVerdict[];
}

/** A scenario with no result on one side (4m, step 1). */
export function missingVerdict(
  id: string,
  kind: Kind,
  group: string,
  side: string,
): ScenarioVerdict {
  const text = `pairing: no ${side} result`;
  return {
    id,
    kind,
    group,
    pass: false,
    firstFailure: text,
    failures: [text],
    largest: [],
    advisories: [],
  };
}

export function summarize(
  reference: string,
  candidate: string,
  verdicts: ScenarioVerdict[],
): JudgeReport {
  const groups = new Map<string, GroupVerdict>();
  for (const v of verdicts) {
    const key = `${v.kind}/${v.group}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        kind: v.kind,
        group: v.group,
        scenarios: 0,
        passed: 0,
        failed: 0,
        advisories: 0,
        largest: [],
      };
      groups.set(key, g);
    }
    g.scenarios++;
    if (v.pass) g.passed++;
    else g.failed++;
    if (v.advisories.length) g.advisories++;
    for (const l of v.largest) {
      const cur = g.largest.find((x) => x.quantity === l.quantity);
      if (!cur) g.largest.push({ ...l, where: `${v.id}: ${l.where}` });
      else if (l.value > cur.value) Object.assign(cur, { ...l, where: `${v.id}: ${l.where}` });
    }
  }
  return {
    format: "mochi2d-judge/0",
    reference,
    candidate,
    passed: verdicts.filter((v) => v.pass).length,
    failed: verdicts.filter((v) => !v.pass).length,
    scenarios: verdicts,
    groups: [...groups.values()],
  };
}

export function formatJudgeReport(r: JudgeReport, opts: { all?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Judge (4l/4m): reference ${r.reference}, candidate ${r.candidate}`);
  lines.push(`${r.passed} passed, ${r.failed} failed, ${r.scenarios.length} scenarios`);
  lines.push("");
  lines.push("Groups:");
  for (const g of r.groups) {
    lines.push(
      `  ${g.kind}/${g.group}: ${g.passed}/${g.scenarios} passed${g.advisories ? `, ${g.advisories} with advisories` : ""}`,
    );
    for (const l of g.largest)
      lines.push(
        `      largest ${l.quantity}: ${fmt(l.value)} (limit ${fmt(l.limit)}) at ${l.where}`,
      );
  }
  const failed = r.scenarios.filter((v) => !v.pass);
  if (failed.length) {
    lines.push("");
    lines.push("Failures:");
    for (const v of failed) lines.push(`  ${v.id}: ${v.firstFailure}`);
  }
  const adv = r.scenarios.filter((v) => v.advisories.length);
  if (adv.length) {
    lines.push("");
    lines.push("Advisories (never fail a round):");
    for (const v of adv.slice(0, opts.all ? adv.length : 40))
      for (const a of v.advisories) lines.push(`  ${v.id}: ${a}`);
    if (!opts.all && adv.length > 40) lines.push(`  … ${adv.length - 40} more scenario(s)`);
  }
  return lines.join("\n");
}

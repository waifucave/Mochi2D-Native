/**
 * Comparison of two conformance result files (`mochi2d-result/*`).
 *
 * Pure TypeScript with no imports, so it runs anywhere (Node, browsers) and the
 * bundled CLI (tools/resultdiff.ts) has no runtime dependencies.
 *
 * Conventionally `a` is the reference and `b` the candidate, but every check is
 * symmetric except for the "only in a / only in b" lists.
 */

export const RESULT_DIFF_FORMAT = "mochi2d-resultdiff/0";

/**
 * A format name with the project's former prefix (`lively2d-`) replaced by
 * the current one (`mochi2d-`), as src/core/format-names.ts does; kept
 * inline so this module has no imports.
 */
const currentFormat = (name: unknown): unknown =>
  typeof name === "string" && name.startsWith("lively2d-") ? `mochi2d-${name.slice(9)}` : name;

/** Absolute tolerances. A value passes when |a - b| <= tolerance. */
export interface DiffTolerances {
  /** Euclidean distance between corresponding vertices. */
  vertex: number;
  /** Drawable opacity. */
  opacity: number;
  /** Each channel of multiplyColor / screenColor. */
  color: number;
  /** Parameter values. */
  parameter: number;
  /** Part opacities. */
  partOpacity: number;
  /** Draw order values. */
  drawOrder: number;
  /** Render order values. */
  renderOrder: number;
  /** Numbers inside `canvas`. */
  canvas: number;
}

export const DEFAULT_TOLERANCES: Readonly<DiffTolerances> = {
  vertex: 1e-4,
  opacity: 1e-4,
  color: 1e-4,
  parameter: 1e-4,
  partOpacity: 1e-4,
  drawOrder: 0,
  renderOrder: 0,
  canvas: 1e-4,
};

/** Names of the checks that decide pass / fail. */
export const CHECKS = [
  "error",
  "canvas",
  "parameterIds",
  "parameterValues",
  "partIds",
  "partOpacities",
  "drawableIds",
  "drawableOrder",
  "vertexCount",
  "vertices",
  "visible",
  "opacity",
  "drawOrder",
  "renderOrder",
  "multiplyColor",
  "screenColor",
] as const;
export type CheckName = (typeof CHECKS)[number];

export interface DiffOptions {
  tolerances?: Partial<DiffTolerances>;
  /** Skip vertex, opacity and color checks for drawables invisible in both files. */
  skipInvisible?: boolean;
  /** Checks that are reported but do not affect `pass`. */
  ignore?: readonly CheckName[];
}

/** Where the largest error of a check occurred. */
export interface MaxError {
  /** Largest error, or `null` if nothing was compared. Non-finite inputs count as invalid instead. */
  value: number | null;
  /** ID of the parameter / part / drawable. */
  id?: string;
  /** Vertex index or color channel, where applicable. */
  index?: number;
}

export interface CheckSummary {
  /** Number of items compared (vertices for "vertices"). */
  compared: number;
  /** Items outside tolerance (or unequal, for non-numeric checks). */
  mismatched: number;
  /** Values that are missing or not finite numbers. Always count as mismatches. */
  invalid: number;
  max?: MaxError;
  /** Root mean square error over all compared items (vertices only). */
  rms?: number | null;
  tolerance?: number;
  /** IDs (or keys) involved, capped at 50 entries. */
  examples?: string[];
  ignored: boolean;
  pass: boolean;
}

export interface IdListDiff {
  onlyInA: string[];
  onlyInB: string[];
  duplicatesInA: string[];
  duplicatesInB: string[];
}

export interface DrawableDiff {
  id: string;
  /** "ok", or the list of failed checks. */
  status: "ok" | "mismatch" | "only-in-a" | "only-in-b";
  failed: CheckName[];
  vertexCount?: [number, number];
  maxVertexError?: number | null;
  maxVertexIndex?: number;
  rmsVertexError?: number | null;
  invalidVertexValues?: number;
  visible?: [unknown, unknown];
  opacity?: [unknown, unknown];
  drawOrder?: [unknown, unknown];
  renderOrder?: [unknown, unknown];
  multiplyColor?: [unknown, unknown];
  screenColor?: [unknown, unknown];
  skipped?: boolean;
}

export interface ValueDiff {
  id: string;
  a: unknown;
  b: unknown;
  error: number | null;
}

export interface FileInfo {
  label: string;
  format: unknown;
  scenario: unknown;
  producer: unknown;
  error: unknown;
}

export interface ResultDiffReport {
  format: typeof RESULT_DIFF_FORMAT;
  a: FileInfo;
  b: FileInfo;
  tolerances: DiffTolerances;
  skipInvisible: boolean;
  pass: boolean;
  failedChecks: CheckName[];
  warnings: string[];
  checks: Record<CheckName, CheckSummary>;
  /** Diagonal of the bounding box of all vertices in `a` (for scale), or null. */
  referenceExtent: number | null;
  parameterIds: IdListDiff;
  partIds: IdListDiff;
  drawableIds: IdListDiff;
  canvasMismatches: { path: string; a: unknown; b: unknown }[];
  parameterMismatches: ValueDiff[];
  partMismatches: ValueDiff[];
  /** Drawables with any failed check, plus every drawable's vertex error, worst first. */
  drawables: DrawableDiff[];
}

/** Thrown for input that is not a result file at all. */
export class ResultFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultFormatError";
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const EXAMPLE_CAP = 50;

function idOf(item: unknown): string | undefined {
  return isObj(item) && typeof item.id === "string" ? item.id : undefined;
}

function arrayField(root: Obj, key: string, warnings: string[], label: string): unknown[] {
  const v = root[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    warnings.push(`${label}: "${key}" is not an array`);
    return [];
  }
  return v;
}

function indexById(items: unknown[]): {
  map: Map<string, unknown>;
  order: string[];
  duplicates: string[];
} {
  const map = new Map<string, unknown>();
  const order: string[] = [];
  const duplicates: string[] = [];
  for (const it of items) {
    const id = idOf(it);
    if (id === undefined) continue;
    if (map.has(id)) {
      duplicates.push(id);
      continue;
    }
    map.set(id, it);
    order.push(id);
  }
  return { map, order, duplicates };
}

function idListDiff(a: ReturnType<typeof indexById>, b: ReturnType<typeof indexById>): IdListDiff {
  return {
    onlyInA: a.order.filter((id) => !b.map.has(id)),
    onlyInB: b.order.filter((id) => !a.map.has(id)),
    duplicatesInA: a.duplicates,
    duplicatesInB: b.duplicates,
  };
}

/** True if the IDs present in both lists appear in the same relative order. */
function sameRelativeOrder(a: string[], b: string[]): boolean {
  const inB = new Set(b);
  const inA = new Set(a);
  const ca = a.filter((id) => inB.has(id));
  const cb = b.filter((id) => inA.has(id));
  return ca.length === cb.length && ca.every((id, i) => id === cb[i]);
}

class Check {
  compared = 0;
  mismatched = 0;
  invalid = 0;
  max: MaxError = { value: null };
  examples: string[] = [];
  sumSq = 0;
  constructor(
    readonly tolerance?: number,
    readonly withRms = false,
  ) {}

  example(s: string): void {
    if (this.examples.length < EXAMPLE_CAP && !this.examples.includes(s)) this.examples.push(s);
  }

  /** Records a numeric error (already absolute). Returns whether it is within tolerance. */
  error(err: number, id: string, index?: number): boolean {
    this.compared++;
    if (!Number.isFinite(err)) {
      this.invalid++;
      this.mismatched++;
      this.example(id);
      return false;
    }
    this.sumSq += err * err;
    if (this.max.value === null || err > this.max.value) {
      this.max = { value: err, id, ...(index !== undefined ? { index } : {}) };
    }
    if (err > (this.tolerance ?? 0)) {
      this.mismatched++;
      this.example(id);
      return false;
    }
    return true;
  }

  /** Records an equality comparison. */
  equal(ok: boolean, id: string): boolean {
    this.compared++;
    if (!ok) {
      this.mismatched++;
      this.example(id);
    }
    return ok;
  }

  invalidValue(id: string): void {
    this.compared++;
    this.invalid++;
    this.mismatched++;
    this.example(id);
  }

  summary(ignored: boolean): CheckSummary {
    const s: CheckSummary = {
      compared: this.compared,
      mismatched: this.mismatched,
      invalid: this.invalid,
      ignored,
      pass: ignored || this.mismatched === 0,
    };
    if (this.tolerance !== undefined) {
      s.tolerance = this.tolerance;
      s.max = this.max;
    }
    if (this.withRms) {
      const finite = this.compared - this.invalid;
      s.rms = finite > 0 ? Math.sqrt(this.sumSq / finite) : null;
    }
    if (this.examples.length) s.examples = this.examples;
    return s;
  }
}

function numErr(a: unknown, b: unknown): number {
  return isNum(a) && isNum(b) ? Math.abs(a - b) : Number.POSITIVE_INFINITY;
}

/** Recursively compares two JSON values; numbers with tolerance. */
function deepCompare(
  a: unknown,
  b: unknown,
  path: string,
  tol: number,
  out: { path: string; a: unknown; b: unknown }[],
  check: Check,
): void {
  if (typeof a === "number" || typeof b === "number") {
    check.error(numErr(a, b), path);
    if (!(numErr(a, b) <= tol)) out.push({ path, a, b });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      check.equal(false, path);
      out.push({ path: `${path}.length`, a: a.length, b: b.length });
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      deepCompare(a[i], b[i], `${path}[${i}]`, tol, out, check);
    return;
  }
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      if (!(k in a) || !(k in b)) {
        check.equal(false, `${path}.${k}`);
        out.push({ path: `${path}.${k}`, a: a[k], b: b[k] });
      } else deepCompare(a[k], b[k], `${path}.${k}`, tol, out, check);
    }
    return;
  }
  const ok = a === b;
  check.equal(ok, path);
  if (!ok) out.push({ path, a, b });
}

function vertexArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function extentOf(drawables: Iterable<unknown>): number | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const d of drawables) {
    const v = isObj(d) ? vertexArray(d.vertices) : undefined;
    if (!v) continue;
    for (let i = 0; i + 1 < v.length; i += 2) {
      const x = v[i];
      const y = v[i + 1];
      if (!isNum(x) || !isNum(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return minX <= maxX ? Math.hypot(maxX - minX, maxY - minY) : null;
}

function fileInfo(label: string, r: Obj): FileInfo {
  return {
    label,
    format: r.format,
    scenario: r.scenario,
    producer: r.producer,
    error: r.error ?? null,
  };
}

/** Validates the top-level shape enough to compare; throws {@link ResultFormatError}. */
export function assertResultShape(value: unknown, label: string): asserts value is Obj {
  if (!isObj(value)) throw new ResultFormatError(`${label}: not a JSON object`);
  const format = currentFormat(value.format);
  if (typeof format !== "string" || !format.startsWith("mochi2d-result/")) {
    throw new ResultFormatError(
      `${label}: "format" is ${JSON.stringify(value.format)}, expected "mochi2d-result/…"`,
    );
  }
}

export function diffResults(
  a: unknown,
  b: unknown,
  opts: DiffOptions = {},
  labels: [string, string] = ["a", "b"],
): ResultDiffReport {
  assertResultShape(a, labels[0]);
  assertResultShape(b, labels[1]);
  const tol: DiffTolerances = { ...DEFAULT_TOLERANCES, ...opts.tolerances };
  const ignore = new Set<CheckName>(opts.ignore ?? []);
  const warnings: string[] = [];
  if (currentFormat(a.format) !== currentFormat(b.format))
    warnings.push(`format differs: ${String(a.format)} vs ${String(b.format)}`);
  if (a.scenario !== b.scenario)
    warnings.push(`scenario differs: ${String(a.scenario)} vs ${String(b.scenario)}`);

  const c = {
    error: new Check(),
    canvas: new Check(tol.canvas),
    parameterIds: new Check(),
    parameterValues: new Check(tol.parameter),
    partIds: new Check(),
    partOpacities: new Check(tol.partOpacity),
    drawableIds: new Check(),
    drawableOrder: new Check(),
    vertexCount: new Check(),
    vertices: new Check(tol.vertex, true),
    visible: new Check(),
    opacity: new Check(tol.opacity),
    drawOrder: new Check(tol.drawOrder),
    renderOrder: new Check(tol.renderOrder),
    multiplyColor: new Check(tol.color),
    screenColor: new Check(tol.color),
  } satisfies Record<CheckName, Check>;

  // Errors: a result that carries an error never passes.
  c.error.equal(a.error === null || a.error === undefined, labels[0]);
  c.error.equal(b.error === null || b.error === undefined, labels[1]);

  // Canvas.
  const canvasMismatches: { path: string; a: unknown; b: unknown }[] = [];
  deepCompare(a.canvas ?? {}, b.canvas ?? {}, "canvas", tol.canvas, canvasMismatches, c.canvas);

  // Parameters and parts.
  const valueSection = (
    key: "parameters" | "parts",
    field: "value" | "opacity",
    ids: Check,
    values: Check,
  ): { idDiff: IdListDiff; mismatches: ValueDiff[] } => {
    const ia = indexById(arrayField(a, key, warnings, labels[0]));
    const ib = indexById(arrayField(b, key, warnings, labels[1]));
    const idDiff = idListDiff(ia, ib);
    for (const id of [
      ...idDiff.onlyInA,
      ...idDiff.onlyInB,
      ...idDiff.duplicatesInA,
      ...idDiff.duplicatesInB,
    ]) {
      ids.equal(false, id);
    }
    const mismatches: ValueDiff[] = [];
    for (const id of ia.order) {
      if (!ib.map.has(id)) continue;
      ids.equal(true, id);
      const va = (ia.map.get(id) as Obj)[field];
      const vb = (ib.map.get(id) as Obj)[field];
      const err = numErr(va, vb);
      if (!values.error(err, id))
        mismatches.push({ id, a: va, b: vb, error: Number.isFinite(err) ? err : null });
    }
    return { idDiff, mismatches };
  };
  const params = valueSection("parameters", "value", c.parameterIds, c.parameterValues);
  const parts = valueSection("parts", "opacity", c.partIds, c.partOpacities);

  // Drawables.
  const da = indexById(arrayField(a, "drawables", warnings, labels[0]));
  const db = indexById(arrayField(b, "drawables", warnings, labels[1]));
  const drawableIds = idListDiff(da, db);
  for (const id of [
    ...drawableIds.onlyInA,
    ...drawableIds.onlyInB,
    ...drawableIds.duplicatesInA,
    ...drawableIds.duplicatesInB,
  ]) {
    c.drawableIds.equal(false, id);
  }
  c.drawableOrder.equal(sameRelativeOrder(da.order, db.order), "drawables");

  const drawables: DrawableDiff[] = [];
  for (const id of drawableIds.onlyInA)
    drawables.push({ id, status: "only-in-a", failed: ["drawableIds"] });
  for (const id of drawableIds.onlyInB)
    drawables.push({ id, status: "only-in-b", failed: ["drawableIds"] });

  for (const id of da.order) {
    if (!db.map.has(id)) continue;
    c.drawableIds.equal(true, id);
    const x = da.map.get(id) as Obj;
    const y = db.map.get(id) as Obj;
    const d: DrawableDiff = { id, status: "ok", failed: [] };
    const fail = (name: CheckName) => d.failed.push(name);

    if (!c.visible.equal(typeof x.visible === "boolean" && x.visible === y.visible, id)) {
      fail("visible");
      d.visible = [x.visible, y.visible];
    }
    const skip = opts.skipInvisible === true && x.visible === false && y.visible === false;
    if (skip) d.skipped = true;

    if (!c.drawOrder.error(numErr(x.drawOrder, y.drawOrder), id)) {
      fail("drawOrder");
      d.drawOrder = [x.drawOrder, y.drawOrder];
    }
    if (!c.renderOrder.error(numErr(x.renderOrder, y.renderOrder), id)) {
      fail("renderOrder");
      d.renderOrder = [x.renderOrder, y.renderOrder];
    }

    if (!skip) {
      if (!c.opacity.error(numErr(x.opacity, y.opacity), id)) {
        fail("opacity");
        d.opacity = [x.opacity, y.opacity];
      }
      for (const key of ["multiplyColor", "screenColor"] as const) {
        const ca = x[key];
        const cb = y[key];
        const check = c[key];
        let ok = true;
        if (!Array.isArray(ca) || !Array.isArray(cb) || ca.length !== cb.length) {
          check.invalidValue(id);
          ok = false;
        } else {
          let worst = 0;
          let worstIdx = 0;
          for (let i = 0; i < ca.length; i++) {
            const e = numErr(ca[i], cb[i]);
            if (!(e <= worst)) {
              worst = e;
              worstIdx = i;
            }
          }
          ok = check.error(worst, id, worstIdx);
        }
        if (!ok) {
          fail(key);
          d[key] = [ca, cb];
        }
      }

      const va = vertexArray(x.vertices);
      const vb = vertexArray(y.vertices);
      if (!va || !vb || va.length !== vb.length || va.length % 2 !== 0) {
        c.vertexCount.equal(false, id);
        fail("vertexCount");
        d.vertexCount = [va ? va.length / 2 : -1, vb ? vb.length / 2 : -1];
      } else {
        c.vertexCount.equal(true, id);
        let worst = 0;
        let worstIdx = -1;
        let sumSq = 0;
        let finite = 0;
        let invalid = 0;
        let ok = true;
        for (let i = 0; i < va.length; i += 2) {
          const ax = va[i];
          const ay = va[i + 1];
          const bx = vb[i];
          const by = vb[i + 1];
          let e: number;
          if (isNum(ax) && isNum(ay) && isNum(bx) && isNum(by)) {
            e = Math.hypot(ax - bx, ay - by);
            sumSq += e * e;
            finite++;
            if (e > worst || worstIdx < 0) {
              worst = e;
              worstIdx = i / 2;
            }
          } else {
            e = Number.POSITIVE_INFINITY;
            invalid++;
          }
          if (!c.vertices.error(e, id, i / 2)) ok = false;
        }
        d.vertexCount = [va.length / 2, vb.length / 2];
        d.maxVertexError = worstIdx >= 0 ? worst : null;
        if (worstIdx >= 0) d.maxVertexIndex = worstIdx;
        d.rmsVertexError = finite ? Math.sqrt(sumSq / finite) : null;
        if (invalid) d.invalidVertexValues = invalid;
        if (!ok) fail("vertices");
      }
    }
    if (d.failed.length) d.status = "mismatch";
    drawables.push(d);
  }

  // Worst first: failed drawables, then by vertex error.
  const rank = (d: DrawableDiff) => (d.status === "ok" ? 0 : 1);
  drawables.sort(
    (p, q) =>
      rank(q) - rank(p) ||
      (q.maxVertexError ?? (q.vertexCount ? -1 : Infinity)) -
        (p.maxVertexError ?? (p.vertexCount ? -1 : Infinity)) ||
      (p.id < q.id ? -1 : p.id > q.id ? 1 : 0),
  );

  const checks = Object.fromEntries(
    CHECKS.map((name) => [name, c[name].summary(ignore.has(name))]),
  ) as Record<CheckName, CheckSummary>;
  const failedChecks = CHECKS.filter((name) => !checks[name].pass);

  return {
    format: RESULT_DIFF_FORMAT,
    a: fileInfo(labels[0], a),
    b: fileInfo(labels[1], b),
    tolerances: tol,
    skipInvisible: opts.skipInvisible === true,
    pass: failedChecks.length === 0,
    failedChecks,
    warnings,
    checks,
    referenceExtent: extentOf(da.map.values()),
    parameterIds: params.idDiff,
    partIds: parts.idDiff,
    drawableIds,
    canvasMismatches,
    parameterMismatches: params.mismatches,
    partMismatches: parts.mismatches,
    drawables,
  };
}

/** Number formatting for tables: short but exact enough to compare with tolerances. */
export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "0";
  const abs = Math.abs(n);
  return abs >= 1e-3 && abs < 1e5 ? String(Number(n.toPrecision(4))) : n.toExponential(2);
}

function pad(s: string, w: number, right = false): string {
  return right ? s.padStart(w) : s.padEnd(w);
}

/** Renders rows as a fixed-width text table. The first row is the header. */
export function table(rows: string[][], rightAlign: boolean[] = []): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) =>
      r
        .map((cell, i) => pad(cell, widths[i]!, rightAlign[i] ?? false))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const CHECK_LABELS: Record<CheckName, string> = {
  error: "error field",
  canvas: "canvas",
  parameterIds: "parameter ids",
  parameterValues: "parameter values",
  partIds: "part ids",
  partOpacities: "part opacities",
  drawableIds: "drawable ids",
  drawableOrder: "drawable order",
  vertexCount: "vertex counts",
  vertices: "vertices",
  visible: "visible",
  opacity: "opacity",
  drawOrder: "draw order",
  renderOrder: "render order",
  multiplyColor: "multiply color",
  screenColor: "screen color",
};

/** Human-readable summary of one report. */
export function formatReport(r: ResultDiffReport, top = 10): string {
  const lines: string[] = [];
  lines.push(`a: ${r.a.label}  (${String(r.a.producer ?? "?")})`);
  lines.push(`b: ${r.b.label}  (${String(r.b.producer ?? "?")})`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  if (r.a.error) lines.push(`a has an error: ${JSON.stringify(r.a.error)}`);
  if (r.b.error) lines.push(`b has an error: ${JSON.stringify(r.b.error)}`);
  lines.push("");
  const rows: string[][] = [
    ["check", "compared", "mismatched", "max error", "where", "tolerance", "status"],
  ];
  for (const name of CHECKS) {
    const s = r.checks[name];
    const where =
      s.max?.id !== undefined && s.max.value !== 0
        ? `${s.max.id}${s.max.index !== undefined ? ` #${s.max.index}` : ""}`
        : "";
    rows.push([
      CHECK_LABELS[name],
      String(s.compared),
      String(s.mismatched) + (s.invalid ? ` (${s.invalid} invalid)` : ""),
      s.max ? fmt(s.max.value) : "",
      where,
      s.tolerance !== undefined ? fmt(s.tolerance) : "exact",
      s.ignored ? (s.mismatched ? "ignored" : "ok") : s.pass ? "ok" : "FAIL",
    ]);
  }
  lines.push(table(rows, [false, true, true, true, false, true, false]));
  const vr = r.checks.vertices;
  if (vr.rms !== undefined) {
    lines.push(
      `vertex rms ${fmt(vr.rms)}` +
        (r.referenceExtent ? `   reference extent (bbox diagonal) ${fmt(r.referenceExtent)}` : "") +
        (r.referenceExtent && vr.max?.value != null
          ? `   max/extent ${fmt(vr.max.value / r.referenceExtent)}`
          : ""),
    );
  }
  const idLines = (label: string, d: IdListDiff) => {
    if (d.onlyInA.length)
      lines.push(`${label} only in a (${d.onlyInA.length}): ${d.onlyInA.slice(0, 20).join(", ")}`);
    if (d.onlyInB.length)
      lines.push(`${label} only in b (${d.onlyInB.length}): ${d.onlyInB.slice(0, 20).join(", ")}`);
    if (d.duplicatesInA.length)
      lines.push(`${label} duplicated in a: ${d.duplicatesInA.slice(0, 20).join(", ")}`);
    if (d.duplicatesInB.length)
      lines.push(`${label} duplicated in b: ${d.duplicatesInB.slice(0, 20).join(", ")}`);
  };
  idLines("parameters", r.parameterIds);
  idLines("parts", r.partIds);
  idLines("drawables", r.drawableIds);
  for (const m of r.canvasMismatches.slice(0, 10)) {
    lines.push(`${m.path}: ${JSON.stringify(m.a)} vs ${JSON.stringify(m.b)}`);
  }
  const worst = r.drawables
    .filter((d) => d.status !== "only-in-a" && d.status !== "only-in-b")
    .slice(0, top);
  if (worst.length && top > 0) {
    lines.push("");
    lines.push(`worst ${worst.length} drawable(s):`);
    const drows: string[][] = [["drawable", "verts", "max err", "at", "rms", "failed checks"]];
    for (const d of worst) {
      drows.push([
        d.id,
        d.vertexCount
          ? `${d.vertexCount[0]}${d.vertexCount[0] !== d.vertexCount[1] ? `/${d.vertexCount[1]}` : ""}`
          : "",
        fmt(d.maxVertexError),
        d.maxVertexIndex !== undefined ? `#${d.maxVertexIndex}` : "",
        fmt(d.rmsVertexError),
        d.failed.join(",") || (d.skipped ? "(skipped: invisible)" : "-"),
      ]);
    }
    lines.push(table(drows, [false, true, true, false, true, false]));
  }
  lines.push("");
  lines.push(r.pass ? "RESULT: PASS" : `RESULT: FAIL (${r.failedChecks.join(", ")})`);
  return lines.join("\n");
}

/** JSON-safe copy: non-finite numbers become null. */
export function toJsonSafe<T>(value: T): Json {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) =>
      typeof v === "number" && !Number.isFinite(v) ? null : v,
    ),
  ) as Json;
}

/**
 * In-place value patches: new values for a loaded model's keyform positions,
 * opacities, draw orders, colors, rotation values, glue intensities and glue
 * weights, normal and blend-shape keyforms alike, without rebuilding it.
 *
 * A patch names an array of {@link MocData} (a group and a field), the first
 * element to replace, and the new values. It writes them into the model's
 * arrays, rebuilds the value-derived plan entries (folded constants, dropped
 * blend steps, −0 flags) of the objects that read them, and says which
 * objects an instance must recompute. The structure (counts, bindings, keys,
 * indices) never changes; a patch to anything else is refused.
 *
 * Every instance of the model sees a patch at its next evaluation. The
 * instance it was applied through recomputes only what it touched; any other
 * instance notices the model's new data revision and re-evaluates in full.
 */
import type { MocModel } from "../moc/model.js";
import { WARP_KIND } from "../moc/model.js";
import { refreshPlan, type PlanObjectKind } from "./plan.js";

/** One patch: `values` replace elements `start…` of a MocData array. */
export interface ValuePatch {
  /** The MocData group, for example "artMeshKeyforms" or "keyformPositions". */
  group: PatchGroup;
  /** The group's field, for example "opacity"; none for `keyformPositions`. */
  field?: string;
  /** Index of the first element replaced, as in that MocData array. */
  start: number;
  values: ArrayLike<number>;
}

/** The MocData groups a patch can write, with their patchable fields. */
export const PATCHABLE_FIELDS = {
  keyformPositions: [] as const,
  artMeshKeyforms: ["opacity", "drawOrder"] as const,
  warpKeyforms: ["opacity"] as const,
  rotationKeyforms: ["opacity", "angle", "originX", "originY", "scale"] as const,
  partKeyforms: ["drawOrder"] as const,
  offscreenKeyforms: ["opacity"] as const,
  glueKeyforms: ["intensity"] as const,
  glueInfo: ["weight"] as const,
  multiplyColors: ["r", "g", "b"] as const,
  screenColors: ["r", "g", "b"] as const,
};
export type PatchGroup = keyof typeof PATCHABLE_FIELDS;

/** What a set of patches asks an instance to do at its next evaluation. */
export interface PatchEffect {
  /** Ranges [start, end) of the positions pool to copy into the instance's heap. */
  positions: [number, number][];
  /** Deformers to recompute (and so their children). */
  deformers: Set<number>;
  /** Art meshes whose vertices to recompute. */
  meshVertices: Set<number>;
  /** Whether glue must run again. */
  glue: boolean;
}

// ------------------------------------------------------------- revisions

const revisions = new WeakMap<MocModel, number>();

/** The model's data revision: 0 when loaded, one more after each patch. */
export function dataRevision(model: MocModel): number {
  return revisions.get(model) ?? 0;
}

// ----------------------------------------------------------------- owners

const MESH = 0;
const DEFORMER = 1;
const PART = 2;
const GLUE = 3;
const OFFSCREEN = 4;
const KINDS: PlanObjectKind[] = ["mesh", "deformer", "part", "glue", "offscreen"];
const pack = (kind: number, index: number) => kind * 2 ** 24 + index;
const kindOf = (packed: number) => Math.floor(packed / 2 ** 24);
const indexOf = (packed: number) => packed % 2 ** 24;

/** Which objects read each element: one owner per element, and any further ones aside. */
class Owners {
  readonly first: Int32Array;
  private readonly more = new Map<number, number[]>();
  constructor(size: number) {
    this.first = new Int32Array(size).fill(-1);
  }
  add(at: number, owner: number): void {
    if (at < 0 || at >= this.first.length) return;
    const f = this.first[at]!;
    if (f === -1) this.first[at] = owner;
    else if (f !== owner) {
      const list = this.more.get(at) ?? [];
      if (!list.includes(owner)) list.push(owner);
      this.more.set(at, list);
    }
  }
  forEach(at: number, fn: (owner: number) => void): void {
    const f = this.first[at];
    if (f === undefined || f < 0) return;
    fn(f);
    for (const o of this.more.get(at) ?? []) fn(o);
  }
}

/** Element → reader maps of a model, built at its first patch. */
interface PatchIndex {
  meshKeyforms: Owners;
  warpKeyforms: Owners;
  rotationKeyforms: Owners;
  partKeyforms: Owners;
  offscreenKeyforms: Owners;
  glueKeyforms: Owners;
  glueInfo: Owners;
  multiply: Owners;
  screen: Owners;
  /** Position runs sorted by start: start, length and owner. */
  runStart: Int32Array;
  runLength: Int32Array;
  runOwner: Int32Array;
  maxRun: number;
}

const indexes = new WeakMap<MocModel, PatchIndex>();

function patchIndex(m: MocModel): PatchIndex {
  let ix = indexes.get(m);
  if (ix) return ix;
  const kf = m.keyforms;
  const count = (band: number) => m.bands[band]!.keyformCount;
  const meshKeyforms = new Owners(kf.meshOpacity.length);
  const warpKeyforms = new Owners(kf.warpOpacity.length);
  const rotationKeyforms = new Owners(kf.rotationAngle.length);
  const partKeyforms = new Owners(kf.partDrawOrder.length);
  const offscreenKeyforms = new Owners(kf.offscreenOpacity.length);
  const glueKeyforms = new Owners(kf.glueIntensity.length);
  const glueInfo = new Owners(
    m.glues.firstInfo.reduce(
      (n, first, g) => Math.max(n, first + 2 * m.glues.weightA[g]!.length),
      0,
    ),
  );
  const multiply = new Owners(m.multiplyColors.length / 3);
  const screen = new Owners(m.screenColors.length / 3);
  const runs: [start: number, length: number, owner: number][] = [];

  /** Every keyform of an object: its normal ones, then those of its blend shapes. */
  const keyforms = (
    first: number,
    band: number,
    list: readonly { firstKeyform: number; keys: Float32Array }[],
    fn: (k: number) => void,
  ) => {
    for (let o = 0; o < count(band); o++) fn(first + o);
    for (const b of list) for (let k = 0; k < b.keys.length; k++) fn(b.firstKeyform + k);
  };
  const colors = (idx: { multiply: Int32Array; screen: Int32Array }, k: number, owner: number) => {
    multiply.add(idx.multiply[k]!, owner);
    screen.add(idx.screen[k]!, owner);
  };

  const me = m.meshes;
  for (let i = 0; i < me.ids.length; i++) {
    const owner = pack(MESH, i);
    keyforms(me.firstKeyform[i]!, me.band[i]!, m.blendShapes.mesh[i]!, (k) => {
      meshKeyforms.add(k, owner);
      colors(kf.meshColors, k, owner);
      runs.push([kf.meshFirstPosition[k]!, 2 * me.vertexCount[i]!, owner]);
    });
  }
  const d = m.deformers;
  for (let i = 0; i < d.ids.length; i++) {
    const owner = pack(DEFORMER, i);
    const k = d.kindIndex[i]!;
    if (d.kind[i] === WARP_KIND) {
      const length = 2 * (m.warps.rows[k]! + 1) * (m.warps.columns[k]! + 1);
      keyforms(m.warps.firstKeyform[k]!, d.band[i]!, m.blendShapes.warp[k]!, (x) => {
        warpKeyforms.add(x, owner);
        colors(kf.warpColors, x, owner);
        runs.push([kf.warpFirstPosition[x]!, length, owner]);
      });
    } else {
      keyforms(m.rotations.firstKeyform[k]!, d.band[i]!, m.blendShapes.rotation[k]!, (x) => {
        rotationKeyforms.add(x, owner);
        colors(kf.rotationColors, x, owner);
      });
    }
  }
  for (let p = 0; p < m.parts.ids.length; p++)
    keyforms(m.parts.firstKeyform[p]!, m.parts.band[p]!, m.blendShapes.part[p]!, (k) =>
      partKeyforms.add(k, pack(PART, p)),
    );
  // An offscreen's normal keyforms through its owner part's, then its own
  // blend-shape keyforms (offscreen targets).
  for (let o = 0; o < m.offscreens.part.length; o++) {
    const owner = pack(OFFSCREEN, o);
    const p = m.offscreens.part[o]!;
    const first = m.parts.firstKeyform[p]!;
    for (let j = 0; j < count(m.parts.band[p]!); j++) {
      const ok = kf.partOffscreenKeyform[first + j]!;
      offscreenKeyforms.add(ok, owner);
      if (ok >= 0) colors(kf.offscreenColors, ok, owner);
    }
    for (const b of m.blendShapes.offscreen[o]!)
      for (let k = 0; k < b.keys.length; k++) {
        offscreenKeyforms.add(b.firstKeyform + k, owner);
        colors(kf.offscreenColors, b.firstKeyform + k, owner);
      }
  }
  for (let g = 0; g < m.glues.ids.length; g++) {
    keyforms(m.glues.firstKeyform[g]!, m.glues.band[g]!, m.blendShapes.glue[g]!, (k) =>
      glueKeyforms.add(k, pack(GLUE, g)),
    );
    const first = m.glues.firstInfo[g]!;
    for (let j = 0; j < 2 * m.glues.weightA[g]!.length; j++) glueInfo.add(first + j, pack(GLUE, g));
  }

  runs.sort((a, b) => a[0] - b[0]);
  ix = {
    meshKeyforms,
    warpKeyforms,
    rotationKeyforms,
    partKeyforms,
    offscreenKeyforms,
    glueKeyforms,
    glueInfo,
    multiply,
    screen,
    runStart: Int32Array.from(runs, (r) => r[0]),
    runLength: Int32Array.from(runs, (r) => r[1]),
    runOwner: Int32Array.from(runs, (r) => r[2]),
    maxRun: runs.reduce((n, r) => Math.max(n, r[1]), 0),
  };
  indexes.set(m, ix);
  return ix;
}

/** Calls `fn` with the owner of every position run that overlaps [a, b). */
function runsOverlapping(ix: PatchIndex, a: number, b: number, fn: (owner: number) => void): void {
  const starts = ix.runStart;
  // The first run that can reach a: start > a − maxRun.
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= a - ix.maxRun) lo = mid + 1;
    else hi = mid;
  }
  for (let r = lo; r < starts.length && starts[r]! < b; r++)
    if (starts[r]! + ix.runLength[r]! > a) fn(ix.runOwner[r]!);
}

// ------------------------------------------------------------- patching

/** The model array a patch writes, as (array, stride, channel): element i is array[stride·i + channel]. */
function target(
  m: MocModel,
  p: ValuePatch,
): { array: Float32Array; stride: number; channel: number } | null {
  const kf = m.keyforms;
  const f = p.field;
  switch (p.group) {
    case "keyformPositions":
      return { array: m.positions, stride: 1, channel: 0 };
    case "artMeshKeyforms":
      return { array: f === "opacity" ? kf.meshOpacity : kf.meshDrawOrder, stride: 1, channel: 0 };
    case "warpKeyforms":
      return { array: kf.warpOpacity, stride: 1, channel: 0 };
    case "rotationKeyforms": {
      const array = {
        opacity: kf.rotationOpacity,
        angle: kf.rotationAngle,
        originX: kf.rotationOriginX,
        originY: kf.rotationOriginY,
        scale: kf.rotationScale,
      }[f as "opacity"];
      return { array, stride: 1, channel: 0 };
    }
    case "partKeyforms":
      return { array: kf.partDrawOrder, stride: 1, channel: 0 };
    case "offscreenKeyforms":
      return { array: kf.offscreenOpacity, stride: 1, channel: 0 };
    case "glueKeyforms":
      return { array: kf.glueIntensity, stride: 1, channel: 0 };
    case "multiplyColors":
    case "screenColors":
      return {
        array: p.group === "multiplyColors" ? m.multiplyColors : m.screenColors,
        stride: 3,
        channel: "rgb".indexOf(f!),
      };
    case "glueInfo":
      return null; // the weights live per glue (see applyPatches)
  }
}

/** The number of elements of the patched MocData array. */
function length(m: MocModel, p: ValuePatch): number {
  if (p.group === "glueInfo") return patchIndex(m).glueInfo.first.length;
  const t = target(m, p)!;
  return t.array.length / t.stride;
}

/** Checks a patch; throws a TypeError or RangeError that names the problem. */
function check(m: MocModel, p: ValuePatch): void {
  const where = `${p.group}${p.field ? `.${p.field}` : ""}`;
  const fields = (PATCHABLE_FIELDS as Record<string, readonly string[]>)[p.group];
  if (!fields)
    throw new TypeError(
      `${p.group} cannot be patched (patchable: ${Object.keys(PATCHABLE_FIELDS).join(", ")})`,
    );
  if (fields.length === 0 ? p.field !== undefined : !fields.includes(p.field ?? ""))
    throw new TypeError(
      fields.length === 0
        ? `${p.group} has no fields`
        : `${where} cannot be patched (fields of ${p.group}: ${fields.join(", ")})`,
    );
  const n = length(m, p);
  if (!(Number.isInteger(p.start) && p.start >= 0 && p.start + p.values.length <= n))
    throw new RangeError(
      `${where}: [${p.start}, ${p.start + p.values.length}) is outside its ${n} elements`,
    );
  // Keyform opacities must be finite, as loadMoc requires by default (other
  // values load whatever they are, so they patch whatever they are).
  const opacity = p.field === "opacity";
  for (let i = 0; i < p.values.length; i++) {
    const v = p.values[i];
    if (typeof v !== "number") throw new TypeError(`${where}: value ${i} is not a number`);
    if (opacity && !Number.isFinite(v))
      throw new RangeError(`${where}: value ${i} is ${v}; keyform opacities must be finite`);
  }
}

/**
 * Applies patches to a model: checks them all first (a bad one throws and
 * none is applied), writes their values, rebuilds the plan values of the
 * objects that read them, bumps the model's data revision, and returns what
 * an instance must recompute.
 */
export function applyPatches(m: MocModel, patches: readonly ValuePatch[]): PatchEffect {
  for (const p of patches) check(m, p);
  const ix = patchIndex(m);
  const effect: PatchEffect = {
    positions: [],
    deformers: new Set(),
    meshVertices: new Set(),
    glue: false,
  };
  const refresh = new Set<number>(); // packed objects whose plan values to rebuild
  const touch = (owner: number) => {
    refresh.add(owner);
    if (kindOf(owner) === DEFORMER) effect.deformers.add(indexOf(owner));
    if (kindOf(owner) === GLUE) effect.glue = true;
  };
  for (const p of patches) {
    const n = p.values.length;
    if (n === 0) continue;
    if (p.group === "glueInfo") {
      for (let i = 0; i < n; i++) {
        const j = p.start + i;
        ix.glueInfo.forEach(j, (owner) => {
          const g = indexOf(owner);
          const e = j - m.glues.firstInfo[g]!;
          (e % 2 === 0 ? m.glues.weightA : m.glues.weightB)[g]![e >> 1] = p.values[i]!;
        });
      }
      effect.glue = true;
      continue;
    }
    const t = target(m, p)!;
    for (let i = 0; i < n; i++) t.array[t.stride * (p.start + i) + t.channel] = p.values[i]!;
    const owners: Owners | null = {
      artMeshKeyforms: ix.meshKeyforms,
      warpKeyforms: ix.warpKeyforms,
      rotationKeyforms: ix.rotationKeyforms,
      partKeyforms: ix.partKeyforms,
      offscreenKeyforms: ix.offscreenKeyforms,
      glueKeyforms: ix.glueKeyforms,
      multiplyColors: ix.multiply,
      screenColors: ix.screen,
      keyformPositions: null,
    }[p.group];
    if (owners) {
      for (let i = 0; i < n; i++) owners.forEach(p.start + i, touch);
      continue;
    }
    // Positions: the heap copy, and the meshes and warps whose runs they fall in.
    effect.positions.push([p.start, p.start + n]);
    runsOverlapping(ix, p.start, p.start + n, (owner) => {
      touch(owner);
      if (kindOf(owner) === MESH) effect.meshVertices.add(indexOf(owner));
    });
  }
  for (const owner of refresh) refreshPlan(m, KINDS[kindOf(owner)]!, indexOf(owner));
  revisions.set(m, dataRevision(m) + 1);
  return effect;
}

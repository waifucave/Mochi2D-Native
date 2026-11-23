/**
 * The crafted model files of the test catalog (4p), rebuilt from
 * DeepSeek-chan's `.moc3` in memory: version relabels (P1), the canvas flag
 * (P2), a big-endian copy (P3), the v6 conversion (P4), the q2c/q2d offscreen
 * crafts (P5), narrowed keys (P6), q4c (P7) and the validation cases (P8: its
 * 41, and 20 more for band, mask, parent and position-run entries and S6's
 * verdicts).
 *
 * Nothing here writes to disk. The catalog writes the results under the
 * gitignored `assets/models/crafts/`; tests use them in memory. No crafted or
 * modified copy of DeepSeek-chan's model is ever committed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMocSections, type MocCanvas, type MocSections } from "../../../src/core/moc/read.js";
import { writeMoc } from "../../../src/core/moc/write.js";
import { ELEMENT_SIZE, FIELDS, type FieldKey } from "../../../src/core/moc/schema.js";
import { repoRoot } from "../cli.js";
import { DEEPSEEK_FOLDER, findDeepseekDir } from "../model-roots.js";

/** DeepSeek-chan's folder name in model paths, and its files. */
export const DEEPSEEK_DIR = DEEPSEEK_FOLDER;
export const DEEPSEEK_SETTINGS = "大肥鱼.model3.json";
export const DEEPSEEK_MOC_NAME = "大肥鱼.moc3";
export const DEEPSEEK_TEXTURE_DIR = "大肥鱼.4096";
export const DEEPSEEK_TEXTURES = [0, 1, 2, 3, 4].map(
  (i) => `${DEEPSEEK_TEXTURE_DIR}/texture_0${i}.png`,
);

/** DeepSeek-chan's `.moc3` (in assets/models/DeepSeek/, or where it is expected there). */
export const DEEPSEEK_MOC = join(
  findDeepseekDir(repoRoot()) ?? join(repoRoot(), "assets", "models", DEEPSEEK_DIR),
  DEEPSEEK_MOC_NAME,
);

let cachedBytes: Uint8Array | null = null;
let cachedSections: MocSections | null = null;

/** DeepSeek-chan's `.moc3` (read once; never modify the returned array). */
export function deepseekMocBytes(): Uint8Array {
  cachedBytes ??= new Uint8Array(readFileSync(DEEPSEEK_MOC));
  return cachedBytes;
}

/** DeepSeek-chan's sections (read once). */
export function deepseekSections(): MocSections {
  cachedSections ??= readMocSections(deepseekMocBytes());
  return cachedSections;
}

export type Fields = Partial<Record<FieldKey, number[] | string[]>>;

/** Rebuilds DeepSeek-chan's file after `mutate` changed its arrays, version, canvas or counts. */
export function craftDeepseek(
  mutate: (f: Fields, x: { counts: number[]; canvas: MocCanvas }) => void = () => {},
  opts: { version?: number; bigEndian?: boolean } = {},
): Uint8Array {
  const s = deepseekSections();
  const fields: Fields = {};
  for (const [key, value] of s.fields) {
    if (value === null) continue;
    fields[key] = Array.isArray(value) ? [...value] : Array.from(value as ArrayLike<number>);
  }
  const counts = Array.from(s.counts);
  const canvas = { ...s.canvas };
  mutate(fields, { counts, canvas });
  return writeMoc({
    version: opts.version ?? s.version,
    canvas,
    fields,
    counts: Object.fromEntries(counts.map((c, i) => [i, c])),
    ...(opts.bigEndian ? { bigEndian: true } : {}),
  });
}

const ints = (f: Fields, k: FieldKey) => f[k] as number[];
const arr = (k: FieldKey) =>
  Array.from(deepseekSections().fields.get(k) as ArrayLike<number>) as number[];
const names = (k: FieldKey) => deepseekSections().fields.get(k) as string[];

/**
 * Draw-order group totals (slot 83) for given part offscreens: each group's
 * drawables plus the offscreens of nested parts, recursively.
 */
export function groupTotals(f: Fields, partOffscreen: readonly number[]): number[] {
  const first = ints(f, "group.firstObject");
  const count = ints(f, "group.objectCount");
  const kind = ints(f, "groupObject.kind");
  const index = ints(f, "groupObject.index");
  const nested = ints(f, "groupObject.nestedGroup");
  const totals = new Array<number>(first.length).fill(0);
  const total = (g: number): number => {
    let t = 0;
    for (let i = first[g]!; i < first[g]! + count[g]!; i++)
      t += kind[i] === 0 ? 1 : (partOffscreen[index[i]!]! >= 0 ? 1 : 0) + total(nested[i]!);
    totals[g] = t;
    return t;
  };
  total(0);
  return totals;
}

/** Sets the last key of parameter binding `binding` (slots 75–77; P6). */
export function setLastKey(f: Fields, binding: number, value: number): void {
  const first = ints(f, "binding.firstKey")[binding]!;
  const count = ints(f, "binding.keyCount")[binding]!;
  ints(f, "keys")[first + count - 1] = value;
}

/** Keys of parameter binding `binding` in DeepSeek-chan's file. */
export function bindingKeys(binding: number): number[] {
  const s = deepseekSections();
  const first = (s.fields.get("binding.firstKey") as Int32Array)[binding]!;
  const count = (s.fields.get("binding.keyCount") as Int32Array)[binding]!;
  return Array.from((s.fields.get("keys") as Float32Array).subarray(first, first + count));
}

/** Drawable blend codes from the flags (P4, P5): 1 for bit 0, 2 for bit 1, else 0. */
function blendCodesFromFlags(exception?: { mesh: string; code: number }): number[] {
  const m = exception ? names("mesh.id").indexOf(exception.mesh) : -1;
  return arr("mesh.flags").map((fl, i) =>
    i === m ? exception!.code : fl & 1 ? 1 : fl & 2 ? 2 : 0,
  );
}

interface OffscreenSpec {
  owner: string;
  blend: number;
  /** Mask list (first entry, count) or none. */
  masks?: { first: number; count: number };
  /** One opacity per owner keyform. */
  opacities: number[];
  /** Color index of owner keyform k (multiply and screen). */
  color: (k: number) => number;
}

/** A version-6 conversion with the given offscreens (P4, P5). */
function craftOffscreens(
  offscreens: OffscreenSpec[],
  drawableBlend: number[],
  expectedTotals: number[],
): Uint8Array {
  const partIds = names("part.id");
  const owners = offscreens.map((o) => {
    const p = partIds.indexOf(o.owner);
    if (p < 0) throw new Error(`craft: no part ${o.owner}`);
    return p;
  });
  return craftDeepseek(
    (f, x) => {
      const partFirst = arr("part.firstKeyform");
      const partCount = arr("part.keyformCount");
      const partOffscreen = new Array<number>(partIds.length).fill(-1);
      owners.forEach((p, o) => (partOffscreen[p] = o));
      f["part.offscreen"] = partOffscreen;
      f["offscreen.part"] = owners;
      f["offscreen.flags"] = offscreens.map(() => 4);
      f["offscreen.blendMode"] = offscreens.map((o) => o.blend);
      f["offscreen.firstMask"] = offscreens.map((o) => o.masks?.first ?? 0);
      f["offscreen.maskCount"] = offscreens.map((o) => o.masks?.count ?? 0);
      const map = new Array<number>(arr("partKeyform.drawOrder").length).fill(-1);
      const opacity: number[] = [];
      const color: number[] = [];
      offscreens.forEach((o, i) => {
        const p = owners[i]!;
        if (o.opacities.length !== partCount[p])
          throw new Error(`craft: ${o.owner} has ${partCount[p]} keyforms`);
        for (let k = 0; k < partCount[p]!; k++) {
          map[partFirst[p]! + k] = opacity.length;
          opacity.push(o.opacities[k]!);
          color.push(o.color(k));
        }
      });
      f["partKeyform.offscreenKeyform"] = map;
      f["offscreenKeyform.opacity"] = opacity;
      f["offscreenKeyform.multiplyColor"] = color;
      f["offscreenKeyform.screenColor"] = color;
      f["mesh.blendMode"] = drawableBlend;
      const totals = groupTotals(f, partOffscreen);
      if (totals.slice(0, expectedTotals.length).join() !== expectedTotals.join())
        throw new Error(`craft: group totals ${totals.slice(0, 4)} (expected ${expectedTotals})`);
      f["group.entryCount"] = totals;
      x.counts[35] = offscreens.length;
      x.counts[36] = opacity.length;
      x.counts[37] = 0;
    },
    { version: 6 },
  );
}

function maskList(mesh: string): { first: number; count: number } {
  const m = names("mesh.id").indexOf(mesh);
  return { first: arr("mesh.firstMask")[m]!, count: arr("mesh.maskCount")[m]! };
}

/** P4: the v6 variant with offscreens on Part114, Part18 and Part30. */
export function craftV6(): Uint8Array {
  return craftOffscreens(
    [
      { owner: "Part114", blend: 0x000, opacities: [0.85], color: (k) => 6510 + k },
      { owner: "Part18", blend: 0x106, opacities: [0.5, 0.9, 0.7], color: (k) => 6538 + k },
      {
        owner: "Part30",
        blend: 0x200,
        masks: maskList("ArtMesh94"),
        opacities: [1, 0.6, 0.3],
        color: (k) => 7002 + k,
      },
    ],
    blendCodesFromFlags({ mesh: "ArtMesh94", code: 0x10e }),
    [718, 44, 21, 21],
  );
}

/**
 * P5: q2c and q2d. Offscreens on Part18 and Part30, blend code 0, opacity 1,
 * color index 0, drawable blend codes from the flags with no exception, and
 * ArtMesh507's mask list on both offscreens (q2c) or only on Part30's (q2d).
 */
export function craftQ2(variant: "q2c" | "q2d"): Uint8Array {
  const masks = maskList("ArtMesh507");
  return craftOffscreens(
    [
      {
        owner: "Part18",
        blend: 0,
        ...(variant === "q2c" ? { masks } : {}),
        opacities: [1, 1, 1],
        color: () => 0,
      },
      { owner: "Part30", blend: 0, masks, opacities: [1, 1, 1], color: () => 0 },
    ],
    blendCodesFromFlags(),
    [717, 44, 21, 21],
  );
}

/** P6: the craft with the last key of `binding` set to `value`. */
export function craftNarrowedKey(binding: number, value: number): Uint8Array {
  return craftDeepseek((f) => setLastKey(f, binding, value));
}

/** P7: q4c, ArtMesh197's keyforms edited (opacity, draw order, colors) and group 0 widened. */
export function craftQ4c(): Uint8Array {
  const m197 = names("mesh.id").indexOf("ArtMesh197");
  const first = arr("mesh.firstKeyform")[m197]!;
  const firstColor = arr("mesh.firstColor")[m197]!;
  if (firstColor !== 6370) throw new Error(`craft q4c: ArtMesh197's first color is ${firstColor}`);
  return craftDeepseek((f) => {
    const set = (k: FieldKey, i: number, v: number) => ((f[k] as number[])[i] = v);
    set("meshKeyform.opacity", first, 1);
    set("meshKeyform.opacity", first + 1, 0.2);
    set("meshKeyform.drawOrder", first, 300);
    set("meshKeyform.drawOrder", first + 1, 700);
    const mul = [
      [1, 1, 1],
      [0.2, 0.4, 0.6],
    ];
    const scr = [
      [0, 0, 0],
      [0.5, 0.3, 0.1],
    ];
    for (let k = 0; k < 2; k++)
      (["r", "g", "b"] as const).forEach((ch, c) => {
        set(`multiplyColor.${ch}`, firstColor + k, mul[k]![c]!);
        set(`screenColor.${ch}`, firstColor + k, scr[k]![c]!);
      });
    set("group.maxDrawOrder", 0, 1000);
    set("group.minDrawOrder", 0, 0);
  });
}

// --- P8: validation crafts, as byte edits of the original file ---

/** Byte-level access to a little-endian version-5 file (P8 recipes). */
class RawMoc {
  readonly dv: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  slot(s: number): number {
    return this.dv.getUint32(64 + 4 * s, true);
  }
  setSlot(s: number, v: number): void {
    this.dv.setUint32(64 + 4 * s, v, true);
  }
  count(k: number): number {
    return this.dv.getInt32(this.slot(0) + 4 * k, true);
  }
  setCount(k: number, v: number): void {
    this.dv.setInt32(this.slot(0) + 4 * k, v, true);
  }
  private spec(s: number) {
    const f = FIELDS.find((x) => x.slot === s);
    if (!f) throw new Error(`no field in slot ${s}`);
    return f;
  }
  /** Element `i` of slot `s` (by the slot's element type). */
  get(s: number, i: number): number {
    const f = this.spec(s);
    const o = this.slot(s) + i * ELEMENT_SIZE[f.type];
    switch (f.type) {
      case "i32":
        return this.dv.getInt32(o, true);
      case "f32":
        return this.dv.getFloat32(o, true);
      case "u16":
        return this.dv.getUint16(o, true);
      case "u8":
        return this.dv.getUint8(o);
      default:
        throw new Error(`slot ${s} holds ${f.type}`);
    }
  }
  set(s: number, i: number, v: number): void {
    const f = this.spec(s);
    const o = this.slot(s) + i * ELEMENT_SIZE[f.type];
    switch (f.type) {
      case "i32":
        return this.dv.setInt32(o, v, true);
      case "f32":
        return this.dv.setFloat32(o, v, true);
      case "u16":
        return this.dv.setUint16(o, v, true);
      case "u8":
        return this.dv.setUint8(o, v);
      default:
        throw new Error(`slot ${s} holds ${f.type}`);
    }
  }
}

export interface ValidationCase {
  name: string;
  /** The official runtime's verdict (P8). */
  official: "accept" | "reject";
  /** What Mochi2D must do (1b.7). */
  required: "accept" | "reject";
  edit: (m: RawMoc) => Uint8Array | void;
}

const A = "accept" as const;
const R = "reject" as const;
const resized = (m: RawMoc, length: number) => {
  const out = new Uint8Array(length);
  out.set(m.bytes.subarray(0, Math.min(length, m.bytes.length)));
  return out;
};

/** The cases of P8 in table order (41), then 20 more (entries of every kind, and S6). */
export const VALIDATION_CASES: readonly ValidationCase[] = [
  { name: "unmodified", official: A, required: A, edit: () => {} },
  { name: "magic", official: R, required: R, edit: (m) => void (m.bytes[0] = 0x58) },
  { name: "version-0", official: R, required: R, edit: (m) => void (m.bytes[4] = 0) },
  { name: "version-7", official: R, required: R, edit: (m) => void (m.bytes[4] = 7) },
  { name: "endian", official: R, required: R, edit: (m) => void (m.bytes[5] = 1) },
  { name: "truncated", official: R, required: R, edit: (m) => resized(m, m.bytes.length - 64) },
  { name: "extra-64", official: A, required: A, edit: (m) => resized(m, m.bytes.length + 64) },
  { name: "extra-3", official: R, required: R, edit: (m) => resized(m, m.bytes.length + 3) },
  { name: "misaligned-3", official: A, required: A, edit: (m) => m.setSlot(3, m.slot(3) + 4) },
  { name: "misaligned-50", official: A, required: A, edit: (m) => m.setSlot(50, m.slot(50) + 4) },
  {
    name: "section-eof",
    official: R,
    required: R,
    edit: (m) => m.setSlot(71, m.bytes.length + 64),
  },
  { name: "count-negative", official: R, required: R, edit: (m) => m.setCount(0, -1) },
  {
    name: "count-positions",
    official: R,
    required: R,
    edit: (m) => m.setCount(10, m.count(10) + 1000),
  },
  { name: "part-parent-high", official: R, required: R, edit: (m) => m.set(9, 1, m.count(0)) },
  { name: "part-parent-low", official: R, required: R, edit: (m) => m.set(9, 1, -2) },
  { name: "part-parent-self", official: A, required: R, edit: (m) => m.set(9, 1, 1) },
  {
    name: "deformer-parent-forward",
    official: A,
    required: R,
    edit: (m) => m.set(16, 0, m.count(1) - 1),
  },
  { name: "deformer-parent-self", official: A, required: R, edit: (m) => m.set(16, 1, 1) },
  { name: "deformer-kind", official: R, required: R, edit: (m) => m.set(17, 0, 2) },
  { name: "deformer-index", official: R, required: R, edit: (m) => m.set(18, 0, 100000) },
  { name: "mesh-parent", official: R, required: R, edit: (m) => m.set(40, 0, m.count(1)) },
  { name: "texture-negative", official: R, required: R, edit: (m) => m.set(41, 0, -1) },
  {
    name: "triangle-index",
    official: A,
    required: R,
    edit: (m) => m.set(79, m.get(45, 0), m.get(43, 0)),
  },
  { name: "triangle-count", official: A, required: R, edit: (m) => m.set(46, 0, m.get(46, 0) - 1) },
  { name: "keyform-count", official: A, required: R, edit: (m) => m.set(36, 0, m.get(36, 0) + 1) },
  { name: "band", official: R, required: R, edit: (m) => m.set(34, 0, m.count(12)) },
  { name: "uv-begin", official: R, required: R, edit: (m) => m.set(44, 0, m.count(15)) },
  { name: "mask-index", official: R, required: R, edit: (m) => m.set(80, 0, m.count(4)) },
  { name: "vertex-count-0", official: A, required: R, edit: (m) => m.set(43, 0, 0) },
  { name: "position-begin", official: R, required: R, edit: (m) => m.set(70, 0, m.count(10)) },
  { name: "binding-no-keys", official: A, required: R, edit: (m) => m.set(76, 0, 0) },
  {
    name: "keys-unsorted",
    official: A,
    required: R,
    edit: (m) => {
      const a = m.get(77, 0);
      m.set(77, 0, m.get(77, 1));
      m.set(77, 1, a);
    },
  },
  { name: "binding-index", official: R, required: R, edit: (m) => m.set(72, 0, m.count(13)) },
  { name: "min-above-max", official: A, required: R, edit: (m) => m.set(52, 0, 100) },
  { name: "default-outside", official: A, required: A, edit: (m) => m.set(53, 0, 1000) },
  { name: "warp-grid", official: R, required: R, edit: (m) => m.set(23, 0, m.get(23, 0) + 1) },
  { name: "draw-order-index", official: R, required: R, edit: (m) => m.set(87, 0, m.count(4)) },
  { name: "draw-order-kind", official: R, required: R, edit: (m) => m.set(86, 0, 2) },
  {
    name: "ppu-0",
    official: A,
    required: A,
    edit: (m) => m.dv.setFloat32(m.slot(1), 0, true),
  },
  {
    name: "name-no-nul",
    official: R,
    required: R,
    edit: (m) => void m.bytes.fill(0x41, m.slot(3), m.slot(3) + 64),
  },
  {
    name: "duplicate-ids",
    official: A,
    required: A,
    edit: (m) => m.bytes.copyWithin(m.slot(3) + 64, m.slot(3), m.slot(3) + 64),
  },
  // Entries checked for every kind (listed or not), then rows for S6's verdicts.
  { name: "mask-index-low", official: R, required: R, edit: (m) => m.set(80, 0, -2) },
  { name: "deformer-parent-low", official: R, required: R, edit: (m) => m.set(16, 1, -2) },
  {
    name: "deformer-parent-high",
    official: R,
    required: R,
    edit: (m) => m.set(16, 1, m.count(1)),
  },
  { name: "part-band", official: R, required: R, edit: (m) => m.set(4, 0, m.count(12)) },
  { name: "deformer-band", official: R, required: R, edit: (m) => m.set(12, 0, m.count(12)) },
  { name: "warp-band", official: R, required: R, edit: (m) => m.set(19, 0, m.count(12)) },
  { name: "rotation-band", official: R, required: R, edit: (m) => m.set(25, 0, m.count(12)) },
  { name: "glue-band", official: R, required: R, edit: (m) => m.set(91, 0, m.count(12)) },
  {
    name: "draw-order-unlisted-kind",
    official: R,
    required: R,
    // One appended draw-order object of kind 2 that no group lists.
    edit: () =>
      craftDeepseek((f, x) => {
        (f["groupObject.kind"] as number[]).push(2);
        (f["groupObject.index"] as number[]).push(0);
        (f["groupObject.nestedGroup"] as number[]).push(-1);
        x.counts[19]!++;
      }),
  },
  // Art keyform 0 belongs to mesh 0, so the official level tests it with its own run:
  // a start of −1 passes it (only the run's end is tested).
  { name: "position-start-low", official: A, required: R, edit: (m) => m.set(70, 0, -1) },
  {
    name: "blend-position-end",
    official: A,
    required: R,
    edit: (m) => m.set(70, firstBlendMeshKeyform(m), m.count(10)),
  },
  {
    name: "blend-position-low",
    official: A,
    required: R,
    edit: (m) => m.set(70, firstBlendMeshKeyform(m), -1),
  },
  {
    name: "draw-order-part-no-child",
    official: A,
    required: R,
    edit: (m) => m.set(88, firstPartEntry(m).entry, -1),
  },
  {
    name: "draw-order-part-cycle",
    official: A,
    required: R,
    edit: (m) => {
      const p = firstPartEntry(m);
      m.set(88, p.entry, p.group);
    },
  },
  {
    // A "reject / accept" row: art keyform 238 (of mesh 206, 44 floats) moved so
    // that its own run ends exactly at the array's end. The official level tests it with
    // mesh 238's 190 floats and rejects the file; Mochi2D keeps that verdict (P8: reject
    // what the check rejects).
    name: "position-run-index",
    official: R,
    required: R,
    edit: (m) => m.set(70, 238, m.count(10) - mismatchedRun(m, 238)),
  },
  { name: "color-index-n", official: A, required: R, edit: (m) => m.set(141, 0, m.count(23)) },
  {
    name: "color-index-n-plus-1",
    official: R,
    required: R,
    edit: (m) => m.set(141, 0, m.count(23) + 1),
  },
  { name: "color-range", official: R, required: R, edit: (m) => m.set(107, 0, m.count(23)) },
  { name: "flag-value", official: R, required: R, edit: (m) => m.set(37, 0, 2) },
  { name: "decimals-negative", official: R, required: R, edit: (m) => m.set(55, 0, -1) },
];

/** The first blend-shape keyform of an art mesh (that of the first art-mesh target's first binding). */
function firstBlendMeshKeyform(m: RawMoc): number {
  return m.get(121, m.get(129, 0));
}

/** The first draw-order object of kind 1 (a part) that a group lists, and that group. */
function firstPartEntry(m: RawMoc): { entry: number; group: number } {
  for (let g = 0; g < m.count(18); g++)
    for (let i = m.get(81, g); i < m.get(81, g) + m.get(82, g); i++)
      if (m.get(86, i) === 1) return { entry: i, group: g };
  throw new Error("no part in any draw-order group");
}

/**
 * The own run length (floats) of art keyform k, checking that it is shorter than
 * that of mesh k, which the official level tests it with.
 */
function mismatchedRun(m: RawMoc, k: number): number {
  for (let i = 0; i < m.count(4); i++)
    if (k >= m.get(35, i) && k < m.get(35, i) + m.get(36, i)) {
      const own = 2 * m.get(43, i);
      if (i !== k && own < 2 * m.get(43, k)) return own;
      break;
    }
  throw new Error(`art keyform ${k} does not have a shorter run than mesh ${k}`);
}

/** The file of validation case `name`. */
export function craftValidation(name: string): Uint8Array {
  const c = VALIDATION_CASES.find((v) => v.name === name);
  if (!c) throw new Error(`no validation case ${name}`);
  const m = new RawMoc(Uint8Array.from(deepseekMocBytes()));
  return c.edit(m) ?? m.bytes;
}

/** A moc craft of 4p: its folder name under `crafts/` and how to build its `m.moc3`. */
export interface MocCraft {
  name: string;
  recipe: string;
  build: () => Uint8Array;
}

const relabel = (byte: number, value: number) => () => {
  const b = Uint8Array.from(deepseekMocBytes());
  b[byte] = value;
  return b;
};

/** Every moc craft of 4p (P1–P8) plus `texbig`'s unmodified copy (4s). */
export function mocCrafts(): MocCraft[] {
  const out: MocCraft[] = [];
  for (const v of [1, 2, 3, 4])
    out.push({ name: `ds-v${v}`, recipe: `P1, version byte ${v}`, build: relabel(4, v) });
  out.push({
    name: "ds-canvasflag",
    recipe: "P2, canvas flags bit 0",
    build: () => craftDeepseek((_, x) => void (x.canvas.flags |= 1)),
  });
  out.push({
    name: "ds-bigendian",
    recipe: "P3, big-endian",
    build: () => craftDeepseek(undefined, { bigEndian: true }),
  });
  out.push({ name: "ds-v6", recipe: "P4, v6 with three offscreens", build: craftV6 });
  out.push({ name: "q2c", recipe: "P5, masks on both offscreens", build: () => craftQ2("q2c") });
  out.push({ name: "q2d", recipe: "P5, masks on Part30's offscreen", build: () => craftQ2("q2d") });
  out.push({
    name: "q3a",
    recipe: "P6, binding 46 last key 0.5",
    build: () => craftNarrowedKey(46, 0.5),
  });
  out.push({
    name: "q3b",
    recipe: "P6, binding 104 last key 0.85",
    build: () => craftNarrowedKey(104, 0.85),
  });
  out.push({
    name: "qm-eye",
    recipe: "P6, binding 42 last key 1.25",
    build: () => craftNarrowedKey(42, 1.25),
  });
  out.push({ name: "q4c", recipe: "P7", build: craftQ4c });
  for (const c of VALIDATION_CASES)
    out.push({
      name: `val-${c.name}`,
      recipe: `P8, ${c.name}`,
      build: () => craftValidation(c.name),
    });
  out.push({
    name: "texbig",
    recipe: "4s, unmodified moc; texture_00 replaced",
    build: () => deepseekMocBytes(),
  });
  return out;
}

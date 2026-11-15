/**
 * Builder for synthetic `.moc3` files (any version 1–6) used by unit tests.
 * It lays out raw arrays the way the format requires (contiguous binding
 * ownership, keyform runs, shared pools, version-specific colors) and writes
 * them with src/core/moc/write.ts.
 */
import { writeMoc } from "../../src/core/moc/write.js";
import type { FieldKey } from "../../src/core/moc/schema.js";
import type { MocCanvas } from "../../src/core/moc/read.js";

export type RGB = [number, number, number];

export interface ColorPair {
  multiply?: RGB;
  screen?: RGB;
}
export interface PartKeyform {
  drawOrder: number;
}
export interface WarpKeyform extends ColorPair {
  opacity?: number;
  points: number[];
}
export interface RotationKeyform extends ColorPair {
  opacity?: number;
  angle: number;
  x: number;
  y: number;
  scale: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
}
export interface MeshKeyform extends ColorPair {
  opacity?: number;
  drawOrder?: number;
  positions: number[];
}
export interface OffscreenKeyform extends ColorPair {
  opacity: number;
}

export interface Constraint {
  param: number;
  keys: number[];
  weights: number[];
}

/** Blend-shape target kinds; "offscreen" (v6) takes offscreen keyforms. */
export type TargetKind = "warp" | "mesh" | "part" | "rotation" | "glue" | "offscreen";

interface BlendShape {
  kind: TargetKind;
  object: number;
  param: number;
  keys: number[];
  base: number;
  keyforms: unknown[];
  constraints: Constraint[];
}

export class Synth {
  canvas: MocCanvas = { pixelsPerUnit: 1, originX: 0, originY: 0, width: 2, height: 2, flags: 0 };
  private params: {
    id: string;
    min: number;
    max: number;
    def: number;
    repeat: boolean;
    type: number;
    keyList?: number[];
  }[] = [];
  private bindings: { param: number; keys: number[] }[] = [];
  private bands: number[][] = [[]];
  private parts: {
    id: string;
    band: number;
    keyforms: PartKeyform[];
    initial: number;
    enabled: number;
    parent: number;
    offscreen: number;
  }[] = [];
  private deformers: {
    id: string;
    band: number;
    enabled: number;
    part: number;
    parent: number;
    kind: 0 | 1;
    kindIndex: number;
  }[] = [];
  private warps: { rows: number; cols: number; bilinear: number; keyforms: WarpKeyform[] }[] = [];
  private rotations: { baseAngle: number; keyforms: RotationKeyform[] }[] = [];
  private meshes: {
    id: string;
    band: number;
    enabled: number;
    part: number;
    deformer: number;
    texture: number;
    flags: number;
    blendMode: number;
    uvs: number[];
    triangles: number[];
    masks: number[];
    keyforms: MeshKeyform[];
  }[] = [];
  private glues: {
    id: string;
    band: number;
    a: number;
    b: number;
    pairs: [number, number, number, number][];
    intensities: number[];
  }[] = [];
  private blendShapes: BlendShape[] = [];
  private offscreens: {
    part: number;
    flags: number;
    blendMode: number;
    masks: number[];
    keyforms: OffscreenKeyform[];
  }[] = [];
  groups:
    | { objects: { kind: 0 | 1; index: number; nested?: number }[]; min: number; max: number }[]
    | null = null;

  constructor(readonly version: number) {}

  param(
    id: string,
    min: number,
    max: number,
    def = 0,
    opts: { repeat?: boolean; type?: number; keyList?: number[] } = {},
  ): number {
    this.params.push({
      id,
      min,
      max,
      def,
      repeat: opts.repeat ?? false,
      type: opts.type ?? 0,
      ...(opts.keyList ? { keyList: opts.keyList } : {}),
    });
    return this.params.length - 1;
  }

  /** A parameter binding (interpolation axis). Returns its builder index. */
  binding(param: number, keys: number[]): number {
    this.bindings.push({ param, keys });
    return this.bindings.length - 1;
  }

  /** A keyform binding listing parameter bindings, innermost first. Band 0 is empty. */
  band(bindings: number[]): number {
    this.bands.push(bindings);
    return this.bands.length - 1;
  }

  part(o: {
    id: string;
    band?: number;
    keyforms?: PartKeyform[];
    initial?: number;
    enabled?: boolean;
    parent?: number;
  }): number {
    this.parts.push({
      id: o.id,
      band: o.band ?? 0,
      keyforms: o.keyforms ?? [{ drawOrder: 500 }],
      initial: o.initial ?? 1,
      enabled: o.enabled === false ? 0 : 1,
      parent: o.parent ?? -1,
      offscreen: -1,
    });
    return this.parts.length - 1;
  }

  warp(o: {
    id: string;
    band?: number;
    part?: number;
    parent?: number;
    enabled?: boolean;
    rows: number;
    cols: number;
    bilinear?: boolean;
    keyforms: WarpKeyform[];
  }): number {
    this.warps.push({
      rows: o.rows,
      cols: o.cols,
      bilinear: o.bilinear ? 1 : 0,
      keyforms: o.keyforms,
    });
    this.deformers.push({
      id: o.id,
      band: o.band ?? 0,
      enabled: o.enabled === false ? 0 : 1,
      part: o.part ?? 0,
      parent: o.parent ?? -1,
      kind: 0,
      kindIndex: this.warps.length - 1,
    });
    return this.deformers.length - 1;
  }

  rotation(o: {
    id: string;
    band?: number;
    part?: number;
    parent?: number;
    enabled?: boolean;
    baseAngle?: number;
    keyforms: RotationKeyform[];
  }): number {
    this.rotations.push({ baseAngle: o.baseAngle ?? 0, keyforms: o.keyforms });
    this.deformers.push({
      id: o.id,
      band: o.band ?? 0,
      enabled: o.enabled === false ? 0 : 1,
      part: o.part ?? 0,
      parent: o.parent ?? -1,
      kind: 1,
      kindIndex: this.rotations.length - 1,
    });
    return this.deformers.length - 1;
  }

  mesh(o: {
    id: string;
    band?: number;
    part?: number;
    deformer?: number;
    enabled?: boolean;
    texture?: number;
    flags?: number;
    blendMode?: number;
    uvs?: number[];
    triangles?: number[];
    masks?: number[];
    keyforms: MeshKeyform[];
  }): number {
    const V = o.keyforms[0]!.positions.length / 2;
    this.meshes.push({
      id: o.id,
      band: o.band ?? 0,
      enabled: o.enabled === false ? 0 : 1,
      part: o.part ?? 0,
      deformer: o.deformer ?? -1,
      texture: o.texture ?? 0,
      flags: o.flags ?? 4,
      blendMode: o.blendMode ?? 0,
      uvs: o.uvs ?? new Array(2 * V).fill(0),
      triangles: o.triangles ?? (V >= 3 ? [0, 1, 2] : []),
      masks: o.masks ?? [],
      keyforms: o.keyforms,
    });
    return this.meshes.length - 1;
  }

  glue(o: {
    id: string;
    band?: number;
    a: number;
    b: number;
    pairs: [va: number, wa: number, vb: number, wb: number][];
    intensities?: number[];
  }): number {
    this.glues.push({
      id: o.id,
      band: o.band ?? 0,
      a: o.a,
      b: o.b,
      pairs: o.pairs,
      intensities: o.intensities ?? [1],
    });
    return this.glues.length - 1;
  }

  /** Blend shape on a target object; keyforms have the target kind's shape (one per key). */
  blendShape(
    kind: TargetKind,
    object: number,
    o: {
      param: number;
      keys: number[];
      base: number;
      keyforms: unknown[];
      constraints?: Constraint[];
    },
  ): void {
    this.blendShapes.push({
      kind,
      object,
      param: o.param,
      keys: o.keys,
      base: o.base,
      keyforms: o.keyforms,
      constraints: o.constraints ?? [],
    });
  }

  /** v6: makes `part` own an offscreen; one offscreen keyform per part keyform. */
  offscreen(o: {
    part: number;
    flags?: number;
    blendMode?: number;
    masks?: number[];
    keyforms: OffscreenKeyform[];
  }): number {
    this.offscreens.push({
      part: o.part,
      flags: o.flags ?? 4,
      blendMode: o.blendMode ?? 0,
      masks: o.masks ?? [],
      keyforms: o.keyforms,
    });
    const index = this.offscreens.length - 1;
    this.parts[o.part]!.offscreen = index;
    return index;
  }

  /** Raw arrays for the writer (tests may tamper with them before writing). */
  fields(): Partial<Record<FieldKey, number[] | string[]>> {
    const v = this.version;
    const F: Partial<Record<FieldKey, number[] | string[]>> = {};
    const arr = (k: FieldKey): number[] => (F[k] ??= []) as number[];
    const names = (k: FieldKey): string[] => (F[k] ??= []) as string[];
    const keys = arr("keys");
    const positions = arr("positions");

    // Parameters own contiguous binding ranges: order bindings by parameter.
    const order = this.bindings
      .map((b, i) => ({ b, i }))
      .sort((x, y) => x.b.param - y.b.param || x.i - y.i);
    const remap = new Map(order.map((o, newIndex) => [o.i, newIndex]));
    for (const { b } of order) {
      arr("binding.firstKey").push(keys.length);
      arr("binding.keyCount").push(b.keys.length);
      keys.push(...b.keys);
    }
    // Blend-shape parameter bindings, owned contiguously as well.
    const bsByParam = this.blendShapes
      .map((bs, i) => ({ bs, i }))
      .sort((x, y) => x.bs.param - y.bs.param || x.i - y.i);
    const bsBindingOf = new Map<number, number>();
    bsByParam.forEach(({ bs, i }, newIndex) => {
      bsBindingOf.set(i, newIndex);
      arr("bsBinding.firstKey").push(keys.length);
      arr("bsBinding.keyCount").push(bs.keys.length);
      arr("bsBinding.baseKey").push(bs.base);
      keys.push(...bs.keys);
    });
    this.params.forEach((p, pi) => {
      names("parameter.id").push(p.id);
      arr("parameter.min").push(p.min);
      arr("parameter.max").push(p.max);
      arr("parameter.default").push(p.def);
      arr("parameter.repeat").push(p.repeat ? 1 : 0);
      arr("parameter.decimals").push(3);
      const owned = order.map((o, idx) => (o.b.param === pi ? idx : -1)).filter((x) => x >= 0);
      arr("parameter.firstBinding").push(owned.length ? owned[0]! : 0);
      arr("parameter.bindingCount").push(owned.length);
      if (v >= 4) {
        const list =
          p.keyList ??
          [...new Set(order.filter((o) => o.b.param === pi).flatMap((o) => o.b.keys))].sort(
            (a, b) => a - b,
          );
        arr("parameter.firstKey").push(keys.length);
        arr("parameter.keyCount").push(list.length);
        keys.push(...list);
        arr("parameter.type").push(p.type);
        const bsOwned = bsByParam
          .map((o, idx) => (o.bs.param === pi ? idx : -1))
          .filter((x) => x >= 0);
        arr("parameter.firstBlendShapeBinding").push(bsOwned.length ? bsOwned[0]! : 0);
        arr("parameter.blendShapeBindingCount").push(bsOwned.length);
      }
    });
    // Bands.
    for (const b of this.bands) {
      arr("band.firstEntry").push(arr("bindingIndex").length);
      arr("band.entryCount").push(b.length);
      for (const x of b) arr("bindingIndex").push(remap.get(x)!);
    }
    // Colors.
    const colorEntry = (c: ColorPair): number => {
      const m = c.multiply ?? [1, 1, 1];
      const s = c.screen ?? [0, 0, 0];
      arr("multiplyColor.r").push(m[0]);
      arr("multiplyColor.g").push(m[1]);
      arr("multiplyColor.b").push(m[2]);
      arr("screenColor.r").push(s[0]);
      arr("screenColor.g").push(s[1]);
      arr("screenColor.b").push(s[2]);
      return arr("multiplyColor.r").length - 1;
    };
    const keyformColors = (
      prefix: "warpKeyform" | "rotationKeyform" | "meshKeyform" | "offscreenKeyform",
      c: ColorPair,
    ) => {
      if (v < 5) return;
      const e = colorEntry(c);
      arr(`${prefix}.multiplyColor` as FieldKey).push(e);
      arr(`${prefix}.screenColor` as FieldKey).push(e);
    };
    const v4FirstColor = (kfs: ColorPair[]): number => {
      const first = arr("multiplyColor.r").length;
      for (const k of kfs) colorEntry(k);
      return first;
    };
    // Parts.
    const offscreenKeyformBase = new Map<number, number>();
    let offKf = 0;
    for (let o = 0; o < this.offscreens.length; o++) {
      offscreenKeyformBase.set(o, offKf);
      offKf += this.offscreens[o]!.keyforms.length;
    }
    for (const p of this.parts) {
      names("part.id").push(p.id);
      arr("part.band").push(p.band);
      arr("part.firstKeyform").push(arr("partKeyform.drawOrder").length);
      arr("part.keyformCount").push(p.keyforms.length);
      arr("part.initiallyVisible").push(p.initial);
      arr("part.enabled").push(p.enabled);
      arr("part.parent").push(p.parent);
      if (v >= 6) arr("part.offscreen").push(p.offscreen);
      p.keyforms.forEach((k, ki) => {
        arr("partKeyform.drawOrder").push(k.drawOrder);
        if (v >= 6)
          arr("partKeyform.offscreenKeyform").push(
            p.offscreen >= 0 ? offscreenKeyformBase.get(p.offscreen)! + ki : -1,
          );
      });
    }
    // Deformers.
    for (const d of this.deformers) {
      names("deformer.id").push(d.id);
      arr("deformer.band").push(d.band);
      arr("deformer.visible").push(1);
      arr("deformer.enabled").push(d.enabled);
      arr("deformer.part").push(d.part);
      arr("deformer.parent").push(d.parent);
      arr("deformer.kind").push(d.kind);
      arr("deformer.kindIndex").push(d.kindIndex);
    }
    const bandOfWarp = (w: number) =>
      this.deformers.find((d) => d.kind === 0 && d.kindIndex === w)!.band;
    const bandOfRot = (r: number) =>
      this.deformers.find((d) => d.kind === 1 && d.kindIndex === r)!.band;
    const pushWarpKeyform = (k: WarpKeyform) => {
      arr("warpKeyform.opacity").push(k.opacity ?? 1);
      arr("warpKeyform.firstPosition").push(positions.length);
      positions.push(...k.points);
      keyformColors("warpKeyform", k);
    };
    this.warps.forEach((w, wi) => {
      arr("warp.band").push(bandOfWarp(wi));
      arr("warp.firstKeyform").push(arr("warpKeyform.opacity").length);
      arr("warp.keyformCount").push(w.keyforms.length);
      arr("warp.pointCount").push((w.rows + 1) * (w.cols + 1));
      arr("warp.rows").push(w.rows);
      arr("warp.columns").push(w.cols);
      if (v >= 2) arr("warp.bilinear").push(w.bilinear);
      if (v === 4) arr("warp.firstColor").push(v4FirstColor(w.keyforms));
      else if (v > 4) arr("warp.firstColor").push(arr("multiplyColor.r").length);
      w.keyforms.forEach(pushWarpKeyform);
    });
    const pushRotationKeyform = (k: RotationKeyform) => {
      arr("rotationKeyform.opacity").push(k.opacity ?? 1);
      arr("rotationKeyform.angle").push(k.angle);
      arr("rotationKeyform.originX").push(k.x);
      arr("rotationKeyform.originY").push(k.y);
      arr("rotationKeyform.scale").push(k.scale);
      arr("rotationKeyform.mirrorX").push(k.mirrorX ? 1 : 0);
      arr("rotationKeyform.mirrorY").push(k.mirrorY ? 1 : 0);
      keyformColors("rotationKeyform", k);
    };
    this.rotations.forEach((r, ri) => {
      arr("rotation.band").push(bandOfRot(ri));
      arr("rotation.firstKeyform").push(arr("rotationKeyform.angle").length);
      arr("rotation.keyformCount").push(r.keyforms.length);
      arr("rotation.baseAngle").push(r.baseAngle);
      if (v === 4) arr("rotation.firstColor").push(v4FirstColor(r.keyforms));
      else if (v > 4) arr("rotation.firstColor").push(arr("multiplyColor.r").length);
      r.keyforms.forEach(pushRotationKeyform);
    });
    // Meshes.
    const pushMeshKeyform = (k: MeshKeyform) => {
      arr("meshKeyform.opacity").push(k.opacity ?? 1);
      arr("meshKeyform.drawOrder").push(k.drawOrder ?? 500);
      arr("meshKeyform.firstPosition").push(positions.length);
      positions.push(...k.positions);
      keyformColors("meshKeyform", k);
    };
    for (const m of this.meshes) {
      names("mesh.id").push(m.id);
      arr("mesh.band").push(m.band);
      arr("mesh.firstKeyform").push(arr("meshKeyform.opacity").length);
      arr("mesh.keyformCount").push(m.keyforms.length);
      arr("mesh.visible").push(1);
      arr("mesh.enabled").push(m.enabled);
      arr("mesh.part").push(m.part);
      arr("mesh.deformer").push(m.deformer);
      arr("mesh.texture").push(m.texture);
      arr("mesh.flags").push(m.flags);
      arr("mesh.vertexCount").push(m.keyforms[0]!.positions.length / 2);
      arr("mesh.firstUv").push(arr("uvs").length);
      arr("uvs").push(...m.uvs);
      arr("mesh.firstTriangleIndex").push(arr("triangleIndices").length);
      arr("mesh.triangleIndexCount").push(m.triangles.length);
      arr("triangleIndices").push(...m.triangles);
      arr("mesh.firstMask").push(arr("maskEntries").length);
      arr("mesh.maskCount").push(m.masks.length);
      arr("maskEntries").push(...m.masks);
      if (v === 4) arr("mesh.firstColor").push(v4FirstColor(m.keyforms));
      else if (v > 4) arr("mesh.firstColor").push(arr("multiplyColor.r").length);
      if (v >= 6) arr("mesh.blendMode").push(m.blendMode);
      m.keyforms.forEach(pushMeshKeyform);
    }
    // Glues.
    for (const g of this.glues) {
      names("glue.id").push(g.id);
      arr("glue.band").push(g.band);
      arr("glue.firstKeyform").push(arr("glueKeyform.intensity").length);
      arr("glue.keyformCount").push(g.intensities.length);
      arr("glueKeyform.intensity").push(...g.intensities);
      arr("glue.meshA").push(g.a);
      arr("glue.meshB").push(g.b);
      arr("glue.firstInfo").push(arr("glueInfo.weight").length);
      arr("glue.infoCount").push(2 * g.pairs.length);
      for (const [va, wa, vb, wb] of g.pairs) {
        arr("glueInfo.vertex").push(va, vb);
        arr("glueInfo.weight").push(wa, wb);
      }
    }
    // Offscreens.
    for (const o of this.offscreens) {
      arr("offscreen.part").push(o.part);
      arr("offscreen.flags").push(o.flags);
      arr("offscreen.blendMode").push(o.blendMode);
      arr("offscreen.firstMask").push(arr("maskEntries").length);
      arr("offscreen.maskCount").push(o.masks.length);
      arr("maskEntries").push(...o.masks);
      for (const k of o.keyforms) {
        arr("offscreenKeyform.opacity").push(k.opacity);
        keyformColors("offscreenKeyform", k);
      }
    }
    // Blend shapes: keyforms go after all normal keyforms of the target kind.
    if (v >= 4) {
      const targetRows = new Map<string, { object: number; bindings: number[] }>();
      this.blendShapes.forEach((bs, i) => {
        const kfBinding = arr("bsKeyformBinding.binding").length;
        arr("bsKeyformBinding.binding").push(bsBindingOf.get(i)!);
        let first: number;
        switch (bs.kind) {
          case "warp":
            first = arr("warpKeyform.opacity").length;
            (bs.keyforms as WarpKeyform[]).forEach(pushWarpKeyform);
            break;
          case "rotation":
            first = arr("rotationKeyform.angle").length;
            (bs.keyforms as RotationKeyform[]).forEach(pushRotationKeyform);
            break;
          case "mesh":
            first = arr("meshKeyform.opacity").length;
            (bs.keyforms as MeshKeyform[]).forEach(pushMeshKeyform);
            break;
          case "part":
            first = arr("partKeyform.drawOrder").length;
            for (const k of bs.keyforms as PartKeyform[]) {
              arr("partKeyform.drawOrder").push(k.drawOrder);
              if (v >= 6) arr("partKeyform.offscreenKeyform").push(-1);
            }
            break;
          case "glue":
            first = arr("glueKeyform.intensity").length;
            arr("glueKeyform.intensity").push(...(bs.keyforms as number[]));
            break;
          case "offscreen":
            // After every offscreen's normal keyforms; each with its own color entry.
            first = arr("offscreenKeyform.opacity").length;
            for (const k of bs.keyforms as OffscreenKeyform[]) {
              arr("offscreenKeyform.opacity").push(k.opacity);
              keyformColors("offscreenKeyform", k);
            }
            break;
        }
        arr("bsKeyformBinding.firstKeyform").push(first);
        arr("bsKeyformBinding.keyformCount").push(bs.keyforms.length);
        arr("bsKeyformBinding.firstConstraintEntry").push(arr("constraintIndex").length);
        arr("bsKeyformBinding.constraintEntryCount").push(bs.constraints.length);
        for (const c of bs.constraints) {
          arr("constraintIndex").push(arr("constraint.parameter").length);
          arr("constraint.parameter").push(c.param);
          arr("constraint.firstValue").push(arr("constraintValue.key").length);
          arr("constraint.valueCount").push(c.keys.length);
          arr("constraintValue.key").push(...c.keys);
          arr("constraintValue.weight").push(...c.weights);
        }
        const key = `${bs.kind}:${bs.object}`;
        const row = targetRows.get(key) ?? { object: bs.object, bindings: [] };
        row.bindings.push(kfBinding);
        targetRows.set(key, row);
      });
      // Target records need contiguous binding runs: bindings were appended per blend
      // shape, so group them by target in insertion order (tests add them per target).
      const prefix: Record<TargetKind, string> = {
        warp: "warpTarget",
        mesh: "meshTarget",
        part: "partTarget",
        rotation: "rotationTarget",
        glue: "glueTarget",
        offscreen: "offscreenTarget",
      };
      for (const [key, row] of targetRows) {
        const kind = key.split(":")[0] as TargetKind;
        const p = prefix[kind];
        const sorted = [...row.bindings].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i] !== sorted[i - 1]! + 1)
            throw new Error(`blend shapes of ${key} must be added consecutively`);
        }
        arr(`${p}.${kind}` as FieldKey).push(row.object);
        arr(`${p}.firstBinding` as FieldKey).push(sorted[0]!);
        arr(`${p}.bindingCount` as FieldKey).push(sorted.length);
      }
    }
    // Draw-order groups (default: one group with every mesh in file order).
    const groups = this.groups ?? [
      { objects: this.meshes.map((_, i) => ({ kind: 0 as const, index: i })), min: 0, max: 1000 },
    ];
    // Group totals: drawables plus offscreens of nested parts, recursively (C6).
    const total = (g: number): number =>
      groups[g]!.objects.reduce(
        (t, o) =>
          t + (o.kind === 0 ? 1 : (this.parts[o.index]!.offscreen >= 0 ? 1 : 0) + total(o.nested!)),
        0,
      );
    for (const [gi, g] of groups.entries()) {
      arr("group.firstObject").push(arr("groupObject.kind").length);
      arr("group.objectCount").push(g.objects.length);
      arr("group.entryCount").push(total(gi));
      arr("group.maxDrawOrder").push(g.max);
      arr("group.minDrawOrder").push(g.min);
      for (const o of g.objects) {
        arr("groupObject.kind").push(o.kind);
        arr("groupObject.index").push(o.index);
        arr("groupObject.nestedGroup").push(o.kind === 1 ? o.nested! : -1);
      }
    }
    return F;
  }

  build(
    opts: {
      bigEndian?: boolean;
      sectionShift?: number;
      tamper?: (f: Partial<Record<FieldKey, number[] | string[]>>) => void;
    } = {},
  ): Uint8Array {
    const f = this.fields();
    opts.tamper?.(f);
    return writeMoc({
      version: this.version,
      canvas: this.canvas,
      fields: f,
      ...(opts.bigEndian ? { bigEndian: true } : {}),
      ...(opts.sectionShift ? { sectionShift: opts.sectionShift } : {}),
    });
  }
}

/** The 5×5 grid of §1d.2 (row-major, float32). */
export function spec1d2Grid(): number[] {
  const out: number[] = [];
  for (let r = 0; r <= 5; r++) {
    for (let c = 0; c <= 5; c++) {
      out.push(Math.fround(-1 + (2 * c) / 5 + 0.05 * Math.sin(1.3 * c + 0.7 * r)));
      out.push(Math.fround(-1 + (2 * r) / 5 + 0.05 * Math.cos(0.9 * c - 1.1 * r)));
    }
  }
  return out;
}

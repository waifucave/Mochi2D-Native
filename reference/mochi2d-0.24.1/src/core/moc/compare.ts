/**
 * Two `.moc3` models compared object by object, matched by ID: the canvas,
 * the file version, which parts exist, each parameter's range and default,
 * and for each art mesh its blend mode, culling, texture, draw order (at the
 * default pose), masks, and vertex and triangle counts. For checking what a
 * re-export changed (the viewer's Edit › Compare).
 */
import { ModelInstance } from "../eval/instance.js";
import type { MocModel } from "./model.js";

export type MocDifferenceKind = "canvas" | "version" | "part" | "parameter" | "art mesh";

/** One difference between the two models. */
export interface MocDifference {
  kind: MocDifferenceKind;
  /** The object's ID ("" for the canvas and the version). */
  id: string;
  /** What differs; "presence" when the ID is in one model only. */
  property: string;
  /** The value in the first and second model (null: absent). */
  a: string | number | null;
  b: string | number | null;
}

const DOUBLE_SIDED = 4;

/** The differences between `a` and `b`, in file order of `a`, then what only `b` has. */
export function compareMocModels(a: MocModel, b: MocModel): MocDifference[] {
  const out: MocDifference[] = [];
  const diff = (
    kind: MocDifferenceKind,
    id: string,
    property: string,
    x: string | number | null,
    y: string | number | null,
  ) => {
    if (!Object.is(x, y)) out.push({ kind, id, property, a: x, b: y });
  };

  diff("version", "", "version", a.version, b.version);
  for (const key of ["pixelsPerUnit", "originX", "originY", "width", "height", "flags"] as const)
    diff("canvas", "", key, a.canvas[key], b.canvas[key]);

  /** Objects matched by ID: each callback gets the index in a and in b. */
  const byId = (
    kind: MocDifferenceKind,
    idsA: readonly string[],
    idsB: readonly string[],
    same: (i: number, j: number, id: string) => void,
  ) => {
    const inB = new Map<string, number>();
    idsB.forEach((id, j) => inB.has(id) || inB.set(id, j));
    const inA = new Set(idsA);
    idsA.forEach((id, i) => {
      const j = inB.get(id);
      if (j === undefined) diff(kind, id, "presence", "present", null);
      else same(i, j, id);
    });
    for (const id of idsB) if (!inA.has(id)) diff(kind, id, "presence", null, "present");
  };

  byId("part", a.parts.ids, b.parts.ids, () => {});

  const pa = a.parameters;
  const pb = b.parameters;
  byId("parameter", pa.ids, pb.ids, (i, j, id) => {
    diff("parameter", id, "minimum", pa.min[i]!, pb.min[j]!);
    diff("parameter", id, "default", pa.defaults[i]!, pb.defaults[j]!);
    diff("parameter", id, "maximum", pa.max[i]!, pb.max[j]!);
  });

  const ma = a.meshes;
  const mb = b.meshes;
  // Draw orders at the default pose (an instance evaluates once when made).
  const orderA = new ModelInstance(a).drawableDrawOrder;
  const orderB = new ModelInstance(b).drawableDrawOrder;
  const maskIds = (m: MocModel, d: number) =>
    Array.from(m.meshes.masks[d]!, (k) => m.meshes.ids[k] ?? String(k)).join(", ");
  byId("art mesh", ma.ids, mb.ids, (i, j, id) => {
    diff("art mesh", id, "blend mode", ma.blendMode[i]!, mb.blendMode[j]!);
    const cull = (m: MocModel["meshes"], d: number) =>
      (m.flags[d]! & DOUBLE_SIDED) !== 0 ? "off" : "on";
    diff("art mesh", id, "culling", cull(ma, i), cull(mb, j));
    diff("art mesh", id, "texture", ma.texture[i]!, mb.texture[j]!);
    diff("art mesh", id, "draw order", orderA[i]!, orderB[j]!);
    diff("art mesh", id, "masks", maskIds(a, i), maskIds(b, j));
    diff("art mesh", id, "vertices", ma.vertexCount[i]!, mb.vertexCount[j]!);
    diff("art mesh", id, "triangles", ma.triangles[i]!.length / 3, mb.triangles[j]!.length / 3);
  });
  return out;
}

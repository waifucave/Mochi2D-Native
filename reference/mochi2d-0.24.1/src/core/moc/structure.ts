/**
 * The structural checks behind `validateMoc` (validate.ts) and `writeMoc`
 * (io.ts), which refuses data that fails the official level. See validate.ts
 * for what each level covers.
 */
import type { MocDiagnostic } from "./io.js";
import type { MocData } from "./data.js";
import { keyformDrawOrder } from "../eval/f32.js";

type Kind = MocDiagnostic["kind"];
type Level = "official" | "strict";

export class Report {
  readonly list: MocDiagnostic[] = [];
  constructor(private readonly strict: boolean) {}

  error(level: Level, code: string, kind: Kind, message: string, index?: number, field?: string) {
    if (level === "official" || this.strict)
      this.list.push({
        code,
        severity: "error",
        kind,
        ...(index !== undefined ? { index } : {}),
        ...(field !== undefined ? { field } : {}),
        message,
      });
  }

  warn(code: string, kind: Kind, message: string, index?: number, field?: string) {
    if (this.strict)
      this.list.push({
        code,
        severity: "warning",
        kind,
        ...(index !== undefined ? { index } : {}),
        ...(field !== undefined ? { field } : {}),
        message,
      });
  }

  get errors(): number {
    return this.list.filter((d) => d.severity === "error").length;
  }
}

// ------------------------------------------------------------ the checks

/**
 * Every structural check of `validateMoc` on shape-checked data, reported at
 * its level: "official" errors are what the official consistency check
 * rejects, "strict" errors what Mochi2D's loader rejects beyond that.
 */
export function checkStructure(d: MocData, v: number, r: Report): void {
  const ids = (kind: "parts" | "deformers" | "artMeshes" | "parameters" | "glues", i: number) => {
    const id = d[kind].ids[i];
    return id !== undefined ? ` (${id})` : "";
  };
  const name = (kind: Kind, i: number) =>
    kind === "parts" ||
    kind === "deformers" ||
    kind === "artMeshes" ||
    kind === "parameters" ||
    kind === "glues"
      ? `${kind}[${i}]${ids(kind, i)}`
      : `${kind}[${i}]`;
  const isIndex = (x: number, lo: number, hi: number) => Number.isInteger(x) && x >= lo && x < hi;

  /** Index field check: value in [lo, hi). `field` is undefined for the entries of a single array. */
  const index = (
    level: Level,
    kind: Kind,
    i: number,
    field: string | undefined,
    value: number,
    lo: number,
    hi: number,
    target: string,
  ): boolean => {
    if (isIndex(value, lo, hi)) return true;
    r.error(
      level,
      "index-out-of-range",
      kind,
      `${name(kind, i)}${field ? `.${field}` : ""} = ${value} is out of range [${lo}, ${hi}) of ${target}`,
      i,
      field,
    );
    return false;
  };

  /** A run [first, first + count) within [0, total); an empty run may start anywhere. */
  const range = (
    level: Level,
    kind: Kind,
    i: number,
    field: string,
    first: number,
    count: number,
    total: number,
    target: string,
  ): boolean => {
    if (count < 0) {
      r.error(
        level,
        "negative-count",
        kind,
        `${name(kind, i)}: negative count ${count} for ${target}`,
        i,
        field,
      );
      return false;
    }
    if (count === 0) return true;
    if (first >= 0 && first + count <= total) return true;
    r.error(
      level,
      "range-out-of-bounds",
      kind,
      `${name(kind, i)}.${field}: [${first}, ${first + count}) is out of bounds of ${target} (0…${total})`,
      i,
      field,
    );
    return false;
  };

  const n = {
    parts: d.parts.ids.length,
    deformers: d.deformers.ids.length,
    warps: d.warpDeformers.band.length,
    rotations: d.rotationDeformers.band.length,
    meshes: d.artMeshes.ids.length,
    parameters: d.parameters.ids.length,
    partKeyforms: d.partKeyforms.drawOrder.length,
    warpKeyforms: d.warpKeyforms.opacity.length,
    rotationKeyforms: d.rotationKeyforms.opacity.length,
    meshKeyforms: d.artMeshKeyforms.opacity.length,
    positions: d.keyformPositions.length,
    bindingEntries: d.bindingIndices.length,
    bands: d.bands.firstEntry.length,
    bindings: d.parameterBindings.firstKey.length,
    keys: d.keys.length,
    uvs: d.uvs.length,
    triangles: d.triangleIndices.length,
    masks: d.maskEntries.length,
    groups: d.drawOrderGroups.firstObject.length,
    groupObjects: d.drawOrderGroupObjects.kind.length,
    glues: d.glues.ids.length,
    glueInfo: d.glueInfo.weight.length,
    glueKeyforms: d.glueKeyforms.intensity.length,
    multiplyColors: d.multiplyColors?.r.length ?? 0,
    screenColors: d.screenColors?.r.length ?? 0,
    offscreens: d.offscreens?.part.length ?? 0,
    offscreenKeyforms: d.offscreenKeyforms?.opacity.length ?? 0,
  };

  // ---- canvas ----
  if (!(d.canvas.pixelsPerUnit > 0))
    r.warn(
      "canvas",
      "canvas",
      `canvas.pixelsPerUnit = ${d.canvas.pixelsPerUnit} is not positive`,
      undefined,
      "pixelsPerUnit",
    );

  // ---- the seven 0/1 fields (official, S6) ----
  const flags = (
    kind: "parts" | "deformers" | "artMeshes" | "parameters",
    field: string,
    values: Int32Array,
  ) => {
    for (let i = 0; i < values.length; i++)
      if (values[i] !== 0 && values[i] !== 1)
        r.error(
          "official",
          "flag-value",
          kind,
          `${name(kind, i)}.${field} = ${values[i]}, but a flag is 0 or 1`,
          i,
          field,
        );
  };
  flags("parts", "initiallyVisible", d.parts.initiallyVisible);
  flags("parts", "enabled", d.parts.enabled);
  flags("deformers", "visible", d.deformers.visible);
  flags("deformers", "enabled", d.deformers.enabled);
  flags("artMeshes", "visible", d.artMeshes.visible);
  flags("artMeshes", "enabled", d.artMeshes.enabled);
  flags("parameters", "repeat", d.parameters.repeat);

  // ---- parameter bindings and their keys (strict) ----
  const keys = d.keys;
  const bindingKeyCount = new Int32Array(n.bindings).fill(-1); // -1: the binding's keys are invalid
  /** A run of strictly ascending keys (the caller has checked that there is at least one). */
  const keysOk = (
    kind: Kind,
    i: number,
    firstField: string,
    first: number,
    count: number,
  ): boolean => {
    if (!range("strict", kind, i, firstField, first, count, n.keys, "keys")) return false;
    for (let k = first + 1; k < first + count; k++)
      if (!(keys[k]! > keys[k - 1]!)) {
        r.error(
          "strict",
          "keys-unsorted",
          kind,
          `${name(kind, i)}: keys are not strictly ascending (${keys[k - 1]} then ${keys[k]})`,
          i,
          firstField,
        );
        return false;
      }
    return true;
  };
  for (let b = 0; b < n.bindings; b++) {
    const first = d.parameterBindings.firstKey[b]!;
    const count = d.parameterBindings.keyCount[b]!;
    if (count === 0) {
      r.error(
        "strict",
        "no-keys",
        "parameterBindings",
        `parameterBindings[${b}]: has no keys`,
        b,
        "keyCount",
      );
      continue;
    }
    if (keysOk("parameterBindings", b, "firstKey", first, count)) bindingKeyCount[b] = count;
  }

  // ---- parameters ----
  const bindingOwner = new Int32Array(n.bindings).fill(-1);
  for (let p = 0; p < n.parameters; p++) {
    const min = d.parameters.min[p]!;
    const max = d.parameters.max[p]!;
    const def = d.parameters.defaultValue[p]!;
    if (min > max)
      r.error(
        "strict",
        "min-above-max",
        "parameters",
        `${name("parameters", p)}: min ${min} > max ${max}`,
        p,
        "min",
      );
    else if (def < min || def > max)
      r.warn(
        "default-outside-range",
        "parameters",
        `${name("parameters", p)}: default ${def} is outside [${min}, ${max}]`,
        p,
        "defaultValue",
      );
    if (d.parameters.decimals[p]! < 0)
      r.error(
        "official",
        "value-range",
        "parameters",
        `${name("parameters", p)}.decimals = ${d.parameters.decimals[p]} is negative (S6)`,
        p,
        "decimals",
      );
    const first = d.parameters.firstBinding[p]!;
    const count = d.parameters.bindingCount[p]!;
    if (
      range(
        "strict",
        "parameters",
        p,
        "firstBinding",
        first,
        count,
        n.bindings,
        "parameterBindings",
      )
    )
      for (let b = first; b < first + count; b++) {
        if (bindingOwner[b] !== -1)
          r.error(
            "strict",
            "binding-ownership",
            "parameterBindings",
            `parameterBindings[${b}] is owned by parameters ${bindingOwner[b]} and ${p}`,
            b,
          );
        else bindingOwner[b] = p;
      }
    if (v >= 4) {
      const t = d.parameters.type![p]!;
      if (t !== 0 && t !== 1)
        r.error(
          "strict",
          "parameter-type",
          "parameters",
          `${name("parameters", p)}.type = ${t} (0 = normal, 1 = blend shape)`,
          p,
          "type",
        );
      range(
        "strict",
        "parameters",
        p,
        "firstKey",
        d.parameters.firstKey![p]!,
        d.parameters.keyCount![p]!,
        n.keys,
        "keys",
      );
    }
  }
  for (let b = 0; b < n.bindings; b++)
    if (bindingOwner[b] === -1)
      r.error(
        "strict",
        "binding-ownership",
        "parameterBindings",
        `parameterBindings[${b}] is owned by no parameter`,
        b,
      );

  // ---- bands ----
  for (let e = 0; e < n.bindingEntries; e++)
    index(
      "official",
      "bindingIndices",
      e,
      undefined,
      d.bindingIndices[e]!,
      0,
      n.bindings,
      "parameterBindings",
    );
  const bandKeyforms = new Float64Array(n.bands).fill(-1); // -1: unknown (invalid band)
  for (let b = 0; b < n.bands; b++) {
    const first = d.bands.firstEntry[b]!;
    const count = d.bands.entryCount[b]!;
    if (
      !range("strict", "bands", b, "firstEntry", first, count, n.bindingEntries, "bindingIndices")
    )
      continue;
    let size = 1;
    let ok = true;
    for (let j = first; j < first + count; j++) {
      const binding = d.bindingIndices[j]!;
      const keyCount = isIndex(binding, 0, n.bindings) ? bindingKeyCount[binding]! : -1;
      if (keyCount < 0) {
        ok = false;
        break;
      }
      size *= keyCount;
    }
    if (!ok) continue;
    if (size > 0x7fffffff) {
      r.error(
        "strict",
        "band-overflow",
        "bands",
        `bands[${b}]: keyform count ${size} overflows`,
        b,
      );
      continue;
    }
    bandKeyforms[b] = size;
  }
  /** An object's band and normal keyforms. */
  const keyforms = (
    kind: Kind,
    i: number,
    band: number,
    first: number,
    count: number,
    total: number,
    target: string,
  ): boolean => {
    // Every kind's band index is checked.
    const bandOk = index("official", kind, i, "band", band, 0, n.bands, "bands");
    const rangeOk = range("strict", kind, i, "firstKeyform", first, count, total, target);
    if (bandOk && bandKeyforms[band]! >= 0 && count !== bandKeyforms[band])
      r.error(
        "strict",
        "keyform-count",
        kind,
        `${name(kind, i)}: ${count} keyforms, but its band's bindings need ${bandKeyforms[band]}`,
        i,
        "keyformCount",
      );
    return rangeOk;
  };

  // Which object owns each normal keyform (for the color and position checks).
  const colorsN = Math.min(n.multiplyColors, n.screenColors);
  const normalOwner = (count: number) => new Int32Array(count).fill(-1);
  const warpNormal = normalOwner(n.warpKeyforms);
  const rotationNormal = normalOwner(n.rotationKeyforms);
  const meshNormal = normalOwner(n.meshKeyforms);

  /**
   * v4 colors (first color + position) and the v5 per-keyform indices (C5).
   * Official (S6): the first color entry is ≥ 0 and the object's range of
   * entries lies in the tables. The per-keyform indices are checked below.
   */
  const colors = (
    kind: Kind,
    i: number,
    first: number,
    count: number,
    firstColor: Int32Array | undefined,
    keyformKind: "warpKeyforms" | "rotationKeyforms" | "artMeshKeyforms",
    owner: Int32Array,
  ) => {
    // Only indices inside the array (a corrupt count can be huge).
    const end = Math.min(owner.length, first + count);
    for (let k = Math.max(0, first); k < end; k++) owner[k] = i;
    if (v < 4 || !firstColor) return;
    const fc = firstColor[i]!;
    if (fc < 0)
      r.error(
        "official",
        "index-out-of-range",
        kind,
        `${name(kind, i)}.firstColor = ${fc} is negative`,
        i,
        "firstColor",
      );
    else range("official", kind, i, "firstColor", fc, count, colorsN, "the color entries");
    if (v < 5) return;
    const kf = d[keyformKind];
    for (let p = 0; p < count; p++) {
      const k = first + p;
      if (k < 0 || k >= kf.opacity.length) break;
      const m = kf.multiplyColor![k]!;
      const s = kf.screenColor![k]!;
      if (m !== fc + p || s !== fc + p)
        r.warn(
          "color-index",
          keyformKind,
          `${keyformKind}[${k}]: color indices ${m}/${s}, but the runtime uses ${name(kind, i)}'s first color entry + ${p} = ${fc + p} for both (C5)`,
          k,
          "multiplyColor",
        );
    }
  };
  /**
   * v5: the per-keyform color indices of warp, rotation and art-mesh
   * keyforms, normal and blend-shape ones (S6; rotations as the others). The
   * official check accepts 0…N, N being the table size, so
   * one past the end too; Mochi2D rejects N (strict).
   */
  const keyformColorIndices = (
    keyformKind: "warpKeyforms" | "rotationKeyforms" | "artMeshKeyforms",
  ) => {
    if (v < 5) return;
    const kf = d[keyformKind];
    for (const [field, N] of [
      ["multiplyColor", n.multiplyColors],
      ["screenColor", n.screenColors],
    ] as const) {
      const values = kf[field]!;
      for (let k = 0; k < values.length; k++) {
        const x = values[k]!;
        if (x >= 0 && x < N) continue;
        r.error(
          x === N ? "strict" : "official",
          "index-out-of-range",
          keyformKind,
          `${keyformKind}[${k}].${field} = ${x} is out of range [0, ${N}) of the color entries${x === N ? " (the official check accepts N)" : ""}`,
          k,
          field,
        );
      }
    }
  };

  // ---- parts ----
  const partOffscreen = d.parts.offscreen ?? new Int32Array(n.parts).fill(-1);
  for (let p = 0; p < n.parts; p++) {
    const parent = d.parts.parent[p]!;
    if (index("official", "parts", p, "parent", parent, -1, n.parts, "parts") && !(parent < p))
      r.error(
        "strict",
        "parent-order",
        "parts",
        `${name("parts", p)}.parent = ${parent} must be -1 or an earlier part`,
        p,
        "parent",
      );
    keyforms(
      "parts",
      p,
      d.parts.band[p]!,
      d.parts.firstKeyform[p]!,
      d.parts.keyformCount[p]!,
      n.partKeyforms,
      "partKeyforms",
    );
    if (v >= 6)
      index("strict", "parts", p, "offscreen", partOffscreen[p]!, -1, n.offscreens, "offscreens");
  }

  // ---- deformers ----
  for (let i = 0; i < n.deformers; i++) {
    const kind = d.deformers.kind[i]!;
    if (kind !== 0 && kind !== 1)
      r.error(
        "official",
        "kind",
        "deformers",
        `${name("deformers", i)}.kind = ${kind} (0 = warp, 1 = rotation)`,
        i,
        "kind",
      );
    else
      index(
        "official",
        "deformers",
        i,
        "kindIndex",
        d.deformers.kindIndex[i]!,
        0,
        kind === 0 ? n.warps : n.rotations,
        kind === 0 ? "warpDeformers" : "rotationDeformers",
      );
    index("official", "deformers", i, "part", d.deformers.part[i]!, -1, n.parts, "parts");
    const parent = d.deformers.parent[i]!;
    if (
      index("official", "deformers", i, "parent", parent, -1, n.deformers, "deformers") &&
      !(parent < i)
    )
      r.error(
        "strict",
        "parent-order",
        "deformers",
        `${name("deformers", i)}.parent = ${parent} must be -1 or an earlier deformer`,
        i,
        "parent",
      );
    const band = d.deformers.band[i]!;
    if (index("official", "deformers", i, "band", band, 0, n.bands, "bands")) {
      // The runtime evaluates a deformer with its warp or rotation record's band.
      const k = d.deformers.kindIndex[i]!;
      const own =
        kind === 0 && isIndex(k, 0, n.warps)
          ? d.warpDeformers.band[k]!
          : kind === 1 && isIndex(k, 0, n.rotations)
            ? d.rotationDeformers.band[k]!
            : band;
      if (own !== band)
        r.warn(
          "band-mismatch",
          "deformers",
          `${name("deformers", i)}.band = ${band}, but its ${kind === 0 ? "warp" : "rotation"} record has band ${own}, which is the one evaluated`,
          i,
          "band",
        );
    }
  }

  // ---- warps ----
  const positionRuns: { kind: Kind; i: number; keyform: Kind; k: number; floats: number }[] = [];
  for (let w = 0; w < n.warps; w++) {
    const R = d.warpDeformers.rows[w]!;
    const C = d.warpDeformers.columns[w]!;
    const points = d.warpDeformers.pointCount[w]!;
    if (!(R >= 1 && C >= 1))
      r.error(
        "strict",
        "grid-size",
        "warpDeformers",
        `warpDeformers[${w}]: grid of ${R}×${C} cells`,
        w,
        "rows",
      );
    if (points !== (R + 1) * (C + 1))
      r.error(
        "official",
        "grid-points",
        "warpDeformers",
        `warpDeformers[${w}]: ${points} grid points, but (rows+1)(columns+1) = ${(R + 1) * (C + 1)}`,
        w,
        "pointCount",
      );
    const first = d.warpDeformers.firstKeyform[w]!;
    const count = d.warpDeformers.keyformCount[w]!;
    if (
      keyforms(
        "warpDeformers",
        w,
        d.warpDeformers.band[w]!,
        first,
        count,
        n.warpKeyforms,
        "warpKeyforms",
      )
    )
      for (let k = first; k < first + count; k++)
        positionRuns.push({
          kind: "warpDeformers",
          i: w,
          keyform: "warpKeyforms",
          k,
          floats: 2 * points,
        });
    colors(
      "warpDeformers",
      w,
      first,
      count,
      d.warpDeformers.firstColor,
      "warpKeyforms",
      warpNormal,
    );
  }

  // ---- rotations ----
  for (let i = 0; i < n.rotations; i++) {
    const first = d.rotationDeformers.firstKeyform[i]!;
    const count = d.rotationDeformers.keyformCount[i]!;
    keyforms(
      "rotationDeformers",
      i,
      d.rotationDeformers.band[i]!,
      first,
      count,
      n.rotationKeyforms,
      "rotationKeyforms",
    );
    colors(
      "rotationDeformers",
      i,
      first,
      count,
      d.rotationDeformers.firstColor,
      "rotationKeyforms",
      rotationNormal,
    );
  }

  // ---- art meshes ----
  const meshes = d.artMeshes;
  /** An object's run of mask entries (the entries themselves are checked below). */
  const maskEntries = (kind: Kind, i: number, first: number, count: number) => {
    range("strict", kind, i, "firstMask", first, count, n.masks, "maskEntries");
  };
  // Every mask entry, listed or not, is −1 or an art mesh.
  for (let e = 0; e < n.masks; e++) {
    const m = d.maskEntries[e]!;
    if (!isIndex(m, -1, n.meshes))
      r.error(
        "official",
        "index-out-of-range",
        "maskEntries",
        `maskEntries[${e}] = ${m} is not an art mesh (−1 or 0…${n.meshes - 1})`,
        e,
      );
  }
  for (let m = 0; m < n.meshes; m++) {
    const V = meshes.vertexCount[m]!;
    if (V < 0)
      r.error(
        "strict",
        "value-range",
        "artMeshes",
        `${name("artMeshes", m)}: negative vertex count ${V}`,
        m,
        "vertexCount",
      );
    const first = meshes.firstKeyform[m]!;
    const count = meshes.keyformCount[m]!;
    if (
      keyforms("artMeshes", m, meshes.band[m]!, first, count, n.meshKeyforms, "artMeshKeyforms") &&
      V >= 0
    )
      for (let k = first; k < first + count; k++)
        positionRuns.push({
          kind: "artMeshes",
          i: m,
          keyform: "artMeshKeyforms",
          k,
          floats: 2 * V,
        });
    index("strict", "artMeshes", m, "part", meshes.part[m]!, -1, n.parts, "parts");
    index(
      "official",
      "artMeshes",
      m,
      "deformer",
      meshes.deformer[m]!,
      -1,
      n.deformers,
      "deformers",
    );
    if (meshes.texture[m]! < 0)
      r.error(
        "official",
        "texture-negative",
        "artMeshes",
        `${name("artMeshes", m)}.texture = ${meshes.texture[m]} is negative`,
        m,
        "texture",
      );
    range(
      "official",
      "artMeshes",
      m,
      "firstUv",
      meshes.firstUv[m]!,
      2 * Math.max(V, 0),
      n.uvs,
      "uvs",
    );
    const tFirst = meshes.firstTriangleIndex[m]!;
    const tCount = meshes.triangleIndexCount[m]!;
    if (
      range(
        "strict",
        "artMeshes",
        m,
        "firstTriangleIndex",
        tFirst,
        tCount,
        n.triangles,
        "triangleIndices",
      )
    ) {
      if (tCount % 3 !== 0)
        r.error(
          "strict",
          "triangle-count",
          "artMeshes",
          `${name("artMeshes", m)}: ${tCount} triangle indices, not a multiple of 3`,
          m,
          "triangleIndexCount",
        );
      for (let t = tFirst; t < tFirst + tCount; t++)
        if (d.triangleIndices[t]! >= V) {
          r.error(
            "strict",
            "triangle-index",
            "artMeshes",
            `${name("artMeshes", m)}: triangle index ${d.triangleIndices[t]} ≥ vertex count ${V}`,
            m,
            "firstTriangleIndex",
          );
          break;
        }
    }
    maskEntries("artMeshes", m, meshes.firstMask[m]!, meshes.maskCount[m]!);
    colors("artMeshes", m, first, count, meshes.firstColor, "artMeshKeyforms", meshNormal);
  }

  keyformColorIndices("warpKeyforms");
  keyformColorIndices("rotationKeyforms");
  keyformColorIndices("artMeshKeyforms");

  // ---- glues ----
  for (let g = 0; g < n.glues; g++) {
    const gl = d.glues;
    keyforms(
      "glues",
      g,
      gl.band[g]!,
      gl.firstKeyform[g]!,
      gl.keyformCount[g]!,
      n.glueKeyforms,
      "glueKeyforms",
    );
    const aOk = index("strict", "glues", g, "artMeshA", gl.artMeshA[g]!, 0, n.meshes, "artMeshes");
    const bOk = index("strict", "glues", g, "artMeshB", gl.artMeshB[g]!, 0, n.meshes, "artMeshes");
    const first = gl.firstInfo[g]!;
    const count = gl.infoCount[g]!;
    if (!range("strict", "glues", g, "firstInfo", first, count, n.glueInfo, "glueInfo")) continue;
    if (count % 2 !== 0) {
      r.error(
        "strict",
        "glue-pairs",
        "glues",
        `${name("glues", g)}: odd glue-info count ${count} (2 per vertex pair)`,
        g,
        "infoCount",
      );
      continue;
    }
    for (let e = first; e < first + count; e += 2) {
      if (aOk && d.glueInfo.vertex[e]! >= meshes.vertexCount[gl.artMeshA[g]!]!)
        r.error(
          "strict",
          "index-out-of-range",
          "glueInfo",
          `glueInfo[${e}].vertex = ${d.glueInfo.vertex[e]} is not a vertex of art mesh A of ${name("glues", g)}`,
          e,
          "vertex",
        );
      if (bOk && d.glueInfo.vertex[e + 1]! >= meshes.vertexCount[gl.artMeshB[g]!]!)
        r.error(
          "strict",
          "index-out-of-range",
          "glueInfo",
          `glueInfo[${e + 1}].vertex = ${d.glueInfo.vertex[e + 1]} is not a vertex of art mesh B of ${name("glues", g)}`,
          e + 1,
          "vertex",
        );
    }
  }

  // ---- offscreens (v6) ----
  const partOffscreenKeyform =
    d.partKeyforms.offscreenKeyform ?? new Int32Array(n.partKeyforms).fill(-1);
  if (v >= 6 && d.offscreens && d.offscreenKeyforms) {
    const o = d.offscreens;
    for (let i = 0; i < n.offscreens; i++) {
      if (
        index("strict", "offscreens", i, "part", o.part[i]!, 0, n.parts, "parts") &&
        partOffscreen[o.part[i]!] !== i
      )
        r.error(
          "strict",
          "offscreen-link",
          "offscreens",
          `offscreens[${i}]: its part ${o.part[i]} does not point back to it`,
          i,
          "part",
        );
      maskEntries("offscreens", i, o.firstMask[i]!, o.maskCount[i]!);
    }
    for (let p = 0; p < n.parts; p++) {
      const off = partOffscreen[p]!;
      if (isIndex(off, 0, n.offscreens) && o.part[off] !== p)
        r.error(
          "strict",
          "offscreen-link",
          "parts",
          `${name("parts", p)}.offscreen = ${off}, but that offscreen names part ${o.part[off]}`,
          p,
          "offscreen",
        );
    }
    // Every part keyform's offscreen keyform entry, normal or blend-shape, of any
    // part, is −1 or an offscreen keyform. Nothing else about it is checked: it may
    // name another offscreen's keyform, offscreen keyforms may go unreferenced, and
    // an owner's normal keyform may hold −1 (its offscreen then reads as zeros).
    for (let k = 0; k < n.partKeyforms; k++)
      index(
        "official",
        "partKeyforms",
        k,
        "offscreenKeyform",
        partOffscreenKeyform[k]!,
        -1,
        n.offscreenKeyforms,
        "offscreenKeyforms",
      );
    const okColors = Int32Array.from(d.offscreenKeyforms.multiplyColor);
    const okScreen = Int32Array.from(d.offscreenKeyforms.screenColor);
    for (let p = 0; p < n.parts; p++) {
      if (partOffscreen[p]! < 0) continue;
      const first = d.parts.firstKeyform[p]!;
      const count = d.parts.keyformCount[p]!;
      if (!(first >= 0 && first + count <= n.partKeyforms)) continue;
      const base = partOffscreenKeyform[first]!;
      for (let j = 0; j < count; j++) {
        const ok = partOffscreenKeyform[first + j]!;
        if (isIndex(ok, 0, n.offscreenKeyforms) && isIndex(base, 0, n.offscreenKeyforms)) {
          okColors[ok] = d.offscreenKeyforms.multiplyColor[base]! + j;
          okScreen[ok] = d.offscreenKeyforms.multiplyColor[base]! + j;
        }
      }
    }
    for (let k = 0; k < n.offscreenKeyforms; k++) {
      index(
        "strict",
        "offscreenKeyforms",
        k,
        "multiplyColor",
        okColors[k]!,
        0,
        n.multiplyColors,
        "multiplyColors",
      );
      index(
        "strict",
        "offscreenKeyforms",
        k,
        "screenColor",
        okScreen[k]!,
        0,
        n.screenColors,
        "screenColors",
      );
    }
  }

  /** Objects that some blend-shape target record with bindings names. */
  const blendShapeTargets = (
    t: { object: Int32Array; bindingCount: Int32Array } | undefined,
    objects: number,
  ): Uint8Array => {
    const out = new Uint8Array(objects);
    if (t)
      for (let i = 0; i < t.object.length; i++)
        if (t.bindingCount[i]! > 0 && isIndex(t.object[i]!, 0, objects)) out[t.object[i]!] = 1;
    return out;
  };
  const meshTarget = blendShapeTargets(d.artMeshBlendShapeTargets, n.meshes);
  const partTarget = blendShapeTargets(d.partBlendShapeTargets, n.parts);

  // ---- draw-order groups ----
  const groups = d.drawOrderGroups;
  const objs = d.drawOrderGroupObjects;
  for (let i = 0; i < n.groupObjects; i++) {
    const kind = objs.kind[i]!;
    if (kind !== 0 && kind !== 1)
      r.error(
        "official",
        "kind",
        "drawOrderGroupObjects",
        `drawOrderGroupObjects[${i}].kind = ${kind} (0 = art mesh, 1 = part)`,
        i,
        "kind",
      );
    else
      index(
        "official",
        "drawOrderGroupObjects",
        i,
        "index",
        objs.index[i]!,
        0,
        kind === 0 ? n.meshes : n.parts,
        kind === 0 ? "artMeshes" : "parts",
      );
    // Every entry, listed by a group or not, of either kind.
    index(
      "official",
      "drawOrderGroupObjects",
      i,
      "nestedGroup",
      objs.nestedGroup[i]!,
      -1,
      n.groups,
      "drawOrderGroups",
    );
  }
  if (n.groups === 0 && n.meshes > 0)
    r.error(
      "strict",
      "group-structure",
      "drawOrderGroups",
      "there are art meshes but no draw-order groups",
    );
  const groupOk = new Uint8Array(n.groups);
  for (let g = 0; g < n.groups; g++) {
    const first = groups.firstObject[g]!;
    const count = groups.objectCount[g]!;
    if (
      !range(
        "strict",
        "drawOrderGroups",
        g,
        "firstObject",
        first,
        count,
        n.groupObjects,
        "drawOrderGroupObjects",
      )
    )
      continue;
    let ok = true;
    for (let i = first; i < first + count; i++) {
      const kind = objs.kind[i]!;
      if (kind === 0) ok &&= isIndex(objs.index[i]!, 0, n.meshes);
      else if (kind === 1) {
        ok &&= isIndex(objs.index[i]!, 0, n.parts);
        if (
          !index(
            "strict",
            "drawOrderGroupObjects",
            i,
            "nestedGroup",
            objs.nestedGroup[i]!,
            0,
            n.groups,
            "drawOrderGroups",
          )
        )
          ok = false;
      } else ok = false;
    }
    groupOk[g] = ok ? 1 : 0;
  }
  if (n.groups > 0 && groupOk.every((x) => x === 1)) {
    const meshSeen = new Uint8Array(n.meshes);
    const offscreenSeen = new Uint8Array(n.offscreens);
    const state = new Uint8Array(n.groups); // 0 new, 1 visiting, 2 done
    const totals = new Float64Array(n.groups).fill(-1);
    let broken = false;
    const visit = (g: number): number => {
      if (state[g] !== 0) {
        r.error(
          "strict",
          "group-structure",
          "drawOrderGroups",
          `drawOrderGroups[${g}] is reached twice or forms a cycle`,
          g,
        );
        broken = true;
        return 0;
      }
      state[g] = 1;
      let total = 0;
      for (
        let i = groups.firstObject[g]!;
        i < groups.firstObject[g]! + groups.objectCount[g]!;
        i++
      ) {
        const idx = objs.index[i]!;
        if (objs.kind[i] === 0) {
          if (meshSeen[idx])
            r.error(
              "strict",
              "group-structure",
              "artMeshes",
              `${name("artMeshes", idx)} appears in more than one draw-order position`,
              idx,
            );
          meshSeen[idx] = 1;
          total += 1;
        } else {
          const off = partOffscreen[idx]!;
          if (isIndex(off, 0, n.offscreens)) {
            if (offscreenSeen[off])
              r.error(
                "strict",
                "group-structure",
                "offscreens",
                `offscreens[${off}] is reached twice`,
                off,
              );
            offscreenSeen[off] = 1;
            total += 1;
          }
          if (broken) return total;
          total += visit(objs.nestedGroup[i]!);
        }
      }
      state[g] = 2;
      totals[g] = total;
      return total;
    };
    visit(0);
    if (!broken) {
      for (let g = 0; g < n.groups; g++)
        if (state[g] === 2 && groups.entryCount[g] !== totals[g])
          r.error(
            "strict",
            "group-total",
            "drawOrderGroups",
            `drawOrderGroups[${g}].entryCount = ${groups.entryCount[g]}, but the group holds ${totals[g]} render-order entries (C6)`,
            g,
            "entryCount",
          );
      for (let m = 0; m < n.meshes; m++)
        if (!meshSeen[m])
          r.error(
            "strict",
            "group-structure",
            "artMeshes",
            `${name("artMeshes", m)} is in no draw-order group`,
            m,
          );
      for (let o = 0; o < n.offscreens; o++)
        if (!offscreenSeen[o])
          r.error(
            "strict",
            "group-structure",
            "offscreens",
            `offscreens[${o}] is in no draw-order group`,
            o,
          );
      // Keyform draw orders outside their group's range (C12, C25): loaded, with a warning.
      for (let g = 0; g < n.groups; g++) {
        if (state[g] !== 2) continue;
        for (
          let i = groups.firstObject[g]!;
          i < groups.firstObject[g]! + groups.objectCount[g]!;
          i++
        ) {
          const mesh = objs.kind[i] === 0;
          const idx = objs.index[i]!;
          const kind: Kind = mesh ? "artMeshes" : "parts";
          const first = (mesh ? meshes.firstKeyform : d.parts.firstKeyform)[idx]!;
          const count = (mesh ? meshes.keyformCount : d.parts.keyformCount)[idx]!;
          const orders = mesh ? d.artMeshKeyforms.drawOrder : d.partKeyforms.drawOrder;
          if (!(first >= 0 && first + count <= orders.length)) continue;
          // Compared as reported: tolerance included, version-5 targets clamped to [0, 1000].
          const target = (mesh ? meshTarget : partTarget)[idx] === 1;
          const outside: number[] = [];
          for (let k = first; k < first + count; k++) {
            const o = orders[k]!;
            const order = keyformDrawOrder(o, target, v);
            if (!(order >= groups.minDrawOrder[g]! && order <= groups.maxDrawOrder[g]!))
              outside.push(o);
          }
          if (outside.length)
            r.warn(
              "draw-order-range",
              kind,
              `${name(kind, idx)}: keyform draw order${outside.length > 1 ? "s" : ""} ${outside.join(", ")} outside the range [${groups.minDrawOrder[g]}, ${groups.maxDrawOrder[g]}] of drawOrderGroups[${g}] (drawn by the evaluated value)`,
              idx,
            );
        }
      }
    }
  }

  // ---- blend shapes (v4+) ----
  if (v >= 4) {
    const bsp = d.blendShapeParameterBindings!;
    const nBs = bsp.firstKey.length;
    const bsOwner = new Int32Array(nBs).fill(-1);
    for (let p = 0; p < n.parameters; p++) {
      const first = d.parameters.firstBlendShapeBinding![p]!;
      const count = d.parameters.blendShapeBindingCount![p]!;
      if (
        !range(
          "strict",
          "parameters",
          p,
          "firstBlendShapeBinding",
          first,
          count,
          nBs,
          "blendShapeParameterBindings",
        )
      )
        continue;
      for (let b = first; b < first + count; b++) {
        if (bsOwner[b] !== -1)
          r.error(
            "strict",
            "binding-ownership",
            "blendShapeParameterBindings",
            `blendShapeParameterBindings[${b}] is owned by parameters ${bsOwner[b]} and ${p}`,
            b,
          );
        else bsOwner[b] = p;
      }
    }
    const bsKeyCount = new Int32Array(nBs).fill(-1);
    for (let b = 0; b < nBs; b++) {
      if (bsOwner[b] === -1)
        r.error(
          "strict",
          "binding-ownership",
          "blendShapeParameterBindings",
          `blendShapeParameterBindings[${b}] is owned by no parameter`,
          b,
        );
      const count = bsp.keyCount[b]!;
      if (count === 0) {
        r.error(
          "strict",
          "no-keys",
          "blendShapeParameterBindings",
          `blendShapeParameterBindings[${b}]: has no keys`,
          b,
          "keyCount",
        );
        continue;
      }
      if (!keysOk("blendShapeParameterBindings", b, "firstKey", bsp.firstKey[b]!, count)) continue;
      bsKeyCount[b] = count;
      index(
        "strict",
        "blendShapeParameterBindings",
        b,
        "baseKey",
        bsp.baseKey[b]!,
        0,
        count,
        "its keys",
      );
    }
    const con = d.blendShapeConstraints!;
    const nCon = con.parameter.length;
    const values = d.blendShapeConstraintValues!;
    for (let c = 0; c < nCon; c++) {
      index(
        "strict",
        "blendShapeConstraints",
        c,
        "parameter",
        con.parameter[c]!,
        0,
        n.parameters,
        "parameters",
      );
      const first = con.firstValue[c]!;
      const count = con.valueCount[c]!;
      if (
        !range(
          "strict",
          "blendShapeConstraints",
          c,
          "firstValue",
          first,
          count,
          values.key.length,
          "blendShapeConstraintValues",
        )
      )
        continue;
      if (count < 1) {
        r.error(
          "strict",
          "no-keys",
          "blendShapeConstraints",
          `blendShapeConstraints[${c}]: no values`,
          c,
          "valueCount",
        );
        continue;
      }
      for (let k = first + 1; k < first + count; k++)
        if (!(values.key[k]! > values.key[k - 1]!)) {
          r.error(
            "strict",
            "keys-unsorted",
            "blendShapeConstraints",
            `blendShapeConstraints[${c}]: keys not ascending`,
            c,
            "firstValue",
          );
          break;
        }
    }
    const entries = d.blendShapeConstraintEntries!;
    for (let e = 0; e < entries.length; e++)
      index(
        "strict",
        "blendShapeConstraintEntries",
        e,
        undefined,
        entries[e]!,
        0,
        nCon,
        "blendShapeConstraints",
      );
    const kb = d.blendShapeKeyformBindings!;
    const nKb = kb.parameterBinding.length;
    const bsKeyformOwner = {
      warp: new Int32Array(n.warpKeyforms).fill(-1),
      rotation: new Int32Array(n.rotationKeyforms).fill(-1),
      mesh: new Int32Array(n.meshKeyforms).fill(-1),
    };
    const targets = (
      kind:
        | "warpBlendShapeTargets"
        | "artMeshBlendShapeTargets"
        | "partBlendShapeTargets"
        | "rotationBlendShapeTargets"
        | "glueBlendShapeTargets"
        | "offscreenBlendShapeTargets",
      objectCount: number,
      objectKind: string,
      keyformTotal: number,
      after: (object: number, firstKeyform: number, count: number, binding: number) => void,
    ) => {
      const t = d[kind];
      if (!t) return;
      for (let i = 0; i < t.object.length; i++) {
        const objectOk = index(
          "strict",
          kind,
          i,
          "object",
          t.object[i]!,
          0,
          objectCount,
          objectKind,
        );
        const first = t.firstBinding[i]!;
        const count = t.bindingCount[i]!;
        if (
          !range("strict", kind, i, "firstBinding", first, count, nKb, "blendShapeKeyformBindings")
        )
          continue;
        for (let b = first; b < first + count; b++) {
          const pb = kb.parameterBinding[b]!;
          const pbOk = index(
            "strict",
            "blendShapeKeyformBindings",
            b,
            "parameterBinding",
            pb,
            0,
            nBs,
            "blendShapeParameterBindings",
          );
          const kFirst = kb.firstKeyform[b]!;
          const kCount = kb.keyformCount[b]!;
          const kOk = range(
            "strict",
            "blendShapeKeyformBindings",
            b,
            "firstKeyform",
            kFirst,
            kCount,
            keyformTotal,
            `the ${objectKind} keyforms`,
          );
          if (pbOk && bsKeyCount[pb]! >= 0 && kCount !== bsKeyCount[pb])
            r.error(
              "strict",
              "keyform-count",
              "blendShapeKeyformBindings",
              `blendShapeKeyformBindings[${b}]: ${kCount} keyforms for ${bsKeyCount[pb]} keys`,
              b,
              "keyformCount",
            );
          range(
            "strict",
            "blendShapeKeyformBindings",
            b,
            "firstConstraintEntry",
            kb.firstConstraintEntry[b]!,
            kb.constraintEntryCount[b]!,
            entries.length,
            "blendShapeConstraintEntries",
          );
          if (objectOk && kOk) after(t.object[i]!, kFirst, kCount, b);
        }
      }
    };
    targets(
      "warpBlendShapeTargets",
      n.warps,
      "warpDeformers",
      n.warpKeyforms,
      (w, first, count) => {
        for (let k = first; k < first + count; k++) {
          bsKeyformOwner.warp[k] = w;
          positionRuns.push({
            kind: "warpDeformers",
            i: w,
            keyform: "warpKeyforms",
            k,
            floats: 2 * d.warpDeformers.pointCount[w]!,
          });
        }
      },
    );
    targets(
      "artMeshBlendShapeTargets",
      n.meshes,
      "artMeshes",
      n.meshKeyforms,
      (m, first, count) => {
        for (let k = first; k < first + count; k++) {
          bsKeyformOwner.mesh[k] = m;
          if (meshes.vertexCount[m]! >= 0)
            positionRuns.push({
              kind: "artMeshes",
              i: m,
              keyform: "artMeshKeyforms",
              k,
              floats: 2 * meshes.vertexCount[m]!,
            });
        }
      },
    );
    if (v >= 5) {
      // A part target's keyforms change its draw order only: their offscreen
      // keyform entries are not read.
      targets("partBlendShapeTargets", n.parts, "parts", n.partKeyforms, () => {});
      targets(
        "rotationBlendShapeTargets",
        n.rotations,
        "rotationDeformers",
        n.rotationKeyforms,
        (rot, first, count) => {
          for (let k = first; k < first + count; k++) bsKeyformOwner.rotation[k] = rot;
        },
      );
      targets("glueBlendShapeTargets", n.glues, "glues", n.glueKeyforms, () => {});
    }
    // v6: offscreen targets, whose keyforms are offscreen keyforms (count 37).
    if (v >= 6)
      targets(
        "offscreenBlendShapeTargets",
        n.offscreens,
        "offscreens",
        n.offscreenKeyforms,
        () => {},
      );
  }

  // ---- keyform positions ----
  // The official level: for each object index i, the
  // keyform stored at index i is tested with object i's run length L(i), whoever owns
  // it: 0 ≤ start + L(i) ≤ N. Nothing else is tested. Keyforms at an index ≥ the
  // object count (blend-shape keyforms included) are never tested, a start may be
  // negative, and a valid file can fail.
  const officialRuns = (
    keyformKind: "warpKeyforms" | "artMeshKeyforms",
    objectKind: Kind,
    objects: number,
    length: (i: number) => number,
  ) => {
    const starts = d[keyformKind].firstPosition;
    for (let i = 0; i < objects && i < starts.length; i++) {
      const end = starts[i]! + length(i);
      if (end >= 0 && end <= n.positions) continue;
      r.error(
        "official",
        "position-run",
        keyformKind,
        `${keyformKind}[${i}].firstPosition = ${starts[i]}: the official level tests keyform ${i} with the run length ${length(i)} of ${name(objectKind, i)}, and ${starts[i]} + ${length(i)} = ${end} is outside [0, ${n.positions}]`,
        i,
        "firstPosition",
      );
    }
  };
  officialRuns("artMeshKeyforms", "artMeshes", n.meshes, (i) => 2 * meshes.vertexCount[i]!);
  officialRuns("warpKeyforms", "warpDeformers", n.warps, (i) => 2 * d.warpDeformers.pointCount[i]!);
  // Strict: every keyform's own run, blend-shape keyforms included, lies in the array.
  for (const run of positionRuns) {
    if (run.floats <= 0) continue;
    const first = (
      run.keyform === "warpKeyforms"
        ? d.warpKeyforms.firstPosition
        : d.artMeshKeyforms.firstPosition
    )[run.k];
    if (first === undefined) continue;
    if (!(first >= 0 && first + run.floats <= n.positions))
      r.error(
        "strict",
        "range-out-of-bounds",
        run.keyform,
        `${run.keyform}[${run.k}].firstPosition: [${first}, ${first + run.floats}) (of ${name(run.kind, run.i)}) is out of bounds of keyformPositions (0…${n.positions})`,
        run.k,
        "firstPosition",
      );
  }
  // Non-finite position values load, and propagate into the outputs.
  let nonFinite = 0;
  let firstNonFinite = -1;
  for (let i = 0; i < n.positions; i++)
    if (!Number.isFinite(d.keyformPositions[i]!)) {
      if (firstNonFinite < 0) firstNonFinite = i;
      nonFinite++;
    }
  if (nonFinite)
    r.warn(
      "position-value",
      "keyformPositions",
      `keyformPositions holds ${nonFinite} non-finite value${nonFinite > 1 ? "s" : ""}, the first at ${firstNonFinite}`,
      firstNonFinite,
    );
  // Non-finite keyform opacities pass the official level (Mochi2D's loader
  // rejects them by default). A writer should store finite values.
  for (const [kind, values] of [
    ["warpKeyforms", d.warpKeyforms.opacity],
    ["rotationKeyforms", d.rotationKeyforms.opacity],
    ["artMeshKeyforms", d.artMeshKeyforms.opacity],
    ["offscreenKeyforms", d.offscreenKeyforms?.opacity],
  ] as const) {
    if (!values) continue;
    for (let k = 0; k < values.length; k++)
      if (!Number.isFinite(values[k]!))
        r.error(
          "strict",
          "opacity-value",
          kind,
          `${kind}[${k}].opacity = ${values[k]} is not finite (the official check accepts it)`,
          k,
          "opacity",
        );
  }

  // ---- duplicate IDs (accepted; the first wins an ID lookup) ----
  for (const kind of ["parts", "deformers", "artMeshes", "parameters", "glues"] as const) {
    const seen = new Map<string, number>();
    d[kind].ids.forEach((id, i) => {
      const before = seen.get(id);
      if (before !== undefined)
        r.warn(
          "duplicate-id",
          kind,
          `${kind}[${i}] has the ID "${id}" of ${kind}[${before}] (an ID lookup finds the first)`,
          i,
          "ids",
        );
      else seen.set(id, i);
    });
  }
}

/**
 * Hit testing (3t), user data (3h) and display information (3i).
 */
import { AnimationFormatError, arr, isObject, num, obj, parseJson, str } from "./json.js";

/** Inclusive bounding box of a drawable's vertices in output space (y up). */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function vertexBounds(vertices: ArrayLike<number>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < vertices.length; i += 2) {
    const x = vertices[i]!;
    const y = vertices[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 3t: whether (x, y) lies in the bounding box of the drawable's vertices from
 * the latest evaluation. Bounds are inclusive; visibility does not matter.
 * Unknown IDs never hit.
 */
export function hitTest(
  drawableIds: readonly string[],
  drawableVertices: readonly ArrayLike<number>[],
  id: string,
  x: number,
  y: number,
): boolean {
  const d = drawableIds.indexOf(id);
  if (d < 0) return false;
  const b = vertexBounds(drawableVertices[d]!);
  return b.minX <= x && x <= b.maxX && b.minY <= y && y <= b.maxY;
}

export interface UserDataEntry {
  target: string;
  id: string;
  value: string;
}

export interface UserData {
  all: UserDataEntry[];
  /** The `ArtMesh` entries. */
  artMeshes: UserDataEntry[];
}

/** 3h: takes the first `UserDataCount` entries; a count larger than the array is rejected. */
export function parseUserData(input: Uint8Array | string | unknown, label = "user data"): UserData {
  const json =
    typeof input === "string" || input instanceof Uint8Array ? parseJson(input, label) : input;
  if (!isObject(json)) throw new AnimationFormatError(`${label}: not a JSON object`);
  const list = arr(json.UserData);
  const count = num(obj(json.Meta).UserDataCount, list.length);
  if (count > list.length)
    throw new AnimationFormatError(
      `${label}: UserDataCount ${count} exceeds the ${list.length} entries`,
    );
  const all = list.slice(0, Math.max(0, count)).map((e) => {
    const ee = obj(e);
    return { target: str(ee.Target), id: str(ee.Id), value: str(ee.Value) };
  });
  return { all, artMeshes: all.filter((e) => e.target === "ArtMesh") };
}

export interface DisplayInfo {
  parameters: { id: string; groupId: string; name: string }[];
  parameterGroups: { id: string; groupId: string; name: string }[];
  parts: { id: string; name: string }[];
  combinedParameters: [string, string][];
}

/** 3i. Playback never reads this file. */
export function parseDisplayInfo(
  input: Uint8Array | string | unknown,
  label = "display info",
): DisplayInfo {
  const json =
    typeof input === "string" || input instanceof Uint8Array ? parseJson(input, label) : input;
  if (!isObject(json)) throw new AnimationFormatError(`${label}: not a JSON object`);
  const entries = (v: unknown) =>
    arr(v).map((e) => {
      const ee = obj(e);
      return { id: str(ee.Id), groupId: str(ee.GroupId), name: str(ee.Name) };
    });
  return {
    parameters: entries(json.Parameters),
    parameterGroups: entries(json.ParameterGroups),
    parts: arr(json.Parts).map((e) => ({ id: str(obj(e).Id), name: str(obj(e).Name) })),
    combinedParameters: arr(json.CombinedParameters)
      .map((p) => arr(p))
      .filter((p) => p.length === 2 && p.every((x) => typeof x === "string"))
      .map((p) => [p[0] as string, p[1] as string]),
  };
}

/** A label and group for one model parameter or part (answer B3). */
export interface DisplayLabel {
  id: string;
  /** The display name, or the ID when there is none. */
  label: string;
  /** Group display name, or undefined for the top level. */
  group: string | undefined;
}

/**
 * Display rules of answer B3 (recommendations): names by ID, the ID when a
 * name is missing, entries for unknown IDs ignored, groups in file order with
 * members in model order, unknown or empty groups at the top level.
 */
export function displayLabels(
  modelIds: readonly string[],
  info: DisplayInfo | null,
  kind: "parameters" | "parts",
): DisplayLabel[] {
  if (!info) return modelIds.map((id) => ({ id, label: id, group: undefined }));
  const names = new Map<string, { name: string; groupId: string }>();
  const list =
    kind === "parameters" ? info.parameters : info.parts.map((p) => ({ ...p, groupId: "" }));
  for (const e of list) if (!names.has(e.id)) names.set(e.id, { name: e.name, groupId: e.groupId });
  const groups = new Map<string, string>();
  for (const g of info.parameterGroups) if (!groups.has(g.id)) groups.set(g.id, g.name || g.id);
  const labels = modelIds.map((id) => {
    const n = names.get(id);
    const group = n && n.groupId && groups.has(n.groupId) ? groups.get(n.groupId) : undefined;
    return { id, label: n?.name || id, group };
  });
  if (kind === "parts") return labels;
  // Top level first, then groups in file order; model order inside each.
  const order = new Map<string | undefined, number>([[undefined, -1]]);
  [...groups.values()].forEach((name, i) => order.has(name) || order.set(name, i));
  return labels
    .map((l, i) => ({ l, i }))
    .sort((a, b) => order.get(a.l.group)! - order.get(b.l.group)! || a.i - b.i)
    .map((x) => x.l);
}

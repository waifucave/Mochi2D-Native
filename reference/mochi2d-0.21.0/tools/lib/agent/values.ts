/** Parsing of the small values the agent interface takes as text (CLI options). */

/** A number from text; empty text is not 0. */
const num = (text: string): number => (text.trim() === "" ? NaN : Number(text));

/** "ID=1.5,Other=-2" → { ID: 1.5, Other: -2 }. */
export function parseAssignments(text: string, what: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of text.split(",")) {
    const part = item.trim();
    if (!part) continue;
    const eq = part.lastIndexOf("=");
    const id = part.slice(0, eq).trim();
    const value = num(part.slice(eq + 1));
    if (eq <= 0 || !id || !Number.isFinite(value))
      throw new Error(`${what}: "${part}" is not ID=number.`);
    out[id] = value;
  }
  return out;
}

/** "WxH" → [W, H]. */
export function parseSize(text: string): [number, number] {
  const m = /^(\d+)\s*[x×X]\s*(\d+)$/.exec(text.trim());
  if (!m) throw new Error(`--size "${text}" is not WIDTHxHEIGHT (for example 512x512).`);
  return [Number(m[1]), Number(m[2])];
}

/** "x,y,pixelsPerUnit" → a view. */
export function parseView(text: string): { x: number; y: number; pixelsPerUnit: number } {
  const n = text.split(",").map(num);
  if (n.length !== 3 || !n.every(Number.isFinite) || !(n[2]! > 0))
    throw new Error(`--view "${text}" is not x,y,pixelsPerUnit (pixelsPerUnit > 0).`);
  return { x: n[0]!, y: n[1]!, pixelsPerUnit: n[2]! };
}

/** "x,y" → [x, y]. */
export function parsePoint(text: string): [number, number] {
  const n = text.split(",").map(num);
  if (n.length !== 2 || !n.every(Number.isFinite)) throw new Error(`"${text}" is not x,y.`);
  return [n[0]!, n[1]!];
}

/**
 * A background: "transparent", "#rgb", "#rrggbb", "#rrggbbaa", or "r,g,b,a"
 * in [0, 1] → straight-alpha RGBA in [0, 1].
 */
export function parseBackground(text: string): [number, number, number, number] {
  const t = text.trim().toLowerCase();
  if (t === "transparent" || t === "none") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    if (h.length === 6) h += "ff";
    const b = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    return [b[0]!, b[1]!, b[2]!, b[3]!];
  }
  const n = t.split(",").map(num);
  if (n.length === 4 && n.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
    return [n[0]!, n[1]!, n[2]!, n[3]!];
  throw new Error(
    `The background "${text}" is not "transparent", a #hex color or r,g,b,a in [0, 1].`,
  );
}

/** "group:index", "group" or a motion file path. */
export function parseMotion(text: string): { group?: string; index?: number; file?: string } {
  if (/\.motion3\.json$/i.test(text)) return { file: text };
  const colon = text.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(text.slice(colon + 1)))
    return { group: text.slice(0, colon), index: Number(text.slice(colon + 1)) };
  return { group: text };
}

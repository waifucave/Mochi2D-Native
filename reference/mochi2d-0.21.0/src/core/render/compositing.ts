/**
 * Reference formulas of the renderer: texture premultiplication
 * and mip averaging on bytes (§2b), the fragment color (§2c), the legacy blend
 * modes (§2d) and the advanced blend codes of the layered pipeline (§2h.3).
 *
 * These are plain real-valued functions. The GPU renderer's shaders implement
 * the same formulas; tests check both against the worked examples of §2j.
 */

export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];

/** §2b.1: premultiplied 8-bit channel, ⌊c·a/255 + ½⌋ (c·a/255 is never halfway). */
export function premultiplyByte(c: number, a: number): number {
  return Math.floor((c * a) / 255 + 0.5);
}

/** §2b.3: mean of a 2×2 block of bytes, rounded to nearest with ties to even. */
export function mipAverage(a: number, b: number, c: number, d: number): number {
  const sum = a + b + c + d;
  const q = sum >> 2;
  const r = sum & 3;
  return r > 2 ? q + 1 : r === 2 ? q + (q & 1) : q;
}

/** Stored 8-bit value of a real channel: round(255·v), clamped (§2d). */
export function toByte(v: number): number {
  return Math.round(255 * Math.min(1, Math.max(0, v)));
}

/** Coverage of a mask (§2g.1) as applied to a drawable or offscreen. */
export interface MaskSample {
  /** m = 1 − ∏(1 − αᵢ). */
  coverage: number;
  inverted: boolean;
}

const maskFactor = (mask?: MaskSample): number =>
  mask ? (mask.inverted ? 1 - mask.coverage : mask.coverage) : 1;

/** §2c: fragment color from a premultiplied texel, multiply / screen colors, opacity and mask. */
export function fragmentColor(t: Rgba, M: Rgb, S: Rgb, opacity: number, mask?: MaskSample): Rgba {
  const out: Rgba = [0, 0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const m = t[i]! * M[i]!;
    out[i] = m + S[i]! * t[3] - m * S[i]!;
  }
  out[3] = t[3];
  // Opacity, then the mask, scale all four channels.
  const m = maskFactor(mask);
  return out.map((v) => v * opacity * m) as Rgba;
}

/** Legacy blend modes of the direct pipeline (§2d), from flag bits 0 and 1. */
export type LegacyBlend = "normal" | "additive" | "multiplicative";

/** Flag bits → legacy blend mode; additive wins if both bits are set. */
export function legacyBlendOf(flags: number): LegacyBlend {
  return flags & 1 ? "additive" : flags & 2 ? "multiplicative" : "normal";
}

/** §2d blend formulas on premultiplied colors. */
export function legacyBlend(mode: LegacyBlend, src: Rgba, dst: Rgba): Rgba {
  const k = 1 - src[3];
  if (mode === "additive") return [src[0] + dst[0], src[1] + dst[1], src[2] + dst[2], dst[3]];
  if (mode === "multiplicative")
    return [
      src[0] * dst[0] + k * dst[0],
      src[1] * dst[1] + k * dst[1],
      src[2] * dst[2] + k * dst[2],
      dst[3],
    ];
  return [src[0] + k * dst[0], src[1] + k * dst[1], src[2] + k * dst[2], src[3] + k * dst[3]];
}

/** Blend codes (§2h.3): color part and alpha part. */
export const colorPart = (code: number): number => code & 0xff;
export const alphaPart = (code: number): number => (code >> 8) & 0xff;

/** Codes the direct pipeline can draw: 0x000, or color part 1 or 2 (§2h.1). */
export function isCompatibleBlend(code: number): boolean {
  const c = colorPart(code);
  return code === 0 || c === 1 || c === 2;
}

/** The legacy mode a compatible code stands for. */
export function compatibleBlendMode(code: number): LegacyBlend {
  const c = colorPart(code);
  return c === 1 ? "additive" : c === 2 ? "multiplicative" : "normal";
}

/** Source of an advanced draw (§2h.3): straight color C and alpha A (mask applied to A only). */
export function advancedSource(
  t: Rgba,
  M: Rgb,
  S: Rgb,
  opacity: number,
  mask?: MaskSample,
): { C: Rgb; A: number } {
  const rgb: Rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const m = t[i]! * M[i]!;
    rgb[i] = (m + S[i]! - m * S[i]!) * opacity; // screen without the factor a
  }
  const A = t[3] * opacity;
  const C: Rgb = A >= 1e-5 ? [rgb[0] / A, rgb[1] / A, rgb[2] / A] : [0, 0, 0];
  return { C, A: A * maskFactor(mask) };
}

/** Straight color of a premultiplied destination pixel. */
export function straightOf(dst: Rgba): { C: Rgb; A: number } {
  const A = dst[3];
  return { C: A >= 1e-5 ? [dst[0] / A, dst[1] / A, dst[2] / A] : [0, 0, 0], A };
}

const lum = (c: Rgb): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const sat = (c: Rgb): number => Math.max(...c) - Math.min(...c);

function clipColor(c: Rgb): Rgb {
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  let out: Rgb = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n)) as Rgb;
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as Rgb;
  return out;
}

function setLum(c: Rgb, l: number): Rgb {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

function setSat(c: Rgb, s: number): Rgb {
  const [r, g, b] = c;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const md = r + g + b - mx - mn;
  const [nmx, nmd, nmn] = mn < mx ? [s, ((md - mn) * s) / (mx - mn), 0] : [0, 0, 0];
  if (r === mx) return b < g ? [nmx, nmd, nmn] : [nmx, nmn, nmd];
  if (g === mx) return r < b ? [nmn, nmx, nmd] : [nmd, nmx, nmn];
  return g < r ? [nmd, nmn, nmx] : [nmn, nmd, nmx];
}

/** Per-channel color functions B(s, d) of §2h.3, by color part. */
function channel(code: number, s: number, d: number): number {
  switch (code) {
    case 3:
      return Math.min(s + d, 1);
    case 4:
      return s + d;
    case 5:
      return Math.min(s, d);
    case 6:
      return s * d;
    case 7:
      return Math.abs(d - 1) < 1e-6 ? 1 : Math.abs(s) < 1e-6 ? 0 : 1 - Math.min(1, (1 - d) / s);
    case 8:
      return Math.max(0, s + d - 1);
    case 9:
      return Math.max(s, d);
    case 10:
      return s + d - s * d;
    case 11:
      return d <= 0 ? 0 : s === 1 ? 1 : Math.min(1, d / (1 - s));
    case 12:
      return d < 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d);
    case 13:
      if (s <= 0.5) return d - (1 - 2 * s) * d * (1 - d);
      if (d <= 0.25) return d + (2 * s - 1) * d * ((16 * d - 12) * d + 3);
      return d + (2 * s - 1) * (Math.sqrt(d) - d);
    case 14:
      return s < 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d);
    case 15:
      return s < 0.5 ? Math.max(0, 2 * s + d - 1) : Math.min(1, 2 * (s - 0.5) + d);
    default:
      return s; // 0 normal (and unknown codes)
  }
}

/** Color function B(s, d) for a color part (§2h.3). */
export function colorFunction(code: number, s: Rgb, d: Rgb): Rgb {
  if (code === 16) return setLum(setSat(s, sat(d)), lum(d));
  if (code === 17) return setLum(s, lum(d));
  return [channel(code, s[0], d[0]), channel(code, s[1], d[1]), channel(code, s[2], d[2])];
}

/** Alpha weights (p₁, p₂, p₃) of §2h.3, by alpha part. */
export function alphaWeights(mode: number, As: number, Ad: number): Rgb {
  switch (mode) {
    case 1:
      return [As * Ad, 0, Ad * (1 - As)];
    case 2:
      return [0, 0, Ad * (1 - As)];
    case 3:
      return [Math.min(As, Ad), Math.max(As - Ad, 0), Math.max(Ad - As, 0)];
    case 4:
      return [Math.max(As + Ad - 1, 0), Math.min(As, 1 - Ad), Math.min(Ad, 1 - As)];
    default:
      return [As * Ad, As * (1 - Ad), Ad * (1 - As)]; // 0 over
  }
}

/** §2h.3: the new premultiplied value of a pixel under an advanced blend code. */
export function advancedBlend(code: number, src: { C: Rgb; A: number }, dst: Rgba): Rgba {
  const d = straightOf(dst);
  const B = colorFunction(colorPart(code), src.C, d.C);
  const [p1, p2, p3] = alphaWeights(alphaPart(code), src.A, d.A);
  return [
    p1 * B[0] + p2 * src.C[0] + p3 * d.C[0],
    p1 * B[1] + p2 * src.C[1] + p3 * d.C[1],
    p1 * B[2] + p2 * src.C[2] + p3 * d.C[2],
    p1 + p2 + p3,
  ];
}

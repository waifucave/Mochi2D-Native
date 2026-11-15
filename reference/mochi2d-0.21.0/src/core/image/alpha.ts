/**
 * RGBA8 alpha conversions.
 *
 * - straight → premultiplied: c' = round(c × a / 255)
 * - premultiplied → straight: c' = min(255, round(c × 255 / a)); a = 0 gives (0, 0, 0, 0)
 *
 * Both keep alpha unchanged. Converting premultiplied data to straight alpha
 * cannot restore precision lost by premultiplication at low alpha.
 */
export type AlphaMode = "premultiplied" | "straight";

export function premultiplyRgba8(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    out[i] = Math.round((data[i]! * a) / 255);
    out[i + 1] = Math.round((data[i + 1]! * a) / 255);
    out[i + 2] = Math.round((data[i + 2]! * a) / 255);
    out[i + 3] = a;
  }
  return out;
}

export function unpremultiplyRgba8(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 0) continue;
    out[i] = Math.min(255, Math.round((data[i]! * 255) / a));
    out[i + 1] = Math.min(255, Math.round((data[i + 1]! * 255) / a));
    out[i + 2] = Math.min(255, Math.round((data[i + 2]! * 255) / a));
    out[i + 3] = a;
  }
  return out;
}

/** Converts between alpha modes; returns a copy even when the modes match. */
export function convertAlpha(
  data: Uint8Array | Uint8ClampedArray,
  from: AlphaMode,
  to: AlphaMode,
): Uint8Array {
  if (from === to) return new Uint8Array(data);
  return to === "premultiplied" ? premultiplyRgba8(data) : unpremultiplyRgba8(data);
}

export function isAlphaMode(v: unknown): v is AlphaMode {
  return v === "premultiplied" || v === "straight";
}

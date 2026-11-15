/**
 * The viewer may downscale textures that do not fit the device or its memory
 * budget, but it must say so visibly (answer B4). This builds the
 * text of that notice.
 */

/** What the notice needs to know about one loaded texture. */
export interface TextureSizeInfo {
  label: string;
  originalWidth: number;
  originalHeight: number;
  /** Uploaded size. */
  width: number;
  height: number;
}

/** Notice text if any texture was uploaded below its stored size, otherwise null. */
export function downscaleNotice(textures: readonly TextureSizeInfo[]): string | null {
  const scaled = textures.filter((t) => t.width < t.originalWidth || t.height < t.originalHeight);
  if (scaled.length === 0) return null;
  const name = (label: string) => label.slice(label.lastIndexOf("/") + 1);
  const list = scaled
    .map((t) => `${name(t.label)} ${t.originalWidth}×${t.originalHeight} → ${t.width}×${t.height}`)
    .join(", ");
  return (
    `${scaled.length} of ${textures.length} textures downscaled to fit this device: ${list}. ` +
    `Fine detail is lost; reference renders never downscale.`
  );
}

import type { AlphaMode } from "../../core/image/alpha.js";

/** Message to the decode worker. `bytes` is transferred. */
export interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  mime: string;
  /** createImageBitmap options, from {@link bitmapOptions}. */
  options: ImageBitmapOptions;
}

export type DecodeResponse =
  | { id: number; ok: true; bitmap: ImageBitmap; ms: number }
  | { id: number; ok: false; error: string };

/** createImageBitmap options for a decode (the same on a worker and on the calling thread). */
export function bitmapOptions(req: {
  alpha: AlphaMode;
  resize?: { width: number; height: number };
}): ImageBitmapOptions {
  const o: ImageBitmapOptions = {
    premultiplyAlpha: req.alpha === "premultiplied" ? "premultiply" : "none",
    colorSpaceConversion: "none",
    imageOrientation: "none",
  };
  if (req.resize) {
    o.resizeWidth = req.resize.width;
    o.resizeHeight = req.resize.height;
    o.resizeQuality = "high";
  }
  return o;
}

/**
 * createImageBitmap with the request's options. A browser that rejects one of
 * the options as unknown (TypeError) gets a second try with only the alpha
 * handling and the size.
 */
export function createBitmap(blob: Blob, options: ImageBitmapOptions): Promise<ImageBitmap> {
  return createImageBitmap(blob, options).catch((e: unknown) => {
    if (!(e instanceof TypeError)) throw e;
    return createImageBitmap(blob, minimalOptions(options));
  });
}

function minimalOptions(o: ImageBitmapOptions): ImageBitmapOptions {
  const m: ImageBitmapOptions = {};
  if (o.premultiplyAlpha) m.premultiplyAlpha = o.premultiplyAlpha;
  if (o.resizeWidth && o.resizeHeight) {
    m.resizeWidth = o.resizeWidth;
    m.resizeHeight = o.resizeHeight;
  }
  return m;
}

/**
 * The decode worker's code: encoded bytes in, an ImageBitmap (decoded as
 * {@link createBitmap} does) transferred back. A classic worker started from
 * a Blob URL, so bundles need no separate worker file and pages may load the
 * library from another origin.
 */
export const DECODE_WORKER_SOURCE = `"use strict";
function minimalOptions(o) {
  var m = {};
  if (o.premultiplyAlpha) m.premultiplyAlpha = o.premultiplyAlpha;
  if (o.resizeWidth && o.resizeHeight) {
    m.resizeWidth = o.resizeWidth;
    m.resizeHeight = o.resizeHeight;
  }
  return m;
}
self.onmessage = function (ev) {
  var req = ev.data;
  var t0 = performance.now();
  var blob = new Blob([req.bytes], { type: req.mime });
  createImageBitmap(blob, req.options)
    .catch(function (e) {
      if (!(e instanceof TypeError)) throw e;
      return createImageBitmap(blob, minimalOptions(req.options));
    })
    .then(
      function (bitmap) {
        self.postMessage({ id: req.id, ok: true, bitmap: bitmap, ms: performance.now() - t0 }, [bitmap]);
      },
      function (e) {
        self.postMessage({ id: req.id, ok: false, error: e && e.message ? e.message : String(e) });
      }
    );
};
`;

/**
 * UTF-8 decoding without depending on host APIs (TextDecoder is not part of the
 * ECMAScript standard library). Invalid sequences decode to U+FFFD.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = "";
  const chunk: number[] = [];
  const flush = () => {
    out += String.fromCharCode(...chunk);
    chunk.length = 0;
  };
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i]!;
    let cp = 0xfffd;
    let len = 1;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xc2 && b0 < 0xe0) {
      len = 2;
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      len = 3;
    } else if (b0 >= 0xf0 && b0 < 0xf5) {
      len = 4;
    }
    if (len > 1) {
      let ok = i + len <= bytes.length;
      let v = b0 & (0xff >> (len + 1));
      for (let k = 1; ok && k < len; k++) {
        const b = bytes[i + k]!;
        if ((b & 0xc0) !== 0x80) ok = false;
        else v = (v << 6) | (b & 0x3f);
      }
      const min = len === 2 ? 0x80 : len === 3 ? 0x800 : 0x10000;
      if (ok && v >= min && v <= 0x10ffff && !(v >= 0xd800 && v <= 0xdfff)) {
        cp = v;
      } else {
        cp = 0xfffd;
        len = 1;
      }
    }
    i += len;
    if (cp > 0xffff) {
      cp -= 0x10000;
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      chunk.push(cp);
    }
    if (chunk.length > 4096) flush();
  }
  flush();
  return out;
}

/**
 * UTF-8 encoding without host APIs, as TextEncoder does it: a lone surrogate
 * becomes U+FFFD.
 */
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      } else cp = 0xfffd;
    } else if (cp >= 0xdc00 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return Uint8Array.from(out);
}

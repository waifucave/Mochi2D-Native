/**
 * Decoding the file names of a zip archive. Zip names are bytes: the UTF-8
 * flag (general purpose bit 11) says they are UTF-8, and the Info-ZIP Unicode
 * Path extra field (0x7075) can carry a UTF-8 copy. Many archives have
 * neither, and store names in the code page of the system that made them
 * (GBK, CP949, Shift_JIS, ...). The rules, in order:
 *
 * 1. A valid Unicode Path field (version 1, and the CRC-32 of the stored name
 *    matches) gives the name.
 * 2. Otherwise a set UTF-8 flag means UTF-8.
 * 3. The remaining names share one encoding, chosen for the whole archive:
 *    UTF-8 if every one of them is valid UTF-8 (many tools write UTF-8
 *    without the flag); else the first of GB18030, Shift_JIS, EUC-KR (with
 *    the CP949 extensions) and Big5 under which every name decodes,
 *    preferring one under which the settings files' references resolve;
 *    else code page 437.
 *
 * The legacy encodings use the host's TextDecoder (browsers, and Node with
 * its standard ICU data), checked against each encoding's byte structure. An
 * encoding the host cannot decode is skipped. Node's EUC-KR lacks the CP949
 * extensions (Hangul syllables outside KS X 1001), so such names decode only
 * in browsers, or by their Unicode Path field.
 */
import { decodeUtf8 } from "../core/binary/utf8.js";
import { crc32, findExtraField, ZIP_FLAG_UTF8, type ZipRecord } from "./zip-archive.js";

export type ZipNameEncoding = "utf-8" | "gb18030" | "shift_jis" | "euc-kr" | "big5" | "cp437";

/** How one name was decoded. */
export type ZipNameSource = "unicode-path" | "utf-8-flag" | "archive-encoding";

export interface DecodedZipNames {
  /** One name per record, in record order. */
  names: string[];
  /** How each name was decoded. */
  sources: ZipNameSource[];
  /**
   * The encoding chosen for names decoded by rule 3. "utf-8" when they are
   * valid UTF-8 or plain ASCII (or when there are none).
   */
  encoding: ZipNameEncoding;
}

/** The legacy encodings of rule 3, in order of preference. */
export const LEGACY_ZIP_ENCODINGS = ["gb18030", "shift_jis", "euc-kr", "big5"] as const;

interface HostDecoder {
  decode(bytes: Uint8Array): string;
}
type HostDecoderCtor = new (label: string, options?: { fatal?: boolean }) => HostDecoder;

const hostDecoders = new Map<string, HostDecoder | null>();

/** A strict decoder from the host, or null if the host lacks the encoding. */
function hostDecoder(label: string): HostDecoder | null {
  let d = hostDecoders.get(label);
  if (d === undefined) {
    const Ctor = (globalThis as { TextDecoder?: HostDecoderCtor }).TextDecoder;
    try {
      d = Ctor ? new Ctor(label, { fatal: true }) : null;
    } catch {
      d = null;
    }
    hostDecoders.set(label, d);
  }
  return d;
}

const isAscii = (b: Uint8Array) => b.every((x) => x < 0x80);

/** Strict UTF-8: undefined for any malformed sequence, overlong form or surrogate. */
export function decodeUtf8Strict(bytes: Uint8Array): string | undefined {
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      i++;
      continue;
    }
    const len =
      b0 >= 0xc2 && b0 < 0xe0 ? 2 : b0 >= 0xe0 && b0 < 0xf0 ? 3 : b0 >= 0xf0 && b0 < 0xf5 ? 4 : 0;
    if (len === 0 || i + len > bytes.length) return undefined;
    let v = b0 & (0xff >> (len + 1));
    for (let k = 1; k < len; k++) {
      const b = bytes[i + k]!;
      if ((b & 0xc0) !== 0x80) return undefined;
      v = (v << 6) | (b & 0x3f);
    }
    const min = len === 2 ? 0x80 : len === 3 ? 0x800 : 0x10000;
    if (v < min || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return undefined;
    i += len;
  }
  return decodeUtf8(bytes);
}

// Code page 437, bytes 0x80–0xFF.
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

export function decodeCp437(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80]!;
  return s;
}

const inRange = (b: number | undefined, lo: number, hi: number) =>
  b !== undefined && b >= lo && b <= hi;

/**
 * Splits a name in a legacy encoding into its characters by byte structure
 * (single bytes, lead and trail bytes, as in the WHATWG Encoding Standard):
 * one entry per character, the byte value for ASCII and -1 for anything else.
 * Undefined if the bytes are malformed.
 */
export function legacyCharShape(
  bytes: Uint8Array,
  encoding: (typeof LEGACY_ZIP_ENCODINGS)[number],
): number[] | undefined {
  const shape: number[] = [];
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    const t = bytes[i + 1];
    if (b < 0x80) {
      shape.push(b);
      i++;
      continue;
    }
    shape.push(-1);
    switch (encoding) {
      case "gb18030":
        if (b === 0x80) i++;
        else if (b === 0xff) return undefined;
        else if (inRange(t, 0x30, 0x39)) {
          if (!inRange(bytes[i + 2], 0x81, 0xfe) || !inRange(bytes[i + 3], 0x30, 0x39))
            return undefined;
          i += 4;
        } else if (inRange(t, 0x40, 0x7e) || inRange(t, 0x80, 0xfe)) i += 2;
        else return undefined;
        break;
      case "shift_jis":
        if (b === 0x80 || inRange(b, 0xa1, 0xdf)) i++;
        else if (
          (inRange(b, 0x81, 0x9f) || inRange(b, 0xe0, 0xfc)) &&
          (inRange(t, 0x40, 0x7e) || inRange(t, 0x80, 0xfc))
        )
          i += 2;
        else return undefined;
        break;
      case "euc-kr":
        if (inRange(b, 0x81, 0xfe) && inRange(t, 0x41, 0xfe)) i += 2;
        else return undefined;
        break;
      case "big5":
        if (inRange(b, 0x81, 0xfe) && (inRange(t, 0x40, 0x7e) || inRange(t, 0xa1, 0xfe))) i += 2;
        else return undefined;
        break;
    }
  }
  return shape;
}

/**
 * True if a decoded string has the given shape. Host decoders do not all
 * reject malformed or unmapped input: some drop bytes silently, even in fatal
 * mode, which shifts ASCII characters out of place. Four Big5 characters
 * decode to a letter and a combining mark (U+0304 or U+030C).
 */
function matchesShape(s: string, shape: number[], encoding: string): boolean {
  const cps = [...s].map((c) => c.codePointAt(0)!);
  let k = 0;
  for (const want of shape) {
    const cp = cps[k++];
    if (cp === undefined || cp === 0xfffd) return false;
    if (want >= 0 ? cp !== want : cp < 0x80) return false;
    if (want < 0 && encoding === "big5" && (cps[k] === 0x304 || cps[k] === 0x30c)) k++;
  }
  return k === cps.length;
}

/** Decodes with a legacy encoding; undefined if a name does not decode or the host lacks it. */
export function decodeLegacy(bytes: Uint8Array, encoding: ZipNameEncoding): string | undefined {
  if (encoding === "utf-8") return decodeUtf8Strict(bytes);
  if (encoding === "cp437") return decodeCp437(bytes);
  const shape = legacyCharShape(bytes, encoding);
  const d = hostDecoder(encoding);
  if (!shape || !d) return undefined;
  let s: string;
  try {
    s = d.decode(bytes);
  } catch {
    return undefined;
  }
  return matchesShape(s, shape, encoding) ? s : undefined;
}

/** The UTF-8 name of a valid Unicode Path extra field (0x7075), if any. */
export function unicodePathName(rawName: Uint8Array, extra: Uint8Array): string | undefined {
  const f = findExtraField(extra, 0x7075);
  if (!f || f.length < 5 || f[0] !== 1) return undefined;
  const crc = (f[1]! | (f[2]! << 8) | (f[3]! << 16) | (f[4]! << 24)) >>> 0;
  if (crc !== crc32(rawName)) return undefined;
  return decodeUtf8Strict(f.subarray(5));
}

export interface DecodeZipNamesOptions {
  /**
   * Extra fields of the local headers, per record, consulted for a Unicode
   * Path field the central directory lacks.
   */
  localExtra?: (index: number) => Uint8Array;
  /**
   * Scores a candidate set of names by how many references of the archive's
   * settings files resolve under it. Called only when several legacy
   * encodings decode every name.
   */
  score?: (names: string[]) => number;
}

/** Decodes the names of an archive's records by the rules above. */
export function decodeZipNames(
  records: readonly ZipRecord[],
  options: DecodeZipNamesOptions = {},
): DecodedZipNames {
  const names: (string | undefined)[] = [];
  const sources: ZipNameSource[] = [];
  const pending: number[] = [];
  records.forEach((r, i) => {
    const unicode =
      unicodePathName(r.rawName, r.extra) ??
      (options.localExtra ? unicodePathName(r.rawName, options.localExtra(i)) : undefined);
    if (unicode !== undefined) {
      names.push(unicode);
      sources.push("unicode-path");
    } else if (r.flags & ZIP_FLAG_UTF8) {
      names.push(decodeUtf8(r.rawName));
      sources.push("utf-8-flag");
    } else {
      names.push(undefined);
      sources.push("archive-encoding");
      pending.push(i);
    }
  });

  const decodeAll = (encoding: ZipNameEncoding): string[] | undefined => {
    const out = names.slice();
    for (const i of pending) {
      const raw = records[i]!.rawName;
      const s = isAscii(raw) ? decodeUtf8(raw) : decodeLegacy(raw, encoding);
      if (s === undefined) return undefined;
      out[i] = s;
    }
    return out as string[];
  };

  let encoding: ZipNameEncoding = "utf-8";
  let decoded = decodeAll("utf-8");
  if (!decoded) {
    const candidates: { encoding: ZipNameEncoding; names: string[] }[] = [];
    for (const e of LEGACY_ZIP_ENCODINGS) {
      const n = decodeAll(e);
      if (n) candidates.push({ encoding: e, names: n });
    }
    let best = candidates[0];
    if (best && candidates.length > 1 && options.score) {
      let bestScore = options.score(best.names);
      for (const c of candidates.slice(1)) {
        const s = options.score(c.names);
        if (s > bestScore) [best, bestScore] = [c, s];
      }
    }
    if (best) {
      encoding = best.encoding;
      decoded = best.names;
    } else {
      encoding = "cp437";
      decoded = decodeAll("cp437")!;
    }
  }
  return { names: decoded, sources, encoding };
}

/** Small helpers for reading the animation JSON files (3a). */
import { decodeUtf8 } from "../core/binary/utf8.js";

/** A file that cannot be used: invalid JSON, wrong structure, or failed validation. */
export class AnimationFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnimationFormatError";
  }
}

export type Json = Record<string, unknown>;

/** Parses UTF-8 JSON text (bytes or a string), skipping a byte-order mark. */
export function parseJson(input: Uint8Array | string, label: string): unknown {
  let text = typeof input === "string" ? input : decodeUtf8(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new AnimationFormatError(`${label}: invalid JSON (${(e as Error).message})`);
  }
}

export const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The object at `v`, or an empty one. */
export const obj = (v: unknown): Json => (isObject(v) ? v : {});

/** The array at `v`, or an empty one. */
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A number, or `fallback` when the value is missing or not a number. */
export const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);

/** A number, or undefined when missing. */
export const optNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

export const bool = (v: unknown, fallback = false): boolean =>
  typeof v === "boolean" ? v : fallback;

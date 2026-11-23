/**
 * Errors across a boundary that keeps only text: from a page to Node
 * (`page.evaluate` keeps a rejection's message, not its type), and from a
 * local file server to the page it serves (an HTTP response). The error goes
 * as its message plus one marked line of JSON with its name and fields, and
 * comes back as the same class, found by name, with the same fields. A name
 * no class is registered for comes back as an `Error` of that name, with its
 * fields.
 */

/** The start of the marked line in a message. */
const WIRE_MARK = "mochi2d-error ";

/** The response header a local file server sends a refused read's error in. */
export const ERROR_HEADER = "x-mochi2d-error";

/** An error class that can be rebuilt by name. */
export type WireErrorClass = abstract new (...args: never[]) => Error;

/** An error's name, message and own fields (strings, numbers, booleans, null), as JSON. */
export function errorToJson(e: unknown): string {
  const err = e instanceof Error ? e : new Error(String(e));
  const fields: Record<string, unknown> = { name: err.name, message: err.message };
  for (const [k, v] of Object.entries(err)) {
    if (k === "name" || k === "message" || k === "stack") continue;
    if (typeof v === "number" && !Number.isFinite(v)) fields[k] = { $number: String(v) };
    else if (v === null || ["string", "number", "boolean"].includes(typeof v)) fields[k] = v;
  }
  return JSON.stringify(fields);
}

/** The error {@link errorToJson} wrote, rebuilt: its class from `classes` by name; or null. */
export function errorFromJson(
  json: string,
  classes: ReadonlyMap<string, WireErrorClass>,
): Error | null {
  let w: unknown;
  try {
    w = JSON.parse(json);
  } catch {
    return null;
  }
  if (!w || typeof w !== "object" || typeof (w as { name?: unknown }).name !== "string")
    return null;
  const { name, message, ...rest } = w as Record<string, unknown>;
  const e = new Error(typeof message === "string" ? message : "");
  const cls = classes.get(name as string);
  if (cls) Object.setPrototypeOf(e, cls.prototype);
  e.name = name as string;
  for (const [k, v] of Object.entries(rest)) {
    const num = v && typeof v === "object" ? (v as { $number?: unknown }).$number : undefined;
    (e as unknown as Record<string, unknown>)[k] = typeof num === "string" ? Number(num) : v;
  }
  e.stack = `${e.name}: ${e.message}`;
  return e;
}

/**
 * An error to reject with where only the message gets through: the same
 * message, then the marked line. Its name is kept for whoever reads it as is.
 */
export function errorForWire(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.message.includes(WIRE_MARK)) return err;
  const out = new Error(`${err.message}\n${WIRE_MARK}${errorToJson(err)}`);
  out.name = err.name;
  return out;
}

/** The error a message from {@link errorForWire} carries, rebuilt; or null. */
export function errorFromMessage(
  message: string,
  classes: ReadonlyMap<string, WireErrorClass>,
): Error | null {
  const at = message.indexOf(WIRE_MARK);
  if (at < 0) return null;
  return errorFromJson(message.slice(at + WIRE_MARK.length).split("\n")[0]!, classes);
}

/** A message without the marked line {@link errorForWire} added. */
export function withoutWireLine(message: string): string {
  return message
    .split("\n")
    .filter((l) => !l.startsWith(WIRE_MARK))
    .join("\n");
}

/** {@link errorToJson} for a response header (ASCII only). */
export function errorToHeader(e: unknown): string {
  return encodeURIComponent(errorToJson(e));
}

/** The error a response header from {@link errorToHeader} carries, rebuilt; or null. */
export function errorFromHeader(
  value: string | null,
  classes: ReadonlyMap<string, WireErrorClass>,
): Error | null {
  if (!value) return null;
  try {
    return errorFromJson(decodeURIComponent(value), classes);
  } catch {
    return null;
  }
}

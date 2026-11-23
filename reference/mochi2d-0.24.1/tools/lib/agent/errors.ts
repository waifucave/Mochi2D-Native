/**
 * An error as the command line and the MCP server report it: its name, its
 * message, and the fields of the typed errors (a cap's `kind`, `limit` and
 * `size`, the file's `path`, a texture's `width` and `height`, a format
 * error's `code`), so a script or an agent can tell "too large" from
 * "damaged" from "missing".
 */
const FIELDS = ["path", "kind", "limit", "size", "width", "height", "code", "fileName"] as const;

export function errorFields(e: unknown): Record<string, unknown> {
  if (!(e instanceof Error)) return { name: "Error", message: String(e) };
  const out: Record<string, unknown> = { name: e.name, message: e.message.split("\n")[0] };
  const any = e as unknown as Record<string, unknown>;
  for (const k of FIELDS) {
    const v = any[k];
    // JSON has no Infinity: a cap turned off is null.
    if (v !== undefined) out[k] = typeof v === "number" && !Number.isFinite(v) ? null : v;
  }
  return out;
}

/** "Name: message", or the message alone for a plain Error. */
export function errorLine(e: unknown): string {
  const f = errorFields(e);
  return f.name === "Error" ? String(f.message) : `${String(f.name)}: ${String(f.message)}`;
}

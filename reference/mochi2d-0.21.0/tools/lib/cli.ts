import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/** Repository root: the nearest ancestor of this module containing package.json. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export interface ParsedArgs {
  positional: string[];
  options: Record<string, string | true>;
}

/** Parses `--key value`, `--key=value` and boolean `--flag` (if listed in `flags`). */
export function parseArgs(argv: string[], flags: string[] = []): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) options[a.slice(2, eq)] = a.slice(eq + 1);
      else if (flags.includes(a.slice(2))) options[a.slice(2)] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error(`Option ${a} needs a value`);
        options[a.slice(2)] = v;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, options };
}

export function errorInfo(e: unknown): { kind: string; message: string } {
  if (e instanceof Error) return { kind: e.name, message: e.message };
  return { kind: "Error", message: String(e) };
}

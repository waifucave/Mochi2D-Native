/**
 * docs/api-stability.md lists every public export of the four entry points
 * with a stability mark: an export that appears or disappears without the
 * list changing fails here (npm run api-list writes the list).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENTRIES, MARKS, entryExports, parseStabilityDoc } from "../scripts/api-exports.mjs";

const root = resolve(__dirname, "..");
const doc = parseStabilityDoc(readFileSync(join(root, "docs", "api-stability.md"), "utf8"));
const src = entryExports(join(root, "src"));
const types = join(root, "dist", "lib", "types");

const listed = (entry: string) =>
  [...doc]
    .filter(([, r]) => r.entries.includes(entry))
    .map(([name]) => name)
    .sort();

describe("the API stability list", () => {
  it("lists every export of each entry point, and nothing else", () => {
    for (const entry of Object.keys(ENTRIES)) {
      const missing = Object.keys(src[entry]!).filter((n) => !doc.get(n)?.entries.includes(entry));
      const extra = listed(entry).filter((n) => !(n in src[entry]!));
      expect({ entry, missing, extra }, "run npm run api-list").toEqual({
        entry,
        missing: [],
        extra: [],
      });
    }
  });

  it("gives each export its kind and a mark, deprecated exactly for @deprecated ones", () => {
    for (const list of Object.values(src))
      for (const [name, info] of Object.entries(list)) {
        const row = doc.get(name)!;
        expect([name, row.kind]).toEqual([name, info.kind]);
        expect(MARKS, `${name} has no mark`).toContain(row.mark);
        expect([name, row.mark === "deprecated"]).toEqual([name, info.deprecated]);
      }
  });

  it("node has everything in headless, and pixi everything in mochi2d", () => {
    for (const [base, wider] of [
      ["mochi2d/headless", "mochi2d/node"],
      ["mochi2d", "mochi2d/pixi"],
    ] as const)
      expect(Object.keys(src[base]!).filter((n) => !(n in src[wider]!))).toEqual([]);
  });

  it("has the values of the headless and node entry points as their modules export them", async () => {
    for (const [entry, file] of [
      ["mochi2d/headless", "../src/lib/headless.js"],
      ["mochi2d/node", "../src/lib/node.js"],
    ] as const) {
      const mod = (await import(file)) as Record<string, unknown>;
      const values = Object.entries(src[entry]!)
        .filter(([, i]) => !["interface", "type"].includes(i.kind))
        .map(([n]) => n)
        .sort();
      expect(Object.keys(mod).sort()).toEqual(values);
    }
  });

  it.skipIf(!existsSync(join(types, "lib", "index.d.ts")))(
    "is the same from the build's declarations",
    () => {
      const built = entryExports(types, ".d.ts");
      for (const entry of Object.keys(ENTRIES))
        expect(Object.keys(built[entry]!).sort(), entry).toEqual(Object.keys(src[entry]!).sort());
    },
    60000,
  );
});

// The public exports of the library's entry points, read with the TypeScript
// compiler, and docs/api-stability.md, which lists them with a stability mark
// (scripts/api-list.mjs writes it; test/api-stability.test.ts checks it).
import ts from "typescript";
import { relative, resolve } from "node:path";

/** The entry points: package export → source file (under src/). */
export const ENTRIES = {
  mochi2d: "lib/index",
  "mochi2d/headless": "lib/headless",
  "mochi2d/node": "lib/node",
  "mochi2d/pixi": "lib/pixi",
};

export const MARKS = ["stable", "experimental", "deprecated"];

/**
 * Groups of the list, by the folder (or file) of the declaration, first match
 * wins. The paths are relative to src/ (or the declarations' root).
 */
const GROUPS = [
  ["Views and models in the browser", ["lib/view", "lib/model", "lib/sources", "lib/speech"]],
  ["Items", ["lib/item"]],
  ["PixiJS", ["lib/pixi"]],
  ["Input, gestures and textures", ["lib/gestures", "lib/texture-budget"]],
  [
    "Live audio and lip sync",
    ["lib/live-lip-sync", "platform/live-audio", "anim/live-lip-sync", "anim/lip-sync"],
  ],
  ["Motion sync", ["lib/live-motion-sync", "anim/motion-sync"]],
  [
    "The runtime",
    [
      "runtime/model-runtime",
      "runtime/bundle",
      "core/eval",
      "core/settings",
      "anim/animator",
      "anim/motion-queue",
    ],
  ],
  ["Animation files", ["anim/"]],
  ["Model data (.moc3)", ["core/moc"]],
  ["File sources", ["core/io", "runtime/zip", "platform/browser-sources", "platform/node-sources"]],
  ["Node", ["lib/node", "platform/node"]],
  [
    "Conformance results",
    ["conformance/", "core/model/snapshot", "core/render/framing", "anim/scenario"],
  ],
  ["Version", ["lib/version"]],
];

function groupOf(path) {
  const p = path.replace(/\.d\.ts$|\.ts$/, "");
  // anim/scenario before anim/ (conformance), anim/lip-sync before anim/.
  const ordered = [...GROUPS].sort(
    (a, b) =>
      Math.max(...b[1].map((x) => (p.startsWith(x) ? x.length : -1))) -
      Math.max(...a[1].map((x) => (p.startsWith(x) ? x.length : -1))),
  );
  const g = ordered.find(([, prefixes]) => prefixes.some((x) => p.startsWith(x)));
  if (!g) throw new Error(`no group for ${path}`);
  return g[0];
}

export const GROUP_ORDER = GROUPS.map((g) => g[0]);

/** Exports declared with the view that belong with the items. */
const NAME_GROUPS = { AddItemOptions: "Items", ItemLayout: "Items" };

/**
 * The exports of each entry point, from `root` (src/, with .ts files, or the
 * build's dist/lib/types/, with .d.ts files): name → { kind, group,
 * deprecated } per entry point.
 */
export function entryExports(root, ext = ".ts") {
  const files = Object.fromEntries(
    Object.entries(ENTRIES).map(([e, f]) => [e, resolve(root, f + ext)]),
  );
  const program = ts.createProgram(Object.values(files), {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    types: ["node"],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  });
  const checker = program.getTypeChecker();
  const out = {};
  for (const [entry, file] of Object.entries(files)) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`missing ${file}`);
    const list = {};
    for (const e of checker.getExportsOfModule(checker.getSymbolAtLocation(sf))) {
      const target = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
      const decls = target.declarations ?? [];
      const decl = decls[0];
      const from = relative(root, decl.getSourceFile().fileName);
      list[e.name] = {
        kind: kindOf(checker, target),
        group: NAME_GROUPS[e.name] ?? groupOf(from),
        deprecated: decls.some((d) =>
          ts.getJSDocTags(d).some((t) => t.tagName.text === "deprecated"),
        ),
      };
    }
    out[entry] = list;
  }
  return out;
}

function kindOf(checker, sym) {
  const f = sym.flags;
  if (f & ts.SymbolFlags.Class) return "class";
  if (f & ts.SymbolFlags.Function) return "function";
  if (f & ts.SymbolFlags.Enum) return "enum";
  if (f & ts.SymbolFlags.Variable) {
    // A constant that holds a class or a function (a deprecated alias) is one.
    const type = checker.getTypeOfSymbol(sym);
    if (type.getConstructSignatures().length) return "class";
    if (type.getCallSignatures().length) return "function";
    return "const";
  }
  if (f & ts.SymbolFlags.Interface) return "interface";
  if (f & ts.SymbolFlags.TypeAlias) return "type";
  return "other";
}

/** One row per export name: its kind, group, entry points and deprecation. */
export function exportRows(exports) {
  const rows = new Map();
  for (const [entry, list] of Object.entries(exports))
    for (const [name, info] of Object.entries(list)) {
      const row = rows.get(name) ?? { name, ...info, entries: [] };
      row.entries.push(entry);
      rows.set(name, row);
    }
  return [...rows.values()];
}

const short = (entry) => (entry === "mochi2d" ? "mochi2d" : entry.slice("mochi2d/".length));

/** The rows of docs/api-stability.md's lists: name → { kind, entries, mark }. */
export function parseStabilityDoc(text) {
  const rows = new Map();
  const re = /^\| `([A-Za-z0-9_$]+)` +\| (\w+) +\| ([a-z0-9, ]+?) +\| (\w+|\?) +\|$/gm;
  for (const m of text.matchAll(re))
    rows.set(m[1], {
      kind: m[2],
      entries: m[3].split(", ").map((e) => (e === "mochi2d" ? e : `mochi2d/${e}`)),
      mark: m[4],
    });
  return rows;
}

/**
 * The lists of docs/api-stability.md between its markers, from the exports,
 * with the marks of `previous` (unmarked exports get "?"; deprecated ones
 * "deprecated").
 */
export function renderLists(exports, previous) {
  const rows = exportRows(exports);
  const parts = [];
  for (const group of GROUP_ORDER) {
    const inGroup = rows
      .filter((r) => r.group === group)
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    if (!inGroup.length) continue;
    parts.push(`### ${group}\n`);
    parts.push("| Export | Kind | Entry points | Stability |");
    parts.push("| --- | --- | --- | --- |");
    for (const r of inGroup) {
      const mark = r.deprecated ? "deprecated" : (previous.get(r.name)?.mark ?? "?");
      const mk = mark === "deprecated" && !r.deprecated ? "?" : mark;
      parts.push(`| \`${r.name}\` | ${r.kind} | ${r.entries.map(short).join(", ")} | ${mk} |`);
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}

export const BEGIN = "<!-- export list: generated by scripts/api-list.mjs; edit only the marks -->";
export const END = "<!-- end of export list -->";

/** The doc with its lists replaced. */
export function withLists(doc, lists) {
  const a = doc.indexOf(BEGIN);
  const b = doc.indexOf(END);
  if (a < 0 || b < a) throw new Error("docs/api-stability.md has no export-list markers");
  return `${doc.slice(0, a + BEGIN.length)}\n\n${lists}\n\n${doc.slice(b)}`;
}

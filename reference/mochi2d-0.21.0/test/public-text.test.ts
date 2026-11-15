/**
 * The public files describe rules and values themselves. The public copy of
 * the repository ships without cleanroom/, so nothing else may cite the
 * project's private records:
 * - no research-note names or labels, no question numbers;
 * - no "values from the official runtime";
 * - no round reports or briefs, no "the coordinator" and no project owner's
 *   decisions;
 * - no paths into cleanroom/, no session links, no private repositories'
 *   names;
 * - no mention of a legal review, a lawyer or an attorney;
 * - no references to the specification ("spec Part 4", "as Part 1
 *   requires"): rule labels such as C12, P8 or §1b.7 are fine.
 *
 * Covers every tracked text file outside cleanroom/ (CLEANROOM.md, the
 * process document, is the one exception), or every file of the tree when
 * there is no git checkout. The official validation level (`level:
 * "official"`) and statements of compatible behavior are fine, and so is an
 * offscreen's owner part.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(__dirname, "..");
const TEXT = /\.(?:ts|js|mjs|cjs|json|md|txt|html|css|yml|yaml)$|^\.[\w-]+$/;
const SKIP = new Set(["node_modules", "dist", "out", "assets", "cleanroom", ".git", "DeepSeek"]);
const EXEMPT = new Set(["CLEANROOM.md", "package-lock.json"]);
const SELF = relative(root, __filename);

/** What a public file must not contain, with what each pattern stands for. */
const CITATIONS: [RegExp, string][] = [
  [/\b(?:maker|models|ms|vts|params)-\d{2}\b/, "a research note's name"],
  [/\b(?:UN)?VERIFIED\b|\bINFERRED\b/, "a research label"],
  [/research\s+(?:side|notes?)\b/i, "the research side"],
  [/\(Q\d+\)|\bR\d{2}-Q\d+\b/, "a question number of the records"],
  [
    /\bofficial\s+(?:values?|vectors?|test vectors|tables?|boxes|outputs?|results?)\b/i,
    "the official runtime's measured values",
  ],
  [/values from the official runtime|official runtime's (?:values|vectors)/i, "measured values"],
  [/cleanroom\/[\w.-]/, "a path into cleanroom/"],
  [/\bcoordinator\b/i, "the coordinator"],
  [/\bround[-\s]\d{2}\b|\bround-\d{2}\.md\b/i, "a round of the records"],
  [/\binbox\s+\d{4}\b/i, "a brief of the records"],
  [
    /\bthe\s+(?:project's\s+)?owner(?:'s)?\s+(?:model|own|files?|decision|recording|review)\b|\bthe\s+owner\s+(?:decided|asked|has)\b/i,
    "the project's owner",
  ],
  [/claude\.ai\/code\/session/, "a session link"],
  [/\bMochi\s+(?:Studio|Maker|Native)\b/, "a private repository's name"],
  [/\blegal(?:\s|\*|\/\/)+reviews?\b|\blawyers?\b|\battorneys?\b/i, "a legal review"],
  [
    /\bspec(?:ification)?(?:'s)?\s+(?:Part|\d)|\bParts?\s+\d\b|\bthe\s+spec(?:ification)?\b/,
    "the private specification",
  ],
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (TEXT.test(name)) out.push(relative(root, path));
  }
}

/** The public files: tracked ones in a checkout, otherwise all of the tree. */
function publicFiles(): string[] {
  if (existsSync(join(root, ".git"))) {
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    return tracked.filter(
      (f) =>
        !f.startsWith("cleanroom/") && TEXT.test(f.split("/").pop()!) && existsSync(join(root, f)),
    );
  }
  const out: string[] = [];
  walk(root, out);
  return out;
}

/** Every match of `re` in `text` (across line breaks), as line numbers. */
function matches(text: string, re: RegExp): number[] {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const lines: number[] = [];
  for (const m of text.matchAll(g)) lines.push(text.slice(0, m.index).split("\n").length);
  return lines;
}

describe("public files", () => {
  it("don't cite the private records", () => {
    const files = publicFiles().filter((f) => !EXEMPT.has(f) && f !== SELF);
    expect(files.length).toBeGreaterThan(200);
    const found: string[] = [];
    for (const rel of files) {
      const text = readFileSync(join(root, rel), "utf8");
      const lines = text.split("\n");
      for (const [re, what] of CITATIONS)
        for (const n of matches(text, re))
          found.push(`${rel}:${n}: ${what}: ${lines[n - 1]!.trim().slice(0, 120)}`);
    }
    expect(found).toEqual([]);
  });

  it("would catch each kind of citation", () => {
    const samples = [
      "see maker-04 for the rule",
      "the vts-03 probe",
      "(VERIFIED with 14 vectors)",
      "the research side measured it",
      "events across a loop wrap (Q2)",
      "matches the official table",
      "selected values from the official runtime",
      "cleanroom/inbox/0010-spec.md",
      "the coordinator's C12 decision",
      "vetted by the\n * coordinator",
      "Reported in round-01.md.",
      "as round 05 found",
      "see inbox 0038",
      "a copy of the owner's model",
      "https://claude.ai/code/session_0123",
      "for Mochi Studio",
      "waits for a legal\n * review",
      "left for the lawyer",
      "an attorney's opinion",
      "the test catalog of spec Part 4",
      "as Part 1 requires",
      "(spec 1b.7, P8)",
      "written from the specification",
      "where the spec gives no rule",
    ];
    for (const s of samples)
      expect(
        CITATIONS.some(([re]) => matches(s, re).length > 0),
        s,
      ).toBe(true);
    const fine = [
      'validateMoc(bytes, { level: "official" })',
      "the official level rejects it",
      "loads such files, as the official runtime does",
      "the owner part's blend shapes never reach its offscreen",
      "the owner's opacity stops above it",
      "rounded to 2 decimals",
      "The project has taken no legal opinion on this",
      "the format's rules (1b.7, P8, C12, §1c)",
      "acquiring the same spec every frame",
      "the owner part's opacity",
      "the public copy ships without cleanroom/ (the process document is CLEANROOM.md)",
    ];
    for (const s of fine)
      expect(
        CITATIONS.some(([re]) => matches(s, re).length > 0),
        s,
      ).toBe(false);
  });
});

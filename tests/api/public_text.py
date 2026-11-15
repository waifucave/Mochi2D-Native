#!/usr/bin/env python3
"""The public files describe rules and values themselves.

The public copy of the repository ships without cleanroom/, so nothing else
may cite the project's private records:
- no research-note names or labels, no question numbers;
- no "values from the official runtime";
- no round reports or briefs, no "the coordinator" and no project owner's
  decisions;
- no paths into cleanroom/, no session links, no private repositories'
  names;
- no mention of a legal review, a lawyer or an attorney;
- no references to the specification ("spec Part 4", "as Part 1
  requires"): rule labels such as C12, P8 or §1b.7 are fine.

The README must also carry the trademark footer, word for word (FOOTER).

Covers every tracked text file outside cleanroom/ (CLEANROOM.md, the process
document, is the one exception), or every file of the tree when there is no
git checkout. The official validation level and statements of compatible
behavior are fine, and so is an offscreen's owner part.

usage: tests/api/public_text.py [root]   (exit 1 on a match; --self-test checks the patterns)
"""
import os
import re
import subprocess
import sys

TEXT = re.compile(
    r"\.(?:c|cc|cpp|h|hpp|inc|mm|m|ts|js|mjs|cjs|json|md|txt|html|css|yml|yaml|py|sh|cmake|in|hlsl|map|exports"
    r"|gitignore|gitattributes)$|^CMakeLists\.txt$|^\.[\w-]+$"
)
SKIP = {"node_modules", "dist", "out", "assets", "cleanroom", ".git", "reference"}
EXEMPT = {"CLEANROOM.md", "package-lock.json"}
SELF = "tests/api/public_text.py"

# What a public file must not contain, with what each pattern stands for.
CITATIONS = [
    (r"\b(?:maker|models|ms|vts|params)-\d{2}\b", "a research note's name"),
    (r"\b(?:UN)?VERIFIED\b|\bINFERRED\b", "a research label"),
    (r"(?i)research\s+(?:side|notes?)\b", "the research side"),
    (r"\(Q\d+\)|\bR\d{2}-Q\d+\b", "a question number of the records"),
    (
        r"(?i)\bofficial\s+(?:values?|vectors?|test vectors|tables?|boxes|outputs?|results?)\b",
        "the official runtime's measured values",
    ),
    (r"(?i)values from the official runtime|official runtime's (?:values|vectors)", "measured values"),
    (r"cleanroom/[\w.-]", "a path into cleanroom/"),
    (r"(?i)\bcoordinator\b", "the coordinator"),
    (r"(?i)\brounds?[-\s]\d{2}\b|\bround-\d{2}\.md\b|\(round \d+\)|\bround \d+\b", "a round of the records"),
    (r"(?i)\binbox\s+\d{4}\b|\binbox\b|\bdecision \d+\b", "a brief of the records"),
    (
        r"(?i)\bthe\s+(?:project's\s+)?owner(?:'s)?\s+(?:model|own|files?|decision|recording|review)\b"
        r"|\bthe\s+owner\s+(?:decided|asked|has)\b",
        "the project's owner",
    ),
    (r"claude\.ai/code/session", "a session link"),
    (r"\bMochi\s+(?:Studio|Maker|Native)\b|\bLively2D\b", "a private repository's name"),
    (r"(?i)\blegal(?:\s|\*|//|#)+reviews?\b|\blawyers?\b|\battorneys?\b", "a legal review"),
    (
        r"\bspec(?:ification)?(?:'s)?\s+(?:Part|\d)|\bParts?\s+\d\b|\bthe\s+spec(?:ification)?\b",
        "the private specification",
    ),
]

# The README's trademark footer, as the project's review gives it.
FOOTER = (
    "Live2D and Live2D Cubism are trademarks or registered trademarks of Live2D Inc. "
    "Mochi2D Native is an independent project. It is not affiliated with, endorsed by, "
    "sponsored by or supported by Live2D Inc., and it contains none of Live2D's code or files."
)
PATTERNS = [(re.compile(p), what) for p, what in CITATIONS]


def public_files(root):
    if os.path.isdir(os.path.join(root, ".git")):
        out = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True).stdout
        files = [f for f in out.split("\n") if f]
        return [
            f
            for f in files
            if not f.startswith("cleanroom/")
            and (not f.startswith("reference/") or f == "reference/README.md")
            and TEXT.search(f.split("/")[-1])
            and os.path.isfile(os.path.join(root, f))
        ]
    found = []
    for d, dirs, names in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP and not x.startswith("build")]
        for n in names:
            if TEXT.search(n):
                found.append(os.path.relpath(os.path.join(d, n), root))
    return found


def matches(text, pattern):
    return [text.count("\n", 0, m.start()) + 1 for m in pattern.finditer(text)]


def self_test():
    catch = [
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
        "the Metal cache (round 10)",
        "see inbox 0038",
        "Inbox 0006's rules hold",
        "new in rounds 06–09",
        "(decision 3 of the plan)",
        "a copy of the owner's model",
        "https://claude.ai/code/session_0123",
        "for Mochi Studio",
        "someone/Lively2D",
        "waits for a legal\n * review",
        "left for the lawyer",
        "an attorney's opinion",
        "the test catalog of spec Part 4",
        "as Part 1 requires",
        "(spec 1b.7, P8)",
        "written from the specification",
        "where the spec gives no rule",
    ]
    fine = [
        'validateMoc(bytes, { level: "official" })',
        "the official level rejects it",
        "loads such files, as the official runtime does",
        "the owner part's blend shapes never reach its offscreen",
        "the owner's opacity stops above it",
        "rounded to 2 decimals",
        "the public copy ships without cleanroom/ (the process document is CLEANROOM.md)",
        "Mochi2D Native",
        "rounded to float32",
        "The project has taken no legal opinion on this",
        "the format's rules (1b.7, P8, C12, §1c)",
        "acquiring the same spec every frame",
        "the owner part's opacity",
    ]
    bad = [s for s in catch if not any(matches(s, p) for p, _ in PATTERNS)]
    bad += [s for s in fine if any(matches(s, p) for p, _ in PATTERNS)]
    for s in bad:
        print(f"public-text: the patterns misjudge {s!r}", file=sys.stderr)
    return not bad


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    root = os.path.abspath(args[0] if args else os.path.join(os.path.dirname(__file__), "..", ".."))
    if not self_test():
        return 1
    if "--self-test" in sys.argv:
        return 0
    files = [f for f in public_files(root) if f not in EXEMPT and f != SELF]
    if len(files) < 200:
        print(f"public-text: only {len(files)} files found under {root}", file=sys.stderr)
        return 1
    found = []
    for rel in files:
        try:
            with open(os.path.join(root, rel), encoding="utf-8") as fh:
                text = fh.read()
        except UnicodeDecodeError:
            continue
        lines = text.split("\n")
        for pattern, what in PATTERNS:
            for n in matches(text, pattern):
                found.append(f"{rel}:{n}: {what}: {lines[n - 1].strip()[:120]}")
    try:
        with open(os.path.join(root, "README.md"), encoding="utf-8") as fh:
            readme = " ".join(fh.read().split())
    except OSError:
        readme = ""
    if FOOTER not in readme:
        found.append("README.md: the trademark footer is missing or not word for word")
    for f in found:
        print(f)
    print(f"public-text: {len(files)} files, {len(found)} citations of the private records", file=sys.stderr)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())

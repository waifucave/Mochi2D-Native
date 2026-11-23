# Clean-room process

Mochi2D is an independent, from-scratch runtime and renderer for Live2D Cubism
model files (`.moc3` + `model3.json` and their companion files). It has to load,
render and animate those models faithfully without using, copying or deriving
from Live2D's own code. This document explains how that separation works.

## Roles

| Role | Where it runs | What it may see | What it produces |
|---|---|---|---|
| **Coordinator** | its own cloud session | everything that passes between the other two | reviewed documents in `cleanroom/inbox/` |
| **Research side** | its own isolated cloud session and container | Live2D's public documentation and file-format specifications; the Cubism SDK as Live2D publishes it (the Framework's published source code, which it may read and never copies, and Cubism Core, which it only runs through its public API); sample models; Mochi2D's code (read-only) | a functional specification in its own words, then test feedback for each Mochi2D build |
| **Implementation side** | its own isolated cloud session and container | this repository, `cleanroom/inbox/`, model data files, general (non-Live2D) knowledge | all code in this repository, round reports |

The research and implementation sides never talk to each other and share no
filesystem. The research side never writes to this repository and has no access
to it. The coordinator gives it read-only snapshots of this repository so it can
test builds. Its own notes and tooling live in a separate private repository
that the implementation side has no access to.

## Information flow

```
Research ──spec / feedback──▶ Coordinator ──reviewed, redacted──▶ cleanroom/inbox/ ──▶ Implementation
Implementation ──code + cleanroom/reports/──▶ Coordinator ──▶ Research (evaluation)
```

The research side may read Mochi2D's code. Information can only go from the
research side to the implementation side through reviewed documents committed
to `cleanroom/inbox/`. These documents are the complete record of what the
implementation side received.

## What may cross into the clean room

Allowed:
- Functional behavior written in the researcher's own words: what the runtime
  computes, as prose, math notation, tables and diagrams.
- File-format facts needed for interoperability: byte layouts, field meanings,
  value ranges, JSON keys, version differences.
- Observed behavior: test vectors (inputs and the official runtime's outputs),
  numeric error reports, descriptions of visual differences, tolerances.
- Answers to the implementer's questions, phrased in terms of behavior.

Removed by the coordinator before anything is forwarded:
- Live2D source code, and pseudo-code or structure that mirrors it. Verbatim text
  from Live2D documentation, comments or headers.
- Internal identifiers from Live2D's SDK (class, function and variable names).
  The only exception is names that are part of the data formats themselves, such
  as JSON keys or IDs stored in model files.
- Anything learned by decompiling, disassembling or inspecting the internals of
  Live2D binaries. The research side is forbidden from doing this as well.
- Paths into, links to, or suggestions to consult Live2D SDK sources.
- Files produced by Live2D's software, such as reference renders or data dumps.
  These stay on the research side. Feedback carries descriptions, aggregate
  metrics and a limited number of example values instead.

## Test models

Mochi2D's committed tests use DeepSeek-chan, a free model whose terms forbid
re-uploading its files. It is therefore not in this repository: users and
developers download it from its creator into the gitignored `assets/models/`
(see the README), and tests that need it skip without it. Further models used
during development were vetted by the coordinator, used locally only and never
committed. Live2D Inc.'s own sample models are never loaded into
Mochi2D or used in its tests. The research side may study them with Live2D's own
software to understand file-format variants.

## Rules for the implementation side

1. Never view, download, install or run any Live2D SDK component. This covers
   Cubism Core in any form (JS, WASM or native), Cubism Framework in any
   language, and code from the SDK samples. It also covers Live2D's online
   manuals and API documentation.
2. Never use third-party Live2D or `.moc3` code or write-ups. That includes
   runtimes, renderers, viewers, parsers, converters, bindings, format templates
   and Live2D-related packages. It also means no web searches for Live2D
   implementation details.
3. Do not write Live2D SDK code from memory. If you notice you are recalling SDK
   internals that are not in `cleanroom/inbox/`, do not use them. Ask in your
   round report instead.
4. Use your own architecture, API design and naming. No `Cubism*` identifiers,
   and do not mirror the SDK's structure.
5. Allowed sources are `cleanroom/inbox/` and the data files (moc3, JSON, PNG,
   WAV) of test models announced in the inbox, which you may analyze yourself.
   General programming, graphics and math knowledge is also allowed, as are
   generic libraries unrelated to Live2D.
6. Never commit model data. `assets/models/` is gitignored and meant for
   locally supplied models.
7. Do not use tools that read or message other agent sessions, and do not
   attach other repositories. `cleanroom/inbox/` is written only by the
   coordinator.
8. Other viewers' code, assets, icons, artwork, visual styling, texts and
   names are off limits. Live2D's Cubism Viewer is the main example.
   - **Familiar conventions are allowed.** The viewer's layout, workflow,
     terms and shortcuts may follow the conventions guide the coordinator
     delivers in `cleanroom/inbox/`, so that users of other viewers feel at
     home. Take them only from that guide, and never look at other viewers
     or their manuals yourself (rule 1).
   - **The look and the names are Mochi2D's own.**

## Rules for the research side

1. Use Cubism Core only through its public API, feeding it inputs and reading its
   outputs. Never decompile, disassemble, deobfuscate, trace, debug, patch or
   memory-inspect it. Feeding it crafted or modified `.moc3` files to watch how
   the outputs change is black-box experimentation and is allowed.
2. The Framework's source code, which Live2D publishes, and the official
   documentation may be read to understand what the software does. Nothing is
   taken from them: no code, no structure, no names, no text. Every deliverable
   describes behavior in the researcher's own words.
3. Third-party descriptions of the `.moc3` layout are hints at most. Every fact
   is verified by the researcher's own observation. Decompiled, disassembled or
   leaked material from any source is never used.
4. Never publish anything. Never write to this repository. SDK files stay inside
   the research container. Notes and harness code may also go in the research
   side's own private repository.
5. Never run Mochi2D on Live2D Inc.'s sample models, and never put them in test
   scenarios or verification data for Mochi2D.

## Audit trail

The clean-room record described below is kept in the project's private
repository. It is not part of the public source, and is preserved unchanged as
evidence of how the code was written.

- `cleanroom/inbox/NNNN-*.md` holds every document delivered to the
  implementation side, in order, after coordinator review.
- `cleanroom/reports/round-NN.md` holds the implementation side's report for
  each round.
- In each evaluation round, the research side also checks Mochi2D code for
  similarity to Live2D's published code. It reports only locations inside
  Mochi2D so they can be rewritten independently, and never quotes Live2D code.

## Known limitations

- The implementation side is a large language model. Its training data may
  include publicly available Live2D SDK source. The rules above reduce the risk,
  as do independent naming and architecture and the similarity audits, but they
  cannot eliminate it completely.
- This document describes an engineering process. It is not legal advice and
  it makes no legal claim. The research side learned how Live2D's software
  behaves in two ways only: by running the runtime and observing its results,
  and by reading the Framework source code that Live2D publishes. No Live2D
  code, documentation text or output file is in this repository, and using
  Mochi2D does not require Live2D's software.

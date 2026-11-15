# Versioning

Mochi2D uses [semantic versioning](https://semver.org): MAJOR.MINOR.PATCH.
This page says what each kind of release may change. It holds from 1.0;
before 1.0, a minor release (0.x.0) may change anything documented, and a
patch release (0.x.y) does not.

**What it covers:**

- every export of the four entry points (`mochi2d`, `mochi2d/headless`,
  `mochi2d/node` and `mochi2d/pixi`), with its mark in
  [docs/api-stability.md](api-stability.md);
- the behavior that [docs/api.md](api.md), [docs/moc-data.md](moc-data.md)
  and [docs/agent-api.md](agent-api.md) describe: the MCP tools and the
  `mochi2d` command line are covered like stable exports;
- the results and renders described below.

**What it doesn't cover:**

- modules the entry points don't export;
- files under `dist/` other than those the package's `exports` name;
- the viewer's layout and controls;
- the conformance and development tools under `tools/`;
- the wording of messages.

## Exports

| Release | Stable exports | Experimental exports |
| --- | --- | --- |
| major (2.0.0) | may change incompatibly: removed, renamed, a different signature or documented behavior | may change in any way |
| minor (1.1.0) | may gain things that don't break callers: new exports, optional parameters, new optional fields in options, new fields in results and events; may deprecate a name | may change incompatibly; each change is listed in `CHANGELOG.md` |
| patch (1.0.1) | fixes only, no change to the API | fixes only |

**Types.**

- A minor release may widen what a function accepts, and add members to
  an interface it returns or to a union of event names.
- It doesn't narrow what a function accepts, or remove members.
- Code that only reads results, and passes options as documented, keeps
  compiling.

**Experimental exports.**

- An experimental export may become stable in a minor release.
- A stable export never becomes experimental again within a major
  version.

**Deprecation.**

- A stable name is never removed or renamed in a minor release. A rename
  keeps the old name as a deprecated alias, with `@deprecated` and the new
  name in its doc comment.
- The alias lives until the next major version, and at least through two
  minor releases.
- `docs/api-stability.md` marks each alias "deprecated", and
  `docs/migration.md` lists it.
- An experimental export may be renamed or removed in a minor release
  without an alias. The changelog says what replaces it.

## Results

Evaluation follows the official runtime's float32 order of operations.
On the conformance catalog it is bit-identical in every compared field
([docs/conformance.md](conformance.md)). That equality is part of the
contract, for every output of evaluation and animation in the reference
configuration:

- vertices, opacities, multiply and screen colors, draw and render orders;
- parameter values and part opacities after animation.

A change to any of these outputs is one of two kinds, and the changelog
says which:

- **A fix:** results come to equal the official runtime's, where they
  differed. It may come in any release, patch included. The changelog
  lists the outputs that change, the largest difference, and which
  catalog scenarios are affected.
- **A break:** results move away from the official runtime. It is never
  intended: it is a bug, and the next patch release reverts it.

**What the contract leaves out:**

- **Values computed in double precision,** outside the float32 rules (the
  decay tails of physics outputs and motion curves): they may differ in
  their last bits when evaluation code changes. No float32 output changes
  with them.
- **Mochi2D's own behavior, where the format gives no rule.** The docs mark it "not
  reference behavior": physics strength, wind and rate, tints, idle
  weights, the motion-sync analysis, and the limits for damaged files. It
  is covered like the API: its stable parts change only in a major
  release. The motion-sync analysis is experimental: its mouth shapes may
  change in a minor release.

## Renders

**Reference renders** (`npm run render`, `NodeRenderer`, `renderToPng`)
follow the official renderer's rules ([docs/rendering.md](rendering.md)).
A change to their pixels comes only toward the official renderer. It may
come in any release, and the changelog lists the renders that change and
by how much.

**The other renders** are approximations that reference renders never
use: the viewer's mask atlas, antialiasing, and textures scaled down to a
budget. They may change in a minor release, and the changelog says so.

## Files Mochi2D writes

Mochi2D's own formats carry a version in their `format` field:

- scenarios and results (`mochi2d-scenario/0`, `mochi2d-result/0`,
  `mochi2d-anim-scenario/0`, `mochi2d-anim-result/0`, `mochi2d-render/0`);
- saved physics state (`mochi2d-physics-state/1`);
- item layouts (`mochi2d-item-layout/1`).

**Within a major version:**

- a stable format's reader keeps reading every earlier version of it;
- `writeMoc`, `writePhysics` and `writeMotionSync` keep writing files the
  official runtime reads.

The scenario, result and render formats are at version 0 and experimental,
like the functions that use them. The physics state and item layout
formats are stable.

## Platforms

- **Node:** the oldest version Mochi2D supports is `engines.node` in
  `package.json` (20 now). A minor release may drop a Node version that
  has reached its end of life.
- **Browsers:** Mochi2D supports those with WebGL2.
- **Peer dependencies:** a new major version of a peer dependency, such as
  PixiJS for `mochi2d/pixi`, may need a major release of Mochi2D.

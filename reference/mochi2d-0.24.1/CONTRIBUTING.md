# Contributing

Thank you for helping with Mochi2D. This page covers how to build and test
it, and what a contribution has to come with.

## Build and test

Mochi2D needs Node 20 or later.

```sh
npm ci
# the viewer, the render harness, the command-line tools and the library
npm run build
# TypeScript, both configurations
npm run typecheck
# Prettier
npm run format:check
# unit tests, plus the browser tests if Playwright and Chromium are installed
npm test
```

**The browser tests** (renders, the viewer, the library in a page) use
Playwright with Chromium. They are skipped when Playwright isn't installed.

**Tests that use DeepSeek-chan** are skipped without it. The README
("Test models") says where to get it, and its terms. Commit no model files:
tests use DeepSeek-chan from `assets/models/` (which git ignores), or
models built in the test from `test/support/synth.ts` and the crafted
variants of `test/support/crafted.ts`.

**What a change should come with:**

- **Code:** a test that fails without the change.
- **The public API:** its entry in `docs/api.md`, and the export list
  (`npm run api-list` after `npm run build:lib`, then the new export's mark
  in `docs/api-stability.md`).
- **Evaluation or rendering:** the changed goldens, regenerated with
  `npm run golden`, and in the pull request which results or pixels
  changed and why. `docs/versioning.md` says what a change in results or
  renders has to be.
- **The viewer's look:** the README's screenshot and the sample model's
  reference render, regenerated with
  `MOCHI2D_UPDATE_IMAGES=1 npx vitest run test/readme-screenshot.test.ts test/sample-mochi.test.ts`
  after `npm run build`.
- **`CHANGELOG.md`:** an entry under the next version.

`test/public-text.test.ts` keeps the public files free of references to
private records. If it flags a line, state the rule or the fact itself.

## The clean-room rule

Mochi2D is written from scratch, through the process in
[CLEANROOM.md](CLEANROOM.md). A contribution may not draw on Live2D's own
code or documentation, or on other implementations of the format.

Each pull request confirms, in its description:

> I have not viewed, decompiled or copied Live2D's SDK, Cubism Core,
> Framework, sample code or manuals, or third-party `.moc3`
> implementations, for this contribution.

**What you may use:**

- the model files themselves (`.moc3`, JSON, textures, audio), within
  their terms;
- this repository's docs;
- general programming, graphics and math knowledge.

**If you're unsure** whether a source is allowed, ask in an issue before
you use it.

## Sign-off (DCO)

Every commit is signed off under the
[Developer Certificate of Origin](https://developercertificate.org/): by
adding the line

```
Signed-off-by: Your Name <you@example.com>
```

you certify that you wrote the change, or have the right to submit it,
under the project's license. `git commit -s` adds the line. A pull request
whose commits aren't signed off can't be merged.

## License

Contributions are licensed under the [MIT License](LICENSE), as the rest of
Mochi2D is.

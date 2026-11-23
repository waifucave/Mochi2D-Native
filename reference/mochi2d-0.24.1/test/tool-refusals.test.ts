/**
 * Refusals through the built tools: the `mochi2d` command line and the MCP
 * server on crafted models (a texture past the caps, a texture whose header
 * lies, a texture file past the file cap, a zip past the archive caps, a
 * damaged .moc3). A refusal fails the
 * command with the error's name and message, its typed fields in --json and
 * in the MCP result, and no output file. Skipped until the tools are built;
 * renders also need dist/web and Playwright's Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadPlaywright } from "../tools/lib/browser.js";
import { craftPng, pngWithData } from "./support/texture-bombs.js";

const root = resolve(__dirname, "..");
const CLI = join(root, "dist", "tools", "mochi2d.js");
const SERVER = join(root, "dist", "tools", "mochi2d-mcp.js");
const built = existsSync(CLI) && existsSync(SERVER);
let canRender = built && existsSync(join(root, "dist", "web", "harness.html"));
try {
  loadPlaywright();
} catch {
  canRender = false;
}

let dir = "";
const models: Record<string, string> = {};

/** A copy of the sample «Mochi» with `change` applied to its folder. */
function sample(name: string, change: (folder: string) => void): string {
  const folder = join(dir, name);
  cpSync(join(root, "samples/mochi"), folder, { recursive: true });
  change(folder);
  return folder;
}

beforeAll(() => {
  if (!built) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mochi2d-refusals-")));
  const texture = (folder: string) => join(folder, "mochi.4096", "texture_00.png");
  // An honest PNG of zeros declaring 20,000²: over the default side cap.
  models.huge = sample("huge", (f) =>
    writeFileSync(texture(f), craftPng({ width: 20000, height: 20000 })),
  );
  // 312 bytes declaring 30,000²: too little data for its size.
  models.lying = sample("lying", (f) => writeFileSync(texture(f), pngWithData(30000, 30000, 260)));
  // A texture file of 1.5 GiB (sparse: no disk space), past the 1 GiB file cap.
  models.sparse = sample("sparse", (f) => truncateSync(texture(f), 1.5 * 2 ** 30));
  // A damaged .moc3: cut in half.
  models.damaged = sample("damaged", (f) => {
    const moc = readFileSync(join(f, "mochi.moc3"));
    writeFileSync(join(f, "mochi.moc3"), moc.subarray(0, moc.length >> 1));
  });
  // A zip of the sample whose directory lists more than 10,000 entries.
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string, prefix: string) => {
    for (const name of [
      "mochi.model3.json",
      "mochi.moc3",
      "mochi.physics3.json",
      "mochi.cdi3.json",
    ])
      files[`${prefix}${name}`] = readFileSync(join(d, name));
    files[`${prefix}mochi.4096/texture_00.png`] = readFileSync(
      join(d, "mochi.4096/texture_00.png"),
    );
    files[`${prefix}motions/idle.motion3.json`] = readFileSync(
      join(d, "motions/idle.motion3.json"),
    );
    for (let i = 0; i < 10_001; i++) files[`${prefix}pad/${i}.txt`] = new Uint8Array(0);
  };
  walk(join(root, "samples/mochi"), "mochi/");
  models.bomb = join(dir, "bomb.zip");
  writeFileSync(models.bomb, zipSync(files, { level: 0 }));
}, 120_000);
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 170_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!built)("the command line", () => {
  it.runIf(canRender)(
    "render: a texture past the caps fails, with no file written",
    () => {
      const out = join(dir, "huge.png");
      const r = cli(["render", models.huge!, "--out", out, "--size", "64x64"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(
        /^mochi2d: TextureLimitError: "mochi\.4096\/texture_00\.png" declares 20000×20000 pixels/,
      );
      expect(existsSync(out)).toBe(false);
      const j = cli(["render", models.huge!, "--out", out, "--size", "64x64", "--json"]);
      expect(j.code).toBe(1);
      expect(JSON.parse(j.out).error).toMatchObject({
        name: "TextureLimitError",
        kind: "side",
        limit: 16384,
        size: 20000,
        width: 20000,
        height: 20000,
        path: "mochi.4096/texture_00.png",
      });
      expect(existsSync(out)).toBe(false);
    },
    180_000,
  );

  it.runIf(canRender)(
    "render: a texture whose header lies fails as damaged",
    () => {
      const out = join(dir, "lying.png");
      const r = cli(["render", models.lying!, "--out", out, "--json"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/^mochi2d: TextureFormatError: .*too few for a PNG file/);
      expect(JSON.parse(r.out).error).toMatchObject({
        name: "TextureFormatError",
        path: "mochi.4096/texture_00.png",
      });
      expect(existsSync(out)).toBe(false);
    },
    180_000,
  );

  it.runIf(canRender)(
    "render: a texture file past the file cap fails with the FileLimitError describe promises",
    () => {
      const d = cli(["describe", models.sparse!, "--json"]);
      expect(d.code).toBe(0);
      expect(JSON.parse(d.out).warnings.join("\n")).toMatch(
        /textures: a render would fail: FileLimitError: "mochi\.4096\/texture_00\.png" holds 1610612736 bytes/,
      );
      const out = join(dir, "sparse.png");
      const before = Date.now();
      const r = cli(["render", models.sparse!, "--out", out, "--json"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(
        /^mochi2d: FileLimitError: "mochi\.4096\/texture_00\.png" holds 1610612736 bytes or more, more than the 1073741824 allowed for one file/,
      );
      expect(r.err).not.toMatch(/page\.evaluate|not found/);
      expect(JSON.parse(r.out).error).toEqual({
        name: "FileLimitError",
        message:
          '"mochi.4096/texture_00.png" holds 1610612736 bytes or more, more than the 1073741824 allowed for one file',
        path: "mochi.4096/texture_00.png",
        kind: "file",
        limit: 2 ** 30,
        size: 1.5 * 2 ** 30,
      });
      expect(existsSync(out)).toBe(false);
      // Refused on its size: nothing is read.
      expect(Date.now() - before).toBeLessThan(60_000);
    },
    180_000,
  );

  it("describe reports the textures' sizes and the refusal a render would meet", () => {
    const r = cli(["describe", models.huge!, "--json"]);
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.textures).toEqual([
      { path: "mochi.4096/texture_00.png", width: 20000, height: 20000, format: "png" },
    ]);
    expect(d.texturesRefused).toMatchObject({ name: "TextureLimitError", kind: "side" });
    expect(d.warnings.join("\n")).toMatch(/textures: a render would fail: TextureLimitError/);
    const t = cli(["describe", models.huge!]);
    expect(t.out).toMatch(/warnings:\n.*a render would fail/);
    // The genuine sample: its texture, and no refusal.
    const g = JSON.parse(cli(["describe", join(root, "samples/mochi"), "--json"]).out);
    expect(g.textures).toEqual([
      { path: "mochi.4096/texture_00.png", width: 2048, height: 512, format: "png" },
    ]);
    expect(g.texturesRefused).toBeUndefined();
  }, 60_000);

  it("params and hit-test, which decode no texture, still work", () => {
    expect(cli(["params", models.huge!]).code).toBe(0);
    expect(cli(["hit-test", models.huge!, "--at", "0,0"]).code).toBe(0);
  }, 60_000);

  it("a zip past the archive caps fails every command that opens it", () => {
    for (const args of [
      ["describe", models.bomb!],
      ["params", models.bomb!],
      ["hit-test", models.bomb!, "--at", "0,0"],
      ["render", models.bomb!, "--out", join(dir, "bomb.png")],
    ]) {
      const r = cli([...args, "--json"]);
      expect(r.code, args[0]).toBe(1);
      expect(r.err).toMatch(
        /^mochi2d: ArchiveLimitError: bomb\.zip: the archive lists 10007 entries/,
      );
      expect(JSON.parse(r.out).error).toMatchObject({
        name: "ArchiveLimitError",
        kind: "entries",
        limit: 10000,
      });
    }
    expect(existsSync(join(dir, "bomb.png"))).toBe(false);
    // list names models without opening them.
    const l = JSON.parse(cli(["list", dir, "--json"]).out);
    expect(l.models.map((m: { path: string }) => m.path)).toContain(models.bomb);
  }, 120_000);

  it("a damaged .moc3 fails to load and to validate, with its error", () => {
    const r = cli(["describe", models.damaged!, "--json"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mochi2d: MocFormatError: /);
    expect(JSON.parse(r.out).error.name).toBe("MocFormatError");
    const v = cli(["validate", join(models.damaged!, "mochi.moc3"), "--json"]);
    expect(v.code).toBe(1);
    expect(JSON.parse(v.out)).toMatchObject({ valid: false });
  }, 60_000);
});

describe.skipIf(!built)("the MCP server", () => {
  let client: Client;
  type Result = {
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args }, undefined, { timeout: 170_000 })) as Result;
  const text = (r: Result) => r.content.map((c) => c.text ?? "").join("\n");
  beforeAll(async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    client = new Client({ name: "mochi2d-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER, `--root=${dir}`],
        env,
        cwd: root,
      }),
    );
  }, 60_000);
  afterAll(async () => {
    await client?.close();
  });

  it.runIf(canRender)(
    "load_model warns; render fails with the typed error",
    async () => {
      const loaded = await call("load_model", { path: models.huge });
      expect(loaded.isError).toBeFalsy();
      expect(
        (loaded.structuredContent!.loaded as Record<string, unknown>).texturesRefused,
      ).toMatchObject({
        name: "TextureLimitError",
      });
      const r = await call("render", { width: 64, height: 64 });
      expect(r.isError).toBe(true);
      expect(r.content.some((c) => c.type === "image")).toBe(false);
      expect(text(r)).toMatch(
        /^TextureLimitError: "mochi\.4096\/texture_00\.png" declares 20000×20000/,
      );
      expect(r.structuredContent!.error).toMatchObject({
        name: "TextureLimitError",
        kind: "side",
        width: 20000,
      });
    },
    180_000,
  );

  it.runIf(canRender)(
    "render: a texture file past the file cap fails with its FileLimitError",
    async () => {
      expect((await call("load_model", { path: models.sparse })).isError).toBeFalsy();
      const r = await call("render", { width: 64, height: 64 });
      expect(r.isError).toBe(true);
      expect(r.content.some((c) => c.type === "image")).toBe(false);
      expect(text(r)).toMatch(
        /^FileLimitError: "mochi\.4096\/texture_00\.png" holds 1610612736 bytes/,
      );
      expect(r.structuredContent!.error).toMatchObject({
        name: "FileLimitError",
        path: "mochi.4096/texture_00.png",
        kind: "file",
        limit: 2 ** 30,
        size: 1.5 * 2 ** 30,
      });
    },
    180_000,
  );

  it("a zip past the archive caps fails to load, with the typed error", async () => {
    const r = await call("load_model", { path: models.bomb });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^ArchiveLimitError: bomb\.zip: the archive lists/);
    expect(r.structuredContent!.error).toMatchObject({
      name: "ArchiveLimitError",
      kind: "entries",
    });
  }, 60_000);

  it("a damaged .moc3 fails to load, with its error", async () => {
    const r = await call("load_model", { path: models.damaged });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^MocFormatError: /);
  }, 60_000);
});

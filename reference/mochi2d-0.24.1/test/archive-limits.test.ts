/**
 * Caps on what a zip archive may inflate to (`ArchiveLimits`): crafted
 * archives are refused with the typed error and bounded memory, measured in
 * a fresh process per case; genuine archives of real models' sizes load with
 * the default caps the tools use. All crafted archives are built here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as zlib from "node:zlib";
import { buildSync } from "esbuild";
import { zipSync } from "fflate";
import {
  ArchiveLimitError,
  DEFAULT_ARCHIVE_LIMITS,
  sourceFromZip,
  ZipFileSource,
  ZipFormatError,
} from "../src/runtime/zip-source.js";
import { crc32 } from "../src/runtime/zip-archive.js";
import { ModelRuntime } from "../src/runtime/model-runtime.js";
import { resolveSettingsPath } from "../src/runtime/bundle.js";
import { openModelInput } from "../src/lib/sources.js";
import { loadModelFromDisk } from "../src/lib/node.js";
import { sourceFromZipFile } from "../src/platform/node-sources.js";
import { buildZip } from "./support/zip-writer.js";
import { manySmallZip, overlappingZip, zerosDeflated } from "./support/archive-bombs.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const root = resolve(__dirname, "..");
const MiB = 2 ** 20;
const enc = (s: string) => new TextEncoder().encode(s);

/** A folder's files as a zip held in memory, under `prefix/`. */
function zipFolder(dir: string, prefix: string) {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files[`${prefix}/${relative(dir, p).split("\\").join("/")}`] = readFileSync(p);
    }
  };
  walk(dir);
  return zipSync(files, { level: 6 });
}

describe("crafted archives, each in a fresh process (peak memory measured)", () => {
  let dir: string;
  let child: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mochi2d-archive-"));
    child = join(dir, "child.mjs");
    buildSync({
      entryPoints: [join(root, "test/support/archive-limits-child.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: child,
      logLevel: "error",
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  interface Outcome {
    error?: {
      name: string;
      message: string;
      kind?: string;
      limit?: number;
      size?: number;
      path?: string;
    };
    inflated: number;
    read: number;
    ms: number;
    /** How far the process's peak resident memory rose while opening and reading. */
    peakRise: number;
  }
  const run = (name: string): Outcome => {
    const r = spawnSync(process.execPath, ["--expose-gc", child, name], {
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Outcome;
  };

  it("an entry that inflates far past its declared size: stops at the declared size", () => {
    // 512 MiB of zeros whose records declare 1 KiB, with the default caps.
    const o = run("lying-size");
    expect(o.error?.name).toBe("ZipFormatError");
    expect(o.error?.message).toMatch(/inflates past the 1024 bytes its directory record declares/);
    expect(o.inflated).toBe(0);
    expect(o.peakRise).toBeLessThan(64 * MiB);
  }, 120_000);

  it("the same data declared honestly: over the entry cap, refused before inflating", () => {
    const o = run("honest-size");
    expect(o.error).toMatchObject({
      name: "ArchiveLimitError",
      kind: "entry",
      limit: DEFAULT_ARCHIVE_LIMITS.maxEntryBytes,
      size: 512 * MiB,
      path: "f000000.bin",
    });
    expect(o.inflated).toBe(0);
    expect(o.peakRise).toBeLessThan(16 * MiB);
  }, 120_000);

  it("an entry under its cap loads, holding little more than twice its size", () => {
    const o = run("under-cap");
    expect(o.error).toBeUndefined();
    expect(o.inflated).toBe(48 * MiB);
    // The entry, and the inflater's spent chunks until the collector frees them (75–95 MiB seen).
    expect(o.peakRise).toBeLessThan(2 * 48 * MiB + 24 * MiB);
  }, 120_000);

  it("many small entries whose total passes the cap", () => {
    // 400 files of 64 KiB (25 MiB in all) against a 4 MiB total.
    const o = run("many-small");
    expect(o.error).toMatchObject({
      name: "ArchiveLimitError",
      kind: "total",
      limit: 4 * MiB,
      path: "textures/t0064.bin",
    });
    expect(o.read).toBe(64);
    expect(o.inflated).toBeLessThanOrEqual(4 * MiB);
    expect(o.peakRise).toBeLessThan(16 * MiB);
  }, 120_000);

  it("one entry listed 1,000 times (8 GiB in all): the default total cap", () => {
    const o = run("overlapping");
    expect(o.error).toMatchObject({
      name: "ArchiveLimitError",
      kind: "total",
      limit: DEFAULT_ARCHIVE_LIMITS.maxTotalBytes,
    });
    expect(o.inflated).toBeLessThanOrEqual(DEFAULT_ARCHIVE_LIMITS.maxTotalBytes);
    expect(o.read).toBe(128);
    // Each 8 MiB read is let go; what remains is the collector's slack.
    expect(o.peakRise).toBeLessThan(384 * MiB);
  }, 120_000);

  it("a directory with more entries than allowed: refused on opening", () => {
    const o = run("many-entries");
    expect(o.error).toMatchObject({
      name: "ArchiveLimitError",
      kind: "entries",
      limit: DEFAULT_ARCHIVE_LIMITS.maxEntries,
      size: 20_000,
      path: "crafted.zip",
    });
    expect(o.read).toBe(0);
    expect(o.peakRise).toBeLessThan(8 * MiB);
  }, 120_000);
});

describe("crafted archives in this process", () => {
  it.runIf(typeof zlib.crc32 === "function")("the CRC-32 agrees with zlib's", () => {
    const b = new Uint8Array(100_003).map((_, i) => (Math.imul(i, 2654435761) >>> 23) & 0xff);
    for (const n of [0, 1, 7, 8, 9, 15, 16, 17, 1000, 100_003])
      expect(crc32(b.subarray(0, n))).toBe(zlib.crc32(b.subarray(0, n)));
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
  });

  it("a wrong CRC-32 is refused, stored or deflated", async () => {
    const data = enc("some texture bytes ".repeat(200));
    for (const deflate of [false, true]) {
      const zip = buildZip([{ name: "a.png", data, deflate }]);
      // The CRC-32 sits at offset 14 of the local header and 16 of the central record.
      const bad = zip.slice();
      const dv = new DataView(bad.buffer);
      const cd = bad.length - 22 - (46 + 5);
      dv.setUint32(cd + 16, (crc32(data) ^ 1) >>> 0, true);
      await expect(sourceFromZip("good.zip", zip).read("a.png")).resolves.toEqual(data);
      await expect(sourceFromZip("bad.zip", bad).read("a.png")).rejects.toThrow(
        /"a\.png" is damaged: its CRC-32 does not match/,
      );
    }
  });

  it("a wrong CRC-32 with the data's true size, built with the writer's raw override", async () => {
    const z = zerosDeflated(1);
    const zip = buildZip([
      { name: "z.bin", data: new Uint8Array(0), deflate: true, raw: { ...z, crc: z.crc ^ 0xff } },
    ]);
    await expect(sourceFromZip("bad.zip", zip).read("z.bin")).rejects.toThrow(ZipFormatError);
  });

  it("the error says which entry and cap, and is an ArchiveLimitError", async () => {
    const zip = manySmallZip(3, 4);
    const source = sourceFromZip("m.zip", zip, { maxEntryBytes: 1024 });
    const err = await source.read("textures/t0001.bin").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveLimitError);
    expect(err).toMatchObject({
      path: "textures/t0001.bin",
      kind: "entry",
      limit: 1024,
      size: 4096,
    });
    expect((err as Error).name).toBe("ArchiveLimitError");
    expect(() => sourceFromZip("m.zip", zip, { maxEntries: 2 })).toThrow(ArchiveLimitError);
    expect(() => sourceFromZip("m.zip", zip, { maxEntries: 3 })).not.toThrow();
  });

  it("an entry read again is counted once toward the total", async () => {
    const source = sourceFromZip("m.zip", manySmallZip(4, 64), { maxTotalBytes: 128 * 1024 });
    for (let i = 0; i < 5; i++) await source.read("textures/t0000.bin");
    await source.read("textures/t0001.bin");
    expect(source.inflatedBytes).toBe(128 * 1024);
    await source.read("textures/t0001.bin");
    await expect(source.read("textures/t0002.bin")).rejects.toMatchObject({ kind: "total" });
    // The refused entry didn't count, and the ones read still read.
    expect(source.inflatedBytes).toBe(128 * 1024);
    await expect(source.read("textures/t0000.bin")).resolves.toHaveLength(64 * 1024);
  });

  it("a declared size over the total is refused before inflating", async () => {
    const z = zerosDeflated(64);
    const zip = overlappingZip({ ...z, deflate: true }, 1);
    const source = sourceFromZip("z.zip", zip, { maxTotalBytes: 32 * MiB });
    await expect(source.read("f000000.bin")).rejects.toMatchObject({
      kind: "total",
      size: 64 * MiB,
    });
    expect(source.inflatedBytes).toBe(0);
  });

  it("the name decoding's own reads of settings files are capped too", () => {
    // A settings file past the entry cap is not read to choose an encoding; the archive still opens.
    const settings = enc(JSON.stringify({ Version: 3, FileReferences: { Moc: "m.moc3" } }));
    const zip = buildZip([
      { name: new Uint8Array([0x8e, 0xa0, 0x2e, 0x6d]), data: "x" },
      { name: "m.model3.json", data: settings },
    ]);
    const source = sourceFromZip("s.zip", zip, { maxEntryBytes: 8 });
    expect(source.list()).toContain("m.model3.json");
    expect(source.inflatedBytes).toBe(0);
  });

  it("a zip inside a zip is an entry like any other: it is never opened", async () => {
    const inner = zipSync({ "m.model3.json": enc("{}") });
    const outer = zipSync({ "inner.zip": inner });
    const source = sourceFromZip("outer.zip", outer);
    expect(source.list()).toEqual(["inner.zip"]);
    await expect(openModelInput(new Blob([outer], { type: "application/zip" }))).rejects.toThrow();
    expect(source.inflatedBytes).toBe(0);
  });

  it("caps must be numbers ≥ 0; Infinity turns one off", () => {
    const zip = manySmallZip(1, 1);
    for (const bad of [-1, Number.NaN, "5" as unknown as number])
      expect(() => sourceFromZip("x.zip", zip, { maxEntryBytes: bad })).toThrow(RangeError);
    const source = sourceFromZip("x.zip", zip, { maxEntryBytes: Infinity, maxTotalBytes: 0 });
    expect(source.limits).toEqual({
      maxEntryBytes: Infinity,
      maxTotalBytes: 0,
      maxEntries: DEFAULT_ARCHIVE_LIMITS.maxEntries,
    });
    expect(sourceFromZip("x.zip", zip).limits).toEqual(DEFAULT_ARCHIVE_LIMITS);
    expect(Object.isFrozen(DEFAULT_ARCHIVE_LIMITS)).toBe(true);
  });
});

describe("the caps reach every way a zip is opened", () => {
  const sample = zipFolder(join(root, "samples/mochi"), "mochi");
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mochi2d-archive-"));
    writeFileSync(join(dir, "mochi.zip"), sample);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const tiny = { maxEntryBytes: 1024 };

  it("openModelInput (a Blob, a File list, bytes in a source)", async () => {
    // Opening reads only what finding the settings needs; the caps bite on reading.
    const blob = new Blob([sample], { type: "application/zip" });
    const file = new File([sample], "mochi.zip");
    for (const input of [blob, [file]]) {
      const open = await openModelInput(input);
      expect((open.source as ZipFileSource).limits).toEqual(DEFAULT_ARCHIVE_LIMITS);
      const capped = await openModelInput(input, undefined, tiny);
      expect((capped.source as ZipFileSource).limits.maxEntryBytes).toBe(1024);
      await expect(ModelRuntime.load(capped.source, capped.settingsPath)).rejects.toThrow(
        ArchiveLimitError,
      );
    }
  });

  it("loadModelFromDisk and sourceFromZipFile", async () => {
    const path = join(dir, "mochi.zip");
    const rt = await loadModelFromDisk(path);
    expect(rt.parameters.length).toBeGreaterThan(0);
    await expect(loadModelFromDisk(path, { archive: tiny })).rejects.toThrow(ArchiveLimitError);
    const source = await sourceFromZipFile(path, { maxTotalBytes: 1024 });
    const settings = await resolveSettingsPath(source);
    await expect(ModelRuntime.load(source, settings)).rejects.toThrow(ArchiveLimitError);
  });
});

describe("genuine archives load with the default caps", () => {
  it("the sample «Mochi»", async () => {
    const source = sourceFromZip("mochi.zip", zipFolder(join(root, "samples/mochi"), "mochi"));
    const rt = await ModelRuntime.load(source, await resolveSettingsPath(source));
    rt.update(1 / 30);
    expect(source.inflatedBytes).toBeGreaterThan(0);
  });

  it.runIf(HAVE_DEEPSEEK)(
    "DeepSeek-chan as a zip",
    async () => {
      const source = sourceFromZip("deepseek.zip", zipFolder(DEEPSEEK, "DeepSeek"));
      const rt = await ModelRuntime.load(source, await resolveSettingsPath(source));
      rt.update(1 / 30);
      for (const path of source.list()) await source.read(path);
      expect(source.inflatedBytes).toBeLessThan(DEFAULT_ARCHIVE_LIMITS.maxTotalBytes / 8);
    },
    120_000,
  );

  // Downloaded models (assets/models/incoming/, gitignored), when present: every entry reads.
  const incoming = join(root, "assets/models/incoming");
  const zips = existsSync(incoming) ? readdirSync(incoming).filter((f) => f.endsWith(".zip")) : [];
  it.runIf(zips.length > 0)(
    `the downloaded model archives (${zips.length})`,
    async () => {
      for (const name of zips) {
        const source = sourceFromZip(name, readFileSync(join(incoming, name)));
        for (const path of source.list()) await source.read(path);
        expect(source.inflatedBytes).toBeLessThan(DEFAULT_ARCHIVE_LIMITS.maxTotalBytes / 8);
      }
    },
    300_000,
  );
});

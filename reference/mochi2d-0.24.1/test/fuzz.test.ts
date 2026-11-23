/**
 * Fuzzing the loaders, a short pass (tools/lib/fuzz.ts; `npm run fuzz` runs
 * the long one): mutated synthetic models and hand-written JSON, WAV and zip
 * files through every loader, which may throw only its documented errors,
 * and each input within a time limit. Then the inputs the long runs found,
 * as regression tests.
 */
import { describe, expect, it } from "vitest";
import { TARGETS, fuzz, mocSeeds, modelFiles, wavFile } from "../tools/lib/fuzz.js";
import { zipSync } from "fflate";
import { sourceFromZip } from "../src/runtime/zip-source.js";
import { ArchiveLimitError, ZipFormatError } from "../src/runtime/zip-archive.js";
import { readMoc, writeMoc, MocWriteError } from "../src/core/moc/io.js";
import { decodeWav, WavFormatError } from "../src/anim/lip-sync.js";
import { decodeMotionSyncWav, MotionSyncAudioError } from "../src/anim/motion-sync/wav.js";

describe("fuzzing the loaders (short pass)", () => {
  for (const target of TARGETS)
    it(
      target.name,
      async () => {
        // The seeds load on their own.
        for (const seed of target.seeds()) await target.run(seed);
        const failures = await fuzz(target, {
          iterations: target.name === "model" ? 150 : 400,
          seed: 1,
          timeLimit: 3000,
        });
        expect(failures.map((f) => f.reason)).toEqual([]);
      },
      120000,
    );
});

describe("what the long runs found", () => {
  it("zip: damaged deflate data is a ZipFormatError", async () => {
    const zip = zipSync({ "a.txt": new TextEncoder().encode("hello ".repeat(100)) }, { level: 6 });
    // The compressed data starts after the 30-byte local header and the 5-byte name:
    // its first block given the reserved block type 3.
    const bad = zip.slice();
    bad[35] = 0xff;
    await expect(sourceFromZip("bad.zip", bad).read("a.txt")).rejects.toThrow(ZipFormatError);
  });

  it("zip: a size beyond what deflate produces is refused before it is allocated", async () => {
    const zip = zipSync({ "a.txt": new TextEncoder().encode("hello") }, { level: 6 });
    const dv = new DataView(zip.buffer);
    // The central directory's uncompressed size (offset 24 of its record).
    const cd = zip.length - 22 - (46 + 5);
    dv.setUint32(cd + 24, 0xfffffff0, true);
    // With no caps the ratio check refuses it; with the defaults, the caps do.
    const uncapped = sourceFromZip("big.zip", zip, {
      maxEntryBytes: Infinity,
      maxTotalBytes: Infinity,
    });
    await expect(uncapped.read("a.txt")).rejects.toThrow(/more than deflate produces/);
    await expect(sourceFromZip("big.zip", zip).read("a.txt")).rejects.toThrow(ArchiveLimitError);
  });

  it("moc3: a corrupt keyform count is checked quickly", () => {
    const bytes = mocSeeds()[4]!;
    const read = readMoc(bytes);
    // Keyform counts far beyond the file.
    read.data.warpDeformers.keyformCount[0] = 860049229;
    read.data.artMeshes.keyformCount[0] = 860049229;
    const t0 = performance.now();
    expect(() => writeMoc(read.data, { version: read.version })).toThrow(MocWriteError);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("WAV: 0 bits per sample, and motion-sync rates outside 1–768 kHz, are refused", () => {
    const zeroBits = wavFile({ rate: 16000, channels: 1, bits: 16, frames: 10 });
    new DataView(zeroBits.buffer).setUint16(34, 0, true);
    expect(() => decodeWav(zeroBits)).toThrow(WavFormatError);
    for (const rate of [999, 2143289344]) {
      const odd = wavFile({ rate: 16000, channels: 1, bits: 16, frames: 10 });
      new DataView(odd.buffer).setUint32(24, rate, true);
      expect(() => decodeMotionSyncWav(odd)).toThrow(MotionSyncAudioError);
    }
    for (const rate of [8000, 768000])
      expect(
        decodeMotionSyncWav(wavFile({ rate, channels: 1, bits: 16, frames: 10 })).sampleRate,
      ).toBe(rate);
  });

  it("physics: a rate so high the steps would never end is limited per frame", async () => {
    const model = TARGETS.find((t) => t.name === "model")!;
    const names = Object.keys(modelFiles(mocSeeds()[4]!));
    const physics = new TextDecoder().decode(modelFiles(mocSeeds()[4]!)["m.physics3.json"]);
    expect(physics).toContain('"Fps":30');
    // 1e309 reads as Infinity.
    for (const fps of ["1e+308", "1e309", "5e-324"]) {
      const file = new TextEncoder().encode(physics.replace('"Fps":30', `"Fps":${fps}`));
      const input = new Uint8Array([names.indexOf("m.physics3.json"), ...file]);
      const t0 = performance.now();
      await model.run(input);
      expect(performance.now() - t0, fps).toBeLessThan(2000);
    }
  });
});

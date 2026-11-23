/**
 * One crafted-archive case in a fresh process, so that its peak memory can be
 * measured (test/archive-limits.test.ts bundles and runs this file). Builds
 * the case's archive, then opens it and reads every entry, and prints one
 * line of JSON: the error, the bytes inflated, the time, and how far the
 * process's peak resident memory rose above what it held just before.
 *
 * Usage: node child.mjs <case>
 */
import { sourceFromZip, type ArchiveLimits } from "../../src/runtime/zip-source.js";
import { manySmallZip, overlappingZip, zerosDeflated } from "./archive-bombs.js";

const MiB = 2 ** 20;
const name = process.argv[2];

function build(): { zip: Uint8Array; limits: ArchiveLimits } {
  switch (name) {
    // 512 MiB of zeros whose records declare 1 KiB: the default caps.
    case "lying-size": {
      const z = zerosDeflated(512);
      return { zip: overlappingZip({ ...z, size: 1024, deflate: true }, 1), limits: {} };
    }
    // The same data declared honestly, as 512 MiB: over the default entry cap.
    case "honest-size": {
      const z = zerosDeflated(512);
      return { zip: overlappingZip({ ...z, deflate: true }, 1), limits: {} };
    }
    // 48 MiB declared honestly, under a 64 MiB entry cap: it loads.
    case "under-cap": {
      const z = zerosDeflated(48);
      return {
        zip: overlappingZip({ ...z, deflate: true }, 1),
        limits: { maxEntryBytes: 64 * MiB },
      };
    }
    // 400 files of 64 KiB (25 MiB) against a 4 MiB total.
    case "many-small":
      return { zip: manySmallZip(400, 64), limits: { maxTotalBytes: 4 * MiB } };
    // One 8 MiB entry listed 1,000 times (8 GiB in all): the default total cap.
    case "overlapping": {
      const z = zerosDeflated(8);
      return { zip: overlappingZip({ ...z, deflate: true }, 1000), limits: {} };
    }
    // A directory of 20,000 records: over the default entry count.
    case "many-entries": {
      const z = zerosDeflated(1);
      return { zip: overlappingZip({ ...z, deflate: true }, 20_000), limits: {} };
    }
    default:
      throw new Error(`unknown case ${name}`);
  }
}

const { zip, limits } = build();
globalThis.gc?.();
const before = process.memoryUsage().rss;
const t0 = performance.now();
let error: Record<string, unknown> | undefined;
let inflated = 0;
let read = 0;
try {
  const source = sourceFromZip("crafted.zip", zip, limits);
  try {
    for (const path of source.list()) {
      await source.read(path);
      read++;
    }
  } finally {
    inflated = source.inflatedBytes;
  }
} catch (e) {
  const err = e as Error & Record<string, unknown>;
  error = {
    name: err.name,
    message: err.message,
    kind: err.kind,
    limit: err.limit,
    size: err.size,
    path: err.path,
  };
}
const ms = performance.now() - t0;
// ru_maxrss is in KiB.
const peakRise = Math.max(0, process.resourceUsage().maxRSS * 1024 - before);
console.log(JSON.stringify({ error, inflated, read, ms, peakRise }));

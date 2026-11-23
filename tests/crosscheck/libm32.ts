/**
 * Vectors of Mochi2D's own port of musl's float32 functions
 * (src/core/math/libm32.ts): atanf, sinf and cosf on special values, the
 * neighbours of every multiple of π/4 up to 2^16 and of the range
 * thresholds, huge arguments, and random bit patterns; atan2f on special
 * pairs and random ones. mochi2d_check_libm32 compares them with the
 * vendored musl files (third_party/musl), bit for bit.
 *
 * usage: node libm32.mjs <out file> [--random N]
 * File: u32 counts (unary, pairs), then per input its bits and the bits of
 * atanf, sinf, cosf; then per pair y, x and atan2f. Little-endian.
 */
import { writeFileSync } from "node:fs";
import { atan2f, atanf, cosf, sinf } from "../../reference/mochi2d-0.24.1/src/core/math/libm32.js";

const out = process.argv[2];
if (!out) {
  console.error("usage: node libm32.mjs <out file> [--random N]");
  process.exit(2);
}
const ri = process.argv.indexOf("--random");
const RANDOM = ri >= 0 ? Number(process.argv[ri + 1]) : 1 << 21;

const scratch = new DataView(new ArrayBuffer(4));
const f32 = (u: number) => {
  scratch.setUint32(0, u >>> 0);
  return scratch.getFloat32(0);
};
const bits = (x: number) => {
  scratch.setFloat32(0, x);
  return scratch.getUint32(0);
};

let s = 0x2545f491;
const rnd = () => {
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return s >>> 0;
};

const unary: number[] = [];
const add = (u: number) => unary.push(u >>> 0);
for (const u of [
  0x00000000, 0x00000001, 0x007fffff, 0x00800000, 0x33800000, 0x39800000, 0x397fffff, 0x3ee00000, 0x3edfffff,
  0x3f300000, 0x3f980000, 0x401c0000, 0x3f490fda, 0x3f490fdb, 0x407b53d1, 0x4016cbe3, 0x40e231d5, 0x40afeddf,
  0x4dc90fdb, 0x4dc90fda, 0x4c800000, 0x7f7fffff, 0x7f800000, 0x7fc00000, 0x7f800001, 0x3f800000, 0x4b000000,
])
  for (const sign of [0, 0x80000000]) add(u | sign);
// Neighbours of k·π/4 (the reduction's boundaries) for k up to 2^16, and of the thresholds.
for (let k = 1; k <= 1 << 16; k++) {
  const c = bits(Math.fround((k * Math.PI) / 4));
  for (let d = -2; d <= 2; d++) {
    add(c + d);
    add((c + d) | 0x80000000);
  }
}
// Huge arguments (__rem_pio2_large), every exponent from 2^28 up.
for (let e = 0x4d800000; e < 0x7f800000; e += 0x00800000)
  for (let m = 0; m < 64; m++) add(e + ((m * 0x2f1b3) & 0x7fffff));
for (let i = 0; i < RANDOM; i++) add(rnd());

const pairs: [number, number][] = [];
const specials = [
  0x00000000, 0x80000000, 0x00000001, 0x80000001, 0x00800000, 0x3f800000, 0xbf800000, 0x3f800001, 0x40490fdb,
  0xc0490fdb, 0x4c800000, 0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000, 0x7fc00000, 0x3edfffff, 0x3f980000,
  0x39800000, 0x40000000,
];
for (const y of specials) for (const x of specials) pairs.push([y, x]);
for (let i = 0; i < RANDOM >> 1; i++) pairs.push([rnd(), rnd()]);
// Ratios around 2^±26 (atan2f's cut-offs) with neighbours.
for (let i = 0; i < 4096; i++) {
  const base = 0x3f800000 + ((i & 63) << 17);
  const off = (((i >> 6) & 63) - 32) | 0;
  pairs.push([base + (26 << 23) + off, base]);
  pairs.push([base, base + (26 << 23) + off]);
}

const buf = Buffer.alloc(8 + unary.length * 16 + pairs.length * 12);
let o = 0;
buf.writeUInt32LE(unary.length, o);
buf.writeUInt32LE(pairs.length, o + 4);
o += 8;
for (const u of unary) {
  const x = f32(u);
  buf.writeUInt32LE(u, o);
  buf.writeUInt32LE(bits(atanf(x)), o + 4);
  buf.writeUInt32LE(bits(sinf(x)), o + 8);
  buf.writeUInt32LE(bits(cosf(x)), o + 12);
  o += 16;
}
for (const [y, x] of pairs) {
  buf.writeUInt32LE(y >>> 0, o);
  buf.writeUInt32LE(x >>> 0, o + 4);
  buf.writeUInt32LE(bits(atan2f(f32(y), f32(x))), o + 8);
  o += 12;
}
writeFileSync(out, buf);
console.log(`libm32 vectors: ${unary.length} inputs × 3 functions, ${pairs.length} atan2f pairs → ${out}`);

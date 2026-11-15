// Vectors for the vendored fdlibm: Node's Math results, bit for bit, on
// special values, hard arguments and random inputs.
// usage: node math.mjs <out file> [count per function]
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "math.txt";
const N = Number(process.argv[3] ?? 200000);
const buf = new DataView(new ArrayBuffer(8));
const hex = (x) => {
  buf.setFloat64(0, x);
  return buf.getBigUint64(0).toString(16).padStart(16, "0");
};
const fromBits = (hi, lo) => {
  buf.setUint32(0, hi >>> 0);
  buf.setUint32(4, lo >>> 0);
  return buf.getFloat64(0);
};
let s = 0x9e3779b9;
const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);

const specials = [0, -0, Infinity, -Infinity, NaN, 1, -1, 0.5, -0.5, 2, Math.PI, -Math.PI, Math.PI / 2, Math.PI / 4,
  Math.E, 1e-300, 5e-324, -5e-324, 2.2250738585072014e-308, 1e22, -1e22, 1e300, 1.7976931348623157e308, 0.1, 3, 1e-8,
  Math.fround(0.1), 7.0, 710, -745, 709.782712893384, -708.3964185322641];
function inputs(kind) {
  const xs = [...specials];
  // Multiples of π/2 and their neighbours (argument reduction).
  for (let k = -2000; k <= 2000; k += 7) {
    const v = (k * Math.PI) / 2;
    xs.push(v, v * (1 + 2 ** -52), v * (1 - 2 ** -52));
  }
  for (const big of [1e6, 1e9, 1e15, 1e20, 2 ** 60, 1e100, 1e200, 1e305]) xs.push(big, -big, big * 1.337);
  while (xs.length < N) {
    const r = rnd();
    if (r < 0.25) xs.push(fromBits(rnd() * 4294967296, rnd() * 4294967296)); // any bits
    else if (r < 0.5) xs.push((rnd() - 0.5) * 2 ** Math.floor(rnd() * 80 - 40)); // wide magnitudes
    else if (r < 0.75) xs.push(Math.fround((rnd() - 0.5) * 2 ** Math.floor(rnd() * 24 - 8))); // float32 values
    else xs.push(kind === "unit" ? rnd() * 2 - 1 : (rnd() - 0.5) * 20); // the usual range
  }
  return xs;
}
const lines = [];
const unary = { sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan, asin: Math.asin, acos: Math.acos,
  exp: Math.exp, expm1: Math.expm1, log: Math.log, log1p: Math.log1p, log2: Math.log2, log10: Math.log10,
  cbrt: Math.cbrt, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh,
  atanh: Math.atanh };
for (const [name, f] of Object.entries(unary)) {
  const kind = ["asin", "acos", "atanh"].includes(name) ? "unit" : "any";
  for (const x of inputs(kind)) lines.push(`${name} ${hex(x)} 0 ${hex(f(x))}`);
}
const xs = inputs("any"), ys = inputs("any");
for (let i = 0; i < xs.length; i++) {
  const y = ys[(i * 7919) % ys.length];
  lines.push(`atan2 ${hex(y)} ${hex(xs[i])} ${hex(Math.atan2(y, xs[i]))}`);
  lines.push(`pow ${hex(xs[i])} ${hex(i % 3 ? y : Math.round(y))} ${hex(Math.pow(xs[i], i % 3 ? y : Math.round(y)))}`);
}
for (const a of specials) for (const b of specials) {
  lines.push(`atan2 ${hex(a)} ${hex(b)} ${hex(Math.atan2(a, b))}`);
  lines.push(`pow ${hex(a)} ${hex(b)} ${hex(Math.pow(a, b))}`);
}
writeFileSync(out, lines.join("\n") + "\n");
console.log(`${lines.length} math vectors → ${out} (Node ${process.version}, V8 ${process.versions.v8})`);

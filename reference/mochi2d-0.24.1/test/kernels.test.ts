/**
 * The WebAssembly kernels must agree bit for bit with the JavaScript kernels
 * (which round every operation with Math.fround). Inputs mix ordinary values
 * with ±0, NaN, ±Infinity, subnormals and huge values; warp points cover the
 * inside, the near band and the far region, odd counts and in-place mapping.
 */
import { describe, expect, it } from "vitest";
import {
  KERNEL_MODULE_BYTES,
  createKernels,
  wasmKernelsAvailable,
  type Kernels,
} from "../src/core/eval/kernels.js";
import { fr } from "../src/core/eval/f32.js";
import { seededRandom } from "../src/core/testing/poses.js";

const FLOATS = 1 << 15;
/** The warp kernel's working space (excluded from the comparison: only WebAssembly uses it). */
const SCRATCH = FLOATS - 16;

const SPECIAL = [0, -0, 1, -1, NaN, Infinity, -Infinity, 1e-40, -1e-42, 3.4e38, -3.4e38, 0.5, 1e-7];

function value(rnd: () => number): number {
  const r = rnd();
  // Kernel arguments are always float32 values in the evaluator.
  if (r < 0.08) return fr(SPECIAL[Math.floor(rnd() * SPECIAL.length)]!);
  if (r < 0.15) return fr((rnd() - 0.5) * 1e-30);
  return fr((rnd() - 0.5) * 2000);
}

/** Runs the same operations on every backend and compares their whole heaps. */
function compare(seed: number, run: (k: Kernels, rnd: () => number) => void): void {
  const heaps: Float32Array[] = [];
  for (const kind of ["wasm", "wasm-scalar", "js"] as const) {
    const k = createKernels(FLOATS, kind);
    expect(k.kind).toBe(kind);
    const rnd = seededRandom(seed);
    for (let i = 0; i < FLOATS; i++) k.heap[i] = value(rnd);
    run(k, rnd);
    heaps.push(k.heap);
  }
  // Each WebAssembly form (4-lane, scalar) against JavaScript.
  const j = heaps[2]!;
  for (const [name, w] of [
    ["wasm", heaps[0]!],
    ["wasm-scalar", heaps[1]!],
  ] as const) {
    let first = -1;
    for (let i = 0; i < SCRATCH && first < 0; i++) if (!Object.is(w[i], j[i])) first = i;
    expect(
      first === -1 ? "identical" : `differs at ${first}: ${name} ${w[first]} js ${j[first]}`,
    ).toBe("identical");
  }
}

/**
 * `count` distinct regions of `size` floats at random (regions never overlap
 * partially; the evaluator only ever passes identical or disjoint regions).
 */
function regions(rnd: () => number, count: number, size: number): number[] {
  const slots = Math.floor(SCRATCH / size);
  const picked = new Set<number>();
  while (picked.size < count) picked.add(Math.floor(rnd() * slots));
  // Random offset inside the slot keeps addresses unaligned.
  return [...picked].map((s) => s * size + Math.floor(rnd() * 4));
}
const tValue = (rnd: () => number) => {
  const r = rnd();
  return r < 0.1 ? 0 : r < 0.15 ? -0 : r < 0.2 ? 1 : r < 0.25 ? NaN : fr(rnd());
};
/** Corner weights: products of t and 1 − t, with zeros, ones, tiny and special values mixed in. */
const weight = (rnd: () => number) => {
  const r = rnd();
  return r < 0.1
    ? 0
    : r < 0.15
      ? 1
      : r < 0.2
        ? fr(1e-40)
        : r < 0.25
          ? value(rnd)
          : fr(rnd() * rnd());
};

describe.skipIf(!wasmKernelsAvailable())("float kernels: WebAssembly = JavaScript", () => {
  it("module stays compact (guards against accidental code bloat)", () => {
    expect(KERNEL_MODULE_BYTES.length).toBeLessThan(8192);
  });

  it("copy, sum1, sum2, sum4 (first pass and accumulating), blend0, blend1, flipY", () => {
    for (let seed = 1; seed <= 40; seed++) {
      compare(seed, (k, rnd) => {
        for (let n = 0; n < 40; n++) {
          const len = Math.floor(rnd() * 37);
          const [d, a, b, c, e] = regions(rnd, 5, 48);
          switch (Math.floor(rnd() * 7)) {
            case 0:
              k.copy(d!, a!, len);
              break;
            case 1:
              k.sum1(d!, a!, rnd() < 0.3 ? 1 : value(rnd), len);
              break;
            case 2:
              k.sum2(d!, a!, b!, weight(rnd), weight(rnd), len);
              break;
            case 3:
              k.sum4(
                d!,
                a!,
                b!,
                c!,
                e!,
                weight(rnd),
                weight(rnd),
                weight(rnd),
                weight(rnd),
                len,
                0,
              );
              break;
            case 4:
              k.sum4(
                d!,
                a!,
                b!,
                c!,
                e!,
                weight(rnd),
                weight(rnd),
                weight(rnd),
                weight(rnd),
                len,
                1,
              );
              break;
            case 5:
              if (rnd() < 0.5) k.blend0(d!, a!, value(rnd), len);
              else {
                const t = tValue(rnd);
                const u = Math.fround(1 - t);
                // The two weightings of the interpolation rule: (1 − t, t), and the base segment's.
                k.blend1(d!, a!, b!, u, rnd() < 0.5 ? t : Math.fround(1 - u), value(rnd), len);
              }
              break;
            default:
              k.flipY(d!, a!, len & ~1);
          }
        }
      });
    }
  });

  it("sums from +0: a −0 keyform value gives +0, as f32(0 + f32(w·Q)) does", () => {
    for (const kind of ["wasm", "wasm-scalar", "js"] as const) {
      const k = createKernels(64, kind);
      // Five lanes of −0 (four SIMD lanes and one scalar), a source of zeros.
      k.heap.fill(-0, 0, 5);
      k.sum1(16, 0, 1, 5);
      k.sum2(24, 0, 0, 0.5, 0.5, 5);
      k.sum4(32, 0, 0, 0, 0, 0.25, 0.25, 0.25, 0.25, 5, 0);
      for (const at of [16, 24, 32])
        expect(Array.from(k.heap.subarray(at, at + 5)).every((x) => Object.is(x, 0))).toBe(true);
    }
  });

  it("rotate", () => {
    for (let seed = 1; seed <= 10; seed++) {
      compare(seed, (k, rnd) => {
        for (let n = 0; n < 30; n++) {
          const count = Math.floor(rnd() * 23);
          const [src, other] = regions(rnd, 2, 52) as [number, number];
          const dst = rnd() < 0.3 ? src : other;
          const angle = rnd() * 7;
          k.rotate(
            src,
            dst,
            count,
            fr(Math.cos(angle)),
            fr(Math.sin(angle)),
            value(rnd),
            value(rnd),
            value(rnd),
            rnd() < 0.5 ? 1 : 0,
            rnd() < 0.5 ? 1 : 0,
          );
        }
      });
    }
  });

  it("warp: inside, near band, far region, specials; both rules; in place and odd counts", () => {
    const shapes = [
      [1, 1],
      [2, 3],
      [5, 5],
      [4, 7],
      [9, 2],
    ] as const;
    for (let seed = 1; seed <= 30; seed++) {
      compare(seed, (k, rnd) => {
        const h = k.heap;
        for (let n = 0; n < 12; n++) {
          const [R, C] = shapes[Math.floor(rnd() * shapes.length)]!;
          const [grid, src, other] = regions(rnd, 3, 200) as [number, number, number];
          // Plausible grid values (specials elsewhere in the heap still feed some cases).
          if (rnd() < 0.8)
            for (let i = 0; i < 2 * (R + 1) * (C + 1); i++) h[grid + i] = fr((rnd() - 0.5) * 900);
          const count = Math.floor(rnd() * 41);
          const mode = rnd();
          for (let p = 0; p < 2 * count; p++) {
            // Mostly inside (so SIMD groups occur), some near and far, some specials and edges.
            const r = rnd();
            h[src + p] =
              mode < 0.4 || r < 0.6
                ? fr(rnd() * 0.9999)
                : r < 0.75
                  ? fr(rnd() * 6 - 2.5)
                  : r < 0.85
                    ? fr(rnd() * 20 - 10)
                    : [0, -0, 1, fr(1 - 2 ** -24), -2, 3, NaN, Infinity, -Infinity, 1e-40][
                        Math.floor(rnd() * 10)
                      ]!;
          }
          const dst = rnd() < 0.4 ? src : other;
          k.warp(grid, R, C, rnd() < 0.5 ? 1 : 0, src, dst, count, SCRATCH);
        }
      });
    }
  });
});

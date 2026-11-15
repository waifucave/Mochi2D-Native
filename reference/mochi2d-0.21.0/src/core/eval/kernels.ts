/**
 * The evaluator's bulk float32 loops ("kernels"), working on one float heap.
 * All arguments are float indices into the heap.
 *
 * Two implementations with identical results:
 * - WebAssembly: native f32 arithmetic, 4 lanes at a time where possible
 *   (f32x4). IEEE single-precision +, −, ×, ÷ give exactly the float32
 *   rounding the reference formulation asks for.
 * - JavaScript: the same operations in float64, each rounded to float32 with
 *   Math.fround. For +, −, ×, ÷ on float32 inputs this is exactly the single-
 *   precision result, so both implementations agree bit for bit.
 *
 * The JavaScript kernels are the fallback when WebAssembly (with SIMD) is
 * unavailable, for example under a Content-Security-Policy that blocks it.
 */
import { fr } from "./f32.js";
import { warpAffineSetup, warpOutside } from "./warp-map.js";

/** The JavaScript warp kernel's affine coefficients (one grid at a time). */
const affineCoef = new Float32Array(6);
import { assembleModule, f32, i32, op, v128, wasmFunction, type Code } from "../wasm/assembler.js";

/** "wasm-scalar": the WebAssembly kernels without their 4-lane (SIMD) loops, for comparison. */
export type KernelChoice = "auto" | "wasm" | "wasm-scalar" | "js";

export interface Kernels {
  readonly kind: "wasm" | "wasm-scalar" | "js";
  /** The whole heap as float32. */
  readonly heap: Float32Array;
  /** heap[dst…] ← heap[src…] (n floats; regions may overlap). */
  copy(dst: number, src: number, n: number): void;
  /**
   * Corner sums of keyform interpolation (S2): starting from +0,
   * dst ← f32(dst + f32(w·Q)) for each corner in order, element-wise over n
   * floats. sum1: one corner; sum2: two corners.
   */
  sum1(dst: number, a: number, w: number, n: number): void;
  sum2(dst: number, a: number, b: number, wa: number, wb: number, n: number): void;
  /**
   * Four corners, starting from +0, or from dst itself when `acc` is 1 (the
   * next four corners of a larger sum).
   */
  sum4(
    dst: number,
    a: number,
    b: number,
    c: number,
    d: number,
    w0: number,
    w1: number,
    w2: number,
    w3: number,
    n: number,
    acc: number,
  ): void;
  /** dst ← dst + w·a (a blend-shape keyform on its key). */
  blend0(dst: number, a: number, w: number, n: number): void;
  /**
   * dst ← dst + w·s with s = wa·a + wb·b, each product and the sum in float32:
   * a blend shape between two keys (wa = 1 − t and wb = t,
   * or in the segment that starts at the base key, whose keyform `a` reads
   * as zeros, wb = 1 − (1 − t)).
   */
  blend1(dst: number, a: number, b: number, wa: number, wb: number, w: number, n: number): void;
  /**
   * Maps `count` points (x, y pairs) from src through the warp grid at `grid`
   * (rows × columns cells) into dst (§1c.8, all regions). src may equal dst.
   * `scratch` is 16 floats of working space.
   */
  warp(
    grid: number,
    rows: number,
    columns: number,
    bilinear: number,
    src: number,
    dst: number,
    count: number,
    scratch: number,
  ): void;
  /** Rotation world form (§1c.7) applied to `count` points; src may equal dst. */
  rotate(
    src: number,
    dst: number,
    count: number,
    cos: number,
    sin: number,
    scale: number,
    ox: number,
    oy: number,
    mirrorX: number,
    mirrorY: number,
  ): void;
  /** dst ← src with every second float (y) negated; n is even. */
  flipY(dst: number, src: number, n: number): void;
}

// --------------------------------------------------------------- JavaScript

function jsKernels(floats: number): Kernels {
  const h = new Float32Array(floats);
  return {
    kind: "js",
    heap: h,
    copy(dst, src, n) {
      h.copyWithin(dst, src, src + n);
    },
    sum1(dst, a, w, n) {
      for (let k = 0; k < n; k++) h[dst + k] = fr(0 + fr(w * h[a + k]!));
    },
    sum2(dst, a, b, wa, wb, n) {
      for (let k = 0; k < n; k++) h[dst + k] = fr(fr(0 + fr(wa * h[a + k]!)) + fr(wb * h[b + k]!));
    },
    sum4(dst, a, b, c, d, w0, w1, w2, w3, n, acc) {
      for (let k = 0; k < n; k++) {
        let r = acc ? h[dst + k]! : 0;
        r = fr(r + fr(w0 * h[a + k]!));
        r = fr(r + fr(w1 * h[b + k]!));
        r = fr(r + fr(w2 * h[c + k]!));
        h[dst + k] = fr(r + fr(w3 * h[d + k]!));
      }
    },
    blend0(dst, a, w, n) {
      for (let k = 0; k < n; k++) h[dst + k] = fr(h[dst + k]! + fr(w * h[a + k]!));
    },
    blend1(dst, a, b, wa, wb, w, n) {
      for (let k = 0; k < n; k++) {
        const s = fr(fr(wa * h[a + k]!) + fr(wb * h[b + k]!));
        h[dst + k] = fr(h[dst + k]! + fr(w * s));
      }
    },
    warp(grid, R, C, bilinear, src, dst, count) {
      // The inside region inlined (the same float32 operations as warpInside in
      // warp-map.ts, so the same bits); the band and far regions call warpOutside.
      const stride = 2 * (C + 1);
      // The affine coefficients once per call, at the first point outside the grid.
      let coefReady = false;
      for (let n = 0; n < count; n++) {
        const u = h[src + 2 * n]!;
        const v = h[src + 2 * n + 1]!;
        const o = dst + 2 * n;
        if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) {
          if (!coefReady) {
            warpAffineSetup(h, grid, R, C, affineCoef);
            coefReady = true;
          }
          warpOutside(h, grid, R, C, u, v, h, o, affineCoef);
          continue;
        }
        const X = fr(u * C);
        const Y = fr(v * R);
        let c = Math.floor(X);
        if (c > C - 1) c = C - 1;
        let r = Math.floor(Y);
        if (r > R - 1) r = R - 1;
        const x = fr(X - c);
        const y = fr(Y - r);
        const gx = fr(1 - x);
        const gy = fr(1 - y);
        const i00 = grid + r * stride + 2 * c;
        const i10 = i00 + 2;
        const i01 = i00 + stride;
        const i11 = i01 + 2;
        if (bilinear) {
          // (((gy·(gx·p00) + gy·(x·p10)) + y·(gx·p01)) + y·(x·p11))
          h[o] = fr(
            fr(
              fr(fr(gy * fr(gx * h[i00]!)) + fr(gy * fr(x * h[i10]!))) + fr(y * fr(gx * h[i01]!)),
            ) + fr(y * fr(x * h[i11]!)),
          );
          h[o + 1] = fr(
            fr(
              fr(fr(gy * fr(gx * h[i00 + 1]!)) + fr(gy * fr(x * h[i10 + 1]!))) +
                fr(y * fr(gx * h[i01 + 1]!)),
            ) + fr(y * fr(x * h[i11 + 1]!)),
          );
        } else if (fr(x + y) <= 1) {
          // ((((1 − x) − y)·p00 + x·p10) + y·p01)
          const w = fr(gx - y);
          h[o] = fr(fr(fr(w * h[i00]!) + fr(x * h[i10]!)) + fr(y * h[i01]!));
          h[o + 1] = fr(fr(fr(w * h[i00 + 1]!) + fr(x * h[i10 + 1]!)) + fr(y * h[i01 + 1]!));
        } else {
          // ((e·p11 + (1 − x)·p01) + (1 − y)·p10), e = y − (1 − x)
          const e = fr(y - gx);
          h[o] = fr(fr(fr(e * h[i11]!) + fr(gx * h[i01]!)) + fr(gy * h[i10]!));
          h[o + 1] = fr(fr(fr(e * h[i11 + 1]!) + fr(gx * h[i01 + 1]!)) + fr(gy * h[i10 + 1]!));
        }
      }
    },
    rotate(src, dst, count, c, sn, s, ox, oy, mirrorX, mirrorY) {
      for (let n = 0; n < count; n++) {
        const x = mirrorX ? -h[src + 2 * n]! : h[src + 2 * n]!;
        const y = mirrorY ? -h[src + 2 * n + 1]! : h[src + 2 * n + 1]!;
        const rx = fr(fr(c * x) - fr(sn * y));
        const ry = fr(fr(sn * x) + fr(c * y));
        h[dst + 2 * n] = fr(ox + fr(s * rx));
        h[dst + 2 * n + 1] = fr(oy + fr(s * ry));
      }
    },
    flipY(dst, src, n) {
      for (let k = 0; k < n; k += 2) {
        h[dst + k] = h[src + k]!;
        h[dst + k + 1] = -h[src + k + 1]!;
      }
    },
  };
}

// ------------------------------------------------------------- WebAssembly

/** Function order in the module (indices for `call`). */
const FUNCTIONS = [
  "affineSetup",
  "affine",
  "corner",
  "outside",
  "warpOne",
  "copy",
  "sum1",
  "sum2",
  "sum4",
  "blend0",
  "blend1",
  "warp",
  "rotate",
  "flipY",
] as const;
const call = (name: (typeof FUNCTIONS)[number]): Code => op.call(FUNCTIONS.indexOf(name));

/** Float indices → byte addresses. */
const toBytes = (...locals: number[]): Code =>
  locals.map((l) => [op.get(l), op.i32Const(2), op.i32Shl, op.set(l)]);
/** Adds `bytes` to each local. */
const advance = (locals: number[], bytes: number): Code =>
  locals.map((l) => [op.get(l), op.i32Const(bytes), op.i32Add, op.set(l)]);
/** while (n ≥ step) { body; n −= step } */
const countedLoop = (n: number, step: number, body: Code): Code => [
  op.block,
  op.loop,
  [op.get(n), op.i32Const(step), op.i32LtS, op.brIf(1)],
  body,
  [op.get(n), op.i32Const(step), op.i32Sub, op.set(n)],
  op.br(0),
  op.end,
  op.end,
];
/** Loads 4 lanes or one float at the address on the stack. */
const load = (simd: boolean): Code => (simd ? op.v128Load() : op.f32Load());
/** Stores 4 lanes or one float (address below the value on the stack). */
const store = (simd: boolean): Code => (simd ? op.v128Store() : op.f32Store());
const add = (simd: boolean): Code => (simd ? op.f32x4Add : op.f32Add);
/** +0 in every lane (`vzero` is a v128 local that is never written). */
const zero = (simd: boolean, vzero: number): Code => (simd ? op.get(vzero) : op.f32Const(0));
/** w · heap[addr] (lanes or one float); `w` is a splat vector or an f32 local. */
const term = (w: number, addr: number, simd: boolean): Code => [
  op.get(w),
  op.get(addr),
  load(simd),
  simd ? op.f32x4Mul : op.f32Mul,
];
/** i8x16 shuffle lanes that take f32 lanes `a`, `a`, `b`, `b` of one vector. */
const pairLanes = (a: number, b: number): number[] =>
  [a, a, b, b].flatMap((l) => [4 * l, 4 * l + 1, 4 * l + 2, 4 * l + 3]);
/** f32 lane indices i, j, k, l of a 32-byte (two-vector) shuffle. */
const lanes = (...ls: number[]): number[] =>
  ls.flatMap((l) => [4 * l, 4 * l + 1, 4 * l + 2, 4 * l + 3]);

/** Scalar inside test 0 ≤ u < 1 and 0 ≤ v < 1 (false for NaN). */
const insideTest = (u: number, v: number): Code => [
  [op.get(u), op.f32Const(0), op.f32Ge, op.get(u), op.f32Const(1), op.f32Lt, op.i32And],
  [op.get(v), op.f32Const(0), op.f32Ge, op.i32And, op.get(v), op.f32Const(1), op.f32Lt, op.i32And],
];

/** Grid address (bytes) of point (column, row): grid + 8·(row·(C+1) + column). */
const gridPoint = (grid: number, C: number, column: Code, row: Code): Code => [
  op.get(grid),
  row,
  op.get(C),
  op.i32Const(1),
  op.i32Add,
  op.i32Mul,
  column,
  op.i32Add,
  op.i32Const(3),
  op.i32Shl,
  op.i32Add,
];

/** The kernels; `wide` false leaves out the 4-lane loops (the scalar loops then do all). */
const kernelFunctions = (wide: boolean) => [
  // affineSetup(grid, R, C, coef): the affine map's coefficients (§1c.8) from the
  // grid's outer corners a = p(0, 0), b = p(C, 0), c = p(0, R), d = p(C, R): with D1 = d − a and
  // D2 = b − c, A0 = (((a + b) + c) + d)·0.25 − D1·0.5, Bu = (D1 + D2)·0.5, Bv = (D1 − D2)·0.5,
  // for x and y at coef bytes 0/4, 8/12, 16/20.
  wasmFunction(
    "affineSetup",
    { grid: i32, R: i32, C: i32, coef: i32 },
    [],
    { ib: i32, ic: i32, id: i32, a: f32, b: f32, c: f32, d: f32, D1: f32, D2: f32 },
    (v) => {
      const coord = (k: number): Code => [
        [op.get(v.grid), op.f32Load(k), op.set(v.a), op.get(v.ib), op.f32Load(k), op.set(v.b)],
        [op.get(v.ic), op.f32Load(k), op.set(v.c), op.get(v.id), op.f32Load(k), op.set(v.d)],
        [op.get(v.d), op.get(v.a), op.f32Sub, op.set(v.D1)],
        [op.get(v.b), op.get(v.c), op.f32Sub, op.set(v.D2)],
        // A0 = (((a + b) + c) + d)·0.25 − D1·0.5
        [op.get(v.coef), op.get(v.a), op.get(v.b), op.f32Add, op.get(v.c), op.f32Add],
        [op.get(v.d), op.f32Add, op.f32Const(0.25), op.f32Mul],
        [op.get(v.D1), op.f32Const(0.5), op.f32Mul, op.f32Sub, op.f32Store(k)],
        // Bu = (D1 + D2)·0.5, Bv = (D1 − D2)·0.5
        [op.get(v.coef), op.get(v.D1), op.get(v.D2), op.f32Add, op.f32Const(0.5), op.f32Mul],
        op.f32Store(8 + k),
        [op.get(v.coef), op.get(v.D1), op.get(v.D2), op.f32Sub, op.f32Const(0.5), op.f32Mul],
        op.f32Store(16 + k),
      ];
      return [
        [gridPoint(v.grid, v.C, op.get(v.C), op.i32Const(0)), op.set(v.ib)],
        [gridPoint(v.grid, v.C, op.i32Const(0), op.get(v.R)), op.set(v.ic)],
        [gridPoint(v.grid, v.C, op.get(v.C), op.get(v.R)), op.set(v.id)],
        coord(0),
        coord(4),
      ];
    },
  ),
  // affine(u, v, coef, out): Aff(u, v) = (A0 + u·Bu) + v·Bv per coordinate.
  wasmFunction("affine", { u: f32, v: f32, coef: i32, out: i32 }, [], {}, (v) =>
    [0, 4].map((k) => [
      [op.get(v.out), op.get(v.coef), op.f32Load(k)],
      [op.get(v.u), op.get(v.coef), op.f32Load(8 + k), op.f32Mul],
      op.f32Add,
      [op.get(v.v), op.get(v.coef), op.f32Load(16 + k), op.f32Mul],
      op.f32Add,
      op.f32Store(k),
    ]),
  ),
  // corner(grid, C, gc, gr, cu, cv, coef, out): grid point (gc, gr), or A(cu, cv) if either
  // index is −1.
  wasmFunction(
    "corner",
    { grid: i32, C: i32, gc: i32, gr: i32, cu: f32, cv: f32, coef: i32, out: i32 },
    [],
    { a: i32 },
    (v) => [
      [op.get(v.gc), op.i32Const(0), op.i32GeS, op.get(v.gr), op.i32Const(0), op.i32GeS, op.i32And],
      op.if,
      [gridPoint(v.grid, v.C, op.get(v.gc), op.get(v.gr)), op.set(v.a)],
      [op.get(v.out), op.get(v.a), op.f32Load(0), op.f32Store(0)],
      [op.get(v.out), op.get(v.a), op.f32Load(4), op.f32Store(4)],
      op.else,
      [op.get(v.cu), op.get(v.cv), op.get(v.coef), op.get(v.out), call("affine")],
      op.end,
    ],
  ),
  // outside(grid, R, C, u, v, dst, scratch): a point outside [0, 1)², in the far region or the
  // near band. scratch: corners P00, P10, P01, P11 at bytes 0–31, affine coefficients at 32–55.
  wasmFunction(
    "outside",
    { grid: i32, R: i32, C: i32, u: f32, v: f32, dst: i32, scratch: i32 },
    [],
    {
      gc0: i32,
      gc1: i32,
      gr0: i32,
      gr1: i32,
      c: i32,
      coef: i32,
      u0: f32,
      u1: f32,
      v0: f32,
      v1: f32,
      fx: f32,
      fy: f32,
      gx: f32,
      gy: f32,
      p: f32,
      T: f32,
    },
    (v) => {
      /**
       * One axis of the band's macro-cell: its ends' positions and grid indices (−1: affine),
       * and the local coordinate (t − t0)/(t1 − t0) at an affine end, t·n − k in a grid cell.
       */
      const axis = (
        x: number,
        n: number,
        x0: number,
        x1: number,
        g0: number,
        g1: number,
        frac: number,
      ): Code => [
        [op.get(x), op.f32Const(0), op.f32Le],
        op.if,
        [op.f32Const(-2), op.set(x0), op.f32Const(0), op.set(x1)],
        [op.i32Const(-1), op.set(g0), op.i32Const(0), op.set(g1)],
        [op.get(x), op.get(x0), op.f32Sub, op.get(x1), op.get(x0), op.f32Sub, op.f32Div],
        op.set(frac),
        op.else,
        [op.get(x), op.f32Const(1), op.f32Ge],
        op.if,
        [op.f32Const(1), op.set(x0), op.f32Const(3), op.set(x1)],
        [op.get(n), op.set(g0), op.i32Const(-1), op.set(g1)],
        [op.get(x), op.get(x0), op.f32Sub, op.get(x1), op.get(x0), op.f32Sub, op.f32Div],
        op.set(frac),
        op.else,
        // T = x·n; c = min(floor(T), n − 1); x0 = c / n; x1 = (c + 1) / n; frac = T − c
        [op.get(n), op.i32Const(1), op.i32Sub],
        [op.get(x), op.get(n), op.f32ConvertI32S, op.f32Mul, op.tee(v.T)],
        [op.i32TruncSatF32S, op.tee(v.c)],
        [op.get(v.c), op.get(n), op.i32Const(1), op.i32Sub, op.i32GtS, op.select, op.set(v.c)],
        [op.get(v.c), op.f32ConvertI32S, op.get(n), op.f32ConvertI32S, op.f32Div, op.set(x0)],
        [op.get(v.c), op.i32Const(1), op.i32Add, op.f32ConvertI32S],
        [op.get(n), op.f32ConvertI32S, op.f32Div, op.set(x1)],
        [op.get(v.c), op.set(g0), op.get(v.c), op.i32Const(1), op.i32Add, op.set(g1)],
        [op.get(v.T), op.get(v.c), op.f32ConvertI32S, op.f32Sub, op.set(frac)],
        op.end,
        op.end,
      ];
      const corner = (gc: number, gr: number, cu: number, cv: number, slot: number): Code => [
        [
          op.get(v.grid),
          op.get(v.C),
          op.get(gc),
          op.get(gr),
          op.get(cu),
          op.get(cv),
          op.get(v.coef),
        ],
        [op.get(v.scratch), op.i32Const(slot), op.i32Add, call("corner")],
      ];
      /** dst[k] = (base + wa·(pa − base)) + wb·(pb − base) over scratch corners (byte offsets). */
      const tri = (
        k: number,
        base: number,
        wa: number,
        pa: number,
        wb: number,
        pb: number,
      ): Code => [
        op.get(v.dst),
        [op.get(v.scratch), op.f32Load(base + k), op.tee(v.p)],
        [op.get(wa), op.get(v.scratch), op.f32Load(pa + k), op.get(v.p), op.f32Sub, op.f32Mul],
        op.f32Add,
        [op.get(wb), op.get(v.scratch), op.f32Load(pb + k), op.get(v.p), op.f32Sub, op.f32Mul],
        op.f32Add,
        op.f32Store(k),
      ];
      return [
        [op.get(v.scratch), op.i32Const(32), op.i32Add, op.set(v.coef)],
        // Far region (u ≤ −2, u ≥ 3, v ≤ −2 or v ≥ 3): the affine map itself.
        [op.get(v.u), op.f32Const(-2), op.f32Le, op.get(v.u), op.f32Const(3), op.f32Ge, op.i32Or],
        [op.get(v.v), op.f32Const(-2), op.f32Le, op.i32Or, op.get(v.v), op.f32Const(3), op.f32Ge],
        op.i32Or,
        op.if,
        [op.get(v.u), op.get(v.v), op.get(v.coef), op.get(v.dst), call("affine")],
        op.return,
        op.end,
        axis(v.u, v.C, v.u0, v.u1, v.gc0, v.gc1, v.fx),
        axis(v.v, v.R, v.v0, v.v1, v.gr0, v.gr1, v.fy),
        corner(v.gc0, v.gr0, v.u0, v.v0, 0),
        corner(v.gc1, v.gr0, v.u1, v.v0, 8),
        corner(v.gc0, v.gr1, v.u0, v.v1, 16),
        corner(v.gc1, v.gr1, v.u1, v.v1, 24),
        [op.get(v.fx), op.get(v.fy), op.f32Add, op.f32Const(1), op.f32Le],
        op.if,
        tri(0, 0, v.fx, 8, v.fy, 16),
        tri(4, 0, v.fx, 8, v.fy, 16),
        op.else,
        [op.f32Const(1), op.get(v.fx), op.f32Sub, op.set(v.gx)],
        [op.f32Const(1), op.get(v.fy), op.f32Sub, op.set(v.gy)],
        tri(0, 24, v.gx, 16, v.gy, 8),
        tri(4, 24, v.gx, 16, v.gy, 8),
        op.end,
      ];
    },
  ),
  // warpOne(grid, R, C, bilinear, src, dst, scratch): one point, any region (byte addresses).
  wasmFunction(
    "warpOne",
    { grid: i32, R: i32, C: i32, bilinear: i32, src: i32, dst: i32, scratch: i32 },
    [],
    {
      c: i32,
      r: i32,
      i00: i32,
      i01: i32,
      tri: i32,
      base: i32,
      pa: i32,
      pb: i32,
      u: f32,
      v: f32,
      X: f32,
      Y: f32,
      fx: f32,
      fy: f32,
      gx: f32,
      gy: f32,
      w0: f32,
      wa: f32,
      wb: f32,
    },
    (v) => {
      /** min(trunc(value · cells), cells − 1) into `local`; value · cells into `scaled`. */
      const cell = (value: number, cells: number, scaled: number, local: number): Code => [
        [op.get(value), op.get(cells), op.f32ConvertI32S, op.f32Mul, op.set(scaled)],
        [
          op.get(cells),
          op.i32Const(1),
          op.i32Sub,
          op.get(scaled),
          op.i32TruncSatF32S,
          op.tee(local),
        ],
        [
          op.get(local),
          op.get(cells),
          op.i32Const(1),
          op.i32Sub,
          op.i32GtS,
          op.select,
          op.set(local),
        ],
      ];
      /** row · (column · corner): the corner value is multiplied in before the row weight. */
      const quadTerm = (row: number, column: number, at: number, offset: number): Code => [
        op.get(row),
        [op.get(column), op.get(at), op.f32Load(offset), op.f32Mul],
        op.f32Mul,
      ];
      // (((gy·(gx·p00) + gy·(fx·p10)) + fy·(gx·p01)) + fy·(fx·p11))
      const bilinearCoord = (k: number): Code => [
        op.get(v.dst),
        quadTerm(v.gy, v.gx, v.i00, k),
        quadTerm(v.gy, v.fx, v.i00, 8 + k),
        op.f32Add,
        quadTerm(v.fy, v.gx, v.i01, k),
        op.f32Add,
        quadTerm(v.fy, v.fx, v.i01, 8 + k),
        op.f32Add,
        op.f32Store(k),
      ];
      // ((w0·base + wa·pa) + wb·pb)
      const triangleCoord = (k: number): Code => [
        op.get(v.dst),
        [op.get(v.w0), op.get(v.base), op.f32Load(k), op.f32Mul],
        [op.get(v.wa), op.get(v.pa), op.f32Load(k), op.f32Mul, op.f32Add],
        [op.get(v.wb), op.get(v.pb), op.f32Load(k), op.f32Mul, op.f32Add],
        op.f32Store(k),
      ];
      /** select(a, b, tri) into `local`. */
      const pick = (a: Code, b: Code, local: number): Code => [
        a,
        b,
        op.get(v.tri),
        op.select,
        op.set(local),
      ];
      return [
        [op.get(v.src), op.f32Load(0), op.set(v.u), op.get(v.src), op.f32Load(4), op.set(v.v)],
        insideTest(v.u, v.v),
        op.if,
        cell(v.u, v.C, v.X, v.c),
        cell(v.v, v.R, v.Y, v.r),
        [op.get(v.X), op.get(v.c), op.f32ConvertI32S, op.f32Sub, op.set(v.fx)],
        [op.get(v.Y), op.get(v.r), op.f32ConvertI32S, op.f32Sub, op.set(v.fy)],
        gridPoint(v.grid, v.C, op.get(v.c), op.get(v.r)),
        [
          op.tee(v.i00),
          op.get(v.C),
          op.i32Const(1),
          op.i32Add,
          op.i32Const(3),
          op.i32Shl,
          op.i32Add,
          op.set(v.i01),
        ],
        [
          op.f32Const(1),
          op.get(v.fx),
          op.f32Sub,
          op.set(v.gx),
          op.f32Const(1),
          op.get(v.fy),
          op.f32Sub,
          op.set(v.gy),
        ],
        op.get(v.bilinear),
        op.if,
        bilinearCoord(0),
        bilinearCoord(4),
        op.else,
        // Lower triangle (fx + fy ≤ 1): ((gx − fy)·P00 + fx·P10) + fy·P01;
        // upper: ((fy − gx)·P11 + gx·P01) + gy·P10. Same operations, chosen operands.
        [op.get(v.fx), op.get(v.fy), op.f32Add, op.f32Const(1), op.f32Le, op.set(v.tri)],
        pick(op.get(v.i00), [op.get(v.i01), op.i32Const(8), op.i32Add], v.base),
        pick([op.get(v.i00), op.i32Const(8), op.i32Add], op.get(v.i01), v.pa),
        pick(op.get(v.i01), [op.get(v.i00), op.i32Const(8), op.i32Add], v.pb),
        pick(
          [op.get(v.gx), op.get(v.fy), op.f32Sub],
          [op.get(v.fy), op.get(v.gx), op.f32Sub],
          v.w0,
        ),
        pick(op.get(v.fx), op.get(v.gx), v.wa),
        pick(op.get(v.fy), op.get(v.gy), v.wb),
        triangleCoord(0),
        triangleCoord(4),
        op.end,
        op.else,
        [
          op.get(v.grid),
          op.get(v.R),
          op.get(v.C),
          op.get(v.u),
          op.get(v.v),
          op.get(v.dst),
          op.get(v.scratch),
        ],
        call("outside"),
        op.end,
      ];
    },
  ),
  wasmFunction("copy", { dst: i32, src: i32, n: i32 }, [], {}, (v) => [
    [op.get(v.dst), op.i32Const(2), op.i32Shl],
    [op.get(v.src), op.i32Const(2), op.i32Shl],
    [op.get(v.n), op.i32Const(2), op.i32Shl],
    op.memoryCopy,
  ]),
  // Corner sums (S2): r ← f32(r + f32(w·Q)) per corner, starting from +0.
  // A v128 local starts as zeros, so `vzero` is +0 in every lane.
  wasmFunction("sum1", { dst: i32, a: i32, w: f32, n: i32 }, [], { vw: v128, vzero: v128 }, (v) => {
    const body = (simd: boolean): Code => [
      [op.get(v.dst), zero(simd, v.vzero)],
      [term(simd ? v.vw : v.w, v.a, simd), add(simd), store(simd)],
      advance([v.dst, v.a], simd ? 16 : 4),
    ];
    return [
      toBytes(v.dst, v.a),
      [op.get(v.w), op.f32x4Splat, op.set(v.vw)],
      countedLoop(v.n, wide ? 4 : 0x40000000, body(true)),
      countedLoop(v.n, 1, body(false)),
    ];
  }),
  wasmFunction(
    "sum2",
    { dst: i32, a: i32, b: i32, wa: f32, wb: f32, n: i32 },
    [],
    { vwa: v128, vwb: v128, vzero: v128 },
    (v) => {
      const body = (simd: boolean): Code => [
        [op.get(v.dst), zero(simd, v.vzero)],
        [term(simd ? v.vwa : v.wa, v.a, simd), add(simd)],
        [term(simd ? v.vwb : v.wb, v.b, simd), add(simd), store(simd)],
        advance([v.dst, v.a, v.b], simd ? 16 : 4),
      ];
      return [
        toBytes(v.dst, v.a, v.b),
        [op.get(v.wa), op.f32x4Splat, op.set(v.vwa), op.get(v.wb), op.f32x4Splat, op.set(v.vwb)],
        countedLoop(v.n, wide ? 4 : 0x40000000, body(true)),
        countedLoop(v.n, 1, body(false)),
      ];
    },
  ),
  wasmFunction(
    "sum4",
    {
      dst: i32,
      a: i32,
      b: i32,
      c: i32,
      d: i32,
      w0: f32,
      w1: f32,
      w2: f32,
      w3: f32,
      n: i32,
      acc: i32,
    },
    [],
    { v0: v128, v1: v128, v2: v128, v3: v128, vzero: v128 },
    (v) => {
      const body = (simd: boolean, acc: boolean): Code => [
        op.get(v.dst),
        acc ? [op.get(v.dst), load(simd)] : zero(simd, v.vzero),
        [term(simd ? v.v0 : v.w0, v.a, simd), add(simd)],
        [term(simd ? v.v1 : v.w1, v.b, simd), add(simd)],
        [term(simd ? v.v2 : v.w2, v.c, simd), add(simd)],
        [term(simd ? v.v3 : v.w3, v.d, simd), add(simd), store(simd)],
        advance([v.dst, v.a, v.b, v.c, v.d], simd ? 16 : 4),
      ];
      const loops = (acc: boolean): Code => [
        countedLoop(v.n, wide ? 4 : 0x40000000, body(true, acc)),
        countedLoop(v.n, 1, body(false, acc)),
      ];
      return [
        toBytes(v.dst, v.a, v.b, v.c, v.d),
        [op.get(v.w0), op.f32x4Splat, op.set(v.v0), op.get(v.w1), op.f32x4Splat, op.set(v.v1)],
        [op.get(v.w2), op.f32x4Splat, op.set(v.v2), op.get(v.w3), op.f32x4Splat, op.set(v.v3)],
        [op.get(v.acc), op.if, loops(true), op.else, loops(false), op.end],
      ];
    },
  ),
  // Blend shapes (§1c.4 with S4): the base keyform reads as zeros, so the step is dst + w·s.
  wasmFunction("blend0", { dst: i32, a: i32, w: f32, n: i32 }, [], { vw: v128 }, (v) => {
    const body = (simd: boolean): Code => [
      [op.get(v.dst), op.get(v.dst), load(simd)],
      [term(simd ? v.vw : v.w, v.a, simd), add(simd), store(simd)],
      advance([v.dst, v.a], simd ? 16 : 4),
    ];
    return [
      toBytes(v.dst, v.a),
      [op.get(v.w), op.f32x4Splat, op.set(v.vw)],
      countedLoop(v.n, wide ? 4 : 0x40000000, body(true)),
      countedLoop(v.n, 1, body(false)),
    ];
  }),
  // s = f32(f32(wa·a) + f32(wb·b)), then dst + f32(w·s).
  wasmFunction(
    "blend1",
    { dst: i32, a: i32, b: i32, wa: f32, wb: f32, w: f32, n: i32 },
    [],
    { vwa: v128, vwb: v128, vw: v128, vs: v128, fs: f32 },
    (v) => {
      const body = (simd: boolean): Code => {
        const [wa, wb, w, s] = simd ? [v.vwa, v.vwb, v.vw, v.vs] : [v.wa, v.wb, v.w, v.fs];
        return [
          [term(wa, v.a, simd), term(wb, v.b, simd), add(simd), op.set(s)],
          [op.get(v.dst), op.get(v.dst), load(simd)],
          [op.get(w), op.get(s), simd ? op.f32x4Mul : op.f32Mul, add(simd), store(simd)],
          advance([v.dst, v.a, v.b], simd ? 16 : 4),
        ];
      };
      return [
        toBytes(v.dst, v.a, v.b),
        [op.get(v.wa), op.f32x4Splat, op.set(v.vwa), op.get(v.wb), op.f32x4Splat, op.set(v.vwb)],
        [op.get(v.w), op.f32x4Splat, op.set(v.vw)],
        countedLoop(v.n, wide ? 4 : 0x40000000, body(true)),
        countedLoop(v.n, 1, body(false)),
      ];
    },
  ),
  // warp: groups of 4 points run 4 lanes wide (cell indices clamped into the grid, so every
  // load stays inside it); lanes whose point is outside [0, 1)² are then redone by `outside`.
  // The last count % 4 points go through warpOne.
  wasmFunction(
    "warp",
    { grid: i32, R: i32, C: i32, bilinear: i32, src: i32, dst: i32, count: i32, scratch: i32 },
    [],
    {
      rowBytes: i32,
      a0: i32,
      a1: i32,
      mask: i32,
      INS: v128,
      vCf: v128,
      vRf: v128,
      vCm1: v128,
      vRm1: v128,
      vRow: v128,
      vGrid: v128,
      vOne: v128,
      vZero: v128,
      A: v128,
      U: v128,
      V: v128,
      X: v128,
      Y: v128,
      CI: v128,
      RI: v128,
      FX: v128,
      FY: v128,
      GX: v128,
      GY: v128,
      ADDR: v128,
      W00: v128,
      W10: v128,
      W01: v128,
      TRI: v128,
      P00: v128,
      P10: v128,
      P01: v128,
      P11: v128,
      M: v128,
      B: v128,
    },
    (v) => {
      /** The 64-bit (x, y) pair at a0 + offset in lanes 0–1 and at a1 + offset in lanes 2–3. */
      const pair = (rowOffset: boolean, offset: number): Code => {
        const at = (a: number): Code =>
          rowOffset ? [op.get(a), op.get(v.rowBytes), op.i32Add] : op.get(a);
        return [at(v.a1), at(v.a0), op.v128Load64Zero(offset), op.v128Load64Lane(offset, 1)];
      };
      /** Broadcast f32 lanes (2h, 2h, 2h+1, 2h+1) of `vec`. */
      const spread = (vec: number, h: number): Code => [
        op.get(vec),
        op.get(vec),
        op.i8x16Shuffle(pairLanes(2 * h, 2 * h + 1)),
      ];
      /** Points 2h and 2h+1 of the group: corner pairs, interpolation, one 16-byte store. */
      const half = (h: number, bilinear: boolean): Code => [
        [op.get(v.ADDR), op.i32x4ExtractLane(2 * h), op.set(v.a0)],
        [op.get(v.ADDR), op.i32x4ExtractLane(2 * h + 1), op.set(v.a1)],
        [pair(false, 0), op.set(v.P00), pair(false, 8), op.set(v.P10)],
        [pair(true, 0), op.set(v.P01), pair(true, 8), op.set(v.P11)],
        op.get(v.dst),
        bilinear
          ? [
              // (((gy·(gx·P00) + gy·(fx·P10)) + fy·(gx·P01)) + fy·(fx·P11))
              [spread(v.GY, h), spread(v.GX, h), op.get(v.P00), op.f32x4Mul, op.f32x4Mul],
              [spread(v.GY, h), spread(v.FX, h), op.get(v.P10), op.f32x4Mul, op.f32x4Mul],
              op.f32x4Add,
              [spread(v.FY, h), spread(v.GX, h), op.get(v.P01), op.f32x4Mul, op.f32x4Mul],
              op.f32x4Add,
              [spread(v.FY, h), spread(v.FX, h), op.get(v.P11), op.f32x4Mul, op.f32x4Mul],
              op.f32x4Add,
            ]
          : [
              // Lower triangle: ((gx − fy)·P00 + fx·P10) + fy·P01;
              // upper: ((fy − gx)·P11 + gx·P01) + gy·P10. W00, W10, W01 hold the chosen weights.
              [spread(v.TRI, h), op.set(v.M)],
              [spread(v.W00, h), op.get(v.P00), op.get(v.P11), op.get(v.M), op.v128Bitselect],
              op.f32x4Mul,
              [spread(v.W10, h), op.get(v.P10), op.get(v.P01), op.get(v.M), op.v128Bitselect],
              [op.f32x4Mul, op.f32x4Add],
              [spread(v.W01, h), op.get(v.P01), op.get(v.P10), op.get(v.M), op.v128Bitselect],
              [op.f32x4Mul, op.f32x4Add],
            ],
        op.v128Store(16 * h),
      ];
      const group = (bilinear: boolean): Code => [
        // X = U·C, Y = V·R; cell (c, r) = min(trunc, n − 1), and ≥ 0 so that lanes of
        // outside points (redone later) still read inside the grid. Fractions, complements.
        [op.get(v.U), op.get(v.vCf), op.f32x4Mul, op.tee(v.X), op.i32x4TruncSatF32x4S],
        [op.get(v.vCm1), op.i32x4MinS, op.get(v.vZero), op.i32x4MaxS, op.set(v.CI)],
        [op.get(v.V), op.get(v.vRf), op.f32x4Mul, op.tee(v.Y), op.i32x4TruncSatF32x4S],
        [op.get(v.vRm1), op.i32x4MinS, op.get(v.vZero), op.i32x4MaxS, op.set(v.RI)],
        [op.get(v.X), op.get(v.CI), op.f32x4ConvertI32x4S, op.f32x4Sub, op.set(v.FX)],
        [op.get(v.Y), op.get(v.RI), op.f32x4ConvertI32x4S, op.f32x4Sub, op.set(v.FY)],
        [op.get(v.vOne), op.get(v.FX), op.f32x4Sub, op.set(v.GX)],
        [op.get(v.vOne), op.get(v.FY), op.f32x4Sub, op.set(v.GY)],
        // Byte address of P00: grid + r·rowBytes + 8c.
        [op.get(v.vGrid), op.get(v.RI), op.get(v.vRow), op.i32x4Mul, op.i32x4Add],
        [op.get(v.CI), op.i32Const(3), op.i32x4Shl, op.i32x4Add, op.set(v.ADDR)],
        bilinear
          ? []
          : [
              // TRI: lower triangle (fx + fy ≤ 1). Weights of the base corner (W00), the
              // second (W10) and the third (W01).
              [op.get(v.FX), op.get(v.FY), op.f32x4Add, op.get(v.vOne), op.f32x4Le, op.set(v.TRI)],
              [op.get(v.GX), op.get(v.FY), op.f32x4Sub, op.get(v.FY), op.get(v.GX), op.f32x4Sub],
              [op.get(v.TRI), op.v128Bitselect, op.set(v.W00)],
              [op.get(v.FX), op.get(v.GX), op.get(v.TRI), op.v128Bitselect, op.set(v.W10)],
              [op.get(v.FY), op.get(v.GY), op.get(v.TRI), op.v128Bitselect, op.set(v.W01)],
            ],
        half(0, bilinear),
        half(1, bilinear),
      ];
      const loop = (bilinear: boolean): Code =>
        countedLoop(v.count, wide ? 4 : 0x40000000, [
          [op.get(v.src), op.v128Load(0), op.set(v.A), op.get(v.src), op.v128Load(16), op.set(v.B)],
          [op.get(v.A), op.get(v.B), op.i8x16Shuffle(lanes(0, 2, 4, 6)), op.set(v.U)],
          [op.get(v.A), op.get(v.B), op.i8x16Shuffle(lanes(1, 3, 5, 7)), op.set(v.V)],
          [
            op.get(v.U),
            op.get(v.vZero),
            op.f32x4Ge,
            op.get(v.U),
            op.get(v.vOne),
            op.f32x4Lt,
            op.v128And,
          ],
          [
            op.get(v.V),
            op.get(v.vZero),
            op.f32x4Ge,
            op.v128And,
            op.get(v.V),
            op.get(v.vOne),
            op.f32x4Lt,
            op.v128And,
          ],
          op.set(v.INS),
          group(bilinear),
          // Redo the lanes whose point is outside the grid (inputs taken from U, V: the
          // stores above may have overwritten src when mapping in place).
          [op.get(v.INS), op.i32x4Bitmask, op.tee(v.mask), op.i32Const(15), op.i32LtS],
          op.if,
          [0, 1, 2, 3].map((j) => [
            [op.get(v.mask), op.i32Const(1 << j), op.i32And, op.i32Eqz],
            op.if,
            [op.get(v.grid), op.get(v.R), op.get(v.C)],
            [op.get(v.U), op.f32x4ExtractLane(j), op.get(v.V), op.f32x4ExtractLane(j)],
            [op.get(v.dst), op.i32Const(8 * j), op.i32Add, op.get(v.scratch), call("outside")],
            op.end,
          ]),
          op.end,
          advance([v.src, v.dst], 32),
        ]);
      return [
        toBytes(v.grid, v.src, v.dst, v.scratch),
        [op.get(v.C), op.i32Const(1), op.i32Add, op.i32Const(3), op.i32Shl, op.set(v.rowBytes)],
        [op.get(v.C), op.f32ConvertI32S, op.f32x4Splat, op.set(v.vCf)],
        [op.get(v.R), op.f32ConvertI32S, op.f32x4Splat, op.set(v.vRf)],
        [op.get(v.C), op.i32Const(1), op.i32Sub, op.i32x4Splat, op.set(v.vCm1)],
        [op.get(v.R), op.i32Const(1), op.i32Sub, op.i32x4Splat, op.set(v.vRm1)],
        [op.get(v.rowBytes), op.i32x4Splat, op.set(v.vRow)],
        [op.get(v.grid), op.i32x4Splat, op.set(v.vGrid)],
        [op.f32Const(1), op.f32x4Splat, op.set(v.vOne)],
        [op.get(v.grid), op.get(v.R), op.get(v.C), op.get(v.scratch), op.i32Const(32), op.i32Add],
        call("affineSetup"),
        op.get(v.bilinear),
        op.if,
        loop(true),
        op.else,
        loop(false),
        op.end,
        countedLoop(v.count, 1, [
          [
            op.get(v.grid),
            op.get(v.R),
            op.get(v.C),
            op.get(v.bilinear),
            op.get(v.src),
            op.get(v.dst),
          ],
          [op.get(v.scratch), call("warpOne")],
          advance([v.src, v.dst], 8),
        ]),
      ];
    },
  ),
  wasmFunction(
    "rotate",
    {
      src: i32,
      dst: i32,
      count: i32,
      c: f32,
      s: f32,
      scale: f32,
      ox: f32,
      oy: f32,
      mirrorX: i32,
      mirrorY: i32,
    },
    [],
    { x: f32, y: f32, rx: f32, ry: f32 },
    (v) => [
      toBytes(v.src, v.dst),
      countedLoop(v.count, 1, [
        [op.get(v.src), op.f32Load(0), op.set(v.x), op.get(v.src), op.f32Load(4), op.set(v.y)],
        [op.get(v.x), op.f32Neg, op.get(v.x), op.get(v.mirrorX), op.select, op.set(v.x)],
        [op.get(v.y), op.f32Neg, op.get(v.y), op.get(v.mirrorY), op.select, op.set(v.y)],
        [
          op.get(v.c),
          op.get(v.x),
          op.f32Mul,
          op.get(v.s),
          op.get(v.y),
          op.f32Mul,
          op.f32Sub,
          op.set(v.rx),
        ],
        [
          op.get(v.s),
          op.get(v.x),
          op.f32Mul,
          op.get(v.c),
          op.get(v.y),
          op.f32Mul,
          op.f32Add,
          op.set(v.ry),
        ],
        [
          op.get(v.dst),
          op.get(v.ox),
          op.get(v.scale),
          op.get(v.rx),
          op.f32Mul,
          op.f32Add,
          op.f32Store(0),
        ],
        [
          op.get(v.dst),
          op.get(v.oy),
          op.get(v.scale),
          op.get(v.ry),
          op.f32Mul,
          op.f32Add,
          op.f32Store(4),
        ],
        advance([v.src, v.dst], 8),
      ]),
    ],
  ),
  wasmFunction("flipY", { dst: i32, src: i32, n: i32 }, [], { mask: v128 }, (v) => [
    toBytes(v.dst, v.src),
    // Sign bit of lanes 1 and 3 (the y of each pair).
    [op.v128Const([0, 0, 0, 0, 0, 0, 0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0x80]), op.set(v.mask)],
    countedLoop(v.n, wide ? 4 : 0x40000000, [
      [op.get(v.dst), op.get(v.src), op.v128Load(), op.get(v.mask), op.v128Xor, op.v128Store()],
      advance([v.dst, v.src], 16),
    ]),
    countedLoop(v.n, 2, [
      [op.get(v.dst), op.get(v.src), op.f32Load(0), op.f32Store(0)],
      [op.get(v.dst), op.get(v.src), op.f32Load(4), op.f32Neg, op.f32Store(4)],
      advance([v.dst, v.src], 8),
    ]),
  ]),
];

const KERNELS = kernelFunctions(true);
if (KERNELS.some((f, i) => f.name !== FUNCTIONS[i])) throw new Error("kernel order mismatch");

/**
 * The kernel module's bytes (about 5.2 KB). It is compiled synchronously on
 * first use; if compilation fails or is not allowed, the JavaScript kernels
 * are used instead.
 */
export const KERNEL_MODULE_BYTES: Uint8Array = assembleModule(KERNELS);

/** The module without 4-lane loops (`"wasm-scalar"`). */
export const KERNEL_SCALAR_MODULE_BYTES: Uint8Array = assembleModule(kernelFunctions(false));

/** The subset of the WebAssembly JS API used here (the core is compiled without DOM types). */
interface WasmApi {
  validate(bytes: Uint8Array): boolean;
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
  Memory: new (descriptor: { initial: number }) => { buffer: ArrayBuffer };
}

const compiled: { wide?: object | null; scalar?: object | null } = {};

/** The compiled kernel module (or its scalar form), or null if WebAssembly with SIMD is unavailable. */
function kernelModule(scalar = false): object | null {
  const key = scalar ? "scalar" : "wide";
  if (compiled[key] === undefined) {
    compiled[key] = null;
    const bytes = scalar ? KERNEL_SCALAR_MODULE_BYTES : KERNEL_MODULE_BYTES;
    try {
      const api = (globalThis as { WebAssembly?: WasmApi }).WebAssembly;
      if (api && api.validate(bytes)) compiled[key] = new api.Module(bytes);
    } catch {
      compiled[key] = null;
    }
  }
  return compiled[key];
}

/** Whether the WebAssembly kernels can be used here. */
export function wasmKernelsAvailable(): boolean {
  return kernelModule() !== null;
}

function wasmKernels(module: object, floats: number, scalar = false): Kernels {
  const api = (globalThis as { WebAssembly?: WasmApi }).WebAssembly!;
  const memory = new api.Memory({ initial: Math.max(1, Math.ceil((floats * 4) / 65536)) });
  const ex = new api.Instance(module, { env: { memory } }).exports as unknown as Omit<
    Kernels,
    "kind" | "heap"
  >;
  return {
    kind: scalar ? "wasm-scalar" : "wasm",
    heap: new Float32Array(memory.buffer, 0, floats),
    copy: ex.copy,
    sum1: ex.sum1,
    sum2: ex.sum2,
    sum4: ex.sum4,
    blend0: ex.blend0,
    blend1: ex.blend1,
    warp: ex.warp,
    rotate: ex.rotate,
    flipY: ex.flipY,
  };
}

/**
 * Kernels over a fresh heap of `floats` float32 values. "auto" uses
 * WebAssembly when available and falls back to JavaScript.
 */
export function createKernels(floats: number, choice: KernelChoice = "auto"): Kernels {
  if (choice !== "js") {
    const scalar = choice === "wasm-scalar";
    const module = kernelModule(scalar);
    if (module) return wasmKernels(module, floats, scalar);
    if (choice !== "auto") throw new Error("WebAssembly kernels are not available here");
  }
  return jsKernels(floats);
}

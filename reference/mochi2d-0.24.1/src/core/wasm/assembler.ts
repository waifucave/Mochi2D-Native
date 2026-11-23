/**
 * A minimal WebAssembly binary writer: one imported memory, a list of
 * functions, each exported under its name. Enough for small numeric kernels;
 * instruction bytes come from {@link op}.
 */

export const i32 = 0x7f;
export const f32 = 0x7d;
export const v128 = 0x7b;
export type ValueType = typeof i32 | typeof f32 | typeof v128;

/** Instruction bytes, possibly nested. */
export type Code = number | readonly Code[];

export interface WasmFunction {
  name: string;
  params: readonly ValueType[];
  results: readonly ValueType[];
  locals: readonly ValueType[];
  body: Code;
}

/** Unsigned LEB128. */
export function uleb(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

/** Signed LEB128 (32-bit). */
export function sleb(n: number): number[] {
  const out: number[] = [];
  let v = n | 0;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

function f32Bytes(x: number): number[] {
  return Array.from(new Uint8Array(new Float32Array([x]).buffer));
}

/** memarg: alignment exponent and offset. */
const mem = (align: number, offset: number): number[] => [...uleb(align), ...uleb(offset)];
/** SIMD instructions: 0xfd prefix, LEB128 opcode. */
const simd = (code: number, ...rest: number[]): number[] => [0xfd, ...uleb(code), ...rest];

/** Instruction encoders (the subset the kernels use). */
export const op = {
  block: [0x02, 0x40],
  loop: [0x03, 0x40],
  if: [0x04, 0x40],
  else: 0x05,
  end: 0x0b,
  br: (depth: number) => [0x0c, ...uleb(depth)],
  brIf: (depth: number) => [0x0d, ...uleb(depth)],
  call: (fn: number) => [0x10, ...uleb(fn)],
  return: 0x0f,
  select: 0x1b,
  get: (local: number) => [0x20, ...uleb(local)],
  set: (local: number) => [0x21, ...uleb(local)],
  tee: (local: number) => [0x22, ...uleb(local)],
  i32Load: (offset = 0) => [0x28, ...mem(2, offset)],
  f32Load: (offset = 0) => [0x2a, ...mem(2, offset)],
  i32Store: (offset = 0) => [0x36, ...mem(2, offset)],
  f32Store: (offset = 0) => [0x38, ...mem(2, offset)],
  i32Const: (v: number) => [0x41, ...sleb(v)],
  f32Const: (v: number) => [0x43, ...f32Bytes(v)],
  i32Eqz: 0x45,
  i32LtS: 0x48,
  i32GtS: 0x4a,
  i32GeS: 0x4e,
  f32Lt: 0x5d,
  f32Gt: 0x5e,
  f32Le: 0x5f,
  f32Ge: 0x60,
  i32Add: 0x6a,
  i32Sub: 0x6b,
  i32Mul: 0x6c,
  i32And: 0x71,
  i32Or: 0x72,
  i32Shl: 0x74,
  f32Neg: 0x8c,
  f32Add: 0x92,
  f32Sub: 0x93,
  f32Mul: 0x94,
  f32Div: 0x95,
  i32TruncF32S: 0xa8,
  f32ConvertI32S: 0xb2,
  i32TruncSatF32S: [0xfc, ...uleb(0)],
  memoryCopy: [0xfc, ...uleb(10), 0x00, 0x00],
  v128Load: (offset = 0) => simd(0x00, ...mem(2, offset)),
  v128Store: (offset = 0) => simd(0x0b, ...mem(2, offset)),
  v128Const: (bytes: readonly number[]) => simd(0x0c, ...bytes),
  v128Load64Zero: (offset = 0) => simd(0x5d, ...mem(2, offset)),
  v128Load64Lane: (offset: number, lane: number) => simd(0x57, ...mem(2, offset), lane),
  i8x16Shuffle: (lanes: readonly number[]) => simd(0x0d, ...lanes),
  i32x4Splat: simd(0x11),
  i32x4ExtractLane: (lane: number) => simd(0x1b, lane),
  f32x4Lt: simd(0x43),
  f32x4Le: simd(0x45),
  f32x4Ge: simd(0x46),
  v128And: simd(0x4e),
  v128Xor: simd(0x51),
  v128Bitselect: simd(0x52),
  i32x4AllTrue: simd(0xa3),
  i32x4Bitmask: simd(0xa4),
  f32x4ExtractLane: (lane: number) => simd(0x1f, lane),
  i32x4MaxS: simd(0xb8),
  i32x4Shl: simd(0xab),
  i32x4Add: simd(0xae),
  i32x4Mul: simd(0xb5),
  i32x4MinS: simd(0xb6),
  i32x4TruncSatF32x4S: simd(0xf8),
  f32x4ConvertI32x4S: simd(0xfa),
  f32x4Splat: simd(0x13),
  f32x4Add: simd(0xe4),
  f32x4Sub: simd(0xe5),
  f32x4Mul: simd(0xe6),
} as const;

function flatten(code: Code, out: number[]): number[] {
  if (typeof code === "number") out.push(code);
  else for (const c of code) flatten(c, out);
  return out;
}

const vec = (items: readonly number[][]): number[] => [...uleb(items.length), ...items.flat()];
const name = (s: string): number[] => {
  const bytes = Array.from(s, (ch) => ch.charCodeAt(0) & 0x7f);
  return [...uleb(bytes.length), ...bytes];
};
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

/** Local declarations, grouping runs of the same type. */
function localGroups(locals: readonly ValueType[]): number[][] {
  const groups: number[][] = [];
  let i = 0;
  while (i < locals.length) {
    let j = i;
    while (j < locals.length && locals[j] === locals[i]) j++;
    groups.push([...uleb(j - i), locals[i]!]);
    i = j;
  }
  return groups;
}

/**
 * Assembles a module importing `memory` from `env.memory` (at least
 * `minPages` 64 KiB pages) and exporting every function by name.
 */
export function assembleModule(functions: readonly WasmFunction[], minPages = 1): Uint8Array {
  const types = functions.map((f) => [
    0x60,
    ...vec(f.params.map((p) => [p])),
    ...vec(f.results.map((r) => [r])),
  ]);
  const memoryImport = [...name("env"), ...name("memory"), 0x02, 0x00, ...uleb(minPages)];
  const bodies = functions.map((f) => {
    const body = [...vec(localGroups(f.locals)), ...flatten(f.body, []), op.end];
    return [...uleb(body.length), ...body];
  });
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, vec(types)),
    ...section(2, vec([memoryImport])),
    ...section(3, vec(functions.map((_, i) => uleb(i)))),
    ...section(7, vec(functions.map((f, i) => [...name(f.name), 0x00, ...uleb(i)]))),
    ...section(10, vec(bodies)),
  ]);
}

/**
 * Declares a function with named parameters and locals. `body` receives the
 * local index of every name.
 */
export function wasmFunction<
  P extends Record<string, ValueType>,
  L extends Record<string, ValueType>,
>(
  fnName: string,
  params: P,
  results: readonly ValueType[],
  locals: L,
  body: (v: { [K in keyof P | keyof L]: number }) => Code,
): WasmFunction {
  const index: Record<string, number> = {};
  let n = 0;
  for (const k of Object.keys(params)) index[k] = n++;
  for (const k of Object.keys(locals)) index[k] = n++;
  return {
    name: fnName,
    params: Object.values(params),
    results,
    locals: Object.values(locals),
    body: body(index as { [K in keyof P | keyof L]: number }),
  };
}

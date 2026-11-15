/**
 * Binary reader with bounds checking. Little-endian by default; pass
 * `littleEndian: false` for big-endian data.
 *
 * Every read validates that the requested bytes lie inside the view and throws a
 * {@link BinaryReadError} carrying the offset, the requested size and an optional
 * label describing what was being read, so format errors are easy to locate.
 */
import { decodeUtf8 } from "./utf8.js";

const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export class BinaryReadError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly length: number,
    readonly byteLength: number,
    readonly label?: string,
  ) {
    super(message);
    this.name = "BinaryReadError";
  }
}

function hex(n: number): string {
  return "0x" + n.toString(16).padStart(8, "0");
}

export class ByteReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private pos = 0;

  /** True when multi-byte values are little-endian. */
  readonly littleEndian: boolean;
  /** Typed arrays can be copied directly when the data matches the host byte order. */
  private readonly fastPath: boolean;

  constructor(
    data: ArrayBuffer | ArrayBufferView,
    offset = 0,
    length?: number,
    littleEndian = true,
  ) {
    this.littleEndian = littleEndian;
    this.fastPath = littleEndian === HOST_LITTLE_ENDIAN;
    if (ArrayBuffer.isView(data)) {
      const base = data.byteOffset + offset;
      const len = length ?? data.byteLength - offset;
      if (offset < 0 || len < 0 || offset + len > data.byteLength) {
        throw new RangeError(
          `ByteReader window [${offset}, +${len}) exceeds ${data.byteLength} bytes`,
        );
      }
      this.view = new DataView(data.buffer, base, len);
    } else {
      const len = length ?? data.byteLength - offset;
      if (offset < 0 || len < 0 || offset + len > data.byteLength) {
        throw new RangeError(
          `ByteReader window [${offset}, +${len}) exceeds ${data.byteLength} bytes`,
        );
      }
      this.view = new DataView(data, offset, len);
    }
    this.bytes = new Uint8Array(this.view.buffer, this.view.byteOffset, this.view.byteLength);
  }

  /** Total number of bytes in this reader's window. */
  get byteLength(): number {
    return this.view.byteLength;
  }

  /** Current cursor position (relative to the window start). */
  get position(): number {
    return this.pos;
  }

  /** Bytes left between the cursor and the end of the window. */
  get remaining(): number {
    return this.view.byteLength - this.pos;
  }

  /** Moves the cursor to an absolute position (end of window is allowed). */
  seek(offset: number, label?: string): this {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.view.byteLength) {
      throw new BinaryReadError(
        `${label ? label + ": " : ""}seek to ${offset} outside [0, ${this.view.byteLength}]`,
        offset,
        0,
        this.view.byteLength,
        label,
      );
    }
    this.pos = offset;
    return this;
  }

  skip(count: number, label?: string): this {
    this.check(this.pos, count, label);
    this.pos += count;
    return this;
  }

  /** Throws unless `[offset, offset + length)` lies inside the window. */
  check(offset: number, length: number, label?: string): void {
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.view.byteLength
    ) {
      const what = label ? `${label}: ` : "";
      throw new BinaryReadError(
        `${what}read of ${length} byte(s) at ${hex(offset)} exceeds buffer of ${this.view.byteLength} byte(s)`,
        offset,
        length,
        this.view.byteLength,
        label,
      );
    }
  }

  /** Returns `true` if `[offset, offset + length)` lies inside the window. */
  inBounds(offset: number, length: number): boolean {
    return (
      Number.isInteger(offset) &&
      Number.isInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset + length <= this.view.byteLength
    );
  }

  // ---- absolute reads (do not move the cursor) ----

  u8At(offset: number, label?: string): number {
    this.check(offset, 1, label);
    return this.view.getUint8(offset);
  }
  i8At(offset: number, label?: string): number {
    this.check(offset, 1, label);
    return this.view.getInt8(offset);
  }
  u16At(offset: number, label?: string): number {
    this.check(offset, 2, label);
    return this.view.getUint16(offset, this.littleEndian);
  }
  i16At(offset: number, label?: string): number {
    this.check(offset, 2, label);
    return this.view.getInt16(offset, this.littleEndian);
  }
  u32At(offset: number, label?: string): number {
    this.check(offset, 4, label);
    return this.view.getUint32(offset, this.littleEndian);
  }
  i32At(offset: number, label?: string): number {
    this.check(offset, 4, label);
    return this.view.getInt32(offset, this.littleEndian);
  }
  f32At(offset: number, label?: string): number {
    this.check(offset, 4, label);
    return this.view.getFloat32(offset, this.littleEndian);
  }
  f64At(offset: number, label?: string): number {
    this.check(offset, 8, label);
    return this.view.getFloat64(offset, this.littleEndian);
  }
  /** 64-bit unsigned integer; throws if it does not fit a safe JS integer. */
  u64At(offset: number, label?: string): number {
    this.check(offset, 8, label);
    const v = this.view.getBigUint64(offset, this.littleEndian);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BinaryReadError(
        `${label ? label + ": " : ""}u64 value ${v} at ${hex(offset)} exceeds 2^53-1`,
        offset,
        8,
        this.view.byteLength,
        label,
      );
    }
    return Number(v);
  }

  /** Copy of `length` bytes at `offset`. */
  bytesAt(offset: number, length: number, label?: string): Uint8Array {
    this.check(offset, length, label);
    return this.bytes.slice(offset, offset + length);
  }

  /** Zero-copy view of `length` bytes at `offset` (shares memory with the source). */
  viewAt(offset: number, length: number, label?: string): Uint8Array {
    this.check(offset, length, label);
    return this.bytes.subarray(offset, offset + length);
  }

  /** `count` float32 values starting at `offset` (copied, alignment-independent). */
  f32ArrayAt(offset: number, count: number, label?: string): Float32Array {
    this.check(offset, count * 4, label);
    if (this.fastPath) return new Float32Array(this.copyBytes(offset, count * 4));
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++)
      out[i] = this.view.getFloat32(offset + i * 4, this.littleEndian);
    return out;
  }
  i32ArrayAt(offset: number, count: number, label?: string): Int32Array {
    this.check(offset, count * 4, label);
    if (this.fastPath) return new Int32Array(this.copyBytes(offset, count * 4));
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getInt32(offset + i * 4, this.littleEndian);
    return out;
  }
  u32ArrayAt(offset: number, count: number, label?: string): Uint32Array {
    this.check(offset, count * 4, label);
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getUint32(offset + i * 4, this.littleEndian);
    return out;
  }
  u16ArrayAt(offset: number, count: number, label?: string): Uint16Array {
    this.check(offset, count * 2, label);
    if (this.fastPath) return new Uint16Array(this.copyBytes(offset, count * 2));
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getUint16(offset + i * 2, this.littleEndian);
    return out;
  }
  i16ArrayAt(offset: number, count: number, label?: string): Int16Array {
    this.check(offset, count * 2, label);
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getInt16(offset + i * 2, this.littleEndian);
    return out;
  }

  /**
   * Fixed-size, NUL-padded string field decoded as UTF-8. Bytes after the first
   * NUL are ignored.
   */
  fixedStringAt(offset: number, size: number, label?: string): string {
    const raw = this.viewAt(offset, size, label);
    let end = raw.indexOf(0);
    if (end < 0) end = size;
    return decodeUtf8(raw.subarray(0, end));
  }

  // ---- sequential reads (advance the cursor) ----

  u8(label?: string): number {
    const v = this.u8At(this.pos, label);
    this.pos += 1;
    return v;
  }
  i8(label?: string): number {
    const v = this.i8At(this.pos, label);
    this.pos += 1;
    return v;
  }
  u16(label?: string): number {
    const v = this.u16At(this.pos, label);
    this.pos += 2;
    return v;
  }
  i16(label?: string): number {
    const v = this.i16At(this.pos, label);
    this.pos += 2;
    return v;
  }
  u32(label?: string): number {
    const v = this.u32At(this.pos, label);
    this.pos += 4;
    return v;
  }
  i32(label?: string): number {
    const v = this.i32At(this.pos, label);
    this.pos += 4;
    return v;
  }
  f32(label?: string): number {
    const v = this.f32At(this.pos, label);
    this.pos += 4;
    return v;
  }
  f64(label?: string): number {
    const v = this.f64At(this.pos, label);
    this.pos += 8;
    return v;
  }
  u64(label?: string): number {
    const v = this.u64At(this.pos, label);
    this.pos += 8;
    return v;
  }
  readBytes(length: number, label?: string): Uint8Array {
    const v = this.bytesAt(this.pos, length, label);
    this.pos += length;
    return v;
  }
  fixedString(size: number, label?: string): string {
    const v = this.fixedStringAt(this.pos, size, label);
    this.pos += size;
    return v;
  }

  /** Advances the cursor to the next multiple of `alignment`. */
  align(alignment: number, label?: string): this {
    const rem = this.pos % alignment;
    if (rem !== 0) this.skip(alignment - rem, label);
    return this;
  }

  /** Copies bytes into a fresh, aligned ArrayBuffer. */
  private copyBytes(offset: number, length: number): ArrayBuffer {
    const out = new Uint8Array(length);
    out.set(this.bytes.subarray(offset, offset + length));
    return out.buffer;
  }

  /** A reader over a sub-range of this one (offsets in the child start at 0). */
  slice(offset: number, length: number, label?: string): ByteReader {
    this.check(offset, length, label);
    return new ByteReader(this.view, offset, length, this.littleEndian);
  }
}

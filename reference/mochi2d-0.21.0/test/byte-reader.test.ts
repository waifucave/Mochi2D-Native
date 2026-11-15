import { describe, expect, it } from "vitest";
import { BinaryReadError, ByteReader } from "../src/core/binary/byte-reader.js";

function sample(): Uint8Array {
  const buf = new ArrayBuffer(32);
  const dv = new DataView(buf);
  dv.setUint32(0, 0xdeadbeef, true);
  dv.setInt16(4, -2, true);
  dv.setFloat32(8, 1.5, true);
  dv.setFloat32(12, -0.25, true);
  new Uint8Array(buf, 16, 6).set([0x68, 0x69, 0, 0x7a, 0x7a, 0x7a]); // "hi\0zzz"
  dv.setBigUint64(24, 123456789012345n, true);
  return new Uint8Array(buf);
}

describe("ByteReader", () => {
  it("reads little-endian values sequentially and absolutely", () => {
    const r = new ByteReader(sample());
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.i16()).toBe(-2);
    expect(r.position).toBe(6);
    r.align(4);
    expect(r.position).toBe(8);
    expect(r.f32()).toBe(1.5);
    expect(r.f32At(12)).toBe(-0.25);
    expect(Array.from(r.f32ArrayAt(8, 2))).toEqual([1.5, -0.25]);
    expect(r.fixedStringAt(16, 6)).toBe("hi");
    expect(r.u64At(24)).toBe(123456789012345);
    expect(r.remaining).toBe(20);
  });

  it("throws BinaryReadError with offset and label on out-of-bounds reads", () => {
    const r = new ByteReader(sample());
    try {
      r.u32At(30, "header.count");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BinaryReadError);
      const err = e as BinaryReadError;
      expect(err.offset).toBe(30);
      expect(err.length).toBe(4);
      expect(err.label).toBe("header.count");
      expect(err.message).toContain("header.count");
      expect(err.message).toContain("0x0000001e");
    }
    expect(() => r.f32ArrayAt(0, 9)).toThrow(BinaryReadError);
    expect(() => r.u8At(-1)).toThrow(BinaryReadError);
    expect(() => r.seek(33)).toThrow(BinaryReadError);
    expect(() => r.u8At(1.5)).toThrow(BinaryReadError);
  });

  it("respects sub-views and slices", () => {
    const bytes = sample();
    const r = new ByteReader(bytes.subarray(8, 16));
    expect(r.byteLength).toBe(8);
    expect(r.f32At(0)).toBe(1.5);
    expect(() => r.u8At(8)).toThrow(BinaryReadError);
    const s = new ByteReader(bytes).slice(16, 6);
    expect(s.fixedString(6)).toBe("hi");
    expect(s.remaining).toBe(0);
  });

  it("reads unaligned arrays", () => {
    const bytes = new Uint8Array(9);
    new DataView(bytes.buffer).setFloat32(1, 3.25, true);
    new DataView(bytes.buffer).setFloat32(5, -7, true);
    expect(Array.from(new ByteReader(bytes).f32ArrayAt(1, 2))).toEqual([3.25, -7]);
  });

  it("rejects u64 values beyond 2^53-1", () => {
    const bytes = new Uint8Array(8).fill(0xff);
    expect(() => new ByteReader(bytes).u64At(0)).toThrow(/exceeds 2\^53-1/);
  });
});

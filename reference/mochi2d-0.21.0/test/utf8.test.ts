import { describe, expect, it } from "vitest";
import { decodeUtf8 } from "../src/core/binary/utf8.js";

const R = "�";

describe("decodeUtf8", () => {
  it("matches TextDecoder on valid input", () => {
    for (const s of ["", "abc", "大肥鱼.model3.json", "＞＜", "emoji 😀 ok", "é ß ∑"]) {
      expect(decodeUtf8(new TextEncoder().encode(s))).toBe(s);
    }
  });
  it("replaces invalid sequences with U+FFFD and keeps valid bytes", () => {
    const cases: [number[], string][] = [
      [[0xff], R],
      [[0xc0, 0x80], R + R],
      [[0xed, 0xa0, 0x80], R + R + R],
      [[0x61, 0x80, 0x62], `a${R}b`],
    ];
    for (const [bytes, want] of cases) expect(decodeUtf8(new Uint8Array(bytes))).toBe(want);
    expect(decodeUtf8(new Uint8Array([0xe2, 0x82, 0x61]))).toMatch(/^�+a$/);
  });
});

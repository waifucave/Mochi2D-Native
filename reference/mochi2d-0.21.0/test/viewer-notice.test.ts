import { describe, expect, it } from "vitest";
import { downscaleNotice } from "../src/lib/texture-notice.js";

const tex = (label: string, ow: number, oh: number, w = ow, h = oh) => ({
  label,
  originalWidth: ow,
  originalHeight: oh,
  width: w,
  height: h,
});

describe("viewer notice for downscaled textures (B4)", () => {
  it("is absent when every texture has its stored size", () => {
    expect(downscaleNotice([tex("a.png", 4096, 8192), tex("b.png", 2048, 2048)])).toBeNull();
    expect(downscaleNotice([])).toBeNull();
  });

  it("names each downscaled texture with both sizes", () => {
    const text = downscaleNotice([
      tex("dir/texture_00.png", 4096, 8192),
      tex("dir/texture_03.png", 8192, 8192, 4096, 4096),
      tex("texture_04.png", 4096, 4096, 4096, 2048),
    ]);
    expect(text).toContain("2 of 3 textures downscaled");
    expect(text).toContain("texture_03.png 8192×8192 → 4096×4096");
    expect(text).toContain("texture_04.png 4096×4096 → 4096×2048");
    expect(text).not.toContain("texture_00");
    expect(text).not.toContain("dir/");
  });
});

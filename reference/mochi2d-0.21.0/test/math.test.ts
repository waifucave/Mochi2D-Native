import { describe, expect, it } from "vitest";
import * as v2 from "../src/core/math/vec2.js";
import {
  invert3,
  multiply3,
  rotation3,
  scaling3,
  transformPoint3,
  transformPoints3,
  translation3,
  identity3,
} from "../src/core/math/mat3.js";
import {
  identity4,
  invert4,
  multiply4,
  ortho4,
  scaling4,
  transformPoint4,
  translation4,
} from "../src/core/math/mat4.js";
import { clamp, invLerp, lerp } from "../src/core/math/scalar.js";

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(eps);
};

describe("scalar", () => {
  it("clamps and interpolates", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(lerp(2, 4, 0.25)).toBe(2.5);
    expect(invLerp(2, 4, 2.5)).toBe(0.25);
    expect(invLerp(1, 1, 3)).toBe(0);
  });
});

describe("vec2", () => {
  it("basic ops", () => {
    expect(v2.add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
    expect(v2.cross({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(1);
    const r = v2.rotate({ x: 1, y: 0 }, Math.PI / 2);
    close([r.x, r.y], [0, 1]);
    expect(v2.normalize({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe("mat3", () => {
  it("composes translate * rotate * scale (applied right to left)", () => {
    const m = multiply3(translation3(10, 0), multiply3(rotation3(Math.PI / 2), scaling3(2, 2)));
    const p = transformPoint3(m, { x: 1, y: 0 });
    close([p.x, p.y], [10, 2]);
    close(transformPoints3(m, [1, 0, 0, 1]), [10, 2, 8, 0]);
  });
  it("inverts", () => {
    const m = multiply3(translation3(3, -4), multiply3(rotation3(0.7), scaling3(2, 0.5)));
    close(multiply3(m, invert3(m)!), identity3());
    expect(invert3(scaling3(0, 1))).toBeNull();
  });
});

describe("mat4", () => {
  it("ortho maps the box to clip space", () => {
    const m = ortho4(0, 100, 0, 50);
    close(transformPoint4(m, 0, 0), [-1, -1]);
    close(transformPoint4(m, 100, 50), [1, 1]);
  });
  it("inverts", () => {
    const m = multiply4(translation4(1, 2, 3), multiply4(scaling4(2, 3, 4), ortho4(-1, 3, -2, 5)));
    close(multiply4(m, invert4(m)!), identity4());
    close(multiply4(invert4(m)!, m), identity4());
  });
});

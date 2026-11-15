/**
 * Items, the parts that need no GPU: item
 * settings from a `.vtube.json`, head-angle smoothing, placement math, and
 * pinning to a triangle of DeepSeek-chan's meshes.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { loadModelFromDisk } from "../src/lib/node.js";
import type { ModelRuntime } from "../src/runtime/model-runtime.js";
import {
  HeadAngleSmoother,
  parseItemSettings,
  readItemSettings,
} from "../src/lib/items/item-settings.js";
import {
  anchorPoint,
  applyAffine,
  canvasRect,
  defaultPlacement,
  invertAffine,
  itemToMain,
  type ItemPlacement,
} from "../src/lib/items/placement.js";
import { findPinTarget, pinPose, triangleAt } from "../src/lib/items/pin.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("item settings (.vtube.json)", () => {
  const sample = {
    ItemSettings: {
      OnlyMoveWhenPinned: false,
      AllowNormalHotkeyTriggers: true,
      Multiplier_HeadAngleX: 1.0,
      Multiplier_HeadAngleY: 0.5,
      Multiplier_HeadAngleZ: 1.0,
      Shift_HeadAngleX: 0.0,
      Shift_HeadAngleY: 3.0,
      Smoothing_HeadAngleX: 15.0,
      Smoothing_HeadAngleY: 15.0,
      Smoothing_HeadAngleZ: 15.0,
    },
  };

  it("reads ItemSettings, with defaults for missing values", () => {
    const s = parseItemSettings(sample, "a.vtube.json")!;
    expect(s.multiplier).toEqual({ x: 1, y: 0.5, z: 1 });
    expect(s.shift).toEqual({ x: 0, y: 3, z: 0 }); // no Shift_HeadAngleZ: 0
    expect(s.smoothing).toEqual({ x: 15, y: 15, z: 15 });
    expect(s.onlyMoveWhenPinned).toBe(false);
    expect(s.allowNormalHotkeyTriggers).toBe(true);
    expect(parseItemSettings({ Version: 1 }, "b.vtube.json")).toBeNull();
    expect(parseItemSettings([], "c.vtube.json")).toBeNull();
  });

  it("finds the .vtube.json next to the settings file", async () => {
    const src = new MemoryFileSource("item", [
      ["Item/item.model3.json", enc("{}")],
      ["Item/item.vtube.json", enc(JSON.stringify(sample))],
      ["Other/other.vtube.json", enc(JSON.stringify(sample))],
    ]);
    expect((await readItemSettings(src, "Item/item.model3.json"))?.file).toBe("item.vtube.json");
    // The only .vtube.json of a folder counts even with another base name.
    const single = new MemoryFileSource("x", [
      ["m.model3.json", enc("{}")],
      ["vts.vtube.json", enc(JSON.stringify(sample))],
    ]);
    expect((await readItemSettings(single, "m.model3.json"))?.file).toBe("vts.vtube.json");
    // None, or one without ItemSettings, or a broken one: null.
    expect(
      await readItemSettings(
        new MemoryFileSource("y", [["m.model3.json", enc("{}")]]),
        "m.model3.json",
      ),
    ).toBeNull();
    const broken = new MemoryFileSource("z", [
      ["m.model3.json", enc("{}")],
      ["m.vtube.json", enc("{")],
    ]);
    expect(await readItemSettings(broken, "m.model3.json")).toBeNull();
  });

  it("smooths with a time constant of strength / 100 seconds, independent of the frame rate", () => {
    const a = new HeadAngleSmoother(15);
    expect(a.step(0, 0)).toBe(0); // the first value is taken as is
    // After τ = 0.15 s, 1 − 1/e of the step remains behind.
    let v = 0;
    for (let i = 0; i < 9; i++) v = a.step(10, 1 / 60);
    expect(v).toBeCloseTo(10 * (1 - Math.exp(-1)), 6);
    const b = new HeadAngleSmoother(15);
    b.step(0, 0);
    let w = 0;
    for (let i = 0; i < 18; i++) w = b.step(10, 1 / 120);
    expect(w).toBeCloseTo(v, 9);
    const none = new HeadAngleSmoother(0);
    none.step(0, 0);
    expect(none.step(7, 1 / 60)).toBe(7);
  });
});

describe("placement", () => {
  // An item canvas 2000 × 1000 px at 1000 px/unit, a main canvas 4000 px/unit.
  const item = canvasRect({
    width: 2000,
    height: 1000,
    originX: 1000,
    originY: 500,
    pixelsPerUnit: 1000,
  } as never);
  const main = canvasRect({
    width: 4000,
    height: 8000,
    originX: 2000,
    originY: 4000,
    pixelsPerUnit: 4000,
  } as never);
  const p = (q: Partial<ItemPlacement>): ItemPlacement => ({ ...defaultPlacement(main), ...q });

  it("puts the anchor at the position, one item pixel per main pixel at scale 1", () => {
    const m = itemToMain(item, main, p({ x: 0.1, y: -0.2 }));
    const [ax, ay] = anchorPoint(item, p({}));
    expect(applyAffine(m, ax, ay)).toEqual([0.1, -0.2]);
    // The item's right edge (1 unit = 1000 px from its center) lies 1000 main pixels away.
    const [x] = applyAffine(m, item.right, 0);
    expect(x).toBeCloseTo(0.1 + 1000 / 4000, 12);
  });

  it("rotates counterclockwise about the anchor and scales", () => {
    const m = itemToMain(
      item,
      main,
      p({ x: 0, y: 0, rotation: 90, scale: 2, anchorX: 0, anchorY: 0 }),
    );
    // The anchor is the top-left corner (−1, 0.5); its right neighbour goes up.
    const [x, y] = applyAffine(m, item.left + 0.5, item.top);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo((2 * 500) / 4000, 12);
    const inv = invertAffine(m);
    const [ix, iy] = applyAffine(inv, x, y);
    expect(ix).toBeCloseTo(item.left + 0.5, 12);
    expect(iy).toBeCloseTo(item.top, 12);
  });

  it("mirrors about the anchor before rotating, and is unchanged without the mirror", () => {
    const q = p({ x: 0.3, y: 0.1, rotation: 30, scale: 1.5, anchorX: 0.25, anchorY: 0.6 });
    const plain = itemToMain(item, main, q);
    expect(itemToMain(item, main, { ...q, mirror: false })).toEqual(plain);
    const { mirror: _, ...old } = q; // a placement from a layout before 0.7.0
    expect(itemToMain(item, main, old)).toEqual(plain);
    const m = itemToMain(item, main, { ...q, mirror: true });
    const [ax, ay] = anchorPoint(item, q);
    // The anchor stays; a point d to its right goes where the plain map puts the point d to its left.
    expect(applyAffine(m, ax, ay)).toEqual(
      applyAffine(plain, ax, ay).map((v) => expect.closeTo(v, 12)),
    );
    for (const [dx, dy] of [
      [0.2, 0],
      [0.3, -0.1],
      [-0.4, 0.25],
    ] as const) {
      const [x1, y1] = applyAffine(m, ax + dx, ay + dy);
      const [x2, y2] = applyAffine(plain, ax - dx, ay + dy);
      expect(x1).toBeCloseTo(x2, 12);
      expect(y1).toBeCloseTo(y2, 12);
    }
    // And its inverse brings points back (hit tests).
    const [ix, iy] = applyAffine(invertAffine(m), ...applyAffine(m, 0.1, -0.2));
    expect(ix).toBeCloseTo(0.1, 12);
    expect(iy).toBeCloseTo(-0.2, 12);
  });
});

describe.skipIf(!HAVE_DEEPSEEK)("pinning to DeepSeek-chan", () => {
  let rt: ModelRuntime;
  beforeAll(async () => {
    rt = await loadModelFromDisk(join(DEEPSEEK, "大肥鱼.model3.json"));
    rt.update(1 / 60);
  });

  it("finds the topmost visible drawable's triangle and the point's barycentric weights", () => {
    const pin = findPinTarget(rt.model, rt.instance, 0, 0.1)!;
    expect(pin).not.toBeNull();
    expect(pin.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(pin.weights.every((w) => w >= -1e-6)).toBe(true);
    // Nothing visible is above it at that point.
    const rank = rt.instance.drawableRenderOrder;
    for (let d = 0; d < rt.model.meshes.ids.length; d++) {
      if (!rt.instance.drawableVisible[d] || rank[d]! <= rank[pin.drawable]!) continue;
      if (rt.model.meshes.masks[d]!.length) continue; // masked drawables may not show there
      expect(triangleAt(rt.model, rt.instance, d, 0, 0.1)).toBeNull();
    }
    const pose = pinPose(rt.instance, pin);
    expect(pose.x).toBeCloseTo(0, 6);
    expect(pose.y).toBeCloseTo(0.1, 6);
    expect(pose.angle).toBeCloseTo(0, 12);
    expect(findPinTarget(rt.model, rt.instance, 50, 50)).toBeNull();
  });

  it("skips drawables whose texture is transparent at the point", () => {
    const opaque = findPinTarget(rt.model, rt.instance, 0, 0.1)!;
    const firstTransparent = findPinTarget(rt.model, rt.instance, 0, 0.1, (tex, u, v) => {
      void tex;
      void u;
      void v;
      return 0;
    });
    expect(firstTransparent).toBeNull(); // every texel transparent: nothing to pin to
    let calls = 0;
    const second = findPinTarget(rt.model, rt.instance, 0, 0.1, () => (calls++ === 0 ? 0 : 1))!;
    expect(second.drawable).not.toBe(opaque.drawable);
  });

  it("follows the triangle when the model moves", () => {
    const pin = findPinTarget(rt.model, rt.instance, 0, 0.3)!;
    const before = pinPose(rt.instance, pin);
    rt.setParameter("ParamBodyAngleZ", 10);
    rt.setEffect("physics", false);
    for (let i = 0; i < 30; i++) rt.update(1 / 60);
    const after = pinPose(rt.instance, pin);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(1e-3);
    expect(Math.abs(after.angle)).toBeGreaterThan(1e-3);
    // The pinned point is still the same weighted mix of the triangle's vertices.
    const v = rt.instance.drawableVertices[pin.drawable]!;
    const [i0, i1, i2] = pin.vertices;
    const x =
      pin.weights[0] * v[2 * i0]! + pin.weights[1] * v[2 * i1]! + pin.weights[2] * v[2 * i2]!;
    expect(after.x).toBeCloseTo(x, 12);
  });
});

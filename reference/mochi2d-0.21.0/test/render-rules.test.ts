/**
 * The renderer's float32 rules on the CPU side (docs/rendering.md): the v
 * a texture is sampled at (rule V) and the mask matrices (rule M), the
 * latter against a float32 reference of their own, entry by entry, on
 * DeepSeek-chan's mask groups. The images are checked by the render hashes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sampledUvs, sampledV } from "../src/core/render/sampling.js";
import {
  columnMajor,
  composeF32,
  inverseView,
  layerMaskMatrix,
  maskMatrices,
  multiplyF32,
  viewMatrix,
} from "../src/core/render/mask-matrix.js";
import { drawablesBox, drawablesUnder, maskGroups, maskMapping } from "../src/core/render/masks.js";
import { clipTransform, frameImage } from "../src/core/render/framing.js";
import { craftQ2 } from "./support/crafted.js";
import { loadMoc } from "../src/core/moc/model.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const f32 = Math.fround;
const bits = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0]!;

describe("rule V: textures sampled at v flipped twice in float32", () => {
  it("moves 0.1 three units in the last place, and keeps a v that survives the flips", () => {
    expect(bits(f32(0.1))).toBe(0x3dcccccd);
    expect(bits(f32(1 - f32(0.1)))).toBe(0x3f666666);
    expect(bits(sampledV(f32(0.1)))).toBe(0x3dccccd0);
    for (const v of [0, 0.25, 0.5, 0.75, 1]) expect(sampledV(v)).toBe(v);
    // From 0.5 up, 1 − v is exact: nothing changes.
    expect(sampledV(f32(0.9))).toBe(f32(0.9));
  });

  it("changes v only, as a float32 array", () => {
    const uv = new Float32Array([0.1, 0.1, 0.3, 0.9]);
    const s = sampledUvs(uv);
    expect(Array.from(s)).toEqual([f32(0.1), sampledV(f32(0.1)), f32(0.3), f32(0.9)]);
    expect(Array.from(uv)).toEqual(Array.from(new Float32Array([0.1, 0.1, 0.3, 0.9])));
  });

  it.skipIf(!HAVE_DEEPSEEK)("moves the v of 14,506 of DeepSeek-chan's 58,967 vertices", () => {
    const model = loadMoc(new Uint8Array(readFileSync(join(DEEPSEEK, "大肥鱼.moc3"))));
    let all = 0;
    let moved = 0;
    for (const uv of model.meshes.uvs)
      for (let i = 1; i < uv.length; i += 2) {
        all++;
        if (sampledV(uv[i]!) !== uv[i]) moved++;
      }
    expect([moved, all]).toEqual([14506, 58967]);
  });
});

/**
 * The reference: each entry written out from the composition order by hand.
 * Texture: [sx, 0, 0, f32(ℓx + f32(sx·(−bx)))], the same for y.
 * Clip: [f32(2sx), 0, 0, f32(f32(2ℓx − 1) + f32(2sx·(−bx)))], the same for y.
 */
function reference(b: [number, number], s: [number, number], l: [number, number]) {
  const [bx, by] = [f32(b[0]), f32(b[1])];
  const [sx, sy] = [f32(s[0]), f32(s[1])];
  const [lx, ly] = [f32(l[0]), f32(l[1])];
  const tx = f32(lx + f32(sx * -bx));
  const ty = f32(ly + f32(sy * -by));
  const cx = f32(f32(2 * lx - 1) + f32(2 * sx * -bx));
  const cy = f32(f32(2 * ly - 1) + f32(2 * sy * -by));
  // prettier-ignore
  return {
    texture: [sx, 0, 0, tx, 0, sy, 0, ty, 0, 0, 1, 0, 0, 0, 0, 1],
    clip: [f32(2 * sx), 0, 0, cx, 0, f32(2 * sy), 0, cy, 0, 0, 1, 0, 0, 0, 0, 1],
  };
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Array.from(a).every((x, i) => Object.is(x === 0 ? 0 : x, b[i] === 0 ? 0 : b[i]));

describe("rule M: mask coordinates through float32 matrices", () => {
  it("rounds each addition of a product to float32, terms in increasing order", () => {
    const a = new Float32Array(16);
    const b = new Float32Array(16);
    a.set([1, f32(1e-8), 0, 0], 0);
    b[0] = 1;
    b[4] = 1;
    // 1 + 1e-8 rounds back to 1 in float32 (not in double).
    expect(multiplyF32(a, b)[0]).toBe(1);
    expect(composeF32([])).toEqual(
      new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    );
  });

  it("builds both matrices as the reference does, for whole-texture and atlas masks", () => {
    const cases: [[number, number], [number, number], [number, number]][] = [
      [
        [-0.123456, 0.654321],
        [3749 / 4096, 3749 / 4096],
        [0, 0],
      ],
      [
        [0.1, -0.7],
        [1 / (1.1 * 0.37), 1 / (1.1 * 2.9)],
        [0, 0],
      ],
      [
        [-0.3, 0.2],
        [512 / 2048, 512 / 2048],
        [18 / 2048, 530 / 2048],
      ],
    ];
    for (const [b, s, l] of cases) {
      const m = maskMatrices({ ox: b[0], oy: b[1], sx: s[0], sy: s[1], lx: l[0], ly: l[1] });
      const r = reference(b, s, l);
      expect(same(m.texture, r.texture), `texture ${b} ${s} ${l}`).toBe(true);
      expect(same(m.clip, r.clip), `clip ${b} ${s} ${l}`).toBe(true);
    }
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "matches the reference entry by entry on DeepSeek-chan's mask groups",
    () => {
      const model = loadMoc(new Uint8Array(readFileSync(join(DEEPSEEK, "大肥鱼.moc3"))));
      const inst = new ModelInstance(model);
      inst.evaluate();
      const groups = maskGroups(model.meshes.masks).groups;
      expect(groups.length).toBeGreaterThan(5);
      let differsFromOneRounding = 0;
      for (const g of groups) {
        const box = drawablesBox(g.members, inst.drawableVertices, true);
        const map = maskMapping(box, model.canvas.pixelsPerUnit, 4096);
        const m = maskMatrices(map);
        const r = reference([map.ox, map.oy], [map.sx, map.sy], [0, 0]);
        expect(same(m.texture, r.texture)).toBe(true);
        expect(same(m.clip, r.clip)).toBe(true);
        // The column-major copy WebGL takes holds the translation in entries 12 and 13.
        const gl = columnMajor(m.texture);
        expect([gl[0], gl[5], gl[12], gl[13]]).toEqual([
          r.texture[0],
          r.texture[5],
          r.texture[3],
          r.texture[7],
        ]);
        // The clip translation rounded once from double is not always the same.
        const once = f32(-1 - 2 * f32(map.sx) * f32(map.ox));
        if (once !== m.clip[3]) differsFromOneRounding++;
      }
      console.log(
        `${groups.length} mask groups; the clip x translation differs from one rounding in ${differsFromOneRounding}`,
      );
    },
  );
});

describe("rule I: a masked layer's mask through D = A · V⁻¹", () => {
  it("inverts the view matrix in double and stores float32", () => {
    const v = viewMatrix([5.859375, 5.859375, -0.46875, 2.9296875]);
    const inv = inverseView(v);
    expect([bits(inv[0]!), bits(inv[5]!), bits(inv[3]!), bits(inv[7]!)]).toEqual([
      0x3e2ec33e, 0x3e2ec33e, 0x3da3d70a, 0xbf000000,
    ]);
    // With a rotation, V⁻¹·V is the identity to float32 precision.
    const turned = viewMatrix([0.01, 0.02, 0.3, -0.4], [Math.cos(0.5), 0.6, 0.4]);
    const back = multiplyF32(inverseView(turned), turned);
    for (const [i, want] of [
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 0],
      [5, 1],
      [7, 0],
    ] as const)
      expect(back[i]!).toBeCloseTo(want, 6);
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "gives the numeric vector: q2d-leg-pose, the mask of Part30's offscreen",
    () => {
      const model = loadMoc(craftQ2("q2d"));
      const inst = new ModelInstance(model);
      inst.setParameter(inst.parameterIndex("HipAngleX"), 20);
      inst.evaluate();
      // The offscreen's mask group: the box over every drawable under its owners (C9), 256 × 256 (C8).
      const owner = model.parts.ids.indexOf("Part30");
      const o = Array.from(model.offscreens.part).indexOf(owner);
      const grouping = maskGroups(model.offscreens.masks);
      const g = grouping.groups[grouping.groupOf[o]!]!;
      const members = [
        ...new Set(
          Array.from(g.members).flatMap((k) =>
            drawablesUnder(model.meshes.part, model.parts.parent, model.offscreens.part[k]!),
          ),
        ),
      ].sort((a, b) => a - b);
      const box = drawablesBox(members, inst.drawableVertices, false);
      const map = maskMapping(box, model.canvas.pixelsPerUnit, 256);
      const framing = frameImage(model.canvas, 512, 512, { x: 0.08, y: -0.5, pixelsPerUnit: 1500 });
      const v = viewMatrix(clipTransform(framing));
      const a = maskMatrices(map).texture;
      const inv = inverseView(v);
      const d = layerMaskMatrix(map, v);
      const entries = (m: Float32Array) => [m[0]!, m[5]!, m[3]!, m[7]!].map(bits);
      expect(entries(v)).toEqual([0x40bb8000, 0x40bb8000, 0xbef00000, 0x403b8000]);
      expect(entries(inv)).toEqual([0x3e2ec33e, 0x3e2ec33e, 0x3da3d70a, 0xbf000000]);
      expect(entries(a)).toEqual([0x40b877b1, 0x3f53da2e, 0xbc39a3e4, 0x3f507c75]);
      expect(entries(d)).toEqual([0x3f7bdc14, 0x3e109fde, 0x3ee65134, 0x3ecd1ebc]);
      // The x translation: f32(f32(A·t) + A's translation), one unit above the exact value.
      expect(d[3]).toBe(f32(f32(a[0]! * inv[3]!) + a[3]!));
      expect(d[3]! - 0.449838272605).toBeGreaterThan(0);
    },
  );
});

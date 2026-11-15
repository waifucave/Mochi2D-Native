/**
 * Offscreens and blend shapes, on synthetic version-6 files:
 *
 * - the count-37 group is the offscreen target table: its bindings' keyforms
 *   are offscreen keyforms, after the normal ones, and change the offscreen's
 *   opacity and colors;
 * - the owner part's blend shapes never reach its offscreen (their offscreen
 *   keyform entries are not read): a part target changes the part's draw
 *   order only;
 * - offscreens are clamped to [0, 1] only as targets, once, after every delta
 *   and before the part opacities; NaN stays NaN;
 * - the final clamp of an art mesh's colors needs a parent deformer, in
 *   versions 4 to 6.
 *
 * Every case runs in every kernel mode, bit for bit (evaluateAll). The
 * validator and the loader check the new table like the other target tables.
 */
import { describe, expect, it } from "vitest";
import { loadMoc } from "../src/core/moc/model.js";
import { validateMoc } from "../src/core/moc/validate.js";
import { Synth, type OffscreenKeyform, type RGB } from "./support/synth.js";
import { evaluateAll } from "./support/evaluate.js";

const fr = Math.fround;
const gray = (x: number): RGB => [x, x, x];
const NO_COLORS = { multiply: gray(0), screen: gray(0) };

type Column = "plain" | "part" | "offscreen";

interface OffscreenCase {
  opacity: number;
  /** Multiply and screen, every channel. Default (1, 0). */
  colors?: [number, number];
  /** The blend shape's keyform at key 1: opacity and color deltas. */
  delta?: { opacity?: number; colors?: [number, number] };
  ownerOpacity?: number;
  /** Opacity of the owner's parent part, which owns no offscreen. */
  parentOpacity?: number;
}

/**
 * Root part T, owner part Q (child of T) with an offscreen and one mesh. The
 * blend-shape parameter BS has keys 0 and 1, base key 0. Columns:
 * - plain: no blend shape;
 * - part: Q is a part target, and its blend-shape keyforms' offscreen
 *   keyform entries point at offscreen keyforms that hold the deltas;
 * - offscreen: the offscreen is a target (count 37) with those deltas.
 */
function build(c: OffscreenCase, column: Column) {
  const s = new Synth(6);
  const T = s.part({ id: "T" });
  const Q = s.part({ id: "Q", parent: T });
  const BS = s.param("BS", 0, 1, 0, { type: 1 });
  const [m, sc] = c.colors ?? [1, 0];
  const o = s.offscreen({
    part: Q,
    keyforms: [{ opacity: c.opacity, multiply: gray(m), screen: gray(sc) }],
  });
  const M = s.mesh({ id: "M", part: Q, keyforms: [{ positions: [0, 0] }] });
  const [dm, ds] = c.delta?.colors ?? [0, 0];
  const deltaKeyform: OffscreenKeyform = {
    opacity: c.delta?.opacity ?? 0,
    multiply: gray(dm),
    screen: gray(ds),
  };
  if (column === "offscreen")
    s.blendShape("offscreen", o, {
      param: BS,
      keys: [0, 1],
      base: 0,
      keyforms: [{ opacity: 0, ...NO_COLORS }, deltaKeyform],
    });
  if (column === "part")
    s.blendShape("part", Q, {
      param: BS,
      keys: [0, 1],
      base: 0,
      keyforms: [{ drawOrder: 0 }, { drawOrder: 0 }],
    });
  s.groups = [
    { min: 0, max: 1000, objects: [{ kind: 1, index: Q, nested: 1 }] },
    { min: 0, max: 1000, objects: [{ kind: 0, index: M }] },
  ];
  const bytes = s.build({
    tamper:
      column === "part"
        ? (f) => {
            // Two more offscreen keyforms, zeros and the deltas, with their own
            // color entries, behind the part's blend-shape keyforms 2 and 3.
            const num = (k: keyof typeof f) => f[k] as number[];
            for (const k of [{ opacity: 0, ...NO_COLORS }, deltaKeyform]) {
              const e = num("multiplyColor.r").length;
              num("multiplyColor.r").push(k.multiply![0]);
              num("multiplyColor.g").push(k.multiply![1]);
              num("multiplyColor.b").push(k.multiply![2]);
              num("screenColor.r").push(k.screen![0]);
              num("screenColor.g").push(k.screen![1]);
              num("screenColor.b").push(k.screen![2]);
              num("offscreenKeyform.opacity").push(k.opacity);
              num("offscreenKeyform.multiplyColor").push(e);
              num("offscreenKeyform.screenColor").push(e);
            }
            const map = num("partKeyform.offscreenKeyform");
            expect(map).toEqual([-1, 0, -1, -1]);
            map[2] = 1;
            map[3] = 2;
          }
        : undefined,
  });
  return { model: loadMoc(bytes, { nonFiniteOpacity: "load" }), BS, T, Q, M, bytes };
}

/** The offscreen's opacity, multiply and screen (one channel each) at BS = bs. */
function at(c: OffscreenCase, column: Column, bs = 0) {
  const { model, BS, T, Q } = build(c, column);
  const out = evaluateAll(model, {
    parameters: { [BS]: bs },
    parts: { [Q]: c.ownerOpacity ?? 1, [T]: c.parentOpacity ?? 1 },
  });
  // Every channel alike.
  expect(new Set(out.offscreenMultiply).size).toBe(1);
  expect(new Set(out.offscreenScreen).size).toBe(1);
  return {
    opacity: out.offscreenOpacity[0]!,
    multiply: out.offscreenMultiply[0]!,
    screen: out.offscreenScreen[0]!,
    meshOpacity: out.opacity[0]!,
  };
}

describe("offscreen values by column", () => {
  // [case, BS, plain, part target, offscreen target]: opacities.
  const OPACITY: [string, OffscreenCase, number, number | null, number, number][] = [
    ["opacity 1.5, deltas 0", { opacity: 1.5 }, 0, 1.5, 1.5, 1],
    ["opacity −0.5, deltas 0", { opacity: -0.5 }, 0, -0.5, -0.5, 0],
    [
      "opacity 0.7, deltas 0",
      { opacity: 0.7 },
      0,
      0.699999988079071,
      0.699999988079071,
      0.699999988079071,
    ],
    ["opacity NaN", { opacity: NaN }, 0, NaN, NaN, NaN],
    ["opacity +∞", { opacity: Infinity }, 0, Infinity, Infinity, 1],
    ["opacity −∞", { opacity: -Infinity }, 0, -Infinity, -Infinity, 0],
    ["opacity 0.5, delta +0.8, BS 0", { opacity: 0.5, delta: { opacity: 0.8 } }, 0, null, 0.5, 0.5],
    [
      "opacity 0.5, delta +0.8, BS 0.5",
      { opacity: 0.5, delta: { opacity: 0.8 } },
      0.5,
      null,
      0.5,
      0.8999999761581421,
    ],
    ["opacity 0.5, delta +0.8, BS 1", { opacity: 0.5, delta: { opacity: 0.8 } }, 1, null, 0.5, 1],
    [
      "opacity 0.5, delta −0.8, BS 0",
      { opacity: 0.5, delta: { opacity: -0.8 } },
      0,
      null,
      0.5,
      0.5,
    ],
    [
      "opacity 0.5, delta −0.8, BS 0.5",
      { opacity: 0.5, delta: { opacity: -0.8 } },
      0.5,
      null,
      0.5,
      0.09999999403953552,
    ],
    ["opacity 0.5, delta −0.8, BS 1", { opacity: 0.5, delta: { opacity: -0.8 } }, 1, null, 0.5, 0],
    ["opacity 1.5, owner part 0.5", { opacity: 1.5, ownerOpacity: 0.5 }, 0, 0.75, 0.75, 0.5],
    ["opacity −0.5, owner part 0.5", { opacity: -0.5, ownerOpacity: 0.5 }, 0, -0.25, -0.25, 0],
    ["opacity 1.5, under a part of 0.5", { opacity: 1.5, parentOpacity: 0.5 }, 0, 0.75, 0.75, 0.5],
  ];

  it.each(OPACITY)("%s", (_, c, bs, plain, part, target) => {
    if (plain !== null) expect(at(c, "plain", bs).opacity).toBe(plain);
    expect(at(c, "part", bs).opacity).toBe(part);
    expect(at(c, "offscreen", bs).opacity).toBe(target);
  });

  // [case, BS, plain/part (multiply, screen), offscreen target (multiply, screen)].
  const COLORS: [string, OffscreenCase, number, [number, number] | null, [number, number]][] = [
    ["colors (1.5, −0.5), deltas 0", { opacity: 1, colors: [1.5, -0.5] }, 0, [1.5, -0.5], [1, 0]],
    ["colors (2, 1.25), deltas 0", { opacity: 1, colors: [2, 1.25] }, 0, [2, 1.25], [1, 1]],
    [
      "colors (0.5, 0.5), deltas (+0.8, −0.8), BS 0.5",
      { opacity: 1, colors: [0.5, 0.5], delta: { colors: [0.8, -0.8] } },
      0.5,
      null,
      [0.8999999761581421, 0.09999999403953552],
    ],
    [
      "colors (0.5, 0.5), deltas (+0.8, −0.8), BS 1",
      { opacity: 1, colors: [0.5, 0.5], delta: { colors: [0.8, -0.8] } },
      1,
      null,
      [1, 0],
    ],
    [
      "colors (0.5, 0.5), deltas (−0.8, +0.8), BS 0.5",
      { opacity: 1, colors: [0.5, 0.5], delta: { colors: [-0.8, 0.8] } },
      0.5,
      null,
      [0.09999999403953552, 0.8999999761581421],
    ],
    [
      "colors (0.5, 0.5), deltas (−0.8, +0.8), BS 1",
      { opacity: 1, colors: [0.5, 0.5], delta: { colors: [-0.8, 0.8] } },
      1,
      null,
      [0, 1],
    ],
  ];

  it.each(COLORS)("%s", (_, c, bs, raw, target) => {
    const untouched = raw ?? c.colors!;
    for (const column of ["plain", "part"] as const) {
      const r = at(c, column, bs);
      expect([r.multiply, r.screen], column).toEqual(untouched.map(fr));
    }
    const t = at(c, "offscreen", bs);
    expect([t.multiply, t.screen]).toEqual(target);
  });

  it("the mesh inside the owner part reports opacity 1: the owner's opacity stops above it", () => {
    for (const column of ["plain", "part", "offscreen"] as const)
      expect(at({ opacity: 1.5, ownerOpacity: 0.5 }, column).meshOpacity).toBe(1);
  });

  it("a part target's blend shapes change only its draw order (the control)", () => {
    // Parts X (400) and Y (600) each own an offscreen and one mesh; Z (500) is
    // a mesh between them. X's part blend shape adds +400 at key 1, and its
    // blend-shape keyforms point at offscreen keyforms with opacity deltas,
    // which must not count.
    const s = new Synth(6);
    s.part({ id: "Root" });
    const X = s.part({ id: "X", parent: 0, keyforms: [{ drawOrder: 400 }] });
    const Y = s.part({ id: "Y", parent: 0, keyforms: [{ drawOrder: 600 }] });
    const BS = s.param("BS", 0, 1, 0, { type: 1 });
    s.offscreen({ part: X, keyforms: [{ opacity: 0.5 }] });
    s.offscreen({ part: Y, keyforms: [{ opacity: 0.5 }] });
    const mx = s.mesh({ id: "mX", part: X, keyforms: [{ positions: [0, 0] }] });
    const my = s.mesh({ id: "mY", part: Y, keyforms: [{ positions: [0, 0] }] });
    const mz = s.mesh({ id: "mZ", keyforms: [{ positions: [0, 0], drawOrder: 500 }] });
    s.blendShape("part", X, {
      param: BS,
      keys: [0, 1],
      base: 0,
      keyforms: [{ drawOrder: 0 }, { drawOrder: 400 }],
    });
    s.groups = [
      {
        min: 0,
        max: 1000,
        objects: [
          { kind: 1, index: X, nested: 1 },
          { kind: 1, index: Y, nested: 2 },
          { kind: 0, index: mz },
        ],
      },
      { min: 0, max: 1000, objects: [{ kind: 0, index: mx }] },
      { min: 0, max: 1000, objects: [{ kind: 0, index: my }] },
    ];
    const model = loadMoc(
      s.build({
        tamper: (f) => {
          const op = f["offscreenKeyform.opacity"] as number[];
          const colors = f["offscreenKeyform.multiplyColor"] as number[];
          op.push(0, 0.4);
          colors.push(colors[0]!, colors[0]!);
          (f["offscreenKeyform.screenColor"] as number[]).push(colors[0]!, colors[0]!);
          const map = f["partKeyform.offscreenKeyform"] as number[];
          expect(map).toEqual([-1, 0, 1, -1, -1]);
          map[3] = 2;
          map[4] = 3;
        },
      }),
    );
    // [BS, X's draw order, render positions of X's offscreen and mesh, Y's, Z's].
    for (const [bs, order, x, y, z] of [
      [0, 400, [0, 1], [3, 4], 2],
      [0.5, 600, [1, 2], [3, 4], 0], // 600 = 600: file order
      [1, 800, [3, 4], [1, 2], 0],
    ] as const) {
      const out = evaluateAll(model, { parameters: { [BS]: bs } });
      expect(out.partDrawOrder[X], `BS ${bs}`).toBe(order);
      expect([out.offscreenRenderOrder[0], out.renderOrder[mx]]).toEqual(x);
      expect([out.offscreenRenderOrder[1], out.renderOrder[my]]).toEqual(y);
      expect(out.renderOrder[mz]).toBe(z);
      expect(out.offscreenOpacity).toEqual([0.5, 0.5]);
    }
  });
});

describe("art meshes in version-6 files clamp as in version 5", () => {
  /** One mesh without a deformer; `target` adds a blend shape with these deltas. */
  const mesh = (
    opacity: number,
    colors: [number, number],
    target: { opacity: number; colors: [number, number] } | null,
  ) => {
    const s = new Synth(6);
    s.part({ id: "Root" });
    const BS = s.param("BS", 0, 1, 0, { type: 1 });
    const m = s.mesh({
      id: "M",
      keyforms: [
        { positions: [0, 0], opacity, multiply: gray(colors[0]), screen: gray(colors[1]) },
      ],
    });
    if (target)
      s.blendShape("mesh", m, {
        param: BS,
        keys: [0, 1],
        base: 0,
        keyforms: [
          { opacity: 0, positions: [0, 0], ...NO_COLORS },
          {
            opacity: target.opacity,
            positions: [0, 0],
            multiply: gray(target.colors[0]),
            screen: gray(target.colors[1]),
          },
        ],
      });
    return { model: loadMoc(s.build()), BS };
  };
  const read = (r: ReturnType<typeof mesh>, bs = 0) => {
    const out = evaluateAll(r.model, { parameters: { [r.BS]: bs } });
    return [out.opacity[0], out.multiply[0], out.screen[0]];
  };

  it("a target's opacity and colors are clamped, a non-target's are not", () => {
    const zero = { opacity: 0, colors: [0, 0] as [number, number] };
    expect(read(mesh(1.5, [1.5, -0.5], zero))).toEqual([1, 1, 0]);
    expect(read(mesh(1.5, [1.5, -0.5], null))).toEqual([1.5, 1.5, -0.5]);
    expect(read(mesh(0.5, [1, 0], { opacity: 0.8, colors: [0, 0] }), 1)).toEqual([1, 1, 0]);
  });
});

describe("the final color clamp needs a parent deformer", () => {
  /** A mesh with colors (m, s), under a warp or rotation with colors (pm, ps), or none. */
  const run = (
    version: 4 | 5 | 6,
    colors: [number, number],
    parent: { kind: "warp" | "rotation"; colors: [number, number] } | null,
  ) => {
    const s = new Synth(version);
    s.part({ id: "Root" });
    let d = -1;
    if (parent?.kind === "warp")
      d = s.warp({
        id: "W",
        rows: 1,
        cols: 1,
        keyforms: [
          {
            points: [0, 0, 1, 0, 0, 1, 1, 1],
            multiply: gray(parent.colors[0]),
            screen: gray(parent.colors[1]),
          },
        ],
      });
    else if (parent)
      d = s.rotation({
        id: "R",
        keyforms: [
          {
            angle: 0,
            x: 0,
            y: 0,
            scale: 1,
            multiply: gray(parent.colors[0]),
            screen: gray(parent.colors[1]),
          },
        ],
      });
    s.mesh({
      id: "M",
      ...(d >= 0 ? { deformer: d } : {}),
      keyforms: [{ positions: [0.5, 0.5], multiply: gray(colors[0]), screen: gray(colors[1]) }],
    });
    const out = evaluateAll(loadMoc(s.build()));
    return [out.multiply[0], out.screen[0]];
  };

  it.each([4, 5, 6] as const)("version %i: no parent deformer, the colors as interpolated", (v) => {
    expect(run(v, [1.5, -0.5], null)).toEqual([1.5, -0.5]);
    expect(run(v, [2, 1.25], null)).toEqual([2, 1.25]);
  });

  it.each([4, 5] as const)("version %i: combined with a parent deformer, clamped", (v) => {
    expect(run(v, [1, 0], { kind: "warp", colors: [2, -0.5] })).toEqual([1, 0]);
    expect(run(v, [0.5, 0], { kind: "warp", colors: [3, -0.5] })).toEqual([1, 0]);
    expect(run(v, [1.5, -0.5], { kind: "warp", colors: [1, 0] })).toEqual([1, 0]);
    expect(run(v, [1.5, -0.5], { kind: "rotation", colors: [1, 0] })).toEqual([1, 0]);
  });
});

describe("the offscreen target table in the validator and the loader", () => {
  /** A valid file with one offscreen target, and the same file with one value changed. */
  type Tamper = NonNullable<NonNullable<Parameters<Synth["build"]>[0]>["tamper"]>;
  const file = (tamper?: Tamper) => {
    const s = new Synth(6);
    const T = s.part({ id: "T" });
    const Q = s.part({ id: "Q", parent: T });
    const BS = s.param("BS", 0, 1, 0, { type: 1 });
    const o = s.offscreen({ part: Q, keyforms: [{ opacity: 0.5 }] });
    const M = s.mesh({ id: "M", part: Q, keyforms: [{ positions: [0, 0] }] });
    s.blendShape("offscreen", o, {
      param: BS,
      keys: [0, 1],
      base: 0,
      keyforms: [
        { opacity: 0, ...NO_COLORS },
        { opacity: 0.8, ...NO_COLORS },
      ],
    });
    s.groups = [
      { min: 0, max: 1000, objects: [{ kind: 1, index: Q, nested: 1 }] },
      { min: 0, max: 1000, objects: [{ kind: 0, index: M }] },
    ];
    return s.build(tamper ? { tamper } : {});
  };
  const loads = (bytes: Uint8Array) => {
    try {
      loadMoc(bytes);
      return true;
    } catch {
      return false;
    }
  };
  const errors = (bytes: Uint8Array, level: "official" | "strict") =>
    validateMoc(bytes, { level })
      .diagnostics.filter((d) => d.severity === "error")
      .map((d) => `${d.code} ${d.kind}${d.field ? `.${d.field}` : ""}`);

  it("reads the table into MocData and the model", () => {
    const bytes = file();
    expect(errors(bytes, "official")).toEqual([]);
    expect(errors(bytes, "strict")).toEqual([]);
    const model = loadMoc(bytes);
    expect(model.blendShapes.offscreen).toHaveLength(1);
    const [b] = model.blendShapes.offscreen[0]!;
    expect([b!.firstKeyform, Array.from(b!.keys), b!.baseKey]).toEqual([1, [0, 1], 0]);
    expect(model.blendShapes.part.flat()).toEqual([]);
  });

  it.each([
    [
      "an offscreen index out of range",
      "offscreenTarget.offscreen",
      1,
      "offscreenBlendShapeTargets.object",
    ],
    [
      "a binding run out of range",
      "offscreenTarget.firstBinding",
      5,
      "offscreenBlendShapeTargets.firstBinding",
    ],
    [
      "keyforms beyond the offscreen keyforms",
      "bsKeyformBinding.firstKeyform",
      2,
      "blendShapeKeyformBindings.firstKeyform",
    ],
  ] as const)("rejects %s (strict and the loader)", (_, key, value, where) => {
    const bytes = file((f) => {
      (f[key] as number[])[0] = value;
    });
    expect(
      errors(bytes, "strict").some((e) => e.endsWith(where)),
      where,
    ).toBe(true);
    expect(loads(bytes)).toBe(false);
  });

  it("rejects a binding with fewer keyforms than keys", () => {
    const bytes = file((f) => {
      (f["bsKeyformBinding.keyformCount"] as number[])[0] = 1;
    });
    expect(errors(bytes, "strict")).toContain(
      "keyform-count blendShapeKeyformBindings.keyformCount",
    );
    expect(loads(bytes)).toBe(false);
  });

  it("no longer requires offscreen keyforms behind a part target's blend-shape keyforms", () => {
    const s = new Synth(6);
    const T = s.part({ id: "T" });
    const Q = s.part({ id: "Q", parent: T });
    const BS = s.param("BS", 0, 1, 0, { type: 1 });
    s.offscreen({ part: Q, keyforms: [{ opacity: 0.5 }] });
    const M = s.mesh({ id: "M", part: Q, keyforms: [{ positions: [0, 0] }] });
    s.blendShape("part", Q, {
      param: BS,
      keys: [0, 1],
      base: 0,
      keyforms: [{ drawOrder: 0 }, { drawOrder: 10 }],
    });
    s.groups = [
      { min: 0, max: 1000, objects: [{ kind: 1, index: Q, nested: 1 }] },
      { min: 0, max: 1000, objects: [{ kind: 0, index: M }] },
    ];
    const bytes = s.build(); // the blend-shape keyforms' entries are −1
    expect(errors(bytes, "strict")).toEqual([]);
    expect(loads(bytes)).toBe(true);
  });
});

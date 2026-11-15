/**
 * A part keyform's offscreen keyform index (slot 160), in the validator, the
 * loader and the evaluator, on a synthetic version-6 scene:
 *
 * - every part keyform's entry, normal or blend-shape, of any part, is −1 or
 *   an offscreen keyform (both validator levels; the loader by default);
 * - blend-shape keyforms' entries are never read;
 * - a normal keyform's −1 gives the offscreen opacity and colors 0;
 * - `offscreenKeyformRange: "load"` loads files with an entry out of range,
 *   reading it as −1.
 *
 * The scene: a normal parameter N and a blend-shape parameter BS (keys 0, 1,
 * base 0); parts Root, X (owns an offscreen, opacity 0.6, and is a part
 * target: +300 to its draw order at BS = 1), Y (owns an offscreen, opacity
 * 0.8) and Z (a part target without an offscreen: +100), one mesh in each.
 * Part keyforms 0–3 are the normal ones of Root, X, Y and Z, 4–5 X's
 * blend-shape keyforms, 6–7 Z's. The baseline's entries are −1, 0, 1, −1,
 * 2, 3, −1, −1, with offscreen keyforms 2 and 3 (zero, and +0.25 opacity)
 * behind X's blend-shape keyforms.
 */
import { describe, expect, it } from "vitest";
import { loadMoc } from "../src/core/moc/model.js";
import { validateMoc } from "../src/core/moc/validate.js";
import { Synth, type OffscreenKeyform } from "./support/synth.js";
import { evaluateAll, same } from "./support/evaluate.js";

type Fields = Record<string, unknown>;
type Edit = (map: number[], f: Fields) => void;

/** Pushes an offscreen keyform with its own color entry. */
function pushOffscreenKeyform(f: Fields, k: OffscreenKeyform): void {
  const num = (key: string) => f[key] as number[];
  const e = num("multiplyColor.r").length;
  for (const [ch, i] of [
    ["r", 0],
    ["g", 1],
    ["b", 2],
  ] as const) {
    num(`multiplyColor.${ch}`).push(k.multiply?.[i] ?? 1);
    num(`screenColor.${ch}`).push(k.screen?.[i] ?? 0);
  }
  num("offscreenKeyform.opacity").push(k.opacity);
  num("offscreenKeyform.multiplyColor").push(e);
  num("offscreenKeyform.screenColor").push(e);
}

const ZERO: OffscreenKeyform = { opacity: 0, multiply: [0, 0, 0], screen: [0, 0, 0] };
const PLUS: OffscreenKeyform = { opacity: 0.25, multiply: [0, 0, 0], screen: [0, 0, 0] };

/**
 * The scene, with offscreen keyforms 2 and 3 behind X's blend-shape keyforms
 * unless `drop`, and then `edit` applied to the entries (slot 160).
 */
function scene(edit: Edit = () => {}, drop = false): { bytes: Uint8Array; BS: number } {
  const s = new Synth(6);
  const Root = s.part({ id: "Root" });
  const X = s.part({ id: "X", parent: Root });
  const Y = s.part({ id: "Y", parent: Root });
  const Z = s.part({ id: "Z", parent: Root });
  s.param("N", 0, 1, 0);
  const BS = s.param("BS", 0, 1, 0, { type: 1 });
  s.offscreen({ part: X, keyforms: [{ opacity: 0.6 }] });
  s.offscreen({ part: Y, keyforms: [{ opacity: 0.8 }] });
  const tri = [{ positions: [0, 0, 1, 0, 0, 1] }];
  const mR = s.mesh({ id: "mR", part: Root, keyforms: tri });
  const mX = s.mesh({ id: "mX", part: X, keyforms: tri });
  const mY = s.mesh({ id: "mY", part: Y, keyforms: tri });
  const mZ = s.mesh({ id: "mZ", part: Z, keyforms: tri });
  s.blendShape("part", X, {
    param: BS,
    keys: [0, 1],
    base: 0,
    keyforms: [{ drawOrder: 0 }, { drawOrder: 300 }],
  });
  s.blendShape("part", Z, {
    param: BS,
    keys: [0, 1],
    base: 0,
    keyforms: [{ drawOrder: 0 }, { drawOrder: 100 }],
  });
  s.groups = [
    {
      min: 0,
      max: 1000,
      objects: [
        { kind: 0, index: mR },
        { kind: 1, index: X, nested: 1 },
        { kind: 1, index: Y, nested: 2 },
        { kind: 1, index: Z, nested: 3 },
      ],
    },
    { min: 0, max: 1000, objects: [{ kind: 0, index: mX }] },
    { min: 0, max: 1000, objects: [{ kind: 0, index: mY }] },
    { min: 0, max: 1000, objects: [{ kind: 0, index: mZ }] },
  ];
  const bytes = s.build({
    tamper: (f) => {
      const map = f["partKeyform.offscreenKeyform"] as number[];
      expect(map).toEqual([-1, 0, 1, -1, -1, -1, -1, -1]);
      if (!drop) {
        pushOffscreenKeyform(f, ZERO);
        pushOffscreenKeyform(f, PLUS);
        map[4] = 2;
        map[5] = 3;
      }
      edit(map, f);
    },
  });
  return { bytes, BS };
}

const verdict = (bytes: Uint8Array, level: "official" | "strict") =>
  validateMoc(bytes, { level }).valid ? "accept" : "reject";

const loads = (bytes: Uint8Array) => {
  try {
    loadMoc(bytes);
    return true;
  } catch {
    return false;
  }
};

/** The outputs that the variants compare, at BS = 0 and 1, in every kernel mode. */
function outputs(bytes: Uint8Array, BS: number) {
  const model = loadMoc(bytes, { offscreenKeyformRange: "load" });
  return [0, 1].map((bs) => {
    const o = evaluateAll(model, { parameters: { [BS]: bs } });
    return {
      offscreenOpacity: o.offscreenOpacity,
      offscreenMultiply: o.offscreenMultiply,
      offscreenScreen: o.offscreenScreen,
      renderOrder: o.renderOrder,
      offscreenRenderOrder: o.offscreenRenderOrder,
      opacity: o.opacity,
    };
  });
}

interface Case {
  name: string;
  edit: Edit;
  drop?: boolean;
  check: "accept" | "reject";
}

/** The variants whose outputs equal the baseline's. */
const SAME: Case[] = [
  {
    name: "baseline: X's blend-shape keyforms → their own offscreen keyforms 2, 3",
    edit: () => {},
    check: "accept",
  },
  {
    name: "X's blend-shape keyforms → −1, −1 (2, 3 unreferenced)",
    edit: (m) => ((m[4] = -1), (m[5] = -1)),
    check: "accept",
  },
  { name: "the same, with keyforms 2, 3 removed", edit: () => {}, drop: true, check: "accept" },
  { name: "only the base-key keyform → −1", edit: (m) => (m[4] = -1), check: "accept" },
  { name: "only the non-base keyform → −1", edit: (m) => (m[5] = -1), check: "accept" },
  {
    name: "both → 0 (X's normal offscreen keyform)",
    edit: (m) => ((m[4] = 0), (m[5] = 0)),
    check: "accept",
  },
  {
    name: "both → 1 (Y's offscreen keyform)",
    edit: (m) => ((m[4] = 1), (m[5] = 1)),
    check: "accept",
  },
  {
    name: "both → 0, keyforms 2, 3 removed",
    edit: (m) => ((m[4] = 0), (m[5] = 0)),
    drop: true,
    check: "accept",
  },
  { name: "both → 4 (the count)", edit: (m) => ((m[4] = 4), (m[5] = 4)), check: "reject" },
  {
    name: "both → 2 with keyforms 2, 3 removed (the new count)",
    edit: (m) => ((m[4] = 2), (m[5] = 2)),
    drop: true,
    check: "reject",
  },
  { name: "both → 1,000,000", edit: (m) => ((m[4] = 1e6), (m[5] = 1e6)), check: "reject" },
  { name: "both → −2", edit: (m) => ((m[4] = -2), (m[5] = -2)), check: "reject" },
  { name: "only the non-base keyform → 4", edit: (m) => (m[5] = 4), check: "reject" },
  {
    name: "control: Z's (no offscreen) normal keyform → 0",
    edit: (m) => (m[3] = 0),
    check: "accept",
  },
  {
    name: "control: Z's blend-shape keyforms → 0, 0",
    edit: (m) => ((m[6] = 0), (m[7] = 0)),
    check: "accept",
  },
  {
    name: "control: Z's blend-shape keyforms → 4",
    edit: (m) => ((m[6] = 4), (m[7] = 4)),
    check: "reject",
  },
];

/** The controls on X's normal keyform, with X's offscreen opacity, multiply and screen. */
const CONTROLS: (Case & { x: [number, number, number] })[] = [
  {
    name: "control: X's normal keyform → −1",
    edit: (m) => (m[1] = -1),
    check: "accept",
    x: [0, 0, 0],
  },
  // The format leaves this entry's meaning open; Mochi2D loads it (when asked) as −1.
  {
    name: "control: X's normal keyform → 4",
    edit: (m) => (m[1] = 4),
    check: "reject",
    x: [0, 0, 0],
  },
  {
    name: "control: X's normal keyform → 1 (Y's keyform)",
    edit: (m) => (m[1] = 1),
    check: "accept",
    x: [Math.fround(0.8), 1, 0],
  },
  {
    name: "control: X's normal keyform → 2 (a zero offscreen keyform)",
    edit: (m) => (m[1] = 2),
    check: "accept",
    x: [0, 0, 0],
  },
];

describe("a part keyform's offscreen keyform index", () => {
  const base = scene();
  const baseline = outputs(base.bytes, base.BS);

  it("the baseline: offscreens 0.6 and 0.8, X's draw order moving with BS", () => {
    expect(baseline[0]!.offscreenOpacity).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(baseline[1]!.offscreenOpacity).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(baseline[0]!.offscreenRenderOrder).not.toEqual(baseline[1]!.offscreenRenderOrder);
  });

  it.each(SAME)("$name: $check, outputs as the baseline's", (c) => {
    const { bytes, BS } = scene(c.edit, c.drop);
    expect(verdict(bytes, "official")).toBe(c.check);
    expect(verdict(bytes, "strict")).toBe(c.check);
    expect(loads(bytes)).toBe(c.check === "accept");
    expect(same(outputs(bytes, BS), baseline)).toBe(true);
  });

  it.each(CONTROLS)("$name: $check", (c) => {
    const { bytes, BS } = scene(c.edit);
    expect(verdict(bytes, "official")).toBe(c.check);
    expect(verdict(bytes, "strict")).toBe(c.check);
    expect(loads(bytes)).toBe(c.check === "accept");
    const out = outputs(bytes, BS);
    for (const pose of out) {
      expect([
        pose.offscreenOpacity[0],
        pose.offscreenMultiply[0],
        pose.offscreenScreen[0],
      ]).toEqual(c.x);
      // Y's offscreen, and everything that does not depend on X's offscreen, as in the baseline.
      expect(pose.offscreenOpacity[1]).toBe(Math.fround(0.8));
    }
    expect(out.map((p) => p.renderOrder)).toEqual(baseline.map((p) => p.renderOrder));
  });

  it("the lenient load says what it read as −1", () => {
    const { bytes } = scene((m) => (m[1] = 4));
    expect(() => loadMoc(bytes)).toThrow(/part keyform 1 offscreen keyform/);
    const model = loadMoc(bytes, { offscreenKeyformRange: "load" });
    expect(model.loadWarnings).toEqual([
      "part keyform 1: offscreen keyform 4 is not −1 or an offscreen keyform; read as −1",
    ]);
  });

  it("names the entry in the validator's diagnostics, at the official level", () => {
    const { bytes } = scene((m) => (m[5] = -2));
    const d = validateMoc(bytes, { level: "official" }).diagnostics.filter(
      (x) => x.severity === "error",
    );
    expect(d.map((x) => [x.code, x.kind, x.index, x.field])).toEqual([
      ["index-out-of-range", "partKeyforms", 5, "offscreenKeyform"],
    ]);
  });
});

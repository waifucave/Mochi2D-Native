/**
 * Two models compared by ID (the viewer's Edit › Compare): canvas, version,
 * parts, parameters and art meshes, on synthetic models that differ in one
 * property at a time.
 */
import { describe, expect, it } from "vitest";
import { loadMoc } from "../src/core/moc/model.js";
import { compareMocModels } from "../src/core/moc/compare.js";
import { Synth } from "./support/synth.js";

/** A small model; `edit` changes it before it is built. */
function build(edit: (s: Synth, ids: { p: number; m: number; k: number }) => void = () => {}) {
  const s = new Synth(5);
  s.param("A", -10, 10, 0);
  const p = s.param("B", 0, 1, 0);
  const root = s.part({ id: "Root" });
  const tri = [0, 0, 1, 0, 0, 1];
  const k = s.mesh({ id: "Mask", part: root, keyforms: [{ positions: tri, drawOrder: 400 }] });
  const m = s.mesh({
    id: "Face",
    part: root,
    masks: [k],
    keyforms: [{ positions: tri, drawOrder: 500 }],
  });
  edit(s, { p, m, k });
  return loadMoc(s.build());
}

describe("compareMocModels", () => {
  it("finds nothing between a model and itself", () => {
    expect(compareMocModels(build(), build())).toEqual([]);
  });

  it("reports each differing property by object ID", () => {
    const a = build();
    const b = build((s) => {
      s.canvas = { ...s.canvas, pixelsPerUnit: 2 };
      s.param("C", 0, 30, 15);
      s.part({ id: "Extra" });
    });
    expect(compareMocModels(a, b)).toEqual([
      { kind: "canvas", id: "", property: "pixelsPerUnit", a: 1, b: 2 },
      { kind: "part", id: "Extra", property: "presence", a: null, b: "present" },
      { kind: "parameter", id: "C", property: "presence", a: null, b: "present" },
    ]);
  });

  it("compares parameter ranges and defaults", () => {
    const a = build();
    const c = loadMoc(
      (() => {
        const s = new Synth(5);
        s.param("A", -30, 10, 2);
        s.param("B", 0, 1, 0);
        const root = s.part({ id: "Root" });
        const tri = [0, 0, 1, 0, 0, 1];
        const k = s.mesh({
          id: "Mask",
          part: root,
          keyforms: [{ positions: tri, drawOrder: 400 }],
        });
        s.mesh({
          id: "Face",
          part: root,
          masks: [k],
          keyforms: [{ positions: tri, drawOrder: 500 }],
        });
        return s.build();
      })(),
    );
    expect(compareMocModels(a, c)).toEqual([
      { kind: "parameter", id: "A", property: "minimum", a: -10, b: -30 },
      { kind: "parameter", id: "A", property: "default", a: 0, b: 2 },
    ]);
  });

  it("compares art meshes: blend mode, culling, texture, draw order, masks, counts", () => {
    const a = build();
    const variant = (o: {
      flags?: number;
      texture?: number;
      blendMode?: number;
      drawOrder?: number;
      masks?: boolean;
      quad?: boolean;
    }) => {
      const s = new Synth(5);
      s.param("A", -10, 10, 0);
      s.param("B", 0, 1, 0);
      const root = s.part({ id: "Root" });
      const tri = [0, 0, 1, 0, 0, 1];
      const quad = [0, 0, 1, 0, 0, 1, 1, 1];
      const k = s.mesh({ id: "Mask", part: root, keyforms: [{ positions: tri, drawOrder: 400 }] });
      s.mesh({
        id: "Face",
        part: root,
        ...(o.masks === false ? {} : { masks: [k] }),
        ...(o.flags !== undefined ? { flags: o.flags } : {}),
        ...(o.texture !== undefined ? { texture: o.texture } : {}),
        ...(o.blendMode !== undefined ? { blendMode: o.blendMode } : {}),
        ...(o.quad ? { triangles: [0, 1, 2, 1, 3, 2] } : {}),
        keyforms: [{ positions: o.quad ? quad : tri, drawOrder: o.drawOrder ?? 500 }],
      });
      return loadMoc(s.build());
    };
    const props = (b: ReturnType<typeof variant>) =>
      compareMocModels(a, b).map((d) => [d.id, d.property, d.a, d.b]);
    expect(props(variant({ flags: 0 }))).toEqual([["Face", "culling", "off", "on"]]);
    expect(props(variant({ texture: 1 }))).toEqual([["Face", "texture", 0, 1]]);
    expect(props(variant({ drawOrder: 600 }))).toEqual([["Face", "draw order", 500, 600]]);
    expect(props(variant({ masks: false }))).toEqual([["Face", "masks", "Mask", ""]]);
    expect(props(variant({ quad: true }))).toEqual([
      ["Face", "vertices", 3, 4],
      ["Face", "triangles", 1, 2],
    ]);
  });
});

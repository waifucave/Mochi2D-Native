/**
 * Crafted variants of DeepSeek-chan, rebuilt in memory at test time (no
 * modified copy of DeepSeek-chan's model is stored): version relabels, the canvas
 * flag, a big-endian copy and a v6 conversion with three offscreens, the
 * latter checked against reference values.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadMoc, type MocModel } from "../src/core/moc/model.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import { applyRequest, formatResultJson, snapshotInstance } from "../src/core/model/snapshot.js";
import { DEEPSEEK_MOC, craftDeepseek, deepseekSections } from "./support/crafted.js";

const root = resolve(__dirname, "..");
const scenarioDir = join(root, "test", "scenarios", "deepseek");
const scenarios = readdirSync(scenarioDir).map(
  (f) =>
    JSON.parse(readFileSync(join(scenarioDir, f), "utf8")) as {
      id: string;
      parameters?: Record<string, number>;
      partOpacities?: Record<string, number>;
    },
);

const evaluate = (model: MocModel, parameters: Record<string, number> = {}, partOpacities = {}) => {
  const inst = new ModelInstance(model);
  applyRequest(inst, { parameters, partOpacities });
  inst.evaluate();
  return inst;
};

describe("crafted variants of DeepSeek-chan", () => {
  const original = loadMoc(readFileSync(DEEPSEEK_MOC));

  it.each([1, 2, 3, 4])(
    "version byte relabelled to %i: loads and evaluates every scenario",
    (v) => {
      const bytes = new Uint8Array(readFileSync(DEEPSEEK_MOC));
      bytes[4] = v;
      const model = loadMoc(bytes);
      expect(model.version).toBe(v);
      if (v === 1) expect(Array.from(model.warps.bilinear).every((b) => b === 0)).toBe(true);
      if (v < 4) expect(Object.values(model.blendShapes).flat(2).length).toBe(0);
      for (const s of scenarios) {
        const inst = evaluate(model, s.parameters, s.partOpacities);
        expect(
          inst.drawableVisible.reduce((a, b) => a + b, 0),
          s.id,
        ).toBeGreaterThan(300);
      }
    },
  );

  it("C23: versions 1–3 report multiply (1, 1, 1) for every drawable, never-active ones included", () => {
    const never = ["ArtMesh436", "ArtMesh453", "ArtMesh454", "ArtMesh455"];
    for (const v of [1, 2, 3, 4, 5]) {
      const bytes = new Uint8Array(readFileSync(DEEPSEEK_MOC));
      bytes[4] = v;
      const model = loadMoc(bytes);
      const inst = new ModelInstance(model); // the creation evaluation
      const snap = snapshotInstance(inst);
      for (const id of never) {
        const d = snap.drawables.find((x) => x.id === id)!;
        expect(inst.drawableActive[model.meshes.ids.indexOf(id)], `v${v} ${id} active`).toBe(0);
        expect(d.multiplyColor, `v${v} ${id}`).toEqual(v < 4 ? [1, 1, 1, 1] : [0, 0, 0, 1]);
        expect(d.screenColor).toEqual([0, 0, 0, 1]);
        expect([d.opacity, d.drawOrder]).toEqual([0, 0]);
      }
      if (v < 4) {
        expect(snap.drawables.every((d) => d.multiplyColor.join() === "1,1,1,1")).toBe(true);
        expect(snap.drawables.every((d) => d.screenColor.join() === "0,0,0,1")).toBe(true);
      }
    }
  });

  it("canvas flag bit 0: outputs stay in model space (y not negated)", () => {
    const model = loadMoc(
      craftDeepseek((_, x) => {
        x.canvas.flags |= 1;
      }),
    );
    const a = evaluate(original, scenarios.find((s) => s.id === "ds-pose-a")!.parameters);
    const b = evaluate(model, scenarios.find((s) => s.id === "ds-pose-a")!.parameters);
    for (let d = 0; d < original.meshes.ids.length; d++) {
      if (!a.drawableVisible[d]) continue;
      const va = a.drawableVertices[d]!;
      const vb = b.drawableVertices[d]!;
      for (let k = 0; k < va.length; k += 2) {
        expect(vb[k]).toBe(va[k]);
        expect(vb[k + 1]).toBe(-va[k + 1]!);
      }
    }
  });

  it("big-endian copy evaluates identically", () => {
    const model = loadMoc(craftDeepseek(undefined, { bigEndian: true }));
    expect(model.bigEndian).toBe(true);
    for (const id of ["ds-pose-b", "ds-blendshapes"]) {
      const s = scenarios.find((x) => x.id === id)!;
      expect(formatResultJson(snapshotInstance(evaluate(model, s.parameters)))).toBe(
        formatResultJson(snapshotInstance(evaluate(original, s.parameters))),
      );
    }
  });

  describe("v6 conversion with three offscreens", () => {
    const sec = deepseekSections();
    const i32 = (k: string) => Array.from(sec.fields.get(k as never) as ArrayLike<number>);
    const partIds = sec.fields.get("part.id" as never) as string[];
    const meshIds = sec.fields.get("mesh.id" as never) as string[];
    const owners = ["Part114", "Part18", "Part30"].map((id) => partIds.indexOf(id));
    const v6 = loadMoc(
      craftDeepseek(
        (f, x) => {
          const partFirst = i32("part.firstKeyform");
          const partCount = i32("part.keyformCount");
          const partOffscreen = new Array<number>(partIds.length).fill(-1);
          owners.forEach((p, o) => (partOffscreen[p] = o));
          f["part.offscreen"] = partOffscreen;
          f["offscreen.part"] = owners;
          f["offscreen.flags"] = [4, 4, 4];
          f["offscreen.blendMode"] = [0x000, 0x106, 0x200];
          const m94 = meshIds.indexOf("ArtMesh94");
          f["offscreen.firstMask"] = [0, 0, i32("mesh.firstMask")[m94]!];
          f["offscreen.maskCount"] = [0, 0, i32("mesh.maskCount")[m94]!];
          const map = new Array<number>(i32("partKeyform.drawOrder").length).fill(-1);
          let next = 0;
          for (const p of owners)
            for (let k = 0; k < partCount[p]!; k++) map[partFirst[p]! + k] = next++;
          expect(next).toBe(7);
          f["partKeyform.offscreenKeyform"] = map;
          f["offscreenKeyform.opacity"] = [0.85, 0.5, 0.9, 0.7, 1, 0.6, 0.3];
          const colors = [6510, 6538, 6539, 6540, 7002, 7003, 7004];
          f["offscreenKeyform.multiplyColor"] = colors;
          f["offscreenKeyform.screenColor"] = colors;
          const flags = i32("mesh.flags");
          f["mesh.blendMode"] = flags.map((fl, m) =>
            m === m94 ? 0x10e : fl & 1 ? 1 : fl & 2 ? 2 : 0,
          );
          f["group.entryCount"] = [718, 44, 21, 21];
          x.counts[35] = 3;
          x.counts[36] = 7;
          x.counts[37] = 0;
        },
        { version: 6 },
      ),
    );

    it("loads with consistent group totals", () => {
      expect(v6.version).toBe(6);
      expect(Array.from(v6.offscreens.part)).toEqual(owners);
      expect(Array.from(v6.groups.entryCount)).toEqual([718, 44, 21, 21]);
    });

    const offscreensAt = (hip: number) => {
      const inst = evaluate(v6, { HipAngleX: hip });
      return owners.map((_, o) => ({
        opacity: inst.offscreenOpacity[o]!,
        multiply: Array.from(inst.offscreenMultiply.subarray(3 * o, 3 * o + 3)),
        screen: Array.from(inst.offscreenScreen.subarray(3 * o, 3 * o + 3)),
        renderOrder: inst.offscreenRenderOrder[o]!,
      }));
    };

    it("matches the reference offscreen values at HipAngleX −12", () => {
      const got = offscreensAt(-12);
      const want = [
        { opacity: 0.85, multiply: 0.2824, screen: [0, 0, 0], renderOrder: 116 },
        { opacity: 0.74, multiply: 0.1835, screen: [0.5741, 0.4188, 0.4118], renderOrder: 117 },
        { opacity: 0.76, multiply: 0.6, screen: [0.2008, 0.2086, 0.2651], renderOrder: 139 },
      ];
      want.forEach((w, o) => {
        const g = got[o]!;
        expect(g.opacity, `offscreen ${o} opacity`).toBeCloseTo(w.opacity, 4);
        for (const m of g.multiply) expect(m, `offscreen ${o} multiply`).toBeCloseTo(w.multiply, 4);
        g.screen.forEach((s, c) =>
          expect(s, `offscreen ${o} screen ${c}`).toBeCloseTo(w.screen[c]!, 4),
        );
        expect(g.renderOrder, `offscreen ${o} render order`).toBe(w.renderOrder);
      });
    });

    it("swaps the render orders of Part18 and Part30 at HipAngleX +30", () => {
      const got = offscreensAt(30);
      expect(got[1]!.renderOrder).toBe(139);
      expect(got[2]!.renderOrder).toBe(117);
    });
  });
});

describe("C12 and C25: keyform draw orders outside their group's range", () => {
  const sec = deepseekSections();
  const meshIds = sec.fields.get("mesh.id" as never) as string[];
  const partIds = sec.fields.get("part.id" as never) as string[];
  const m197 = meshIds.indexOf("ArtMesh197");
  const first = (sec.fields.get("mesh.firstKeyform" as never) as Int32Array)[m197]!;
  const original = loadMoc(readFileSync(DEEPSEEK_MOC));
  const withOrders = (orders: [number, number], range?: [number, number]) =>
    craftDeepseek((f) => {
      const o = f["meshKeyform.drawOrder"] as number[];
      o[first] = orders[0];
      o[first + 1] = orders[1];
      if (range) {
        (f["group.minDrawOrder"] as number[])[0] = range[0];
        (f["group.maxDrawOrder"] as number[])[0] = range[1];
      }
    });
  /** Drawable render orders after evaluating at one parameter value. */
  const renderOrders = (model: MocModel, parameter: string, value: number) => {
    const inst = new ModelInstance(model);
    inst.setParameter(inst.parameterIndex(parameter), value);
    inst.evaluate();
    return Array.from(inst.drawableRenderOrder);
  };
  const isPermutation = (orders: number[]) =>
    [...orders].sort((a, b) => a - b).every((x, i) => x === i);

  it("loads such a file by default, with a warning that names the object and its group's range", () => {
    expect((sec.fields.get("mesh.keyformCount" as never) as Int32Array)[m197]).toBe(2);
    const m = loadMoc(withOrders([300, 633]));
    expect(m.loadWarnings).toEqual([
      "art mesh ArtMesh197: keyform draw orders 300, 633 outside the range [500, 500] of draw-order group 0; drawn by the evaluated value",
    ]);
    // The keys stay as they are (no clamping).
    expect(Array.from(m.keyforms.meshDrawOrder.subarray(first, first + 2))).toEqual([300, 633]);
  });

  it("rejects it in the opt-in strict mode", () => {
    expect(() => loadMoc(withOrders([300, 633]), { drawOrderRange: "reject" })).toThrow(
      /ArtMesh197: keyform draw order 300 is outside the range \[500, 500\] of draw-order group 0/,
    );
  });

  it("accepts in-range keys without a warning (the q4c craft widens the range to [0, 1000])", () => {
    const m = loadMoc(withOrders([300, 700], [0, 1000]), { drawOrderRange: "reject" });
    expect(m.meshes.ids[m197]).toBe("ArtMesh197");
    expect(m.loadWarnings).toEqual([]);
  });

  describe("draw-order-part: Part18's keys 300, 500, 700 in group 1's range [499, 501]", () => {
    const p18 = partIds.indexOf("Part18");
    const pFirst = (sec.fields.get("part.firstKeyform" as never) as Int32Array)[p18]!;
    const keys = sec.fields.get("partKeyform.drawOrder" as never) as Float32Array;
    const craft = loadMoc(
      craftDeepseek((f) => {
        const o = f["partKeyform.drawOrder"] as number[];
        [300, 500, 700].forEach((v, k) => (o[pFirst + k] = v));
      }),
    );

    it("edits elements 92–94 of slot 58, whose keys are 499, 500 and 501", () => {
      expect(pFirst).toBe(92);
      expect(Array.from(keys.subarray(92, 95))).toEqual([499, 500, 501]);
      expect(craft.loadWarnings).toEqual([
        "part Part18: keyform draw orders 300, 700 outside the range [499, 501] of draw-order group 1; drawn by the evaluated value",
      ]);
    });

    it("keeps the reference order wherever it is valid", () => {
      // Part18's draw order 499 or 500: the default order.
      for (const hip of [-0.15, -0.145, -0.14, -0.1, 0, 0.1, 0.14])
        expect(renderOrders(craft, "HipAngleX", hip), `HipAngleX ${hip}`).toEqual(
          renderOrders(original, "HipAngleX", hip),
        );
      // 501 to 533: Part30's group is drawn before Part18's. The reference order
      // differs from the clamped keys' order (the unmodified file's) in 42 render orders.
      for (const hip of [0.16, 0.2, 0.29, 0.3, 0.31, 0.35, 0.4, 0.45, 0.5, 0.6, 0.75, 1, 2, 5]) {
        const a = renderOrders(craft, "HipAngleX", hip);
        const b = renderOrders(original, "HipAngleX", hip);
        expect(a.filter((x, i) => x !== b[i]).length, `HipAngleX ${hip}`).toBe(42);
      }
    });

    it("gives a valid order where the reference one breaks (below 499, and 566 and 700)", () => {
      for (const hip of [-30, -0.16, -0.155, -0.151, 10, 30])
        expect(isPermutation(renderOrders(craft, "HipAngleX", hip)), `HipAngleX ${hip}`).toBe(true);
      // Below the range Part18 sorts first, above it after Part30: as in the unmodified file at ±30.
      expect(renderOrders(craft, "HipAngleX", -30)).toEqual(
        renderOrders(original, "HipAngleX", -30),
      );
      expect(renderOrders(craft, "HipAngleX", 30)).toEqual(renderOrders(original, "HipAngleX", 30));
    });
  });

  describe("draw-order-mesh: ArtMesh197's keys 300 and 700 in group 0's range [500, 500]", () => {
    const craft = loadMoc(withOrders([300, 700]));

    it("edits elements 71 and 72 of slot 69 and loads with a warning", () => {
      expect(first).toBe(71);
      expect(craft.loadWarnings).toHaveLength(1);
      expect(craft.loadWarnings[0]).toMatch(
        /^art mesh ArtMesh197: keyform draw orders 300, 700 .*\[500, 500\]/,
      );
    });

    it("matches the in-range result and stays valid out of range", () => {
      // ParamMouthOpenY 0.15: the evaluated draw order is 500, inside the range.
      expect(renderOrders(craft, "ParamMouthOpenY", 0.15)).toEqual(
        renderOrders(original, "ParamMouthOpenY", 0.15),
      );
      for (const v of [0, 0.05, 0.25, 0.29])
        expect(
          isPermutation(renderOrders(craft, "ParamMouthOpenY", v)),
          `ParamMouthOpenY ${v}`,
        ).toBe(true);
    });
  });
});

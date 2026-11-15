/**
 * validateMoc (src/core/moc/validate.ts; docs/moc-data.md): the official
 * level against the expected verdicts of the 61 validation crafts (P8 and
 * S6), the strict level against their required verdicts and against
 * Mochi2D's loader (also on thousands of single-value mutations), the
 * structure of its diagnostics, and writeMoc's refusal of files the official
 * level rejects.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateMoc } from "../src/core/moc/validate.js";
import { MocWriteError, readMoc, writeMoc, writeMocUnchecked } from "../src/core/moc/io.js";
import { MOC_DATA_LAYOUT, type MocData, type MocDataGroup } from "../src/core/moc/data.js";
import { loadMoc } from "../src/core/moc/model.js";
import { Synth } from "./support/synth.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";
import { VALIDATION_CASES, craftValidation } from "../tools/lib/catalog/moc-crafts.js";
import { sampleModel } from "./support/sample-model.js";

const loads = (bytes: Uint8Array) => {
  try {
    loadMoc(bytes);
    return true;
  } catch {
    return false;
  }
};

const codes = (v: ReturnType<typeof validateMoc>, severity = "error") =>
  v.diagnostics.filter((d) => d.severity === severity).map((d) => d.code);

/** A seeded sequence in [0, 1). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/**
 * Mutates one value of `data` at a time and checks that the strict level
 * and the loader agree: an error from the structured checks exactly when
 * the loader rejects the file.
 */
function fuzz(data: MocData, version: 1 | 2 | 3 | 4 | 5, iterations: number, seed: number) {
  const rnd = lcg(seed);
  const targets: { group: MocDataGroup; field?: string }[] = [];
  for (const [g, layout] of Object.entries(MOC_DATA_LAYOUT)) {
    const present = (data as unknown as Record<string, unknown>)[g];
    if (present === undefined) continue;
    if ("pool" in layout) targets.push({ group: g as MocDataGroup });
    else
      for (const f of Object.keys(layout.fields))
        if ((present as Record<string, unknown>)[f] !== undefined && f !== "ids")
          targets.push({ group: g as MocDataGroup, field: f });
  }
  const mismatches: string[] = [];
  let tried = 0;
  for (let it = 0; it < iterations; it++) {
    const t = targets[Math.floor(rnd() * targets.length)]!;
    const group = (
      data as unknown as Record<string, Record<string, ArrayLike<number> & { [i: number]: number }>>
    )[t.group]!;
    const arr = (t.field ? group[t.field] : group) as unknown as
      Int32Array | Float32Array | Uint16Array | Uint8Array;
    if (arr.length === 0) continue;
    const i = Math.floor(rnd() * arr.length);
    const old = arr[i]!;
    const len = arr.length;
    const choices =
      arr instanceof Float32Array
        ? [NaN, -1, 0, 1e9, old + 1, 0.5]
        : arr instanceof Uint16Array
          ? [0, 1, 65535, old + 1]
          : arr instanceof Uint8Array
            ? [0, 1, 255]
            : [-2, -1, 0, 1, len, len + 1, 2147483647, old + 1, old - 1];
    arr[i] = choices[Math.floor(rnd() * choices.length)]!;
    if (!Object.is(arr[i], old)) {
      tried++;
      const bytes = writeMocUnchecked(data, { version });
      const structural = validateMoc(bytes).diagnostics.filter(
        (d) => d.severity === "error" && d.code !== "load-error",
      );
      if ((structural.length === 0) !== loads(bytes))
        mismatches.push(
          `${t.group}${t.field ? `.${t.field}` : ""}[${i}] ${old} → ${arr[i]}: loader ${loads(bytes) ? "accepts" : "rejects"}, validator ${structural.map((d) => d.code).join(",") || "accepts"}`,
        );
    }
    arr[i] = old;
  }
  return { tried, mismatches };
}

describe("validateMoc on the validation crafts (P8)", () => {
  it.skipIf(!HAVE_DEEPSEEK)(
    "gives the expected verdicts at the official level and the required ones at the strict level",
    () => {
      const rows: string[] = [];
      for (const c of VALIDATION_CASES) {
        const bytes = craftValidation(c.name);
        const official = validateMoc(bytes, { level: "official" });
        const strict = validateMoc(bytes, { level: "strict" });
        rows.push(
          `${c.name}: ${official.valid ? "accept" : "reject"}/${strict.valid ? "accept" : "reject"}/${loads(bytes) ? "accept" : "reject"}`,
        );
        // Strict and the loader agree on every case.
        expect(strict.valid, c.name).toBe(loads(bytes));
      }
      expect(rows).toEqual(
        VALIDATION_CASES.map((c) => `${c.name}: ${c.official}/${c.required}/${c.required}`),
      );
      // Some codes, by case.
      const first = (name: string, level: "official" | "strict" = "official") =>
        codes(validateMoc(craftValidation(name), { level }))[0];
      expect(first("magic")).toBe("magic");
      expect(first("endian")).toBe("endianness");
      expect(first("extra-3")).toBe("file-length");
      expect(first("count-positions")).toBe("slot-order");
      expect(first("warp-grid")).toBe("grid-points");
      expect(first("name-no-nul")).toBe("name-terminator");
      expect(first("texture-negative")).toBe("texture-negative");
      expect(first("part-parent-self", "strict")).toBe("parent-order");
      expect(first("keys-unsorted", "strict")).toBe("keys-unsorted");
      expect(first("keyform-count", "strict")).toBe("keyform-count");
      const mesh = validateMoc(craftValidation("mesh-parent"), { level: "official" })
        .diagnostics[0]!;
      expect(mesh).toMatchObject({
        code: "index-out-of-range",
        kind: "artMeshes",
        index: 0,
        field: "deformer",
      });
      // S6.
      expect(first("flag-value")).toBe("flag-value");
      expect(first("decimals-negative")).toBe("value-range");
      expect(first("mask-index-low")).toBe("index-out-of-range");
      expect(first("color-index-n", "strict")).toBe("index-out-of-range");
      expect(first("draw-order-part-cycle", "strict")).toBe("group-structure");
      expect(first("position-start-low", "strict")).toBe("range-out-of-bounds");
      // Art keyform 238 (of mesh 206) is tested with mesh 238's run.
      const run = validateMoc(craftValidation("position-run-index"), { level: "official" });
      expect(run.diagnostics).toMatchObject([
        { code: "position-run", kind: "artMeshKeyforms", index: 238, field: "firstPosition" },
      ]);
      // Accepted oddities are warnings at the strict level only.
      expect(codes(validateMoc(craftValidation("duplicate-ids")), "warning")).toContain(
        "duplicate-id",
      );
      expect(
        validateMoc(craftValidation("duplicate-ids"), { level: "official" }).diagnostics,
      ).toEqual([]);
    },
    240_000,
  );

  it.skipIf(!HAVE_DEEPSEEK)(
    "the position-run rule: appended zero floats make the moved keyform pass (145 fail, 146 pass)",
    () => {
      const data = readMoc(craftValidation("position-run-index")).data;
      // writeMoc refuses data that fails the official level.
      let refused: MocWriteError | null = null;
      try {
        writeMoc(data, { version: 5 });
      } catch (e) {
        refused = e as MocWriteError;
      }
      expect(refused).toBeInstanceOf(MocWriteError);
      expect(refused!.diagnostics.map((d) => d.code)).toEqual(["position-run"]);
      const padded = (zeros: number): MocData => {
        const p = new Float32Array(data.keyformPositions.length + zeros);
        p.set(data.keyformPositions);
        return { ...data, keyformPositions: p };
      };
      expect(validateMoc(padded(145), { version: 5, level: "official" }).valid).toBe(false);
      expect(validateMoc(padded(146), { version: 5, level: "official" }).valid).toBe(true);
      expect(validateMoc(padded(146), { version: 5 }).valid).toBe(true);
      expect(loads(writeMoc(padded(146), { version: 5 }))).toBe(true);
    },
  );

  it.skipIf(!HAVE_DEEPSEEK)("passes DeepSeek-chan at both levels without warnings", () => {
    const bytes = new Uint8Array(readFileSync(join(DEEPSEEK, "大肥鱼.moc3")));
    for (const level of ["official", "strict"] as const)
      expect(validateMoc(bytes, { level })).toEqual({ valid: true, version: 5, diagnostics: [] });
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "agrees with the loader on mutations of DeepSeek-chan",
    () => {
      const data = readMoc(new Uint8Array(readFileSync(join(DEEPSEEK, "大肥鱼.moc3")))).data;
      const r = fuzz(data, 5, 20, 3);
      expect(r.tried).toBeGreaterThan(10);
      expect(r.mismatches).toEqual([]);
    },
    240_000,
  );
});

describe("validateMoc on synthetic files", () => {
  it.each([1, 2, 3, 4, 5] as const)(
    "agrees with the loader on mutations of a version-%i file",
    (version) => {
      const data = readMoc(sampleModel(version)).data;
      expect(validateMoc(writeMoc(data, { version }))).toEqual({
        valid: true,
        version,
        diagnostics: [],
      });
      const r = fuzz(data, version, 500, 11 + version);
      expect(r.tried).toBeGreaterThan(250);
      expect(r.mismatches).toEqual([]);
    },
    120_000,
  );

  it("validates MocData given with its version, and checks its shape first", () => {
    const data = readMoc(sampleModel(4)).data;
    expect(validateMoc(data, { version: 4 })).toEqual({ valid: true, version: 4, diagnostics: [] });
    expect(validateMoc(data)).toMatchObject({ valid: false, diagnostics: [{ code: "version" }] });
    expect(codes(validateMoc(data, { version: 5 }))).toEqual(
      expect.arrayContaining(["missing-field"]),
    );
    const broken = structuredClone(data);
    broken.artMeshes.deformer[1] = 99;
    broken.parts.parent[1] = 1;
    const v = validateMoc(broken, { version: 4 });
    expect(v.valid).toBe(false);
    expect(v.diagnostics).toEqual([
      {
        code: "parent-order",
        severity: "error",
        kind: "parts",
        index: 1,
        field: "parent",
        message: "parts[1] (Child).parent = 1 must be -1 or an earlier part",
      },
      {
        code: "index-out-of-range",
        severity: "error",
        kind: "artMeshes",
        index: 1,
        field: "deformer",
        message: "artMeshes[1] (Mesh).deformer = 99 is out of range [-1, 2) of deformers",
      },
    ]);
    // Only the second is rejected at the official level.
    expect(
      validateMoc(broken, { version: 4, level: "official" }).diagnostics.map((d) => d.code),
    ).toEqual(["index-out-of-range"]);
  });

  it("rejects wrong group totals at the strict level only (C6)", () => {
    const data = readMoc(sampleModel(3)).data;
    data.drawOrderGroups.entryCount[0] = 1;
    const strict = validateMoc(data, { version: 3 });
    expect(strict.diagnostics).toEqual([
      expect.objectContaining({
        code: "group-total",
        kind: "drawOrderGroups",
        index: 0,
        field: "entryCount",
      }),
    ]);
    expect(validateMoc(data, { version: 3, level: "official" }).valid).toBe(true);
  });

  it("warns about what loads but is odd", () => {
    const data = readMoc(sampleModel(5)).data;
    // Draw orders outside the group's range (C12, C25), of mesh 1, which is not a
    // blend-shape target. Mesh 0 is one: its 5000 reads as 1000 (targets' draw orders are capped), in range.
    data.artMeshKeyforms.drawOrder[1] = 5000;
    data.artMeshKeyforms.drawOrder[0] = 5000;
    // A per-keyform color index the runtime ignores (C5).
    data.warpKeyforms.multiplyColor![1]! += 7;
    // A default outside [min, max], a duplicate ID, a zero ppu.
    data.parameters.defaultValue[0] = 99;
    data.parts.ids[1] = data.parts.ids[0]!;
    data.canvas.pixelsPerUnit = 0;
    const v = validateMoc(data, { version: 5 });
    expect(v.valid).toBe(true);
    expect(codes(v, "warning").sort()).toEqual(
      ["canvas", "color-index", "default-outside-range", "draw-order-range", "duplicate-id"].sort(),
    );
    expect(v.diagnostics.find((d) => d.code === "color-index")).toMatchObject({
      kind: "warpKeyforms",
      index: 1,
      field: "multiplyColor",
    });
    expect(v.diagnostics.filter((d) => d.code === "draw-order-range").map((d) => d.index)).toEqual([
      1,
    ]);
    expect(validateMoc(data, { version: 5, level: "official" }).diagnostics).toEqual([]);
    // And the file still loads.
    expect(loads(writeMoc(data, { version: 5 }))).toBe(true);
  });

  it("rejects big-endian files at both levels, though they load", () => {
    const s = new Synth(4);
    s.part({ id: "Root" });
    s.mesh({ id: "M", keyforms: [{ positions: [0, 0, 1, 0, 0, 1], drawOrder: 500 }] });
    const be = s.build({ bigEndian: true });
    expect(loads(be)).toBe(true);
    for (const level of ["official", "strict"] as const)
      expect(validateMoc(be, { level }).diagnostics.map((d) => d.code)).toEqual(["big-endian"]);
  });

  it("never throws on garbage", () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array(64), new Uint8Array(4096).fill(0xff)]) {
      const v = validateMoc(bytes);
      expect(v.valid).toBe(false);
      expect(v.diagnostics[0]!.kind).toBe("file");
    }
  });
});

describe("validation of keyform color indices, constraints, glue targets and opacities", () => {
  /** official / required (strict) / loader verdicts after setting one keyform color index. */
  function verdicts(
    data: MocData,
    kind: "warpKeyforms" | "rotationKeyforms" | "artMeshKeyforms",
    field: "multiplyColor" | "screenColor",
    k: number,
    value: number,
  ): [boolean, boolean, boolean] {
    const arr = data[kind][field]!;
    const old = arr[k]!;
    arr[k] = value;
    try {
      return [
        validateMoc(data, { version: 5, level: "official" }).valid,
        validateMoc(data, { version: 5 }).valid,
        loads(writeMocUnchecked(data, { version: 5 })),
      ];
    } finally {
      arr[k] = old;
    }
  }
  /** −1 reject, N − 1 accept, N accept / reject, N + 1 and 2³¹ − 1 reject. */
  const EXPECTED = (N: number): [number, [boolean, boolean, boolean]][] => [
    [-1, [false, false, false]],
    [N - 1, [true, true, true]],
    [N, [true, false, false]],
    [N + 1, [false, false, false]],
    [2147483647, [false, false, false]],
  ];

  it("rotation keyform color indices are checked like those of warps and art meshes", () => {
    const data = readMoc(sampleModel(5)).data;
    const N = data.multiplyColors!.r.length;
    // Every rotation keyform, normal and blend-shape ones alike.
    for (let k = 0; k < data.rotationKeyforms.angle.length; k++)
      for (const field of ["multiplyColor", "screenColor"] as const)
        for (const [value, expected] of EXPECTED(N))
          expect(
            verdicts(data, "rotationKeyforms", field, k, value),
            `${field}[${k}] = ${value}`,
          ).toEqual(expected);
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "the 120 verdicts on DeepSeek-chan's keyforms (slots 137–142)",
    () => {
      const data = readMoc(new Uint8Array(readFileSync(join(DEEPSEEK, "大肥鱼.moc3")))).data;
      const N = data.multiplyColors!.r.length;
      expect(N).toBe(10242);
      expect(data.rotationKeyforms.angle.length).toBe(535);
      const KEYFORMS: ["warpKeyforms" | "rotationKeyforms" | "artMeshKeyforms", number[]][] = [
        ["rotationKeyforms", [0, 228, 457, 534]],
        ["warpKeyforms", [0, 2921, 5842, 8859]],
        ["artMeshKeyforms", [0, 404, 808, 846]],
      ];
      let n = 0;
      for (const [kind, ks] of KEYFORMS)
        for (const k of ks)
          for (const field of ["multiplyColor", "screenColor"] as const)
            for (const [value, expected] of EXPECTED(N)) {
              const [official, strict] = verdicts(data, kind, field, k, value);
              expect([official, strict], `${kind}[${k}].${field} = ${value}`).toEqual(
                expected.slice(0, 2),
              );
              n++;
            }
      expect(n).toBe(120);
    },
    240_000,
  );

  it("constraints on type-1 parameters and glue blend-shape targets are accepted and load", () => {
    const s = new Synth(5);
    s.part({ id: "Root" });
    const bs1 = s.param("BS1", 0, 1, 0, { type: 1 });
    const bs2 = s.param("BS2", 0, 1, 0, { type: 1 });
    const tri = [0, 0, 1, 0, 0, 1];
    const a = s.mesh({ id: "A", keyforms: [{ positions: tri }] });
    const b = s.mesh({ id: "B", keyforms: [{ positions: tri }] });
    s.blendShape("mesh", a, {
      param: bs1,
      keys: [0, 1],
      base: 0,
      keyforms: [{ positions: tri }, { positions: tri }],
      constraints: [
        { param: bs2, keys: [0, 1], weights: [1, 0] },
        { param: bs1, keys: [0, 1], weights: [1, 0] },
      ],
    });
    const g = s.glue({ id: "G", a, b, pairs: [[0, 0.5, 0, 0.5]], intensities: [0.5] });
    s.blendShape("glue", g, { param: bs2, keys: [0, 1], base: 0, keyforms: [0, 0.3] });
    const bytes = s.build();
    for (const level of ["official", "strict"] as const)
      expect(validateMoc(bytes, { level })).toEqual({ valid: true, version: 5, diagnostics: [] });
    expect(loads(bytes)).toBe(true);
  });

  it("non-finite keyform opacities: accepted (official), rejected (required, and the loader)", () => {
    for (const bad of [NaN, Infinity, -Infinity])
      for (const kind of ["warp", "rotation", "mesh"] as const) {
        const s = new Synth(5);
        s.part({ id: "Root" });
        const tri = [0.2, 0.2, 0.8, 0.2, 0.2, 0.8];
        const op = (k: "warp" | "rotation" | "mesh") => (k === kind ? bad : 1);
        const w = s.warp({
          id: "W",
          rows: 1,
          cols: 1,
          keyforms: [{ opacity: op("warp"), points: [0, 0, 1, 0, 0, 1, 1, 1] }],
        });
        const r = s.rotation({
          id: "R",
          keyforms: [{ opacity: op("rotation"), angle: 0, x: 0, y: 0, scale: 1 }],
        });
        s.mesh({ id: "MW", deformer: w, keyforms: [{ opacity: op("mesh"), positions: tri }] });
        s.mesh({ id: "MR", deformer: r, keyforms: [{ positions: tri }] });
        const bytes = s.build();
        const what = `${kind} opacity ${bad}`;
        expect(validateMoc(bytes, { level: "official" }).diagnostics, what).toEqual([]);
        const strict = validateMoc(bytes);
        expect(strict.valid, what).toBe(false);
        expect(codes(strict), what).toEqual(["opacity-value"]);
        expect(loads(bytes), what).toBe(false);
        expect(() => loadMoc(bytes, { nonFiniteOpacity: "load" }), what).not.toThrow();
      }
  });
});

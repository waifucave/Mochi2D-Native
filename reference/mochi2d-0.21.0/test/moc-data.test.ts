/**
 * The public model data (src/core/moc/data.ts, io.ts; docs/moc-data.md):
 * the layout table, readMoc and writeMoc, their round trip in every
 * writable version (synthetic files), byte identity on DeepSeek-chan, and
 * every refusal.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MocWriteError,
  WRITABLE_VERSIONS,
  readMoc,
  writeMoc,
  type MocDiagnostic,
} from "../src/core/moc/io.js";
import { MOC_DATA_GROUPS, MOC_DATA_LAYOUT, type MocData } from "../src/core/moc/data.js";
import { FIELDS, Count } from "../src/core/moc/schema.js";
import { MocFormatError } from "../src/core/moc/read.js";
import { loadMoc } from "../src/core/moc/model.js";
import { writeMoc as writeRawMoc } from "../src/core/moc/write.js";
import { ModelInstance } from "../src/core/eval/instance.js";
import { snapshotInstance, formatResultJson } from "../src/core/model/snapshot.js";
import { Synth } from "./support/synth.js";
import { sampleModel } from "./support/sample-model.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

function evaluateBytes(bytes: Uint8Array, parameters: Record<string, number> = {}): string {
  const inst = new ModelInstance(loadMoc(bytes));
  for (const [id, v] of Object.entries(parameters)) inst.setParameter(inst.parameterIndex(id), v);
  inst.evaluate();
  return formatResultJson(snapshotInstance(inst));
}

function refusal(f: () => unknown): MocDiagnostic[] {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(MocWriteError);
    return (e as MocWriteError).diagnostics;
  }
  throw new Error("writeMoc did not refuse");
}

describe("the model-data layout", () => {
  it("maps every array of the schema exactly once, by count", () => {
    const mapped = new Map<string, string>();
    for (const g of MOC_DATA_GROUPS) {
      const l = MOC_DATA_LAYOUT[g];
      for (const key of "pool" in l ? [l.pool] : Object.values(l.fields)) {
        expect(mapped.has(key), key).toBe(false);
        mapped.set(key, g);
        expect(FIELDS.find((f) => f.key === key)!.count, key).toBe(l.count);
      }
    }
    const arrays = FIELDS.filter((f) => f.type !== "placeholder").map((f) => f.key);
    expect([...mapped.keys()].sort()).toEqual([...arrays].sort());
    // docs/moc-data.md lists every group and field.
    const doc = readFileSync(join(__dirname, "..", "docs", "moc-data.md"), "utf8");
    for (const g of MOC_DATA_GROUPS) {
      const row = doc
        .split("\n")
        .find((l) => l.startsWith("| ") && (l.split("|")[1] ?? "").includes(`\`${g}\``));
      expect(row, g).toBeDefined();
      const l = MOC_DATA_LAYOUT[g];
      if (!("pool" in l))
        for (const f of Object.keys(l.fields)) expect(row, `${g}.${f}`).toContain(`\`${f}\``);
    }
    // One group per count-table entry, in count order.
    expect(MOC_DATA_GROUPS.map((g) => MOC_DATA_LAYOUT[g].count)).toEqual(
      Array.from({ length: Count.OffscreenBlendShapeTargets + 1 }, (_, i) => i),
    );
  });
});

describe("readMoc and writeMoc", () => {
  it.each(WRITABLE_VERSIONS)("round-trip a synthetic version-%i file", (version) => {
    const original = sampleModel(version);
    const r = readMoc(original);
    expect(r.version).toBe(version);
    expect(r.diagnostics).toEqual([]);
    // Exactly the fields of the version.
    expect(r.data.parts.offscreen).toBeUndefined();
    expect(r.data.warpDeformers.bilinear === undefined).toBe(version < 2);
    expect(r.data.multiplyColors === undefined).toBe(version < 4);
    expect(r.data.warpKeyforms.multiplyColor === undefined).toBe(version < 5);
    const written = writeMoc(r.data, { version });
    const again = readMoc(written);
    expect(again.version).toBe(version);
    expect(again.data).toEqual(r.data);
    // Deterministic, and stable: writing the data read back gives the same bytes.
    expect(writeMoc(r.data, { version })).toEqual(written);
    expect(writeMoc(again.data, { version })).toEqual(written);
    expect(written.length % 64).toBe(0);
    // The written file evaluates exactly like the original.
    const poses: Record<string, number>[] = [
      {},
      { ParamAngle: 17, ParamOpen: 0.3 },
      { ParamAngle: -30, ParamBlend: 0.6 },
    ];
    for (const params of poses)
      expect(evaluateBytes(written, params)).toBe(evaluateBytes(original, params));
  });

  it("lays files out like genuine files: slot order, 64-byte sections, names after their placeholders", () => {
    const bytes = writeMoc(readMoc(sampleModel(5)).data, { version: 5 });
    const dv = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("MOC3");
    expect([bytes[4], bytes[5]]).toEqual([5, 0]);
    expect(bytes.subarray(6, 64).every((b) => b === 0)).toBe(true);
    const slot = (i: number) => dv.getUint32(64 + i * 4, true);
    expect(slot(0)).toBe(64 + 480 * 4); // count table right after the offset table
    expect(slot(1)).toBe(slot(0) + 256); // the canvas after the 64-entry count table
    // part.reserved (slot 2) on a boundary, part.id (slot 3) right after it (2 parts × 8 bytes).
    expect(slot(2) % 64).toBe(0);
    expect(slot(3)).toBe(slot(2) + 16);
    expect(slot(4) % 64).toBe(0);
    // Slots past the version's last are 0.
    for (let i = 152; i < 480; i++) expect(slot(i)).toBe(0);
  });

  it.skipIf(!HAVE_DEEPSEEK)("reproduce DeepSeek-chan's file byte for byte", () => {
    const original = new Uint8Array(readFileSync(join(DEEPSEEK, "大肥鱼.moc3")));
    const r = readMoc(original);
    expect([r.version, r.diagnostics]).toEqual([5, []]);
    expect(r.data.parts.ids).toHaveLength(147);
    expect(r.data.artMeshes.ids).toHaveLength(715);
    expect(r.data.keyformPositions).toHaveLength(3670832);
    expect(r.data.canvas).toEqual({
      pixelsPerUnit: 3749,
      originX: 1874.5,
      originY: 3848.5,
      width: 3749,
      height: 7697,
      flags: 0,
    });
    const written = writeMoc(r.data, { version: 5 });
    expect(written.length).toBe(original.length);
    expect(Buffer.from(written).equals(Buffer.from(original))).toBe(true);
    // The data is a copy: changing it leaves the original's bytes alone.
    r.data.keyformPositions[0] = 123;
    expect(readMoc(original).data.keyformPositions[0]).not.toBe(123);
  });

  it("refuse version 6, and versions that do not exist", () => {
    const data = readMoc(sampleModel(5)).data;
    expect(refusal(() => writeMoc(data, { version: 6 }))[0]).toMatchObject({
      code: "version-unsupported",
      kind: "file",
    });
    expect(refusal(() => writeMoc(data, { version: 7 as never }))[0]!.code).toBe(
      "version-unsupported",
    );
  });

  it("refuse data that a version cannot hold, naming every array", () => {
    const data = readMoc(sampleModel(5)).data;
    const diags = refusal(() => writeMoc(data, { version: 4 }));
    expect(diags.map((d) => `${d.code} ${d.kind}${d.field ? `.${d.field}` : ""}`).sort()).toEqual(
      [
        "field-not-in-version artMeshKeyforms.multiplyColor",
        "field-not-in-version artMeshKeyforms.screenColor",
        "field-not-in-version glueBlendShapeTargets",
        "field-not-in-version partBlendShapeTargets",
        "field-not-in-version rotationBlendShapeTargets",
        "field-not-in-version rotationKeyforms.multiplyColor",
        "field-not-in-version rotationKeyforms.screenColor",
        "field-not-in-version warpKeyforms.multiplyColor",
        "field-not-in-version warpKeyforms.screenColor",
      ].sort(),
    );
    // Without the version-5 arrays, it is a valid version-4 file.
    const v4: MocData = structuredClone(data);
    for (const k of ["warpKeyforms", "rotationKeyforms", "artMeshKeyforms"] as const) {
      delete v4[k].multiplyColor;
      delete v4[k].screenColor;
    }
    delete v4.partBlendShapeTargets;
    delete v4.rotationBlendShapeTargets;
    delete v4.glueBlendShapeTargets;
    // The rotation's blend shape needs version 5: its keyforms stay, as plain keyforms.
    const bytes = writeMoc(v4, { version: 4 });
    expect(readMoc(bytes).data).toEqual(v4);
    expect(() => loadMoc(bytes)).not.toThrow();
    // And arrays a version needs must be there.
    const v1 = structuredClone(v4) as Partial<MocData>;
    expect(refusal(() => writeMoc(v1 as MocData, { version: 5 })).map((d) => d.code)).toContain(
      "missing-field",
    );
  });

  it("refuse wrong types, lengths, IDs and canvas values", () => {
    const base = readMoc(sampleModel(3)).data;
    const codes = (change: (d: MocData) => void) => {
      const d = structuredClone(base);
      change(d);
      return refusal(() => writeMoc(d, { version: 3 })).map((x) => ({
        code: x.code,
        kind: x.kind,
        ...(x.field ? { field: x.field } : {}),
        ...(x.index !== undefined ? { index: x.index } : {}),
      }));
    };
    expect(codes((d) => ((d.parts as { parent: unknown }).parent = [-1, 0]))).toEqual([
      { code: "value-type", kind: "parts", field: "parent" },
    ]);
    expect(codes((d) => (d.parts.parent = Int32Array.of(-1)))).toEqual([
      { code: "length-mismatch", kind: "parts", field: "parent" },
    ]);
    expect(codes((d) => (d.artMeshes.ids[1] = "x".repeat(64)))).toEqual([
      { code: "name-too-long", kind: "artMeshes", field: "ids", index: 1 },
    ]);
    expect(codes((d) => (d.artMeshes.ids[0] = "a\0b"))).toEqual([
      { code: "name-nul", kind: "artMeshes", field: "ids", index: 0 },
    ]);
    expect(codes((d) => (d.canvas.width = 0.1))).toEqual([
      { code: "not-float32", kind: "canvas", field: "width" },
    ]);
    expect(codes((d) => (d.canvas.flags = 256))).toEqual([
      { code: "value-range", kind: "canvas", field: "flags" },
    ]);
    expect(
      codes((d) => ((d.parts as unknown as Record<string, unknown>).colour = Int32Array.of(0, 0))),
    ).toEqual([{ code: "unknown-field", kind: "parts", field: "colour" }]);
    expect(codes((d) => ((d as unknown as Record<string, unknown>).extras = {}))).toEqual([
      { code: "unknown-field", kind: "file" },
    ]);
    // A 63-byte ID in UTF-8 is fine; non-ASCII counts in bytes.
    const ok = structuredClone(base);
    ok.artMeshes.ids[0] = "测".repeat(21);
    expect(readMoc(writeMoc(ok, { version: 3 })).data.artMeshes.ids[0]).toBe("测".repeat(21));
    ok.artMeshes.ids[0] = "测".repeat(21) + "x";
    expect(refusal(() => writeMoc(ok, { version: 3 }))[0]!.code).toBe("name-too-long");
  });

  it("keep float32 bit patterns", () => {
    const d = readMoc(sampleModel(3)).data;
    const bits = new Uint32Array(
      d.keyformPositions.buffer,
      d.keyformPositions.byteOffset,
      d.keyformPositions.length,
    );
    bits[0] = 0x7fc00123; // a NaN with a payload
    const back = readMoc(writeMoc(d, { version: 3 })).data.keyformPositions;
    expect(new Uint32Array(back.buffer, back.byteOffset, back.length)[0]).toBe(0x7fc00123);
  });
});

describe("readMoc's diagnostics and errors", () => {
  it("read big-endian files, with a warning", () => {
    const s = new Synth(4);
    s.part({ id: "Root" });
    s.mesh({ id: "M", keyforms: [{ positions: [0, 0, 1, 0, 0, 1], drawOrder: 500 }] });
    const le = readMoc(s.build());
    const be = readMoc(s.build({ bigEndian: true }));
    expect(be.data).toEqual(le.data);
    expect(be.diagnostics).toEqual([
      expect.objectContaining({ code: "big-endian", severity: "warning", kind: "file" }),
    ]);
  });

  it("report what leaves the data intact, and fail on the rest with a code", () => {
    const good = sampleModel(4);
    const padded = new Uint8Array(good.length + 3);
    padded.set(good);
    const r = readMoc(padded);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "file-length", severity: "error" }),
    ]);
    expect(r.data).toEqual(readMoc(good).data);
    // Sections out of slot order (C26): readable, reported.
    const s = new Synth(5);
    s.part({ id: "Root" });
    s.mesh({ id: "M", keyforms: [{ positions: [0, 0, 1, 0, 0, 1], drawOrder: 500 }] });
    const shuffled = writeRawMoc({
      version: 5,
      canvas: s.canvas,
      fields: s.fields(),
      sectionOrder: "schema",
    });
    expect(readMoc(shuffled).diagnostics.map((d) => d.code)).toEqual(["slot-order"]);
    expect(() => loadMoc(shuffled)).toThrow(MocFormatError);
    const code = (bytes: Uint8Array) => {
      try {
        readMoc(bytes);
      } catch (e) {
        return (e as MocFormatError).code;
      }
      return "read";
    };
    const edit = (f: (b: Uint8Array, dv: DataView) => void) => {
      const b = good.slice();
      f(b, new DataView(b.buffer));
      return b;
    };
    expect(code(edit((b) => (b[0] = 0x58)))).toBe("magic");
    expect(code(edit((b) => (b[4] = 9)))).toBe("version");
    expect(code(edit((b) => (b[5] = 1)))).toBe("endianness");
    expect(code(good.slice(0, good.length - 64))).toBe("section-bounds");
    expect(code(good.slice(0, 40))).toBe("file-length");
    expect(code(edit((b, dv) => dv.setInt32(dv.getUint32(64, true), -1, true)))).toBe(
      "negative-count",
    );
    expect(
      code(
        edit((b, dv) =>
          b.fill(0x41, dv.getUint32(64 + 3 * 4, true), dv.getUint32(64 + 3 * 4, true) + 64),
        ),
      ),
    ).toBe("name-terminator");
  });
});

/**
 * The test catalog (4o–4w), generated at test
 * time: the generators' check values, the catalog's size and groups, the P8
 * validation table, and catalog scenarios run through the conformance
 * runners (with the crafted files served from memory) against expected
 * values: the 4k example, the animation vectors, cra-hit-margin's boxes,
 * C20, C21, the 4i note on motion curves and the 4e/4r sequences.
 */
import { describe, expect, it } from "vitest";
import { fullCatalog, type CatalogEntry } from "../tools/lib/catalog/scenarios.js";
import { checkDsrand, checkRandomLists } from "../tools/lib/catalog/checks.js";
import { HIT_MARGIN_BOXES } from "../tools/lib/catalog/scenarios.js";
import {
  VALIDATION_CASES,
  craftDeepseek,
  deepseekMocBytes,
  deepseekSections,
  mocCrafts,
} from "../tools/lib/catalog/moc-crafts.js";
import { writeMoc } from "../src/core/moc/write.js";
import {
  ANIM_SOUNDS,
  animFolderFiles,
  questionFolderFiles,
  wavFile,
} from "../tools/lib/catalog/anim-files.js";
import { virtualCatalog } from "../tools/lib/catalog/virtual.js";
import { ModelCache } from "../tools/lib/model-cache.js";
import { runStatic } from "../tools/lib/conformance-runner.js";
import { parseScenario } from "../tools/lib/scenario.js";
import {
  parseAnimScenario,
  parseSequence,
  runAnimFile,
  runSequence,
  type AnimResult,
  type SequenceResult,
} from "../tools/lib/formats.js";
import { loadMoc } from "../src/core/moc/model.js";
import { parseMotion } from "../src/anim/motion.js";
import { parseExpression } from "../src/anim/expression.js";
import { parsePhysics } from "../src/anim/physics.js";
import { parsePose } from "../src/anim/pose.js";
import { decodeWav } from "../src/anim/lip-sync.js";
import { expect7 } from "./support/anim.js";

const catalog = fullCatalog();
const byId = new Map(catalog.map((e) => [e.id, e]));
const { resolver, io } = virtualCatalog();
const models = new ModelCache(resolver, 2, io);
const scenario = (id: string): CatalogEntry => {
  const e = byId.get(id);
  if (!e) throw new Error(`no catalog scenario ${id}`);
  return e;
};
const anim = (id: string): AnimResult => {
  const r = runAnimFile(parseAnimScenario(scenario(id).scenario), models, "test");
  expect(r.error, `${id} error`).toBeNull();
  return r;
};
const sequence = (id: string): SequenceResult => {
  const r = runSequence(parseSequence(scenario(id).scenario), models, "test");
  expect(r.error, `${id} error`).toBeNull();
  return r;
};
/** A frame's value of a recorded parameter. */
const param = (r: AnimResult, frame: number, id: string) => {
  const f = r.frames.find((x) => x.frame === frame)!;
  return f.parameters[r.ids.parameters.indexOf(id)] as number;
};

describe("generators (4q, 4u)", () => {
  it("reproduces every dsrand check value of 4q", () => {
    expect(checkDsrand(loadMoc(deepseekMocBytes()))).toEqual([]);
  });
  it("reproduces R(7) and R(101)", () => {
    expect(checkRandomLists()).toEqual([]);
  });
});

describe("catalog contents (4w)", () => {
  it("has 827 scenarios in the groups of 4w (P8 with 20 more validation cases)", () => {
    const count = (kind: string, group?: string) =>
      catalog.filter((e) => e.kind === kind && (group === undefined || e.group === group)).length;
    expect(catalog.length).toBe(827);
    expect([count("static"), count("sequence"), count("render"), count("animation")]).toEqual([
      665, 4, 54, 104,
    ]);
    expect(
      ["ds", "extras", "dsrand", "variants", "v6", "validation"].map((g) => count("static", g)),
    ).toEqual([14, 4, 300, 228, 58, 61]);
    expect(["dsr", "rx", "v6", "q2", "qm", "texture-limit"].map((g) => count("render", g))).toEqual(
      [9, 22, 11, 6, 5, 1],
    );
    expect(["A1", "A2", "A3", "A4", "A5", "A6", "A7"].map((g) => count("animation", g))).toEqual([
      23, 35, 4, 7, 3, 11, 21,
    ]);
  });

  it("every scenario file parses under its format", () => {
    for (const e of catalog) {
      if (e.kind === "static" || e.kind === "render") parseScenario(e.scenario);
      else if (e.kind === "sequence") parseSequence(e.scenario);
      else parseAnimScenario(e.scenario);
    }
  });

  it("takes the extra scenarios from 4q's table (D2)", () => {
    expect(scenario("ds-multi-constraint-p50").scenario.parameters).toEqual({
      Param50: 1,
      Movement1: 0.4,
      Movement3: 0.7,
      Param37: 0.3,
      Movement2: 0.5,
    });
    expect(scenario("ds-multi-constraint-shock").scenario.parameters).toEqual({
      ShockL: 1,
      ParamEyeROpen: 1.45,
      ParamEyeLOpen: 1.42,
      ParamBrowLY: 0.97,
    });
    expect(scenario("ds-bs-nosnap-hair").scenario.parameters).toEqual({ LateHairX2: -0.9991 });
    expect(scenario("ds-bs-nosnap-tongue").scenario.parameters).toEqual({ TongueOut: 0.3009 });
  });

  it("carries P8's verdicts for the validation cases (C27)", () => {
    const v = catalog.filter((e) => e.group === "validation");
    // P8's 34 rejections and 20 more (S6).
    expect(v.filter((e) => e.verdicts?.required === "reject")).toHaveLength(54);
    expect(scenario("val-part-parent-self").verdicts).toEqual({
      official: "accept",
      required: "reject",
    });
    expect(scenario("val-color-index-n").verdicts).toEqual({
      official: "accept",
      required: "reject",
    });
    expect(scenario("val-position-run-index").verdicts).toEqual({
      official: "reject",
      required: "reject",
    });
  });

  it("names variant scenarios <variant>_<base id> (4q)", () => {
    expect(scenario("ds-v1_ds-default").scenario.model).toBe("crafts/ds-v1/m.model3.json");
    expect(scenario("ds-bigendian_dsrand-023").scenario.parameters).toEqual(
      scenario("dsrand-023").scenario.parameters,
    );
    expect(scenario("ds-v6_hip-p30-parts").scenario.partOpacities).toEqual({
      Part114: 0.5,
      Part18: 0.4,
      Part30: 0.8,
    });
  });
});

describe("crafted animation files (4t, A7)", () => {
  it("every motion, expression, pose and physics file parses, except the invalid motions", () => {
    // m-badcount and m-badpoints (4t); m-nocc, m-nosc and m-nopc, whose missing count is 0.
    const invalid = ["m-badcount", "m-badpoints", "m-nocc", "m-nosc", "m-nopc"].map(
      (n) => `${n}.motion3.json`,
    );
    for (const [folder, files] of [
      ["anim", animFolderFiles()],
      ["anim-q", questionFolderFiles()],
    ] as const) {
      for (const [name, content] of files) {
        const what = `${folder}/${name}`;
        if (name.endsWith(".motion3.json")) {
          if (invalid.includes(name))
            expect(() => parseMotion(content, name), what).toThrow(/Meta/);
          else expect(() => parseMotion(content, name), what).not.toThrow();
        } else if (name.endsWith(".exp3.json"))
          expect(() => parseExpression(content, name), what).not.toThrow();
        else if (name.endsWith(".pose3.json"))
          expect(() => parsePose(content, name), what).not.toThrow();
        else if (name.endsWith(".physics3.json"))
          expect(() => parsePhysics(content, name), what).not.toThrow();
      }
    }
  });

  it("writes the WAV files of 4t; w16list fails to load (C20), w16list-even loads", () => {
    const ok = [
      "w16m44.wav",
      "w8s22.wav",
      "w24m48.wav",
      "w32m16.wav",
      "w16list-even.wav",
      "vec.wav",
    ];
    for (const name of ok) expect(() => decodeWav(wavFile(ANIM_SOUNDS[name]!)), name).not.toThrow();
    expect(() => decodeWav(wavFile(ANIM_SOUNDS["w16list.wav"]!))).toThrow();
    expect(() => decodeWav(wavFile(ANIM_SOUNDS["wfloat.wav"]!))).toThrow();
    const w = decodeWav(wavFile(ANIM_SOUNDS["w8s22.wav"]!));
    expect([w.sampleRate, w.channels, w.frames]).toEqual([22050, 2, 33075]);
    // 8-bit: round(127·v) + 128; 16-bit: round(32767·v), halves upward.
    expect(wavFile(ANIM_SOUNDS["w16list.wav"]!).length).toBe(44 + 8 + 17 + 1 + 12000 * 4);
  });
});

describe("validation crafts (P8)", () => {
  it.each(VALIDATION_CASES.map((c) => [c.name, c.required] as const))(
    "val-%s: %s",
    (name, required) => {
      const r = runStatic(parseScenario(scenario(`val-${name}`).scenario), models, "test");
      if (required === "accept") expect(r.error).toBeNull();
      else expect(r.error?.kind).toBe("ModelLoadError");
    },
  );
});

describe("C24: overlapping sections, at the exact boundary", () => {
  const verdict = (entry: number, d: number) => {
    const b = Uint8Array.from(deepseekMocBytes());
    const dv = new DataView(b.buffer);
    const counts = dv.getUint32(64, true);
    dv.setInt32(counts + 4 * entry, dv.getInt32(counts + 4 * entry, true) + d, true);
    try {
      loadMoc(b);
      return "accept";
    } catch {
      return "reject";
    }
  };
  // Count-table entry, the accepted and rejected changes d.
  const table: [number, number[], number[]][] = [
    [10, [-2, -1, 0], [1, 2, 64, 1000]],
    [14, [1, 2], [3, 64, 1000, -1, -2]],
    [15, [1, 2], [3, 64, 1000, -1, -2]],
    [16, [1, 2, 11, 12], [13, 14, 64, 1000, -1, -2]],
  ];
  it.each(table)("count-table entry %i", (entry, accepted, rejected) => {
    for (const d of accepted) expect(verdict(entry, d), `d = ${d}`).toBe("accept");
    for (const d of rejected) expect(verdict(entry, d), `d = ${d}`).toBe("reject");
  });
});

describe("C26: sections in slot order", () => {
  const loads = (b: Uint8Array) => {
    try {
      loadMoc(b);
      return "accept";
    } catch {
      return "reject";
    }
  };
  const slotOf = (dv: DataView, slot: number) => dv.getUint32(64 + 4 * slot, true);
  /** DeepSeek-chan's file with the sections of two equal-sized slots exchanged (contents and offsets). */
  const exchanged = (a: number, b: number) => {
    const bytes = Uint8Array.from(deepseekMocBytes());
    const dv = new DataView(bytes.buffer);
    const oa = slotOf(dv, a);
    const ob = slotOf(dv, b);
    const size = 147 * 4; // one int32 per part
    const tmp = bytes.slice(oa, oa + size);
    bytes.copyWithin(oa, ob, ob + size);
    bytes.set(tmp, ob);
    dv.setUint32(64 + 4 * a, ob, true);
    dv.setUint32(64 + 4 * b, oa, true);
    return bytes;
  };
  /** One slot pointed at another slot's offset. */
  const shared = (slot: number, at: number) => {
    const bytes = Uint8Array.from(deepseekMocBytes());
    const dv = new DataView(bytes.buffer);
    dv.setUint32(64 + 4 * slot, slotOf(dv, at), true);
    return bytes;
  };
  const sections = deepseekSections();
  const rewrite = (opts: Partial<Parameters<typeof writeMoc>[0]>) =>
    writeMoc({
      version: sections.version,
      canvas: sections.canvas,
      fields: Object.fromEntries(
        [...sections.fields].filter(([, v]) => v !== null).map(([k, v]) => [k, v as never]),
      ),
      counts: Object.fromEntries(Array.from(sections.counts, (c, i) => [i, c])),
      ...opts,
    });

  it("rejects exchanged sections, even with the contents moved along", () => {
    expect(loads(deepseekMocBytes())).toBe("accept");
    for (const [a, b] of [
      [4, 5],
      [5, 6],
      [4, 9],
    ] as const)
      expect(loads(exchanged(a, b)), `slots ${a} and ${b}`).toBe("reject");
  });

  it("accepts DeepSeek-chan rewritten in slot order, aligned to 4 or 64 bytes", () => {
    expect(loads(rewrite({ alignment: 4 }))).toBe("accept");
    expect(loads(rewrite({ alignment: 64 }))).toBe("accept");
    expect(loads(craftDeepseek())).toBe("accept");
  });

  it("rejects the schema-order layout, with later versions' arrays out of slot order", () => {
    expect(loads(rewrite({ sectionOrder: "schema" }))).toBe("reject");
  });

  it("rejects two non-empty arrays at the same offset", () => {
    for (const [slot, at] of [
      [8, 7],
      [7, 8],
      [30, 29],
    ] as const)
      expect(loads(shared(slot, at)), `slot ${slot} at slot ${at}'s offset`).toBe("reject");
  });

  it("every moc craft of the catalog is in slot order: only P8's rejections fail to load", () => {
    for (const c of mocCrafts()) {
      const required =
        VALIDATION_CASES.find((v) => `val-${v.name}` === c.name)?.required ?? "accept";
      expect(loads(c.build()), c.name).toBe(required);
    }
  });
});

describe("animation scenarios through the file runner (4i–4k)", () => {
  it("v-curves frame 1 is the example of 4k", () => {
    const r = anim("v-curves");
    const f = r.frames[1]!;
    expect(f.frame).toBe(1);
    expect(f.time).toBe(0.25);
    expect(f.parameters[0]).toBe(2.5);
    expect7(f.parameters[1] as number, 3.46986, "AngleY");
    expect7(f.parameters[2] as number, -7.32574, "AngleZ");
    expect(f.parameters.slice(3)).toEqual([0, 5]);
    expect(f.parts).toEqual([]);
    expect([f.modelOpacity, f.motionAdvanced, f.queueEmpty, f.lipsync]).toEqual([
      1,
      true,
      false,
      null,
    ]);
    expect(f.events).toEqual([]);
    expect(r.starts).toEqual([{ frame: 0, command: 0, started: true }]);
    expect(r.randomUsed).toBe(0);
  });

  it("the v-* scenarios reproduce the animation vector tables", () => {
    const table = (id: string, rows: Record<number, Record<string, number>>) => {
      const r = anim(id);
      for (const [frame, values] of Object.entries(rows))
        for (const [pid, want] of Object.entries(values))
          expect7(param(r, Number(frame), pid), want, `${id} ${frame} ${pid}`);
    };
    table("v-fades", {
      1: { AngleX: 2.928932, AngleY: 10 },
      13: { AngleX: 15.6066 },
      15: { AngleX: -6.299172 },
    });
    table("v-loop", {
      13: { AngleX: 26.25 },
      20: { AngleX: 30, AngleY: 20 },
      21: { AngleX: 2.5, AngleY: -20 },
    });
    table("v-expr", {
      1: { AngleX: 7.464466, AngleY: -2.924621 },
      9: { AngleX: 13.47119, AngleY: -6 },
    });
    table("v-physics", {
      2: { AngleZ: -7.281898 },
      12: { AngleZ: 6.15521 },
      17: { AngleZ: -0.39957 },
    });
    table("v-blink", {
      35: { ParamEyeLOpen: 1 },
      36: { ParamEyeLOpen: 0.5 },
      39: { ParamEyeLOpen: 0.3333333 },
    });
    table("v-drag", {
      5: { ParamAngleX: 6.666667, ParamEyeBallX: 0.2222222 },
      9: { ParamAngleX: 19.31244 },
    });
    table("v-breath", {
      0: { ParamAngleX: 1.785575, ParamBreath: 0.7333864 },
      3: { ParamBodyAngleX: 0.7870568 },
    });
    table("v-lip", {
      0: { ParamMouthOpenY: 0.3511096 },
      15: { ParamMouthOpenY: 0.004786775 },
      22: { ParamMouthOpenY: 0.1764453 },
    });
    const pose = anim("v-pose");
    const part = (frame: number, id: string) =>
      pose.frames[frame]!.parts[pose.ids.parts.indexOf(id)] as number;
    expect7(part(11, "Part99"), 0.8125, "v-pose Part99");
    expect7(part(14, "Part64"), 0.2499999, "v-pose Part64");
    expect7(part(13, "Part116"), 0.6, "v-pose Part116");
  });

  it("cra-hit-margin: the expected boxes and hit, hit, hit, miss, miss, miss (C22)", () => {
    const r = anim("cra-hit-margin");
    expect(r.frames.map((f) => f.frame)).toEqual([0, 60, 120]);
    for (const f of r.frames) {
      expect(f.hits!.map((h) => (h.hit ? "H" : "m")).join("")).toBe("HHHmmm".repeat(3) + "m");
      for (const [drawable, boxes] of Object.entries(HIT_MARGIN_BOXES)) {
        const want = f.frame === 60 ? boxes.f60 : boxes.rest;
        const got = f.hits!.find((h) => h.drawable === drawable)!.box!;
        got.forEach((v, i) =>
          expect(Math.abs(v - want[i]!), `${drawable} frame ${f.frame} box[${i}]`).toBeLessThan(
            1e-7,
          ),
        );
      }
      expect(f.hits!.at(-1)!.box).toBeNull();
    }
  });

  it("C21: free values never written read as null; C20: w16list gives 0, w16list-even about 0.32", () => {
    const segs = anim("cra-segs-unres");
    for (const f of segs.frames) expect(f.free.slice(1)).toEqual(new Array(8).fill(null));
    expect(segs.frames[100]!.free[0]).not.toBeNull();
    expect(anim("cra-lip-w16list").frames.every((f) => f.lipsync === 0)).toBe(true);
    const even = anim("cra-lip-w16list-even").frames.map((f) => f.lipsync as number);
    expect(Math.max(...even)).toBeGreaterThan(0.3);
    expect(Math.max(...even)).toBeLessThan(0.34);
  });

  it("cra-model-curves: ParamMouthOpenY is 0.56 at τ = 0.5 with lip sync off (4i)", () => {
    expect7(param(anim("cra-model-curves"), 30, "ParamMouthOpenY"), 0.56, "τ = 0.5");
  });

  it("cra-validate drops both invalid motion files with warnings", () => {
    const r = anim("cra-validate");
    expect(r.starts.map((s) => s.started)).toEqual([false, true, false, false]);
    expect(r.warnings.filter((w) => /invalid/.test(w))).toHaveLength(2);
  });

  it("q7-pose-late: the pose effect switched on by a command at frame 10", () => {
    const r = anim("q7-pose-late");
    expect(r.frames).toHaveLength(16);
    expect(r.ids.parameters).toEqual([]);
  });
});

describe("animation rules through the A7 scenarios", () => {
  const started = (id: string) => anim(id).starts.map((x) => x.started);
  it("stop keeps the current priority", () => {
    expect(started("q1-stop-same")).toEqual([true, false, true]);
    expect(started("q1-stop-low")).toEqual([true, false, false]);
    expect(started("q1-natural")).toEqual([true, true]);
    const idle = anim("q1-stop-idle").starts.filter((x) => x.idle !== undefined);
    expect(idle.map((x) => x.frame)).toEqual(Array.from({ length: 30 }, (_, k) => 10 + k));
    expect(idle.every((x) => !x.started)).toBe(true);
  });
  it("events across a loop wrap", () => {
    const events = (id: string) =>
      anim(id)
        .frames.filter((f) => f.events.length)
        .map((f) => `${f.frame}: ${f.events.join(", ")}`)
        .join("; ");
    expect(events("q2-loop-025")).toBe(
      "1: e005; 2: e050; 4: e095, e100; 5: e005; 7: e050; 10: e005; 11: e050; 13: e095, e100; 14: e005; 16: e050; 18: e005",
    );
    expect(events("q2-loop-030")).toBe(
      "1: e005; 2: e050; 4: e005; 6: e050; 7: e095; 8: e005; 10: e050; 11: e095, e100, e105; 12: e005; 13: e050; 15: e005; 17: e050; 18: e095; 19: e005",
    );
  });
  it("settle writes the settled outputs from frame 0", () => {
    const r = anim("cra-phys-fps30-stab");
    [0.3054326, 0.3040673, 0.2985241].forEach((v, k) =>
      expect7(param(r, k, "ParamMouthForm"), v, `frame ${k}`),
    );
    const plain = anim("cra-phys-fps30");
    expect7(param(plain, 1, "ParamMouthForm"), -0.464962, "without settle, frame 1");
  });
  it("missing counts count as 0", () => {
    for (const n of ["m-nocc", "m-nosc", "m-nopc"]) expect(started(`q5-${n}`)).toEqual([false]);
    for (const n of ["m-empty-nocounts", "m-empty-zero"])
      expect(started(`q5-${n}`)).toEqual([true]);
  });
  it("an unloadable sound stops the analysis; a loadable one restarts it", () => {
    const r = anim("q6-float-during");
    expect7(param(r, 8, "ParamMouthOpenY"), 0.3552888, "frame 8");
    expect7(param(r, 9, "ParamMouthOpenY"), 0.3551093, "frame 9");
    for (let k = 10; k < 30; k++) expect(param(r, k, "ParamMouthOpenY")).toBe(0);
    const pcm = anim("q6-pcm-during");
    for (let k = 0; k < 3; k++)
      expect(param(pcm, 10 + k, "ParamMouthOpenY")).toBe(param(pcm, k, "ParamMouthOpenY"));
  });
  it("pose setup on its first frame", () => {
    const setup = [1, 1, 0, 1, 0, 0, 0, 0]; // Part99, Part64, Part116, Part66, Part10, Part8, Part47, Part81
    expect(anim("q7-pose-first").frames[0]!.parts).toEqual(setup);
    const late = anim("q7-pose-late");
    for (let k = 0; k < 10; k++) expect(late.frames[k]!.parts).toEqual(new Array(8).fill(1));
    expect(late.frames[10]!.parts).toEqual(setup);
  });
  it("the first entry of a duplicated ID wins", () => {
    const want: [string, number][] = [
      ["e-add2", 0.3016434],
      ["e-over2", 0.2],
      ["e-mul2", 0.0008217157],
      ["e-add-over", 0.3016434],
      ["e-over-add", 0.8],
    ];
    for (const [n, v] of want) expect7(param(anim(`q8-${n}`), 1, "ParamEyeBallX"), v, n);
  });
});

describe("sequences (4e, 4r) through the sequence runner", () => {
  const vertex = (r: SequenceResult, step: number, mesh: string, v: number) => {
    const d = r.steps[step]!.drawables.find((x) => x.id === mesh)!;
    return [d.vertices[2 * v]!, d.vertices[2 * v + 1]!];
  };
  it("seq-q3a matches the expected table", () => {
    const r = sequence("seq-q3a");
    expect(r.steps.map((s) => s.label)).toEqual(["create", "s1", "s2", "s3", "s4", "s5", "s6"]);
    const rows: [number, number, number, number][] = [
      [2, 13, -0.01289533, 0.4340729],
      [4, 13, -0.01227311, 0.2286396],
    ];
    for (const [step, v, x, y] of rows) {
      const [gx, gy] = vertex(r, step, "ArtMesh198", v);
      expect(Math.abs(gx! - x)).toBeLessThan(1e-6);
      expect(Math.abs(gy! - y)).toBeLessThan(1e-6);
    }
  });
  it("seq-q3b: the first inactive step meets near y = 0", () => {
    const r = sequence("seq-q3b");
    expect(Math.abs(vertex(r, 2, "ArtMesh715", 0)[1]! - 0.0003913343)).toBeLessThan(1e-6);
    expect(Math.abs(vertex(r, 3, "ArtMesh626", 17)[1]! - 0.1269716)).toBeLessThan(1e-6);
  });
  it("seq-q4c: stale opacity, draw order and colors, render orders 4, 419, 714 (C10)", () => {
    const r = sequence("seq-q4c");
    const d = (step: number) => r.steps[step]!.drawables.find((x) => x.id === "ArtMesh197")!;
    expect([0, 1, 2, 5].map((s) => d(s).renderOrder)).toEqual([4, 419, 4, 714]);
    expect(Math.abs(d(2).opacity - 0.6)).toBeLessThan(1e-6);
    expect(d(2).drawOrder).toBe(500);
    expect(d(6).drawOrder).toBe(633);
  });
  it("seq-ds-history: the claims of 4e", () => {
    const r = sequence("seq-ds-history");
    expect(r.steps).toHaveLength(9);
    const m436 = (s: number) => r.steps[s]!.drawables.find((x) => x.id === "ArtMesh436")!;
    const m197 = (s: number) => r.steps[s]!.drawables.find((x) => x.id === "ArtMesh197")!;
    expect(m436(0).vertices.every((v) => v === 0)).toBe(true); // never active at creation
    expect(m436(1).visible).toBe(true);
    expect(m436(2).visible).toBe(false);
    expect(m436(2).vertices).toEqual(m436(1).vertices);
    expect(Math.abs(m436(2).opacity - 0.13)).toBeLessThan(1e-6);
    expect(m197(4).visible).toBe(false);
    expect(m197(4).vertices).toEqual(m197(3).vertices);
    expect(m197(5).vertices).toEqual(m197(3).vertices);
    const visible = (s: number) => r.steps[s]!.drawables.filter((x) => x.visible).length;
    expect(visible(5) - visible(6)).toBe(24);
    expect(m436(8).vertices).toEqual(m436(1).vertices);
  });
});

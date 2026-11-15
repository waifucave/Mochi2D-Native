/**
 * Other model data for a loaded model (`ModelRuntime.withModel`, `withData`),
 * as `MochiModel.replace` uses for an editor's structural edits: the state
 * carried over by ID, `.moc3` bytes and MocData giving the same result, the
 * load options, and errors that leave the current runtime as it was.
 */
import { describe, expect, it } from "vitest";
import { readMoc } from "../src/core/moc/io.js";
import { MocFormatError } from "../src/core/moc/read.js";
import { MemoryFileSource } from "../src/core/io/file-source.js";
import { ModelRuntime, type RuntimeOptions } from "../src/runtime/model-runtime.js";
import { constant, motionJson } from "./support/anim.js";
import { output, same } from "./support/evaluate.js";
import { Synth } from "./support/synth.js";

const tri = (x: number, y: number, s = 0.1) => [x, y, x + s, y, x, y + s, x + s, y + s];
const triangles = [0, 1, 2, 1, 3, 2];

/**
 * Parameters P and Q, parts Root and Child, meshes M0 (bound to P) and M1.
 * `edited` is a structural edit of it: a parameter R and a mesh M2 bound to
 * R. `drawOrder` is M1's draw order (outside [0, 1000] for the range tests).
 */
function moc(edited: boolean, drawOrder = 500): Uint8Array {
  const s = new Synth(5);
  const root = s.part({ id: "Root" });
  const P = s.param("P", 0, 1, 0.3);
  s.param("Q", -1, 1, 0);
  const R = edited ? s.param("R", 0, 1, 0) : -1;
  const bP = s.band([s.binding(P, [0, 1])]);
  const child = s.part({ id: "Child", parent: root });
  s.mesh({
    id: "M0",
    band: bP,
    part: child,
    triangles,
    keyforms: [{ positions: tri(0, 0) }, { positions: tri(0.5, 0.2) }],
  });
  s.mesh({ id: "M1", part: root, triangles, keyforms: [{ positions: tri(0.3, 0.3), drawOrder }] });
  if (edited)
    s.mesh({
      id: "M2",
      band: s.band([s.binding(R, [0, 1])]),
      part: child,
      triangles,
      keyforms: [{ positions: tri(-0.5, 0) }, { positions: tri(-0.5, 0.4) }],
    });
  return s.build();
}

const SETTINGS = JSON.stringify({
  Version: 3,
  FileReferences: { Moc: "m.moc3", Textures: [] },
  Groups: [{ Target: "Parameter", Name: "LipSync", Ids: ["Q"] }],
});

function load(bytes: Uint8Array, options: RuntimeOptions = {}): Promise<ModelRuntime> {
  const source = MemoryFileSource.fromFiles({ "m.model3.json": SETTINGS, "m.moc3": bytes });
  return ModelRuntime.load(source, "m.model3.json", options);
}

/** The state the tests set on a runtime. */
function pose(rt: ModelRuntime): void {
  rt.setParameter("P", 0.8);
  rt.setParameter("Q", -0.5);
  rt.setPartOpacity("Child", 0.25);
  rt.setEffect("breath", false);
}

describe("other model data for a loaded model", () => {
  it("carries parameter values, part opacities and effect switches over by ID", async () => {
    const rt = await load(moc(false));
    pose(rt);
    rt.update(0);
    const before = output(rt.instance);
    const next = await rt.withData(moc(true));
    expect(next).not.toBe(rt);
    expect(next.parameters.map((p) => p.id)).toEqual(["P", "Q", "R"]);
    // Values are float32, as in the runtime they came from.
    expect(["P", "Q", "R"].map((id) => next.getParameter(id))).toEqual([Math.fround(0.8), -0.5, 0]);
    expect(next.getPartOpacity("Child")).toBe(0.25);
    expect([next.effect("breath"), next.effect("look")]).toEqual([false, true]);
    next.update(0);
    // The same as loading the edited data and setting the same values.
    const fresh = await load(moc(true));
    pose(fresh);
    fresh.update(0);
    expect(same(output(next.instance), output(fresh.instance))).toBe(true);
    expect(next.instance.drawableVertices.length).toBe(3);
    // The runtime it was made from is unchanged.
    expect(rt.model.meshes.ids).toEqual(["M0", "M1"]);
    expect(rt.getParameter("P")).toBe(Math.fround(0.8));
    rt.update(0);
    expect(same(output(rt.instance), before)).toBe(true);
  });

  it("keeps a live lip-sync input and its mix, but no motions or expressions", async () => {
    const rt = await load(moc(false));
    const live = { next: () => 0.5 };
    expect(rt.setLiveLipSync(live, "replace")).toBe(true);
    const next = await rt.withData(moc(true));
    expect(next.liveLipSync).toBe(live);
    expect(next.liveLipSyncMix).toBe("replace");
    next.update(1 / 60);
    expect(next.instance.parameterValues[1]).toBe(0.5); // Q, the LipSync parameter
    expect(next.playingMotions).toEqual([]);
  });

  it("takes MocData with its version, as mocModelFromData does", async () => {
    const rt = await load(moc(false));
    pose(rt);
    const read = readMoc(moc(true));
    const fromData = await rt.withData(read.data, read.version);
    const fromBytes = await rt.withData(moc(true));
    fromData.update(0);
    fromBytes.update(0);
    expect(same(output(fromData.instance), output(fromBytes.instance))).toBe(true);
    // An ArrayBuffer works as the bytes do.
    const bytes = moc(true);
    const fromBuffer = await rt.withData(bytes.buffer.slice(0) as ArrayBuffer);
    fromBuffer.update(0);
    expect(same(output(fromBuffer.instance), output(fromBytes.instance))).toBe(true);
    // The data is copied: changing it afterwards changes nothing.
    const positions = Float32Array.from(fromData.model.positions);
    read.data.keyformPositions.fill(7);
    expect(fromData.model.positions).toEqual(positions);
  });

  it("rejects bad data, and data without a version, leaving the runtime as it was", async () => {
    const rt = await load(moc(false));
    pose(rt);
    rt.update(0);
    const before = output(rt.instance);
    await expect(rt.withData(readMoc(moc(true)).data)).rejects.toThrow(TypeError);
    await expect(rt.withData(new Uint8Array([1, 2, 3]))).rejects.toThrow(MocFormatError);
    const broken = readMoc(moc(true)).data;
    broken.artMeshes.part[0] = 9;
    await expect(rt.withData(broken, 5)).rejects.toThrow(/part/);
    rt.setParameter("P", 0.8);
    rt.update(0);
    expect(same(output(rt.instance), before)).toBe(true);
  });

  it("loads with the runtime's options, and replaces the warnings of the old data", async () => {
    const outside = moc(true, 1200);
    const rt = await load(moc(false, 1100));
    expect(rt.warnings.filter((w) => w.startsWith("m.moc3: "))).toEqual([
      expect.stringContaining("art mesh M1: keyform draw order 1100 outside the range"),
    ]);
    const next = await rt.withData(outside);
    expect(next.warnings.filter((w) => w.startsWith("m.moc3: "))).toEqual([
      expect.stringContaining("art mesh M1: keyform draw order 1200 outside the range"),
    ]);
    // strictDrawOrders rejects such data, from bytes and from MocData.
    const strict = await load(moc(false), { strictDrawOrders: true });
    await expect(strict.withData(outside)).rejects.toThrow(/outside the range/);
    const read = readMoc(outside);
    await expect(strict.withData(read.data, read.version)).rejects.toThrow(/outside the range/);
    expect((await strict.withData(moc(true))).model.meshes.ids).toEqual(["M0", "M1", "M2"]);
  });

  it("reuses the motion files already read", async () => {
    const files = MemoryFileSource.fromFiles({
      "m.model3.json": JSON.stringify({
        Version: 3,
        FileReferences: {
          Moc: "m.moc3",
          Textures: [],
          Motions: { Idle: [{ File: "idle.motion3.json" }] },
        },
      }),
      "m.moc3": moc(false),
      "idle.motion3.json": motionJson({ duration: 1, fps: 30, curves: [constant("P", 1, 1)] }),
    });
    const reads: string[] = [];
    const source = {
      label: files.label,
      list: () => files.list(),
      read: (path: string) => (reads.push(path), files.read(path)),
    };
    const rt = await ModelRuntime.load(source, "m.model3.json");
    expect(reads).toContain("idle.motion3.json");
    expect(rt.warnings).toEqual([]);
    reads.length = 0;
    const next = await rt.withData(moc(true));
    expect(reads).toEqual([]);
    expect(next.motionGroups).toEqual(rt.motionGroups);
  });

  it("withModel takes a loaded model", async () => {
    const rt = await load(moc(false));
    pose(rt);
    const other = await load(moc(true));
    const next = await rt.withModel(other.model);
    expect(next.model).toBe(other.model);
    expect(next.getParameter("P")).toBe(Math.fround(0.8));
  });
});

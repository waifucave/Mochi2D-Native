/**
 * Sequence and animation vectors for the cross-check, made at test time and
 * never committed: for a synthetic model, random settings files, motions,
 * expressions, physics and pose files and WAV sounds (written with the
 * reference catalog's own builders where it has them), and random sequence
 * and animation scenarios on them. Also a list of malformed sequence and
 * animation scenarios, one per InvalidScenario rule.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  motionJson,
  wavFile,
  type CurveSpec,
  type MotionSpec,
  type Segment,
  type WavSpec,
} from "../../reference/mochi2d-0.24.1/tools/lib/catalog/anim-files.js";
import type { MocModel } from "../../reference/mochi2d-0.24.1/src/core/moc/model.js";

type Rnd = () => number;

/** A seeded sequence in [0, 1). */
export function lcg(seed: number): Rnd {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

const ANIM_FORMAT = "mochi2d-anim-scenario/0";
const SEQ_FORMAT = "mochi2d-sequence/0";

interface Tools {
  rnd: Rnd;
  pick<T>(a: readonly T[]): T;
  chance(p: number): boolean;
  between(a: number, b: number): number;
  int(a: number, b: number): number;
  subset<T>(a: readonly T[], p: number): T[];
}

function tools(seed: number): Tools {
  const rnd = lcg(seed);
  return {
    rnd,
    pick: (a) => a[Math.floor(rnd() * a.length)]!,
    chance: (p) => rnd() < p,
    between: (a, b) => a + (b - a) * rnd(),
    int: (a, b) => a + Math.floor(rnd() * (b - a + 1)),
    subset: (a, p) => a.filter(() => rnd() < p),
  };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ------------------------------------------------------------------ motions

function randomCurve(t: Tools, id: string, duration: number, lo: number, hi: number): CurveSpec {
  const n = t.int(1, 5);
  const segments: Segment[] = [];
  let time = t.chance(0.2) ? r3(t.between(0, duration / 3)) : 0;
  const first: [number, number] = [time, r3(t.between(lo, hi))];
  const end = Math.max(duration, 0.1) * (t.chance(0.2) ? 0.6 : 1);
  for (let k = 0; k < n; k++) {
    const next = k === n - 1 ? end : r3(time + t.between(0, (end - time) / (n - k)) * (t.chance(0.1) ? 0 : 1));
    const v = r3(t.between(lo, hi));
    const kind = t.pick(["linear", "linear", "bezier", "bezier", "stepped", "inverse"] as const);
    if (kind === "bezier") {
      const span = next - time;
      const c1 = r3(time + span * t.between(t.chance(0.15) ? -0.5 : 0, t.chance(0.15) ? 1.5 : 1));
      const c2 = r3(time + span * t.between(t.chance(0.15) ? -0.5 : 0, t.chance(0.15) ? 1.5 : 1));
      segments.push(["bezier", c1, r3(t.between(lo, hi)), c2, r3(t.between(lo, hi)), next, v]);
    } else {
      segments.push([kind, next, v]);
    }
    time = next;
  }
  const c: CurveSpec = { id, first, segments };
  if (t.chance(0.15)) c.fadeIn = t.pick([0, 0.2, 0.7, -1]);
  if (t.chance(0.15)) c.fadeOut = t.pick([0, 0.3, 1.2]);
  return c;
}

interface ModelIds {
  params: { id: string; min: number; max: number }[];
  parts: string[];
  meshes: string[];
}

function randomMotion(t: Tools, ids: ModelIds, blink: string[], lip: string[]): MotionSpec {
  const duration = t.pick([0, 0.5, 1, 1.7, 2.5, 3]);
  const curves: CurveSpec[] = [];
  const model = (id: string, lo: number, hi: number) => ({ ...randomCurve(t, id, duration, lo, hi), target: "Model" as const });
  if (t.chance(0.3)) curves.push(model("EyeBlink", 0, 1));
  if (t.chance(0.3)) curves.push(model("LipSync", 0, 1));
  if (t.chance(0.3)) curves.push(model("Opacity", 0, 1));
  const params = [...t.subset(ids.params, 0.6), ...(t.chance(0.3) ? [{ id: "FreeCurve", min: -2, max: 2 }] : [])];
  for (const id of t.subset([...blink, ...lip], 0.3)) params.push({ id, min: -1, max: 1.5 });
  for (const p of params) {
    const span = p.max - p.min;
    curves.push(randomCurve(t, p.id, duration, p.min - span * 0.2, p.max + span * 0.2));
  }
  for (const id of [...t.subset(ids.parts, 0.4), ...(t.chance(0.2) ? ["FreePart"] : [])])
    curves.push({ ...randomCurve(t, id, duration, 0, 1), target: "PartOpacity" });
  // Out of the order of 3c.2 sometimes: the later curves are ignored.
  if (t.chance(0.1) && curves.length > 0) curves.push(model("Opacity", 0, 1));
  const spec: MotionSpec = {
    duration,
    fps: t.pick([0, 10, 24, 30, 60]),
    restricted: t.chance(0.3),
    curves,
    events: t.chance(0.4)
      ? Array.from({ length: t.int(1, 4) }, (_, k) => ({ time: r3(t.pick([0, duration, duration + 0.5, t.between(0, duration)])), value: `ev${k}` }))
      : [],
  };
  if (t.chance(0.7)) spec.fadeIn = t.pick([0, 0.1, 0.5, 1, -1]);
  if (t.chance(0.7)) spec.fadeOut = t.pick([0, 0.2, 0.5, 1.5, -2]);
  return spec;
}

/** Motion files the reference rejects, or reads in an unusual way. */
const ODD_MOTIONS: Record<string, string> = {
  "bad-nonnumeric": JSON.stringify({ Meta: { CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 2 }, Curves: [{ Target: "Parameter", Id: "X", Segments: [0, 0, 0, "1", 1] }] }),
  "bad-nofirst": JSON.stringify({ Meta: { CurveCount: 1 }, Curves: [{ Target: "Parameter", Id: "X", Segments: [0] }] }),
  "bad-code": JSON.stringify({ Meta: { CurveCount: 1 }, Curves: [{ Target: "Parameter", Id: "X", Segments: [0, 0, 4.5, 1, 1] }] }),
  "bad-truncated": JSON.stringify({ Meta: { CurveCount: 1 }, Curves: [{ Target: "Parameter", Id: "X", Segments: [0, 0, 1, 0.2, 1, 0.5] }] }),
  "bad-notobject": "[1, 2, 3]",
  "bad-counts": JSON.stringify({ Meta: { CurveCount: 1, TotalSegmentCount: 7, TotalPointCount: 2 }, Curves: [{ Target: "Parameter", Id: "X", Segments: [0, 0, 0, 1, 1] }] }),
  "odd-proto-target": JSON.stringify({
    Meta: { Duration: 1, Fps: 30, CurveCount: 3, TotalSegmentCount: 3, TotalPointCount: 6 },
    Curves: [
      { Target: "Parameter", Id: "FreeCurve", Segments: [0, 0, 0, 1, 1] },
      { Target: "toString", Id: "FreeCurve", Segments: [0, 0, 0, 1, 1] },
      { Target: "Model", Id: "Opacity", Segments: [0, 1, 0, 1, 0.25] },
    ],
  }),
};

// ------------------------------------------------------------- expressions

function randomExpression(t: Tools, ids: ModelIds): string {
  const entries: Record<string, unknown>[] = [];
  const pool = [...ids.params.map((p) => p.id), "FreeExpr", "FreeCurve"];
  for (let k = t.int(0, 4); k > 0; k--)
    entries.push({
      Id: t.pick(pool),
      Value: r3(t.between(-2, 2)),
      ...(t.chance(0.85) ? { Blend: t.pick(["Add", "Multiply", "Overwrite", "Screen"]) } : {}),
    });
  return JSON.stringify(
    {
      Type: "Live2D Expression",
      ...(t.chance(0.8) ? { FadeInTime: t.pick([0, 0.1, 0.5, 1, -1]) } : {}),
      ...(t.chance(0.8) ? { FadeOutTime: t.pick([0, 0.2, 0.6]) } : {}),
      Parameters: entries,
    },
    null,
    2,
  );
}

// ----------------------------------------------------------------- physics

function physicsJson(t: Tools, ids: ModelIds, opts: { badTotals?: boolean; zeroVertices?: boolean; fractionalVertex?: boolean } = {}): string {
  const kinds = ["X", "Y", "Angle"] as const;
  const pool = [...ids.params.map((p) => p.id), "FreePhys"];
  const settings = Array.from({ length: t.int(1, 3) }, (_, s) => {
    const nv = opts.zeroVertices && s === 0 ? 0 : t.int(1, 4);
    const vertices = Array.from({ length: nv }, (_, i) => ({
      Position: { X: i === 0 ? r3(t.between(-1, 1)) : 0, Y: r3(i * t.between(1, 10)) },
      Mobility: r3(t.between(0.5, 1)),
      Delay: r3(t.between(0.3, 1.2)),
      Acceleration: r3(t.between(0.5, 3)),
      Radius: i === 0 ? 0 : r3(t.between(1, 10)),
    }));
    const norm = () => ({ Minimum: -r3(t.between(1, 30)), Default: r3(t.between(-1, 1)), Maximum: r3(t.between(1, 30)) });
    return {
      Id: `PhysicsSetting${s}`,
      Input: Array.from({ length: t.int(1, 3) }, () => ({
        Source: { Target: "Parameter", Id: t.pick(pool) },
        Weight: t.pick([30, 50, 100, 60]),
        Type: t.pick(kinds),
        Reflect: t.chance(0.3),
      })),
      Output: Array.from({ length: t.int(1, 3) }, (_, k) => ({
        Destination: { Target: "Parameter", Id: t.pick(pool) },
        VertexIndex: opts.fractionalVertex && s === 0 && k === 0 ? 1.5 : t.pick([1, 1, 2, 3, 0, 9]),
        Scale: r3(t.between(0.5, 20)),
        Weight: t.pick([100, 50, 120, 80]),
        Type: t.pick(kinds),
        Reflect: t.chance(0.2),
      })),
      Vertices: vertices,
      Normalization: { Position: norm(), Angle: norm() },
    };
  });
  const total = (k: "Input" | "Output" | "Vertices") => settings.reduce((n, s) => n + s[k].length, 0);
  return JSON.stringify(
    {
      Version: 3,
      Meta: {
        PhysicsSettingCount: settings.length,
        TotalInputCount: total("Input") + (opts.badTotals ? 1 : 0),
        TotalOutputCount: total("Output"),
        VertexCount: total("Vertices"),
        ...(t.chance(0.6) ? { Fps: t.pick([0, 30, 60, 120]) } : {}),
        EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
        PhysicsDictionary: settings.map((s) => ({ Id: s.Id, Name: s.Id })),
      },
      PhysicsSettings: settings,
    },
    null,
    2,
  );
}

function poseJson(t: Tools, ids: ModelIds): string {
  const pool = [...ids.parts, "FreePart", ...ids.params.map((p) => p.id).slice(0, 1)];
  const groups = Array.from({ length: t.int(1, 3) }, () =>
    Array.from({ length: t.int(0, 3) }, () => ({
      Id: t.pick(pool),
      ...(t.chance(0.5) ? { Link: t.subset(pool, 0.4) } : {}),
    })),
  );
  return JSON.stringify(
    { Type: "Live2D Pose", ...(t.chance(0.8) ? { FadeInTime: t.pick([0, 0.3, 0.5, -1]) } : {}), Groups: groups },
    null,
    2,
  );
}

// ------------------------------------------------------------------- sounds

function randomWav(t: Tools, scale: number): Uint8Array {
  const f1 = t.between(80, 600);
  const spec: WavSpec = {
    rate: t.pick([8000, 11025, 22050]),
    channels: t.pick([1, 1, 2]),
    bits: t.pick([8, 16, 16, 24, 32] as const),
    frames: 0,
    signal: (time, c) => (c === 0 ? 0.6 : 0.3) * Math.sin(2 * Math.PI * f1 * time) * (time > 0.8 ? 0.2 : 1),
  };
  spec.frames = Math.floor(spec.rate * t.between(0.3, 1.5) * scale);
  if (t.chance(0.2)) {
    const body = Uint8Array.from([..."INFOISFT"].map((ch) => ch.charCodeAt(0)).concat([4, 0, 0, 0, 116, 101, 115, 0]));
    spec.list = { body, pad: t.chance(0.5) };
  }
  return wavFile(spec);
}

function oddWavs(): Record<string, Uint8Array> {
  const header = (bits: number, dataSize: number, format = 1) => {
    const b = new Uint8Array(44 + dataSize);
    const dv = new DataView(b.buffer);
    const text = (o: number, s: string) => [...s].forEach((ch, i) => (b[o + i] = ch.charCodeAt(0)));
    text(0, "RIFF");
    dv.setUint32(4, 36 + dataSize, true);
    text(8, "WAVE");
    text(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, format, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, 8000, true);
    dv.setUint32(28, 8000, true);
    dv.setUint16(32, 1, true);
    dv.setUint16(34, bits, true);
    text(36, "data");
    dv.setUint32(40, dataSize, true);
    for (let i = 0; i < dataSize; i++) b[44 + i] = (i * 37) & 0xff;
    return b;
  };
  return {
    "w-float.wav": header(32, 400, 3),
    "w-bits0.wav": header(0, 100),
    "w-bits0-empty.wav": header(0, 0),
    "w-bits12.wav": header(12, 800),
    "w-garbage.wav": Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
    "w-short-fmt.wav": header(16, 0).slice(0, 30),
    "w-nodata.wav": header(16, 0).slice(0, 36),
  };
}

// ---------------------------------------------------------------- scenarios

export interface AnimFiles {
  /** Scenario objects to write. */
  scenarios: Record<string, unknown>[];
}

/**
 * Writes the animation assets of one model into `dir` (its folder under
 * models/) and returns sequence and animation scenarios on them.
 */
export function animationVectors(
  name: string,
  dir: string,
  model: MocModel,
  seed: number,
  count: number,
  soundScale = 1,
): AnimFiles {
  const t = tools(seed);
  const ids: ModelIds = {
    params: model.parameters.ids.map((id, i) => ({ id, min: model.parameters.min[i]!, max: model.parameters.max[i]! })),
    parts: [...model.parts.ids],
    meshes: [...model.meshes.ids],
  };
  const paramIds = ids.params.map((p) => p.id);
  const write = (file: string, content: string | Uint8Array) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), content);
  };
  // Motions, expressions, physics, poses and sounds.
  const blinkIds = [...t.subset(paramIds, 0.3), ...(t.chance(0.5) ? ["FreeBlink"] : [])];
  const lipIds = [...t.subset(paramIds, 0.3), ...(t.chance(0.5) ? ["FreeLip"] : [])];
  const motions: string[] = [];
  for (let k = 0; k < 8; k++) {
    const file = `motions/m${k}.motion3.json`;
    write(file, motionJson(randomMotion(t, ids, blinkIds, lipIds)));
    motions.push(file);
  }
  for (const [n, text] of Object.entries(ODD_MOTIONS)) {
    write(`motions/${n}.motion3.json`, text);
    motions.push(`motions/${n}.motion3.json`);
  }
  motions.push("motions/missing.motion3.json");
  const expressions: string[] = [];
  for (let k = 0; k < 5; k++) {
    write(`exp/e${k}.exp3.json`, randomExpression(t, ids));
    expressions.push(`exp/e${k}.exp3.json`);
  }
  write("exp/bad.exp3.json", "[]");
  expressions.push("exp/bad.exp3.json", "exp/missing.exp3.json");
  const p0 = physicsJson(t, ids);
  write("p0.physics3.json", p0);
  write("p1.physics3.json", physicsJson(t, ids));
  write("p-badtotals.physics3.json", physicsJson(t, ids, { badTotals: true }));
  write("p-novertex.physics3.json", physicsJson(t, ids, { zeroVertices: true }));
  write("p-fraction.physics3.json", physicsJson(t, ids, { fractionalVertex: true }));
  write("pose0.pose3.json", poseJson(t, ids));
  write("pose1.pose3.json", poseJson(t, ids));
  const sounds: string[] = [];
  for (let k = 0; k < 3; k++) {
    write(`s${k}.wav`, randomWav(t, soundScale));
    sounds.push(`s${k}.wav`);
  }
  for (const [n, bytes] of Object.entries(oddWavs())) {
    write(n, bytes);
    sounds.push(n);
  }
  sounds.push("missing.wav");

  // Settings files.
  const settingsFiles: string[] = [];
  for (let k = 0; k < 4; k++) {
    const group = () =>
      t.subset(motions, 0.3).map((file) => ({
        File: file,
        ...(t.chance(0.3) ? { FadeInTime: t.pick([0, 0.3, -1]) } : {}),
        ...(t.chance(0.3) ? { FadeOutTime: t.pick([0, 0.4, -1]) } : {}),
        ...(t.chance(0.3) ? { Sound: t.pick(sounds) } : {}),
      }));
    const motionsRef: Record<string, unknown> = {};
    if (t.chance(0.7)) motionsRef.Idle = group();
    motionsRef.Tap = group();
    if (t.chance(0.3)) motionsRef["1"] = group();
    if (t.chance(0.2)) motionsRef.Broken = "not a list";
    const physics = k === 3 ? t.pick(["p-badtotals.physics3.json", "p-novertex.physics3.json", "p-fraction.physics3.json", "nope.physics3.json"]) : t.pick(["p0.physics3.json", "p1.physics3.json", "", ""]);
    const pose = k === 3 && t.chance(0.3) ? "nope.pose3.json" : t.pick(["pose0.pose3.json", "pose1.pose3.json", "", ""]);
    const file = `a${k}.model3.json`;
    write(
      file,
      JSON.stringify(
        {
          Version: 3,
          FileReferences: {
            Moc: `${name}.moc3`,
            Textures: [],
            ...(physics ? { Physics: physics } : {}),
            ...(pose ? { Pose: pose } : {}),
            Expressions: expressions.map((f, i) => ({ Name: `x${i}`, File: f })),
            Motions: motionsRef,
          },
          Groups: [
            ...(t.chance(0.8) ? [{ Target: "Parameter", Name: "EyeBlink", Ids: blinkIds }] : []),
            ...(t.chance(0.8) ? [{ Target: "Parameter", Name: "LipSync", Ids: lipIds }] : []),
          ],
          HitAreas: ids.meshes.slice(0, 1).map((id) => ({ Id: id, Name: "Body" })),
        },
        null,
        2,
      ),
    );
    settingsFiles.push(file);
  }

  const scenarios: Record<string, unknown>[] = [];
  // Sequences.
  for (let k = 0; k < 2; k++) {
    const steps = Array.from({ length: t.int(1, 5) }, (_, i) => {
      const parameters: Record<string, number> = {};
      for (const p of t.subset(ids.params, 0.5)) parameters[p.id] = r3(t.between(p.min - 1, p.max + 1));
      if (t.chance(0.2)) parameters.NoSuchParam = 1;
      const partOpacities: Record<string, number> = {};
      for (const id of t.subset(ids.parts, 0.3)) partOpacities[id] = r3(t.between(-0.2, 1.2));
      if (t.chance(0.1)) partOpacities.NoSuchPart = 0.5;
      return { ...(t.chance(0.7) ? { label: `step${i}` } : {}), parameters, partOpacities };
    });
    scenarios.push({ format: SEQ_FORMAT, id: `${name}-seq${k}`, model: `${name}/${name}.model3.json`, steps });
  }
  // Animations.
  for (let k = 0; k < count; k++) {
    const settings = t.pick(settingsFiles);
    const frames = t.int(30, 240);
    const steps = t.chance(0.5)
      ? { dt: t.pick([1 / 60, 1 / 30, 1 / 144, 0.05]), frames }
      : {
          dts: Array.from({ length: frames }, () =>
            t.chance(0.05) ? 0 : t.chance(0.02) ? t.pick([0.5, 6, 1 / 3]) : r3(t.between(0.008, 0.04)),
          ),
        };
    const random = Array.from({ length: t.chance(0.15) ? t.int(0, 3) : t.int(10, 40) }, () => t.rnd());
    const effects: Record<string, boolean> = {};
    for (const e of ["idle", "blink", "expressions", "look", "breath", "physics", "lipsync", "pose"])
      if (t.chance(0.8)) effects[e] = t.chance(0.6);
    const commands: Record<string, unknown>[] = [];
    for (let c = t.int(0, 12); c > 0; c--) {
      const frame = t.int(0, frames - 1);
      const kind = t.pick(["motion", "motion", "motion", "expression", "look", "sound", "partOpacity", "stopMotions", "enable"]);
      let cmd: Record<string, unknown>;
      if (kind === "motion") {
        cmd = t.chance(0.6) ? { file: t.pick(motions) } : { group: t.pick(["Idle", "Tap", "1", "Nope"]), index: t.int(0, 3) };
        if (t.chance(0.6)) cmd.priority = t.pick([1, 2, 3, 0]);
        if (cmd.file !== undefined && t.chance(0.3)) cmd.FadeInTime = t.pick([0, 0.2, -1]);
        if (cmd.file !== undefined && t.chance(0.3)) cmd.FadeOutTime = t.pick([0, 0.5]);
        if (t.chance(0.3)) cmd.loop = t.chance(0.7);
        if (t.chance(0.2)) cmd.loopFade = t.chance(0.5);
        if (t.chance(0.2)) cmd.weight = t.pick([0.3, 1, 0]);
        if (t.chance(0.2)) cmd.offset = t.pick([0.25, 1.5, -0.5]);
        if (t.chance(0.15)) cmd.legacyLoop = t.chance(0.7);
      } else if (kind === "expression") {
        cmd = t.chance(0.6) ? { file: t.pick(expressions) } : { name: t.pick(["x0", "x1", "x2", "x5", "nope"]) };
      } else if (kind === "look") {
        cmd = { x: r3(t.between(-1.2, 1.2)), y: r3(t.between(-1.2, 1.2)) };
      } else if (kind === "sound") {
        cmd = { file: t.pick(sounds) };
      } else if (kind === "partOpacity") {
        cmd = { id: t.pick([...ids.parts, "FreePart"]), value: r3(t.between(-0.2, 1.2)) };
      } else if (kind === "enable") {
        cmd = { effect: t.pick(["idle", "blink", "expressions", "look", "breath", "physics", "lipsync", "pose", "toString"]) };
      } else {
        cmd = {};
      }
      commands.push({ frame, do: kind, ...cmd });
    }
    commands.sort((a, b) => (a.frame as number) - (b.frame as number));
    const record: Record<string, unknown> = {};
    if (t.chance(0.3)) record.parameters = [...t.subset(paramIds, 0.6), ...(t.chance(0.3) ? ["NoSuchParam"] : [])];
    if (t.chance(0.3)) record.parts = [...t.subset(ids.parts, 0.6), ...(t.chance(0.3) ? ["NoSuchPart"] : [])];
    record.free = t.subset(["FreeBlink", "FreeLip", "FreeCurve", "FreeExpr", "FreePart", "FreePhys", "NoSuch", ...ids.parts.slice(0, 2), paramIds[0]!], 0.5);
    if (t.chance(0.4)) record.every = t.int(1, 4);
    if (t.chance(0.3))
      record.hits = Array.from({ length: t.int(1, 3) }, () => ({
        frame: t.int(0, frames - 1),
        drawable: t.pick([...ids.meshes, "NoSuchMesh"]),
        x: r3(t.between(-1, 1)),
        y: r3(t.between(-1, 1)),
      }));
    if (t.chance(0.2)) record.drawables = [t.int(0, frames - 1)];
    const options: Record<string, unknown> = {};
    if (t.chance(0.2)) options.wrap = t.chance(0.7);
    if (t.chance(0.2)) options.gravity = [r3(t.between(-1, 1)), r3(t.between(-1.5, 0))];
    if (t.chance(0.2)) options.wind = [r3(t.between(-2, 2)), 0];
    if (t.chance(0.2)) options.settle = t.chance(0.7);
    if (t.chance(0.2)) options.blinkTiming = [t.pick([0.5, 1, 4]), 0.1, t.pick([0, 0.05]), 0.15];
    scenarios.push({
      format: ANIM_FORMAT,
      id: `${name}-anim${k}`,
      model: `${name}/${settings}`,
      ...steps,
      random,
      effects,
      ...(t.chance(0.2) ? { idleMotions: t.subset(motions, 0.4).concat([t.pick(motions)]) } : {}),
      ...(Object.keys(options).length ? { options } : {}),
      commands,
      record,
    });
  }
  // Mochi2D 0.16.0's physics step limit: rates so high the steps would never
  // end (1e+308; 1e309, read as infinite; 5e-324) in p0's settings, a frame
  // after another (no random draws: the scenarios above are unchanged).
  ["1e+308", "1e309", "5e-324"].forEach((fps, i) => {
    const physics = JSON.parse(p0) as { Meta: Record<string, unknown> };
    physics.Meta.Fps = 424242.5;
    write(`p-fast${i}.physics3.json`, JSON.stringify(physics, null, 2).replace("424242.5", fps));
    const settings = `fast${i}.model3.json`;
    write(settings, JSON.stringify({ Version: 3, FileReferences: { Moc: `${name}.moc3`, Textures: [], Physics: `p-fast${i}.physics3.json` } }, null, 2));
    scenarios.push({ format: ANIM_FORMAT, id: `${name}-fastphysics${i}`, model: `${name}/${settings}`, dt: 1 / 30, frames: 12, commands: [], record: {} });
  });
  return { scenarios };
}

/** Malformed sequence and animation scenarios on one model: one per InvalidScenario rule. */
export function invalidScenarios(model: string): Record<string, unknown>[] {
  const a = (id: string, extra: Record<string, unknown>) => ({ format: ANIM_FORMAT, id: `bad-anim-${id}`, model, dt: 1 / 60, frames: 4, ...extra });
  const s = (id: string, extra: Record<string, unknown>) => ({ format: SEQ_FORMAT, id: `bad-seq-${id}`, model, steps: [], ...extra });
  const cmd = (id: string, c: Record<string, unknown>) => a(`cmd-${id}`, { commands: [{ frame: 0, ...c }] });
  return [
    s("format", { format: "mochi2d-sequence/1" }),
    s("model", { model: "" }),
    s("steps", { steps: {} }),
    s("step", { steps: [3] }),
    s("label", { steps: [{ label: 1 }] }),
    s("params", { steps: [{ parameters: [] }] }),
    s("param", { steps: [{ parameters: { a: "1" } }] }),
    s("parts", { steps: [{ partOpacities: { a: null } }] }),
    // "__proto__" as an own key, as JSON.parse makes it.
    s("proto", { steps: [{ parameters: JSON.parse('{"__proto__": 1, "constructor": 2, "Param0": 0.5}') }] }),
    a("dts-and-dt", { dts: [0.1] }),
    a("dts", { dt: undefined, frames: undefined, dts: [0.1, -1] }),
    a("dt", { dt: "x" }),
    a("dt-negative", { dt: -1 }),
    a("frames", { frames: 2.5 }),
    a("random", { random: [0.5, 1] }),
    a("random-null", { random: null }),
    a("effects", { effects: [] }),
    a("effect", { effects: { blink: 1 } }),
    a("effect-proto", { effects: { toString: "yes" } }),
    a("effect-unknown", { effects: { sparkle: 3 } }),
    a("idle", { idleMotions: ["", "a"] }),
    a("options", { options: 1 }),
    a("wrap", { options: { wrap: 1 } }),
    a("gravity", { options: { gravity: [1] } }),
    a("wind", { options: { wind: [1, "2"] } }),
    a("settle", { options: { settle: null } }),
    a("blink-timing", { options: { blinkTiming: [1, 2, 3] } }),
    a("commands", { commands: {} }),
    a("command", { commands: [1] }),
    a("command-frame", { commands: [{ frame: 4, do: "stopMotions" }] }),
    a("command-order", { commands: [{ frame: 2, do: "stopMotions" }, { frame: 1, do: "stopMotions" }] }),
    cmd("unknown", { do: "dance" }),
    cmd("missing-do", {}),
    cmd("motion-both", { do: "motion", file: "a", group: "g", index: 0 }),
    cmd("motion-none", { do: "motion" }),
    cmd("motion-file", { do: "motion", file: "" }),
    cmd("motion-group", { do: "motion", group: 1, index: 0 }),
    cmd("motion-index", { do: "motion", group: "g", index: -1 }),
    cmd("motion-fade-group", { do: "motion", group: "g", index: 0, FadeInTime: 1 }),
    cmd("motion-priority", { do: "motion", file: "a", priority: "high" }),
    cmd("motion-fadein", { do: "motion", file: "a", FadeInTime: null }),
    cmd("motion-fadeout", { do: "motion", file: "a", FadeOutTime: "1" }),
    cmd("motion-loop", { do: "motion", file: "a", loop: 1 }),
    cmd("motion-loopfade", { do: "motion", file: "a", loopFade: "no" }),
    cmd("motion-weight", { do: "motion", file: "a", weight: [] }),
    cmd("motion-offset", { do: "motion", file: "a", offset: {} }),
    cmd("motion-legacy", { do: "motion", file: "a", legacyLoop: 0 }),
    cmd("expression-both", { do: "expression", file: "a", name: "b" }),
    cmd("expression-name", { do: "expression", name: "" }),
    cmd("look", { do: "look", x: 1 }),
    cmd("sound", { do: "sound", file: 3 }),
    cmd("part", { do: "partOpacity", id: "a" }),
    cmd("enable", { do: "enable", effect: "sparkle" }),
    cmd("enable-proto", { do: "enable", effect: "valueOf" }),
    a("record", { record: [] }),
    a("every", { record: { every: 0 } }),
    a("hits", { record: { hits: {} } }),
    a("drawables", { record: { drawables: 2 } }),
    a("record-params", { record: { parameters: "some" } }),
    a("record-parts", { record: { parts: [1] } }),
    a("record-free", { record: { free: null } }),
    a("hit", { record: { hits: [1] } }),
    a("hit-frame", { record: { hits: [{ frame: 9, drawable: "a", x: 0, y: 0 }] } }),
    a("hit-drawable", { record: { hits: [{ frame: 0, drawable: "", x: 0, y: 0 }] } }),
    a("hit-x", { record: { hits: [{ frame: 0, drawable: "a", y: 0 }] } }),
    a("drawable-frame", { record: { drawables: [-1] } }),
    a("frames-huge", { frames: 2 ** 32 }),
    { format: ANIM_FORMAT, id: "bad-anim-model", model: 3, dt: 0, frames: 0 },
    { format: ANIM_FORMAT, id: "bad-anim-badid", x: "the id below is replaced by one with a space" },
  ];
}
